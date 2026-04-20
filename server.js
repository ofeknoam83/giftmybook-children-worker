require('dotenv').config();

// Process-level crash handlers
process.on('uncaughtException', (err) => {
  console.error(`[FATAL] Uncaught exception: ${err.message}`);
  console.error(err.stack);
  const mem = process.memoryUsage();
  console.error(`[FATAL] Memory at crash: heap=${Math.round(mem.heapUsed/1024/1024)}MB, rss=${Math.round(mem.rss/1024/1024)}MB`);
  // Don't exit — Cloud Run will restart
});

process.on('unhandledRejection', (reason) => {
  console.error(`[FATAL] Unhandled rejection: ${reason?.message || reason}`);
  if (reason?.stack) console.error(reason.stack);
});

process.on('SIGTERM', async () => {
  console.warn('[PROCESS] Received SIGTERM — Cloud Run is shutting down this instance');

  // Report failure for all in-memory active book generations
  // so their status resets to failed and they can be retried
  try {
    const inFlight = Array.from(activeBooks.keys());
    console.warn(`[PROCESS] SIGTERM: ${inFlight.length} in-flight book(s): ${inFlight.join(', ')}`);
    for (const bookId of inFlight) {
      const ctx = activeBooks.get(bookId);
      // Abort in-progress LLM calls so the generation fails fast
      ctx?.abortController?.abort();
      if (ctx?.progressCallbackUrl) {
        const { reportProgressForce } = require('./services/progressReporter');
        reportProgressForce(ctx.progressCallbackUrl, {
          bookId,
          stage: 'failed',
          progress: 0,
          message: 'Worker instance was shut down mid-generation (Cloud Run SIGTERM). Will be retried.',
          logs: ctx.logs || [],
          error: 'SIGTERM: Cloud Run instance recycled during generation',
        }).catch(() => {});
      }
    }
  } catch (cleanupErr) {
    console.error('[PROCESS] SIGTERM cleanup error:', cleanupErr.message);
  }

  setTimeout(() => process.exit(0), 10000);
});

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const pLimit = require('p-limit');
const { v4: uuidv4 } = require('uuid');

const { brainstormStorySeed, EMOTIONAL_THEMES, getEmotionalTier, planChapterBook } = require('./services/storyPlanner');
const { generateIllustration, downloadPhotoAsBase64 } = require('./services/illustrationGenerator');
// generateIllustration is only used for chapter books and graphic novels.
// Picture book illustration uses IllustratorEngine (services/illustrator/engine.js) exclusively.
// V3: compositeTextOnIllustration removed (V1 illustration pipeline)
const { assemblePdf, buildChapterBookPdf } = require('./services/layoutEngine');
const { generateCover, generateUpsellCovers } = require('./services/coverGenerator');
const { computeCoverPdfMetadata } = require('./services/coverMetadata');
const { uploadBuffer, getSignedUrl, downloadBuffer, deletePrefix } = require('./services/gcsStorage');
const { reportProgress, reportProgressForce, reportComplete, reportError, clearThrottle } = require('./services/progressReporter');
const { CostTracker } = require('./services/costTracker');
const { buildWriterBrief, buildV2Brief, buildChildContext, getAgeProfile, getAgeTier } = require('./prompts/writerBrief');
const { validateGenerateBookRequest, validateGenerateSpreadRequest, validateFinalizeBookRequest } = require('./services/validation');
const { withRetry } = require('./services/retry');

// Guard against lorem ipsum / placeholder text leaking into illustration prompts
const LOREM_PATTERNS = /lorem\s+ipsum|dolor\s+sit\s+amet|consectetur\s+adipiscing|labore\s+et\s+dolore/i;

/**
 * Parse bookFrom into individual gifter names.
 * "Mom and Dad" → ["Mom", "Dad"]
 * "Grandma and Grandpa" → ["Grandma", "Grandpa"]
 * "Alex" → ["Alex"]  (single gifter, no rule needed)
 */
function parseGifters(bookFrom) {
  if (!bookFrom || typeof bookFrom !== 'string') return [];
  const cleaned = bookFrom.trim();
  // Split on " and ", " & ", ", "
  const parts = cleaned.split(/\s+and\s+|\s*&\s*|,\s*/i).map(s => s.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [cleaned];
}


// ── Text Similarity Utilities (for OCR verification) ──

/**
 * Calculate Levenshtein-based text similarity between two strings.
 * Returns a value between 0 (completely different) and 1 (identical).
 */
function calculateTextSimilarity(extracted, expected) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const a = norm(extracted);
  const b = norm(expected);

  if (a === b) return 1.0;
  if (!a || !b) return 0.0;

  const matrix = [];
  for (let i = 0; i <= a.length; i++) {
    matrix[i] = [i];
    for (let j = 1; j <= b.length; j++) {
      matrix[i][j] = i === 0 ? j : Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }

  const maxLen = Math.max(a.length, b.length);
  return 1 - (matrix[a.length][b.length] / maxLen);
}

/**
 * Identify specific text differences between extracted OCR text and expected text.
 * Returns an array of human-readable issue descriptions.
 */
function identifyTextDifferences(extracted, expected) {
  const issues = [];
  if (!extracted || extracted === 'UNREADABLE') {
    issues.push('Text is unreadable or missing');
    return issues;
  }

  const extractedWords = extracted.toLowerCase().split(/\s+/);
  const expectedWords = expected.toLowerCase().split(/\s+/);

  for (const word of expectedWords) {
    if (!extractedWords.some(w => calculateTextSimilarity(w, word) > 0.8)) {
      issues.push(`Missing or misspelled word: "${word}"`);
    }
  }

  for (const word of extractedWords) {
    if (!expectedWords.some(w => calculateTextSimilarity(w, word) > 0.8)) {
      issues.push(`Unexpected extra text: "${word}"`);
    }
  }

  return issues;
}

/**
 * Verify embedded text in an illustration using Gemini Vision OCR.
 * Reads text from the image and compares to expected text.
 *
 * @param {string} imageBase64 - Base64-encoded image
 * @param {string} expectedText - The text that should appear in the image
 * @returns {Promise<{passed: boolean, extractedText: string, expectedText: string, similarity: number, issues: string[]}>}
 */
async function verifyEmbeddedText(imageBase64, expectedText) {
  const { getNextApiKey, fetchWithTimeout } = require('./services/illustrationGenerator');

  if (!expectedText || !expectedText.trim()) {
    return { passed: true, extractedText: '', expectedText: '', similarity: 1.0, issues: [] };
  }

  const apiKey = getNextApiKey();
  if (!apiKey) {
    console.log('[verifyEmbeddedText] No API key available — skipping verification');
    return { passed: true, extractedText: '', expectedText, similarity: 1.0, issues: [] };
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const body = {
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: 'image/png', data: imageBase64 } },
          { text: `Read ALL text visible in this children's book illustration. Return ONLY the text you can read, nothing else. If you cannot read any text or the text is garbled, return "UNREADABLE".` },
        ],
      }],
      generationConfig: {
        maxOutputTokens: 256,
        temperature: 0.1,
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 30000);

    if (!resp.ok) {
      console.log(`[verifyEmbeddedText] OCR API error ${resp.status} — skipping verification`);
      return { passed: true, extractedText: '', expectedText, similarity: 1.0, issues: [] };
    }

    const data = await resp.json();
    const extractedText = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();

    const similarity = calculateTextSimilarity(extractedText, expectedText);
    const passed = similarity > 0.85;
    const issues = !passed ? identifyTextDifferences(extractedText, expectedText) : [];

    console.log(`[verifyEmbeddedText] similarity=${similarity.toFixed(2)}, passed=${passed}, extracted="${extractedText.slice(0, 80)}"`);

    return { passed, extractedText, expectedText, similarity, issues };
  } catch (err) {
    console.log(`[verifyEmbeddedText] Verification error: ${err.message} — skipping`);
    return { passed: true, extractedText: '', expectedText, similarity: 1.0, issues: [] };
  }
}

const app = express();
app.set('trust proxy', 1); // Cloud Run runs behind a load balancer

// ── Checkpoint Helpers ──
async function saveCheckpoint(bookId, data) {
  try {
    const path = `children-jobs/${bookId}/checkpoint.json`;
    const buf = Buffer.from(JSON.stringify(data));
    await uploadBuffer(buf, path, 'application/json');
    console.log(`[checkpoint] Saved checkpoint for ${bookId} at stage: ${data.completedStage}`);
  } catch (err) {
    console.warn(`[checkpoint] Failed to save checkpoint for ${bookId} (non-fatal): ${err.message}`);
    // Non-fatal — generation can continue without checkpoint
  }
}

async function loadCheckpoint(bookId) {
  try {
    const path = `children-jobs/${bookId}/checkpoint.json`;
    const buf = await downloadBuffer(path);
    const data = JSON.parse(buf.toString());
    console.log(`[checkpoint] Loaded checkpoint for ${bookId} at stage: ${data.completedStage}`);
    return data;
  } catch (err) {
    // No checkpoint found — start fresh
    return null;
  }
}

async function clearCheckpoint(bookId) {
  try {
    await deletePrefix(`children-jobs/${bookId}/checkpoint.json`);
  } catch (e) { /* ignore */ }
}

app.use(helmet());
app.use(cors());
app.use(compression());
app.use(morgan('short'));
app.use(express.json({ limit: '50mb' }));

// Rate limiting on generation endpoints (disabled in test)
if (process.env.NODE_ENV !== 'test') {
  const generationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests, please try again later' },
  });
  app.use('/generate-style-variant', generationLimiter);
  app.use('/generate-book', generationLimiter);
  app.use('/finalize-book', generationLimiter);
}

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY;
const ABSOLUTE_TIMEOUT_MS = 90 * 60 * 1000; // 90 minutes max per book

// ── Per-Book Activity Tracking ──
const activeBooks = new Map();
global.__lastGlobalActivity = Date.now();

global.touchActivity = function (bookId) {
  const now = Date.now();
  global.__lastGlobalActivity = now;
  if (bookId && activeBooks.has(bookId)) {
    activeBooks.get(bookId).lastActivity = now;
  } else {
    for (const ctx of activeBooks.values()) {
      ctx.lastActivity = now;
    }
  }
};

/**
 * Create a tracking context for an active book generation.
 * @param {string} bookId
 * @returns {{ bookId: string, lastActivity: number, abortController: AbortController, abortSignal: AbortSignal }}
 */
function createBookContext(bookId, opts = {}) {
  const abortController = new AbortController();
  const context = {
    bookId,
    abortSignal: abortController.signal,
    abortController,
    lastActivity: Date.now(),
    reject: null,
    progressCallbackUrl: opts.progressCallbackUrl || null,
    callbackUrl: opts.callbackUrl || null,
    logs: [],
    log(level, msg, data) {
      const entry = { ts: new Date().toISOString(), level, msg, data };
      context.logs.push(entry);
      console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[book:${bookId.slice(0, 8)}] ${msg}`, data ? JSON.stringify(data).slice(0, 200) : '');
    },
    touchActivity() {
      context.lastActivity = Date.now();
      global.__lastGlobalActivity = Date.now();
    },
    checkAbort() {
      if (abortController.signal.aborted) {
        throw new Error('Generation aborted');
      }
    },
  };
  activeBooks.set(bookId, context);
  return context;
}

function removeBookContext(bookId) {
  activeBooks.delete(bookId);
  clearThrottle(bookId);
}

// Per-book watchdog: abort books idle > 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [bookId, ctx] of activeBooks) {
    const idle = now - ctx.lastActivity;
    if (idle > 900000) {
      console.error(`[watchdog] Book ${bookId} idle for ${Math.round(idle / 1000)}s - aborting`);
      ctx.abortController.abort();
      if (ctx.reject) ctx.reject(new Error(`Book generation timed out after ${Math.round(idle / 1000)}s of inactivity`));
      activeBooks.delete(bookId);
    }
  }
  if (activeBooks.size === 0 && (now - global.__lastGlobalActivity) > 600000) {
    console.log('[watchdog] No active books for 10 minutes - exiting cleanly for Cloud Run to manage');
    process.exit(0);
  }
}, 30000);

// ── Auth Middleware ──
function authenticate(req, res, next) {
  if (!API_KEY) {
    console.error('[auth] API_KEY not configured — rejecting request');
    return res.status(500).json({ success: false, error: 'Server misconfigured' });
  }
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(403).json({ success: false, error: 'Forbidden: invalid API key' });
  }
  next();
}

// ── Parallel Pipeline Functions ──
// NOTE: generateAllText removed in V2 — text comes from the story plan directly.

/**
 * V2: Generate illustrations for all story entries that need them.
 *
 * Processes entries in order. For each entry with an image_prompt or
 * spread_image_prompt, generates an illustration and attaches the URL.
 *
 * @param {Array<object>} entries - V2 entries array
 * @param {object} storyPlan - Full plan (for characterDescription, etc.)
 * @param {object} childDetails
 * @param {string} characterRef
 * @param {string} style
 * @param {object} opts
 * @returns {Promise<Array<object>>} entries with illustration URLs attached
 */
async function generateAllIllustrations(entries, storyPlan, childDetails, characterRef, style, opts) {
  const {
    apiKeys, costTracker, bookId, bookContext, progressCallbackUrl,
    resolvedChildPhotoUrl, cachedPhotoBase64, cachedPhotoMime,
    existingIllustrations, checkpointData, detectedSecondaryCharacters,
    characterAnchor,
    coverForIllustratorBase64,
    theme,
  } = opts;

  // ── Illustrator V2 (feature-flagged) ──
  const useIllustratorV2 = process.env.USE_ILLUSTRATOR_V2 === 'true';
  if (useIllustratorV2) {
    bookContext.log('info', 'Using Illustrator V2 engine (USE_ILLUSTRATOR_V2=true)');
    const { IllustratorEngine } = require('./services/illustrator/engine');
    const illustrator = new IllustratorEngine();
    return await illustrator.generate({
      entries,
      storyPlan,
      childDetails,
      style,
      coverBase64: coverForIllustratorBase64 || null,
      coverMime: 'image/jpeg',
      childPhotoBase64: cachedPhotoBase64,
      childPhotoMime: cachedPhotoMime || 'image/jpeg',
      bookId,
      bookContext,
      theme,
      additionalCoverCharacters: storyPlan.secondaryCharacterDescription || storyPlan.additionalCoverCharacters || detectedSecondaryCharacters || null,
      costTracker,
    });
  }

  // V3: V1 illustration pipeline removed — Illustrator V2 handles all picture books.
  // If we reach here, USE_ILLUSTRATOR_V2 is not enabled, which is a configuration error.
  throw new Error('Illustrator V2 (USE_ILLUSTRATOR_V2=true) is required — V1 illustration pipeline has been removed');
}

function trimToWordCount(text, maxWords) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return String(text || '').trim();
  return `${words.slice(0, maxWords).join(' ')}...`;
}

function buildGraphicNovelStoryContentForDb(storyPlan) {
  return {
    title: storyPlan.title,
    isGraphicNovel: true,
    graphicNovelVersion: storyPlan.graphicNovelVersion || 'v2_premium',
    tagline: storyPlan.tagline || '',
    benchmark: storyPlan.verticalSliceBenchmark || null,
    pages: (storyPlan.pages || []).map((page) => ({
      pageNumber: page.pageNumber,
      sceneNumber: page.sceneNumber,
      sceneTitle: page.sceneTitle,
      layoutTemplate: page.layoutTemplate,
      panelCount: page.panelCount,
      dominantBeat: page.dominantBeat,
      panels: (page.panels || []).map((panel) => ({
        panelNumber: panel.panelNumber,
        panelType: panel.panelType,
        shot: panel.shot,
        dialogue: panel.dialogue,
        caption: panel.caption,
      })),
    })),
  };
}

/**
 * Convert Writer V2 result to legacy storyPlan shape for the illustration pipeline.
 * The illustration pipeline expects { title, entries: [...] } with specific entry types.
 */
function convertWriterV2ToLegacyPlan(writerResult, childDetails, theme, approvedTitle) {
  const spreads = writerResult.story.spreads || [];
  const childName = childDetails.name || childDetails.childName || 'the child';
  const title = approvedTitle || `A Story for ${childName}`;
  const THEME_SUBS = {
    mothers_day: 'A story about love',
    fathers_day: 'A story about love',
    birthday: 'A birthday story',
    birthday_magic: 'A birthday story',
    adventure: 'An adventure story',
    fantasy: 'A fantasy quest',
    space: 'A space adventure',
    underwater: 'An underwater adventure',
    nature: 'A nature story',
    bedtime: 'A bedtime story',
    school: 'A school story',
    friendship: 'A friendship story',
    holiday: 'A holiday story',
    anxiety: 'A story about being brave',
    anger: 'A story about big feelings',
    fear: 'A story about courage',
    grief: 'A story about remembering',
    loneliness: 'A story about connection',
    new_beginnings: 'A story about new beginnings',
    self_worth: 'A story about being you',
    family_change: 'A story about family',
  };
  const subtitle = `${THEME_SUBS[theme] || 'A story'} for ${childName}`;

  // Build spread entries — split text into left/right pages
  const spreadEntries = spreads.map((s) => {
    const lines = (s.text || '').split('\n').filter(l => l.trim());
    let leftText, rightText;
    if (lines.length >= 4) {
      const mid = Math.ceil(lines.length / 2);
      leftText = lines.slice(0, mid).join('\n');
      rightText = lines.slice(mid).join('\n');
    } else if (lines.length >= 2) {
      leftText = lines[0];
      rightText = lines.slice(1).join('\n');
    } else {
      leftText = s.text || '';
      rightText = null;
    }

    return {
      type: 'spread',
      spread: s.spread,
      left: { text: leftText },
      right: { text: rightText },
      spread_image_prompt: `Illustration for spread ${s.spread} of a ${theme} children's picture book. Scene: ${leftText} ${rightText || ''}`.slice(0, 500),
    };
  });

  const entries = [
    { type: 'half_title_page', title },
    { type: 'blank' },
    { type: 'title_page', title, subtitle },
    { type: 'copyright_page' },
    { type: 'dedication_page', text: `For ${childName}` },
    ...spreadEntries,
    { type: 'blank' },
    { type: 'closing_page' },
    { type: 'blank' },
  ];

  return { title, entries };
}

