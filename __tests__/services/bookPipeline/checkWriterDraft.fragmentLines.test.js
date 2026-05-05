const {
  findInfantFragmentLines,
  lineHasFiniteVerb,
} = require('../../../services/bookPipeline/qa/checkWriterDraft');
const { AGE_BANDS } = require('../../../services/bookPipeline/constants');

// PR R: infant_fragment_line. Every infant couplet line must have subject +
// finite verb. Catches "Mama, soft glow", "Leaves, soft show", "Mama eyes
// aglow", "Sunlit joy below" — all from draft 9. The detector is conservative:
// false negatives are OK, false positives are not.

describe('lineHasFiniteVerb (PR R)', () => {
  describe('lines that MUST be detected as having a finite verb', () => {
    test('explicit copular verb (is)', () => {
      expect(lineHasFiniteVerb('Mama is happy.')).toBe(true);
    });

    test('plural copular (are)', () => {
      expect(lineHasFiniteVerb('Bees are humming.')).toBe(true);
    });

    test('-s third-person regular verb in non-final position', () => {
      // "Mama lifts her hands" — "hands" is a noun plural (excluded by
      // INFANT_NOUN_PLURALS), but "lifts" must be detected.
      expect(lineHasFiniteVerb('Mama lifts her hands.')).toBe(true);
    });

    test('short clause with verb at the end (≤3 tokens, "Mama laughs")', () => {
      expect(lineHasFiniteVerb('Mama laughs.')).toBe(true);
    });

    test('-ed regular past in non-final position', () => {
      expect(lineHasFiniteVerb('Mama hummed her song.')).toBe(true);
    });

    test('irregular verb (sees) anywhere on the line', () => {
      expect(lineHasFiniteVerb('Mama sees the moon.')).toBe(true);
    });

    test('explicit "sit" / "hold" — small infant-safe verbs from voice rules', () => {
      expect(lineHasFiniteVerb('Mama holds the bear.')).toBe(true);
      expect(lineHasFiniteVerb('Baby sits in lap.')).toBe(true);
    });
  });

  describe('lines that MUST be detected as fragments (no finite verb)', () => {
    test('comma-fragment "Mama, soft glow" (draft 9 S8)', () => {
      expect(lineHasFiniteVerb('Mama, soft glow')).toBe(false);
    });

    test('plural-noun fragment "Leaves, soft show" (draft 9 S8) — "leaves" is a plural noun, not a verb', () => {
      expect(lineHasFiniteVerb('Leaves, soft show')).toBe(false);
    });

    test('appositive fragment "Mama eyes aglow" (draft 9 S10) — "eyes" is plural noun', () => {
      expect(lineHasFiniteVerb('Mama eyes aglow')).toBe(false);
    });

    test('label fragment "Sunlit joy below" (draft 9 S10)', () => {
      expect(lineHasFiniteVerb('Sunlit joy below')).toBe(false);
    });

    test('pure noun list "Soft beams, gentle dreams"', () => {
      expect(lineHasFiniteVerb('Soft beams, gentle dreams')).toBe(false);
    });
  });
});

describe('findInfantFragmentLines (PR R)', () => {
  test('returns [] for non-infant age bands (no false positives at toddler/preschool)', () => {
    const txt = 'Mama, soft glow\nLeaves, soft show';
    expect(findInfantFragmentLines(txt, AGE_BANDS.PB_TODDLER)).toEqual([]);
    expect(findInfantFragmentLines(txt, AGE_BANDS.PB_PRESCHOOL)).toEqual([]);
  });

  test('flags both fragment lines from draft-9 spread 8', () => {
    const txt = 'Mama, soft glow\nLeaves, soft show';
    const out = findInfantFragmentLines(txt, AGE_BANDS.PB_INFANT);
    expect(out).toEqual(['Mama, soft glow', 'Leaves, soft show']);
  });

  test('flags both fragment lines from draft-9 spread 10', () => {
    const txt = 'Mama eyes aglow\nSunlit joy below';
    const out = findInfantFragmentLines(txt, AGE_BANDS.PB_INFANT);
    expect(out).toEqual(['Mama eyes aglow', 'Sunlit joy below']);
  });

  test('passes a clean infant couplet (subject + verb on each line)', () => {
    const txt = 'Mama lifts her hands.\nBaby smiles wide.';
    const out = findInfantFragmentLines(txt, AGE_BANDS.PB_INFANT);
    expect(out).toEqual([]);
  });

  test('flags only the fragment when one line is fine and the other is broken', () => {
    const txt = 'Mama is humming.\nLeaves, soft show';
    const out = findInfantFragmentLines(txt, AGE_BANDS.PB_INFANT);
    expect(out).toEqual(['Leaves, soft show']);
  });

  test('handles empty / blank input safely', () => {
    expect(findInfantFragmentLines('', AGE_BANDS.PB_INFANT)).toEqual([]);
    expect(findInfantFragmentLines('   \n\n  ', AGE_BANDS.PB_INFANT)).toEqual([]);
    expect(findInfantFragmentLines(null, AGE_BANDS.PB_INFANT)).toEqual([]);
    expect(findInfantFragmentLines(undefined, AGE_BANDS.PB_INFANT)).toEqual([]);
  });

  test('does not flag short single-clause lines like "Mama laughs"', () => {
    // "Mama laughs" is a complete sentence (subject + finite verb), even though
    // the verb sits at the line end. The ≤3-token + verb-suffix path saves it.
    const txt = 'Mama laughs.\nBaby giggles.';
    const out = findInfantFragmentLines(txt, AGE_BANDS.PB_INFANT);
    expect(out).toEqual([]);
  });
});
