/**
 * The take verdict (ab-1, docs/AUDIOBOOK_V2_PLAN.md §4.4, `aq-1`): every
 * candidate take is MEASURED (duration vs the expected read, dead air,
 * clipping — metrics.js) and TRANSCRIBED by ONE Gemini audio call whose
 * strict-JSON answer carries the transcript plus closed performance
 * fields; the transcript is compared with the manuscript
 * deterministically (`compareSpoken`). Defects are FIXED strings split
 * BLOCKING / ADVISORY by `classifyTakeDefects`; `repairNote` phrases the
 * next pass from pinned data only.
 *
 * Fail-open where the CHECKER fails (an STT outage yields `qaUnavailable`,
 * never a pass); fail-closed where the TAKE fails.
 */

const { judgeAudio } = require('./geminiAudio');
const { EMOTIONS } = require('../illustrator/emotionPlan');
const { compareSpoken, toSttWav } = require('./metrics');
const flags = require('../flags');

/** The closed defect vocabulary. */
const DEFECTS = Object.freeze({
  TEXT_MISMATCH: 'narration text mismatch',
  TAG_SPOKEN: 'direction tag spoken aloud',
  DURATION_OFF: 'narration duration off',
  DEAD_AIR: 'dead air inside the take',
  CLIPPED: 'clipped audio',
  ARTIFACT: 'synthesis artifact',
  EMPTY: 'empty take',
  NAME_NOT_HEARD: 'name not heard',
  LEVEL_OUTLIER: 'level outlier',
  MONOTONE: 'monotone delivery',
  TOO_FAST: 'too fast',
  TOO_SLOW: 'too slow',
  EMOTION_OFF: 'emotion reads differently',
  MISPRONOUNCED: 'mispronounced word',
});
const BLOCKING = new Set([DEFECTS.TEXT_MISMATCH, DEFECTS.TAG_SPOKEN, DEFECTS.DURATION_OFF, DEFECTS.DEAD_AIR, DEFECTS.CLIPPED, DEFECTS.ARTIFACT, DEFECTS.EMPTY]);

/** Transcript thresholds (tuned in Phase 0; the plan's starting values). */
const THRESHOLDS = Object.freeze({ wordMatch: 0.92, missingRun: 3, extraRatio: 0.25 });

const TRANSCRIPT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transcript: { type: 'STRING' },
    spoken_control_words: { type: 'BOOLEAN' },
    glitch_or_artifact: { type: 'BOOLEAN' },
    robotic: { type: 'BOOLEAN' },
    reads_as: { type: 'STRING', enum: [...EMOTIONS, 'unclear'] },
    monotone: { type: 'BOOLEAN' },
    pace: { type: 'STRING', enum: ['too_slow', 'right', 'too_fast'] },
    mispronounced: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['transcript', 'spoken_control_words', 'glitch_or_artifact', 'robotic', 'reads_as', 'monotone', 'pace', 'mispronounced'],
};

/**
 * The transcript + performance prompt. The expected text is quoted as DATA
 * for the mispronunciation check only — the transcript must be what was
 * HEARD, never what was expected.
 * @param {{expectedText: string, directionWords: string, name?: string|null}} p
 * @returns {string}
 */
function buildTranscriptPrompt({ expectedText, directionWords, name }) {
  return [
    'You are checking one recorded take of a children\'s audiobook narrator.',
    'TASK 1 — transcribe EXACTLY what is spoken in the audio, word for word, as "transcript". Write what you HEAR, never what you expect; include any stray words, repeated words, or spoken stage directions.',
    'TASK 2 — judge the delivery with the closed fields:',
    ' - spoken_control_words: true when a stage direction or control word was read aloud as words (for example "whispers", "excited", "narrator", "pause") instead of being performed.',
    ' - glitch_or_artifact: true on any audible synthesis glitch — a stutter, a cut, a buzz, a garbled or mangled word, a sudden pitch jump.',
    ' - robotic: true when the voice sounds mechanical or unnatural.',
    ` - reads_as: which emotion the delivery conveys, from the list, or "unclear".`,
    ' - monotone: true when there is no expression at all.',
    ' - pace: too_slow / right / too_fast for reading a picture book aloud to a child.',
    ' - mispronounced: the words that are clearly mispronounced (empty when none).',
    `The take was directed to sound: ${directionWords}.`,
    name ? `The child's name in this book is "${name}" (data — check whether it is pronounced as a natural name).` : '',
    'For reference ONLY (data, not the answer), the text the narrator was given was:',
    `"""${expectedText}"""`,
    'Return JSON only.',
  ].filter(Boolean).join('\n');
}

