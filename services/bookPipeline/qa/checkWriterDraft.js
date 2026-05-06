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

const JUDGE_SYSTEM = `You are judging a children's-book manuscript spread by spread. Each spread is exactly 4 lines.

IDENTITY-RHYME GATE — CHECK THIS FIRST, BEFORE ANYTHING ELSE.
- Look at the last word of each of the 4 lines (strip punctuation, lowercase).
- If the last word of L1 equals the last word of L2, the spread is broken.
- If the last word of L3 equals the last word of L4, the spread is broken.
- This applies even when the words appear in different phrases ("sees green trees" / "walks by trees" — still broken: trees=trees).
- This applies even when the words have different meanings or parts of speech ("settles close" / "Smushy, close" — still broken: close=close).
- No interpretation. Same word twice = broken. Always.
- Issue: "L1/L2 identity rhyme: both end on 'trees'" (or "L3/L4 identity rhyme: both end on 'shade'").
- Hint: "change one of the two end-words; e.g. rewrite L2 to end on a different real rhyme for 'trees' such as 'breeze' or 'knees'".

THE RHYME SCHEME IS AABB. This is the most important rule.
- L1 must rhyme with L2.
- L3 must rhyme with L4.
- The two couplets do NOT need to rhyme with each other.
- A rhyme means the stressed vowels and everything after them sound the same out loud ("sun/fun", "high/sky", "near/hear").
- These are NOT rhymes and must be flagged:
  - identity rhymes (same word twice — see the IDENTITY-RHYME GATE above; also covers cases where the same word ends BOTH lines of a couplet within different phrases): "cheek/cheek", "glow/glow", "slow/slow", "trees/trees", "shade/shade", "close/close".
  - stem/containment rhymes where one word is contained in the other: "by/nearby", "high/nearby" only-share-y, "town/hometown", "way/byway".
  - suffix-only rhymes: "running/jumping", "played/shaded".
  - mismatched tail vowels: "near/side", "hand/below", "there/Scarlett", "Mama/close", "low/again".
  - the words "Mama" and "drama" are NOT acceptable rhyme partners — "drama" almost never fits a children's-book scene and is filler.
- If EITHER couplet fails to rhyme, the spread is broken. No exceptions.

MEANING CHECK — equal weight to rhyme. A line whose end-word is rhyme-driven filler is broken even if the acoustic rhyme works:
- Flag a line where the end-word does not make literal sense in the sentence: "her hand meets bright" (bright is not a thing you meet), "Mama lifts her by" ("by" used as a sentence end with no object), "Mama says, Smushy, nigh" (nigh is archaic and meaningless here), "the grass hums some drama" (grass doesn't hum drama on a porch).
- Flag archaic / poetic filler in modern children's verse: "nigh", "yon", "thee", "o'er", end-of-line "by" with no object. Children's books use plain modern English.
- Flag past-tense verbs shoved in for rhyme: "leaves played" (leaves don't get played), "sees leaves played" (ungrammatical past participle).
- The rule of thumb: if you cannot say WHAT the line literally means in one short clause, the line is broken. Issue the rewrite.

Also flag a spread \`broken: true\` for these (only if clearly present):
- DROPPED ARTICLE: a preposition followed by a bare singular countable noun with no determiner ("in sun" → "in the sun"; "by chin" → "by Mama's chin").
- PRONOUN MISTAKE: a pronoun referring to the hero that does not match the hero pronouns provided in the user message. Also flag pronouns whose antecedent is genuinely ambiguous between the hero and another character on the same spread.
- AGE-INAPPROPRIATE ACTION: for an infant book, a verb describing locomotion the lap-baby cannot perform with the baby as the subject ("Baby runs", "Scarlett twirls"). Body parts with non-locomotion verbs are fine.
- VERBATIM REPETITION: a full line that appears verbatim on another spread, OR a 3+ word phrase that recurs across 4 or more spreads (e.g. "Mama holds her ___" appearing on spreads 1, 4, 10, 11 is a structural crutch). The opening and closing spreads MAY echo each other deliberately — don't flag spread 1 vs the final spread for a single-line echo. Flag the later occurrence(s) when the same phrase pattern dominates the book.
- CONTINUITY BREAK: a concrete prop or location that doesn't fit the established scene (a "curb" on a porch swing, a "gate" with no setup). Use light judgment; only flag obvious mismatches.

For rhyme breaks, the issue MUST name the failing couplet ("L3/L4 do not rhyme: 'near' vs 'side'") and the hint MUST suggest a concrete rewrite that preserves the meaning of the spread ("rewrite L4 to end on a word rhyming with 'near' such as 'hear', 'clear', 'dear'").

For everything else, when in doubt, mark \`broken: false\`. Bias toward NOT flagging taste, mood, or fragment style.

For each broken spread return 1-3 specific \`issues\` (what's wrong, naming the offending lines) and 1-3 \`hints\` (how to fix). Keep hints tight.

Return ONLY this JSON:
{
  "perSpread": [
    { "spreadNumber": 1, "broken": false, "issues": [], "hints": [] },
    { "spreadNumber": 2, "broken": true, "issues": ["..."], "hints": ["..."] }
  ]
}
One entry per spread. No markdown, no prose.`;

/**
 * AA-CW-27: deterministic identity-rhyme detector.
 * Returns { couplet: 'L1/L2'|'L3/L4', word: string } if the spread has
 * a same-word identity rhyme on either couplet. Returns null otherwise.
 */
function detectIdentityRhyme(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 4) return null;
  const lastWord = (line) => {
    const m = String(line).toLowerCase().match(/([a-z']+)[^a-z']*$/);
    return m ? m[1] : null;
  };
  const w1 = lastWord(lines[0]);
  const w2 = lastWord(lines[1]);
  const w3 = lastWord(lines[2]);
  const w4 = lastWord(lines[3]);
  if (w1 && w2 && w1 === w2) return { couplet: 'L1/L2', word: w1 };
  if (w3 && w4 && w3 === w4) return { couplet: 'L3/L4', word: w3 };
  return null;
}

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
    const entry = {
      spreadNumber: s.spreadNumber,
      broken: j.broken === true,
      issues: Array.isArray(j.issues) ? j.issues.map(String) : [],
      hints: Array.isArray(j.hints) ? j.hints.map(String) : [],
    };
    // AA-CW-27: deterministic identity-rhyme safety net. The judge has
    // missed identity rhymes (trees/trees, shade/shade, close/close) on
    // multiple production books despite explicit prompt rules. Force-flag
    // any spread where L1==L2 or L3==L4 by last-word.
    const idRhyme = detectIdentityRhyme(s.manuscript?.text || '');
    if (idRhyme) {
      entry.broken = true;
      const issue = `${idRhyme.couplet} identity rhyme: both end on '${idRhyme.word}'`;
      const hint = `change one of the two end-words; pick a real rhyme partner for '${idRhyme.word}'`;
      if (!entry.issues.includes(issue)) entry.issues.unshift(issue);
      if (!entry.hints.includes(hint)) entry.hints.unshift(hint);
    }
    return entry;
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
  detectIdentityRhyme,
};
