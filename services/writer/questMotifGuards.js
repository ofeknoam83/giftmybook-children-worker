/**
 * Reduces repetitive quest-spine motifs on parent-gift adventures (e.g. chasing
 * a sentient ribbon after melody-trope debiasing made "ribbon quests" spike).
 */

const RIBBON_OPT_IN =
  /\b(ribbon|streamers?|satin\s+bow|bow\s+trail|wrapping\s+ribbon)\b/i;

function anecdoteStringBlob(anecdotes) {
  if (!anecdotes || typeof anecdotes !== 'object') return '';
  return Object.values(anecdotes).filter(v => typeof v === 'string').join('\n');
}

/**
 * @param {...string|null|undefined} chunks
 * @returns {boolean}
 */
function briefMentionsRibbon(...chunks) {
  for (const c of chunks) {
    if (typeof c !== 'string' || !c.trim()) continue;
    if (RIBBON_OPT_IN.test(c)) return true;
  }
  return false;
}

/**
 * @param {object} childDetails
 * @param {string} [customDetails]
 * @returns {boolean}
 */
function plannerRibbonBriefOptIn(childDetails, customDetails = '') {
  const an = anecdoteStringBlob(childDetails?.childAnecdotes || childDetails?.anecdotes);
  return briefMentionsRibbon(
    typeof customDetails === 'string' ? customDetails : '',
    an,
  );
}

/** Legacy Phase-1 planner — tighten against ribbon replacing melody as default MacGuffin. */
const STORY_PLANNER_RIBBON_BIAS_LINE =
  '\n\nRIBBON / STREAMER GUARD (parent-gift adventures): Do **not** build the backbone on a glowing or **talking** ribbon, a ribbon that verbally beckons the child, a spread-to-spread chase after the **same** gold or magic ribbon, or ribbon crumbs / ribbon trails as the quest engine — **unless** the family\'s custom questionnaire text **explicitly** names ribbons or streamers. Prefer a **non-luminous**, concrete MacGuffin anchored in hobbies or errands (relay baton charm, arcade ticket stripe, bakery box tab, library date-slip, tram transfer chip, scout patch token, kite tail tab **without personality**, sports hall wristband clasp). **At most one** ordinary real-world ribbon (e.g. gift-wrap bow, hair accessory) across the whole book if it fits naturally.';

/**
 * Writer V2 user prompt — skips when the brief already asks for ribbons.
 * @param {string[]} sections
 * @param {object} [book]
 * @param {object} [child]
 */
function appendParentGiftRibbonMotifGuards(sections, book = {}, child = {}) {
  const an = anecdoteStringBlob(child?.anecdotes);
  if (briefMentionsRibbon(
    typeof book.customDetails === 'string' ? book.customDetails : '',
    typeof book.heartfeltNote === 'string' ? book.heartfeltNote : '',
    an,
  )) {
    return;
  }

  sections.push('\n## RIBBON / STREAMER MACGUFFIN (DO NOT DEFAULT HERE)\n');
  sections.push('- **Forbidden as plot spine:** a sentient or speaking ribbon ("To me!", "Away!"); chasing one recurring gold/magic ribbon across many spreads; ribbon crumbs marking a scavenger leash; moth/fairy plus doodle-map **plus ribbon-as-voicey-guide** cliché — unless `customDetails` explicitly requests ribbons/streamers.');
  sections.push('- **Use instead:** tactile non-ribbon, **non magical-light** tokens (carousel cog, arcade counter chip, train platform stamp, scout belt clip, baker\'s twine tag tied to snacks, scooter bell ring, thrift-shop ticket punch — none of these may **speak** or **blink** as cartoon characters unless the brief invites fantasy).');
  sections.push('- **At most one** mundane ribbon beat in the entire book if natural (real gift bow, hair ribbon on cover) — not the engine of the quest.');
}

const LIGHT_MOTH_OPT_IN =
  /\b(moth|moths|butterfly|butterflies|fireflies?|firefly|lantern|lighthouse|prism|gleam|glow\s*quest|starlight\s*guide)\b/i;

/**
 * @param {...string|null|undefined} chunks
 * @returns {boolean}
 */
