'use strict';

/**
 * Graphic novel page layout templates.
 *
 * Each template defines panel positions within the page's live area.
 * Page size: 495×756pt (6.875"×10.5" with bleed). Margins: 36pt (0.5") all sides.
 * Live area: 423×684pt. Gutters between panels: 10pt.
 *
 * Coordinates are in PDF space (origin bottom-left).
 * Panel {x, y, w, h} = bottom-left corner of panel in page coords.
 * aspect = closest Gemini-supported aspect ratio for image generation.
 */

const PAGE_W = 495;  // 6.875" = 6.625" + 2×0.125" bleed (Lulu comic spec)
const PAGE_H = 756;  // 10.50" = 10.25" + 2×0.125" bleed (Lulu comic spec)
const MARGIN = 36;
const GUTTER = 10;

const LIVE_X = MARGIN;
const LIVE_Y = MARGIN;
const LIVE_W = PAGE_W - MARGIN * 2;   // 432
const LIVE_H = PAGE_H - MARGIN * 2;   // 648

/**
 * Pick the closest Gemini-supported aspect ratio for a panel's dimensions.
 * Supported: '1:1', '16:9', '9:16', '4:3', '3:4'
 */
function pickAspect(w, h) {
  const r = w / h;
  const options = [
    { ratio: '1:1',  val: 1.0 },
    { ratio: '4:3',  val: 4 / 3 },
    { ratio: '3:4',  val: 3 / 4 },
    { ratio: '16:9', val: 16 / 9 },
    { ratio: '9:16', val: 9 / 16 },
  ];
  let best = options[0];
  let bestDiff = Math.abs(r - best.val);
  for (const opt of options) {
    const diff = Math.abs(r - opt.val);
    if (diff < bestDiff) { best = opt; bestDiff = diff; }
  }
  return best.ratio;
}

/** Build a panel object with auto-computed aspect ratio. */
function P(x, y, w, h, bleed = false) {
  return { x, y, w, h, aspect: pickAspect(w, h), bleed };
}

// ── Half-dimensions for common splits ──
const halfW = (LIVE_W - GUTTER) / 2;           // 211
const thirdH = (LIVE_H - GUTTER * 2) / 3;     // ~209.3
const halfH = (LIVE_H - GUTTER) / 2;           // 319
const thirdW = (LIVE_W - GUTTER * 2) / 3;      // ~137.3

// ── TEMPLATES ──

