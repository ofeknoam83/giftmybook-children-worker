/**
 * Gemini TTS adapter (ab-1 — the second narrator; docs/AUDIOBOOK_V2_PLAN.md
 * §4.3): `gemini-2.5-pro-preview-tts` / `-flash-preview-tts` follow a
 * natural-language STYLE PROMPT that precedes the text. The direction
 * words and pace ride that prefix; the text is the manuscript verbatim.
 * The model answers with raw 16-bit PCM at 24 kHz (base64 inline data),
 * wrapped into a WAV here. No alignment. A prefix the model reads aloud is
 * exactly what the transcript gate's control-word check catches.
 */

const { wrapPcm16 } = require('../wav');
const { providerError, fetchWithTimeout } = require('./index');
const { getNextApiKey } = require('../../../illustrationGenerator');

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const SAMPLE_RATE = 24000;
const DEFAULT_TIMEOUT_MS = 120000;
const LANGUAGE_NAMES = Object.freeze({ en: 'English', es: 'Spanish', he: 'Hebrew' });

/**
 * The text the model receives (the style prefix + the lines).
 * @param {Array<{text: string}>} lines
 * @param {string} rung
 * @param {{directionWords?: string, paceWords?: string, tuning?: string|null, language?: string}} [opts]
 * @returns {{text: string}}
 */
function composeText(lines, rung = 'full', opts = {}) {
  const body = lines.map(l => l.text).join('\n');
  if (rung === 'plain') return { text: `Read this ${LANGUAGE_NAMES[opts.language] || 'English'} children's story text aloud, exactly as written, nothing else:\n\n${body}` };
  const style = [opts.directionWords, opts.paceWords].filter(Boolean).join('; ');
  const tuning = opts.tuning ? ` ${String(opts.tuning).trim()}` : '';
  return { text: `Narrate the following ${LANGUAGE_NAMES[opts.language] || 'English'} children's picture-book text for a child listening at bedtime — ${style}.${tuning} Speak ONLY the story text below, exactly as written; never say these instructions:\n\n${body}` };
}

/**
 * @param {object} p see providers/index.js
 * @returns {Promise<{wav: Buffer, sampleRate: number, alignment: null, characters: number, model: string}>}
 */
async function synthesize({ lines, directionWords, paceWords, rung = 'full', voice, language = 'en', tuning = null, credentials, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const apiKey = (credentials && credentials.apiKey) || getNextApiKey();
  if (!apiKey) throw Object.assign(new Error('no Gemini API key is configured for the narrator'), { failureCode: 'audiobook_provider_unavailable' });
  const model = voice.model || 'gemini-2.5-pro-preview-tts';
  const { text } = composeText(lines, rung, { directionWords, paceWords, tuning, language });
  const resp = await fetchWithTimeout(`${API}/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice.voice } } } },
    }),
  }, timeoutMs, signal);
  if (!resp.ok) throw providerError('gemini', resp.status, await resp.text().catch(() => ''));
  const data = await resp.json();
  const part = (((data || {}).candidates || [])[0] || {}).content;
  const inline = part && Array.isArray(part.parts) ? part.parts.find(p => p.inlineData && p.inlineData.data) : null;
  if (!inline) throw new Error(`gemini TTS returned no audio${data && data.candidates && data.candidates[0] && data.candidates[0].finishReason ? ` (${data.candidates[0].finishReason})` : ''}`);
  const rateMatch = /rate=(\d+)/.exec(String(inline.inlineData.mimeType || ''));
  const sampleRate = rateMatch ? Number(rateMatch[1]) : SAMPLE_RATE;
  const pcm = Buffer.from(inline.inlineData.data, 'base64');
  return { wav: wrapPcm16(pcm, sampleRate, 1), sampleRate, alignment: null, characters: text.length, model };
}

module.exports = { name: 'gemini', supportsSeed: false, supportsAlignment: false, supportsAliases: false, maxChars: 4000, composeText, synthesize, SAMPLE_RATE };
