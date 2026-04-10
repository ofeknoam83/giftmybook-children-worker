'use strict';

/**
 * Speech bubble, caption box, and SFX renderer for graphic novel PDFs.
 *
 * Uses pdf-lib's drawSvgPath + drawRectangle + drawText for
 * professional comic-style lettering overlaid on panel illustrations.
 */

const { rgb } = require('pdf-lib');

// ── Color constants ──
const BLACK = rgb(0.05, 0.05, 0.1);
const WHITE = rgb(1, 1, 1);
const CAPTION_BG = rgb(0.15, 0.2, 0.35);
const SFX_COLOR = rgb(0.95, 0.25, 0.15);
const SHOUT_STROKE = rgb(0.9, 0.1, 0.1);
const WHISPER_STROKE = rgb(0.5, 0.5, 0.55);
const THOUGHT_STROKE = rgb(0.2, 0.2, 0.25);

// ── Bubble geometry ──
const BUBBLE_PAD_X = 10;
const BUBBLE_PAD_Y = 7;
const BUBBLE_RADIUS = 8;
const BUBBLE_STROKE_W = 1.5;
const TAIL_WIDTH = 12;
const TAIL_HEIGHT = 14;

/**
 * Build an SVG path string for a rounded rectangle.
 * Origin is bottom-left in PDF coordinates.
 */
function roundedRectPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  // PDF y-axis: y is bottom, y+h is top
  return [
    `M ${x + r} ${y}`,
    `L ${x + w - r} ${y}`,
    `Q ${x + w} ${y} ${x + w} ${y + r}`,
    `L ${x + w} ${y + h - r}`,
    `Q ${x + w} ${y + h} ${x + w - r} ${y + h}`,
    `L ${x + r} ${y + h}`,
    `Q ${x} ${y + h} ${x} ${y + h - r}`,
    `L ${x} ${y + r}`,
    `Q ${x} ${y} ${x + r} ${y}`,
    'Z',
  ].join(' ');
}

/**
 * Wrap text into lines that fit within maxWidth.
 */
