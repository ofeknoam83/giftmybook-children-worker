'use strict';

/**
 * AA-CW-19 — break the verb-crutch whack-a-mole loop.
 *
 * AA-CW-18 told the rewriter "give is overused, replace it." The rewriter
 * obediently removed "give" and crutched on "say" instead. Wave 2 flagged
 * "say"; wave 3 it became "pat". The 5-wave budget ran out and the book
 * failed at the writer hard gate (production book e3f4e0c0 retry).
 *
 * AA-CW-19 ships three orthogonal fixes:
 *
 *  Part A — Cumulative forbidden-lemma list across waves. Once a lemma is
 *           flagged by verb_crutch / refrain_crutch in any wave, it is
 *           BANNED from every subsequent rewrite wave.
 *
 *  Part B — Pre-flight self-audit in the writer-draft SYSTEM_PROMPT so the
 *           writer fixes corpus diversity at draft time, not in 5 waves of
 *           remediation.
 *
 *  Part C — Sensory-channel rotation directive in the rewrite prompt:
 *           replacing a crutch verb with another verb is the loop. Drop
 *           the verb-led shape entirely; use sensory image / state line /
 *           sound line.
 */

describe('AA-CW-19 Part A — cumulative forbidden-lemma list', () => {
  const {
    recordForbiddenLemmasFromDirectives,
    renderForbiddenLemmasBlock,
    rewriteUserPrompt,
  } = require('../../../services/bookPipeline/writer/rewriteBookText');

  describe('recordForbiddenLemmasFromDirectives', () => {
    test('returns the same doc when directives are empty / null', () => {
      const doc = { foo: 1 };
      expect(recordForbiddenLemmasFromDirectives(doc, [])).toBe(doc);
      expect(recordForbiddenLemmasFromDirectives(doc, null)).toBe(doc);
      expect(recordForbiddenLemmasFromDirectives(doc, undefined)).toBe(doc);
    });

    test('seeds the forbidden-lemma set on first call', () => {
      const doc = {};
      const next = recordForbiddenLemmasFromDirectives(doc, [
        { kind: 'verb_crutch', lemma: 'give' },
        { kind: 'refrain_crutch', lemma: 'sleeve' },
      ]);
      expect(next.writerForbiddenLemmas).toEqual({
        verbs: ['give'],
        nouns: ['sleeve'],
      });
      // Original doc not mutated.
      expect(doc.writerForbiddenLemmas).toBeUndefined();
    });

    test('accumulates across calls — a lemma burned in wave 1 stays burned in wave 2', () => {
      let doc = recordForbiddenLemmasFromDirectives({}, [
        { kind: 'verb_crutch', lemma: 'give' },
      ]);
      doc = recordForbiddenLemmasFromDirectives(doc, [
        { kind: 'verb_crutch', lemma: 'say' },
      ]);
      doc = recordForbiddenLemmasFromDirectives(doc, [
        { kind: 'verb_crutch', lemma: 'pat' },
      ]);
      expect(doc.writerForbiddenLemmas.verbs).toEqual(['give', 'pat', 'say']);
    });

    test('deduplicates and lower-cases', () => {
      const doc = recordForbiddenLemmasFromDirectives({}, [
        { kind: 'verb_crutch', lemma: 'GIVE' },
        { kind: 'verb_crutch', lemma: 'give' },
        { kind: 'verb_crutch', lemma: 'Give' },
      ]);
      expect(doc.writerForbiddenLemmas.verbs).toEqual(['give']);
    });

    test('separates verbs and nouns by directive kind', () => {
      const doc = recordForbiddenLemmasFromDirectives({}, [
        { kind: 'verb_crutch', lemma: 'give' },
        { kind: 'refrain_crutch', lemma: 'sleeve' },
        { kind: 'verb_crutch', lemma: 'say' },
        { kind: 'refrain_crutch', lemma: 'leaf' },
      ]);
      expect(doc.writerForbiddenLemmas).toEqual({
        verbs: ['give', 'say'],
        nouns: ['leaf', 'sleeve'],
      });
    });

    test('skips directives with empty / missing lemmas', () => {
      const doc = recordForbiddenLemmasFromDirectives({}, [
        { kind: 'verb_crutch', lemma: '' },
        { kind: 'verb_crutch', lemma: '   ' },
        { kind: 'verb_crutch' },
        { kind: 'verb_crutch', lemma: 'give' },
      ]);
      expect(doc.writerForbiddenLemmas.verbs).toEqual(['give']);
    });

    test('preserves prior verbs / nouns when accumulating from a doc with existing state', () => {
      const doc = {
        writerForbiddenLemmas: {
          verbs: ['hold'],
          nouns: ['blanket'],
        },
      };
      const next = recordForbiddenLemmasFromDirectives(doc, [
        { kind: 'verb_crutch', lemma: 'give' },
        { kind: 'refrain_crutch', lemma: 'sleeve' },
      ]);
      expect(next.writerForbiddenLemmas.verbs).toEqual(['give', 'hold']);
      expect(next.writerForbiddenLemmas.nouns).toEqual(['blanket', 'sleeve']);
    });
  });

  describe('renderForbiddenLemmasBlock', () => {
    test('returns empty string when there are no forbidden lemmas', () => {
      expect(renderForbiddenLemmasBlock({})).toBe('');
      expect(renderForbiddenLemmasBlock({ writerForbiddenLemmas: { verbs: [], nouns: [] } })).toBe('');
      expect(renderForbiddenLemmasBlock(null)).toBe('');
    });

    test('renders a banned-verbs line when only verbs are present', () => {
      const block = renderForbiddenLemmasBlock({
        writerForbiddenLemmas: { verbs: ['give', 'say'], nouns: [] },
      });
      expect(block).toMatch(/FORBIDDEN LEMMAS/);
      expect(block).toMatch(/AA-CW-19/);
      expect(block).toMatch(/BANNED VERB LEMMAS.*"give".*"say"/);
      expect(block).not.toMatch(/BANNED NOUN LEMMAS/);
    });

    test('renders both verbs and nouns when both present', () => {
      const block = renderForbiddenLemmasBlock({
        writerForbiddenLemmas: { verbs: ['give'], nouns: ['sleeve'] },
      });
      expect(block).toMatch(/BANNED VERB LEMMAS.*"give"/);
      expect(block).toMatch(/BANNED NOUN LEMMAS.*"sleeve"/);
    });

    test('explicitly warns against replacing one banned lemma with another crutch', () => {
      const block = renderForbiddenLemmasBlock({
        writerForbiddenLemmas: { verbs: ['give', 'say'], nouns: [] },
      });
      // The rationale text must appear so the rewriter understands WHY the ban exists.
      expect(block).toMatch(/Replacing one banned lemma with a non-banned crutch/);
      expect(block).toMatch(/sensory image|state line|sound line/);
    });
  });

  describe('rewriteUserPrompt integration', () => {
    function makeDoc({ writerForbiddenLemmas } = {}) {
      return {
        request: { ageBand: '0-1', format: 'picture_book' },
        brief: {
          child: { name: 'Scarlett' },
          pronouns: { subject: 'she', object: 'her', possessive: 'her', reflexive: 'herself' },
        },
        storyBible: { title: 'Test', narrativeSpine: 'spine' },
        spreads: [
          { spreadNumber: 1, spec: { textSide: 'right' }, manuscript: { text: 'Mama gives a hug.\nScarlett gives a smile.\nA tender give.\nGive give.' } },
        ],
        writerQa: {
          bookLevel: ["verb_crutch: 'give' appears in 5 of 13 spreads — spreads 1, 4, 8, 9, 10."],
        },
        writerForbiddenLemmas,
      };
    }

    test('omits the forbidden-lemmas block when state is empty', () => {
      const doc = makeDoc();
      const targets = [{ spreadNumber: 1, issues: ['x'], tags: ['verb_crutch'], suggestedRewrite: null }];
      const prompt = rewriteUserPrompt(doc, targets);
      expect(prompt).not.toMatch(/FORBIDDEN LEMMAS/);
    });

    test('threads the forbidden-lemmas block above the JSON payload when state is populated', () => {
      const doc = makeDoc({ writerForbiddenLemmas: { verbs: ['give', 'say'], nouns: ['sleeve'] } });
      const targets = [{ spreadNumber: 1, issues: ['x'], tags: ['verb_crutch'], suggestedRewrite: null }];
      const prompt = rewriteUserPrompt(doc, targets);

      expect(prompt).toMatch(/FORBIDDEN LEMMAS/);
      expect(prompt).toMatch(/"give"/);
      expect(prompt).toMatch(/"say"/);
      expect(prompt).toMatch(/"sleeve"/);

      // Block must appear BEFORE the per-spread JSON payload so the model sees it.
      const forbiddenIdx = prompt.indexOf('FORBIDDEN LEMMAS');
      const jsonIdx = prompt.indexOf('Rewrite ONLY these spreads');
      expect(forbiddenIdx).toBeGreaterThan(-1);
      expect(jsonIdx).toBeGreaterThan(-1);
      expect(forbiddenIdx).toBeLessThan(jsonIdx);
    });
  });
});

