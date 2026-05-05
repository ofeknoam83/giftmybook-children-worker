/**
 * Planner Guard.
 *
 * Replaces the deterministic regex-based infant verb sanitizer (PR H,
 * deleted in AA-CW-2) with a single Flash LLM call that semantically
 * audits the planner's spread specs for infant-band violations.
 *
 * Why an LLM and not a regex list:
 *
 *   - The regex list (`INFANT_FORBIDDEN_PLANNER_VERBS`) chased a moving
 *     target — the planner LLM kept inventing locomotion phrasing the
 *     list didn't have ("breaks into a sprint", "strides ahead",
 *     "scampers"). Each miss meant a forbidden phrase reached the writer.
 *
 *   - The substitution map (`INFANT_VERB_SUBSTITUTIONS`) silently
 *     rewrote noun usage too — e.g. "a quiet walk" → "a quiet looks up at",
 *     producing nonsense focal actions. The writer then read garbage and
 *     produced garbage.
 *
 *   - Semantic understanding ("the baby is the still point — energy comes
 *     from the world around the baby") is a 1-line instruction for a small
 *     LLM, which can spot novel locomotion phrasings the regex list never
 *     anticipated.
 *
 * Contract:
 *
 *   - PB_INFANT only. No-op for other age bands.
 *   - One Gemini Flash call per planner attempt (NOT one per spread). The
 *     model receives the full set of 13 specs in a single structured prompt
 *     and returns `{ hits:[{ spreadNumber, problemPhrase, reason,
 *     suggestedAlternative }] }`.
 *   - Hits are stashed onto `doc.spreads[i].spec.plannerGuardHits` so the
 *     existing `validateSpreadSpecs` gate can surface them as issues, which
 *     triggers the existing planner-stage retry budget and writes a
 *     retryMemory entry the next planner attempt sees in its prompt.
 *   - On parse failure or LLM transport failure the guard logs a warning
 *     and returns the doc unchanged. We do NOT block the pipeline on a
 *     guard transport error — the writer-side LLM judge (PR AA-CW-4) is
 *     the second line of defense.
 *
 * This module owns ZERO regex of its own. The check is a pure semantic
 * audit by a small LLM.
 */

const { callText } = require('../llm/openaiClient');
const { MODELS, AGE_BANDS } = require('../constants');
const { appendLlmCall } = require('../schema/bookDocument');

const PLANNER_GUARD_SYSTEM = `You are an INFANT BAND safety auditor for a personalized children's picture book pipeline.

The book you are reviewing is a board book for a LAP BABY (ages 0-1). The child cannot walk, run, climb, jump, hop, skip, march, dance, twirl, leap, gallop, crawl across distances, stand on their own, or otherwise move themselves through space. The child sits, lies, looks, reaches, holds, snuggles, giggles, coos, pats, claps, hears, smells, touches, points, watches, waves, blinks, gasps. Energy and motion in the book come from THE WORLD AROUND THE BABY — light shifts, cloth flutters, Mama leans in, a leaf drifts past, music sways through the air.

You are reviewing the planner's spread specs (a structured list, one entry per spread). For each spread you receive:

  - spreadNumber
  - focalAction      — what is happening on this page
  - plotBeat         — the spread's role in the story arc

Your job: identify any phrasing in focalAction or plotBeat that puts the BABY in self-locomotion, asks the baby to do something the baby cannot do, or otherwise breaks the lap-baby contract. You are not checking grammar, rhyme, or beauty — only whether the action is physically possible for a 0-1 year old held in a parent's arms or seated in a parent's lap.

Examples of HITS (any phrasing that puts the baby in motion through space, regardless of which verb is used):

  - "Scarlett runs across the meadow" — the baby cannot run.
  - "She tiptoes toward the door" — the baby cannot tiptoe.
  - "He scampers after the ball" — the baby cannot scamper.
  - "Mira leaps for joy" — the baby cannot leap.
  - "Climbs onto Mama's lap on her own" — the baby cannot climb on their own.
  - "Strides into the kitchen" / "marches forward" / "breaks into a sprint" — same pattern.
  - "Dances around the room" — locomotion-as-dance is not lap-safe; "sways in Mama's arms" would be fine.
  - "Stands at the window" — the baby cannot stand on their own.

Examples of CLEAN (no hit):

  - "Mama lifts Scarlett to see the moon."
  - "Scarlett reaches for the soft red leaf as Mama holds her."
  - "The light moves across the wall while Scarlett watches from her cot."
  - "Mama sways with Scarlett in her arms; the music drifts in." (the baby is held — Mama provides the motion)
  - "Scarlett pats the warm bread on the table while sitting in her highchair."

Reframing rule: a focal action is CLEAN when the baby is the still point and the world (or the parent) provides the motion. A focal action is a HIT when the baby is the agent of locomotion.

Return strict JSON: { "hits": [ { "spreadNumber": <int>, "problemPhrase": "<the exact substring from focalAction or plotBeat that breaks the rule>", "reason": "<one-sentence explanation in plain English>", "suggestedAlternative": "<one-sentence rewrite that preserves the spread's intent but keeps the baby as the still point>" } ] }. Emit hits ONLY when you are confident the baby is the agent of locomotion. When in doubt, do not emit a hit. If the entire book is clean, emit { "hits": [] }.`;

