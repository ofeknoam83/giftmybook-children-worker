/**
 * Illustrator — Per-Spread Prompt Builder
 *
 * The system instruction already carries the style lock, character lock, text
 * rules, and family policy. A per-spread turn only needs:
 *   - "You are on spread X of Y"
 *   - the scene description
 *   - the exact LEFT / RIGHT text (if any)
 *   - a short reminder of the no-center text band (belt-and-suspenders; the
 *     model tends to drift on placement after ~6 turns without a reminder)
 *
 * Keep this module under ~100 lines. If you find yourself re-adding rule
 * blocks, move them to systemInstruction.js instead.
 */

const { TEXT_RULES, TOTAL_SPREADS } = require('./config');

/**
 * @typedef {Object} SpreadTurnOpts
 * @property {number} spreadIndex - 0-based spread index (0..12).
 * @property {number} [totalSpreads] - Defaults to TOTAL_SPREADS (13).
 * @property {string} scene - Scene description from the story planner (what happens, where, mood).
 * @property {string} [leftText] - Exact text to render on the left side.
 * @property {string} [rightText] - Exact text to render on the right side.
 * @property {string} [correctionNote] - Optional per-retry correction (appended when non-empty).
 */

/**
 * Build a single per-spread user turn (plain string — session.js wraps it in a
 * `{role: 'user', parts: [...]}` entry).
 *
 * @param {SpreadTurnOpts} opts
 * @returns {string}
 */
function buildSpreadTurn(opts) {
  const {
    spreadIndex,
    totalSpreads = TOTAL_SPREADS,
    scene,
    leftText = '',
    rightText = '',
    correctionNote,
  } = opts;

  if (typeof scene !== 'string' || !scene.trim()) {
    throw new Error('buildSpreadTurn: scene description is required');
  }

  const human = spreadIndex + 1;
  const sections = [];

  sections.push(`### SPREAD ${human} of ${totalSpreads}`);

  sections.push(
`### SCENE
${scene.trim()}`
  );

  sections.push(buildTextBlock(leftText, rightText));

  // Short belt-and-suspenders reminder — the system instruction already covers
  // these but the image model tends to drift on placement by the middle of the
  // book. Keep it terse so it doesn't dilute the scene.
  sections.push(
`### REMINDERS
- Keep the hero child and any on-cover characters identical to the cover and to the approved spreads you've already generated in this session.
- Text stays strictly on its half of the image. Center band (${TEXT_RULES.centerExclusionPercent * 2}% wide across the midline) has ZERO text. Text must be CHARACTER-FOR-CHARACTER identical to what is listed above.
- One hero, one moment, one seamless painting.`
  );

  if (correctionNote && correctionNote.trim()) {
    sections.push(`### CORRECTION FOR THIS RETRY
${correctionNote.trim()}`);
  }

  return sections.join('\n\n');
}

function buildTextBlock(leftText, rightText) {
  const hasLeft = typeof leftText === 'string' && leftText.trim().length > 0;
  const hasRight = typeof rightText === 'string' && rightText.trim().length > 0;

  if (!hasLeft && !hasRight) {
    return `### ON-IMAGE TEXT
None. Generate a full-bleed illustration with NO text overlay for this spread.`;
  }

  const lines = ['### ON-IMAGE TEXT (render exactly as written — no paraphrasing, no duplicates)'];
  lines.push(`LEFT TEXT: ${hasLeft ? `"${leftText.trim()}"` : '(none — leave the left half text-free)'}`);
  lines.push(`RIGHT TEXT: ${hasRight ? `"${rightText.trim()}"` : '(none — leave the right half text-free)'}`);
  return lines.join('\n');
}

/**
 * Build a short correction prompt for in-session retry. Keeps the text/scene
 * anchors so the model knows it's still producing the SAME spread, just fixing
 * a specific defect.
 *
 * @param {object} opts
 * @param {number} opts.spreadIndex
 * @param {number} [opts.totalSpreads]
 * @param {string} opts.scene
 * @param {string} [opts.leftText]
 * @param {string} [opts.rightText]
 * @param {string[]} opts.issues - Human-readable QA issues to fix.
 * @returns {string}
 */
function buildCorrectionTurn(opts) {
  const correctionNote = `The previous attempt had these problems — fix ALL of them and regenerate:\n- ${opts.issues.join('\n- ')}`;
  return buildSpreadTurn({
    spreadIndex: opts.spreadIndex,
    totalSpreads: opts.totalSpreads,
    scene: opts.scene,
    leftText: opts.leftText,
    rightText: opts.rightText,
    correctionNote,
  });
}

module.exports = {
  buildSpreadTurn,
  buildCorrectionTurn,
};
