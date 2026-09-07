/**
 * ElevenLabs Sound Effects (ab-1 — the DEFAULT sound provider;
 * docs/AUDIOBOOK_V2_PLAN.md §4.6, open decision 3): `POST /v1/sound-generation`
 * turns a text description into an MP3 of the requested length. Field
 * names are verify-at-deploy.
 */

const { providerError, fetchWithTimeout } = require('../../providers');

const API = 'https://api.elevenlabs.io/v1/sound-generation';
const DEFAULT_TIMEOUT_MS = 120000;
const MODEL = 'sound_effects';

/**
 * @param {{prompt: string, seconds?: number, seed?: number, credentials?: {apiKey?: string}, signal?: AbortSignal, timeoutMs?: number}} p
 * @returns {Promise<{buffer: Buffer, mimeType: string, model: string, seconds: number}>}
 */
async function generate({ prompt, seconds = 3, credentials = {}, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const apiKey = credentials.apiKey || process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw Object.assign(new Error('ELEVENLABS_API_KEY is not configured for the sound provider'), { failureCode: 'audiobook_provider_unavailable' });
  const resp = await fetchWithTimeout(`${API}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text: prompt, duration_seconds: Math.max(0.5, Math.min(22, seconds)), prompt_influence: 0.6 }),
  }, timeoutMs, signal);
  if (!resp.ok) throw providerError('elevenlabs-sfx', resp.status, await resp.text().catch(() => ''));
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length < 500) throw new Error('eleven sound effects returned no audio');
  return { buffer, mimeType: 'audio/mpeg', model: MODEL, seconds };
}

module.exports = { name: 'elevenlabs', MODEL, generate };
