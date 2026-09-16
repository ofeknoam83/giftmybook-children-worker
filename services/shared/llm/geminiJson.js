/**
 * Strict-JSON calls on the Gemini QA model — the ONE generationConfig every
 * vision/text judge in the illustrator uses, and the tolerant parse of what
 * comes back.
 *
 * Why this exists (2026-09-02 incident): `gemini-2.5-flash` is a THINKING
 * model whose reasoning tokens count against `maxOutputTokens`. A judge
 * that capped the answer at 256 tokens (the ce-9 character-sheet judge) had
 * its whole budget spent on reasoning before the JSON started, so every
 * candidate came back empty or clipped (`finishReason: MAX_TOKENS`) and
 * read as "unparseable JSON" — with the sheet REQUIRED, every book failed
 * `identity_kit_failed`. The deleted pipeline had already learned this
 * (QA_MAX_OUTPUT_TOKENS = 4096, thinkingBudget 0 in config.js); the
 * ce-9 judges were written against the small legacy caps instead.
 *
 * Perception questions ("is there readable text?", "same child?") gain
 * nothing from a reasoning pass, so thinking is held to the model's
 * minimum: the 3.x family (`gemini-3.5-flash`, `gemini-3.1-pro-preview`,
 * the default since the 2026-09-16 migration) takes a thinking LEVEL
 * (`thinkingLevel: MINIMAL` by default — CATALOG_QA_THINKING_LEVEL; a 3.x
 * request carrying BOTH `thinkingBudget` and `thinkingLevel` is a 400),
 * the legacy 2.5 flash family takes a zero BUDGET (`thinkingBudget: 0`;
 * 2.5 Pro cannot go below 128 and older models reject the field, so
 * neither gets a thinkingConfig), and the output ceiling never drops below
 * QA_MIN_OUTPUT_TOKENS. A transport that meets a 400 naming the thinking
 * field retries ONCE without it (`isThinkingFieldError` + `stripThinking`)
 * — the `imageSize` pattern in illustrationGenerator.
 */

const { qaVisionModel, qaThinkingLevel } = require('./models');

/** The floor for any strict-JSON QA answer (the largest legitimate verdict is ~400 tokens). */
const QA_MIN_OUTPUT_TOKENS = 2048;

/**
 * Whether the model accepts `thinkingConfig.thinkingBudget: 0` (the legacy
 * 2.5 flash family only; kept for compatibility — the 3.x family takes a
 * level, see `thinkingConfigFor`).
 * @param {string} model
 * @returns {boolean}
 */
function supportsZeroThinking(model) {
  return /gemini-2\.5-flash/i.test(String(model || ''));
}

/**
 * The thinkingConfig a strict-JSON judge sends to a model: a zero BUDGET on
 * the 2.5 flash family, a thinking LEVEL on the 3.x family (never both —
 * the API rejects the pair), nothing for every other model.
 * @param {string} model
 * @param {string} [level] a 3.x thinking level (default: CATALOG_QA_THINKING_LEVEL)
 * @returns {{thinkingBudget: number}|{thinkingLevel: string}|null}
 */
function thinkingConfigFor(model, level = qaThinkingLevel()) {
  const id = String(model || '');
  if (supportsZeroThinking(id)) return { thinkingBudget: 0 };
  if (/gemini-3/i.test(id)) return { thinkingLevel: level };
  return null;
}

/**
 * generationConfig for a strict-JSON judge call.
 * @param {number} [maxOutputTokens] the caller's ceiling — raised to the floor
 * @param {string} [model] the model the call targets (default: the QA model)
 * @param {{thinkingLevel?: string}} [opts] `thinkingLevel` overrides the env level on a 3.x model
 * @returns {{temperature: number, maxOutputTokens: number, responseMimeType: string, thinkingConfig?: {thinkingBudget: number}|{thinkingLevel: string}}}
 */
function jsonQaGenerationConfig(maxOutputTokens, model = qaVisionModel(), opts = {}) {
  const requested = Number.isInteger(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : QA_MIN_OUTPUT_TOKENS;
  const thinkingConfig = thinkingConfigFor(model, opts && opts.thinkingLevel ? opts.thinkingLevel : undefined);
  return {
    temperature: 0,
    maxOutputTokens: Math.max(QA_MIN_OUTPUT_TOKENS, requested),
    responseMimeType: 'application/json',
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };
}

/**
 * Whether a failed response is the model rejecting the thinking field
 * (a 400 whose body names `thinking` — an id that takes a budget being sent
 * a level, or the reverse) — the one failure a transport retries once
 * without `thinkingConfig`.
 * @param {number} status HTTP status
 * @param {string} bodyText the error body
 * @returns {boolean}
 */
function isThinkingFieldError(status, bodyText) {
  return Number(status) === 400 && /thinking/i.test(String(bodyText || ''));
}

/**
 * The same generationConfig without its `thinkingConfig` (a new object; the
 * input is never mutated).
 * @param {object} config
 * @returns {object}
 */
function stripThinking(config) {
  const { thinkingConfig, ...rest } = config || {}; // eslint-disable-line no-unused-vars
  return rest;
}

/**
 * The text of a generateContent response (all text parts of the first
 * candidate, joined) — '' when there is none.
 * @param {*} data parsed response body
 * @returns {string}
 */
function responseText(data) {
  return (data?.candidates?.[0]?.content?.parts || []).map(p => (typeof p?.text === 'string' ? p.text : '')).join('');
}

/**
 * Why a response may carry no usable JSON — the candidate's finishReason
 * (MAX_TOKENS = the cap was spent, SAFETY = blocked) or the prompt-level
 * block reason; null when the response is ordinary.
 * @param {*} data parsed response body
 * @returns {string|null}
 */
function finishReasonOf(data) {
  const reason = data?.candidates?.[0]?.finishReason;
  if (typeof reason === 'string' && reason && reason !== 'STOP') return reason;
  const blocked = data?.promptFeedback?.blockReason;
  return typeof blocked === 'string' && blocked ? `blocked: ${blocked}` : null;
}

/**
 * Parse a strict-JSON answer tolerantly: code fences and any prose around
 * the ONE object are dropped. Throws when no object parses (a clipped
 * answer has no closing brace — that is the caller's "unparseable" case).
 * @param {string} text
 * @returns {*}
 */
function parseJsonText(text) {
  const raw = String(text || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim();
  try {
    return JSON.parse(raw);
  } catch (err) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) throw err;
    return JSON.parse(raw.slice(start, end + 1));
  }
}

/**
 * One-line diagnosis for an unparseable answer: the finish reason and how
 * much text came back, so the advisory says WHY (a clipped budget, a
 * safety block, an empty body) instead of just "unparseable".
 * @param {*} data parsed response body
 * @param {string} text the response text
 * @returns {string} '' when nothing notable
 */
function unparseableDetail(data, text) {
  const reason = finishReasonOf(data);
  const len = String(text || '').trim().length;
  if (!reason && len > 0) return '';
  const bits = [];
  if (reason) bits.push(`finishReason: ${reason}`);
  bits.push(len === 0 ? 'empty response' : `${len} chars`);
  return ` (${bits.join(', ')})`;
}

module.exports = {
  QA_MIN_OUTPUT_TOKENS,
  supportsZeroThinking,
  thinkingConfigFor,
  jsonQaGenerationConfig,
  isThinkingFieldError,
  stripThinking,
  responseText,
  finishReasonOf,
  parseJsonText,
  unparseableDetail,
};
