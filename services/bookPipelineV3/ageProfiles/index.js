/**
 * Age profile loader. Bands map to declarative JSON constraints. The
 * Age Adaptation activity (Stage 2) is allowed to micro-tune values
 * before persisting an `AgeProfile` artifact, but the JSON files here
 * are the canonical defaults.
 */

const PB_INFANT = require('./PB_INFANT.json');
const PB_TODDLER = require('./PB_TODDLER.json');
const PB_PRESCHOOL = require('./PB_PRESCHOOL.json');
const PB_EARLY_READER = require('./PB_EARLY_READER.json');

const PROFILES = {
  PB_INFANT,
  PB_TODDLER,
  PB_PRESCHOOL,
  PB_EARLY_READER,
};

function getAgeProfile(ageBand) {
  const p = PROFILES[ageBand];
  if (!p) throw new Error(`unknown age band: ${ageBand}`);
  return JSON.parse(JSON.stringify(p)); // defensive deep clone
}

function listAgeBands() {
  return Object.keys(PROFILES);
}

function isPictureBookBand(ageBand) {
  return Object.prototype.hasOwnProperty.call(PROFILES, ageBand);
}

/**
 * Map a child's age in months (or years if months unavailable) to a
 * picture-book age band. Mirrors v1's normalizeRequest.js logic so the
 * cutover doesn't shift any child between bands.
 */
function deriveAgeBandFromAge({ ageMonths, ageYears }) {
  let months = ageMonths;
  if (months == null && ageYears != null) months = Math.round(ageYears * 12);
  if (months == null) return 'PB_PRESCHOOL';
  if (months < 18) return 'PB_INFANT';
  if (months <= 36) return 'PB_TODDLER';
  if (months <= 72) return 'PB_PRESCHOOL';
  return 'PB_EARLY_READER';
}

/**
 * Derive the age band straight from a raw generate-book request.
 * Use nullish-aware number picking instead of `||` because age=0 is a real,
 * valid value (a 0-month-old is a lap baby and must resolve to PB_INFANT).
 * The previous `child.age || child.ageYears || null` chain treated 0 as
 * falsy and fell through to the default PB_PRESCHOOL — observed in
 * production on book e3f4e0c0 (mothers_day, birthDate-derived age=0).
 */
function deriveAgeBandFromRequest(rawRequest) {
  const child = rawRequest?.child || {};
  const pickNumber = (...vals) => {
    for (const v of vals) {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
  };
  const ageMonths = pickNumber(child.ageMonths, child.age_months);
  const ageYears = pickNumber(child.age, child.ageYears);
  return deriveAgeBandFromAge({ ageMonths, ageYears });
}

module.exports = {
  getAgeProfile,
  listAgeBands,
  isPictureBookBand,
  deriveAgeBandFromAge,
  deriveAgeBandFromRequest,
  PROFILES,
};
