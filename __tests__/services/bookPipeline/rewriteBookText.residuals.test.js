/**
 * AA-CW-9 — `collectInfantActionResiduals` reads the judge verdict.
 *
 * Before AA-CW-9 the residual hard gate called a per-line gemini-2.5-flash
 * gate (~38 sequential calls, ~65s wall time per book) that re-evaluated
 * what the gpt-5.4 judge had already reported. The Flash gate is gone.
 * The hard gate now reads `doc.writerQa.perSpread[*].tags` for the
 * `infant_action_verb_in_text` tag emitted by the judge.
 *
 * This suite locks the new contract:
 *   1. Non-PB_INFANT bands skip entirely (no offenders, no Flash, no cost).
 *   2. PB_INFANT books with a clean judge verdict produce zero offenders.
 *   3. PB_INFANT books with the judge tag produce one offender per tagged
 *      spread, carrying the judge's verb list parsed from the issue text.
 *   4. PB_INFANT books missing structured issue text still produce an
 *      offender (so the hard gate fires) with a placeholder hit.
 */

const {
  collectInfantActionResiduals,
} = require('../../../services/bookPipeline/writer/rewriteBookText');
const { AGE_BANDS } = require('../../../services/bookPipeline/constants');

function makeDoc({ ageBand, perSpread = [] }) {
  return {
    request: { ageBand },
    writerQa: { perSpread },
  };
}

describe('collectInfantActionResiduals (AA-CW-9 judge-driven)', () => {
  test('non-PB_INFANT bands return empty (no scan, no Flash)', () => {
    const out = collectInfantActionResiduals(makeDoc({
      ageBand: AGE_BANDS.PB_PRESCHOOL,
      perSpread: [
        { spreadNumber: 3, tags: ['infant_action_verb_in_text'], issues: ['junk'] },
      ],
    }));
    expect(out).toEqual([]);
  });

  test('PB_INFANT clean verdict produces zero offenders', () => {
    const out = collectInfantActionResiduals(makeDoc({
      ageBand: AGE_BANDS.PB_INFANT,
      perSpread: [
        { spreadNumber: 1, tags: [], issues: [] },
        { spreadNumber: 2, tags: ['rhyme_fail'], issues: ['lines 3+4 do not rhyme'] },
      ],
    }));
    expect(out).toEqual([]);
  });

  test('PB_INFANT judge tag produces one offender per tagged spread, parsing verbs from issue text', () => {
    const out = collectInfantActionResiduals(makeDoc({
      ageBand: AGE_BANDS.PB_INFANT,
      perSpread: [
        {
          spreadNumber: 4,
          tags: ['infant_action_verb_in_text'],
          issues: ['infant_action_verb_in_text: locomotion verbs forbidden for PB_INFANT — twirls, hops'],
        },
        {
          spreadNumber: 7,
          tags: ['rhyme_fail'],
          issues: ['lines 1+2 do not rhyme'],
        },
        {
          spreadNumber: 9,
          tags: ['infant_action_verb_in_text', 'fragment_line'],
          issues: ['infant_action_verb_in_text: locomotion verbs forbidden for PB_INFANT — runs'],
        },
      ],
    }));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ spreadNumber: 4 });
    expect(out[0].hits.join(' ')).toMatch(/twirls/);
    expect(out[1]).toMatchObject({ spreadNumber: 9 });
    expect(out[1].hits.join(' ')).toMatch(/runs/);
  });

  test('PB_INFANT tag without parseable issue text still produces a placeholder offender', () => {
    const out = collectInfantActionResiduals(makeDoc({
      ageBand: AGE_BANDS.PB_INFANT,
      perSpread: [
        { spreadNumber: 5, tags: ['infant_action_verb_in_text'], issues: [] },
      ],
    }));
    expect(out).toHaveLength(1);
    expect(out[0].spreadNumber).toBe(5);
    expect(out[0].hits.length).toBeGreaterThan(0);
  });

  test('missing writerQa is treated as no offenders (defensive)', () => {
    const doc = { request: { ageBand: AGE_BANDS.PB_INFANT } };
    expect(collectInfantActionResiduals(doc)).toEqual([]);
  });
});
