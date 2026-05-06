/**
 * AA-CW-12 — writer-fatal residual hard gate.
 *
 * Production log on book e3f4e0c0-08f2-4274-9971-d9eec50cf7bf proved two
 * intertwined defects:
 *
 *   1. writerQa.identityRhymeAudit forced rhyme_fail+identity_rhyme on
 *      3 spreads after wave 3 — but the pipeline marked "Manuscript ready"
 *      and shipped the flagged text to the illustrator anyway, because
 *      only `infant_action_verb_in_text` ever raised the wave-exhaustion
 *      hard gate.
 *
 *   2. The illustrator burned its entire 5-attempt budget on spreads 9+10
 *      cycling through action_mismatch tags because the manuscript said
 *      "Mama holds her purr" / "Scarlett bites her grin" / "Scarlett pats
 *      one string" — lines whose verb objects either (a) cannot be
 *      drawn (purr, grin) or (b) reference props the spread spec did not
 *      authorize (string when the spec said blanket).
 *
 * AA-CW-12 introduces:
 *
 *   - `unrenderable_action` and `writer_invented_prop` rules in the
 *     judge prompt (Task D).
 *   - `collectWriterFatalResiduals` + WriterUnresolvableError throw
 *     after wave exhaustion for any of:
 *       identity_rhyme | unrenderable_action | writer_invented_prop
 *     (Task B).
 *
 * This suite locks the new contract.
 */

const {
  collectWriterFatalResiduals,
  WRITER_FATAL_TAGS,
  WriterUnresolvableError,
} = require('../../../services/bookPipeline/writer/rewriteBookText');
const { JUDGE_SYSTEM } = require('../../../services/bookPipeline/qa/checkWriterDraft');

function makeDoc({ perSpread = [] } = {}) {
  return {
    request: { ageBand: 'PB_INFANT' },
    operationalContext: { bookId: 'test-book' },
    writerQa: { perSpread },
  };
}

