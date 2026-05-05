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
const { maybeTruncateInfantManuscript } = require('./truncateInfantText');
const { compressInfantManuscript } = require('./compressInfantSpread');
const {
  findInfantPlannerVerbs,
  sanitizeInfantSpec,
} = require('../planner/createSpreadSpecs');

const SYSTEM_PROMPT = `You write premium children's book verse for image-first spreads.

Hard rules (apply to every spread):
- Honor the spread spec exactly (side, personalization, beat).
- Read-aloud quality comes first. Musical cadence, simple words, no large metaphors, low repetition.
- Third-person by default unless the user prompt overrides.
- Funny/playful tone, character-based humor. Mostly implicit emotional meaning — never preach.
- Use the child's name sometimes, not constantly. Use custom details concretely.
- **Scene flow:** when \`sceneBridge\` and \`continuityAnchors\` are present on a spread, let the verse acknowledge the *same* story movement — cause, discovery, or callback — so the read-aloud feels like a single adventure, not isolated vignettes. You may imply the bridge subtly (a repeated object, a "still following", "the trail led", "the friend from before") without naming camera directions.

Picture-book structure (MANDATORY when format is picture_book — every single spread, no exceptions):
- LINE COUNT depends on age band:
   * Infant band (PB_INFANT, 0-1): EXACTLY 2 lines per spread — one AA rhyming couplet. Board-book brevity. The parent reads one short couplet aloud while the baby looks at the picture. Do NOT pad to 4 lines.
   * Toddler/Preschool bands (PB_TODDLER 0-3, PB_PRESCHOOL 3-6): EXACTLY 4 lines per spread — two AABB rhyming couplets.
   * Lines are separated by a single "\\n" character.
- Rhyme scheme:
   * 2-line (infant): AA — line 1's last word rhymes with line 2's last word.
   * 4-line (toddler/preschool): AABB — lines 1+2 rhyme; lines 3+4 rhyme. Lines 2 and 4 do NOT need to rhyme with each other.
- Real end-rhymes only (e.g. "high / sky", "wide / side", "tune / moon"). Near-rhymes are fine. Same-word rhymes ("cuddle / cuddle", "Mommy / Mommy") and non-rhymes ("sing / plan") are NOT acceptable.
- LINE LENGTH — see the per-age-band "LINE LENGTH" rule in the age/voice policy block above. Infants (0-1) are extra-tight (~2-4 words/line, hardMax 5). Ages 0-3 (PB_TODDLER) are VERY short (~3-7 words/line, sing-song board-book cadence); ages 3-6 (PB_PRESCHOOL) are short (~6-12 words/line). Never exceed the hardMax for the band. Each line is a natural phrase unit with consistent musical pulse across each couplet.
- NEVER invent fake words just to make a rhyme work. "Farf" is not a word. If the rhyme word doesn't exist in English, pick a different rhyme — don't fabricate.
- NEVER use a simile ("X as Y", "like Y") where Y is something the target child wouldn't recognize. "Light as code", "soft as math" are nonsense in a baby book — use concrete sensory comparisons ("soft as fluff", "warm as toast").
- If a couplet does not actually rhyme when read aloud, rewrite it before emitting.
- No line may cross the horizontal center of the spread when painted.

Early reader structure (when format is early_reader):
- 3–4 short prose lines per spread. Rhyme optional — do not force it.

Return ONLY strict JSON: { "spreads": [ { "spreadNumber": 1, "text": "LINE1\\nLINE2[\\nLINE3\\nLINE4]", "side": "left|right", "lineBreakHints": ["..."], "personalizationUsed": ["..."], "writerNotes": "optional" }, ... ] }. The "text" field is a single string with embedded "\\n" line breaks — do NOT emit it as an array. For infant books emit 2 lines; for toddler/preschool books emit 4 lines.`;

/**
 * Render a one-line reminder of the line-count gate for the current age band.
 * Surfaced near the top of the user prompt so the writer can't miss it.
 */
