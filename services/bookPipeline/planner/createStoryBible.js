/**
 * Story bible planner.
 *
 * Produces the book's narrative spine before any spread-level writing or
 * illustration. Optimizes for read-aloud delight, memorable personalization,
 * cinematic-but-safe adventure, and a concrete ending. Uses OpenAI with
 * strict JSON output.
 */

const { callText } = require('../llm/openaiClient');
const { MODELS, AGE_BANDS } = require('../constants');
const { appendLlmCall, withStageResult } = require('../schema/bookDocument');
const { selectRetryMemory, renderRetryMemoryForPrompt } = require('../retryMemory');
const { renderThemeDirectiveBlock } = require('./themeDirectives');
const {
  renderPersonalizationSnapshotForPlanner,
  briefHasRichPersonalization,
} = require('./personalizationSnapshot');
const {
  buildAnchorAllocation,
  renderAllocationBlockForStoryBible,
} = require('./anchorAllocation');

const SYSTEM_PROMPT = `You are a senior children's picture-book story architect.
You design the narrative spine for a premium personalized book, not the final prose.

**ANCHORS ARE THE SUBJECT (read first).** When the user prompt includes a BOOK SUBJECT block listing specific questionnaire moments (\`funny_thing\`, \`meaningful_moment\`, \`moms_favorite_moment\`, \`dads_favorite_moment\`, \`anything_else\`, \`calls_mom\`, \`calls_dad\`), THIS BOOK IS ABOUT THOSE MOMENTS. They are not a checklist — they are the spine. \`narrativeSpine\`, \`beginningHook\`, \`middleEscalation\`, \`endingPayoff\`, \`emotionalArc\`, \`humorStrategy\`, and at least half of \`personalizationTargets\` must explicitly grow out of those exact moments. **Transform, do not erase, do not copy.** Preserve the emotional truth and concrete specifics of each moment — the people, the action, the place, the feeling — by writing them into the story's voice. Do NOT generalize them into stock imagery ("a tiny chomp", "a happy hug") that loses what made the moment specific. Do NOT copy the questionnaire answer literally either — the bible's job is to plan how the writer will turn that moment into a couplet that lives on the page. Generic adventure / sensory imagery is allowed only as the connective tissue BETWEEN anchor moments, never in place of them.

**Anti-padding compression.** When the questionnaire is sparse (≤3 strong text moments), do NOT manufacture extra plot to fill the page count. Compress: let some spreads be quiet sensory bridges that grow out of the anchor moments, rather than 13 padded couplets sprinkled with anchor tokens. The goal is anchor density, not anchor decoration.

Hard rules:
- Optimize for fun read-aloud quality first, emotional payoff, personalization, and visual richness.
- Funny, playful tone, character-based humor. Never preachy.
- Soft but meaningful emotional range. Cinematic but clearly child-safe adventure.
- Push toward memorable, photogenic locations. Never let the book live mostly inside a house.
- **One connected adventure (critical):** the book must read as a single through-line — cause, quest, or discovery that pulls the hero from place to place. New settings are welcome and should feel spectacular, but they must not feel like random stock backdrops. Every major location change should answer "what story reason brought us here?" Prefer **causal bridges tied to the PERSONALIZATION SNAPSHOT** when present (a prop from interests, a real anecdote object, a ticking errand, mistaken delivery, tidal clock, steward creature with no light motif, friend's note, weather closing a path, map clue from custom details). Avoid defaulting the whole spine to "chasing a light" or a luminous trail unless the brief explicitly names that fantasy. Avoid "theme park" jumps with no bridge.
- **Recurring visual motifs:** name 3-5 concrete things that can reappear in the art — **prefer** a carried object or color from the questionnaire, a small non-mascot companion echo, weather continuity, texture/sound motif, or recurring food/prop from interests. Luminous trails or "glow leading the child" may appear **at most** as one motif if the personalization section truly supports it — do not stack them with a talking star, personified lamp, and prism quest by default.
- **Anti-template stack:** avoid making the spine = talking animal guide + map scavenger + personified light/star + prism/lighthouse restore **unless** hooks in the brief/interests explicitly invite that cluster.
- The hero is the child provided in the brief. The approved cover is already chosen; the cover locks the hero's look and outfit.
- Do not invent named family members that are not in the brief. Do not turn the child into a stand-in for any family member.
- **Personalization tie-in (when PERSONALIZATION SNAPSHOT has interests, questionnaire lines, or substantive custom details):** \`narrativeSpine\`, \`middleEscalation\`, at least half of \`personalizationTargets\`, the primary companion or quest object, and \`visualJourneySpine\` must clearly echo at least one concrete item from that snapshot. If the snapshot is nearly empty, inventive generic adventure is OK for adventure / fantasy / space / sea themes. **For parent themes (mother's day / father's day / grandparents day) and birthday, even with a thin snapshot, you must NOT default to the theme's cultural prop set** — the through-line must be a CONCRETE SHARED ACTIVITY in a CONCRETE PLACE (a specific errand, a specific build, a specific reach, a specific outing to a specific named place). It may not be a generic gift-giving sequence, a ribbon trail, a heart-and-bouquet collage, a breakfast tray, or any culturally pre-formed token of the holiday. The personalization may be sparse but the spine must still be a real journey with cause and effect.
- **Parent themes are adventure books with an emotional spine (additive, not subtractive):** treat parent themes the same way you treat adventure themes for plot construction — same standards for cinematic locations, causal bridges, recurring visual motifs, surprise, and anti-template variety. The parent rail adds emotional anchoring **on top**; it does not lower the adventure bar. The hero/parent bond is the EMOTIONAL spine of the book, not the STRUCTURAL one — the structural spine is still a concrete journey with cause and effect, multiple distinct photogenic locations, and earned escalation. A parent theme that ends up smaller in scope or quieter in stakes than an adventure book has failed.
- **Sensory spine for parent themes:** for mother's day / father's day / grandparents day, the spine must carry at least ONE sensory anchor that recurs across multiple spreads — a specific scent, a specific sound, a specific texture, a specific temperature, or a specific weight. Examples: the smell of a certain bread, the squeak of a particular gate, the cold of a specific bench, the weight of a satchel, the hush of an empty hall. Generic emotional gestures (a warm hug, a smile, a happy heart) are NOT sensory anchors. Add the chosen sensory motif to \`recurringVisualMotifs\` so the writer has something specific to ground every spread in (taste / touch / sound / smell / temperature) instead of abstract emotional verbs.
- **Thicker-bible contract (Phase 1).** A book a child asks for again has a unified narrator, a real refrain, and a specific MOMENT. Emit these named fields and treat them as the spine, not decoration:
  - \`moment\` — the specific hour/occasion the book inhabits, named as a real time and place. NOT "being brave" (a topic) but "the morning between waking up and the bus on the first day of kindergarten" (a moment).
  - \`weather\` — the atmospheric anchor that holds across all 13 spreads: light, time of day, mood. "Late-afternoon gold," "rainy Tuesday afternoon," "first snow at dusk." Atmosphere does ~70% of the emotional work — pick it before the plot.
  - \`ritual\` — a small, family-adoptable action the hero does once or twice that a parent could adopt at home (three deep breaths and a wink; tap the door three times; whisper a name to the moon). May be null if no ritual fits this book — but prefer to find one. This is the single highest-leverage move on "asked for again."
  - \`voiceCard\` — how this book SOUNDS. Four fields: narratorPOV ("third-person warm" / "second-person intimate" / "first-person brave-child"), tonalRegister ("gentle, slightly wry, never cute"), signatureMove (ONE positive narrator trick used recurrently — a sound word, a tiny aside, a sensory zoom; not a "don't"), refrainSeed (4–7 words at the heart of the refrain).
  - \`refrain\` — a 4-to-12-word phrase that recurs THREE times with three jobs: plant (spread 1–4: introduce at face value), deepen (spread 5–9: same words, weighted by what has happened), transform (spread 10–13: same words, new meaning earned). Pick exact spread numbers that fit this book.
  - \`openingImage\` — a concrete, drawable image the book opens on (NOT a feeling). "A lunchbox on the counter, lid still open." It must matter at the end.
  - \`closingCallback\` — how the closing image references or transforms openingImage. Same object, new feeling — or new framing of the same scene. The book ends by re-showing where it began.
  - \`adultReaderLine\` — ONE short note (≤ 120 chars) describing a single line that should resonate with the ADULT reading aloud, not only the child. A sly aside, a melancholic detail, a wink — something that earns the parent's hundredth re-read. Optional: emit empty string if no line fits this book. The writer is asked to place this beat naturally in one spread, rendered in voice rather than copied as-is.
- Return ONLY strict JSON matching the schema in the user message.`;

