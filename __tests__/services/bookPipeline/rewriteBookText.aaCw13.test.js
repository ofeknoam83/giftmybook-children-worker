/**
 * AA-CW-13 \u2014 general craft rules + verb_crutch hard gate.
 *
 * Two surfaces under test:
 *
 *   1. JUDGE_SYSTEM prompt now teaches the judge five new principles
 *      (interjection-as-rhyme, r-controlled vowel mismatch, mandatory
 *      verb/refrain counting, semantic_filler, forced_rhyme_meaning_drift).
 *      Each was added in response to a real production manuscript that
 *      the previous prompt let through. We don't unit-test the LLM,
 *      but we DO lock that the prompt contains the principles + the
 *      generic example anchors so a regression of the prompt is caught.
 *
 *   2. collectWriterFatalResiduals now raises offenders for:
 *        per-spread:    semantic_filler, forced_rhyme_meaning_drift
 *        book-level:    verb_crutch
 *      matching the same wave-exhaustion contract as AA-CW-12.
 */

const {
  collectWriterFatalResiduals,
  WRITER_FATAL_TAGS,
  WRITER_FATAL_BOOK_LEVEL_TAGS,
} = require('../../../services/bookPipeline/writer/rewriteBookText');
const { JUDGE_SYSTEM } = require('../../../services/bookPipeline/qa/checkWriterDraft');

function makeDoc({ perSpread = [], bookLevel = [] } = {}) {
  // NOTE: this passes 'PB_INFANT' (the constants KEY) not the VALUE
  // ('0-1'). The AA-CW-20 band check compares against the VALUE, so
  // these tests do NOT trigger the PB_INFANT taste-tag demotion — they
  // exercise the full fatal-tag set. AA-CW-20 has its own dedicated
  // band-conditional tests in __tests__/services/bookPipeline/aaCw20.test.js.
  return {
    request: { ageBand: 'PB_INFANT' },
    operationalContext: { bookId: 'test-book' },
    writerQa: { perSpread, bookLevel },
  };
}

