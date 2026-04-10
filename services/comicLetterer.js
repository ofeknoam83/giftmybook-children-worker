'use strict';

const { rgb } = require('pdf-lib');
const { countWords } = require('./graphicNovelQa');

const COLORS = {
  white: rgb(1, 1, 1),
  black: rgb(0.08, 0.08, 0.12),
  ink: rgb(0.12, 0.12, 0.16),
  shadow: rgb(0.72, 0.72, 0.72),
  captionBg: rgb(0.08, 0.10, 0.18),
  captionText: rgb(0.97, 0.97, 0.99),
  captionBorder: rgb(0.765, 0.549, 0.180), // gold
  locationBg: rgb(0.97, 0.95, 0.90),
  locationBorder: rgb(0.35, 0.35, 0.40),
  noteBg: rgb(0.98, 0.95, 0.83),
  noteAccent: rgb(0.765, 0.549, 0.180),
  shoutFill: rgb(1, 1, 0.92),
  whisperBorder: rgb(0.55, 0.55, 0.60),
  // SFX style colors
  sfxImpactFill: rgb(1, 0.15, 0.05),
  sfxImpactOutline: rgb(0.08, 0.08, 0.12),
  sfxAiryFill: rgb(0.50, 0.80, 1),
  sfxAiryOutline: rgb(1, 1, 1),
  sfxElectricFill: rgb(1, 0.95, 0.20),
  sfxElectricOutline: rgb(0.15, 0.20, 0.70),
  sfxMagicFill: rgb(0.75, 0.30, 0.95),
  sfxMagicOutline: rgb(0.765, 0.549, 0.180),
};

// ── Text helpers ────────────────────────────────────────────────────────────

function wrapText(text, font, size, maxW) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(next, size) > maxW) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ── Bubble shape primitives ─────────────────────────────────────────────────

function drawFilledTail(page, from, to, fillColor, borderColor) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
  const ux = dx / length;
  const uy = dy / length;
  const spread = 6;
  const perpX = -uy * spread;
  const perpY = ux * spread;
  const base1 = { x: from.x + perpX, y: from.y + perpY };
  const base2 = { x: from.x - perpX, y: from.y - perpY };
  // Fill the tail triangle with closely-spaced lines
  const FILL_STEPS = 14;
  for (let s = 0; s <= FILL_STEPS; s++) {
    const f = s / FILL_STEPS;
    page.drawLine({
      start: { x: base1.x + (to.x - base1.x) * f, y: base1.y + (to.y - base1.y) * f },
      end: { x: base2.x + (to.x - base2.x) * f, y: base2.y + (to.y - base2.y) * f },
      thickness: 1.8, color: fillColor,
    });
  }
  // Outline edges
  page.drawLine({ start: base1, end: to, thickness: 1.5, color: borderColor });
  page.drawLine({ start: base2, end: to, thickness: 1.5, color: borderColor });
}

function drawThoughtTrail(page, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const sizes = [5, 3.5, 2.2];
  for (let i = 0; i < sizes.length; i++) {
    const t = 0.25 + (i * 0.25);
    const px = from.x + dx * t;
    const py = from.y + dy * t;
    page.drawEllipse({
      x: px, y: py,
      xScale: sizes[i], yScale: sizes[i],
      color: COLORS.white,
      borderColor: COLORS.ink,
      borderWidth: 1.2,
    });
  }
}

