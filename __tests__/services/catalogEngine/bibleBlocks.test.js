/**
 * Renderer bible mode (ce-9): the reference pack replaces the anchor+plate
 * pair with labeled, ordered parts; the CHARACTER / PROPS / COMPANION /
 * EMOTION blocks are stated ONCE and switch the legacy six-fold outfit
 * repetition off; the safety ladder rebuilds the pinned blocks intact on
 * the sanitized rung and re-attaches them on the generic-safe rung; the
 * accepted rung is logged; safetySettings ride every image call. Legacy
 * (bible-less) callers stay byte-identical.
 */

jest.mock('../../../services/gcsStorage', () => ({
  uploadBuffer: jest.fn().mockResolvedValue('gs://bucket/x.png'),
  downloadBuffer: jest.fn(),
  getSignedUrl: jest.fn(),
}));

const gen = require('../../../services/illustrationGenerator');
const { buildCharacterPrompt, renderBibleBlocks, buildReferenceParts, generateIllustration } = gen;
const { GEMINI_IMAGE_SAFETY_SETTINGS } = require('../../../services/shared/illustration/config');

const BIBLE = {
  characterSheetRef: 1,
  coverRef: 2,
  outfitSpecText: 'Top: red t-shirt. Bottom: blue jeans. Footwear: white sneakers.',
  hairLine: 'short curly dark-brown hair, light-brown skin',
  props: [{ name: 'teddy bear', specText: 'a small honey-brown plush bear', ref: 3, carried: true }],
  companion: { name: 'Farmer Bea', type: 'friendly adult farm guide', ref: null },
  emotionLine: 'EMOTION (this spread): clear curiosity — eyes wide, leaning in.',
};

