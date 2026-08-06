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

// Embedded-layout caption budget (2026-07-28 audit, book 4c8daf08): in
// embedded mode the caption is typeset OVER the art, and the band budget
// that suits a white caption page smothers a painting — 55-75-word captions
// forced scrim boxes across 30-45% of every spread. Cap what the writer may
// spend when the words share the page with the picture.
const EMBEDDED_MAX_WORDS_PER_SPREAD = 50;
const EMBEDDED_TARGET_WORDS_PER_SPREAD = 40;

/**
 * Clamp a profile's words-per-spread budget for the embedded text layout.
 * Mutates the given profile clone in place (getAgeProfile returns a deep
 * clone) and returns it; a no-op for caption layout or bands already under
 * the cap. Called once at workflow start so the writer prompt, the
 * mechanical gate, and every downstream consumer see the same numbers.
 *
 * @param {object} profile - deep-cloned age profile
 * @param {string} textLayout - 'caption' | 'embedded'
 * @returns {object} the same profile
 */
function applyEmbeddedLayoutBudget(profile, textLayout) {
  if (textLayout !== 'embedded') return profile;
  const wps = profile?.narrativeConstraints?.wordsPerSpread;
  if (!wps) return profile;
  wps.max = Math.min(wps.max, EMBEDDED_MAX_WORDS_PER_SPREAD);
  wps.target = Math.min(wps.target, EMBEDDED_TARGET_WORDS_PER_SPREAD);
  wps.min = Math.min(wps.min, wps.max); // keep the window well-formed for low caps
  return profile;
}

/**
 * Narrative tense for a book (2026-08-02 customer feedback: "the story
 * should be in the past tense"). Past tense is the classic storybook
 * register and what the story-format openers already imply ("Once upon a
 * time…", "It started like any normal day…"); the two pre-verbal lap-baby
 * bands stay present tense ("Baby claps" — happening NOW is the point at
 * that age, and the pastTense gate check machine-enforces it).
 *
 * Resolution: BOOK_PIPELINE_V3_NARRATIVE_TENSE env (ops flip, loud-warn on
 * unknown values) → profile narrativeConstraints.narrativeTense → band
 * fallback (INFANT/TODDLER present, everything else past).
 *
 * @param {object} ageProfile
 * @returns {'past'|'present'}
 */
function narrativeTenseFor(ageProfile) {
  const env = String(process.env.BOOK_PIPELINE_V3_NARRATIVE_TENSE || '').trim().toLowerCase();
  if (env === 'past' || env === 'present') return env;
  if (env) {
    console.warn(`[bookPipelineV3] BOOK_PIPELINE_V3_NARRATIVE_TENSE='${env}' is not 'past'|'present' — ignored`);
  }
  const declared = String(ageProfile?.narrativeConstraints?.narrativeTense || '').toLowerCase();
  if (declared === 'past' || declared === 'present') return declared;
  const band = ageProfile?.ageBand || ageProfile?.band;
  return (band === 'PB_INFANT' || band === 'PB_TODDLER') ? 'present' : 'past';
}

function isPictureBookBand(ageBand) {
  return Object.prototype.hasOwnProperty.call(PROFILES, ageBand);
}

/**
 * Map a child's age in months (or years if months unavailable) to a
 * picture-book age band. The band split at 60 months is a product decision
 * (2026-08-06): ages 1-4 get the no-antagonist/small-budget bands, ages 5-8
 * get the full picture-book budget with a mild antagonist allowed. Ages
 * above 8 exceed the product ceiling (picture books only, ages 1-8) and
 * clamp LOUDLY onto the oldest band.
 */
function deriveAgeBandFromAge({ ageMonths, ageYears }) {
  let months = ageMonths;
  if (months == null && ageYears != null) months = Math.round(ageYears * 12);
  if (months == null) return 'PB_PRESCHOOL';
  if (months < 18) return 'PB_INFANT';
  if (months <= 36) return 'PB_TODDLER';
  if (months < 60) return 'PB_PRESCHOOL';
  if (months <= 96) return 'PB_EARLY_READER';
  console.warn(`[bookPipelineV3] age ${months}mo exceeds the 8-year product ceiling (picture books only) — clamping to PB_EARLY_READER`);
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
  narrativeTenseFor,
  deriveAgeBandFromAge,
  deriveAgeBandFromRequest,
  applyEmbeddedLayoutBudget,
  EMBEDDED_MAX_WORDS_PER_SPREAD,
  EMBEDDED_TARGET_WORDS_PER_SPREAD,
  PROFILES,
};
