/**
 * Writer draft stage.
 *
 * Writes the full manuscript using the storyBible, visualBible, and spread
 * specs. Produces strict-JSON one entry per spread with text, side, and
 * line-break hints. Does not redesign plot structure.
 */

const { callText } = require('../llm/openaiClient');
const { MODELS, TOTAL_SPREADS, TEXT_LINE_TARGET, AGE_BANDS, getWriterTemperature } = require('../constants');
const { updateSpread, appendLlmCall } = require('../schema/bookDocument');
const { renderTextPolicyBlock } = require('./textPolicies');
const { selectRetryMemory, renderRetryMemoryForPrompt } = require('../retryMemory');

// AA-CW-2: writer-side defenders (sanitizeForbiddenMistakesForInfant,
// sanitizeSpecViewForInfant) and their imports from createSpreadSpecs were
// deleted. The planner-side regex sanitizer they wrapped is gone (replaced
// by Planner Guard, a single Flash call); the writer now consumes the
// planner's spec as-is, including the explicit infant ban string the
// planner attaches to forbiddenMistakes.
//
// AA-CW-3: the post-draft per-spread compressor (compressInfantManuscript)
// and the regex line-truncator (maybeTruncateInfantManuscript) were removed.
// The writer is responsible for emitting a band-shaped manuscript directly,
// driven by SYSTEM_PROMPT line-count rules and the writerQA → rewrite loop
// (REPAIR_BUDGETS.writerRewriteWaves). No regex-fallback truncation, no
// per-spread compression LLM pass — the rewrite loop is the single repair
// surface.

