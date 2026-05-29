/**
 * Comics — group-photo face detection via Gemini Vision bounding boxes.
 *
 * Admin-only worker service used by the adult-comics-book pipeline.
 * Returns normalized 0..1 boxes (top-left origin) so callers can render
 * overlays at any image size. Results are cached in GCS by sha256(url).
 */

const crypto = require('crypto');
const { saveJson, loadJson } = require('../gcsStorage');
const { withRetry } = require('../retry');

/** GCS prefix for cached detection results */
const DETECT_CACHE_PREFIX = 'comics/detect-cache';

/** Bump to invalidate cached detections after prompt/parse changes */
const DETECT_PROMPT_VERSION = 'v1';

/**
 * Compute the GCS cache key for a given group-photo URL.
 *
 * @param {string} groupPhotoUrl
 * @returns {string}
 */
function computeDetectCacheKey(groupPhotoUrl) {
  const hash = crypto.createHash('sha256').update(groupPhotoUrl).digest('hex');
  return `${DETECT_CACHE_PREFIX}/${hash}.json`;
}

/**
 * Strip markdown code fences from a model response so JSON.parse can consume it.
 *
 * @param {string} text
 * @returns {string}
 */
function stripCodeFences(text) {
  if (!text) return text;
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  return t;
}

/**
 * Clamp a numeric value into [0, 1]; default to 0 for invalid inputs.
 *
 * @param {*} n
 * @returns {number}
 */
function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Normalize a raw face entry from the model into { box:[x,y,w,h], confidence }.
 * Accepts box as array [x,y,w,h] or object {x,y,w,h}.
 *
 * @param {*} raw
 * @returns {{ box: number[], confidence: number } | null}
 */
function normalizeFace(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let box = raw.box;
  if (box && !Array.isArray(box) && typeof box === 'object') {
    box = [box.x, box.y, box.w, box.h];
  }
  if (!Array.isArray(box) || box.length < 4) return null;
  const [x, y, w, h] = box.map(clamp01);
  if (w <= 0 || h <= 0) return null;
  const confidence = clamp01(raw.confidence);
  return { box: [x, y, w, h], confidence };
}

/**
 * Detect faces in a group photo using Gemini Vision and return normalized boxes.
 *
 * Caches the result in GCS keyed by sha256(groupPhotoUrl) so re-opening the
 * tagging UI is instant and idempotent. If GEMINI_API_KEY is not configured,
 * returns an empty result with a warning log.
 *
 * @param {string} groupPhotoUrl - URL of the source group photo
 * @returns {Promise<{ faces: Array<{ id: string, box: number[], confidence: number }>, faceCount: number }>}
 */
async function detectFaces(groupPhotoUrl) {
  const totalStart = Date.now();
  if (!groupPhotoUrl || typeof groupPhotoUrl !== 'string') {
    throw new Error('groupPhotoUrl is required');
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[comics/detectFaces] GEMINI_API_KEY missing — returning empty result');
    return { faces: [], faceCount: 0 };
  }

  // Check GCS cache first
  const cacheKey = computeDetectCacheKey(groupPhotoUrl);
  try {
    const cached = await loadJson(cacheKey);
    if (cached && cached.promptVersion === DETECT_PROMPT_VERSION && Array.isArray(cached.faces)) {
      console.log(`[comics/detectFaces] Cache HIT for ${cacheKey} (${cached.faces.length} faces, ${Date.now() - totalStart}ms)`);
      return { faces: cached.faces, faceCount: cached.faces.length };
    }
  } catch (err) {
    console.log(`[comics/detectFaces] Cache MISS for ${cacheKey}`);
  }

  // Download image
  const dlStart = Date.now();
  const imgResp = await withRetry(
    async () => {
      const resp = await fetch(groupPhotoUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp;
    },
    { maxRetries: 3, baseDelayMs: 1000, label: 'comics-group-photo-download' }
  );
  const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
  const mimeType = imgResp.headers.get('content-type') || 'image/jpeg';
  const base64 = imgBuffer.toString('base64');
  console.log(`[comics/detectFaces] Photo downloaded (${imgBuffer.length} bytes, ${Date.now() - dlStart}ms)`);

  const prompt = `Detect every distinct human FACE in this group photo. For each face return a tight
bounding box. Respond ONLY as JSON: an array of objects
{ "box": [x, y, w, h], "confidence": 0..1 }
where x,y,w,h are fractions of image width/height in range 0..1 (x,y = top-left corner).
Do not include partial/background blurred faces below confidence 0.3. No prose.`;

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64 } },
      ],
    }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
    },
  };

  const geminiStart = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const resp = await withRetry(
    async () => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        throw new Error(`Gemini API ${r.status}: ${errText.slice(0, 200)}`);
      }
      return r;
    },
    { maxRetries: 3, baseDelayMs: 1500, label: 'comics-detect-faces-gemini' }
  );

  const result = await resp.json();
  const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  console.log(`[comics/detectFaces] Gemini responded (${text.length} chars, ${Date.now() - geminiStart}ms)`);

  // Parse robustly — model may wrap in code fences despite responseMimeType
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFences(text));
  } catch (err) {
    console.warn(`[comics/detectFaces] Failed to parse JSON: ${err.message} — raw: ${text.slice(0, 200)}`);
    return { faces: [], faceCount: 0 };
  }

  // Gemini may return either a bare array or an object wrapping one
  let rawFaces = [];
  if (Array.isArray(parsed)) {
    rawFaces = parsed;
  } else if (parsed && Array.isArray(parsed.faces)) {
    rawFaces = parsed.faces;
  } else if (parsed && Array.isArray(parsed.boxes)) {
    rawFaces = parsed.boxes;
  } else {
    console.warn(`[comics/detectFaces] Unexpected JSON shape: ${JSON.stringify(parsed).slice(0, 200)}`);
    return { faces: [], faceCount: 0 };
  }

  // Normalize, drop low-confidence, sort top-left → bottom-right, assign stable ids
  const faces = rawFaces
    .map(normalizeFace)
    .filter((f) => f && f.confidence >= 0.3)
    .sort((a, b) => {
      // Bin y into rows of ~10% so we read left-to-right within each row
      const ay = Math.round(a.box[1] * 10);
      const by = Math.round(b.box[1] * 10);
      if (ay !== by) return ay - by;
      return a.box[0] - b.box[0];
    })
    .map((f, idx) => ({
      id: `face-${idx + 1}`,
      box: f.box,
      confidence: f.confidence,
    }));

  // Cache result (best-effort)
  try {
    await saveJson(
      {
        version: 1,
        promptVersion: DETECT_PROMPT_VERSION,
        groupPhotoUrl,
        faces,
        createdAt: new Date().toISOString(),
      },
      cacheKey
    );
    console.log(`[comics/detectFaces] Cached ${faces.length} faces at ${cacheKey}`);
  } catch (err) {
    console.warn(`[comics/detectFaces] Cache save failed: ${err.message}`);
  }

  console.log(`[comics/detectFaces] completed: ${faces.length} faces (${Date.now() - totalStart}ms)`);
  return { faces, faceCount: faces.length };
}

module.exports = {
  detectFaces,
  computeDetectCacheKey,
};
