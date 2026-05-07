/**
 * Stage 5 — Character Bible
 *
 * Produces a CharacterBible per named character. For tonight's vertical
 * slice we generate the protagonist's bible from the personalization
 * brief + age profile + story intent + (when available) the approved
 * cover image URL. The cover-derived branch is the v2 contract; when
 * the cover is not yet rendered (rare in production — server.js has the
 * cover before calling generateBook), we fall back to text-only.
 */

const { callWithRole } = require('../../llm/modelRouter');

const SYSTEM = `You are a character-bible author for a children's picture book. Produce a CharacterBible JSON for the protagonist (and any other named characters). Lock: name, role, age_months, age_band, ethnicity_descriptor, skin_tone_family, hair { color_family, length, texture, volume, signature_styling }, eyes { color, shape }, face { cheek_quality, mouth }, body { head_to_body_ratio, developmental_stage, can_stand_independently, rendered_teeth, limb_quality }, signature_outfit { top, bottom, accessories }, signature_prop, personality, speaking_style, visual_rules (array), anti_rules (array), derived_from_cover_image (URL or null). For PB_INFANT, body MUST reflect a lap baby (1:3 head-to-body, no rendered teeth, cannot stand independently, soft rounded limbs). For PB_TODDLER, age-appropriate toddler proportions. visual_rules and anti_rules are explicit do/do-not lists the illustrator will read. Output STRICT JSON only — an object with key 'characters' that is an array.`;

async function characterBibleActivity(input, ctx) {
  const { rawRequest, brief, ageProfile, intent, coverImageUrl } = input;
  const userPrompt = JSON.stringify({
    instructions: 'Produce CharacterBible objects (one per named character). Protagonist first.',
    child: rawRequest?.child || {},
    coverImageUrl: coverImageUrl || null,
    brief,
    ageProfile,
    intent,
  });
  const resp = await callWithRole('PLANNER', {
    systemPrompt: SYSTEM,
    userPrompt,
    jsonMode: true,
    temperature: 0.35,
    maxTokens: 3500,
    label: 'v2.characterBible',
  });
  // Accept several shapes the model may emit:
  //   { characters: [...] }    (canonical)
  //   [ ...character objs ]    (bare array)
  //   { protagonist: {...}, supporting: [...] }   (common synonym)
  //   { protagonist: {...} }   (single-character)
  //   single character object  (no wrapping)
  let out = resp.json;
  let characters = null;
  if (Array.isArray(out)) {
    characters = out;
    out = {};
  } else if (out && typeof out === 'object') {
    if (Array.isArray(out.characters)) {
      characters = out.characters;
    } else if (Array.isArray(out.cast)) {
      characters = out.cast;
    } else if (out.protagonist && typeof out.protagonist === 'object') {
      characters = [out.protagonist].concat(
        Array.isArray(out.supporting) ? out.supporting :
        Array.isArray(out.others) ? out.others : []
      );
    } else if (out.name && (out.role || out.signature_outfit || out.hair)) {
      // The whole object looks like a single character.
      characters = [out];
      out = {};
    }
  }
  if (!characters || !characters.length) {
    const keys = out && typeof out === 'object' ? Object.keys(out).join(',') : typeof out;
    throw new Error(`characterBible: model did not return any characters (top-level keys: ${keys})`);
  }
  out.characters = characters.filter(c => c && typeof c === 'object');
  out.version = '1.0';
  out.generated_at = new Date().toISOString();
  out.model = resp.model;
  ctx.log('info', `[v2] characterBible: ${out.characters.length} characters locked`);
  return out;
}

module.exports = { characterBibleActivity };
