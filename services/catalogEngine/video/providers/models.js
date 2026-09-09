/**
 * Video model profiles (gift video, gv-2 — docs/GIFT_VIDEO_PLAN.md §4.4).
 *
 * A profile says, per model id, which host serves it, which clip lengths
 * and aspect ratios it accepts, whether it takes an END frame beside the
 * start frame (gv-2's single take opens on the first picked still and
 * lands on the last), how it names a reference element in the prompt, and
 * how the provider-neutral brief renders into its input object. The exact
 * input field names of a hosted model are a verify-at-build fact (the
 * vendors' docs were unreachable when this was written), so
 * `CATALOG_VIDEO_MODEL_INPUT_JSON` can add or override input fields on the
 * revision without a deploy, `CATALOG_VIDEO_ELEMENTS=0` drops the reference
 * elements entirely, and `CATALOG_VIDEO_END_FRAME=0` drops the end frame
 * (generate.js also retries a 422 once without it).
 *
 * A profile's `imageLimit` is the vendor's cap on PICTURES per request —
 * the start frame, the end frame and every reference image or element
 * COUNT TOGETHER. Kling's is seven (error 1201 on 2026-09-08, "The number
 * of images and elements exceeds the limit, max number is 7", on a
 * full-story shot that sent one start frame + seven reference sheets;
 * before that the Omni guard capped the reference list alone at seven).
 * `imageBudget` is what the callers select against; the `input()` guards
 * are the last line and should never fire.
 */

const { renderPromptForModel } = require('../brief');
const flags = require('../../flags');

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

/** Kling 3.0: start frame + end frame + reference images/elements ≤ 7 (vendor error 1201). */
const KLING_IMAGE_LIMIT = 7;

/**
 * The pictures one request may carry in total: `CATALOG_VIDEO_MAX_IMAGES`
 * overrides the profile's own limit (a verify-at-deploy fact); a profile
 * that declares none is unbounded.
 * @param {{imageLimit?: number}|null} profile
 * @returns {number}
 */
function imageLimitFor(profile) {
  const override = flags.videoMaxImages();
  if (override > 0) return override;
  return profile && Number.isFinite(profile.imageLimit) ? profile.imageLimit : Infinity;
}

/**
 * How many reference images/elements one clip request may attach beside
 * its frames — the callers select their reference pack against this.
 * @param {{imageLimit?: number}|null} profile
 * @param {{startFrame?: boolean, endFrame?: boolean}} [frames]
 * @returns {{limit: number, frames: number, references: number}}
 */
function imageBudget(profile, { startFrame = true, endFrame = false } = {}) {
  const limit = imageLimitFor(profile);
  const frames = (startFrame ? 1 : 0) + (endFrame ? 1 : 0);
  return { limit, frames, references: Number.isFinite(limit) ? Math.max(0, limit - frames) : Infinity };
}

/**
 * The last-line guard on one built input: frames + references within the limit.
 * @param {{imageLimit?: number}} profile
 * @param {number} frames start + end
 * @param {number} references reference images or elements
 * @param {string} noun
 */
function assertImageCount(profile, frames, references, noun) {
  const limit = imageLimitFor(profile);
  if (frames + references <= limit) return;
  const e = new Error(`the model accepts at most ${limit} images per request (start frame, end frame and ${noun} together); this request carries ${frames + references}`);
  e.failureCode = 'video_provider_input_rejected';
  throw e;
}

const MODELS = {
  'kwaivgi/kling-v3-omni-video': {
    provider: 'replicate',
    durations: KLING_DURATIONS,
    aspectRatios: ['16:9', '9:16', '1:1'],
    supportsReferences: true,
    supportsEndFrame: true,
    imageLimit: KLING_IMAGE_LIMIT,
    referenceMention: i => `<<<image_${i}>>>`,
    /**
     * Official Replicate Omni schema, verified 2026-09-07. One sheet per
     * reference. `mode` is the Kling tier — `pro` (1080p) unless the job
     * names `quality: 'std'` (720p, about half the per-second price; the
     * full-story film's default since gfs-2).
     */
    input(job) {
      const images = job.referenceUrls.map(r => (r.urls || [r.url])[0]);
      assertImageCount(this, 1 + (job.endFrameUrl ? 1 : 0), images.length, 'reference images');
      const prompt = renderPromptForModel(job.brief, this.referenceMention);
      if (prompt.length > 2500) throw new Error('Kling Omni prompt exceeds 2500 characters');
      return { prompt, start_image: job.startFrameUrl, ...(job.endFrameUrl ? { end_image: job.endFrameUrl } : {}),
        reference_images: images, duration: job.seconds, aspect_ratio: job.aspect, mode: job.quality === 'std' ? 'std' : 'pro', generate_audio: false };
    },
  },
  'kwaivgi/kling-v3-video': {
    provider: 'replicate',
    durations: KLING_DURATIONS,
    aspectRatios: ['16:9', '9:16', '1:1'],
    supportsReferences: true,
    /** Kling's first+last-frame mode (`end_image` on Replicate's Kling models — verify). */
    supportsEndFrame: true,
    /** Each element counts once beside the frames (the Omni rule; per-image counting is unverified — `CATALOG_VIDEO_MAX_IMAGES` adjusts). */
    imageLimit: KLING_IMAGE_LIMIT,
    referenceMention: (i) => `@Element${i}`,
    /**
     * Replicate input for one clip job.
     * @param {object} job {brief, startFrameUrl, endFrameUrl?, referenceUrls: Array<{kind, url}>, seconds, aspect, seed}
     * @param {{elements: boolean}} opts
     * @returns {object}
     */
    input(job, opts) {
      const elements = opts.elements && job.referenceUrls.length > 0;
      const input = {
        prompt: renderPromptForModel(job.brief, elements ? this.referenceMention : null),
        negative_prompt: job.brief.negativePrompt,
        start_image: job.startFrameUrl,
        ...(job.endFrameUrl ? { end_image: job.endFrameUrl } : {}),
        duration: job.seconds,
        aspect_ratio: job.aspect,
        cfg_scale: job.brief.params.cfgScale,
        generate_audio: false,
      };
      if (elements) {
        assertImageCount(this, 1 + (job.endFrameUrl ? 1 : 0), job.referenceUrls.length, 'reference elements');
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
 * The cost-table key of a purchase: the bare model id is its default (pro)
 * tier; a cheaper tier is billed under `model:tier` (costTracker RATES).
 * @param {string} model
 * @param {string|null} [quality]
 * @returns {string}
 */
function costModelFor(model, quality) {
  return quality && quality !== 'pro' ? `${model}:${quality}` : model;
}

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

module.exports = { MODELS, modelProfile, clipSecondsFor, costModelFor, imageBudget, imageLimitFor, KLING_DURATIONS, KLING_IMAGE_LIMIT };
