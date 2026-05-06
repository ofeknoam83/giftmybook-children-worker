/**
 * AA-CW-24 — brutally simple writer judge.
 *
 * One LLM call to gpt-5.4 (MODELS.WRITER_JUDGE). For each spread the judge
 * returns { broken: bool, issues: [], hints: [] }. Caller filters broken
 * spreads and rewrites only those. No book-level signal, no tags, no shadow
 * gemini, no deterministic audits, no repair plan.
 */

const { callText } = require('../llm/openaiClient');
const { MODELS } = require('../constants');
const { appendLlmCall } = require('../schema/bookDocument');

const JUDGE_SYSTEM = `You are judging a children's-book manuscript spread by spread.

Flag a spread \`broken: true\` ONLY for clear, concrete defects of these kinds:
- DROPPED ARTICLE: a preposition followed by a bare singular countable noun with no determiner ("in sun" → "in the sun"; "by chin" → "by Mama's chin").
- BROKEN RHYME: a couplet that does not actually rhyme out loud (identity rhymes like "cheek/cheek", slant rhymes with mismatched stressed vowels, suffix-only rhymes like "running/jumping", stem rhymes like "town/hometown").
- PRONOUN MISTAKE: a pronoun referring to the hero that does not match the hero pronouns provided in the user message.
- AGE-INAPPROPRIATE ACTION: for an infant book, a verb describing locomotion the lap-baby cannot perform with the baby as the subject ("Baby runs", "Scarlett twirls"). Body parts with non-locomotion verbs are fine.

When in doubt, mark the spread \`broken: false\`. Bias toward NOT flagging. Taste, mood, freshness, repetition, fragments — all the writer's call. Don't raise them.

For each broken spread return 1-3 specific \`issues\` (what's wrong) and 1-3 \`hints\` (how to fix). Hints should be concrete and actionable, e.g. "swap 'in sun' → 'in the sun'", or "rhyme 'sun'/'fun' or 'sun'/'run'". Keep hints tight.

Return ONLY this JSON:
{
  "perSpread": [
    { "spreadNumber": 1, "broken": false, "issues": [], "hints": [] },
    { "spreadNumber": 2, "broken": true, "issues": ["..."], "hints": ["..."] }
  ]
}
One entry per spread. No markdown, no prose.`;

function buildJudgeUserPrompt(doc) {
  const spreads = doc.spreads.map(s => ({
    spreadNumber: s.spreadNumber,
    text: s.manuscript?.text,
    side: s.manuscript?.side,
  }));
  const pronouns = doc?.brief?.pronouns || null;
  const heroName = doc?.brief?.child?.name || 'the hero';
  const ageBand = doc?.request?.ageBand || 'unknown';
  const pronounLine = pronouns
    ? `Hero "${heroName}" pronouns: subject=${pronouns.subject}, object=${pronouns.object}, possessive=${pronouns.possessive}, reflexive=${pronouns.reflexive}. Any other pronoun referring to ${heroName} is a pronoun mistake.`
    : `Hero name: ${heroName}.`;
  return [
    `Age band: ${ageBand}.`,
    pronounLine,
    `Spreads:\n${JSON.stringify(spreads, null, 2)}`,
    'Emit the JSON now.',
  ].join('\n');
}

/**
 * @param {object} args
 * @param {object} args.doc
 * @returns {Promise<{ perSpread: Array<{ spreadNumber:number, broken:boolean, issues:string[], hints:string[] }>, updatedDoc: object }>}
 */
async function judgeWriterDraft({ doc }) {
  const result = await callText({
    model: MODELS.WRITER_JUDGE,
    systemPrompt: JUDGE_SYSTEM,
    userPrompt: buildJudgeUserPrompt(doc),
    jsonMode: true,
    temperature: 0.2,
    maxTokens: 6000,
    label: 'writerQa.judge',
    abortSignal: doc.operationalContext?.abortSignal,
  });

  const json = result.json || {};
  const raw = Array.isArray(json.perSpread) ? json.perSpread : [];
  const byNumber = new Map();
  for (const entry of raw) {
    const n = Number(entry?.spreadNumber);
    if (!Number.isFinite(n)) continue;
    byNumber.set(n, entry);
  }
  const perSpread = doc.spreads.map(s => {
    const j = byNumber.get(s.spreadNumber) || {};
    return {
      spreadNumber: s.spreadNumber,
      broken: j.broken === true,
      issues: Array.isArray(j.issues) ? j.issues.map(String) : [],
      hints: Array.isArray(j.hints) ? j.hints.map(String) : [],
    };
  });

  const updatedDoc = appendLlmCall(doc, {
    stage: 'writerQa.judge',
    model: result.model,
    attempts: result.attempts,
    usage: result.usage,
  });

  return { perSpread, updatedDoc };
}

module.exports = {
  judgeWriterDraft,
  // exported for tests / introspection
  JUDGE_SYSTEM,
  buildJudgeUserPrompt,
};
