/**
 * ElevenLabs adapter (ab-1 — the DEFAULT narrator; docs/AUDIOBOOK_V2_PLAN.md
 * §4.3, open decision 1). `eleven_v3` reads inline AUDIO TAGS as
 * performance direction, so the closed direction table maps onto a CLOSED
 * tag set (one tag per line, only when the direction changes; none on the
 * `plain` rung). The `with-timestamps` endpoint returns the PCM plus a
 * character alignment, which becomes per-line timings for the read-along.
 * Pronunciation aliases ride as a pronunciation dictionary (created once
 * per (name, alias) and cached in-process), so the text keeps the real
 * name and the transcript gate still expects it.
 *
 * Vendor facts (field names, tag reliability, plan limits) are
 * verify-at-deploy: `/v13/audiobook-audition` proves a voice speaks.
 */

const { wrapPcm16 } = require('../wav');
const { providerError, fetchWithTimeout } = require('./index');

const API = 'https://api.elevenlabs.io/v1';
const SAMPLE_RATE = 44100;
const OUTPUT_FORMAT = `pcm_${SAMPLE_RATE}`;
const DEFAULT_TIMEOUT_MS = 120000;

/** Closed tag map — emotion → tag, intensity → tag. */
const EMOTION_TAGS = Object.freeze({
  joy: '[cheerfully]', wonder: '[amazed]', curiosity: '[curious]', determination: '[determined]', worry: '[nervously]',
  calm: '[calmly]', surprise: '[surprised]', pride: '[proudly]', tenderness: '[warmly]', silly: '[playfully]',
});
const INTENSITY_TAGS = Object.freeze({ soft: '[softly]', clear: '', big: '[excited]' });
const REFRAIN_TAG = '[warmly]';
const PACE_SPEED = Object.freeze({ slow: 0.9, even: 1.0, brisk: 1.05 });
const LANGUAGE_CODES = Object.freeze({ en: 'en', es: 'es', he: 'he' });

const dictionaryCache = new Map();

/**
 * The tags for one line (none on the plain rung).
 * @param {{direction: object, isRefrain: boolean}} line
 * @param {string} rung
 * @returns {string}
 */
function tagsFor(line, rung) {
  if (rung === 'plain') return '';
  if (line.isRefrain) return REFRAIN_TAG;
  const e = EMOTION_TAGS[line.direction.emotion] || '';
  const i = INTENSITY_TAGS[line.direction.intensity] || '';
  return [e, i].filter(Boolean).join(' ');
}

/**
 * The text the model receives: one paragraph per line, tagged when the
 * direction changes from the previous line.
 * @param {Array<{text: string, direction: object, isRefrain: boolean}>} lines
 * @param {string} [rung]
 * @returns {{text: string, spans: Array<{line: number, start: number, end: number}>}}
 */
function composeText(lines, rung = 'full') {
  const parts = [];
  const spans = [];
  let prev = null;
  let cursor = 0;
  lines.forEach((line, i) => {
    const tags = tagsFor(line, rung);
    const prefix = tags && tags !== prev ? `${tags} ` : '';
    prev = tags || prev;
    const piece = `${prefix}${line.text}`;
    const start = cursor + prefix.length;
    spans.push({ line: i, start, end: start + line.text.length });
    parts.push(piece);
    cursor += piece.length + 2;
  });
  return { text: parts.join('\n\n'), spans };
}

/**
 * Per-line timings from the character alignment (fail-open null).
 * @param {{characters?: string[], character_start_times_seconds?: number[], character_end_times_seconds?: number[]}} alignment
 * @param {string} text
 * @param {Array<{line: number, start: number, end: number}>} spans
 * @returns {Array<{line: number, start: number, end: number}>|null}
 */
function lineTimings(alignment, text, spans) {
  if (!alignment || !Array.isArray(alignment.characters) || !Array.isArray(alignment.character_start_times_seconds)) return null;
  const chars = alignment.characters;
  const starts = alignment.character_start_times_seconds;
  const ends = alignment.character_end_times_seconds || starts;
  // The API echoes the input characters; when it does not (normalization),
  // fall back to proportional mapping over the returned length.
  const same = chars.length === text.length;
  const ratio = chars.length / Math.max(1, text.length);
  const at = idx => Math.min(chars.length - 1, Math.max(0, same ? idx : Math.round(idx * ratio)));
  const out = [];
  for (const s of spans) {
    const a = at(s.start);
    const b = at(Math.max(s.start, s.end - 1));
    const start = starts[a];
    const end = ends[b];
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    out.push({ line: s.line, start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 });
  }
  return out;
}

