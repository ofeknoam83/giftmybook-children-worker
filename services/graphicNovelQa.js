'use strict';

const LAYOUT_TEMPLATE_TO_PAGE_LAYOUT = {
  fullBleedSplash: 'splash',
  cinematicTopStrip: 'strip+2',
  heroTopTwoBottom: '1large+2small',
  twoTierEqual: '2equal',
  conversationGrid: '3equal',
  fourGrid: '4equal',
};

const PAGE_LAYOUT_TO_TEMPLATE = Object.entries(LAYOUT_TEMPLATE_TO_PAGE_LAYOUT)
  .reduce((acc, [template, layout]) => ({ ...acc, [layout]: template }), {});

const VALID_PANEL_TYPES = new Set(['establishing', 'action', 'dialogue', 'closeup', 'reaction', 'insert', 'splash']);
const VALID_BALLOON_TYPES = new Set(['speech', 'shout', 'whisper', 'thought']);
const VALID_CAPTION_TYPES = new Set(['narration', 'location_time', 'internal_monologue']);
const VALID_SPEAKER_POSITIONS = new Set(['left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']);
const VALID_TEXT_DENSITY = new Set(['silent', 'light', 'medium', 'heavy']);
const VALID_INTERSTITIAL_TYPES = new Set(['scene_opener', 'internal_monologue', 'letter_or_diary', 'narrator_aside']);

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function joinBalloonText(balloons) {
  return balloons.map((balloon) => balloon.text).filter(Boolean).join(' ');
}

function joinCaptionText(captions) {
  return captions.map((caption) => caption.text).filter(Boolean).join(' ');
}

function inferLayoutTemplate(page) {
  if (page.layoutTemplate && LAYOUT_TEMPLATE_TO_PAGE_LAYOUT[page.layoutTemplate]) {
    return page.layoutTemplate;
  }
  return PAGE_LAYOUT_TO_TEMPLATE[page.pageLayout] || 'conversationGrid';
}

function inferPageLayout(page) {
  if (page.pageLayout && PAGE_LAYOUT_TO_TEMPLATE[page.pageLayout]) {
    return page.pageLayout;
  }
  const template = inferLayoutTemplate(page);
  return LAYOUT_TEMPLATE_TO_PAGE_LAYOUT[template] || '3equal';
}

function normalizeBalloon(balloon, index, panel) {
  const type = VALID_BALLOON_TYPES.has(balloon?.type) ? balloon.type : 'speech';
  const anchor = VALID_SPEAKER_POSITIONS.has(balloon?.anchor) ? balloon.anchor : (panel.speakerPosition || 'left');
  const text = typeof balloon?.text === 'string' ? balloon.text.trim() : '';
  return {
    id: balloon?.id || `p${panel.sceneNumber || 1}-${panel.panelNumber || index + 1}-b${index + 1}`,
    type,
    speaker: balloon?.speaker || '',
    text,
    order: Number.isFinite(balloon?.order) ? balloon.order : index + 1,
    anchor,
  };
}

function normalizeCaption(caption, index, panel) {
  const type = VALID_CAPTION_TYPES.has(caption?.type) ? caption.type : 'narration';
  return {
    id: caption?.id || `p${panel.sceneNumber || 1}-${panel.panelNumber || index + 1}-c${index + 1}`,
    type,
    text: typeof caption?.text === 'string' ? caption.text.trim() : '',
    placement: caption?.placement || 'top-band',
  };
}

