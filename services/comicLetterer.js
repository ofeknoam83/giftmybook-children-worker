'use strict';

const { rgb } = require('pdf-lib');
const { countWords } = require('./graphicNovelQa');

const COLORS = {
  white: rgb(1, 1, 1),
  black: rgb(0.08, 0.08, 0.12),
  ink: rgb(0.12, 0.12, 0.16),
  captionBg: rgb(0.09, 0.10, 0.16),
  captionText: rgb(0.97, 0.97, 0.99),
  noteBg: rgb(0.98, 0.95, 0.83),
  sfxGlow: rgb(1, 0.85, 0.30),
};

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

function drawEllipseBubble(page, cx, cy, rx, ry) {
  page.drawEllipse({
    x: cx,
    y: cy,
    xScale: rx,
    yScale: ry,
    color: COLORS.white,
    borderColor: COLORS.ink,
    borderWidth: 1.2,
  });
}

function drawRoundedBox(page, x, y, w, h, opts = {}) {
  page.drawRectangle({
    x,
    y,
    width: w,
    height: h,
    color: opts.color || COLORS.white,
    borderColor: opts.borderColor || COLORS.ink,
    borderWidth: opts.borderWidth == null ? 1 : opts.borderWidth,
  });
}

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

function drawTail(page, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
  const ux = dx / length;
  const uy = dy / length;
  const perpX = -uy * 5;
  const perpY = ux * 5;
  const base1 = { x: from.x + perpX, y: from.y + perpY };
  const base2 = { x: from.x - perpX, y: from.y - perpY };
  page.drawLine({ start: base1, end: to, thickness: 1.2, color: COLORS.ink });
  page.drawLine({ start: base2, end: to, thickness: 1.2, color: COLORS.ink });
}

function drawBalloon(page, balloon, panelRect, safeRect, fonts, index, total) {
  const font = balloon.type === 'whisper' ? fonts.captionFont : fonts.dialogueFont;
  const fontSize = balloon.type === 'shout' ? 11 : 10;
  const maxWidth = safeRect.w * 0.42;
  const lines = wrapText(balloon.text, font, fontSize, maxWidth);
  const lineHeight = fontSize * 1.35;
  const textWidth = Math.max(55, ...lines.map((line) => font.widthOfTextAtSize(line, fontSize)));
  const textHeight = Math.max(lineHeight, lines.length * lineHeight);
  const bubbleW = textWidth + 24;
  const bubbleH = textHeight + 18;
  const origin = balloonOrigin(safeRect, index, total, panelRect.textFreeZone || 'top-right');
  const cx = Math.max(safeRect.x + bubbleW / 2, Math.min(safeRect.x + safeRect.w - bubbleW / 2, origin.x));
  const cy = Math.max(safeRect.y + bubbleH / 2, Math.min(safeRect.y + safeRect.h - bubbleH / 2, origin.y));
  const rx = bubbleW / 2;
  const ry = bubbleH / 2;

  if (balloon.type === 'thought') {
    drawRoundedBox(page, cx - rx, cy - ry, bubbleW, bubbleH, { radius: 16 });
  } else {
    drawEllipseBubble(page, cx, cy, rx, ry);
  }

  const speakerPoint = anchorPoint(panelRect.rect || panelRect, balloon.anchor || 'left');
  drawTail(page, { x: cx + (speakerPoint.x < cx ? -rx * 0.55 : rx * 0.55), y: cy - ry * 0.15 }, speakerPoint);

  let textY = cy + (lines.length * lineHeight) / 2 - fontSize;
  for (const line of lines) {
    const width = font.widthOfTextAtSize(line, fontSize);
    page.drawText(line, {
      x: cx - width / 2,
      y: textY,
      size: fontSize,
      font,
      color: COLORS.black,
    });
    textY -= lineHeight;
  }
}

function captionBoxRect(safeRect, caption, idx) {
  const height = 26;
  const yTop = safeRect.y + safeRect.h - (idx + 1) * (height + 6);
  if (caption.placement === 'bottom-band') return { x: safeRect.x, y: safeRect.y + idx * (height + 6), w: safeRect.w, h: height };
  if (caption.placement === 'top-left-box') return { x: safeRect.x, y: yTop, w: safeRect.w * 0.58, h: height };
  if (caption.placement === 'top-right-box') return { x: safeRect.x + safeRect.w * 0.42, y: yTop, w: safeRect.w * 0.58, h: height };
  return { x: safeRect.x, y: yTop, w: safeRect.w, h: height };
}

function drawCaption(page, caption, safeRect, fonts, idx) {
  const font = caption.type === 'location_time' ? fonts.captionFont : fonts.dialogueFont;
  const fontSize = caption.type === 'location_time' ? 8.5 : 9;
  const rect = captionBoxRect(safeRect, caption, idx);
  const bg = caption.type === 'internal_monologue' ? COLORS.noteBg : COLORS.captionBg;
  const fg = caption.type === 'internal_monologue' ? COLORS.black : COLORS.captionText;
  drawRoundedBox(page, rect.x, rect.y, rect.w, rect.h, { radius: 4, color: bg, borderColor: bg, borderWidth: 0.2 });
  const lines = wrapText(caption.text, font, fontSize, rect.w - 12).slice(0, 2);
  let y = rect.y + rect.h - 10 - fontSize;
  for (const line of lines) {
    page.drawText(line, { x: rect.x + 6, y, size: fontSize, font, color: fg });
    y -= fontSize * 1.25;
  }
}

function drawSfx(page, sfx, rect, fonts, idx) {
  const font = fonts.sfxFont;
  const text = String(sfx.text || '').trim();
  if (!text) return;
  const size = rect.w < 140 ? 14 : 18;
  let x = rect.x + rect.w * 0.10;
  let y = rect.y + rect.h * 0.20;
  if (sfx.placement === 'background-right') x = rect.x + rect.w * 0.58;
  if (sfx.placement === 'foreground') y = rect.y + rect.h * 0.10;
  if (sfx.placement === 'mid-action') y = rect.y + rect.h * 0.40;
  page.drawText(text, {
    x,
    y: y + idx * 4,
    size,
    font,
    color: COLORS.sfxGlow,
  });
}

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
