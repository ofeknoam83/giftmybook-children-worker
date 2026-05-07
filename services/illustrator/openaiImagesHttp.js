/**
 * OpenAI Images API — raw REST.
 *
 * **gpt-image-2 + `/v1/images/generations`:** JSON body required. The endpoint
 * does NOT accept reference images on this route — `image[]` multipart parts
 * (and any equivalent JSON `image` field) are rejected. Reference-conditioned
 * generation requires either:
 *   - `/v1/images/edits` with multipart `image[]` (typically `dall-e-2` /
 *     `gpt-image-1`; gpt-image-2 was reported 400 on this endpoint), or
 *   - the Responses API `/v1/responses` with `input_image` content parts.
 *
 * The current adapter therefore runs gpt-image-2 in text-to-image mode on
 * `/v1/images/generations` (JSON). When `imageFiles` are supplied to this
 * helper, they are DROPPED with a clear warning — character consistency is
 * carried by the system instruction + per-spread CHARACTER ANCHOR text alone,
 * which is degraded vs. the Gemini chat-session path. Wiring reference images
 * back in is follow-up work (Responses API migration).
 */

'use strict';

const { fetchWithTimeout } = require('../illustrationGenerator');
const {
  OPENAI_IMAGES_EDIT_URL: DEFAULT_IMAGES_EDITS_URL,
  OPENAI_IMAGES_GENERATIONS_URL: DEFAULT_IMAGES_GENERATIONS_URL,
} = require('./config');

/**
 * POST /v1/images/generations as JSON.
 *
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} p.model
 * @param {string} p.prompt
 * @param {string} [p.size]
 * @param {Array<{ buffer: Buffer, filename: string, mimeType?: string }>} [p.imageFiles] - DROPPED with warning; this endpoint is text-to-image only.
 * @param {string} [p.url]
 * @param {string} [p.quality] - for GPT image models on generations only (`low` | `medium` | `high` | `auto`)
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
      + 'Character consistency is carried by the prompt text alone for this call. '
      + 'See module docs for the Responses-API follow-up to restore image references.',
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
 * POST /v1/images/edits (multipart). Currently unused by the production
 * pipeline (gpt-image-2 returned 400 on this endpoint), but kept for any
 * future fallback or for non-gpt-image-2 callers.
 *
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} p.model
 * @param {string} p.prompt
 * @param {string} [p.size]
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

  const fd = new FormData();
  fd.append('model', model);
  fd.append('prompt', prompt);
  if (size) fd.append('size', size);
  fd.append('n', '1');

  for (const f of imageFiles) {
    const mime = f.mimeType || 'image/jpeg';
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
