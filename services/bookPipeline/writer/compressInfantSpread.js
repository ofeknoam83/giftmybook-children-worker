/**
 * Infant spread compressor (PR G).
 *
 * The primary writer (`draftBookText`) sometimes returns 4 lines for infant
 * books or smuggles in subtle locomotion verbs ("Her brave steps bounce with
 * thrill" — the baby isn't walking, but Gemini will faithfully draw a
 * walking toddler and the age-action gate will reject every retry).
 *
 * Rather than blow another writer rewrite wave on every offender, this module
 * runs a focused, narrow LLM pass per infant spread: input is the draft text
 * (any line count) plus the explicit banned-verb list, output is a 2-line AA
 * couplet that satisfies the infant contract (2-4 words/line, hardMax 5,
 * banned-verb-free, real English rhyme).
 *
 * Compression with hard constraints is a markedly easier task than constrained
 * free generation — the model has the imagery in front of it and just needs
 * to shrink + sanitise it. We use a low temperature and a per-spread call so
 * one bad spread can't poison the others.
 *
 * The compressor only fires for PB_INFANT books. For other bands this module
 * is a no-op (compressInfantManuscript simply returns the doc unchanged).
 */

const { callText } = require('../llm/openaiClient');
const { MODELS, AGE_BANDS, TOTAL_SPREADS } = require('../constants');
const { updateSpread, appendLlmCall } = require('../schema/bookDocument');
const { wordsRhyme } = require('../qa/checkWriterDraft');

// Public list of banned locomotion verbs the compressor must avoid. Kept in
// sync with INFANT_FORBIDDEN_VERB_PATTERNS (qa/checkWriterDraft.js) and the
// BANNED list inside renderInfantContract (writer/draftBookText.js). When you
// add a verb to either of those, add it here too.
const BANNED_INFANT_VERBS = [
  'jump', 'run', 'race', 'spin', 'twirl', 'hop',
  'walk', 'climb', 'leap', 'dance', 'chase', 'grab',
  'skip', 'gallop', 'stomp', 'march', 'crawl',
  'cartwheel', 'tumble',
  // PR G additions
  'step', 'stand', 'stood', 'bounce',
];

const SAFE_INFANT_VERBS = [
  'sit', 'lie', 'look', 'see', 'reach', 'hold', 'snuggle',
  'giggle', 'coo', 'pat', 'clap', 'hear', 'smell', 'touch',
  'point', 'wave', 'kiss', 'hug', 'rest', 'nap',
];

const SYSTEM_PROMPT = `You are a board-book editor. You compress longer draft verse into a tight 2-line AA rhyming couplet for an infant board book (lap baby, age 0-1).

Hard rules — every output MUST satisfy ALL of these:
1. EXACTLY 2 lines. Separated by a single "\\n".
2. AA rhyme: the last word of line 1 must rhyme with the last word of line 2 in real English. Identity rhymes ("hand / hand"), stem rhymes ("light / spotlight"), and suffix-only rhymes ("running / jumping") are NOT real rhymes — pick a different ending.
3. 2-4 words per line. Hard max 5 words. Tight, sing-song board-book cadence.
4. NO banned locomotion verbs (full list given in the user prompt). If the draft contains one, replace the action with a posture or sense the baby actually has — see SAFE verbs in the user prompt. Do NOT smuggle the action via body parts ("feet flash", "feet bounce") or via the parent ("Mama dances with her" still implies the baby is dancing) — pick a different image entirely.
5. Real English only. No invented rhyme-fill words ("farf", "blurp"). If the rhyme requires a fake word, pick a different rhyme.
6. Preserve the spread's core image and any personalization (child's name, custom prop, sensory detail) when it fits in 2 short lines. Drop sub-clauses, adverbs, and second sentences before you drop the personalization.
7. Keep the read-aloud pulse: matched line lengths, light alliteration is fine, no preachy moralizing.

Return ONLY strict JSON: { "text": "LINE1\\nLINE2" }. No prose, no explanation.`;

/**
 * Build the user-message body for a single spread compression.
 *
 * @param {object} args
 * @param {string} args.draftText  the writer's current spread text (any number of lines)
 * @param {object} args.spec       the spread spec (location, focalAction, plotBeat, etc.)
 * @param {object} args.brief      doc.brief — for personalization context
 * @param {string} args.heroName   the child's name (handy for personalization)
 * @returns {string}
 */