function userPrompt(doc) {
  const { brief, cover, request } = doc;
  const retries = selectRetryMemory(doc.retryMemory, 'storyBible');
  const retryBlock = renderRetryMemoryForPrompt(retries);
  const themeBlock = renderThemeDirectiveBlock(request.theme);

  const customDetailsBlock = Object.entries(brief.customDetails || {})
    .filter(([, v]) => v != null && String(v).trim())
    .map(([k, v]) => `  - ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n') || '  (none)';

  const personalizationBlock = renderPersonalizationSnapshotForPlanner(brief.child, brief.customDetails || {}, brief.pronouns || null);
  const rich = briefHasRichPersonalization(brief.child, brief.customDetails || {});
  const isInfant = request.ageBand === AGE_BANDS.PB_INFANT;

  // PR Z — anchor allocation. Build the deterministic per-beat plan and
  // render the BOOK SUBJECT block at the top of the userPrompt so the LLM
  // reads the questionnaire moments as the narrative spine, not as a
  // checklist below the fold.
  const anchorAllocation = buildAnchorAllocation(brief);
  const anchorBlock = renderAllocationBlockForStoryBible(anchorAllocation);

  // Lap-baby books are NOT adventure books — the hero cannot travel a
  // multi-location quest, and there is no narrative escalation. Cap the
  // scope to at most 2 connected micro-settings (cot+kitchen, porch+garden,
  // bedroom+window) and frame the spine as sensory discovery, not physical
  // locomotion. This clause overrides the general adventure-book guidance
  // above, which assumes a hero who can walk.
  const infantStoryBibleClause = isInfant
    ? `INFANT BAND (PB_INFANT, ages 0-1.5) — SCOPE OVERRIDE for the story bible:
  - This is a lap-baby board book. The hero CANNOT travel, lead a quest, or move between many locations under their own power.
  - cinematicLocations: at most 2 connected micro-settings, OR up to 3 when they form ONE continuous outdoor / semi-outdoor journey the baby is CARRIED through (e.g. front stoop → garden path → river-edge bench; porch → flower lane → park bench under a maple). NEVER 4+ locations. NEVER unconnected jumps. NEVER "coastal lighthouse at dusk" / "market square at twilight" / "hilltop with racing clouds" — those are toddler+ scopes. The baby is carried (in arms, sling, stroller, pram) across all stops; no self-locomotion.
  - narrativeSpine / middleEscalation / endingPayoff are NOT a quest. They describe a sensory discovery thread ("Mama and Scarlett notice the warmth, the light, and the song through one quiet day"), not a problem to solve. For 3-stop outdoor books, the thread is sensory escalation through the journey (light on the stoop → fragrance on the path → water-sound at the bench), not a goal-driven mission.
  - visualJourneySpine is the sensory thread connecting the micro-settings (a beam of warm light moving across the room, a sound carried from one space to the next, the smell of cut grass deepening as the path opens onto the river), NOT a causal chain of athletic actions.
  - recurringVisualMotifs are tactile/auditory anchors a baby actually senses. INDOOR examples: a soft blanket, Mama's hands, a window of light, a wooden cup, a familiar song. OUTDOOR examples (use these when the journey leaves the home): a petal cupped in a small hand, breeze on a cheek, water-sound at a bench, fragrance of cut grass, a songbird overhead, dew on a railing, the weight of a hat brim, gravel under a stroller wheel.
  - humorStrategy is gentle warmth (the family dog bumping the high chair, the cat curling up nearby, a stroller wheel that squeaks at every step) — NEVER a comedic engine that requires the hero to act on the world.
  - The book is read TO the baby by the parent. Write the spine FOR the parent reading aloud.`
    : '';

  // The JSON schema example in this prompt is the LLM's strongest anchor for
  // shape AND content. Shipping the toddler+ schema example to an infant book
  // (e.g. "3-5 photogenic settings ... coastal lighthouse at dusk") directly
  // contradicts the prose infant clause above and was the root cause of the
  // PR M→regen failure: the validator rejects 3+ cinematicLocations for
  // PB_INFANT, but the schema example was telling the model to emit them.
  // Use a band-shaped schema example instead so prose and schema agree.
  // Phase-1 thicker-bible fields the LLM must emit on every band:
  //   moment, weather, ritual, voiceCard, refrain{text,plant,deepen,transform},
  //   openingImage, closingCallback. See SYSTEM_PROMPT for what they mean.
  const thickerBibleSchema = `  "moment": "one sentence: the specific hour/occasion this book inhabits — a real time and place, not a topic. e.g. 'the morning between waking up and the bus on the first day of kindergarten'.",
  "weather": "one short phrase: the atmospheric anchor across all 13 spreads (light + time of day + mood). e.g. 'late-afternoon gold, leaves blowing'.",
  "ritual": { "name": "short name of a small family-adoptable action (3-7 words). null if no ritual fits.", "description": "one sentence: how the ritual works in this book and how a parent could adopt it." },
  "voiceCard": {
    "narratorPOV": "one phrase: e.g. 'third-person warm', 'second-person intimate', 'first-person brave-child'.",
    "tonalRegister": "one phrase: e.g. 'gentle, slightly wry, never cute'.",
    "signatureMove": "one POSITIVE narrator trick used recurrently (a sound word, a tiny aside to the reader, a sensory zoom). NOT a 'don't'.",
    "refrainSeed": "4-7 words at the heart of the refrain"
  },
  "refrain": {
    "text": "the 4-to-12-word refrain phrase that will recur three times",
    "plant": "integer spread number 1-4 where it first appears (face value)",
    "deepen": "integer spread number 5-9 where it deepens (same words, new weight)",
    "transform": "integer spread number 10-13 where it transforms (same words, new meaning)"
  },
  "openingImage": "one sentence: a concrete, drawable image the book opens on (NOT a feeling). Must matter at the end.",
  "closingCallback": "one sentence: how the closing image references or transforms openingImage — same object, new feeling, or new framing of the same scene.",
  "adultReaderLine": "≤ 120 chars: a brief described beat the writer should land in one spread that resonates with the adult reading aloud (a sly aside, a melancholic detail, a wink). Empty string if no such beat fits this book.",`;

  const schemaExample = isInfant
    ? `{
  "narrativeSpine": "one sentence that names what this lap-baby book is really about (a sensory discovery thread, NOT a quest)",
  "beginningHook": "one sentence: the opening beat the parent reads first (a tiny sensory invitation, not a problem to solve)",
  "middleEscalation": "one sentence: how the sensory thread deepens — this is NOT escalation in the action sense; it is a quieter sensory bloom (the light moves, the sound carries, a familiar warmth grows)",
  "endingPayoff": "one sentence: the concrete, specific final beat the parent and baby share (a held cheek, a name spoken, a felt rhythm) — NOT a quest resolution",
  "emotionalArc": "one sentence: the emotional spine from start to finish (warmth, recognition, calm)",
  "humorStrategy": "one sentence: gentle warmth only — the family pet bumping the high chair, a sock that won't stay on. NEVER a comedic engine that requires the hero to act on the world.",
  "themeGuidance": "one sentence: how ${request.theme} shows up without being on-the-nose",
  "personalizationTargets": ["3-6 specific custom-detail hooks the book must use — prefer tactile/auditory/named-person hooks the parent can point to during the read-aloud"],
  "locationStrategy": "one sentence: a contained sensory spine across 1-2 connected micro-settings the baby can be carried between (cot+kitchen, lap+window, porch+garden), OR a single continuous outdoor journey across up to 3 stops the baby is carried through (front stoop → garden path → river-edge bench). Do NOT propose a multi-location travel spine where the hero moves under their own power — the hero is a lap baby.",
  "cinematicLocations": ["1-2 connected micro-settings, OR up to 3 stops on ONE continuous outdoor/semi-outdoor journey. Use intimate, baby-scale spaces (a sun-warmed bedroom window, a high-chair beside the kitchen sink, a porch swing under a maple, the cot at nap-light) OR up-to-three stops the baby is CARRIED through (front stoop at first light → flower-lined path mid-morning → river-edge bench under a willow). NEVER 4 or more locations. NEVER unconnected jumps. NEVER 'coastal lighthouse', 'market square', 'hilltop', or 'tide pool' — those are toddler+ scopes and will fail validation. Time-of-day + weather labels are fine and encouraged on outdoor stops."],
  "visualJourneySpine": "2-3 sentences: the SENSORY thread that connects the micro-settings (a beam of warm light moving across the room, a familiar song carried from one space to the next, the smell of something baking reaching the cot — OR for outdoor books: light on the stoop deepening into fragrance on the path and water-sound at the bench). NOT a causal action chain. NOT a mission or quest.",
  "recurringVisualMotifs": ["3-5 tactile/auditory anchors a baby actually senses. INDOOR: a soft blanket, Mama's hands, a window of light, a wooden cup, a familiar song, the family cat's tail. OUTDOOR (preferred when the journey leaves home): a petal cupped in the hand, breeze on a cheek, water-sound at a bench, fragrance of cut grass, a songbird overhead, dew on a railing, gravel under a stroller wheel. Prefer cues from the PERSONALIZATION SNAPSHOT."],
  "forbiddenMoves": ["things this specific book must avoid (locomotion the baby cannot do, multi-location quests, preachy lessons, bedtime endings unless the brief asks for one)."],
${thickerBibleSchema}
}`
    : `{
  "narrativeSpine": "one sentence that names what the book is really about",
  "beginningHook": "one sentence: the opening beat that grabs a child",
  "middleEscalation": "one sentence: how the story grows and surprises",
  "endingPayoff": "one sentence: the concrete, specific ending that parents remember",
  "emotionalArc": "one sentence: the emotional spine from start to finish",
  "humorStrategy": "one sentence: the comedic engine (e.g. literal-minded sidekick, hero misreads the world)",
  "themeGuidance": "one sentence: how ${request.theme} shows up without being on-the-nose",
  "personalizationTargets": ["3-6 specific custom-detail hooks the book must use"],
  "locationStrategy": "one sentence: a travel spine across at least 4 visually distinct, photogenic places",
  "cinematicLocations": ["3-5 specific photogenic settings the book MUST visit. Use real location types with time-of-day and weather (e.g. a coastal lighthouse at dusk, a market square strung with lanterns at twilight, a hilltop with a single tree under racing clouds, a tide pool at low tide in morning fog). No generic 'park' or 'garden' — name the time of day AND the weather/light."],
  "visualJourneySpine": "2-4 sentences: the causal thread that connects those places into ONE story — the mission, object, quest, or escalation that justifies each move. Make the chain clear enough that spread-to-spread transitions feel earned, not random.",
  "recurringVisualMotifs": ["3-5 concrete motifs — prefer cues from personalization snapshot before generic luminous trails"],
  "forbiddenMoves": ["things this specific book must avoid (generic scenes, bedtime ending, preachiness, etc.)"],
${thickerBibleSchema}
}`;

  return [
    `Child: ${brief.child.name}, age ${brief.child.age}, gender ${brief.child.gender}.`,
    `Format: ${request.format}. Age band: ${request.ageBand}. Theme: ${request.theme}.`,
    `Approved cover title: "${cover.title}".`,
    // PR Z — anchor allocation block FIRST, so the LLM reads the book's
    // subject before any abstract narrative theory.
    anchorBlock,
    themeBlock,
    personalizationBlock,
    infantStoryBibleClause,
    rich
      ? ''
      : 'NOTE: Personalization snapshot is thin — still avoid boilerplate "moth + chasing light + prism" unless you invent a fresh angle.',
    `Custom details (must be used concretely unless they hurt the story):`,
    customDetailsBlock,
    '',
    'Return JSON with this exact shape:',
    schemaExample,
    retryBlock ? `\n${retryBlock}` : '',
    'Emit the JSON now.',
  ].filter(Boolean).join('\n');
}

/**
 * Normalize the LLM's `ritual` object onto a strict shape, or null if no
 * ritual was emitted / it was emitted empty. The validator allows null
 * (rituals are optional — not every book needs one) but rejects partial
 * objects with only one of the two fields filled.
 *
 * @param {any} raw
 * @returns {{ name: string, description: string }|null}
 */
function normalizeRitual(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  const description = String(raw.description || '').trim();
  if (!name && !description) return null;
  return { name, description };
}

/**
 * Normalize the LLM's `voiceCard` object onto its four required fields.
 * Empty fields are kept as empty strings so the validator can flag the
 * specific missing field instead of treating the whole object as missing.
 *
 * @param {any} raw
 * @returns {{ narratorPOV: string, tonalRegister: string, signatureMove: string, refrainSeed: string }}
 */
function normalizeVoiceCard(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    narratorPOV: String(src.narratorPOV || '').trim(),
    tonalRegister: String(src.tonalRegister || '').trim(),
    signatureMove: String(src.signatureMove || '').trim(),
    refrainSeed: String(src.refrainSeed || '').trim(),
  };
}

/**
 * Normalize the LLM's `refrain` object. Coerces plant/deepen/transform to
 * integers; preserves zeros so the validator sees the missing assignment
 * rather than a silently defaulted spread number.
 *
 * @param {any} raw
 * @returns {{ text: string, plant: number, deepen: number, transform: number }}
 */
function normalizeRefrain(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  };
  return {
    text: String(src.text || '').trim(),
    plant: num(src.plant),
    deepen: num(src.deepen),
    transform: num(src.transform),
  };
}

/**
 * @param {object} doc
 * @returns {Promise<object>}
 */
async function createStoryBible(doc) {
  const result = await callText({
    model: MODELS.STORY_BIBLE,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userPrompt(doc),
    jsonMode: true,
    temperature: 0.9,
    maxTokens: 8000,
    label: 'storyBible',
    abortSignal: doc.operationalContext?.abortSignal,
  });

  const json = result.json || {};
  const storyBible = {
    narrativeSpine: String(json.narrativeSpine || '').trim(),
    beginningHook: String(json.beginningHook || '').trim(),
    middleEscalation: String(json.middleEscalation || '').trim(),
    endingPayoff: String(json.endingPayoff || '').trim(),
    emotionalArc: String(json.emotionalArc || '').trim(),
    humorStrategy: String(json.humorStrategy || '').trim(),
    themeGuidance: String(json.themeGuidance || '').trim(),
    personalizationTargets: Array.isArray(json.personalizationTargets) ? json.personalizationTargets.map(String) : [],
    locationStrategy: String(json.locationStrategy || '').trim(),
    cinematicLocations: Array.isArray(json.cinematicLocations) ? json.cinematicLocations.map(String) : [],
    visualJourneySpine: String(json.visualJourneySpine || '').trim(),
    recurringVisualMotifs: Array.isArray(json.recurringVisualMotifs) ? json.recurringVisualMotifs.map(String) : [],
    forbiddenMoves: Array.isArray(json.forbiddenMoves) ? json.forbiddenMoves.map(String) : [],
    // Phase 1 — thicker bible. See SYSTEM_PROMPT for semantics. Validators
    // in schema/validateBookDocument enforce the structure that downstream
    // stages (writer voice, refrain placement, illustrator opening/closing
    // image) actually depend on; weak content surfaces as a gate issue and
    // triggers the existing planner retry budget.
    moment: String(json.moment || '').trim(),
    weather: String(json.weather || '').trim(),
    ritual: normalizeRitual(json.ritual),
    voiceCard: normalizeVoiceCard(json.voiceCard),
    refrain: normalizeRefrain(json.refrain),
    openingImage: String(json.openingImage || '').trim(),
    closingCallback: String(json.closingCallback || '').trim(),
    // Phase 5b — optional. Empty string is acceptable if no adult-reader
    // line fits this specific book; the writer treats empty as "no
    // adult-reader requirement" rather than failing the gate.
    adultReaderLine: String(json.adultReaderLine || '').trim(),
  };

  const traced = appendLlmCall(doc, {
    stage: 'storyBible',
    model: result.model,
    attempts: result.attempts,
    usage: result.usage,
  });
  return withStageResult(traced, { storyBible });
}

module.exports = { createStoryBible };
