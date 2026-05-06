/**
 * AA-CW-17 — failure-forensics persistence + drop AABB for PB_INFANT.
 *
 * Production book e3f4e0c0 (post AA-CW-16 deploy) hit the writer-fatal
 * hard gate after all 5 rewrite waves with a stable residual mix of
 * `forced_rhyme_meaning_drift, identity_rhyme, semantic_filler,
 * unrenderable_action`. Cloud Run logs preserved only the truncated
 * failure summary — the wave-N manuscript text was never persisted, so
 * post-mortem text analysis was impossible without re-running the book.
 *
 * Two surgeries land here:
 *
 *   A. FAILURE FORENSICS PERSISTENCE — when the writer hard gate fires
 *      (infant residual or AA-CW-12 fatal residual), the doc's
 *      `writerRewriteMemory`, `writerQa`, and `finalSpreads` (with text)
 *      are flushed to GCS at `children-jobs/<bookId>/writer-failure.json`
 *      before the WriterUnresolvableError is thrown. Errors are
 *      swallowed so forensics never crash the actual error path.
 *
 *   B. RHYME SCHEME RELAXATION FOR PB_INFANT — at infant line budget
 *      (2-5 words/hardMax 6) the writer's search space for the second
 *      AABB couplet collapses against proseProps + banned locomotion
 *      verbs + no identity rhymes + fresh verb / fresh refrain rules.
 *      Lines 1+2 must still rhyme (the heart of board-book sing-song);
 *      lines 3+4 may rhyme OR be free-verse with parallel rhythm,
 *      whichever yields more natural language. PB_TODDLER and
 *      PB_PRESCHOOL keep strict AABB.
 */

const path = require('path');

const { JUDGE_SYSTEM } = require('../../../services/bookPipeline/qa/checkWriterDraft');
const {
  SYSTEM_PROMPT: WRITER_DRAFT_SYSTEM_PROMPT,
  renderLineCountReminder,
} = require('../../../services/bookPipeline/writer/draftBookText');
const {
  SYSTEM_PROMPT: WRITER_REWRITE_SYSTEM_PROMPT,
  renderLineCountReminderForRewrite,
  persistWriterFailureForensics,
} = require('../../../services/bookPipeline/writer/rewriteBookText');
const { renderTextPolicyBlock } = require('../../../services/bookPipeline/writer/textPolicies');
const { AGE_BANDS } = require('../../../services/bookPipeline/constants');

// =============================================================================
// Part B — band-conditional rhyme rule prompt locks
// =============================================================================