function userPrompt({ draftText, spec, brief, heroName }) {
  const personalizationBits = [];
  if (heroName) personalizationBits.push(`hero name: ${heroName}`);
  const interests = brief?.interests || brief?.questionnaire?.interests;
  if (Array.isArray(interests) && interests.length) {
    personalizationBits.push(`interests: ${interests.slice(0, 5).join(', ')}`);
  }
  const customDetails = brief?.customDetails || brief?.questionnaire?.customDetails;
  if (typeof customDetails === 'string' && customDetails.trim()) {
    personalizationBits.push(`custom: ${customDetails.slice(0, 200)}`);
  } else if (Array.isArray(customDetails) && customDetails.length) {
    personalizationBits.push(`custom: ${customDetails.slice(0, 3).join(' | ').slice(0, 200)}`);
  }

  const specBits = [];
  if (spec?.location) specBits.push(`location: ${spec.location}`);
  if (spec?.focalAction) specBits.push(`focalAction: ${spec.focalAction}`);
  if (spec?.plotBeat) specBits.push(`plotBeat: ${spec.plotBeat}`);

  return [
    `BANNED VERBS (any inflection — do NOT use): ${BANNED_INFANT_VERBS.join(', ')}.`,
    `SAFE VERBS (use these instead): ${SAFE_INFANT_VERBS.join(', ')}.`,
    '',
    'SPREAD CONTEXT:',
    specBits.length ? specBits.map(s => `- ${s}`).join('\n') : '- (none)',
    '',
    'PERSONALIZATION (preserve when it fits):',
    personalizationBits.length ? personalizationBits.map(s => `- ${s}`).join('\n') : '- (none)',
    '',
    'DRAFT TEXT (compress this — keep the core image, drop the rest):',
    '"""',
    String(draftText || '').trim(),
    '"""',
    '',
    'Return ONLY: { "text": "LINE1\\nLINE2" }',
  ].join('\n');
}

/**
 * Pick the best AA-rhyming pair from a multi-line block. Mirrors the
 * truncator's strategy so we have a deterministic last-resort fallback when
 * the LLM still emits more than 2 lines.
 */
function pickBestCouplet(text) {
  const lines = String(text || '')
    .split('\n')
    .map(l => l.replace(/\s+$/u, ''))
    .filter(l => l.trim().length > 0);
  if (lines.length <= 2) return lines.join('\n');
  const lastWord = (l) => {
    const m = String(l || '').toLowerCase().match(/([a-z']+)[^a-z']*$/i);
    return m ? m[1] : '';
  };
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (wordsRhyme(lastWord(lines[i]), lastWord(lines[j]))) {
        return [lines[i], lines[j]].join('\n');
      }
    }
  }
  return [lines[0], lines[1]].join('\n');
}

/**
 * Compress a single spread's text via a focused LLM call. Returns a
 * { text, llmCall } pair so the caller can both update the manuscript and
 * record the call in doc.llmCalls. Errors propagate — the caller decides
 * whether to fall back to the original draft.
 *
 * @param {object} args
 * @param {string} args.draftText
 * @param {object} args.spec
 * @param {object} args.brief
 * @param {string} args.heroName
 * @param {string} args.label    short label for the LLM trace (e.g. "writerCompress.s7")
 * @param {AbortSignal} [args.abortSignal]
 * @returns {Promise<{text:string, llmCall:object}>}
 */
async function compressInfantSpreadText(args) {
  const { draftText, spec, brief, heroName, label, abortSignal } = args;
  const result = await callText({
    model: MODELS.WRITER,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userPrompt({ draftText, spec, brief, heroName }),
    jsonMode: true,
    temperature: 0.4,
    maxTokens: 400,
    label: label || 'writerCompressInfant',
    abortSignal,
  });
  const raw = String(result?.json?.text || '').trim();
  const compressed = pickBestCouplet(raw);
  return {
    text: compressed,
    llmCall: {
      stage: label || 'writerCompressInfant',
      model: result.model,
      attempts: result.attempts,
      usage: result.usage,
    },
  };
}

/**
 * Walk every spread on an infant document, compress its manuscript text via
 * the focused LLM pass, and return the updated document. No-op for non-infant
 * bands. Per-spread errors are caught: we keep the original draft text rather
 * than failing the whole book — the writer-QA gate will still flag any
 * residual contract violations on the original text.
 *
 * @param {object} doc
 * @returns {Promise<object>}
 */
async function compressInfantManuscript(doc) {
  if (doc?.request?.ageBand !== AGE_BANDS.PB_INFANT) return doc;

  const heroName = doc?.brief?.heroName
    || doc?.request?.heroName
    || doc?.brief?.questionnaire?.heroName
    || '';
  const brief = doc?.brief || {};
  const abortSignal = doc?.operationalContext?.abortSignal;

  let next = doc;
  for (let n = 1; n <= TOTAL_SPREADS; n++) {
    const spread = next.spreads?.find(s => s.spreadNumber === n);
    if (!spread) continue;
    const draftText = spread?.manuscript?.text;
    if (!draftText || !draftText.trim()) continue;

    try {
      const { text, llmCall } = await compressInfantSpreadText({
        draftText,
        spec: spread.spec || {},
        brief,
        heroName,
        label: `writerCompressInfant.s${n}`,
        abortSignal,
      });
      if (text && text.trim()) {
        next = updateSpread(next, n, s => ({
          ...s,
          manuscript: { ...s.manuscript, text },
        }));
      }
      next = appendLlmCall(next, llmCall);
    } catch (err) {
      // Compression is best-effort: keep the original draft text and let
      // the writer-QA gate score it. Surface the failure on the LLM trace
      // so the pipeline log makes the cause clear.
      console.warn(`[writerCompressInfant.s${n}] compression failed: ${err?.message || err}`);
      next = appendLlmCall(next, {
        stage: `writerCompressInfant.s${n}`,
        model: MODELS.WRITER,
        attempts: 0,
        usage: {},
        error: err?.message || String(err),
      });
    }
  }

  return next;
}

module.exports = {
  compressInfantManuscript,
  compressInfantSpreadText,
  pickBestCouplet,
  BANNED_INFANT_VERBS,
  SAFE_INFANT_VERBS,
  SYSTEM_PROMPT,
};
