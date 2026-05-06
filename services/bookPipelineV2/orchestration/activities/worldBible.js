/**
 * Stage 6 — World Bible
 *
 * Locks the visual world: palette, environment anchors, recurring
 * motifs, props, supporting cast partial-presence locks, and the
 * cover-anchored style rules. This is what the illustration director
 * reads later — never the raw beats.
 *
 * The cover image URL is the hard anchor when present; the bible MUST
 * NOT contradict the cover. (Mirrors v1's createVisualBible contract,
 * which the AA-CW work shipped.)
 */

const { callWithRole } = require('../../llm/modelRouter');

const SYSTEM = `You are the art director for a premium personalized children's picture book. Produce a WorldBible JSON. Lock: palette { primaries[], accents[], lighting }, style_rules[] (premium 3D character-driven, warm cinematic light, materials with weight; one focal action per spread), environment_anchors[] (each: id, label, defining_surfaces[], defining_props[]), recurring_motifs[] (each: id, label, where_it_appears[]), recurring_props[] (each: id, name, locked_description with color+pattern+material+size_relative_to_hero, appears_in_spreads[]), supporting_cast[] (each: id, role, on_cover boolean, partial_presence_lock { skin_tone, hand_or_arm, sleeve_or_outfit_fragment, signature_item }), text_placement_policy { default_side, never_cross_center: true }, cover_anchor_rules[] (do/do-not list explicitly bound to the cover image), prohibited_visual_drift[]. The world must feel like ONE journey across varied photogenic places. Off-cover characters are never drawn full face/body. Output STRICT JSON only.`;

async function worldBibleActivity(input, ctx) {
  const { rawRequest, intent, ageProfile, characterBible, coverImageUrl } = input;
  const userPrompt = JSON.stringify({
    instructions: 'Produce the WorldBible. Read the cover image as the hard anchor for hero appearance and palette. Encode partial-presence rules for any implied caregiver from the intent.',
    coverImageUrl: coverImageUrl || null,
    coverTitle: rawRequest?.cover?.title || null,
    intent,
    ageProfile,
    characterBible,
  });
  const resp = await callWithRole('PLANNER', {
    systemPrompt: SYSTEM,
    userPrompt,
    jsonMode: true,
    temperature: 0.4,
    maxTokens: 4500,
    label: 'v2.worldBible',
  });
  const bible = resp.json;
  if (!bible || typeof bible !== 'object') throw new Error('worldBible: empty/invalid JSON');
  bible.version = '1.0';
  bible.generated_at = new Date().toISOString();
  bible.model = resp.model;
  ctx.log('info', `[v2] worldBible locked (${(bible.environment_anchors || []).length} environments, ${(bible.recurring_props || []).length} recurring props)`);
  return bible;
}

module.exports = { worldBibleActivity };
