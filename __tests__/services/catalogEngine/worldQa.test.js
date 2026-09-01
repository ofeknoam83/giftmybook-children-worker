/**
 * checkWorldConsistency — the book-level multi-image world QA call (Layer 3),
 * with the Gemini transport mocked. Mirrors checkSpreadRender's contract:
 * infra failures pass with `qaUnavailable`, never block a book.
 */

jest.mock('../../../services/illustrationGenerator', () => ({
  fetchWithTimeout: jest.fn(),
  getNextApiKey: jest.fn(() => 'test-key'),
  compareTexts: jest.fn(() => ({ valid: true, issues: [] })),
}));

const { fetchWithTimeout } = require('../../../services/illustrationGenerator');
const { checkWorldConsistency, worldRepairNote } = require('../../../services/catalogEngine/illustrator/spreadQa');

const entries = (...spreads) => spreads.map(n => ({ spread: n, buffer: Buffer.from(`img-${n}`) }));

const geminiJson = obj => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }),
});

beforeEach(() => fetchWithTimeout.mockReset());

describe('checkWorldConsistency', () => {
  test('fewer than 2 renders returns null — a single-spread probe skips the gate', async () => {
    await expect(checkWorldConsistency(entries(3))).resolves.toBeNull();
    await expect(checkWorldConsistency([])).resolves.toBeNull();
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  test('a consistent set passes', async () => {
    fetchWithTimeout.mockResolvedValue(geminiJson({ consistent: true, flagged: [] }));
    const verdict = await checkWorldConsistency(entries(1, 2, 3));
    expect(verdict).toEqual({ pass: true, flagged: [] });
    // Every render rides the one call, each labeled before its image.
    const body = JSON.parse(fetchWithTimeout.mock.calls[0][1].body);
    const parts = body.contents[0].parts;
    expect(parts.filter(p => p.inline_data)).toHaveLength(3);
    expect(parts.some(p => p.text === 'SPREAD 2:')).toBe(true);
  });

  test('flagged spreads are reported; hallucinated spread numbers are dropped', async () => {
    fetchWithTimeout.mockResolvedValue(geminiJson({
      consistent: false,
      flagged: [
        { spread: 3, note: 'cooler palette and modern lamp posts unlike the other spreads' },
        { spread: 99, note: 'not in this check' },
      ],
    }));
    const verdict = await checkWorldConsistency(entries(1, 2, 3));
    expect(verdict.pass).toBe(false);
    expect(verdict.flagged).toEqual([{ spread: 3, note: 'cooler palette and modern lamp posts unlike the other spreads' }]);
  });

  test('an inconsistent verdict whose flags are all hallucinated keeps pass=false with nothing to repair', async () => {
    // consistent:false but nothing actionable survives — the gate must not
    // invent a flagged spread; the disagreement is surfaced book-level only.
    fetchWithTimeout.mockResolvedValue(geminiJson({ consistent: false, flagged: [{ spread: 42, note: 'x' }] }));
    const verdict = await checkWorldConsistency(entries(1, 2));
    expect(verdict.flagged).toEqual([]);
    expect(verdict.pass).toBe(false); // the model said the set disagrees — surfaced, nothing re-rendered
  });

  test('HTTP failure and malformed verdicts pass with qaUnavailable — never block', async () => {
    fetchWithTimeout.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    let verdict = await checkWorldConsistency(entries(1, 2));
    expect(verdict.pass).toBe(true);
    expect(verdict.qaUnavailable).toMatch(/HTTP 500/);

    fetchWithTimeout.mockResolvedValue(geminiJson({ nonsense: true }));
    verdict = await checkWorldConsistency(entries(1, 2));
    expect(verdict.pass).toBe(true);
    expect(verdict.qaUnavailable).toMatch(/malformed/);

    fetchWithTimeout.mockRejectedValue(new Error('socket hangup'));
    verdict = await checkWorldConsistency(entries(1, 2));
    expect(verdict.pass).toBe(true);
    expect(verdict.qaUnavailable).toMatch(/socket hangup/);
  });
});

describe('worldRepairNote', () => {
  test('carries the finding and scopes the fix to the world break only', () => {
    const note = worldRepairNote('cooler palette than the rest of the book');
    expect(note).toContain('cooler palette than the rest of the book');
    expect(note).toContain('SAME scene and action');
    expect(note).toContain('Fix ONLY the world/style break');
  });
});
