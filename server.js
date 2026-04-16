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

const { planStory, polishStory, brainstormStorySeed, combinedCritic, polishEarlyReader, masterCritic, EMOTIONAL_THEMES, getEmotionalTier, planChapterBook } = require('./services/storyPlanner');
const { generateSpreadText } = require('./services/textGenerator');
const { generateIllustration, generateIllustrationWithAnchors, downloadPhotoAsBase64 } = require('./services/illustrationGenerator');
const { ChatSessionManager } = require('./services/chatSessionManager');
const { TextCompositor } = require('./services/textCompositor');
const { assemblePdf, buildChapterBookPdf } = require('./services/layoutEngine');
const { generateCover, generateUpsellCovers } = require('./services/coverGenerator');
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

// ── QA Fix Tier Helpers ──

/**
 * Pick the top-scoring images from a QA run to use as visual anchors during retries.
 * Selects images that passed the most checks / had fewest issues.
 *
 * @param {Array<{index, imageBase64}>} allQaImages
 * @param {{failedSpreads: Array<{index, checks}>}} qaResult
 * @param {number} count - How many anchor images to return (max 2)
 * @returns {Array<{imageBase64: string, label: string}>}
 */
function getTopScoringImages(allQaImages, qaResult, count = 2) {
  const failedIndices = new Set((qaResult.failedSpreads || []).map(f => f.index));

  // Score each image: images NOT in failedSpreads score highest
  const scored = allQaImages
    .filter(img => img.imageBase64 && !failedIndices.has(img.index))
    .map(img => {
      // Count how many checks this image failed across all failedSpreads
      const failEntry = (qaResult.failedSpreads || []).find(f => f.index === img.index);
      const failCount = failEntry ? failEntry.checks.length : 0;
      return { ...img, failCount };
    })
    .sort((a, b) => a.failCount - b.failCount);

  return scored.slice(0, count).map(img => ({
    imageBase64: img.imageBase64,
    label: `Spread ${img.index + 1} (anchor — highest quality)`,
  }));
}

/**
 * Build check-specific correction strategies for QA retries.
 * Returns a correction prompt tailored to the specific checks that failed.
 *
 * @param {Array<{check: string, issues: string[]}>} failedChecks
 * @param {object} context - { characterAnchor, characterOutfit, pageText, sceneDescription }
 * @returns {string} Correction prompt
 */
