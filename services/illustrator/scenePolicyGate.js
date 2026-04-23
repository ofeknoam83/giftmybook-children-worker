/**
 * Pre-illustration scene gate — align spread_image_prompt with family / cast policy
 * so Gemini is not asked for compositions vision QA will reject.
 */

const { PARENT_THEMES } = require('./config');

const IMPLIED_PARENT_STAGING = `

[Illustration staging — REQUIRED] Themed parent/caregiver: IMPLIED PRESENCE ONLY — hands, forearms, stroller push-bar, back-of-head, shoulder silhouette, or cropped torso with face hidden or turned away. NO full-face adult. NO full-body standing/walking adult portrait beside the child. The hero child must match the BOOK COVER likeness, skin tone, hair, and outfit (unless bath, pool, or pajamas per system rules).`;

const ADVENTURE_CAST_LOCK = `

[Cast lock] Only the hero child and people described in the customer-confirmed cast (if any) may appear as recognizable full figures. Do not invent a second unrelated adult couple, random parents, or crowd filler adults. If caregivers are needed, they must match confirmed cast descriptions.`;

/**
 * Apply policy suffixes to spread illustration prompts in place.
 *
 * @param {Array<object>} entries - storyPlan.entries
 * @param {object} opts
 * @param {string} opts.theme
 * @param {boolean} opts.coverParentPresent
 * @param {boolean} opts.coverHadVisionSecondaries - true if cover scan found real secondaries (not depiction-only)
 * @param {boolean} opts.hasConfirmedCast - true if customer confirmed non-main_child characters
 */
function applyScenePolicyToEntries(entries, opts = {}) {
  const {
    theme = '',
    coverParentPresent = false,
    coverHadVisionSecondaries = false,
    hasConfirmedCast = false,
  } = opts;

  if (!Array.isArray(entries)) return;

  const isParentTheme = PARENT_THEMES.has(theme);
  const needsImpliedParent = isParentTheme && !coverParentPresent;

  for (const e of entries) {
    if (!e || e.type !== 'spread') continue;
    const raw = typeof e.spread_image_prompt === 'string' ? e.spread_image_prompt.trim() : '';
    if (!raw) continue;

    let next = raw;
    if (needsImpliedParent && !/\[Illustration staging — REQUIRED\]/i.test(next)) {
      next += IMPLIED_PARENT_STAGING;
    }
    if (!isParentTheme && hasConfirmedCast && !coverHadVisionSecondaries) {
      if (!/\[Cast lock\]/i.test(next)) next += ADVENTURE_CAST_LOCK;
    }

    e.spread_image_prompt = next.slice(0, 2000);
  }
}

module.exports = { applyScenePolicyToEntries, IMPLIED_PARENT_STAGING, ADVENTURE_CAST_LOCK };
