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
  '\n\nRIBBON / STREAMER GUARD (parent-gift adventures): Do **not** build the backbone on a glowing or **talking** ribbon, a ribbon that verbally beckons the child, a spread-to-spread chase after the **same** gold or magic ribbon, or ribbon crumbs / ribbon trails as the quest engine — **unless** the family\'s custom questionnaire text **explicitly** names ribbons or streamers. Prefer a different concrete MacGuffin (brass carousel tab, lighthouse lens keeper, prism shard, tide-clock hand, shell token, ferry bell chip, kite twine without personality). **At most one** ordinary real-world ribbon (e.g. gift-wrap bow, hair accessory) across the whole book if it fits naturally.';

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
  sections.push('- **Use instead:** tactile non-ribbon tokens (carousel cog, lantern plate screw, prism wedge, lighthouse wick cap, tide-gauge knob, scallop-shell pass, brass gate token, net float that is **not** a ribbon).');
  sections.push('- **At most one** mundane ribbon beat in the entire book if natural (real gift bow, hair ribbon on cover) — not the engine of the quest.');
}

module.exports = {
  briefMentionsRibbon,
  plannerRibbonBriefOptIn,
  STORY_PLANNER_RIBBON_BIAS_LINE,
  appendParentGiftRibbonMotifGuards,
};
