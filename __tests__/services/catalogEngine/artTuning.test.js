/**
 * Art Tuning Layer: input validation, kill-switch, per-spread scene-block
 * composition, and the tag-keyed render-cache path — the worker-side half of
 * the illustration feedback loop (docs/AI_ILLUSTRATION_FEEDBACK_LOOP_PLAN.md).
 */

const {
  validateArtTuningInput,
  normalizeArtTuning,
  renderArtTuningBlock,
} = require('../../../services/catalogEngine/illustrator/tuning');
const {
  renderCachePath,
  renderStorySpreads,
} = require('../../../services/catalogEngine/illustrator');
const { STYLE_VERSION } = require('../../../services/catalogEngine/versions');

const TUNING = {
  versionLabel: 'art-003',
  hash: '9F31C2AB9F31C2AB',
  text: 'Warm key light on the child\'s face. Keep backgrounds simple.',
  spreads: { 3: 'Wide establishing shot of the world.' },
};

afterEach(() => {
  delete process.env.CATALOG_ART_TUNING_LAYER;
});

describe('illustrationTuning input validation', () => {
  test('absent tuning is valid; malformed shapes are named', () => {
    expect(validateArtTuningInput(undefined)).toBeNull();
    expect(validateArtTuningInput(null)).toBeNull();
    expect(validateArtTuningInput('rules')).toMatch(/object/);
    expect(validateArtTuningInput({ ...TUNING, versionLabel: 'bad label!' })).toMatch(/versionLabel/);
    expect(validateArtTuningInput({ ...TUNING, hash: 'nothex' })).toMatch(/hash/);
    expect(validateArtTuningInput({ ...TUNING, text: 42 })).toMatch(/text must be a string/);
    expect(validateArtTuningInput(TUNING)).toBeNull();
  });

  test('a global-only or spread-only overlay is valid; an EMPTY one is not', () => {
    expect(validateArtTuningInput({ versionLabel: 'art-001', hash: 'aabbccdd', text: 'soft rim light' })).toBeNull();
    expect(validateArtTuningInput({ versionLabel: 'art-001', hash: 'aabbccdd', spreads: { 9: 'dusk palette' } })).toBeNull();
    expect(validateArtTuningInput({ versionLabel: 'art-001', hash: 'aabbccdd' })).toMatch(/no visible directive text/);
    expect(validateArtTuningInput({ versionLabel: 'art-001', hash: 'aabbccdd', text: '  ', spreads: {} })).toMatch(/no visible directive text/);
  });

  test('spread keys must be spread numbers 1-12 with string values', () => {
    expect(validateArtTuningInput({ ...TUNING, spreads: { 0: 'x' } })).toMatch(/not a spread number/);
    expect(validateArtTuningInput({ ...TUNING, spreads: { 13: 'x' } })).toMatch(/not a spread number/);
    expect(validateArtTuningInput({ ...TUNING, spreads: { cover: 'x' } })).toMatch(/not a spread number/);
    expect(validateArtTuningInput({ ...TUNING, spreads: { 3: 42 } })).toMatch(/must be a string/);
    expect(validateArtTuningInput({ ...TUNING, spreads: ['x'] })).toMatch(/object keyed by spread number/);
  });

  test('byte caps: 2000 global / 400 per spread / 3000 total, counted in UTF-8 bytes', () => {
    expect(validateArtTuningInput({ ...TUNING, text: 'x'.repeat(2001) })).toMatch(/2000/);
    expect(validateArtTuningInput({ ...TUNING, spreads: { 3: 'x'.repeat(401) } })).toMatch(/400/);
    // 1900 + 4×300 = 3100 > 3000 although every part is under its own cap.
    expect(validateArtTuningInput({
      ...TUNING,
      text: 'x'.repeat(1900),
      spreads: { 1: 'x'.repeat(300), 2: 'x'.repeat(300), 3: 'x'.repeat(300), 4: 'x'.repeat(300) },
    })).toMatch(/3000 total/);
    // 1100 'é' chars = 2200 UTF-8 bytes but only 1100 code units.
    expect(validateArtTuningInput({ ...TUNING, text: 'é'.repeat(1100) })).toMatch(/2000/);
    expect(validateArtTuningInput({ ...TUNING, text: 'é'.repeat(900) })).toBeNull();
  });

  test('text that survives only as control characters is rejected, not silently dropped', () => {
    expect(validateArtTuningInput({
      versionLabel: 'art-001', hash: 'aabbccdd', text: ' ',
    })).toMatch(/no visible directive text/);
  });
});

