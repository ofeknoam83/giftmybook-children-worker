/**
 * Video model profiles (gift video, gv-1 — docs/GIFT_VIDEO_PLAN.md §4.4).
 *
 * A profile says, per model id, which host serves it, which clip lengths
 * and aspect ratios it accepts, how it names a reference element in the
 * prompt, and how the provider-neutral brief renders into its input
 * object. The exact input field names of a hosted model are a
 * verify-at-build fact (the vendors' docs were unreachable when this was
 * written), so `CATALOG_VIDEO_MODEL_INPUT_JSON` can add or override input
 * fields on the revision without a deploy, and `CATALOG_VIDEO_ELEMENTS=0`
 * drops the reference elements entirely.
 */

const { renderPromptForModel } = require('../brief');

/**
 * Pick the smallest supported clip length ≥ the requested seconds.
 * @param {number} requested
 * @param {number[]} supported ascending
 * @returns {number}
 */
function clipSecondsFor(requested, supported) {
  const hit = supported.find(s => s >= requested);
  return hit === undefined ? supported[supported.length - 1] : hit;
}

/** Whole seconds 3..15 (Kling 3.0 image-to-video). */
const KLING_DURATIONS = Array.from({ length: 13 }, (_, i) => i + 3);

const MODELS = {
  'kwaivgi/kling-v3-video': {
    provider: 'replicate',
    durations: KLING_DURATIONS,
    aspectRatios: ['16:9', '9:16', '1:1'],
    supportsReferences: true,
    referenceMention: (i) => `@Element${i}`,
    /**
     * Replicate input for one clip job.
     * @param {object} job {brief, startFrameUrl, referenceUrls: Array<{kind, url}>, seconds, aspect, seed}
     * @param {{elements: boolean}} opts
     * @returns {object}
     */
    input(job, opts) {
      const elements = opts.elements && job.referenceUrls.length > 0;
      const input = {
        prompt: renderPromptForModel(job.brief, elements ? this.referenceMention : null),
        negative_prompt: job.brief.negativePrompt,
        start_image: job.startFrameUrl,
        duration: job.seconds,
        aspect_ratio: job.aspect,
        cfg_scale: job.brief.params.cfgScale,
        generate_audio: false,
      };
      if (elements) {
        input.elements = job.referenceUrls.map((r, i) => ({
          name: `Element${i + 1}`,
          images: Array.isArray(r.urls) ? r.urls : [r.url],
        }));
      }
      if (Number.isInteger(job.seed)) input.seed = job.seed;
      return input;
    },
  },
};

/**
 * Resolve a model profile, applying the env input overrides.
 * @param {string} modelId
 * @returns {object|null}
 */
function modelProfile(modelId) {
  const base = MODELS[modelId];
  if (!base) return null;
  return {
    id: modelId,
    ...base,
    input(job, opts) {
      const built = base.input.call(base, job, opts);
      let override = null;
      const raw = process.env.CATALOG_VIDEO_MODEL_INPUT_JSON;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) override = parsed;
        } catch { override = null; }
      }
      if (!override) return built;
      // Override values are plain data: an own-property merge (never prototype
      // keys), and `null` removes a field the model turns out not to accept.
      const out = { ...built };
      for (const [k, v] of Object.entries(override)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        if (v === null) delete out[k];
        else out[k] = v;
      }
      return out;
    },
  };
}

module.exports = { MODELS, modelProfile, clipSecondsFor, KLING_DURATIONS };
