/**
 * Illustrator — Per-Spread Prompt Builder
 *
 * The system instruction already carries the style lock, character lock, text
 * rules, and family policy. A per-spread turn only needs:
 *   - "You are on spread X of Y"
 *   - the scene description
 *   - the exact TEXT (single passage) and which SIDE to render it on
 *   - a short reminder of the single-side placement rule (belt-and-suspenders;
 *     the model drifts on placement after ~6 turns without a reminder)
 *
 * Single-side rule (hard lock):
 *   Each spread's entire caption lives on ONE side only (LEFT or RIGHT). The
 *   opposite side stays text-free. If legacy callers pass leftText/rightText
 *   we concatenate them into one passage and use the side derived from
 *   defaultTextSide(spreadIndex).
 *
 * Keep this module small. If you find yourself re-adding rule blocks, move
 * them to systemInstruction.js instead.
 */

const { TEXT_RULES, TOTAL_SPREADS, defaultTextSide, PARENT_THEMES } = require('./config');

/**
 * @typedef {Object} SpreadTurnOpts
 * @property {number} spreadIndex - 0-based spread index (0..12).
 * @property {number} [totalSpreads] - Defaults to TOTAL_SPREADS (13).
 * @property {string} scene - Scene description from the story planner.
 * @property {string} [text] - Exact caption for the spread (the whole passage, on one side).
 * @property {'left' | 'right'} [textSide] - Which side to render on. Default: defaultTextSide(spreadIndex).
 * @property {string} [leftText] - LEGACY. Concatenated with rightText if text is not provided.
 * @property {string} [rightText] - LEGACY. Concatenated with leftText if text is not provided.
 * @property {string} [correctionNote] - Optional per-retry correction (appended when non-empty).
 * @property {string} [characterOutfit] - Locked outfit string from story plan (QA retries + reminders).
 * @property {string} [characterDescription] - Optional short hero description for directives.
 * @property {string} [theme] - Book theme id (e.g. mothers_day).
 * @property {boolean} [hasSecondaryOnCover] - True if parent or other non-child human on cover.
 * @property {boolean} [coverParentPresent] - Themed parent visible on cover.
 * @property {string} [additionalCoverCharacters] - Non-child people on cover description.
 */

/**
 * Normalize legacy left/right split callers into the new single-passage form.
 * Returns {text, side} — `text` may be empty for no-text spreads.
 *
 * @param {SpreadTurnOpts} opts
 * @returns {{text: string, side: 'left' | 'right'}}
 */
function resolveTextAndSide(opts) {
  const { spreadIndex, text, textSide, leftText, rightText } = opts;

  let resolved = typeof text === 'string' ? text.trim() : '';
  if (!resolved) {
    const parts = [leftText, rightText]
      .filter(s => typeof s === 'string' && s.trim().length > 0)
      .map(s => s.trim());
    resolved = parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  const side = (textSide === 'left' || textSide === 'right')
    ? textSide
    : defaultTextSide(spreadIndex);

  return { text: resolved, side };
}

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
    correctionNote,
  } = opts;

  if (typeof scene !== 'string' || !scene.trim()) {
    throw new Error('buildSpreadTurn: scene description is required');
  }

  const { text, side } = resolveTextAndSide(opts);

  const human = spreadIndex + 1;
  const sections = [];

  sections.push(`### SPREAD ${human} of ${totalSpreads}`);

  sections.push(
`### SCENE
${scene.trim()}`
  );

  sections.push(buildTextBlock(text, side));

  const reminderLines = [
    '### REMINDERS',
    '- Keep the hero child and any on-cover characters identical to the cover and to the approved spreads you\'ve already generated in this session.',
    `- Text rule for this spread: render the caption on the ${side.toUpperCase()} side ONLY. The ${oppositeSide(side).toUpperCase()} side and the center band must be completely text-free. Text must be CHARACTER-FOR-CHARACTER identical to what is listed above — no duplicates, no "the end", no extras.`,
    '- One hero, one moment, **one continuous panoramic illustration** (single wide shot). Do NOT compose this as two different scenes side-by-side. No vertical seam, no lighting or palette break down the middle, no object or person truncated at center as if two images were stitched.',
    '- The book printer will crop this **one** image into two pages — you must paint **one** unified environment edge to edge.',
  ];

  const theme = typeof opts.theme === 'string' ? opts.theme.trim() : '';
  const outfit = typeof opts.characterOutfit === 'string' ? opts.characterOutfit.trim() : '';
  if (outfit && theme && PARENT_THEMES.has(theme)) {
    reminderLines.push(
      `- Outfit lock: the hero must wear exactly this locked outfit (same as cover unless bath, pool, or pajamas per system rules): ${outfit}`,
    );
    reminderLines.push(
      '- No background strangers or extra full-face adults. For this parent-gift theme, any parent not on the cover appears only as implied presence (hands, stroller bar, shoulder, silhouette) — never a clear parent face unless they are on the approved cover.',
    );
  }

  sections.push(reminderLines.join('\n'));

  if (correctionNote && correctionNote.trim()) {
    sections.push(`### CORRECTION FOR THIS RETRY
${correctionNote.trim()}`);
  }

  return sections.join('\n\n');
}

