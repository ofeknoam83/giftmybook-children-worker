/**
 * Tests for buildCorrectionTurn's tag-specific directive logic. Each directive
 * addresses a specific repeating Gemini failure mode observed in production.
 */

jest.mock('../../../services/illustrationGenerator', () => ({
  fetchWithTimeout: jest.fn(),
}));

const { buildCorrectionTurn } = require('../../../services/illustrator/prompt');

const base = {
  spreadIndex: 2,
  scene: 'A pond with two ducks, daytime, calm meadow.',
  leftText: 'They pass the pond, where two ducks dip and glide.',
  rightText: 'Vivienne points and sings, and Mama sings beside.',
};

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
    expect(out).toMatch(/hallucination/);
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
});
