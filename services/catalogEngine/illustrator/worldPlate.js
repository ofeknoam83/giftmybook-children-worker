/**
 * World reference plate — the per-theme FIXED environment reference image
 * (Layer 2 of the cross-spread world-consistency design).
 *
 * One establishing key art per theme (environment only — no child, no
 * companion, no characters, no text), generated once through the shared
 * Gemini image client, cached in GCS under STYLE_VERSION + the plate
 * prompt's hash (the prompt folds in overlay-patchable world naming and
 * the world-law card, so a Catalog Studio activation resolves a new plate
 * instead of replaying the old world's), and attached to EVERY spread
 * render as a second reference image beside the identity anchor. Because the plate is identical on every spread, each stateless
 * render converges toward the same world instead of toward the previous
 * render — deliberately NOT the deleted previous-spread chaining
 * (illustrationGenerator's photocopy-of-a-photocopy drift source): the
 * reference never changes generation to generation.
 *
 * The plate's content hash rides the render cache key (renderStorySpreads),
 * so a regenerated plate never replays renders anchored on the old one, and
 * a plate-less run (kill-switch or generation failure) caches separately
 * from a plated one.
 *
 * Fail-open by contract: any plate failure logs and returns null — a
 * customer render must never fail because the world plate could not be
 * made; the world-law card still rides the prompt either way.
 * Kill-switch: CATALOG_WORLD_PLATE=0.
 */

const { getNextApiKey, GEMINI_MODEL, fetchWithTimeout, renderStyleBlock } = require('../../illustrationGenerator');
const { PIXAR_STYLE } = require('../../shared/illustration/config');
const { downloadBuffer, uploadBufferIfAbsent } = require('../../gcsStorage');
const { renderWorldCardBlock } = require('../worldCards');
const { STYLE_VERSION } = require('../versions');
const { fnv1a } = require('../selection');
const flags = require('../flags');

const PLATE_TIMEOUT_MS = 180000;
const PLATE_ATTEMPTS = 2;

// In-process caches, keyed by themeId + plate-prompt hash, so a warm
// instance resolves each plate's bytes once. The in-flight map dedupes
// concurrent first-use generation across parallel renders. The plate cache
// is a BOUNDED LRU: each entry holds a multi-megabyte base64 image, and the
// key churns with overlay activations and pinned older stories — unbounded,
// a long-lived instance would accumulate plates until OOM. 16 comfortably
// covers the 12 live themes plus pinned/overlay variants in flight.
const PLATE_CACHE_MAX = 16;
const _plates = new Map();
const _inFlight = new Map();

/** LRU get: refresh recency on hit. @param {string} key */
function plateCacheGet(key) {
  if (!_plates.has(key)) return null;
  const plate = _plates.get(key);
  _plates.delete(key);
  _plates.set(key, plate);
  return plate;
}

/** LRU set: insert as most-recent, evict oldest past the cap. */
function plateCacheSet(key, plate) {
  _plates.delete(key);
  _plates.set(key, plate);
  while (_plates.size > PLATE_CACHE_MAX) _plates.delete(_plates.keys().next().value);
}

/**
 * Deterministic GCS path for one theme's plate. Keyed by STYLE_VERSION
 * (a style bump regenerates plates) AND the plate-prompt hash: the prompt
 * folds in the theme's display/world naming (Catalog Studio overlays can
 * patch those) and the world-law card, so an overlay activation or card
 * edit resolves a NEW plate object instead of replaying the old world's.
 * @param {string} themeId
 * @param {string} promptHash fnv1a-base36 of the plate prompt
 * @returns {string}
 */
function platePath(themeId, promptHash) {
  return `catalog-assets/world-plates/${STYLE_VERSION}/${themeId}-${promptHash}.png`;
}

/**
 * The plate's generation prompt: the canonical premium-3D style block +
 * the theme's world identity + its world-law card, with hard no-character /
 * no-text rules — the plate is a pure environment reference.
 * @param {object} theme catalog theme ({theme_id, display_name, world_name})
 * @returns {string}
 */
function buildPlatePrompt(theme) {
  const lines = [
    renderStyleBlock(PIXAR_STYLE),
    `Wide establishing key art of "${theme.world_name}" — the fixed world of a children's picture book theme "${theme.display_name}".`,
    'ENVIRONMENT ONLY (hard rules): absolutely NO people, NO children, NO characters, NO animals or creatures as subjects, and NO readable text, letters, or signage anywhere in the image.',
    'This image is the book\'s world reference plate: it defines the palette, lighting, era, materials, and environment logic that every interior illustration must match.',
  ];
  const card = renderWorldCardBlock(theme.theme_id);
  if (card) lines.push(card);
  return lines.join('\n');
}

