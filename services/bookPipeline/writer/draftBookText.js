/**
 * Writer draft stage.
 *
 * Writes the full manuscript using the storyBible, visualBible, and spread
 * specs. Produces strict-JSON one entry per spread with text, side, and
 * line-break hints. Does not redesign plot structure.
 */

const { callText } = require('../llm/openaiClient');
const { MODELS, TOTAL_SPREADS } = require('../constants');
const { updateSpread, appendLlmCall } = require('../schema/bookDocument');
const { renderTextPolicyBlock } = require('./textPolicies');
const { selectRetryMemory, renderRetryMemoryForPrompt } = require('../retryMemory');
const { WRITER_LOCATION_VIVIDNESS_RULES } = require('./writerLocationGuidance');

const SYSTEM_PROMPT = `You write premium children's book verse for image-first spreads.

Hard rules (apply to every spread):
- Honor the spread spec exactly (side, personalization, beat).
${WRITER_LOCATION_VIVIDNESS_RULES}
- Read-aloud quality comes first. Musical cadence, simple words, no large metaphors, low repetition.
- Third-person by default unless the user prompt overrides.
- Funny/playful tone, character-based humor. Mostly implicit emotional meaning — never preach.
- Use the child's name sometimes, not constantly. Use custom details and \`mustUseDetails\` concretely.
- **Plot energy:** follow \`plotBeat\`, \`focalAction\`, and \`location\` — the adventure (discovery, problem, funny try, wonder) drives each spread. If personalization is soft (hugs, kisses, snuggles), honor it lightly on heart/close spreads — do not make every spread only cuddly or generic family warmth; the spec's action still happens.
- **No line wallpaper:** do not paste the same full line on multiple spreads unless one intentional callback — vary wording while keeping rhyme.
- **Scene flow:** when \`sceneBridge\` and \`continuityAnchors\` are present on a spread, let the verse acknowledge the *same* story movement — cause, discovery, or callback — so the read-aloud feels like a single adventure, not isolated vignettes. You may imply the bridge subtly (a repeated object, a "still following", "the trail led", "the friend from before") without naming camera directions.
- **Anti-collage:** Do not treat each spread as a standalone puzzle of random props. Personalization (\`mustUseDetails\`, questionnaire) must feel **woven into the same outing** — reuse motifs and causal links across spreads; avoid "feature a new gimmick every page" when the story bible implies one journey.
- **Mechanical hooks:** Do not use the counting phrase "one, two, three" (or "1, 2, 3") on **more than two spreads** in the same book unless \`storyBible.narrativeSpine\` or \`recurringVisualMotifs\` clearly establish that counting beat as the book's intentional refrain. Vary rhythm and actions spread to spread.

Picture-book structure (MANDATORY when format is picture_book — every single spread, no exceptions):
- The "text" field for each spread is EXACTLY 4 lines, separated by a single "\\n" character.
- Rhyme scheme is AABB: line 1's last word rhymes with line 2's last word, and line 3's last word rhymes with line 4's last word. Lines 2 and 4 do NOT need to rhyme with each other.
- Real end-rhymes only (e.g. "high / sky", "wide / side", "tune / moon"). Near-rhymes are fine. Non-rhymes ("sing / plan", "sway / nap") are NOT acceptable.
- **Different rhyme words:** Within each couplet, the **last stressed word** of line 1 vs line 2 (and line 3 vs 4) must be **two different words** — never repeat the same word to "rhyme" with itself ("heart / heart", "bright / bright", "cuddle / cuddle"). Also avoid **lazy echo** where the pair is only grammar-flip of the same stem ("glow / glows", "bake / bakes") — pick a true second rhyme mate.
- LINE LENGTH — see the per-age-band "LINE LENGTH" rule in the age/voice policy block above. Ages 0-3 (PB_TODDLER) are VERY short (~3-7 words/line, sing-song board-book cadence); ages 3-6 (PB_PRESCHOOL) are short (~6-12 words/line). Never exceed the hardMax for the band. Each line is a natural phrase unit with consistent musical pulse across each couplet.
- If a couplet does not actually rhyme when read aloud, rewrite it before emitting.
- No line may cross the horizontal center of the spread when painted.

Early reader structure (when format is early_reader):
- 3–4 short prose lines per spread. Rhyme optional — do not force it.

Return ONLY strict JSON: { "spreads": [ { "spreadNumber": 1, "text": "LINE1\\nLINE2\\nLINE3\\nLINE4", "side": "left|right", "lineBreakHints": ["..."], "personalizationUsed": ["..."], "writerNotes": "optional" }, ... ] }. The "text" field is a single string with embedded "\\n" line breaks — do NOT emit it as an array.`;

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

  return [
    renderTextPolicyBlock(doc),
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
    'For each spread, the four lines must make the place feel beautiful and specific — grounded in that spread\'s `location` and `focalAction`, not generic indoor blur — while keeping **narrative continuity** with `sceneBridge` so the book does not read as thirteen unrelated spectacle cards.',
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
    const manuscript = {
      text: String(entry.text || '').trim(),
      side: entry.side === 'left' ? 'left' : 'right',
      lineBreakHints: Array.isArray(entry.lineBreakHints) ? entry.lineBreakHints.map(String) : [],
      personalizationUsed: Array.isArray(entry.personalizationUsed) ? entry.personalizationUsed.map(String) : [],
      writerNotes: entry.writerNotes ? String(entry.writerNotes) : null,
    };
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

  const next = applyManuscript(doc, result.json);
  return appendLlmCall(next, {
    stage: 'writerDraft',
    model: result.model,
    attempts: result.attempts,
    usage: result.usage,
  });
}

module.exports = { draftBookText, applyManuscript };
