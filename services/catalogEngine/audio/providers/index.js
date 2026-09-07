/**
 * Narrator provider registry (ab-1, docs/AUDIOBOOK_V2_PLAN.md §4.3). Only
 * implemented adapters are selectable; `CATALOG_AUDIO_NARRATOR_PROVIDER`
 * names the default. Credentials come from the revision's env or the copy
 * the app injects into the request body (the REPLICATE_API_TOKEN pattern).
 *
 * Adapter contract (every adapter):
 *   name, supportsSeed, supportsAlignment, supportsAliases, maxChars
 *   synthesize({lines, directionWords, paceWords, rung, voice, language, seed,
 *               tuning, aliases, credentials, signal, timeoutMs})
 *     → {wav: Buffer, sampleRate, alignment: [{line, start, end}]|null, characters, model}
 *   composeText(lines, rung) → the text the provider receives (tests)
 */

const flags = require('../../flags');

const ADAPTERS = {
  elevenlabs: () => require('./elevenlabs'),
  gemini: () => require('./gemini'),
  openai: () => require('./openai'),
};

/**
 * Resolve the adapter for a request.
 * @param {{provider?: string|null}} [req]
 * @returns {{ok: true, provider: string, adapter: object}|{ok: false, error: string}}
 */
function resolveNarratorProvider(req = {}) {
  const provider = String(req.provider || flags.audioNarratorProvider()).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ADAPTERS, provider)) {
    return { ok: false, error: `narrator provider '${provider}' is not implemented (known: ${Object.keys(ADAPTERS).join(', ')})` };
  }
  return { ok: true, provider, adapter: ADAPTERS[provider]() };
}

/**
 * The credentials for a provider: env first, then the request-injected copy.
 * @param {string} provider
 * @param {{ELEVENLABS_API_KEY?: string, apiKeys?: object}} [injected] request body fields
 * @returns {{apiKey: string|null}}
 */
function providerCredentials(provider, injected = {}) {
  const keys = injected && injected.apiKeys && typeof injected.apiKeys === 'object' ? injected.apiKeys : {};
  if (provider === 'elevenlabs') return { apiKey: process.env.ELEVENLABS_API_KEY || injected.ELEVENLABS_API_KEY || keys.ELEVENLABS_API_KEY || null };
  if (provider === 'openai') return { apiKey: process.env.OPENAI_API_KEY || keys.OPENAI_API_KEY || null };
  if (provider === 'gemini') return { apiKey: keys.GEMINI_API_KEY || null }; // null → the worker's key pool
  return { apiKey: null };
}

/**
 * A classified provider HTTP failure.
 * @param {string} provider
 * @param {number} status
 * @param {string} detail
 * @returns {Error}
 */
function providerError(provider, status, detail) {
  const e = new Error(`${provider} refused the request (HTTP ${status}): ${String(detail || '').slice(0, 300)}`);
  e.statusCode = status;
  e.transient = status === 429 || status >= 500;
  e.failureCode = status === 401 || status === 402 || status === 403
    ? 'audiobook_provider_unavailable'
    : (status === 400 || status === 422 ? 'audiobook_provider_input_rejected' : 'audiobook_provider_error');
  return e;
}

/**
 * fetch with a timeout and an optional parent abort signal; returns the raw
 * Response (callers read JSON or bytes).
 * @param {string} url
 * @param {object} opts
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, opts, timeoutMs, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); throw new Error('cancelled'); }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') throw Object.assign(new Error(`provider request timed out after ${Math.round(timeoutMs / 1000)}s`), { transient: true });
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = { ADAPTERS, resolveNarratorProvider, providerCredentials, providerError, fetchWithTimeout };
