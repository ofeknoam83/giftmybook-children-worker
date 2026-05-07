/**
 * OpenAI Images API — raw REST.
 *
 * **gpt-image-2 + reference-image conditioning** runs on
 * `POST /v1/images/edits` (multipart). `image[]` form parts (1–16) carry the
 * reference set; each part needs a filename + Content-Type or the API
 * rejects with `unsupported_content_type` (see openai-node#1844).
 *
 * `POST /v1/images/generations` is text-to-image only — JSON body, no
 * reference-image input field on this endpoint for any image model.
 */

'use strict';

const { fetchWithTimeout } = require('../illustrationGenerator');
const {
  OPENAI_IMAGES_EDIT_URL: DEFAULT_IMAGES_EDITS_URL,
  OPENAI_IMAGES_GENERATIONS_URL: DEFAULT_IMAGES_GENERATIONS_URL,
} = require('./config');

/**
 * POST /v1/images/generations as JSON. Text-to-image only.
 *
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} p.model
 * @param {string} p.prompt
 * @param {string} [p.size]
 * @param {Array<{ buffer: Buffer, filename: string, mimeType?: string }>} [p.imageFiles] - DROPPED with warning; this endpoint is text-to-image only.
 * @param {string} [p.url]
 * @param {string} [p.quality] - low | medium | high | auto (gpt-image-2)
 * @param {number} [p.timeoutMs]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<
 *   { ok: true, status: number, data: object } |
 *   { ok: false, status: number, text: string }
 * >}
 */
async function postImagesGenerations(p) {
  const {
    apiKey,
    model,
    prompt,
    size,
    imageFiles,
    quality,
    url = DEFAULT_IMAGES_GENERATIONS_URL,
    timeoutMs = 180000,
    signal,
  } = p;

  if (Array.isArray(imageFiles) && imageFiles.length > 0) {
    console.warn(
      `[openaiImagesHttp] Dropping ${imageFiles.length} reference image(s) — `
      + '/v1/images/generations is JSON-only and does not accept reference images. '
      + 'Use postImagesEdits for reference-conditioned generation.',
    );
  }

  const body = {
    model,
    prompt,
    n: 1,
  };
  if (size) body.size = size;
  if (quality) body.quality = quality;

  const resp = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
    signal,
  );

  const text = await resp.text();
  if (!resp.ok) {
    return { ok: false, status: resp.status, text };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, status: resp.status, text };
  }
  return { ok: true, status: resp.status, data };
}

/**
 * POST /v1/images/edits — multipart, reference-image-conditioned generation.
 *
 * For `gpt-image-2` this is the documented path that preserves character
 * identity across calls. References travel as `image[]` form parts (1-16),
 * each with a filename and a Content-Type header so the server doesn't
 * reject the multipart body with `unsupported_content_type`. The first
 * `image[]` is the canonical reference; additional images supply continuity
 * (recently approved spreads). The model treats them all as conditioning,
 * not as content to edit literally — there is no `mask` here.
 *
 * NOTE: the `quality` form field is NOT accepted on this endpoint (the API
 * returns 400 `unknown_parameter` for it on /v1/images/edits, even though
 * /v1/images/generations accepts it). Caller may pass `quality` for
 * symmetry; this helper silently drops it.
 *
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} p.model
 * @param {string} p.prompt
 * @param {string} [p.size]
 * @param {string} [p.quality] - DROPPED on this endpoint (see note above).
 * @param {Array<{ buffer: Buffer, filename: string, mimeType?: string }>} p.imageFiles
 * @param {string} [p.url]
 * @param {number} [p.timeoutMs]
 * @param {AbortSignal} [p.signal]
 */
async function postImagesEdits(p) {
  const {
    apiKey,
    model,
    prompt,
    size,
    imageFiles,
    url = DEFAULT_IMAGES_EDITS_URL,
    timeoutMs = 180000,
    signal,
  } = p;

  if (typeof FormData === 'undefined' || typeof Blob === 'undefined') {
    throw new Error('Node >= 20 required for FormData / Blob (OpenAI images HTTP)');
  }

  if (!Array.isArray(imageFiles) || imageFiles.length === 0) {
    throw new Error('postImagesEdits: at least one reference image is required');
  }
  if (imageFiles.length > 16) {
    throw new Error(`postImagesEdits: too many references (${imageFiles.length}); OpenAI limit is 16`);
  }

  const fd = new FormData();
  fd.append('model', model);
  fd.append('prompt', prompt);
  if (size) fd.append('size', size);
  fd.append('n', '1');

  for (const f of imageFiles) {
    const mime = f.mimeType || 'image/jpeg';
    if (!f.filename || typeof f.filename !== 'string' || !f.filename.trim()) {
      throw new Error('postImagesEdits: every reference image must have a non-empty filename (OpenAI rejects multipart parts without filename)');
    }
    fd.append('image[]', new Blob([f.buffer], { type: mime }), f.filename);
  }

  const resp = await fetchWithTimeout(
    url,
    { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: fd },
    timeoutMs,
    signal,
  );

  const text = await resp.text();
  if (!resp.ok) {
    return { ok: false, status: resp.status, text };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, status: resp.status, text };
  }
  return { ok: true, status: resp.status, data };
}

module.exports = {
  postImagesGenerations,
  postImagesEdits,
  DEFAULT_IMAGES_GENERATIONS_URL,
  DEFAULT_IMAGES_EDITS_URL,
};
