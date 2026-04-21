/**
 * gameSpriteCore — single-sprite Gemini pipeline.
 *
 * A thin reusable wrapper used by the hero-prop, NPC, and item-library
 * generators. Given a prompt and optional style refs it asks Gemini to
 * emit one painterly sprite on flat white, then chromakeys + alpha-trims
 * the result and returns a transparent PNG buffer plus its width/height.
 */

const sharp = require('sharp');
const { GEMINI_IMAGE_MODEL, CHAT_API_BASE } = require('./illustrator/config');
const { fetchWithTimeout, downloadPhotoAsBase64 } = require('./illustrationGenerator');

function pickApiKey() {
  const keys = [];
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  if (keys.length === 0) {
    const single = process.env.GOOGLE_AI_STUDIO_KEY || process.env.GEMINI_API_KEY || '';
    if (single) keys.push(single);
  }
  if (keys.length === 0) throw new Error('No Gemini API key available');
  return keys[Math.floor(Math.random() * keys.length)];
}

async function loadRefs(urls) {
  const refs = [];
  for (const entry of urls || []) {
    if (!entry?.url) continue;
    try {
      const r = await downloadPhotoAsBase64(entry.url);
      refs.push({
        label: entry.label || 'STYLE REFERENCE:',
        base64: r.base64,
        mime: r.mimeType || 'image/png',
      });
    } catch (_) { /* ignore individual ref failures */ }
  }
  return refs;
}

async function callGemini({ apiKey, prompt, refs, aspectRatio = '1:1' }) {
  const url = `${CHAT_API_BASE}/${GEMINI_IMAGE_MODEL}:generateContent?key=${apiKey}`;
  const parts = [];
  for (const ref of refs) {
    parts.push({ text: ref.label });
    parts.push({ inline_data: { mimeType: ref.mime, data: ref.base64 } });
  }
  parts.push({ text: prompt });

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio },
      },
    }),
  }, 90000);

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Gemini ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  const parts2 = data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts2.find((p) => p.inlineData || p.inline_data);
  const b64 = imgPart?.inlineData?.data || imgPart?.inline_data?.data;
  if (!b64) throw new Error('No image in response');
  return Buffer.from(b64, 'base64');
}

// Luminance chromakey — identical tuning to gameCharacter.js.
async function softChromakeyWhiteToTransparent(inputBuffer) {
  const img = sharp(inputBuffer).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (channels < 3) return inputBuffer;

  const pxCount = width * height;
  const out = Buffer.alloc(pxCount * 4);
  const LOW = 220, HIGH = 246;
  const CHANNEL_SPREAD = 18;
  for (let i = 0; i < pxCount; i++) {
    const s = i * channels;
    const d = i * 4;
    const r = data[s], g = data[s + 1], b = data[s + 2];
    const minC = Math.min(r, g, b);
    const spread = Math.max(r, g, b) - minC;
    let alpha;
    const whitish = minC >= LOW && spread <= CHANNEL_SPREAD;
    if (!whitish) alpha = 255;
    else if (minC >= HIGH) alpha = 0;
    else alpha = Math.round(255 * (HIGH - minC) / (HIGH - LOW));
    out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = alpha;
  }
  return sharp(out, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function trimToAlpha(inputBuffer, pad = 10) {
  try {
    const { data, info } = await sharp(inputBuffer).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    const THRESH = 24;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * channels + 3] > THRESH) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return inputBuffer;
    const left = Math.max(0, minX - pad);
    const top = Math.max(0, minY - pad);
    const right = Math.min(width - 1, maxX + pad);
    const bottom = Math.min(height - 1, maxY + pad);
    return sharp(inputBuffer)
      .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
      .png({ compressionLevel: 9 }).toBuffer();
  } catch (_) {
    return inputBuffer;
  }
}

/**
 * Produce one transparent sprite PNG and return `{ buffer, width, height }`.
 *
 * @param {{ prompt: string, refs?: Array<{url:string,label?:string}>, aspectRatio?: string }} opts
 */
async function generateSpritePng(opts) {
  const { prompt, refs: refDescriptors = [], aspectRatio = '1:1' } = opts || {};
  if (!prompt) throw new Error('prompt required');
  const apiKey = pickApiKey();
  const refs = await loadRefs(refDescriptors);
  const rawBuf = await callGemini({ apiKey, prompt, refs, aspectRatio });
  const keyed = await softChromakeyWhiteToTransparent(rawBuf);
  const trimmed = await trimToAlpha(keyed, 10);
  const meta = await sharp(trimmed).metadata();
  return {
    buffer: trimmed,
    width: meta.width || null,
    height: meta.height || null,
  };
}

module.exports = {
  generateSpritePng,
  pickApiKey,
  softChromakeyWhiteToTransparent,
  trimToAlpha,
};