function buildCheckSpecificCorrection(failedChecks, context) {
  const parts = ['QUALITY CORRECTION — FIX THESE SPECIFIC ISSUES:\n'];

  for (const { check, issues } of failedChecks) {
    const issueStr = (issues || []).join(', ');
    switch (check) {
      case 'characterConsistency':
        parts.push(`CHARACTER CONSISTENCY FIX (CRITICAL):
The child has ${context.characterAnchor || 'the appearance shown in the reference photo'}.
Their outfit is ${context.characterOutfit || 'as shown in the reference'}.
Reproduce their appearance EXACTLY — same face shape, hair, skin tone, clothing.
Previous issue: ${issueStr}`);
        break;

      case 'fontConsistency':
        parts.push(`FONT CONSISTENCY FIX (CRITICAL):
Match the EXACT font family, size, weight, and color from the reference image.
Use the same font style on every page — no variations.
Previous issue: ${issueStr}`);
        break;

      case 'textWidth':
        parts.push(`TEXT WIDTH FIX (CRITICAL):
Text must occupy no more than 30% of the image width.
Place text in a clean area with a narrow column.
Use shorter lines and more line breaks rather than wide text blocks.
Previous issue: ${issueStr}`);
        break;

      case 'anatomical':
        parts.push(`ANATOMICAL FIX (CRITICAL):
Every character must have exactly 5 fingers per hand, 2 arms, 2 legs.
Check all body proportions carefully before finalizing.
Previous issue: ${issueStr}`);
        break;

      case 'textAccuracy':
        parts.push(`TEXT ACCURACY FIX (CRITICAL):
The text on this page must read EXACTLY: "${context.pageText || ''}"
Spell every word correctly. Double-check every letter.
Do NOT add, remove, or change any words.
Previous issue: ${issueStr}`);
        break;

      case 'colorPalette':
        parts.push(`COLOR PALETTE FIX:
Match the color palette of the companion scenes shown in the reference images.
Same lighting, same background tones, same warmth.
Previous issue: ${issueStr}`);
        break;

      case 'artStyle':
        parts.push(`ART STYLE FIX:
Match the rendering technique of the reference images exactly.
Same line weight, same level of detail, same shading approach.
Previous issue: ${issueStr}`);
        break;

      case 'sceneAlignment':
        parts.push(`SCENE ALIGNMENT FIX:
This page must show: ${context.sceneDescription || 'the described scene'}.
Ensure the character's action and setting match the story text.
Previous issue: ${issueStr}`);
        break;

      case 'contentSafety':
        parts.push(`CONTENT SAFETY FIX (CRITICAL):
This is for ages 2-8. No scary elements, no unsafe situations.
All characters must be appropriately dressed. No violence or dark imagery.
Previous issue: ${issueStr}`);
        break;

      default:
        parts.push(`${check}: ${issueStr}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Generate 3 candidates for a stubborn spread and pick the best one via QA scoring.
 * Used as Tier 3 — the nuclear option for spreads that fail Tier 1 and Tier 2.
 *
 * @param {string} prompt - Scene prompt
 * @param {string} characterRef
 * @param {string} style
 * @param {Array<{imageBase64, label}>} anchorImages
 * @param {object} opts - generateIllustration opts
 * @param {Array<string>} failedCheckNames - Which checks failed
 * @param {object} qaContext
 * @param {Array} allQaImages
 * @param {object} imageInfo - {index, pageText, sceneDescription}
 * @returns {Promise<{url: string|null, score: number, imageBase64: string|null}>}
 */
async function generateBestCandidate(prompt, characterRef, style, anchorImages, opts, failedCheckNames, qaContext, allQaImages, imageInfo) {
  const { scoreIllustrationAgainstBook } = require('./services/illustrationQa');

  // Generate 3 candidates in parallel
  const candidatePromises = [
    generateIllustrationWithAnchors(prompt, characterRef, style, anchorImages, opts).catch(() => null),
    generateIllustrationWithAnchors(prompt, characterRef, style, anchorImages, opts).catch(() => null),
    generateIllustrationWithAnchors(prompt, characterRef, style, anchorImages, opts).catch(() => null),
  ];

  const candidateUrls = await Promise.all(candidatePromises);
  const validCandidates = candidateUrls.filter(Boolean);

  if (validCandidates.length === 0) {
    return { url: null, score: 0, imageBase64: null };
  }

  // Download and QA-score each candidate
  const scored = await Promise.all(
    validCandidates.map(async (url) => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) return { url, score: 0, imageBase64: null };
        const imgBase64 = Buffer.from(await resp.arrayBuffer()).toString('base64');
        const scoreResult = await scoreIllustrationAgainstBook(
          imgBase64, allQaImages, failedCheckNames, qaContext, imageInfo
        );
        return { url, score: scoreResult.score, imageBase64: imgBase64, issues: scoreResult.issues };
      } catch (e) {
        return { url, score: 0, imageBase64: null };
      }
    })
  );

  // Return the best candidate
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  console.log(`[qa-tier3] Best candidate: score=${best.score}, candidates evaluated=${scored.length}`);
  return best;
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
  app.use('/generate-spread', generationLimiter);
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
    characterRefSheetBase64, parentCoverRefBase64,
  } = opts;

  // Count how many illustrations we need
  const illustratableEntries = entries.map((entry, idx) => {
    if (entry.type === 'blank') return null;
    if (entry.type === 'title_page') return null;
    if (entry.type === 'half_title_page') return null;
    if (entry.type === 'copyright_page') return null;
    if (entry.type === 'closing_page') return null;
    if (entry.type === 'dedication_page') return null;
    if (entry.type === 'spread') {
      const spreadText = [entry.left?.text, entry.right?.text].filter(Boolean).join(' ');
      const validSpreadText = spreadText && !LOREM_PATTERNS.test(spreadText) ? spreadText : '';
      // Always generate as a single wide spread (16:9) — never as separate left/right pages
      const spreadPrompt = entry.spread_image_prompt
        || entry.left?.image_prompt
        || entry.right?.image_prompt
        || (validSpreadText ? `Children's book illustration for this scene: ${validSpreadText}. Show the main character in a warm, expressive moment. Include environment details, lighting, and one texture detail.` : null);
      if (!spreadPrompt) return null;
      if (!entry.spread_image_prompt && (entry.left?.image_prompt || entry.right?.image_prompt)) {
        bookContext.log('info', `Spread ${entry.spread}: using left/right prompt as spread (forced wide format)`);
      }
      return { idx, prompt: spreadPrompt, field: 'spreadIllustrationUrl', pageText: validSpreadText, isSpread: true };
    }
    return null;
  }).flat().filter(Boolean);

  bookContext.log('info', 'Starting V2 illustration generation', {
    totalIllustrations: illustratableEntries.length,
    resumed: (existingIllustrations || []).filter(Boolean).length,
  });

  const stage5Start = Date.now();
  const results = new Array(entries.length);
  // Pre-fill entries
  for (let i = 0; i < entries.length; i++) {
    results[i] = { ...entries[i] };
  }

  // Pre-fill from checkpoint
  let completedCount = 0;
  if (existingIllustrations) {
    for (let i = 0; i < existingIllustrations.length && i < results.length; i++) {
      if (existingIllustrations[i]?.spreadIllustrationUrl || existingIllustrations[i]?.illustrationUrl) {
        results[i] = existingIllustrations[i];
        completedCount++;
        bookContext.log('info', `Entry ${i} illustration resumed from checkpoint`);
      }
    }
  }

  const illustrationLimit = pLimit(1); // Sequential
  let firstSpreadBase64 = null;

  // ── Chat Session Setup ──
  // Try to start a Gemini chat session for visual consistency across spreads.
  // Falls back to standalone generateIllustration() calls if chat fails.
  let chatSession = null;
  const useChatSession = !opts.disableChatSession; // allow opting out
  if (useChatSession) {
    try {
      chatSession = new ChatSessionManager();
      const characterRefImages = [];
      if (cachedPhotoBase64) {
        characterRefImages.push({ base64: cachedPhotoBase64, mimeType: cachedPhotoMime || 'image/jpeg' });
      }
      if (parentCoverRefBase64 && parentCoverRefBase64 !== cachedPhotoBase64) {
        characterRefImages.push({ base64: parentCoverRefBase64, mimeType: 'image/jpeg' });
      }
      if (characterRefSheetBase64 && characterRefSheetBase64 !== cachedPhotoBase64) {
        characterRefImages.push({ base64: characterRefSheetBase64, mimeType: 'image/jpeg' });
      }

      const styleConfig = {
        artStyle: style,
        characterDescription: storyPlan.characterDescription || '',
        characterOutfit: storyPlan.characterOutfit || '',
        characterAnchor: characterAnchor || storyPlan.characterAnchor || null,
        additionalCoverCharacters: storyPlan.secondaryCharacterDescription || storyPlan.additionalCoverCharacters || detectedSecondaryCharacters || null,
      };
      const chatBookContext = {
        childName: childDetails.name,
        childAge: childDetails.age || childDetails.childAge,
        totalSpreads: illustratableEntries.length,
        recurringElement: storyPlan.recurringElement || '',
        keyObjects: storyPlan.keyObjects || '',
      };

      await chatSession.startBookSession(characterRefImages, styleConfig, chatBookContext);
      bookContext.log('info', 'Chat session started for illustration generation');
    } catch (chatErr) {
      bookContext.log('warn', `Chat session failed to start — falling back to standalone generation: ${chatErr.message}`);
      chatSession = null;
    }
  }

  const illustrationPromises = illustratableEntries.map((job) =>
    illustrationLimit(async () => {
      const { idx, prompt, field } = job;

      // Check abort signal before starting each illustration
      if (bookContext.abortController.signal.aborted) {
        bookContext.log('info', `Skipping illustration entry ${idx + 1} — generation aborted`);
        return;
      }

      // Skip if already resumed from checkpoint
      if (results[idx]?.[field]) {  // field = leftIllustrationUrl, rightIllustrationUrl, or spreadIllustrationUrl
        return;
      }

      let imageUrl = null;
      let imageBuffer = null; // Keep raw buffer for text compositing
      const illStart = Date.now();
      const outfit = storyPlan.characterOutfit || '';
      const MAX_ILL_RETRIES = 3;
      const entryLabel = `entry ${idx + 1} (${results[idx].type})`;

      // ── Try chat session first, fall back to standalone ──
      if (chatSession) {
        try {
          bookContext.log('info', `Illustration ${entryLabel} via chat session`);
          const entryData = entries[idx] || {};
          const textPlacement = idx % 2 === 0 ? 'bottom' : 'top';
          const chatResult = await chatSession.generateSpread(prompt, idx, textPlacement, {
            aspectRatio: job.isSpread ? '16:9' : '1:1',
            shotType: entryData.shot_type || null,
          });

          imageBuffer = chatResult.imageBuffer;

          if (costTracker) {
            costTracker.addImageGeneration('gemini-3.1-flash-image-preview', 1);
          }

          // Upload raw (no-text) illustration to GCS
          if (bookId && imageBuffer) {
            const { uploadBuffer: uploadBuf } = require('./services/gcsStorage');
            const gcsPath = `children-jobs/${bookId}/illustrations/${Date.now()}.png`;
            imageUrl = await uploadBuf(imageBuffer, gcsPath, 'image/png');
          }

          bookContext.touchActivity();
          const memUsage = process.memoryUsage();
          bookContext.log('info', `Illustration ${entryLabel} complete (chat)`, { ms: Date.now() - illStart, hasImage: !!imageUrl, heapMB: Math.round(memUsage.heapUsed / 1024 / 1024) });
        } catch (chatGenErr) {
          bookContext.log('warn', `Chat session generation failed for ${entryLabel}: ${chatGenErr.message} — falling back to standalone`);
          chatSession = null; // Disable chat for remaining spreads
          imageUrl = null;
          imageBuffer = null;
        }
      }

      // Fallback: standalone generation (original path)
      if (!imageUrl) {
        for (let attempt = 1; attempt <= MAX_ILL_RETRIES; attempt++) {
          try {
            if (attempt === 1) {
              bookContext.log('info', `Illustration ${entryLabel} starting (standalone)`, { promptLength: prompt.length, field });
            } else {
              bookContext.log('info', `Illustration ${entryLabel} retry ${attempt}/${MAX_ILL_RETRIES}`);
            }
            let prevIllustrationUrl = null;
            for (let pi = idx - 1; pi >= 0; pi--) {
              const prev = results[pi];
              const prevUrl = prev?.spreadIllustrationUrl || prev?.illustrationUrl;
              if (prevUrl) { prevIllustrationUrl = prevUrl; break; }
            }
            const isFirstSpread = (idx === 0);
            const photoRefForSpread = parentCoverRefBase64
              ? parentCoverRefBase64
              : (characterRefSheetBase64 || cachedPhotoBase64);
            const photoMimeForSpread = parentCoverRefBase64
              ? 'image/jpeg'
              : (characterRefSheetBase64 ? 'image/jpeg' : cachedPhotoMime);
            const entryData = entries[idx] || {};
            const illustrationPromise = generateIllustration(prompt, characterRef, style, {
              apiKeys,
              costTracker,
              bookId,
              childName: childDetails.name,
              characterOutfit: outfit,
              characterDescription: storyPlan.characterDescription || '',
              characterAnchor: characterAnchor || storyPlan.characterAnchor || null,
              additionalCoverCharacters: storyPlan.secondaryCharacterDescription || storyPlan.additionalCoverCharacters || detectedSecondaryCharacters || null,
              recurringElement: storyPlan.recurringElement || '',
              keyObjects: storyPlan.keyObjects || '',
              coverArtStyle: storyPlan.coverArtStyle || '',
              childPhotoUrl: resolvedChildPhotoUrl,
              _cachedPhotoBase64: photoRefForSpread,
              _cachedPhotoMime: photoMimeForSpread,
              spreadIndex: idx,
              totalSpreads: entries.filter(e => e.type === 'spread').length,
              childAge: childDetails.age || childDetails.childAge,
              pageText: '', // Never embed text — composited separately
              isSpread: job.isSpread || false,
              skipTextEmbed: true, // Force no-text mode
              deadlineMs: 200000,
              abortSignal: bookContext.abortController.signal,
              prevIllustrationUrl,
              shotType: entryData.shot_type || null,
              characterPosition: entryData.character_position || null,
              promptInjection: isFirstSpread
                ? `STYLE ESTABLISHMENT: This is the FIRST illustration of the book. The art style, color palette, lighting mood, and character rendering quality you establish HERE will be used as the style reference for ALL subsequent illustrations. Commit to a specific, rich, consistent style in this first image. `
                : '',
              firstSpreadRefBase64: firstSpreadBase64 || null,
            });
            const timeoutPromise = new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Illustration ${entryLabel} timed out after 3.5 minutes`)), 210000)
            );
            imageUrl = await Promise.race([illustrationPromise, timeoutPromise]);
            bookContext.touchActivity();
            const memUsage = process.memoryUsage();
            bookContext.log('info', `Illustration ${entryLabel} complete (standalone)`, { ms: Date.now() - illStart, hasImage: !!imageUrl, heapMB: Math.round(memUsage.heapUsed / 1024 / 1024) });
            break;
          } catch (illustrationErr) {
            bookContext.log('error', `Illustration ${entryLabel} attempt ${attempt} failed`, { error: illustrationErr.message, ms: Date.now() - illStart });
            if (attempt < MAX_ILL_RETRIES) {
              const backoff = attempt * 3000;
              await new Promise(r => setTimeout(r, backoff));
            } else {
              bookContext.log('warn', `Illustration ${entryLabel} failed after ${MAX_ILL_RETRIES} attempts — skipping`);
            }
          }
        }
      } // end fallback standalone generation

      // ── C5: Post-generation visual QA checks (streamlined — text checks removed) ──
      // Download generated image once for all checks
      const originalImageUrl = imageUrl; // track original to detect if QA retries changed the image
      let genBase64 = null;
      if (imageUrl && typeof imageUrl === 'string' && imageUrl.startsWith('http')) {
        try {
          const checkResp = await fetch(imageUrl);
          if (checkResp.ok) {
            genBase64 = Buffer.from(await checkResp.arrayBuffer()).toString('base64');
          }
        } catch {}
      }

      // Helper: build retry options for corrective re-generation
      const buildRetryOpts = () => {
        const entry = results[idx];
        const spreadText = (entry.left?.text || '') + ' ' + (entry.right?.text || '') + ' ' + (entry.text || '');
        const mentionsParent = /mom|mama|mommy|mother|dad|daddy|papa|father/i.test(spreadText);
        const photoRefForRetry = (mentionsParent && parentCoverRefBase64)
          ? parentCoverRefBase64
          : (characterRefSheetBase64 || cachedPhotoBase64);
        const photoMimeForRetry = (mentionsParent && parentCoverRefBase64)
          ? 'image/jpeg'
          : (characterRefSheetBase64 ? 'image/jpeg' : cachedPhotoMime);
        return {
          apiKeys,
          costTracker,
          bookId,
          childName: childDetails.name,
          characterOutfit: storyPlan.characterOutfit || '',
          characterDescription: storyPlan.characterDescription || '',
          characterAnchor: characterAnchor || storyPlan.characterAnchor || null,
          additionalCoverCharacters: storyPlan.secondaryCharacterDescription || storyPlan.additionalCoverCharacters || detectedSecondaryCharacters || null,
          recurringElement: storyPlan.recurringElement || '',
          keyObjects: storyPlan.keyObjects || '',
          coverArtStyle: storyPlan.coverArtStyle || '',
          childPhotoUrl: resolvedChildPhotoUrl,
          _cachedPhotoBase64: photoRefForRetry,
          _cachedPhotoMime: photoMimeForRetry,
          spreadIndex: idx,
          totalSpreads: entries.filter(e => e.type === 'spread').length,
          childAge: childDetails.age || childDetails.childAge,
          pageText: '', // No text in illustrations — composited separately
          skipTextEmbed: true,
          isSpread: job.isSpread || false,
          deadlineMs: 200000,
          abortSignal: bookContext.abortController.signal,
          firstSpreadRefBase64: firstSpreadBase64 || null,
        };
      };

      // Check 1: Character consistency (existing)
      const refBase64ForCheck = characterRefSheetBase64 || cachedPhotoBase64;
      if (genBase64 && refBase64ForCheck) {
        try {
          const { checkCharacterConsistency } = require('./services/illustrationGenerator');
          const consistency = await checkCharacterConsistency(genBase64, refBase64ForCheck, storyPlan.characterAnchor, storyPlan.characterOutfit || '', storyPlan.additionalCoverCharacters || null);
          if (!consistency.consistent) {
            bookContext.log('warn', `Spread ${idx + 1} character inconsistency detected`, { issues: consistency.issues });
            try {
              const correctionNote = `IMPORTANT: Pay close attention to the character's appearance.\nThe child has: ${storyPlan.characterAnchor || ''}\nCore outfit: ${storyPlan.characterOutfit || ''}\nPrevious attempt issue: ${consistency.issues.join(', ')}`;
              const correctedPrompt = correctionNote + '\n\n' + prompt;
              bookContext.log('info', `Retrying spread ${idx + 1} with consistency correction`);
              const retryResult = await generateIllustration(correctedPrompt, characterRef, style, buildRetryOpts());
              if (retryResult) {
                imageUrl = retryResult;
                genBase64 = null; // re-download for subsequent checks
                try {
                  const reResp = await fetch(imageUrl);
                  if (reResp.ok) genBase64 = Buffer.from(await reResp.arrayBuffer()).toString('base64');
                } catch {}
                bookContext.log('info', `Spread ${idx + 1} consistency retry succeeded`);
              }
            } catch (retryErr) {
              bookContext.log('warn', `Consistency retry failed for spread ${idx + 1}`, { error: retryErr.message });
            }
          } else {
            bookContext.log('info', `Spread ${idx + 1} character consistency OK`);
          }
        } catch (checkErr) {
          bookContext.log('warn', `Consistency check error for spread ${idx + 1}`, { error: checkErr.message });
        }
      }

      // Check 2: Character count — detect duplicated characters
      if (genBase64) {
        try {
          const { checkCharacterCount } = require('./services/illustrationGenerator');
          const entry = results[idx];
          const spreadText = (entry.left?.text || '') + ' ' + (entry.right?.text || '') + ' ' + (entry.text || '');
          const spreadImagePrompt = entry.spread_image_prompt || '';
          const searchableText = spreadText + ' ' + spreadImagePrompt;
          const hasSecondaryCharacters = !!storyPlan.additionalCoverCharacters;
          const mentionsParent = /mom|mama|mommy|mother|dad|daddy|papa|father/i.test(searchableText);
          const expectedCharacters = { childCount: 1, adultCount: (mentionsParent && hasSecondaryCharacters) ? 1 : 0 };
          const countResult = await checkCharacterCount(genBase64, expectedCharacters);
          if (!countResult.passed) {
            bookContext.log('warn', `Spread ${idx + 1} character count mismatch`, { message: countResult.message });
            try {
              const correctionNote = `CRITICAL: The previous image showed the wrong number of characters. ${countResult.message}. Generate with EXACTLY ${expectedCharacters.childCount} child(ren) and ${expectedCharacters.adultCount} adult(s).`;
              const correctedPrompt = correctionNote + '\n\n' + prompt;
              bookContext.log('info', `Retrying spread ${idx + 1} with character count correction`);
              const retryResult = await generateIllustration(correctedPrompt, characterRef, style, buildRetryOpts());
              if (retryResult) {
                imageUrl = retryResult;
                genBase64 = null;
                try {
                  const reResp = await fetch(imageUrl);
                  if (reResp.ok) genBase64 = Buffer.from(await reResp.arrayBuffer()).toString('base64');
                } catch {}
                bookContext.log('info', `Spread ${idx + 1} character count retry succeeded`);
              }
            } catch (retryErr) {
              bookContext.log('warn', `Character count retry failed for spread ${idx + 1}`, { error: retryErr.message });
            }
          } else {
            bookContext.log('info', `Spread ${idx + 1} character count OK`);
          }
        } catch (checkErr) {
          bookContext.log('warn', `Character count check error for spread ${idx + 1}`, { error: checkErr.message });
        }
      }

      // Checks 3 & 4 (text overlay, font consistency) REMOVED — text is composited separately

      // Final re-check: if any QA retry changed the image, verify character consistency one more time
      if (genBase64 && refBase64ForCheck && imageUrl !== originalImageUrl) {
        try {
          const { checkCharacterConsistency } = require('./services/illustrationGenerator');
          const finalCheck = await checkCharacterConsistency(genBase64, refBase64ForCheck, storyPlan.characterAnchor, storyPlan.characterOutfit || '', storyPlan.additionalCoverCharacters || null);
          if (!finalCheck.consistent) {
            bookContext.log('warn', `Spread ${idx + 1} post-retry consistency re-check failed`, { issues: finalCheck.issues });
            // One last attempt with explicit correction
            try {
              const correctionNote = `IMPORTANT: Pay close attention to the character's appearance.\nThe child has: ${storyPlan.characterAnchor || ''}\nCore outfit: ${storyPlan.characterOutfit || ''}\nPrevious attempt issue: ${finalCheck.issues.join(', ')}`;
              const correctedPrompt = correctionNote + '\n\n' + prompt;
              const finalRetry = await generateIllustration(correctedPrompt, characterRef, style, buildRetryOpts());
              if (finalRetry) {
                imageUrl = finalRetry;
                bookContext.log('info', `Spread ${idx + 1} final consistency retry succeeded`);
              }
            } catch (retryErr) {
              bookContext.log('warn', `Final consistency retry failed for spread ${idx + 1}`, { error: retryErr.message });
            }
          } else {
            bookContext.log('info', `Spread ${idx + 1} post-retry consistency re-check OK`);
          }
        } catch (checkErr) {
          bookContext.log('warn', `Post-retry consistency re-check error for spread ${idx + 1}`, { error: checkErr.message });
        }
      }

      // Save first spread image as outfit style reference for subsequent spreads
      if (idx === 0 && imageUrl && !firstSpreadBase64) {
        try {
          const fsResp = await fetch(imageUrl);
          if (fsResp.ok) {
            firstSpreadBase64 = Buffer.from(await fsResp.arrayBuffer()).toString('base64');
            bookContext.log('info', 'Saved first spread as outfit style reference');
          }
        } catch (e) {
          bookContext.log('warn', 'Failed to save first spread as outfit reference', { error: e.message });
        }
      }

      results[idx][field] = imageUrl;
      completedCount++;

      // Save partial checkpoint
      if (checkpointData) {
        await saveCheckpoint(bookId, {
          ...checkpointData,
          completedStage: 'illustrations_partial',
          illustrationResults: results,
          timestamp: new Date().toISOString(),
          accumulatedCosts: costTracker.getSummary(),
        }).catch(e => console.warn('[checkpoint] Save failed:', e.message));
      }

      if (progressCallbackUrl) {
        const progress = 0.40 + (0.35 * completedCount / illustratableEntries.length);
        reportProgress(progressCallbackUrl, {
          bookId,
          stage: 'illustration',
          progress,
          message: `Generating illustration ${completedCount} of ${illustratableEntries.length}...`,
          previewUrls: results.filter(r => r.spreadIllustrationUrl || r.illustrationUrl || r.leftIllustrationUrl).map(r => r.spreadIllustrationUrl || r.illustrationUrl || r.leftIllustrationUrl),
          logs: bookContext.logs,
        });
      }
    })
  );

  await Promise.all(illustrationPromises);

  bookContext.log('info', 'All illustrations generated (no text)', { totalMs: Date.now() - stage5Start });

  // ── Text Compositing ──
  // Composite story text onto illustrations programmatically.
  // This ensures perfect font consistency across all spreads.
  const textCompositor = new TextCompositor();
  const compositingStart = Date.now();
  let compositedCount = 0;

  for (const job of illustratableEntries) {
    const { idx, field } = job;
    const entry = results[idx];
    const illUrl = entry?.[field];
    const pageText = job.pageText || '';

    if (!illUrl || !pageText.trim()) continue;

    try {
      // Download the raw illustration
      const resp = await fetch(illUrl);
      if (!resp.ok) continue;
      const rawBuffer = Buffer.from(await resp.arrayBuffer());

      // Get layout config for this spread
      const layout = TextCompositor.getDefaultLayout(idx, illustratableEntries.length);

      // Composite text
      const compositedBuffer = await textCompositor.compositeText(rawBuffer, pageText, layout);

      // Upload composited version
      const compositedPath = `children-jobs/${bookId}/illustrations/${Date.now()}-text.png`;
      const compositedUrl = await uploadBuffer(compositedBuffer, compositedPath, 'image/png');

      // Store raw URL for admin comparison, use composited for the book
      entry._rawIllustrationUrl = illUrl;
      entry[field] = compositedUrl;
      compositedCount++;

      bookContext.log('info', `Text composited for spread ${idx + 1}`);
    } catch (compErr) {
      bookContext.log('warn', `Text compositing failed for spread ${idx + 1}: ${compErr.message} — using raw illustration`);
      // Non-fatal: the illustration without text is still usable
    }
  }

  bookContext.log('info', `Text compositing complete: ${compositedCount}/${illustratableEntries.filter(j => j.pageText?.trim()).length} spreads`, { ms: Date.now() - compositingStart });
  console.log(`[server] Stage timing: illustrations=${Date.now() - stage5Start}ms (incl. text compositing, book ${bookId})`);
  return results;
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
          skipTextEmbed: false,
          comicPageMode: true,
          colorScript: page.colorScript,
          prevIllustrationUrls,
          abortSignal: bookContext.abortController.signal,
          deadlineMs: 180000,
          firstPageRefBase64: firstPageRefBase64 || null,
          promptInjection: completed === 0
            ? 'STYLE ESTABLISHMENT: This is the FIRST page of the graphic novel. The art style, color palette, lighting mood, character rendering, and text style you establish HERE will be the reference for ALL subsequent pages. Commit to a specific, rich, consistent style. '
            : '',
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
                  skipTextEmbed: false,
                  comicPageMode: true,
                  colorScript: page.colorScript,
                  prevIllustrationUrls,
                  abortSignal: bookContext.abortController.signal,
                  deadlineMs: 180000,
                  firstPageRefBase64: firstPageRefBase64 || null,
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
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'giftmybook-children-worker',
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
      cachedPhotoBase64: characterRefBase64,
      cachedPhotoMime: characterRefMime,
      existingIllustrations: [],
      checkpointData: null,
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
  const style = artStyle || 'cinematic_3d';
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

  const bookContext = createBookContext(bookId, { progressCallbackUrl, callbackUrl });

  // Respond 202 immediately, process in background
  res.status(202).json({ success: true, status: 'processing', bookId });

  let absoluteTimer = null;
  let heartbeatInterval = null;

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
          const resp = await reportProgress(progressCallbackUrl, {
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
      } else {
        // Always start fresh for V2 (incompatible with old checkpoint format)
        bookContext.checkAbort();
        bookContext.log('info', 'Starting V2 story planning', { theme: theme || 'adventure' });
        if (progressCallbackUrl) {
          reportProgress(progressCallbackUrl, { bookId, stage: 'story_planning', progress: 0.15, message: 'Planning story...', logs: bookContext.logs });
        }

        const stage3Start = Date.now();
        storyPlan = await planStory(childDetails, theme || 'adventure', format, plannerCustomDetails, {
          apiKeys,
          costTracker,
          approvedTitle,
          v2Vars,
          additionalCoverCharacters: detectedSecondaryCharacters || null,
        });
        bookContext.touchActivity();
        const stage3Ms = Date.now() - stage3Start;
        const spreads = storyPlan.entries.filter(e => e.type === 'spread');
        bookContext.log('info', 'V2 story planned', { spreads: spreads.length, entries: storyPlan.entries.length, title: storyPlan.title, ms: stage3Ms });
        console.log(`[server] Stage timing: story=${stage3Ms}ms (book ${bookId})`);

        // Save story content to DB immediately so admin can see the text
        if (progressCallbackUrl) {
          const storyContentForDb = {
            title: storyPlan.title,
            entries: storyPlan.entries.map(e => ({ type: e.type, spread: e.spread, left: e.left, right: e.right, title: e.title, text: e.text })),
            characterDescription: storyPlan.characterDescription || null,
            characterOutfit: storyPlan.characterOutfit || null,
            characterAnchor: storyPlan.characterAnchor || null,
            additionalCoverCharacters: storyPlan.additionalCoverCharacters || null,
          };
          reportProgressForce(progressCallbackUrl, { bookId, stage: 'story_planning', storyContent: storyContentForDb, logs: bookContext.logs }).catch(() => {});
        }

        await saveCheckpoint(bookId, { bookId, completedStage: 'story_planning', storyPlan, timestamp: new Date().toISOString(), accumulatedCosts: costTracker.getSummary() });

        // ── Master Critic (consolidated single pass) ──
        bookContext.checkAbort();
        bookContext.log('info', 'Starting master critic (12-criteria scoring + rewrite)');
        if (progressCallbackUrl) {
          reportProgress(progressCallbackUrl, { bookId, stage: 'story_planning', progress: 0.20, message: 'Evaluating and polishing story...', logs: bookContext.logs });
        }
        try {
          const criticStart = Date.now();
          storyPlan = await masterCritic(storyPlan, {
            apiKeys,
            costTracker,
            theme,
            childAge: childDetails.age,
            format,
            style_mode: v2Vars?.style_mode || storyPlan._styleMode || 'playful',
            techniques: v2Vars?.techniques || storyPlan._techniques || ['rule_of_three', 'humor'],
            narrativePatterns: storyPlan._narrativePatterns || null,
          });
          const criticMs = Date.now() - criticStart;
          bookContext.log('info', 'Master critic complete', { ms: criticMs, scores: storyPlan._masterCriticScores, issueCount: storyPlan._masterCriticIssueCount });
          bookContext.touchActivity();

          // Quality gate: retry writing once if masterCritic avg < 5.0
          if (storyPlan._masterCriticScores) {
            const scores = storyPlan._masterCriticScores;
            const scoreValues = Object.values(scores).filter(v => typeof v === 'number');
            const avgScore = scoreValues.length > 0 ? scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length : 10;
            if (avgScore < 5.0) {
              bookContext.log('info', `Quality gate triggered: avg=${avgScore.toFixed(1)} — retrying story generation + re-critic`);
              if (progressCallbackUrl) {
                reportProgress(progressCallbackUrl, { bookId, stage: 'story_planning', progress: 0.22, message: 'Improving story — rewriting...', logs: bookContext.logs });
              }
              try {
                const retryPlan = await planStory(childDetails, theme || 'adventure', format, plannerCustomDetails, {
                  apiKeys,
                  costTracker,
                  approvedTitle,
                  v2Vars: { ...v2Vars, retryTemperature: 0.9 },
                  additionalCoverCharacters: detectedSecondaryCharacters || null,
                });
                const retryCritic = await masterCritic(retryPlan, {
                  apiKeys,
                  costTracker,
                  theme,
                  childAge: childDetails.age,
                  format,
                  style_mode: v2Vars?.style_mode || retryPlan._styleMode || 'playful',
                  techniques: v2Vars?.techniques || retryPlan._techniques || ['rule_of_three', 'humor'],
                  narrativePatterns: retryPlan._narrativePatterns || null,
                });
                const retryScores = retryCritic._masterCriticScores || {};
                const retryValues = Object.values(retryScores).filter(v => typeof v === 'number');
                const retryAvg = retryValues.length > 0 ? retryValues.reduce((a, b) => a + b, 0) / retryValues.length : 0;
                if (retryAvg > avgScore) {
                  bookContext.log('info', `Quality gate retry succeeded: new avg=${retryAvg.toFixed(1)} > old avg=${avgScore.toFixed(1)} — using retry version`);
                  storyPlan = retryCritic;
                } else {
                  bookContext.log('info', `Quality gate retry did not improve: new avg=${retryAvg.toFixed(1)} <= old avg=${avgScore.toFixed(1)} — keeping original`);
                }
              } catch (retryErr) {
                bookContext.log('warn', `Quality gate retry failed: ${retryErr.message} — keeping original`);
              }
            }
          }

          // Save polished content to DB
          if (progressCallbackUrl) {
            const polishedContent = { title: storyPlan.title, entries: storyPlan.entries.map(e => ({ type: e.type, spread: e.spread, left: e.left, right: e.right, title: e.title, text: e.text })) };
            reportProgressForce(progressCallbackUrl, { bookId, stage: 'story_planning', storyContent: polishedContent, logs: bookContext.logs }).catch(() => {});
          }
          await saveCheckpoint(bookId, { bookId, completedStage: 'story_final_polish', storyPlan, timestamp: new Date().toISOString(), accumulatedCosts: costTracker.getSummary() });
        } catch (criticErr) {
          bookContext.log('warn', `Master critic failed — continuing with original text: ${criticErr.message}`);
        }
      }

      // V2: Text is already in the story plan — no separate text generation needed.

      // ── W3 + W7: Quality gates — check custom details usage and story quality ──
      if (!isChapterBook && !storyPlan.isChapterBook && !isGraphicNovel && !storyPlan.isGraphicNovel) {
        try {
          const { checkCustomDetailsUsage, criticStory } = require('./services/qualityGates');

          // W3: Check customDetails usage
          const detailsCheck = await checkCustomDetailsUsage(storyPlan.entries, enrichedCustomDetails || customDetails, { costTracker });
          bookContext.log('info', 'Custom details usage check', { score: detailsCheck.score, missing: detailsCheck.missingCritical });
          if (detailsCheck.missingCritical && detailsCheck.missingCritical.length > 0 && detailsCheck.score < 5) {
            bookContext.log('warn', 'Story missing critical custom details', { missing: detailsCheck.missingCritical, score: detailsCheck.score });
          }

          // W7: Story critic (blocking — triggers retry on failure)
          const criticResult = await criticStory(storyPlan.entries, enrichedCustomDetails || customDetails, theme, childDetails.age || childDetails.childAge, { costTracker });
          bookContext.log('info', 'Story critic result', { total: criticResult.total, approved: criticResult.approved, feedback: (criticResult.feedback || '').slice(0, 200) });

          if (!criticResult.approved) {
            bookContext.log('warn', 'Story below quality threshold — triggering masterCritic retry', { score: criticResult.total, weakest: criticResult.weakestSpreads });
            try {
              if (progressCallbackUrl) {
                reportProgress(progressCallbackUrl, { bookId, stage: 'story_planning', progress: 0.27, message: 'Improving story based on critic feedback...', logs: bookContext.logs });
              }

              // Re-run masterCritic on the current version
              const retryCritic = await masterCritic(storyPlan, {
                apiKeys,
                costTracker,
                theme,
                childAge: childDetails.age || childDetails.childAge,
                format,
                style_mode: v2Vars?.style_mode || storyPlan._styleMode || 'playful',
                techniques: v2Vars?.techniques || storyPlan._techniques || ['rule_of_three', 'humor'],
                narrativePatterns: storyPlan._narrativePatterns || null,
              });
              bookContext.log('info', 'Critic retry: masterCritic complete', { scores: retryCritic._masterCriticScores });

              // Re-run criticStory on the improved version
              const retryResult = await criticStory(retryCritic.entries, enrichedCustomDetails || customDetails, theme, childDetails.age || childDetails.childAge, { costTracker });
              bookContext.log('info', 'Critic retry: second critic result', { total: retryResult.total, approved: retryResult.approved });

              // Accept the retried version regardless of second score (don't loop more than once)
              storyPlan = retryCritic;
              bookContext.log('info', `Critic retry complete — using retried version (score: ${retryResult.total}, approved: ${retryResult.approved})`);
            } catch (criticRetryErr) {
              bookContext.log('warn', `Critic retry failed — keeping original: ${criticRetryErr.message}`);
            }
          }
        } catch (qgErr) {
          bookContext.log('warn', 'Quality gates failed (non-blocking)', { error: qgErr.message });
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

      if (approvedCoverUrl) {
        try {
          const sharp = require('sharp');
          const coverUrl = approvedCoverUrl;
          const coverBuf = await withRetry(
            () => downloadBuffer(coverUrl),
            { maxRetries: 3, baseDelayMs: 1000, label: `download-cover-ref-${bookId}` }
          );
          preGeneratedCoverBuffer = coverBuf;

          // Use 512px cover for vision analysis (needs detail for facial feature extraction)
          const coverForVision = await sharp(coverBuf)
            .resize(512, 512, { fit: 'cover' })
            .jpeg({ quality: 80 })
            .toBuffer();
          const coverForVisionBase64 = coverForVision.toString('base64');

          const resizedCover = await sharp(coverBuf)
            .resize(256, 256, { fit: 'cover' })
            .jpeg({ quality: 80 })
            .toBuffer();
          characterRefBase64 = resizedCover.toString('base64');
          characterRefMime = 'image/jpeg';
          bookContext.log('info', 'Cover downloaded and resized', { originalBytes: coverBuf.length, visionBytes: coverForVision.length, refBytes: resizedCover.length, ms: Date.now() - stage6Start });

          // Extract character appearance + art style from cover using Gemini vision (512px)
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
                    { text: `Analyze this children's book cover image and respond with exactly four labeled sections.

CHARACTER:
Describe the MAIN child character in this exact format:
HAIR: [exact color, style, length, texture, and any accessories]
EYES: [color]
SKIN: [tone description]
BUILD: [approximate age/size cues visible]
NOTABLE: [any distinguishing features]

If you cannot determine a field from the image, write "not visible".

OUTFIT:
Describe the MAIN child's clothing EXACTLY as visible in the image:
TOP: [garment type, exact color, any patterns/logos/details, sleeve length, neckline, or "not visible"]
BOTTOM: [garment type, exact color, or "not visible"]
SHOES: [type, exact color, or "not visible"]
CLOTHING_ACCESSORIES: [items WORN on the body: hats, bows, hair ties, glasses, jewelry, scarves, capes, belts — or "none"]
HELD_ITEMS: [anything the character is HOLDING or interacting with: toys, devices, weapons, wands, books, tools — or "none". These are scene props, NOT part of the outfit]

ADDITIONAL_CHARACTERS:
List any OTHER characters visible on the cover besides the main child. For each one write:
- [relationship if apparent, e.g. grandmother/elderly woman/adult man]: [brief appearance description — hair, skin, clothing, distinguishing features]. If no other characters are present, write: NONE.

STYLE:
Describe the exact art style: medium (watercolor/digital/gouache/etc), color palette, line quality, texture, lighting, mood, and any distinctive techniques.

You MUST start the sections with CHARACTER:, OUTFIT:, ADDITIONAL_CHARACTERS:, and STYLE: exactly.` },
                    { inline_data: { mime_type: 'image/jpeg', data: coverForVisionBase64 } },
                  ]}],
                  generationConfig: { maxOutputTokens: 2500, temperature: 0.2 },
                }),
                signal: bookContext.abortController.signal,
              }
            );
            if (visionResp.ok) {
              const visionData = await visionResp.json();
              const extractedDesc = visionData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
              if (extractedDesc && extractedDesc.length > 20) {
                // Parse CHARACTER, OUTFIT, ADDITIONAL_CHARACTERS, and STYLE sections
                const charMatch = extractedDesc.match(/CHARACTER[:\s]+([\s\S]*?)(?=\nOUTFIT[:\s]|\nADDITIONAL_CHARACTERS[:\s]|\nSTYLE[:\s]|$)/i);
                const outfitMatch = extractedDesc.match(/OUTFIT[:\s]+([\s\S]*?)(?=\nADDITIONAL_CHARACTERS[:\s]|\nSTYLE[:\s]|$)/i);
                const addlMatch = extractedDesc.match(/ADDITIONAL_CHARACTERS[:\s]+([\s\S]*?)(?=\nSTYLE[:\s]|$)/i);
                const styleMatch = extractedDesc.match(/STYLE[:\s]+([\s\S]*?)$/i);
                if (charMatch?.[1]?.trim()) {
                  const charDesc = charMatch[1].trim();
                  const charDescLower = charDesc.toLowerCase();
                  // Guard: if Gemini describes an adult instead of a child, discard
                  if (charDescLower.includes('adult male') || charDescLower.includes('adult female') || charDescLower.includes('not a child') || charDescLower.includes('beard and mustache')) {
                    bookContext.log('warn', 'Character description describes an adult, not a child — discarding', { description: charDesc.slice(0, 200) });
                    storyPlan.characterDescription = null;
                  } else {
                    storyPlan.characterDescription = charDesc;
                    bookContext.log('info', 'Character appearance extracted from cover', { description: charDesc.slice(0, 300) });
                  }
                } else {
                  storyPlan.characterDescription = extractedDesc;
                  bookContext.log('info', 'Character appearance extracted (unstructured)', { description: extractedDesc.slice(0, 300) });
                }
                // Store additional cover characters (Grammy, siblings, etc.) for illustration allowlist
                const addlRaw = addlMatch?.[1]?.trim();
                if (addlRaw && addlRaw.toUpperCase() !== 'NONE' && addlRaw.length > 4) {
                  storyPlan.additionalCoverCharacters = addlRaw;
                  bookContext.log('info', 'Additional cover characters detected', { characters: addlRaw.slice(0, 300) });
                } else {
                  storyPlan.additionalCoverCharacters = null;
                }
                if (styleMatch?.[1]?.trim()) {
                  storyPlan.coverArtStyle = styleMatch[1].trim();
                  bookContext.log('info', 'Cover art style extracted', { style: styleMatch[1].trim().slice(0, 300) });
                } else {
                  bookContext.log('info', 'Cover art style not extracted — using cinematic_3d default');
                }
                // Override characterOutfit from cover image (takes priority over story planner's guess)
                // For partially visible outfits (e.g. cover shows only upper body), merge:
                // use cover-extracted values for visible parts, keep story planner's for non-visible parts.
                const outfitRaw = outfitMatch?.[1]?.trim();
                if (outfitRaw && outfitRaw.length > 10) {
                  const topPart = outfitRaw.match(/TOP[:\s]+(.+)/i);
                  const bottomPart = outfitRaw.match(/BOTTOM[:\s]+(.+)/i);
                  const shoesPart = outfitRaw.match(/SHOES[:\s]+(.+)/i);
                  const accessoriesPart = outfitRaw.match(/CLOTHING_ACCESSORIES[:\s]+(.+)/i);
                  // Intentionally ignore HELD_ITEMS — they are scene-specific props, not outfit
                  const coverParts = [];
                  if (topPart?.[1]?.trim() && !/not visible/i.test(topPart[1])) coverParts.push(topPart[1].trim());
                  if (bottomPart?.[1]?.trim() && !/not visible/i.test(bottomPart[1])) coverParts.push(bottomPart[1].trim());
                  if (shoesPart?.[1]?.trim() && !/not visible/i.test(shoesPart[1])) coverParts.push(shoesPart[1].trim());
                  if (accessoriesPart?.[1]?.trim() && !/not visible|^none$/i.test(accessoriesPart[1])) coverParts.push(accessoriesPart[1].trim());
                  if (coverParts.length > 0) {
                    const previousOutfit = storyPlan.characterOutfit || '';
                    // Merge: start with cover-extracted parts, then append non-visible parts from story planner
                    let mergedOutfit = coverParts.join(', ');
                    let hasBottom = bottomPart?.[1]?.trim() && !/not visible/i.test(bottomPart[1]);
                    let hasShoes = shoesPart?.[1]?.trim() && !/not visible/i.test(shoesPart[1]);
                    if ((!hasBottom || !hasShoes) && previousOutfit) {
                      // Extract bottom/shoes from story planner's outfit to fill gaps
                      const plannerItems = previousOutfit.split(/,\s*/);
                      for (const item of plannerItems) {
                        const itemLower = item.toLowerCase().trim();
                        if (!hasBottom && /\b(pants|jeans|shorts|skirt|leggings|trousers|joggers|overalls)\b/.test(itemLower)) {
                          mergedOutfit += ', ' + item.trim();
                          bookContext.log('info', 'Merged bottom garment from story planner', { item: item.trim() });
                          hasBottom = true;
                        }
                        if (!hasShoes && /\b(shoes|sneakers|boots|sandals|slippers|loafers|flats)\b/.test(itemLower)) {
                          mergedOutfit += ', ' + item.trim();
                          bookContext.log('info', 'Merged shoes from story planner', { item: item.trim() });
                          hasShoes = true;
                        }
                      }
                    }
                    // Append "no additional accessories" if cover showed none, to prevent invented items
                    const hasAccessories = accessoriesPart?.[1]?.trim() && !/not visible|^none$/i.test(accessoriesPart[1]);
                    if (!hasAccessories) {
                      mergedOutfit += ', no additional accessories';
                    }
                    storyPlan.characterOutfit = mergedOutfit;
                    bookContext.log('info', 'Character outfit extracted from cover (overriding story planner)', {
                      coverOutfit: storyPlan.characterOutfit.slice(0, 300),
                      previousOutfit: previousOutfit.slice(0, 300),
                    });
                  } else {
                    bookContext.log('info', 'Outfit section parsed but no visible garments — keeping story planner outfit');
                  }
                } else {
                  bookContext.log('info', 'Outfit not extracted from cover — keeping story planner outfit');
                }
              }
            }

            // Dedicated character anchor extraction — explicit ethnicity, eye shape, skin tone
            // Retries up to 4 times with rotating API keys until a valid anchor is extracted
            if (childPhotoUrls && childPhotoUrls.length > 0) {
            const MAX_ANCHOR_RETRIES = 4;
            for (let anchorAttempt = 1; anchorAttempt <= MAX_ANCHOR_RETRIES; anchorAttempt++) {
              try {
                const { getNextApiKey: getAnchorKey } = require('./services/illustrationGenerator');
                const anchorApiKey = getAnchorKey() || apiKey;
                bookContext.log('info', `Character anchor extraction attempt ${anchorAttempt}/${MAX_ANCHOR_RETRIES}`);
                const anchorResp = await fetch(
                  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${anchorApiKey}`,
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      contents: [{ role: 'user', parts: [
                        { text: `Look at the main child in this photograph. Answer these questions about their physical appearance with SPECIFIC, PRECISE answers — no vague descriptions. This is a REAL PHOTOGRAPH, not an illustration.

ETHNICITY: What is the child's ethnicity or racial appearance? (e.g. East Asian, South Asian, Black/African, Hispanic/Latino, White/Caucasian, Middle Eastern, Mixed/Biracial — be specific)
SKIN_TONE: Describe the exact skin tone using a specific shade name and undertone (e.g. "deep brown with warm golden undertones", "fair peach with cool pink undertones", "medium olive with warm yellow undertones"). Be precise enough that an illustrator could match this exactly.
EYE_SHAPE: Describe the eye shape specifically (e.g. "monolid", "almond-shaped with epicanthal fold", "large round", "hooded almond", "wide set round"). IMPORTANT: If the child's eyes are closed, squinting, or not fully visible in the photo, describe the eye SHAPE as if they were open (e.g. based on ethnicity and facial structure). A single photo captures a transient moment — always describe the eyes as open.
EYE_COLOR: What color are the eyes? If the eyes are closed or not visible, make your best estimate based on ethnicity and other features.
HAIR_COLOR: Exact hair color
HAIR_TEXTURE: Straight / wavy / curly / coily / tightly coiled
HAIR_LENGTH: Short / medium / long / very long

Format your answer with each label on its own line followed by a colon and the answer. Be specific and concrete — these will be used to ensure illustration consistency across an entire book.` },
                        { inline_data: { mime_type: cachedPhotoMime || 'image/jpeg', data: cachedPhotoBase64 } },
                      ]}],
                      generationConfig: { maxOutputTokens: 400, temperature: 0.1 },
                    }),
                    signal: bookContext.abortController.signal,
                  }
                );
                if (!anchorResp.ok) {
                  bookContext.log('warn', `Character anchor attempt ${anchorAttempt} failed`, { status: anchorResp.status, statusText: anchorResp.statusText });
                  if (anchorAttempt < MAX_ANCHOR_RETRIES) await new Promise(r => setTimeout(r, anchorAttempt * 1500));
                  continue;
                }
                const anchorData = await anchorResp.json();
                const anchorText = anchorData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                if (!anchorText || anchorText.length < 20) {
                  bookContext.log('warn', `Character anchor attempt ${anchorAttempt} returned empty/short response`, { length: anchorText?.length || 0 });
                  if (anchorAttempt < MAX_ANCHOR_RETRIES) await new Promise(r => setTimeout(r, anchorAttempt * 1500));
                  continue;
                }
                // Guard: if Gemini says "not a child" or "adult male/female", the photo
                // subject isn't a child — discard the anchor to avoid prompt contradictions
                const anchorLower = anchorText.toLowerCase();
                if (anchorLower.includes('not a child') || anchorLower.includes('adult male') || anchorLower.includes('adult female') || anchorLower.includes('not a kid')) {
                  bookContext.log('warn', 'Character anchor describes an adult, not a child — discarding to avoid prompt contradiction', { anchor: anchorText.slice(0, 200) });
                  storyPlan.characterAnchor = null;
                  break;
                }
                storyPlan.characterAnchor = anchorText;
                bookContext.log('info', 'Character anchor extracted', { attempt: anchorAttempt, anchor: anchorText.slice(0, 300) });
                // Persist to DB immediately
                if (progressCallbackUrl) {
                  const entriesSummary = Array.isArray(storyPlan.entries)
                    ? storyPlan.entries.map(e => ({ type: e.type, spread: e.spread, left: e.left, right: e.right }))
                    : [];
                  reportProgressForce(progressCallbackUrl, {
                    bookId,
                    stage: 'cover_analysis',
                    storyContent: {
                      title: storyPlan.title,
                      entries: entriesSummary,
                      ...(storyPlan.isGraphicNovel && { isGraphicNovel: true, panelCount: (storyPlan.allPanels || []).length }),
                      characterDescription: storyPlan.characterDescription || null,
                      characterOutfit: storyPlan.characterOutfit || null,
                      characterAnchor: storyPlan.characterAnchor || null,
                      additionalCoverCharacters: storyPlan.additionalCoverCharacters || null,
                    },
                    logs: bookContext.logs,
                  }).catch(() => {});
                }
                break; // success — stop retrying
              } catch (anchorErr) {
                bookContext.log('warn', `Character anchor attempt ${anchorAttempt} threw`, { error: anchorErr.message });
                if (anchorAttempt < MAX_ANCHOR_RETRIES) await new Promise(r => setTimeout(r, anchorAttempt * 1500));
              }
            }
            if (!storyPlan.characterAnchor) {
              bookContext.log('warn', 'Character anchor extraction failed after all retries — illustrations will use characterDescription only');
            }
            } else {
              storyPlan.characterAnchor = null;
              bookContext.log('info', '[generate-book] No photo provided, skipping characterAnchor extraction');
            }
          } catch (visionErr) {
            bookContext.log('warn', 'Failed to extract character appearance from cover', { error: visionErr.message });
          }
        } catch (dlErr) {
          bookContext.log('warn', 'Failed to download approved cover for reference, using original photo', { error: dlErr.message });
        }
      }

      // If we still have no characterAnchor but parent provided one, use it
      if (!storyPlan.characterAnchor && parentCharacterAnchor) {
        storyPlan.characterAnchor = parentCharacterAnchor;
        bookContext.log('info', '[generate-book] Using parentCharacterAnchor from parent book');
      }

      bookContext.log('info', 'Character reference ready', { refBytes: characterRefBase64?.length || 0, ms: Date.now() - stage6Start });

      // ── C1: Generate character reference sheet in the book's art style ──
      let characterRefSheetBase64 = null;
      if (storyPlan.characterAnchor && cachedPhotoBase64) {
        try {
          bookContext.log('info', 'Generating character reference sheet');
          const refSheetPrompt = `Front-facing portrait of a child character. Clean, well-lit, plain soft-colored background. Head and shoulders visible, looking directly at camera, neutral friendly expression. ${storyPlan.characterAnchor}. Character must look EXACTLY like the reference photo provided.`;

          const refSheet = await generateIllustration(refSheetPrompt, null, style, {
            apiKeys,
            costTracker,
            bookId,
            childName: childDetails.name || childDetails.childName,
            childPhotoUrl: null,
            _cachedPhotoBase64: cachedPhotoBase64,
            _cachedPhotoMime: cachedPhotoMime || 'image/jpeg',
            spreadIndex: -1, // special index for ref sheet
            deadlineMs: 120000,
            isSpread: false,
            skipTextEmbed: true,
          });

          if (refSheet && typeof refSheet === 'string') {
            // refSheet is a GCS URL — download it
            const refResp = await fetch(refSheet);
            if (refResp.ok) {
              const sharp = require('sharp');
              const refBuf = Buffer.from(await refResp.arrayBuffer());
              const resizedRef = await sharp(refBuf).resize(512, 512, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
              characterRefSheetBase64 = resizedRef.toString('base64');
              bookContext.log('info', 'Character reference sheet generated', { bytes: characterRefSheetBase64.length });
            }
          } else if (Buffer.isBuffer(refSheet)) {
            characterRefSheetBase64 = refSheet.toString('base64');
            bookContext.log('info', 'Character reference sheet generated', { bytes: characterRefSheetBase64.length });
          }
        } catch (refErr) {
          bookContext.log('warn', 'Character reference sheet failed, using photo fallback', { error: refErr.message });
        }
      }

      // ── C4: Use approved cover as secondary character visual reference ──
      // Fetch whenever the cover contains a secondary character, regardless of theme.
      let parentCoverRefBase64 = null;
      if (approvedCoverUrl && storyPlan.additionalCoverCharacters) {
        try {
          bookContext.log('info', 'Downloading approved cover as parent character reference');
          const coverResp = await fetch(approvedCoverUrl);
          if (coverResp.ok) {
            const coverBuf = Buffer.from(await coverResp.arrayBuffer());
            const sharp = require('sharp');
            const resized = await sharp(coverBuf).resize(512, 512, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
            parentCoverRefBase64 = resized.toString('base64');
            bookContext.log('info', 'Cover reference ready for parent character', { bytes: parentCoverRefBase64.length });
          }
        } catch (coverRefErr) {
          bookContext.log('warn', 'Cover reference download failed', { error: coverRefErr.message });
        }
      }

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
                skipTextEmbed: true,
                promptInjection: 'PORTRAIT FORMAT: This is a 2:3 portrait illustration for a chapter book. Tall, not wide.',
                pageText: '',
                additionalCoverCharacters: storyPlan.additionalCoverCharacters || null,
                artStyle: style,
              }
            );
            // generateIllustration returns a GCS URL string directly
            let illustUrl = typeof illus === 'string' ? illus : null;
            chapter.imageBuffer = null; // will be downloaded later from the URL

            // ── C5: Post-generation consistency check (chapter book) ──
            const chapterRefBase64 = characterRefSheetBase64 || characterRefBase64;
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
                          skipTextEmbed: true,
                          promptInjection: 'PORTRAIT FORMAT: This is a 2:3 portrait illustration for a chapter book. Tall, not wide.',
                          pageText: '',
                          additionalCoverCharacters: storyPlan.additionalCoverCharacters || null,
                          artStyle: style,
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

        entriesWithIllustrations = await generateAllIllustrations(storyPlan.entries, storyPlan, childDetails, characterRef, style, {
          apiKeys, costTracker, bookId, bookContext, progressCallbackUrl,
          resolvedChildPhotoUrl,
          cachedPhotoBase64: characterRefBase64,
          cachedPhotoMime: characterRefMime,
          existingIllustrations: checkpoint?.illustrationResults || [],
          checkpointData: { bookId, storyPlan },
          detectedSecondaryCharacters: detectedSecondaryCharacters || null,
          characterAnchor: storyPlan.characterAnchor || null,
          characterRefSheetBase64: characterRefSheetBase64 || null,
          parentCoverRefBase64: parentCoverRefBase64 || null,
        });

        bookContext.log('info', 'All illustrations complete', { entries: entriesWithIllustrations.length });

        spreadEntries = entriesWithIllustrations.filter(e => e.type === 'spread');
        const illustrationFailures = spreadEntries.filter(e => !e.spreadIllustrationUrl && !e.leftIllustrationUrl).length;
        if (illustrationFailures > 0) {
          bookContext.log('warn', `${illustrationFailures}/${spreadEntries.length} spread illustrations failed`);
          bookWarnings.push(`${illustrationFailures} of ${spreadEntries.length} illustrations failed`);
        }
      }

      // ── Holistic QA Gate: analyze all illustrations as a set ──
      try {
        const { runHolisticQa } = require('./services/illustrationQa');
        bookContext.checkAbort();
        bookContext.log('info', 'Starting holistic illustration QA');
        if (progressCallbackUrl) {
          reportProgress(progressCallbackUrl, { bookId, stage: 'qa', progress: 0.78, message: 'Running illustration quality checks...', logs: bookContext.logs });
        }

        // Collect all generated images with their base64 data
        const allQaImages = [];
        if (isGraphicNovel || storyPlan.isGraphicNovel) {
          // GN pipeline: pages stored on storyPlan.pages
          for (const page of (storyPlan.pages || [])) {
            if (!page.illustrationUrl) continue;
            let imgBase64 = null;
            try {
              const resp = await fetch(page.illustrationUrl);
              if (resp.ok) imgBase64 = Buffer.from(await resp.arrayBuffer()).toString('base64');
            } catch {}
            if (imgBase64) {
              const panelTexts = (page.panels || []).map(p => p.dialogue || p.caption || '').filter(Boolean).join(' ');
              allQaImages.push({
                index: (page.pageNumber || allQaImages.length + 1) - 1,
                imageBase64: imgBase64,
                imageUrl: page.illustrationUrl,
                pageText: panelTexts,
                sceneDescription: page.sceneTitle || '',
              });
            }
          }
        } else if (!(isChapterBook || storyPlan.isChapterBook)) {
          // Picture book / early reader: entries with illustration URLs
          for (let i = 0; i < (entriesWithIllustrations || []).length; i++) {
            const entry = entriesWithIllustrations[i];
            const illUrl = entry.spreadIllustrationUrl || entry.illustrationUrl;
            if (!illUrl) continue;
            let imgBase64 = null;
            try {
              const resp = await fetch(illUrl);
              if (resp.ok) imgBase64 = Buffer.from(await resp.arrayBuffer()).toString('base64');
            } catch {}
            if (imgBase64) {
              const spreadText = [entry.left?.text, entry.right?.text, entry.text].filter(Boolean).join(' ');
              allQaImages.push({
                index: i,
                imageBase64: imgBase64,
                imageUrl: illUrl,
                pageText: spreadText || '',
                sceneDescription: entry.spread_image_prompt || '',
              });
            }
          }
        }

        if (allQaImages.length >= 2) {
          const qaContext = {
            characterRef: characterRefBase64 || null,
            characterAnchor: storyPlan.characterAnchor || null,
            characterOutfit: storyPlan.characterOutfit || '',
            artStyle: style,
            childName: childDetails.name || childDetails.childName,
            bookType: bookFormat,
            storyPlan,
            allCharacters: storyPlan.additionalCoverCharacters
              ? [childDetails.name || 'child', storyPlan.additionalCoverCharacters]
              : [childDetails.name || 'child'],
          };

          const qaResult = await runHolisticQa(allQaImages, qaContext);
          bookContext.log('info', `Holistic QA complete: score=${qaResult.score}, passed=${qaResult.passed}, issues=${qaResult.issues.length}`);

          // Report QA results
          if (progressCallbackUrl) {
            reportProgressForce(progressCallbackUrl, {
              bookId,
              stage: 'qa_complete',
              progress: 0.82,
              message: `Quality check: ${qaResult.score}% (${qaResult.passed ? 'passed' : 'needs improvement'})`,
              qaScore: qaResult.score,
              qaPassed: qaResult.passed,
              qaIssues: qaResult.issues,
              logs: bookContext.logs,
            });
          }

          // ── Simple Chat-Based QA Retry (replaces 3-tier fix system) ──
          // If QA fails, do one round of retries for failed spreads using standalone generation.
          // Never abort — always produce a book.
          if (!qaResult.passed && qaResult.failedSpreads.length > 0) {
            bookContext.log('info', `QA retry: ${qaResult.failedSpreads.length} spreads need improvement (score: ${qaResult.score})`);
            if (progressCallbackUrl) {
              reportProgress(progressCallbackUrl, {
                bookId, stage: 'qa_fix', progress: 0.85,
                message: `Improving ${qaResult.failedSpreads.length} illustrations...`, logs: bookContext.logs,
              });
            }

            const anchorImages = getTopScoringImages(allQaImages, qaResult, 2);

            for (const failed of qaResult.failedSpreads) {
              const failedCheckNames = failed.checks.map(c => c.check);
              bookContext.log('info', `QA retry: spread ${failed.index + 1} for: ${failedCheckNames.join(', ')}`);

              const origImg = allQaImages.find(q => q.index === failed.index);
              const correctionContext = {
                characterAnchor: storyPlan.characterAnchor || '',
                characterOutfit: storyPlan.characterOutfit || '',
                pageText: origImg?.pageText || '',
                sceneDescription: origImg?.sceneDescription || '',
              };
              const correctionNote = buildCheckSpecificCorrection(failed.checks, correctionContext);

              try {
                let originalPrompt = '';
                if (isGraphicNovel || storyPlan.isGraphicNovel) {
                  const page = (storyPlan.pages || [])[failed.index];
                  if (page) originalPrompt = page.fullPagePrompt || '';
                } else {
                  const entry = entriesWithIllustrations[failed.index];
                  if (entry) originalPrompt = entry.spread_image_prompt || entry.left?.image_prompt || '';
                }

                const correctedPrompt = correctionNote + '\n\n' + originalPrompt;

                // Build retry opts
                const retryOpts = {
                  apiKeys, costTracker, bookId,
                  childName: childDetails.name,
                  characterOutfit: storyPlan.characterOutfit || '',
                  characterDescription: storyPlan.characterDescription || '',
                  characterAnchor: storyPlan.characterAnchor || null,
                  additionalCoverCharacters: storyPlan.additionalCoverCharacters || null,
                  recurringElement: storyPlan.recurringElement || '',
                  keyObjects: storyPlan.keyObjects || '',
                  coverArtStyle: storyPlan.coverArtStyle || '',
                  childPhotoUrl: resolvedChildPhotoUrl,
                  _cachedPhotoBase64: characterRefSheetBase64 || characterRefBase64 || cachedPhotoBase64,
                  _cachedPhotoMime: characterRefSheetBase64 ? 'image/jpeg' : (characterRefMime || cachedPhotoMime),
                  spreadIndex: failed.index,
                  totalSpreads: spreadEntries.length,
                  childAge: childDetails.age || childDetails.childAge,
                  pageText: '', // No text in illustrations
                  skipTextEmbed: true,
                  isSpread: !!(entriesWithIllustrations[failed.index]?.type === 'spread'),
                  deadlineMs: 200000,
                  abortSignal: bookContext.abortController.signal,
                };

                const retryUrl = await generateIllustrationWithAnchors(
                  correctedPrompt,
                  characterRef,
                  style,
                  anchorImages,
                  retryOpts
                );

                if (retryUrl) {
                  if (isGraphicNovel || storyPlan.isGraphicNovel) {
                    const page = (storyPlan.pages || [])[failed.index];
                    if (page) page.illustrationUrl = retryUrl;
                  } else {
                    const entry = entriesWithIllustrations[failed.index];
                    if (entry) entry.spreadIllustrationUrl = retryUrl;
                  }
                  bookContext.log('info', `QA retry: spread ${failed.index + 1} improved`);
                }
              } catch (retryErr) {
                bookContext.log('warn', `QA retry failed for spread ${failed.index + 1}: ${retryErr.message} — accepting as-is`);
              }
            }

            // Report final QA results
            if (progressCallbackUrl) {
              reportProgressForce(progressCallbackUrl, {
                bookId,
                stage: 'qa_final',
                progress: 0.90,
                message: `Quality: ${qaResult.score}% — proceeding with best effort`,
                qaScore: qaResult.score,
                qaPassed: qaResult.passed,
                qaIssues: qaResult.issues,
                logs: bookContext.logs,
              });
            }
          }
        } else {
          bookContext.log('info', 'Skipping holistic QA — fewer than 2 images available');
        }
      } catch (qaErr) {
        bookContext.log('warn', 'Holistic QA failed (non-blocking)', { error: qaErr.message });
        // QA failure should never block book generation
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
      const coverPath = `children-jobs/${bookId}/cover.pdf`;
      try {
        bookContext.log('info', 'Building cover PDF...');
        reportProgressForce(progressCallbackUrl, { bookId, stage: 'cover', progress: 0.95, message: 'Building cover PDF...', logs: bookContext.logs }).catch(() => {});
        // Calculate actual interior page count for spine width
        let pageCount;
        if (isGraphicNovel || storyPlan.isGraphicNovel) {
          // Graphic novel: title + dedication + scene pages (panel-count driven) + end page
          const panelCount = (storyPlan.allPanels || []).length;
          pageCount = 2 + Math.ceil(panelCount / 2) + 1;
          pageCount = Math.max(32, pageCount % 2 === 0 ? pageCount : pageCount + 1);
        } else if (isChapterBook || storyPlan.isChapterBook) {
          // Chapter book: estimate from chapters (title + dedication + 5*(title page + ~3 text pages) + end page)
          pageCount = 2 + storyPlan.chapters.length * 4 + 1;
          pageCount = Math.max(32, pageCount % 2 === 0 ? pageCount : pageCount + 1);
        } else {
          pageCount = 0;
          for (const entry of entriesWithBuffers) {
            if (entry.type === 'spread') pageCount += 2;
            else pageCount += 1;
          }
          pageCount = Math.max(32, pageCount % 2 === 0 ? pageCount : pageCount + 1);
        }
        // Build synopsis from story plan for back cover
        let synopsis;
        if (isGraphicNovel || storyPlan.isGraphicNovel) {
          synopsis = storyPlan.synopsis
            || storyPlan.storyBible?.logline
            || storyPlan.storyBible?.audiencePromise
            || (Array.isArray(storyPlan.storyBible?.sceneBlueprints) && storyPlan.storyBible.sceneBlueprints.length >= 2
              ? storyPlan.storyBible.sceneBlueprints.slice(0, 3).map(s => s.purpose || s.sceneTitle || '').filter(Boolean).join(' ')
              : null)
            || storyPlan.tagline
            || `A personalized graphic novel for ${childDetails.name}`;
        } else if (isChapterBook || storyPlan.isChapterBook) {
          synopsis = storyPlan.chapters.slice(0, 2).map(ch => ch.synopsis).join(' ')
            || `A personalized chapter book for ${childDetails.name}`;
        } else {
          synopsis = storyPlan.synopsis
            || (storyPlan.entries || []).filter(e => e.type === 'spread').slice(0, 2).map(e => [e.left?.text, e.right?.text].filter(Boolean).join(' ')).join(' ')
            || `A personalized bedtime story for ${childDetails.name}`;
        }

        const coverData = await generateCover(bookTitle, childDetails, characterRef, format, {
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
      removeBookContext(bookId);
    }
  })();

  // Hard wall: kill generation after 90 minutes no matter what
  const hardTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Generation exceeded 90 minute hard limit')), 90 * 60 * 1000)
  );

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
// Regenerate a single spread illustration without stopping the main pipeline.
// Called by admin "regenerate illustration" button.
app.post('/regenerate-illustration', authenticate, async (req, res) => {
  const { bookId, spreadIndex, spreadImagePrompt, promptInjection, pageText, artStyle,
    characterOutfit, characterDescription, characterAnchor, recurringElement, keyObjects,
    coverArtStyle, childName, childPhotoUrl, cachedPhotoBase64, prevIllustrationUrl, prevIllustrationUrls, fontStyle, additionalCoverCharacters,
    totalSpreads, firstSpreadRefUrl } = req.body;

  if (!bookId || typeof spreadIndex !== 'number') {
    return res.status(400).json({ success: false, error: 'bookId and spreadIndex are required' });
  }
  if (!spreadImagePrompt) {
    return res.status(400).json({ success: false, error: 'spreadImagePrompt is required' });
  }

  console.log(`[server] /regenerate-illustration: bookId=${bookId}, spread=${spreadIndex}${promptInjection ? ' [+injection]' : ''}`);

  const costTracker = new CostTracker();
  const style = artStyle || 'cinematic_3d';

  // Auto-extract characterAnchor if missing — happens for books generated before the anchor feature
  let resolvedCharacterAnchor = characterAnchor || null;
  if (!resolvedCharacterAnchor && childPhotoUrl) {
    console.log(`[server] /regenerate-illustration: characterAnchor missing for ${bookId} — extracting from cover photo`);
    const MAX_ANCHOR_RETRIES = 3;
    for (let anchorAttempt = 1; anchorAttempt <= MAX_ANCHOR_RETRIES; anchorAttempt++) {
      try {
        const { getNextApiKey, downloadPhotoAsBase64 } = require('./services/illustrationGenerator');
        const anchorApiKey = getNextApiKey();
        const coverPhoto = await downloadPhotoAsBase64(childPhotoUrl);
        const anchorResp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${anchorApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [
                { text: `Look at the main child character in this image. Answer with SPECIFIC, PRECISE answers.

ETHNICITY: What is the child's ethnicity or racial appearance? (e.g. East Asian, South Asian, Black/African, Hispanic/Latino, White/Caucasian, Middle Eastern, Mixed/Biracial — be specific)
SKIN_TONE: Exact skin tone in 3-5 words
EYE_SHAPE: Eye shape specifically (e.g. monolid, almond-shaped with epicanthal fold, large round)
EYE_COLOR: Eye color
HAIR_COLOR: Exact hair color
HAIR_TEXTURE: Straight / wavy / curly / coily / tightly coiled
HAIR_LENGTH: Short / medium / long / very long

Format: each label on its own line followed by a colon and the answer.` },
                { inline_data: { mime_type: coverPhoto.mimeType || 'image/jpeg', data: coverPhoto.base64 } },
              ]}],
              generationConfig: { maxOutputTokens: 400, temperature: 0.1 },
            }),
          }
        );
        if (anchorResp.ok) {
          const anchorData = await anchorResp.json();
          const anchorText = anchorData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (anchorText && anchorText.length > 20) {
            resolvedCharacterAnchor = anchorText;
            console.log(`[server] /regenerate-illustration: characterAnchor extracted (attempt ${anchorAttempt}):`, anchorText.slice(0, 120));
            break;
          }
        } else {
          console.warn(`[server] /regenerate-illustration: anchor extraction attempt ${anchorAttempt} failed: ${anchorResp.status}`);
        }
      } catch (anchorErr) {
        console.warn(`[server] /regenerate-illustration: anchor extraction attempt ${anchorAttempt} threw:`, anchorErr.message);
      }
      if (anchorAttempt < MAX_ANCHOR_RETRIES) await new Promise(r => setTimeout(r, anchorAttempt * 1500));
    }
  }

  // Download first spread as base64 for outfit/font reference during regeneration
  let firstSpreadRefBase64 = null;
  if (firstSpreadRefUrl && spreadIndex > 0) {
    try {
      const { downloadPhotoAsBase64 } = require('./services/illustrationGenerator');
      const firstSpreadPhoto = await downloadPhotoAsBase64(firstSpreadRefUrl);
      firstSpreadRefBase64 = firstSpreadPhoto.base64;
      console.log(`[regen] Downloaded first spread ref for outfit/font consistency`);
    } catch (e) {
      console.log(`[regen] Could not download first spread ref: ${e.message}`);
    }
  }

  try {
    // Generate the illustration
    const result = await generateIllustration(spreadImagePrompt, null, style, {
      costTracker,
      bookId,
      childName,
      childPhotoUrl,
      spreadIndex,
      totalSpreads: totalSpreads || 0,
      pageText: pageText || '',
      characterOutfit,
      characterDescription,
      characterAnchor: resolvedCharacterAnchor,
      recurringElement,
      keyObjects,
      coverArtStyle,
      isSpread: true,
      promptInjection: promptInjection || '',
      fontStyle: fontStyle || null,
      additionalCoverCharacters: additionalCoverCharacters || null,
      prevIllustrationUrl: prevIllustrationUrl || null,
      prevIllustrationUrls: Array.isArray(prevIllustrationUrls) && prevIllustrationUrls.length > 0 ? prevIllustrationUrls : (prevIllustrationUrl ? [prevIllustrationUrl] : []),
      _cachedPhotoBase64: cachedPhotoBase64 || null,
      firstSpreadRefBase64,
    });

    if (!result) {
      return res.status(500).json({ success: false, error: 'Illustration generation returned no result' });
    }

    // Upload to GCS, replacing the old illustration
    const gcsPath = `children-jobs/${bookId}/illustrations/spread-${spreadIndex}-${Date.now()}.png`;
    const imageBuffer = await downloadBuffer(result);
    await uploadBuffer(imageBuffer, gcsPath, 'image/png');
    const newUrl = await getSignedUrl(gcsPath, 30 * 24 * 60 * 60 * 1000);

    console.log(`[server] Illustration regenerated for book ${bookId}, spread ${spreadIndex}`);

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

// ── POST /generate-spread ──
// Generate a single spread (for Cloud Tasks parallelism)
app.post('/generate-spread', authenticate, async (req, res) => {
  const { valid, errors } = validateGenerateSpreadRequest(req.body);
  if (!valid) {
    return res.status(400).json({ success: false, errors });
  }

  const {
    bookId, spreadPlan, characterRef,
    childDetails, bookFormat, storyContext, artStyle, apiKeys,
  } = req.body;

  console.log(`[server] /generate-spread: bookId=${bookId}, spread=${spreadPlan.spreadNumber}`);
  global.touchActivity(bookId);

  const costTracker = new CostTracker();

  try {
    // Generate text for this spread
    const text = await generateSpreadText(spreadPlan, childDetails, bookFormat || 'picture_book', storyContext || {}, {
      apiKeys,
      costTracker,
    });
    global.touchActivity(bookId);

    // Generate illustration
    const style = artStyle || 'cinematic_3d';
    const sceneDesc = spreadPlan.illustrationPrompt || spreadPlan.illustrationDescription || text;
    const imageUrl = await generateIllustration(sceneDesc, characterRef, style, {
      apiKeys,
      costTracker,
      bookId,
    });
    global.touchActivity(bookId);

    // Upload spread image to GCS
    const spreadPath = `children-jobs/${bookId}/spreads/spread-${spreadPlan.spreadNumber}.png`;
    const imageBuffer = await downloadBuffer(imageUrl);
    await uploadBuffer(imageBuffer, spreadPath, 'image/png');
    const spreadImageUrl = await getSignedUrl(spreadPath, 30 * 24 * 60 * 60 * 1000);

    res.json({
      success: true,
      spreadNumber: spreadPlan.spreadNumber,
      text,
      imageUrl: spreadImageUrl,
      costs: costTracker.getSummary(),
    });
  } catch (err) {
    console.error(`[server] Spread ${spreadPlan.spreadNumber} failed for ${bookId}:`, err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /generate-coloring-book ──────────────────────────────────────────────
// mode=trace  (default): converts existing spread illustrations to coloring pages.
// mode=generate: creates original coloring scenes from scenePrompts + child photo.
app.post('/generate-coloring-book', authenticate, async (req, res) => {
  const {
    bookId, childName, title, illustrationUrls,
    mode = 'trace',
    scenePrompts, childPhotoUrl, characterDescription, characterAnchorUrl,
    synopsis, age, sceneCount,
    pagesOnly = false,
  } = req.body;

  if (!bookId) {
    return res.status(400).json({ success: false, error: 'bookId is required' });
  }

  if (mode === 'trace') {
    if (!Array.isArray(illustrationUrls) || illustrationUrls.length === 0) {
      return res.status(400).json({ success: false, error: 'illustrationUrls[] is required for trace mode' });
    }
  } else if (mode === 'generate') {
    // scenePrompts can be omitted — server will auto-plan from title/synopsis
    if (!Array.isArray(scenePrompts) && !title) {
      return res.status(400).json({ success: false, error: 'generate mode requires scenePrompts[] or at least title for auto-planning' });
    }
  } else {
    return res.status(400).json({ success: false, error: `Invalid mode "${mode}" — use "trace" or "generate"` });
  }

  console.log(`[server] /generate-coloring-book: bookId=${bookId}, mode=${mode}`);

  try {
    const { generateColoringPages, generateOriginalColoringPages, planColoringScenes } = require('./services/coloringBookGenerator');
    const { downloadPhotoAsBase64 } = require('./services/illustrationGenerator');
    const { buildColoringBookPdf, buildInteriorPdf, buildCoverWrapPdf, generateCoverThumbnailPng, imageToPreviewPng } = require('./services/coloringBookLayout');
    const { uploadBuffer } = require('./services/gcsStorage');

    let pages;

    if (mode === 'trace') {
      pages = await generateColoringPages(illustrationUrls);
    } else {
      // Auto-plan scenes if caller didn't supply them
      let resolvedScenePrompts = scenePrompts;
      if (!Array.isArray(resolvedScenePrompts) || resolvedScenePrompts.length === 0) {
        console.log(`[server] Auto-planning coloring scenes from book metadata`);
        resolvedScenePrompts = await planColoringScenes({
          title, synopsis, characterDescription, childName, age,
          count: sceneCount || 12,
        });
        console.log(`[server] Planned ${resolvedScenePrompts.length} coloring scenes`);
      }

      let characterRef = null;
      if (childPhotoUrl) {
        try {
          characterRef = await downloadPhotoAsBase64(childPhotoUrl);
        } catch (err) {
          console.warn(`[server] Could not download child photo for coloring generate: ${err.message}`);
        }
      }

      let characterAnchor = null;
      if (characterAnchorUrl) {
        try {
          characterAnchor = await downloadPhotoAsBase64(characterAnchorUrl);
        } catch (err) {
          console.warn(`[server] Could not download character anchor for coloring generate: ${err.message}`);
        }
      }

      pages = await generateOriginalColoringPages(resolvedScenePrompts, characterRef, {
        characterDescription,
        characterAnchor,
      });
    }

    const totalPages = pages.length;

    const successCount = pages.filter(p => p.success).length;
    console.log(`[server] Coloring page ${mode}: ${successCount}/${totalPages} succeeded`);

    // Pick a cover image from the first successful coloring page
    const firstSuccessPage = pages.find(p => p.success && p.buffer);
    const coverImageBuffer = firstSuccessPage ? firstSuccessPage.buffer : undefined;

    // Build all PDFs in parallel
    const [legacyPdfBuffer, interiorPdfBuffer, coverPdfBuffer] = await Promise.all([
      buildColoringBookPdf(pages, { title, childName, pagesOnly, coverImageBuffer }),
      pagesOnly ? null : buildInteriorPdf(pages, { title, childName }),
      pagesOnly ? null : buildCoverWrapPdf({ title, childName, coverImageBuffer }),
    ]);
    console.log(`[server] Coloring book PDFs built — legacy: ${Math.round(legacyPdfBuffer.length / 1024)}KB` +
      (interiorPdfBuffer ? `, interior: ${Math.round(interiorPdfBuffer.length / 1024)}KB` : '') +
      (coverPdfBuffer ? `, cover: ${Math.round(coverPdfBuffer.length / 1024)}KB` : ''));

    // Upload PDFs in parallel
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

    // Generate cover thumbnail and preview PNGs
    const pngPromises = [];
    if (!pagesOnly && coverImageBuffer) {
      pngPromises.push(
        generateCoverThumbnailPng({ title, childName, coverImageBuffer })
          .then(buf => uploadBuffer(buf, `${gcsBase}/cover-thumbnail.png`, 'image/png'))
      );
    }

    // Pick up to 3 successful pages for previews
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
    const coverImageUrl = (!pagesOnly && coverImageBuffer) ? pngUrls[0] : undefined;
    const previewImageUrls = pngUrls.slice(coverImageUrl ? 1 : 0);

    console.log(`[server] Coloring book uploaded — legacy: ${legacyUrl.slice(0, 80)}`);
    if (interiorPdfUrl) console.log(`[server] Interior PDF: ${interiorPdfUrl.slice(0, 80)}`);
    if (coverPdfUrl) console.log(`[server] Cover PDF: ${coverPdfUrl.slice(0, 80)}`);

    const failedErrors = pages.filter(p => !p.success).map(p => p.error).filter(Boolean);
    res.json({
      success: true,
      coloringBookPdfUrl: legacyUrl,  // backwards compat
      interiorPdfUrl,
      coverPdfUrl,
      coverImageUrl,
      previewImageUrls,
      successCount,
      totalPages,
      failedErrors,
      mode,
    });
  } catch (err) {
    console.error(`[server] /generate-coloring-book failed (${mode}): ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
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
        const details = childDetails || { name: childName, age: 5, gender: 'neutral' };
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
app.post('/rebuild-cover-pdf', authenticate, async (req, res) => {
  const { bookId, title, childDetails, coverImageUrl, bindingType, bookFormat, pageCount, synopsis, heartfeltNote, bookFrom } = req.body;
  if (!bookId || !coverImageUrl) {
    return res.status(400).json({ error: 'bookId and coverImageUrl required' });
  }
  try {
    console.log(`[rebuild-cover-pdf] Starting for book ${bookId}, binding=${bindingType}`);
    const preGeneratedCoverBuffer = await downloadBuffer(coverImageUrl);
    const resolvedPageCount = pageCount || 32;
    const coverData = await generateCover(title || 'My Story', childDetails || {}, null, bookFormat || 'PICTURE_BOOK', {
      bookId,
      preGeneratedCoverBuffer,
      pageCount: resolvedPageCount,
      synopsis: synopsis || '',
      heartfeltNote: heartfeltNote || '',
      bookFrom: bookFrom || '',
      bindingType: bindingType || '',
    });
    if (!coverData?.coverPdfBuffer) throw new Error('generateCover returned no buffer');
    const coverPath = `children-jobs/${bookId}/cover.pdf`;
    await uploadBuffer(coverData.coverPdfBuffer, coverPath, 'application/pdf');
    const coverPdfUrl = await getSignedUrl(coverPath, 30 * 24 * 60 * 60 * 1000);
    console.log(`[rebuild-cover-pdf] Done for book ${bookId}: ${coverPdfUrl}`);
    return res.json({ success: true, coverPdfUrl });
  } catch (err) {
    console.error(`[rebuild-cover-pdf] Error:`, err.message);
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