describe('AA-CW-12 — writer-fatal residual hard gate', () => {
  describe('WRITER_FATAL_TAGS', () => {
    test('exports identity_rhyme, unrenderable_action, writer_invented_prop', () => {
      expect(WRITER_FATAL_TAGS).toEqual(
        expect.arrayContaining(['identity_rhyme', 'unrenderable_action', 'writer_invented_prop']),
      );
      // AA-CW-13 grew this list with semantic_filler and
      // forced_rhyme_meaning_drift; future PRs may add more. Lock the
      // AA-CW-12 floor (3 tags) without freezing future growth.
      expect(WRITER_FATAL_TAGS.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('collectWriterFatalResiduals', () => {
    test('clean verdict produces zero offenders', () => {
      const out = collectWriterFatalResiduals(makeDoc({
        perSpread: [
          { spreadNumber: 1, tags: [], issues: [] },
          { spreadNumber: 2, tags: ['rhyme_fail'], issues: ['lines 3+4 do not rhyme'] },
        ],
      }));
      expect(out).toEqual([]);
    });

    test('identity_rhyme tag produces one offender, carrying issue text', () => {
      const out = collectWriterFatalResiduals(makeDoc({
        perSpread: [
          {
            spreadNumber: 8,
            tags: ['rhyme_fail', 'identity_rhyme'],
            issues: ['rhyme_fail: identity rhyme on lines 3+4 — "mama/mama". Both lines end on the same word; pick a real rhyme partner.'],
          },
        ],
      }));
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ spreadNumber: 8, tag: 'identity_rhyme' });
      expect(out[0].issue).toMatch(/mama\/mama/);
    });

    test('unrenderable_action tag produces one offender per tagged spread', () => {
      const out = collectWriterFatalResiduals(makeDoc({
        perSpread: [
          {
            spreadNumber: 9,
            tags: ['unrenderable_action'],
            issues: ['unrenderable_action: "Mama holds her purr." A purr is a sound, not a holdable object.'],
          },
          {
            spreadNumber: 10,
            tags: ['unrenderable_action'],
            issues: ['unrenderable_action: "Scarlett bites her grin." A grin is a facial expression, not bitable.'],
          },
        ],
      }));
      expect(out).toHaveLength(2);
      expect(out.map(o => o.spreadNumber).sort((a, b) => a - b)).toEqual([9, 10]);
      expect(out.every(o => o.tag === 'unrenderable_action')).toBe(true);
    });

    test('writer_invented_prop tag produces an offender', () => {
      const out = collectWriterFatalResiduals(makeDoc({
        perSpread: [
          {
            spreadNumber: 7,
            tags: ['writer_invented_prop'],
            issues: ['writer_invented_prop: "Scarlett pats one string" — spec.focalAction names blanket, not string. Replace with the spec\'s prop.'],
          },
        ],
      }));
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ spreadNumber: 7, tag: 'writer_invented_prop' });
      expect(out[0].issue).toMatch(/string/);
    });

    test('multiple writer-fatal tags on the same spread produce multiple offenders (one per tag)', () => {
      const out = collectWriterFatalResiduals(makeDoc({
        perSpread: [
          {
            spreadNumber: 9,
            tags: ['identity_rhyme', 'unrenderable_action'],
            issues: [
              'rhyme_fail: identity rhyme on lines 1+2 — "slow/slow".',
              'unrenderable_action: "Mama holds her purr."',
            ],
          },
        ],
      }));
      expect(out).toHaveLength(2);
      expect(out.map(o => o.tag).sort()).toEqual(['identity_rhyme', 'unrenderable_action']);
    });

    test('tag without parseable issue text still yields a placeholder offender', () => {
      const out = collectWriterFatalResiduals(makeDoc({
        perSpread: [
          { spreadNumber: 5, tags: ['identity_rhyme'], issues: [] },
        ],
      }));
      expect(out).toHaveLength(1);
      expect(out[0].spreadNumber).toBe(5);
      expect(out[0].tag).toBe('identity_rhyme');
      expect(out[0].issue).toMatch(/identity_rhyme/);
    });

    test('non-fatal tags (rhyme_fail without identity_rhyme, dropped_article, etc.) do NOT produce offenders', () => {
      const out = collectWriterFatalResiduals(makeDoc({
        perSpread: [
          { spreadNumber: 1, tags: ['rhyme_fail'], issues: ['slant rhyme outside/glide'] },
          { spreadNumber: 2, tags: ['dropped_article'], issues: ['"down street" missing the'] },
          { spreadNumber: 3, tags: ['fragment_line'], issues: ['line has no finite verb'] },
          { spreadNumber: 4, tags: ['nonsense_word'], issues: ['"froes" is not a word'] },
        ],
      }));
      expect(out).toEqual([]);
    });

    test('missing writerQa is treated as no offenders (defensive)', () => {
      const doc = { request: { ageBand: 'PB_INFANT' } };
      expect(collectWriterFatalResiduals(doc)).toEqual([]);
    });
  });

  describe('WriterUnresolvableError shape (sanity)', () => {
    test('carries issues and tags including writer_fatal_residual', () => {
      const err = new WriterUnresolvableError('test', {
        issues: ['spread 9 [identity_rhyme]: mama/mama'],
        tags: ['writer_fatal_residual', 'identity_rhyme'],
      });
      expect(err.tags).toContain('writer_fatal_residual');
      expect(err.tags).toContain('identity_rhyme');
      expect(err.issues).toHaveLength(1);
    });
  });

  describe('Task D — JUDGE_SYSTEM prompt contains the new rules', () => {
    test('prompt names "unrenderable_action" tag with concrete BAD examples', () => {
      expect(JUDGE_SYSTEM).toMatch(/unrenderable_action/);
      // Concrete BAD examples from the production log
      expect(JUDGE_SYSTEM).toMatch(/Mama holds her purr/);
      expect(JUDGE_SYSTEM).toMatch(/bites her grin/);
    });

    test('prompt names "writer_invented_prop" tag and explains the spec contract', () => {
      expect(JUDGE_SYSTEM).toMatch(/writer_invented_prop/);
      expect(JUDGE_SYSTEM).toMatch(/spec\.focalAction/);
      // Must reference that text-prop must appear in spec
      expect(JUDGE_SYSTEM.toLowerCase()).toMatch(/blanket/);
    });

    test('Pass criteria explicitly forbids unrenderable_action and writer_invented_prop', () => {
      expect(JUDGE_SYSTEM).toMatch(/No unrenderable_action hits/);
      expect(JUDGE_SYSTEM).toMatch(/No writer_invented_prop hits/);
    });
  });
});
