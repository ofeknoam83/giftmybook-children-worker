/**
 * Quad (4:1 dual-spread) user prompts — imported only by `renderAllSpreadsQuad`.
 */

const {
  TEXT_RULES,
  TOTAL_SPREADS,
  resolvePictureBookTextRules,
  PARENT_THEMES,
  resolveSideAndCorner,
} = require('./config');
const { buildTextBlock } = require('./prompt');

function oppositeSide(side) {
  return side === 'left' ? 'right' : 'left';
}

/**
 * @param {object} opts
 * @param {number} opts.spreadIndexA - 0-based first spread in the pair
 * @param {number} opts.spreadIndexB - 0-based second spread
 * @param {string} opts.sceneA
 * @param {string} opts.sceneB
 * @param {string} [opts.textA]
 * @param {string} [opts.textB]
 * @param {'left'|'right'} [opts.textSideA]
 * @param {'left'|'right'} [opts.textSideB]
 * @param {string} [opts.textCornerA]
 * @param {string} [opts.textCornerB]
 * @param {string} [opts.theme]
 * @param {number|string|null} [opts.childAge]
 * @param {number} [opts.quadBatchIndex] - 0-based batch index within the book
 * @param {string} [opts.correctionNote]
 * @param {string} [opts.heroAppearance] - visual bible hero physical description; repeated every batch for hair/outfit lock
 * @returns {string}
 */
function buildDualSpreadTurn(opts) {
  const {
    spreadIndexA,
    spreadIndexB,
    sceneA,
    sceneB,
    theme,
    childAge,
    quadBatchIndex = 0,
    correctionNote,
    heroAppearance,
  } = opts;

  const numA = spreadIndexA + 1;
  const numB = spreadIndexB + 1;
  const textRules = resolvePictureBookTextRules(childAge);

  const { side: sideA, corner: cornerA } = resolveSideAndCorner(
    spreadIndexA,
    opts.textSideA,
    opts.textCornerA,
    childAge,
  );
  const { side: sideB, corner: cornerB } = resolveSideAndCorner(
    spreadIndexB,
    opts.textSideB,
    opts.textCornerB,
    childAge,
  );

  const textA = typeof opts.textA === 'string' ? opts.textA.trim() : '';
  const textB = typeof opts.textB === 'string' ? opts.textB.trim() : '';

  const cornerAU = cornerA.toUpperCase();
  const cornerBU = cornerB.toUpperCase();
  const themeStr = typeof theme === 'string' ? theme.trim() : '';
  const isParentTheme = themeStr && PARENT_THEMES.has(themeStr);

  const reminderLines = [
    '### REMINDERS (4:1 DUAL — BOTH HALVES)',
    `- **One 4:1 frame:** LEFT half = spread ${numA} only; RIGHT half = spread ${numB} only. Story order left → right.`,
    '- **Each half is one 2:1 spread:** within each half, the two bound pages are ONE continuous environment — same rules as single-spread panorama (no seam down the middle of that half).',
    `- **Captions:** spread ${numA}: ${cornerAU} on ${sideA.toUpperCase()} **within the left half only**. Spread ${numB}: ${cornerBU} on ${sideB.toUpperCase()} **within the right half only**. Never place a caption in the partner half.`,
    '- **Art style:** 3D Pixar CGI matching the BOOK COVER; not 2D illustration.',
    '- **Vertical center of the full 4:1:** transition should stay seamless (lighting/atmosphere) — no harsh cut like two unrelated photos.',
    '- **Exact text:** character-for-character match for each half\'s TEXT; no extra words, no duplication across halves.',
    '- **Hero look:** hair color, hairstyle, skin tone, and face must match the BOOK COVER and the HERO LOCK block below on **both** halves and **every** quad batch — no drift across pairs.',
  ];

  if (textRules.maxWordsPerLine !== TEXT_RULES.maxWordsPerLine) {
    reminderLines.push(
      `- **Longer read-aloud lines:** at most ${textRules.maxWordsPerLine} words per line per caption.`,
    );
  }
  if (isParentTheme) {
    reminderLines.push(
      '- Parent theme: off-cover adults only as implied presence per system instruction — never invent a full parent face.',
    );
  }

  const heroBlock = typeof heroAppearance === 'string' && heroAppearance.trim()
    ? [
      '### HERO LOCK (repeat every batch)',
      'Match this written lock to the BOOK COVER and every prior accepted interior — same child identity.',
      heroAppearance.trim(),
      '',
    ]
    : [];

  const sections = [
    `### QUAD BATCH ${quadBatchIndex + 1} — DUAL SPREADS ${numA} AND ${numB} of ${TOTAL_SPREADS} (one 4:1 image)`,
    '',
    ...heroBlock,
    `### LEFT HALF — SPREAD ${numA} of ${TOTAL_SPREADS} (this half is a complete 2:1 wide spread)`,
    '### SCENE',
    String(sceneA || '').trim(),
    '',
    buildTextBlock(textA, sideA, cornerA, textRules),
    '',
    `### RIGHT HALF — SPREAD ${numB} of ${TOTAL_SPREADS} (this half is a complete 2:1 wide spread)`,
    '### SCENE',
    String(sceneB || '').trim(),
    '',
    buildTextBlock(textB, sideB, cornerB, textRules),
    '',
    reminderLines.join('\n'),
  ];

  if (correctionNote && String(correctionNote).trim()) {
    sections.push('', '### CORRECTION FOR THIS RETRY', String(correctionNote).trim());
  }

  return sections.join('\n');
}

/**
 * @param {object} opts
 * @param {number} opts.spreadIndexA
 * @param {number} opts.spreadIndexB
 * @param {string} opts.sceneA
 * @param {string} opts.sceneB
 * @param {string} [opts.textA]
 * @param {string} [opts.textB]
 * @param {'left'|'right'} [opts.textSideA]
 * @param {'left'|'right'} [opts.textSideB]
 * @param {string} [opts.textCornerA]
 * @param {string} [opts.textCornerB]
 * @param {string[]} opts.issues
 * @param {string[]} [opts.tags]
 * @param {string} [opts.theme]
 * @param {number|string|null} [opts.childAge]
 * @param {number} [opts.quadBatchIndex]
 * @param {string} [opts.heroAppearance]
 * @returns {string}
 */
function buildDualCorrectionTurn(opts) {
  const tags = Array.isArray(opts.tags) ? opts.tags : [];
  const lines = [
    'The previous 4:1 dual-spread attempt failed QA on one or both halves — fix ALL issues and regenerate the full 4:1 frame:',
    ...opts.issues.map(i => `- ${i}`),
  ];
  if (tags.length) {
    lines.push('', 'TAGS: ' + tags.join(', '));
  }
  return buildDualSpreadTurn({
    spreadIndexA: opts.spreadIndexA,
    spreadIndexB: opts.spreadIndexB,
    sceneA: opts.sceneA,
    sceneB: opts.sceneB,
    textA: opts.textA,
    textB: opts.textB,
    textSideA: opts.textSideA,
    textSideB: opts.textSideB,
    textCornerA: opts.textCornerA,
    textCornerB: opts.textCornerB,
    theme: opts.theme,
    childAge: opts.childAge,
    quadBatchIndex: opts.quadBatchIndex,
    heroAppearance: opts.heroAppearance,
    correctionNote: lines.join('\n'),
  });
}

module.exports = { buildDualSpreadTurn, buildDualCorrectionTurn, oppositeSide };