function buildGraphicNovelReferencePack(storyPlan, childDetails) {
  const storyBible = storyPlan.storyBible || {};
  const heroName = childDetails.name || childDetails.childName || 'the child';
  const worldBible = storyBible.worldBible || {};
  const referencePack = {
    characterPack: {
      heroName,
      voiceGuide: storyBible.cast?.[0]?.voiceGuide || '',
      visualAnchor: storyBible.cast?.[0]?.visualAnchor || '',
      actingNotes: storyBible.cast?.[0]?.actingNotes || '',
      outfit: storyPlan.characterOutfit || '',
      description: storyPlan.characterDescription || '',
      anchor: storyPlan.characterAnchor || '',
      supportingCast: storyPlan.additionalCoverCharacters || '',
    },
    worldPack: {
      setting: worldBible.setting || '',
      locationAnchors: worldBible.locationAnchors || [],
      propAnchors: worldBible.propAnchors || [],
      recurringMotifs: storyBible.recurringMotifs || [],
      palette: storyBible.sceneColorScript || [],
      styleNorthStar: worldBible.styleNorthStar || 'Cinematic 3D Pixar-like sequential art adapted for print clarity',
    },
  };

  const totalPages = (storyPlan.pages || []).length;
  const totalPanels = (storyPlan.allPanels || []).length;
  const silentPanels = (storyPlan.allPanels || []).filter((panel) => !(panel.dialogue || '').trim() && !(panel.caption || '').trim()).length;
  storyPlan.referencePack = referencePack;
  storyPlan.verticalSliceBenchmark = {
    benchmarkBook: `${heroName} premium GN vertical slice`,
    version: storyPlan.graphicNovelVersion || 'v2_premium',
    pages: totalPages,
    panels: totalPanels,
    avgPanelsPerPage: totalPages ? Number((totalPanels / totalPages).toFixed(2)) : 0,
    silentPanelRatio: totalPanels ? Number((silentPanels / totalPanels).toFixed(2)) : 0,
    comparisonAgainstLegacy: {
      legacyRenderer: 'flat panel grouping with single caption band and one oval bubble',
      premiumRenderer: 'page-aware templates with vector lettering, text-safe zones, and reference-guided panel staging',
    },
  };

  return referencePack;
}

function collectGraphicNovelReferenceUrls(allPanels, index) {
  const refs = [];
  const current = allPanels[index];
  for (let i = index - 1; i >= 0; i--) {
    const prev = allPanels[i];
    if (!prev?.illustrationUrl) continue;
    if (prev.sceneNumber === current?.sceneNumber) refs.push(prev.illustrationUrl);
    if (refs.length >= 2) break;
  }
  for (let i = index - 1; i >= 0 && refs.length < 4; i--) {
    const prev = allPanels[i];
    if (!prev?.illustrationUrl) continue;
    refs.push(prev.illustrationUrl);
  }
  return Array.from(new Set(refs)).slice(0, 4);
}

function applyGraphicNovelRenderFixes(storyPlan) {
  const { countWords, normalizeGraphicNovelPlan } = require('./services/graphicNovelQa');
  const plan = normalizeGraphicNovelPlan(storyPlan, { fallbackTitle: storyPlan.title });
  for (const page of plan.pages) {
    if (page.layoutTemplate === 'fullBleedSplash' && page.panels.length > 1) {
      page.panels = [page.panels[0]];
      page.panelCount = 1;
    }
    for (const panel of page.panels) {
      if ((panel.balloons || []).length > 2 && (page.layoutTemplate === 'fourGrid' || page.layoutTemplate === 'conversationGrid')) {
        panel.balloons = panel.balloons.slice(0, 2);
      }
      if (countWords(panel.dialogue) > 18) {
        panel.dialogue = trimToWordCount(panel.dialogue, 18);
        if (panel.balloons?.length) {
          panel.balloons[0].text = trimToWordCount(panel.balloons[0].text, 18);
        }
      }
      if (countWords(panel.caption) > 18) {
        panel.caption = trimToWordCount(panel.caption, 18);
        if (panel.captions?.length) {
          panel.captions[0].text = trimToWordCount(panel.captions[0].text, 18);
        }
      }
      if ((page.layoutTemplate === 'fourGrid' || page.layoutTemplate === 'conversationGrid') && panel.backgroundComplexity === 'medium') {
        panel.backgroundComplexity = 'simple';
      }
    }
  }
  return normalizeGraphicNovelPlan(plan, { fallbackTitle: storyPlan.title });
}

/**
 * Generate one full-page illustration per page for graphic novels.
 * Each page's fullPagePrompt describes the complete page (panels, text, bubbles, SFX)
 * and Gemini renders everything in a single image.
 */
async function generateGraphicNovelPages(storyPlan, childDetails, style, opts) {
  const {
    apiKeys, costTracker, bookId, bookContext, progressCallbackUrl,
    resolvedChildPhotoUrl, characterRefBase64, characterRefMime,
  } = opts;
  const pages = storyPlan.pages || [];
  // Only generate illustrations for illustrated pages, not text interstitials
  const illustratedPages = pages.filter(p => p.pageType !== 'text_interstitial');
  const totalIllustrated = illustratedPages.length;
  let completed = 0;

  // Count pages already generated from a prior checkpoint
  const resumedCount = illustratedPages.filter(p => p.illustrationUrl).length;
  if (resumedCount > 0) {
    bookContext.log('info', `Resuming graphic novel pages — ${resumedCount}/${totalIllustrated} already generated`);
  }

  // First page reference for outfit/style/text consistency across GN pages
  let firstPageRefBase64 = null;

  // Collect previous page illustration URLs for style continuity
  function collectPrevPageUrls(currentIdx) {
    const refs = [];
    for (let i = currentIdx - 1; i >= 0 && refs.length < 4; i--) {
      if (illustratedPages[i]?.illustrationUrl) refs.push(illustratedPages[i].illustrationUrl);
    }
    return refs;
  }

  for (const page of illustratedPages) {
    bookContext.checkAbort();

    // Skip pages that already have illustrations from a prior run
    if (page.illustrationUrl) {
      completed++;
      continue;
    }

    bookContext.log('info', `Generating page ${completed + 1}/${totalIllustrated}`, {
      pageNumber: page.pageNumber,
      sceneNumber: page.sceneNumber,
      layoutTemplate: page.layoutTemplate,
    });

    const prevIllustrationUrls = collectPrevPageUrls(completed);
    let illustrationUrl = null;
    try {
      illustrationUrl = await generateIllustration(
        page.fullPagePrompt || `Graphic novel page ${completed + 1}`,
        null,
        storyPlan.coverArtStyle || style,
        {
          apiKeys,
          costTracker,
          bookId,
          bookContext,
          childName: childDetails.name,
          childAge: parseInt(childDetails.age, 10) || 10,
          childPhotoUrl: resolvedChildPhotoUrl,
          _cachedPhotoBase64: characterRefBase64,
          _cachedPhotoMime: characterRefMime,
          characterDescription: storyPlan.characterDescription || '',
          characterAnchor: storyPlan.characterAnchor || null,
          characterOutfit: storyPlan.characterOutfit || '',
          recurringElement: storyPlan.recurringElement || '',
          keyObjects: storyPlan.keyObjects || '',
          additionalCoverCharacters: storyPlan.additionalCoverCharacters || null,
          coverArtStyle: storyPlan.coverArtStyle || '',
          spreadIndex: completed,
          totalSpreads: totalIllustrated,
          comicPageMode: true,
          colorScript: page.colorScript,
          prevIllustrationUrls,
          abortSignal: bookContext.abortController.signal,
          deadlineMs: 180000,
          firstPageRefBase64: firstPageRefBase64 || null,
          promptInjection: completed === 0
            ? 'STYLE ESTABLISHMENT: This is the FIRST page of the graphic novel. The art style, color palette, lighting mood, character rendering, and text style you establish HERE will be the reference for ALL subsequent pages. Commit to a specific, rich, consistent style. '
            : '',
          theme: theme || null,
          parentOutfit: storyPlan.parentOutfit || null,
        }
      );
    } catch (pageErr) {
      bookContext.log('warn', `Page ${completed + 1} generation failed`, { error: pageErr.message });
    }

    // Save first page image as outfit/style reference for subsequent pages
    if (completed === 0 && illustrationUrl && !firstPageRefBase64) {
      try {
        const fpResp = await fetch(illustrationUrl);
        if (fpResp.ok) {
          firstPageRefBase64 = Buffer.from(await fpResp.arrayBuffer()).toString('base64');
          bookContext.log('info', 'Saved first GN page as style reference');
        }
      } catch (e) {
        bookContext.log('warn', 'Failed to save first GN page as style reference', { error: e.message });
      }
    }

    // ── Post-generation consistency check ──
    if (illustrationUrl && characterRefBase64) {
      try {
        const { checkCharacterConsistency } = require('./services/illustrationGenerator');
        let genBase64 = null;
        if (typeof illustrationUrl === 'string' && illustrationUrl.startsWith('http')) {
          try {
            const checkResp = await fetch(illustrationUrl);
            if (checkResp.ok) {
              genBase64 = Buffer.from(await checkResp.arrayBuffer()).toString('base64');
            }
          } catch {}
        }
        if (genBase64) {
          const consistency = await checkCharacterConsistency(genBase64, characterRefBase64, storyPlan.characterAnchor, storyPlan.characterOutfit || '', storyPlan.additionalCoverCharacters || null);
          if (!consistency.consistent) {
            bookContext.log('warn', `Page ${completed + 1} character inconsistency detected`, { issues: consistency.issues });
            // Retry ONCE with corrective prompt
            try {
              const originalPrompt = page.fullPagePrompt || `Graphic novel page ${completed + 1}`;
              const correctionNote = `IMPORTANT: Pay close attention to the character's appearance.\nThe child has: ${storyPlan.characterAnchor || ''}\nCore outfit: ${storyPlan.characterOutfit || ''}\nPrevious attempt issue: ${consistency.issues.join(', ')}`;
              const correctedPrompt = correctionNote + '\n\n' + originalPrompt;
              bookContext.log('info', `Retrying page ${completed + 1} with consistency correction`);

              const retryResult = await generateIllustration(
                correctedPrompt,
                null,
                storyPlan.coverArtStyle || style,
                {
                  apiKeys,
                  costTracker,
                  bookId,
                  bookContext,
                  childName: childDetails.name,
                  childAge: parseInt(childDetails.age, 10) || 10,
                  childPhotoUrl: resolvedChildPhotoUrl,
                  _cachedPhotoBase64: characterRefBase64,
                  _cachedPhotoMime: characterRefMime,
                  characterDescription: storyPlan.characterDescription || '',
                  characterAnchor: storyPlan.characterAnchor || null,
                  characterOutfit: storyPlan.characterOutfit || '',
                  recurringElement: storyPlan.recurringElement || '',
                  keyObjects: storyPlan.keyObjects || '',
                  additionalCoverCharacters: storyPlan.additionalCoverCharacters || null,
                  coverArtStyle: storyPlan.coverArtStyle || '',
                  spreadIndex: completed,
                  totalSpreads: totalIllustrated,
                  comicPageMode: true,
                  colorScript: page.colorScript,
                  prevIllustrationUrls,
                  abortSignal: bookContext.abortController.signal,
                  deadlineMs: 180000,
                  firstPageRefBase64: firstPageRefBase64 || null,
                  theme: theme || null,
                  parentOutfit: storyPlan.parentOutfit || null,
                }
              );
              if (retryResult) {
                illustrationUrl = retryResult;
                bookContext.log('info', `Page ${completed + 1} consistency retry succeeded`);
              }
            } catch (retryErr) {
              bookContext.log('warn', `Consistency retry failed for page ${completed + 1}`, { error: retryErr.message });
            }
          } else {
            bookContext.log('info', `Page ${completed + 1} character consistency OK`);
          }
        }
      } catch (checkErr) {
        bookContext.log('warn', `Consistency check error for page ${completed + 1}`, { error: checkErr.message });
      }
    }

    page.illustrationUrl = illustrationUrl || null;

    completed++;
    bookContext.touchActivity();

    await saveCheckpoint(bookId, {
      bookId,
      completedStage: 'illustrations_partial',
      storyPlan,
      timestamp: new Date().toISOString(),
      accumulatedCosts: costTracker.getSummary(),
    });

    if (progressCallbackUrl) {
      reportProgress(progressCallbackUrl, {
        bookId,
        stage: 'illustration',
        progress: 0.40 + (0.35 * completed / Math.max(1, totalIllustrated)),
        message: `Generating graphic novel page ${completed} of ${totalIllustrated}...`,
        previewUrls: illustratedPages.map((p) => p.illustrationUrl).filter(Boolean).slice(-8),
        logs: bookContext.logs,
      });
    }
  }
}

// ── Health Check ──
const versionInfo = require('./version.json');

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'giftmybook-children-worker',
    version: versionInfo.version,
    writerVersion: versionInfo.writerVersion,
    buildDate: versionInfo.buildDate,
    activeBooks: activeBooks.size,
  });
});

app.post('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ── POST /generate-style-variant ──
// Lighter pipeline: reuses existing story plan, only regenerates illustrations + PDFs in a new art style
app.post('/generate-style-variant', authenticate, async (req, res) => {
  const { bookId, variantIndex, style, storyPlan, childDetails, approvedCoverUrl, childPhotoUrls, callbackUrl, progressCallbackUrl } = req.body;

  if (!bookId || !style || !storyPlan) {
    return res.status(400).json({ error: 'bookId, style, and storyPlan are required' });
  }

  // Respond immediately
  res.status(202).json({ success: true, status: 'processing', bookId, style });

  // Process in background
  const bookContext = createBookContext(bookId, { progressCallbackUrl, callbackUrl });
  bookContext.log('info', `Style variant generation started`, { style, bookId });

  const heartbeatInterval = setInterval(() => {
    if (progressCallbackUrl) {
      reportProgress(progressCallbackUrl, { bookId, stage: 'illustration', heartbeat: true, logs: bookContext.logs }).catch(() => {});
    }
  }, 30000);

  try {
    // 1. Cache child photo (64px)
    let cachedPhotoBase64 = null;
    let cachedPhotoMime = 'image/jpeg';
    const childPhotoUrl = childPhotoUrls?.[0];
    if (childPhotoUrl) {
      try {
        const photoBuf = await downloadBuffer(childPhotoUrl);
        const resized = await require('sharp')(photoBuf).resize(512, 512, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
        cachedPhotoBase64 = resized.toString('base64');
        cachedPhotoMime = 'image/jpeg';
        bookContext.log('info', 'Photo cached for variant');
      } catch (e) {
        bookContext.log('warn', `Photo cache failed: ${e.message}`);
      }
    }

    // 2. Download approved cover for character reference
    let characterRefBase64 = cachedPhotoBase64;
    let characterRefMime = cachedPhotoMime;
    if (approvedCoverUrl) {
      try {
        const coverBuf = await downloadBuffer(approvedCoverUrl);
        const resized = await require('sharp')(coverBuf).resize(512, 512, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
        characterRefBase64 = resized.toString('base64');
        characterRefMime = 'image/jpeg';
      } catch (e) {
        bookContext.log('warn', `Cover download failed: ${e.message}`);
      }
    }

    // 3. Generate illustrations with the NEW style (sequential)
    const entries = storyPlan.entries || storyPlan.spreads?.map((s, i) => ({ type: 'spread', spread: i + 1, spread_image_prompt: s.illustrationPrompt || s.illustrationDescription, left: { text: s.text }, right: {} })) || [];

    bookContext.log('info', `Generating ${entries.length} illustrations in style: ${style}`);

    const entriesWithIllustrations = await generateAllIllustrations(entries, storyPlan, childDetails, null, style, {
      apiKeys: req.body.apiKeys || {},
      costTracker: null,
      bookId,
      bookContext,
      progressCallbackUrl,
      resolvedChildPhotoUrl: childPhotoUrl,
      cachedPhotoBase64: cachedPhotoBase64,
      cachedPhotoMime: cachedPhotoMime,
      existingIllustrations: [],
      checkpointData: null,
      coverForIllustratorBase64: characterRefBase64 || null,
      theme: storyPlan.theme || null,
    });

    bookContext.log('info', 'All variant illustrations complete');

    // 4. Download illustration buffers
    const downloadLimit = pLimit(4);
    const entriesWithBuffers = await Promise.all(
      entriesWithIllustrations.map((entry) => downloadLimit(async () => {
        const result = { ...entry };
        if (entry.spreadIllustrationUrl) {
          try { result.spreadIllustrationBuffer = await downloadBuffer(entry.spreadIllustrationUrl); } catch (e) {}
        }
        if (entry.illustrationUrl) {
          try { result.illustrationBuffer = await downloadBuffer(entry.illustrationUrl); } catch (e) {}
        }
        return result;
      }))
    );

    // 5. Assemble interior PDF
    const format = storyPlan.format || 'picture_book';
    const interiorPdf = await assemblePdf(entriesWithBuffers, format, {
      title: storyPlan.title || 'My Story',
      childName: childDetails.name,
      year: new Date().getFullYear(),
    });

    // 6. Upload interior PDF
    const variantPath = `children-jobs/${bookId}/variants/${style}`;
    await uploadBuffer(interiorPdf, `${variantPath}/interior.pdf`, 'application/pdf');
    const interiorPdfUrl = await getSignedUrl(`${variantPath}/interior.pdf`, 30 * 24 * 60 * 60 * 1000);

    // 7. Generate cover PDF
    let coverPdfUrl = null;
    // Find the first spread illustration to use as front cover
    const firstSpread = entriesWithBuffers.find(e => e.spreadIllustrationBuffer || e.illustrationBuffer);
    const coverBuffer = firstSpread?.spreadIllustrationBuffer || firstSpread?.illustrationBuffer;

    if (coverBuffer) {
      let pageCount = 0;
      for (const e of entriesWithBuffers) {
        if (e.type === 'spread') pageCount += 2;
        else pageCount += 1;
      }
      pageCount = Math.max(32, pageCount % 2 === 0 ? pageCount : pageCount + 1);

      const synopsis = storyPlan.synopsis || '';
      const coverData = await generateCover(storyPlan.title || 'My Story', childDetails, null, format, {
        bookId, preGeneratedCoverBuffer: coverBuffer, pageCount, synopsis,
      });
      if (coverData?.coverPdfBuffer) {
        await uploadBuffer(coverData.coverPdfBuffer, `${variantPath}/cover.pdf`, 'application/pdf');
        coverPdfUrl = await getSignedUrl(`${variantPath}/cover.pdf`, 30 * 24 * 60 * 60 * 1000);
      }
    }

    // 8. Collect preview URLs
    const previewImageUrls = entriesWithIllustrations
      .filter(e => e.spreadIllustrationUrl || e.illustrationUrl)
      .map(e => e.spreadIllustrationUrl || e.illustrationUrl);

    // 9. Callback
    bookContext.log('info', `Style variant '${style}' complete`);
    const variantResult = { success: true, bookId, variantIndex, style, interiorPdfUrl, coverPdfUrl, previewImageUrls, logs: bookContext.logs };
    if (callbackUrl) {
      await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY || '' },
        body: JSON.stringify(variantResult),
      }).catch(e => console.error(`Variant callback failed: ${e.message}`));
    }
    if (progressCallbackUrl) {
      reportComplete(progressCallbackUrl, variantResult);
    }
  } catch (err) {
    bookContext.log('error', `Style variant failed: ${err.message}`);
    const variantError = { success: false, bookId, variantIndex, style, error: err.message, logs: bookContext.logs };
    if (callbackUrl) {
      await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY || '' },
        body: JSON.stringify(variantError),
      }).catch(() => {});
    }
    if (progressCallbackUrl) {
      reportError(progressCallbackUrl, variantError);
    }
  } finally {
    clearInterval(heartbeatInterval);
    removeBookContext(bookId);
  }
});

