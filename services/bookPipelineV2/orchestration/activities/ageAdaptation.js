/**
 * Stage 2 — Age Adaptation
 *
 * Loads the band's default `AgeProfile` and may apply micro-tweaks
 * derived from the personalization brief (e.g. lower the conflict cap
 * if `comfort_patterns: high`). For tonight we apply a small set of
 * deterministic tweaks; the LLM-tuned version is a follow-up.
 */

const { getAgeProfile } = require('../../ageProfiles');

function ageAdaptationActivity(input, ctx) {
  const { ageBand, brief } = input;
  const profile = getAgeProfile(ageBand);

  const inferred = brief?.inferred || {};
  const directives = brief?.structural_directives || {};

  // Conservative safety tweaks.
  if (inferred.emotional_safety_level === 'high' && profile.narrativeConstraints) {
    profile.narrativeConstraints.conflictIntensityMax = Math.min(
      profile.narrativeConstraints.conflictIntensityMax || 0,
      0.1,
    );
  }
  if (Array.isArray(directives.banned_arc_shapes) && directives.banned_arc_shapes.includes('scary peak')) {
    profile.illustrationConstraints = profile.illustrationConstraints || {};
    profile.illustrationConstraints.noScaryImagery = true;
  }

  profile._adapted_at = new Date().toISOString();
  profile._adaptation_notes = [];
  if (inferred.emotional_safety_level === 'high') {
    profile._adaptation_notes.push('lowered conflictIntensityMax due to high emotional_safety_level');
  }
  ctx.log('info', `[v2] ageAdaptation: ${ageBand} adapted; ${profile._adaptation_notes.length} tweaks applied`);
  return profile;
}

module.exports = { ageAdaptationActivity };
