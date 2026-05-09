/**
 * AA-CW-24 — brutally simple writer↔judge loop.
 *
 *   draft → judge → rewrite broken spreads → judge → … (3 waves max)
 *
 * Tracks the best-seen draft by broken-spread count and ALWAYS returns the
 * best draft — never throws, never fails the book. After the last rewrite
 * wave, runs one final judge pass so the last writer output is honestly
 * scored against the best.
 *
 * Budget: up to 3 judge calls + 3 writer calls + 1 final judge call = 7
 * LLM calls per book in the worst case.
 */

const { callText } = require('../llm/openaiClient');
const { MODELS, REPAIR_BUDGETS, TOTAL_SPREADS, getWriterTemperature } = require('../constants');
const { updateSpread, appendLlmCall, withStageResult, incrementCounter } = require('../schema/bookDocument');
const { renderTextPolicyBlock } = require('./textPolicies');
const { renderStoryArcContext, renderVoiceAndRefrain } = require('./draftBookText');
const { judgeWriterDraft } = require('../qa/checkWriterDraft');

const REWRITE_SYSTEM_PROMPT = `You are rewriting specific spreads of a children's book. Keep every other spread exactly as-is.

For each spread listed in the user message, produce an improved version that addresses the listed issues using the provided hints. Honor the spread spec (side, beat, personalization). Read-aloud first. Musical, simple, low repetition. Funny/playful tone, never preachy.

Picture-book structure: emit EXACTLY 4 lines per spread, separated by "\\n", in AABB rhyming couplets. Real end-rhymes only — no identity rhymes ("cheek/cheek", "glow/glow"), no slant rhymes with mismatched stressed vowels, no suffix-only rhymes ("running/jumping"), no stem/containment rhymes ("by/nearby", "town/hometown"), no "Mama/drama" cop-outs. For PB_INFANT the per-line word budget is tight (~2-5 words/line); other bands per the policy block.

MEANING FIRST. Every word — especially the line-ending rhyme word — must mean something concrete in the sentence. NEVER use a word just because it rhymes. Forbidden filler patterns:
- archaic / poetic words: "nigh", "yon", "thee", "o'er".
- end-of-line "by" with no object ("Mama lifts her by" — by what?).
- nouns or verbs that don't fit the scene just to land a rhyme ("the grass hums some drama", "sees leaves played").
- abstract end-words used as if concrete ("her hand meets bright").
If you can't say in one short clause WHAT the line literally means, rewrite it. Pick a different rhyme pair instead of forcing filler.

VARY YOUR PHRASES. Do not lean on a single sentence frame across the book (e.g. "Mama holds her near / tight / still / there / slow" recurring on 4+ spreads). Each spread should bring fresh syntax.

Use the hero pronouns the user message provides — do not switch pronouns mid-book. For infant books, do NOT attribute locomotion verbs (jump/run/twirl/dance/walk/climb/hop/skip/march/stand/step/bounce/etc.) to the baby; the baby is held, carried, or seated.

Return ONLY strict JSON:
{ "spreads": [ { "spreadNumber": N, "text": "LINE1\\nLINE2\\nLINE3\\nLINE4", "side": "left|right", "lineBreakHints": ["..."], "personalizationUsed": ["..."], "writerNotes": "optional" } ] }`;

