/**
 * AA-CW-15 — writer rewrite memory.
 *
 * Production logs (book e3f4e0c0) showed the rewriter cycling through the
 * same 3-4 defects across 3 waves: wave 1 fixes the verb but breaks the
 * rhyme; wave 2 fixes the rhyme but reintroduces filler; wave 3 fixes
 * filler but reintroduces the verb. The rewriter has no recollection of
 * what it just tried, so it rediscovers each lossy local optimum.
 *
 * Fix: snapshot the rejected manuscript text + killing tags + killing
 * issues per spread BEFORE each rewrite call, cap to the last 2 attempts,
 * and surface a prominent "WHAT YOU JUST TRIED THAT DID NOT WORK" block
 * in the next wave's user prompt — both as a top-level memoryBlock and as
 * a `priorAttempts` field on each item in the JSON payload.
 */

const {
  recordRewriteAttempt,
  renderRewriteMemoryForSpread,
  rewriteUserPrompt,
  REWRITE_MEMORY_MAX_ATTEMPTS,
} = require('../../../services/bookPipeline/writer/rewriteBookText');

function makeBaseDoc() {
  return {
    request: { ageBand: 'PB_INFANT', bookId: 'test-book' },
    operationalContext: { bookId: 'test-book' },
    storyBible: { title: 'Test', characters: [], arcSummary: '' },
    spreads: [
      {
        spreadNumber: 1,
        spec: { setting: 'kitchen' },
        manuscript: { text: 'Line one of one.\nLine two of one.\nLine three of one.\nLine four of one.' },
      },
      {
        spreadNumber: 2,
        spec: { setting: 'garden' },
        manuscript: { text: 'Line one of two.\nLine two of two.\nLine three of two.\nLine four of two.' },
      },
    ],
  };
}