function oppositeSide(side) {
  return side === 'left' ? 'right' : 'left';
}

function buildTextBlock(text, side) {
  if (!text) {
    return `### ON-IMAGE TEXT
None. Generate a full-bleed illustration with NO text overlay anywhere on this spread.`;
  }

  const opp = oppositeSide(side);
  const sideU = side === 'left' ? 'LEFT' : 'RIGHT';
  const oppU = opp === 'left' ? 'LEFT' : 'RIGHT';

  return `### ON-IMAGE TEXT (render exactly as written — one caption, one side)
TEXT: "${text}"
CHOSEN SIDE: ${sideU}
PLACEMENT: Render the TEXT line above exactly once as a single stacked caption on the ${sideU} half only — tucked toward the outer page edge and well away from the middle spine. The ${oppU} half must stay completely free of any letters or punctuation. The caption is one continuous passage: print it one time only; if you start to repeat the same words elsewhere on the canvas, delete the extra copy. Never split this passage across both halves. Never paint instructions, measurements, or placeholder symbols as part of the caption — only the TEXT line may appear as type.`;
}

/**
 * Build a short correction prompt for in-session retry. Keeps the scene + text
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
 * @param {string} [opts.text]
 * @param {'left' | 'right'} [opts.textSide]
 * @param {string} [opts.leftText] - LEGACY
 * @param {string} [opts.rightText] - LEGACY
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
    text: opts.text,
    textSide: opts.textSide,
    leftText: opts.leftText,
    rightText: opts.rightText,
    correctionNote: lines.join('\n'),
    characterOutfit: opts.characterOutfit,
    characterDescription: opts.characterDescription,
    theme: opts.theme,
    hasSecondaryOnCover: opts.hasSecondaryOnCover,
    coverParentPresent: opts.coverParentPresent,
    additionalCoverCharacters: opts.additionalCoverCharacters,
  });
}

/**
 * Map QA tags to explicit remediation directives. Kept small and surgical —
 * each directive addresses a specific repeating Gemini failure mode observed
 * in production logs (center-band hallucinations, doubled captions, phantom
 * words, text on both sides).
 *
 * @param {string[]} tags
 * @param {object} opts - Spread + book context for tag-specific remediation.
 * @returns {string[]}
 */