const SYSTEM_PROMPT = `You write premium children's book verse for image-first spreads.

RHYME — READ THIS FIRST (AA-CW-22, hard rules, no exceptions):
- A rhyme means TWO DIFFERENT WORDS whose final stressed vowel + final consonant sound match. "chin / grin" is a rhyme. "chin / chin" is NOT a rhyme — that is an identity rhyme and it is an automatic failure.
- NEVER end two lines on the same word. NEVER repeat the line-ending word inside the same line either (e.g. "Mama grins with a grin." repeats grin and will be rejected).
- NEVER ship a couplet that does not rhyme out loud. If the only "rhyme" you can find is a stretched one like "leaf / brief", change BOTH end-words — pick a stronger pair like "leaf / tree" or "breeze / trees".
- DROPPED ARTICLES: never write "in lap", "by chin", "at chin", "on knee" etc. A bare singular body part / object after a preposition is broken English. Always use a determiner: "in her lap", "by Mama's chin", "at his chin", "on her knee".
- BEFORE you emit a spread: read lines 1+2 aloud in your head. If they end on the same word, fix it. If they don't actually rhyme, fix it. If they share a stem (sky/skies, beam/beams, gold/golden), fix it.

Hard rules (apply to every spread):
- Honor the spread spec exactly (side, personalization, beat).
- Read-aloud quality comes first. Musical cadence, simple words, no large metaphors, low repetition.
- Third-person by default unless the user prompt overrides.
- **HERO PRONOUNS — single source of truth.** The user prompt declares ONE pronoun set for the hero (subject / object / possessive / reflexive). Use ONLY those pronouns for the hero across the ENTIRE book. NEVER swap pronoun sets within a spread or between spreads. If a sentence is ambiguous, prefer the hero's name over a pronoun rather than introducing a different pronoun set.
- **Arc context.** Each spread spec carries \`arcContext\` (actNumber, beat, callbackToSpread, setsUpSpread, emotionalRegister). When \`callbackToSpread\` is set, the verse should subtly echo that earlier spread (a repeated word, a returning prop, a recognizable rhythm). When \`setsUpSpread\` is set, plant a small forward-looking note. The book is ONE arc — closing should feel like a transformed echo of the opening.
- Funny/playful tone, character-based humor. Mostly implicit emotional meaning — never preach.
- Use the child's name sometimes, not constantly. Use custom details concretely.
- **Scene flow:** when \`sceneBridge\` and \`continuityAnchors\` are present on a spread, let the verse acknowledge the *same* story movement — cause, discovery, or callback — so the read-aloud feels like a single adventure, not isolated vignettes. You may imply the bridge subtly (a repeated object, a "still following", "the trail led", "the friend from before") without naming camera directions.
- **PROSE-PROP WHITELIST (AA-CW-16, hard rule).** Each spread spec carries \`proseProps\` — the EXHAUSTIVE list of concrete physical objects you may name in that spread's text. The illustrator renders the spec, not your text, so any noun outside the whitelist guarantees an action_mismatch loop and will fail QA as \`writer_invented_prop\`. Constraint: every concrete physical noun the hero or parent INTERACTS WITH (object of a transitive verb, possessive target, prepositional anchor of a touch/lift/hold/pat/etc.) must be either (a) the child or parent themselves, (b) a body part, (c) the spread's location, or (d) an entry in \`proseProps\` (case-insensitive substring match). Background scenery you only mention (sky, trees, clouds) is exempt unless the hero touches it. If you cannot complete a couplet using the whitelist, choose a different rhyme word — NEVER invent a prop to land a rhyme.

Picture-book structure (MANDATORY when format is picture_book — every single spread, no exceptions):
- LINE COUNT: EXACTLY 4 lines per spread for ALL picture-book age bands (PB_INFANT 0-1, PB_TODDLER 0-3, PB_PRESCHOOL 3-6). Even the infant board-book band uses 4 lines; the band is differentiated by per-line word budget, not by line count. NEVER emit 2-line spreads for picture books.
   * Lines are separated by a single "\\n" character.
- RHYME SCHEME (band-conditional — see the per-age-band block above for the authoritative rule):
   * PB_TODDLER (0-3) and PB_PRESCHOOL (3-6): full AABB — lines 1+2 rhyme; lines 3+4 rhyme. Lines 2 and 4 do NOT need to rhyme with each other.
   * PB_INFANT (0-1) (AA-CW-18 — DEFAULT FREE-VERSE ON 3+4): Lines 1+2 MUST rhyme (real end-rhyme, no identity, no slant). Lines 3+4 DEFAULT to free-verse with parallel rhythm; only rhyme them if a real, natural rhyme appears on the FIRST attempt. Do NOT iterate to find a rhyme on 3+4 — if no obvious partner fits the scene, lock free-verse and move on. NEVER force a rhyme that drifts meaning ("dawning", "teal"), uses identity rhyme, invents a prop, requires an unrenderable action ("arm sighs", "leaf peeks"), or relies on slant/r-controlled mismatches (cloth/both, sleeve/breeze, arm/warm). Declare free-verse 3+4 explicitly in \`writerNotes\`.
- Real end-rhymes only (e.g. "high / sky", "wide / side", "tune / moon"). Near-rhymes are fine. Same-word rhymes ("cuddle / cuddle", "Mommy / Mommy") and non-rhymes ("sing / plan") are NOT acceptable on ANY couplet that you choose to rhyme.
- LINE LENGTH — see the per-age-band "LINE LENGTH" rule in the age/voice policy block above. Infants (0-1) are extra-tight (~2-5 words/line, hardMax 6) — board-book brevity inside a 4-line shape. Ages 0-3 (PB_TODDLER) are VERY short (~3-7 words/line, sing-song board-book cadence); ages 3-6 (PB_PRESCHOOL) are short (~6-12 words/line). Never exceed the hardMax for the band. Each line is a natural phrase unit with consistent musical pulse across each couplet.
- NEVER invent fake words just to make a rhyme work. "Farf" is not a word. If the rhyme word doesn't exist in English, pick a different rhyme — don't fabricate.
- NEVER use a simile ("X as Y", "like Y") where Y is something the target child wouldn't recognize. "Light as code", "soft as math" are nonsense in a baby book — use concrete sensory comparisons ("soft as fluff", "warm as toast").
- If a couplet does not actually rhyme when read aloud, rewrite it before emitting.
- No line may cross the horizontal center of the spread when painted.

BOOK-LEVEL DIVERSITY SELF-AUDIT (AA-CW-19, MANDATORY before you return JSON):
- Scan the verb lemmas you used across all 13 spreads. NO single verb lemma may appear in more than 3 of 13 spreads (≤23%). "give/gives/gave/giving" all collapse to one lemma; same for "say/says/said", "pat/pats/patted", "hold/holds/held", "tuck/tucks/tucked", etc.
- Scan concrete refrain nouns (sleeve, hand, leaf, blanket, arm, lap, chin, cheek). NO single noun may appear in more than 3 of 13 spreads.
- If your draft fails either check, REWRITE the offending spreads BEFORE returning JSON. Vary by sensory channel: a verb-led action line on one spread, a sensory image on the next ("Soft sun on her cheek."), a state line on the next ("The room is hush."), a sound line on the next ("A small bird sings."). Verbs are NOT the only way to open a line; you may use noun-led, adjective-led, or sound-led lines for variety.
- A book that fails this self-audit at draft time will burn 5 rewrite waves trying to recover and will fail the gate. Self-audit costs you nothing and saves the book.

Early reader structure (when format is early_reader):
- 3–4 short prose lines per spread. Rhyme optional — do not force it.

Return ONLY strict JSON: { "spreads": [ { "spreadNumber": 1, "text": "LINE1\\nLINE2\\nLINE3\\nLINE4", "side": "left|right", "lineBreakHints": ["..."], "personalizationUsed": ["..."], "writerNotes": "optional" }, ... ] }. The "text" field is a single string with embedded "\\n" line breaks — do NOT emit it as an array. Picture books always emit EXACTLY 4 lines per spread regardless of age band.`;

