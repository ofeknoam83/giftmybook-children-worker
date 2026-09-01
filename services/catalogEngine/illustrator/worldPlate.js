/**
 * World reference plate — the per-theme FIXED environment reference image
 * (Layer 2 of the cross-spread world-consistency design).
 *
 * One establishing key art per theme (environment only — no child, no
 * companion, no characters, no text), generated once through the shared
 * Gemini image client, cached in GCS under STYLE_VERSION, and attached to
 * EVERY spread render as a second reference image beside the identity
 * anchor. Because the plate is identical on every spread, each stateless
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
const { downloadBuffer, uploadBuffer } = require('../../gcsStorage');
const { renderWorldCardBlock } = require('../worldCards');
const { STYLE_VERSION } = require('../versions');
const { fnv1a } = require('../selection');
const flags = require('../flags');

const PLATE_TIMEOUT_MS = 180000;
const PLATE_ATTEMPTS = 2;

// In-process caches: plates are per-theme per-STYLE_VERSION (12 themes max),
// so a warm instance resolves each plate's bytes once. The in-flight map
// dedupes concurrent first-use generation across parallel renders.
const _plates = new Map();
const _inFlight = new Map();

/**
 * Deterministic GCS path for one theme's plate. STYLE_VERSION-keyed: a
 * style bump (which also covers worldCards.json edits) regenerates plates.
 * @param {string} themeId
 * @returns {string}
 */
function platePath(themeId) {
  return `catalog-assets/world-plates/${STYLE_VERSION}/${themeId}.png`;
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
  if (_plates.has(themeId)) return _plates.get(themeId);
  if (_inFlight.has(themeId)) return _inFlight.get(themeId);

  const resolve = (async () => {
    const path = platePath(themeId);
    try {
      const cached = await downloadBuffer(path).catch(() => null);
      if (cached) {
        const plate = toPlate(cached);
        _plates.set(themeId, plate);
        return plate;
      }
      log('info', `world plate for theme '${themeId}' not cached — generating (${path})`);
      const buffer = await renderPlateImage(buildPlatePrompt(theme));
      if (costTracker) costTracker.addImageGeneration(GEMINI_MODEL, 1);
      // Best-effort persist: a failed upload only means the next instance
      // regenerates; this run still anchors on the plate it just made.
      await uploadBuffer(buffer, path, 'image/png').catch((err) => {
        log('warn', `world plate upload failed for '${themeId}' (${err.message}) — plate used un-persisted`);
      });
      const plate = toPlate(buffer);
      _plates.set(themeId, plate);
      return plate;
    } catch (err) {
      log('warn', `world plate unavailable for theme '${themeId}' (${err.message}) — rendering without it`);
      return null;
    } finally {
      _inFlight.delete(themeId);
    }
  })();
  _inFlight.set(themeId, resolve);
  return resolve;
}

module.exports = { getWorldPlate, platePath, buildPlatePrompt };
