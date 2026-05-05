/**
 * PR F.3 \u2014 Illustrator early-abort for unrenderable infant actions.
 *
 * The quad illustrator counts consecutive `age_action_impossible`
 * rejections per spread pair. When the streak hits the configured
 * threshold, the pair is abandoned with `infant_action_text_unrenderable`
 * instead of burning the rest of the per-pair budget.
 *
 * These helpers are pure so they can be exercised without spinning up
 * the full Gemini illustrator session.
 */

const {
  nextConsecutiveAgeActionImpossible,
  shouldEarlyAbortForUnrenderableInfantAction,
} = require('../../../services/bookPipeline/illustrator/renderAllSpreadsQuad');
const { REPAIR_BUDGETS } = require('../../../services/bookPipeline/constants');

describe('nextConsecutiveAgeActionImpossible', () => {
  test('increments when the latest rejection includes age_action_impossible', () => {
    expect(nextConsecutiveAgeActionImpossible(0, ['age_action_impossible'])).toBe(1);
    expect(nextConsecutiveAgeActionImpossible(2, ['age_action_impossible', 'action_mismatch'])).toBe(3);
  });

  test('resets to 0 when the latest rejection does not include the tag', () => {
    expect(nextConsecutiveAgeActionImpossible(2, ['outfit_mismatch'])).toBe(0);
    expect(nextConsecutiveAgeActionImpossible(5, [])).toBe(0);
  });

  test('treats undefined/non-array tags as a reset', () => {
    expect(nextConsecutiveAgeActionImpossible(3, undefined)).toBe(0);
    expect(nextConsecutiveAgeActionImpossible(3, null)).toBe(0);
  });

  test('handles undefined prev as 0', () => {
    expect(nextConsecutiveAgeActionImpossible(undefined, ['age_action_impossible'])).toBe(1);
  });
});

describe('shouldEarlyAbortForUnrenderableInfantAction', () => {
  test('returns false until the configured threshold is reached', () => {
    const threshold = REPAIR_BUDGETS.ageActionImpossibleConsecutiveAbort;
    expect(shouldEarlyAbortForUnrenderableInfantAction(0)).toBe(false);
    expect(shouldEarlyAbortForUnrenderableInfantAction(threshold - 1)).toBe(false);
  });

  test('returns true at and beyond the configured threshold', () => {
    const threshold = REPAIR_BUDGETS.ageActionImpossibleConsecutiveAbort;
    expect(shouldEarlyAbortForUnrenderableInfantAction(threshold)).toBe(true);
    expect(shouldEarlyAbortForUnrenderableInfantAction(threshold + 5)).toBe(true);
  });

  test('threshold is configured to a sensible value (\u2265 2 to absorb noise, \u2264 5 to avoid waste)', () => {
    // Documents the contract: too low = false-positive aborts on a single
    // bad render; too high = defeats the cost-saving purpose of the gate.
    expect(REPAIR_BUDGETS.ageActionImpossibleConsecutiveAbort).toBeGreaterThanOrEqual(2);
    expect(REPAIR_BUDGETS.ageActionImpossibleConsecutiveAbort).toBeLessThanOrEqual(5);
  });
});

describe('streak behaviour through realistic rejection sequences', () => {
  test('a sustained streak hits the abort threshold (mirrors the live failure log)', () => {
    // Mirrors the actual Everleigh spread 7+8 log: every rejection had
    // age_action_impossible because the manuscript text said "twirl up high".
    const sequence = [
      ['action_mismatch', 'age_action_impossible'],
      ['age_action_impossible', 'wrong_font', 'outfit_mismatch'],
      ['action_mismatch', 'age_action_impossible'],
      ['age_action_impossible'],
      ['action_mismatch', 'age_action_impossible'],
    ];
    let streak = 0;
    let aborted = false;
    let abortedAtAttempt = -1;
    for (let i = 0; i < sequence.length; i += 1) {
      streak = nextConsecutiveAgeActionImpossible(streak, sequence[i]);
      if (shouldEarlyAbortForUnrenderableInfantAction(streak)) {
        aborted = true;
        abortedAtAttempt = i + 1;
        break;
      }
    }
    expect(aborted).toBe(true);
    // With threshold = 3, abort on attempt 3 \u2014 saves the remaining 17 attempts.
    expect(abortedAtAttempt).toBe(REPAIR_BUDGETS.ageActionImpossibleConsecutiveAbort);
  });

  test('an interleaved sequence (not a streak) does NOT abort early', () => {
    // age failures broken up by outfit-only failures \u2014 not an unwinnable
    // text contract issue, just normal illustrator noise. Must not abort.
    const sequence = [
      ['age_action_impossible'],
      ['outfit_mismatch'],
      ['age_action_impossible'],
      ['hair_continuity_drift'],
      ['age_action_impossible'],
      ['outfit_mismatch'],
    ];
    let streak = 0;
    let aborted = false;
    for (const tags of sequence) {
      streak = nextConsecutiveAgeActionImpossible(streak, tags);
      if (shouldEarlyAbortForUnrenderableInfantAction(streak)) {
        aborted = true;
        break;
      }
    }
    expect(aborted).toBe(false);
  });
});
