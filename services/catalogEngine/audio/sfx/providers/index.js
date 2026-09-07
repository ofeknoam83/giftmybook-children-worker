/**
 * Sound-effect provider registry (ab-1 §4.6). Adapter contract:
 *   generate({prompt, seconds, seed, credentials, signal})
 *     → {buffer: Buffer, mimeType: string, model: string, seconds: number}
 * `library` means no generator (cues without elected audio are skipped).
 */

const flags = require('../../../flags');

const ADAPTERS = {
  elevenlabs: () => require('./elevenlabs'),
  library: () => ({ name: 'library', generate: async () => { throw new Error('the library provider does not generate'); } }),
};

/**
 * @param {{provider?: string|null}} [req]
 * @returns {{ok: true, provider: string, adapter: object}|{ok: false, error: string}}
 */
function resolveSfxProvider(req = {}) {
  const provider = String(req.provider || flags.audioSfxProvider()).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ADAPTERS, provider)) return { ok: false, error: `sound provider '${provider}' is not implemented (known: ${Object.keys(ADAPTERS).join(', ')})` };
  return { ok: true, provider, adapter: ADAPTERS[provider]() };
}

module.exports = { ADAPTERS, resolveSfxProvider };
