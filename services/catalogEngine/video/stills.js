/**
 * Start frames for the gift video (gv-1 — docs/GIFT_VIDEO_PLAN.md §4.3–4.4).
 *
 * The film's start frames are the EXACT pixels the customer got: the app
 * sends canonical render keys (never URLs, never candidate keys), each is
 * fetched and content-hashed, and an `embedded`-layout key (story text
 * painted INTO the art) is never used — the spread is re-rendered text-free
 * through the production `renderStorySpreads` path under the `half` layout
 * (its `wide-plain` cache key). Every start frame then passes a strict-JSON
 * vision text gate before it is prepared (16:9, blur-filled) for the
 * provider.
 */

const sharp = require('sharp');
const { downloadBuffer } = require('../../gcsStorage');
const { fetchWithTimeout, getNextApiKey } = require('../../illustrationGenerator');
const { jsonQaGenerationConfig, responseText, parseJsonText } = require('../../shared/llm/geminiJson');
const { fnv1a } = require('../selection');

const RENDER_KEY_RE = /^children-jobs\/([A-Za-z0-9_-]{1,128})\/ce-renders\/[^/]+\/[^/]+\/spread-(\d{1,2})\.(square|wide|wide-plain)\.png$/;
const QA_MODEL = () => process.env.CATALOG_QA_VISION_MODEL || 'gemini-2.5-flash';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
const CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u001f\\u007f]+', 'g');

/**
 * Validate the app's `renders` list for one book: 1–12 entries, unique
 * spreads, canonical render keys of THIS book whose spread matches.
 * @param {string} bookId
 * @param {*} renders
 * @returns {{ok: true, entries: Array<{spread: number, storageKey: string, aspect: string, embedded: boolean}>}|{ok: false, error: string}}
 */
function validateRenders(bookId, renders) {
  if (!Array.isArray(renders) || renders.length < 1 || renders.length > 12) {
    return { ok: false, error: 'renders must list 1-12 {spread, storageKey} entries' };
  }
  const entries = [];
  const seen = new Set();
  for (const r of renders) {
    if (!r || typeof r !== 'object') return { ok: false, error: 'renders entries must be objects' };
    if (!Number.isInteger(r.spread) || r.spread < 1 || r.spread > 12) return { ok: false, error: 'renders[].spread must be an integer between 1 and 12' };
    if (seen.has(r.spread)) return { ok: false, error: `renders lists spread ${r.spread} twice` };
    if (typeof r.storageKey !== 'string' || r.storageKey.length > 512) return { ok: false, error: `renders[].storageKey for spread ${r.spread} must be a string` };
    const m = r.storageKey.includes('..') ? null : RENDER_KEY_RE.exec(r.storageKey);
    if (!m) return { ok: false, error: `renders[].storageKey for spread ${r.spread} is not a canonical render key (candidate keys must be promoted with /v13/pick-candidate first)` };
    if (m[1] !== bookId) return { ok: false, error: `renders[].storageKey for spread ${r.spread} belongs to another book` };
    if (Number(m[2]) !== r.spread) return { ok: false, error: `renders[].storageKey for spread ${r.spread} names spread ${Number(m[2])}` };
    seen.add(r.spread);
    entries.push({ spread: r.spread, storageKey: r.storageKey, aspect: m[3], embedded: m[3] === 'wide' });
  }
  entries.sort((a, b) => a.spread - b.spread);
  return { ok: true, entries };
}

/**
 * Content hash of an image buffer (the render cache's own fingerprint).
 * @param {Buffer} buffer
 * @returns {string}
 */
function contentHash(buffer) {
  return fnv1a(buffer.toString('base64')).toString(36);
}

/**
 * Fetch one start frame's bytes; a missing object is `video_source_missing`
 * (the app's keys are stale — never substitute the current render).
 * @param {string} source storage key or URL
 * @param {string} what for the error message
 * @returns {Promise<{buffer: Buffer, hash: string}>}
 */
async function fetchStill(source, what) {
  let buffer;
  try {
    buffer = await downloadBuffer(source);
  } catch (err) {
    const e = new Error(`${what} could not be fetched (${err.message}) — the render keys the app holds no longer resolve`);
    e.failureCode = 'video_source_missing';
    throw e;
  }
  if (!buffer || buffer.length === 0) {
    const e = new Error(`${what} is empty`);
    e.failureCode = 'video_source_missing';
    throw e;
  }
  return { buffer, hash: contentHash(buffer) };
}

