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

const {
  TEXT_RULES,
  TOTAL_SPREADS,
  defaultTextSide,
  resolveSideAndCorner,
  PARENT_THEMES,
  resolvePictureBookTextRules,
} = require('./config');

/** Tags from textQa (layout + caption fidelity) — used for staged corrections before hero/outfit fixes. */
const ILLUSTRATOR_TEXT_QA_TAGS = new Set([
  'text_on_both_sides', 'spelling_mismatch', 'duplicated_word', 'extra_word',
  'unexpected_text', 'text_in_center_band', 'text_crosses_midline', 'wrong_font',
  'text_duplicated_caption', 'missing_word',
]);

const SIGNAGE_SCENE_HINT = /\b(sign|signs|banner|billboard|headquarters|headquarter|marquee|plaque|label|league|alphabet|inscription|typography|stone\s+letters?|letters?\s+line|giant\s+letters?|letter\s+path|letter\s+trail)\b/i;

/**
 * Appends a hard constraint that the model must not add readable environmental text
 * (common source of `extra_word` QA failures). Idempotent: does not double-append.
 *
 * @param {string} scene
 * @returns {string}
 */
function deescalateSceneForSignage(scene) {
  const s = String(scene || '').trim();
  if (!s) return s;
  if (/\[Print constraint\]/i.test(s) && /in-world|legible/i.test(s)) return s;
  return `${s}\n\n[Print constraint] Do not paint legible in-world text on signs, storefronts, building names, or props — use blank panels, pictograms, or illegible blur. The ONLY readable text in the image must be the book caption in the margin on the chosen side.`;
}

/**
 * @param {string[]} tags
 * @param {string} [scene]
 * @returns {boolean}
 */
function shouldDeescalateSceneForQaFail(tags, scene) {
  const t = Array.isArray(tags) ? tags : [];
  if (t.includes('extra_word') || t.includes('unexpected_text')) return true;
  return SIGNAGE_SCENE_HINT.test(String(scene || ''));
}

/**
 * Remove long per-spread policy blocks (off-cover cast, caption placement) that
 * duplicate the session system instruction. Cuts redundant NEVER/HARD wording
 * from the user turn for any book — general mitigation for PROHIBITED_CONTENT.
 *
 * @param {string} scene
 * @returns {string}
 */
function compactSceneForImageSafetyRetry(scene) {
  const s = String(scene || '').trim();
  if (!s) return s;
  let cut = s.search(/\n\s*Off-cover cast rule\b/i);
  if (cut === -1) cut = s.search(/\n\s*Caption placement\b/i);
  if (cut === -1) return s;
  const head = s.slice(0, cut).trim();
  if (!head) return s;
  return (
    `${head}\n\n`
    + '[System note: Off-cover visibility, caption corner placement, and anatomy rules '
    + 'are defined in the session system instruction — follow that policy.]'
  );
}

/**
 * Caption wording softening for last-resort safety retries. Can break strict
 * rhyme; used before rebuild so the book can complete.
 *
 * @param {string} caption
 * @returns {string}
 */
function softenCaptionForImageSafetyRetry(caption) {
  if (typeof caption !== 'string' || !caption) return caption;
  let s = caption;
  s = s.replace(/\bpeeking\b/gi, 'looking');
  s = s.replace(/\bpeeks\b/gi, 'looks');
  s = s.replace(/\bpeek\b/gi, 'look');
  s = s.replace(/\bpeep\b/gi, 'glance');
  s = s.replace(/\bin every pack\b/gi, 'in each lunch bag');
  s = s.replace(/\bevery pack\b/gi, 'each lunch bag');
  return s;
}

/**
 * Extra phrase-level softening on the SCENE string (optional second line of defense).
 *
 * @param {string} scene
 * @returns {string}
 */