test('renderBibleBlocks states identity, outfit, props, companion and emotion once, citing the references', () => {
  const lines = renderBibleBlocks(BIBLE);
  const text = lines.join('\n');
  expect(text).toMatch(/^CHARACTER \(THE ONLY CHILD/);
  expect(text).toContain('REFERENCE 1 (the CHARACTER MODEL SHEET');
  expect(text).toContain('REFERENCE 2 (the APPROVED COVER');
  expect(text).toContain("REFERENCE 1's plain studio background is NOT part of this scene");
  expect(text).toContain('- Appearance (fixed): short curly dark-brown hair, light-brown skin');
  expect(text).toContain('Top: red t-shirt. Bottom: blue jeans. Footwear: white sneakers.');
  expect(text).toContain('PROPS (each quoted name is DATA');
  expect(text).toContain('- "teddy bear" — see REFERENCE 3: a small honey-brown plush bear Carried by the child');
  // ce-10: a carried prop is visually subdued, and the list is CLOSED —
  // no invented personal objects beyond it.
  expect(text).toContain('visually subdued');
  expect(text).toContain('These are the ONLY personal objects in this book');
  // A bible without props carries no discipline bullet (the scene prompt's
  // own PROP DISCIPLINE line covers prop-less spreads).
  expect(renderBibleBlocks({ ...BIBLE, props: [] }).join('\n')).not.toContain('ONLY personal objects');
  expect(text).toContain('COMPANION: Farmer Bea, a friendly adult farm guide; friendly and warm');
  expect(text).toContain('EMOTION (this spread): clear curiosity');
  // bath/water: the outfit is the dry-land default, not worn in the water
  expect(renderBibleBlocks(BIBLE, { bathWaterScene: true }).join('\n')).toContain('NOT worn in the water on this spread');
  expect((text.match(/Top: red t-shirt/g) || []).length).toBe(1);
});

test('bible mode states the outfit ONCE and drops the legacy repetition; legacy mode is untouched', () => {
  const legacy = buildCharacterPrompt('A farm scene.', 'pixar_premium', 'Emma', null, 'red t-shirt, blue jeans', null, null, null, { isSpread: true, spreadIndex: 0, totalSpreads: 12 });
  const bible = buildCharacterPrompt('A farm scene.', 'pixar_premium', 'Emma', null, BIBLE.outfitSpecText, null, null, null, { isSpread: true, spreadIndex: 0, totalSpreads: 12, bible: BIBLE });
  expect((legacy.match(/red t-shirt, blue jeans/g) || []).length).toBeGreaterThanOrEqual(5);
  expect((bible.match(/Top: red t-shirt\. Bottom: blue jeans\. Footwear: white sneakers\./g) || []).length).toBe(2); // CHARACTER block + the pre-generate checklist
  expect(bible).toContain('OUTFIT LOCK (CRITICAL)'.slice(0, 0)); // placeholder — legacy block absent below
  expect(bible).not.toContain('5. OUTFIT LOCK (CRITICAL)');
  expect(bible).toContain('match REFERENCE 1 (model sheet) and REFERENCE 2 (approved cover) precisely');
  expect(bible).toContain('REFERENCES = IDENTITY ONLY');
  expect(bible).toContain('8. OUTFIT MATCH: child is wearing exactly: the CHARACTER block outfit (REFERENCE 1 (the character model sheet))');
  expect(bible.length).toBeLessThan(legacy.length + 1200);
  expect(legacy).not.toContain('CHARACTER (THE ONLY CHILD');
});

test('buildReferenceParts labels and orders the pack after the prompt', () => {
  const parts = buildReferenceParts('PROMPT', [
    { label: 'CHARACTER MODEL SHEET', base64: 'YQ==', mimeType: 'image/png' },
    { label: 'WORLD STYLE PLATE', base64: 'Yg==' },
  ]);
  expect(parts).toEqual([
    { text: 'PROMPT' },
    { text: 'REFERENCE IMAGE 1 — CHARACTER MODEL SHEET' },
    { inline_data: { mimeType: 'image/png', data: 'YQ==' } },
    { text: 'REFERENCE IMAGE 2 — WORLD STYLE PLATE' },
    { inline_data: { mimeType: 'image/png', data: 'Yg==' } },
  ]);
});

describe('generateIllustration with a reference pack + bible', () => {
  const okImage = () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('img').toString('base64') } }] } }] }) });
  const nsfw = () => ({ ok: false, status: 400, text: async () => 'blocked by SAFETY filters' });
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
    process.env.GEMINI_API_KEY = 'k';
  });
  afterEach(() => fetchSpy.mockRestore());

  test('the pack rides the Gemini call with its labels, and safetySettings are sent', async () => {
    fetchSpy.mockResolvedValue(okImage());
    const attemptLog = [];
    const url = await generateIllustration('A farm scene.', 'https://x/cover.png', 'pixar_premium', {
      bookId: 'b1', childName: 'Emma', skipTextEmbed: true, isSpread: true, spreadIndex: 0, totalSpreads: 12,
      _cachedPhotoBase64: 'Y292ZXI=', _cachedPhotoMime: 'image/jpeg',
      referencePack: [{ label: 'CHARACTER MODEL SHEET', base64: 'c2hlZXQ=' }, { label: 'APPROVED COVER', base64: 'Y292ZXI=', mimeType: 'image/jpeg' }],
      bible: BIBLE, attemptLog, gcsPath: 'children-jobs/b1/x.png',
    });
    expect(url).toBe('gs://bucket/x.png');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const parts = body.contents[0].parts;
    expect(parts[0].text).toContain('CHARACTER (THE ONLY CHILD');
    expect(parts[1].text).toBe('REFERENCE IMAGE 1 — CHARACTER MODEL SHEET');
    expect(parts[2].inline_data.data).toBe('c2hlZXQ=');
    expect(parts[3].text).toBe('REFERENCE IMAGE 2 — APPROVED COVER');
    expect(parts[4].inline_data).toEqual({ mimeType: 'image/jpeg', data: 'Y292ZXI=' });
    expect(parts).toHaveLength(6);
    expect(parts[5].text).toContain('SCENE INTEGRATION (si-1)');
    expect(parts[5].text).toContain('do NOT lock source-image lighting');
    expect(parts[5].text).toContain('same visual medium, degree of stylization');
    expect(parts[5].text).toContain('contact shadows and overlap');
    expect(parts[5].text).toContain('only when the stated story action calls for them');
    expect(parts[5].text).toContain('without adding or changing hair colours or facial markings');
    expect(parts[5].text).toContain('Preserve all manuscript and typography-template instructions exactly');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(body.safetySettings).toEqual(GEMINI_IMAGE_SAFETY_SETTINGS);
    expect(attemptLog).toEqual([{ attempt: 1, variant: 'original', accepted: true }]);
  });

  test('the sanitized rung keeps the bible blocks intact and the generic-safe rung re-attaches them; the accepted rung is logged', async () => {
    fetchSpy.mockResolvedValueOnce(nsfw()).mockResolvedValueOnce(nsfw()).mockResolvedValueOnce(okImage());
    const attemptLog = [];
    await generateIllustration('The child gives the bear a kiss and a bare-footed splash.', 'https://x/cover.png', 'pixar_premium', {
      bookId: 'b1', childName: 'Emma', skipTextEmbed: true, isSpread: true, spreadIndex: 0, totalSpreads: 12,
      _cachedPhotoBase64: 'Y292ZXI=', _cachedPhotoMime: 'image/jpeg',
      referencePack: [{ label: 'CHARACTER MODEL SHEET', base64: 'c2hlZXQ=' }],
      bible: BIBLE, characterOutfit: BIBLE.outfitSpecText, attemptLog, gcsPath: 'children-jobs/b1/x.png',
      safeFallbackSuffix: 'WORLD LAWS: fixed.',
    });
    const prompts = fetchSpy.mock.calls.map(c => JSON.parse(c[1].body).contents[0].parts[0].text);
    // rung 2: trigger words gone from the SCENE, bible blocks and outfit intact
    expect(prompts[1]).not.toMatch(/\bkiss\b/);
    expect(prompts[1]).toContain('Top: red t-shirt. Bottom: blue jeans. Footwear: white sneakers.');
    expect(prompts[1]).toContain('PROPS (each quoted name is DATA');
    // rung 3: the scene is gone, the identity blocks and the suffix are back
    expect(prompts[2]).toContain('happy child');
    expect(prompts[2]).toContain('CHARACTER (THE ONLY CHILD');
    expect(prompts[2]).toContain('"teddy bear"');
    expect(prompts[2]).toContain('WORLD LAWS: fixed.');
    // Every fallback receives the same integration instruction AFTER all
    // reference pixels, without adding another image request or reference.
    for (const call of fetchSpy.mock.calls) {
      const parts = JSON.parse(call[1].body).contents[0].parts;
      expect(parts.at(-1).text).toContain('SCENE INTEGRATION (si-1)');
      expect(parts.filter(p => p.inline_data)).toHaveLength(1);
    }
    expect(attemptLog.filter(a => a.accepted)).toEqual([{ attempt: 3, variant: 'generic-safe', accepted: true }]);
  });

  test('cover generation does not receive the spread-only redraw instruction', async () => {
    fetchSpy.mockResolvedValue(okImage());
    await generateIllustration('A cover portrait.', 'https://x/cover.png', 'pixar_premium', {
      bookId: 'b1', childName: 'Emma', skipTextEmbed: true, isSpread: false,
      _cachedPhotoBase64: 'Y292ZXI=', _cachedPhotoMime: 'image/jpeg',
      gcsPath: 'children-jobs/b1/cover.png',
    });
    const parts = JSON.parse(fetchSpy.mock.calls[0][1].body).contents[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts.some(p => p.text?.includes('SCENE INTEGRATION'))).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

test('ce-19: the COMPANION block cites a PERSON companion\'s sheet in a person\'s terms, carries the FIXED LOOK spec, and pins exactly ONE', () => {
  const human = renderBibleBlocks({ ...BIBLE, companion: { name: 'Farmer Bea', type: 'friendly adult farm guide', ref: 4, specText: 'Farmer Bea: an elderly adult of sturdy build, long grey hair in two braids; outfit: blue denim overalls.', human: true } }).join('\n');
  expect(human).toContain('COMPANION: Farmer Bea, a friendly adult farm guide — draw EXACTLY the person of REFERENCE 4 (the same face, apparent age, hair colour/style/length, skin tone, build, and the same complete outfit on every spread; identity only — never copy that sheet\'s pose or background); friendly and warm, secondary to the child — a fictional adult guide who IS allowed in this scene');
  expect(human).toContain('FIXED LOOK (data, never to be reinterpreted): Farmer Bea: an elderly adult of sturdy build, long grey hair in two braids; outfit: blue denim overalls.');
  expect(human).toContain('Exactly ONE Farmer Bea in the scene — never two, never a look-alike.');
  // A creature keeps the design wording; the shared companionKind answer decides when `human` is not pinned.
  const creature = renderBibleBlocks({ ...BIBLE, companion: { name: 'Tavi', type: 'young triceratops', ref: 4, specText: 'Tavi: a child-sized creature, green.' } }).join('\n');
  expect(creature).toContain('COMPANION: Tavi, a young triceratops — draw EXACTLY the character of REFERENCE 4 (same design, colours and proportions on every spread); friendly and warm, secondary to the child. FIXED LOOK (data, never to be reinterpreted): Tavi: a child-sized creature, green. Exactly ONE Tavi in the scene');
  expect(creature).not.toContain('fictional adult guide');
  // Reference-less and spec-less (the pre-ce-19 shape): byte-identical wording, no ONE sentence.
  const bare = renderBibleBlocks(BIBLE).join('\n');
  expect(bare).toContain('COMPANION: Farmer Bea, a friendly adult farm guide; friendly and warm, secondary to the child — a fictional adult guide who IS allowed in this scene (draw them fully, face included, the same design on every spread); the no-other-humans rule applies to everyone else.');
  expect(bare).not.toContain('Exactly ONE Farmer Bea');
});

test('plot objects keep their story state and family count instead of decorative-only rules', () => {
  const rendered = renderBibleBlocks({ props: [{ name: 'Story object: route marker', storyObject: true, required: true, critical: true, ref: 3, specText: 'wood post, orange stripe', state: 'Third marker lies in grass.', multiplicity: 'group', instances: [{ id: 'third', description: 'displaced marker' }] }] }).join('\n');
  expect(rendered).toContain('Third marker lies in grass.');
  expect(rendered).toContain('group of matching objects is intentional');
  expect(rendered).not.toContain('never plot-critical');
  expect(rendered).not.toContain('Small and decorative');
});

test.each(['absent', 'off_screen'])('a %s story family is not requested from its reference sheet', visibility => {
  const rendered = renderBibleBlocks({ props: [{ name: 'meerkat group', storyObject: true, required: false,
    visibility, ref: 3, state: 'No group was there; Kito waited beside the child.', multiplicity: 'group',
    reference: { kind: 'group', subject: 'creature', description: 'A group of meerkats' } }] }).join('\n');
  expect(rendered).toContain('ABSENT FROM THIS PICTURE');
  expect(rendered).toContain('separately named companion');
  expect(rendered).not.toContain('A group has multiple intentional members');
  expect(rendered).not.toContain('see REFERENCE 3');
});