/**
 * Create (once) a pronunciation dictionary holding one alias rule.
 * @param {{name: string, alias: string}} p
 * @param {{apiKey: string}} credentials
 * @param {AbortSignal} [signal]
 * @returns {Promise<{pronunciation_dictionary_id: string, version_id: string}|null>}
 */
async function aliasDictionary({ name, alias }, credentials, signal) {
  const key = `${name}=>${alias}`;
  if (dictionaryCache.has(key)) return dictionaryCache.get(key);
  const resp = await fetchWithTimeout(`${API}/pronunciation-dictionaries/add-from-rules`, {
    method: 'POST',
    headers: { 'xi-api-key': credentials.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `gmb-${name.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}-${Date.now()}`, rules: [{ string_to_replace: name, type: 'alias', alias }] }),
  }, 30000, signal);
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => null);
  const locator = data && data.id ? { pronunciation_dictionary_id: data.id, version_id: data.version_id } : null;
  dictionaryCache.set(key, locator);
  return locator;
}

/**
 * Synthesize one chunk.
 * @param {object} p
 * @param {Array<{text: string, direction: object, isRefrain: boolean}>} p.lines
 * @param {string} [p.directionWords] unused here (tags carry it) — kept for the contract
 * @param {string} [p.rung] 'full' | 'restate' | 'plain'
 * @param {{voiceId: string, model: string, settings?: object}} p.voice
 * @param {string} [p.language]
 * @param {number|null} [p.seed]
 * @param {Array<{name: string, alias: string}>} [p.aliases]
 * @param {{apiKey: string|null}} p.credentials
 * @param {AbortSignal} [p.signal]
 * @param {number} [p.timeoutMs]
 * @param {string} [p.pace]
 * @returns {Promise<{wav: Buffer, sampleRate: number, alignment: object[]|null, characters: number, model: string}>}
 */
async function synthesize({ lines, rung = 'full', voice, language = 'en', seed = null, aliases = [], credentials, signal, timeoutMs = DEFAULT_TIMEOUT_MS, pace = 'even' }) {
  if (!credentials || !credentials.apiKey) throw Object.assign(new Error('ELEVENLABS_API_KEY is not configured on the worker (and no key rode the request)'), { failureCode: 'audiobook_provider_unavailable' });
  const { text, spans } = composeText(lines, rung);
  const locators = [];
  for (const a of aliases || []) {
    const loc = await aliasDictionary(a, credentials, signal).catch(() => null);
    if (loc) locators.push(loc);
  }
  const settings = { ...(voice.settings || {}) };
  if (PACE_SPEED[pace]) settings.speed = PACE_SPEED[pace];
  const body = {
    text,
    model_id: voice.model || 'eleven_v3',
    voice_settings: settings,
    apply_text_normalization: 'auto',
    ...(LANGUAGE_CODES[language] ? { language_code: LANGUAGE_CODES[language] } : {}),
    ...(Number.isInteger(seed) ? { seed: Math.abs(seed) % 4294967295 } : {}),
    ...(locators.length ? { pronunciation_dictionary_locators: locators } : {}),
  };
  const resp = await fetchWithTimeout(`${API}/text-to-speech/${encodeURIComponent(voice.voiceId)}/with-timestamps?output_format=${OUTPUT_FORMAT}`, {
    method: 'POST',
    headers: { 'xi-api-key': credentials.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  }, timeoutMs, signal);
  if (!resp.ok) throw providerError('elevenlabs', resp.status, await resp.text().catch(() => ''));
  const data = await resp.json();
  if (!data || typeof data.audio_base64 !== 'string' || !data.audio_base64) throw new Error('elevenlabs returned no audio');
  const pcm = Buffer.from(data.audio_base64, 'base64');
  return {
    wav: wrapPcm16(pcm, SAMPLE_RATE, 1),
    sampleRate: SAMPLE_RATE,
    alignment: lineTimings(data.alignment || data.normalized_alignment, text, spans),
    characters: text.length,
    model: body.model_id,
  };
}

module.exports = {
  name: 'elevenlabs', supportsSeed: true, supportsAlignment: true, supportsAliases: true, maxChars: 4000,
  EMOTION_TAGS, INTENSITY_TAGS, REFRAIN_TAG, PACE_SPEED, tagsFor, composeText, lineTimings, aliasDictionary, synthesize, SAMPLE_RATE,
};
