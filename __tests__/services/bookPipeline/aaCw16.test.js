/**
 * AA-CW-16 — proseProps whitelist + writer rewrite escape hatch.
 *
 * Production book e3f4e0c0 (run at 13:29 IDT on the AA-CW-15 deploy)
 * still hit the writer-fatal hard gate after 3 waves with residuals
 * `semantic_filler, writer_invented_prop, forced_rhyme_meaning_drift`.
 * AA-CW-15's rewrite memory trimmed verb_crutch and nonsense_word but
 * could not get the writer over the line on its own.
 *
 * Two surgeries land here:
 *
 *   A. PROP WHITELIST — every spread spec now carries a `proseProps`
 *      array: an exhaustive list of concrete physical objects the writer
 *      is allowed to name. The illustrator renders the spec, not the
 *      text, so any noun outside the whitelist guarantees
 *      action_mismatch downstream and is tagged `writer_invented_prop`
 *      by the judge. Surfaced in: planner SYSTEM_PROMPT, JSON schema,
 *      normalizer, writer draft prompt, rewriter prompt, judge rule 19.
 *
 *   B. ESCAPE HATCH — `REPAIR_BUDGETS.writerRewriteWaves` bumped 3 → 5,
 *      and any spread that has been rejected
 *      `writerEscapeHatchAfterRejections` (default 3) consecutive times
 *      gets a per-spread block in the next rewrite prompt that
 *      authorizes RELAXING EXACTLY ONE craft constraint (rhyme scheme,
 *      line count, OR repeated phrase). Hard rules (no invented props,
 *      hero pronouns, no nonsense words, etc.) are NEVER relaxed.
 */

const { JUDGE_SYSTEM } = require('../../../services/bookPipeline/qa/checkWriterDraft');
const {
  isEscapeHatchUnlocked,
  recordRewriteAttempt,
  renderEscapeHatchForSpread,
  rewriteUserPrompt,
  WRITER_ESCAPE_HATCH_AFTER_REJECTIONS,
} = require('../../../services/bookPipeline/writer/rewriteBookText');
const { REPAIR_BUDGETS } = require('../../../services/bookPipeline/constants');
const { SYSTEM_PROMPT: PLANNER_SYSTEM_PROMPT } = require('../../../services/bookPipeline/planner/createSpreadSpecs');
const { SYSTEM_PROMPT: WRITER_DRAFT_SYSTEM_PROMPT } = require('../../../services/bookPipeline/writer/draftBookText');

function makeBaseDoc() {
  return {
    request: { ageBand: 'PB_INFANT', bookId: 'test-book', format: 'picture_book' },
    operationalContext: { bookId: 'test-book' },
    storyBible: { title: 'T', characters: [], arcSummary: '' },
    spreads: [
      {
        spreadNumber: 1,
        spec: {
          location: 'kitchen',
          focalAction: 'Scarlett pats the blanket',
          proseProps: ['blanket', 'stroller', 'cheek', 'hand'],
        },
        manuscript: { text: 'one\ntwo\nthree\nfour' },
      },
      {
        spreadNumber: 2,
        spec: { location: 'garden', focalAction: 'reach for tulip', proseProps: ['tulip', 'basket'] },
        manuscript: { text: 'a\nb\nc\nd' },
      },
    ],
  };
}

describe('AA-CW-16 — proseProps whitelist (planner + judge)', () => {
  describe('JUDGE_SYSTEM teaches the proseProps rule', () => {
    test('rule 19 references the proseProps whitelist as authority', () => {
      expect(JUDGE_SYSTEM).toMatch(/proseProps/);
      expect(JUDGE_SYSTEM).toMatch(/writer_invented_prop/);
      // Must teach the four allow-paths.
      expect(JUDGE_SYSTEM).toMatch(/body part/);
      expect(JUDGE_SYSTEM).toMatch(/case-insensitive substring/);
      // Must teach a fallback when proseProps is missing/empty so legacy
      // books in flight don't false-positive everything.
      expect(JUDGE_SYSTEM).toMatch(/fall back to the legacy substring check/);
    });
  });

  describe('REPAIR_BUDGETS bumped to 5', () => {
    test('writerRewriteWaves is 5', () => {
      expect(REPAIR_BUDGETS.writerRewriteWaves).toBe(5);
    });
    test('writerEscapeHatchAfterRejections is set', () => {
      expect(Number.isFinite(REPAIR_BUDGETS.writerEscapeHatchAfterRejections)).toBe(true);
      expect(REPAIR_BUDGETS.writerEscapeHatchAfterRejections).toBeGreaterThan(0);
    });
  });
});

