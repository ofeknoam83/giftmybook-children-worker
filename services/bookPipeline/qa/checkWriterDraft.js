/**
 * AA-CW-4 — Writer-side QA, rewritten as a single LLM judge.
 *
 * Authoritative path: ONE call to a strong LLM (gpt-5.4) that returns the
 * full per-spread + book-level verdict in structured JSON. The 25
 * deterministic helpers from the previous implementation (verb-crutch
 * lemmatization, dropped-article regex, address-name concat, fragment
 * detection, phonetic rhyme tail comparator, nonsense-word lexicon,
 * nonsense-simile keyword list, peer-framing matcher, refrain-crutch
 * counter, infant forbidden-verb regex stack, line-count truncator,
 * etc.) are all DELETED in this PR. The judge prompt enumerates every
 * one of those failure modes with concrete BAD/GOOD examples so the LLM
 * carries the entire signal.
 *
 * Two side calls remain:
 *   1. Infant locomotion gate — a pure Flash call (no regex) that
 *      returns the list of forbidden-verb hits per infant spread. Used
 *      both inside the judge verdict AND by the writer-rewrite hard
 *      gate in rewriteBookText.js (`findInfantForbiddenActionVerbs`).
 *   2. Shadow run — the old gemini-2.5-flash literary call still fires
 *      in parallel; its verdict is logged to stdout + appended to
 *      `doc.llmCalls` under stage `writerQa.shadow` for diffing during
 *      the rollout window. NOT authoritative.
 *
 * `signatureBeats.checkSignatureBeatCoverage` survives as a cheap
 * deterministic preflight (token-presence over per-anchor keywords)
 * because the questionnaire-anchor coverage signal is structured data,
 * not a literary judgment, and the same module is also consumed by
 * planner/anchorAllocation. It feeds the judge prompt as
 * `signatureBeatsHint` and gates the final pass independently.
 *
 * Returns `{ pass, perSpread, bookLevel, bookLevelTags, repairPlan, updatedDoc }`.
 */

const { callText } = require('../llm/openaiClient');
const { MODELS, AGE_BANDS } = require('../constants');
const { appendLlmCall } = require('../schema/bookDocument');
const { renderThemeDirectiveBlock } = require('../planner/themeDirectives');
const { checkSignatureBeatCoverage, describeBeat } = require('./signatureBeats');

// =============================================================================
// Judge prompt (authoritative)
// =============================================================================

