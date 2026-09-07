/**
 * Moments — the one or two sentences each planned page is drawn from
 * (cb-1, docs/COLORING_BOOK_V2_PLAN.md §4.2). Two sources, in order:
 *
 *  1. TEMPLATE lines (deterministic, always available): a fixed template
 *     per kind over pinned data. A template never copies a beat verb
 *     phrase, so it passes the duplication gate by construction.
 *  2. The MOMENT WRITER (ON by default, CATALOG_COLORING_MOMENT_WRITER=0):
 *     ONE strict-JSON call per book on the QA model that receives the plan
 *     (kinds + anchors + the adjacent beats, quoted as data), the theme and
 *     the book's safety lines, and phrases each slot. One retry with the
 *     gate's rejections fed back; a slot that still fails takes its template
 *     line. The writer never fails the book.
 *
 * THE DUPLICATION GATE is the guarantee that no page retells the book: a
 * moment is REJECTED when, against ANY beat or spread text, it shares a
 * content-word 4-gram, exceeds a content-word Jaccard of 0.45, or a
 * normalized Levenshtein ratio of 0.6; and when it invents a proper noun,
 * names a banned brand, uses a peril word, or contains anything paintable
 * as text (a quoted string, a digit). The names the pages are ALLOWED to
 * share — child, companion, world — are masked before comparison.
 */

const { fetchWithTimeout, getNextApiKey } = require('../../illustrationGenerator');
const { jsonQaGenerationConfig, responseText, parseJsonText, unparseableDetail } = require('../../shared/llm/geminiJson');
const flags = require('../flags');

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
const WRITER_MODEL = () => process.env.CATALOG_QA_VISION_MODEL || 'gemini-2.5-flash';
const WRITER_TIMEOUT_MS = 90000;
const MOMENT_MIN_CHARS = 20;
const MOMENT_MAX_CHARS = 320;
const TITLE_MAX_WORDS = 5;
const TITLE_MAX_CHARS = 40;

const NGRAM = 4;
const JACCARD_MAX = 0.45;
const LEVENSHTEIN_MAX = 0.6;

const BANNED_BRANDS = require('../data/bannedBrands.json').terms;

/** Words that turn a quiet moment into a plot event (the catalog's tone). */
const PERIL_WORDS = ['lost', 'trapped', 'hurt', 'scared', 'scary', 'frightened', 'storm', 'thunder', 'chase', 'chased', 'chasing', 'fall', 'falls', 'fell', 'falling', 'cry', 'cries', 'crying', 'danger', 'dangerous', 'afraid', 'fear', 'alone', 'stuck', 'bleed', 'blood', 'fight', 'fighting', 'angry', 'monster', 'ghost', 'witch', 'dark', 'darkness', 'broken', 'breaks', 'sick', 'ill', 'accident', 'emergency', 'rescue', 'missing', 'search', 'searches', 'searching', 'problem', 'trouble', 'worried', 'worry'];

const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'with', 'for', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'their', 'they', 'them', 'he', 'she', 'his', 'her', 'him', 'we', 'our', 'you', 'your', 'i', 'my', 'me', 'one', 'ones', 'no', 'not', 'never', 'then', 'than', 'so', 'up', 'down', 'out', 'into', 'onto', 'over', 'under', 'off', 'all', 'any', 'each', 'every', 'very', 'just', 'only', 'also', 'while', 'when', 'where', 'who', 'whom', 'which', 'what', 'how', 'do', 'does', 'did', 'has', 'have', 'had', 'can', 'could', 'may', 'might', 'will', 'would', 'shall', 'should', 'let', 'if', 'but', 'about', 'around', 'near', 'beside', 'next', 'still', 'yet', 'again', 'back', 'away', 'here', 'there', 'now', 'too', 'more', 'most', 'own', 'same', 'some', 'such', 'both', 'few', 'little', 'small', 'big', 'exactly', 'naturally', 'gently', 'child', 'name', 'like', 'through', 'along', 'toward', 'towards', 'between', 'before', 'after', 'part', 'day', 'moment', 'nothing', 'happening', 'calm', 'quiet', 'ready', 'world']);