describe('AA-CW-19 Part A integration — rewrite loop accumulates lemmas', () => {
  // Simulate the wave-over-wave behavior at the helper-composition level so we
  // do not need to mock the full LLM/QA pipeline. The contract: every wave
  // calls `recordForbiddenLemmasFromDirectives(doc, parsedDirectives)` BEFORE
  // building the rewrite prompt, so the prompt for wave N+1 sees lemmas from
  // every prior wave's QA judgment.
  const {
    recordForbiddenLemmasFromDirectives,
    parseBookLevelDirectives,
  } = require('../../../services/bookPipeline/writer/rewriteBookText');

  test('three waves accumulate give → say → pat as cumulative forbidden verbs', () => {
    let doc = {};
    // Wave 1 QA judgment
    let directives = parseBookLevelDirectives([
      "verb_crutch: 'give' appears in 5 of 13 spreads — spreads 1, 4, 8, 9, 10.",
    ]);
    doc = recordForbiddenLemmasFromDirectives(doc, directives);
    expect(doc.writerForbiddenLemmas.verbs).toEqual(['give']);

    // Wave 2 QA judgment — the rewriter swapped give→say and the judge caught it.
    directives = parseBookLevelDirectives([
      "verb_crutch: 'say' appears in 4 of 13 spreads — spreads 2, 5, 7, 11.",
    ]);
    doc = recordForbiddenLemmasFromDirectives(doc, directives);
    expect(doc.writerForbiddenLemmas.verbs).toEqual(['give', 'say']);

    // Wave 3 QA judgment — now pat. After this, the wave-4 prompt will list
    // give, say, and pat as banned; the rewriter cannot reach for any of them.
    directives = parseBookLevelDirectives([
      "verb_crutch: 'pat' appears in 4 of 13 spreads — spreads 3, 6, 12, 13.",
    ]);
    doc = recordForbiddenLemmasFromDirectives(doc, directives);
    expect(doc.writerForbiddenLemmas.verbs).toEqual(['give', 'pat', 'say']);
  });
});