function drawCloudBubble(page, cx, cy, rx, ry) {
  // Draw shadow
  const so = 2;
  const bumps = 8;
  for (let i = 0; i < bumps; i++) {
    const angle = (i / bumps) * Math.PI * 2;
    const bumpRx = rx * 0.42;
    const bumpRy = ry * 0.48;
    const bx = cx + so + Math.cos(angle) * (rx - bumpRx * 0.4);
    const by = cy - so + Math.sin(angle) * (ry - bumpRy * 0.4);
    page.drawEllipse({ x: bx, y: by, xScale: bumpRx, yScale: bumpRy, color: COLORS.shadow, borderWidth: 0 });
  }
  page.drawEllipse({ x: cx + so, y: cy - so, xScale: rx * 0.7, yScale: ry * 0.7, color: COLORS.shadow, borderWidth: 0 });

  // Draw cloud bumps (overlapping circles) — white fill
  for (let i = 0; i < bumps; i++) {
    const angle = (i / bumps) * Math.PI * 2;
    const bumpRx = rx * 0.42;
    const bumpRy = ry * 0.48;
    const bx = cx + Math.cos(angle) * (rx - bumpRx * 0.4);
    const by = cy + Math.sin(angle) * (ry - bumpRy * 0.4);
    page.drawEllipse({ x: bx, y: by, xScale: bumpRx, yScale: bumpRy, color: COLORS.white, borderColor: COLORS.ink, borderWidth: 1.2 });
  }
  // White center fill to cover inner borders
  page.drawEllipse({ x: cx, y: cy, xScale: rx * 0.7, yScale: ry * 0.7, color: COLORS.white, borderWidth: 0 });
}

function drawStarburstBubble(page, cx, cy, rx, ry) {
  // Starburst / jagged shout bubble
  const points = 12;
  const innerR = 0.72;
  const shadow = 2;

  // Draw shadow spikes
  for (let i = 0; i < points; i++) {
    const a1 = (i / points) * Math.PI * 2;
    const a2 = ((i + 0.5) / points) * Math.PI * 2;
    const a3 = ((i + 1) / points) * Math.PI * 2;
    const outer = { x: cx + shadow + Math.cos(a1) * rx, y: cy - shadow + Math.sin(a1) * ry };
    const inner = { x: cx + shadow + Math.cos(a2) * rx * innerR, y: cy - shadow + Math.sin(a2) * ry * innerR };
    const next = { x: cx + shadow + Math.cos(a3) * rx, y: cy - shadow + Math.sin(a3) * ry };
    page.drawLine({ start: outer, end: inner, thickness: 4, color: COLORS.shadow });
    page.drawLine({ start: inner, end: next, thickness: 4, color: COLORS.shadow });
  }

  // Fill center with yellow tint
  page.drawEllipse({ x: cx, y: cy, xScale: rx * innerR, yScale: ry * innerR, color: COLORS.shoutFill, borderWidth: 0 });

  // Draw spikes
  for (let i = 0; i < points; i++) {
    const a1 = (i / points) * Math.PI * 2;
    const a2 = ((i + 0.5) / points) * Math.PI * 2;
    const a3 = ((i + 1) / points) * Math.PI * 2;
    const outer = { x: cx + Math.cos(a1) * rx, y: cy + Math.sin(a1) * ry };
    const inner = { x: cx + Math.cos(a2) * rx * innerR, y: cy + Math.sin(a2) * ry * innerR };
    const next = { x: cx + Math.cos(a3) * rx, y: cy + Math.sin(a3) * ry };
    // Fill between spikes
    page.drawLine({ start: outer, end: inner, thickness: 3, color: COLORS.shoutFill });
    page.drawLine({ start: inner, end: next, thickness: 3, color: COLORS.shoutFill });
    // Outline
    page.drawLine({ start: outer, end: inner, thickness: 2, color: COLORS.ink });
    page.drawLine({ start: inner, end: next, thickness: 2, color: COLORS.ink });
  }
}

function drawDashedEllipse(page, cx, cy, rx, ry, color) {
  // Simulate dashed ellipse border using short line segments
  const segments = 36;
  const dashRatio = 0.55;
  for (let i = 0; i < segments; i++) {
    const t0 = (i / segments) * Math.PI * 2;
    const t1 = ((i + dashRatio) / segments) * Math.PI * 2;
    const start = { x: cx + Math.cos(t0) * rx, y: cy + Math.sin(t0) * ry };
    const end = { x: cx + Math.cos(t1) * rx, y: cy + Math.sin(t1) * ry };
    page.drawLine({ start, end, thickness: 1, color });
  }
}