/**
 * Render a one-line reminder of the line-count gate for the current age band.
 * Surfaced near the top of the user prompt so the writer can't miss it.
 */
function renderLineCountReminder(ageBand) {
  const target = TEXT_LINE_TARGET[ageBand];
  if (target && target.min === target.max) {
    // AA-CW-17 Part B: PB_INFANT now uses relaxed scheme (lines 1+2 must
    // rhyme; lines 3+4 may be free-verse). Other picture-book bands stay AABB.
    if (ageBand === AGE_BANDS.PB_INFANT) {
      return `LINE COUNT FOR THIS BOOK: EXACTLY ${target.min} lines per spread (age band ${ageBand}). Lines 1+2 MUST rhyme; lines 3+4 may rhyme OR may be free-verse — prefer naturalness over forced rhymes.`;
    }
    return `LINE COUNT FOR THIS BOOK: EXACTLY ${target.min} lines per spread (age band ${ageBand}). Picture books always emit 4 lines per spread — two AABB rhyming couplets.`;
  }
  return '';
}

/**
 * AA-CW-5b — `renderInfantContract` deleted.
 *
 * The single source of truth for the infant CORE PRINCIPLE / REFRAME /
 * IDENTITY-RHYME-BAN / VOCABULARY-DIVERSITY / COMPLETE-SENTENCE / NO-YODA /
 * STRUCTURE block now lives entirely in `writer/textPolicies.js`
 * (`renderTextPolicyBlock` infant branch). Sending both the old contract AND
 * the textPolicies infant block to the writer was duplicating ~40 lines of
 * prompt and risking drift between the two blocks (we already saw the
 * contract say "2-5 words per line" while textPolicies said the same — but
 * if either was edited in isolation they would silently diverge).
 *
 * `renderInfantContract` is kept as a no-op compatibility stub so external
 * callers (notably rewriteBookText.js) don't have to change in this PR.
 */
function renderInfantContract(_ageBand) {
  return '';
}

/**
 * AA-CW-5b — Render a curated STORY ARC CONTEXT block from the storyBible.
 *
 * The previous writer prompt dumped the entire `storyBible` JSON object
 * inline, which (a) buried the load-bearing arc fields under structural
 * boilerplate and (b) made it harder for the writer to honor the spine
 * across spreads. This block surfaces ONLY the fields that drive arc
 * decisions — narrativeSpine, beginningHook/middleEscalation/endingPayoff,
 * emotionalArc, recurringVisualMotifs, cinematicLocations, humorStrategy
 * — as a labeled contract the writer can refer back to from any spread.
 *
 * The full storyBible JSON is still passed below (for completeness / any
 * field this block omits); this block is layered on top of it.
 *
 * Returns '' if the storyBible is empty.
 */
