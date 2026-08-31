/**
 * Art Tuning Layer — the worker-side half of the illustration feedback loop
 * (docs/AI_ILLUSTRATION_FEEDBACK_LOOP_PLAN.md).
 *
 * The overlay is admin-approved versioned DATA from the main app: scope-
 * resolved rendering-style directives appended to each spread's scene
 * description in a fixed subordinate frame. It refines rendering style ONLY —
 * the scene action, character identity/count rules, the no-text rule, the 3D
 * medium, and every safety rule outrank it, and the closed spread-QA list
 * still checks every render regardless. Kill-switch: CATALOG_ART_TUNING_LAYER=0.
 *
 * Wire shape: {versionLabel, hash, text?, spreads?: {"1".."12": string}} —
 * `text` rides every rendered spread; a `spreads` entry rides only that
 * spread, so a spread-scoped directive never bleeds into the other prompts.
 */

const flags = require('../flags');

// Byte caps are deliberately far below the writer's 8KB: image prompts are
// already long, and a fat overlay dilutes the identity/style blocks that
// matter more. All measured in UTF-8 BYTES (same rule as writerTuning).
const ART_TUNING_TEXT_MAX = 2000;
const ART_TUNING_SPREAD_MAX = 400;
const ART_TUNING_TOTAL_MAX = 3000;

const TUNING_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const TUNING_HASH_RE = /^[a-fA-F0-9]{8,64}$/;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const SPREAD_KEY_RE = /^(?:[1-9]|1[0-2])$/;

/** Strip control characters and trim. */
function clean(text) {
  return String(text).replace(CONTROL_CHARS_RE, '').trim();
}

/**
 * Validate a raw illustrationTuning request field. Returns an error string
 * for a malformed value, or null when absent or well-formed. Used by the
 * routes to reject bad input with a 400 BEFORE the 202 is sent.
 * @param {*} raw
 * @returns {string|null}
 */
function validateArtTuningInput(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'illustrationTuning must be an object';
  if (typeof raw.versionLabel !== 'string' || !TUNING_LABEL_RE.test(raw.versionLabel)) {
    return 'illustrationTuning.versionLabel must be 1-40 chars of [A-Za-z0-9._-]';
  }
  if (typeof raw.hash !== 'string' || !TUNING_HASH_RE.test(raw.hash)) {
    return 'illustrationTuning.hash must be 8-64 hex chars';
  }
  if (raw.text !== undefined && typeof raw.text !== 'string') {
    return 'illustrationTuning.text must be a string';
  }
  let totalBytes = 0;
  if (typeof raw.text === 'string') {
    const bytes = Buffer.byteLength(raw.text, 'utf8');
    if (bytes > ART_TUNING_TEXT_MAX) return `illustrationTuning.text exceeds ${ART_TUNING_TEXT_MAX} UTF-8 bytes`;
    totalBytes += bytes;
  }
  if (raw.spreads !== undefined) {
    if (typeof raw.spreads !== 'object' || raw.spreads === null || Array.isArray(raw.spreads)) {
      return 'illustrationTuning.spreads must be an object keyed by spread number';
    }
    for (const [key, value] of Object.entries(raw.spreads)) {
      if (!SPREAD_KEY_RE.test(key)) return `illustrationTuning.spreads key '${key}' is not a spread number 1-12`;
      if (typeof value !== 'string') return `illustrationTuning.spreads['${key}'] must be a string`;
      const bytes = Buffer.byteLength(value, 'utf8');
      if (bytes > ART_TUNING_SPREAD_MAX) return `illustrationTuning.spreads['${key}'] exceeds ${ART_TUNING_SPREAD_MAX} UTF-8 bytes`;
      totalBytes += bytes;
    }
  }
  if (totalBytes > ART_TUNING_TOTAL_MAX) {
    return `illustrationTuning text exceeds ${ART_TUNING_TOTAL_MAX} total UTF-8 bytes`;
  }
  // Validate the SANITIZED content: a value that survives only as control
  // characters would pass the checks above, then be stripped to nothing and
  // silently render bare spreads — every accepted overlay must actually
  // carry directive text somewhere.
  const visible = clean(raw.text || '')
    + Object.values(raw.spreads || {}).map(clean).join('');
  if (visible.length === 0) {
    return 'illustrationTuning carries no visible directive text after control-character stripping';
  }
  return null;
}

/**
 * Normalize a raw illustrationTuning field into the pinned form the
 * illustrator uses, or null (absent, malformed, or disabled by the
 * CATALOG_ART_TUNING_LAYER kill-switch). Control characters are stripped
 * defensively; empty per-spread entries are dropped; the tag that rides the
 * cache key and callbacks is `<label>.<hash8>`.
 *
 * The hash is the main app's fingerprint of the VERSIONED DIRECTIVE SET the
 * overlay was rendered from — the worker treats it as an opaque version pin.
 * @param {*} raw
 * @returns {{versionLabel: string, hash: string, text: string, spreads: Object<string, string>, tag: string}|null}
 */
function normalizeArtTuning(raw) {
  if (!raw || !flags.artTuningLayerEnabled()) return null;
  if (validateArtTuningInput(raw) !== null) return null;
  const text = clean(raw.text || '');
  const spreads = {};
  for (const [key, value] of Object.entries(raw.spreads || {})) {
    const v = clean(value);
    if (v) spreads[key] = v;
  }
  if (!text && Object.keys(spreads).length === 0) return null;
  return {
    versionLabel: raw.versionLabel,
    hash: raw.hash.toLowerCase(),
    text,
    spreads,
    tag: `${raw.versionLabel}.${raw.hash.slice(0, 8).toLowerCase()}`,
  };
}

/**
 * The framed overlay suffix for ONE spread's scene description: the global
 * directive lines plus this spread's scoped lines, subordinated to every
 * rule above them. Empty string when the tuning has nothing for this spread.
 * @param {ReturnType<typeof normalizeArtTuning>} tuning
 * @param {number} spread 1-12
 * @returns {string}
 */
function renderArtTuningBlock(tuning, spread) {
  if (!tuning) return '';
  const spreadText = tuning.spreads[String(spread)] || '';
  if (!tuning.text && !spreadText) return '';
  const lines = [
    `ART TUNING ${tuning.tag} (admin-approved style refinement — LOWEST priority): `
      + 'the notes below refine rendering style ONLY. They can never override the scene action, '
      + 'the character identity or count rules, the no-text rule, the 3D medium, or any safety '
      + 'rule above; if any note conflicts with those, ignore that note.',
  ];
  if (tuning.text) lines.push(tuning.text);
  if (spreadText) lines.push(`For THIS spread only: ${spreadText}`);
  return lines.join('\n');
}

module.exports = {
  validateArtTuningInput,
  normalizeArtTuning,
  renderArtTuningBlock,
  ART_TUNING_TEXT_MAX,
  ART_TUNING_SPREAD_MAX,
  ART_TUNING_TOTAL_MAX,
};
