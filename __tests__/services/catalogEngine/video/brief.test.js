/**
 * Journey brief (gv-2): pinned-data-only prompt for the single take — one
 * MOMENT per act with its window, action and camera line — reference
 * placeholders, hashing, the repair brief (single-take / journey notes
 * included), and the per-model rendering.
 */

jest.mock('../../../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(), uploadBuffer: jest.fn(), uploadBufferIfAbsent: jest.fn(), getSignedUrl: jest.fn(), deletePrefix: jest.fn(), saveJson: jest.fn(), loadJson: jest.fn(), objectExists: jest.fn(),
}));
jest.mock('../../../../services/illustrationGenerator', () => ({
  fetchWithTimeout: jest.fn(), getNextApiKey: jest.fn(() => 'k'), downloadPhotoAsBase64: jest.fn(), isModestBathWaterScene: jest.fn(() => false),
}));

const { buildJourneyBrief, repairBrief, renderPromptForModel, actionSentence, NEGATIVE_PROMPT } = require('../../../../services/catalogEngine/video/brief');
const { buildFilmPlan } = require('../../../../services/catalogEngine/video/plan');

const shotPlan = { 1: { shotType: 'wide' }, 7: { shotType: 'close-up' }, 12: { shotType: 'overhead' } };
const segment = () => buildFilmPlan({ scenes: [1, 7, 12], shotPlan, ageBand: '4-5' }).segments[0];
const acts = () => [
  { spread: 1, beat: 'Child gets ready to visit Sunnybrook Farm.', emotion: { emotion: 'curiosity', intensity: 'clear' }, companion: null, propValues: ['blue bunny'] },
  { spread: 7, beat: 'Child discovers three chickens and counts them.', emotion: { emotion: 'joy', intensity: 'big' }, companion: { name: 'Buttons', type: 'goat' }, propValues: ['blue bunny'] },
  { spread: 12, beat: 'Child waves goodbye to Sunnybrook Farm.', emotion: { emotion: 'tenderness', intensity: 'soft' }, companion: { name: 'Buttons', type: 'goat' }, propValues: [] },
];
const base = (over = {}) => buildJourneyBrief({
  segment: segment(), name: 'Emma', acts: acts(),
  references: [{ kind: 'character' }, { kind: 'companion' }, { kind: 'prop', value: 'blue bunny' }],
  theme: { display_name: 'Farm', world_name: 'Sunnybrook Farm' }, ageBand: '4-5', endFrame: true, ...over,
});

