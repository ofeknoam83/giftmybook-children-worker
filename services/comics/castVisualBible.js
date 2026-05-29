/**
 * Comics — Cast Visual Bible (Phase 2, admin-only).
 *
 * Turns a cropped face reference (`faceCropUrl`) into a locked ADULT
 * comic-style character reference sheet plus a JSON `visualLocks` block of
 * stable traits that every later panel will reference.
 *
 * Pipeline:
 *   1. Idempotent GCS cache, keyed by sha256(faceCropUrl + artStyle + VERSION).
 *   2. Likeness description via `gemini-2.5-flash` vision on the faceCrop
 *      image → strict JSON visualLocks (face, hair, skinTone, facialHair,
 *      glasses, build, distinguishingFeatures, suggestedOutfit, signatureColor).
 *   3. ADULT comic / graphic-novel reference sheet via IMG2IMG on
 *      `gemini-3.1-flash-image-preview` (front + 3/4 + face close-up,
 *      fully clothed PG-13, cel-shaded line art — NOT photoreal, NOT a
 *      children's storybook style). Preserves likeness from the faceCrop.
 *   4. Upload PNG → `comics/<comicId>/refsheets/<characterId>.png`.
 *   5. saveJson cache → `comics/<comicId>/refsheets/<characterId>.json`.
 *
 * DO NOT reuse `faceEngine.generateCharacterReference` — its prompts are
 * hardcoded child-safe/pixar.
 */

const crypto = require('crypto');

const {
  uploadBuffer,
  downloadBuffer,
  saveJson,
  loadJson,
} = require('../gcsStorage');
const { withRetry } = require('../retry');
const {
  GEMINI_IMAGE_MODEL,
  CHAT_API_BASE,
} = require('../illustrator/config');

const VISION_MODEL = 'gemini-2.5-flash';
const CACHE_VERSION = 'v1';
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const IMAGE_TIMEOUT_MS = 120000;
const VISION_TIMEOUT_MS = 30000;
function normalizeCacheUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_) {
    return url.split('#')[0].split('?')[0];
  }
}

/**
 * Fetch with an AbortController-backed timeout.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download the faceCrop and return base64 + mimeType.
 *
 * @param {string} url
 * @returns {Promise<{ base64: string, mimeType: string }>}
 */
async function downloadFaceCrop(url) {
  const buf = await downloadBuffer(url);
  // GCS download path doesn't expose content-type — assume JPEG (cropFace.js
  // always writes JPEG) but allow PNG-style URLs to pass through.
  const mimeType = /\.png(\?|$)/i.test(url) ? 'image/png' : 'image/jpeg';
  return { base64: buf.toString('base64'), mimeType };
}

/**
 * Compute the cache key for a (faceCropUrl, artStyle, version) triple.
 *
 * @param {string} faceCropUrl
 * @param {string} artStyle
 * @returns {string}
 */
function computeCacheKey(faceCropUrl, artStyle) {
  const stableFaceCropUrl = normalizeCacheUrl(faceCropUrl);
  return crypto
    .createHash('sha256')
    .update(`${stableFaceCropUrl}::${artStyle || ''}::${CACHE_VERSION}`)
    .digest('hex');
}

/**
 * Build the visualLocks vision prompt. Asks for strict JSON, PG-13, factual
 * and respectful. Provided signatureColor/signatureProp are passed through.
 *
 * @param {{ name?: string, role?: string, definingTrait?: string,
 *           signatureColor?: string, signatureProp?: string }} ctx
 * @returns {string}
 */
