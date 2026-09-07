/**
 * Lyria on Vertex AI (ab-1 — the DEFAULT music provider; docs/AUDIOBOOK_V2_PLAN.md
 * §4.5, open decision 2): the existing Google account, bearer-authenticated
 * through google-auth-library (the identity-metrics precedent), the
 * `:predict` endpoint of the Lyria music model. The answer is a WAV
 * (48 kHz stereo, ~30 s for lyria-002) as `bytesBase64Encoded`. The model
 * id, project and location are revision configuration
 * (`CATALOG_AUDIO_MUSIC_MODEL`, `GOOGLE_CLOUD_PROJECT`,
 * `CATALOG_AUDIO_MUSIC_LOCATION`) — verify-at-deploy facts.
 */

const { providerError, fetchWithTimeout } = require('../../providers');

const DEFAULT_MODEL = 'lyria-002';
const DEFAULT_LOCATION = 'us-central1';
const DEFAULT_TIMEOUT_MS = 180000;
let _authClient = null;

/** @returns {Promise<string|null>} */
async function accessToken() {
  if (!_authClient) {
    let lib;
    try { lib = require('google-auth-library'); } catch { return null; } // eslint-disable-line global-require
    _authClient = new lib.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }
  const token = await _authClient.getAccessToken();
  const value = token && typeof token === 'object' ? token.token : token;
  return typeof value === 'string' && value ? value : null;
}

/**
 * @param {{prompt: string, negativePrompt?: string, seconds?: number, seed?: number, credentials?: {accessToken?: string}, signal?: AbortSignal, timeoutMs?: number}} p
 * @returns {Promise<{buffer: Buffer, mimeType: string, model: string, seconds: number}>}
 */
async function generate({ prompt, negativePrompt = '', seconds = 30, seed = 1, credentials = {}, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  if (!project) throw Object.assign(new Error('GOOGLE_CLOUD_PROJECT is not set — the Lyria music provider is unavailable'), { failureCode: 'audiobook_provider_unavailable' });
  const token = credentials.accessToken || await accessToken();
  if (!token) throw Object.assign(new Error('no Google access token for Vertex AI (google-auth-library unavailable)'), { failureCode: 'audiobook_provider_unavailable' });
  const model = process.env.CATALOG_AUDIO_MUSIC_MODEL || DEFAULT_MODEL;
  const location = process.env.CATALOG_AUDIO_MUSIC_LOCATION || DEFAULT_LOCATION;
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:predict`;
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [{ prompt, ...(negativePrompt ? { negative_prompt: negativePrompt } : {}), seed: Number(seed) || 1 }], parameters: { sample_count: 1 } }),
  }, timeoutMs, signal);
  if (!resp.ok) throw providerError('lyria', resp.status, await resp.text().catch(() => ''));
  const data = await resp.json();
  const pred = data && Array.isArray(data.predictions) ? data.predictions[0] : null;
  const b64 = pred && (pred.bytesBase64Encoded || pred.audioContent);
  if (!b64) throw new Error('lyria returned no audio');
  return { buffer: Buffer.from(b64, 'base64'), mimeType: (pred.mimeType || 'audio/wav'), model, seconds };
}

module.exports = { name: 'lyria', DEFAULT_MODEL, generate };