function buildRewriteUserPrompt(doc, brokenSpreads) {
  const bySpread = new Map(doc.spreads.map(s => [s.spreadNumber, s]));
  const items = brokenSpreads.map(b => {
    const s = bySpread.get(b.spreadNumber);
    if (!s) return null;
    return {
      spreadNumber: b.spreadNumber,
      spec: s.spec,
      currentText: s.manuscript?.text || '',
      currentSide: s.manuscript?.side || null,
      issues: b.issues || [],
      hints: b.hints || [],
    };
  }).filter(Boolean);

  const pronouns = doc?.brief?.pronouns || null;
  const heroName = doc?.brief?.child?.name || 'the hero';
  const pronounBlock = pronouns
    ? `Hero "${heroName}" pronouns — use ONLY these: subject=${pronouns.subject}, object=${pronouns.object}, possessive=${pronouns.possessive}, reflexive=${pronouns.reflexive}.`
    : '';
  const arcContextBlock = renderStoryArcContext(doc.storyBible) || '';
  // Phase 2 — even rewrites must hold the voice + refrain contract. A
  // rewrite that fixes a rhyme but loses the narrator's signature move or
  // the refrain placement is a regression, not a fix.
  const voiceAndRefrainBlock = renderVoiceAndRefrain(doc.storyBible) || '';

  return [
    voiceAndRefrainBlock ? `${voiceAndRefrainBlock}\n` : '',
    renderTextPolicyBlock(doc),
    arcContextBlock ? `\n${arcContextBlock}` : '',
    pronounBlock ? `\n${pronounBlock}` : '',
    '',
    `Rewrite ONLY these spreads. Leave all other spreads untouched.`,
    `Use the issues + hints below to fix each spread:`,
    JSON.stringify(items, null, 2),
    '',
    'Emit the JSON now.',
  ].filter(Boolean).join('\n');
}

function mergeRewrites(doc, json) {
  const arr = Array.isArray(json?.spreads) ? json.spreads : [];
  let next = doc;
  for (const entry of arr) {
    const n = Number(entry?.spreadNumber);
    if (!Number.isFinite(n) || n < 1 || n > TOTAL_SPREADS) continue;
    const manuscript = {
      text: String(entry.text || '').trim(),
      side: entry.side === 'left' ? 'left' : 'right',
      lineBreakHints: Array.isArray(entry.lineBreakHints) ? entry.lineBreakHints.map(String) : [],
      personalizationUsed: Array.isArray(entry.personalizationUsed) ? entry.personalizationUsed.map(String) : [],
      writerNotes: entry.writerNotes ? String(entry.writerNotes) : null,
    };
    if (!manuscript.text) continue;
    next = updateSpread(next, n, s => ({ ...s, manuscript }));
  }
  return next;
}

async function rewriteSpreads(doc, brokenSpreads, wave) {
  const ageBand = doc?.request?.ageBand || '(none)';
  const temperature = getWriterTemperature('rewrite', ageBand);
  console.log(`[writer:rewrite.wave${wave}] ageBand=${ageBand} temperature=${temperature} broken=${brokenSpreads.length}`);
  const result = await callText({
    model: MODELS.WRITER,
    systemPrompt: REWRITE_SYSTEM_PROMPT,
    userPrompt: buildRewriteUserPrompt(doc, brokenSpreads),
    jsonMode: true,
    temperature,
    maxTokens: 7000,
    label: `writerRewrite.wave${wave}`,
    abortSignal: doc.operationalContext?.abortSignal,
  });
  let next = mergeRewrites(doc, result.json);
  next = appendLlmCall(next, {
    stage: 'writerRewrite',
    wave,
    model: result.model,
    attempts: result.attempts,
    usage: result.usage,
  });
  return next;
}

/**
 * Writer QA + rewrite loop. ALWAYS returns the best-seen draft. NEVER throws.
 *
 * @param {object} doc
 * @returns {Promise<object>}
 */
