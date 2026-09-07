/**
 * The audio script — the schema-validated performance plan (ab-1,
 * docs/AUDIOBOOK_V2_PLAN.md §4.1). A PURE function of pinned inputs: the
 * validated story, the (pinned) book definition, the theme, the profile,
 * the band, the emotion plan, the language, the resolved cast, the
 * dedication and the evidence.
 *
 * The words are the manuscript, verbatim (plus the fixed intro / dedication
 * / outro template lines); the DIRECTION is metadata from closed
 * vocabularies — the spread's pinned emotion × intensity (the same object
 * the illustrator pins), the line's shape from its punctuation, the pace
 * from the band. Dialogue attributed to the companion is split into its
 * own lines so the companion's cast voice can speak it; the refrain is
 * pinned to ONE delivery and flagged for the music motif. Nothing here
 * ever reaches a provider as free text from a model.
 */

const crypto = require('crypto');
const Ajv = require('ajv');
const { AUDIO_VERSION } = require('../versions');
const { EMOTIONS, INTENSITIES } = require('../illustrator/emotionPlan');
const { planMusic } = require('./music/plan');
const { planSfx, loadSfxLibrary, bounded } = require('./sfx/plan');
const schema = require('../data/audio/schemas/audioScript.schema.json');

const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);

/** Words per minute the band's read aims for — the duration gate's basis. */
const BAND_WPM = Object.freeze({ '1-3': 110, '4-5': 125, '6-7': 140, '8-10': 150 });
const BAND_PACE = Object.freeze({ '1-3': 'slow', '4-5': 'even', '6-7': 'even', '8-10': 'brisk' });
const PAUSE_MS = Object.freeze({ statement: 450, question: 550, exclaim: 500, trail: 700 });
const YOUNG_PAUSE_EXTRA_MS = 200;
const REFRAIN_PAUSE_MS = 900;
const DURATION_TOLERANCE = Object.freeze({ min: 0.6, max: 1.6, slackSeconds: 2, floorSeconds: 0.8 });
const MAX_DEDICATION_WORDS = 80;

/** Closed delivery words per (emotion, intensity) — provider-neutral. */
const DIRECTION_TABLE = Object.freeze({
  joy: { soft: 'gently happy, smiling', clear: 'bright and happy', big: 'bursting with joy, energetic' },
  wonder: { soft: 'hushed, slow, full of wonder', clear: 'amazed and full of wonder', big: 'wide-eyed, thrilled with wonder' },
  curiosity: { soft: 'quietly curious', clear: 'curious and interested', big: 'eagerly curious, leaning in' },
  determination: { soft: 'quietly determined', clear: 'determined and steady', big: 'boldly determined, brave' },
  worry: { soft: 'a little unsure, careful', clear: 'worried but brave, a little breathless', big: 'nervous and hurried, still gentle' },
  calm: { soft: 'very calm, slow and soft', clear: 'calm and even', big: 'calm, warm and reassuring' },
  surprise: { soft: 'softly surprised', clear: 'surprised and delighted', big: 'astonished, gasping with delight' },
  pride: { soft: 'quietly proud', clear: 'proud and warm', big: 'beaming with pride' },
  tenderness: { soft: 'tender, close, very gentle', clear: 'warm and loving', big: 'overflowing with love' },
  silly: { soft: 'playful, a little giggly', clear: 'silly and playful', big: 'giddy, giggling, bouncing' },
});
const REFRAIN_DIRECTION_WORDS = 'the story\'s refrain — warm, sing-song, exactly the same lilt every time it returns';
const SHAPE_WORDS = Object.freeze({ statement: '', question: 'lifting into a question', exclaim: 'with a bright lift', trail: 'trailing off softly' });
const PACE_WORDS = Object.freeze({ slow: 'slow and unhurried, with long breaths', even: 'an easy storytelling pace', brisk: 'a lively pace' });