describe('AA-CW-13 \u2014 general craft rules + verb_crutch hard gate', () => {
  describe('WRITER_FATAL_TAGS (per-spread)', () => {
    test('includes the unconditional + taste tags (union, length 5)', () => {
      // AA-CW-20: the exported WRITER_FATAL_TAGS is the union of
      // unconditional and taste tag lists for backwards compatibility.
      // The actual gating behaviour is band-conditional inside
      // collectWriterFatalResiduals.
      expect(WRITER_FATAL_TAGS).toEqual(expect.arrayContaining([
        'identity_rhyme',
        'unrenderable_action',
        'writer_invented_prop',
        'semantic_filler',
        'forced_rhyme_meaning_drift',
      ]));
      expect(WRITER_FATAL_TAGS).toHaveLength(5);
    });
  });

  describe('WRITER_FATAL_BOOK_LEVEL_TAGS', () => {
    test('contains verb_crutch and only verb_crutch', () => {
      expect(WRITER_FATAL_BOOK_LEVEL_TAGS).toEqual(['verb_crutch']);
    });

    test('does NOT contain refrain_crutch (intentionally soft-gated)', () => {
      expect(WRITER_FATAL_BOOK_LEVEL_TAGS).not.toContain('refrain_crutch');
    });
  });

  describe('collectWriterFatalResiduals \u2014 per-spread additions', () => {
    test('semantic_filler tag produces an offender', () => {
      const out = collectWriterFatalResiduals(makeDoc({
        perSpread: [
          {
            spreadNumber: 9,
            tags: ['semantic_filler'],
            issues: ['semantic_filler: "Mama stays close, she knows." \u2014 dangling subordinate, no new image.'],
          },
        ],
      }));
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ spreadNumber: 9, tag: 'semantic_filler' });
      expect(out[0].issue).toMatch(/she knows/);
    });

    test('forced_rhyme_meaning_drift tag produces an offender', () => {
      const out = collectWriterFatalResiduals(makeDoc({
        perSpread: [
          {
            spreadNumber: 5,
            tags: ['forced_rhyme_meaning_drift'],
            issues: ['forced_rhyme_meaning_drift: "Mama laughs at that wail." \u2014 wrong emotional valence.'],
          },
        ],
      }));
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ spreadNumber: 5, tag: 'forced_rhyme_meaning_drift' });
    });

    test('multiple per-spread fatal tags on one spread produce one offender per tag', () => {
      const out = collectWriterFatalResiduals(makeDoc({
        perSpread: [
          {
            spreadNumber: 11,
            tags: ['semantic_filler', 'forced_rhyme_meaning_drift'],
            issues: [
              'semantic_filler: "Snuggles stay so sweet." \u2014 abstract.',
              'forced_rhyme_meaning_drift: "Mama rocks her seat." \u2014 geometrically odd.',
            ],
          },
        ],
      }));
      expect(out).toHaveLength(2);
      expect(out.map(o => o.tag).sort()).toEqual(['forced_rhyme_meaning_drift', 'semantic_filler']);
    });
  });

  describe('collectWriterFatalResiduals \u2014 book-level verb_crutch', () => {
    test('book-level verb_crutch issue produces a book-level offender (spreadNumber: null)', () => {
      const out = collectWriterFatalResiduals(makeDoc({
        bookLevel: ["verb_crutch: 'squeal' appears in 6 of 13 spreads (46%) \u2014 spreads 5, 7, 8, 11, 12, 13."],
      }));
      expect(out).toHaveLength(1);
      expect(out[0].spreadNumber).toBeNull();
      expect(out[0].tag).toBe('verb_crutch');
      expect(out[0].issue).toMatch(/squeal/);
    });

    test('book-level verb_crutch + per-spread semantic_filler produce two offenders', () => {
      const out = collectWriterFatalResiduals(makeDoc({
        perSpread: [
          {
            spreadNumber: 7,
            tags: ['semantic_filler'],
            issues: ['semantic_filler: line is filler.'],
          },
        ],
        bookLevel: ['verb_crutch: hold appears in 5 of 13 spreads.'],
      }));
      expect(out).toHaveLength(2);
      const tags = out.map(o => o.tag).sort();
      expect(tags).toEqual(['semantic_filler', 'verb_crutch']);
      const bookLevel = out.find(o => o.tag === 'verb_crutch');
      expect(bookLevel.spreadNumber).toBeNull();
      const perSpread = out.find(o => o.tag === 'semantic_filler');
      expect(perSpread.spreadNumber).toBe(7);
    });

    test('book-level WITHOUT verb_crutch text does not match (substring is required)', () => {
      const out = collectWriterFatalResiduals(makeDoc({
        bookLevel: ['low_personalization_saturation: only 30% of spreads use the questionnaire.'],
      }));
      expect(out).toEqual([]);
    });

    test('refrain_crutch in bookLevel does NOT produce an offender (soft-gated)', () => {
      const out = collectWriterFatalResiduals(makeDoc({
        bookLevel: ["refrain_crutch: 'blanket' appears in 5 of 13 spreads."],
      }));
      expect(out).toEqual([]);
    });
  });

  describe('Task D \u2014 JUDGE_SYSTEM contains the new general rules', () => {
    test('rhyme_fail teaches r-controlled vowel mismatch with phonetic principle', () => {
      expect(JUDGE_SYSTEM).toMatch(/R-CONTROLLED VOWEL MISMATCH/);
      // canonical example pair
      expect(JUDGE_SYSTEM).toMatch(/arm\/warm/);
      // the principle, not just the example
      expect(JUDGE_SYSTEM).toMatch(/vowel before \/r\/ carries the rhyme/);
    });

    test('rhyme_fail teaches interjection-as-rhyme as a fail family', () => {
      expect(JUDGE_SYSTEM).toMatch(/INTERJECTION/);
      expect(JUDGE_SYSTEM).toMatch(/Ta-da/);
      // The principle phrasing, not just the example
      expect(JUDGE_SYSTEM).toMatch(/interjections are theatrical, not lexical/);
    });

    test('verb_crutch rule contains a mandatory counting procedure (lemma + threshold)', () => {
      expect(JUDGE_SYSTEM).toMatch(/Mandatory counting procedure/);
      expect(JUDGE_SYSTEM).toMatch(/lemma/i);
      expect(JUDGE_SYSTEM).toMatch(/MORE THAN 25%/);
      expect(JUDGE_SYSTEM).toMatch(/Do NOT eyeball this/);
    });

    test('refrain_crutch rule has the same counting procedure with motif carve-out', () => {
      expect(JUDGE_SYSTEM).toMatch(/load-bearing motif/);
      expect(JUDGE_SYSTEM).toMatch(/refrain_crutch/);
    });

    test('semantic_filler rule defines three independent tests', () => {
      expect(JUDGE_SYSTEM).toMatch(/semantic_filler/);
      expect(JUDGE_SYSTEM).toMatch(/Image test/);
      expect(JUDGE_SYSTEM).toMatch(/Cut test/);
      expect(JUDGE_SYSTEM).toMatch(/Rhyme-completer test/);
    });

    test('forced_rhyme_meaning_drift defines emotional valence + physical plausibility tests', () => {
      expect(JUDGE_SYSTEM).toMatch(/forced_rhyme_meaning_drift/);
      expect(JUDGE_SYSTEM).toMatch(/Emotional valence/);
      expect(JUDGE_SYSTEM).toMatch(/Physical plausibility/);
    });

    test('Pass criteria forbids all five new conditions', () => {
      // AA-CW-20: semantic_filler / forced_rhyme_meaning_drift are
      // advisory at PB_INFANT but still fatal at PB_TODDLER /
      // PB_PRESCHOOL. The pass-criteria block names the band-conditional
      // wording instead of the unconditional "No X hits" lines from
      // AA-CW-13.
      expect(JUDGE_SYSTEM).toMatch(/no semantic_filler/);
      expect(JUDGE_SYSTEM).toMatch(/no forced_rhyme_meaning_drift/);
      expect(JUDGE_SYSTEM).toMatch(/No verb_crutch at book level/);
      expect(JUDGE_SYSTEM).toMatch(/r-controlled-mismatch\/interjection/);
    });
  });
});
