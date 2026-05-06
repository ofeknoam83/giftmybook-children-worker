/**
 * AA-CW-21 — gut the writer-QA judge.
 *
 * Production data through AA-CW-20 (PR #162, deploy 25440438594) showed
 * that even with same-model self-critique (gpt-5.4 judging gpt-5.4), the
 * 21-rule judge prompt kept failing manuscripts on aesthetic-disqualifier
 * tags (`semantic_filler`, `forced_rhyme_meaning_drift`, `verb_crutch`,
 * `low_personalization_saturation`, `signature_beat_missing`,
 * `fragment_line`) which the writer cannot mechanically fix in a finite
 * number of waves. Each wave rediscovered a new local optimum that
 * raised a new combination of taste tags. Two waves of taste-rejection
 * burned ~10k tokens per book without converging.
 *
 * AA-CW-21 strips the judge to FIVE mechanically falsifiable defects:
 *   - rhyme_fail (judge call + deterministic identity-rhyme audit)
 *   - dropped_article (judge call + deterministic regex audit)
 *   - address_name_concat ("Mama Courtney")
 *   - infant_action_verb_in_text (PB_INFANT only, judge + locomotion-hits)
 *   - identity_pronoun_swap (pronouns inconsistent with brief.pronouns)
 *
 * Everything else is the writer's call. `verb_crutch`, `refrain_crutch`,
 * `signature_beat_missing`, `low_personalization_saturation`,
 * `semantic_filler`, `forced_rhyme_meaning_drift`, `fragment_line`,
 * `nonsense_word`, `nonsense_simile`, `theme_cliche`, `unrenderable_action`,
 * `writer_invented_prop` — none gate ship any longer. They are still
 * logged for forensics if the LLM raises them, but checkWriterDraft
 * filters them out of `perSpread.tags` and never sets `pass=false`
 * on their account.
 *
 * Wave budget drops from 2 -> 1: with five mechanically falsifiable
 * tags, one rewrite is enough.
 */

const path = require('path');

const { JUDGE_SYSTEM } = require('../../../services/bookPipeline/qa/checkWriterDraft');
const {
  WRITER_FATAL_TAGS,
  WRITER_FATAL_TAGS_UNCONDITIONAL,
  WRITER_FATAL_TAGS_TASTE,
  WRITER_FATAL_BOOK_LEVEL_TAGS,
  collectWriterFatalResiduals,
} = require('../../../services/bookPipeline/writer/rewriteBookText');
const { REPAIR_BUDGETS, AGE_BANDS } = require('../../../services/bookPipeline/constants');

// =============================================================================
// REPAIR_BUDGETS lock — wave 1
// =============================================================================

describe('AA-CW-21 — REPAIR_BUDGETS', () => {
  test('writerRewriteWaves is 1 (down from 2)', () => {
    expect(REPAIR_BUDGETS.writerRewriteWaves).toBe(1);
  });
});

// =============================================================================
// WRITER_FATAL_TAGS shape lock
// =============================================================================

describe('AA-CW-21 — WRITER_FATAL_TAGS gutted to five mechanical defects', () => {
  test('WRITER_FATAL_TAGS_UNCONDITIONAL is exactly the AA-CW-21 short list', () => {
    expect(new Set(WRITER_FATAL_TAGS_UNCONDITIONAL)).toEqual(
      new Set([
        'rhyme_fail',
        'identity_rhyme',
        'dropped_article',
        'address_name_concat',
        'infant_action_verb_in_text',
        'identity_pronoun_swap',
      ]),
    );
  });

  test('WRITER_FATAL_TAGS_TASTE is empty', () => {
    expect(WRITER_FATAL_TAGS_TASTE).toEqual([]);
  });

  test('WRITER_FATAL_TAGS is the union (length 6)', () => {
    expect(WRITER_FATAL_TAGS).toHaveLength(6);
  });

  test('WRITER_FATAL_BOOK_LEVEL_TAGS is empty (verb_crutch demoted)', () => {
    expect(WRITER_FATAL_BOOK_LEVEL_TAGS).toEqual([]);
  });
});

