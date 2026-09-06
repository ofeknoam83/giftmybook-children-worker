/**
 * Cost Tracker — tracks per-model costs for text and image generation
 */

const RATES = {
  // Text models (per 1M tokens)
  'gpt-5.4': { input: 2.50, output: 15.00 },
  'gpt-5.4-mini': { input: 0.15, output: 0.60 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-3-flash-preview': { input: 0.30, output: 2.50 },
  // DeepSeek (OpenAI-compatible API). Confirm rates against the published
  // DeepSeek pricing page before relying on these numbers for invoicing.
  'deepseek-v4-pro':   { input: 0.27, output: 1.10 },
  'deepseek-v4-flash': { input: 0.14, output: 0.28 },
  // Image models (per image)
  'replicate-faceid': { perImage: 0.05 },
  'replicate-flux': { perImage: 0.04 },
  'gemini-image': { perImage: 0.02 },
  'gemini-3.1-flash-image': { perImage: 0.02 },
  // Requested 4K output: 2,520 image tokens at $60/M (Google pricing,
  // 2026-09-06). Image-output estimate only; excludes input/thinking tokens.
  'gemini-3.1-flash-image:4K': { perImage: 0.1512 },
  'gemini-2.5-flash-image': { perImage: 0.02 },
  // The v3 illustrator's default renderer (sheet + spread renders). Placeholder
  // rate pending published pro-tier image pricing — confirm before invoicing
  // (previously this id fell through to the silent unknown-model default).
  'gemini-3-pro-image-preview': { perImage: 0.05 },
  // Video models (per generated second, audio OFF) — gift video (gv-1).
  // Third-party price summaries as of 2026-09; verify against the hosts'
  // pricing pages before invoicing (docs/GIFT_VIDEO_PLAN.md §8).
  'kwaivgi/kling-v3-video': { perSecond: 0.168 },
  'veo-3.1-fast-generate-preview': { perSecond: 0.15 },
  'veo-3.1-generate-preview': { perSecond: 0.40 },
};

// Unknown models bill at a plausible default, which silently hides a missing
// RATES entry (a new renderer id shows a plausible-but-wrong number). Warn
// once per model per process so the gap is visible in Cloud Logging.
const warnedUnknownModels = new Set();
function rateFor(model, fallback, kind) {
  const rate = RATES[model];
  if (rate) return rate;
  if (!warnedUnknownModels.has(model)) {
    warnedUnknownModels.add(model);
    console.warn(`[costTracker] no RATES entry for ${kind} model '${model}' — billing at the default (${JSON.stringify(fallback)}); add it to RATES for accurate cost reporting`);
  }
  return fallback;
}

class CostTracker {
  constructor() {
    this.textUsage = {};   // model → { inputTokens, outputTokens }
    this.imageUsage = {};  // model → count
    this.videoUsage = {};  // model → generated seconds
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

  /**
   * Record generated video seconds for a model (gift video, gv-1).
   * @param {string} model provider model id
   * @param {number} seconds seconds of video the vendor generated (billed)
   */
  addVideoSeconds(model, seconds) {
    const s = Number(seconds);
    if (!Number.isFinite(s) || s <= 0) return;
    this.videoUsage[model] = (this.videoUsage[model] || 0) + s;
  }

  getSummary() {
    let totalCost = 0;
    const breakdown = {};

    // Text costs
    for (const [model, usage] of Object.entries(this.textUsage)) {
      const rate = rateFor(model, { input: 1.0, output: 3.0 }, 'text');
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
      const rate = rateFor(model, { perImage: 0.05 }, 'image');
      const cost = count * rate.perImage;
      totalCost += cost;
      breakdown[model] = {
        imageCount: count,
        cost: Math.round(cost * 10000) / 10000,
      };
    }

    // Video costs (per generated second)
    for (const [model, seconds] of Object.entries(this.videoUsage)) {
      const rate = rateFor(model, { perSecond: 0.20 }, 'video');
      const cost = seconds * rate.perSecond;
      totalCost += cost;
      breakdown[model] = {
        videoSeconds: Math.round(seconds * 100) / 100,
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
    this.videoUsage = {};
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
      if (data.videoSeconds != null) {
        this.addVideoSeconds(model, data.videoSeconds);
      }
    }
  }
}

module.exports = { CostTracker };