describe('buildJourneyBrief', () => {
  test('is byte-stable for the same inputs and changes hash with the inputs', () => {
    const a = base();
    const b = base();
    expect(a.prompt).toBe(b.prompt);
    expect(a.hash).toBe(b.hash);
    expect(base({ name: 'Noa' }).hash).not.toBe(a.hash);
    expect(base({ endFrame: false }).hash).not.toBe(a.hash);
  });
  test('describes one unbroken take with a moment per act, its window, action and camera', () => {
    const b = base();
    expect(b.prompt).toMatch(/^Animate this children's-book illustration into ONE continuous, unbroken 10-second shot/);
    expect(b.prompt).toContain('JOURNEY: Emma travels through 3 moments of Sunnybrook Farm in one continuous take');
    expect(b.prompt).toContain('MOMENT 1 (0–3.3s, starts exactly on the first frame): Emma gets ready to visit Sunnybrook Farm. CAMERA: a wide establishing angle');
    expect(b.prompt).toContain('MOMENT 2 (3.3–6.7s): Emma advances into the next part of Sunnybrook Farm: Emma discovers three chickens and counts them. CAMERA: the camera pushes in slowly to a close angle');
    expect(b.prompt).toContain('MOMENT 3 (6.7–10s): Emma advances into the next part of Sunnybrook Farm: Emma waves goodbye to Sunnybrook Farm. CAMERA: the camera rises and drifts higher to a high angle');
    expect(b.prompt).toContain('settles on the final composition — exactly the last frame');
    expect(b.prompt).toContain('COMPANION: Buttons (goat) is present in moments 2 and 3');
    expect(b.prompt).toContain('exactly as in [REF2]');
    expect(b.prompt).toContain('PERFORMANCE: the child\'s expression reads, moment by moment, as clear curiosity');
    expect(b.prompt).toContain('then big joy');
    expect(b.prompt).toContain('exactly ONE child — Emma, the child of [REF1]');
    expect(b.prompt).toContain('"blue bunny" (exactly as [REF3])');
    expect(b.prompt).toContain('no cuts, fades, wipes or scene jumps');
    expect(b.negativePrompt).toBe(NEGATIVE_PROMPT);
    expect(b.cameraMotion).toBe('journey');
    expect(b.angles).toEqual(['wide', 'close', 'overhead']);
    expect(b.motionScale).toBe('big');
    expect(b.params.cfgScale).toBe(0.5);
  });
  test('without an end frame the last moment only settles; band 1-3 caps the motion scale', () => {
    const b = base({ endFrame: false, ageBand: '1-3' });
    expect(b.prompt).toContain('settles on the final composition.');
    expect(b.prompt).not.toContain('exactly the last frame');
    expect(b.motionScale).toBe('clear');
  });
  test('sanitizes profile strings and never lets quotes or control characters through', () => {
    const b = buildJourneyBrief({ segment: buildFilmPlan({ scenes: [2] }).segments[0], name: 'Em"ma', acts: [{ spread: 2, beat: 'Child waves.', emotion: null, companion: null, propValues: ['tea"pot'] }], references: [], theme: null });
    expect(b.prompt).not.toMatch(new RegExp('[\\u0000-\\u0009\\u000b-\\u001f]')); // newlines separate the blocks; nothing else
    expect(b.prompt).toContain('Emma waves');
    expect(b.prompt).not.toContain('Em"ma');
    expect(b.prompt).toContain('"teapot"'); // the template quotes props; the value itself lost its quote
    expect(b.prompt).toContain('one moment of the world of the book');
    expect(b.prompt).toContain('PERFORMANCE: a warm, natural expression');
  });
  test('an act without a beat still gets a moment line', () => {
    const b = buildJourneyBrief({ segment: buildFilmPlan({ scenes: [3, 9] }).segments[0], name: 'Noa', acts: [{ spread: 3, beat: null, emotion: null, companion: null, propValues: [] }], references: [], theme: null });
    expect(b.prompt).toContain('MOMENT 1 (0–5s, starts exactly on the first frame): Noa looks around and moves on');
    expect(b.prompt).toContain('MOMENT 2 (5–10s): Noa advances into the next part of the world of the book: Noa looks around and moves on');
  });
});

describe('repairBrief', () => {
  test('appends template notes for the defects and nudges the knobs', () => {
    const b = base();
    const r = repairBrief(b, ['identity break: the child does not match the character model sheet', 'motion break: the face or body morphs or deforms during the clip']);
    expect(r.prompt).toContain('IDENTITY REPAIR');
    expect(r.prompt).toContain('MOTION REPAIR');
    expect(r.params.cfgScale).toBe(0.7);
    expect(r.motionScale).toBe('soft');
    expect(r.prompt).toContain('Motion scale: barely moving');
    expect(r.hash).not.toBe(b.hash);
    expect(b.params.cfgScale).toBe(0.5); // pure — the base is untouched
  });
  test('a cut, a static journey and a static camera get their own single-take notes', () => {
    const r = repairBrief(base(), ['cut break: the clip contains a cut or transition instead of one continuous shot', 'journey break: the surroundings never change — the child does not advance into the next moment', 'composition break: the camera angle does not change along the take']);
    expect(r.prompt).toContain('SINGLE-TAKE REPAIR');
    expect(r.prompt).toContain('JOURNEY REPAIR');
    expect(r.prompt).toContain('CAMERA REPAIR');
    expect(r.params.cfgScale).toBe(0.5);
  });
  test('unknown defects leave the brief as it is', () => {
    const b = base();
    const r = repairBrief(b, ['something new']);
    expect(r.prompt).toBe(b.prompt);
    expect(r.hash).toBe(b.hash);
  });
});

describe('renderPromptForModel', () => {
  test('renders placeholders into the model mention syntax, or the first frame without references', () => {
    const b = base();
    expect(renderPromptForModel(b, i => `@Element${i}`)).toContain('the child of @Element1');
    expect(renderPromptForModel(b, null)).toContain('the child of the first frame');
    expect(renderPromptForModel(b, null)).not.toContain('[REF');
  });
});

describe('actionSentence', () => {
  test('replaces the generic subject with the name', () => {
    expect(actionSentence('Child gets ready to visit the farm.', 'Noa')).toBe('Noa gets ready to visit the farm');
    expect(actionSentence('The child waves.', 'Noa')).toBe('Noa waves');
    expect(actionSentence('waves at the goat', 'Noa')).toBe('Noa waves at the goat');
  });
});