// =============================================================================
// collectWriterFatalResiduals — only the five tags survive
// =============================================================================

describe('AA-CW-21 — collectWriterFatalResiduals filters non-AA-CW-21 tags', () => {
  function makeDoc(perSpread, bookLevel = [], ageBand = AGE_BANDS.PB_INFANT) {
    return {
      request: { ageBand },
      writerQa: { perSpread, bookLevel },
    };
  }

  test('semantic_filler tag does NOT produce an offender', () => {
    const offenders = collectWriterFatalResiduals(
      makeDoc([{ spreadNumber: 1, tags: ['semantic_filler'], issues: ['semantic_filler: vague'] }]),
    );
    expect(offenders).toEqual([]);
  });

  test('verb_crutch book-level tag does NOT produce an offender', () => {
    const offenders = collectWriterFatalResiduals(
      makeDoc(
        [{ spreadNumber: 1, tags: [], issues: [] }],
        ['verb_crutch: "squeal" appears in 6 of 13 spreads'],
      ),
    );
    expect(offenders).toEqual([]);
  });

  test('refrain_crutch book-level tag does NOT produce an offender', () => {
    const offenders = collectWriterFatalResiduals(
      makeDoc(
        [{ spreadNumber: 1, tags: [], issues: [] }],
        ['refrain_crutch: "blanket" appears in 5 of 13 spreads'],
      ),
    );
    expect(offenders).toEqual([]);
  });

  test('signature_beat_missing on a spread does NOT produce an offender', () => {
    const offenders = collectWriterFatalResiduals(
      makeDoc([
        {
          spreadNumber: 3,
          tags: ['signature_beat_missing'],
          issues: ['signature_beat_missing: surface the funny_thing anchor'],
        },
      ]),
    );
    expect(offenders).toEqual([]);
  });

  test('rhyme_fail / identity_rhyme produce offenders at every band', () => {
    for (const band of [AGE_BANDS.PB_INFANT, AGE_BANDS.PB_TODDLER, AGE_BANDS.PB_PRESCHOOL]) {
      const offenders = collectWriterFatalResiduals(
        makeDoc(
          [
            {
              spreadNumber: 4,
              tags: ['rhyme_fail', 'identity_rhyme'],
              issues: ['rhyme_fail: identity rhyme on lines 1+2 — "cheek/cheek"'],
            },
          ],
          [],
          band,
        ),
      );
      expect(offenders.length).toBeGreaterThan(0);
      expect(offenders[0].spreadNumber).toBe(4);
    }
  });

  test('dropped_article produces an offender', () => {
    const offenders = collectWriterFatalResiduals(
      makeDoc([
        {
          spreadNumber: 2,
          tags: ['dropped_article'],
          issues: ['dropped_article: line 1 "at sky" missing a determiner'],
        },
      ]),
    );
    expect(offenders.length).toBe(1);
    expect(offenders[0].tag).toBe('dropped_article');
  });

  test('address_name_concat produces an offender', () => {
    const offenders = collectWriterFatalResiduals(
      makeDoc([
        {
          spreadNumber: 5,
          tags: ['address_name_concat'],
          issues: ['address_name_concat: "Mama Courtney" on line 3'],
        },
      ]),
    );
    expect(offenders.length).toBe(1);
    expect(offenders[0].tag).toBe('address_name_concat');
  });

  test('infant_action_verb_in_text produces an offender', () => {
    const offenders = collectWriterFatalResiduals(
      makeDoc([
        {
          spreadNumber: 7,
          tags: ['infant_action_verb_in_text'],
          issues: ['infant_action_verb_in_text: "twirls"'],
        },
      ]),
    );
    expect(offenders.length).toBe(1);
    expect(offenders[0].tag).toBe('infant_action_verb_in_text');
  });

  test('identity_pronoun_swap produces an offender', () => {
    const offenders = collectWriterFatalResiduals(
      makeDoc([
        {
          spreadNumber: 6,
          tags: ['identity_pronoun_swap'],
          issues: ['identity_pronoun_swap: "he" used; brief says she/her'],
        },
      ]),
    );
    expect(offenders.length).toBe(1);
    expect(offenders[0].tag).toBe('identity_pronoun_swap');
  });

  test('mixed: only the AA-CW-21 tags survive', () => {
    const offenders = collectWriterFatalResiduals(
      makeDoc(
        [
          {
            spreadNumber: 1,
            tags: ['semantic_filler', 'rhyme_fail', 'verb_crutch', 'fragment_line'],
            issues: [
              'rhyme_fail: line 1+2 don\'t rhyme',
              'semantic_filler: vague',
              'fragment_line: missing finite verb',
            ],
          },
        ],
        ['verb_crutch: "look" appears in 7 of 13 spreads'],
      ),
    );
    // Only rhyme_fail survives.
    expect(offenders.length).toBe(1);
    expect(offenders[0].tag).toBe('rhyme_fail');
  });
});