describe('AA-CW-19 Part B — writer-draft self-audit in SYSTEM_PROMPT', () => {
  const { SYSTEM_PROMPT } = require('../../../services/bookPipeline/writer/draftBookText');

  test('SYSTEM_PROMPT names the AA-CW-19 self-audit by name', () => {
    expect(SYSTEM_PROMPT).toMatch(/AA-CW-19/);
    expect(SYSTEM_PROMPT).toMatch(/SELF-AUDIT/i);
  });

  test('SYSTEM_PROMPT enforces an explicit numerical threshold (≤3 of 13 spreads)', () => {
    // The threshold has to be unambiguous so the writer does not interpret
    // "diversify" loosely. The wording lives in writer/draftBookText.js.
    expect(SYSTEM_PROMPT).toMatch(/3 of 13 spreads/);
  });

  test('SYSTEM_PROMPT collapses verb forms to a single lemma when counting', () => {
    // The rule must explicitly say "give/gives/gave/giving" all count as one
    // lemma so the writer does not game the audit by alternating tense.
    expect(SYSTEM_PROMPT).toMatch(/give\/gives\/gave\/giving/);
  });

  test('SYSTEM_PROMPT lists the canonical refrain-noun set from production failures', () => {
    expect(SYSTEM_PROMPT).toMatch(/sleeve/);
    expect(SYSTEM_PROMPT).toMatch(/leaf/);
    expect(SYSTEM_PROMPT).toMatch(/blanket/);
  });

  test('SYSTEM_PROMPT authorises non-verb-led line shapes (sensory / state / sound)', () => {
    expect(SYSTEM_PROMPT).toMatch(/sensory image/);
    expect(SYSTEM_PROMPT).toMatch(/state line/);
    expect(SYSTEM_PROMPT).toMatch(/sound line/);
  });

  test('SYSTEM_PROMPT explains the cost — 5 wasted rewrite waves — to incentivise self-fix', () => {
    expect(SYSTEM_PROMPT).toMatch(/5 rewrite waves/);
  });
});

describe('AA-CW-19 Part C — sensory-channel rotation in rewrite prompt', () => {
  const {
    renderBookLevelDirectivesBlock,
  } = require('../../../services/bookPipeline/writer/rewriteBookText');

  test('book-level diversification block names AA-CW-19 sensory rotation', () => {
    const block = renderBookLevelDirectivesBlock([
      { kind: 'verb_crutch', lemma: 'give', spreads: [1, 4, 8] },
    ]);
    expect(block).toMatch(/AA-CW-19 SENSORY-CHANNEL ROTATION/);
  });

  test('block authorises dropping the verb-led construction entirely', () => {
    const block = renderBookLevelDirectivesBlock([
      { kind: 'verb_crutch', lemma: 'give', spreads: [1, 4, 8] },
    ]);
    expect(block).toMatch(/sensory image/);
    expect(block).toMatch(/state line/);
    expect(block).toMatch(/sound line/);
    expect(block).toMatch(/Drop the verb-led construction entirely/);
  });

  test('block explicitly warns against the give → say → pat → hold rotation pattern', () => {
    const block = renderBookLevelDirectivesBlock([
      { kind: 'verb_crutch', lemma: 'give', spreads: [1, 4, 8] },
    ]);
    expect(block).toMatch(/give.*say.*pat.*hold/);
    expect(block).toMatch(/the same gate fires on the new lemma/);
  });

  test('block gives at least one concrete worked example of the verb→sensory swap', () => {
    const block = renderBookLevelDirectivesBlock([
      { kind: 'verb_crutch', lemma: 'give', spreads: [1, 4, 8] },
    ]);
    // We do not pin the exact wording — the test just asserts a worked
    // before→after example exists.
    expect(block).toMatch(/verb-led:.*→/);
  });
});
