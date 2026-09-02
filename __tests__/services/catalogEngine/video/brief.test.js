/**
 * Clip brief (gv-1): pinned-data-only prompt, reference placeholders,
 * hashing, the repair brief, and the per-model rendering.
 */

jest.mock('../../../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(), uploadBuffer: jest.fn(), uploadBufferIfAbsent: jest.fn(), getSignedUrl: jest.fn(), deletePrefix: jest.fn(), saveJson: jest.fn(), loadJson: jest.fn(), objectExists: jest.fn(),
}));
jest.mock('../../../../services/illustrationGenerator', () => ({
  fetchWithTimeout: jest.fn(), getNextApiKey: jest.fn(() => 'k'), downloadPhotoAsBase64: jest.fn(), isModestBathWaterScene: jest.fn(() => false),
}));

const { buildClipBrief, repairBrief, renderPromptForModel, actionSentence, NEGATIVE_PROMPT } = require('../../../../services/catalogEngine/video/brief');

const base = () => buildClipBrief({
  segment: { kind: 'spread', spread: 7, motion: 'pan-left', seconds: 3 },
  name: 'Emma',
  beat: 'Child arrives in Sunnybrook Farm and takes in the main sights.',
  companion: { name: 'Buttons', type: 'goat' },
  emotion: { emotion: 'wonder', intensity: 'clear' },
  propValues: ['blue bunny'],
  references: [{ kind: 'character' }, { kind: 'companion' }, { kind: 'prop', value: 'blue bunny' }],
  ageBand: '4-5',
});

describe('buildClipBrief', () => {
  test('is byte-stable for the same inputs and changes hash with the inputs', () => {
    const a = base();
    const b = base();
    expect(a.prompt).toBe(b.prompt);
    expect(a.hash).toBe(b.hash);
    const c = buildClipBrief({ ...{ segment: { kind: 'spread', spread: 7, motion: 'push-in', seconds: 3 }, name: 'Emma', beat: 'x', companion: null, emotion: null, propValues: [], references: [{ kind: 'character' }] } });
    expect(c.hash).not.toBe(a.hash);
  });
  test('carries the action with the name, the camera, the emotion cue, the lock and the rules', () => {
    const b = base();
    expect(b.prompt).toContain('ACTION: Emma arrives in Sunnybrook Farm');
    expect(b.prompt).toContain('CAMERA: a slow, smooth pan to the left');
    expect(b.prompt).toContain('clear wonder');
    expect(b.prompt).toContain('exactly ONE child — Emma, the child of [REF1]');
    expect(b.prompt).toContain('COMPANION: Buttons (goat)');
    expect(b.prompt).toContain('exactly as in [REF2]');
    expect(b.prompt).toContain('"blue bunny" (exactly as [REF3])');
    expect(b.prompt).toContain('no speech');
    expect(b.prompt).toContain('no text, captions');
    expect(b.negativePrompt).toBe(NEGATIVE_PROMPT);
    expect(b.cameraMotion).toBe('pan-left');
    expect(b.params.cfgScale).toBe(0.5);
  });
  test('sanitizes profile strings and never lets quotes or control characters through', () => {
    const b = buildClipBrief({ segment: { kind: 'spread', spread: 2, motion: 'hold', seconds: 3 }, name: 'Em"ma', beat: 'Child waves.', companion: null, emotion: null, propValues: ['tea"pot'], references: [] });
    expect(b.prompt).not.toMatch(new RegExp('[\\u0000-\\u0009\\u000b-\\u001f]')); // newlines separate the blocks; nothing else
    expect(b.prompt).toContain('Emma waves');
    expect(b.prompt).not.toContain('Em"ma');
    expect(b.prompt).toContain('"teapot"'); // the template quotes props; the value itself lost its quote
  });
  test('the cover segment gets its own action and no beat', () => {
    const b = buildClipBrief({ segment: { kind: 'cover', spread: null, motion: 'push-in', seconds: 2.4 }, name: 'Emma', beat: null, companion: null, emotion: null, propValues: [], references: [{ kind: 'character' }] });
    expect(b.prompt).toContain("comes alive on the book's cover");
  });
  test('band 1-3 caps the motion scale below big', () => {
    const b = buildClipBrief({ segment: { kind: 'spread', spread: 3, motion: 'push-in', seconds: 3 }, name: 'Emma', beat: 'Child laughs.', companion: null, emotion: { emotion: 'joy', intensity: 'big' }, propValues: [], references: [], ageBand: '1-3' });
    expect(b.motionScale).toBe('clear');
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
