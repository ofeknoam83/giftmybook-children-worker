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
  // Requested 2K output (cb-1 coloring pages default): ~1,120 image tokens
  // at $60/M — verify against Google's published 2K token count before
  // invoicing (the 4K entry above is the measured reference).
  'gemini-3.1-flash-image:2K': { perImage: 0.0672 },
  'gemini-2.5-flash-image': { perImage: 0.02 },
  // The v3 illustrator's default renderer (sheet + spread renders). Placeholder
  // rate pending published pro-tier image pricing — confirm before invoicing
  // (previously this id fell through to the silent unknown-model default).
  'gemini-3-pro-image-preview': { perImage: 0.05 },
  // Video models (per generated second, audio OFF) — gift video (gv-1).
  // Third-party price summaries as of 2026-09; verify against the hosts'
  // pricing pages before invoicing (docs/GIFT_VIDEO_PLAN.md §8).
  'kwaivgi/kling-v3-video': { perSecond: 0.168 },
  // Kling 3.0 Omni (the full-story film's model): the bare id is the `pro`
  // 1080p tier the trailer always bought; `:std` is the 720p tier the film
  // buys by default since gfs-2 (CATALOG_FILM_VIDEO_QUALITY) — Kling has
  // priced std at roughly half of pro on every generation; verify the exact
  // per-second rate on the host's pricing page before invoicing.
  'kwaivgi/kling-v3-omni-video': { perSecond: 0.168 },
  'kwaivgi/kling-v3-omni-video:std': { perSecond: 0.084 },
  'kwaivgi/kling-v3-video:std': { perSecond: 0.084 },
  // Sync Lipsync 2 (dialogue shots only): per second of input video, as
  // summarized 2026-09 — verify against the host's pricing page.
  'sync/lipsync-2': { perSecond: 0.0685 },
  'veo-3.1-fast-generate-preview': { perSecond: 0.15 },
  'veo-3.1-generate-preview': { perSecond: 0.40 },
  // Audiobook (ab-1, docs/AUDIOBOOK_V2_PLAN.md §7) — narration per 1,000
  // characters, generated music / sound effects per second. Vendor pages
  // as summarized 2026-09-07; verify against the account's plan before
  // invoicing (ElevenLabs bills per plan tier, $0.10-0.18 per 1k chars).
  'elevenlabs:eleven_v3': { perThousandChars: 0.18 },
  'elevenlabs:eleven_multilingual_v2': { perThousandChars: 0.18 },
  'gemini:gemini-2.5-pro-preview-tts': { perThousandChars: 0.08 },
  'gemini:gemini-2.5-flash-preview-tts': { perThousandChars: 0.04 },
  'openai:gpt-4o-mini-tts': { perThousandChars: 0.015 },
  'elevenlabs:music_v1': { perSecond: 0.0025 },
  'elevenlabs:sound_effects': { perSecond: 0.002 },
  'lyria:lyria-002': { perSecond: 0.002 },
  'lyria:lyria-3': { perSecond: 0.0027 },
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

/**
 * A vendor estimate BEFORE a purchase (the film reports what a run will buy
 * before buying it) — the same table getSummary() bills from.
 * @param {string} model a RATES key (`model` or `model:tier`)
 * @param {number} seconds generated seconds
 * @returns {number} USD, rounded to cents
 */
function estimateVideoCost(model, seconds) {
  const rate = rateFor(model, { perSecond: 0.20 }, 'video');
  const s = Number(seconds);
  return Math.round((Number.isFinite(s) && s > 0 ? s : 0) * rate.perSecond * 100) / 100;
}

class CostTracker {
  constructor() {
    this.textUsage = {};   // model → { inputTokens, outputTokens }
    this.imageUsage = {};  // model → count
    this.videoUsage = {};  // model → generated seconds
    this.audioChars = {};  // provider:model → synthesized characters (audiobook, ab-1)
    this.audioSeconds = {}; // provider:model → generated seconds of music / effects
    this.operations = {};
    this.reused = {};
  }
  recordOperation(kind, model) { const key = `${kind}:${model}`; this.operations[key] = (this.operations[key] || 0) + 1; }
  recordReuse(kind) { this.reused[kind] = (this.reused[kind] || 0) + 1; }

  /**
   * Record synthesized narration characters for a provider:model (ab-1).
   * @param {string} model `provider:model`
   * @param {number} characters
   */
  addAudioCharacters(model, characters) {
    const n = Number(characters);
    if (!Number.isFinite(n) || n <= 0) return;
    this.audioChars[model] = (this.audioChars[model] || 0) + n;
  }

  /**
   * Record generated seconds of music or sound effects (ab-1).
   * @param {string} model `provider:model`
   * @param {number} seconds
   */
  addAudioSeconds(model, seconds) {
    const s = Number(seconds);
    if (!Number.isFinite(s) || s <= 0) return;
    this.audioSeconds[model] = (this.audioSeconds[model] || 0) + s;
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

    // Audiobook narration (per 1,000 characters) and generated audio (per second)
    for (const [model, chars] of Object.entries(this.audioChars)) {
      const rate = rateFor(model, { perThousandChars: 0.15 }, 'audio');
      const cost = (chars / 1000) * (rate.perThousandChars || 0.15);
      totalCost += cost;
      breakdown[model] = { audioCharacters: chars, cost: Math.round(cost * 10000) / 10000 };
    }
    for (const [model, seconds] of Object.entries(this.audioSeconds)) {
      const rate = rateFor(model, { perSecond: 0.0025 }, 'audio');
      const cost = seconds * (rate.perSecond || 0.0025);
      totalCost += cost;
      breakdown[model] = { audioSeconds: Math.round(seconds * 100) / 100, cost: Math.round(cost * 10000) / 10000 };
    }

    return {
      totalCost: Math.round(totalCost * 10000) / 10000,
      operations: { ...this.operations }, reused: { ...this.reused },
      breakdown,
    };
  }

  reset() {
    this.operations = {};
    this.reused = {};
    this.textUsage = {};
    this.imageUsage = {};
    this.videoUsage = {};
    this.audioChars = {};
    this.audioSeconds = {};
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
      if (data.audioCharacters != null) {
        this.addAudioCharacters(model, data.audioCharacters);
      }
      if (data.audioSeconds != null) {
        this.addAudioSeconds(model, data.audioSeconds);
      }
    }
  }
}

module.exports = { CostTracker, estimateVideoCost, RATES };