function briefMentionsLightOrMothFantasy(...chunks) {
  for (const c of chunks) {
    if (typeof c !== 'string' || !c.trim()) continue;
    if (LIGHT_MOTH_OPT_IN.test(c)) return true;
  }
  return false;
}

/**
 * @param {object} childDetails
 * @param {string} [customDetails]
 */
function plannerLightMothBriefOptIn(childDetails, customDetails = '') {
  const an = anecdoteStringBlob(childDetails?.childAnecdotes || childDetails?.anecdotes);
  const interestBlob = Array.isArray(childDetails?.interests)
    ? childDetails.interests.join(' ')
    : typeof childDetails?.interests === 'string'
      ? childDetails.interests
      : '';
  return briefMentionsLightOrMothFantasy(
    typeof customDetails === 'string' ? customDetails : '',
    an,
    interestBlob,
  );
}

/** Legacy Phase-1 planner — reduce default moth + chased-light + prism stack. */
const STORY_PLANNER_LIGHT_MOTH_BIAS_LINE =
  '\n\nLIGHT / MOTH / PRISM GUARD (parent-gift adventures): Do **not** hang the spine on **lantern moth + talking glow / "Mr Light" + prism restore** unless questionnaire or custom text names moths, lanterns, lighthouses, prism play, or explicit light-fantasy. Prefer MacGuffins and guides grounded in **favorite activities, food, pets, sports, or anecdotes** from the questionnaire.';

/**
 * @param {string[]} sections
 * @param {object} child
 * @param {object} [book]
 */
function appendPersonalizationFirstGuards(sections, child, book = {}) {
  const interestBlob = Array.isArray(child?.interests) ? child.interests.join(' ') : '';
  const an = anecdoteStringBlob(child?.anecdotes);
  const extras = [book.customDetails, book.heartfeltNote]
    .map(x => (typeof x === 'string' ? x : ''))
    .filter(Boolean)
    .join('\n');
  const has = interestBlob.trim() || an.trim() || extras.trim();
  if (!has) return;

  sections.push('\n## PERSONALIZATION-FIRST (QUEST OBJECT + PICTURES)\n');
  sections.push('- Real **interests**, **anecdotes**, and **heartfelt / custom** notes are the first place to shop for the spine, recurring prop, and mascot energy — not a canned adventure pantry.');
  sections.push('- Name concrete objects, foods, games, or places **from the questionnaire** in multiple spreads so art and rhyme feel like **this** family.');
}

/**
 * Writer V2 — skip when brief already names light/moth/prism fantasy.
 * @param {string[]} sections
 * @param {object} [book]
 * @param {object} [child]
 */
function appendParentGiftLightMotifGuards(sections, book = {}, child = {}) {
  const an = anecdoteStringBlob(child?.anecdotes);
  if (briefMentionsLightOrMothFantasy(
    typeof book.customDetails === 'string' ? book.customDetails : '',
    typeof book.heartfeltNote === 'string' ? book.heartfeltNote : '',
    an,
    Array.isArray(child?.interests) ? child.interests.join(' ') : '',
  )) {
    return;
  }

  sections.push('\n## LIGHT / MOTH / PRISM TEMPLATE (DO NOT DEFAULT)\n');
  sections.push('- **Skip** the boilerplate: tiny glowing guide (moth/firefly) + child chases a beam + prism "wakes" a named light — unless `customDetails` explicitly invite that fantasy.');
  sections.push('- Prefer **earthbound** quest drivers from interests/anecdotes (ball, truck, snack, pet, sport, drawing, funny family moment).');
}

function plannerOptInDetailBlob(book = {}) {
  const parts = [];
  if (typeof book.customDetails === 'string') {
    parts.push(book.customDetails);
  } else if (book.customDetails && typeof book.customDetails === 'object') {
    try {
      parts.push(JSON.stringify(book.customDetails));
    } catch (_) { /* noop */ }
  }
  if (typeof book.heartfeltNote === 'string') parts.push(book.heartfeltNote);
  return parts.join('\n').trim();
}