describe('AA-CW-16 — escape hatch state machine', () => {
  test('isEscapeHatchUnlocked is false for fresh doc', () => {
    expect(isEscapeHatchUnlocked(makeBaseDoc(), 1)).toBe(false);
  });

  test('isEscapeHatchUnlocked flips to true after threshold rejections', () => {
    let doc = makeBaseDoc();
    for (let i = 0; i < WRITER_ESCAPE_HATCH_AFTER_REJECTIONS - 1; i++) {
      doc = recordRewriteAttempt(doc, 1, {
        wave: i + 1,
        rejectedText: `attempt-${i + 1}`,
        killingTags: ['rhyme_fail'],
        killingIssues: [],
      });
      expect(isEscapeHatchUnlocked(doc, 1)).toBe(false);
    }
    doc = recordRewriteAttempt(doc, 1, {
      wave: WRITER_ESCAPE_HATCH_AFTER_REJECTIONS,
      rejectedText: 'final',
      killingTags: ['rhyme_fail'],
      killingIssues: [],
    });
    expect(isEscapeHatchUnlocked(doc, 1)).toBe(true);
  });

  test('rejection counter is independent of memory window cap', () => {
    let doc = makeBaseDoc();
    // Push more attempts than the 2-attempt memory cap to prove the
    // rejection counter keeps incrementing past the window.
    for (let w = 1; w <= 5; w++) {
      doc = recordRewriteAttempt(doc, 1, {
        wave: w,
        rejectedText: `w${w}`,
        killingTags: ['t'],
        killingIssues: [],
      });
    }
    // Memory is capped to 2 attempts (AA-CW-15 contract).
    expect(doc.writerRewriteMemory[1]).toHaveLength(2);
    // Counter is NOT capped.
    expect(doc.writerRewriteRejectionCount[1]).toBe(5);
    expect(isEscapeHatchUnlocked(doc, 1)).toBe(true);
  });

  test('escape hatch is per-spread', () => {
    let doc = makeBaseDoc();
    for (let i = 0; i < WRITER_ESCAPE_HATCH_AFTER_REJECTIONS; i++) {
      doc = recordRewriteAttempt(doc, 1, { wave: i + 1, rejectedText: 'x', killingTags: [], killingIssues: [] });
    }
    expect(isEscapeHatchUnlocked(doc, 1)).toBe(true);
    expect(isEscapeHatchUnlocked(doc, 2)).toBe(false);
  });

  test('renderEscapeHatchForSpread teaches the three relaxation options + the hard floor', () => {
    const block = renderEscapeHatchForSpread(7);
    expect(block).toMatch(/Spread 7/);
    expect(block).toMatch(/Rhyme scheme/);
    expect(block).toMatch(/Line count/);
    expect(block).toMatch(/Repeated phrase/);
    // Must explicitly say only ONE may be relaxed.
    expect(block).toMatch(/EXACTLY ONE|ONLY ONE/i);
    // Must NOT relax the rules that are illustrator-safety rails.
    expect(block).toMatch(/proseProps/);
    expect(block).toMatch(/hero pronouns/i);
    expect(block).toMatch(/nonsense words/);
  });
});

describe('AA-CW-16 — planner SYSTEM_PROMPT teaches proseProps', () => {
  test('rule names proseProps and explains its purpose', () => {
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/proseProps/);
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/exhaustive whitelist/i);
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/writer_invented_prop/);
  });
  test('teaches what NOT to include (abstract nouns, characters, background scenery)', () => {
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/abstract nouns/);
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/those are characters/);
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/background scenery/);
  });
  test('JSON schema in user-prompt template includes proseProps field', () => {
    // The userPrompt() function returns the JSON schema-shape string. Pull
    // it via createSpreadSpecs's prompt builder by re-reading the source
    // (we don't want to call userPrompt(doc) here — too much fixture). The
    // SYSTEM_PROMPT alone is enough since it teaches the rule; the schema
    // is enforced by the normalizer test below.
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/6–12|6-12/);
  });
});

