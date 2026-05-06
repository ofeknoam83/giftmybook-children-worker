'use strict';

/**
 * AA-CW-18 — three-part fix targeting the production failure documented
 * in writer-failure.json for book e3f4e0c0:
 *
 *  Part A — book-level diversification: parse verb_crutch / refrain_crutch
 *           tags into structured directives; render them into the rewrite
 *           prompt; force the rewriter to touch spreads named in book-level
 *           tags even when those spreads passed per-spread QA.
 *
 *  Part B — harden the PB_INFANT 3+4 escape hatch: 3+4 now DEFAULTS to
 *           free-verse, no rhyme iteration permitted.
 *
 *  Part C — deterministic dropped-article audit in checkWriterDraft so the
 *           judge does not waste a wave on \"at sky\" / \"by hand\" type
 *           grammar slips at the tight infant word budget.
 */

describe('AA-CW-18 Part A — book-level diversification directives', () => {
  const {
    parseBookLevelDirectives,
    renderBookLevelDirectivesBlock,
    rewriteUserPrompt,
  } = require('../../../services/bookPipeline/writer/rewriteBookText');

  describe('parseBookLevelDirectives', () => {
    test('returns [] for empty / non-array input', () => {
      expect(parseBookLevelDirectives()).toEqual([]);
      expect(parseBookLevelDirectives(null)).toEqual([]);
      expect(parseBookLevelDirectives([])).toEqual([]);
    });

    test('parses a single verb_crutch line with one lemma + spread enumeration', () => {
      const issues = [
        "verb_crutch: 'give' appears in 5 of 13 spreads (38%) — spreads 4, 8, 9, 10, 12. Diversify the actions.",
      ];
      const out = parseBookLevelDirectives(issues);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        kind: 'verb_crutch',
        lemma: 'give',
        spreads: [4, 8, 9, 10, 12],
      });
    });

    test('parses curly-quote lemmas (\u2018give\u2019) too', () => {
      const issues = [
        "verb_crutch: \u2018pat\u2019 appears in 4 of 13 spreads (31%) \u2014 spreads 1, 6, 12, 13. Diversify the actions.",
      ];
      const out = parseBookLevelDirectives(issues);
      expect(out).toHaveLength(1);
      expect(out[0].lemma).toBe('pat');
      expect(out[0].spreads).toEqual([1, 6, 12, 13]);
    });

    test('produces one directive per lemma when a single refrain_crutch line names many', () => {
      // Real production string from forensics file:
      const issues = [
        "refrain_crutch: The manuscript has extremely repetitive vocabulary. 'sleeve' appears in 8/13 spreads, 'hand' in 7/13, 'leaf' in 7/13, 'blanket' in 6/13, and 'arm' in 5/13.",
      ];
      const out = parseBookLevelDirectives(issues);
      const lemmas = out.map(d => d.lemma).sort();
      expect(lemmas).toEqual(['arm', 'blanket', 'hand', 'leaf', 'sleeve']);
      for (const d of out) {
        expect(d.kind).toBe('refrain_crutch');
      }
    });

    test('handles a directive with NO enumerated spreads gracefully', () => {
      const issues = [
        "verb_crutch: 'pat' appears in 4 of 13 spreads.",
      ];
      const out = parseBookLevelDirectives(issues);
      expect(out).toHaveLength(1);
      expect(out[0].lemma).toBe('pat');
      expect(out[0].spreads).toEqual([]);
    });

    test('ignores unrelated book-level issues (non-crutch tags)', () => {
      const issues = [
        'signature_beat_missing: the dedication line is absent.',
        'some other note about the book',
      ];
      expect(parseBookLevelDirectives(issues)).toEqual([]);
    });

    test('mixes verb_crutch and refrain_crutch in the right order and kinds', () => {
      const issues = [
        "verb_crutch: 'give' appears in 5 of 13 spreads (38%) — spreads 4, 8, 9, 10, 12.",
        "refrain_crutch: 'sleeve' appears in 8 of 13 spreads — spreads 1, 4, 6, 8, 10, 11, 12, 13.",
      ];
      const out = parseBookLevelDirectives(issues);
      expect(out).toHaveLength(2);
      expect(out[0].kind).toBe('verb_crutch');
      expect(out[1].kind).toBe('refrain_crutch');
    });
  });

  describe('renderBookLevelDirectivesBlock', () => {
    test('returns empty string when there are no directives', () => {
      expect(renderBookLevelDirectivesBlock([])).toBe('');
      expect(renderBookLevelDirectivesBlock(null)).toBe('');
    });

    test('renders verb crutches under a VERBS heading and refrains under a NOUNS heading', () => {
      const out = renderBookLevelDirectivesBlock([
        { kind: 'verb_crutch', lemma: 'give', spreads: [4, 8] },
        { kind: 'refrain_crutch', lemma: 'sleeve', spreads: [1, 6] },
      ]);
      expect(out).toMatch(/BOOK-LEVEL DIVERSIFICATION/);
      expect(out).toMatch(/Overused VERBS/);
      expect(out).toMatch(/Overused NOUNS \/ WORDS/);
      expect(out).toMatch(/"give"/);
      expect(out).toMatch(/spreads 4, 8/);
      expect(out).toMatch(/"sleeve"/);
      expect(out).toMatch(/spreads 1, 6/);
    });

    test('falls back to "every spread it appears on" when no spread enumeration is present', () => {
      const out = renderBookLevelDirectivesBlock([
        { kind: 'verb_crutch', lemma: 'pat', spreads: [] },
      ]);
      expect(out).toMatch(/every spread it appears on/);
    });

    test('reminds the rewriter to vary the SENSORY CHANNEL on refrain crutches', () => {
      const out = renderBookLevelDirectivesBlock([
        { kind: 'refrain_crutch', lemma: 'leaf', spreads: [4] },
      ]);
      expect(out.toLowerCase()).toMatch(/sensory channel|sound|light|breath|texture|shadow/);
    });

    test('includes the strong corpus-not-spread instruction at the bottom', () => {
      const out = renderBookLevelDirectivesBlock([
        { kind: 'verb_crutch', lemma: 'give', spreads: [4, 8] },
      ]);
      expect(out).toMatch(/corpus problem, not a per-spread problem/);
    });
  });

  describe('rewriteUserPrompt — surfaces book-level directives above the JSON payload', () => {
    function buildDocWithBookLevel(bookLevelIssues) {
      return {
        request: { ageBand: '0-1', format: 'picture_book' },
        brief: { child: { name: 'Scarlett' }, pronouns: { subject: 'she', object: 'her', possessive: 'her', reflexive: 'herself' } },
        storyBible: { narrativeSpine: 'A Mother\u2019s Day stroll.', beats: [], motifs: [], locations: [] },
        spreads: [
          { spreadNumber: 1, spec: { sceneIntent: 'opening' }, manuscript: { text: 'Mama says, "Smushy."\nScarlett smiles, gushy.\nLight moves on her face.\nHer hand pats Mama\u2019s sleeve.', side: 'left' } },
          { spreadNumber: 4, spec: { sceneIntent: 'mid' }, manuscript: { text: 'Leaves stir in breeze.\nA hand gives a squeeze.\nScarlett hears a leaf sound.\nThe breeze brushes her cheek.', side: 'right' } },
        ],
        writerQa: {
          bookLevel: bookLevelIssues,
        },
      };
    }

    test('renders the book-level block when verb_crutch is present', () => {
      const doc = buildDocWithBookLevel([
        "verb_crutch: 'give' appears in 5 of 13 spreads (38%) — spreads 4, 8, 9, 10, 12.",
      ]);
      const targets = [{ spreadNumber: 4, issues: ['some_per_spread_issue'], tags: ['rhyme_fail'], suggestedRewrite: null }];
      const out = rewriteUserPrompt(doc, targets);
      expect(out).toMatch(/BOOK-LEVEL DIVERSIFICATION/);
      expect(out).toMatch(/"give"/);
    });

    test('does NOT render the book-level block when no crutch tags exist', () => {
      const doc = buildDocWithBookLevel([]);
      const targets = [{ spreadNumber: 4, issues: [], tags: [], suggestedRewrite: null }];
      const out = rewriteUserPrompt(doc, targets);
      expect(out).not.toMatch(/BOOK-LEVEL DIVERSIFICATION/);
    });

    test('places the directive block ABOVE the JSON payload (not buried)', () => {
      const doc = buildDocWithBookLevel([
        "refrain_crutch: 'sleeve' appears in 8 of 13 spreads — spreads 1, 4.",
      ]);
      const targets = [{ spreadNumber: 4, issues: [], tags: [], suggestedRewrite: null }];
      const out = rewriteUserPrompt(doc, targets);
      const idxDirective = out.indexOf('BOOK-LEVEL DIVERSIFICATION');
      const idxJsonPayload = out.indexOf('Rewrite ONLY these spreads');
      expect(idxDirective).toBeGreaterThan(-1);
      expect(idxJsonPayload).toBeGreaterThan(-1);
      expect(idxDirective).toBeLessThan(idxJsonPayload);
    });
  });
});