/**
 * Strip a string to inert prompt data (control chars out, quotes out,
 * whitespace collapsed, capped) — the scenes.js inertPropValue posture.
 * @param {*} v
 * @param {number} [max]
 * @returns {string}
 */
function inert(v, max = 120) {
  return String(v ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/["'`“”‘’]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Escape a literal for RegExp. @param {string} s @returns {string} */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word, case-insensitive containment. @param {string} text @param {string} term @returns {boolean} */
function containsWord(text, term) {
  const t = String(term || '').trim();
  if (!t) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(t)}(?![\\p{L}\\p{N}])`, 'iu').test(String(text || ''));
}

/** Light suffix stemming for the gate's content words. @param {string} w @returns {string} */
function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

/**
 * Normalize a text for comparison: allowlisted names masked, lowercase,
 * diacritics stripped, punctuation out, stop words out, stemmed.
 * @param {string} text
 * @param {string[]} [masks] names allowed to be shared (child, companion, world)
 * @returns {string[]} content tokens
 */
function contentTokens(text, masks = []) {
  let s = String(text || '');
  for (const m of masks) {
    const t = String(m || '').trim();
    if (t) s = s.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(t)}(?![\\p{L}\\p{N}])`, 'giu'), ' ');
  }
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(w => w && !STOP_WORDS.has(w))
    .map(stem);
}

/** Levenshtein distance (small strings). @param {string} a @param {string} b @returns {number} */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Content-word n-grams of a token list. @param {string[]} tokens @param {number} n @returns {Set<string>} */
function ngrams(tokens, n) {
  const out = new Set();
  for (let i = 0; i + n <= tokens.length; i++) out.add(tokens.slice(i, i + n).join(' '));
  return out;
}

/**
 * Capitalized words in the ORIGINAL text that are not sentence-initial and
 * not in the allowlist — an invented name.
 * @param {string} text
 * @param {Set<string>} allow lowercase allowed words
 * @returns {string[]}
 */