const JUDGE_SYSTEM = `You are the senior children's-book editor and the FINAL gate before this manuscript ships. You are not a polite reviewer — you are the last line of defense against bad children's books being printed and mailed to a real family. Be brutal. Hedge nothing. If a couplet does not rhyme, fail it. If an infant book describes the baby running, fail it. If a parent's first name is jammed against an address word, fail it. Your verdict is authoritative.

You receive: format, ageBand, theme, brief (child name, pronouns, anecdotes, interests, parents), storyBible, the full per-spread manuscript (text + side + spec), an optional theme-directive block listing banned clichés, and an optional signatureBeatsHint listing questionnaire anchors that look unlanded.

You return ONE JSON object with the schema given at the bottom. No prose, no markdown.

== Universal expectations ==
- Story coherence and emotional payoff across the 13 spreads (act-1 setup, act-2 stakes, act-3 resolution).
- Read-aloud musicality. Clear pulse. No tongue-twisters.
- Age-fit: vocabulary, action, sensory range, attention budget all match the declared age band.
- Real personalization: hero name, pronouns, parents' address forms (Mama/Daddy/etc.), interests, anecdotes from the questionnaire all appear and feel native — not tacked on.
- No preachy moralizing ("always remember", "the lesson is", "never forget", "you should always", "the moral is", "we all must").
- Pronoun discipline: ONE pronoun set for the hero, declared in brief.pronouns. Never alternate, never swap, never use a different set anywhere in the book. When ambiguous, prefer the hero's name.

== Picture-book hard rules (format == "picture_book") — apply to ALL bands ==
- LINE COUNT: EXACTLY 4 lines per spread for ALL picture-book age bands (PB_INFANT 0-1, PB_TODDLER 0-3, PB_PRESCHOOL 3-6). Two AABB rhyming couplets. NEVER accept 2-line spreads. Lines separated by "\\n".
- AABB rhyme scheme: lines 1+2 rhyme; lines 3+4 rhyme. Real end-rhymes or near-rhymes only.
- Per-line word budget:
  * PB_INFANT (0-1): 2-5 words/line, hardMax 6.
  * PB_TODDLER (0-3): 3-7 words/line, hardMax 8.
  * PB_PRESCHOOL (3-6): 6-12 words/line, hardMax 14.
- Consistent musical pulse within each couplet.

== Failure modes — tag exactly as named ==
Each issue must carry one of these tags. Multiple tags allowed per spread.

1. "rhyme_fail" — couplet does not really rhyme. INCLUDES:
   - Non-rhymes: "sing/plan", "sigh/Deana", "sniff/off", "high/cuddle".
   - Identity rhymes (same word): "town/town", "squeals/squeals", "light/light".
   - Stem rhymes (one word contains the other): "town/hometown", "light/spotlight", "day/today".
   - Suffix-only rhymes (only the grammatical ending matches): "running/jumping", "sadly/badly", "quickly/slowly", "playing/staying".
   GOOD: "town/down", "light/bright", "day/play", "high/sky", "ball/tall".
   In the issue text, name the offending pair AND which sub-mode it is (identity / stem / suffix-only / non-rhyming).

2. "dropped_article" — a preposition is followed by a bare singular countable noun with no determiner. BAD: "down street", "by feet", "on bench", "in room". GOOD: "down THE street", "by HER feet", "on a bench", "in HIS room". This is broken phrasing, never a stylistic choice.

3. "address_name_concat" — a parental address term jammed against the parent's proper first name. BAD: "Mama Courtney", "Daddy John", "Mommy Sarah", "Papa Tom". GOOD: pick one — "Mama" OR "Courtney", never both back-to-back.

4. "verb_crutch" — ONE content verb dominates the manuscript (>~25% of spreads). Book-level. Name the overused verb and how many spreads it appears in.

5. "refrain_crutch" — ONE non-verb content word (noun, onomatopoeia, exclamation) dominates the manuscript (>~25% of spreads, >~20% for infant). Distinct from verb_crutch. Book-level. Excludes the child's name and declared parent address words. Name the overused word.

6. "low_personalization_saturation" — substantive personalization items from the brief (interests, anecdotes, address forms, custom details) appear in fewer than ~60% of relevant spreads. Book-level. Name the missing items.

7. "signature_beat_missing" — a questionnaire anchor (funny_thing, meaningful_moment, moms_favorite_moment, dads_favorite_moment, anything_else, calls_mom, calls_dad) does NOT surface in any spread. Book-level. Use the signatureBeatsHint input as a pre-screen but make your own call from the manuscript text.

8. "age_mismatch_action" — action attributed to the child is implausible for the declared age band. Per-spread.

9. "infant_action_verb_in_text" — for PB_INFANT (0-1) ONLY, the manuscript uses a locomotion verb the baby physically cannot do. Banned roots (any inflection — base, -s, -ed, -ing): jump, run, race, spin, twirl, hop, walk, climb, leap, dance, chase, grab, skip, gallop, stomp, march, crawl, step, stand/stood, bounce, cartwheel, tumble. ALSO reject body-part displacement constructions: "feet flash", "feet pound", "feet step", "feet bounce", "legs kick" (when the baby is the agent). Use sit/lie/look/reach/giggle/coo/hold/snuggle/nuzzle/wiggle instead. Per-spread. List the offending verb(s) in the issue text.

10. "nonsense_word" — the manuscript invents a fake word to force a rhyme. BAD: "farf" rhymed with "scarf", "blurp" rhymed with "burp", "shloop" rhymed with "scoop". Real English only (proper names and onomatopoeia like "boop", "pop", "shh" are fine). Name the invented word in the issue.

11. "nonsense_simile" — a simile ("X as Y", "X like Y") whose comparand is implausible for a baby/preschooler. BAD: "light as code", "soft as math", "like an algorithm", "loud as a server". GOOD: "soft as fluff", "warm as toast", "loud as thunder". Per-spread.

12. "parent_theme_relationship_framing" — for Mother's Day / Father's Day / Grandparents' Day themes, the manuscript casts child + parent as PEERS. Banned framings: "best friends", "best buds", "best mates", "buddies", "besties", "BFF", "we're a team" framed as equals. CORRECT framing: parent as loving caregiver / hero / the one who tucks me in. Per-spread.

13. "fragment_line" — a manuscript line has no finite verb and reads as a noun-phrase fragment. BAD: "Mama, soft glow." / "Stars and a yawn." / "Two warm hands." GOOD: "Mama gives a soft glow." / "Stars hang above the yawn." / "Two warm hands hold tight." Per-spread.

14. "identity_pronoun_swap" — the hero is referred to with a pronoun set inconsistent with brief.pronouns (e.g. brief says she/her but a spread uses "he"/"him"/"his"/"they"). Per-spread. Quote the offending sentence.

15. "theme_cliche" — the manuscript uses a phrase listed as a BANNED CLICHÉ in the theme-directive block. Per-spread.

16. "line_count_violation" — the spread does not have EXACTLY 4 lines (for picture books). Per-spread.

17. "line_length_violation" — a line exceeds the per-band hardMax word count. Per-spread. Name the line and word count.

== Repair directive ==
For each failing spread, produce \`suggestedRewrite\` as a SHORT actionable directive (1-2 sentences) telling the writer what to fix and what to preserve. Do NOT produce the rewrite itself — that's the writer's job in the next wave. Examples:
  - "Replace 'Mama Courtney' with just 'Mama' on line 3; keep the snuggle imagery; line 3 must still rhyme with line 4."
  - "Lines 1-2 don't rhyme ('sing'/'plan'). Re-end line 2 with a real rhyme for 'sing' (ring/wing/king/swing). Keep the bedtime imagery."
  - "Spread 4 uses 'twirls' (forbidden infant locomotion). Recast as 'wiggles' or 'reaches' and adjust the couplet's rhyme accordingly."

== Pass criteria ==
\`pass: true\` ONLY when ALL of the following hold:
  - Zero per-spread issues across all spreads.
  - Zero book-level issues.
  - All AABB rhymes are real (no identity/stem/suffix-only).
  - All picture-book spreads have exactly 4 lines and respect the per-band word budget.
  - No infant_action_verb_in_text hits in any infant spread.
  - All questionnaire signature beats land somewhere in the manuscript.
Anything less → \`pass: false\`.

== Output schema (return EXACTLY this shape) ==
{
  "pass": true|false,
  "bookLevelIssues": ["<plain-text issue>", ...],
  "bookLevelTags": ["<tag>", ...],
  "perSpread": [
    {
      "spreadNumber": 1,
      "issues": ["<plain-text issue>", ...],
      "tags": ["<tag>", ...],
      "suggestedRewrite": "<short actionable directive>" | null
    },
    ...one entry per spread (1..13)...
  ],
  "infantLocomotionHits": [
    { "spreadNumber": 4, "verbs": ["twirls", "spins"] },
    ...
  ]
}

Return ONLY the JSON object. No prose. No markdown fences.`;

