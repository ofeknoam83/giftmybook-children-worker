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

const SYSTEM_PROMPT = `You are a senior children's picture-book story architect.
You design the narrative spine for a premium personalized book, not the final prose.

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

  const personalizationBlock = renderPersonalizationSnapshotForPlanner(brief.child, brief.customDetails || {});
  const rich = briefHasRichPersonalization(brief.child, brief.customDetails || {});
  const isInfant = request.ageBand === AGE_BANDS.PB_INFANT;

  // Lap-baby books are NOT adventure books — the hero cannot travel a
  // multi-location quest, and there is no narrative escalation. Cap the
  // scope to at most 2 connected micro-settings (cot+kitchen, porch+garden,
  // bedroom+window) and frame the spine as sensory discovery, not physical
  // locomotion. This clause overrides the general adventure-book guidance
  // above, which assumes a hero who can walk.
  const infantStoryBibleClause = isInfant
    ? `INFANT BAND (PB_INFANT, ages 0-1.5) — SCOPE OVERRIDE for the story bible:
  - This is a lap-baby board book. The hero CANNOT travel, lead a quest, or move between many locations under their own power.
  - cinematicLocations: at most 2 connected micro-settings only — e.g. cot + kitchen, porch + garden, bedroom + window, lap + park-bench. NEVER 3+ locations. NEVER "coastal lighthouse at dusk" / "market square at twilight" / "hilltop with racing clouds" — those are toddler+ scopes.
  - narrativeSpine / middleEscalation / endingPayoff are NOT a quest. They describe a sensory discovery thread ("Mama and Scarlett notice the warmth, the light, and the song through one quiet day"), not a problem to solve.
  - visualJourneySpine is the sensory thread connecting those 2 micro-settings (a beam of warm light moving across the room, a sound carried from one space to the next), NOT a causal chain of athletic actions.
  - recurringVisualMotifs are tactile/auditory anchors a baby actually senses: a soft blanket, Mama's hands, a window of light, a wooden cup, a familiar song.
  - humorStrategy is gentle warmth (the family dog bumping the high chair, the cat curling up nearby) — NEVER a comedic engine that requires the hero to act on the world.
  - The book is read TO the baby by the parent. Write the spine FOR the parent reading aloud.`
    : '';

  return [
    `Child: ${brief.child.name}, age ${brief.child.age}, gender ${brief.child.gender}.`,
    `Format: ${request.format}. Age band: ${request.ageBand}. Theme: ${request.theme}.`,
    `Approved cover title: "${cover.title}".`,
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
    `{
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
  "forbiddenMoves": ["things this specific book must avoid (generic scenes, bedtime ending, preachiness, etc.)"]
}`,
    retryBlock ? `\n${retryBlock}` : '',
    'Emit the JSON now.',
  ].filter(Boolean).join('\n');
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