describe('AA-CW-17 Part B — drop AABB for PB_INFANT (band-conditional rhyme rule)', () => {
  describe('renderTextPolicyBlock — PB_INFANT', () => {
    const doc = {
      request: { ageBand: AGE_BANDS.PB_INFANT, format: 'picture_book' },
      brief: {},
    };
    const block = renderTextPolicyBlock(doc);

    it('explicitly marks the rhyme scheme as RELAXED for infant', () => {
      expect(block).toMatch(/RELAXED FOR INFANT/i);
    });

    it('still requires lines 1+2 to rhyme (board-book sing-song anchor)', () => {
      expect(block).toMatch(/Lines 1\+2 MUST rhyme/i);
    });

    it('permits free-verse on lines 3+4 with strong rhythmic parallel', () => {
      expect(block).toMatch(/Lines 3\+4 MAY rhyme OR MAY be free-verse/i);
      expect(block).toMatch(/strong rhythmic parallel/i);
    });

    it('lists the failure modes that justify skipping the second rhyme', () => {
      // The principle block must enumerate the four conditions where
      // the writer should choose free-verse over forcing the rhyme:
      // meaning drift, identity rhyme, invented prop, unrenderable action.
      expect(block).toMatch(/drag the meaning out of frame/i);
      expect(block).toMatch(/identity rhyme/i);
      expect(block).toMatch(/invented prop/i);
      expect(block).toMatch(/unrenderable action/i);
    });

    it('asks the writer to declare unrhymed lines 3+4 in writerNotes', () => {
      expect(block).toMatch(/writerNotes/i);
    });

    it('includes both a fully-rhymed example AND an unrhymed-3+4 example for cadence', () => {
      expect(block).toMatch(/EXAMPLE CADENCE A/i);
      expect(block).toMatch(/EXAMPLE CADENCE B/i);
    });
  });

  describe('renderTextPolicyBlock — PB_TODDLER (unchanged: strict AABB)', () => {
    const doc = {
      request: { ageBand: AGE_BANDS.PB_TODDLER, format: 'picture_book' },
      brief: {},
    };
    const block = renderTextPolicyBlock(doc);

    it('still mandates AABB for toddler band', () => {
      expect(block).toMatch(/AABB/);
    });

    it('does NOT mention the AA-CW-17 infant relaxation', () => {
      expect(block).not.toMatch(/RELAXED FOR INFANT/i);
    });
  });

  describe('renderTextPolicyBlock — PB_PRESCHOOL (unchanged: strict AABB)', () => {
    const doc = {
      request: { ageBand: AGE_BANDS.PB_PRESCHOOL, format: 'picture_book' },
      brief: {},
    };
    const block = renderTextPolicyBlock(doc);

    it('still mandates AABB for preschool band', () => {
      expect(block).toMatch(/AABB/);
    });

    it('does NOT mention the AA-CW-17 infant relaxation', () => {
      expect(block).not.toMatch(/RELAXED FOR INFANT/i);
    });
  });

  describe('renderLineCountReminder — band-conditional', () => {
    it('infant reminder mentions free-verse / naturalness', () => {
      const reminder = renderLineCountReminder(AGE_BANDS.PB_INFANT);
      expect(reminder).toMatch(/free-verse/i);
      expect(reminder).toMatch(/Lines 1\+2 MUST rhyme/i);
      // No "AABB rhyming couplets" boilerplate for the infant reminder —
      // that wording would contradict the relaxation.
      expect(reminder).not.toMatch(/two AABB rhyming couplets/i);
    });

    it('toddler reminder still mentions AABB rhyming couplets', () => {
      const reminder = renderLineCountReminder(AGE_BANDS.PB_TODDLER);
      expect(reminder).toMatch(/AABB rhyming couplets/i);
    });

    it('preschool reminder still mentions AABB rhyming couplets', () => {
      const reminder = renderLineCountReminder(AGE_BANDS.PB_PRESCHOOL);
      expect(reminder).toMatch(/AABB rhyming couplets/i);
    });
  });

  describe('renderLineCountReminderForRewrite — band-conditional', () => {
    it('infant rewrite reminder mentions free-verse / naturalness', () => {
      const reminder = renderLineCountReminderForRewrite(AGE_BANDS.PB_INFANT);
      expect(reminder).toMatch(/free-verse/i);
      expect(reminder).toMatch(/Lines 1\+2 MUST rhyme/i);
    });

    it('toddler rewrite reminder still mentions AABB couplets', () => {
      const reminder = renderLineCountReminderForRewrite(AGE_BANDS.PB_TODDLER);
      expect(reminder).toMatch(/AABB couplets/i);
    });
  });

  describe('writer DRAFT SYSTEM_PROMPT — band-conditional rhyme rule', () => {
    it('marks the rhyme scheme as band-conditional', () => {
      expect(WRITER_DRAFT_SYSTEM_PROMPT).toMatch(/RHYME SCHEME \(band-conditional/i);
    });

    it('keeps full AABB for PB_TODDLER and PB_PRESCHOOL', () => {
      expect(WRITER_DRAFT_SYSTEM_PROMPT).toMatch(/PB_TODDLER.*PB_PRESCHOOL.*full AABB/is);
    });

    it('relaxes lines 3+4 for PB_INFANT', () => {
      // The infant rule: lines 1+2 MUST rhyme; lines 3+4 may rhyme OR
      // may be free-verse.
      expect(WRITER_DRAFT_SYSTEM_PROMPT).toMatch(/PB_INFANT.*RELAXED/is);
      expect(WRITER_DRAFT_SYSTEM_PROMPT).toMatch(/Lines 1\+2 MUST rhyme/);
      expect(WRITER_DRAFT_SYSTEM_PROMPT).toMatch(/Lines 3\+4 MAY rhyme OR MAY be free-verse/);
    });
  });

  describe('writer REWRITE SYSTEM_PROMPT — band-conditional rhyme rule', () => {
    it('marks the rhyme scheme as band-conditional', () => {
      expect(WRITER_REWRITE_SYSTEM_PROMPT).toMatch(/RHYME SCHEME \(band-conditional/i);
    });

    it('keeps full AABB for PB_TODDLER and PB_PRESCHOOL', () => {
      expect(WRITER_REWRITE_SYSTEM_PROMPT).toMatch(/PB_TODDLER.*PB_PRESCHOOL.*full AABB/is);
    });

    it('relaxes lines 3+4 for PB_INFANT', () => {
      expect(WRITER_REWRITE_SYSTEM_PROMPT).toMatch(/PB_INFANT.*RELAXED/is);
      expect(WRITER_REWRITE_SYSTEM_PROMPT).toMatch(/free-verse/i);
    });

    it('tells rewriter to prefer free-verse 3+4 when prior wave failed on 3+4 with the four bad-outcome tags', () => {
      // The rewriter should KNOW that if a previous wave's 3+4 produced
      // identity_rhyme / forced_rhyme_meaning_drift / writer_invented_prop
      // / unrenderable_action, the next attempt should drop the rhyme
      // requirement on those lines, not keep retrying.
      expect(WRITER_REWRITE_SYSTEM_PROMPT).toMatch(/identity_rhyme/);
      expect(WRITER_REWRITE_SYSTEM_PROMPT).toMatch(/forced_rhyme_meaning_drift/);
      expect(WRITER_REWRITE_SYSTEM_PROMPT).toMatch(/writer_invented_prop/);
      expect(WRITER_REWRITE_SYSTEM_PROMPT).toMatch(/unrenderable_action/);
    });
  });

  describe('JUDGE_SYSTEM — band-conditional rhyme enforcement', () => {
    it('keeps strict AABB enforcement for PB_TODDLER and PB_PRESCHOOL', () => {
      expect(JUDGE_SYSTEM).toMatch(/PB_TODDLER.*PB_PRESCHOOL.*full AABB/is);
    });

    it('relaxes 3+4 for PB_INFANT but keeps 1+2 mandatory', () => {
      expect(JUDGE_SYSTEM).toMatch(/PB_INFANT.*RELAXED/is);
      expect(JUDGE_SYSTEM).toMatch(/Lines 1\+2 MUST rhyme/);
    });

    it('tells the judge NOT to raise rhyme_fail on free-verse infant 3+4', () => {
      // Most important judge change: a clean unrhymed lines 3+4 in an
      // infant book is no longer a `rhyme_fail`. Only attempted-then-
      // broken rhymes on lines 3+4 are flagged.
      expect(JUDGE_SYSTEM).toMatch(/Do NOT raise `rhyme_fail` on lines 3\+4 of an infant spread/i);
      expect(JUDGE_SYSTEM).toMatch(/Free-verse lines 3\+4 with parallel rhythm are ACCEPTABLE/i);
    });

    it('still fails identity rhymes on EVERY couplet that is rhymed at all, in EVERY band', () => {
      // The relaxation must not become a loophole for sneaking in
      // identity rhymes on a "free-verse" couplet.
      expect(JUDGE_SYSTEM).toMatch(/identity rhymes.*ALWAYS `rhyme_fail`/i);
    });

    it('updates pass criteria to allow free-verse infant 3+4', () => {
      expect(JUDGE_SYSTEM).toMatch(/free-verse with parallel rhythm passes/i);
    });
  });
});

// =============================================================================
// Part A — failure-forensics persistence
// =============================================================================

describe('AA-CW-17 Part A — persistWriterFailureForensics', () => {
  let saveJsonSpy;
  let consoleLogSpy;
  let consoleWarnSpy;

  // The writer module lazy-requires gcsStorage, so we mock the module
  // path it requires.
  const gcsStoragePath = path.resolve(__dirname, '../../../services/gcsStorage.js');

  beforeEach(() => {
    jest.resetModules();
    saveJsonSpy = jest.fn().mockResolvedValue('gs://bucket/dummy');
    jest.doMock(gcsStoragePath, () => ({
      saveJson: saveJsonSpy,
    }));
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    jest.dontMock(gcsStoragePath);
    jest.resetModules();
  });

  // Re-require with mocks applied.
  function loadPersist() {
    const mod = require('../../../services/bookPipeline/writer/rewriteBookText');
    return mod.persistWriterFailureForensics;
  }

  function makeFailedDoc(overrides = {}) {
    return {
      operationalContext: { bookId: 'test-book-aa-cw-17' },
      request: {
        bookId: 'test-book-aa-cw-17',
        ageBand: AGE_BANDS.PB_INFANT,
        format: 'picture_book',
        pipelineVersion: 'book-pipeline-v2',
      },
      writerQa: {
        pass: false,
        perSpread: [
          { spreadNumber: 4, tags: ['identity_rhyme'], issues: ['identity rhyme on snug/snug'] },
        ],
        bookLevel: ['verb_crutch: pat appears on 5 spreads'],
        waves: 5,
      },
      writerRewriteMemory: {
        4: [
          { wave: 1, text: 'first attempt text', tags: ['rhyme_fail'], issues: ['rhyme fail'] },
          { wave: 2, text: 'second attempt text', tags: ['identity_rhyme'], issues: ['identity'] },
        ],
      },
      writerRewriteRejectionCount: { 4: 5 },
      spreads: [
        {
          spreadNumber: 4,
          manuscript: {
            text: 'final\nspread\nfour\ntext',
            side: 'left',
            lineBreakHints: ['hint'],
            personalizationUsed: ['Scarlett'],
            writerNotes: 'lines 3+4 unrhymed for natural cadence',
          },
        },
      ],
      ...overrides,
    };
  }

  it('writes a JSON dump to children-jobs/<bookId>/writer-failure.json when bookId is set', async () => {
    const persist = loadPersist();
    const doc = makeFailedDoc();
    await persist(doc, { reason: 'writer_fatal_residual', waves: 5, residualTags: ['identity_rhyme'] });

    expect(saveJsonSpy).toHaveBeenCalledTimes(1);
    const [dump, dest] = saveJsonSpy.mock.calls[0];
    expect(dest).toBe('children-jobs/test-book-aa-cw-17/writer-failure.json');
    expect(dump.bookId).toBe('test-book-aa-cw-17');
    expect(dump.schemaVersion).toBe('aa-cw-17.v1');
    expect(dump.failure.reason).toBe('writer_fatal_residual');
    expect(dump.failure.waves).toBe(5);
    expect(dump.failure.residualTags).toEqual(['identity_rhyme']);
  });

  it('includes writerRewriteMemory, writerQa, and final spread text in the dump', async () => {
    const persist = loadPersist();
    const doc = makeFailedDoc();
    await persist(doc, { reason: 'writer_fatal_residual', waves: 5, residualTags: ['identity_rhyme'] });

    const [dump] = saveJsonSpy.mock.calls[0];
    // Wave-by-wave attempt text MUST be in the dump — that's the whole
    // point of Part A. Without it, post-mortem text analysis is
    // impossible.
    expect(dump.writerRewriteMemory[4][0].text).toBe('first attempt text');
    expect(dump.writerRewriteMemory[4][1].text).toBe('second attempt text');
    expect(dump.writerRewriteRejectionCount[4]).toBe(5);
    expect(dump.writerQa.perSpread[0].tags).toContain('identity_rhyme');
    expect(dump.writerQa.bookLevel[0]).toMatch(/verb_crutch/);
    expect(dump.finalSpreads[0].text).toBe('final\nspread\nfour\ntext');
    expect(dump.finalSpreads[0].writerNotes).toBe('lines 3+4 unrhymed for natural cadence');
  });

  it('captures the ageBand so the operator knows which band failed', async () => {
    const persist = loadPersist();
    const doc = makeFailedDoc();
    await persist(doc, { reason: 'infant_action_text_residual', waves: 3, residualTags: ['infant_action_text_residual'] });

    const [dump] = saveJsonSpy.mock.calls[0];
    expect(dump.ageBand).toBe(AGE_BANDS.PB_INFANT);
    expect(dump.format).toBe('picture_book');
  });

  it('falls back to request.bookId when operationalContext.bookId is missing', async () => {
    const persist = loadPersist();
    const doc = makeFailedDoc({ operationalContext: {} });
    await persist(doc, { reason: 'writer_fatal_residual', waves: 5, residualTags: [] });
    expect(saveJsonSpy).toHaveBeenCalledTimes(1);
    expect(saveJsonSpy.mock.calls[0][1]).toBe('children-jobs/test-book-aa-cw-17/writer-failure.json');
  });

  it('skips the dump when no bookId is available anywhere', async () => {
    const persist = loadPersist();
    const doc = makeFailedDoc({ operationalContext: {}, request: { ...makeFailedDoc().request, bookId: undefined } });
    await persist(doc, { reason: 'writer_fatal_residual', waves: 5, residualTags: [] });
    expect(saveJsonSpy).not.toHaveBeenCalled();
  });

  it('honors operationalContext.persistFailureForensics === false to skip dump (test-friendly)', async () => {
    const persist = loadPersist();
    const doc = makeFailedDoc({
      operationalContext: { bookId: 'test-book', persistFailureForensics: false },
    });
    await persist(doc, { reason: 'writer_fatal_residual', waves: 5, residualTags: [] });
    expect(saveJsonSpy).not.toHaveBeenCalled();
  });

  it('SWALLOWS errors from saveJson — forensics must never crash the actual error path', async () => {
    saveJsonSpy.mockRejectedValueOnce(new Error('GCS unavailable'));
    const persist = loadPersist();
    const doc = makeFailedDoc();
    // Must not throw, must not propagate.
    await expect(persist(doc, { reason: 'writer_fatal_residual', waves: 5, residualTags: [] })).resolves.toBeUndefined();
    // Should have logged a warning.
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringMatching(/failed to persist forensics/i));
  });

  it('handles a doc with no spreads gracefully (empty finalSpreads)', async () => {
    const persist = loadPersist();
    const doc = makeFailedDoc({ spreads: undefined });
    await persist(doc, { reason: 'writer_fatal_residual', waves: 5, residualTags: [] });
    const [dump] = saveJsonSpy.mock.calls[0];
    expect(dump.finalSpreads).toEqual([]);
  });

  it('handles a doc with empty rewrite memory gracefully', async () => {
    const persist = loadPersist();
    const doc = makeFailedDoc({ writerRewriteMemory: undefined, writerRewriteRejectionCount: undefined });
    await persist(doc, { reason: 'writer_fatal_residual', waves: 5, residualTags: [] });
    const [dump] = saveJsonSpy.mock.calls[0];
    expect(dump.writerRewriteMemory).toEqual({});
    expect(dump.writerRewriteRejectionCount).toEqual({});
  });
});