describe('AA-CW-15 — writer rewrite memory', () => {
  describe('REWRITE_MEMORY_MAX_ATTEMPTS', () => {
    test('is 2 — keeps the prompt bounded', () => {
      expect(REWRITE_MEMORY_MAX_ATTEMPTS).toBe(2);
    });
  });

  describe('recordRewriteAttempt', () => {
    test('appends to an empty memory and creates the spread bucket', () => {
      const doc = makeBaseDoc();
      const next = recordRewriteAttempt(doc, 1, {
        wave: 1,
        rejectedText: 'bad line',
        killingTags: ['rhyme_fail'],
        killingIssues: ['off-rhyme'],
      });
      expect(next.writerRewriteMemory[1]).toHaveLength(1);
      expect(next.writerRewriteMemory[1][0]).toMatchObject({
        wave: 1,
        rejectedText: 'bad line',
        killingTags: ['rhyme_fail'],
        killingIssues: ['off-rhyme'],
      });
      // Original doc is not mutated.
      expect(doc.writerRewriteMemory).toBeUndefined();
    });

    test('caps at the last 2 attempts per spread', () => {
      let doc = makeBaseDoc();
      doc = recordRewriteAttempt(doc, 1, { wave: 1, rejectedText: 'A', killingTags: ['t1'], killingIssues: [] });
      doc = recordRewriteAttempt(doc, 1, { wave: 2, rejectedText: 'B', killingTags: ['t2'], killingIssues: [] });
      doc = recordRewriteAttempt(doc, 1, { wave: 3, rejectedText: 'C', killingTags: ['t3'], killingIssues: [] });
      expect(doc.writerRewriteMemory[1]).toHaveLength(2);
      expect(doc.writerRewriteMemory[1].map(a => a.wave)).toEqual([2, 3]);
      expect(doc.writerRewriteMemory[1].map(a => a.rejectedText)).toEqual(['B', 'C']);
    });

    test('keeps per-spread buckets independent', () => {
      let doc = makeBaseDoc();
      doc = recordRewriteAttempt(doc, 1, { wave: 1, rejectedText: 'A', killingTags: [], killingIssues: [] });
      doc = recordRewriteAttempt(doc, 2, { wave: 1, rejectedText: 'X', killingTags: [], killingIssues: [] });
      expect(doc.writerRewriteMemory[1]).toHaveLength(1);
      expect(doc.writerRewriteMemory[2]).toHaveLength(1);
      expect(doc.writerRewriteMemory[1][0].rejectedText).toBe('A');
      expect(doc.writerRewriteMemory[2][0].rejectedText).toBe('X');
    });
  });

  describe('renderRewriteMemoryForSpread', () => {
    test('returns empty string when no memory exists', () => {
      const doc = makeBaseDoc();
      expect(renderRewriteMemoryForSpread(doc, 1)).toBe('');
    });

    test('renders the wave label, killing tags, rejected text, and why-it-failed bullets', () => {
      let doc = makeBaseDoc();
      doc = recordRewriteAttempt(doc, 1, {
        wave: 1,
        rejectedText: 'A line that drifted.\nA line that filled.',
        killingTags: ['semantic_filler', 'rhyme_fail'],
        killingIssues: ['filler word "just"', 'eye-rhyme love/move'],
      });
      const block = renderRewriteMemoryForSpread(doc, 1);
      expect(block).toContain('WHAT YOU JUST TRIED THAT DID NOT WORK');
      expect(block).toContain('Wave 1');
      expect(block).toContain('semantic_filler');
      expect(block).toContain('rhyme_fail');
      expect(block).toContain('A line that drifted.');
      expect(block).toContain('A line that filled.');
      expect(block).toContain('filler word "just"');
      expect(block).toContain('eye-rhyme love/move');
      expect(block).toContain('MUST differ in substance');
    });

    test('renders multiple attempts in chronological order', () => {
      let doc = makeBaseDoc();
      doc = recordRewriteAttempt(doc, 1, { wave: 1, rejectedText: 'WAVE-ONE-LINE', killingTags: ['t1'], killingIssues: [] });
      doc = recordRewriteAttempt(doc, 1, { wave: 2, rejectedText: 'WAVE-TWO-LINE', killingTags: ['t2'], killingIssues: [] });
      const block = renderRewriteMemoryForSpread(doc, 1);
      expect(block.indexOf('WAVE-ONE-LINE')).toBeGreaterThan(-1);
      expect(block.indexOf('WAVE-TWO-LINE')).toBeGreaterThan(-1);
      expect(block.indexOf('WAVE-ONE-LINE')).toBeLessThan(block.indexOf('WAVE-TWO-LINE'));
    });

    test('handles missing killingIssues gracefully', () => {
      let doc = makeBaseDoc();
      doc = recordRewriteAttempt(doc, 1, { wave: 1, rejectedText: 'L', killingTags: ['t'], killingIssues: undefined });
      expect(() => renderRewriteMemoryForSpread(doc, 1)).not.toThrow();
    });
  });

  describe('rewriteUserPrompt — memory injection', () => {
    test('does not include any memory block when memory is empty', () => {
      const doc = makeBaseDoc();
      const targets = [{ spreadNumber: 1, issues: ['x'], tags: ['rhyme_fail'], suggestedRewrite: '' }];
      const prompt = rewriteUserPrompt(doc, targets);
      expect(prompt).not.toContain('WHAT YOU JUST TRIED');
    });

    test('injects the memory block ABOVE the JSON payload for wave 2+', () => {
      let doc = makeBaseDoc();
      doc = recordRewriteAttempt(doc, 1, {
        wave: 1,
        rejectedText: 'Line one of one.\nLine two of one.\nLine three of one.\nLine four of one.',
        killingTags: ['verb_crutch'],
        killingIssues: ['"is" overused'],
      });
      const targets = [{ spreadNumber: 1, issues: ['rhyme_fail'], tags: ['rhyme_fail'], suggestedRewrite: '' }];
      const prompt = rewriteUserPrompt(doc, targets);

      // Block is present, with the spread header.
      expect(prompt).toContain('WHAT YOU JUST TRIED THAT DID NOT WORK');
      expect(prompt).toContain('--- Spread 1 ---');
      expect(prompt).toContain('Line one of one.');
      expect(prompt).toContain('verb_crutch');
      expect(prompt).toContain('"is" overused');

      // The prominent block must appear before the spread targets JSON.
      const blockIdx = prompt.indexOf('WHAT YOU JUST TRIED');
      const jsonIdx = prompt.indexOf('"priorAttempts"');
      expect(blockIdx).toBeGreaterThan(-1);
      expect(jsonIdx).toBeGreaterThan(-1);
      expect(blockIdx).toBeLessThan(jsonIdx);
    });

    test('embeds priorAttempts inside each item of the JSON payload', () => {
      let doc = makeBaseDoc();
      doc = recordRewriteAttempt(doc, 2, {
        wave: 1,
        rejectedText: 'WAVE-ONE-FOR-TWO',
        killingTags: ['semantic_filler'],
        killingIssues: ['"just" filler'],
      });
      const targets = [{ spreadNumber: 2, issues: ['x'], tags: ['rhyme_fail'], suggestedRewrite: '' }];
      const prompt = rewriteUserPrompt(doc, targets);
      expect(prompt).toContain('"priorAttempts"');
      expect(prompt).toContain('WAVE-ONE-FOR-TWO');
      expect(prompt).toContain('semantic_filler');
    });

    test('renders only the spreads currently being targeted', () => {
      let doc = makeBaseDoc();
      doc = recordRewriteAttempt(doc, 1, { wave: 1, rejectedText: 'SPREAD-ONE-MEMORY', killingTags: ['t'], killingIssues: [] });
      doc = recordRewriteAttempt(doc, 2, { wave: 1, rejectedText: 'SPREAD-TWO-MEMORY', killingTags: ['t'], killingIssues: [] });
      const targets = [{ spreadNumber: 2, issues: ['x'], tags: ['t'], suggestedRewrite: '' }];
      const prompt = rewriteUserPrompt(doc, targets);
      // Spread 2's memory shows up; spread 1's does not (we are not rewriting it).
      expect(prompt).toContain('SPREAD-TWO-MEMORY');
      expect(prompt).not.toContain('SPREAD-ONE-MEMORY');
    });

    test('integration — wave 2 prompt contains wave 1 rejected text verbatim', () => {
      let doc = makeBaseDoc();
      // Simulate wave 1 getting rejected: snapshot the manuscript that QA killed.
      const wave1RejectedText = doc.spreads[0].manuscript.text;
      doc = recordRewriteAttempt(doc, 1, {
        wave: 1,
        rejectedText: wave1RejectedText,
        killingTags: ['verb_crutch', 'rhyme_fail'],
        killingIssues: ['"is" overused', 'identity rhyme'],
      });
      const targets = [{ spreadNumber: 1, issues: ['rhyme_fail'], tags: ['rhyme_fail'], suggestedRewrite: '' }];
      const prompt = rewriteUserPrompt(doc, targets);

      // Every line of the rejected text shows up in the prompt.
      for (const line of wave1RejectedText.split(/\r?\n/)) {
        expect(prompt).toContain(line);
      }
      // Both killing tags surface.
      expect(prompt).toContain('verb_crutch');
      expect(prompt).toContain('rhyme_fail');
    });
  });
});
