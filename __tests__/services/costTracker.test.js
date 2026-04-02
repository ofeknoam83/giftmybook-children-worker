const { CostTracker } = require('../../services/costTracker');

describe('CostTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  test('starts with zero cost', () => {
    const summary = tracker.getSummary();
    expect(summary.totalCost).toBe(0);
    expect(Object.keys(summary.breakdown)).toHaveLength(0);
  });

  test('tracks text usage', () => {
    tracker.addTextUsage('gpt-5.4', 1000, 500);
    const summary = tracker.getSummary();
    expect(summary.totalCost).toBeGreaterThan(0);
    expect(summary.breakdown['gpt-5.4']).toBeDefined();
    expect(summary.breakdown['gpt-5.4'].inputTokens).toBe(1000);
    expect(summary.breakdown['gpt-5.4'].outputTokens).toBe(500);
  });

  test('accumulates text usage for same model', () => {
    tracker.addTextUsage('gpt-5.4', 1000, 500);
    tracker.addTextUsage('gpt-5.4', 2000, 1000);
    const summary = tracker.getSummary();
    expect(summary.breakdown['gpt-5.4'].inputTokens).toBe(3000);
    expect(summary.breakdown['gpt-5.4'].outputTokens).toBe(1500);
  });

  test('tracks image generation', () => {
    tracker.addImageGeneration('flux-dev', 3);
    const summary = tracker.getSummary();
    expect(summary.totalCost).toBeGreaterThan(0);
    expect(summary.breakdown['flux-dev'].imageCount).toBe(3);
  });

  test('combines text and image costs', () => {
    tracker.addTextUsage('gpt-5.4', 10000, 5000);
    tracker.addImageGeneration('flux-dev', 10);
    const summary = tracker.getSummary();
    expect(Object.keys(summary.breakdown)).toHaveLength(2);
    expect(summary.totalCost).toBeGreaterThan(0);
  });

  test('reset clears all usage', () => {
    tracker.addTextUsage('gpt-5.4', 1000, 500);
    tracker.addImageGeneration('flux-dev', 5);
    tracker.reset();
    const summary = tracker.getSummary();
    expect(summary.totalCost).toBe(0);
  });

  test('handles unknown models with default rates', () => {
    tracker.addTextUsage('unknown-model', 1000, 500);
    const summary = tracker.getSummary();
    expect(summary.totalCost).toBeGreaterThan(0);
  });
});
