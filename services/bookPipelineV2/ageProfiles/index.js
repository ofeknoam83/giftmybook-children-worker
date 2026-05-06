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

module.exports = {
  getAgeProfile,
  listAgeBands,
  isPictureBookBand,
  deriveAgeBandFromAge,
  PROFILES,
};