// ── Anchor positioning ──────────────────────────────────────────────────────

function anchorPoint(rect, anchor) {
  const map = {
    left: { x: rect.x + rect.w * 0.18, y: rect.y + rect.h * 0.48 },
    right: { x: rect.x + rect.w * 0.82, y: rect.y + rect.h * 0.48 },
    center: { x: rect.x + rect.w * 0.50, y: rect.y + rect.h * 0.55 },
    'top-left': { x: rect.x + rect.w * 0.22, y: rect.y + rect.h * 0.75 },
    'top-right': { x: rect.x + rect.w * 0.78, y: rect.y + rect.h * 0.75 },
    'bottom-left': { x: rect.x + rect.w * 0.22, y: rect.y + rect.h * 0.28 },
    'bottom-right': { x: rect.x + rect.w * 0.78, y: rect.y + rect.h * 0.28 },
  };
  return map[anchor] || map.left;
}

function balloonOrigin(rect, idx, total, textFreeZone) {
  const verticalOffset = idx * 0.18;
  switch (textFreeZone) {
    case 'upper-band':
      return { x: rect.x + rect.w * 0.50, y: rect.y + rect.h * (0.83 - verticalOffset) };
    case 'top-left':
      return { x: rect.x + rect.w * 0.30, y: rect.y + rect.h * (0.78 - verticalOffset) };
    case 'left-side':
      return { x: rect.x + rect.w * 0.28, y: rect.y + rect.h * (0.62 - verticalOffset) };
    case 'right-side':
    case 'top-right':
    default:
      return { x: rect.x + rect.w * 0.72, y: rect.y + rect.h * (0.78 - verticalOffset) };
  }
}

// ── Speech balloons ─────────────────────────────────────────────────────────

function drawBalloon(page, balloon, panelRect, safeRect, fonts, index, total) {
  const type = balloon.type || 'speech';
  const font = type === 'whisper' ? fonts.captionFont : fonts.dialogueFont;
  const fontSize = type === 'shout' ? 12.5 : type === 'whisper' ? 9 : 11;
  const maxWidth = safeRect.w * 0.44;
  const lines = wrapText(balloon.text, font, fontSize, maxWidth);
  const lineHeight = fontSize * 1.35;
  const textWidth = Math.max(55, ...lines.map((line) => font.widthOfTextAtSize(line, fontSize)));
  const textHeight = Math.max(lineHeight, lines.length * lineHeight);
  const padX = type === 'shout' ? 28 : 24;
  const padY = type === 'shout' ? 22 : 18;
  const bubbleW = textWidth + padX;
  const bubbleH = textHeight + padY;
  const origin = balloonOrigin(safeRect, index, total, panelRect.textFreeZone || 'top-right');
  const cx = Math.max(safeRect.x + bubbleW / 2, Math.min(safeRect.x + safeRect.w - bubbleW / 2, origin.x));
  const cy = Math.max(safeRect.y + bubbleH / 2, Math.min(safeRect.y + safeRect.h - bubbleH / 2, origin.y));
  const rx = bubbleW / 2;
  const ry = bubbleH / 2;

  const speakerPoint = anchorPoint(panelRect.rect || panelRect, balloon.anchor || 'left');
  const tailFrom = { x: cx + (speakerPoint.x < cx ? -rx * 0.55 : rx * 0.55), y: cy - ry * 0.15 };

  if (type === 'thought') {
    drawCloudBubble(page, cx, cy, rx + 6, ry + 4);
    drawThoughtTrail(page, tailFrom, speakerPoint);
  } else if (type === 'shout') {
    drawStarburstBubble(page, cx, cy, rx + 8, ry + 6);
    drawFilledTail(page, tailFrom, speakerPoint, COLORS.shoutFill, COLORS.ink);
  } else if (type === 'whisper') {
    // Drop shadow
    page.drawEllipse({ x: cx + 2, y: cy - 2, xScale: rx, yScale: ry, color: COLORS.shadow, borderWidth: 0 });
    // White fill (no solid border)
    page.drawEllipse({ x: cx, y: cy, xScale: rx, yScale: ry, color: COLORS.white, borderWidth: 0 });
    // Dashed border
    drawDashedEllipse(page, cx, cy, rx, ry, COLORS.whisperBorder);
    drawFilledTail(page, tailFrom, speakerPoint, COLORS.white, COLORS.whisperBorder);
  } else {
    // Standard speech bubble with drop shadow
    page.drawEllipse({ x: cx + 2, y: cy - 2, xScale: rx, yScale: ry, color: COLORS.shadow, borderWidth: 0 });
    page.drawEllipse({ x: cx, y: cy, xScale: rx, yScale: ry, color: COLORS.white, borderColor: COLORS.ink, borderWidth: 1.8 });
    drawFilledTail(page, tailFrom, speakerPoint, COLORS.white, COLORS.ink);
  }

  // Render text centered in bubble
  const textColor = type === 'whisper' ? rgb(0.30, 0.30, 0.35) : COLORS.black;
  let textY = cy + (lines.length * lineHeight) / 2 - fontSize;
  for (const line of lines) {
    const width = font.widthOfTextAtSize(line, fontSize);
    page.drawText(line, {
      x: cx - width / 2,
      y: textY,
      size: fontSize,
      font,
      color: textColor,
    });
    textY -= lineHeight;
  }
}

