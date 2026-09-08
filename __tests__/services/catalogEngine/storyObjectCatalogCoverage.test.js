jest.mock('../../../services/illustrationGenerator', () => ({ fetchWithTimeout: jest.fn(), getNextApiKey: () => 'test' }));
jest.mock('../../../services/gcsStorage', () => ({ downloadBuffer: jest.fn(), uploadBufferIfAbsent: jest.fn() }));
const { fetchWithTimeout } = require('../../../services/illustrationGenerator');
const { downloadBuffer, uploadBufferIfAbsent } = require('../../../services/gcsStorage');
const { inputsFor, validatePlan, resolveStoryObjects } = require('../../../services/catalogEngine/illustrator/storyObjects');
const catalog = require('../../../services/catalogEngine/data/catalog.json');
const seeds = require('../../../services/catalogEngine/data/storyObjects.json');

// Real catalog beats, synthetic model plans: this checks the shared contract
// across themes, not the probability of a live model omission or image quality.
const cases = [
  ['farm_8_10_farm_map', 'map', ['maps']],
  ['dinosaur_8_10_field_guide', 'card', ['cards']],
  ['space_6_7_rover_marker', 'marker', ['markers', 'route marker']],
  ['sea_6_7_route_markers', 'marker', ['markers', 'route marker']],
  ['jungle_6_7_trail_markers', 'marker', ['markers', 'third marker']],
  ['safari_6_7_watering_hole_map', 'route marker', ['marker', 'markers', 'route markers', 'third marker']],
  ['enchanted_8_10_lantern_mystery', 'lantern', ['lanterns']],
  ['pirate_6_7_compass_clue', 'card', ['cards', 'direction cards']],
  ['construction_6_7_cone_route', 'cone', ['cones', 'marker', 'markers']],
  ['dream_6_7_star_path', 'marker', ['markers', 'glowing marker']],
  ['christmas_6_7_ornament_hunt', 'box', ['boxes', 'ornament boxes']],
  ['thanksgiving_2_3_pumpkin_day', 'pumpkin', ['pumpkins']],
  ['thanksgiving_4_5_pumpkin_delivery', 'pumpkin', ['pumpkins']],
];

function fixture(bookId, name, aliases) {
  const theme = Object.values(catalog.themes).find(t => Object.values(t.age_bands).flat().some(b => b.id === bookId));
  const book = Object.values(theme.age_bands).flat().find(b => b.id === bookId);
  const definition = seeds[bookId]?.objects[0] || {
    id: name.replace(/ /g, '_'), name, aliases, critical: true,
    design: { shape: 'A fixed test shape', material: 'A fixed test material', colors: 'A fixed test color', scale: 'A fixed test scale', features: 'A fixed test feature' },
  };
  const mentions = [definition.name, ...definition.aliases].map(a => new RegExp(`\\b${a}\\b`, 'i'));
  const appearances = book.beats.filter(b => mentions.some(re => re.test(b.beat)));
  // Exact beat quotes also act as stand-in manuscript text. One appearance is
  // beat-only to exercise the independent beat/manuscript coverage requirement.
  const omittedSpread = appearances[appearances.length - 1].spread;
  const params = { book, theme, story: { book_id: bookId, personalization_evidence: [],
    spreads: book.beats.map(b => ({ spread: b.spread, text: b.spread === omittedSpread ? 'The child considers the next step.' : b.beat })),
  } };
  const complete = { objects: [{ ...definition,
    instances: [{ id: 'object_group', description: 'The story object family used in this contract fixture' }],
    occurrences: appearances.map(b => ({ spread: b.spread, instanceIds: ['object_group'], multiplicity: 'group', state: b.beat, evidence: b.beat, required: true })),
  }], conflicts: [] };
  const incomplete = JSON.parse(JSON.stringify(complete));
  incomplete.objects[0].occurrences = incomplete.objects[0].occurrences.filter(o => o.spread !== omittedSpread);
  return { params, complete, incomplete, omittedSpread, appearances };
}

const response = plan => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(plan) }] } }] }) });
beforeEach(() => {
  jest.clearAllMocks();
  downloadBuffer.mockRejectedValue(Object.assign(new Error('missing'), { code: 404 }));
  uploadBufferIfAbsent.mockResolvedValue({ created: true });
});

test('fixtures span every catalog theme and age band', () => {
  const themes = new Set(cases.map(([id, name, aliases]) => fixture(id, name, aliases).params.theme.theme_id));
  expect(themes.size).toBe(Object.keys(catalog.themes).length);
  const bands = new Set(cases.map(([id, name, aliases]) => {
    const { theme } = fixture(id, name, aliases).params;
    return Object.entries(theme.age_bands).find(([, books]) => books.some(b => b.id === id))[0];
  }));
  expect([...bands].sort()).toEqual(['1-3', '4-5', '6-7', '8-10']);
});

describe.each(cases)('%s', (id, name, aliases) => {
  test('an omitted object mention fails and a grounded correction recovers', async () => {
    const f = fixture(id, name, aliases);
    expect(f.appearances.length).toBeGreaterThan(1);
    const inputs = inputsFor(f.params);
    expect(() => validatePlan(f.incomplete, inputs)).toThrow(`Object occurrence omitted on spread ${f.omittedSpread}`);
    const def = f.complete.objects[0];
    const { spread, ...patch } = def.occurrences.find(o => o.spread === f.omittedSpread);
    patch.evidence = `s${spread}_beat_1`;
    const key = `${def.id}__s${spread}`;
    fetchWithTimeout.mockResolvedValueOnce(response(f.incomplete)).mockResolvedValueOnce(response({ [key]: patch }));
    const result = await resolveStoryObjects(f.params);
    expect(result.objects[0].occurrences.map(o => o.spread)).toEqual(f.appearances.map(b => b.spread));
    const retry = JSON.parse(fetchWithTimeout.mock.calls[1][1].body);
    expect(retry.generationConfig.responseJsonSchema.required).toEqual([key]);
    expect(uploadBufferIfAbsent).toHaveBeenCalledTimes(1);
  });

  test('an unchanged omission still fails without storing a partial plan', async () => {
    const f = fixture(id, name, aliases);
    fetchWithTimeout.mockResolvedValueOnce(response(f.incomplete)).mockResolvedValue(response({}));
    await expect(resolveStoryObjects(f.params)).rejects.toMatchObject({ failureCode: 'identity_kit_failed' });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
    expect(uploadBufferIfAbsent).not.toHaveBeenCalled();
  });
});
