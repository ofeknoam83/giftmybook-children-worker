/**
 * Outfit lock — a concrete, per-anchor clothing spec derived ONCE from the
 * identity reference image and pinned verbatim on every stateless render.
 *
 * Why: "keep the outfit identical across every illustration" is not
 * actionable by a single render — spread 7's model never sees spreads 1-6,
 * so cross-spread sameness only comes from FIXED inputs (the same rule
 * TEXT_RULES applies to typography and the world plate applies to the
 * environment). The renderer already carries a full outfit-lock arsenal
 * (`buildCharacterPrompt`'s OUTFIT LOCK block: per-garment color
 * verification, no additions/removals, pre-generate checklist) — but it
 * only arms when `characterOutfit` is supplied, and nothing supplied it.
 * This module reads the outfit off the approved anchor with one vision
 * call and arms that machinery with the SAME concrete spec on all 12
 * renders.
 *
 * Cache discipline mirrors the world plate: the spec is nondeterministic
 * model output, so all instances must converge on ONE winning spec per
 * anchor — GCS create-if-absent elects the winner, losers adopt it, and an
 * upload failure resolves null (lock-less renders) rather than letting
 * instances fork the description. The spec's content hash rides the render
 * cache key upstream (renderStorySpreads), so locked and lock-less renders
 * never replay each other.
 *
 * Fail-open by contract: any failure logs and returns null — a render must
 * never fail because the outfit could not be read. Kill-switch:
 * CATALOG_OUTFIT_LOCK=0.
 */

const { getNextApiKey, fetchWithTimeout } = require('../../illustrationGenerator');
const { downloadBuffer, uploadBufferIfAbsent } = require('../../gcsStorage');
const { fnv1a } = require('../selection');
const flags = require('../flags');

const OUTFIT_MODEL = () => process.env.CATALOG_QA_VISION_MODEL || 'gemini-2.5-flash';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
const OUTFIT_TIMEOUT_MS = 60000;
const OUTFIT_MAX_CHARS = 500;
const OUTFIT_MIN_CHARS = 10;

// In-process caches, keyed by the anchor's path hash. Specs are tiny, but
// the maps stay bounded like the plate's. Failed derivations sit out a
// cooldown so a recurrently failing anchor costs one attempt per window,
// not one per spread batch.
const CACHE_MAX = 64;
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const _specs = new Map();
const _inFlight = new Map();
const _failures = new Map();

const OUTFIT_PROMPT = `You are extracting the OUTFIT LOCK for a children's picture book from its approved character reference image.

Describe EXACTLY what the child in the image is wearing, garment by garment, so an illustrator can reproduce it identically in every illustration: each garment with its precise color, pattern or graphic, and style, plus every visible accessory (glasses, jewelry, hair accessories, bags). Do NOT describe the child's face, hair, body, pose, or the background — clothing and visible accessories only. Do NOT invent items that are not clearly visible.

Answer STRICT JSON only:
{"outfit": "<one compact sentence listing every garment and accessory with its colors>"}`;

/** @param {string} key @returns {boolean} still inside the failure cooldown */
function inFailureCooldown(key) {
  const at = _failures.get(key);
  if (at === undefined) return false;
  if (Date.now() - at < FAILURE_COOLDOWN_MS) return true;
  _failures.delete(key);
  return false;
}

/** Record a failed derivation (evicting oldest past the cap). */
function recordFailure(key) {
  _failures.delete(key);
  _failures.set(key, Date.now());
  while (_failures.size > CACHE_MAX) _failures.delete(_failures.keys().next().value);
}

/** LRU get/set for resolved specs. */
function cacheGet(key) {
  if (!_specs.has(key)) return null;
  const spec = _specs.get(key);
  _specs.delete(key);
  _specs.set(key, spec);
  return spec;
}
function cacheSet(key, spec) {
  _specs.delete(key);
  _specs.set(key, spec);
  while (_specs.size > CACHE_MAX) _specs.delete(_specs.keys().next().value);
}

/**
 * The anchor's cache identity: its URL PATH, never the query string — a
 * signed URL's rotating signature must not re-derive (or re-key) the same
 * object. Same rule as the probe cache's identity fold.
 * @param {string} anchorUrl
 * @returns {string} fnv1a-base36 of the path
 */
function anchorHash(anchorUrl) {
  return fnv1a(String(anchorUrl).split('?')[0]).toString(36);
}