/**
 * Writer V2 — when brainstorm/planner beats are adopted verbatim, reinforce
 * rewriting away from mascot-light clichés buried in upstream stubs.
 *
 * @param {string[]} sections
 * @param {object} [plan]
 * @param {object} [book]
 * @param {object} [child]
 */
function appendUpstreamSeedAntiLightLocks(sections, plan = {}, book = {}, child = {}) {
  if (!plan.usedStorySeedBeats) return;

  const detailBlob = plannerOptInDetailBlob(book);
  const interestBlob = Array.isArray(child?.interests) ? child.interests.join(' ') : '';
  const an = anecdoteStringBlob(child?.anecdotes);

  if (briefMentionsLightOrMothFantasy(detailBlob, an, interestBlob)) return;

  const spineHint = typeof plan.storySeed?.narrative_spine === 'string'
    ? plan.storySeed.narrative_spine.trim()
    : '';

  sections.push('\n## STORY SEED — SPINE ANTI‑TEMPLATE LOCK\n');
  sections.push('- Beats arrive from upstream brainstorming — treat them as **location + beat roughage**, not law. If any line rhymes with *personified Warm Light / mascot beam / collectible café tokens awakening a Glow Lord*, reinterpret into **quirky errands, tactile hobbies, joke snacks, real sports mishaps**, or parent callbacks from the questionnaire — **unless** personalization explicitly names light fantasy, lanterns-as-companions, or prism quests.');
  sections.push('- **Forbidden mascot names or behaviors** anywhere in rhyme: Mr/Mrs Glow, Gleam Lady, spelled-like-a-name LIGHT, prism-and-three-tokens climax, gleam/sun beam that blinks awake as a cartoon character guiding every spread.');
  if (spineHint) {
    sections.push('- Upstream narrative_spine hint: paraphrase in earthbound causal language unless the parent\'s text contradicts.');
  }
}

/** Mr Light / mascot-light spine without questionnaire support (deterministic QA). */
const PERSONIFIED_LIGHT_NAME_RE =
  /\b(?:mrs?\.?\s*light|[Mm]r\.?\s*[Ll]ight|\bmrlight\b|[Mm][Rr][Ll]ight\b)\b/;

/** Singular light/beam or gleam/glow (plural "street lights blinked" stays allowed). */
const PERSONIFIED_LIGHT_SPINE_VERB_RE =
  /\b(?:gleam|glow)s?\s+blink(?:ed)?\s+out|\bbeam\s+blink(?:ed)?\s+out|\blight\s+blink(?:ed)?\s+out|\b(?:gleam|glow|light|beam)s?\s+(?:flicker(?:ed)?\s+back|would\s+(?:soon\s+)?be\s+woken)\b/i;
const PERSONIFIED_LIGHT_WOKEN_ORDER_RE =
  /\b(?:gleam|glow|light|beam)s?\s+[^\n.!?]{0,80}\bwoken\b|\bwoken\b[^\n.!?]{0,80}\bmr\.?\s*light\b|\bmrlight\b[^\n.!?]{0,80}\bwoken\b/;

/**
 * @param {string} blob - joined TEXT (and optionally SCENE) from story spreads
 * @returns {boolean}
 */
function detectParentGiftPersonifiedLightMotifInStory(blob) {
  const t = String(blob || '').replace(/\s+/g, ' ');
  if (!t.trim()) return false;
  if (PERSONIFIED_LIGHT_NAME_RE.test(t)) return true;
  if (PERSONIFIED_LIGHT_SPINE_VERB_RE.test(t)) return true;
  return PERSONIFIED_LIGHT_WOKEN_ORDER_RE.test(t);
}

module.exports = {
  briefMentionsRibbon,
  plannerRibbonBriefOptIn,
  STORY_PLANNER_RIBBON_BIAS_LINE,
  appendParentGiftRibbonMotifGuards,
  briefMentionsLightOrMothFantasy,
  plannerLightMothBriefOptIn,
  STORY_PLANNER_LIGHT_MOTH_BIAS_LINE,
  appendPersonalizationFirstGuards,
  appendParentGiftLightMotifGuards,
  plannerOptInDetailBlob,
  detectParentGiftPersonifiedLightMotifInStory,
  appendUpstreamSeedAntiLightLocks,
};