function inferTextDensity(panel) {
  const words = countWords(`${panel.caption || ''} ${panel.dialogue || ''}`.trim());
  if (words === 0) return 'silent';
  if (words <= 12) return 'light';
  return 'medium';
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function buildPanelQaIssues(panel, page, rect = null) {
  const issues = [];
  const totalWords = countWords(`${panel.caption || ''} ${panel.dialogue || ''}`.trim());
  if (page.layoutTemplate !== 'fullBleedSplash' && totalWords > 28) {
    issues.push({ type: 'text_overflow_risk', severity: 'warn', message: `Panel has ${totalWords} words.` });
  }
  if ((panel.balloons || []).length > 2 && page.layoutTemplate !== 'fullBleedSplash') {
    issues.push({ type: 'crowded_balloons', severity: 'warn', message: 'Panel has more than two balloons.' });
  }
  if (rect && rect.safeRect) {
    const safeWidth = rect.safeRect.w;
    const safeHeight = rect.safeRect.h;
    if (safeWidth < 90 || safeHeight < 90) {
      issues.push({ type: 'tiny_panel', severity: 'warn', message: 'Panel safe area is very small.' });
    }
  }
  return issues;
}

function normalizePanel(panel, page, index) {
  const panelType = VALID_PANEL_TYPES.has(panel?.panelType) ? panel.panelType : (index === 0 ? 'dialogue' : 'reaction');
  const speakerPosition = VALID_SPEAKER_POSITIONS.has(panel?.speakerPosition) ? panel.speakerPosition : 'left';
  const balloons = normalizeArray(panel?.balloons).map((item, balloonIndex) => normalizeBalloon(item, balloonIndex, { ...panel, speakerPosition }));
  const captions = normalizeArray(panel?.captions).map((item, captionIndex) => normalizeCaption(item, captionIndex, panel || {}));
  const dialogue = (typeof panel?.dialogue === 'string' && panel.dialogue.trim()) || joinBalloonText(balloons);
  const caption = (typeof panel?.caption === 'string' && panel.caption.trim()) || joinCaptionText(captions);
  const textFreeZone = panel?.textFreeZone || (captions.length ? 'upper-band' : 'top-right');
  const safeTextZones = normalizeArray(panel?.safeTextZones).filter(Boolean);

  return {
    sceneNumber: panel?.sceneNumber || page.sceneNumber || 1,
    sceneTitle: panel?.sceneTitle || page.sceneTitle || '',
    pageNumber: page.pageNumber,
    panelNumber: Number.isFinite(panel?.panelNumber) ? panel.panelNumber : index + 1,
    panelType,
    shot: panel?.shot || (panelType === 'establishing' ? 'WS' : panelType === 'closeup' ? 'CU' : 'MS'),
    cameraAngle: panel?.cameraAngle || 'eye-level',
    pacing: panel?.pacing || (panelType === 'action' ? 'fast' : 'medium'),
    actingNotes: panel?.actingNotes || '',
    backgroundComplexity: panel?.backgroundComplexity || (panelType === 'closeup' ? 'minimal' : 'simple'),
    speakerPosition,
    textFreeZone,
    safeTextZones: safeTextZones.length ? safeTextZones : [textFreeZone],
    action: panel?.action || '',
    balloons,
    captions,
    sfx: normalizeArray(panel?.sfx).filter((item) => item && item.text).map((item) => ({
      text: item.text.trim(),
      placement: item.placement || 'mid-action',
      style: item.style || 'impact',
    })),
    dialogue,
    caption,
    pageLayout: panel?.pageLayout || inferPageLayout(page),
    imagePrompt: panel?.imagePrompt || panel?.action || '',
    textDensity: panel?.textDensity || inferTextDensity({ caption, dialogue }),
    illustrationUrl: panel?.illustrationUrl || null,
    imageBuffer: panel?.imageBuffer || null,
  };
}

function normalizeGraphicNovelPlan(rawPlan, opts = {}) {
  const plan = rawPlan && typeof rawPlan === 'object' ? JSON.parse(JSON.stringify(rawPlan)) : {};
  const pages = normalizeArray(plan.pages);
  const normalizedPages = [];
  const scenesMap = new Map();

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const rawPage = pages[pageIndex] || {};
    const pageNumber = Number.isFinite(rawPage.pageNumber) ? rawPage.pageNumber : pageIndex + 1;
    const sceneNumber = Number.isFinite(rawPage.sceneNumber) ? rawPage.sceneNumber : 1;
    const pageType = rawPage.pageType === 'text_interstitial' ? 'text_interstitial' : 'illustrated';

    let normalizedPage;
    if (pageType === 'text_interstitial') {
      normalizedPage = {
        pageNumber,
        pageType,
        sceneNumber,
        sceneTitle: rawPage.sceneTitle || `Scene ${sceneNumber}`,
        interstitialType: VALID_INTERSTITIAL_TYPES.has(rawPage.interstitialType) ? rawPage.interstitialType : 'scene_opener',
        heading: typeof rawPage.heading === 'string' ? rawPage.heading.trim() : '',
        subheading: typeof rawPage.subheading === 'string' ? rawPage.subheading.trim() : '',
        bodyText: typeof rawPage.bodyText === 'string' ? rawPage.bodyText.trim() : '',
        mood: typeof rawPage.mood === 'string' ? rawPage.mood.trim() : '',
        panels: [],
        panelCount: 0,
      };
    } else {
      const layoutTemplate = inferLayoutTemplate(rawPage);
      normalizedPage = {
        pageNumber,
        pageType,
        sceneNumber,
        sceneTitle: rawPage.sceneTitle || `Scene ${sceneNumber}`,
        pagePurpose: rawPage.pagePurpose || '',
        pageTurnIntent: rawPage.pageTurnIntent || 'question',
        dominantBeat: rawPage.dominantBeat || '',
        layoutTemplate,
        pageLayout: inferPageLayout(rawPage),
        panelCount: 0,
        textDensity: VALID_TEXT_DENSITY.has(rawPage.textDensity) ? rawPage.textDensity : 'medium',
        colorScript: rawPage.colorScript || {},
        fullPagePrompt: typeof rawPage.fullPagePrompt === 'string' ? rawPage.fullPagePrompt.trim() : '',
        illustrationUrl: rawPage.illustrationUrl || null,
        panels: [],
      };
      normalizedPage.panels = normalizeArray(rawPage.panels).map((panel, panelIndex) => normalizePanel(panel, normalizedPage, panelIndex));
      normalizedPage.panelCount = normalizedPage.panels.length || Math.max(1, rawPage.panelCount || 0);
    }

    const scene = scenesMap.get(sceneNumber) || {
      number: sceneNumber,
      sceneTitle: normalizedPage.sceneTitle,
      pages: [],
      panels: [],
    };
    scene.pages.push(normalizedPage.pageNumber);
    if (normalizedPage.panels) scene.panels.push(...normalizedPage.panels);
    scenesMap.set(sceneNumber, scene);
    normalizedPages.push(normalizedPage);
  }

  const normalizedScenes = Array.from(scenesMap.values()).sort((a, b) => a.number - b.number);
  const allPanels = normalizedPages.flatMap((page) => page.panels.map((panel) => ({
    ...panel,
    layoutTemplate: page.layoutTemplate,
    pageTurnIntent: page.pageTurnIntent,
    dominantBeat: page.dominantBeat,
    colorScript: page.colorScript,
  })));

  return {
    ...plan,
    title: plan.title || opts.fallbackTitle || 'My Graphic Novel',
    tagline: plan.tagline || '',
    graphicNovelVersion: plan.graphicNovelVersion || 'v2_premium',
    pages: normalizedPages,
    scenes: normalizedScenes,
    allPanels,
  };
}