/** Fixed per-language template lines — the only non-manuscript words the engine speaks. */
const TEMPLATES = Object.freeze({
  en: { introTitle: '{title}.', introFor: 'A story for {name}.', dedicationFrom: 'A note from {from}.', dedicationAnon: 'A note for {name}.', outroEnd: 'The end.', outroThanks: 'Thank you for listening.' },
  es: { introTitle: '{title}.', introFor: 'Un cuento para {name}.', dedicationFrom: 'Una nota de {from}.', dedicationAnon: 'Una nota para {name}.', outroEnd: 'Fin.', outroThanks: 'Gracias por escuchar.' },
  he: { introTitle: '{title}.', introFor: 'סיפור בשביל {name}.', dedicationFrom: 'מילים מ{from}.', dedicationAnon: 'מילים בשביל {name}.', outroEnd: 'הסוף.', outroThanks: 'תודה שהקשבתם.' },
});

/** @param {string} s @returns {string} */
function normalizeSpoken(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[“”„‟"]/g, '').replace(/[‘’‚‛']/g, "'").toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** @param {string} text @returns {number} */
function countWords(text) {
  return String(text || '').split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
}

/**
 * Split a spread's text into spoken lines. Every VERBATIM-REQUIRED string
 * (`masks`: the child name, the companion and world names, the refrain,
 * evidence values) is protected first, so a name like "Jo Jo" or a refrain
 * of two sentences never splits; line breaks split first (verse), then
 * sentence-final punctuation.
 * @param {string} text
 * @param {string[]} [masks]
 * @returns {string[]}
 */
function splitLines(text, masks = []) {
  let t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return [];
  const stash = [];
  const endsSentence = s => /[.!?…]["”’')\]]*$/u.test(s);
  const place = (m) => { stash.push(m); return `\u0001${stash.length - 1}${endsSentence(m) ? '\u0002' : '\u0001'}`; };
  // 1. Verbatim strings (longest first): a name never splits a sentence; a
  //    refrain that ends in punctuation ends its own line.
  const protectedTerms = [...new Set((masks || []).filter(Boolean).map(String))].sort((a, b) => b.length - a.length);
  for (const term of protectedTerms) {
    if (!term.trim()) continue;
    t = t.replace(bounded(term, 'gu'), place);
  }
  // Title abbreviations never end a sentence (a non-terminating placeholder).
  t = t.replace(/\b(Mr|Mrs|Ms|Dr|St)\./g, (m) => { stash.push(m); return `\u0001${stash.length - 1}\u0001`; });
  // 2. Quoted spans are atoms: "Hello there!" said Bea. stays one sentence
  //    so the attribution rule can see the speaker beside the quote.
  t = t.replace(/[“"][^”"\n]{1,400}[”"]/gu, place);
  const restore = (s) => {
    let out = s;
    for (let i = 0; i < 4 && /\u0001\d+[\u0001\u0002]/.test(out); i++) out = out.replace(/\u0001(\d+)[\u0001\u0002]/g, (_, k) => stash[Number(k)]);
    return out;
  };
  const out = [];
  for (const para of t.split(/\n+/)) {
    const p = para.trim();
    if (!p) continue;
    const parts = p.match(/[^.!?…\u0002]+(?:[.!?…]+["”’')\]]*|\u0002|$)/gu) || [p];
    const lines = parts.map(part => restore(part).replace(/\u0002/g, '').trim()).filter(s => s && /[\p{L}\p{N}]/u.test(s));
    // 3. Re-join a quote with its attribution clause: a line that ends on a
    //    closing quote + a next line that starts lowercase ("said Bea."), or
    //    a line that ends on a comma/colon + a next line that opens a quote.
    for (const line of lines) {
      const prev = out[out.length - 1];
      if (prev && ((/["”’]$/u.test(prev) && /^\p{Ll}/u.test(line)) || (/[,:]$/.test(prev) && /^[“"]/u.test(line)))) {
        out[out.length - 1] = `${prev} ${line}`;
      } else {
        out.push(line);
      }
    }
  }
  return out;
}

/** @param {string} text @returns {'statement'|'question'|'exclaim'|'trail'} */
function lineShape(text) {
  const t = String(text || '').trim().replace(/["”’')\]]+$/u, '');
  if (/…$|\.\.\.$/.test(t)) return 'trail';
  if (/\?$/.test(t)) return 'question';
  if (/!$/.test(t)) return 'exclaim';
  return 'statement';
}

/**
 * Attribute a line's quoted spans to the companion when the text OUTSIDE
 * the quotes names the companion (whole word, the world/display names
 * masked, never when the child shares the name). The line is split into
 * ordered parts so the narrator keeps the attribution and the companion
 * voice speaks the quote. Everything else is the narrator's.
 * @param {string} text
 * @param {{name?: string, type?: string}|null} companion
 * @param {{childName?: string, theme?: object, enabled?: boolean}} ctx
 * @returns {Array<{text: string, speaker: 'narrator'|'companion'}>}
 */
function attributeLine(text, companion, ctx = {}) {
  const parts = [{ text, speaker: 'narrator' }];
  if (!ctx.enabled || !companion || !companion.name) return parts;
  const name = String(companion.name).trim();
  const childName = String(ctx.childName || '').trim();
  if (childName && childName.toLowerCase() === name.toLowerCase()) return parts;
  const quoteRe = /[“"]([^”"]+)[”"]/gu;
  const quotes = [...String(text).matchAll(quoteRe)];
  if (quotes.length === 0) return parts;
  let outside = String(text).replace(quoteRe, ' ');
  for (const mask of [ctx.theme && ctx.theme.world_name, ctx.theme && ctx.theme.display_name]) {
    const m = String(mask || '').trim();
    if (!m || bounded(m, 'iu').test(name)) continue;
    outside = outside.replace(bounded(m, 'giu'), ' ');
  }
  if (!bounded(name, 'u').test(outside)) return parts;
  if (childName && bounded(childName, 'u').test(outside)) return parts;
  const out = [];
  let cursor = 0;
  for (const q of quotes) {
    const before = String(text).slice(cursor, q.index).trim();
    if (before) out.push({ text: before, speaker: 'narrator' });
    out.push({ text: q[0].trim(), speaker: 'companion' });
    cursor = q.index + q[0].length;
  }
  const tail = String(text).slice(cursor).trim();
  if (tail) out.push({ text: tail, speaker: 'narrator' });
  return out.filter(p => /[\p{L}\p{N}]/u.test(p.text));
}

/** @param {object} direction @returns {string} the closed delivery phrase */
function directionWords(direction, { refrain = false } = {}) {
  if (refrain) return REFRAIN_DIRECTION_WORDS;
  const table = DIRECTION_TABLE[direction.emotion] || DIRECTION_TABLE.calm;
  const words = table[direction.intensity] || table.clear;
  const shape = SHAPE_WORDS[direction.shape] || '';
  return [words, shape].filter(Boolean).join(', ');
}

/** @param {'slow'|'even'|'brisk'} pace @returns {string} */
function paceWords(pace) { return PACE_WORDS[pace] || PACE_WORDS.even; }

/**
 * Every delivery word the closed tables can emit (normalized) — the
 * transcript gate treats one of these spoken but absent from the text as
 * a direction read aloud.
 * @returns {string[]}
 */
function controlWords() {
  const set = new Set();
  const add = phrase => { for (const w of normalizeSpoken(phrase).split(' ')) if (w.length >= 4) set.add(w); };
  for (const e of Object.values(DIRECTION_TABLE)) for (const p of Object.values(e)) add(p);
  add(REFRAIN_DIRECTION_WORDS);
  for (const w of Object.values(SHAPE_WORDS)) add(w);
  for (const w of Object.values(PACE_WORDS)) add(w);
  for (const w of ['whispers', 'excited', 'cheerfully', 'softly', 'warmly', 'gently', 'playfully', 'amazed', 'curious', 'nervously', 'calmly', 'surprised', 'proudly', 'laughs', 'sighs', 'gasps', 'narrator', 'pause']) set.add(w);
  return [...set];
}

/**
 * Story text per spread + title from a `{spreads, title}` response or a
 * `{request, response}` pair.
 * @param {*} story
 * @returns {{title: string, texts: Map<number, string>, evidence: object[]}}
 */
function storyParts(story) {
  const response = story && story.response && Array.isArray(story.response.spreads) ? story.response : story;
  const texts = new Map();
  for (const s of (response && response.spreads) || []) if (s && Number.isInteger(s.spread) && typeof s.text === 'string') texts.set(s.spread, s.text);
  return { title: String((response && response.title) || ''), texts, evidence: Array.isArray(response && response.personalization_evidence) ? response.personalization_evidence : [] };
}

/**
 * The verbatim strings that must never split or match as keywords.
 * @param {{profile: object, theme: object, book: object, evidence: object[]}} p
 * @returns {string[]}
 */
function verbatimMasks({ profile, theme, book, evidence }) {
  return [...new Set([
    profile && profile.name,
    theme && theme.companion && theme.companion.name,
    theme && theme.world_name,
    theme && theme.display_name,
    book && book.refrain && book.refrain.text,
    ...(evidence || []).map(e => e && e.source_value),
  ].filter(v => typeof v === 'string' && v.trim()))];
}

/**
 * Build the lines of one segment from raw sentences.
 * @param {object} p
 * @returns {object[]}
 */
function buildLines({ sentences, emotion, band, refrainText, isRefrainSpread, companion, ctx }) {
  const pace = BAND_PACE[band] || 'even';
  const refrainNorm = refrainText ? normalizeSpoken(refrainText) : null;
  const lines = [];
  for (const sentence of sentences) {
    const isRefrain = !!(isRefrainSpread && refrainNorm && normalizeSpoken(sentence) === refrainNorm);
    const parts = isRefrain ? [{ text: sentence, speaker: 'narrator' }] : attributeLine(sentence, companion, ctx);
    for (const part of parts) {
      const shape = lineShape(part.text);
      const direction = isRefrain
        ? { emotion: 'joy', intensity: 'clear', pace, shape }
        : { emotion: emotion.emotion, intensity: emotion.intensity, pace: shape === 'trail' ? 'slow' : pace, shape };
      const pause = isRefrain ? REFRAIN_PAUSE_MS : PAUSE_MS[shape] + (band === '1-3' ? YOUNG_PAUSE_EXTRA_MS : 0);
      lines.push({ index: lines.length, text: part.text, speaker: part.speaker, direction, isRefrain, pauseAfterMs: pause });
    }
  }
  if (lines.length) lines[lines.length - 1].pauseAfterMs = 0;
  return lines;
}

/**
 * Expected words and seconds of a segment from the band's pace.
 * @param {object[]} lines
 * @param {string} band
 * @returns {{expectedWords: number, expectedSeconds: {min: number, max: number}}}
 */
function expectedTiming(lines, band) {
  const words = lines.reduce((n, l) => n + countWords(l.text), 0);
  const pauses = lines.reduce((n, l) => n + l.pauseAfterMs, 0) / 1000;
  const wpm = BAND_WPM[band] || 130;
  const base = (words / wpm) * 60 + pauses + lines.length * 0.15;
  return {
    expectedWords: Math.max(1, words),
    expectedSeconds: {
      min: Math.round(Math.max(DURATION_TOLERANCE.floorSeconds, base * DURATION_TOLERANCE.min) * 100) / 100,
      max: Math.round((base * DURATION_TOLERANCE.max + DURATION_TOLERANCE.slackSeconds) * 100) / 100,
    },
  };
}

/** @param {string} tpl @param {object} vars @returns {string} */
function fill(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

/**
 * Build the segments (intro, dedication, spreads, outro) with their lines.
 * @param {object} p
 * @returns {{segments: object[], advisories: string[]}}
 */
function buildSegments({ story, book, theme, profile, ageBand, emotionPlan, language = 'en', dedication = null, characterVoices = true, companionCast = null }) {
  const t = TEMPLATES[language] || TEMPLATES.en;
  const { title, texts, evidence } = storyParts(story);
  const masks = verbatimMasks({ profile, theme, book, evidence });
  const name = profile && profile.name ? profile.name : '';
  const advisories = [];
  const companion = theme && theme.companion ? theme.companion : null;
  const attribCtx = { childName: name, theme, enabled: !!(characterVoices && companionCast && ageBand !== '1-3') };
  const refrainText = book && book.refrain && typeof book.refrain.text === 'string' ? book.refrain.text : null;
  const refrainSpreads = new Set(book && book.refrain && Array.isArray(book.refrain.spreads) ? book.refrain.spreads : []);
  const plainCtx = { childName: name, theme, enabled: false };
  const segments = [];
  const push = (kind, spread, lines) => {
    if (!lines.length) return;
    segments.push({ index: segments.length, kind, spread, lines, ...expectedTiming(lines, ageBand) });
  };

  // Intro: the title, then the dedication line.
  const introEmotion = { emotion: ageBand === '1-3' ? 'wonder' : 'joy', intensity: ageBand === '1-3' ? 'soft' : 'clear' };
  const introSentences = [fill(t.introTitle, { title: title || book.title_template.replace('{name}', name) }), fill(t.introFor, { name })].filter(s => /[\p{L}\p{N}]/u.test(s));
  push('intro', null, buildLines({ sentences: introSentences, emotion: introEmotion, band: ageBand, refrainText: null, isRefrainSpread: false, companion, ctx: plainCtx }));

  // Dedication: the parent's note, verbatim, capped.
  if (dedication && typeof dedication.text === 'string' && dedication.text.trim()) {
    const from = typeof dedication.from === 'string' ? dedication.from.trim() : '';
    let noteLines = splitLines(dedication.text, masks);
    let words = 0;
    const kept = [];
    for (const l of noteLines) { const w = countWords(l); if (words + w > MAX_DEDICATION_WORDS) break; kept.push(l); words += w; }
    if (kept.length < noteLines.length) advisories.push(`dedication cut at ${MAX_DEDICATION_WORDS} words (${noteLines.length - kept.length} sentence(s) not read)`);
    noteLines = kept;
    if (noteLines.length) {
      const lead = from ? fill(t.dedicationFrom, { from }) : fill(t.dedicationAnon, { name });
      push('dedication', null, buildLines({ sentences: [lead, ...noteLines], emotion: { emotion: 'tenderness', intensity: 'soft' }, band: ageBand, refrainText: null, isRefrainSpread: false, companion, ctx: plainCtx }));
    }
  }

  // Spreads, in order, every beat of the book.
  const spreads = [...new Set((book.beats || []).map(b => b.spread))].sort((a, b) => a - b);
  for (const spread of spreads) {
    const text = texts.get(spread);
    if (!text || !text.trim()) { advisories.push(`spread ${spread} has no manuscript text`); continue; }
    const emotion = (emotionPlan && emotionPlan[spread]) || { emotion: 'calm', intensity: 'clear' };
    const lines = buildLines({ sentences: splitLines(text, masks), emotion, band: ageBand, refrainText, isRefrainSpread: refrainSpreads.has(spread), companion, ctx: attribCtx });
    if (!lines.length) { advisories.push(`spread ${spread} yields no spoken line`); continue; }
    if (refrainSpreads.has(spread) && !lines.some(l => l.isRefrain)) advisories.push(`spread ${spread}: the refrain is not a line of its own (no motif placed)`);
    push('spread', spread, lines);
  }

  // Outro.
  push('outro', null, buildLines({ sentences: [t.outroEnd, t.outroThanks], emotion: { emotion: 'tenderness', intensity: 'soft' }, band: ageBand, refrainText: null, isRefrainSpread: false, companion, ctx: plainCtx }));
  return { segments, advisories, masks, evidence, refrainSpreads: [...refrainSpreads] };
}

/**
 * Validate a script against the schema and the closed vocabularies.
 * @param {object} script
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateAudioScript(script) {
  const errors = [];
  if (!validateSchema(script)) {
    for (const e of validateSchema.errors || []) errors.push(`${e.instancePath || '/'} ${e.message}`);
  }
  for (const seg of (script && script.segments) || []) {
    for (const l of seg.lines || []) {
      if (!EMOTIONS.includes(l.direction.emotion)) errors.push(`segment ${seg.index} line ${l.index}: emotion ${l.direction.emotion}`);
      if (!INTENSITIES.includes(l.direction.intensity)) errors.push(`segment ${seg.index} line ${l.index}: intensity ${l.direction.intensity}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Content hash of a script (its `hash` field excluded).
 * @param {object} script
 * @returns {string}
 */
function scriptHash(script) {
  const { hash, ...rest } = script;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16);
}

/**
 * Build the complete, validated audio script.
 * @param {object} p
 * @param {object} p.story validated story (`{spreads, title, personalization_evidence}` or the pair)
 * @param {object} p.book pinned book definition
 * @param {object} p.theme catalog theme
 * @param {object} p.profile normalized profile
 * @param {string} p.ageBand
 * @param {Object<number, {emotion: string, intensity: string}>} p.emotionPlan
 * @param {{hash: string, companion: object|null}} p.cast resolved cast
 * @param {'en'|'es'|'he'} [p.language]
 * @param {{text: string, from?: string}|null} [p.dedication]
 * @param {{music?: boolean, sfx?: boolean, ambience?: boolean, pageTurn?: boolean, characterVoices?: boolean}} [p.options]
 * @param {string} [p.seedBasis] story fingerprint
 * @param {Object<number, string[]>|null} [p.directorPicks]
 * @param {object} [p.library] sound library (tests)
 * @returns {{script: object, music: object, sfx: object, masks: string[]}}
 */
function buildAudioScript({ story, book, theme, profile, ageBand, emotionPlan, cast, language = 'en', dedication = null, options = {}, seedBasis = '', directorPicks = null, directorLines = null, library }) {
  const characterVoices = options.characterVoices !== false && !!(cast && cast.companion);
  const built = buildSegments({ story, book, theme, profile, ageBand, emotionPlan, language, dedication, characterVoices, companionCast: cast && cast.companion });
  // The director's validated line refinements (closed enums only; never a
  // refrain line; band 1-3 never worry) land BEFORE the music and cue plans.
  for (const r of Array.isArray(directorLines) ? directorLines : []) {
    const seg = built.segments.find(s => s.index === r.segment);
    const line = seg && seg.lines[r.line];
    if (!line || line.isRefrain || !EMOTIONS.includes(r.emotion) || !INTENSITIES.includes(r.intensity)) continue;
    if (ageBand === '1-3' && r.emotion === 'worry') continue;
    line.direction = { ...line.direction, emotion: r.emotion, intensity: r.intensity };
  }
  const music = options.music !== false
    ? planMusic({ segments: built.segments, emotionPlan, band: ageBand, refrainSpreads: built.refrainSpreads })
    : { segments: built.segments.map(s => Object.assign(s, { music: null })), spans: [], changes: 0 };
  const sfx = planSfx({
    segments: built.segments, book, theme, band: ageBand, evidence: built.evidence, masks: built.masks, seedBasis,
    options: { ambience: options.ambience !== false && options.sfx !== false, pageTurn: options.pageTurn !== false && options.sfx !== false, spots: options.sfx !== false },
    library: library || loadSfxLibrary(), directorPicks,
  });
  const script = {
    version: AUDIO_VERSION,
    language,
    band: ageBand,
    castHash: cast ? cast.hash : 'none',
    director: directorPicks || (Array.isArray(directorLines) && directorLines.length) ? 'llm' : 'table',
    segments: built.segments,
    pageTurn: sfx.pageTurn,
    advisories: built.advisories,
    hash: '',
  };
  script.hash = scriptHash(script);
  const check = validateAudioScript(script);
  if (!check.ok) throw new Error(`audio script invalid: ${check.errors.slice(0, 5).join('; ')}`);
  return { script, music, sfx, masks: built.masks };
}

module.exports = {
  BAND_WPM, BAND_PACE, PAUSE_MS, DIRECTION_TABLE, TEMPLATES, DURATION_TOLERANCE, MAX_DEDICATION_WORDS,
  normalizeSpoken, countWords, splitLines, lineShape, attributeLine, directionWords, paceWords, controlWords,
  storyParts, verbatimMasks, buildLines, expectedTiming, buildSegments, validateAudioScript, scriptHash, buildAudioScript,
};
