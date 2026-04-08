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

const { planStory, polishStory, brainstormStorySeed, combinedCritic, EMOTIONAL_THEMES, getEmotionalTier } = require('./services/storyPlanner');
const { generateSpreadText } = require('./services/textGenerator');
const { generateIllustration } = require('./services/illustrationGenerator');
const { assemblePdf } = require('./services/layoutEngine');
const { generateCover, generateUpsellCovers } = require('./services/coverGenerator');
const { uploadBuffer, getSignedUrl, downloadBuffer, deletePrefix } = require('./services/gcsStorage');
const { reportProgress, reportProgressForce, reportComplete, reportError, clearThrottle } = require('./services/progressReporter');
const { CostTracker } = require('./services/costTracker');
const { buildWriterBrief, buildV2Brief, buildChildContext, getAgeProfile, getAgeTier } = require('./prompts/writerBrief');
const { validateGenerateBookRequest, validateGenerateSpreadRequest, validateFinalizeBookRequest } = require('./services/validation');
const { withRetry } = require('./services/retry');

// Guard against lorem ipsum / placeholder text leaking into illustration prompts
const LOREM_PATTERNS = /lorem\s+ipsum|dolor\s+sit\s+amet|consectetur\s+adipiscing|labore\s+et\s+dolore/i;

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
function createBookContext(bookId) {
  const abortController = new AbortController();
  const context = {
    bookId,
    abortSignal: abortController.signal,
    abortController,
    lastActivity: Date.now(),
    reject: null,
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
      const illStart = Date.now();
      const outfit = storyPlan.characterOutfit || '';
      const MAX_ILL_RETRIES = 3;
      const entryLabel = `entry ${idx + 1} (${results[idx].type})`;

      for (let attempt = 1; attempt <= MAX_ILL_RETRIES; attempt++) {
        try {
          if (attempt === 1) {
            bookContext.log('info', `Illustration ${entryLabel} starting`, { promptLength: prompt.length, field });
          } else {
            bookContext.log('info', `Illustration ${entryLabel} retry ${attempt}/${MAX_ILL_RETRIES}`);
          }
          // Find the most recent completed illustration as style reference
          // For spread 1 (idx=0): no prev illustration yet — use cover as style hint (already used as character ref)
          // For spread 2 (idx=1): use spread 1 once available
          let prevIllustrationUrl = null;
          for (let pi = idx - 1; pi >= 0; pi--) {
            const prev = results[pi];
            const prevUrl = prev?.spreadIllustrationUrl || prev?.illustrationUrl;
            if (prevUrl) { prevIllustrationUrl = prevUrl; break; }
          }
          // For spread 1 specifically: if no cover has been generated yet,
          // use the approved cover itself as the style anchor (in addition to being the character ref)
          // This is already handled via characterRefBase64 — no change needed here.
          // BUT: add a style establishment note to spread 1's prompt injection via spreadIndex check
          const isFirstSpread = (idx === 0);

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
            _cachedPhotoBase64: cachedPhotoBase64,
            _cachedPhotoMime: cachedPhotoMime,
            spreadIndex: idx,
            totalSpreads: entries.filter(e => e.type === 'spread').length,
            childAge: childDetails.age || childDetails.childAge,
            pageText: job.pageText || '',
            isSpread: job.isSpread || false,
            deadlineMs: 200000,
            abortSignal: bookContext.abortController.signal,
            prevIllustrationUrl,
            promptInjection: isFirstSpread
              ? `STYLE ESTABLISHMENT: This is the FIRST illustration of the book. The art style, color palette, lighting mood, and character rendering quality you establish HERE will be used as the style reference for ALL subsequent illustrations. Commit to a specific, rich, consistent style in this first image. `
              : '',
          });
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Illustration ${entryLabel} timed out after 3.5 minutes`)), 210000)
          );
          imageUrl = await Promise.race([illustrationPromise, timeoutPromise]);
          bookContext.touchActivity();
          const memUsage = process.memoryUsage();
          bookContext.log('info', `Illustration ${entryLabel} complete`, { ms: Date.now() - illStart, hasImage: !!imageUrl, heapMB: Math.round(memUsage.heapUsed / 1024 / 1024) });
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

  bookContext.log('info', 'All illustrations complete', { totalMs: Date.now() - stage5Start });
  console.log(`[server] Stage timing: illustrations=${Date.now() - stage5Start}ms (book ${bookId})`);
  return results;
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
  const bookContext = createBookContext(bookId);
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
    approvedTitle, approvedCoverUrl, childAnecdotes,
  } = sanitized;
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

  // Merge child anecdotes into customDetails so the planner can use them
  const anecdoteParts = [];
  if (childAnecdotes) {
    if (childAnecdotes.favorite_activities) anecdoteParts.push(`Favorite activities: ${childAnecdotes.favorite_activities}`);
    if (childAnecdotes.funny_thing) anecdoteParts.push(`Funny thing they do: ${childAnecdotes.funny_thing}`);
    if (childAnecdotes.favorite_food) anecdoteParts.push(`Favorite food: ${childAnecdotes.favorite_food}`);
    if (childAnecdotes.other_detail) anecdoteParts.push(`Other detail: ${childAnecdotes.other_detail}`);
  }
  const enrichedCustomDetails = anecdoteParts.length > 0
    ? [customDetails, ...anecdoteParts].filter(Boolean).join('\n')
    : customDetails;

  let format = bookFormat;
  const style = artStyle || 'cinematic_3d';
  const costTracker = new CostTracker();

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

  const bookContext = createBookContext(bookId);

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

      // Detect secondary characters (e.g. a parent) in the uploaded photo
      let detectedSecondaryCharacters = null;
      if (cachedPhotoBase64) {
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
      };

      // Append story seed to custom details so the planner has the full creative direction
      let plannerCustomDetails = enrichedCustomDetails || '';
      if (storySeed.storySeed) {
        plannerCustomDetails += `\n\nSTORY SEED (use as creative direction): ${storySeed.storySeed}`;
      }

      // Stage 2: V2 Story Planning (returns complete story with text + image prompts)
      let storyPlan;
      if (checkpoint?.storyPlan && Array.isArray(checkpoint.storyPlan.entries)) {
        // V2 checkpoint — resume
        storyPlan = checkpoint.storyPlan;
        const spreads = storyPlan.entries.filter(e => e.type === 'spread');
        bookContext.log('info', 'Resumed V2 story plan from checkpoint', { spreads: spreads.length, title: storyPlan.title });
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

        // ── Self-Critic + Auto-Rewrite pass ──
        // ── Combined critic: rhythm + arc + memorable line + language quality ──
        bookContext.checkAbort();
        bookContext.log('info', 'Starting combined critic (rhythm, arc, language)');
        if (progressCallbackUrl) {
          reportProgress(progressCallbackUrl, { bookId, stage: 'story_planning', progress: 0.22, message: 'Refining story quality...', logs: bookContext.logs });
        }
        try {
          const criticStart = Date.now();
          storyPlan = await combinedCritic(storyPlan, { apiKeys, costTracker, theme });
          bookContext.log('info', 'Combined critic complete', { ms: Date.now() - criticStart });
          bookContext.touchActivity();
          // Save polished content to DB
          if (progressCallbackUrl) {
            const polishedContent = { title: storyPlan.title, entries: storyPlan.entries.map(e => ({ type: e.type, spread: e.spread, left: e.left, right: e.right, title: e.title, text: e.text })) };
            reportProgressForce(progressCallbackUrl, { bookId, stage: 'story_planning', storyContent: polishedContent, logs: bookContext.logs }).catch(() => {});
          }
          await saveCheckpoint(bookId, { bookId, completedStage: 'story_final_polish', storyPlan, timestamp: new Date().toISOString(), accumulatedCosts: costTracker.getSummary() });
        } catch (criticErr) {
          bookContext.log('warn', `Combined critic failed — using original text: ${criticErr.message}`);
        }
      }

      // V2: Text is already in the story plan — no separate text generation needed.

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

          // Use 256px cover for vision analysis (needs detail for style extraction)
          const coverForVision = await sharp(coverBuf)
            .resize(256, 256, { fit: 'cover' })
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

          // Extract character appearance + art style from cover using Gemini vision (256px)
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
                    { text: `Analyze this children's book cover image and respond with exactly three labeled sections.

CHARACTER:
Describe the MAIN child character in this exact format:
HAIR: [exact color, style, length, texture, and any accessories]
EYES: [color]
SKIN: [tone description]
BUILD: [approximate age/size cues visible]
NOTABLE: [any distinguishing features]

If you cannot determine a field from the image, write "not visible".

ADDITIONAL_CHARACTERS:
List any OTHER characters visible on the cover besides the main child. For each one write:
- [relationship if apparent, e.g. grandmother/elderly woman/adult man]: [brief appearance description — hair, skin, clothing, distinguishing features]. If no other characters are present, write: NONE.

STYLE:
Describe the exact art style: medium (watercolor/digital/gouache/etc), color palette, line quality, texture, lighting, mood, and any distinctive techniques.

You MUST start the sections with CHARACTER:, ADDITIONAL_CHARACTERS:, and STYLE: exactly.` },
                    { inline_data: { mime_type: 'image/jpeg', data: coverForVisionBase64 } },
                  ]}],
                  generationConfig: { maxOutputTokens: 1000, temperature: 0.2 },
                }),
                signal: bookContext.abortController.signal,
              }
            );
            if (visionResp.ok) {
              const visionData = await visionResp.json();
              const extractedDesc = visionData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
              if (extractedDesc && extractedDesc.length > 20) {
                // Parse CHARACTER, ADDITIONAL_CHARACTERS, and STYLE sections
                const charMatch = extractedDesc.match(/CHARACTER[:\s]+([\s\S]*?)(?=\nADDITIONAL_CHARACTERS[:\s]|\nSTYLE[:\s]|$)/i);
                const addlMatch = extractedDesc.match(/ADDITIONAL_CHARACTERS[:\s]+([\s\S]*?)(?=\nSTYLE[:\s]|$)/i);
                const styleMatch = extractedDesc.match(/STYLE[:\s]+([\s\S]*?)$/i);
                if (charMatch?.[1]?.trim()) {
                  storyPlan.characterDescription = charMatch[1].trim();
                  bookContext.log('info', 'Character appearance extracted from cover', { description: charMatch[1].trim().slice(0, 100) });
                } else {
                  storyPlan.characterDescription = extractedDesc;
                  bookContext.log('info', 'Character appearance extracted (unstructured)', { description: extractedDesc.slice(0, 100) });
                }
                // Store additional cover characters (Grammy, siblings, etc.) for illustration allowlist
                const addlRaw = addlMatch?.[1]?.trim();
                if (addlRaw && addlRaw.toUpperCase() !== 'NONE' && addlRaw.length > 4) {
                  storyPlan.additionalCoverCharacters = addlRaw;
                  bookContext.log('info', 'Additional cover characters detected', { characters: addlRaw.slice(0, 150) });
                } else {
                  storyPlan.additionalCoverCharacters = null;
                }
                if (styleMatch?.[1]?.trim()) {
                  storyPlan.coverArtStyle = styleMatch[1].trim();
                  bookContext.log('info', 'Cover art style extracted', { style: styleMatch[1].trim().slice(0, 150) });
                } else {
                  bookContext.log('info', 'Cover art style not extracted — using cinematic_3d default');
                }
              }
            }

            // Dedicated character anchor extraction — explicit ethnicity, eye shape, skin tone
            // Retries up to 4 times with rotating API keys until a valid anchor is extracted
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
                        { text: `Look at the main child character in this image. Answer these questions about their physical appearance with SPECIFIC, PRECISE answers — no vague descriptions.

ETHNICITY: What is the child's ethnicity or racial appearance? (e.g. East Asian, South Asian, Black/African, Hispanic/Latino, White/Caucasian, Middle Eastern, Mixed/Biracial — be specific)
SKIN_TONE: Describe the exact skin tone in 3-5 words (e.g. "light golden beige", "deep warm brown", "fair with pink undertones")
EYE_SHAPE: Describe the eye shape specifically (e.g. "monolid", "almond-shaped with epicanthal fold", "large round", "hooded almond", "wide set round")
EYE_COLOR: What color are the eyes?
HAIR_COLOR: Exact hair color
HAIR_TEXTURE: Straight / wavy / curly / coily / tightly coiled
HAIR_LENGTH: Short / medium / long / very long

Format your answer with each label on its own line followed by a colon and the answer. Be specific and concrete — these will be used to ensure illustration consistency.` },
                        { inline_data: { mime_type: 'image/jpeg', data: coverForVisionBase64 } },
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
                storyPlan.characterAnchor = anchorText;
                bookContext.log('info', 'Character anchor extracted', { attempt: anchorAttempt, anchor: anchorText.slice(0, 200) });
                // Persist to DB immediately
                if (progressCallbackUrl) {
                  reportProgressForce(progressCallbackUrl, {
                    bookId,
                    stage: 'cover_analysis',
                    storyContent: {
                      title: storyPlan.title,
                      entries: storyPlan.entries.map(e => ({ type: e.type, spread: e.spread, left: e.left, right: e.right })),
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
          } catch (visionErr) {
            bookContext.log('warn', 'Failed to extract character appearance from cover', { error: visionErr.message });
          }
        } catch (dlErr) {
          bookContext.log('warn', 'Failed to download approved cover for reference, using original photo', { error: dlErr.message });
        }
      }

      bookContext.log('info', 'Character reference ready, starting illustrations', { refBytes: characterRefBase64?.length || 0, ms: Date.now() - stage6Start });

      // Birthday theme: ensure spread 13 illustration prompt shows cake/candles
      if (theme === 'birthday') {
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

      // Stage 4: Generate illustrations (V2 — text overlaid by layout engine, not embedded in images)
      bookContext.checkAbort();
      bookContext.log('info', 'Starting V2 illustration generation');
      if (progressCallbackUrl) {
        reportProgress(progressCallbackUrl, { bookId, stage: 'illustration', progress: 0.40, message: 'Generating illustrations...', logs: bookContext.logs });
      }

      const entriesWithIllustrations = await generateAllIllustrations(storyPlan.entries, storyPlan, childDetails, characterRef, style, {
        apiKeys, costTracker, bookId, bookContext, progressCallbackUrl,
        resolvedChildPhotoUrl,
        cachedPhotoBase64: characterRefBase64,
        cachedPhotoMime: characterRefMime,
        existingIllustrations: checkpoint?.illustrationResults || [],
        checkpointData: { bookId, storyPlan },
        detectedSecondaryCharacters: detectedSecondaryCharacters || null,
        characterAnchor: storyPlan.characterAnchor || null,
      });

      bookContext.log('info', 'All illustrations complete', { entries: entriesWithIllustrations.length });

      // Count illustration failures for spreads
      const spreadEntries = entriesWithIllustrations.filter(e => e.type === 'spread');
      const illustrationFailures = spreadEntries.filter(e => !e.spreadIllustrationUrl && !e.leftIllustrationUrl).length;
      if (illustrationFailures > 0) {
        bookContext.log('warn', `${illustrationFailures}/${spreadEntries.length} spread illustrations failed`);
        bookWarnings.push(`${illustrationFailures} of ${spreadEntries.length} illustrations failed`);
      }

      // Note: old illustrations from previous runs are NOT deleted here.
      // They have unique timestamp-based filenames and don't collide with new ones.
      // Deleting them concurrently with PDF assembly caused 404 errors.

      // Stage 5: Assemble PDF
      const stage7Start = Date.now();
      bookContext.checkAbort();
      bookContext.log('info', 'Starting V2 PDF assembly');
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

      bookContext.log('info', 'Downloading illustration buffers for PDF');
      const entriesWithBuffers = await Promise.all(
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

      const bookTitle = approvedTitle || storyPlan?.title || 'My Story';

      // ── Upsell covers: generate 4 styles BEFORE interior PDF so they can be baked in ──
      let upsellCovers = [];
      if (preGeneratedCoverBuffer) {
        try {
          bookContext.log('info', 'Generating upsell covers (4 styles)...');
          // Race against a 4-minute timeout. The upsell promise is always caught so
          // it never becomes an unhandled rejection even if it outlives the timeout.
          const upsellCostTracker = new CostTracker();
          const upsellPromise = generateUpsellCovers(bookId, childDetails, preGeneratedCoverBuffer, bookTitle, {
            apiKeys, costTracker: upsellCostTracker,
          }).catch(e => {
            console.warn(`[server] Upsell covers background error: ${e.message}`);
            return [];
          });
          const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 4 * 60 * 1000));
          const result = await Promise.race([upsellPromise, timeoutPromise]);
          // Merge upsell costs into main tracker regardless of outcome
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
          // Insert before closing_page, or append
          const closingIdx = entriesWithBuffers.findIndex(e => e.type === 'closing_page');
          if (closingIdx >= 0) {
            entriesWithBuffers.splice(closingIdx, 0, upsellEntry);
          } else {
            entriesWithBuffers.push(upsellEntry);
          }
          bookContext.log('info', `Upsell spread injected into interior PDF (${validUpsell.length} covers)`);
        }
      }

      // Pass validUpsell (with coverBuffer) to assemblePdf, not the raw upsellCovers
      const upsellCoversWithBuffers = entriesWithBuffers.find(e => e.type === 'upsell_spread')?.upsellCovers || [];
      const interiorPdf = await assemblePdf(entriesWithBuffers, format, {
        title: bookTitle,
        childName: childDetails.name,
        dedication,
        bookFrom,
        year: new Date().getFullYear(),
        bookId,
        upsellCovers: upsellCoversWithBuffers,
        minPages: emotionalTierInfo ? emotionalTierInfo.minPages : 32,
      });
      bookContext.touchActivity();
      bookContext.log('info', 'Interior PDF assembled', { entries: entriesWithBuffers.length, ms: Date.now() - stage7Start });

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
        // V2: count pages from entries (blank=1, title/dedication=1, spread=2)
        let pageCount = 0;
        for (const entry of entriesWithBuffers) {
          if (entry.type === 'spread') pageCount += 2;
          else pageCount += 1;
        }
        pageCount = Math.max(32, pageCount % 2 === 0 ? pageCount : pageCount + 1);
        // Build synopsis from story plan for back cover
        const synopsis = storyPlan.synopsis
          || (storyPlan.entries || []).filter(e => e.type === 'spread').slice(0, 2).map(e => [e.left?.text, e.right?.text].filter(Boolean).join(' ')).join(' ')
          || `A personalized bedtime story for ${childDetails.name}`;

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

      const previewImageUrls = entriesWithIllustrations
        .filter(e => e.spreadIllustrationUrl || e.illustrationUrl || e.leftIllustrationUrl)
        .map(e => e.spreadIllustrationUrl || e.illustrationUrl || e.leftIllustrationUrl);

      // Send upsell cover metadata to standalone DB (already generated above)
      if (upsellCovers.length > 0 && progressCallbackUrl) {
        reportProgressForce(progressCallbackUrl, { bookId, upsellCovers, logs: bookContext.logs }).catch(() => {});
      }

      const totalMs = Date.now() - bookStartTime;
      const costSummary = costTracker.getSummary();
      bookContext.log('info', 'Book complete', { totalMs, entries: entriesWithIllustrations.length, cost: `$${costSummary.totalCost.toFixed(4)}`, warnings: bookWarnings.length });

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
                storyContent: {
                  title: bookTitle,
                  entries: entriesWithIllustrations.map(e => ({ type: e.type, spread: e.spread, left: e.left, right: e.right, hasImage: !!(e.spreadIllustrationUrl || e.illustrationUrl) })),
                  characterDescription: storyPlan.characterDescription || null,
                  characterOutfit: storyPlan.characterOutfit || null,
                  characterAnchor: storyPlan.characterAnchor || null,
                  additionalCoverCharacters: storyPlan.additionalCoverCharacters || null,
                },
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
          storyContent: {
            title: bookTitle,
            entries: entriesWithIllustrations.map(e => ({ type: e.type, spread: e.spread, left: e.left, right: e.right, hasImage: !!(e.spreadIllustrationUrl || e.illustrationUrl) })),
            characterDescription: storyPlan.characterDescription || null,
            characterOutfit: storyPlan.characterOutfit || null,
            characterAnchor: storyPlan.characterAnchor || null,
            additionalCoverCharacters: storyPlan.additionalCoverCharacters || null,
          },
          costs: costSummary,
          emotionalCategory: emotionalCategory || null,
          warnings: bookWarnings.length > 0 ? bookWarnings : undefined,
          logs: bookContext.logs,
        });
      }

      // Clear checkpoint on successful completion
      await clearCheckpoint(bookId);

      console.log(`[server] Book ${bookId} complete: ${spreadEntries.length} spreads, cost: $${costSummary.totalCost.toFixed(4)}`);
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
    coverArtStyle, childName, childPhotoUrl, cachedPhotoBase64, prevIllustrationUrl, prevIllustrationUrls, fontStyle, additionalCoverCharacters } = req.body;

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

  try {
    // Generate the illustration
    const result = await generateIllustration(spreadImagePrompt, null, style, {
      costTracker,
      bookId,
      childName,
      childPhotoUrl,
      spreadIndex,
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

// ── POST /finalize-book ──
// Assemble all spreads into final PDF
app.post('/finalize-book', authenticate, async (req, res) => {
  const { valid, errors } = validateFinalizeBookRequest(req.body);
  if (!valid) {
    return res.status(400).json({ success: false, errors });
  }

  const { bookId, title, spreads, coverData, bookFormat, childName, bookFrom, dedication, upsellCovers, apiKeys } = req.body;

  console.log(`[server] /finalize-book: bookId=${bookId}, spreads=${spreads.length}`);
  const bookContext = createBookContext(bookId);

  try {
    // Download all spread images
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

    // Assemble final PDF
    const pdfBuffer = await assemblePdf(spreadsWithBuffers, bookFormat || 'picture_book', {
      title: title || 'My Story',
      childName: childName || '',
      bookFrom: bookFrom || '',
      dedication: dedication || '',
      year: new Date().getFullYear(),
      bookId,
      upsellCovers: resolvedUpsellCovers,
    });
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