/**
 * One Gemini image call for the plate (no reference image — the plate IS
 * the reference). Kept local instead of reusing generateIllustration: that
 * path wraps scenes in child-identity prompt language a pure environment
 * plate must not carry.
 * @param {string} prompt
 * @returns {Promise<Buffer>}
 */
async function renderPlateImage(prompt) {
  let lastErr;
  for (let attempt = 1; attempt <= PLATE_ATTEMPTS; attempt++) {
    const apiKey = getNextApiKey();
    try {
      const resp = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } },
          }),
        },
        PLATE_TIMEOUT_MS,
      );
      if (!resp.ok) throw new Error(`Gemini plate render HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
      const data = await resp.json();
      const imagePart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (!imagePart) throw new Error('no image in Gemini plate response');
      return Buffer.from(imagePart.inlineData.data, 'base64');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** @param {Buffer} buffer @returns {{base64: string, mimeType: string, hash: string}} */
function toPlate(buffer) {
  const base64 = buffer.toString('base64');
  return { base64, mimeType: 'image/png', hash: fnv1a(base64).toString(36) };
}

/**
 * Resolve (or lazily create) the world plate for one theme.
 * @param {object} params
 * @param {object} params.theme catalog theme ({theme_id, display_name, world_name})
 * @param {object} [params.costTracker]
 * @param {(level: string, msg: string) => void} [params.log]
 * @returns {Promise<{base64: string, mimeType: string, hash: string}|null>}
 *   null when disabled or on any failure — the caller renders plate-less.
 */
async function getWorldPlate({ theme, costTracker, log = () => {} }) {
  if (!flags.worldPlateEnabled()) return null;
  const themeId = theme?.theme_id;
  if (!themeId || !theme.world_name) return null;
  // EVERYTHING below is fail-open — even prompt/key construction: a plate
  // problem of any shape renders plate-less, never fails the run.
  let prompt;
  let promptHash;
  try {
    prompt = buildPlatePrompt(theme);
    promptHash = fnv1a(prompt).toString(36);
  } catch (err) {
    log('warn', `world plate unavailable for theme '${themeId}' (${err.message}) — rendering without it`);
    return null;
  }
  // The cache identity is the PROMPT, not just the theme id: pinned/overlay
  // catalog definitions can carry different world naming for the same id,
  // and each must anchor on the plate rendered from ITS world.
  const key = `${themeId}:${promptHash}`;
  const hit = plateCacheGet(key);
  if (hit) return hit;
  if (_inFlight.has(key)) return _inFlight.get(key);

  const resolve = (async () => {
    const path = platePath(themeId, promptHash);
    try {
      const cached = await downloadBuffer(path).catch(() => null);
      if (cached) {
        const plate = toPlate(cached);
        plateCacheSet(key, plate);
        return plate;
      }
      log('info', `world plate for theme '${themeId}' not cached — generating (${path})`);
      const buffer = await renderPlateImage(prompt);
      if (costTracker) costTracker.addImageGeneration(GEMINI_MODEL, 1);
      // Create-if-absent: concurrent cold instances race to create the same
      // deterministic object, and exactly one write wins — every loser
      // ADOPTS the winning bytes, so all instances anchor on ONE plate
      // (nondeterministic generation would otherwise fork the world).
      let plateBuffer = buffer;
      let persisted = true;
      try {
        const { created } = await uploadBufferIfAbsent(buffer, path, 'image/png');
        if (!created) {
          // A KNOWN winner exists. Once that is known, local bytes are never
          // acceptable: failing to fetch the winner renders this run
          // plate-less (and caches nothing) rather than forking the world.
          log('info', `world plate for '${themeId}' was created concurrently — adopting the winning object`);
          try {
            plateBuffer = await downloadBuffer(path);
          } catch (winErr) {
            log('warn', `world plate for '${themeId}': lost the creation race and could not fetch the winning plate (${winErr.message}) — rendering without a plate`);
            return null;
          }
        }
      } catch (err) {
        // Upload failed BEFORE learning whether another object won — no
        // known winner to diverge from, so this run keeps its local plate
        // best-effort but does NOT cache it: the next run re-resolves
        // against GCS instead of pinning possibly-divergent bytes.
        persisted = false;
        log('warn', `world plate upload failed for '${themeId}' (${err.message}) — plate used un-persisted, not cached`);
      }
      const plate = toPlate(plateBuffer);
      if (persisted) plateCacheSet(key, plate);
      return plate;
    } catch (err) {
      log('warn', `world plate unavailable for theme '${themeId}' (${err.message}) — rendering without it`);
      return null;
    } finally {
      _inFlight.delete(key);
    }
  })();
  _inFlight.set(key, resolve);
  return resolve;
}

module.exports = { getWorldPlate, platePath, buildPlatePrompt };