// ── POST /generate-book ──
// Full pipeline: photo cache -> story planning -> text -> illustrations -> PDF assembly
app.post('/generate-book', authenticate, async (req, res) => {
  const { valid, errors, sanitized } = validateGenerateBookRequest(req.body);
  if (!valid) {
    return res.status(400).json({ success: false, errors });
  }

  const {
    bookId, childName, childAge, childGender, childAppearance,
    childInterests, childPhotoUrls, bookFormat, artStyle, theme,
    customDetails, callbackUrl, progressCallbackUrl, childId,
    approvedCoverUrl, childAnecdotes,
  } = sanitized;
  let { approvedTitle } = sanitized;
  const heartfeltNote = req.body.heartfeltNote || null;
  const bookFrom = req.body.bookFrom || null;
  const bindingType = req.body.bindingType || '';
  const emotionalCategory = sanitized.emotionalCategory || null;
  const emotionalSituation = sanitized.emotionalSituation || null;
  const emotionalParentGoal = sanitized.emotionalParentGoal || null;
  const copingResourceHint = sanitized.copingResourceHint || null;
  const isEmotionalBook = EMOTIONAL_THEMES.has(theme);
  const countryCode = req.body.countryCode || null; // e.g. 'US', 'GB', 'AU'
  const apiKeys = req.body.apiKeys;
  const parentStoryContent = req.body.parentStoryContent || null;
  const parentCharacterAnchor = req.body.parentCharacterAnchor || null;

  // When generating from a parent book, always preserve the original title.
  // Derive parentBookTitle from parentStoryContent.title if not explicitly set,
  // and lock approvedTitle so the planner never invents a different one.
  let parentBookTitle = req.body.parentBookTitle || null;
  if (parentStoryContent && !parentBookTitle && parentStoryContent.title) {
    parentBookTitle = parentStoryContent.title;
  }
  if (parentBookTitle && !approvedTitle) {
    approvedTitle = parentBookTitle;
    console.log(`[server] Locked title from parent book: "${approvedTitle}"`);
  }

  // Merge child anecdotes into customDetails so the planner can use them
  const anecdoteParts = [];
  if (childAnecdotes) {
    if (childAnecdotes.favorite_activities) anecdoteParts.push(`Favorite activities: ${childAnecdotes.favorite_activities}`);
    if (childAnecdotes.funny_thing) anecdoteParts.push(`Funny thing they do: ${childAnecdotes.funny_thing}`);
    if (childAnecdotes.favorite_food) anecdoteParts.push(`Favorite food: ${childAnecdotes.favorite_food}`);
    if (childAnecdotes.other_detail) anecdoteParts.push(`Other detail: ${childAnecdotes.other_detail}`);
    // Theme-specific fields
    if (childAnecdotes.calls_mom) anecdoteParts.push(`Child calls mom: ${childAnecdotes.calls_mom}`);
    if (childAnecdotes.mom_name) anecdoteParts.push(`Mom's name: ${childAnecdotes.mom_name}`);
    if (childAnecdotes.calls_dad) anecdoteParts.push(`Child calls dad: ${childAnecdotes.calls_dad}`);
    if (childAnecdotes.dad_name) anecdoteParts.push(`Dad's name: ${childAnecdotes.dad_name}`);
    if (childAnecdotes.meaningful_moment) anecdoteParts.push(`Meaningful moment: ${childAnecdotes.meaningful_moment}`);
    if (childAnecdotes.moms_favorite_moment) anecdoteParts.push(`Mom's favorite moment: ${childAnecdotes.moms_favorite_moment}`);
    if (childAnecdotes.favorite_cake_flavor) anecdoteParts.push(`Favorite cake flavor: ${childAnecdotes.favorite_cake_flavor}`);
    if (childAnecdotes.favorite_toys) anecdoteParts.push(`Favorite toys: ${childAnecdotes.favorite_toys}`);
    if (childAnecdotes.birth_date) anecdoteParts.push(`Birth date: ${childAnecdotes.birth_date}`);
    if (childAnecdotes.anything_else) anecdoteParts.push(`Additional details: ${childAnecdotes.anything_else}`);
  }
  const enrichedCustomDetails = anecdoteParts.length > 0
    ? [customDetails, ...anecdoteParts].filter(Boolean).join('\n')
    : customDetails;

  let format = bookFormat;
  const style = artStyle || 'pixar_premium';
  const costTracker = new CostTracker();
  const isChapterBook = bookFormat === 'CHAPTER_BOOK' || (childAge >= 9 && req.body.bookFormat === 'CHAPTER_BOOK');
  const isGraphicNovel = bookFormat === 'GRAPHIC_NOVEL';

  // Auto-derive emotional tier from age for emotional books
  let emotionalTierInfo = null;
  if (isEmotionalBook) {
    emotionalTierInfo = getEmotionalTier(childAge || 5);
    if (!format || format === 'picture_book') {
      format = emotionalTierInfo.bookFormat.toLowerCase();
      console.log(`[server] [emotional] Tier ${emotionalTierInfo.tier} derived from age ${childAge} → format=${format}, spreads=${emotionalTierInfo.spreads}`);
    }
  }

  const childDetails = {
    name: childName,
    age: childAge,
    gender: childGender,
    appearance: childAppearance,
    interests: childInterests,
    photoUrls: childPhotoUrls,
  };

  console.log(`[server] /generate-book: bookId=${bookId}, child=${childName}, format=${format}, style=${style}`);

  // Deduplication guard — reject if this bookId is already being generated
  if (activeBooks.has(bookId)) {
    console.warn(`[server] /generate-book: DUPLICATE request for bookId=${bookId} — already in progress, rejecting`);
    return res.status(409).json({ success: false, error: 'Book generation already in progress', bookId });
  }

  const bookContext = createBookContext(bookId, { progressCallbackUrl, callbackUrl });

  // Respond 202 immediately, process in background
  res.status(202).json({ success: true, status: 'processing', bookId });

  let absoluteTimer = null;
  let heartbeatInterval = null;
  let hardTimeoutId = null;

  const generationWork = (async () => {
    const bookWarnings = [];
    const bookStartTime = Date.now();
    bookContext.log('info', 'Book generation started', { childName, format, style, theme });
    absoluteTimer = setTimeout(() => {
      bookContext.log('error', 'Absolute timeout reached — aborting', { timeoutMin: ABSOLUTE_TIMEOUT_MS / 60000 });
      console.error(`[server] Book ${bookId} hit absolute timeout (${ABSOLUTE_TIMEOUT_MS / 60000}min) — aborting`);
      bookContext.abortController.abort();
    }, ABSOLUTE_TIMEOUT_MS);

    // Send heartbeat every 30s so standalone knows we're alive
    // If standalone returns abort:true (book was marked failed), stop generating
    heartbeatInterval = setInterval(async () => {
      if (progressCallbackUrl) {
        try {
          const resp = await reportProgressForce(progressCallbackUrl, {
            bookId,
            stage: 'generating',
            heartbeat: true,
            logs: bookContext.logs,
          });
          if (resp?.abort) {
            bookContext.log('warn', `Abort signal received from standalone: ${resp.reason || 'unknown'}`);
            console.warn(`[server] Book ${bookId} received abort signal — stopping generation`);
            bookContext.abortController.abort();
          }
        } catch (_) { /* fire-and-forget */ }
      }
    }, 30000);

    try {
      // If forceNew, wipe all GCS data and checkpoints for a truly fresh start
      const forceNew = req.body.forceNew === true;
      let checkpoint = null;
      if (forceNew) {
        bookContext.log('info', 'Full regeneration requested — clearing checkpoint');
        // Clear checkpoint immediately so we don't resume from old state.
        // Old illustrations are cleaned up AFTER new ones are generated (see post-illustration cleanup).
        try {
          await deletePrefix(`children-jobs/${bookId}/checkpoint.json`);
          bookContext.log('info', 'Checkpoint cleared');
        } catch (e) {
          bookContext.log('warn', 'Checkpoint clear failed — continuing', { error: (e?.message || String(e)).slice(0, 150) });
        }
      } else {
        // Load checkpoint for resume support
        checkpoint = await loadCheckpoint(bookId);
      }
      if (checkpoint) {
        bookContext.log('info', 'Checkpoint found — resuming from stage: ' + checkpoint.completedStage);
        // Seed costTracker with costs accumulated in previous run
        if (checkpoint.accumulatedCosts) {
          costTracker.addFromSummary(checkpoint.accumulatedCosts);
          bookContext.log('info', `[costTracker] Resumed: $${checkpoint.accumulatedCosts.totalCost?.toFixed(4) || '0.0000'} from prior run`);
        }
      }

      // Stage 1: Download + cache child photo for illustration calls (always runs — photo not saved in checkpoint)
      bookContext.log('info', 'Starting photo download');
      if (progressCallbackUrl) {
        reportProgress(progressCallbackUrl, { bookId, stage: 'photo_cache', progress: 0.05, message: 'Preparing photos...', logs: bookContext.logs });
      }
      bookContext.touchActivity();

      const stage1Start = Date.now();
      const childPhotoUrl = childDetails.photoUrls?.[0];
      let cachedPhotoBase64 = null;
      let cachedPhotoMime = 'image/jpeg';

      if (childPhotoUrl) {
        const cachedPhotoPath = `children-jobs/${bookId}/photo-512.jpg`;
        try {
          // Try to load previously cached resized photo first (42KB vs 4.6MB)
          const cachedBuf = await downloadBuffer(cachedPhotoPath).catch(() => null);
          if (cachedBuf && cachedBuf.length > 1000) {
            cachedPhotoBase64 = cachedBuf.toString('base64');
            bookContext.log('info', 'Child photo loaded from cache', { bytes: cachedBuf.length });
          } else {
            // Download original and resize
            const sharp = require('sharp');
            const photoBuf = await downloadBuffer(childPhotoUrl);
            const resizedBuf = await sharp(photoBuf)
              .resize(512, 512, { fit: 'cover' })
              .jpeg({ quality: 80 })
              .toBuffer();
            cachedPhotoBase64 = resizedBuf.toString('base64');
            bookContext.log('info', 'Child photo cached (resized to 512px)', { originalBytes: photoBuf.length, resizedBytes: resizedBuf.length });
            // Save resized photo to GCS for reuse (fire-and-forget)
            uploadBuffer(resizedBuf, cachedPhotoPath, 'image/jpeg')
              .then(() => console.log(`[server] Saved cached photo for ${bookId}`))
              .catch(() => {});
          }
        } catch (photoErr) {
          bookContext.log('warn', 'Failed to cache child photo', { error: photoErr.message });
        }
      }
      bookContext.touchActivity();

      const resolvedChildPhotoUrl = childPhotoUrl;

      // Use user-confirmed character identifications if available, otherwise auto-detect
      let detectedSecondaryCharacters = null;
      if (req.body.confirmedCharacters && Array.isArray(req.body.confirmedCharacters)) {
        const confirmed = req.body.confirmedCharacters;
        const secondary = confirmed.filter(c => c.role !== 'main_child' && c.role !== 'exclude');
        if (secondary.length > 0) {
          detectedSecondaryCharacters = secondary
            .map(c => `${c.label || c.role}: ${c.description || 'appearance from uploaded photo'}`)
            .join('\n');
        }
        bookContext.log('info', 'Using user-confirmed character identifications', { count: secondary.length });
      } else if (cachedPhotoBase64) {
        try {
          const { getNextApiKey } = require('./services/illustrationGenerator');
          const photoAnalysisKey = getNextApiKey() || process.env.GOOGLE_AI_STUDIO_KEY || process.env.GEMINI_API_KEY;
          const photoAnalysisResp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${photoAnalysisKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [
                  { text: `Look at this photo. Answer ONE question: Are there multiple people in this photo?

If YES — list each NON-CHILD person with:
SECONDARY_CHARACTER: [relationship if apparent, e.g. father/adult man/grandmother]: [hair color and style] | [skin tone] | [approximate age/build] | [any notable features like beard, glasses]

If there is only ONE person (the child), respond with exactly: NONE

Be concise. Only describe adults/secondary people, not the main child.` },
                  { inline_data: { mime_type: cachedPhotoMime || 'image/jpeg', data: cachedPhotoBase64 } },
                ]}],
                generationConfig: { maxOutputTokens: 300, temperature: 0.1 },
              }),
            }
          );
          if (photoAnalysisResp.ok) {
            const photoData = await photoAnalysisResp.json();
            const photoText = photoData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (photoText && photoText !== 'NONE' && photoText.includes('SECONDARY_CHARACTER')) {
              detectedSecondaryCharacters = photoText.replace(/SECONDARY_CHARACTER:\s*/gi, '').trim();
              bookContext.log('info', 'Secondary characters detected in uploaded photo', { desc: detectedSecondaryCharacters.slice(0, 150) });
            }
          }
        } catch (photoScanErr) {
          bookContext.log('warn', 'Photo secondary character scan failed', { error: photoScanErr.message });
        }
      }

      const stage1Ms = Date.now() - stage1Start;
      bookContext.log('info', 'Photo cache complete', { ms: stage1Ms, hasPhotoCache: !!cachedPhotoBase64 });

      console.log(`[server] Stage timing: photo_cache=${stage1Ms}ms (book ${bookId})`);

      // ── EARLY parent theme guard: clear photo-detected secondary characters for parent themes ──
      // The photo scan may detect an adult (mother/father) in the child photo, but for parent-themed
      // books where the parent is NOT on the chosen cover, we must NOT pass those characters to the
      // story planner — otherwise it bakes the parent into secondaryCharacterDescription and the
      // illustration system draws them explicitly. This must happen BEFORE story planning.
      const { PARENT_THEMES } = require('./services/illustrationGenerator');
      if (PARENT_THEMES.has(theme) && detectedSecondaryCharacters) {
        bookContext.log('info', 'Parent theme — clearing photo-detected secondary characters BEFORE story planning (parent must not be drawn explicitly unless on chosen cover)', { was: detectedSecondaryCharacters.slice(0, 100) });
        detectedSecondaryCharacters = null;
      }

      // Character reference generation skipped — Gemini illustrations use child photo directly
      const characterRef = null;

      // ── Brainstorm unique story seed ──
      bookContext.checkAbort();
      bookContext.log('info', 'Brainstorming unique story seed');
      if (progressCallbackUrl) {
        reportProgress(progressCallbackUrl, { bookId, stage: 'story_planning', progress: 0.10, message: 'Brainstorming story idea...', logs: bookContext.logs });
      }
      let storySeed;
      try {
        storySeed = await brainstormStorySeed(childDetails, enrichedCustomDetails || '', approvedTitle, {
          apiKeys, costTracker, theme,
          emotionalSituation,
          copingResourceHint,
          additionalCoverCharacters: detectedSecondaryCharacters || null,
        });
        bookContext.log('info', 'Story seed ready', {
          favorite_object: storySeed.favorite_object,
          fear: storySeed.fear,
          setting: (storySeed.setting || '').slice(0, 80),
          storySeed: (storySeed.storySeed || '').slice(0, 100),
        });
      } catch (seedErr) {
        bookContext.log('warn', `Story seed brainstorm failed — using defaults: ${seedErr.message}`);
        storySeed = { favorite_object: 'a favorite toy', fear: 'the dark', setting: 'a magical place', storySeed: '' };
      }
      bookContext.touchActivity();

      // Build dedication from heartfelt note if available
      let dedication;
      if (heartfeltNote) {
        dedication = bookFrom ? `From ${bookFrom}:\n${heartfeltNote}` : heartfeltNote;
      } else {
        dedication = `For ${childDetails.name || 'the child'}`;
      }
      const gifterNames = parseGifters(bookFrom);
      const isMultipleGifters = gifterNames.length > 1;
      const v2Vars = {
        name: childDetails.name,
        age: childDetails.age || 5,
        favorite_object: storySeed.favorite_object || 'a favorite toy',
        fear: storySeed.fear || 'the dark',
        setting: storySeed.setting || 'a magical place',
        dedication,
        beats: storySeed.beats || [],
        repeated_phrase: storySeed.repeated_phrase || '',
        phrase_arc: storySeed.phrase_arc || [],
        countryCode: countryCode || null,
        emotionalSituation: emotionalSituation || null,
        emotionalParentGoal: emotionalParentGoal || null,
        copingResourceHint: copingResourceHint || null,
        emotionalSpreads: emotionalTierInfo ? emotionalTierInfo.spreads : undefined,
        emotionalTier: emotionalTierInfo ? emotionalTierInfo.tier : undefined,
        gifterNames,
        isMultipleGifters,
        style_mode: storySeed.style_mode || 'playful',
        techniques: storySeed.techniques || ['rule_of_three', 'humor'],
      };

      // Append story seed to custom details so the planner has the full creative direction
      let plannerCustomDetails = enrichedCustomDetails || '';
      if (storySeed.storySeed) {
        plannerCustomDetails += `\n\nSTORY SEED (use as creative direction): ${storySeed.storySeed}`;
      }

      // Stage 2: V2 Story Planning (returns complete story with text + image prompts)
      let storyPlan;
      if (checkpoint?.storyPlan && (Array.isArray(checkpoint.storyPlan.entries) || Array.isArray(checkpoint.storyPlan.chapters) || Array.isArray(checkpoint.storyPlan.pages))) {
        // checkpoint — resume
        storyPlan = checkpoint.storyPlan;
        const itemCount = storyPlan.isGraphicNovel
          ? (storyPlan.pages || []).length
          : storyPlan.isChapterBook
            ? (storyPlan.chapters || []).length
            : (storyPlan.entries || []).filter(e => e.type === 'spread').length;
        bookContext.log('info', 'Resumed story plan from checkpoint', { items: itemCount, title: storyPlan.title, isChapterBook: !!storyPlan.isChapterBook, isGraphicNovel: !!storyPlan.isGraphicNovel });
      } else if (isChapterBook) {
        // ── Chapter book planning (T4 format, ages 9-12) ──
        bookContext.checkAbort();
        bookContext.log('info', 'Starting chapter book planning', { theme: theme || 'adventure' });
        if (progressCallbackUrl) {
          reportProgress(progressCallbackUrl, { bookId, stage: 'story_planning', progress: 0.15, message: 'Planning chapter book...', logs: bookContext.logs });
        }

        const stage3Start = Date.now();
        storyPlan = await planChapterBook(childDetails, theme || 'adventure', plannerCustomDetails, {
          apiKeys,
          costTracker,
          approvedTitle,
          bookContext,
          parentBookTitle,
          parentStoryContent,
          additionalCoverCharacters: detectedSecondaryCharacters || null,
        });
        storyPlan.isChapterBook = true;
        bookContext.touchActivity();
        const stage3Ms = Date.now() - stage3Start;
        bookContext.log('info', 'Chapter book planned', { chapters: storyPlan.chapters.length, title: storyPlan.title, ms: stage3Ms });
        console.log(`[server] Stage timing: story=${stage3Ms}ms (book ${bookId})`);

        // Save story content to DB immediately so admin can see the text
        if (progressCallbackUrl) {
          const storyContentForDb = {
            title: storyPlan.title,
            isChapterBook: true,
            chapters: storyPlan.chapters.map(ch => ({ number: ch.number, chapterTitle: ch.chapterTitle, synopsis: ch.synopsis, text: ch.text })),
          };
          reportProgressForce(progressCallbackUrl, { bookId, stage: 'story_planning', storyContent: storyContentForDb, logs: bookContext.logs }).catch(() => {});
        }

        await saveCheckpoint(bookId, { bookId, completedStage: 'story_planning', storyPlan, timestamp: new Date().toISOString(), accumulatedCosts: costTracker.getSummary() });
      } else if (isGraphicNovel) {
        // ── Graphic novel planning (GRAPHIC_NOVEL format, ages 9-12) ──
        bookContext.checkAbort();
        bookContext.log('info', 'Starting graphic novel planning', { theme: theme || 'adventure' });
        if (progressCallbackUrl) {
          reportProgress(progressCallbackUrl, { bookId, stage: 'story_planning', progress: 0.15, message: 'Planning graphic novel...', logs: bookContext.logs });
        }

        const { planGraphicNovel } = require('./services/storyPlanner');
        const gnStart = Date.now();
        storyPlan = await planGraphicNovel(childDetails, theme || 'adventure', plannerCustomDetails, {
          apiKeys, costTracker, approvedTitle, bookContext,
          parentBookTitle, parentStoryContent,
          additionalCoverCharacters: detectedSecondaryCharacters || null,
        });
        storyPlan.isGraphicNovel = true;
        bookContext.touchActivity();
        const gnMs = Date.now() - gnStart;
        bookContext.log('info', 'Graphic novel planned', { scenes: storyPlan.scenes?.length, panels: storyPlan.allPanels?.length, title: storyPlan.title, ms: gnMs });
        console.log(`[server] Stage timing: story=${gnMs}ms (book ${bookId})`);

        if (progressCallbackUrl) {
          const storyContentForDb = buildGraphicNovelStoryContentForDb(storyPlan);
          reportProgressForce(progressCallbackUrl, { bookId, stage: 'story_planning', storyContent: storyContentForDb, logs: bookContext.logs }).catch(() => {});
        }

        await saveCheckpoint(bookId, { bookId, completedStage: 'story_planning', storyPlan, timestamp: new Date().toISOString(), accumulatedCosts: costTracker.getSummary() });
      } else if (!isChapterBook && !isGraphicNovel) {
        // ── Writer V2 — unified engine for supported themes ──
        bookContext.checkAbort();
        bookContext.log('info', 'Starting Writer V2 story generation', { theme: theme || 'adventure' });
        if (progressCallbackUrl) {
          reportProgress(progressCallbackUrl, { bookId, stage: 'story_planning', progress: 0.15, message: 'Writing story (Writer V2)...', logs: bookContext.logs });
        }

        // Inject API keys from standalone into process.env so Writer V2 can use GPT-5.4
        if (apiKeys) {
          for (const [key, val] of Object.entries(apiKeys)) {
            if (val && !process.env[key]) process.env[key] = val;
          }
        }

        const { WriterEngine } = require('./services/writer/engine');
        const stage3Start = Date.now();
        if (approvedTitle && sanitized.approvedTitle !== approvedTitle) {
          sanitized.approvedTitle = approvedTitle;
        }
        const writerResult = await WriterEngine.generate(sanitized, {
          onProgress: (p) => {
            if (progressCallbackUrl) {
              const progressMap = { planning: 0.16, writing: 0.18, quality: 0.20, revising: 0.22, complete: 0.25 };
              reportProgress(progressCallbackUrl, { bookId, stage: 'story_planning', progress: progressMap[p.step] || 0.20, message: p.message, logs: bookContext.logs });
            }
          },
          maxRetries: 2,
          // Wire the brainstormed story seed so Writer V2 uses it as the beat backbone
          // instead of picking a random plot template. Falls back to templates if beats missing.
          storySeed: {
            narrative_spine: storySeed?.narrative_spine || null,
            beats: v2Vars.beats,
            favorite_object: v2Vars.favorite_object,
            fear: v2Vars.fear,
            setting: v2Vars.setting,
            repeated_phrase: v2Vars.repeated_phrase,
            phrase_arc: v2Vars.phrase_arc,
            storySeed: storySeed?.storySeed || '',
            emotional_core: storySeed?.emotional_core || null,
          },
        });
        bookContext.touchActivity();
        const stage3Ms = Date.now() - stage3Start;
        bookContext.log('info', 'Writer V2 story complete', {
          spreads: writerResult.story.spreads.length,
          model: writerResult.metadata.model,
          qualityScore: writerResult.metadata.qualityScore,
          totalWords: writerResult.metadata.totalWords,
          ms: stage3Ms,
        });
        console.log(`[server] Stage timing: writerV2=${stage3Ms}ms (book ${bookId})`);

        // Safety: if Writer V2 returned 0 spreads, fail the book instead of generating a blank PDF
        if (!writerResult.story.spreads || writerResult.story.spreads.length === 0) {
          throw new Error(`Writer V2 returned 0 spreads for book ${bookId} — aborting to prevent blank book`);
        }

        // Convert Writer V2 result to legacy storyPlan shape for illustration pipeline
        storyPlan = convertWriterV2ToLegacyPlan(writerResult, childDetails, theme, approvedTitle);
        storyPlan._writerV2Metadata = writerResult.metadata;

        // Save story content to DB
        if (progressCallbackUrl) {
          const storyContentForDb = {
            title: storyPlan.title,
            entries: storyPlan.entries.map(e => ({ type: e.type, spread: e.spread, left: e.left, right: e.right, title: e.title, text: e.text })),
            characterDescription: storyPlan.characterDescription || null,
            characterOutfit: storyPlan.characterOutfit || null,
            writerV2Metadata: writerResult.metadata,
          };
          reportProgressForce(progressCallbackUrl, { bookId, stage: 'story_planning', storyContent: storyContentForDb, logs: bookContext.logs }).catch(() => {});
        }

        await saveCheckpoint(bookId, { bookId, completedStage: 'story_planning', storyPlan, timestamp: new Date().toISOString(), accumulatedCosts: costTracker.getSummary() });
      }

      // V2: Text is already in the story plan — no separate text generation needed.

      // ── W3: Check custom details usage (non-blocking, informational) ──
      // Writer V2 has its own QualityGate — no need for V1 criticStory/masterCritic
      if (!isChapterBook && !storyPlan.isChapterBook && !isGraphicNovel && !storyPlan.isGraphicNovel) {
        try {
          const { checkCustomDetailsUsage } = require('./services/qualityGates');
          const detailsCheck = await checkCustomDetailsUsage(storyPlan.entries, enrichedCustomDetails || customDetails, { costTracker });
          bookContext.log('info', 'Custom details usage check', { score: detailsCheck.score, missing: detailsCheck.missingCritical });
        } catch (qgErr) {
          bookContext.log('warn', 'Custom details check failed (non-blocking)', { error: qgErr.message });
        }
      }

      // Stage 3: Prepare cover + character reference
      const stage6Start = Date.now();
      bookContext.checkAbort();
      bookContext.log('info', approvedCoverUrl ? 'Using pre-approved cover' : 'Starting cover preparation');
      if (progressCallbackUrl) {
        reportProgress(progressCallbackUrl, { bookId, stage: 'cover', progress: 0.30, message: 'Preparing cover...', logs: bookContext.logs });
      }

      let characterRefBase64 = cachedPhotoBase64;
      let characterRefMime = cachedPhotoMime;
      let preGeneratedCoverBuffer = null;
      let coverForIllustratorBase64 = null; // 512px cover for Illustrator V2

      if (approvedCoverUrl) {
        try {
          const sharp = require('sharp');
          const coverUrl = approvedCoverUrl;
          const coverBuf = await withRetry(
            () => downloadBuffer(coverUrl),
            { maxRetries: 3, baseDelayMs: 1000, label: `download-cover-ref-${bookId}` }
          );
          preGeneratedCoverBuffer = coverBuf;

          // 512px cover for Illustrator V2 (high enough detail for Gemini to see style/outfit/features)
          const coverForIllustrator = await sharp(coverBuf)
            .resize(512, 512, { fit: 'cover' })
            .jpeg({ quality: 80 })
            .toBuffer();
          coverForIllustratorBase64 = coverForIllustrator.toString('base64');

          bookContext.log('info', 'Cover downloaded and resized', { originalBytes: coverBuf.length, illustratorBytes: coverForIllustrator.length, ms: Date.now() - stage6Start });

          // Detect additional characters on cover (parent, grandparent, sibling, etc.)
          // Illustrator V2 sees the cover image directly for style/outfit/appearance,
          // but we still need to know if a secondary character is present for parent visibility logic.
          try {
            const { getNextApiKey } = require('./services/illustrationGenerator');
            const apiKey = getNextApiKey() || process.env.GOOGLE_AI_STUDIO_KEY || process.env.GEMINI_API_KEY;
            const visionResp = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ role: 'user', parts: [
                    { text: `Look at this children's book cover. Are there any characters visible BESIDES the main child? If yes, for each one write:\n- [relationship if apparent, e.g. grandmother/elderly woman/adult man]: [brief appearance description — hair, skin, clothing, distinguishing features]\n\nIf the main child is the ONLY character, respond with exactly: NONE` },
                    { inline_data: { mime_type: 'image/jpeg', data: coverForIllustratorBase64 } },
                  ]}],
                  generationConfig: { maxOutputTokens: 500, temperature: 0.2 },
                }),
                signal: bookContext.abortController.signal,
              }
            );
            if (visionResp.ok) {
              const visionData = await visionResp.json();
              const addlText = visionData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
              const isNone = !addlText || /^none[.!]?$/i.test(addlText.trim()) || addlText.trim().length <= 5;
              if (addlText && !isNone) {
                storyPlan.additionalCoverCharacters = addlText;
                bookContext.log('info', 'Additional cover characters detected', { characters: addlText.slice(0, 300) });
              } else {
                storyPlan.additionalCoverCharacters = null;
                bookContext.log('info', 'No additional cover characters detected');
              }
            }

            storyPlan.characterAnchor = null;
          } catch (visionErr) {
            bookContext.log('warn', 'Failed to detect additional cover characters', { error: visionErr.message });
          }
        } catch (dlErr) {
          bookContext.log('warn', 'Failed to download approved cover for reference, using original photo', { error: dlErr.message });
        }
      }

      // ── Fix: For parent themes, if the cover does NOT contain the parent,
      // ignore photo-detected secondary characters. The photo scan may have detected
      // an adult's hand/arm in the child photo, but that should NOT override
      // the implied-presence path when the parent is not on the chosen cover.
      if (PARENT_THEMES.has(theme) && !storyPlan.additionalCoverCharacters) {
        // Safety net: clear any lingering secondary character references for parent themes
        if (detectedSecondaryCharacters) {
          bookContext.log('info', 'Parent theme without cover parent — clearing residual detectedSecondaryCharacters', { was: detectedSecondaryCharacters.slice(0, 100) });
          detectedSecondaryCharacters = null;
        }
        // Also clear secondaryCharacterDescription if the story planner generated one—
        // this would cause the illustration system to draw the parent explicitly
        if (storyPlan.secondaryCharacterDescription) {
          bookContext.log('info', 'Parent theme without cover parent — clearing storyPlan.secondaryCharacterDescription (parent must not be drawn explicitly)', { was: storyPlan.secondaryCharacterDescription.slice(0, 100) });
          storyPlan.secondaryCharacterDescription = null;
        }
      }

      // If we still have no characterAnchor but parent provided one, use it
      if (!storyPlan.characterAnchor && parentCharacterAnchor) {
        storyPlan.characterAnchor = parentCharacterAnchor;
        bookContext.log('info', '[generate-book] Using parentCharacterAnchor from parent book');
      }

      bookContext.log('info', 'Character reference ready', { refBytes: characterRefBase64?.length || 0, coverBytes: coverForIllustratorBase64?.length || 0, ms: Date.now() - stage6Start });

      // Birthday theme: ensure spread 13 illustration prompt shows cake/candles
      if (theme === 'birthday' && !isChapterBook && !storyPlan.isChapterBook) {
        const spreads = storyPlan.entries.filter(e => e.type === 'spread');
        const lastSpread = spreads[spreads.length - 1];
        if (lastSpread && lastSpread.spread_image_prompt) {
          const prompt = lastSpread.spread_image_prompt.toLowerCase();
          if (!prompt.includes('cake') && !prompt.includes('candle')) {
            const childAge = childDetails.age || childDetails.childAge || 5;
            const candleDesc = `${childAge} lit candles`;
            const childNameStr = childDetails.name || childDetails.childName || 'the child';
            const favoriteObj = storyPlan.recurringElement || v2Vars?.favorite_object || '';
            const favoriteClause = favoriteObj ? ` The ${favoriteObj} sits on the table nearby.` : '';
            lastSpread.spread_image_prompt = `${childNameStr} leaning toward a birthday cake with ${candleDesc}, cheeks puffed, about to blow out the candles. Warm golden candlelight illuminates their face from below. Soft confetti and party decorations in the background.${favoriteClause} The room glows with warmth, joy, and celebration. Close-up emotional moment.`;
            bookContext.log('info', 'Birthday: replaced last spread illustration prompt with locked cake/candles scene');
          }
        }
      }

      // Stage 4: Generate illustrations
      bookContext.checkAbort();
      let entriesWithIllustrations;
      let spreadEntries;
      let upsellCoversWithBuffers = []; // default empty; PICTURE_BOOK path overwrites below

      if (isChapterBook || storyPlan.isChapterBook) {
        // ── Chapter book: Generate 5 portrait chapter-opener illustrations (no text) ──
        bookContext.log('info', 'Starting chapter book illustration generation');
        if (progressCallbackUrl) {
          reportProgress(progressCallbackUrl, { bookId, stage: 'illustration', progress: 0.40, message: 'Generating chapter illustrations...', logs: bookContext.logs });
        }

        for (let i = 0; i < storyPlan.chapters.length; i++) {
          const chapter = storyPlan.chapters[i];
          bookContext.log('info', `Generating chapter ${i + 1} illustration`);
          try {
            const illus = await generateIllustration(
              chapter.imagePrompt || `A scene from chapter ${i + 1}: ${chapter.synopsis}`,
              null,
              storyPlan.coverArtStyle || style,
              {
                apiKeys, costTracker, bookId, bookContext,
                resolvedChildPhotoUrl: characterRef || resolvedChildPhotoUrl,
                _cachedPhotoBase64: characterRefBase64,
                _cachedPhotoMime: characterRefMime,
                characterRef: characterRefBase64,
                characterDescription: storyPlan.characterDescription,
                characterAnchor: storyPlan.characterAnchor,
                characterOutfit: storyPlan.characterOutfit,
                recurringElement: storyPlan.recurringElement,
                keyObjects: storyPlan.keyObjects,
                coverArtStyle: storyPlan.coverArtStyle,
                childName,
                childAge: parseInt(childDetails.age) || 10,
                isSpread: false,
                spreadIndex: i,
                totalSpreads: 5,
                promptInjection: 'PORTRAIT FORMAT: This is a 2:3 portrait illustration for a chapter book. Tall, not wide.',
                pageText: '',
                additionalCoverCharacters: storyPlan.additionalCoverCharacters || null,
                artStyle: style,
                theme: theme || null,
                parentOutfit: storyPlan.parentOutfit || null,
              }
            );
            // generateIllustration returns a GCS URL string directly
            let illustUrl = typeof illus === 'string' ? illus : null;
            chapter.imageBuffer = null; // will be downloaded later from the URL

            // ── C5: Post-generation consistency check (chapter book) ──
            const chapterRefBase64 = characterRefBase64;
            if (illustUrl && chapterRefBase64) {
              try {
                const { checkCharacterConsistency } = require('./services/illustrationGenerator');
                let genBase64 = null;
                try {
                  const checkResp = await fetch(illustUrl);
                  if (checkResp.ok) {
                    genBase64 = Buffer.from(await checkResp.arrayBuffer()).toString('base64');
                  }
                } catch {}
                if (genBase64) {
                  const consistency = await checkCharacterConsistency(genBase64, chapterRefBase64, storyPlan.characterAnchor, storyPlan.characterOutfit || '', storyPlan.additionalCoverCharacters || null);
                  if (!consistency.consistent) {
                    bookContext.log('warn', `Chapter ${i + 1} character inconsistency detected`, { issues: consistency.issues });
                    try {
                      const originalChapterPrompt = chapter.imagePrompt || `A scene from chapter ${i + 1}: ${chapter.synopsis}`;
                      const correctionNote = `IMPORTANT: Pay close attention to the character's appearance.\nThe child has: ${storyPlan.characterAnchor || ''}\nCore outfit: ${storyPlan.characterOutfit || ''}\nPrevious attempt issue: ${consistency.issues.join(', ')}`;
                      const correctedPrompt = correctionNote + '\n\n' + originalChapterPrompt;
                      bookContext.log('info', `Retrying chapter ${i + 1} with consistency correction`);
                      const retryResult = await generateIllustration(
                        correctedPrompt,
                        null,
                        storyPlan.coverArtStyle || style,
                        {
                          apiKeys, costTracker, bookId, bookContext,
                          resolvedChildPhotoUrl: characterRef || resolvedChildPhotoUrl,
                          _cachedPhotoBase64: characterRefBase64,
                          _cachedPhotoMime: characterRefMime,
                          characterRef: characterRefBase64,
                          characterDescription: storyPlan.characterDescription,
                          characterAnchor: storyPlan.characterAnchor,
                          characterOutfit: storyPlan.characterOutfit,
                          recurringElement: storyPlan.recurringElement,
                          keyObjects: storyPlan.keyObjects,
                          coverArtStyle: storyPlan.coverArtStyle,
                          childName,
                          childAge: parseInt(childDetails.age) || 10,
                          isSpread: false,
                          spreadIndex: i,
                          totalSpreads: 5,
                          promptInjection: 'PORTRAIT FORMAT: This is a 2:3 portrait illustration for a chapter book. Tall, not wide.',
                          pageText: '',
                          additionalCoverCharacters: storyPlan.additionalCoverCharacters || null,
                          artStyle: style,
                          theme: theme || null,
                          parentOutfit: storyPlan.parentOutfit || null,
                        }
                      );
                      if (retryResult && typeof retryResult === 'string') {
                        illustUrl = retryResult;
                        bookContext.log('info', `Chapter ${i + 1} consistency retry succeeded`);
                      }
                    } catch (retryErr) {
                      bookContext.log('warn', `Consistency retry failed for chapter ${i + 1}`, { error: retryErr.message });
                    }
                  } else {
                    bookContext.log('info', `Chapter ${i + 1} character consistency OK`);
                  }
                }
              } catch (checkErr) {
                bookContext.log('warn', `Consistency check error for chapter ${i + 1}`, { error: checkErr.message });
              }
            }

            chapter.illustrationUrl = illustUrl;
            bookContext.log('info', `Chapter ${i + 1} illustration done`);
            bookContext.touchActivity();
          } catch (illustErr) {
            bookContext.log('warn', `Chapter ${i + 1} illustration failed: ${illustErr.message}`);
          }
        }

        const illustrationFailures = storyPlan.chapters.filter(ch => !ch.illustrationUrl && !ch.imageBuffer).length;
        if (illustrationFailures > 0) {
          bookContext.log('warn', `${illustrationFailures}/${storyPlan.chapters.length} chapter illustrations failed`);
          bookWarnings.push(`${illustrationFailures} of ${storyPlan.chapters.length} chapter illustrations failed`);
        }
        // Set entriesWithIllustrations/spreadEntries to empty for chapter book (not used in standard flow)
        entriesWithIllustrations = [];
        spreadEntries = [];
      } else if (isGraphicNovel || storyPlan.isGraphicNovel) {
        // ── Graphic novel: Generate full-page illustrations ──
        const { normalizeGraphicNovelPlan } = require('./services/graphicNovelQa');
        storyPlan = normalizeGraphicNovelPlan(storyPlan, { fallbackTitle: storyPlan.title });
        bookContext.log('info', `Generating ${storyPlan.pages?.length || 0} full-page graphic novel illustrations`, {
          version: storyPlan.graphicNovelVersion || 'v2_premium',
          pages: storyPlan.pages?.length || 0,
        });
        if (progressCallbackUrl) {
          reportProgress(progressCallbackUrl, { bookId, stage: 'illustration', progress: 0.40, message: 'Generating graphic novel pages...', logs: bookContext.logs });
        }
        await generateGraphicNovelPages(storyPlan, childDetails, style, {
          apiKeys,
          costTracker,
          bookId,
          bookContext,
          progressCallbackUrl,
          resolvedChildPhotoUrl: characterRef || resolvedChildPhotoUrl,
          characterRefBase64,
          characterRefMime,
        });
        entriesWithIllustrations = [];
        spreadEntries = [];
      } else {
        // ── Standard picture/early reader illustration generation ──
        bookContext.log('info', 'Starting V2 illustration generation');
        if (progressCallbackUrl) {
          reportProgress(progressCallbackUrl, { bookId, stage: 'illustration', progress: 0.40, message: 'Generating illustrations...', logs: bookContext.logs });
        }

        // Safety: For parent themes, ensure photo-detected characters don't override implied presence
        // This catches cases where cover analysis didn't run (no approved cover yet)
        if (PARENT_THEMES.has(theme) && !storyPlan.additionalCoverCharacters) {
          if (detectedSecondaryCharacters) {
            bookContext.log('info', 'Pre-illustration safety: nullifying photo-detected secondary chars for parent theme implied presence');
            detectedSecondaryCharacters = null;
          }
        }

        entriesWithIllustrations = await generateAllIllustrations(storyPlan.entries, storyPlan, childDetails, characterRef, style, {
          apiKeys, costTracker, bookId, bookContext, progressCallbackUrl,
          resolvedChildPhotoUrl,
          cachedPhotoBase64: characterRefBase64,
          cachedPhotoMime: characterRefMime,
          existingIllustrations: checkpoint?.illustrationResults || [],
          checkpointData: { bookId, storyPlan },
          detectedSecondaryCharacters: detectedSecondaryCharacters || null,
          characterAnchor: storyPlan.characterAnchor || null,
          coverForIllustratorBase64: coverForIllustratorBase64 || null,
          theme,
        });

        bookContext.log('info', 'All illustrations complete', { entries: entriesWithIllustrations.length });

        spreadEntries = entriesWithIllustrations.filter(e => e.type === 'spread');
        const illustrationFailures = spreadEntries.filter(e => !e.spreadIllustrationUrl && !e.leftIllustrationUrl).length;
        if (illustrationFailures > 0) {
          bookContext.log('warn', `${illustrationFailures}/${spreadEntries.length} spread illustrations failed`);
          bookWarnings.push(`${illustrationFailures} of ${spreadEntries.length} illustrations failed`);
        }
      }

      // Note: old illustrations from previous runs are NOT deleted here.
      // They have unique timestamp-based filenames and don't collide with new ones.
      // Deleting them concurrently with PDF assembly caused 404 errors.

      // Stage 5: Assemble PDF
      const stage7Start = Date.now();
      bookContext.checkAbort();
      bookContext.log('info', 'Starting PDF assembly');
      if (progressCallbackUrl) {
        reportProgress(progressCallbackUrl, { bookId, stage: 'assembly', progress: 0.90, message: 'Assembling PDF...', logs: bookContext.logs });
      }

      // Download illustration URLs into buffers for PDF embedding
      // Use pLimit(2) — GCS TLS connections drop under high concurrency on Cloud Run
      // Retry up to 3 times with delay on TLS/network errors
      const downloadLimit = pLimit(2);
      async function downloadWithRetry(url, label, maxAttempts = 3) {
        let lastErr;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            const timeout = new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Download timed out after 120s: ${label}`)), 120000)
            );
            return await Promise.race([downloadBuffer(url), timeout]);
          } catch (err) {
            lastErr = err;
            const isTlsOrNetwork = err.message.includes('TLS') || err.message.includes('socket') || err.message.includes('network') || err.message.includes('ECONNRESET') || err.message.includes('timed out');
            if (attempt < maxAttempts && isTlsOrNetwork) {
              const delay = attempt * 2000; // 2s, 4s
              bookContext.log('warn', `Download attempt ${attempt} failed for ${label}, retrying in ${delay}ms`, { error: err.message.slice(0, 100) });
              await new Promise(r => setTimeout(r, delay));
            } else {
              throw lastErr;
            }
          }
        }
        throw lastErr;
      }

      const bookTitle = approvedTitle || storyPlan?.title || 'My Story';
      let interiorPdf;
      let entriesWithBuffers = [];
      let previewImageUrls;

      if (isChapterBook || storyPlan.isChapterBook) {
        // ── Chapter book PDF assembly ──
        // Download chapter illustration URLs into buffers
        for (let i = 0; i < storyPlan.chapters.length; i++) {
          const chapter = storyPlan.chapters[i];
          if (chapter.illustrationUrl && !chapter.imageBuffer) {
            try {
              chapter.imageBuffer = await downloadWithRetry(chapter.illustrationUrl, `chapter-${i + 1}`);
              bookContext.log('info', `Downloaded chapter ${i + 1} illustration buffer`);
            } catch (err) {
              bookContext.log('warn', `Failed to download chapter ${i + 1} illustration: ${err.message}`);
            }
          }
        }

        const chaptersWithBuffers = storyPlan.chapters.map(ch => ({
          chapterTitle: ch.chapterTitle,
          text: ch.text,
          imageBuffer: ch.imageBuffer || null,
        }));
        interiorPdf = await buildChapterBookPdf(chaptersWithBuffers, {
          title: bookTitle,
          childName: childDetails.name,
          bookFrom: bookFrom || '',
          dedication: dedication || '',
          year: new Date().getFullYear(),
          bookId,
          upsellCovers: [],
        });

        previewImageUrls = storyPlan.chapters.map(ch => ch.illustrationUrl).filter(Boolean);
      } else if (isGraphicNovel || storyPlan.isGraphicNovel) {
        // ── Graphic novel PDF assembly (full-page images) ──
        const { buildGraphicNovelPdf } = require('./services/layoutEngine');

        // Download page-level illustration buffers
        for (const page of storyPlan.pages || []) {
          if (page.illustrationUrl) {
            try { page.imageBuffer = await downloadWithRetry(page.illustrationUrl, `page-${page.pageNumber}`); }
            catch (e) { page.imageBuffer = null; }
          }
        }

        // ── Upsell covers: generate 4 styles BEFORE interior PDF so they can be baked in ──
        let gnUpsellCovers = [];
        if (preGeneratedCoverBuffer) {
          try {
            bookContext.log('info', 'Generating upsell covers for graphic novel (4 styles)...');
            const upsellCostTracker = new CostTracker();
            const upsellPromise = generateUpsellCovers(bookId, childDetails, preGeneratedCoverBuffer, bookTitle, {
              apiKeys, costTracker: upsellCostTracker,
              characterDescription: storyPlan?.characterDescription || null,
              characterAnchor: storyPlan?.characterAnchor || null,
              theme: theme || null,
              momDescription: (theme === 'mothers_day' && storyPlan?.additionalCoverCharacters) ? storyPlan.additionalCoverCharacters : null,
            }).catch(e => {
              console.warn(`[server] Upsell covers background error: ${e.message}`);
              return [];
            });
            const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 4 * 60 * 1000));
            const result = await Promise.race([upsellPromise, timeoutPromise]);
            costTracker.addFromSummary(upsellCostTracker.getSummary());
            if (result === null) {
              bookContext.log('warn', 'Upsell cover generation timed out after 4 min — continuing without upsell spread');
            } else {
              gnUpsellCovers = result;
              bookContext.log('info', `Upsell covers ready: ${gnUpsellCovers.length}/4 (upsell cost: $${upsellCostTracker.getSummary().totalCost.toFixed(4)})`);
            }
          } catch (upsellErr) {
            bookContext.log('warn', `Upsell covers failed (non-blocking): ${upsellErr.message}`);
          }
        }

        // Download upsell cover image buffers from GCS
        let gnValidUpsell = [];
        if (gnUpsellCovers.length > 0) {
          const upsellEntries = await Promise.all(
            gnUpsellCovers.map(async (uc) => {
              try {
                const buf = await downloadBuffer(uc.gcsPath);
                return { ...uc, coverBuffer: buf };
              } catch (e) {
                console.warn(`[server] Could not download upsell buffer ${uc.gcsPath}: ${e.message}`);
                return { ...uc, coverBuffer: null };
              }
            })
          );
          gnValidUpsell = upsellEntries.filter(u => u.coverBuffer);
          if (gnValidUpsell.length > 0) {
            bookContext.log('info', `Upsell covers downloaded for graphic novel (${gnValidUpsell.length} covers)`);
          }
        }
        upsellCoversWithBuffers = gnValidUpsell;

        interiorPdf = await buildGraphicNovelPdf([], {
          title: storyPlan.title || bookTitle,
          childName: childDetails.name,
          tagline: storyPlan.tagline || '',
          bookFrom: bookFrom || '',
          dedication,
          year: new Date().getFullYear(),
          pages: storyPlan.pages || [],
          upsellCovers: gnValidUpsell,
          bookId,
        });

        previewImageUrls = (storyPlan.pages || []).map(p => p.illustrationUrl).filter(Boolean);
        spreadEntries = (storyPlan.pages || []).map((p, i) => ({ type: 'page', index: i, illustrationUrl: p.illustrationUrl }));
      } else {
        // ── Standard picture/early reader PDF assembly ──
        bookContext.log('info', 'Downloading illustration buffers for PDF');
        entriesWithBuffers = await Promise.all(
          entriesWithIllustrations.map((entry) => downloadLimit(async () => {
            const result = { ...entry };

            if (entry.spreadIllustrationUrl) {
              try {
                result.spreadIllustrationBuffer = await downloadWithRetry(entry.spreadIllustrationUrl, `spread-${entry.spread || entry.type}`);
                bookContext.log('info', `Downloaded spread ${entry.spread || entry.type} illustration`);
              } catch (err) {
                bookContext.log('error', `Failed to download spread illustration`, { error: err.message, spread: entry.spread });
              }
            }

            if (entry.leftIllustrationUrl) {
              try {
                result.leftIllustrationBuffer = await downloadWithRetry(entry.leftIllustrationUrl, `left-${entry.spread}`);
              } catch (err) {
                bookContext.log('error', `Failed to download left illustration`, { error: err.message });
              }
            }
            if (entry.rightIllustrationUrl) {
              try {
                result.rightIllustrationBuffer = await downloadWithRetry(entry.rightIllustrationUrl, `right-${entry.spread}`);
              } catch (err) {
                bookContext.log('error', `Failed to download right illustration`, { error: err.message });
              }
            }

            if (entry.illustrationUrl) {
              try {
                result.illustrationBuffer = await downloadWithRetry(entry.illustrationUrl, entry.type);
                bookContext.log('info', `Downloaded ${entry.type} illustration`);
              } catch (err) {
                bookContext.log('error', `Failed to download ${entry.type} illustration`, { error: err.message });
              }
            }

            return result;
          }))
        );
        bookContext.log('info', 'All illustration buffers downloaded');

        // Interior title page is text-only — the cover image is for the cover PDF only.
        // Do NOT attach the cover image to the title page entry.

        // ── Upsell covers: generate 4 styles BEFORE interior PDF so they can be baked in ──
        let upsellCovers = [];
        if (preGeneratedCoverBuffer) {
          try {
            bookContext.log('info', 'Generating upsell covers (4 styles)...');
            const upsellCostTracker = new CostTracker();
            const parentDescription = ((theme === 'mothers_day' || theme === 'fathers_day') && storyPlan?.additionalCoverCharacters)
              ? storyPlan.additionalCoverCharacters : null;
            const upsellPromise = generateUpsellCovers(bookId, childDetails, preGeneratedCoverBuffer, bookTitle, {
              apiKeys, costTracker: upsellCostTracker,
              characterDescription: storyPlan?.characterDescription || null,
              characterAnchor: storyPlan?.characterAnchor || null,
              theme: theme || null,
              momDescription: parentDescription,
            }).catch(e => {
              console.warn(`[server] Upsell covers background error: ${e.message}`);
              return [];
            });
            const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 4 * 60 * 1000));
            const result = await Promise.race([upsellPromise, timeoutPromise]);
            costTracker.addFromSummary(upsellCostTracker.getSummary());
            if (result === null) {
              bookContext.log('warn', 'Upsell cover generation timed out after 4 min — continuing without upsell spread');
            } else {
              upsellCovers = result;
              bookContext.log('info', `Upsell covers ready: ${upsellCovers.length}/4 (upsell cost: $${upsellCostTracker.getSummary().totalCost.toFixed(4)})`);
            }
          } catch (upsellErr) {
            bookContext.log('warn', `Upsell covers failed (non-blocking): ${upsellErr.message}`);
          }
        }

        // Download upsell cover image buffers from GCS and inject as upsell_spread entry
        if (upsellCovers.length > 0) {
          const upsellEntries = await Promise.all(
            upsellCovers.map(async (uc) => {
              try {
                const buf = await downloadBuffer(uc.gcsPath);
                return { ...uc, coverBuffer: buf };
              } catch (e) {
                console.warn(`[server] Could not download upsell buffer ${uc.gcsPath}: ${e.message}`);
                return { ...uc, coverBuffer: null };
              }
            })
          );
          const validUpsell = upsellEntries.filter(u => u.coverBuffer);
          if (validUpsell.length > 0) {
            const upsellEntry = {
              type: 'upsell_spread',
              upsellCovers: validUpsell,
              childName: childDetails.name || childDetails.childName,
              bookId,
              tagline: `What will ${childDetails.name || childDetails.childName}\'s next story be?`,
            };
            const closingIdx = entriesWithBuffers.findIndex(e => e.type === 'closing_page');
            if (closingIdx >= 0) {
              entriesWithBuffers.splice(closingIdx, 0, upsellEntry);
            } else {
              entriesWithBuffers.push(upsellEntry);
            }
            bookContext.log('info', `Upsell spread injected into interior PDF (${validUpsell.length} covers)`);
          }
        }

        upsellCoversWithBuffers = entriesWithBuffers.find(e => e.type === 'upsell_spread')?.upsellCovers || [];
        interiorPdf = await assemblePdf(entriesWithBuffers, format, {
          title: bookTitle,
          childName: childDetails.name,
          dedication,
          bookFrom,
          year: new Date().getFullYear(),
          bookId,
          upsellCovers: upsellCoversWithBuffers,
          minPages: emotionalTierInfo ? emotionalTierInfo.minPages : 32,
        });

        previewImageUrls = entriesWithIllustrations
          .filter(e => e.spreadIllustrationUrl || e.illustrationUrl || e.leftIllustrationUrl)
          .map(e => e.spreadIllustrationUrl || e.illustrationUrl || e.leftIllustrationUrl);
      }

      bookContext.touchActivity();
      bookContext.log('info', 'Interior PDF assembled', { ms: Date.now() - stage7Start });

      console.log(`[server] Stage timing: pdf=${Date.now() - stage7Start}ms (book ${bookId})`);

      // Stage 6: Upload interior PDF to GCS
      bookContext.log('info', 'Uploading interior PDF to storage');
      reportProgressForce(progressCallbackUrl, { bookId, stage: 'upload', progress: 0.92, message: 'Uploading interior PDF...', logs: bookContext.logs }).catch(() => {});
      const interiorPath = `children-jobs/${bookId}/interior.pdf`;
      await uploadBuffer(interiorPdf, interiorPath, 'application/pdf');
      const interiorPdfUrl = await getSignedUrl(interiorPath, 30 * 24 * 60 * 60 * 1000);
      bookContext.log('info', 'Interior PDF uploaded');

      // Stage 7: Build cover PDF separately (after interior is done)
      let coverPdfUrl = null;
      let coverData = null;
      const coverPath = `children-jobs/${bookId}/cover.pdf`;
      try {
        bookContext.log('info', 'Building cover PDF...');
        reportProgressForce(progressCallbackUrl, { bookId, stage: 'cover', progress: 0.95, message: 'Building cover PDF...', logs: bookContext.logs }).catch(() => {});
        // Calculate interior page count + back-cover synopsis using the
        // shared helper so the admin rebuild flow produces identical output.
        // For regular books the helper needs `entries` to derive pageCount,
        // so we hand it a synthetic source that mirrors storyPlan but with
        // entriesWithBuffers (has the authoritative page layout for this run).
        const coverMetaSource = (isGraphicNovel || storyPlan.isGraphicNovel || isChapterBook || storyPlan.isChapterBook)
          ? storyPlan
          : { ...storyPlan, entries: entriesWithBuffers };
        const { pageCount, synopsis } = computeCoverPdfMetadata(
          coverMetaSource,
          childDetails,
          {
            isChapterBook:  isChapterBook  || storyPlan.isChapterBook,
            isGraphicNovel: isGraphicNovel || storyPlan.isGraphicNovel,
          },
        );

        coverData = await generateCover(bookTitle, childDetails, characterRef, format, {
          apiKeys, costTracker, bookId, preGeneratedCoverBuffer, pageCount, synopsis,
          heartfeltNote, bookFrom, bindingType,
        });
        if (coverData?.coverPdfBuffer) {
          await uploadBuffer(coverData.coverPdfBuffer, coverPath, 'application/pdf');
          coverPdfUrl = await getSignedUrl(coverPath, 30 * 24 * 60 * 60 * 1000);
          bookContext.log('info', 'Cover PDF uploaded');
        }
      } catch (coverErr) {
        bookContext.log('error', 'Cover PDF failed (non-blocking)', { error: coverErr.message });
      }

      const totalMs = Date.now() - bookStartTime;
      const costSummary = costTracker.getSummary();
      const itemCount = (isGraphicNovel || storyPlan.isGraphicNovel)
        ? (storyPlan.allPanels || []).length
        : (isChapterBook || storyPlan.isChapterBook) ? storyPlan.chapters.length : entriesWithIllustrations.length;
      bookContext.log('info', 'Book complete', { totalMs, items: itemCount, cost: `$${costSummary.totalCost.toFixed(4)}`, warnings: bookWarnings.length });

      // Build storyContent for DB
      let storyContent;
      if (isGraphicNovel || storyPlan.isGraphicNovel) {
        storyContent = {
          title: storyPlan.title || bookTitle,
          isGraphicNovel: true,
          tagline: storyPlan.tagline || '',
          characterDescription: storyPlan.characterDescription || null,
          characterAnchor: storyPlan.characterAnchor || null,
          scenes: storyPlan.scenes?.map(s => ({
            number: s.number, sceneTitle: s.sceneTitle,
            panels: s.panels?.map(p => ({ panelNumber: p.panelNumber, caption: p.caption, illustrationUrl: p.illustrationUrl || null }))
          })) || [],
        };
      } else if (isChapterBook || storyPlan.isChapterBook) {
        storyContent = {
          title: bookTitle,
          isChapterBook: true,
          characterDescription: storyPlan.characterDescription || null,
          characterAnchor: storyPlan.characterAnchor || null,
          characterOutfit: storyPlan.characterOutfit || null,
          chapters: storyPlan.chapters.map(ch => ({
            number: ch.number,
            chapterTitle: ch.chapterTitle,
            synopsis: ch.synopsis,
            text: ch.text,
            illustrationUrl: ch.illustrationUrl || null,
          })),
        };
      } else {
        storyContent = {
          title: bookTitle,
          entries: entriesWithIllustrations.map(e => ({ type: e.type, spread: e.spread, left: e.left, right: e.right, hasImage: !!(e.spreadIllustrationUrl || e.illustrationUrl) })),
          characterDescription: storyPlan.characterDescription || null,
          characterOutfit: storyPlan.characterOutfit || null,
          characterAnchor: storyPlan.characterAnchor || null,
          additionalCoverCharacters: storyPlan.additionalCoverCharacters || null,
        };
      }

      // Report completion (with retry)
      if (callbackUrl) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await fetch(callbackUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY || '' },
              body: JSON.stringify({
                success: true,
                bookId,
                interiorPdfUrl,
                coverPdfUrl,
                backCoverImageUrl: coverData?.backCoverImageUrl || null,
                previewImageUrls,
                title: bookTitle,
                spreadCount: spreadEntries.length,
                storyContent,
                upsellCovers: upsellCoversWithBuffers.map(uc => ({ index: uc.index, coverUrl: uc.coverUrl, gcsPath: uc.gcsPath, style: uc.style, label: uc.label })),
                costs: costSummary,
                emotionalCategory: emotionalCategory || null,
                warnings: bookWarnings.length > 0 ? bookWarnings : undefined,
                logs: bookContext.logs,
              }),
            });
            break;
          } catch (cbErr) {
            console.error(`[server] Completion callback attempt ${attempt + 1}/3 failed:`, cbErr.message);
            if (attempt < 2) await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
          }
        }
      }

      if (progressCallbackUrl) {
        reportComplete(progressCallbackUrl, {
          bookId,
          interiorPdfUrl,
          coverPdfUrl,
          previewImageUrls,
          title: bookTitle,
          spreadCount: spreadEntries.length,
          storyContent,
          upsellCovers: upsellCoversWithBuffers.map(uc => ({ index: uc.index, coverUrl: uc.coverUrl, gcsPath: uc.gcsPath, style: uc.style, label: uc.label })),
          costs: costSummary,
          emotionalCategory: emotionalCategory || null,
          warnings: bookWarnings.length > 0 ? bookWarnings : undefined,
          logs: bookContext.logs,
        });
      }

      // Clear checkpoint on successful completion
      await clearCheckpoint(bookId);

      console.log(`[server] Book ${bookId} complete: ${itemCount} items, cost: $${costSummary.totalCost.toFixed(4)}`);
    } catch (err) {
      bookContext.log('error', 'Book generation failed', { error: err.message, totalMs: Date.now() - bookStartTime });
      console.error(`[server] Book ${bookId} failed:`, err);

      if (callbackUrl) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const errorAbort = new AbortController();
            const errorTimeout = setTimeout(() => errorAbort.abort(), 10000);
            await fetch(callbackUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY || '' },
              body: JSON.stringify({ success: false, bookId, error: err.message, logs: bookContext.logs }),
              signal: errorAbort.signal,
            });
            clearTimeout(errorTimeout);
            break;
          } catch (cbErr) {
            console.error(`[server] Error callback attempt ${attempt + 1}/3 failed:`, cbErr.message);
            if (attempt < 2) await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
          }
        }
      }

      if (progressCallbackUrl) {
        reportError(progressCallbackUrl, { bookId, error: err.message, logs: bookContext.logs });
      }
    } finally {
      clearInterval(heartbeatInterval);
      clearTimeout(absoluteTimer);
      clearTimeout(hardTimeoutId);
      removeBookContext(bookId);
    }
  })();

  // Hard wall: kill generation after 90 minutes no matter what
  const hardTimeout = new Promise((_, reject) => {
    hardTimeoutId = setTimeout(() => reject(new Error('Generation exceeded 90 minute hard limit')), 90 * 60 * 1000);
  });

  Promise.race([generationWork, hardTimeout]).catch(async (err) => {
    console.error(`[server] Book ${bookId} hit hard timeout: ${err.message}`);
    bookContext.log('error', 'Hard timeout reached', { error: err.message });
    const timeoutPayload = { success: false, bookId, error: err.message, logs: bookContext.logs };
    if (callbackUrl) {
      try {
        await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY || '' },
          body: JSON.stringify(timeoutPayload),
        });
      } catch (cbErr) {
        console.error(`[server] Failed to report hard timeout: ${cbErr.message}`);
      }
    }
    if (progressCallbackUrl) {
      reportError(progressCallbackUrl, timeoutPayload).catch(() => {});
    }
    bookContext.abortController.abort();
    clearInterval(heartbeatInterval);
    clearTimeout(absoluteTimer);
    removeBookContext(bookId);
  });
});