function buildJudgeUserPrompt(doc, signatureHint) {
  const spreads = doc.spreads.map(s => ({
    spreadNumber: s.spreadNumber,
    spec: s.spec,
    text: s.manuscript?.text,
    side: s.manuscript?.side,
  }));
  const themeBlock = renderThemeDirectiveBlock(doc.request.theme);
  const pronouns = doc?.brief?.pronouns || null;
  const heroName = doc?.brief?.child?.name || 'the hero';
  const pronounBlock = pronouns
    ? `HERO PRONOUNS — the manuscript MUST use ONLY these for ${heroName} everywhere: subject=${pronouns.subject}, object=${pronouns.object}, possessive=${pronouns.possessive}, reflexive=${pronouns.reflexive}. Any other pronoun referring to ${heroName} is identity_pronoun_swap.`
    : '';

  return [
    `Format: ${doc.request.format}. Age band: ${doc.request.ageBand}. Theme: ${doc.request.theme}.`,
    pronounBlock,
    themeBlock,
    themeBlock ? 'If the manuscript uses any BANNED CLICHÉS from the theme directive, tag those spreads with "theme_cliche" and fail.' : '',
    `Brief (subset):\n${JSON.stringify({
      child: doc?.brief?.child || null,
      parents: doc?.brief?.parents || null,
      pronouns,
      interests: doc?.brief?.interests || doc?.brief?.child?.interests || null,
      anecdotes: doc?.brief?.child?.anecdotes || null,
      customDetails: doc?.brief?.customDetails || null,
    }, null, 2)}`,
    `Story bible:\n${JSON.stringify(doc.storyBible, null, 2)}`,
    `Spreads:\n${JSON.stringify(spreads, null, 2)}`,
    signatureHint ? `signatureBeatsHint (deterministic preflight — verify against the manuscript yourself):\n${JSON.stringify(signatureHint, null, 2)}` : '',
    '',
    'Emit the JSON verdict now.',
  ].filter(Boolean).join('\n');
}