function summarizeGraphicNovelIssues(plan, blueprint = null) {
  const issues = [];
  const pages = normalizeArray(plan.pages);
  const allPanels = normalizeArray(plan.allPanels);

  if (pages.length < 48 || pages.length > 80) {
    issues.push({ type: 'page_count', severity: 'warn', message: `Expected 48-80 pages, got ${pages.length}.` });
  }
  const splashCount = allPanels.filter((panel) => panel.panelType === 'splash').length;
  if (splashCount < 2 || splashCount > 5) {
    issues.push({ type: 'splash_count', severity: 'warn', message: `Expected 2-5 splash panels, got ${splashCount}.` });
  }
  const interstitialCount = pages.filter((page) => page.pageType === 'text_interstitial').length;
  if (interstitialCount < 5) {
    issues.push({ type: 'low_interstitial_count', severity: 'warn', message: `Expected at least 5 text_interstitial pages, got ${interstitialCount}.` });
  }
  for (const page of pages.filter((p) => p.pageType === 'text_interstitial')) {
    if (!page.bodyText) {
      issues.push({ type: 'empty_interstitial', severity: 'warn', message: `Text interstitial page ${page.pageNumber} has no bodyText.` });
    }
  }
  let silentPanels = 0;
  let repeatedLayoutRun = 1;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (!page.dominantBeat) {
      issues.push({ type: 'missing_dominant_beat', severity: 'warn', message: `Page ${page.pageNumber} is missing a dominant beat.` });
    }
    if (page.pageType !== 'text_interstitial' && !page.fullPagePrompt) {
      issues.push({ type: 'missing_full_page_prompt', severity: 'warn', message: `Page ${page.pageNumber} is missing a fullPagePrompt.` });
    }
    if (page.layoutTemplate === pages[i - 1]?.layoutTemplate) repeatedLayoutRun += 1;
    else repeatedLayoutRun = 1;
    if (repeatedLayoutRun >= 4) {
      issues.push({ type: 'layout_monotony', severity: 'warn', message: `Layout ${page.layoutTemplate} repeats for ${repeatedLayoutRun} pages.` });
    }
    for (const panel of page.panels || []) {
      if (!(panel.dialogue || '').trim() && !(panel.caption || '').trim()) silentPanels += 1;
    }
  }
  if (allPanels.length > 0) {
    const silentPct = silentPanels / allPanels.length;
    if (silentPct < 0.1) {
      issues.push({ type: 'silent_panel_ratio', severity: 'warn', message: `Silent panel ratio is ${Math.round(silentPct * 100)}%.` });
    }
  }
  if (blueprint && Array.isArray(blueprint.sceneBlueprints) && plan.scenes.length !== blueprint.sceneBlueprints.length) {
    issues.push({ type: 'scene_count', severity: 'warn', message: `Expected ${blueprint.sceneBlueprints.length} scenes, got ${plan.scenes.length}.` });
  }
  return issues;
}

