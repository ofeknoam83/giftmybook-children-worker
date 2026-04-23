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
  lines.push('ONE-SIDE-ONLY RULE: text appears on EXACTLY ONE side of this spread. The opposite side must stay entirely text-free illustration. Do NOT mirror, duplicate, or split the caption across sides.');
  lines.push(`LEFT TEXT: ${hasLeft ? `"${leftText.trim()}"` : '(none — the LEFT half must be text-free illustration)'}`);
  lines.push(`RIGHT TEXT: ${hasRight ? `"${rightText.trim()}"` : '(none — the RIGHT half must be text-free illustration)'}`);
  return lines.join('\n');
}

/**
 * Build a short correction prompt for in-session retry. Keeps the text/scene
 * anchors so the model knows it's still producing the SAME spread, just fixing
 * a specific defect.
 *
 * Tag-specific directives are appended so Gemini is told not just WHAT went
 * wrong but what ACTION to take. Empirically Gemini treats "fix this" as
 * "re-place this" — for hallucinated words it needs an explicit "delete these,
 * they are not part of the spread" to stop re-emitting them in new locations.
 *
 * @param {object} opts
 * @param {number} opts.spreadIndex
 * @param {number} [opts.totalSpreads]
 * @param {string} opts.scene
 * @param {string} [opts.leftText]
 * @param {string} [opts.rightText]
 * @param {string[]} opts.issues - Human-readable QA issues to fix.
 * @param {string[]} [opts.tags] - QA tag codes from textQa/consistencyQa (used to add tag-specific directives).
 * @returns {string}
 */
function buildCorrectionTurn(opts) {
  const tags = Array.isArray(opts.tags) ? opts.tags : [];
  const lines = [
    `The previous attempt had these problems — fix ALL of them and regenerate:`,
    ...opts.issues.map(i => `- ${i}`),
  ];

  const directives = buildTagDirectives(tags, opts);
  if (directives.length > 0) {
    lines.push('');
    lines.push('SPECIFIC ACTIONS TO TAKE:');
    for (const d of directives) lines.push(`- ${d}`);
  }

  return buildSpreadTurn({
    spreadIndex: opts.spreadIndex,
    totalSpreads: opts.totalSpreads,
    scene: opts.scene,
    leftText: opts.leftText,
    rightText: opts.rightText,
    correctionNote: lines.join('\n'),
  });
}

/**
 * Map QA tags to explicit remediation directives. Kept small and surgical —
 * each directive addresses a specific repeating Gemini failure mode observed
 * in production logs (center-band hallucinations, doubled captions, phantom
 * words).
 *
 * @param {string[]} tags
 * @param {{leftText?: string, rightText?: string}} opts
 * @returns {string[]}
 */
function buildTagDirectives(tags, opts) {
  const set = new Set(tags);
  const out = [];

  if (set.has('text_in_center_band') || set.has('text_crosses_midline')) {
    out.push(
      `No text may touch the center band (${50 - TEXT_RULES.centerExclusionPercent}%–${50 + TEXT_RULES.centerExclusionPercent}% of image width). ` +
      `If any text from the previous attempt landed there, DELETE it — any word in the center that is NOT part of the LEFT TEXT or RIGHT TEXT above is a hallucination and must not appear anywhere on the image.`,
    );
  }
  if (set.has('text_duplicated_caption') || set.has('duplicated_word')) {
    out.push('Render each caption EXACTLY ONCE. Do not repeat the LEFT TEXT or RIGHT TEXT anywhere else on the image.');
  }
  if (set.has('extra_word') || set.has('unexpected_text')) {
    const left = (opts.leftText || '').trim();
    const right = (opts.rightText || '').trim();
    const permitted = [left && `"${left}"`, right && `"${right}"`].filter(Boolean).join(' and ');
    out.push(
      permitted
        ? `The ONLY text permitted on this image is ${permitted}. Any other word, letter, label, sign, title, or signature is forbidden — do not add decorative text, titles, or signatures of any kind.`
        : 'No extra words, labels, titles, or signatures are allowed on this image.',
    );
  }
  if (set.has('missing_word') || set.has('spelling_mismatch')) {
    out.push('Render the LEFT TEXT and RIGHT TEXT character-for-character identical to the passages above. No paraphrasing, no dropped words, no added words.');
  }

  return out;
}

module.exports = {
  buildSpreadTurn,
  buildCorrectionTurn,
};
