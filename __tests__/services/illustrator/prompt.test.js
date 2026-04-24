/**
 * Tests for buildCorrectionTurn's tag-specific directive logic. Each directive
 * addresses a specific repeating Gemini failure mode observed in production.
 */

jest.mock('../../../services/illustrationGenerator', () => ({
  fetchWithTimeout: jest.fn(),
}));

const {
  buildCorrectionTurn,
  buildSpreadTurn,
  compactSceneForImageSafetyRetry,
  softenSceneForImageSafetyRetry,
  softenCaptionForImageSafetyRetry,
  minimalSafeSceneFallback,
} = require('../../../services/illustrator/prompt');

const base = {
  spreadIndex: 2,
  scene: 'A pond with two ducks, daytime, calm meadow.',
  leftText: 'They pass the pond, where two ducks dip and glide.',
  rightText: 'Vivienne points and sings, and Mama sings beside.',
};

describe('compactSceneForImageSafetyRetry / soften / caption / minimal fallback', () => {
  test('compact strips off-cover and caption placement blocks', () => {
    const scene = 'Focal action: walk.\nLocation: park.\n\nOff-cover cast rule (HARD):\n  - no full face.\n\nCaption placement (single-scene): NEVER blah';
    const out = compactSceneForImageSafetyRetry(scene);
    expect(out).toContain('Focal action: walk');
    expect(out).not.toMatch(/Off-cover cast rule/i);
    expect(out).not.toMatch(/Caption placement/i);
    expect(out).toMatch(/session system instruction/i);
  });

  test('compact returns original when no strip markers', () => {
    const s = 'Focal action: x.\nLocation: y.';
    expect(compactSceneForImageSafetyRetry(s)).toBe(s);
  });

  test('softens peek and pack phrasing in planner scenes', () => {
    expect(softenSceneForImageSafetyRetry('She peeks in every pack near a bench.'))
      .toMatch(/looks in each lunch bag/i);
  });

  test('softenCaptionForImageSafetyRetry matches scene rules', () => {
    const cap = 'Past play, she spots a snack.\nShe peeks in every pack.\nA star peeks by the seat.';
    const out = softenCaptionForImageSafetyRetry(cap);
    expect(out).toContain('looks in each lunch bag');
    expect(out).toContain('A star looks by the seat');
  });

  test('minimalSafeSceneFallback is generic and includes spread index', () => {
    const s = minimalSafeSceneFallback(2, 'birthday');
    expect(s).toMatch(/spread 3/i);
    expect(s).toMatch(/birthday/i);
  });
});

describe('buildSpreadTurn — shot variety reminder', () => {
  test('REMINDERS include shot variety line', () => {
    const out = buildSpreadTurn({
      spreadIndex: 3,
      scene: 'A calm pond at midday.',
      text: 'The ducks glide by.',
    });
    expect(out).toMatch(/Shot variety/i);
    expect(out).toMatch(/framing|angle/i);
  });

  test('childAge 3–8 uses larger vertical padding and longer-line reminder', () => {
    const out = buildSpreadTurn({
      spreadIndex: 0,
      scene: 'A sunny park.',
      text: 'We walked and talked and laughed all afternoon long.',
      childAge: 6,
    });
    expect(out).toMatch(/at least 26%/);
    expect(out).toMatch(/7 words per line|at most 7 words/i);
  });
});

