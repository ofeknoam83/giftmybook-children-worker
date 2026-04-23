/**
 * Writer-side QA for the full manuscript.
 *
 * Runs two signal layers:
 *   1. Deterministic checks (side mismatch, length, basic readability,
 *      personalization coverage, preachiness markers).
 *   2. A model-assisted literary review that returns a per-spread verdict
 *      and concrete rewrite directives.
 *
 * Returns `{ pass, perSpread, bookLevel, repairPlan }`.
 */

const { callText } = require('../llm/openaiClient');
const { MODELS } = require('../constants');
const { appendLlmCall } = require('../schema/bookDocument');
const { renderThemeDirectiveBlock } = require('../planner/themeDirectives');

const PREACH_MARKERS = [
  /\b(always remember|never forget|the lesson is|the moral is|you should always|we all must)\b/i,
];

const MAX_WORDS_PER_LINE = 14;

function splitLines(text) {
  return String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
}

function wordCount(s) {
  return (String(s || '').match(/\S+/g) || []).length;
}

function deterministicCheck(spread) {
  const issues = [];
  const tags = [];
  const m = spread.manuscript;
  const spec = spread.spec;
  if (!m || !m.text) {
    return { pass: false, issues: ['manuscript missing'], tags: ['missing_text'] };
  }

  if (spec && m.side !== spec.textSide) {
    issues.push(`side mismatch: spec=${spec.textSide} manuscript=${m.side}`);
    tags.push('side_mismatch');
  }

  const lines = splitLines(m.text);
  if (lines.length > 5) {
    issues.push(`too many lines: ${lines.length}`);
    tags.push('too_many_lines');
  }
  const overLong = lines.filter(l => wordCount(l) > MAX_WORDS_PER_LINE);
  if (overLong.length) {
    issues.push(`lines too long (>${MAX_WORDS_PER_LINE} words): ${overLong.length}`);
    tags.push('line_too_long');
  }

  const preachy = PREACH_MARKERS.some(rx => rx.test(m.text));
  if (preachy) {
    issues.push('preachy phrasing detected');
    tags.push('preachy');
  }

  return { pass: issues.length === 0, issues, tags };
}

const LITERARY_QA_SYSTEM = `You are a senior children's book editor.
You review an existing manuscript for:
 - story coherence and payoff
 - read-aloud musicality
 - age fit for the given band
 - personalization that feels real, not tacked on
 - absence of preachy moralizing
 - rhyme quality where rhyme applies
Return ONLY strict JSON. Be specific and actionable. Mark "pass": true only if the book is genuinely strong.`;

function literaryQaUserPrompt(doc) {
  const spreads = doc.spreads.map(s => ({
    spreadNumber: s.spreadNumber,
    spec: s.spec,
    text: s.manuscript?.text,
    side: s.manuscript?.side,
  }));
  const themeBlock = renderThemeDirectiveBlock(doc.request.theme);
  return [
    `Format: ${doc.request.format}. Age band: ${doc.request.ageBand}. Theme: ${doc.request.theme}.`,
    themeBlock,
    themeBlock ? 'If the manuscript uses any BANNED CLICHÉS from the theme directive, tag those spreads with "theme_cliche" and fail.' : '',
    `Story bible:\n${JSON.stringify(doc.storyBible, null, 2)}`,
    `Spreads:\n${JSON.stringify(spreads, null, 2)}`,
    '',
    'Return JSON:',
    `{
  "pass": true|false,
  "bookLevelIssues": ["..."],
  "perSpread": [
    { "spreadNumber": 1, "issues": ["..."], "tags": ["..."], "suggestedRewrite": "optional short directive" }
  ]
}`,
  ].join('\n');
}

/**
 * @param {object} doc
 * @returns {Promise<{ pass: boolean, perSpread: object[], bookLevel: string[], repairPlan: object[], updatedDoc: object }>}
 */
async function checkWriterDraft(doc) {
  const deterministic = doc.spreads.map(s => ({
    spreadNumber: s.spreadNumber,
    ...deterministicCheck(s),
  }));

  const result = await callText({
    model: MODELS.WRITER_QA,
    systemPrompt: LITERARY_QA_SYSTEM,
    userPrompt: literaryQaUserPrompt(doc),
    jsonMode: true,
    temperature: 0.3,
    maxTokens: 7000,
    label: 'writerQa',
    abortSignal: doc.operationalContext?.abortSignal,
  });

  const literary = result.json || {};
  const perSpreadLit = Array.isArray(literary.perSpread) ? literary.perSpread : [];
  const bookLevel = Array.isArray(literary.bookLevelIssues) ? literary.bookLevelIssues : [];

  const merged = doc.spreads.map(s => {
    const det = deterministic.find(d => d.spreadNumber === s.spreadNumber) || { pass: true, issues: [], tags: [] };
    const lit = perSpreadLit.find(l => Number(l?.spreadNumber) === s.spreadNumber) || {};
    const issues = [...det.issues, ...(Array.isArray(lit.issues) ? lit.issues.map(String) : [])];
    const tags = [...det.tags, ...(Array.isArray(lit.tags) ? lit.tags.map(String) : [])];
    return {
      spreadNumber: s.spreadNumber,
      pass: issues.length === 0,
      issues,
      tags,
      suggestedRewrite: lit.suggestedRewrite ? String(lit.suggestedRewrite) : null,
    };
  });

  const repairPlan = merged.filter(m => !m.pass);
  const pass = literary.pass === true && repairPlan.length === 0;

  const updatedDoc = appendLlmCall(doc, {
    stage: 'writerQa',
    model: result.model,
    attempts: result.attempts,
    usage: result.usage,
  });

  return {
    pass,
    perSpread: merged,
    bookLevel,
    repairPlan,
    updatedDoc,
  };
}

module.exports = { checkWriterDraft };
