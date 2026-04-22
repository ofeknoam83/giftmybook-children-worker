/**
 * promptSanitizer.js — last-mile sanitizer for text we're about to send to Gemini.
 *
 * Why this exists on top of validation.js#sanitizeForPrompt:
 *   sanitizeForPrompt() runs ONCE at the API boundary on a handful of user
 *   fields (childName, customDetails, anecdotes, emotionalSituation, ...).
 *   By the time those fields reach Gemini they've been interpolated into
 *   system prompts, writer-generated beats, story-bible entries, and
 *   per-spread scene descriptions — all of which can reintroduce invisible
 *   characters, homoglyph-driven role injections, or trigger phrasings that
 *   Gemini's classifier flags as `blockReason=OTHER`. Once that happens on a
 *   spread, retrying in-session keeps hitting the same block, and even a
 *   session rebuild can't recover because the per-spread prompt (the actual
 *   culprit) is re-sent verbatim.
 *
 *   This module is the WIRE-LAYER sanitizer: it runs on every `text` part of
 *   the request body just before POST, independent of where the text came
 *   from. It's deliberately conservative — the goal is to remove noise
 *   (invisibles, directional overrides, homoglyphs, lingering role tags)
 *   without changing the story's meaning.
 */

const { sanitizeMixedScriptString } = require('./writer/quality/sanitize');

/**
 * Invisibles / directional controls that can sneak into LLM output via copy-paste
 * or multilingual fallback and confuse the safety classifier:
 *   U+200B..U+200D  zero-width space / non-joiner / joiner
 *   U+2028,U+2029   line/paragraph separators
 *   U+FEFF          BOM / zero-width no-break space
 *   U+202A..U+202E  LRE / RLE / PDF / LRO / RLO (directional overrides — most
 *                   weaponized vector for hidden prompt injection)
 *   U+2066..U+2069  LRI / RLI / FSI / PDI
 */
const INVISIBLE_RE = new RegExp('[\\u200B-\\u200D\\u2028\\u2029\\uFEFF\\u202A-\\u202E\\u2066-\\u2069]', 'g');

/**
 * ASCII / C1 control characters that should never appear in a prompt. Keeps
 * the common whitespace: \t (0x09), \n (0x0A), \r (0x0D).
 */
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g;

/**
 * Role-injection patterns — same list as validation.js INJECTION_PATTERNS but
 * duplicated here so the wire-layer sanitizer is self-contained (avoids a
 * cross-import cycle between validation.js and writer/).
 */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/gi,
  /ignore\s+(all\s+)?above/gi,
  /disregard\s+(all\s+)?previous/gi,
  /system\s*:\s*/gi,
  /\bassistant\s*:\s*/gi,
  /\buser\s*:\s*/gi,
  /```\s*(system|assistant|user)/gi,
  /<\/?(?:system|prompt|instruction|role)[^>]*>/gi,
];

/**
 * Image-mode softeners — these apply only when the prompt is being sent to the
 * Gemini IMAGE model (which uses a stricter safety classifier than the text
 * model). Each entry rewrites a phrase that we ourselves inject into spread
 * prompts and that, read out of context, looks threatening enough to trip
 * `blockReason=OTHER`.
 *
 * Do NOT add story-content words here (blood, fight, scared, ...). User-facing
 * themes like grief/fear legitimately use those words; rewriting them would
 * corrupt the narrative. Only soften META-directives the engine writes itself.
 */
const IMAGE_SOFTENERS = [
  [/\bNEVER\s+draw\b/gi, 'do not draw'],
  [/\bNEVER\s+show\b/gi, 'do not show'],
  [/\bblack\s+(rectangle|bar|box|patch|blob)\b/gi, 'dark shape'],
  [/\bcensor\s+(block|bar|rectangle)\b/gi, 'obscured shape'],
  [/\bopaque\s+black\b/gi, 'solid dark'],
];

/**
 * Normalize a prompt string for Gemini.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {'text'|'image'} [opts.mode='text'] - 'image' applies extra softeners
 *   for the image model's stricter safety classifier.
 * @returns {string}
 */
function sanitizeForGemini(text, opts = {}) {
  if (typeof text !== 'string' || !text) return '';

  let out = text;
  try { out = out.normalize('NFKC'); } catch { /* leave unchanged on platforms without full ICU */ }

  out = out.replace(INVISIBLE_RE, '');
  out = out.replace(CONTROL_RE, '');
  out = sanitizeMixedScriptString(out);

  for (const pattern of INJECTION_PATTERNS) {
    out = out.replace(pattern, '');
  }

  if (opts.mode === 'image') {
    for (const [re, replacement] of IMAGE_SOFTENERS) {
      out = out.replace(re, replacement);
    }
  }

  out = out.replace(/[ \t]{3,}/g, '  ');
  out = out.replace(/\n{4,}/g, '\n\n\n');

  return out;
}

/**
 * Sanitize every `text` field inside a Gemini `parts` array in place-safe
 * fashion (returns a new array; untouched non-text parts are reused by
 * reference). Image parts (inline_data / inlineData) are left alone.
 *
 * @param {Array<object>} parts
 * @param {object} [opts]
 * @returns {Array<object>}
 */
function sanitizeParts(parts, opts) {
  if (!Array.isArray(parts)) return parts;
  return parts.map(part => {
    if (part && typeof part.text === 'string') {
      return { ...part, text: sanitizeForGemini(part.text, opts) };
    }
    return part;
  });
}

/**
 * Sanitize an entire history array (Gemini chat contents). Each message's
 * `parts` is run through sanitizeParts(). Non-text parts (images) are
 * preserved as-is. Roles and thoughtSignature fields are preserved.
 *
 * @param {Array<{role: string, parts: Array<object>}>} history
 * @param {object} [opts]
 * @returns {Array<{role: string, parts: Array<object>}>}
 */
function sanitizeHistory(history, opts) {
  if (!Array.isArray(history)) return history;
  return history.map(msg => ({ ...msg, parts: sanitizeParts(msg.parts, opts) }));
}

module.exports = {
  sanitizeForGemini,
  sanitizeParts,
  sanitizeHistory,
};
