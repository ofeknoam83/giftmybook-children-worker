/**
 * OpenAI Images API — raw REST (multipart), no `openai` SDK.
 *
 * **gpt-image-2 + reference images:** Use `POST /v1/images/generations` with
 * `model`, `prompt`, `size`, `image[]`, and optional `quality`. The same model
 * on `POST /v1/images/edits` often returns `400` (`model` must be `dall-e-2`)
 * in production even though docs show curl examples with gpt-image-2 on edits.
 *
 * SDKs can also reject unknown `model` values client-side; this module does not.
 */

'use strict';

const { fetchWithTimeout } = require('../illustrationGenerator');
const {
  OPENAI_IMAGES_EDIT_URL: DEFAULT_IMAGES_EDITS_URL,
  OPENAI_IMAGES_GENERATIONS_URL: DEFAULT_IMAGES_GENERATIONS_URL,
} = require('./config');

/**
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} p.model
 * @param {string} p.prompt
 * @param {string} [p.size]
 * @param {Array<{ buffer: Buffer, filename: string, mimeType?: string }>} p.imageFiles
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

  if (typeof FormData === 'undefined' || typeof Blob === 'undefined') {
    throw new Error('Node >= 20 required for FormData / Blob (OpenAI images HTTP)');
  }

  const fd = new FormData();
  fd.append('model', model);
  fd.append('prompt', prompt);
  if (size) fd.append('size', size);
  if (quality) fd.append('quality', quality);
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

/**
 * POST /v1/images/edits (typically `dall-e-2` only for `model` in production).
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