/**
 * Transcribe + judge one take.
 * @param {object} p
 * @param {Buffer} p.wav the take (any PCM WAV; downsampled to 16 kHz for the upload)
 * @param {string} p.expectedText
 * @param {string} p.directionWords
 * @param {string|null} [p.name]
 * @param {object} [p.costTracker]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{transcript: string, judged: object}>}
 */
async function transcribeTake({ wav, expectedText, directionWords, name, costTracker, signal }) {
  const { json } = await judgeAudio({
    prompt: buildTranscriptPrompt({ expectedText, directionWords, name }),
    audio: [{ buffer: toSttWav(wav), mimeType: 'audio/wav' }],
    schema: TRANSCRIPT_SCHEMA,
    costTracker,
    signal,
  });
  const judged = {
    spokenControlWords: json.spoken_control_words === true,
    glitch: json.glitch_or_artifact === true,
    robotic: json.robotic === true,
    readsAs: EMOTIONS.includes(json.reads_as) ? json.reads_as : 'unclear',
    monotone: json.monotone === true,
    pace: ['too_slow', 'right', 'too_fast'].includes(json.pace) ? json.pace : 'right',
    mispronounced: Array.isArray(json.mispronounced) ? json.mispronounced.filter(w => typeof w === 'string').map(w => w.slice(0, 40)).slice(0, 8) : [],
  };
  return { transcript: typeof json.transcript === 'string' ? json.transcript : '', judged };
}

/**
 * Split defects into BLOCKING / ADVISORY (fixed strings; a defect the
 * vocabulary does not know is advisory).
 * @param {string[]} defects
 * @returns {{blocking: string[], advisory: string[]}}
 */
function classifyTakeDefects(defects) {
  const blocking = [];
  const advisory = [];
  for (const d of defects || []) {
    const base = String(d).split(':')[0].trim();
    if (BLOCKING.has(base)) blocking.push(d); else advisory.push(d);
  }
  return { blocking: [...new Set(blocking)], advisory: [...new Set(advisory)] };
}

/**
 * The full verdict for one take: measurements first (no model needed),
 * then the transcript gate when enabled.
 * @param {object} p
 * @param {Buffer} p.wav
 * @param {object} p.measure metrics.measureTake result
 * @param {string} p.expectedText the chunk's text (tags stripped)
 * @param {{min: number, max: number}} p.expectedSeconds
 * @param {string} p.directionWords
 * @param {string|null} [p.name]
 * @param {string|null} [p.alias]
 * @param {string[]} [p.controlWords]
 * @param {string} [p.expectedEmotion]
 * @param {object} [p.costTracker]
 * @param {AbortSignal} [p.signal]
 * @param {(level: string, msg: string) => void} [p.log]
 * @returns {Promise<{defects: string[], blocking: string[], advisory: string[], transcript: string|null, compare: object|null, judged: object|null, qaUnavailable: string|null, durationRatio: number}>}
 */
