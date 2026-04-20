/**
 * Game Voices Generator (M2)
 *
 * Synthesizes every dialogue line to MP3 using Google Cloud Text-to-Speech
 * REST API (via google-auth-library ADC — same credentials already used
 * for GCS). Uploads each clip to GCS and returns a manifest
 * `{ [lineId]: signedUrl }` that the client pre-loads once at boot.
 *
 * We intentionally use the REST API (not @google-cloud/text-to-speech) to
 * avoid adding another heavy dep; the worker already depends on
 * google-auth-library transitively.
 */

'use strict';

const { GoogleAuth } = require('google-auth-library');
const { uploadBuffer } = require('./gcsStorage');

const TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const AUTH_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

const auth = new GoogleAuth({ scopes: AUTH_SCOPES });

// Voice assignment per speaker. Picked from the Chirp3-HD / Studio pools for
// warmth; fallback to Wavenet if region/model not available.
const VOICE_MAP = {
  narrator: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Aoede', ssmlGender: 'FEMALE' },
  mom:      { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Kore',   ssmlGender: 'FEMALE' },
  dad:      { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Puck',   ssmlGender: 'MALE' },
  child:    { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Leda',   ssmlGender: 'FEMALE' },
  sibling:  { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Zephyr', ssmlGender: 'FEMALE' },
  cat:      { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Leda',   ssmlGender: 'FEMALE' },
  dog:      { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Puck',   ssmlGender: 'MALE' },
  bunny:    { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Leda',   ssmlGender: 'FEMALE' },
};
const FALLBACK_VOICE = { languageCode: 'en-US', name: 'en-US-Wavenet-F', ssmlGender: 'FEMALE' };

async function getAccessToken() {
  const client = await auth.getClient();
  const tokenResp = await client.getAccessToken();
  const tok = typeof tokenResp === 'string' ? tokenResp : tokenResp?.token;
  if (!tok) throw new Error('Failed to obtain Google access token for TTS');
  return tok;
}

async function synthesizeOne({ token, text, voice, audioConfig }) {
  const body = {
    input: { text },
    voice,
    audioConfig,
  };
  const resp = await fetch(TTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    // Retry once with the universally-available fallback voice if the Chirp3
    // voice is unavailable in this project/region.
    if (voice !== FALLBACK_VOICE && /voice/i.test(errText)) {
      return synthesizeOne({ token, text, voice: FALLBACK_VOICE, audioConfig });
    }
    throw new Error(`TTS ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (!data?.audioContent) throw new Error('TTS returned no audioContent');
  return Buffer.from(data.audioContent, 'base64');
}

/**
 * @param {object} input
 * @param {string} input.bookId
 * @param {Object.<string,{text:string,speaker:string}>} input.dialogues
 * @param {string} [input.gender] 'boy'|'girl'|null — tweak child voice selection
 * @returns {Promise<{voices: Object.<string,string>, tookMs: number, count: number}>}
 */
async function generateGameVoices(input) {
  const started = Date.now();
  const { bookId, dialogues, gender } = input || {};
  if (!bookId) throw new Error('bookId is required');
  if (!dialogues || typeof dialogues !== 'object') throw new Error('dialogues is required');

  const token = await getAccessToken();
  const audioConfig = {
    audioEncoding: 'MP3',
    speakingRate: 1.0,
    pitch: 0.0,
    sampleRateHertz: 24000,
  };

  // Prefer boy child voice for male protagonists.
  const voiceMap = { ...VOICE_MAP };
  if (gender === 'boy') {
    voiceMap.child   = { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Puck', ssmlGender: 'MALE' };
    voiceMap.sibling = { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Fenrir', ssmlGender: 'MALE' };
  }

  const entries = Object.entries(dialogues).filter(([, v]) => v && typeof v.text === 'string' && v.text.trim());

  const voices = {};
  const CONCURRENCY = 4;
  let i = 0;
  async function worker() {
    while (i < entries.length) {
      const idx = i++;
      const [lineId, entry] = entries[idx];
      const voice = voiceMap[entry.speaker] || voiceMap.narrator || FALLBACK_VOICE;
      try {
        const buf = await synthesizeOne({ token, text: entry.text, voice, audioConfig });
        const dest = `children-game/${bookId}/voices/${encodeURIComponent(lineId)}.mp3`;
        const url = await uploadBuffer(buf, dest, 'audio/mpeg');
        voices[lineId] = url;
      } catch (err) {
        console.warn(`[gameVoices] ${lineId} failed: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));

  return {
    voices,
    count: Object.keys(voices).length,
    tookMs: Date.now() - started,
  };
}

module.exports = { generateGameVoices, VOICE_MAP };
