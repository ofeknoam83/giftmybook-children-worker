/**
 * Cost Tracker — tracks per-model costs for text and image generation
 */

const RATES = {
  // Text models (per 1M tokens)
  'gpt-5.4': { input: 2.50, output: 15.00 },
  'gpt-5.4-mini': { input: 0.15, output: 0.60 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-3-flash-preview': { input: 0.30, output: 2.50 },
  // Image models (per image)
  'replicate-faceid': { perImage: 0.05 },
  'replicate-flux': { perImage: 0.04 },
  'gemini-image': { perImage: 0.02 },
  'gemini-3.1-flash-image-preview': { perImage: 0.02 },
  'gemini-2.5-flash-image': { perImage: 0.02 },
};

class CostTracker {
  constructor() {
    this.textUsage = {};   // model → { inputTokens, outputTokens }
    this.imageUsage = {};  // model → count
  }

  addTextUsage(model, inputTokens, outputTokens) {
    if (!this.textUsage[model]) {
      this.textUsage[model] = { inputTokens: 0, outputTokens: 0 };
    }
    this.textUsage[model].inputTokens += inputTokens || 0;
    this.textUsage[model].outputTokens += outputTokens || 0;
  }

  addImageGeneration(model, count = 1) {
    this.imageUsage[model] = (this.imageUsage[model] || 0) + count;
  }

  getSummary() {
    let totalCost = 0;
    const breakdown = {};

    // Text costs
    for (const [model, usage] of Object.entries(this.textUsage)) {
      const rate = RATES[model] || { input: 1.0, output: 3.0 };
      const inputCost = (usage.inputTokens / 1_000_000) * rate.input;
      const outputCost = (usage.outputTokens / 1_000_000) * rate.output;
      const cost = inputCost + outputCost;
      totalCost += cost;
      breakdown[model] = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cost: Math.round(cost * 10000) / 10000,
      };
    }

    // Image costs
    for (const [model, count] of Object.entries(this.imageUsage)) {
      const rate = RATES[model] || { perImage: 0.05 };
      const cost = count * rate.perImage;
      totalCost += cost;
      breakdown[model] = {
        imageCount: count,
        cost: Math.round(cost * 10000) / 10000,
      };
    }

    return {
      totalCost: Math.round(totalCost * 10000) / 10000,
      breakdown,
    };
  }

  reset() {
    this.textUsage = {};
    this.imageUsage = {};
  }

  // Re-hydrate from a previously saved summary (used to resume costs across retries)
  addFromSummary(summary) {
    if (!summary || !summary.breakdown) return;
    for (const [model, data] of Object.entries(summary.breakdown)) {
      if (data.inputTokens != null) {
        this.addTextUsage(model, data.inputTokens || 0, data.outputTokens || 0);
      }
      if (data.imageCount != null) {
        this.addImageGeneration(model, data.imageCount);
      }
    }
  }
}

module.exports = { CostTracker };