function renderStoryArcContext(storyBible) {
  if (!storyBible || typeof storyBible !== 'object') return '';
  const lines = ['### STORY ARC CONTEXT (one through-line — every spread serves this arc):'];
  const push = (label, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      const cleaned = value.map(v => String(v).trim()).filter(Boolean);
      if (cleaned.length === 0) return;
      lines.push(`- ${label}:`);
      for (const v of cleaned) lines.push(`    • ${v}`);
      return;
    }
    const s = String(value).trim();
    if (!s) return;
    lines.push(`- ${label}: ${s}`);
  };
  push('Title', storyBible.title);
  push('Narrative spine', storyBible.narrativeSpine);
  push('Beginning hook', storyBible.beginningHook);
  push('Middle escalation', storyBible.middleEscalation);
  push('Ending payoff', storyBible.endingPayoff);
  push('Emotional arc', storyBible.emotionalArc);
  push('Humor strategy', storyBible.humorStrategy);
  push('Location strategy', storyBible.locationStrategy);
  push('Cinematic locations', storyBible.cinematicLocations);
  push('Recurring visual motifs', storyBible.recurringVisualMotifs);
  push('Personalization targets', storyBible.personalizationTargets);
  if (lines.length === 1) return ''; // nothing populated
  lines.push(
    '- Use this arc as the spine of every spread. The opening should plant the first chord; the middle should escalate it; the closing should resolve it as a transformed echo of the opening (callback). When a spread spec\'s `arcContext.callbackToSpread` is set, lean into the recurring motif from the listed earlier spread (a returning prop, a repeated phrase, a planted seed).',
  );
  return lines.join('\n');
}

function userPrompt(doc) {
  const { storyBible, visualBible, spreads } = doc;
  const retries = selectRetryMemory(doc.retryMemory, 'writerDraft');
  const retryBlock = renderRetryMemoryForPrompt(retries);
  // AA-CW-2: writer-side sanitization is gone. The planner's Planner Guard
  // is the single semantic check, and it runs upstream as a gate — a hit
  // there triggers a planner retry, not a silent rewrite at the writer
  // boundary. We hand the planner spec to the writer LLM as-is.
  // AA-CW-5a: include arcContext on each per-spread payload so the writer
  // can shape callbacks/setups, and use brief.pronouns as the single
  // canonical pronoun source.
  const specs = spreads.map(s => {
    const baseSpec = s.spec;
    return {
      spreadNumber: s.spreadNumber,
      purpose: baseSpec?.purpose,
      plotBeat: baseSpec?.plotBeat,
      sceneBridge: baseSpec?.sceneBridge,
      emotionalBeat: baseSpec?.emotionalBeat,
      humorBeat: baseSpec?.humorBeat,
      location: baseSpec?.location,
      focalAction: baseSpec?.focalAction,
      textSide: baseSpec?.textSide,
      textLineTarget: baseSpec?.textLineTarget,
      mustUseDetails: baseSpec?.mustUseDetails,
      continuityAnchors: baseSpec?.continuityAnchors,
      proseProps: baseSpec?.proseProps || [],
      forbiddenMistakes: baseSpec?.forbiddenMistakes,
      arcContext: baseSpec?.arcContext || null,
    };
  });

  // AA-CW-5a — hero pronouns block, threaded into the writer prompt as a
  // hard-rule reminder above the spread specs JSON. The spread specs
  // themselves don't repeat the pronouns (would just bloat per-spread
  // tokens); the writer reads this block once and is bound by the
  // SYSTEM_PROMPT "hero pronouns single source of truth" rule.
  const pronouns = doc?.brief?.pronouns || null;
  const heroName = doc?.brief?.child?.name || 'the hero';
  const pronounBlock = pronouns
    ? `HERO PRONOUNS — USE ONLY THESE FOR ${heroName} (never swap, never alternate, never use a different pronoun set anywhere in the book):\n  subject: ${pronouns.subject}\n  object: ${pronouns.object}\n  possessive: ${pronouns.possessive}\n  reflexive: ${pronouns.reflexive}`
    : '';

  const lineCountReminder = renderLineCountReminder(doc.request?.ageBand);
  const arcContextBlock = renderStoryArcContext(storyBible);

  // AA-CW-5b: the previous prompt prepended an INFANT BOOK CONTRACT block
  // that duplicated textPolicies.js' infant branch verbatim. That stub is
  // gone — textPolicies is now the single source of truth. The arc context
  // block (curated narrativeSpine / beats / motifs / locations) takes its
  // slot at the top of the prompt so the writer reads the through-line
  // before any per-spread JSON.
  return [
    renderTextPolicyBlock(doc),
    arcContextBlock ? `\n${arcContextBlock}` : '',
    lineCountReminder ? `\n${lineCountReminder}` : '',
    pronounBlock ? `\n${pronounBlock}` : '',
    '',
    `Story bible:\n${JSON.stringify(storyBible, null, 2)}`,
    '',
    `Visual cues (for tone only — do NOT describe images in prose):\n${JSON.stringify({
      palette: visualBible.palette,
      environmentAnchors: visualBible.environmentAnchors,
    }, null, 2)}`,
    '',
    `Spread specs (length ${TOTAL_SPREADS}):\n${JSON.stringify(specs, null, 2)}`,
    retryBlock ? `\n${retryBlock}` : '',
    'Emit the JSON now.',
  ].filter(Boolean).join('\n');
}