function buildVisualLocksPrompt(ctx = {}) {
  const ctxLines = [];
  if (ctx.name) ctxLines.push(`Name (for context only — do not invent traits from it): ${ctx.name}`);
  if (ctx.role) ctxLines.push(`Role in the story: ${ctx.role}`);
  if (ctx.definingTrait) ctxLines.push(`Defining trait: ${ctx.definingTrait}`);
  if (ctx.signatureColor) ctxLines.push(`Signature color (must appear in suggestedOutfit and be returned as signatureColor): ${ctx.signatureColor}`);
  if (ctx.signatureProp) ctxLines.push(`Signature prop (may be referenced in distinguishingFeatures or suggestedOutfit): ${ctx.signatureProp}`);
  const ctxBlock = ctxLines.length > 0 ? `\n\nContext:\n${ctxLines.join('\n')}` : '';

  return `You are helping lock the visual identity of an ADULT character for a personalized graphic-novel-style comic. The attached image is a cropped reference photo of the real person this character is based on. Your job is to extract stable visual traits that an illustrator will reference on EVERY later panel so the rendered character is consistently recognizable as this person.

Return STRICT JSON only, no markdown, no commentary, exactly this shape:
{
  "face": "<concise face description: shape, prominent features, age range as a decade bracket only e.g. '30s'>",
  "hair": "<color, texture, length, style, parting, hairline — exact enough to redraw>",
  "skinTone": "<precise artistic descriptor: depth + warmth/coolness + undertones (e.g. 'warm medium-light with peachy undertones', 'deep brown with neutral undertones')>",
  "facialHair": "<exact description, or 'none'>",
  "glasses": "<frame style + color, or 'none'>",
  "build": "<height impression + general build (e.g. 'average height, slim athletic build')>",
  "distinguishingFeatures": "<freckles, moles, scars, tattoos, jewelry, asymmetry — only if visible; else 'none'>",
  "suggestedOutfit": "<one tasteful, fully-clothed PG-13 outfit appropriate to the role, incorporating signatureColor if provided>",
  "signatureColor": "<dominant color used in suggestedOutfit; echo the provided signatureColor if any>"
}

Rules:
- PG-13, affectionate, respectful. Describe traits visible in the photo — do NOT speculate about ethnicity, religion, weight as a judgement, health, or sexuality. Do NOT include the person's actual name or any identifying text.
- Be FACTUAL and PRECISE: an illustrator must be able to draw the same person from your description alone.
- If a field is not visible, use "none" or a neutral default; never invent dramatic features.
- ADULT only — never describe the person as a child, teen, or minor.${ctxBlock}`;
}

/**
 * Build the reference-sheet img2img prompt.
 *
 * @param {{
 *   name?: string, role?: string, definingTrait?: string,
 *   signatureProp?: string, signatureColor?: string,
 *   artStyle?: string, portrayalDial?: string,
 *   visualLocks?: object
 * }} ctx
 * @returns {string}
 */
function buildRefSheetPrompt(ctx = {}) {
  const locks = ctx.visualLocks || {};
  const lockLines = [
    locks.face && `- Face: ${locks.face}`,
    locks.hair && `- Hair: ${locks.hair}`,
    locks.skinTone && `- Skin tone: ${locks.skinTone}`,
    locks.facialHair && locks.facialHair !== 'none' && `- Facial hair: ${locks.facialHair}`,
    locks.glasses && locks.glasses !== 'none' && `- Glasses: ${locks.glasses}`,
    locks.build && `- Build: ${locks.build}`,
    locks.distinguishingFeatures && locks.distinguishingFeatures !== 'none' && `- Distinguishing features: ${locks.distinguishingFeatures}`,
    locks.suggestedOutfit && `- Outfit: ${locks.suggestedOutfit}`,
    locks.signatureColor && `- Signature color (must be visible in outfit): ${locks.signatureColor}`,
  ].filter(Boolean);

  const ctxLines = [];
  if (ctx.role) ctxLines.push(`Role: ${ctx.role}`);
  if (ctx.definingTrait) ctxLines.push(`Defining trait: ${ctx.definingTrait}`);
  if (ctx.signatureProp) ctxLines.push(`Signature prop (include subtly held or worn — not the focus): ${ctx.signatureProp}`);
  if (ctx.portrayalDial) ctxLines.push(`Portrayal dial (tone): ${ctx.portrayalDial}`);
  const styleHint = ctx.artStyle && typeof ctx.artStyle === 'string' && ctx.artStyle.trim().length > 0
    ? `\n\nArt style hint from the book (interpret within the comic / graphic-novel idiom — do NOT switch to photoreal or to a children's storybook look): ${ctx.artStyle.trim()}`
    : '';

  return `Create an ADULT character REFERENCE SHEET in a modern comic-book / graphic-novel style.

The attached image is the actual face reference of the real adult this character is based on. PRESERVE THE FACIAL LIKENESS of that reference photo — face shape, eye spacing, nose, mouth, hairline must clearly read as the same person — but render the character as a stylized comic illustration, not a photo and not a child's storybook.

STYLE — required:
- Comic book / graphic-novel illustration. Clean confident line art with cel shading and vibrant ink-and-color rendering. Modern Western graphic-novel sensibility.
- Affectionate, PG-13, tasteful. Fully clothed.

STYLE — forbidden (negative):
- NOT photorealistic, NOT a photograph, NOT a 3D render.
- NOT a child's storybook illustration, NOT watercolor, NOT pixar, NOT anime.
- NO nudity, NO suggestive posing, NO gore, NO weapons aimed at the viewer.
- NO text, NO speech bubbles, NO captions, NO watermarks, NO logos, NO labels.
- NO multiple different people — single character only. NO children.

LAYOUT — single composite reference sheet, neutral / plain white background, the SAME character shown in three clearly separated views arranged left-to-right:
  1. Front-facing full-figure standing pose (head to feet).
  2. Three-quarter-view full-figure pose (slight turn, same outfit).
  3. Clear face close-up (head and shoulders, neutral expression, eyes open). This close-up is the recognizability anchor — render it large enough that the likeness reads clearly.
Consistent design across all three views: identical outfit, identical hair, identical proportions.

CHARACTER LOCKS — these traits must be visible and consistent across every view:
${lockLines.length > 0 ? lockLines.join('\n') : '- (No prior locks — derive from the reference photo and keep them stable across views.)'}${ctxLines.length > 0 ? `\n\nContext:\n${ctxLines.join('\n')}` : ''}${styleHint}

This sheet will be referenced on every later comic panel, so consistency and recognizability matter more than dramatic composition.`;
}