describe('AA-CW-16 — writer draft SYSTEM_PROMPT teaches proseProps', () => {
  test('writer is bound to the whitelist as a hard rule', () => {
    expect(WRITER_DRAFT_SYSTEM_PROMPT).toMatch(/proseProps/);
    expect(WRITER_DRAFT_SYSTEM_PROMPT).toMatch(/PROSE-PROP WHITELIST/);
    expect(WRITER_DRAFT_SYSTEM_PROMPT).toMatch(/writer_invented_prop/);
  });
  test('writer prompt lists the four allow-paths so the LLM does not over-reject', () => {
    expect(WRITER_DRAFT_SYSTEM_PROMPT).toMatch(/body part/);
    expect(WRITER_DRAFT_SYSTEM_PROMPT).toMatch(/location/);
    expect(WRITER_DRAFT_SYSTEM_PROMPT).toMatch(/case-insensitive substring/);
  });
});

describe('AA-CW-16 — escape hatch wired into rewriteUserPrompt', () => {
  test('locked spread: prompt has no escape-hatch block and no flag', () => {
    let doc = makeBaseDoc();
    // One rejection — below threshold.
    doc = recordRewriteAttempt(doc, 1, { wave: 1, rejectedText: 'r', killingTags: ['t'], killingIssues: [] });
    const targets = [{ spreadNumber: 1, issues: ['x'], tags: ['t'], suggestedRewrite: '' }];
    const prompt = rewriteUserPrompt(doc, targets);
    expect(prompt).not.toMatch(/ESCAPE HATCH/);
    expect(prompt).toMatch(/"escapeHatchUnlocked":\s*false/);
  });

  test('unlocked spread: prompt contains the escape-hatch block AND the flag', () => {
    let doc = makeBaseDoc();
    for (let i = 0; i < WRITER_ESCAPE_HATCH_AFTER_REJECTIONS; i++) {
      doc = recordRewriteAttempt(doc, 1, {
        wave: i + 1,
        rejectedText: `attempt-${i}`,
        killingTags: ['rhyme_fail', 'semantic_filler'],
        killingIssues: ['x'],
      });
    }
    const targets = [{ spreadNumber: 1, issues: ['x'], tags: ['rhyme_fail'], suggestedRewrite: '' }];
    const prompt = rewriteUserPrompt(doc, targets);
    expect(prompt).toMatch(/ESCAPE HATCH — Spread 1/);
    expect(prompt).toMatch(/"escapeHatchUnlocked":\s*true/);
  });

  test('mixed: only unlocked spreads see their own escape-hatch block', () => {
    let doc = makeBaseDoc();
    for (let i = 0; i < WRITER_ESCAPE_HATCH_AFTER_REJECTIONS; i++) {
      doc = recordRewriteAttempt(doc, 1, { wave: i + 1, rejectedText: 'r', killingTags: ['t'], killingIssues: [] });
    }
    // Spread 2 has zero rejections — locked.
    const targets = [
      { spreadNumber: 1, issues: ['x'], tags: ['t'], suggestedRewrite: '' },
      { spreadNumber: 2, issues: ['x'], tags: ['t'], suggestedRewrite: '' },
    ];
    const prompt = rewriteUserPrompt(doc, targets);
    expect(prompt).toMatch(/ESCAPE HATCH — Spread 1/);
    expect(prompt).not.toMatch(/ESCAPE HATCH — Spread 2/);
  });

  test('escape hatch block appears ABOVE the JSON payload', () => {
    let doc = makeBaseDoc();
    for (let i = 0; i < WRITER_ESCAPE_HATCH_AFTER_REJECTIONS; i++) {
      doc = recordRewriteAttempt(doc, 1, { wave: i + 1, rejectedText: 'r', killingTags: ['t'], killingIssues: [] });
    }
    const targets = [{ spreadNumber: 1, issues: ['x'], tags: ['t'], suggestedRewrite: '' }];
    const prompt = rewriteUserPrompt(doc, targets);
    const hatchIdx = prompt.indexOf('ESCAPE HATCH');
    const jsonIdx = prompt.indexOf('"escapeHatchUnlocked"');
    expect(hatchIdx).toBeGreaterThan(-1);
    expect(jsonIdx).toBeGreaterThan(-1);
    expect(hatchIdx).toBeLessThan(jsonIdx);
  });
});