function buildTagDirectives(tags, opts) {
  const set = new Set(tags);
  const out = [];

  // Resolve the single caption + side (supports legacy L/R shape).
  const { text: permittedText, side } = resolveTextAndSide({
    spreadIndex: opts.spreadIndex,
    text: opts.text,
    textSide: opts.textSide,
    leftText: opts.leftText,
    rightText: opts.rightText,
  });
  if (set.has('text_on_both_sides')) {
    out.push(
      `Text appeared on BOTH sides in the previous attempt. Delete ALL text from the ${side === 'left' ? 'RIGHT' : 'LEFT'} half of the image — the entire caption must live on the ${side.toUpperCase()} side only. Do not mirror, duplicate, or echo the caption across the midline.`,
    );
  }
  if (set.has('text_in_center_band') || set.has('text_crosses_midline')) {
    out.push(
      'No text may sit in or cross the middle band around the book spine (the gutter). ' +
      'If any lettering from the previous attempt landed there, DELETE it — that zone is illustration-only unless it is clearly part of the scene (signage in-world is forbidden unless it matches the TEXT exactly).',
    );
  }
  if (set.has('text_duplicated_caption') || set.has('duplicated_word')) {
    out.push(`Render the caption EXACTLY ONCE on the ${side.toUpperCase()} side. Do not repeat it anywhere else on the image.`);
  }
  if (set.has('extra_word') || set.has('unexpected_text')) {
    out.push(
      permittedText
        ? `The ONLY text permitted on this image is "${permittedText}", rendered on the ${side.toUpperCase()} side. Any other word, letter, label, sign, title, or signature is forbidden — do not add decorative text, titles, or signatures of any kind.`
        : 'No text of any kind is allowed on this image — no words, labels, titles, or signatures.',
    );
  }
  if (set.has('missing_word') || set.has('spelling_mismatch')) {
    out.push(`Render the TEXT character-for-character identical to the passage above on the ${side.toUpperCase()} side. No paraphrasing, no dropped words, no added words.`);
  }
  if (set.has('implied_parent_skin_mismatch')) {
    out.push(
      'Any visible skin on the implied parent (hands, forearms, legs, arms) MUST match the hero child\'s skin tone and undertone from the BOOK COVER — same family, same household. Re-render those partial-body areas to align with the cover child; keep the parent\'s face hidden per policy.',
    );
  }
  if (set.has('split_panel')) {
    out.push(
      'The image looked like TWO illustrations stitched together (diptych) with a visible vertical seam or mismatched halves. Re-render as ONE seamless wide panorama: identical lighting and atmosphere across the full width, one ground plane, one continuous background — no seam at the vertical center, no abrupt crop of props or people at mid-frame. Think one cinematic still, not two pages.',
    );
  }

  const theme = typeof opts.theme === 'string' ? opts.theme.trim() : '';
  const isParentTheme = theme.length > 0 && PARENT_THEMES.has(theme);
  const hasSecondary = opts.hasSecondaryOnCover === true;

  if (set.has('outfit_mismatch')) {
    const outfit = typeof opts.characterOutfit === 'string' ? opts.characterOutfit.trim() : '';
    out.push(
      outfit
        ? `The hero's clothing must match the cover exactly. Locked outfit (reproduce precisely — no swaps unless bath, pool, or pajamas per system rules): ${outfit}`
        : 'The hero\'s clothing must match the cover reference exactly — same garments, colors, and silhouette. No outfit drift unless the story beat explicitly calls for bath, pool, or pajamas per system rules.',
    );
  }
  if (set.has('hero_mismatch')) {
    const desc = typeof opts.characterDescription === 'string' ? opts.characterDescription.trim() : '';
    out.push(
      desc
        ? `Face, hair, skin tone, and proportions must match the BOOK COVER reference exactly — no drift. Story reference: ${desc}`
        : 'Face, hair, skin tone, eye color, hairstyle, and body proportions must match the BOOK COVER reference exactly — no drift, no "similar" substitute child.',
    );
  }
  if (set.has('unexpected_person')) {
    if (!hasSecondary && isParentTheme) {
      out.push(
        'Remove any full-face or full-body adults and all background pedestrians. Only the hero child belongs in frame; the parent for this theme appears only as IMPLIED presence (hands, stroller push bar, shoulder edge, silhouette) — never a recognizable parent face unless they are on the approved cover.',
      );
    } else if (hasSecondary) {
      out.push(
        'Only characters who appear on the approved cover may show as full people. Remove every other person — no extras, no crowd filler, no background pedestrians.',
      );
    } else {
      out.push(
        'Only the hero child may appear as a full person. Remove any other full humans from the scene (no background pedestrians, no strangers).',
      );
    }
  }
  if (set.has('duplicated_hero')) {
    out.push(
      'Exactly ONE hero child in the image. Remove mirror duplicates, reflections that read as a second child, twinning, or a second full figure of the same character.',
    );
  }
  if (set.has('wrong_font')) {
    out.push(
      `Font for the caption must follow this lock exactly: ${TEXT_RULES.fontStyle}`,
    );
  }

  return out;
}

module.exports = {
  buildSpreadTurn,
  buildCorrectionTurn,
  resolveTextAndSide,
};