describe('AA-CW-18 Part B — harder PB_INFANT escape hatch (default free-verse on 3+4)', () => {
  const { renderTextPolicyBlock } = require('../../../services/bookPipeline/writer/textPolicies');
  const { SYSTEM_PROMPT: WRITER_DRAFT_SYSTEM_PROMPT } = require('../../../services/bookPipeline/writer/draftBookText');
  const { SYSTEM_PROMPT: WRITER_REWRITE_SYSTEM_PROMPT } = require('../../../services/bookPipeline/writer/rewriteBookText');

  function policyBlockForInfant() {
    return renderTextPolicyBlock({
      request: { ageBand: '0-1', format: 'picture_book' },
      brief: { child: { name: 'Scarlett' } },
    });
  }

  test('infant rhyme rule now reads "DEFAULT FREE-VERSE", not just "RELAXED"', () => {
    const block = policyBlockForInfant();
    expect(block).toMatch(/DEFAULT FREE-VERSE/i);
  });

  test('infant rule explicitly forbids iterating on lines 3+4 to find a rhyme', () => {
    const block = policyBlockForInfant();
    expect(block).toMatch(/do NOT iterate to find a rhyme/i);
  });

  test('infant rule names the canonical bad-rhyme outcomes seen in production (dawning, teal, slant pairs)', () => {
    const block = policyBlockForInfant();
    expect(block).toMatch(/dawning/);
    expect(block).toMatch(/teal/);
    expect(block).toMatch(/cloth\/both|sleeve\/breeze|arm\/warm/);
  });

  test('writer DRAFT SYSTEM_PROMPT carries the same DEFAULT FREE-VERSE wording', () => {
    expect(WRITER_DRAFT_SYSTEM_PROMPT).toMatch(/DEFAULT FREE-VERSE/i);
    expect(WRITER_DRAFT_SYSTEM_PROMPT).toMatch(/FIRST attempt/);
  });

  test('writer REWRITE SYSTEM_PROMPT tells the rewriter that prior 3+4 failures must go free-verse next wave', () => {
    expect(WRITER_REWRITE_SYSTEM_PROMPT).toMatch(/DEFAULT FREE-VERSE/i);
    expect(WRITER_REWRITE_SYSTEM_PROMPT).toMatch(/MUST go free-verse/i);
  });

  test('rewriter prompt names the four prior-wave failure tags that mandate free-verse next wave', () => {
    expect(WRITER_REWRITE_SYSTEM_PROMPT).toMatch(/identity_rhyme/);
    expect(WRITER_REWRITE_SYSTEM_PROMPT).toMatch(/forced_rhyme_meaning_drift/);
    expect(WRITER_REWRITE_SYSTEM_PROMPT).toMatch(/writer_invented_prop/);
    expect(WRITER_REWRITE_SYSTEM_PROMPT).toMatch(/unrenderable_action/);
  });
});

