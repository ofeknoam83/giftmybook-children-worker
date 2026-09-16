/**
 * The Gemini model registry — ONE place for every text/vision/audio model id
 * the worker calls by name, each behind its own env knob.
 *
 * Why (2026-09-16 migration): `gemini-2.5-flash` / `-flash-lite` shut down
 * on 2026-10-16 (earliest) and `gemini-2.5-pro` no earlier than that. The
 * ids used to be literals in twenty-odd call sites (judges, the text
 * fallback, the audio transcript, the TTS narrator); a migration meant
 * touching every one. Now a call site asks the registry, and a deploy pins
 * a different id with an env var, never a code change.
 *
 * Every accessor reads its env at CALL time (trimmed; empty → the default)
 * so a test or a Cloud Run revision can override it without a module
 * reload. Image generation is NOT here: `GEMINI_IMAGE_MODEL`
 * (`gemini-3.1-flash-image`) stays in shared/illustration/config.js.
 *
 *  - CATALOG_QA_VISION_MODEL     — every strict-JSON vision / text judge
 *                                  (default `gemini-3.5-flash`).
 *  - CATALOG_QA_PRO_MODEL        — the Pro tier for a caller that asks for
 *                                  one (default `gemini-3.1-pro-preview`).
 *  - CATALOG_TEXT_FALLBACK_MODEL — the Gemini text model openaiClient
 *                                  falls back to (default `gemini-3.5-flash`).
 *  - CATALOG_AUDIO_STT_MODEL     — the audio-input judge (transcripts, the
 *                                  listen-through; default `gemini-3.5-flash`).
 *  - CATALOG_AUDIO_TTS_MODEL     — the Gemini TTS narrator when a cast voice
 *                                  names no model (default
 *                                  `gemini-3.1-flash-tts-preview`).
 *  - CATALOG_QA_SECONDARY_MODEL  — the reviewed-fallback judge for a saved
 *                                  provider block (NO default: empty
 *                                  disables the reviewed fallback).
 *  - CATALOG_QA_THINKING_LEVEL   — the thinking level sent to 3.x models
 *                                  (`MINIMAL` | `LOW` | `MEDIUM` | `HIGH`,
 *                                  default `MINIMAL`; anything else → the
 *                                  default).
 */

const DEFAULT_QA_VISION_MODEL = 'gemini-3.5-flash';
const DEFAULT_PRO_MODEL = 'gemini-3.1-pro-preview';
const DEFAULT_TEXT_FALLBACK_MODEL = 'gemini-3.5-flash';
const DEFAULT_AUDIO_MODEL = 'gemini-3.5-flash';
const DEFAULT_TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const DEFAULT_QA_THINKING_LEVEL = 'MINIMAL';

/** The thinking levels the 3.x family accepts (`thinkingConfig.thinkingLevel`). */
const THINKING_LEVELS = Object.freeze(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);

/**
 * One env value, trimmed; '' when unset or blank.
 * @param {string} name
 * @returns {string}
 */
function envString(name) {
  const raw = process.env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * One model id from its env knob, or the default when the env is unset or
 * blank.
 * @param {string} name env var
 * @param {string} fallback
 * @returns {string}
 */
function modelFromEnv(name, fallback) {
  return envString(name) || fallback;
}

/**
 * The strict-JSON vision / text judge model (`CATALOG_QA_VISION_MODEL`).
 * @returns {string}
 */
function qaVisionModel() {
  return modelFromEnv('CATALOG_QA_VISION_MODEL', DEFAULT_QA_VISION_MODEL);
}

/**
 * The Pro-tier model (`CATALOG_QA_PRO_MODEL`).
 * @returns {string}
 */
function proModel() {
  return modelFromEnv('CATALOG_QA_PRO_MODEL', DEFAULT_PRO_MODEL);
}

/**
 * The Gemini text model openaiClient falls back to
 * (`CATALOG_TEXT_FALLBACK_MODEL`).
 * @returns {string}
 */
function textFallbackModel() {
  return modelFromEnv('CATALOG_TEXT_FALLBACK_MODEL', DEFAULT_TEXT_FALLBACK_MODEL);
}

/**
 * The audio-input judge model (`CATALOG_AUDIO_STT_MODEL`).
 * @returns {string}
 */
function audioModel() {
  return modelFromEnv('CATALOG_AUDIO_STT_MODEL', DEFAULT_AUDIO_MODEL);
}

/**
 * The Gemini TTS model (`CATALOG_AUDIO_TTS_MODEL`).
 * @returns {string}
 */
function ttsModel() {
  return modelFromEnv('CATALOG_AUDIO_TTS_MODEL', DEFAULT_TTS_MODEL);
}

/**
 * The reviewed-fallback judge (`CATALOG_QA_SECONDARY_MODEL`) — null when
 * unset or blank, which DISABLES the reviewed fallback. There is no default
 * on purpose: a second model that may receive a child's evidence after an
 * admin review is an explicit deployment decision.
 * @returns {string|null}
 */
function secondaryReviewModel() {
  return envString('CATALOG_QA_SECONDARY_MODEL') || null;
}

/**
 * The thinking level for 3.x judges (`CATALOG_QA_THINKING_LEVEL`),
 * validated against the four levels (case-insensitive); an unknown value
 * falls back to the default.
 * @returns {'MINIMAL'|'LOW'|'MEDIUM'|'HIGH'}
 */
function qaThinkingLevel() {
  const level = envString('CATALOG_QA_THINKING_LEVEL').toUpperCase();
  return THINKING_LEVELS.includes(level) ? level : DEFAULT_QA_THINKING_LEVEL;
}

module.exports = {
  THINKING_LEVELS,
  DEFAULT_QA_VISION_MODEL,
  DEFAULT_PRO_MODEL,
  DEFAULT_TEXT_FALLBACK_MODEL,
  DEFAULT_AUDIO_MODEL,
  DEFAULT_TTS_MODEL,
  DEFAULT_QA_THINKING_LEVEL,
  qaVisionModel,
  proModel,
  textFallbackModel,
  audioModel,
  ttsModel,
  secondaryReviewModel,
  qaThinkingLevel,
};
