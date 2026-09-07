/**
 * Name pronunciation, verified and pinned (ab-1, docs/AUDIOBOOK_V2_PLAN.md
 * §4.3): once per (name, language, voice) the name is synthesized ALONE,
 * transcribed, and compared; on a mismatch up to three respellings from
 * ONE strict-JSON text call are each synthesized and transcribed, and the
 * first that is heard is pinned as the ALIAS under
 * `catalog-assets/pronunciations/{AUDIO_VERSION}/{lang}/…` — the outfit
 * lock of the voice: derived once, verified, pinned. None passing is an
 * advisory (STT itself is fallible on names), never a blocker.
 */

const crypto = require('crypto');
const { AUDIO_VERSION } = require('../versions');
const { judgeAudio } = require('./geminiAudio');
const { transcribeTake } = require('./takeQa');
const { compareSpoken, measureTake } = require('./metrics');
const { loadJson, saveJson } = require('../../gcsStorage');
const flags = require('../flags');

const RESPELL_SCHEMA = { type: 'OBJECT', properties: { respellings: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['respellings'] };
const LANGUAGE_NAMES = Object.freeze({ en: 'English', es: 'Spanish', he: 'Hebrew' });

/**
 * The election key for one (name, language, voice).
 * @param {string} name
 * @param {string} language
 * @param {string} voiceHash
 * @returns {string}
 */
function pronunciationKey(name, language, voiceHash) {
  const h = crypto.createHash('sha256').update(String(name).normalize('NFC').toLowerCase()).digest('hex').slice(0, 12);
  return `catalog-assets/pronunciations/${AUDIO_VERSION}/${language}/${h}-${voiceHash}.json`;
}

/**
 * Up to three phonetic respellings of a name for a text-to-speech voice.
 * @param {string} name
 * @param {string} language
 * @param {object} [costTracker]
 * @param {AbortSignal} [signal]
 * @returns {Promise<string[]>}
 */
async function respellings(name, language, costTracker, signal) {
  const { json } = await judgeAudio({
    prompt: `A text-to-speech voice mispronounces the name "${name}". Give up to three alternative spellings of the SAME name that a ${LANGUAGE_NAMES[language] || 'English'} text-to-speech voice would pronounce correctly (phonetic respellings, for example "Sair-uh" for "Sarah"). Return JSON only: {"respellings": ["..."]}.`,
    schema: RESPELL_SCHEMA,
    costTracker,
    signal,
    maxOutputTokens: 512,
  });
  return (Array.isArray(json.respellings) ? json.respellings : []).filter(s => typeof s === 'string' && s.trim() && s.length <= 40).map(s => s.trim()).slice(0, 3);
}

/**
 * Whether one synthesized take of the name alone is heard as the name.
 * @param {object} p
 * @returns {Promise<{heard: boolean, transcript: string}>}
 */
async function hearName({ name, alias, adapter, voice, language, credentials, costTracker, signal }) {
  const r = await adapter.synthesize({
    lines: [{ text: `${name}.`, direction: { emotion: 'calm', intensity: 'clear', pace: 'even', shape: 'statement' }, isRefrain: false }],
    directionWords: 'clear and neutral', paceWords: 'an easy pace', rung: 'plain', voice, language, seed: 7,
    aliases: alias ? [{ name, alias }] : [], credentials, signal, pace: 'even',
  });
  const measure = measureTake(r.wav);
  if (measure.trimmedSeconds < 0.2) return { heard: false, transcript: '' };
  const { transcript } = await transcribeTake({ wav: r.wav, expectedText: name, directionWords: 'clear and neutral', name, costTracker, signal });
  const cmp = compareSpoken(name, transcript, { name, alias });
  return { heard: cmp.nameHeard === true, transcript };
}

/**
 * Ensure a verified pronunciation for a name on a voice — the pinned
 * record, or a fresh election.
 * @param {object} p
 * @param {string} p.name
 * @param {string} p.language
 * @param {object} p.voice the cast entry (with `hash`)
 * @param {object} p.adapter narrator adapter
 * @param {{apiKey: string|null}} p.credentials
 * @param {object} [p.costTracker]
 * @param {(level: string, msg: string) => void} [p.log]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{name: string, status: 'verified'|'alias'|'unverified'|'skipped', alias: string|null, transcript: string|null, cached: boolean}>}
 */
async function ensurePronunciation({ name, language = 'en', voice, adapter, credentials, costTracker, log = () => {}, signal }) {
  if (!name || !String(name).trim()) return { name: name || '', status: 'skipped', alias: null, transcript: null, cached: false };
  if (!flags.audioTranscriptQaEnabled()) return { name, status: 'skipped', alias: null, transcript: null, cached: false };
  const key = pronunciationKey(name, language, voice.hash);
  const pinned = await loadJson(key).catch(() => null);
  if (pinned && pinned.status) return { ...pinned, cached: true };
  const record = { name, language, voiceKey: voice.key, status: 'unverified', alias: null, transcript: null, checkedAt: new Date().toISOString() };
  try {
    const first = await hearName({ name, alias: null, adapter, voice, language, credentials, costTracker, signal });
    record.transcript = first.transcript;
    if (first.heard) {
      record.status = 'verified';
    } else if (adapter.supportsAliases) {
      for (const alias of await respellings(name, language, costTracker, signal).catch(() => [])) {
        const r = await hearName({ name, alias, adapter, voice, language, credentials, costTracker, signal });
        if (r.heard) { record.status = 'alias'; record.alias = alias; record.transcript = r.transcript; break; }
      }
    }
    log('info', `pronunciation of "${name}" on ${voice.key}: ${record.status}${record.alias ? ` (alias "${record.alias}")` : ''}`);
  } catch (err) {
    log('warn', `pronunciation check for "${name}" failed (${err.message}) — unverified`);
    record.status = 'unverified';
    record.error = err.message;
    return { ...record, cached: false };
  }
  try { await saveJson(record, key); } catch (err) { log('warn', `pronunciation pin failed (${err.message})`); }
  return { ...record, cached: false };
}

module.exports = { pronunciationKey, respellings, hearName, ensurePronunciation, RESPELL_SCHEMA };
