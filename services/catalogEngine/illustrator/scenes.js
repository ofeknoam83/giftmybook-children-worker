/**
 * Deterministic scene prompts for the slim illustrator.
 *
 * The catalog's fixed beat IS the scene: no art director, no concept pass.
 * Each spread's prompt combines the beat, the theme's fixed world +
 * companion, the child (single instance, identity from the approved-cover
 * reference image), and any approved visual personalization slots declared
 * in the story's evidence. Style/medium language is owned by the renderer
 * (`illustrationGenerator`'s canonical premium-3D config) — this module
 * only describes WHAT is in the scene, never the medium.
 */

/**
 * Visual personalization props for one spread, from validated evidence.
 * Only evidence with visual_required=true reaches pixels (D5-adjacent rule:
 * the map's visual_alignment gate decides, never free text).
 * @param {object[]} evidence personalization_evidence records
 * @param {number} spread
 * @returns {string[]} prop descriptions
 */
function visualPropsForSpread(evidence, spread) {
  return (evidence || [])
    .filter(ev => ev.spread === spread && ev.visual_required === true)
    .map(ev => ev.source_value);
}

/**
 * Whether the companion plausibly appears on this spread — the beat text
 * naming them is the only deterministic signal we trust.
 * @param {object} beat
 * @param {object} companion {name, type}
 * @returns {boolean}
 */
function beatMentionsCompanion(beat, companion) {
  if (!companion?.name) return false;
  return beat.beat.toLowerCase().includes(companion.name.toLowerCase());
}

/**
 * Build the scene description for one spread.
 * @param {object} params
 * @param {object} params.book catalog book definition
 * @param {object} params.theme catalog theme ({display_name, world_name, companion})
 * @param {number} params.spread 1-12
 * @param {string} params.spreadText the manuscript text (context only — never painted)
 * @param {object} params.profile normalized child profile
 * @param {object[]} [params.evidence] validated personalization evidence
 * @returns {string}
 */
function buildScenePrompt({ book, theme, spread, spreadText, profile, evidence }) {
  const beat = book.beats.find(b => b.spread === spread);
  if (!beat) throw new Error(`buildScenePrompt: book ${book.id} has no beat for spread ${spread}`);

  const lines = [];
  lines.push(`Scene ${spread} of 12 in "${theme.display_name}" world "${theme.world_name}".`);
  lines.push(`ACTION (paint exactly this moment): ${beat.beat}`);
  lines.push(`The child ${profile.name} (age ${profile.age}) is the active protagonist — exactly ONE instance of ${profile.name} in the scene, matching the reference character's face, hair, and outfit.`);
  if (beatMentionsCompanion(beat, theme.companion)) {
    lines.push(`Companion present: ${theme.companion.name}, a ${theme.companion.type} — friendly and warm, secondary to the child.`);
  }
  if (spreadText) {
    lines.push(`Story context (for mood/props only — NEVER paint these words): ${spreadText}`);
  }
  const props = visualPropsForSpread(evidence, spread);
  for (const prop of props) {
    lines.push(`Include naturally near the child (small, decorative, never plot-critical): ${prop}.`);
  }
  lines.push('Setting, era, and weather stay consistent with the fixed world across all 12 scenes.');
  return lines.join('\n');
}

module.exports = { buildScenePrompt, visualPropsForSpread, beatMentionsCompanion };
