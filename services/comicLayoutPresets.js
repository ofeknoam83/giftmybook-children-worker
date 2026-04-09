'use strict';

const BLEED_PT = 9;
const OUTER_SAFE_PT = 27;
const INNER_SAFE_PT = 36;
const PANEL_GUTTER_PT = 10;

function createRect(x, y, w, h) {
  return { x, y, w, h };
}

function insetRect(rect, top, right = top, bottom = top, left = right) {
  return createRect(
    rect.x + left,
    rect.y + bottom,
    Math.max(1, rect.w - left - right),
    Math.max(1, rect.h - top - bottom)
  );
}

function trimRectForPage(pageW, pageH) {
  return createRect(BLEED_PT, BLEED_PT, pageW - BLEED_PT * 2, pageH - BLEED_PT * 2);
}

function contentRectForPage(pageW, pageH) {
  const trim = trimRectForPage(pageW, pageH);
  return insetRect(trim, OUTER_SAFE_PT, OUTER_SAFE_PT, OUTER_SAFE_PT, OUTER_SAFE_PT);
}

function safeRectForPanel(rect, isLeftPage, isRightPage) {
  const innerInset = isLeftPage ? OUTER_SAFE_PT : (isRightPage ? INNER_SAFE_PT : OUTER_SAFE_PT);
  const outerInset = isLeftPage ? INNER_SAFE_PT : OUTER_SAFE_PT;
  return insetRect(rect, 18, outerInset, 18, innerInset);
}

function blueprintPanel(rect, panel, page, pageIndex, panelIndex) {
  const isLeftPage = pageIndex % 2 === 0;
  const isRightPage = !isLeftPage;
  return {
    index: panelIndex,
    panelNumber: panel.panelNumber,
    rect,
    artRect: rect,
    safeRect: safeRectForPanel(rect, isLeftPage, isRightPage),
    textFreeZone: panel.textFreeZone || 'top-right',
    safeTextZones: Array.isArray(panel.safeTextZones) ? panel.safeTextZones : [],
  };
}

function buildPanelRects(layoutTemplate, content) {
  const rects = [];
  const g = PANEL_GUTTER_PT;

  if (layoutTemplate === 'fullBleedSplash') {
    rects.push(createRect(content.x, content.y, content.w, content.h));
    return rects;
  }

  if (layoutTemplate === 'cinematicTopStrip') {
    const stripH = content.h * 0.24;
    const lowerH = content.h - stripH - g;
    const halfW = (content.w - g) / 2;
    rects.push(createRect(content.x, content.y + lowerH + g, content.w, stripH));
    rects.push(createRect(content.x, content.y, halfW, lowerH));
    rects.push(createRect(content.x + halfW + g, content.y, halfW, lowerH));
    return rects;
  }

  if (layoutTemplate === 'heroTopTwoBottom') {
    const heroH = content.h * 0.58;
    const lowerH = content.h - heroH - g;
    const halfW = (content.w - g) / 2;
    rects.push(createRect(content.x, content.y + lowerH + g, content.w, heroH));
    rects.push(createRect(content.x, content.y, halfW, lowerH));
    rects.push(createRect(content.x + halfW + g, content.y, halfW, lowerH));
    return rects;
  }

  if (layoutTemplate === 'twoTierEqual') {
    const panelH = (content.h - g) / 2;
    rects.push(createRect(content.x, content.y + panelH + g, content.w, panelH));
    rects.push(createRect(content.x, content.y, content.w, panelH));
    return rects;
  }

  if (layoutTemplate === 'fourGrid') {
    const panelW = (content.w - g) / 2;
    const panelH = (content.h - g) / 2;
    rects.push(createRect(content.x, content.y + panelH + g, panelW, panelH));
    rects.push(createRect(content.x + panelW + g, content.y + panelH + g, panelW, panelH));
    rects.push(createRect(content.x, content.y, panelW, panelH));
    rects.push(createRect(content.x + panelW + g, content.y, panelW, panelH));
    return rects;
  }

  const panelH = (content.h - g * 2) / 3;
  rects.push(createRect(content.x, content.y + (panelH + g) * 2, content.w, panelH));
  rects.push(createRect(content.x, content.y + panelH + g, content.w, panelH));
  rects.push(createRect(content.x, content.y, content.w, panelH));
  return rects;
}

function buildGraphicNovelPageBlueprint(page, pageIndex, pageW, pageH) {
  const trimRect = trimRectForPage(pageW, pageH);
  const contentRect = contentRectForPage(pageW, pageH);
  const layoutTemplate = page.layoutTemplate || 'conversationGrid';
  const rawRects = buildPanelRects(layoutTemplate, contentRect);
  const panelBlueprints = rawRects.slice(0, (page.panels || []).length).map((rect, idx) =>
    blueprintPanel(rect, page.panels[idx], page, pageIndex, idx)
  );

  return {
    pageNumber: page.pageNumber,
    layoutTemplate,
    trimRect,
    contentRect,
    panelBlueprints,
  };
}

function buildGraphicNovelBlueprints(pages, pageW, pageH) {
  return (pages || []).map((page, index) => buildGraphicNovelPageBlueprint(page, index, pageW, pageH));
}

module.exports = {
  BLEED_PT,
  OUTER_SAFE_PT,
  INNER_SAFE_PT,
  PANEL_GUTTER_PT,
  buildGraphicNovelBlueprints,
  buildGraphicNovelPageBlueprint,
};
