/**
 * Eleven Music (ab-1 — the second music provider; docs/AUDIOBOOK_V2_PLAN.md
 * §4.5): `POST /v1/music` composes an instrumental from a prompt and a
 * length in milliseconds and answers MP3 bytes. Field names are
 * verify-at-deploy.
 */

const { providerError, fetchWithTimeout } = require('../../providers');

const API = 'https://api.elevenlabs.io/v1/music';
const DEFAULT_MODEL = 'music_v1';
const DEFAULT_TIMEOUT_MS = 180000;

/**
 * @param {{prompt: string, negativePrompt?: string, seconds?: number, seed?: number, credentials?: {apiKey?: string}, signal?: AbortSignal, timeoutMs?: number}} p
 * @returns {Promise<{buffer: Buffer, mimeType: string, model: string, seconds: number}>}
 */
async function generate({ prompt, negativePrompt = '', seconds = 30, credentials = {}, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const apiKey = credentials.apiKey || process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw Object.assign(new Error('ELEVENLABS_API_KEY is not configured for the music provider'), { failureCode: 'audiobook_provider_unavailable' });
  const model = process.env.CATALOG_AUDIO_MUSIC_MODEL || DEFAULT_MODEL;
  const resp = await fetchWithTimeout(`${API}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ prompt: negativePrompt ? `${prompt} Avoid: ${negativePrompt}.` : prompt, music_length_ms: Math.round(seconds * 1000), model_id: model, force_instrumental: true }),
  }, timeoutMs, signal);
  if (!resp.ok) throw providerError('elevenlabs-music', resp.status, await resp.text().catch(() => ''));
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length < 1000) throw new Error('eleven music returned no audio');
  return { buffer, mimeType: 'audio/mpeg', model, seconds };
}

module.exports = { name: 'elevenlabs', DEFAULT_MODEL, generate };
