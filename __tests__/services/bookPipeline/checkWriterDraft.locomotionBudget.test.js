/**
 * AA-CW-8 — Lock the maxTokens floor for `infantLocomotionGate`.
 *
 * Gemini Flash 2.5 reserves a thinking-token budget below ~512 before
 * emitting any output. Production logs showed every per-line locomotion
 * gate call truncating at maxTokens=200, then the wrapper auto-doubling
 * to 400 (often truncating again) and 800 (eventually succeeding) — for
 * a final ~5-10 token JSON payload. Net waste: 2-3x Flash spend and
 * ~3-7s latency per line, multiplied across every PB_INFANT spread.
 *
 * This test asserts the call site requests at least 1024 tokens so the
 * thinking floor + JSON envelope fit in one attempt.
 */

jest.mock('../../../services/bookPipeline/llm/openaiClient', () => ({
  callText: jest.fn(),
}));

const { callText } = require('../../../services/bookPipeline/llm/openaiClient');
const {
  findInfantForbiddenActionVerbs,
} = require('../../../services/bookPipeline/qa/checkWriterDraft');
const { AGE_BANDS, MODELS } = require('../../../services/bookPipeline/constants');

describe('infantLocomotionGate — Flash budget floor (AA-CW-8)', () => {
  beforeEach(() => {
    callText.mockReset();
  });

  it('requests at least 1024 maxTokens to clear the Flash 2.5 thinking floor', async () => {
    callText.mockResolvedValue({ json: { hits: [] } });

    await findInfantForbiddenActionVerbs(
      'Baby giggles softly in the crib.',
      AGE_BANDS.PB_INFANT,
    );

    expect(callText).toHaveBeenCalledTimes(1);
    const config = callText.mock.calls[0][0];
    expect(config.label).toBe('infantLocomotionGate');
    expect(config.model).toBe(MODELS.WRITER_QA);
    expect(config.jsonMode).toBe(true);
    expect(config.maxTokens).toBeGreaterThanOrEqual(1024);
  });

  it('runs one call per line and each respects the budget floor', async () => {
    callText.mockResolvedValue({ json: { hits: [] } });

    await findInfantForbiddenActionVerbs(
      'Line one is calm.\nLine two is also calm.\nLine three rests.',
      AGE_BANDS.PB_INFANT,
    );

    expect(callText).toHaveBeenCalledTimes(3);
    for (const call of callText.mock.calls) {
      expect(call[0].label).toBe('infantLocomotionGate');
      expect(call[0].maxTokens).toBeGreaterThanOrEqual(1024);
    }
  });

  it('skips entirely for non-PB_INFANT bands (no call, no cost)', async () => {
    const out = await findInfantForbiddenActionVerbs(
      'A toddler runs across the room.',
      AGE_BANDS.PB_PRESCHOOL,
    );
    expect(out).toEqual([]);
    expect(callText).not.toHaveBeenCalled();
  });
});
