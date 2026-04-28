/**
 * Exhaustion acceptance gate for spread QA (premium Pixar medium must hold).
 */

const {
  canAcceptSpreadAfterExhaustionGate,
} = require('../../../services/bookPipeline/illustrator/renderAllSpreads');

describe('canAcceptSpreadAfterExhaustionGate', () => {
  const prev = process.env.ILLUSTRATION_QA_ACCEPT_ON_EXHAUSTION;

  afterEach(() => {
    process.env.ILLUSTRATION_QA_ACCEPT_ON_EXHAUSTION = prev;
  });

  test('returns false when env unset', () => {
    delete process.env.ILLUSTRATION_QA_ACCEPT_ON_EXHAUSTION;
    expect(canAcceptSpreadAfterExhaustionGate({
      pass: false,
      tags: ['missing_word'],
      consistency: { artStyleIs3DPixar: true },
    })).toBe(false);
  });

  test('returns true when env=1, qa failed on text only, Pixar holds', () => {
    process.env.ILLUSTRATION_QA_ACCEPT_ON_EXHAUSTION = '1';
    expect(canAcceptSpreadAfterExhaustionGate({
      pass: false,
      tags: ['missing_word', 'qa_api_error'],
      consistency: { artStyleIs3DPixar: true },
    })).toBe(true);
  });

  test('returns false on style_drift even when env set', () => {
    process.env.ILLUSTRATION_QA_ACCEPT_ON_EXHAUSTION = 'true';
    expect(canAcceptSpreadAfterExhaustionGate({
      pass: false,
      tags: ['style_drift'],
      consistency: { artStyleIs3DPixar: false },
    })).toBe(false);
  });

  test('returns false on hero_mismatch (identity) even when env set', () => {
    process.env.ILLUSTRATION_QA_ACCEPT_ON_EXHAUSTION = '1';
    expect(canAcceptSpreadAfterExhaustionGate({
      pass: false,
      tags: ['hero_mismatch'],
      consistency: { artStyleIs3DPixar: true },
    })).toBe(false);
  });
});