function renderLineCountReminder(ageBand) {
  if (ageBand === AGE_BANDS.PB_INFANT) {
    return 'LINE COUNT FOR THIS BOOK: EXACTLY 2 lines per spread (AA couplet) — infant band. Do NOT emit 4 lines.';
  }
  const target = TEXT_LINE_TARGET[ageBand];
  if (target && target.min === target.max) {
    return `LINE COUNT FOR THIS BOOK: EXACTLY ${target.min} lines per spread (age band ${ageBand}).`;
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
    '1. EXACTLY 2 lines per spread. No 3-line spreads. No 4-line spreads. Two lines, separated by \\n.',
    '2. The two lines form one AA rhyming couplet (last word of line 1 rhymes with last word of line 2).',
    '3. 2-4 words per line, hardMax 5. Tight, board-book cadence.',
    '4. THE BABY IS THE STILL POINT. The baby is held, carried, or seated. The baby never moves themselves through space. Energy and motion come from THE WORLD around the baby — light shifts, cloth flutters, Mama leans in, a leaf drifts past, music sways through the air. The baby watches, reaches, smiles, snuggles, points, claps, gasps, giggles — always from a held or seated position.',
    '5. NO DIALOGUE. The baby cannot speak in full sentences. Mama and other characters also do not speak in full sentences inside the verse. Sensory observation only — no quotation marks at all.',
    '6. Use only the safe-action whitelist on the baby: sit, lie, look, see, reach, hold, snuggle, giggle, coo, pat, clap, hear, smell, touch, point, watch, wave, blink, gasp. Anything outside this list, do NOT attach to the baby.',
    '7. Across the WHOLE book, do not lean on a single noun, descriptor, or sound-word as a refrain across many spreads. Vary the imagery.',
    '8. Real English only. No invented rhyme-fill words. No similes with abstract comparands.',
    '',
    'GOOD EXAMPLE A (one spread):',
    '   Mama lifts the moon.',
    '   Bright as a spoon.',
    '',
    'GOOD EXAMPLE B (one spread):',
    '   A red leaf drifts by.',
    '   Little hand waves goodbye.',
    '',
    'GOOD EXAMPLE C (one spread):',
    '   Soft sun warms her cheek.',
    '   Mama hums, hide-and-seek.',
    '',
    'COMMON FAILURE MODES (avoid — described abstractly so the words below are not seeded into your output):',
    '   - Putting the baby in motion through space (any verb of self-locomotion).',
    '   - Putting words in the baby\'s mouth (any quoted speech from the hero).',
    '   - Quoted commands from Mama ("Come on!", "Look at this!") — keep the verse as observation, not stage directions.',
    '   - Re-using the same descriptor or sound-word as a refrain across many spreads.',
    '   - Padding to 4 lines on an infant spread.',
    '============================================================',
  ].join('\n');
}

/**
 * PR J.1 — strip literal banned-verb tokens from forbiddenMistakes before
 * the writer reads them.
 *
 * Background: the planner appends `forbiddenMistakes` entries that NAME
 * every banned locomotion verb ("manuscript text must not contain
 * locomotion verbs (jump/run/race/spin/twirl/...)" and "planner sanitized
 * banned verb(s) twirl, dance from spec..."). These strings are then
 * shown to the writer LLM verbatim. Echoing the forbidden tokens 13 times
 * across the prompt PRIMES the model to produce them — a well-known
 * negative-priming failure mode in instruction-tuned LLMs.
 *
 * The infant ban is already named ONCE in the INFANT BOOK CONTRACT at the
 * top of the user prompt; that's enough. Per-spread forbiddenMistakes
 * entries that simply re-echo the ban are replaced with a neutral
 * reminder that does NOT contain any banned-verb literal.
 */
