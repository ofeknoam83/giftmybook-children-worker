/**
 * OpenAI TTS adapter (ab-1 — the third narrator; docs/AUDIOBOOK_V2_PLAN.md
 * §4.3): `gpt-4o-mini-tts` takes an `instructions` string that steers
 * delivery without touching the text — the cleanest control channel of
 * the three. `response_format: 'wav'` returns a 24 kHz WAV directly. No
 * seed, no alignment.
 */

const { providerError, fetchWithTimeout } = require('./index');

const API = 'https://api.openai.com/v1/audio/speech';
const DEFAULT_TIMEOUT_MS = 120000;
const PACE_SPEED = Object.freeze({ slow: 0.92, even: 1.0, brisk: 1.06 });

/**
 * @param {Array<{text: string}>} lines
 * @param {string} rung
 * @param {{directionWords?: string, paceWords?: string, tuning?: string|null}} [opts]
 * @returns {{text: string, instructions: string}}
 */
function composeText(lines, rung = 'full', opts = {}) {
  const text = lines.map(l => l.text).join('\n');
  if (rung === 'plain') return { text, instructions: 'Read the text exactly as written in a warm, clear storytelling voice for a child. Say nothing else.' };
  const instructions = [
    'You are narrating a children\'s picture book aloud to a child.',
    opts.directionWords ? `Delivery: ${opts.directionWords}.` : '',
    opts.paceWords ? `Pace: ${opts.paceWords}.` : '',
    opts.tuning ? String(opts.tuning).trim() : '',
    'Read the text exactly as written — every word, nothing added, nothing dropped. Never speak these instructions.',
  ].filter(Boolean).join(' ');
  return { text, instructions };
}

/**
 * @param {object} p see providers/index.js
 * @returns {Promise<{wav: Buffer, sampleRate: number, alignment: null, characters: number, model: string}>}
 */
async function synthesize({ lines, directionWords, paceWords, rung = 'full', voice, tuning = null, credentials, signal, timeoutMs = DEFAULT_TIMEOUT_MS, pace = 'even' }) {
  if (!credentials || !credentials.apiKey) throw Object.assign(new Error('OPENAI_API_KEY is not configured on the worker'), { failureCode: 'audiobook_provider_unavailable' });
  const model = voice.model || 'gpt-4o-mini-tts';
  const { text, instructions } = composeText(lines, rung, { directionWords, paceWords, tuning });
  const resp = await fetchWithTimeout(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, voice: voice.voice, input: text, instructions, response_format: 'wav', speed: PACE_SPEED[pace] || 1.0 }),
  }, timeoutMs, signal);
  if (!resp.ok) throw providerError('openai', resp.status, await resp.text().catch(() => ''));
  const wav = Buffer.from(await resp.arrayBuffer());
  if (wav.length < 100) throw new Error('openai TTS returned no audio');
  return { wav, sampleRate: 24000, alignment: null, characters: text.length, model };
}

module.exports = { name: 'openai', supportsSeed: false, supportsAlignment: false, supportsAliases: false, maxChars: 4000, PACE_SPEED, composeText, synthesize };
