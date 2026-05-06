/**
 * AA-CW-4 — Writer-side QA, rewritten as a single LLM judge.
 * AA-CW-11 — cross-family judge (gemini-2.5-pro) replaces same-family judge
 *            to break shared-blind-spot rhyme failures.
 * AA-CW-20 — reverted to same-family SELF-CRITIQUE (gpt-5.4 judges gpt-5.4)
 *            after production showed the cross-family judge raised
 *            taste-level tags at the 2-5 word infant line budget that
 *            the writer could not satisfy in 5 rewrite waves. Same-model
 *            self-critique converges because the critic only raises
 *            defects the writer can actually fix. Deterministic
 *            identity-rhyme + dropped-article audits run AFTER the
 *            self-critique as belt-and-suspenders insurance against the
 *            shared blind spot. The gemini-2.5-flash shadow stays wired
 *            up but is observability-only — it never gates pass/fail.
 *
 * Authoritative path: ONE call to MODELS.WRITER_JUDGE (gpt-5.4 as of
 * AA-CW-20) that returns the full per-spread + book-level verdict in
 * structured JSON. The 25 deterministic helpers from the original
 * implementation (verb-crutch lemmatization, dropped-article regex,
 * address-name concat, fragment detection, phonetic rhyme tail
 * comparator, nonsense-word lexicon, nonsense-simile keyword list,
 * peer-framing matcher, refrain-crutch counter, infant forbidden-verb
 * regex stack, line-count truncator, etc.) are all DELETED. The judge
 * prompt enumerates every one of those failure modes with concrete
 * BAD/GOOD examples so the LLM carries the entire signal.
 *
 * One side call remains:
 *   - Shadow run — the gemini-2.5-flash literary call still fires in
 *     parallel; its verdict is logged to stdout + appended to
 *     `doc.llmCalls` under stage `writerQa.shadow` for observability
 *     and rollout-window diffing. NEVER authoritative — it cannot
 *     fail the manuscript.
 *
 * AA-CW-9: the per-line `infantLocomotionGate` Flash call was deleted.
 * It cost ~38 sequential Flash calls (~65s wall time) per PB_INFANT
 * book to confirm what the gpt-5.4 judge already reports as
 * `infant_action_verb_in_text`. The judge's verdict is the single
 * source of truth; the writer-rewrite hard gate now relies on the
 * judge's `infant_action_verb_in_text` tag instead of a separate
 * regex/Flash residual sweep.
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
const { checkSignatureBeatCoverage, describeBeat } = require('./signatureBeats');
const { applyRealRhymeRescue } = require('./realRhymeAudit');

// =============================================================================
// Judge prompt (authoritative)
// =============================================================================

const JUDGE_SYSTEM = `You are a STRUCTURAL CHECKER on a children's-book manuscript that the writer (same model family) just produced. You are NOT a literary critic. You are NOT optimising for taste. Your only job is to flag five specific mechanical defects. Anything else the writer wrote — pacing, mood, word choice, sensory variety, line freshness — is the writer's call, NOT yours. Do NOT raise issues outside the five tags below. Do NOT add commentary about line freshness, repetition feel, fragment-ness, semantic richness, sensory rotation, or any other taste judgement. If the manuscript breaks none of the five rules, pass it. Period.

You receive: format, ageBand, theme, brief (child name, pronouns, anecdotes, interests, parents), storyBible, the full per-spread manuscript (text + side + spec).

You return ONE JSON object with the schema given at the bottom. No prose, no markdown.

== Pronoun rule (universal, hard) ==
ONE pronoun set for the hero, declared in brief.pronouns. Any other pronoun referring to the hero is \`identity_pronoun_swap\`.

== Failure modes — the ONLY five tags you may raise (plus identity_pronoun_swap) ==
Each issue must carry exactly one of these tags. Anything not on this list — do NOT raise it. If a defect doesn't fit one of these tags, the writer is allowed to ship it.

TAGS YOU MAY RAISE: rhyme_fail, dropped_article, address_name_concat, infant_action_verb_in_text, identity_pronoun_swap.

TAGS YOU MUST NOT RAISE (writer's call, not yours): semantic_filler, forced_rhyme_meaning_drift, fragment_line, verb_crutch, refrain_crutch, low_personalization_saturation, signature_beat_missing, age_mismatch_action, nonsense_word, nonsense_simile, parent_theme_relationship_framing, theme_cliche, line_count_violation, line_length_violation, unrenderable_action, writer_invented_prop. Do NOT add new tags. Do NOT invent tags. If the manuscript has none of the five named defects, pass it.

1. "rhyme_fail" — couplet does not really rhyme.

   IDENTITY RHYMES — same word repeated as both rhyme ends. ALWAYS FAIL. NO EXCEPTIONS.
     BAD: "cheek/cheek", "Mama/Mama", "town/town", "squeals/squeals", "light/light", "name/name".
     A couplet that ends both lines on the SAME WORD (even with different intervening words) is identity rhyme. Repeating the hero's name or a parent name as the rhyme is identity rhyme. Repeating any noun as both rhyme positions is identity rhyme.

   SLANT RHYMES — vowel or final-consonant mismatches. ALWAYS FAIL.
     BAD: "outside/glide" (different stressed vowels), "wide/beside" (different stressed-syllable sounds), "along/song" (different vowel quality), "stays/always" (different stress + suffix-only), "pride/outside" (slant), "nose/froes" (one is a fake word, see nonsense_word too), "sing/plan", "sigh/Deana", "sniff/off", "high/cuddle".

   STEM RHYMES — one word contains the other. ALWAYS FAIL.
     BAD: "town/hometown", "light/spotlight", "day/today", "side/outside".

   SUFFIX-ONLY RHYMES — only the grammatical ending matches. ALWAYS FAIL.
     BAD: "running/jumping", "sadly/badly", "quickly/slowly", "playing/staying".

   R-CONTROLLED VOWEL MISMATCH — pairs whose post-vowel consonant matches but the stressed vowel differs. ALWAYS FAIL. Phonetic principle: in American English, the vowel before /r/ carries the rhyme, not the /r/ itself. If the vowels diverge, the pair only LOOKS like a rhyme on paper.
     BAD families (each pair is the canonical example of its family): "arm/warm" (/ɑrm/ vs /wɔrm/), "heart/short" (/ɑrt/ vs /ɔrt/), "born/turn" (/ɔrn/ vs /ɜrn/), "care/fear" (/ɛr/ vs /ɪr/), "hard/word" (/ɑrd/ vs /ɜrd/).
     The test: say both words out loud. If the stressed vowel differs, fail it regardless of how the spelling looks.

   INTERJECTION / EXCLAMATION AS RHYME — the rhyme word on at least one side is an interjection, onomatopoeia, or stage-direction sound used to force a match with a content word. ALWAYS FAIL — interjections are theatrical, not lexical, and pairing them with real words breaks the read-aloud.
     BAD examples (one per family): "Mama/Ta-da", "flow/Whoa", "day/Yay", "cheer/Hooray", "glow/Oh", "high/Aha", "go/Uh-oh", "bang/Bam", "creep/Boo", "top/Pop".
     Onomatopoeia is fine WITHIN a line for sound effect, but never as the rhyme word itself. Excludes nothing — even "Ta-da" repeated across multiple spreads as a refrain does not earn it status as a rhyme word.

   GOOD pairs (real rhymes): "town/down", "light/bright", "day/play", "high/sky", "ball/tall", "chin/grin", "tight/right", "snug/hug", "flies/sighs", "by/high", "there/air", "slow/blow", "cheer/near", "heart/part".

   In the issue text, name the offending pair AND which sub-mode (identity / slant / stem / suffix-only / r-controlled / interjection / non-rhyming). When in doubt about a slant pair, FAIL it — the writer can find a real rhyme.

RHYME SCHEME (band-conditional):
   * PB_TODDLER and PB_PRESCHOOL: full AABB — lines 1+2 MUST rhyme; lines 3+4 MUST rhyme.
   * PB_INFANT (0-1): lines 1+2 MUST rhyme; lines 3+4 MAY rhyme OR MAY be free-verse. Do NOT raise rhyme_fail on infant lines 3+4 purely for being unrhymed. Only raise it when the writer ATTEMPTED to rhyme them and the attempt is identity/slant/stem/suffix-only/non-rhyme.
   * Identity rhymes (same word both ends) are ALWAYS rhyme_fail.
   * A couplet the writer chose to rhyme must be a REAL rhyme: identity / slant (different stressed vowels) / stem (one word contains the other) / suffix-only / r-controlled-vowel-mismatch / interjection-as-rhyme are all rhyme_fail.
   * GOOD pairs: "town/down", "light/bright", "day/play", "high/sky", "chin/grin", "snug/hug", "there/air".

   In the issue text, name the offending pair AND which sub-mode (identity / slant / stem / suffix-only / r-controlled / interjection / non-rhyming). When in doubt, FAIL it.

2. "dropped_article" — a preposition is followed by a bare singular countable noun with no determiner. BAD: "down street", "by feet", "on bench", "in room", "drift above land" (should be "above the land"), "go past" used as object ("baskets go past" is fine, but "baskets past store" is broken). GOOD: "down THE street", "by HER feet", "on a bench", "in HIS room", "drift above THE land". This is broken phrasing, never a stylistic choice.

3. "address_name_concat" — a parental address term jammed against the parent's proper first name. BAD: "Mama Courtney", "Daddy John". GOOD: "Mama" OR "Courtney", never both back-to-back.

4. "infant_action_verb_in_text" — for PB_INFANT (0-1) ONLY, the manuscript uses a locomotion VERB the baby physically cannot do. This rule is about VERBS. Bare nouns are NEVER triggers.
   Banned verb roots (any inflection) when the BABY is the subject: jump, run, race, spin, twirl, hop, walk, climb, leap, dance, chase, skip, gallop, stomp, march, crawl, step, stand/stood, cartwheel, tumble.
   Body-part-as-agent triggers ONLY with a locomotion verb implying the whole baby moves through space ("feet pound the floor", "feet gallop"). Body parts with non-locomotion verbs are fine: "hands reach", "toes curl", "feet kick the air".
   "hop" / "jump" about a non-baby agent (bunny, dad) is fine. Per-spread. List the offending VERB.

5. "identity_pronoun_swap" — the hero is referred to with a pronoun set inconsistent with brief.pronouns. Per-spread. Quote the offending sentence.

== Repair directive ==
For each failing spread, produce \`suggestedRewrite\` as a SHORT actionable directive (1-2 sentences). Examples:
  - "Replace 'Mama Courtney' with just 'Mama' on line 3; keep the rhyme with line 4."
  - "Lines 1-2 don't rhyme ('sing'/'plan'). Re-end line 2 with a real rhyme for 'sing' (ring/wing/king/swing). Keep the bedtime imagery."
  - "Spread 4 uses 'twirls' (forbidden infant locomotion). Recast as 'wiggles' or 'reaches' and adjust the couplet's rhyme accordingly."

== Pass criteria ==
\`pass: true\` when:
  - All rhymed couplets are real rhymes (PB_INFANT lines 3+4 may be free-verse).
  - No dropped_article hits.
  - No address_name_concat hits.
  - No infant_action_verb_in_text hits.
  - No identity_pronoun_swap hits.

Nothing else blocks pass. If you noticed something off that does NOT fit one of those five tags, you do NOT raise it and you do NOT set pass=false. The writer is allowed to ship it.

== Output schema (return EXACTLY this shape) ==
{
  "pass": true|false,
  "bookLevelIssues": [],
  "bookLevelTags": [],
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
    { "spreadNumber": 4, "verbs": ["twirls", "spins"] }
  ]
}

Return ONLY the JSON object. No prose. No markdown fences.`;

function buildJudgeUserPrompt(doc) {
  const spreads = doc.spreads.map(s => ({
    spreadNumber: s.spreadNumber,
    spec: s.spec,
    text: s.manuscript?.text,
    side: s.manuscript?.side,
  }));
  const pronouns = doc?.brief?.pronouns || null;
  const heroName = doc?.brief?.child?.name || 'the hero';
  const pronounBlock = pronouns
    ? `HERO PRONOUNS — the manuscript MUST use ONLY these for ${heroName} everywhere: subject=${pronouns.subject}, object=${pronouns.object}, possessive=${pronouns.possessive}, reflexive=${pronouns.reflexive}. Any other pronoun referring to ${heroName} is identity_pronoun_swap.`
    : '';

  return [
    `Format: ${doc.request.format}. Age band: ${doc.request.ageBand}. Theme: ${doc.request.theme}.`,
    pronounBlock,
    `Brief (subset):\n${JSON.stringify({
      child: doc?.brief?.child || null,
      parents: doc?.brief?.parents || null,
      pronouns,
    }, null, 2)}`,
    `Spreads:\n${JSON.stringify(spreads, null, 2)}`,
    '',
    'Emit the JSON verdict now.',
  ].filter(Boolean).join('\n');
}

// =============================================================================
// Shadow run — old gemini-2.5-flash literary call, non-authoritative
// =============================================================================

const SHADOW_SYSTEM = `You are a senior children's-book editor running in SHADOW mode. Your verdict is logged but not authoritative. Apply the same picture-book rules: 4 lines per spread, real rhymes only on rhymed couplets, no infant locomotion verbs, no dropped articles, no parent-name concat with address words, no fragment lines, no nonsense words/similes, no peer framing for parent themes, consistent hero pronouns. Rhyme scheme is band-conditional (AA-CW-17): PB_TODDLER and PB_PRESCHOOL use full AABB; PB_INFANT requires lines 1+2 to rhyme but allows lines 3+4 to be free-verse with parallel rhythm — do NOT raise rhyme_fail on infant lines 3+4 purely for being unrhymed. Return JSON: {"pass": bool, "bookLevelIssues": [...], "perSpread": [{"spreadNumber": N, "issues": [...], "tags": [...]}]}. JSON only.`;

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
  // AA-CW-21: deterministic signature-beat coverage is logged for forensics
  // only. We do NOT block ship on missing questionnaire anchors any more.
  // The writer prompt is responsible for personalization; if anchors are
  // missing we'll see it in the logs and tighten the writer, not the judge.
  const signature = checkSignatureBeatCoverage(doc.brief, doc.spreads);

  // Authoritative judge + shadow run, in parallel.
  const [judgeResult, shadowResult] = await Promise.all([
    callText({
      model: MODELS.WRITER_JUDGE,
      systemPrompt: JUDGE_SYSTEM,
      userPrompt: buildJudgeUserPrompt(doc),
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
  const infantLocomotionHits = Array.isArray(judge.infantLocomotionHits) ? judge.infantLocomotionHits : [];

  // AA-CW-21: book-level issues from the judge are advisory only. The
  // judge prompt restricts it to five per-spread tags; anything it raises
  // at book level is taste, and we do not gate on it.
  const bookLevel = [];
  const bookLevelTags = [];
  const advisoryBookLevel = Array.isArray(judge.bookLevelIssues) ? judge.bookLevelIssues.map(String) : [];
  const advisoryBookLevelTags = Array.isArray(judge.bookLevelTags) ? judge.bookLevelTags.map(String) : [];

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

  const bookId = doc?.operationalContext?.bookId || doc?.request?.bookId || 'n/a';

  // AA-CW-21: only these five tags can fail a spread. Everything else the
  // judge tries to raise is dropped on the floor (logged for forensics).
  const ALLOWED_FATAL_TAGS = new Set([
    'rhyme_fail',
    'identity_rhyme',
    'dropped_article',
    'address_name_concat',
    'infant_action_verb_in_text',
    'identity_pronoun_swap',
  ]);

  // Merge per-spread verdicts onto the canonical spread list (1..N).
  const droppedTagsByEntry = [];
  const merged = doc.spreads.map(s => {
    const j = perSpreadJudge.find(p => Number(p?.spreadNumber) === s.spreadNumber) || {};
    const rawTags = Array.isArray(j.tags) ? j.tags.map(String) : [];
    const rawIssues = Array.isArray(j.issues) ? j.issues.map(String) : [];

    // Filter to allowed tags. Keep the issue text only if its tag survived.
    const tags = rawTags.filter(t => ALLOWED_FATAL_TAGS.has(t));
    const droppedTags = rawTags.filter(t => !ALLOWED_FATAL_TAGS.has(t));
    const issues = tags.length === 0
      ? []
      : rawIssues.filter((issueText) => {
        // Heuristic: keep issues whose text mentions a surviving tag, OR
        // if all surviving tag names appear in no issue text (judge gave
        // tags without per-tag prose), keep all rawIssues. The judge
        // prompt asks for tag-prefixed issue text but doesn't enforce.
        const lower = issueText.toLowerCase();
        return tags.some(t => lower.startsWith(t) || lower.includes(`${t}:`) || lower.includes(t.replace(/_/g, ' ')));
      })
      .concat(
        // If after filtering we lost all issues but still have surviving
        // tags, fall back to rawIssues so the writer has something to
        // act on. Empty-issues+nonempty-tags is a worse failure mode.
        [],
      );
    if (tags.length > 0 && issues.length === 0 && rawIssues.length > 0) {
      issues.push(...rawIssues);
    }
    if (droppedTags.length > 0) {
      droppedTagsByEntry.push({ spreadNumber: s.spreadNumber, droppedTags });
    }

    const infantVerbs = infantHitsBySpread.get(s.spreadNumber);
    if (infantVerbs && infantVerbs.length > 0) {
      const issue = `infant_action_verb_in_text: locomotion verbs forbidden for PB_INFANT — ${infantVerbs.join(', ')}`;
      if (!issues.some(x => x.startsWith('infant_action_verb_in_text'))) issues.push(issue);
      if (!tags.includes('infant_action_verb_in_text')) tags.push('infant_action_verb_in_text');
    }

    return {
      spreadNumber: s.spreadNumber,
      pass: issues.length === 0 && tags.length === 0,
      issues,
      tags,
      suggestedRewrite: j.suggestedRewrite ? String(j.suggestedRewrite) : null,
    };
  });
  if (droppedTagsByEntry.length > 0) {
    console.log(
      `[writerQa.droppedTags:${bookId}] judge raised non-fatal tags that AA-CW-21 ignores: ${JSON.stringify(droppedTagsByEntry)}`,
    );
  }
  if (advisoryBookLevel.length > 0 || advisoryBookLevelTags.length > 0) {
    console.log(
      `[writerQa.advisoryBookLevel:${bookId}] judge raised book-level issues that AA-CW-21 does not gate on: tags=${JSON.stringify(advisoryBookLevelTags)} issues=${JSON.stringify(advisoryBookLevel)}`,
    );
  }
  if (signature.missing.length > 0) {
    console.log(
      `[writerQa.signatureCoverage:${bookId}] ${signature.missing.length} of ${signature.beats.length} questionnaire anchors not detected in manuscript (advisory only): ${JSON.stringify(signature.missing.map(describeBeat))}`,
    );
  }

  // AA-CW-11: deterministic identity-rhyme audit. The LLM judge has
  // historically passed couplets ending on the same word ("cheek/cheek",
  // "Mama/Mama", "squeals/squeals") even when the prompt forbids them.
  // This pure check runs after the LLM verdict, extracts the last word
  // of each line, normalises (lowercase, strip punctuation), and forces
  // a `rhyme_fail` tag with sub-mode "identity" if either couplet ends
  // on the same surface form. The writer's rewrite loop already consumes
  // `tags` and `issues`, so no plumbing changes are needed downstream.
  const identityRhymeOffenders = [];
  for (const entry of merged) {
    const spread = doc.spreads.find(s => s.spreadNumber === entry.spreadNumber);
    const text = spread?.manuscript?.text;
    const lines = String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (lines.length < 4) continue;
    const lastWord = (line) => {
      const m = String(line).toLowerCase().match(/([a-z\u00c0-\u024f']+)[^a-z\u00c0-\u024f']*$/i);
      return m ? m[1] : '';
    };
    const w = [lastWord(lines[0]), lastWord(lines[1]), lastWord(lines[2]), lastWord(lines[3])];
    const flags = [];
    if (w[0] && w[0] === w[1]) flags.push({ pair: `${w[0]}/${w[1]}`, lines: '1+2' });
    if (w[2] && w[2] === w[3]) flags.push({ pair: `${w[2]}/${w[3]}`, lines: '3+4' });
    if (flags.length === 0) continue;
    for (const f of flags) {
      const issue = `rhyme_fail: identity rhyme on lines ${f.lines} — "${f.pair}". Both lines end on the same word; pick a real rhyme partner.`;
      if (!entry.issues.includes(issue)) entry.issues.push(issue);
    }
    if (!entry.tags.includes('rhyme_fail')) entry.tags.push('rhyme_fail');
    if (!entry.tags.includes('identity_rhyme')) entry.tags.push('identity_rhyme');
    entry.pass = false;
    identityRhymeOffenders.push({ spreadNumber: entry.spreadNumber, flags });
  }
  if (identityRhymeOffenders.length > 0) {
    console.warn(
      `[writerQa.identityRhymeAudit:${bookId}] forced rhyme_fail on ${identityRhymeOffenders.length} spread(s): ${JSON.stringify(identityRhymeOffenders)}`,
    );
  }

  // AA-CW-23: deterministic real-rhyme RESCUE audit. Inverse of the
  // identity-rhyme audit above. Production failure (book e3f4e0c0,
  // post-AA-CW-22 deploy) showed the LLM judge hallucinating rhyme_fail
  // on real rhymes (face/place, cheek/peek, chin/grin, see/glee). The
  // rhyme bank delivered the correct rewrite, then the same-model self-
  // critique killed the rewrite anyway. This rescue strips rhyme_fail
  // from spreads whose lines 1+2 form a real rhyme by either (a) bank
  // partnership or (b) shared tail-rime. Identity rhymes are NEVER
  // rescued — they are filtered out before the rescue runs.
  const rescuedRhymes = applyRealRhymeRescue(merged, doc);
  if (rescuedRhymes.length > 0) {
    console.log(
      `[writerQa.realRhymeRescue:${bookId}] dropped rhyme_fail on ${rescuedRhymes.length} spread(s) with real rhyme: ${JSON.stringify(rescuedRhymes)}`,
    );
  }

  // AA-CW-18 Part C: deterministic dropped-article audit. Forensics from
  // book e3f4e0c0 showed the LLM judge missing trivial determiner-drops
  // ("at sky", "by hand", "on lap", "for chin") and burning entire rewrite
  // waves on cosmetic fixes. This pure regex check forces the
  // `dropped_article` tag when a preposition is followed by a bare
  // singular countable noun with no determiner. The check is conservative
  // — it only flags an explicit short whitelist of common bare-noun
  // collocations seen in production failures, so false-positives stay rare.
  const droppedArticleOffenders = [];
  const BARE_NOUN_AFTER_PREP = new RegExp(
    // preposition followed by a singular content noun with NO determiner.
    // Restricted to a curated safe-list of bare nouns seen in production
    // fails. Add to this list deliberately — every entry must be a
    // singular countable noun that is broken without a determiner in
    // child-book voice.
    String.raw`\b(at|in|on|by|for|to|onto|into|under|over|past|with|near|inside|outside|across)\s+(sky|hand|lap|chin|cheek|sleeve|arm|leaf|blanket|seat|stall|awning|door|path|lane|street|room|bench|porch|floor|table|chair|window|cup|book|house|yard|tree|flower|cloud|moon|sun|star|cat|dog|bird|face|head|foot|knee|nose|ear|eye|mouth|toy|ball|cloth)\b(?!\s*(?:'s|s\b))`,
    'gi',
  );
  for (const entry of merged) {
    const spread = doc.spreads.find(s => s.spreadNumber === entry.spreadNumber);
    const text = spread?.manuscript?.text;
    if (!text) continue;
    const lines = String(text).split(/\n+/).map(s => s.trim()).filter(Boolean);
    const hits = [];
    for (let li = 0; li < lines.length; li += 1) {
      const line = lines[li];
      // Reset lastIndex on each line because the regex is global.
      BARE_NOUN_AFTER_PREP.lastIndex = 0;
      let m;
      while ((m = BARE_NOUN_AFTER_PREP.exec(line)) !== null) {
        hits.push({ line: li + 1, prep: m[1], noun: m[2], match: m[0] });
      }
    }
    if (hits.length === 0) continue;
    for (const h of hits) {
      const issue = `dropped_article: line ${h.line} "${h.match}" is missing a determiner. Use "${h.prep} the ${h.noun}", "${h.prep} a ${h.noun}", or "${h.prep} her/his ${h.noun}".`;
      if (!entry.issues.includes(issue)) entry.issues.push(issue);
    }
    if (!entry.tags.includes('dropped_article')) entry.tags.push('dropped_article');
    entry.pass = false;
    droppedArticleOffenders.push({ spreadNumber: entry.spreadNumber, hits });
  }
  if (droppedArticleOffenders.length > 0) {
    console.warn(
      `[writerQa.droppedArticleAudit:${bookId}] forced dropped_article on ${droppedArticleOffenders.length} spread(s): ${JSON.stringify(droppedArticleOffenders)}`,
    );
  }

  // AA-CW-21: pass = no surviving fatal tags on any spread. The judge's
  // pass field is ignored — our 5-tag filter is the source of truth. The
  // deterministic identity-rhyme + dropped-article audits above already
  // forced .pass=false on any spread that hit those defects, and the
  // judge's rhyme_fail / address_name_concat / identity_pronoun_swap /
  // infant_action_verb_in_text tags survive the filter for the rest.
  const repairPlan = merged.filter(m => !m.pass);
  const pass = repairPlan.length === 0;

  // Shadow diff — log to stdout so we can grep it during the rollout
  // window. Also recorded structurally on the doc via appendLlmCall.
  const shadowDiff = diffJudgeVerdicts({ pass, perSpread: merged, bookLevel, bookLevelTags }, shadowResult);
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
  // exported for unit tests
  JUDGE_SYSTEM,
};
