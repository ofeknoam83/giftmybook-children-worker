/**
 * Music provider registry (ab-1 §4.5). Adapter contract:
 *   generate({prompt, negativePrompt, seconds, seed, credentials, signal})
 *     → {buffer: Buffer, mimeType: string, model: string, seconds: number}
 * `library` is the CC0 floor (no generation; suites.js reads the files).
 */

const flags = require('../../../flags');

const ADAPTERS = {
  lyria: () => require('./lyria'),
  elevenlabs: () => require('./elevenlabs'),
  library: () => ({ name: 'library', generate: async () => { throw new Error('the library provider does not generate'); } }),
};

/**
 * @param {{provider?: string|null}} [req]
 * @returns {{ok: true, provider: string, adapter: object}|{ok: false, error: string}}
 */
function resolveMusicProvider(req = {}) {
  const provider = String(req.provider || flags.audioMusicProvider()).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ADAPTERS, provider)) return { ok: false, error: `music provider '${provider}' is not implemented (known: ${Object.keys(ADAPTERS).join(', ')})` };
  return { ok: true, provider, adapter: ADAPTERS[provider]() };
}

module.exports = { ADAPTERS, resolveMusicProvider };