function wrapLines(text, font, fontSize, maxWidth) {
  if (!text || !text.trim()) return [];
  const words = text.trim().split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(test, fontSize) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Measure the bubble dimensions needed for given text.
 */
function measureBubble(text, font, fontSize, maxTextWidth) {
  const lines = wrapLines(text, font, fontSize, maxTextWidth);
  const lineH = fontSize * 1.35;
  const textW = lines.length > 0
    ? Math.max(...lines.map(l => font.widthOfTextAtSize(l, fontSize)))
    : 0;
  const textH = lines.length * lineH;
  return {
    lines,
    lineH,
    bubW: textW + BUBBLE_PAD_X * 2,
    bubH: textH + BUBBLE_PAD_Y * 2,
  };
}

/**
 * Draw a speech bubble with rounded corners and a triangular tail.
 *
 * @param {PDFPage} page
 * @param {string} text - Dialogue text (will be ALL-CAPS for speech/shout)
 * @param {number} bx - Bubble center X in page coords
 * @param {number} by - Bubble bottom Y in page coords
 * @param {object} font - Embedded PDF font
 * @param {object} opts
 * @param {string} opts.type - 'speech'|'thought'|'shout'|'whisper'
 * @param {string} opts.tailDirection - 'down'|'up'|'none'
 * @param {number} opts.tailTargetX - X coord where tail points to
 * @param {number} opts.tailTargetY - Y coord where tail points to
 * @param {number} [opts.maxWidth=140] - Max text width
 * @param {number} [opts.fontSize=9] - Font size
 */
function drawSpeechBubble(page, text, bx, by, font, opts = {}) {
  const type = opts.type || 'speech';
  const fontSize = opts.fontSize || 9;
  const maxTextW = opts.maxWidth || 140;

  // Format text
  const displayText = (type === 'speech' || type === 'shout') ? text.toUpperCase() : text;
  const { lines, lineH, bubW, bubH } = measureBubble(displayText, font, fontSize, maxTextW);
  if (lines.length === 0) return { bubW: 0, bubH: 0 };

  // Position bubble — bx is center, by is bottom
  const bubX = bx - bubW / 2;
  const bubY = by;

  // Style by type
  let strokeColor = BLACK;
  let strokeWidth = BUBBLE_STROKE_W;
  let fillColor = WHITE;
  let textColor = BLACK;

  if (type === 'shout') {
    strokeWidth = 2.5;
    strokeColor = BLACK;
  } else if (type === 'whisper') {
    strokeColor = WHISPER_STROKE;
    strokeWidth = 1;
  } else if (type === 'thought') {
    strokeColor = THOUGHT_STROKE;
    strokeWidth = 1.2;
  }

  // Draw bubble background (rounded rect)
  const path = roundedRectPath(bubX, bubY, bubW, bubH, BUBBLE_RADIUS);
  page.drawSvgPath(path, {
    color: fillColor,
    borderColor: strokeColor,
    borderWidth: strokeWidth,
  });

  // Draw tail (triangle pointing toward speaker)
  const tailDir = opts.tailDirection || 'down';
  if (tailDir !== 'none') {
    const tailTargetX = opts.tailTargetX !== undefined ? opts.tailTargetX : bx;
    const tailTargetY = opts.tailTargetY !== undefined ? opts.tailTargetY : (tailDir === 'down' ? bubY - TAIL_HEIGHT : bubY + bubH + TAIL_HEIGHT);

    let tailBaseY, tailBaseLeftX, tailBaseRightX;
    if (tailDir === 'down') {
      tailBaseY = bubY;
      tailBaseLeftX = Math.max(bubX + BUBBLE_RADIUS, bx - TAIL_WIDTH / 2);
      tailBaseRightX = Math.min(bubX + bubW - BUBBLE_RADIUS, bx + TAIL_WIDTH / 2);
    } else {
      tailBaseY = bubY + bubH;
      tailBaseLeftX = Math.max(bubX + BUBBLE_RADIUS, bx - TAIL_WIDTH / 2);
      tailBaseRightX = Math.min(bubX + bubW - BUBBLE_RADIUS, bx + TAIL_WIDTH / 2);
    }

    // White fill triangle to cover the border at the base
    const tailPath = `M ${tailBaseLeftX} ${tailBaseY} L ${tailTargetX} ${tailTargetY} L ${tailBaseRightX} ${tailBaseY} Z`;
    page.drawSvgPath(tailPath, { color: fillColor });
    // Border lines
    page.drawLine({
      start: { x: tailBaseLeftX, y: tailBaseY },
      end: { x: tailTargetX, y: tailTargetY },
      thickness: strokeWidth, color: strokeColor,
    });
    page.drawLine({
      start: { x: tailBaseRightX, y: tailBaseY },
      end: { x: tailTargetX, y: tailTargetY },
      thickness: strokeWidth, color: strokeColor,
    });
  }

  // Thought bubble: draw small trailing circles instead of tail
  if (type === 'thought' && opts.tailDirection !== 'none') {
    const tx = opts.tailTargetX !== undefined ? opts.tailTargetX : bx;
    const ty = opts.tailTargetY !== undefined ? opts.tailTargetY : bubY - TAIL_HEIGHT * 1.5;
    const midX = (bx + tx) / 2;
    const midY = (bubY + ty) / 2;
    // Three decreasing circles
    page.drawCircle({ x: bx, y: bubY - 4, size: 4, color: fillColor, borderColor: strokeColor, borderWidth: 1 });
    page.drawCircle({ x: midX, y: midY + 4, size: 3, color: fillColor, borderColor: strokeColor, borderWidth: 1 });
    page.drawCircle({ x: tx, y: ty + 4, size: 2, color: fillColor, borderColor: strokeColor, borderWidth: 1 });
  }

  // Draw text lines — centered within bubble
  for (let i = 0; i < lines.length; i++) {
    const lineW = font.widthOfTextAtSize(lines[i], fontSize);
    const lx = bubX + (bubW - lineW) / 2;
    // PDF text y = baseline. Top line starts at top of bubble minus padding.
    const ly = bubY + bubH - BUBBLE_PAD_Y - (i + 1) * lineH + lineH * 0.3;
    page.drawText(lines[i], {
      x: lx, y: ly, size: fontSize, font, color: textColor,
    });
  }

  return { bubW, bubH };
}

/**
 * Draw a narrator caption box at a given position.
 *
 * @param {PDFPage} page
 * @param {string} text - Caption text
 * @param {number} x - Left X
 * @param {number} y - Bottom Y
 * @param {number} maxWidth - Available width
 * @param {object} font - Embedded PDF font
 * @param {object} [opts]
 */
function drawCaptionBox(page, text, x, y, maxWidth, font, opts = {}) {
  if (!text || !text.trim()) return { w: 0, h: 0 };
  const fontSize = opts.fontSize || 8;
  const lines = wrapLines(text, font, fontSize, maxWidth - 14);
  const lineH = fontSize * 1.4;
  const boxH = lines.length * lineH + 10;
  const boxW = maxWidth;

  // Background rectangle
  const bgColor = opts.bgColor || CAPTION_BG;
  page.drawRectangle({
    x, y, width: boxW, height: boxH,
    color: bgColor, opacity: 0.88,
  });

  // Text — left-aligned with padding
  for (let i = 0; i < lines.length; i++) {
    const ly = y + boxH - 6 - (i + 1) * lineH + lineH * 0.3;
    page.drawText(lines[i], {
      x: x + 7, y: ly, size: fontSize, font, color: WHITE,
    });
  }

  return { w: boxW, h: boxH };
}

/**
 * Draw a sound effect (SFX) text.
 *
 * @param {PDFPage} page
 * @param {string} text - SFX text (e.g. "BOOM", "CRACK")
 * @param {number} cx - Center X
 * @param {number} cy - Center Y
 * @param {object} font
 * @param {object} [opts]
 */
function drawSfx(page, text, cx, cy, font, opts = {}) {
  if (!text || !text.trim()) return;
  const sfxText = text.toUpperCase();
  const fontSize = opts.fontSize || 20;
  const color = opts.color || SFX_COLOR;

  const tw = font.widthOfTextAtSize(sfxText, fontSize);
  // Draw with slight rotation for dynamic feel — pdf-lib doesn't support rotate on drawText,
  // so we draw it straight but with a bold outline effect via multiple offsets
  const offsets = [
    { dx: -1, dy: -1 }, { dx: 1, dy: -1 },
    { dx: -1, dy: 1 }, { dx: 1, dy: 1 },
  ];
  // Black outline
  for (const off of offsets) {
    page.drawText(sfxText, {
      x: cx - tw / 2 + off.dx, y: cy + off.dy,
      size: fontSize, font, color: BLACK,
    });
  }
  // Colored fill
  page.drawText(sfxText, {
    x: cx - tw / 2, y: cy,
    size: fontSize, font, color,
  });
}

/**
 * Render all dialogue bubbles, captions, and SFX for a single panel.
 *
 * @param {PDFPage} page
 * @param {object} panelData - { dialogue: [], caption: string, sfx: string }
 * @param {object} panelRect - { x, y, w, h } in page coords (PDF space)
 * @param {object} font
 */
function renderPanelOverlays(page, panelData, panelRect, font) {
  const { dialogue, caption, sfx } = panelData;
  const px = panelRect.x;
  const py = panelRect.y;
  const pw = panelRect.w;
  const ph = panelRect.h;

  // ── Caption box (top of panel) ──
  if (caption && caption.trim()) {
    const captionW = Math.min(pw * 0.7, 200);
    drawCaptionBox(page, caption, px + 4, py + ph - 4 - 30, captionW, font);
  }

  // ── Dialogue bubbles ──
  if (Array.isArray(dialogue) && dialogue.length > 0) {
    let leftY = py + ph - 10;
    let rightY = py + ph - 10;
    const captionOffset = (caption && caption.trim()) ? 34 : 0;
    leftY -= captionOffset;
    rightY -= captionOffset;

    for (const entry of dialogue) {
      if (!entry.text || !entry.text.trim()) continue;

      const isRight = entry.position === 'right';
      const bubbleCenterX = isRight
        ? px + pw * 0.72
        : px + pw * 0.28;

      // Tail points toward lower center of panel (character area)
      const tailX = isRight ? px + pw * 0.6 : px + pw * 0.4;
      const currentY = isRight ? rightY : leftY;
      const tailY = currentY - 18;

      const maxBubbleW = Math.min(pw * 0.45, 150);
      const { bubH } = drawSpeechBubble(page, entry.text, bubbleCenterX, currentY - 40, font, {
        type: entry.type || 'speech',
        tailDirection: 'down',
        tailTargetX: tailX,
        tailTargetY: tailY - 20,
        maxWidth: maxBubbleW,
        fontSize: 9,
      });

      // Stack bubbles vertically
      if (isRight) {
        rightY -= (bubH + 22);
      } else {
        leftY -= (bubH + 22);
      }
    }
  }

  // ── SFX ──
  if (sfx && sfx.trim()) {
    const sfxX = px + pw * 0.5;
    const sfxY = py + ph * 0.35;
    drawSfx(page, sfx, sfxX, sfxY, font, { fontSize: Math.min(22, pw * 0.12) });
  }
}

module.exports = {
  drawSpeechBubble,
  drawCaptionBox,
  drawSfx,
  renderPanelOverlays,
  roundedRectPath,
  wrapLines,
  measureBubble,
};
