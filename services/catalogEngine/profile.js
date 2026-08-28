/**
 * Deterministic child-profile normalization (no LLM, per the V1.3 runtime
 * contract): Unicode NFC, whitespace collapse, empty-to-null, list
 * de-duplication, length limits, control-character rejection. Every string
 * is data, never an instruction; nothing missing is ever inferred.
 */

const OPTIONAL_STRING_FIELDS = ['object', 'food', 'place', 'habit', 'trait'];
const OPTIONAL_LIST_FIELDS = ['interests', 'activities'];
const LENGTH_LIMITS = {
  name: 60, object: 100, food: 100, place: 120, habit: 180, trait: 80,
  interests: 100, activities: 100, pronoun: 30,
};
const MAX_LIST_ITEMS = 5;

/** Matches C0/C1 control characters (tab/newline included — profile values are single-line). */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

class ProfileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProfileError';
    this.statusCode = 400;
  }
}

/**
 * Normalize one string value; returns null for empty.
 * @param {*} value
 * @param {string} field
 * @param {number} maxLen
 * @returns {string|null}
 */
function cleanString(value, field, maxLen) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new ProfileError(`profile.${field} must be a string`);
  if (CONTROL_CHARS.test(value)) throw new ProfileError(`profile.${field} contains control characters`);
  const cleaned = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (cleaned === '') return null;
  if (cleaned.length > maxLen) throw new ProfileError(`profile.${field} exceeds ${maxLen} characters`);
  return cleaned;
}

/**
 * Case/diacritic-insensitive canonical form used for matching (tag matching,
 * evidence tracing, leakage checks) — never for display.
 * @param {string} s
 * @returns {string}
 */
function matchKey(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a raw profile from the main app.
 * @param {object} raw {name, age, pronouns:{subject,object,possessive_adjective}, object?, interests?, activities?, food?, place?, habit?, trait?}
 * @returns {object} normalized profile (same shape, cleaned)
 */
function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') throw new ProfileError('profile is required');
  const name = cleanString(raw.name, 'name', LENGTH_LIMITS.name);
  if (!name) throw new ProfileError('profile.name is required');
  const age = Number(raw.age);
  if (!Number.isInteger(age) || age < 1 || age > 10) throw new ProfileError('profile.age must be an integer 1-10');

  const p = raw.pronouns || {};
  const pronouns = {
    subject: cleanString(p.subject, 'pronouns.subject', LENGTH_LIMITS.pronoun),
    object: cleanString(p.object, 'pronouns.object', LENGTH_LIMITS.pronoun),
    possessive_adjective: cleanString(p.possessive_adjective || p.possessive, 'pronouns.possessive_adjective', LENGTH_LIMITS.pronoun),
  };
  if (!pronouns.subject || !pronouns.object || !pronouns.possessive_adjective) {
    throw new ProfileError('profile.pronouns requires subject, object, possessive_adjective');
  }

  const profile = { name, age, pronouns };
  for (const field of OPTIONAL_STRING_FIELDS) {
    profile[field] = cleanString(raw[field], field, LENGTH_LIMITS[field]);
  }
  for (const field of OPTIONAL_LIST_FIELDS) {
    const list = raw[field];
    if (list === null || list === undefined) { profile[field] = []; continue; }
    if (!Array.isArray(list)) throw new ProfileError(`profile.${field} must be an array`);
    const cleaned = [];
    const seen = new Set();
    for (const item of list) {
      const c = cleanString(item, field, LENGTH_LIMITS[field]);
      if (!c) continue;
      const key = matchKey(c);
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(c);
      if (cleaned.length >= MAX_LIST_ITEMS) break;
    }
    profile[field] = cleaned;
  }
  return profile;
}

/**
 * The distinct usable optional details of a normalized profile, in stable
 * input order — the unit the selection thresholds and the writer's
 * "2–4 details" rule count.
 * @param {object} profile normalized
 * @returns {Array<{field: string, value: string, key: string}>}
 */
function usableDetails(profile) {
  const details = [];
  for (const field of OPTIONAL_STRING_FIELDS) {
    if (profile[field]) details.push({ field, value: profile[field], key: matchKey(profile[field]) });
  }
  for (const field of OPTIONAL_LIST_FIELDS) {
    for (const value of profile[field]) details.push({ field, value, key: matchKey(value) });
  }
  return details;
}

module.exports = {
  normalizeProfile,
  usableDetails,
  matchKey,
  ProfileError,
  OPTIONAL_STRING_FIELDS,
  OPTIONAL_LIST_FIELDS,
};