function softenSceneForImageSafetyRetry(scene) {
  let s = String(scene || '').trim();
  if (!s) return s;

  s = s.replace(/\bpeeking\b/gi, 'looking');
  s = s.replace(/\bpeeks\b/gi, 'looks');
  s = s.replace(/\bpeek\b/gi, 'look');
  s = s.replace(/\bpeep\b/gi, 'glance');

  s = s.replace(/\bin every pack\b/gi, 'in each lunch bag');
  s = s.replace(/\bevery pack\b/gi, 'each lunch bag');
  s = s.replace(/\bthe pack\b/gi, 'the bag');

  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Last-resort scene when softening is not enough — keeps spread index + theme
 * for continuity but strips planner detail that may trip the classifier.
 *
 * @param {number} spreadIndex - 0-based
 * @param {string} [theme]
 * @returns {string}
 */
function minimalSafeSceneFallback(spreadIndex, theme) {
  const t = typeof theme === 'string' && theme
    ? theme.replace(/_/g, ' ')
    : 'family';
  const n = spreadIndex + 1;
  return (
    `Wholesome picture-book moment for spread ${n} (gentle ${t} story). ` +
    'Bright, cheerful daytime outdoor or park setting; same 3D Pixar-style CGI as the cover. ' +
    'Hero child with family figures nearby if the story needs them; playful, calm, age-appropriate. ' +
    'No scary imagery, no suggestive staging, no photoreal documentary look.'
  );
}

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
 * @property {string} [characterOutfit] - Legacy; not used for outfit (visual lock is cover + session).
 * @property {string} [characterDescription] - Optional short hero description for directives.
 * @property {string} [theme] - Book theme id (e.g. mothers_day).
 * @property {boolean} [hasSecondaryOnCover] - True if parent or other non-child human on cover.
 * @property {boolean} [coverParentPresent] - Themed parent visible on cover.
 * @property {string} [additionalCoverCharacters] - Non-child people on cover description.
 * @property {number|string|null} [childAge] - 3–8 triggers compact caption tier in ON-IMAGE TEXT block.
 */

/**
 * Normalize legacy left/right split callers into the new single-passage form.
 * Returns {text, side, corner} — `text` may be empty for no-text spreads.
 *
 * @param {SpreadTurnOpts} opts
 * @returns {{text: string, side: 'left' | 'right', corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'}}
 */
function resolveTextAndSide(opts) {
  const { spreadIndex, text, textSide, textCorner, leftText, rightText } = opts;

  let resolved = typeof text === 'string' ? text.trim() : '';
  if (!resolved) {
    const parts = [leftText, rightText]
      .filter(s => typeof s === 'string' && s.trim().length > 0)
      .map(s => s.trim());
    resolved = parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  const { side, corner } = resolveSideAndCorner(spreadIndex, textSide, textCorner);

  return { text: resolved, side, corner };
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

  const { text, side, corner } = resolveTextAndSide(opts);
  const textRules = resolvePictureBookTextRules(opts.childAge);

  const human = spreadIndex + 1;
  const sections = [];

  sections.push(`### SPREAD ${human} of ${totalSpreads}`);

  sections.push(
`### SCENE
${scene.trim()}`
  );

  sections.push(buildTextBlock(text, side, corner, textRules));

  const theme = typeof opts.theme === 'string' ? opts.theme.trim() : '';
  const isParentTheme = theme && PARENT_THEMES.has(theme);

  const cornerU = corner.toUpperCase();
  const reminderLines = [
    '### REMINDERS',
    '- **One story, many places:** if the SCENE block names a journey thread, recurring motifs, or a scene bridge, treat this image as the next beat in that SAME adventure — not a random wallpaper change. Keep motifs and emotional through-line visually believable across spreads.',
    '- **Caption = in-scene type:** the painted words must be **lit and color-graded like the rest of the frame** — same key light, matching warmth/cool, soft shadow/haze that fits depth. No flat subtitle bar, no sticker look, no sharp panel behind the lines.',
    '- **One subtitle spec for the book:** same Georgia-like serif, same weight, same **apparent** type size (modest, very legible, not big) on every spread — match your prior caption renders in this session. If this spread’s text is bigger, bolder, or a different font, fix it before emitting.',
    '- **Art style (HARD — check before emitting):** Render as a 3D CGI Pixar-film frame — photoreal subsurface skin scattering, rendered hair strands, physically based materials, volumetric ray-traced lighting, real optical depth-of-field bokeh. NOT a 2D illustration, NOT a painterly children\'s-book illustration, NOT watercolor/gouache/pencil/ink/anime/paper-cutout. If you find yourself drifting toward "soft painted storybook", stop and re-render as a Pixar-film CGI frame matching the BOOK COVER exactly.',
    '- **Hero look (outfit + face):** Match the **BOOK COVER** image and your **earlier interior images in this same chat** — not a new costume each time. Reuse the same visible clothing, colors, and hair as in those images unless this SCENE explicitly requires a situational change (bath, pool, pajamas, cold-weather layer) per the system instruction.',
    '- Keep the hero child and any on-cover characters identical to the cover and to the approved spreads you\'ve already generated in this session.',
    `- Text rule for this spread: render the caption tucked into the ${cornerU} corner (on the ${side.toUpperCase()} side) ONLY — compact block near the outer edge AND near the ${corner.startsWith('top') ? 'top' : 'bottom'} edge, with safe padding so nothing clips in print. Do NOT center the caption vertically in its half. The ${oppositeSide(side).toUpperCase()} side and the center spine band must be completely text-free. Text must be CHARACTER-FOR-CHARACTER identical to what is listed above — no duplicates, no "the end", no extras.`,
    '- **SCENE first:** Fulfil the SCENE block above (camera, focal action, who is in frame). It is the author\'s shot list — do not substitute a generic repeat of a prior spread unless the scene text is shallow (then still vary framing vs the last time this place appeared).',
    '- **ONE scene edge to edge:** both halves of the 16:9 frame show the SAME environment — same ground, same sky, same light, same perspective. Do NOT compose as "busy subject on one side + blurred empty slab on the other side for text". The text corner is just a naturally less-busy region of the SAME scene (open sky, soft-focus background, shaded path, foliage, water) — the environment continues underneath the caption, not erased for it.',
    '- No vertical seam, no lighting or palette break down the middle, no object or person truncated at center as if two images were stitched. The printer crops this ONE image into two pages.',
    '- **Shot variety:** If this spread shares the same setting as the previous one, change framing (distance, angle, focal point) per the SCENE — keep the **place** consistent, not a duplicate composition. If this place also appeared non-consecutively, still follow the new SCENE so it is not a clone of that earlier still.',
  ];

  if (textRules.maxWordsPerLine !== TEXT_RULES.maxWordsPerLine) {
    reminderLines.push(
      `- **Longer read-aloud lines (this book):** wrap to at most ${textRules.maxWordsPerLine} words per line; keep the **compact** caption size from the system instruction — do not enlarge type to fit.`,
    );
  }

  if (isParentTheme) {
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

/**
 * @param {string} text
 * @param {'left'|'right'} side
 * @param {string} corner
 * @param {typeof TEXT_RULES} [textRules]
 */
function buildTextBlock(text, side, corner, textRules = TEXT_RULES) {
  if (!text) {
    return `### ON-IMAGE TEXT
None. Generate a full-bleed illustration with NO text overlay anywhere on this spread.`;
  }

  const opp = oppositeSide(side);
  const sideU = side === 'left' ? 'LEFT' : 'RIGHT';
  const oppU = opp === 'left' ? 'LEFT' : 'RIGHT';
  const cornerU = (corner || (side === 'left' ? 'top-left' : 'top-right')).toUpperCase();
  const vertical = cornerU.startsWith('TOP-') ? 'top' : 'bottom';
  const edgeWord = side === 'left' ? 'left' : 'right';
  const edgePct = textRules.edgePaddingPercent;
  const cornerPct = textRules.cornerVerticalPaddingPercent || 21;

  const blend = textRules.textIntegration || '';
  const typeLock = textRules.typographyConsistency || '';

  return `### ON-IMAGE TEXT (render exactly as written — one caption, one corner)
TEXT: "${text}"
CHOSEN SIDE: ${sideU}
CHOSEN CORNER: ${cornerU}
PLACEMENT: Render the TEXT line above exactly once as a single compact stacked caption tucked into the ${cornerU} corner of the frame — near the outer ${edgeWord} edge (about ${edgePct}% in from that edge) AND near the ${vertical} edge of the frame (at least ${cornerPct}% in from the ${vertical} — extra margin is required so nothing clips after print trim/bleed and PDF layout; never hug the top or bottom edge). Do NOT center the caption vertically in the ${sideU} half — it is a CORNER block, not a side block. The ${oppU} half and the middle spine band must stay completely free of any letters or punctuation. The caption is one continuous passage: print it one time only; if you start to repeat the same words elsewhere on the canvas, delete the extra copy. Never split this passage across both halves. Never paint instructions, measurements, or placeholder symbols as part of the caption — only the TEXT line may appear as type. The scene (background, foliage, sky, path, etc.) continues softly underneath the caption — do NOT erase or heavily blur the corner region to "make room" for it.

TYPOGRAPHY (same book, same spec): ${typeLock}
Size note: ${textRules.fontSize}
NATURAL BLEND: ${blend}
COLOR/LIGHT (for blend, not for changing type size): ${textRules.fontColor}`;
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
    textCorner: opts.textCorner,
    leftText: opts.leftText,
    rightText: opts.rightText,
    correctionNote: lines.join('\n'),
    characterOutfit: opts.characterOutfit,
    characterDescription: opts.characterDescription,
    theme: opts.theme,
    hasSecondaryOnCover: opts.hasSecondaryOnCover,
    coverParentPresent: opts.coverParentPresent,
    additionalCoverCharacters: opts.additionalCoverCharacters,
    childAge: opts.childAge,
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
    out.push(
      'Hero clothing: copy **exactly** from the **BOOK COVER** (turn 1 in this chat) and from **your last accepted interior image(s)** here — same top/bottom/dress/shoes and color family. Do not invent a new outfit. Re-lighting, folds, and pose may change; the wardrobe must not. If this SCENE requires bath/pool/pajamas/snow layer per system rules, only then swap; otherwise keep street clothes identical to the cover render.',
    );
    out.push(
      'If the CAPTION mentions a scarf, ribbon, or wrap, do **not** change the hero’s core shirt/pants vs the cover — show that fabric on **partial-presence parent**, **railing/banner**, or a **small environmental prop**, not as a different main outfit on the child.',
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
        'Child-only / no secondaries on cover: only the hero may appear as a full, faced person. Remove pairs of full adults, "mom and dad" stroller shots, and any other full-body grown-ups — use implied care (one hand, cropped sleeve, off-panel) or show the hero alone. No background crowds of recognizable adults.',
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
  if (set.has('style_drift')) {
    out.push(
      'The previous image drifted to a photograph, flat 2D art, or non-CGI style. Re-render as stylized 3D Pixar-like CGI matching the BOOK COVER — soft render, volumetric light, subsurface skin — NOT a real camera photo, NOT watercolor, NOT anime.',
    );
  }
  if (set.has('bath_modesty')) {
    out.push(
      'Bath/swim scene: keep the hero modest — thick bubble foam or towel wrap or modest child swimwear; never explicit nudity; never the hero fully dressed in street clothes inside the tub.',
    );
  }

  return out;
}

module.exports = {
  buildSpreadTurn,
  buildCorrectionTurn,
  resolveTextAndSide,
  ILLUSTRATOR_TEXT_QA_TAGS,
  deescalateSceneForSignage,
  shouldDeescalateSceneForQaFail,
  compactSceneForImageSafetyRetry,
  softenSceneForImageSafetyRetry,
  softenCaptionForImageSafetyRetry,
  minimalSafeSceneFallback,
};