const TEMPLATES = {

  // ──────────────────────────────────────────────
  // 1 panel — dramatic full-page
  // ──────────────────────────────────────────────

  SPLASH: {
    name: 'SPLASH',
    panelCount: 1,
    description: 'Full-page bleed illustration for dramatic moments',
    panels: [
      // Full bleed — extends to page edges (no margin)
      P(0, 0, PAGE_W, PAGE_H, true),
    ],
  },

  // ──────────────────────────────────────────────
  // 2 panels
  // ──────────────────────────────────────────────

  SPLASH_INSET: {
    name: 'SPLASH_INSET',
    panelCount: 2,
    description: 'Full bleed with small inset panel in corner',
    panels: [
      P(0, 0, PAGE_W, PAGE_H, true),                       // full bleed background
      P(PAGE_W - MARGIN - 130, MARGIN + 10, 120, 120),     // small inset bottom-right
    ],
  },

  VERTICAL_SPLIT: {
    name: 'VERTICAL_SPLIT',
    panelCount: 2,
    description: 'Two tall panels side by side',
    panels: [
      P(LIVE_X, LIVE_Y, halfW, LIVE_H),
      P(LIVE_X + halfW + GUTTER, LIVE_Y, halfW, LIVE_H),
    ],
  },

  // ──────────────────────────────────────────────
  // 3 panels
  // ──────────────────────────────────────────────

  WIDE_TOP_2BOT: {
    name: 'WIDE_TOP_2BOT',
    panelCount: 3,
    description: 'Wide establishing shot top, two panels bottom',
    panels: [
      P(LIVE_X, LIVE_Y + halfH + GUTTER, LIVE_W, halfH),       // wide top
      P(LIVE_X, LIVE_Y, halfW, halfH),                          // bottom-left
      P(LIVE_X + halfW + GUTTER, LIVE_Y, halfW, halfH),         // bottom-right
    ],
  },

  '2TOP_WIDE_BOT': {
    name: '2TOP_WIDE_BOT',
    panelCount: 3,
    description: 'Two panels top, wide reveal bottom',
    panels: [
      P(LIVE_X, LIVE_Y + halfH + GUTTER, halfW, halfH),         // top-left
      P(LIVE_X + halfW + GUTTER, LIVE_Y + halfH + GUTTER, halfW, halfH), // top-right
      P(LIVE_X, LIVE_Y, LIVE_W, halfH),                         // wide bottom
    ],
  },

  GRID_3ROW: {
    name: 'GRID_3ROW',
    panelCount: 3,
    description: 'Three equal horizontal strips',
    panels: [
      P(LIVE_X, LIVE_Y + thirdH * 2 + GUTTER * 2, LIVE_W, thirdH),  // top
      P(LIVE_X, LIVE_Y + thirdH + GUTTER, LIVE_W, thirdH),          // middle
      P(LIVE_X, LIVE_Y, LIVE_W, thirdH),                             // bottom
    ],
  },

  L_SHAPE: {
    name: 'L_SHAPE',
    panelCount: 3,
    description: 'Large panel left, two stacked right — hero moment',
    panels: [
      P(LIVE_X, LIVE_Y, LIVE_W * 0.58, LIVE_H),                                              // large left
      P(LIVE_X + LIVE_W * 0.58 + GUTTER, LIVE_Y + halfH + GUTTER, LIVE_W * 0.42 - GUTTER, halfH),  // top-right
      P(LIVE_X + LIVE_W * 0.58 + GUTTER, LIVE_Y, LIVE_W * 0.42 - GUTTER, halfH),                   // bottom-right
    ],
  },

  CINEMATIC: {
    name: 'CINEMATIC',
    panelCount: 3,
    description: 'Three wide horizontal strips — widescreen cinematic feel',
    panels: (() => {
      const stripH = (LIVE_H - GUTTER * 2) / 3;
      return [
        P(LIVE_X, LIVE_Y + stripH * 2 + GUTTER * 2, LIVE_W, stripH),
        P(LIVE_X, LIVE_Y + stripH + GUTTER, LIVE_W, stripH),
        P(LIVE_X, LIVE_Y, LIVE_W, stripH),
      ];
    })(),
  },

  // ──────────────────────────────────────────────
  // 4 panels
  // ──────────────────────────────────────────────

  GRID_2x2: {
    name: 'GRID_2x2',
    panelCount: 4,
    description: 'Four equal panels — dialogue or steady action',
    panels: [
      P(LIVE_X, LIVE_Y + halfH + GUTTER, halfW, halfH),                           // top-left
      P(LIVE_X + halfW + GUTTER, LIVE_Y + halfH + GUTTER, halfW, halfH),          // top-right
      P(LIVE_X, LIVE_Y, halfW, halfH),                                             // bottom-left
      P(LIVE_X + halfW + GUTTER, LIVE_Y, halfW, halfH),                           // bottom-right
    ],
  },

  HERO_4: {
    name: 'HERO_4',
    panelCount: 4,
    description: 'One large hero panel + three small — focus with context',
    panels: (() => {
      const heroW = LIVE_W * 0.6;
      const sideW = LIVE_W - heroW - GUTTER;
      const sideH = (LIVE_H - GUTTER * 2) / 3;
      return [
        P(LIVE_X, LIVE_Y, heroW, LIVE_H),                                              // large left hero
        P(LIVE_X + heroW + GUTTER, LIVE_Y + sideH * 2 + GUTTER * 2, sideW, sideH),    // top-right
        P(LIVE_X + heroW + GUTTER, LIVE_Y + sideH + GUTTER, sideW, sideH),             // mid-right
        P(LIVE_X + heroW + GUTTER, LIVE_Y, sideW, sideH),                              // bottom-right
      ];
    })(),
  },

  // ──────────────────────────────────────────────
  // 5 panels
  // ──────────────────────────────────────────────

  STRIP_5: {
    name: 'STRIP_5',
    panelCount: 5,
    description: 'Two panels top, three bottom — rapid sequence',
    panels: (() => {
      const topH = LIVE_H * 0.45;
      const botH = LIVE_H - topH - GUTTER;
      const botW = (LIVE_W - GUTTER * 2) / 3;
      return [
        P(LIVE_X, LIVE_Y + botH + GUTTER, halfW, topH),                          // top-left
        P(LIVE_X + halfW + GUTTER, LIVE_Y + botH + GUTTER, halfW, topH),         // top-right
        P(LIVE_X, LIVE_Y, botW, botH),                                            // bottom-left
        P(LIVE_X + botW + GUTTER, LIVE_Y, botW, botH),                            // bottom-center
        P(LIVE_X + botW * 2 + GUTTER * 2, LIVE_Y, botW, botH),                    // bottom-right
      ];
    })(),
  },

  ACTION_5: {
    name: 'ACTION_5',
    panelCount: 5,
    description: 'Dynamic asymmetric five-panel layout',
    panels: (() => {
      const topH = LIVE_H * 0.38;
      const botH = LIVE_H - topH - GUTTER;
      const topThirdW = (LIVE_W - GUTTER * 2) / 3;
      return [
        P(LIVE_X, LIVE_Y + botH + GUTTER, topThirdW, topH),                          // top-left small
        P(LIVE_X + topThirdW + GUTTER, LIVE_Y + botH + GUTTER, topThirdW * 2 + GUTTER, topH),  // top-right wide
        P(LIVE_X, LIVE_Y, LIVE_W * 0.5 - GUTTER / 2, botH),                          // bottom-left
        P(LIVE_X + LIVE_W * 0.5 + GUTTER / 2, LIVE_Y + botH * 0.45 + GUTTER, LIVE_W * 0.5 - GUTTER / 2, botH * 0.55), // mid-right
        P(LIVE_X + LIVE_W * 0.5 + GUTTER / 2, LIVE_Y, LIVE_W * 0.5 - GUTTER / 2, botH * 0.45),  // bottom-right
      ];
    })(),
  },

  // ──────────────────────────────────────────────
  // 6 panels
  // ──────────────────────────────────────────────

  DIALOGUE_6: {
    name: 'DIALOGUE_6',
    panelCount: 6,
    description: 'Three rows of two — rapid conversation or montage',
    panels: (() => {
      const rowH = (LIVE_H - GUTTER * 2) / 3;
      return [
        P(LIVE_X, LIVE_Y + rowH * 2 + GUTTER * 2, halfW, rowH),                           // top-left
        P(LIVE_X + halfW + GUTTER, LIVE_Y + rowH * 2 + GUTTER * 2, halfW, rowH),          // top-right
        P(LIVE_X, LIVE_Y + rowH + GUTTER, halfW, rowH),                                    // mid-left
        P(LIVE_X + halfW + GUTTER, LIVE_Y + rowH + GUTTER, halfW, rowH),                  // mid-right
        P(LIVE_X, LIVE_Y, halfW, rowH),                                                     // bottom-left
        P(LIVE_X + halfW + GUTTER, LIVE_Y, halfW, rowH),                                   // bottom-right
      ];
    })(),
  },
};

/** Get a template by name. Falls back to GRID_2x2 if unknown. */
function getTemplate(name) {
  return TEMPLATES[name] || TEMPLATES.GRID_2x2;
}

/** List all available template names. */
function getTemplateNames() {
  return Object.keys(TEMPLATES);
}

module.exports = {
  TEMPLATES,
  getTemplate,
  getTemplateNames,
  pickAspect,
  PAGE_W,
  PAGE_H,
  MARGIN,
  GUTTER,
  LIVE_X,
  LIVE_Y,
  LIVE_W,
  LIVE_H,
};