// =============================================================================
// Infant locomotion — pure LLM Flash call (no regex)
// =============================================================================

const INFANT_LOCOMOTION_SYSTEM = `You are an infant-development reviewer. You receive a single line of text from a children's book aimed at PB_INFANT (age 0-1, lap-baby). You return JSON listing every word in the line that describes a locomotion or whole-body action a 0-1 year old physically cannot do (jump, run, race, spin, twirl, hop, walk, climb, leap, dance, chase, grab forcefully, skip, gallop, stomp, march, crawl independently far, step, stand, stood, bounce on feet, cartwheel, tumble) — including any inflection (-s, -ed, -ing). Also flag body-part displacement constructions where the baby is the agent ("feet flash", "feet pound", "legs kick", "feet bounce"). Sit, lie, look, reach, giggle, coo, hold, snuggle, nuzzle, wiggle, wave, kick (lying down), babble, smile, peek, blink are FINE. Onomatopoeia (boop, shh, pop) is FINE.

Return ONLY: {"hits": ["word1", "word2", ...]}. Empty array if nothing forbidden. Lowercase the surface form you saw in the text. Do not include words from the safe list. No prose, no markdown.`;

function buildInfantLocomotionUserPrompt(line) {
  return `Line: ${JSON.stringify(line)}\nReturn the JSON now.`;
}

/**
 * Async helper used by writer/rewriteBookText.js' final hard gate.
 *
 * Replaces the deleted regex helper of the same name. Returns a string[]
 * of forbidden surface forms found in `text`. Empty array means clean.
 *
 * Calls Flash once per line. Skips non-PB_INFANT bands.
 *
 * @param {string} text
 * @param {string} ageBand
 * @param {{ abortSignal?: AbortSignal }} [options]
 * @returns {Promise<string[]>}
 */
async function findInfantForbiddenActionVerbs(text, ageBand, options = {}) {
  if (ageBand !== AGE_BANDS.PB_INFANT) return [];
  const lines = String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const all = [];
  for (const line of lines) {
    try {
      const result = await callText({
        model: MODELS.WRITER_QA,
        systemPrompt: INFANT_LOCOMOTION_SYSTEM,
        userPrompt: buildInfantLocomotionUserPrompt(line),
        jsonMode: true,
        temperature: 0.1,
        // Gemini Flash 2.5 reserves a thinking-token budget below ~512 before
        // emitting any output. Budgets of 200/400/800 truncate, force the
        // wrapper to retry, and waste 2-3x Flash spend + ~3-7s latency per
        // line. Net JSON output is only ~5-10 tokens, but we need headroom
        // above the thinking floor for one-shot success.
        maxTokens: 1024,
        label: 'infantLocomotionGate',
        abortSignal: options.abortSignal,
      });
      const hits = Array.isArray(result?.json?.hits) ? result.json.hits.map(String) : [];
      for (const h of hits) {
        const lc = h.toLowerCase();
        if (lc && !all.includes(lc)) all.push(lc);
      }
    } catch (err) {
      console.warn(`[checkWriterDraft] infant locomotion gate failed for line ${JSON.stringify(line)}: ${err?.message || err}`);
      // Fail-open: a single line failure doesn't block the gate. The
      // judge call still runs and the writer-rewrite hard gate will see
      // an empty hit list; if the line truly contained a forbidden verb
      // the judge is the redundant safety net.
    }
  }
  return all;
}

// =============================================================================
// Shadow run — old gemini-2.5-flash literary call, non-authoritative
// =============================================================================

const SHADOW_SYSTEM = `You are a senior children's-book editor running in SHADOW mode. Your verdict is logged but not authoritative. Apply the same picture-book rules: AABB 4-line per spread, real rhymes only, no infant locomotion verbs, no dropped articles, no parent-name concat with address words, no fragment lines, no nonsense words/similes, no peer framing for parent themes, consistent hero pronouns. Return JSON: {"pass": bool, "bookLevelIssues": [...], "perSpread": [{"spreadNumber": N, "issues": [...], "tags": [...]}]}. JSON only.`;

function buildShadowUserPrompt(doc) {
  const spreads = doc.spreads.map(s => ({
    spreadNumber: s.spreadNumber,
    text: s.manuscript?.text,
    side: s.manuscript?.side,
  }));
  return [
    `ageBand=${doc.request.ageBand}, theme=${doc.request.theme}, format=${doc.request.format}.`,
    `Spreads:\n${JSON.stringify(spreads, null, 2)}`,
    'Return JSON.',
  ].join('\n');
}