/** Deterministic GCS path for one anchor's elected outfit spec. */
function outfitLockPath(hash) {
  return `catalog-assets/outfit-locks/${hash}.json`;
}

/**
 * Sanitize the model's outfit sentence into inert pinned prompt data:
 * control chars and newlines collapse, whitespace normalizes, and the spec
 * is length-capped. Returns null when nothing usable survives.
 * @param {*} value
 * @returns {string|null}
 */
function cleanOutfit(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, OUTFIT_MAX_CHARS);
  return cleaned.length >= OUTFIT_MIN_CHARS ? cleaned : null;
}

/**
 * One vision call: read the outfit off the anchor image.
 * @param {{base64: string, mimeType: string}} refPhoto
 * @returns {Promise<string>} sanitized outfit sentence
 */
async function deriveOutfit(refPhoto) {
  const apiKey = getNextApiKey();
  const resp = await fetchWithTimeout(
    `${GEMINI_API}/${OUTFIT_MODEL()}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: OUTFIT_PROMPT },
            { inline_data: { mimeType: refPhoto.mimeType || 'image/png', data: refPhoto.base64 } },
          ],
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 256, responseMimeType: 'application/json' },
      }),
    },
    OUTFIT_TIMEOUT_MS,
  );
  if (!resp.ok) throw new Error(`outfit vision HTTP ${resp.status}`);
  const data = await resp.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  const json = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
  const outfit = cleanOutfit(json?.outfit);
  if (!outfit) throw new Error('outfit vision returned no usable spec');
  return outfit;
}

/**
 * Resolve (or lazily derive) the outfit lock for one identity anchor.
 * @param {object} params
 * @param {string} params.anchorUrl the identity reference URL (approved
 *   cover, or the raw-photo fallback for coverless test books)
 * @param {{base64: string, mimeType: string}} params.refPhoto the anchor
 *   bytes the caller already downloaded for the renders
 * @param {(level: string, msg: string) => void} [params.log]
 * @returns {Promise<{outfit: string, hash: string}|null>} null when
 *   disabled or on any failure — the caller renders without the lock.
 */
async function getOutfitLock({ anchorUrl, refPhoto, log = () => {} }) {
  try {
    if (!flags.outfitLockEnabled()) return null;
    if (!anchorUrl || !refPhoto?.base64) return null;
    const key = anchorHash(anchorUrl);
    const hit = cacheGet(key);
    if (hit) return hit;
    if (inFailureCooldown(key)) return null;
    if (_inFlight.has(key)) return _inFlight.get(key);

    const resolve = (async () => {
      const path = outfitLockPath(key);
      try {
        const cached = await downloadBuffer(path).catch(() => null);
        if (cached) {
          const stored = cleanOutfit(JSON.parse(cached.toString('utf8'))?.outfit);
          if (stored) {
            const spec = { outfit: stored, hash: fnv1a(stored).toString(36) };
            cacheSet(key, spec);
            return spec;
          }
          // A stored blob with no usable spec is treated as a derivation
          // failure — cooldown, never a per-book retry storm.
          recordFailure(key);
          return null;
        }
        log('info', `outfit lock for anchor ${key} not cached — deriving (${path})`);
        const outfit = await deriveOutfit(refPhoto);
        // Create-if-absent elects ONE winning spec per anchor; losers adopt
        // the winner so every instance pins the same words (and the same
        // cache-key hash) — a forked description would fork the render key.
        let elected = outfit;
        const body = Buffer.from(JSON.stringify({ outfit, derivedAt: new Date().toISOString() }));
        const { created } = await uploadBufferIfAbsent(body, path, 'application/json');
        if (!created) {
          const winner = await downloadBuffer(path);
          const stored = cleanOutfit(JSON.parse(winner.toString('utf8'))?.outfit);
          if (!stored) {
            recordFailure(key);
            return null;
          }
          elected = stored;
        }
        const spec = { outfit: elected, hash: fnv1a(elected).toString(36) };
        cacheSet(key, spec);
        return spec;
      } catch (err) {
        log('warn', `outfit lock unavailable for anchor ${key} (${err.message}) — rendering without it`);
        recordFailure(key);
        return null;
      } finally {
        _inFlight.delete(key);
      }
    })();
    _inFlight.set(key, resolve);
    return resolve;
  } catch (err) {
    log('warn', `outfit lock unavailable (${err.message}) — rendering without it`);
    return null;
  }
}

module.exports = { getOutfitLock, outfitLockPath, anchorHash, cleanOutfit };
