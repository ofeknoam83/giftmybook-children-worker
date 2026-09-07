/**
 * The cast — pinned voices (ab-1, docs/AUDIOBOOK_V2_PLAN.md §4.2). The
 * house cast lives in data/audio/cast.json: narrator voices and companion
 * voices keyed by companion KIND, each pinned per provider. The default
 * narrator for a book is deterministic (theme, band); the request may
 * override it. The cast file's content hash folds into every take key, so
 * editing a voice never replays an old take.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isHumanCompanionType } = require('../../shared/illustration/companionKind');
const { fnv1a } = require('../selection');

const CAST_PATH = path.join(__dirname, '..', 'data', 'audio', 'cast.json');
let _cast = null;
let _hash = null;

/** @returns {object} the cast file (validated once) */
function loadCast() {
  if (_cast) return _cast;
  const raw = fs.readFileSync(CAST_PATH, 'utf8');
  const cast = JSON.parse(raw);
  if (!cast || typeof cast !== 'object' || !cast.voices || typeof cast.voices !== 'object') throw new Error('cast.json: no voices');
  for (const [key, v] of Object.entries(cast.voices)) {
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(key)) throw new Error(`cast.json: bad voice key '${key}'`);
    if (!v || !['narrator', 'companion'].includes(v.kind)) throw new Error(`cast.json: voice '${key}' has no kind`);
    if (!v.providers || typeof v.providers !== 'object' || Object.keys(v.providers).length === 0) throw new Error(`cast.json: voice '${key}' pins no provider`);
  }
  _cast = cast;
  _hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return cast;
}

/** @returns {string} content hash of the cast file (12 hex) */
function castFileHash() {
  loadCast();
  return _hash;
}

/**
 * The narrator voice keys an admin may choose from.
 * @returns {Array<{key: string, label: string, gender: string, description: string}>}
 */
function narratorOptions() {
  const cast = loadCast();
  return Object.entries(cast.voices).filter(([, v]) => v.kind === 'narrator').map(([key, v]) => ({ key, label: v.label, gender: v.gender, description: v.description || '' }));
}

/**
 * The companion voice keys.
 * @returns {Array<{key: string, label: string, gender: string, description: string}>}
 */
function companionOptions() {
  const cast = loadCast();
  return Object.entries(cast.voices).filter(([, v]) => v.kind === 'companion').map(([key, v]) => ({ key, label: v.label, gender: v.gender, description: v.description || '' }));
}

/**
 * The default companion voice key for a theme's companion — PERSON vs
 * creature by the shared companionKind rule, small vs large by the type
 * words, with per-theme overrides from the cast file.
 * @param {{theme_id?: string, themeId?: string, companion?: {name?: string, type?: string}}} theme
 * @returns {string|null} a companion voice key, or null when the theme has no named companion
 */
function companionCastKey(theme) {
  const cast = loadCast();
  const companion = theme && theme.companion;
  if (!companion || !companion.name) return null;
  const themeId = theme.theme_id || theme.themeId;
  const override = cast.defaults && cast.defaults.companionByTheme && cast.defaults.companionByTheme[themeId];
  if (override && cast.voices[override]) return override;
  if (isHumanCompanionType(companion.type)) return cast.voices.guide_adult_f ? 'guide_adult_f' : null;
  const small = new RegExp(cast.defaults && cast.defaults.smallCreaturePattern ? cast.defaults.smallCreaturePattern : '\\b(small|little|young)\\b', 'i');
  const key = small.test(String(companion.type || '')) ? 'creature_small' : 'creature_large';
  return cast.voices[key] ? key : null;
}

/**
 * The default narrator for a book: band first (1-3 always the warm
 * storyteller), then the theme table, then a seeded pick among the
 * narrators (tie-break only — deterministic per story fingerprint).
 * @param {{themeId: string, ageBand: string, seedBasis?: string}} p
 * @returns {string}
 */
function defaultNarratorKey({ themeId, ageBand, seedBasis = '' }) {
  const cast = loadCast();
  const d = cast.defaults || {};
  if (d.narratorByBand && d.narratorByBand[ageBand] && cast.voices[d.narratorByBand[ageBand]]) return d.narratorByBand[ageBand];
  if (d.narratorByTheme && d.narratorByTheme[themeId] && cast.voices[d.narratorByTheme[themeId]]) return d.narratorByTheme[themeId];
  const narrators = narratorOptions().map(o => o.key);
  return narrators[fnv1a(`${seedBasis}|${themeId}|${ageBand}`) % narrators.length];
}

/**
 * Resolve the cast for one book: the narrator voice, the companion voice
 * (null under band 1-3, when character voices are off, or when the theme
 * has none), each with the pinned provider entry for the active provider.
 * @param {object} p
 * @param {string} p.provider the narrator provider (elevenlabs | gemini | openai)
 * @param {object} p.theme catalog theme
 * @param {string} p.ageBand
 * @param {string} [p.seedBasis]
 * @param {{narrator?: string, companion?: string}} [p.request] request overrides ('none' disables the companion)
 * @param {boolean} [p.characterVoices] whether companion voices are enabled
 * @returns {{narrator: object, companion: object|null, hash: string, castFileHash: string}}
 */
function resolveCast({ provider, theme, ageBand, seedBasis, request = {}, characterVoices = true }) {
  const cast = loadCast();
  const pick = (key, kind) => {
    const v = cast.voices[key];
    if (!v || v.kind !== kind) throw Object.assign(new Error(`unknown ${kind} voice '${key}'`), { statusCode: 400 });
    const pinned = v.providers[provider];
    if (!pinned) throw Object.assign(new Error(`voice '${key}' is not pinned for provider '${provider}'`), { statusCode: 400 });
    return { key, label: v.label, gender: v.gender, kind, provider, ...pinned, hash: fnv1a(`${key}|${provider}|${JSON.stringify(pinned)}`).toString(36) };
  };
  const narratorKey = request.narrator || defaultNarratorKey({ themeId: theme.theme_id || theme.themeId, ageBand, seedBasis });
  const narrator = pick(narratorKey, 'narrator');
  let companion = null;
  const wantsCompanion = characterVoices && ageBand !== '1-3' && request.companion !== 'none';
  if (wantsCompanion) {
    const companionKey = request.companion || companionCastKey(theme);
    if (companionKey) companion = pick(companionKey, 'companion');
  }
  const hash = fnv1a(`${castFileHash()}|${narrator.hash}|${companion ? companion.hash : 'none'}`).toString(36);
  return { narrator, companion, hash, castFileHash: castFileHash() };
}

/** Test hook: forget the cached cast file. */
function resetCastCache() { _cast = null; _hash = null; }

module.exports = { loadCast, castFileHash, narratorOptions, companionOptions, companionCastKey, defaultNarratorKey, resolveCast, resetCastCache, CAST_PATH };