// ── Captions ────────────────────────────────────────────────────────────────

function captionBoxRect(safeRect, caption, idx) {
  const height = 30;
  const yTop = safeRect.y + safeRect.h - (idx + 1) * (height + 6);
  if (caption.placement === 'bottom-band') return { x: safeRect.x, y: safeRect.y + idx * (height + 6), w: safeRect.w, h: height };
  if (caption.placement === 'top-left-box') return { x: safeRect.x, y: yTop, w: safeRect.w * 0.58, h: height };
  if (caption.placement === 'top-right-box') return { x: safeRect.x + safeRect.w * 0.42, y: yTop, w: safeRect.w * 0.58, h: height };
  return { x: safeRect.x, y: yTop, w: safeRect.w, h: height };
}

function drawCaption(page, caption, safeRect, fonts, idx) {
  const isLocation = caption.type === 'location_time';
  const isMonologue = caption.type === 'internal_monologue';
  const font = fonts.captionFont;
  const fontSize = isLocation ? 9 : 10;
  const rect = captionBoxRect(safeRect, caption, idx);
  const padX = 10;
  const padY = 8;

  if (isMonologue) {
    // Internal monologue — yellow bg with gold left accent bar
    page.drawRectangle({ x: rect.x, y: rect.y, width: rect.w, height: rect.h, color: COLORS.noteBg, borderColor: COLORS.noteAccent, borderWidth: 0.5 });
    page.drawRectangle({ x: rect.x, y: rect.y, width: 2.5, height: rect.h, color: COLORS.noteAccent });
    const lines = wrapText(caption.text, font, fontSize, rect.w - padX * 2 - 4).slice(0, 2);
    let y = rect.y + rect.h - padY - fontSize;
    for (const line of lines) {
      page.drawText(line, { x: rect.x + padX + 4, y, size: fontSize, font, color: COLORS.black });
      y -= fontSize * 1.3;
    }
  } else if (isLocation) {
    // Location/time — light cream bg with thin dark border
    page.drawRectangle({ x: rect.x, y: rect.y, width: rect.w, height: rect.h, color: COLORS.locationBg, borderColor: COLORS.locationBorder, borderWidth: 0.8 });
    const lines = wrapText(caption.text, font, fontSize, rect.w - padX * 2).slice(0, 2);
    let y = rect.y + rect.h - padY - fontSize;
    for (const line of lines) {
      page.drawText(line, { x: rect.x + padX, y, size: fontSize, font, color: COLORS.black });
      y -= fontSize * 1.3;
    }
  } else {
    // Narration — dark blue bg with gold top border
    page.drawRectangle({ x: rect.x, y: rect.y, width: rect.w, height: rect.h, color: COLORS.captionBg, borderColor: COLORS.captionBg, borderWidth: 0.3 });
    page.drawRectangle({ x: rect.x, y: rect.y + rect.h - 1.5, width: rect.w, height: 1.5, color: COLORS.captionBorder });
    const lines = wrapText(caption.text, font, fontSize, rect.w - padX * 2).slice(0, 2);
    let y = rect.y + rect.h - padY - fontSize;
    for (const line of lines) {
      page.drawText(line, { x: rect.x + padX, y, size: fontSize, font, color: COLORS.captionText });
      y -= fontSize * 1.3;
    }
  }
}

