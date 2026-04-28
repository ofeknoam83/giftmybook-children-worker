/**
 * OpenAI Images 2.0 — single stateless render call.
 *
 * Posts ONE spread to `/v1/images/edits` (multipart) with:
 *   - the cover image as `image[0]` (canonical character + style ground truth)
 *   - the most recently accepted spread as `image[1]` (continuity anchor) when present
 *   - the slim rules block + per-spread prompt as `prompt`
 *   - `model: gpt-image-2`, `size: OPENAI_IMAGE_SIZE`, `quality: OPENAI_IMAGE_QUALITY`, `n: 1`
 *
 * Endpoint choice: `/v1/images/edits` is the only OpenAI image endpoint that
 * accepts multipart reference images for gpt-image-2; `/v1/images/generations`
 * is JSON-only and rejects `Content-Type: multipart/form-data` with a 400
 * `unsupported_content_type` error in production.
 *
 * Why only 2 references: gpt-image-2's attention dilutes when given 4+ refs;
 * cover dominance is what keeps the hero face stable. The most recent accepted
 * spread is enough for outfit / palette / lighting continuity.
 */

'use strict';

const { postImagesEdits } = require('../openaiImagesHttp');
const {
  OPENAI_IMAGE_MODEL,
  OPENAI_IMAGES_EDIT_URL,
  OPENAI_IMAGE_SIZE,
  OPENAI_IMAGE_SIZE_FALLBACK,
  OPENAI_IMAGE_QUALITY,
  OPENAI_TURN_TIMEOUT_MS,
} = require('../config');

/**
 * The shared `fetchWithTimeout` helper hardcodes a "Gemini image API timed
 * out" message because it lives in `services/illustrationGenerator.js`. Catch
 * that and rethrow with provider-correct wording so logs aren't misleading.
 */
function rebrandTimeout(err) {
  if (err && typeof err.message === 'string' && /Gemini image API timed out/i.test(err.message)) {
    const fixed = new Error(err.message.replace(/Gemini image API/i, 'OpenAI Images API'));
    fixed.cause = err;
    fixed.isTimeout = true;
    return fixed;
  }
  return err;
}

/**
 * @typedef {Object} RenderRefs
 * @property {string} coverBase64
 * @property {string} [coverMime]
 * @property {string} [previousSpreadBase64] - Most recently accepted spread (continuity).
 * @property {string} [previousSpreadMime]
 */

/**
 * @typedef {Object} RenderSpreadOpts
 * @property {string} apiKey - OPENAI_API_KEY
 * @property {string} promptText - Combined rules + per-spread prompt.
 * @property {RenderRefs} refs
 * @property {AbortSignal} [signal]
 * @property {number} [timeoutMs]
 * @property {number} [spreadIndex] - For logging only.
 */

/**
 * Stateless render — does not mutate any session, does not store history.
 * Returns the standard `{imageBuffer, imageBase64}` shape consumed by post-
 * process + QA, identical to Gemini's `generateSpread` so QA / upload code is
 * unchanged.
 *
 * Errors thrown:
 *   - `err.isSafetyBlock = true` — OpenAI moderation_blocked / policy_violation
 *   - `err.isEmptyResponse = true` — API returned 200 but no b64_json
 *   - generic Error otherwise (HTTP, timeout, network)
 *
 * @param {RenderSpreadOpts} opts
 * @returns {Promise<{ imageBuffer: Buffer, imageBase64: string }>}
 */