function buildUserPrompt(doc) {
  const heroName = doc?.brief?.child?.name || 'the baby';
  const specs = (doc.spreads || [])
    .filter((s) => s && s.spec)
    .map((s) => ({
      spreadNumber: s.spreadNumber,
      focalAction: String(s.spec.focalAction || ''),
      plotBeat: String(s.spec.plotBeat || ''),
    }));
  return [
    `Hero name: ${heroName}.`,
    `Age band: PB_INFANT (0-1, lap baby).`,
    '',
    'Spread specs to audit (focalAction and plotBeat only — other fields omitted):',
    JSON.stringify(specs, null, 2),
    '',
    'Return the JSON object now.',
  ].join('\n');
}

/**
 * Run the planner guard against an infant book's spread specs.
 *
 * No-op for non-infant books. On hits, stashes
 * `spec.plannerGuardHits = [{ problemPhrase, reason, suggestedAlternative }]`
 * on each affected spread; the existing `validateSpreadSpecs` gate then
 * surfaces each hit as a validator issue, which triggers a planner-stage
 * retry via `runStage`'s gate-retry budget.
 *
 * On LLM transport / parse failure, logs a warning and returns doc
 * unchanged. The writer-side LLM judge (AA-CW-4) is the second line
 * of defense.
 *
 * @param {object} doc
 * @returns {Promise<object>} doc with optional `spec.plannerGuardHits`
 */
async function runPlannerGuard(doc) {
  if (doc?.request?.ageBand !== AGE_BANDS.PB_INFANT) return doc;
  const bookId = doc?.operationalContext?.bookId || 'n/a';

  let result;
  try {
    result = await callText({
      model: MODELS.WRITER_QA, // gemini-2.5-flash
      systemPrompt: PLANNER_GUARD_SYSTEM,
      userPrompt: buildUserPrompt(doc),
      jsonMode: true,
      temperature: 0,
      maxTokens: 2000,
      label: 'plannerGuard',
      abortSignal: doc.operationalContext?.abortSignal,
    });
  } catch (err) {
    console.warn(
      `[bookPipeline:${bookId}] plannerGuard LLM call failed; skipping guard for this attempt: ${err?.message || err}`,
    );
    return doc;
  }

  const hits = Array.isArray(result?.json?.hits) ? result.json.hits : [];
  console.log(
    `[bookPipeline:${bookId}] plannerGuard reported ${hits.length} hit(s)` +
      (hits.length ? `: ${hits.map((h) => `spread${h.spreadNumber}="${h.problemPhrase}"`).join(', ')}` : ''),
  );

  // Stash hits per spread. validateSpreadSpecs will read these and surface
  // them as validator issues, which triggers the runStage retry loop.
  let next = doc;
  if (hits.length) {
    const bySpread = new Map();
    for (const h of hits) {
      const n = Number(h?.spreadNumber);
      if (!Number.isFinite(n)) continue;
      const arr = bySpread.get(n) || [];
      arr.push({
        problemPhrase: String(h.problemPhrase || ''),
        reason: String(h.reason || ''),
        suggestedAlternative: String(h.suggestedAlternative || ''),
      });
      bySpread.set(n, arr);
    }
    next = {
      ...next,
      spreads: next.spreads.map((s) => {
        const guardHits = bySpread.get(s.spreadNumber);
        if (!guardHits || !guardHits.length) return s;
        return {
          ...s,
          spec: { ...s.spec, plannerGuardHits: guardHits },
        };
      }),
    };
  }

  next = appendLlmCall(next, {
    stage: 'plannerGuard',
    model: result.model,
    attempts: result.attempts,
    usage: result.usage,
  });

  return next;
}

module.exports = {
  runPlannerGuard,
  // Exposed for unit tests only.
  __testInternals: {
    PLANNER_GUARD_SYSTEM,
    buildUserPrompt,
  },
};