// ── POST /regenerate-illustration ──
// Regenerate a single spread using Illustrator V2 pipeline.
// Called by admin "regenerate illustration" button.
app.post('/regenerate-illustration', authenticate, async (req, res) => {
  const { bookId, spreadIndex, spreadImagePrompt, promptInjection, pageText, artStyle,
    additionalCoverCharacters, totalSpreads, theme, parentOutfit,
    childPhotoUrl, cachedPhotoBase64, coverImageUrl, firstSpreadRefUrl } = req.body;

  if (!bookId || typeof spreadIndex !== 'number') {
    return res.status(400).json({ success: false, error: 'bookId and spreadIndex are required' });
  }
  if (!spreadImagePrompt) {
    return res.status(400).json({ success: false, error: 'spreadImagePrompt is required' });
  }

  console.log(`[server] /regenerate-illustration (V2): bookId=${bookId}, spread=${spreadIndex}${promptInjection ? ' [+injection]' : ''}`);

  const costTracker = new CostTracker();
  const style = artStyle || 'pixar_premium';

  try {
    const { downloadPhotoAsBase64 } = require('./services/illustrationGenerator');

    // Download child photo as base64
    let childPhotoB64 = cachedPhotoBase64 || null;
    if (!childPhotoB64 && childPhotoUrl) {
      try {
        const photo = await downloadPhotoAsBase64(childPhotoUrl);
        childPhotoB64 = photo.base64;
      } catch (e) {
        console.warn(`[regen] Could not download child photo: ${e.message}`);
      }
    }

    // Download cover image as base64 (used by V2 for character consistency)
    let coverB64 = null;
    if (coverImageUrl) {
      try {
        const cover = await downloadPhotoAsBase64(coverImageUrl);
        coverB64 = cover.base64;
      } catch (e) {
        console.warn(`[regen] Could not download cover: ${e.message}`);
      }
    }
    // Fall back to first spread reference as cover substitute
    if (!coverB64 && firstSpreadRefUrl) {
      try {
        const ref = await downloadPhotoAsBase64(firstSpreadRefUrl);
        coverB64 = ref.base64;
      } catch (e) {
        console.warn(`[regen] Could not download first spread ref: ${e.message}`);
      }
    }

    // Split page text into left/right if possible
    const fullText = pageText || '';
    const lines = fullText.split('\n').filter(l => l.trim());
    let leftText = fullText, rightText = null;
    if (lines.length >= 2) {
      const mid = Math.ceil(lines.length / 2);
      leftText = lines.slice(0, mid).join('\n');
      rightText = lines.slice(mid).join('\n');
    }

    let scenePrompt = spreadImagePrompt;
    if (promptInjection) {
      scenePrompt += `\n\nADDITIONAL INSTRUCTIONS: ${promptInjection}`;
    }

    const { IllustratorEngine } = require('./services/illustrator/engine');
    const illustrator = new IllustratorEngine();

    const result = await illustrator.generateSingleSpread({
      scenePrompt,
      spreadText: fullText,
      leftText,
      rightText,
      style,
      coverBase64: coverB64,
      childPhotoBase64: childPhotoB64,
      theme: theme || null,
      additionalCoverCharacters: additionalCoverCharacters || null,
      parentOutfit: parentOutfit || null,
      spreadIndex,
      totalSpreads: totalSpreads || 13,
      costTracker,
    });

    // Upload to GCS
    const gcsPath = `children-jobs/${bookId}/illustrations/spread-${spreadIndex}-${Date.now()}.png`;
    await uploadBuffer(result.imageBuffer, gcsPath, 'image/png');
    const newUrl = await getSignedUrl(gcsPath, 30 * 24 * 60 * 60 * 1000);

    console.log(`[server] Illustration regenerated (V2) for book ${bookId}, spread ${spreadIndex}`);

    res.json({
      success: true,
      bookId,
      spreadIndex,
      illustrationUrl: newUrl,
      costs: costTracker.getSummary(),
    });
  } catch (err) {
    console.error(`[server] Regenerate illustration failed for ${bookId} spread ${spreadIndex}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// /generate-spread removed — V2 pipeline generates sequentially, this endpoint was unused.

// ── POST /generate-coloring-book ──────────────────────────────────────────────
// Async endpoint: returns 202 immediately, processes in background, reports via callbackUrl.
// mode=trace  (default): converts existing spread illustrations to coloring pages.
// mode=generate: creates original coloring scenes from scenePrompts + child photo.
app.post('/generate-coloring-book', authenticate, async (req, res) => {
  const {
    bookId, childName, title, illustrationUrls,
    mode = 'trace',
    scenePrompts, childPhotoUrl, characterDescription, characterAnchorUrl,
    synopsis, age, sceneCount,
    pagesOnly = false,
    parentCoverImageUrl,
    parentCoverMime,
    storyMoments,
    questionnaire,
    callbackUrl,
    progressCallbackUrl,
  } = req.body;

  if (!bookId) {
    return res.status(400).json({ success: false, error: 'bookId is required' });
  }

  if (mode === 'trace') {
    if (!Array.isArray(illustrationUrls) || illustrationUrls.length === 0) {
      return res.status(400).json({ success: false, error: 'illustrationUrls[] is required for trace mode' });
    }
  } else if (mode === 'generate') {
    if (!Array.isArray(scenePrompts) && !title) {
      return res.status(400).json({ success: false, error: 'generate mode requires scenePrompts[] or at least title for auto-planning' });
    }
  } else {
    return res.status(400).json({ success: false, error: `Invalid mode "${mode}" — use "trace" or "generate"` });
  }

  console.log(`[server] /generate-coloring-book: bookId=${bookId}, mode=${mode}, callbackUrl=${callbackUrl ? 'yes' : 'none'}`);

  res.status(202).json({ success: true, bookId, status: 'generating' });

  // Background generation
  (async () => {
    const startMs = Date.now();

    async function reportProgress(stage, progress, message) {
      if (!progressCallbackUrl) return;
      const payload = { bookId, stage, progress, message };
      fetch(progressCallbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY || '' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    }

    try {
      const { generateColoringPages, generateOriginalColoringPages, planColoringScenes, generateCoverArtFromParent } = require('./services/coloringBookGenerator');
      const { downloadPhotoAsBase64 } = require('./services/illustrationGenerator');
      const { buildColoringBookPdf, buildInteriorPdf, buildCoverWrapPdf, generateCoverThumbnailPng, imageToPreviewPng } = require('./services/coloringBookLayout');
      const { uploadBuffer } = require('./services/gcsStorage');

      await reportProgress('planning', 0.05, 'Preparing coloring book generation');

      let parentCoverBuffer = null;
      let parentCoverMimeResolved = parentCoverMime || null;
      if (parentCoverImageUrl && !pagesOnly) {
        try {
          const photo = await downloadPhotoAsBase64(parentCoverImageUrl);
          parentCoverBuffer = Buffer.from(photo.base64, 'base64');
          if (!parentCoverMimeResolved) parentCoverMimeResolved = photo.mimeType;
          console.log(`[server] Downloaded parent cover for coloring derivation (${Math.round(parentCoverBuffer.length / 1024)}KB, ${parentCoverMimeResolved || 'unknown mime'})`);
        } catch (err) {
          console.warn(`[server] Could not download parent cover, will generate from scratch: ${err.message}`);
        }
      }

      // Pre-download the child photo + character anchor once so they can be
      // shared across cover generation (back cover needs the child face) and
      // interior page generation.
      let characterRef = null;
      if (childPhotoUrl) {
        try {
          characterRef = await downloadPhotoAsBase64(childPhotoUrl);
        } catch (err) {
          console.warn(`[server] Could not download child photo: ${err.message}`);
        }
      }
      let characterAnchor = null;
      if (characterAnchorUrl) {
        try {
          characterAnchor = await downloadPhotoAsBase64(characterAnchorUrl);
        } catch (err) {
          console.warn(`[server] Could not download character anchor: ${err.message}`);
        }
      }

      let coverArtPromise = null;
      if (!pagesOnly) {
        coverArtPromise = generateCoverArtFromParent({
          childName, title, age, characterDescription,
          parentCoverBuffer,
          parentCoverMime: parentCoverMimeResolved,
          questionnaire,
          characterRef,
          characterAnchor,
        })
          .catch(err => {
            console.warn(`[server] Cover art generation failed, will fall back to programmatic covers: ${err.message}`);
            return null;
          });
      }

      let pages;
      let totalScenes;

      if (mode === 'trace') {
        totalScenes = illustrationUrls.length;
        await reportProgress('illustration', 0.10, `Converting ${totalScenes} illustrations to coloring pages`);
        pages = await generateColoringPages(illustrationUrls);
      } else {
        let resolvedScenePrompts = scenePrompts;
        if (!Array.isArray(resolvedScenePrompts) || resolvedScenePrompts.length === 0) {
          await reportProgress('planning', 0.08, 'Planning coloring scenes from book story');
          resolvedScenePrompts = await planColoringScenes({
            title, synopsis, characterDescription, childName, age,
            count: sceneCount || 12,
            storyMoments: Array.isArray(storyMoments) ? storyMoments : undefined,
          });
          console.log(`[server] Planned ${resolvedScenePrompts.length} coloring scenes${Array.isArray(storyMoments) && storyMoments.length ? ` (grounded in ${storyMoments.length} parent story moments)` : ''}`);
        }
        totalScenes = resolvedScenePrompts.length;
        await reportProgress('illustration', 0.10, `Generating ${totalScenes} coloring pages`);

        pages = await generateOriginalColoringPages(resolvedScenePrompts, characterRef, {
          characterDescription,
          characterAnchor,
          onPageComplete: (doneCount) => {
            const pct = 0.10 + (doneCount / totalScenes) * 0.65;
            reportProgress('illustration', pct, `Coloring page ${doneCount}/${totalScenes} done`);
          },
        });
      }

      const totalPages = pages.length;
      const successCount = pages.filter(p => p.success).length;
      console.log(`[server] Coloring page ${mode}: ${successCount}/${totalPages} succeeded`);

      await reportProgress('cover', 0.78, 'Generating cover art');
      const coverArt = coverArtPromise ? await coverArtPromise : null;
      const frontCoverBuffer = coverArt?.frontCoverBuffer;
      const backCoverBuffer = coverArt?.backCoverBuffer;
      if (coverArt) {
        console.log(`[server] AI cover art generated — front: ${Math.round(frontCoverBuffer.length / 1024)}KB, back: ${Math.round(backCoverBuffer.length / 1024)}KB`);
      }

      const firstSuccessPage = pages.find(p => p.success && p.buffer);
      const coverImageBuffer = firstSuccessPage ? firstSuccessPage.buffer : undefined;

      await reportProgress('assembly', 0.82, 'Building PDFs');
      const [legacyPdfBuffer, interiorPdfBuffer, coverPdfBuffer] = await Promise.all([
        buildColoringBookPdf(pages, { title, childName, pagesOnly, coverImageBuffer, frontCoverBuffer }),
        pagesOnly ? null : buildInteriorPdf(pages, { title, childName }),
        pagesOnly ? null : buildCoverWrapPdf({ title, childName, frontCoverBuffer, backCoverBuffer, coverImageBuffer }),
      ]);
      console.log(`[server] Coloring book PDFs built — legacy: ${Math.round(legacyPdfBuffer.length / 1024)}KB` +
        (interiorPdfBuffer ? `, interior: ${Math.round(interiorPdfBuffer.length / 1024)}KB` : '') +
        (coverPdfBuffer ? `, cover: ${Math.round(coverPdfBuffer.length / 1024)}KB` : ''));

      await reportProgress('upload', 0.88, 'Uploading files');
      const gcsBase = `children-jobs/${bookId}/coloring`;
      const uploadPromises = [
        uploadBuffer(legacyPdfBuffer, `${gcsBase}/legacy.pdf`, 'application/pdf'),
      ];
      if (interiorPdfBuffer) {
        uploadPromises.push(uploadBuffer(interiorPdfBuffer, `${gcsBase}/interior.pdf`, 'application/pdf'));
      }
      if (coverPdfBuffer) {
        uploadPromises.push(uploadBuffer(coverPdfBuffer, `${gcsBase}/cover.pdf`, 'application/pdf'));
      }

      const pngPromises = [];
      if (!pagesOnly && (frontCoverBuffer || coverImageBuffer)) {
        pngPromises.push(
          generateCoverThumbnailPng({ title, childName, frontCoverBuffer, coverImageBuffer })
            .then(buf => uploadBuffer(buf, `${gcsBase}/cover-thumbnail.png`, 'image/png'))
        );
      }

      const previewPages = pages.filter(p => p.success && p.buffer).slice(0, 3);
      for (let i = 0; i < previewPages.length; i++) {
        pngPromises.push(
          imageToPreviewPng(previewPages[i].buffer, 800)
            .then(buf => uploadBuffer(buf, `${gcsBase}/preview-${i + 1}.png`, 'image/png'))
        );
      }

      const [legacyUrl, ...restUrls] = await Promise.all(uploadPromises);
      const interiorPdfUrl = interiorPdfBuffer ? restUrls[0] : undefined;
      const coverPdfUrl = coverPdfBuffer ? restUrls[interiorPdfBuffer ? 1 : 0] : undefined;

      const pngUrls = await Promise.all(pngPromises);
      const coverImageUrl = (!pagesOnly && (frontCoverBuffer || coverImageBuffer)) ? pngUrls[0] : undefined;
      const previewImageUrls = pngUrls.slice(coverImageUrl ? 1 : 0);

      console.log(`[server] Coloring book uploaded — legacy: ${legacyUrl.slice(0, 80)}`);
      if (interiorPdfUrl) console.log(`[server] Interior PDF: ${interiorPdfUrl.slice(0, 80)}`);
      if (coverPdfUrl) console.log(`[server] Cover PDF: ${coverPdfUrl.slice(0, 80)}`);

      const failedErrors = pages.filter(p => !p.success).map(p => p.error).filter(Boolean);
      const result = {
        success: true,
        bookId,
        coloringBookPdfUrl: legacyUrl,
        interiorPdfUrl,
        coverPdfUrl,
        coverImageUrl,
        previewImageUrls,
        successCount,
        totalPages,
        failedErrors,
        mode,
        elapsedMs: Date.now() - startMs,
      };

      if (callbackUrl) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await fetch(callbackUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY || '' },
              body: JSON.stringify(result),
            });
            console.log(`[server] Coloring book callback sent to ${callbackUrl}`);
            break;
          } catch (cbErr) {
            console.error(`[server] Coloring callback attempt ${attempt + 1}/3 failed: ${cbErr.message}`);
            if (attempt < 2) await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
          }
        }
      }
    } catch (err) {
      console.error(`[server] /generate-coloring-book background failed (${mode}): ${err.message}`);
      if (callbackUrl) {
        const errorResult = { success: false, bookId, error: err.message, mode, elapsedMs: Date.now() - startMs };
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await fetch(callbackUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY || '' },
              body: JSON.stringify(errorResult),
            });
            break;
          } catch (cbErr) {
            if (attempt < 2) await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
          }
        }
      }
    }
  })();
});

// ── POST /finalize-book ──
// Assemble all spreads into final PDF
app.post('/finalize-book', authenticate, async (req, res) => {
  const { valid, errors } = validateFinalizeBookRequest(req.body);
  if (!valid) {
    return res.status(400).json({ success: false, errors });
  }

  const { bookId, title, spreads, pages, coverData, bookFormat, childName, bookFrom, dedication, heartfeltNote, tagline, upsellCovers, apiKeys, coverImageUrl, childDetails } = req.body;
  const isGraphicNovel = bookFormat === 'GRAPHIC_NOVEL';
  // Build dedication from heartfeltNote + bookFrom (same logic as main generation flow)
  const resolvedDedication = dedication || (heartfeltNote ? (bookFrom ? `From ${bookFrom}:\n${heartfeltNote}` : heartfeltNote) : (bookFrom ? `From ${bookFrom}` : `For ${childName || 'the child'}`));

  console.log(`[server] /finalize-book: bookId=${bookId}, format=${bookFormat || 'picture_book'}, ${isGraphicNovel ? `pages=${(pages || []).length}` : `spreads=${(spreads || []).length}`}`);
  const bookContext = createBookContext(bookId);

  try {
    // Download upsell cover buffers if provided
    let resolvedUpsellCovers = [];
    if (Array.isArray(upsellCovers) && upsellCovers.length > 0) {
      resolvedUpsellCovers = await Promise.all(upsellCovers.map(async uc => {
        try {
          // Prefer gcsPath (direct GCS read, never expires) over coverUrl (may be expired signed URL)
          let coverBuffer = null;
          if (uc.gcsPath) {
            const { Storage } = require('@google-cloud/storage');
            const storage = new Storage();
            const bucket = storage.bucket(process.env.GCS_BUCKET_NAME || 'giftmybook-bucket');
            const [contents] = await bucket.file(uc.gcsPath).download();
            coverBuffer = contents;
          } else if (uc.coverUrl && uc.coverUrl.startsWith('data:')) {
            const base64Data = uc.coverUrl.split(',')[1];
            coverBuffer = Buffer.from(base64Data, 'base64');
          } else if (uc.coverUrl) {
            coverBuffer = await downloadBuffer(uc.coverUrl);
          }
          return { ...uc, coverBuffer };
        } catch(e) {
          console.warn(`[finalize-book] Could not load upsell cover ${uc.index}: ${e.message}`);
          return { ...uc, coverBuffer: null };
        }
      }));
      resolvedUpsellCovers = resolvedUpsellCovers.filter(u => u.coverBuffer);
    }

    // Generate upsell covers on-the-fly if none provided but cover image available
    if (resolvedUpsellCovers.length === 0 && coverImageUrl) {
      try {
        console.log(`[finalize-book] No upsell covers provided — generating from cover image for ${bookId}`);
        const coverBuffer = await downloadBuffer(coverImageUrl);
        const { normaliseGender } = require('./services/validation');
        const details = childDetails || { name: childName, age: 5 };
        // Normalise incoming gender ('boy' | 'girl' | 'other' from the client DB)
        // to the internal vocabulary so the upsell AI prompts render the child
        // with the correct gender.
        details.gender = normaliseGender(details.childGender || details.gender);
        const generated = await generateUpsellCovers(bookId, details, coverBuffer, title || 'My Story', {});
        if (generated && generated.length > 0) {
          const entries = await Promise.all(generated.map(async uc => {
            try {
              const buf = await downloadBuffer(uc.gcsPath);
              return { ...uc, coverBuffer: buf };
            } catch (e) {
              console.warn(`[finalize-book] Could not download generated upsell cover ${uc.index}: ${e.message}`);
              return { ...uc, coverBuffer: null };
            }
          }));
          resolvedUpsellCovers = entries.filter(u => u.coverBuffer);
          console.log(`[finalize-book] Generated ${resolvedUpsellCovers.length} upsell covers for ${bookId}`);
        }
      } catch (upsellGenErr) {
        console.warn(`[finalize-book] Upsell cover generation failed (non-blocking): ${upsellGenErr.message}`);
      }
    }

    let pdfBuffer;
    if (isGraphicNovel) {
      // ── Graphic novel: download page images and build with buildGraphicNovelPdf ──
      const { buildGraphicNovelPdf } = require('./services/layoutEngine');

      const pagesWithBuffers = [];
      for (const page of pages) {
        let imageBuffer = null;
        if (page.imageUrl) {
          try { imageBuffer = await downloadBuffer(page.imageUrl); } catch (e) {
            console.warn(`[finalize-book] Could not download page image: ${e.message}`);
          }
        }
        pagesWithBuffers.push({ ...page, imageBuffer });
        bookContext.touchActivity();
      }

      pdfBuffer = await buildGraphicNovelPdf([], {
        title: title || 'My Story',
        childName: childName || '',
        tagline: tagline || '',
        dedication: resolvedDedication,
        year: new Date().getFullYear(),
        pages: pagesWithBuffers,
        upsellCovers: resolvedUpsellCovers,
        bookId,
      });
    } else {
      // ── Standard picture/early-reader: spread-based PDF assembly ──
      const spreadsWithBuffers = [];
      for (const spread of spreads) {
        let imageBuffer = null;
        if (spread.imageUrl) {
          try { imageBuffer = await downloadBuffer(spread.imageUrl); } catch(e) {
            console.warn(`[finalize-book] Could not download spread image: ${e.message}`);
          }
        }
        spreadsWithBuffers.push({ ...spread, spreadIllustrationBuffer: imageBuffer });
        bookContext.touchActivity();
      }

      pdfBuffer = await assemblePdf(spreadsWithBuffers, bookFormat || 'picture_book', {
        title: title || 'My Story',
        childName: childName || '',
        bookFrom: bookFrom || '',
        dedication: resolvedDedication,
        year: new Date().getFullYear(),
        bookId,
        upsellCovers: resolvedUpsellCovers,
      });
    }
    bookContext.touchActivity();

    // Upload to GCS
    const pdfPath = `children-jobs/${bookId}/interior.pdf`;
    await uploadBuffer(pdfBuffer, pdfPath, 'application/pdf');
    const pdfUrl = await getSignedUrl(pdfPath, 30 * 24 * 60 * 60 * 1000);

    removeBookContext(bookId);
    res.json({ success: true, bookId, interiorPdfUrl: pdfUrl });
  } catch (err) {
    removeBookContext(bookId);
    console.error(`[server] Finalize failed for ${bookId}:`, err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /rebuild-cover-pdf — Rebuild cover PDF only (binding-aware) ──
//
// Rebuilds the Lulu wrap-around cover PDF using the exact same pipeline as
// initial book generation (services/coverGenerator.generateCover), so that
// flipping the binding type (paperback ↔ hardcover) or re-running after an
// edit produces bit-for-bit equivalent output.
//
// The admin caller is expected to pass the persisted `storyContent` so that
// pageCount (spine width) and synopsis (back cover) match what the main
// pipeline would have produced. The `isChapterBook` / `isGraphicNovel`
// flags let us pick the right branch when storyContent doesn't encode them.
app.post('/rebuild-cover-pdf', authenticate, async (req, res) => {
  const {
    bookId,
    title,
    childDetails,
    coverImageUrl,
    bindingType,
    bookFormat,
    storyContent,
    isChapterBook,
    isGraphicNovel,
    heartfeltNote,
    bookFrom,
    // Legacy fields (still accepted for backward compatibility with older clients):
    pageCount: legacyPageCount,
    synopsis: legacySynopsis,
  } = req.body;

  if (!bookId || !coverImageUrl) {
    return res.status(400).json({ error: 'bookId and coverImageUrl required' });
  }

  try {
    console.log(`[rebuild-cover-pdf] Starting for book ${bookId}, binding=${bindingType}`);
    const preGeneratedCoverBuffer = await downloadBuffer(coverImageUrl);

    // Prefer computing from storyContent so the result matches initial
    // generation exactly; fall back to legacy fields if the caller is on an
    // older contract.
    const resolvedChildDetails = childDetails || {};
    const flags = { isChapterBook: !!isChapterBook, isGraphicNovel: !!isGraphicNovel };
    const computed = storyContent
      ? computeCoverPdfMetadata(storyContent, resolvedChildDetails, flags)
      : null;

    const pageCount = computed?.pageCount || legacyPageCount || 32;
    const synopsis  = computed?.synopsis  || legacySynopsis  || '';

    const coverData = await generateCover(
      title || 'My Story',
      resolvedChildDetails,
      null, // characterRefUrl unused when preGeneratedCoverBuffer is supplied
      bookFormat || 'PICTURE_BOOK',
      {
        bookId,
        preGeneratedCoverBuffer,
        pageCount,
        synopsis,
        heartfeltNote: heartfeltNote || '',
        bookFrom: bookFrom || '',
        bindingType: bindingType || '',
      },
    );
    if (!coverData?.coverPdfBuffer) throw new Error('generateCover returned no buffer');

    const coverPath = `children-jobs/${bookId}/cover.pdf`;
    await uploadBuffer(coverData.coverPdfBuffer, coverPath, 'application/pdf');
    const coverPdfUrl = await getSignedUrl(coverPath, 30 * 24 * 60 * 60 * 1000);
    console.log(`[rebuild-cover-pdf] Done for book ${bookId}: ${coverPdfUrl} (pages=${pageCount}, binding=${bindingType || 'paperback'})`);
    return res.json({ success: true, coverPdfUrl });
  } catch (err) {
    console.error(`[rebuild-cover-pdf] Error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /rebuild-coloring-cover-pdf — Regenerate cover art + wrap PDF for a coloring book ──
app.post('/rebuild-coloring-cover-pdf', authenticate, async (req, res) => {
  const { bookId, title, childName, age, characterDescription, parentCoverImageUrl, parentCoverMime, questionnaire, childPhotoUrl, characterAnchorUrl } = req.body;
  if (!bookId) {
    return res.status(400).json({ error: 'bookId is required' });
  }
  try {
    console.log(`[rebuild-coloring-cover-pdf] Starting for book ${bookId}`);
    const { generateCoverArtFromParent } = require('./services/coloringBookGenerator');
    const { buildCoverWrapPdf, generateCoverThumbnailPng } = require('./services/coloringBookLayout');

    let parentCoverBuffer = null;
    let parentCoverMimeResolved = parentCoverMime || null;
    if (parentCoverImageUrl) {
      try {
        const photo = await downloadPhotoAsBase64(parentCoverImageUrl);
        parentCoverBuffer = Buffer.from(photo.base64, 'base64');
        if (!parentCoverMimeResolved) parentCoverMimeResolved = photo.mimeType;
        console.log(`[rebuild-coloring-cover-pdf] Downloaded parent cover (${Math.round(parentCoverBuffer.length / 1024)}KB, ${parentCoverMimeResolved || 'unknown mime'})`);
      } catch (err) {
        console.warn(`[rebuild-coloring-cover-pdf] Could not download parent cover, generating from scratch: ${err.message}`);
      }
    }

    // Pull the child photo + optional character anchor so the back cover's
    // pencil sketch can feature the same child face as the chosen front cover.
    let characterRef = null;
    if (childPhotoUrl) {
      try { characterRef = await downloadPhotoAsBase64(childPhotoUrl); }
      catch (err) { console.warn(`[rebuild-coloring-cover-pdf] child photo fetch failed: ${err.message}`); }
    }
    let characterAnchor = null;
    if (characterAnchorUrl) {
      try { characterAnchor = await downloadPhotoAsBase64(characterAnchorUrl); }
      catch (err) { console.warn(`[rebuild-coloring-cover-pdf] character anchor fetch failed: ${err.message}`); }
    }

    const coverArt = await generateCoverArtFromParent({
      childName, title, age, characterDescription,
      parentCoverBuffer,
      parentCoverMime: parentCoverMimeResolved,
      questionnaire,
      characterRef,
      characterAnchor,
    });
    const frontCoverBuffer = coverArt?.frontCoverBuffer;
    const backCoverBuffer = coverArt?.backCoverBuffer;
    if (frontCoverBuffer) {
      console.log(`[rebuild-coloring-cover-pdf] Cover art generated — front: ${Math.round(frontCoverBuffer.length / 1024)}KB, back: ${Math.round((backCoverBuffer?.length || 0) / 1024)}KB`);
    }

    const coverPdfBuffer = await buildCoverWrapPdf({ title: title || 'My Coloring Book', childName: childName || '', frontCoverBuffer, backCoverBuffer });
    if (!coverPdfBuffer) throw new Error('buildCoverWrapPdf returned no buffer');

    const gcsBase = `children-jobs/${bookId}/coloring`;
    await uploadBuffer(coverPdfBuffer, `${gcsBase}/cover.pdf`, 'application/pdf');
    const coverPdfUrl = await getSignedUrl(`${gcsBase}/cover.pdf`, 30 * 24 * 60 * 60 * 1000);

    let coverImageUrl;
    try {
      const thumbnailPng = await generateCoverThumbnailPng({ title: title || 'My Coloring Book', childName: childName || '', frontCoverBuffer });
      await uploadBuffer(thumbnailPng, `${gcsBase}/cover-thumbnail.png`, 'image/png');
      coverImageUrl = await getSignedUrl(`${gcsBase}/cover-thumbnail.png`, 30 * 24 * 60 * 60 * 1000);
    } catch (err) {
      console.warn(`[rebuild-coloring-cover-pdf] Thumbnail generation failed (non-fatal): ${err.message}`);
    }

    console.log(`[rebuild-coloring-cover-pdf] Done for book ${bookId}`);
    return res.json({ success: true, coverPdfUrl, coverImageUrl });
  } catch (err) {
    console.error(`[rebuild-coloring-cover-pdf] Error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /manage-checkpoint — Read or reset a book checkpoint ──
// Used by standalone (no GCS creds) to read/modify checkpoints for regenerate-phase.
app.post('/manage-checkpoint', authenticate, async (req, res) => {
  const { bookId, action, phase } = req.body;
  if (!bookId) return res.status(400).json({ success: false, error: 'bookId is required' });
  if (!['read', 'reset-phase'].includes(action)) {
    return res.status(400).json({ success: false, error: 'action must be read or reset-phase' });
  }

  try {
    const { Storage } = require('@google-cloud/storage');
    const storage = new Storage();
    const BUCKET = process.env.GCS_BUCKET_NAME || 'giftmybook-bucket';
    const bucket = storage.bucket(BUCKET);
    const file = bucket.file(`children-jobs/${bookId}/checkpoint.json`);

    const [contents] = await file.download();
    const checkpoint = JSON.parse(contents.toString());

    if (action === 'read') {
      return res.json({ success: true, checkpoint });
    }

    // reset-phase: clear data from the requested phase onwards
    if (phase === 'story') {
      delete checkpoint.storyPlan;
      delete checkpoint.spreadsWithText;
      delete checkpoint.illustrationResults;
      checkpoint.completedStage = 'photo_cache';
    } else if (phase === 'text') {
      delete checkpoint.spreadsWithText;
      delete checkpoint.illustrationResults;
      checkpoint.completedStage = 'story_planning';
    } else if (phase === 'illustrations') {
      delete checkpoint.illustrationResults;
      checkpoint.completedStage = 'text_generation';
    } else if (phase === 'cover') {
      checkpoint.completedStage = 'text_generation';
      delete checkpoint.illustrationResults;
    } else {
      return res.status(400).json({ success: false, error: `Unknown phase: ${phase}` });
    }

    await file.save(JSON.stringify(checkpoint));
    console.log(`[manage-checkpoint] Reset phase '${phase}' for book ${bookId}`);
    res.json({ success: true, completedStage: checkpoint.completedStage });
  } catch (err) {
    console.error('[manage-checkpoint] Error:', err.message);
    res.status(err.message.includes('No such object') ? 404 : 500)
      .json({ success: false, error: err.message });
  }
});

// ── POST /get-spread-data — Return checkpoint data for one or more spreads ──
// Used by standalone to get the real scene prompts + character details for regeneration.
app.post('/get-spread-data', authenticate, async (req, res) => {
  const { bookId, spreadIndices } = req.body;
  if (!bookId) return res.status(400).json({ success: false, error: 'bookId is required' });

  try {
    const { Storage } = require('@google-cloud/storage');
    const storage = new Storage();
    const bucket = storage.bucket(process.env.GCS_BUCKET_NAME || 'giftmybook-bucket');
    const [contents] = await bucket.file(`children-jobs/${bookId}/checkpoint.json`).download();
    const checkpoint = JSON.parse(contents.toString());

    const storyPlan = checkpoint.storyPlan || {};
    const entries = (storyPlan.entries || []).filter(e => e.type === 'spread');

    const indices = Array.isArray(spreadIndices) ? spreadIndices : Array.from({ length: entries.length }, (_, i) => i);

    const spreads = indices.map(idx => {
      const entry = entries[idx];
      if (!entry) return { idx, error: 'out of range' };
      return {
        idx,
        spreadImagePrompt: entry.spread_image_prompt || '',
        pageText: (() => { const rawPageText = [entry.left?.text, entry.right?.text].filter(Boolean).join(' '); return rawPageText && !LOREM_PATTERNS.test(rawPageText) ? rawPageText : ''; })(),
        characterOutfit: storyPlan.characterOutfit || '',
        characterDescription: storyPlan.characterDescription || '',
        characterAnchor: storyPlan.characterAnchor || '',
        recurringElement: storyPlan.recurringElement || '',
        keyObjects: storyPlan.keyObjects || [],
        coverArtStyle: storyPlan.coverArtStyle || '',
        additionalCoverCharacters: storyPlan.additionalCoverCharacters || null,
      };
    });

    res.json({ success: true, spreads });
  } catch (err) {
    console.error('[get-spread-data] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /refresh-url — Return a fresh signed URL for a GCS object ──
// Used by standalone when it lacks GCS credentials to re-sign URLs.
app.post('/refresh-url', authenticate, async (req, res) => {
  const { gcsUrl } = req.body;
  if (!gcsUrl || typeof gcsUrl !== 'string') {
    return res.status(400).json({ success: false, error: 'gcsUrl is required' });
  }
  try {
    const BUCKET = process.env.GCS_BUCKET_NAME || 'giftmybook-bucket';
    const base = gcsUrl.split('?')[0];
    const marker = `${BUCKET}/`;
    const idx = base.indexOf(marker);
    if (idx === -1) return res.status(400).json({ success: false, error: 'Not a known GCS bucket URL' });
    const filePath = decodeURIComponent(base.slice(idx + marker.length));
    const signedUrl = await getSignedUrl(filePath, 30 * 24 * 60 * 60 * 1000); // 30 days
    res.json({ success: true, signedUrl });
  } catch (err) {
    console.error('[refresh-url] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Diagnostic: test Gemini image generation latency ──
app.get('/test-gemini-image', authenticate, async (req, res) => {
  const start = Date.now();
  const apiKey = process.env.GOOGLE_AI_STUDIO_KEY || process.env.GEMINI_API_KEY;
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Watercolor illustration of a happy child playing in a park. Include text: "Hello World!" in large friendly font.' }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        }),
      }
    );
    const ms = Date.now() - start;
    if (!resp.ok) {
      const err = await resp.text();
      return res.json({ ok: false, ms, status: resp.status, error: err.slice(0, 200) });
    }
    const data = await resp.json();
    const hasImage = data.candidates?.[0]?.content?.parts?.some(p => p.inlineData);
    res.json({ ok: true, ms, hasImage, endpoint: 'public' });
  } catch (e) {
    res.json({ ok: false, ms: Date.now() - start, error: e.message });
  }
});

// ── Startup Validation ──
const REQUIRED_ENV = ['API_KEY', 'GEMINI_API_KEY', 'GCS_BUCKET_NAME'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
// ─── POST /qa/generate-story ─── Writer V2 QA endpoint with SSE streaming
app.post('/qa/generate-story', authenticate, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Inject API keys from standalone proxy (don't overwrite existing env vars)
  const apiKeys = req.body.apiKeys || {};
  for (const [key, val] of Object.entries(apiKeys)) {
    if (val && !process.env[key]) process.env[key] = val;
  }

  try {
    const { WriterEngine } = require('./services/writer/engine');
    const result = await WriterEngine.generate(req.body, {
      onProgress: (progress) => sendEvent('progress', progress),
    });
    // Flatten story + metadata + pipeline for frontend (fixes "0 words across 0 spreads" bug)
    sendEvent('story', {
      spreads: result.story.spreads,
      _model: result.story._model,
      _ageTier: result.story._ageTier,
      ...result.metadata,
      pipeline: result.pipeline,
    });
    sendEvent('done', {});
  } catch (err) {
    console.error('[qa/generate-story] Error:', err.message);
    sendEvent('error', { message: err.message, stack: err.stack?.split('\n').slice(0, 5).join('\n') });
  } finally {
    res.end();
  }
});

if (missingEnv.length > 0 && process.env.NODE_ENV !== 'test') {
  console.error(`[startup] Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`giftmybook-children-worker listening on port ${PORT}`);
  });
}

module.exports = app;

// ─── POST /upload-cover-pdf ─── Accept base64 PDF, upload to GCS, return signed URL
app.post('/upload-cover-pdf', authenticate, async (req, res) => {
  const { bookId, pdfBase64 } = req.body;
  if (!bookId || !pdfBase64) return res.status(400).json({ error: 'bookId and pdfBase64 required' });
  try {
    const buf = Buffer.from(pdfBase64, 'base64');
    const { uploadBuffer, getSignedUrl } = require('./services/gcsStorage');
    const path = `children-jobs/${bookId}/cover.pdf`;
    await uploadBuffer(buf, path, 'application/pdf');
    const url = await getSignedUrl(path, 30 * 24 * 60 * 60 * 1000);
    res.json({ success: true, coverPdfUrl: url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /upload-image ─── Accept base64 image, upload to GCS, return signed URL
app.post('/upload-image', authenticate, async (req, res) => {
  const { bookId, imageBase64, mimeType, gcsPath: customPath } = req.body;
  if (!bookId || !imageBase64) return res.status(400).json({ error: 'bookId and imageBase64 required' });
  try {
    const buf = Buffer.from(imageBase64, 'base64');
    const { uploadBuffer, getSignedUrl } = require('./services/gcsStorage');
    const filePath = customPath || `children-covers/${bookId}/cover-admin-upload.jpg`;
    await uploadBuffer(buf, filePath, mimeType || 'image/jpeg');
    const url = await getSignedUrl(filePath, 30 * 24 * 60 * 60 * 1000);
    res.json({ success: true, url, gcsPath: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
