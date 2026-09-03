/**
 * Provider registry (gift video, gv-1 — docs/GIFT_VIDEO_PLAN.md §4.4).
 *
 * Only adapters that are implemented are selectable; `CATALOG_VIDEO_PROVIDERS`
 * narrows that set further and names the default (its first entry). A
 * request may name a provider/model pair; both must be allowed, and the
 * model must be served by that provider.
 */

const flags = require('../../flags');
const { modelProfile } = require('./models');

const ADAPTERS = {
  replicate: () => require('./replicate'),
};

/**
 * Providers an admin may select: the configured list ∩ implemented adapters.
 * @returns {string[]}
 */
function allowedProviders() {
  return flags.videoProviders().filter(p => Object.prototype.hasOwnProperty.call(ADAPTERS, p));
}

/**
 * Resolve the provider + model for a request (defaults from the flags).
 * @param {{provider?: string|null, model?: string|null}} [req]
 * @returns {{ok: true, provider: string, model: string, adapter: object, profile: object}|{ok: false, error: string}}
 */
function resolveProvider(req = {}) {
  const allowed = allowedProviders();
  if (allowed.length === 0) return { ok: false, error: 'no video provider is configured (CATALOG_VIDEO_PROVIDERS names no implemented adapter)' };
  const provider = req.provider ? String(req.provider).toLowerCase() : allowed[0];
  if (!allowed.includes(provider)) return { ok: false, error: `provider '${provider}' is not enabled (allowed: ${allowed.join(', ')})` };
  const model = req.model ? String(req.model) : flags.videoModel();
  if (!/^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,96}$/.test(model)) return { ok: false, error: `model '${model}' is not a valid model id` };
  const profile = modelProfile(model);
  if (!profile) return { ok: false, error: `model '${model}' has no profile (known: ${Object.keys(require('./models').MODELS).join(', ')})` };
  if (profile.provider !== provider) return { ok: false, error: `model '${model}' is served by '${profile.provider}', not '${provider}'` };
  return { ok: true, provider, model, adapter: ADAPTERS[provider](), profile };
}

module.exports = { resolveProvider, allowedProviders, ADAPTERS };