function validateGraphicNovelPagesForRender(plan, pageBlueprints) {
  const pages = normalizeArray(plan.pages);
  const pageReports = [];
  const globalIssues = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const blueprint = pageBlueprints?.[i];
    const panelReports = [];
    for (let panelIndex = 0; panelIndex < (page.panels || []).length; panelIndex++) {
      const panel = page.panels[panelIndex];
      const rect = blueprint?.panelBlueprints?.[panelIndex] || null;
      const qaIssues = buildPanelQaIssues(panel, page, rect);
      panelReports.push({
        panelNumber: panel.panelNumber,
        issues: qaIssues,
      });
      globalIssues.push(...qaIssues.map((issue) => ({ ...issue, pageNumber: page.pageNumber, panelNumber: panel.panelNumber })));
    }
    pageReports.push({
      pageNumber: page.pageNumber,
      layoutTemplate: page.layoutTemplate,
      panelReports,
    });
  }

  return {
    ok: !globalIssues.some((issue) => issue.severity === 'error'),
    globalIssues,
    pageReports,
  };
}

module.exports = {
  LAYOUT_TEMPLATE_TO_PAGE_LAYOUT,
  PAGE_LAYOUT_TO_TEMPLATE,
  countWords,
  normalizeGraphicNovelPlan,
  summarizeGraphicNovelIssues,
  validateGraphicNovelPagesForRender,
};