/**
 * Apply the JSON manuscript onto the document.
 *
 * @param {object} doc
 * @param {any} json
 * @returns {object}
 */
function applyManuscript(doc, json) {
  const arr = Array.isArray(json?.spreads) ? json.spreads : [];
  let next = doc;
  for (const entry of arr) {
    const n = Number(entry?.spreadNumber);
    if (!Number.isFinite(n) || n < 1 || n > TOTAL_SPREADS) continue;
    const manuscriptRaw = {
      text: String(entry.text || '').trim(),
      side: entry.side === 'left' ? 'left' : 'right',
      lineBreakHints: Array.isArray(entry.lineBreakHints) ? entry.lineBreakHints.map(String) : [],
      personalizationUsed: Array.isArray(entry.personalizationUsed) ? entry.personalizationUsed.map(String) : [],
      writerNotes: entry.writerNotes ? String(entry.writerNotes) : null,
    };
    // AA-CW-3: no regex truncation. The writer must emit the correct line
    // count for the band; if it overshoots, the writerQA + rewrite loop
    // handles the repair.
    next = updateSpread(next, n, s => ({
      ...s,
      manuscript: manuscriptRaw,
    }));
  }
  return next;
}

/**
 * @param {object} doc
 * @returns {Promise<object>}
 */
async function draftBookText(doc) {
  // PR J.4 — infant band uses a lower sampling temperature so hard
  // constraints (still-point, no dialogue, safe-action whitelist) win
  // over the model's bias toward exotic locomotion verbs in a children's
  // book theme. Other bands keep their historical temperature.
  // PR J.1.5 diagnostic: log resolved sampling temperature + ageBand so we
  // can confirm Cloud Run is serving the J.4 revision and that ageBand is
  // populated at the writer call site.
  const _draftAgeBand = doc?.request?.ageBand || '(none)';
  const _draftTemp = getWriterTemperature('draft', doc?.request?.ageBand);
  console.log(
    `[writer:draft] ageBand=${_draftAgeBand} temperature=${_draftTemp} (PR J.1.5 diagnostic)`
  );
  const result = await callText({
    model: MODELS.WRITER,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userPrompt(doc),
    jsonMode: true,
    temperature: _draftTemp,
    maxTokens: 12000,
    label: 'writerDraft',
    abortSignal: doc.operationalContext?.abortSignal,
  });

  const next = appendLlmCall(applyManuscript(doc, result.json), {
    stage: 'writerDraft',
    model: result.model,
    attempts: result.attempts,
    usage: result.usage,
  });

  // AA-CW-3: removed the post-draft compressInfantManuscript pass.
  // The writer is now the single source for infant manuscript shape;
  // any miss is caught by writerQA and fixed by the rewrite loop
  // (REPAIR_BUDGETS.writerRewriteWaves), with no regex/lexicon fallback.
  return next;
}

module.exports = {
  draftBookText,
  applyManuscript,
  renderInfantContract,
  renderStoryArcContext,
  // AA-CW-16 — exported so tests can prompt-lock the proseProps rule.
  SYSTEM_PROMPT,
  // AA-CW-17 Part B — exported so tests can prompt-lock the band-conditional rhyme reminder.
  renderLineCountReminder,
};