/**
 * Prepare a start frame for the provider: exact 16:9 at the film size, a
 * non-16:9 source letterboxed over a blurred, darkened copy of itself (the
 * same treatment the stitch gives clips), encoded JPEG.
 * @param {Buffer} buffer
 * @param {{width?: number, height?: number}} [opts]
 * @returns {Promise<{buffer: Buffer, mimeType: string, width: number, height: number, blurFilled: boolean}>}
 */
async function prepareStartFrame(buffer, opts = {}) {
  const width = opts.width || 1920;
  const height = opts.height || 1080;
  const meta = await sharp(buffer).metadata();
  const ratio = meta.width && meta.height ? meta.width / meta.height : null;
  const target = width / height;
  const near = ratio !== null && Math.abs(ratio - target) / target < 0.03;
  if (near) {
    const out = await sharp(buffer).resize(width, height, { fit: 'cover' }).jpeg({ quality: 92 }).toBuffer();
    return { buffer: out, mimeType: 'image/jpeg', width, height, blurFilled: false };
  }
  const bg = await sharp(buffer).resize(width, height, { fit: 'cover' }).blur(40).modulate({ brightness: 0.85 }).toBuffer();
  const fg = await sharp(buffer).resize(width, height, { fit: 'inside' }).toBuffer();
  const out = await sharp(bg).composite([{ input: fg, gravity: 'centre' }]).jpeg({ quality: 92 }).toBuffer();
  return { buffer: out, mimeType: 'image/jpeg', width, height, blurFilled: true };
}

/**
 * The text gate: ONE strict-JSON vision call — is there any legible text
 * painted in this illustration? Fail-open with a named reason (the
 * sources are text-free by contract; the gate is belt and braces).
 * @param {Buffer} buffer PNG/JPEG bytes
 * @param {{label?: string, costTracker?: object}} [opts]
 * @returns {Promise<{pass: boolean, textPresent: boolean, transcript: string|null, unavailable?: string}>}
 */
async function textGate(buffer, opts = {}) {
  const label = opts.label || 'videoTextGate';
  const prompt = 'You are checking one illustration from a children\'s picture book for PAINTED TEXT. '
    + 'Look at every part of the image. Answer with strict JSON only: '
    + '{"text_present": boolean, "transcript": string} — text_present is true when ANY legible letters, words, digits, '
    + 'captions, signs, or logos appear anywhere in the artwork (pictograms, scribbles and non-letter shapes do not count); '
    + 'transcript is the exact legible text you can read, or "" when there is none.';
  try {
    const apiKey = getNextApiKey();
    const resp = await fetchWithTimeout(
      `${GEMINI_API}/${QA_MODEL()}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mimeType: 'image/png', data: buffer.toString('base64') } }] }],
          generationConfig: jsonQaGenerationConfig(512, QA_MODEL()),
        }),
      },
      60000,
    );
    if (!resp.ok) return { pass: true, textPresent: false, transcript: null, unavailable: `vision text gate HTTP ${resp.status}` };
    const data = await resp.json();
    if (opts.costTracker) opts.costTracker.addTextUsage(QA_MODEL(), 500, 50);
    const json = parseJsonText(responseText(data));
    if (!json || typeof json.text_present !== 'boolean') return { pass: true, textPresent: false, transcript: null, unavailable: 'vision text gate returned a malformed verdict' };
    const transcript = typeof json.transcript === 'string' ? json.transcript.replace(CONTROL_CHARS_RE, ' ').trim().slice(0, 200) : '';
    return { pass: !json.text_present, textPresent: json.text_present, transcript: transcript || null };
  } catch (err) {
    console.warn(`[${label}] text gate failed to run (passing without it): ${err.message}`);
    return { pass: true, textPresent: false, transcript: null, unavailable: `vision text gate errored: ${err.message}` };
  }
}

module.exports = { RENDER_KEY_RE, validateRenders, contentHash, fetchStill, prepareStartFrame, textGate };