async function renderSpread(opts) {
  const { apiKey, promptText, refs, signal, timeoutMs, spreadIndex } = opts;
  if (!apiKey) throw new Error('renderSpread: OPENAI_API_KEY missing');
  if (!promptText) throw new Error('renderSpread: promptText is required');
  if (!refs?.coverBase64) throw new Error('renderSpread: refs.coverBase64 is required');

  const imageFiles = packReferenceImages(refs);
  const startMs = Date.now();
  const label = spreadIndex != null ? `spread ${spreadIndex + 1}` : 'spread';

  console.log(
    `[illustrator/openaiFlow/render] ${label} → POST /v1/images/edits ` +
    `(refs=${imageFiles.length}, size=${OPENAI_IMAGE_SIZE}, quality=${OPENAI_IMAGE_QUALITY})`,
  );

  const effectiveTimeout = timeoutMs || OPENAI_TURN_TIMEOUT_MS;
  let result;
  try {
    result = await postImagesEdits({
      apiKey,
      url: OPENAI_IMAGES_EDIT_URL,
      model: OPENAI_IMAGE_MODEL,
      prompt: promptText,
      size: OPENAI_IMAGE_SIZE,
      quality: OPENAI_IMAGE_QUALITY,
      imageFiles,
      timeoutMs: effectiveTimeout,
      signal,
    });
  } catch (err) {
    throw rebrandTimeout(err);
  }

  // Some accounts reject OPENAI_IMAGE_SIZE with `invalid_value` on `size`. Fall back
  // once to a known-good landscape size before surfacing the error.
  if (!result.ok && /size/i.test(result.text || '') && /invalid|unsupported/i.test(result.text || '')) {
    console.warn(
      `[illustrator/openaiFlow/render] ${label} size ${OPENAI_IMAGE_SIZE} rejected — retrying at ${OPENAI_IMAGE_SIZE_FALLBACK}`,
    );
    try {
      result = await postImagesEdits({
        apiKey,
        url: OPENAI_IMAGES_EDIT_URL,
        model: OPENAI_IMAGE_MODEL,
        prompt: promptText,
        size: OPENAI_IMAGE_SIZE_FALLBACK,
        quality: OPENAI_IMAGE_QUALITY,
        imageFiles,
        timeoutMs: effectiveTimeout,
        signal,
      });
    } catch (err) {
      throw rebrandTimeout(err);
    }
  }

  if (!result.ok) {
    const body = result.text || '';
    const err = new Error(`OpenAI Images API ${result.status}: ${body.slice(0, 400)}`);
    if (/moderation_blocked|safety|policy_violation|content_policy|content_filter/i.test(body)) {
      err.isSafetyBlock = true;
      err.isEmptyResponse = true;
      err.blockReason = 'moderation_blocked';
    }
    throw err;
  }

  const b64 = result.data?.data?.[0]?.b64_json;
  if (!b64) {
    const err = new Error('OpenAI Images API returned no b64_json payload');
    err.isEmptyResponse = true;
    throw err;
  }

  const elapsedMs = Date.now() - startMs;
  const imageBuffer = Buffer.from(b64, 'base64');
  console.log(
    `[illustrator/openaiFlow/render] ${label} ← ok ${imageBuffer.length} bytes (${elapsedMs}ms)`,
  );
  return { imageBuffer, imageBase64: b64 };
}

/**
 * Build the `image[]` payload. Cover always; previous spread when supplied.
 * Capped at 2 references on purpose — see file header.
 *
 * @param {RenderRefs} refs
 * @returns {Array<{buffer: Buffer, filename: string, mimeType: string}>}
 */
function packReferenceImages(refs) {
  const files = [];
  const coverMime = (refs.coverMime || 'image/jpeg').toLowerCase();
  files.push({
    buffer: Buffer.from(refs.coverBase64, 'base64'),
    filename: coverMime.includes('png') ? 'cover.png' : 'cover.jpg',
    mimeType: coverMime,
  });
  if (refs.previousSpreadBase64) {
    const prevMime = (refs.previousSpreadMime || 'image/png').toLowerCase();
    files.push({
      buffer: Buffer.from(refs.previousSpreadBase64, 'base64'),
      filename: prevMime.includes('png') ? 'prev-spread.png' : 'prev-spread.jpg',
      mimeType: prevMime,
    });
  }
  return files;
}

module.exports = {
  renderSpread,
};
