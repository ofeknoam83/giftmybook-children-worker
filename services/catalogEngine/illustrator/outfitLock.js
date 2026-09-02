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
const OUTFIT_MAX_CHARS = 700;
const OUTFIT_MIN_CHARS = 10;
const SLOT_MAX_CHARS = 160;

// In-process caches, keyed by the anchor's path hash. Specs are tiny, but
// the maps stay bounded like the plate's. Failed derivations sit out a
// cooldown so a recurrently failing anchor costs one attempt per window,
// not one per spread batch.
const CACHE_MAX = 64;
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const _specs = new Map();
const _inFlight = new Map();
const _failures = new Map();

// v2 (ce-8): a STRUCTURED per-slot spec instead of one free sentence. The
// v1 prompt's "do NOT invent items that are not clearly visible" left every
// anchor-cropped garment (the approved cover usually crops the legs)
// UNSPECIFIED — and an unspecified garment is per-spread freedom: each
// stateless render re-invented the pant length and the shoes, which is
// exactly the observed drift. v2 requires every slot filled — a slot the
// anchor does not show gets ONE elected, style-consistent completion marked
// `inferred` (the goal is that all renders pin the SAME words, not fidelity
// to an invisible garment) — with the length words the drift lives in
// (sleeve length, hem reach, footwear type) mandatory where they apply.
const OUTFIT_PROMPT = `You are extracting the OUTFIT LOCK for a children's picture book from its approved character reference image. The lock pins EXACTLY what the child wears in EVERY illustration of the book, so every slot must be specific enough for an illustrator to reproduce it identically twelve times.

For each slot, give the garment's precise color, pattern or graphic, style/cut, and LENGTH where it applies (sleeve length; pant or skirt cut and where the hem reaches — e.g. "full-length, reaching the ankles"; shoe type and color, plus socks if visible). Length words are mandatory for tops, bottoms, and footwear.

If a slot is NOT visible in the image (for example the legs are cropped out), you MUST still fill it: elect ONE plausible completion consistent with the visible clothing and mark it "inferred". Never leave a required slot empty and never write "not visible" — the lock needs one fixed complete outfit.

Do NOT describe the child's face, hair, body, pose, or the background. "outerwear" may be null and "accessories" may be an empty list when the child clearly wears none.

Answer STRICT JSON only:
{
  "top": {"desc": "<color, pattern/graphic, style, sleeve length>", "visibility": "seen"|"inferred"},
  "bottom": {"desc": "<color, style/cut, where the hem reaches>", "visibility": "seen"|"inferred"},
  "footwear": {"desc": "<shoe type and color, socks if visible>", "visibility": "seen"|"inferred"},
  "outerwear": {"desc": "<color, style>", "visibility": "seen"|"inferred"} | null,
  "accessories": [{"desc": "<item and color>", "visibility": "seen"|"inferred"}]
}`;

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

/** Deterministic GCS path for one anchor's elected outfit spec. The `v2/`
 * segment keeps v1's free-sentence blobs from ever being half-parsed as a
 * structured spec (they simply stop being read; a v2 spec re-derives). */
function outfitLockPath(hash) {
  return `catalog-assets/outfit-locks/v2/${hash}.json`;
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
 * Sanitize one slot description into inert pinned prompt data: control
 * chars/newlines collapse, quotes/backticks strip (the spec is later quoted
 * into the QA prompt as `"…"`), length-capped. Null when nothing survives.
 * @param {*} value
 * @returns {string|null}
 */
function cleanSlotDesc(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SLOT_MAX_CHARS);
  return cleaned.length >= 3 ? cleaned : null;
}

/** Minimum words for a REQUIRED slot description: the contract is color +
 * garment + cut/length words, so a description that thin ("shoes",
 * "blue pants") cannot pin the hem/footwear detail the drift lives in —
 * reject it and let the derivation retry rather than pin a partial lock. */
const REQUIRED_SLOT_MIN_WORDS = 3;

/** @param {*} slot @returns {{desc: string, visibility: string}|null} */
function cleanSlot(slot) {
  const desc = cleanSlotDesc(slot?.desc);
  if (!desc) return null;
  // `visibility` is diagnostics-only (it never reaches a prompt or the
  // hash), so an off-enum value normalizes to 'seen' instead of rejecting
  // an otherwise-usable garment description.
  const visibility = slot?.visibility === 'inferred' ? 'inferred' : 'seen';
  return { desc, visibility };
}