describe('buildCorrectionTurn — tag directives', () => {
  test('text_in_center_band adds a delete-hallucinated-words directive', () => {
    const out = buildCorrectionTurn({
      ...base,
      issues: ['Text in center band: "I LOVE MAMA"'],
      tags: ['text_in_center_band'],
    });
    expect(out).toMatch(/SPECIFIC ACTIONS/);
    expect(out).toMatch(/center band/);
    expect(out).toMatch(/DELETE it/);
    expect(out).toMatch(/illustration-only/);
  });

  test('text_duplicated_caption adds a render-once directive', () => {
    const out = buildCorrectionTurn({
      ...base,
      issues: ['Caption appears to be printed twice on the image'],
      tags: ['text_duplicated_caption'],
    });
    expect(out).toMatch(/EXACTLY ONCE/);
    expect(out).toMatch(/Do not repeat/);
  });

  test('extra_word directive lists the permitted captions verbatim', () => {
    const out = buildCorrectionTurn({
      ...base,
      issues: ['Unexpected word "zero" in illustration (not in manuscript)'],
      tags: ['extra_word'],
    });
    expect(out).toMatch(/ONLY text permitted/);
    expect(out).toMatch(/They pass the pond/);
    expect(out).toMatch(/Vivienne points/);
  });

  test('spelling_mismatch directive reinforces character-for-character match', () => {
    const out = buildCorrectionTurn({
      ...base,
      issues: ['Left-side text mismatch'],
      tags: ['spelling_mismatch'],
    });
    expect(out).toMatch(/character-for-character/);
  });

  test('no tags → no SPECIFIC ACTIONS section, but still lists issues', () => {
    const out = buildCorrectionTurn({
      ...base,
      issues: ['something generic went wrong'],
      tags: [],
    });
    expect(out).not.toMatch(/SPECIFIC ACTIONS/);
    expect(out).toMatch(/something generic went wrong/);
  });

  test('multiple tags produce multiple directives', () => {
    const out = buildCorrectionTurn({
      ...base,
      issues: ['Text in center band: "X"', 'Caption appears to be printed twice on the image'],
      tags: ['text_in_center_band', 'text_duplicated_caption'],
    });
    expect(out).toMatch(/center band/);
    expect(out).toMatch(/EXACTLY ONCE/);
  });

  test('split_panel adds seamless panorama directive', () => {
    const out = buildCorrectionTurn({
      ...base,
      issues: ['Spread looks like a split panel / diptych with a visible seam'],
      tags: ['split_panel'],
    });
    expect(out).toMatch(/SPECIFIC ACTIONS/);
    expect(out).toMatch(/ONE seamless wide panorama|one seamless wide panorama/i);
    expect(out).toMatch(/diptych|stitched/i);
  });

  test('implied_parent_skin_mismatch adds skin-matching directive', () => {
    const out = buildCorrectionTurn({
      ...base,
      issues: ['Parent hands wrong tone'],
      tags: ['implied_parent_skin_mismatch'],
    });
    expect(out).toMatch(/SPECIFIC ACTIONS/);
    expect(out).toMatch(/BOOK COVER/);
    expect(out).toMatch(/skin tone/);
  });

  test('outfit_mismatch uses cover + session visual lock (no prose wardrobe)', () => {
    const out = buildCorrectionTurn({
      ...base,
      issues: ['Hero outfit differs from cover'],
      tags: ['outfit_mismatch'],
      characterOutfit: 'navy overalls, red sneakers, yellow tee',
    });
    expect(out).toMatch(/SPECIFIC ACTIONS/);
    expect(out).toMatch(/BOOK COVER/);
    expect(out).toMatch(/last accepted interior image/);
    expect(out).not.toMatch(/navy overalls/);
  });

  test('unexpected_person (parent theme, no secondary on cover) forbids strangers and full adults', () => {
    const out = buildCorrectionTurn({
      ...base,
      issues: ['Extra person in background'],
      tags: ['unexpected_person'],
      theme: 'mothers_day',
      hasSecondaryOnCover: false,
    });
    expect(out).toMatch(/SPECIFIC ACTIONS/);
    expect(out).toMatch(/background pedestrians|Remove any full-face/i);
    expect(out).toMatch(/IMPLIED presence/i);
  });

  test('wrong_font reinforces TEXT_RULES font lock', () => {
    const out = buildCorrectionTurn({
      ...base,
      issues: ['Caption font looks handwritten'],
      tags: ['wrong_font'],
    });
    expect(out).toMatch(/SPECIFIC ACTIONS/);
    expect(out).toMatch(/Georgia|Book Antiqua|serif/i);
  });
});