async function writerQaAndRewrite(doc) {
  const maxWaves = Number.isFinite(REPAIR_BUDGETS.writerRewriteWaves)
    ? REPAIR_BUDGETS.writerRewriteWaves
    : 3;
  const bookId = doc?.operationalContext?.bookId || doc?.request?.bookId || 'n/a';

  let current = doc;
  let best = { draft: doc, brokenCount: Infinity, perSpread: null };
  let lastPerSpread = null;

  for (let wave = 1; wave <= maxWaves; wave += 1) {
    const { perSpread, updatedDoc } = await judgeWriterDraft({ doc: current });
    current = updatedDoc;
    lastPerSpread = perSpread;
    const brokenSpreads = perSpread.filter(s => s.broken);
    console.log(`[writerQa:${bookId}] wave=${wave} broken=${brokenSpreads.length}`);

    if (brokenSpreads.length < best.brokenCount) {
      best = { draft: current, brokenCount: brokenSpreads.length, perSpread };
    }
    if (brokenSpreads.length === 0) break;
    if (wave === maxWaves) break;

    try {
      current = await rewriteSpreads(current, brokenSpreads, wave);
      incrementCounter(current, 'writer.reviseLoopsUsed');
    } catch (err) {
      console.warn(`[writerQa:${bookId}] wave=${wave} rewrite call failed: ${err?.message || err}. Returning best-seen draft.`);
      break;
    }
  }

  // Final judge pass: if the last rewrite wave produced a different draft than
  // `best.draft`, score it once more so best-seen tracking is honest.
  if (current !== best.draft) {
    try {
      const { perSpread: finalPerSpread, updatedDoc } = await judgeWriterDraft({ doc: current });
      current = updatedDoc;
      lastPerSpread = finalPerSpread;
      const finalBroken = finalPerSpread.filter(s => s.broken).length;
      console.log(`[writerQa:${bookId}] final-judge broken=${finalBroken} bestSoFar=${best.brokenCount}`);
      if (finalBroken < best.brokenCount) {
        best = { draft: current, brokenCount: finalBroken, perSpread: finalPerSpread };
      }
    } catch (err) {
      console.warn(`[writerQa:${bookId}] final judge pass failed: ${err?.message || err}. Keeping best-seen draft.`);
    }
  }

  console.log(`[writerQa:${bookId}] DONE finalBrokenCount=${best.brokenCount}`);

  return withStageResult(best.draft, {
    writerQa: {
      pass: best.brokenCount === 0,
      finalBrokenCount: best.brokenCount,
      perSpread: best.perSpread || lastPerSpread || [],
    },
  });
}

/**
 * Phase 4 — prose ↔ image feedback edge.
 *
 * When the illustrator's QA flags a writer-side cause (age_action_impossible,
 * action_mismatch with a clearly-prose origin), the renderer can call this
 * helper to rewrite JUST that one spread's text before re-rendering. The
 * caller decides bounding (the per-spread loop should allow at most ONE
 * prose revision so we don't spend the whole render budget on the writer).
 *
 * Returns the updated doc (the spread's manuscript is replaced with the
 * new text). On any failure (writer call throws, JSON malformed, no spread
 * matched), returns the doc unchanged so the renderer can continue with
 * its existing budget.
 *
 * @param {object} doc
 * @param {number} spreadNumber
 * @param {object} veto - { tags: string[], issues: string[], hints?: string[] }
 *   The reason the renderer wants the prose changed. Forwarded into the
 *   writer's user prompt verbatim — be specific.
 * @returns {Promise<object>} updated doc
 */
async function reviseSpreadProseForIllustrator(doc, spreadNumber, veto) {
  const tags = Array.isArray(veto?.tags) ? veto.tags : [];
  const issues = Array.isArray(veto?.issues) ? veto.issues : [];
  const hints = Array.isArray(veto?.hints) ? veto.hints : [];

  // Construct the brokenSpread shape rewriteSpreads expects. Tag the
  // veto source so the writer's user prompt can read it as a clear
  // illustrator-driven instruction, not just another quality issue.
  const renderedHints = [
    ...hints,
    `Illustrator could not render this spread because of these tags: [${tags.join(', ')}]. ` +
    `Rewrite the prose so the named action is something the hero can physically do at this age, ` +
    `the named props are on this spread's proseProps whitelist, and the focal action lines up with ` +
    `the spread spec. Keep the voice, refrain placement, and rhyme contract intact.`,
  ];
  const brokenSpread = { spreadNumber, issues, hints: renderedHints };

  try {
    return await rewriteSpreads(doc, [brokenSpread], `proseRevise.spread${spreadNumber}`);
  } catch (err) {
    console.warn(
      `[writer:proseRevise.spread${spreadNumber}] failed: ${err?.message || 'unknown'} — ` +
      `keeping existing manuscript and letting the render loop continue.`,
    );
    return doc;
  }
}

module.exports = {
  writerQaAndRewrite,
  reviseSpreadProseForIllustrator,
  // exported for tests / introspection
  REWRITE_SYSTEM_PROMPT,
  buildRewriteUserPrompt,
  mergeRewrites,
};