describe('normalizeArtTuning', () => {
  test('strips control chars, drops empty spread entries, and builds the label.hash8 tag', () => {
    const t = normalizeArtTuning({ ...TUNING, text: 'keep\nlines but not bells', spreads: { 3: ' ok ', 9: ' ' } });
    expect(t.tag).toBe('art-003.9f31c2ab');
    expect(t.hash).toBe('9f31c2ab9f31c2ab');
    expect(t.text).toBe('keep\nlines but not bells');
    expect(t.spreads).toEqual({ 3: 'ok' });
  });

  test('CATALOG_ART_TUNING_LAYER=0 kill-switch drops the overlay entirely', () => {
    process.env.CATALOG_ART_TUNING_LAYER = '0';
    expect(normalizeArtTuning(TUNING)).toBeNull();
  });

  test('malformed input normalizes to null (never throws mid-render)', () => {
    expect(normalizeArtTuning({ versionLabel: 'bad label!', hash: 'aabbccdd', text: 'x' })).toBeNull();
    expect(normalizeArtTuning(undefined)).toBeNull();
  });
});

describe('renderArtTuningBlock', () => {
  const tuning = normalizeArtTuning(TUNING);

  test('frames the overlay as BINDING within its scope, subordinate to the hard rules', () => {
    const block = renderArtTuningBlock(tuning, 1);
    expect(block).toContain('ART TUNING art-003.9f31c2ab');
    // ce-7 reframe: "LOWEST priority … ignore that note" invited the model
    // to drop admin directives — the frame now BINDS on style/continuity
    // while still yielding to action/identity/count/text/medium/safety.
    expect(block).toContain('BINDING within its scope');
    expect(block).not.toContain('LOWEST priority');
    expect(block).toContain('subordinate ONLY to the scene action');
    expect(block).toContain('everywhere else, follow it');
    // Cross-spread continuity rules (what stays identical across the book)
    // ride the overlay dynamically — the frame must sanction them.
    expect(block).toContain('CROSS-SPREAD CONTINUITY');
    expect(block).toContain(TUNING.text);
  });

  test('a spread-scoped line rides ONLY its own spread', () => {
    expect(renderArtTuningBlock(tuning, 3)).toContain('For THIS spread only: Wide establishing shot');
    expect(renderArtTuningBlock(tuning, 4)).not.toContain('Wide establishing shot');
  });

  test('no tuning, or nothing for this spread, appends nothing', () => {
    expect(renderArtTuningBlock(null, 1)).toBe('');
    const spreadOnly = normalizeArtTuning({ versionLabel: 'art-001', hash: 'aabbccdd', spreads: { 9: 'dusk palette' } });
    expect(renderArtTuningBlock(spreadOnly, 8)).toBe('');
    expect(renderArtTuningBlock(spreadOnly, 9)).toContain('dusk palette');
  });
});

describe('tag-keyed render cache', () => {
  test("tag 'none' (and the default) keeps the pre-tuning path byte-identical", () => {
    const legacy = `children-jobs/b1/ce-renders/${STYLE_VERSION}/h1/spread-3.square.png`;
    expect(renderCachePath('b1', 'h1', 3, 'square')).toBe(legacy);
    expect(renderCachePath('b1', 'h1', 3, 'square', 'none')).toBe(legacy);
  });

  test('a tuning tag becomes a second cache dimension beside STYLE_VERSION', () => {
    expect(renderCachePath('b1', 'h1', 3, 'wide', 'art-003.9f31c2ab'))
      .toBe(`children-jobs/b1/ce-renders/${STYLE_VERSION}+art-003.9f31c2ab/h1/spread-3.wide.png`);
  });
});

describe('renderStorySpreads identity anchor', () => {
  test('no anchor fails with missing_identity_reference before any render IO', async () => {
    await expect(renderStorySpreads({
      bookId: 'b1',
      story: { book_id: 'x', spreads: [] },
      bookDef: { book: { beats: [] }, theme: {} },
      profile: { name: 'Emma', age: 2, pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' } },
      approvedCoverUrl: null,
      childPhotoUrl: null,
    })).rejects.toMatchObject({ failureCode: 'missing_identity_reference' });
  });
});
