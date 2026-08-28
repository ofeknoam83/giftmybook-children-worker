/**
 * Deterministic story-response validation — the V1.3 runtime contract's
 * ordered sequence, no second model involved:
 *
 *   1. schema validation (writer-runtime.schema.json response def)
 *   2. identity/version echo
 *   3. exactly 12 spreads numbered once each in order
 *   4. title equality with the backend-rendered title
 *   5. book-definition checks (refrain exact/placement, child name present)
 *   6. age-engine deterministic word bounds (exact-age calibrated for 1–3)
 *   7. personalization evidence vs profile and map
 *   8. callback-before-introduction + detail/moment caps
 *   9. forbidden terms (brands/IP) + optional-detail leakage
 *
 * Returns every error found (the retry feeds them all back to the model).
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv/dist/2020');
const { matchKey, usableDetails } = require('./profile');
const { checkAgeBounds } = require('./ageBounds');
const { INTRO_CAPABLE_TYPES } = require('./augments');

const RUNTIME_SCHEMA_PATH = path.join(__dirname, 'data', 'schemas', 'writer-runtime.schema.json');
const BANNED_BRANDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'bannedBrands.json'), 'utf8')).terms;

const CALLBACK_TYPES = new Set(['object_callback', 'closing_callback']);

let _validateResponse = null;

function responseValidator() {
  if (_validateResponse) return _validateResponse;
  const ajv = new Ajv({ allErrors: true, strict: false });
  const runtimeSchema = JSON.parse(fs.readFileSync(RUNTIME_SCHEMA_PATH, 'utf8'));
  // Validate the response payload object directly (the wire wrapper with
  // {type, payload} is an internal transport detail we don't use).
  ajv.addSchema(runtimeSchema, 'runtime');
  _validateResponse = ajv.compile({ $ref: 'runtime#/$defs/response' });
  return _validateResponse;
}

/** Whole-word, case/diacritic-insensitive presence of `needle` in `haystack`. */
function containsTerm(haystack, needle) {
  const h = ` ${matchKey(haystack).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const n = ` ${matchKey(needle).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return n.trim().length > 0 && h.includes(n);
}

/**
 * Validate the story text + evidence of a response.
 *
 * @param {object} params
 * @param {object} params.response parsed writer response payload
 * @param {object} params.request the pinned request {request_id, book_id, rendered_title, age_band(wire), profile, versions}
 * @param {object} params.book catalog book definition
 * @param {string} params.ageBand catalog band key ('1-3' etc.)
 * @param {object|null} params.map approved personalization map (null = name-only mode)
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateStoryResponse({ response, request, book, ageBand, map }) {
  const errors = [];

  // 1. Schema
  const validate = responseValidator();
  if (!validate(response)) {
    for (const err of (validate.errors || []).slice(0, 12)) {
      errors.push(`schema: ${err.instancePath || '/'} ${err.message}`);
    }
    return { ok: false, errors }; // structure is broken; later checks would be noise
  }

  // 2. Identity echo
  if (response.request_id !== request.request_id) errors.push(`request_id mismatch: '${response.request_id}'`);
  if (response.book_id !== request.book_id) errors.push(`book_id mismatch: '${response.book_id}'`);
  for (const [k, v] of Object.entries(request.versions)) {
    if (response.versions?.[k] !== v) errors.push(`versions.${k} must echo '${v}'`);
  }

  // 3. Spread numbering
  const numbers = response.spreads.map(s => s.spread);
  if (JSON.stringify(numbers) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])) {
    errors.push(`spreads must be numbered 1-12 in order (got ${numbers.join(',')})`);
  }

  // 4. Title equality
  if (response.title !== request.rendered_title) {
    errors.push(`title must exactly equal the rendered title '${request.rendered_title}'`);
  }

  const fullText = response.spreads.map(s => s.text).join('\n');

  // 5. Book-definition checks: refrain + child name
  if (book.refrain?.text) {
    const required = new Set(book.refrain.spreads);
    for (const s of response.spreads) {
      const has = s.text.includes(book.refrain.text);
      if (required.has(s.spread) && !has) {
        errors.push(`spread ${s.spread}: must contain the exact refrain "${book.refrain.text}"`);
      }
      if (!required.has(s.spread) && has) {
        errors.push(`spread ${s.spread}: refrain must appear ONLY on spreads ${[...required].join(',')}`);
      }
    }
  }
  const profile = request.profile;
  if (!fullText.includes(profile.name)) {
    errors.push(`the child's name '${profile.name}' (exact spelling) must appear in the story`);
  }

  // 6. Age bounds
  errors.push(...checkAgeBounds(response.spreads, ageBand, profile.age));

  // 7-8. Personalization evidence
  errors.push(...validateEvidence({ response, profile, map }));

  // 9. Forbidden terms + leakage. A banned term that is (a word of) the
  // child's own supplied name is exempt — the name is REQUIRED in the text,
  // so "Elsa"/"Mario"/"Woody" as the hero is the child, not the franchise.
  const nameWords = new Set(matchKey(profile.name).split(' '));
  for (const term of BANNED_BRANDS) {
    if (nameWords.has(matchKey(term))) continue;
    if (containsTerm(fullText, term)) errors.push(`banned brand/IP term in story text: "${term}"`);
  }
  errors.push(...checkLeakage({ response, profile, fullText }));

  return { ok: errors.length === 0, errors };
}

/**
 * Steps 7–8: every evidence record traces to supplied data and an approved
 * slot; caps and callback ordering hold. In name-only mode (no map) the
 * evidence must be empty.
 * @returns {string[]} errors
 */
function validateEvidence({ response, profile, map }) {
  const errors = [];
  const evidence = response.personalization_evidence || [];

  if (!map) {
    if (evidence.length > 0) {
      errors.push('no approved personalization map: personalization_evidence must be empty (name-only mode)');
    }
    return errors;
  }

  const details = usableDetails(profile);
  const detailKeys = new Map(); // `${field}|${key}` -> detail
  for (const d of details) detailKeys.set(`${d.field}|${d.key}`, d);

  const slotsById = new Map(map.slots.map(s => [s.slot_id, s]));
  const slotUses = new Map();
  const perDetailUses = new Map();
  const introducedDetails = new Set(); // details with an intro-capable moment, by spread order
  const sorted = [...evidence].sort((a, b) => a.spread - b.spread);

  for (const ev of sorted) {
    const key = `${ev.source_field}|${matchKey(ev.source_value)}`;
    // Trace to supplied data: the value must match a normalized profile value.
    const supplied = detailKeys.get(key);
    if (!supplied) {
      errors.push(`evidence: '${ev.source_value}' is not a supplied ${ev.source_field} value`);
      continue;
    }
    const slot = slotsById.get(ev.slot_id);
    if (!slot) { errors.push(`evidence: unknown slot_id '${ev.slot_id}'`); continue; }
    if (slot.spread !== ev.spread) errors.push(`evidence: slot ${ev.slot_id} is spread ${slot.spread}, not ${ev.spread}`);
    if (!slot.allowed_moment_types.includes(ev.moment_type)) {
      errors.push(`evidence: slot ${ev.slot_id} does not allow moment type '${ev.moment_type}'`);
    }
    if (!slot.allowed_profile_fields.includes(ev.source_field)) {
      errors.push(`evidence: slot ${ev.slot_id} does not allow profile field '${ev.source_field}'`);
    }
    slotUses.set(ev.slot_id, (slotUses.get(ev.slot_id) || 0) + 1);
    if (slotUses.get(ev.slot_id) > slot.max_uses) {
      errors.push(`evidence: slot ${ev.slot_id} used ${slotUses.get(ev.slot_id)}x, max ${slot.max_uses}`);
    }
    if (CALLBACK_TYPES.has(ev.moment_type) || slot.requires_prior_detail_use) {
      if (!introducedDetails.has(key)) {
        errors.push(`evidence: '${ev.source_value}' used as callback on spread ${ev.spread} without an earlier introduction`);
      }
    }
    if (INTRO_CAPABLE_TYPES.has(ev.moment_type)) introducedDetails.add(key);
    const va = slot.visual_alignment || { mode: 'none' };
    if (va.mode === 'required_if_used') {
      if (ev.visual_required !== true) errors.push(`evidence: slot ${ev.slot_id} requires visual_required=true`);
      if (ev.visual_slot_id !== va.visual_slot_id) {
        errors.push(`evidence: slot ${ev.slot_id} must carry visual_slot_id '${va.visual_slot_id}'`);
      }
    }
    if (va.mode === 'none' && ev.visual_required === true) {
      errors.push(`evidence: slot ${ev.slot_id} has no visual alignment but visual_required=true`);
    }
    perDetailUses.set(key, (perDetailUses.get(key) || 0) + 1);
  }

  // Caps: moments = evidence records; details = unique (field, value) pairs.
  const momentCount = sorted.length;
  const detailCount = perDetailUses.size;
  if (momentCount > map.targets.max_moments) {
    errors.push(`moment_count ${momentCount} exceeds map max_moments ${map.targets.max_moments}`);
  }
  if (detailCount > map.targets.max_details) {
    errors.push(`selected_detail_count ${detailCount} exceeds map max_details ${map.targets.max_details}`);
  }
  const repeatLimit = map.detail_repeat_limit || 3;
  for (const [key, uses] of perDetailUses.entries()) {
    if (uses > repeatLimit) errors.push(`detail '${key.split('|')[1]}' used ${uses}x, repeat limit ${repeatLimit}`);
  }

  // Minima (runtime contract): falling below the map targets is allowed only
  // for sparse input, no eligible pair, or editorial omission — WITH the
  // reason recorded. So when a rich profile lands under the minima, every
  // supplied-but-unused field must appear in omitted_profile_fields.
  const belowMinima = momentCount < map.targets.min_moments || detailCount < map.targets.min_details;
  if (belowMinima && details.length > 0) {
    const usedFields = new Set(sorted.map(ev => ev.source_field));
    const omittedFields = new Set((response.omitted_profile_fields || []).map(o => o.source_field));
    const unaccounted = [...new Set(details.map(d => d.field))]
      .filter(f => !usedFields.has(f) && !omittedFields.has(f));
    if (unaccounted.length > 0) {
      errors.push(`below the map minimum (${momentCount}/${map.targets.min_moments} moments, ${detailCount}/${map.targets.min_details} details) without a recorded omission reason for supplied field(s): ${unaccounted.join(', ')} — personalize them via approved slots or justify each in omitted_profile_fields`);
    }
  }
  return errors;
}

/**
 * Step 9b: supplied optional values that were NOT used as evidence must not
 * appear in the story text (normalized whole-word match). Values shorter
 * than 4 characters are skipped — too collision-prone to be meaningful.
 * @returns {string[]} errors
 */
function checkLeakage({ response, profile, fullText }) {
  const errors = [];
  const evidenceKeys = new Set(
    (response.personalization_evidence || []).map(ev => `${ev.source_field}|${matchKey(ev.source_value)}`),
  );
  for (const d of usableDetails(profile)) {
    if (evidenceKeys.has(`${d.field}|${d.key}`)) continue;
    if (d.key.length < 4) continue;
    if (containsTerm(fullText, d.value)) {
      errors.push(`'${d.value}' (${d.field}) appears in the story text but is not declared in personalization_evidence — either declare it via an approved slot or remove it`);
    }
  }
  return errors;
}

module.exports = { validateStoryResponse, validateEvidence, checkLeakage, containsTerm, BANNED_BRANDS };