// =============================================================================
// JUDGE_SYSTEM prompt locks
// =============================================================================

describe('AA-CW-21 — JUDGE_SYSTEM prompt is gutted to five rules', () => {
  test('preamble names structural-checker / not literary-critic', () => {
    expect(JUDGE_SYSTEM).toMatch(/STRUCTURAL CHECKER/i);
    expect(JUDGE_SYSTEM).toMatch(/NOT a literary critic/i);
  });

  test('explicitly tells the judge it MAY raise exactly five tags (plus pronoun swap)', () => {
    expect(JUDGE_SYSTEM).toMatch(/TAGS YOU MAY RAISE: rhyme_fail, dropped_article, address_name_concat, infant_action_verb_in_text, identity_pronoun_swap/);
  });

  test('explicitly tells the judge NOT to raise the demoted tags', () => {
    for (const banned of [
      'semantic_filler',
      'forced_rhyme_meaning_drift',
      'fragment_line',
      'verb_crutch',
      'refrain_crutch',
      'low_personalization_saturation',
      'signature_beat_missing',
      'unrenderable_action',
      'writer_invented_prop',
    ]) {
      expect(JUDGE_SYSTEM).toMatch(new RegExp(`TAGS YOU MUST NOT RAISE[\\s\\S]*${banned}`, 'i'));
    }
  });

  test('rule list contains exactly five numbered rules', () => {
    // Match leading "1." through "5." but no "6.".
    expect(JUDGE_SYSTEM).toMatch(/^1\. "rhyme_fail"/m);
    expect(JUDGE_SYSTEM).toMatch(/^2\. "dropped_article"/m);
    expect(JUDGE_SYSTEM).toMatch(/^3\. "address_name_concat"/m);
    expect(JUDGE_SYSTEM).toMatch(/^4\. "infant_action_verb_in_text"/m);
    expect(JUDGE_SYSTEM).toMatch(/^5\. "identity_pronoun_swap"/m);
    expect(JUDGE_SYSTEM).not.toMatch(/^6\./m);
  });

  test('Pass criteria block names exactly the five gating conditions', () => {
    expect(JUDGE_SYSTEM).toMatch(/All rhymed couplets are real rhymes/);
    expect(JUDGE_SYSTEM).toMatch(/No dropped_article hits/);
    expect(JUDGE_SYSTEM).toMatch(/No address_name_concat hits/);
    expect(JUDGE_SYSTEM).toMatch(/No infant_action_verb_in_text hits/);
    expect(JUDGE_SYSTEM).toMatch(/No identity_pronoun_swap hits/);
  });

  test('Pass criteria does NOT mention the demoted gates', () => {
    // Anything past the "Pass criteria" header should not list these
    // as gating; confirm they're absent from the entire prompt body
    // outside of the explicit MUST-NOT-RAISE list.
    const lines = JUDGE_SYSTEM.split('\n');
    const passIdx = lines.findIndex(l => /^== Pass criteria ==/.test(l));
    const passSection = lines.slice(passIdx).join('\n');
    expect(passSection).not.toMatch(/No verb_crutch/);
    expect(passSection).not.toMatch(/No refrain_crutch/);
    expect(passSection).not.toMatch(/No semantic_filler/);
    expect(passSection).not.toMatch(/signature beats land/);
  });
});