describe('AA-CW-18 Part C — deterministic dropped-article audit', () => {
  // Mock the LLM judge + shadow at module load so checkWriterDraft can run
  // end-to-end without a real network call.
  jest.resetModules();
  jest.doMock('../../../services/bookPipeline/llm/openaiClient', () => ({
    callText: jest.fn(async ({ label }) => {
      // Return a "pass" judge verdict so we can prove the dropped-article
      // audit FORCES the failure even when the LLM judge missed it.
      if (label === 'writerQa.judge') {
        return {
          json: { pass: true, perSpread: [], bookLevelIssues: [], bookLevelTags: [] },
          ok: true,
          model: 'gemini-2.5-pro',
          attempts: 1,
          usage: { promptTokens: 0, completionTokens: 0 },
        };
      }
      // Shadow path
      return {
        json: { pass: true, bookLevelIssues: [], perSpread: [] },
        ok: true,
        model: 'gemini-2.5-flash',
        attempts: 1,
        usage: { promptTokens: 0, completionTokens: 0 },
      };
    }),
  }));

  const { checkWriterDraft } = require('../../../services/bookPipeline/qa/checkWriterDraft');

  function buildDoc(spreads) {
    return {
      operationalContext: { bookId: 'test-aa-cw-18-c' },
      request: { ageBand: '0-1', format: 'picture_book' },
      brief: { child: { name: 'Scarlett', firstName: 'Scarlett' }, pronouns: { subject: 'she', object: 'her', possessive: 'her', reflexive: 'herself' } },
      storyBible: { narrativeSpine: 'stroll', beats: [], motifs: [], locations: [], theme: 'mothers_day' },
      spreads: spreads.map((text, i) => ({
        spreadNumber: i + 1,
        spec: { sceneIntent: '', characters: [], visibleProps: [], setting: '' },
        manuscript: { text, side: i % 2 === 0 ? 'left' : 'right' },
      })),
      trace: { llmCalls: [] },
    };
  }

  test('flags "at sky" as dropped_article on the spread that contains it', async () => {
    const doc = buildDoc([
      'Mama lifts Scarlett high.\nScarlett looks at sky.\nA leaf waves by the door.\nThe blanket slips on her arm.',
    ]);
    const result = await checkWriterDraft(doc);
    expect(result.pass).toBe(false);
    const s1 = result.perSpread.find(s => s.spreadNumber === 1);
    expect(s1.tags).toContain('dropped_article');
    expect(s1.issues.some(i => /at sky/.test(i))).toBe(true);
  });

  test('flags "by hand" as dropped_article', async () => {
    const doc = buildDoc([
      'Wheel hums low.\nLeaf shadows flow.\nScarlett watches the path.\nThe blanket rests by hand.',
    ]);
    const result = await checkWriterDraft(doc);
    const s1 = result.perSpread.find(s => s.spreadNumber === 1);
    expect(s1.tags).toContain('dropped_article');
    expect(s1.issues.some(i => /by hand/.test(i))).toBe(true);
  });

  test('flags "for chin" as dropped_article', async () => {
    const doc = buildDoc([
      'Scarlett reaches for chin.\nMama leans her in.\nA hand lifts by her cheek.\nA smile waits there.',
    ]);
    const result = await checkWriterDraft(doc);
    const s1 = result.perSpread.find(s => s.spreadNumber === 1);
    expect(s1.tags).toContain('dropped_article');
  });

  test('does NOT flag well-formed prepositional phrases ("at the sky", "on her lap", "by her hand")', async () => {
    const doc = buildDoc([
      'Mama lifts Scarlett high.\nScarlett looks at the sky.\nScarlett rests on her lap.\nThe blanket rests by her hand.',
    ]);
    const result = await checkWriterDraft(doc);
    const s1 = result.perSpread.find(s => s.spreadNumber === 1);
    expect(s1.tags || []).not.toContain('dropped_article');
  });

  test('does NOT flag plural bare-noun phrases ("in arms", "on hands")', async () => {
    const doc = buildDoc([
      'Scarlett rests in arms.\nMama hums to her.\nLight moves on hands.\nA leaf turns slow.',
    ]);
    const result = await checkWriterDraft(doc);
    const s1 = result.perSpread.find(s => s.spreadNumber === 1);
    expect(s1.tags || []).not.toContain('dropped_article');
  });

  test('flags ALL offending prepositions on a single line', async () => {
    const doc = buildDoc([
      'Scarlett looks at sky.\nScarlett looks at sky.\nA blanket rests on lap.\nA leaf falls by chin.',
    ]);
    const result = await checkWriterDraft(doc);
    const s1 = result.perSpread.find(s => s.spreadNumber === 1);
    expect(s1.tags).toContain('dropped_article');
    // Should have produced multiple distinct issue strings (one per match).
    const droppedIssues = s1.issues.filter(i => i.startsWith('dropped_article'));
    expect(droppedIssues.length).toBeGreaterThanOrEqual(3);
  });

  test('forces overall pass=false and perSpread.pass=false even when the LLM judge said pass', async () => {
    const doc = buildDoc([
      'Scarlett looks at sky.\nMama lifts her high.\nA leaf waves slow.\nThe blanket rests by her hand.',
    ]);
    const result = await checkWriterDraft(doc);
    expect(result.pass).toBe(false);
    const s1 = result.perSpread.find(s => s.spreadNumber === 1);
    expect(s1.pass).toBe(false);
  });
});
