/**
 * Likeness brief (A0 step 1) — vision analysis of the child's photos
 * producing an illustrator-grade appearance description.
 *
 * Keeps faceEngine's skin-tone-precision emphasis (that instinct is
 * correct — skin-tone drift is the most sensitive failure in the whole
 * system) and adds age-correct body proportions per band, because "6 y/o
 * proportions on a 2 y/o" is a recurring likeness defect class.
 */

const { callVisionRole } = require('../../llm/visionClient');

/** Head-to-body guidance per picture-book age band. */
const PROPORTIONS_BY_BAND = {
  PB_INFANT: 'infant/lap-baby proportions: head ≈ 1/3 of total height, very short limbs, rounded torso, minimal neck',
  PB_TODDLER: 'toddler proportions: head ≈ 1/4 of total height, short limbs, round belly, unsteady stance',
  PB_PRESCHOOL: 'preschooler proportions: head ≈ 1/5 of total height, limbs lengthening, still soft/rounded features',
  PB_EARLY_READER: 'young child proportions: head ≈ 1/6 of total height, leaner limbs, more defined posture',
};

const BRIEF_PROMPT = `You are a character designer preparing an illustrator-grade likeness brief from a child's photo(s).
Describe EXACTLY what you see — precision here decides whether the printed book looks like this child.

Return STRICT JSON:
{
  "skinTone": "precise, respectful description (undertone + depth, e.g. 'warm medium-brown with golden undertones') — NEVER vague words like 'normal'",
  "hairColor": "...",
  "hairStyle": "cut, length, texture, parting, any accessories",
  "eyeColor": "...",
  "faceShape": "...",
  "distinguishingFeatures": ["ranked, most recognizable first — e.g. dimples, freckle placement, gap teeth, glasses, birthmarks"],
  "expressionNotes": "the child's characteristic expression/energy visible in the photos"
}

Rules:
- Only physical appearance. No name, age guesses, clothing, or background.
- If multiple photos disagree (lighting/age), describe the consensus and note the conflict in expressionNotes.
- Skin tone precision is non-negotiable: undertone AND depth, in plain respectful language.`;

/**
 * @param {object} opts
 * @param {Array<{base64: string, mimeType?: string}>} opts.photos - decoded child photos
 * @param {string} opts.ageBand - PB_* band
 * @param {object} [opts.childDetails] - { name, gender } for the composed text (never sent to the model)
 * @param {boolean} [opts.hasCover] - an approved cover exists: proportions/age defer to the
 *   cover character instead of the band note (the band push-down aged characters down vs
 *   the parent-approved art — 2026-07-15 exhaustion)
 * @param {string} [opts.label]
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{ fields: object, proportionsNote: string, briefText: string, model: string }>}
 */
async function buildLikenessBrief({ photos, ageBand, childDetails = {}, hasCover = false, label = 'v3.identitykit.brief', abortSignal }) {
  if (!photos || photos.length === 0) throw new Error('buildLikenessBrief: at least one photo is required');

  const { json: fields, model } = await callVisionRole('QA_VISION', {
    prompt: BRIEF_PROMPT,
    images: photos,
    label,
    expectJson: true,
    abortSignal,
  });

  const proportionsNote = hasCover
    ? 'match the approved cover character\'s apparent age, build, and head-to-body proportions EXACTLY — the cover is the ground truth, not a generic age chart'
    : (PROPORTIONS_BY_BAND[ageBand] || PROPORTIONS_BY_BAND.PB_PRESCHOOL);
  const pronoun = childDetails.gender === 'male' ? 'He' : childDetails.gender === 'female' ? 'She' : 'They';

  const briefText = [
    `CHILD LIKENESS BRIEF${childDetails.name ? ` for ${childDetails.name}` : ''}:`,
    `- Skin tone: ${fields.skinTone}`,
    `- Hair: ${fields.hairColor}, ${fields.hairStyle}`,
    `- Eyes: ${fields.eyeColor}`,
    `- Face: ${fields.faceShape}`,
    fields.distinguishingFeatures?.length
      ? `- Most recognizable features (preserve ALL): ${fields.distinguishingFeatures.join('; ')}`
      : null,
    fields.expressionNotes ? `- Characteristic expression: ${fields.expressionNotes}` : null,
    `- Body proportions and apparent age: ${proportionsNote}`,
    hasCover
      ? `${pronoun} must be recognizable as the character on this book's APPROVED COVER in every image — where this description and the cover disagree, the cover wins.`
      : `${pronoun} must be recognizable as THIS child in every image — skin tone, hair, and the listed features are locked and may never drift.`,
  ].filter(Boolean).join('\n');

  return { fields, proportionsNote, briefText, model };
}

module.exports = { buildLikenessBrief, PROPORTIONS_BY_BAND, BRIEF_PROMPT };