/** A required slot must actually carry the color/garment/length detail. */
function cleanRequiredSlot(slot) {
  const cleaned = cleanSlot(slot);
  if (!cleaned) return null;
  return cleaned.desc.split(' ').length >= REQUIRED_SLOT_MIN_WORDS ? cleaned : null;
}

/**
 * Validate + sanitize the model's structured answer and render the pinned
 * spec sentence. top/bottom/footwear are REQUIRED and must be detailed
 * enough to lock (>= REQUIRED_SLOT_MIN_WORDS words — the whole point of v2
 * is that no garment stays unspecified); outerwear/accessories are
 * optional and fail soft (a malformed optional entry is dropped, never a
 * reason to lose the lock). The rendered sentence must fit
 * OUTFIT_MAX_CHARS whole: trailing accessories are dropped FROM BOTH the
 * sentence and the stored spec until it fits (spec and pinned words must
 * never disagree about what is locked), and a spec whose garment slots
 * alone cannot fit is rejected — a silently truncated lock would end
 * mid-item and defeat full coverage.
 * @param {*} json the model's parsed JSON
 * @returns {{spec: object, outfit: string}|null} null when unusable
 */
function renderOutfitSpec(json) {
  if (!json || typeof json !== 'object') return null;
  const top = cleanRequiredSlot(json.top);
  const bottom = cleanRequiredSlot(json.bottom);
  const footwear = cleanRequiredSlot(json.footwear);
  if (!top || !bottom || !footwear) return null;
  const outerwear = json.outerwear ? cleanSlot(json.outerwear) : null;
  const accessories = (Array.isArray(json.accessories) ? json.accessories : [])
    .map(cleanSlot)
    .filter(Boolean)
    .slice(0, 6);
  // Slot descs are already control-stripped and collapsed (cleanSlotDesc),
  // so the plain join IS the normalized sentence — its length is checked
  // against the cap directly (cleanOutfit's slice can never distinguish
  // "fits exactly" from "was truncated").
  const render = (acc) => [
    `Top: ${top.desc}.`,
    `Bottom: ${bottom.desc}.`,
    `Footwear: ${footwear.desc}.`,
    ...(outerwear ? [`Outerwear: ${outerwear.desc}.`] : []),
    ...(acc.length > 0 ? [`Accessories: ${acc.map(a => a.desc).join('; ')}.`] : []),
  ].join(' ');
  for (let keep = accessories.length; keep >= 0; keep -= 1) {
    const kept = accessories.slice(0, keep);
    const outfit = render(kept);
    if (outfit.length >= OUTFIT_MIN_CHARS && outfit.length <= OUTFIT_MAX_CHARS) {
      return { spec: { top, bottom, footwear, ...(outerwear ? { outerwear } : {}), accessories: kept }, outfit };
    }
  }
  return null;
}

/**
 * One vision call: read the outfit off the anchor image.
 * @param {{base64: string, mimeType: string}} refPhoto
 * @returns {Promise<{spec: object, outfit: string}>} sanitized structured
 *   spec + the rendered sentence that gets pinned on renders
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
        generationConfig: { temperature: 0, maxOutputTokens: 512, responseMimeType: 'application/json' },
      }),
    },
    OUTFIT_TIMEOUT_MS,
  );
  if (!resp.ok) throw new Error(`outfit vision HTTP ${resp.status}`);
  const data = await resp.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  const json = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
  const rendered = renderOutfitSpec(json);
  if (!rendered) throw new Error('outfit vision returned no usable spec');
  return rendered;
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
        const derived = await deriveOutfit(refPhoto);
        // Create-if-absent elects ONE winning spec per anchor; losers adopt
        // the winner so every instance pins the same words (and the same
        // cache-key hash) — a forked description would fork the render key.
        // The structured slots ride the blob for diagnostics; the rendered
        // sentence is what gets pinned (and hashed).
        let elected = derived.outfit;
        const body = Buffer.from(JSON.stringify({ spec: derived.spec, outfit: derived.outfit, derivedAt: new Date().toISOString() }));
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

module.exports = { getOutfitLock, outfitLockPath, anchorHash, cleanOutfit, renderOutfitSpec };
