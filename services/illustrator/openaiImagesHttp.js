/**
 * OpenAI Images API — raw REST (multipart) for `/v1/images/edits`
 *
 * We intentionally do **not** use the official `openai` npm client for these
 * routes. The SDK lags the API: it can reject newer `model` values (e.g.
 * gpt-image-2) and form fields with client-side validation. This module
 * posts exactly what the HTTP API accepts — validated only by the server.
 */

'use strict';

const { fetchWithTimeout } = require('../illustrationGenerator');
const { OPENAI_IMAGES_EDIT_URL: DEFAULT_IMAGES_EDITS_URL } = require('./config');

/**
 * POST https://api.openai.com/v1/images/edits
 *
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} p.model
 * @param {string} p.prompt
 * @param {string} [p.size] - e.g. 1792x1008, 1024x1024
 * @param {Array<{ buffer: Buffer, filename: string, mimeType?: string }>} p.imageFiles
 * @param {string} [p.url] - override endpoint (default from illustrator config)
 * @param {number} [p.timeoutMs]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<
 *   { ok: true, status: number, data: object } |
 *   { ok: false, status: number, text: string }
 * >}
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
  // `images/edits` does not take `quality` (only `images/generations` does).
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
  postImagesEdits,
  DEFAULT_IMAGES_EDITS_URL,
};
