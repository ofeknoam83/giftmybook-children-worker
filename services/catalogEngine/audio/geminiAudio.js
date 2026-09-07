/**
 * Strict-JSON judge calls on the Gemini QA model with AUDIO parts (ab-1):
 * the speech-to-text + performance verdict per take (takeQa.js), the
 * music-cue and sound-cue election judges (music/suites.js,
 * sfx/library.js), the listen-through gate (gates.js) and the director's
 * text-only refinement (director.js). One transport, the ONE
 * generationConfig every judge in the illustrator uses
 * (`jsonQaGenerationConfig`), the tolerant parse, the cost line.
 *
 * Audio rides inline (`inline_data`, base64) — a 16 kHz mono WAV of a take
 * is ~2 MB per minute, a 192 kbps MP3 of a whole book ~1.4 MB per minute,
 * both far under the 20 MB inline limit; callers pass excerpts for
 * anything longer (gates.js).
 */

const { fetchWithTimeout, getNextApiKey } = require('../../illustrationGenerator');
const { jsonQaGenerationConfig, responseText, parseJsonText, unparseableDetail } = require('../../shared/llm/geminiJson');
const flags = require('../flags');

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 90000;
const MAX_INLINE_BYTES = 18 * 1024 * 1024;

/**
 * One strict-JSON call with optional audio parts.
 * @param {object} p
 * @param {string} p.prompt
 * @param {Array<{buffer: Buffer, mimeType: string}>} [p.audio] audio parts, in order, BEFORE the prompt
 * @param {object} [p.schema] Gemini responseSchema
 * @param {string} [p.model] default: the STT/QA model flag
 * @param {number} [p.maxOutputTokens]
 * @param {number} [p.timeoutMs]
 * @param {object} [p.costTracker]
 * @param {AbortSignal} [p.signal]
 * @param {string} [p.apiKey] explicit key (default: the pool)
 * @returns {Promise<{json: object, model: string, usage: {promptTokens: number, candidateTokens: number}}>}
 */
async function judgeAudio({ prompt, audio = [], schema, model, maxOutputTokens, timeoutMs = DEFAULT_TIMEOUT_MS, costTracker, signal, apiKey }) {
  const m = model || flags.audioSttModel();
  const key = apiKey || getNextApiKey();
  if (!key) throw Object.assign(new Error('no Gemini API key is configured for the audio judge'), { failureCode: 'audiobook_provider_unavailable' });
  const parts = [];
  for (const a of audio) {
    if (!a || !Buffer.isBuffer(a.buffer) || a.buffer.length === 0) continue;
    if (a.buffer.length > MAX_INLINE_BYTES) throw new Error(`audio part of ${a.buffer.length} bytes exceeds the inline limit`);
    parts.push({ inline_data: { mime_type: a.mimeType || 'audio/wav', data: a.buffer.toString('base64') } });
  }
  parts.push({ text: prompt });
  const generationConfig = { ...jsonQaGenerationConfig(maxOutputTokens, m), ...(schema ? { responseSchema: schema } : {}) };
  const resp = await fetchWithTimeout(`${GEMINI_API}/${m}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
  }, timeoutMs, signal);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const e = new Error(`audio judge HTTP ${resp.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    e.statusCode = resp.status;
    throw e;
  }
  const data = await resp.json();
  const usage = data && data.usageMetadata ? { promptTokens: data.usageMetadata.promptTokenCount || 0, candidateTokens: data.usageMetadata.candidatesTokenCount || 0 } : { promptTokens: 0, candidateTokens: 0 };
  if (costTracker && typeof costTracker.addTextUsage === 'function') costTracker.addTextUsage(m, usage.promptTokens, usage.candidateTokens);
  const text = responseText(data);
  let json;
  try {
    json = parseJsonText(text);
  } catch (err) {
    throw new Error(`audio judge returned unparseable JSON${unparseableDetail(data, text)}`);
  }
  if (!json || typeof json !== 'object') throw new Error('audio judge returned no object');
  return { json, model: m, usage };
}

module.exports = { judgeAudio, GEMINI_API, MAX_INLINE_BYTES };
