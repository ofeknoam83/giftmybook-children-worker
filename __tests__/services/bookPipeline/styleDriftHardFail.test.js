/**
 * Confirmation tests for PR C section C.6: `style_drift` is a hard-fail
 * tag — it must always force `classifyCorrectionMode === 'full'`, even
 * when stacked with text-QA tags or soft-identity tags.
 *
 * We rely on this so that a spread that drifts onto a different rendering
 * tradition (photo, watercolor, anime) is regenerated from scratch
 * instead of getting a cheap text-only patch.
 */

const { classifyCorrectionMode } = require('../../../services/bookPipeline/qa/planRepair');

describe('style_drift hard-fail', () => {
  test('style_drift alone on attempt 1 → full', () => {
    expect(classifyCorrectionMode(['style_drift'], 1)).toBe('full');
  });

  test('style_drift + text tag on attempt 1 → full (not text_priority, not text_only)', () => {
    expect(classifyCorrectionMode(['unexpected_text', 'style_drift'], 1)).toBe('full');
    expect(classifyCorrectionMode(['style_drift', 'text_in_center_band'], 1)).toBe('full');
  });

  test('style_drift + soft identity tag on attempt 1 → full', () => {
    // A soft-identity tag alone with text would be text_priority. Adding
    // style_drift escalates the whole correction back to full.
    expect(classifyCorrectionMode(['text_in_center_band', 'hero_mismatch', 'style_drift'], 1)).toBe('full');
  });

  test('style_drift on attempt 2+ → full (every non-attempt-1 is full)', () => {
    expect(classifyCorrectionMode(['style_drift'], 2)).toBe('full');
    expect(classifyCorrectionMode(['style_drift', 'unexpected_text'], 3)).toBe('full');
  });

  test('text-only on attempt 1 (control) → text_only', () => {
    // Sanity check that the soft-correction pathway still works without
    // style_drift in the mix.
    expect(classifyCorrectionMode(['unexpected_text'], 1)).toBe('text_only');
  });
});