function sanitizeForbiddenMistakesForInfant(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map(raw => {
      const s = String(raw || '');
      if (!s) return null;
      // If this entry contains any banned verb literal, replace it with a
      // neutral, verb-free reminder. Otherwise keep it (it's spread-specific
      // guidance like "unmotivated location change" we want the writer to see).
      const hits = findInfantPlannerVerbs(s);
      if (hits.length === 0) return s;
      return 'INFANT BAND: keep the manuscript inside the still-point safe-action set named in the INFANT BOOK CONTRACT (no locomotion verbs, no dialogue commands).';
    })
    .filter(Boolean)
    // Dedupe identical entries so the writer doesn't see the same neutral
    // reminder 13 times either.
    .filter((entry, idx, arr) => arr.indexOf(entry) === idx);
}

/**
 * PR J.1 — defensive re-sanitization at the writer-input boundary.
 *
 * PR H sanitizes focalAction/plotBeat in the planner. This is a
 * belt-and-suspenders pass: even if a future planner change drops banned
 * verbs back into a spec, the writer prompt itself never contains them.
 * If sanitizeInfantSpec produces changes that the planner missed, we use
 * the cleaned strings for the writer view of the spec only — we don't
 * mutate the persisted spec from here.
 */
function sanitizeSpecViewForInfant(spec, heroName) {
  if (!spec) return spec;
  const { spec: cleaned } = sanitizeInfantSpec(spec, { heroName });
  return {
    ...spec,
    focalAction: cleaned.focalAction,
    plotBeat: cleaned.plotBeat,
  };
}

function userPrompt(doc) {
  const { storyBible, visualBible, spreads } = doc;
  const retries = selectRetryMemory(doc.retryMemory, 'writerDraft');
  const retryBlock = renderRetryMemoryForPrompt(retries);
  const isInfant = doc?.request?.ageBand === AGE_BANDS.PB_INFANT;
  const heroName = doc?.brief?.child?.name || '';
  const specs = spreads.map(s => {
    const baseSpec = isInfant ? sanitizeSpecViewForInfant(s.spec, heroName) : s.spec;
    const forbiddenMistakes = isInfant
      ? sanitizeForbiddenMistakesForInfant(baseSpec?.forbiddenMistakes)
      : baseSpec?.forbiddenMistakes;
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
      forbiddenMistakes,
    };
  });

  const lineCountReminder = renderLineCountReminder(doc.request?.ageBand);
  const infantContract = renderInfantContract(doc.request?.ageBand);

  return [
    infantContract,
    renderTextPolicyBlock(doc),
    lineCountReminder ? `\n${lineCountReminder}` : '',
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
    // Defense-in-depth: if the writer overshoots line count for an infant
    // book, truncate to a 2-line AA couplet here so downstream stages see a
    // band-shaped manuscript even before the rewrite loop catches up.
    const manuscript = maybeTruncateInfantManuscript(manuscriptRaw, doc);
    next = updateSpread(next, n, s => ({
      ...s,
      manuscript,
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
  const result = await callText({
    model: MODELS.WRITER,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userPrompt(doc),
    jsonMode: true,
    temperature: getWriterTemperature('draft', doc?.request?.ageBand),
    maxTokens: 12000,
    label: 'writerDraft',
    abortSignal: doc.operationalContext?.abortSignal,
  });

  let next = applyManuscript(doc, result.json);
  next = appendLlmCall(next, {
    stage: 'writerDraft',
    model: result.model,
    attempts: result.attempts,
    usage: result.usage,
  });

  // PR G: post-draft compression pass for infant books. The primary writer
  // is encouraged to draft freely; we then compress each spread to a
  // 2-line AA couplet that satisfies the infant contract. Compression
  // with hard constraints is a narrower task than constrained free
  // generation and reliably scrubs subtle locomotion verbs that slipped
  // past the writer's own self-check. No-op for non-infant bands.
  next = await compressInfantManuscript(next);

  return next;
}

module.exports = { draftBookText, applyManuscript, renderInfantContract };
// PR J.1 — internal helpers exposed for unit testing only. Not part of the
// public surface and not consumed elsewhere in the pipeline.
module.exports.__testInternals = {
  sanitizeForbiddenMistakesForInfant,
  sanitizeSpecViewForInfant,
};
