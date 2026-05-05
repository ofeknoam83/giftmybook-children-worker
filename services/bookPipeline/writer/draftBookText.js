/**
 * Writer draft stage.
 *
 * Writes the full manuscript using the storyBible, visualBible, and spread
 * specs. Produces strict-JSON one entry per spread with text, side, and
 * line-break hints. Does not redesign plot structure.
 */

const { callText } = require('../llm/openaiClient');
const { MODELS, TOTAL_SPREADS, TEXT_LINE_TARGET, AGE_BANDS } = require('../constants');
const { updateSpread, appendLlmCall } = require('../schema/bookDocument');
const { renderTextPolicyBlock } = require('./textPolicies');
const { selectRetryMemory, renderRetryMemoryForPrompt } = require('../retryMemory');
const { maybeTruncateInfantManuscript } = require('./truncateInfantText');
const { compressInfantManuscript } = require('./compressInfantSpread');

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
    '4. NO LOCOMOTION VERBS. The baby cannot do these and the parent reading aloud will sound silly:',
    '   BANNED: jump, run, race, spin, twirl, hop, walk, climb, leap, dance, chase, grab, skip, gallop, stomp, march, crawl, cartwheel, tumble, step, stand, stood, bounce.',
    '   Also banned: "feet flash", "feet pound", "feet race" — no body-part displacements.',
    '   USE INSTEAD: sit, lie, look, see, reach, hold, snuggle, giggle, coo, pat, clap, hear, smell, touch, point.',
    '5. Across the WHOLE book, do NOT lean on a single noun or sound-word as a refrain (e.g. "peekaboo" 5 times). Vary the imagery.',
    '6. Real English only. No invented rhyme-fill words. No similes with abstract comparands.',
    '',
    'GOOD EXAMPLE (one spread):',
    '   Mama lifts the moon.',
    '   Bright as a spoon.',
    '',
    'BAD EXAMPLE (do NOT do this):',
    '   Peekaboo! Everleigh says, "Dance!"',
    '   "Mama, outside!" She starts to prance.',
    '   They giggle in warm sun.',
    '   A bright chase has begun.',
    '   — 4 lines (should be 2), uses "dance", "prance", "chase" (banned locomotion), "peekaboo" as refrain.',
    '============================================================',
  ].join('\n');
}

function userPrompt(doc) {
  const { storyBible, visualBible, spreads } = doc;
  const retries = selectRetryMemory(doc.retryMemory, 'writerDraft');
  const retryBlock = renderRetryMemoryForPrompt(retries);
  const specs = spreads.map(s => ({
    spreadNumber: s.spreadNumber,
    purpose: s.spec?.purpose,
    plotBeat: s.spec?.plotBeat,
    sceneBridge: s.spec?.sceneBridge,
    emotionalBeat: s.spec?.emotionalBeat,
    humorBeat: s.spec?.humorBeat,
    location: s.spec?.location,
    focalAction: s.spec?.focalAction,
    textSide: s.spec?.textSide,
    textLineTarget: s.spec?.textLineTarget,
    mustUseDetails: s.spec?.mustUseDetails,
    continuityAnchors: s.spec?.continuityAnchors,
    forbiddenMistakes: s.spec?.forbiddenMistakes,
  }));

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
  const result = await callText({
    model: MODELS.WRITER,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userPrompt(doc),
    jsonMode: true,
    temperature: 0.95,
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