/**
 * Parse a strict-JSON Gemini response. Tolerates code-fence wrappers.
 *
 * @param {string} text
 * @returns {object | null}
 */
function parseJsonLoose(text) {
  if (!text || typeof text !== 'string') return null;
  const stripped = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(stripped);
  } catch (_) {
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch (_) {
      return null;
    }
  }
}

/**
 * Call gemini-2.5-flash vision to produce the visualLocks JSON. On failure
 * returns an empty object so the caller can still generate the sheet.
 *
 * @param {string} apiKey
 * @param {{ base64: string, mimeType: string }} face
 * @param {object} ctx
 * @returns {Promise<object>}
 */
async function describeVisualLocks(apiKey, face, ctx) {
  const url = `${CHAT_API_BASE}/${VISION_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: buildVisualLocksPrompt(ctx) },
        { inline_data: { mime_type: face.mimeType, data: face.base64 } },
      ],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.15,
      maxOutputTokens: 800,
    },
  };

  try {
    const resp = await withRetry(
      async () => {
        const r = await fetchWithTimeout(
          url,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
          VISION_TIMEOUT_MS,
        );
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          throw new Error(`vision HTTP ${r.status}: ${t.slice(0, 300)}`);
        }
        return r;
      },
      { maxRetries: 3, baseDelayMs: 1500, label: 'castVisualBible:describeLocks' },
    );
    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';
    const parsed = parseJsonLoose(text);
    if (!parsed || typeof parsed !== 'object') {
      console.warn('[castVisualBible] visualLocks parse returned empty — continuing with empty locks');
      return {};
    }
    if (ctx.signatureColor && !parsed.signatureColor) parsed.signatureColor = ctx.signatureColor;
    return parsed;
  } catch (err) {
    console.warn(`[castVisualBible] describeVisualLocks failed: ${err.message} — continuing with empty locks`);
    return {};
  }
}

/**
 * Call gemini-3.1-flash-image-preview img2img with the faceCrop reference and
 * return the generated PNG buffer.
 *
 * @param {string} apiKey
 * @param {{ base64: string, mimeType: string }} face
 * @param {object} ctx
 * @returns {Promise<Buffer>}
 */
async function generateRefSheetImage(apiKey, face, ctx) {
  const url = `${CHAT_API_BASE}/${GEMINI_IMAGE_MODEL}:generateContent?key=${apiKey}`;
  const prompt = buildRefSheetPrompt(ctx);

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inline_data: { mime_type: face.mimeType, data: face.base64 } },
      ],
    }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '16:9' },
    },
  };

  return withRetry(
    async () => {
      const resp = await fetchWithTimeout(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        IMAGE_TIMEOUT_MS,
      );
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        throw new Error(`refsheet image HTTP ${resp.status}: ${t.slice(0, 300)}`);
      }
      const data = await resp.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find(p => p.inlineData || p.inline_data);
      const b64 = imgPart?.inlineData?.data || imgPart?.inline_data?.data;
      if (!b64) {
        const txt = parts.find(p => p.text)?.text || '';
        throw new Error(`No image in refsheet response. Text: "${String(txt).slice(0, 200)}"`);
      }
      return Buffer.from(b64, 'base64');
    },
    { maxRetries: 3, baseDelayMs: 2000, label: 'castVisualBible:refSheetImage' },
  );
}

/**
 * Generate (or fetch cached) a comic-style adult character reference sheet
 * plus visualLocks JSON for a single character.
 *
 * @param {object} params
 * @param {string} params.comicId
 * @param {string} params.characterId
 * @param {string} params.faceCropUrl
 * @param {string} [params.name]
 * @param {string} [params.role]
 * @param {string} [params.definingTrait]
 * @param {string} [params.signatureProp]
 * @param {string} [params.signatureColor]
 * @param {string} [params.artStyle]
 * @param {string} [params.portrayalDial]
 * @param {boolean} [params.force] - Bypass the cache and regenerate.
 * @returns {Promise<{ refSheetUrl: string, visualLocks: object }>}
 */
async function generateCharacterRefSheet(params = {}) {
  const totalStart = Date.now();
  const {
    comicId,
    characterId,
    faceCropUrl,
    name,
    role,
    definingTrait,
    signatureProp,
    signatureColor,
    artStyle,
    portrayalDial,
    force = false,
  } = params;

  if (!comicId || typeof comicId !== 'string' || !SAFE_ID_RE.test(comicId)) {
    throw new Error('comicId is required (alnum/_/-)');
  }
  if (!characterId || typeof characterId !== 'string' || !SAFE_ID_RE.test(characterId)) {
    throw new Error('characterId is required (alnum/_/-)');
  }
  if (!faceCropUrl || typeof faceCropUrl !== 'string') {
    throw new Error('faceCropUrl is required');
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required for generateCharacterRefSheet');
  }

  const cacheJsonPath = `comics/${comicId}/refsheets/${characterId}.json`;
  const refSheetPngPath = `comics/${comicId}/refsheets/${characterId}.png`;
  const cacheKey = computeCacheKey(faceCropUrl, artStyle);

  if (!force) {
    try {
      const cached = await loadJson(cacheJsonPath);
      if (cached && cached.cacheKey === cacheKey && cached.refSheetUrl) {
        console.log(`[castVisualBible] cache HIT comicId=${comicId} characterId=${characterId} (${Date.now() - totalStart}ms)`);
        return {
          refSheetUrl: cached.refSheetUrl,
          visualLocks: cached.visualLocks || {},
        };
      }
      if (cached) {
        console.log(`[castVisualBible] cache STALE comicId=${comicId} characterId=${characterId} — regenerating`);
      }
    } catch (_) {
      // Miss is the common path on first run; loadJson throws on 404.
    }
  } else {
    console.log(`[castVisualBible] cache FORCE bypass comicId=${comicId} characterId=${characterId}`);
  }

  // 1. Download faceCrop once and reuse for both vision + img2img.
  const dlStart = Date.now();
  const face = await downloadFaceCrop(faceCropUrl);
  console.log(`[castVisualBible] face downloaded (${face.base64.length} b64 chars, ${Date.now() - dlStart}ms)`);

  // 2. Describe visual locks (soft-fail to empty {} on error).
  const ctx = { name, role, definingTrait, signatureProp, signatureColor, artStyle, portrayalDial };
  const locksStart = Date.now();
  const visualLocks = await describeVisualLocks(apiKey, face, ctx);
  console.log(`[castVisualBible] visualLocks done (${Object.keys(visualLocks).length} fields, ${Date.now() - locksStart}ms)`);

  // 3. Generate the ref-sheet PNG (hard-fail → throw → 502 from route).
  const imgStart = Date.now();
  const pngBuf = await generateRefSheetImage(apiKey, face, { ...ctx, visualLocks });
  console.log(`[castVisualBible] refsheet image generated (${pngBuf.length} bytes, ${Date.now() - imgStart}ms)`);

  // 4. Upload PNG → signed URL.
  const refSheetUrl = await uploadBuffer(pngBuf, refSheetPngPath, 'image/png');

  // 5. Save the cache JSON (only when visualLocks were produced).
  if (Object.keys(visualLocks).length > 0) {
    await saveJson({ cacheKey, refSheetUrl, visualLocks }, cacheJsonPath);
  } else {
    console.warn('[castVisualBible] visualLocks empty — skipping cache save to avoid sticky soft-fail');
  }

  console.log(`[castVisualBible] DONE comicId=${comicId} characterId=${characterId} (total ${Date.now() - totalStart}ms)`);
  return { refSheetUrl, visualLocks };
}

module.exports = {
  generateCharacterRefSheet,
  __private: {
    normalizeCacheUrl,
    computeCacheKey,
    fetchWithTimeout,
  },
};
