/**
 * Image-generation client for the native V3 illustrator (A0 sheets,
 * A1 world plates, A2 spread renders).
 *
 * One clean seam over the Gemini image API:
 *   - multi-reference input (photo + sheet + cover + plate) — identity
 *     always flows from the same fixed reference set, never through a
 *     session or a previous spread (the design's no-drift rule)
 *   - key-pool rotation + transient retry with exponential backoff
 *   - model resolved per call site (SHEET_RENDERER_MODEL /
 *     SPREAD_RENDERER_MODEL upgrade seams in ../config)
 *   - MODEL FALLBACK: an invalid/unprovisioned model id (404 "not found
 *     for API version") falls back LOUDLY to FALLBACK_IMAGE_MODEL instead
 *     of bricking every render (2026-07-15: a wrong pro-tier id dead-ended
 *     books at the identity kit). Invalid ids are remembered for the
 *     process lifetime so later calls skip the dead model.
 *
 * Deliberately NOT the legacy session machinery (services/illustrator/*):
 * no chat sessions, no quad slicing, no stateful correction turns.
 */

const { getNextApiKey, fetchWithTimeout } = require('../../../illustrationGenerator');

const RENDER_TIMEOUT_MS = Number(process.env.BOOK_PIPELINE_V3_RENDER_TIMEOUT_MS || 180000);
const MAX_ATTEMPTS = 3;

/** Known-good model on the public Generative Language API for these keys. */
const FALLBACK_IMAGE_MODEL = process.env.BOOK_PIPELINE_V3_FALLBACK_IMAGE_MODEL || 'gemini-3.1-flash-image';

/** Model ids that 404'd this process — skip straight to the fallback. */
const invalidModels = new Set();

class RenderTransientError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RenderTransientError';
    this.isTransient = true;
  }
}

class ModelNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelNotFoundError';
  }
}

function isTransientBody(status, body) {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  return /Deadline expired|UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL/i.test(body || '');
}

function isModelNotFoundBody(status, body) {
  return status === 404
    || /is not found for API version/i.test(body || '')
    || /is not supported for generateContent/i.test(body || '');
}

/**
 * One model, full transient-retry loop.
 * @throws {ModelNotFoundError} when the model id itself is invalid
 */
async function generateWithModel({ model, parts, generationConfig, abortSignal, label }) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const apiKey = getNextApiKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
      const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }], generationConfig }),
        signal: abortSignal,
      }, RENDER_TIMEOUT_MS);

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        if (isModelNotFoundBody(resp.status, body)) {
          throw new ModelNotFoundError(`${label}: model '${model}' not available: HTTP ${resp.status} ${body.slice(0, 200)}`);
        }
        if (isTransientBody(resp.status, body)) throw new RenderTransientError(`${label}: HTTP ${resp.status} ${body.slice(0, 200)}`);
        throw new Error(`${label}: HTTP ${resp.status} ${body.slice(0, 300)}`);
      }

      const data = await resp.json();
      const imagePart = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData || p.inline_data);
      if (!imagePart) {
        // Model replied text-only (usually a safety refusal or a prompt
        // problem) — not transient; surface the text for diagnosis.
        const textOut = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join(' ') || 'no content';
        throw new Error(`${label}: no image in response — model said: ${textOut.slice(0, 300)}`);
      }
      const inline = imagePart.inlineData || imagePart.inline_data;
      return {
        buffer: Buffer.from(inline.data, 'base64'),
        mimeType: inline.mimeType || inline.mime_type || 'image/png',
        model,
      };
    } catch (err) {
      lastErr = err;
      if (err?.isTransient === true && attempt < MAX_ATTEMPTS) {
        const delay = 2000 * 2 ** (attempt - 1);
        console.warn(`[imageClient] ${label}: transient (attempt ${attempt}/${MAX_ATTEMPTS}), retry in ${delay}ms: ${err.message}`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Generate one image.
 *
 * @param {object} opts
 * @param {string} opts.model - image model id
 * @param {string} opts.prompt - full render prompt (style bible + scene + rules)
 * @param {Array<{base64: string, mimeType?: string, note?: string}>} opts.references
 *   Reference images in priority order; a `note` becomes a text part
 *   immediately before its image so the model knows what each reference is.
 * @param {string} [opts.aspectRatio] - imageConfig.aspectRatio (e.g. '16:9', '1:1')
 * @param {AbortSignal} [opts.abortSignal]
 * @param {string} [opts.label] - logging tag
 * @returns {Promise<{ buffer: Buffer, mimeType: string, model: string }>}
 *   `model` is the model ACTUALLY used (the fallback when the configured id was invalid).
 */
async function generateImage({ model, prompt, references = [], aspectRatio, abortSignal, label = 'v3.render' }) {
  if (!model) throw new Error('imageClient.generateImage: model is required');
  if (!prompt) throw new Error('imageClient.generateImage: prompt is required');

  const parts = [{ text: prompt }];
  for (const ref of references) {
    if (ref.note) parts.push({ text: ref.note });
    parts.push({ inline_data: { mimeType: ref.mimeType || 'image/jpeg', data: ref.base64 } });
  }

  const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
  if (aspectRatio) generationConfig.imageConfig = { aspectRatio };

  // Known-dead model id from earlier in this process: don't re-404, go
  // straight to the fallback (still logged so misconfiguration stays loud).
  let effectiveModel = model;
  if (invalidModels.has(model) && model !== FALLBACK_IMAGE_MODEL) {
    console.warn(`[imageClient] ${label}: model '${model}' known-invalid this process — using fallback '${FALLBACK_IMAGE_MODEL}'`);
    effectiveModel = FALLBACK_IMAGE_MODEL;
  }

  try {
    return await generateWithModel({ model: effectiveModel, parts, generationConfig, abortSignal, label });
  } catch (err) {
    if (err instanceof ModelNotFoundError && effectiveModel !== FALLBACK_IMAGE_MODEL) {
      invalidModels.add(effectiveModel);
      console.error(`[imageClient] ${label}: ${err.message} — FALLING BACK to '${FALLBACK_IMAGE_MODEL}'. Fix BOOK_PIPELINE_V3_SHEET/SPREAD_RENDERER_MODEL to a model from ListModels.`);
      return generateWithModel({ model: FALLBACK_IMAGE_MODEL, parts, generationConfig, abortSignal, label });
    }
    throw err;
  }
}

module.exports = { generateImage, RenderTransientError, ModelNotFoundError, FALLBACK_IMAGE_MODEL, RENDER_TIMEOUT_MS };