// ── Sound Effects ───────────────────────────────────────────────────────────

const SFX_STYLES = {
  impact: { fill: 'sfxImpactFill', outline: 'sfxImpactOutline', size: 20 },
  airy: { fill: 'sfxAiryFill', outline: 'sfxAiryOutline', size: 14 },
  electric: { fill: 'sfxElectricFill', outline: 'sfxElectricOutline', size: 16 },
  magic: { fill: 'sfxMagicFill', outline: 'sfxMagicOutline', size: 16 },
};

function drawSfx(page, sfx, rect, fonts, idx) {
  const font = fonts.sfxFont;
  const text = String(sfx.text || '').trim();
  if (!text) return;
  const style = SFX_STYLES[sfx.style] || SFX_STYLES.impact;
  const size = rect.w < 140 ? Math.max(12, style.size - 4) : style.size;
  const fillColor = COLORS[style.fill];
  const outlineColor = COLORS[style.outline];

  let x = rect.x + rect.w * 0.10;
  let y = rect.y + rect.h * 0.20;
  if (sfx.placement === 'background-right') x = rect.x + rect.w * 0.58;
  if (sfx.placement === 'foreground') y = rect.y + rect.h * 0.10;
  if (sfx.placement === 'mid-action') y = rect.y + rect.h * 0.40;
  y += idx * 5;

  // Outline effect — draw text at 4 offsets then fill on top
  const outlineOff = 1.2;
  const offsets = [
    { dx: -outlineOff, dy: 0 }, { dx: outlineOff, dy: 0 },
    { dx: 0, dy: -outlineOff }, { dx: 0, dy: outlineOff },
  ];
  for (const off of offsets) {
    page.drawText(text, { x: x + off.dx, y: y + off.dy, size, font, color: outlineColor });
  }
  page.drawText(text, { x, y, size, font, color: fillColor });
}

// ── Panel lettering assembly ────────────────────────────────────────────────

function renderPanelLettering(page, panel, blueprint, fonts) {
  const safeRect = blueprint.safeRect;
  const balloons = (panel.balloons || []).filter((balloon) => balloon.text);
  const captions = (panel.captions || []).filter((caption) => caption.text);
  const sfx = (panel.sfx || []).filter((item) => item.text);

  captions.forEach((caption, idx) => drawCaption(page, caption, safeRect, fonts, idx));
  balloons
    .slice()
    .sort((a, b) => a.order - b.order)
    .forEach((balloon, idx, arr) => drawBalloon(page, balloon, blueprint, safeRect, fonts, idx, arr.length));
  sfx.forEach((item, idx) => drawSfx(page, item, blueprint.rect, fonts, idx));
}

function scorePanelReadability(panel) {
  const balloons = panel.balloons || [];
  const captions = panel.captions || [];
  const textWords = countWords(`${panel.dialogue || ''} ${panel.caption || ''}`.trim());
  let score = 100;
  score -= Math.max(0, textWords - 22) * 2;
  score -= Math.max(0, balloons.length - 2) * 10;
  score -= Math.max(0, captions.length - 2) * 8;
  return Math.max(0, score);
}

module.exports = {
  renderPanelLettering,
  scorePanelReadability,
};
