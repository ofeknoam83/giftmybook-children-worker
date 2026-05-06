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

Hard rules (apply to every spread):
- Honor the spread spec exactly (side, personalization, beat).
- Read-aloud quality comes first. Musical cadence, simple words, no large metaphors, low repetition.
- Third-person by default unless the user prompt overrides.
- **HERO PRONOUNS — single source of truth.** The user prompt declares ONE pronoun set for the hero (subject / object / possessive / reflexive). Use ONLY those pronouns for the hero across the ENTIRE book. NEVER swap pronoun sets within a spread or between spreads. If a sentence is ambiguous, prefer the hero's name over a pronoun rather than introducing a different pronoun set.
- **Arc context.** Each spread spec carries \`arcContext\` (actNumber, beat, callbackToSpread, setsUpSpread, emotionalRegister). When \`callbackToSpread\` is set, the verse should subtly echo that earlier spread (a repeated word, a returning prop, a recognizable rhythm). When \`setsUpSpread\` is set, plant a small forward-looking note. The book is ONE arc — closing should feel like a transformed echo of the opening.
- Funny/playful tone, character-based humor. Mostly implicit emotional meaning — never preach.
- Use the child's name sometimes, not constantly. Use custom details concretely.
- **Scene flow:** when \`sceneBridge\` and \`continuityAnchors\` are present on a spread, let the verse acknowledge the *same* story movement — cause, discovery, or callback — so the read-aloud feels like a single adventure, not isolated vignettes. You may imply the bridge subtly (a repeated object, a "still following", "the trail led", "the friend from before") without naming camera directions.

Picture-book structure (MANDATORY when format is picture_book — every single spread, no exceptions):
- LINE COUNT: EXACTLY 4 lines per spread for ALL picture-book age bands (PB_INFANT 0-1, PB_TODDLER 0-3, PB_PRESCHOOL 3-6) — two AABB rhyming couplets. Even the infant board-book band uses 4 lines; the band is differentiated by per-line word budget, not by line count. NEVER emit 2-line spreads for picture books.
   * Lines are separated by a single "\\n" character.
- Rhyme scheme: AABB — lines 1+2 rhyme; lines 3+4 rhyme. Lines 2 and 4 do NOT need to rhyme with each other.
- Real end-rhymes only (e.g. "high / sky", "wide / side", "tune / moon"). Near-rhymes are fine. Same-word rhymes ("cuddle / cuddle", "Mommy / Mommy") and non-rhymes ("sing / plan") are NOT acceptable.
- LINE LENGTH — see the per-age-band "LINE LENGTH" rule in the age/voice policy block above. Infants (0-1) are extra-tight (~2-5 words/line, hardMax 6) — board-book brevity inside a 4-line shape. Ages 0-3 (PB_TODDLER) are VERY short (~3-7 words/line, sing-song board-book cadence); ages 3-6 (PB_PRESCHOOL) are short (~6-12 words/line). Never exceed the hardMax for the band. Each line is a natural phrase unit with consistent musical pulse across each couplet.
- NEVER invent fake words just to make a rhyme work. "Farf" is not a word. If the rhyme word doesn't exist in English, pick a different rhyme — don't fabricate.
- NEVER use a simile ("X as Y", "like Y") where Y is something the target child wouldn't recognize. "Light as code", "soft as math" are nonsense in a baby book — use concrete sensory comparisons ("soft as fluff", "warm as toast").
- If a couplet does not actually rhyme when read aloud, rewrite it before emitting.
- No line may cross the horizontal center of the spread when painted.

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
    return `LINE COUNT FOR THIS BOOK: EXACTLY ${target.min} lines per spread (age band ${ageBand}). Picture books always emit 4 lines per spread — two AABB rhyming couplets.`;
  }
  return '';
}

/**
 * Hard infant contract block. Prepended to the user prompt for PB_INFANT books.
 * Stronger than a one-line reminder — a structured contract with banned verbs,
 * one good example and one bad example so the model has a concrete pattern to
 * imitate. Empty string for non-infant bands.
 */
function renderInfantContract(ageBand) {
  if (ageBand !== AGE_BANDS.PB_INFANT) return '';
  return [
    '============================================================',
    'INFANT BOOK CONTRACT (PB_INFANT, age 0-1) — READ FIRST',
    '============================================================',
    'This is a board book for a lap baby. Every spread MUST follow:',
    '',
    '1. EXACTLY 4 lines per spread. No 2-line spreads. No 3-line spreads. Four lines, separated by \\n.',
    '2. The four lines form TWO AABB rhyming couplets: lines 1+2 rhyme; lines 3+4 rhyme. Lines 2 and 4 do NOT need to rhyme with each other.',
    '3. 2-5 words per line, hardMax 6. Tight, board-book cadence — every word earns its place.',
    '4. THE BABY IS THE STILL POINT. The baby is held, carried, or seated. The baby never moves themselves through space. Energy and motion come from THE WORLD around the baby — light shifts, cloth flutters, Mama leans in, a leaf drifts past, music sways through the air. The baby watches, reaches, smiles, snuggles, points, claps, gasps, giggles — always from a held or seated position.',
    '5. NO DIALOGUE. The baby cannot speak in full sentences. Mama and other characters also do not speak in full sentences inside the verse. Sensory observation only — no quotation marks at all.',
    '6. Use only the safe-action whitelist on the baby: sit, lie, look, see, reach, hold, snuggle, giggle, coo, pat, clap, hear, smell, touch, point, watch, wave, blink, gasp. Anything outside this list, do NOT attach to the baby.',
    '7. Across the WHOLE book, do not lean on a single noun, descriptor, or sound-word as a refrain across many spreads. Vary the imagery.',
    '8. Real English only. No invented rhyme-fill words. No similes with abstract comparands.',
    '',
    'GOOD EXAMPLE A (one spread — four lines, AABB):',
    '   Mama lifts the moon.',
    '   Bright as a silver spoon.',
    '   Soft light fills the room.',
    '   Goodbye, little gloom.',
    '',
    'GOOD EXAMPLE B (one spread — four lines, AABB):',
    '   A red leaf drifts by.',
    '   Little hand waves goodbye.',
    '   The breeze hums a tune.',
    '   Baby smiles at the moon.',
    '',
    'GOOD EXAMPLE C (one spread — four lines, AABB):',
    '   Soft sun warms her cheek.',
    '   Mama plays hide-and-seek.',
    '   Little fingers spread wide.',
    '   Joy is curled up inside.',
    '',
    'COMMON FAILURE MODES (avoid — described abstractly so the words below are not seeded into your output):',
    '   - Putting the baby in motion through space (any verb of self-locomotion).',
    '   - Putting words in the baby\'s mouth (any quoted speech from the hero).',
    '   - Quoted commands from Mama ("Come on!", "Look at this!") — keep the verse as observation, not stage directions.',
    '   - Re-using the same descriptor or sound-word as a refrain across many spreads.',
    '   - Emitting fewer than 4 lines, or breaking AABB rhyme on either couplet.',
    '============================================================',
  ].join('\n');
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
  const infantContract = renderInfantContract(doc.request?.ageBand);

  return [
    infantContract,
    renderTextPolicyBlock(doc),
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

module.exports = { draftBookText, applyManuscript, renderInfantContract };