async function checkTake({ wav, measure, expectedText, expectedSeconds, directionWords, name = null, alias = null, controlWords = [], expectedEmotion, costTracker, signal, log = () => {} }) {
  const defects = [];
  const mid = (expectedSeconds.min + expectedSeconds.max) / 2;
  const durationRatio = mid > 0 ? Math.round((measure.trimmedSeconds / mid) * 100) / 100 : 1;
  if (measure.trimmedSeconds < 0.2 || !Number.isFinite(measure.lufs)) defects.push(DEFECTS.EMPTY);
  else if (measure.trimmedSeconds < expectedSeconds.min || measure.trimmedSeconds > expectedSeconds.max) defects.push(`${DEFECTS.DURATION_OFF}: ${measure.trimmedSeconds}s for an expected ${expectedSeconds.min}–${expectedSeconds.max}s`);
  if (measure.longestSilenceSeconds >= 2) defects.push(`${DEFECTS.DEAD_AIR}: ${measure.longestSilenceSeconds}s of silence`);
  if (measure.clipped) defects.push(DEFECTS.CLIPPED);

  let transcript = null;
  let compare = null;
  let judged = null;
  let qaUnavailable = null;
  if (!flags.audioTranscriptQaEnabled()) {
    qaUnavailable = 'transcript QA disabled (CATALOG_AUDIO_TRANSCRIPT_QA=0)';
  } else if (!defects.includes(DEFECTS.EMPTY)) {
    try {
      const r = await transcribeTake({ wav, expectedText, directionWords, name, costTracker, signal });
      transcript = r.transcript;
      judged = r.judged;
      compare = compareSpoken(expectedText, transcript, { name, alias, controlWords });
      const textIssues = [];
      if (compare.wordMatch < THRESHOLDS.wordMatch) textIssues.push(`word match ${compare.wordMatch}`);
      if (compare.missingRun >= THRESHOLDS.missingRun) textIssues.push(`${compare.missingRun} words missing in a row`);
      if (!compare.firstWordPresent) textIssues.push('first word missing');
      if (!compare.lastWordPresent) textIssues.push('last word missing');
      if (compare.doubledWords.length) textIssues.push(`doubled: ${compare.doubledWords.slice(0, 3).join(', ')}`);
      if (compare.extraRatio > THRESHOLDS.extraRatio) textIssues.push(`${Math.round(compare.extraRatio * 100)}% extra words`);
      if (textIssues.length) defects.push(`${DEFECTS.TEXT_MISMATCH}: ${textIssues.join('; ')}`);
      if (compare.controlSpoken.length || judged.spokenControlWords) defects.push(`${DEFECTS.TAG_SPOKEN}${compare.controlSpoken.length ? `: ${compare.controlSpoken.slice(0, 3).join(', ')}` : ''}`);
      if (judged.glitch || judged.robotic) defects.push(`${DEFECTS.ARTIFACT}: ${judged.glitch ? 'glitch' : 'robotic'}`);
      if (compare.nameHeard === false) defects.push(DEFECTS.NAME_NOT_HEARD);
      if (judged.monotone) defects.push(DEFECTS.MONOTONE);
      if (judged.pace === 'too_fast') defects.push(DEFECTS.TOO_FAST);
      if (judged.pace === 'too_slow') defects.push(DEFECTS.TOO_SLOW);
      if (expectedEmotion && judged.readsAs !== 'unclear' && judged.readsAs !== expectedEmotion) defects.push(`${DEFECTS.EMOTION_OFF}: reads as ${judged.readsAs}, directed ${expectedEmotion}`);
      if (judged.mispronounced.length) defects.push(`${DEFECTS.MISPRONOUNCED}: ${judged.mispronounced.slice(0, 3).join(', ')}`);
    } catch (err) {
      qaUnavailable = `transcript check failed (${err.message})`;
      log('warn', qaUnavailable);
    }
  }
  const { blocking, advisory } = classifyTakeDefects(defects);
  return { defects, blocking, advisory, transcript, compare, judged, qaUnavailable, durationRatio };
}

/**
 * The next pass's steer, from the blocking defects and pinned data only.
 * @param {string[]} blocking
 * @param {{directionWords: string, name?: string|null, alias?: string|null}} ctx
 * @returns {{note: string, rung: 'restate'|'plain', useAlias: boolean, newSeed: boolean}}
 */
function repairNote(blocking, ctx) {
  const bases = blocking.map(d => String(d).split(':')[0].trim());
  const parts = [];
  let rung = 'restate';
  if (bases.includes(DEFECTS.TAG_SPOKEN)) { parts.push('perform the direction, never speak it'); rung = 'plain'; }
  if (bases.includes(DEFECTS.TEXT_MISMATCH)) parts.push('read every word exactly as written, nothing added, nothing dropped, nothing repeated');
  if (bases.includes(DEFECTS.DURATION_OFF)) parts.push('read at an easy storytelling pace, no long pauses, no rushing');
  if (bases.includes(DEFECTS.DEAD_AIR)) parts.push('no long silences inside the take');
  if (bases.includes(DEFECTS.ARTIFACT)) parts.push('a clean, natural take');
  if (bases.includes(DEFECTS.CLIPPED)) parts.push('a clean take without distortion');
  const useAlias = !!(ctx && ctx.alias);
  return { note: `${parts.join('; ') || 'a clean take'} — ${ctx && ctx.directionWords ? ctx.directionWords : 'warm and clear'}`, rung, useAlias, newSeed: true };
}

module.exports = { DEFECTS, BLOCKING, THRESHOLDS, TRANSCRIPT_SCHEMA, buildTranscriptPrompt, transcribeTake, classifyTakeDefects, checkTake, repairNote };