async function runShadowJudge(doc) {
  try {
    const result = await callText({
      model: MODELS.WRITER_QA,
      systemPrompt: SHADOW_SYSTEM,
      userPrompt: buildShadowUserPrompt(doc),
      jsonMode: true,
      temperature: 0.3,
      maxTokens: 7000,
      label: 'writerQa.shadow',
      abortSignal: doc.operationalContext?.abortSignal,
    });
    return { ok: true, json: result.json || {}, model: result.model, attempts: result.attempts, usage: result.usage };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function diffJudgeVerdicts(authoritative, shadow) {
  if (!shadow || !shadow.ok) return { shadowFailed: true };
  const auPass = authoritative.pass === true;
  const shPass = shadow.json?.pass === true;
  const auTags = new Set();
  for (const s of authoritative.perSpread || []) for (const t of s.tags || []) auTags.add(t);
  for (const t of authoritative.bookLevelTags || []) auTags.add(t);
  const shTags = new Set();
  for (const s of shadow.json?.perSpread || []) for (const t of s.tags || []) shTags.add(t);
  for (const t of shadow.json?.bookLevelIssues || []) shTags.add(`book:${String(t).slice(0, 40)}`);
  const onlyAuthoritative = [...auTags].filter(t => !shTags.has(t));
  const onlyShadow = [...shTags].filter(t => !auTags.has(t));
  return {
    shadowFailed: false,
    passAgreement: auPass === shPass,
    authoritativePass: auPass,
    shadowPass: shPass,
    onlyAuthoritative,
    onlyShadow,
  };
}

// =============================================================================
// Orchestrator
// =============================================================================

/**
 * @param {object} doc
 * @returns {Promise<{ pass: boolean, perSpread: object[], bookLevel: string[], bookLevelTags: string[], repairPlan: object[], updatedDoc: object }>}
 */
async function checkWriterDraft(doc) {
  // Deterministic preflight — signatureBeats is the only deterministic
  // signal that survives. It's structured questionnaire-anchor coverage,
  // not literary judgment. Feed it to the judge as a hint and also use it
  // as an independent book-level gate.
  const signature = checkSignatureBeatCoverage(doc.brief, doc.spreads);
  const signatureHint = signature.beats.length > 0
    ? {
        landed: signature.landed.map(describeBeat),
        missing: signature.missing.map(describeBeat),
        coverageRatio: signature.beats.length === 0 ? 1 : signature.landed.length / signature.beats.length,
      }
    : null;

  // Authoritative judge + shadow run, in parallel.
  const [judgeResult, shadowResult] = await Promise.all([
    callText({
      model: MODELS.WRITER_JUDGE,
      systemPrompt: JUDGE_SYSTEM,
      userPrompt: buildJudgeUserPrompt(doc, signatureHint),
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 12000,
      label: 'writerQa.judge',
      abortSignal: doc.operationalContext?.abortSignal,
    }),
    runShadowJudge(doc),
  ]);

  const judge = judgeResult.json || {};
  const perSpreadJudge = Array.isArray(judge.perSpread) ? judge.perSpread : [];
  const bookLevel = Array.isArray(judge.bookLevelIssues) ? judge.bookLevelIssues.map(String) : [];
  const bookLevelTags = Array.isArray(judge.bookLevelTags) ? judge.bookLevelTags.map(String) : [];
  const infantLocomotionHits = Array.isArray(judge.infantLocomotionHits) ? judge.infantLocomotionHits : [];

  // Independent signature-beat gate. The judge is asked to verify against
  // the manuscript, but if it disagrees with the deterministic preflight
  // we trust the preflight (token-presence is unambiguous).
  let signatureGateFail = false;
  if (signature.missing.length > 0) {
    const beatList = signature.missing.map(describeBeat).join('; ');
    const issue = `signature beats missing: ${signature.missing.length} of ${signature.beats.length} questionnaire anchors did not appear in any spread — ${beatList}`;
    if (!bookLevel.includes(issue)) bookLevel.push(issue);
    if (!bookLevelTags.includes('signature_beat_missing')) bookLevelTags.push('signature_beat_missing');
    signatureGateFail = true;
  }

  // Inject infant locomotion hits as per-spread tags so the rewrite loop
  // has actionable targets even if the judge missed them.
  const infantHitsBySpread = new Map();
  for (const hit of infantLocomotionHits) {
    const n = Number(hit?.spreadNumber);
    if (!Number.isFinite(n)) continue;
    const verbs = Array.isArray(hit?.verbs) ? hit.verbs.map(String) : [];
    if (verbs.length === 0) continue;
    infantHitsBySpread.set(n, verbs);
  }

  // Inject signature_beat_missing per-spread directives into the rotation
  // assignment so the rewrite loop has concrete spreads to target.
  const sigInjections = new Map(); // spreadNumber -> { issues:[], tags:[] }
  if (signature.missing.length > 0) {
    for (let i = 0; i < signature.missing.length; i++) {
      const beat = signature.missing[i];
      const sn = signature.assignments[i];
      if (!Number.isFinite(sn)) continue;
      const phrasing = (beat.key === 'calls_mom' || beat.key === 'calls_dad')
        ? `${beat.key} parent address word "${beat.text}"`
        : `questionnaire anchor ${describeBeat(beat)}`;
      const entry = sigInjections.get(sn) || { issues: [], tags: [] };
      entry.issues.push(`signature_beat_missing: surface the ${phrasing} in this spread — it is a load-bearing personalization detail from the questionnaire and the manuscript must not ship without it.`);
      if (!entry.tags.includes('signature_beat_missing')) entry.tags.push('signature_beat_missing');
      sigInjections.set(sn, entry);
    }
  }

  // Merge per-spread verdicts onto the canonical spread list (1..N).
  const merged = doc.spreads.map(s => {
    const j = perSpreadJudge.find(p => Number(p?.spreadNumber) === s.spreadNumber) || {};
    const issues = Array.isArray(j.issues) ? j.issues.map(String) : [];
    const tags = Array.isArray(j.tags) ? j.tags.map(String) : [];

    const infantVerbs = infantHitsBySpread.get(s.spreadNumber);
    if (infantVerbs && infantVerbs.length > 0) {
      const issue = `infant_action_verb_in_text: locomotion verbs forbidden for PB_INFANT — ${infantVerbs.join(', ')}`;
      if (!issues.some(x => x.startsWith('infant_action_verb_in_text'))) issues.push(issue);
      if (!tags.includes('infant_action_verb_in_text')) tags.push('infant_action_verb_in_text');
    }

    const sig = sigInjections.get(s.spreadNumber);
    if (sig) {
      for (const i of sig.issues) if (!issues.includes(i)) issues.push(i);
      for (const t of sig.tags) if (!tags.includes(t)) tags.push(t);
    }

    return {
      spreadNumber: s.spreadNumber,
      pass: issues.length === 0,
      issues,
      tags,
      suggestedRewrite: j.suggestedRewrite ? String(j.suggestedRewrite) : null,
    };
  });

  const repairPlan = merged.filter(m => !m.pass);
  const judgeSaysPass = judge.pass === true;
  const pass = judgeSaysPass && repairPlan.length === 0 && bookLevel.length === 0 && !signatureGateFail;

  // Shadow diff — log to stdout so we can grep it during the rollout
  // window. Also recorded structurally on the doc via appendLlmCall.
  const shadowDiff = diffJudgeVerdicts({ pass, perSpread: merged, bookLevel, bookLevelTags }, shadowResult);
  const bookId = doc?.operationalContext?.bookId || doc?.request?.bookId || 'n/a';
  console.log(
    `[writerQa.shadowDiff:${bookId}] authoritativePass=${shadowDiff.authoritativePass} shadowPass=${shadowDiff.shadowPass} agreement=${shadowDiff.passAgreement} onlyAuthoritative=${JSON.stringify(shadowDiff.onlyAuthoritative)} onlyShadow=${JSON.stringify(shadowDiff.onlyShadow)} shadowFailed=${shadowDiff.shadowFailed === true}`,
  );

  // Persist both calls onto the doc.
  let updatedDoc = appendLlmCall(doc, {
    stage: 'writerQa.judge',
    model: judgeResult.model,
    attempts: judgeResult.attempts,
    usage: judgeResult.usage,
  });
  if (shadowResult && shadowResult.ok) {
    updatedDoc = appendLlmCall(updatedDoc, {
      stage: 'writerQa.shadow',
      model: shadowResult.model,
      attempts: shadowResult.attempts,
      usage: shadowResult.usage,
    });
  }

  return {
    pass,
    perSpread: merged,
    bookLevel,
    bookLevelTags,
    repairPlan,
    updatedDoc,
  };
}

module.exports = {
  checkWriterDraft,
  findInfantForbiddenActionVerbs,
  // exported for unit tests
  JUDGE_SYSTEM,
  INFANT_LOCOMOTION_SYSTEM,
};