function inventedNames(text, allow) {
  const out = [];
  const sentences = String(text || '').split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean);
    words.forEach((raw, i) => {
      const w = raw.replace(/[^\p{L}\p{N}'’-]/gu, '');
      if (i === 0 || !w) return;
      if (!/^\p{Lu}[\p{Ll}'’-]+$/u.test(w)) return;
      const lower = w.toLowerCase().replace(/[’']s$/, '');
      if (allow.has(lower) || lower === 'i') return;
      out.push(w);
    });
  }
  return [...new Set(out)];
}

/**
 * The duplication gate. Pure.
 * @param {string} moment the candidate line
 * @param {{beats: string[], spreadTexts: string[], names: string[], allowedWords?: string[]}} refs
 *   `names`: the child, companion, world and display names (masked before
 *   comparison and allowed as capitalized words); `allowedWords`: extra
 *   capitalized words the beats themselves use.
 * @returns {{ok: boolean, reasons: string[]}}
 */
function duplicationGate(moment, refs) {
  const reasons = [];
  const text = String(moment || '');
  if (/[\u0000-\u001F\u007F]/.test(text)) reasons.push('contains control characters');
  const trimmed = text.trim();
  if (trimmed.length < MOMENT_MIN_CHARS) reasons.push(`too short (${trimmed.length} chars)`);
  if (trimmed.length > MOMENT_MAX_CHARS) reasons.push(`too long (${trimmed.length} chars)`);
  if (/["“”]/.test(trimmed)) reasons.push('contains a quoted string (paintable as text)');
  if (/\d/.test(trimmed)) reasons.push('contains a digit (paintable as text)');
  for (const term of BANNED_BRANDS) {
    if (containsWord(trimmed, term)) { reasons.push(`names a banned brand or IP: ${term}`); break; }
  }
  for (const w of PERIL_WORDS) {
    if (containsWord(trimmed, w)) { reasons.push(`uses a peril or plot word: ${w}`); break; }
  }
  const names = (refs.names || []).map(n => String(n || '').trim()).filter(Boolean);
  const allow = new Set();
  for (const n of names) for (const w of n.toLowerCase().split(/\s+/)) allow.add(w);
  for (const w of refs.allowedWords || []) allow.add(String(w).toLowerCase());
  const invented = inventedNames(trimmed, allow);
  if (invented.length > 0) reasons.push(`invents a name: ${invented.join(', ')}`);

  const tokens = contentTokens(trimmed, names);
  const grams = ngrams(tokens, NGRAM);
  const joined = tokens.join(' ');
  const references = [
    ...(refs.beats || []).map((t, i) => ({ label: `beat ${i + 1}`, text: t })),
    ...(refs.spreadTexts || []).map((t, i) => ({ label: `spread ${i + 1} text`, text: t })),
  ];
  for (const ref of references) {
    if (!ref.text) continue;
    const rt = contentTokens(ref.text, names);
    if (rt.length === 0) continue;
    const rg = ngrams(rt, NGRAM);
    const shared = [...grams].find(g => rg.has(g));
    if (shared) { reasons.push(`restates ${ref.label} (shared phrase: ${shared})`); continue; }
    const a = new Set(tokens);
    const b = new Set(rt);
    let inter = 0;
    for (const w of a) if (b.has(w)) inter += 1;
    const union = a.size + b.size - inter;
    const jaccard = union > 0 ? inter / union : 0;
    if (jaccard > JACCARD_MAX) { reasons.push(`too close to ${ref.label} (word overlap ${jaccard.toFixed(2)})`); continue; }
    const rj = rt.join(' ');
    const maxLen = Math.max(joined.length, rj.length);
    if (maxLen > 0) {
      const ratio = 1 - levenshtein(joined, rj) / maxLen;
      if (ratio > LEVENSHTEIN_MAX) reasons.push(`paraphrases ${ref.label} (similarity ${ratio.toFixed(2)})`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/** Validate a page title: 1-5 words, ≤ 40 chars, no digits/quotes/brands. @param {*} t @returns {string|null} */
function cleanTitle(t) {
  const s = inert(t, TITLE_MAX_CHARS + 20).replace(/[.!?]+$/, '').trim();
  if (!s || s.length > TITLE_MAX_CHARS) return null;
  const words = s.split(/\s+/);
  if (words.length > TITLE_MAX_WORDS) return null;
  if (/\d/.test(s)) return null;
  for (const term of BANNED_BRANDS) if (containsWord(s, term)) return null;
  return s;
}

/** Guide text per kind — the writer's and the renderer's shared definition. */
const KIND_GUIDE = Object.freeze({
  meet: 'the hero\'s own model sheet page — not a scene',
  hero_portrait: 'a full-length portrait of the child standing in the world, ready for the day; no event',
  companion_portrait: 'the companion alone, doing what its type naturally does; no child, no event',
  world_portrait: 'a place the story visits, empty of people and creatures — quiet, inviting; no event',
  cast_portrait: 'the small creatures or objects that belong to this part of the world, close up, doing what they naturally do; no people',
  between: 'the quiet transition between two beats — walking, waiting, looking, carrying, preparing; NEVER the event of either beat',
  before: 'the morning before the visit — getting ready at home, looking forward; no event',
  after: 'the evening after — home, sleepy and happy, remembering; no event',
  quiet_parallel: 'a calm parallel moment at the story\'s peak — the child pauses, listens, notices; nothing happens',
  prop_still_life: 'the child\'s own comfort object beside two or three everyday things from the world, drawn large and simple; no people',
  pattern: 'a decorative pattern page of the world\'s motifs; no people, no text',
});

/**
 * The deterministic template line + title for one planned page.
 * @param {object} page a plan page
 * @param {{name: string, world: string, display: string, companion: {name: string, type: string}|null}} ctx
 * @returns {{moment: string, title: string}}
 */
function templateMoment(page, ctx) {
  const name = inert(ctx.name, 40) || 'the child';
  const world = inert(ctx.world, 60) || 'the story world';
  const companion = ctx.companion && ctx.companion.name ? { name: inert(ctx.companion.name, 40), type: inert(ctx.companion.type, 60) || 'friend' } : null;
  const carried = (page.props || []).map(v => inert(v, 60)).filter(Boolean);
  const propLine = carried.length > 0 && page.kind !== 'prop_still_life' ? `, keeping ${carried[0]} close` : '';
  const withCompanion = page.companion && companion ? `, with ${companion.name} alongside` : '';
  switch (page.kind) {
    case 'meet':
      return { moment: `${name} standing tall in three views — front, side and back — a model sheet to colour.`, title: `Meet ${name}` };
    case 'hero_portrait':
      return { moment: `${name} standing proudly in ${world}, full length, smiling and ready for the day${propLine}.`, title: `Here is ${name}` };
    case 'companion_portrait':
      return { moment: `${companion ? companion.name : 'A friend'}, the ${companion ? companion.type : 'friend'}, in ${world} on an ordinary day, busy with what a ${companion ? companion.type : 'friend'} does, nobody else around.`, title: `Meet ${companion ? companion.name : 'a friend'}` };
    case 'world_portrait':
      return { moment: `A wide, empty view of ${world} — the places the story visits, with nobody in it, peaceful and inviting.`, title: `Welcome to ${world}` };
    case 'cast_portrait':
      return { moment: `A close, calm picture of the small creatures and things that belong to this corner of ${world}, doing what they naturally do, with no people in it.`, title: 'Little friends' };
    case 'between':
      return { moment: `A calm in-between moment in ${world}: ${name} walks on to the next part of the day${withCompanion}, looking around, nothing happening yet${propLine}.`, title: 'On the way' };
    case 'before':
      return { moment: `The morning before the visit: ${name} at home getting ready, shoes by the door, looking forward to ${world}${propLine}.`, title: 'Getting ready' };
    case 'after':
      return { moment: `The evening after: ${name} at home, sleepy and happy, thinking about ${world}${propLine}.`, title: 'Home again' };
    case 'quiet_parallel':
      return { moment: `A quiet moment in ${world}: ${name} pauses to listen and look around, calm and thoughtful${withCompanion}${propLine}.`, title: 'A quiet moment' };
    case 'prop_still_life':
      return { moment: `${name}'s ${carried[0] || 'favourite thing'} resting beside two or three everyday things from ${world}, drawn large and simple, no people.`, title: `${name}'s treasures` };
    case 'pattern':
      return { moment: `A decorative pattern page of the motifs of ${world} repeating in a gentle border, no people, no text.`, title: 'Pattern play' };
    default:
      return { moment: `A calm moment in ${world} with ${name}.`, title: 'A moment' };
  }
}

/**
 * The writer's prompt — every input pinned and quoted as data.
 * @param {object} p {plan, book, theme, name, rejections}
 * @returns {string}
 */
function buildWriterPrompt({ plan, book, theme, name, rejections = [] }) {
  const world = inert(theme.world_name, 60) || 'the story world';
  const display = inert(theme.display_name, 40);
  const companion = theme.companion && theme.companion.name ? `${inert(theme.companion.name, 40)}, a ${inert(theme.companion.type, 60)}` : 'none';
  const slots = plan.pages.filter(pg => pg.kind !== 'meet').map(pg => ({
    index: pg.index,
    kind: pg.kind,
    what: KIND_GUIDE[pg.kind],
    anchor: pg.anchor,
    child_present: pg.hasChild,
    companion_present: pg.companion,
    carried_object: pg.props && pg.props.length ? inert(pg.props[0], 60) : null,
    adjacent_beats: (pg.beats || []).map(b => inert(b, 300)),
  }));
  const safety = (book.safety || []).map(s => `- ${inert(s, 200)}`).join('\n');
  const learning = (book.learning || []).map(s => `- ${inert(s, 200)}`).join('\n');
  const rejected = rejections.length > 0
    ? `\nYOUR PREVIOUS ANSWER WAS REJECTED FOR THESE SLOTS — rewrite ONLY them, differently:\n${rejections.map(r => `- page ${r.index}: ${r.reasons.join('; ')}`).join('\n')}\n`
    : '';
  return `You phrase the pages of a children's COLORING BOOK that accompanies a picture book. The picture book already shows its story; the coloring pages show the moments BESIDE it — never the story's own events.

World: "${world}" (${display}). Child: "${inert(name, 40)}". Companion: ${companion}.
Book safety rules (always obey):
${safety || '- keep everything gentle'}
Things the book teaches (a cast page may show them):
${learning || '- (none)'}

For EACH slot below, write:
- "moment": ONE or TWO plain sentences (60-240 characters) describing exactly what to draw for that slot's kind. Concrete and drawable: who/what is in the picture, where, doing what small natural thing. Calm and wholesome.
- "title": a page caption of at most 5 words.

HARD RULES:
- The moment must NOT retell, restate or paraphrase any adjacent beat. It shows a quiet in-between, before, after, portrait or parallel moment that the picture book does NOT contain.
- No new characters: name ONLY the child, the companion, and the world. No other names, no families, no strangers.
- No new events, problems, danger, peril, losing, searching, hurting, storms, chases, crying.
- No food unless the slot's carried object is food. No brands, no licensed characters.
- Nothing that could be drawn as text: no signs with words, no letters, no numbers, no quoted speech.
- child_present false ⇒ no people in the picture. companion_present true ⇒ the companion is in it; false ⇒ it is not.
- If carried_object is set, the child keeps it close (small, decorative).
${rejected}
SLOTS (data):
${JSON.stringify(slots)}

Return STRICT JSON only: {"pages":[{"index":<slot index>,"moment":"...","title":"..."}, ...]} — one entry per slot, in slot order.`;
}

/**
 * One writer call → `{pages}` or null (transport/parse failure).
 * @param {string} prompt
 * @param {object} [costTracker]
 * @returns {Promise<{pages: Array<{index: number, moment: string, title: string}>}|null>}
 */
async function callWriter(prompt, costTracker) {
  const model = WRITER_MODEL();
  const apiKey = getNextApiKey();
  const resp = await fetchWithTimeout(`${GEMINI_API}/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { ...jsonQaGenerationConfig(4096, model), temperature: 0.7 },
    }),
  }, WRITER_TIMEOUT_MS);
  if (!resp.ok) throw new Error(`moment writer HTTP ${resp.status}`);
  const data = await resp.json();
  if (costTracker && data && data.usageMetadata) {
    costTracker.addTextUsage(model, data.usageMetadata.promptTokenCount || 0, data.usageMetadata.candidatesTokenCount || 0);
  }
  const text = responseText(data);
  let json;
  try {
    json = parseJsonText(text);
  } catch (err) {
    throw new Error(`moment writer returned unparseable JSON${unparseableDetail(data, text)}`);
  }
  if (!json || typeof json !== 'object' || !Array.isArray(json.pages)) throw new Error('moment writer returned no pages array');
  return { pages: json.pages, model };
}

/**
 * Resolve a moment + title for every planned page: the writer (validated
 * by the gate, one retry) with the template as the per-slot fallback.
 * Never throws for writer trouble — the templates always exist.
 * @param {object} p
 * @param {object} p.plan buildColoringPlan output
 * @param {object} p.book catalog book definition
 * @param {object} p.theme catalog theme
 * @param {{spreads?: Array<{spread: number, text: string}>}} p.story
 * @param {{name: string}} p.profile
 * @param {object} [p.costTracker]
 * @param {(level: string, msg: string) => void} [p.log]
 * @returns {Promise<{pages: Array<{index: number, moment: string, title: string, source: 'writer'|'template'}>, writer: string, gateRejections: Array<{index: number, reasons: string[]}>}>}
 */
async function resolveMoments({ plan, book, theme, story, profile, costTracker, log = () => {} }) {
  const ctx = { name: profile && profile.name, world: theme && theme.world_name, display: theme && theme.display_name, companion: theme && theme.companion ? theme.companion : null };
  const beats = (book.beats || []).map(b => String(b.beat || ''));
  const spreadTexts = ((story && story.spreads) || []).map(s => String(s.text || ''));
  const names = [ctx.name, ctx.companion && ctx.companion.name, ctx.world, ctx.display].filter(Boolean);
  // Capitalized words the beats themselves use (a place name inside a beat)
  // are legitimate on a page; anything else capitalized is an invented name.
  const allowedWords = [];
  for (const b of beats) for (const w of inventedNames(b, new Set())) allowedWords.push(w.toLowerCase());
  const refs = { beats, spreadTexts, names, allowedWords };
  const templates = new Map(plan.pages.map(pg => [pg.index, templateMoment(pg, ctx)]));
  const resolved = new Map();
  const gateRejections = [];
  let writerModel = 'template';

  if (flags.coloringMomentWriterEnabled()) {
    let rejections = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      let answer;
      try {
        answer = await callWriter(buildWriterPrompt({ plan, book, theme, name: ctx.name, rejections }), costTracker);
      } catch (err) {
        log('warn', `moment writer attempt ${attempt + 1} failed (${err.message}) — template lines stand`);
        break;
      }
      writerModel = answer.model;
      const byIndex = new Map();
      for (const entry of answer.pages) {
        if (!entry || typeof entry !== 'object') continue;
        const index = Number(Object.prototype.hasOwnProperty.call(entry, 'index') ? entry.index : NaN);
        if (!Number.isInteger(index)) continue;
        byIndex.set(index, entry);
      }
      rejections = [];
      for (const pg of plan.pages) {
        if (pg.kind === 'meet' || resolved.has(pg.index)) continue;
        const entry = byIndex.get(pg.index);
        if (!entry) { rejections.push({ index: pg.index, reasons: ['no answer for this slot'] }); continue; }
        const moment = inert(entry.moment, MOMENT_MAX_CHARS + 40);
        const gate = duplicationGate(moment, refs);
        const title = cleanTitle(entry.title);
        const reasons = [...gate.reasons, ...(title ? [] : ['title missing, too long, or unsafe'])];
        if (reasons.length === 0) resolved.set(pg.index, { moment, title, source: 'writer' });
        else rejections.push({ index: pg.index, reasons });
      }
      if (rejections.length === 0) break;
      log('info', `moment writer attempt ${attempt + 1}: ${rejections.length} slot(s) rejected by the gate`);
      if (attempt === 1) gateRejections.push(...rejections);
    }
  }
  const pages = plan.pages.map(pg => {
    const hit = resolved.get(pg.index);
    if (hit) return { index: pg.index, ...hit };
    const t = templates.get(pg.index);
    return { index: pg.index, moment: t.moment, title: t.title, source: 'template' };
  });
  return { pages, writer: writerModel, gateRejections };
}

module.exports = {
  KIND_GUIDE,
  PERIL_WORDS,
  NGRAM,
  JACCARD_MAX,
  LEVENSHTEIN_MAX,
  inert,
  containsWord,
  contentTokens,
  levenshtein,
  inventedNames,
  duplicationGate,
  cleanTitle,
  templateMoment,
  buildWriterPrompt,
  resolveMoments,
};
