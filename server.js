require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const pLimit = require('p-limit');
const { v4: uuidv4 } = require('uuid');

const { planStory } = require('./services/storyPlanner');
const { generateSpreadText } = require('./services/textGenerator');
const { generateIllustration } = require('./services/illustrationGenerator');
const { assemblePdf } = require('./services/layoutEngine');
const { generateCover } = require('./services/coverGenerator');
const { uploadBuffer, getSignedUrl, downloadBuffer, deletePrefix } = require('./services/gcsStorage');
const { reportProgress, reportComplete, reportError } = require('./services/progressReporter');
const { CostTracker } = require('./services/costTracker');
const { validateGenerateBookRequest, validateGenerateSpreadRequest, validateFinalizeBookRequest } = require('./services/validation');
const { withRetry } = require('./services/retry');

const app = express();

// ── Checkpoint Helpers ──
async function saveCheckpoint(bookId, data) {
  const path = `children-jobs/${bookId}/checkpoint.json`;
  const buf = Buffer.from(JSON.stringify(data));
  await uploadBuffer(buf, path, 'application/json');
  console.log(`[checkpoint] Saved checkpoint for ${bookId} at stage: ${data.completedStage}`);
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
  app.use('/generate-book', generationLimiter);
  app.use('/generate-spread', generationLimiter);
  app.use('/finalize-book', generationLimiter);
}

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY;
const ABSOLUTE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour max per book

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
  };
  activeBooks.set(bookId, context);
  return context;
}

function removeBookContext(bookId) {
  activeBooks.delete(bookId);
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
    console.error('[watchdog] No active books for 10 minutes - exiting');
    process.exit(1);
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

/**
 * Generate text for all spreads (batched, groups of 4).
 * Returns array of { ...spread, text } in order.
 */
async function generateAllText(storyPlan, childDetails, format, opts) {
  const { apiKeys, costTracker, bookId, bookContext, progressCallbackUrl } = opts;
  const stage4Start = Date.now();
  const spreadsWithText = [];
  const BATCH_SIZE = 4;

  for (let batchStart = 0; batchStart < storyPlan.spreads.length; batchStart += BATCH_SIZE) {
    const batchStartTime = Date.now();
    const batch = storyPlan.spreads.slice(batchStart, batchStart + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(spreadPlan => {
      const storyContext = {
        title: storyPlan.title,
        previousSpreads: spreadsWithText.map(s => s.text),
        totalSpreads: storyPlan.spreads.length,
      };
      return generateSpreadText(spreadPlan, childDetails, format, storyContext, {
        apiKeys,
        costTracker,
      });
    }));

    batch.forEach((spreadPlan, i) => {
      const wordCount = batchResults[i].split(/\s+/).filter(Boolean).length;
      bookContext.log('info', `Text for spread ${spreadPlan.spreadNumber} generated`, { words: wordCount });
      spreadsWithText.push({ ...spreadPlan, text: batchResults[i] });
    });
    bookContext.touchActivity();
    bookContext.log('info', `Text batch complete (spreads ${batchStart + 1}-${Math.min(batchStart + BATCH_SIZE, storyPlan.spreads.length)})`, { ms: Date.now() - batchStartTime });

    if (progressCallbackUrl) {
      const progress = 0.20 + (0.20 * Math.min(batchStart + BATCH_SIZE, storyPlan.spreads.length) / storyPlan.spreads.length);
      reportProgress(progressCallbackUrl, {
        bookId,
        stage: 'text_generation',
        progress,
        message: `Writing spreads ${batchStart + 1}-${Math.min(batchStart + BATCH_SIZE, storyPlan.spreads.length)} of ${storyPlan.spreads.length}...`,
        logs: bookContext.logs,
      });
    }
  }

  bookContext.log('info', 'All text generation complete', { totalSpreads: spreadsWithText.length, ms: Date.now() - stage4Start });
  console.log(`[server] Stage timing: text=${Date.now() - stage4Start}ms (book ${bookId})`);
  return spreadsWithText;
}

/**
 * Generate illustrations for all spreads (8 concurrent).
 * Returns array of { ...spread, imageUrl } in order.
 */
async function generateAllIllustrations(storyPlan, childDetails, characterRef, style, opts) {
  const {
    apiKeys, costTracker, bookId, bookContext, progressCallbackUrl,
    resolvedChildPhotoUrl, cachedPhotoBase64, cachedPhotoMime,
    existingIllustrations, checkpointData,
  } = opts;

  bookContext.log('info', 'Starting illustration generation', { totalIllustrations: storyPlan.spreads.length, resumed: (existingIllustrations || []).filter(Boolean).length });

  const stage5Start = Date.now();
  const spreadsWithImages = new Array(storyPlan.spreads.length);
  let completedCount = 0;

  // Pre-fill from checkpoint
  if (existingIllustrations) {
    for (let i = 0; i < existingIllustrations.length; i++) {
      if (existingIllustrations[i]?.imageUrl) {
        spreadsWithImages[i] = existingIllustrations[i];
        completedCount++;
        bookContext.log('info', `Illustration ${i + 1} resumed from checkpoint`);
      }
    }
  }

  const illustrationLimit = pLimit(2); // Gemini image API throttles at higher concurrency

  const illustrationPromises = storyPlan.spreads.map((spread, i) =>
    illustrationLimit(async () => {
      // Skip if already resumed from checkpoint
      if (spreadsWithImages[i]?.imageUrl) {
        return;
      }

      // Only skip illustration for explicitly text-only spreads
      if (spread.layoutType === 'NO_TEXT') {
        spreadsWithImages[i] = { ...spread, imageUrl: null };
        completedCount++;
        return;
      }

      let imageUrl = null;
      const illStart = Date.now();
      try {
        const sceneDesc = spread.illustrationDescription || spread.text;
        bookContext.log('info', `Illustration ${i + 1}/${storyPlan.spreads.length} starting`);
        // Per-illustration timeout (3 min) to prevent one hung illustration from blocking the rest
        const illustrationPromise = generateIllustration(sceneDesc, characterRef, style, {
          apiKeys,
          costTracker,
          bookId,
          childName: childDetails.name,
          childPhotoUrl: resolvedChildPhotoUrl,
          _cachedPhotoBase64: cachedPhotoBase64,
          _cachedPhotoMime: cachedPhotoMime,
          spreadIndex: i,
          pageText: spread.text,
        });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Illustration ${i + 1} timed out after 5 minutes`)), 300000)
        );
        imageUrl = await Promise.race([illustrationPromise, timeoutPromise]);
        bookContext.touchActivity();
        bookContext.log('info', `Illustration ${i + 1}/${storyPlan.spreads.length} complete`, { ms: Date.now() - illStart, hasImage: !!imageUrl });
      } catch (illustrationErr) {
        bookContext.log('error', `Illustration ${i + 1}/${storyPlan.spreads.length} failed`, { error: illustrationErr.message, ms: Date.now() - illStart });
        console.error(`[server] Illustration ${i + 1}/${storyPlan.spreads.length} failed for book ${bookId} (continuing): ${illustrationErr.message}`);
      }

      spreadsWithImages[i] = { ...spread, imageUrl };
      completedCount++;

      // Save partial checkpoint after each illustration completes
      if (checkpointData) {
        await saveCheckpoint(bookId, {
          ...checkpointData,
          completedStage: 'illustrations_partial',
          illustrationResults: spreadsWithImages.filter(Boolean),
          timestamp: new Date().toISOString(),
        }).catch(e => console.warn('[checkpoint] Save failed:', e.message));
      }

      if (progressCallbackUrl) {
        const progress = 0.40 + (0.35 * completedCount / storyPlan.spreads.length);
        reportProgress(progressCallbackUrl, {
          bookId,
          stage: 'illustration',
          progress,
          message: `Generating illustration ${completedCount} of ${storyPlan.spreads.length}...`,
          previewUrls: spreadsWithImages.filter(s => s && s.imageUrl).map(s => s.imageUrl).slice(-3),
          logs: bookContext.logs,
        });
      }
    })
  );

  await Promise.all(illustrationPromises);

  bookContext.log('info', 'All illustrations complete', { totalMs: Date.now() - stage5Start });
  console.log(`[server] Stage timing: illustrations=${Date.now() - stage5Start}ms (book ${bookId})`);
  return spreadsWithImages;
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
    approvedTitle, approvedCoverUrl,
  } = sanitized;
  const apiKeys = req.body.apiKeys;

  const format = bookFormat;
  const style = artStyle;
  const costTracker = new CostTracker();

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

  (async () => {
    const bookWarnings = [];
    const bookStartTime = Date.now();
    bookContext.log('info', 'Book generation started', { childName, format, style, theme });
    const absoluteTimer = setTimeout(() => {
      bookContext.log('error', 'Absolute timeout reached — aborting', { timeoutMin: ABSOLUTE_TIMEOUT_MS / 60000 });
      console.error(`[server] Book ${bookId} hit absolute timeout (${ABSOLUTE_TIMEOUT_MS / 60000}min) — aborting`);
      bookContext.abortController.abort();
    }, ABSOLUTE_TIMEOUT_MS);

    try {
      // Load checkpoint for resume support
      const checkpoint = await loadCheckpoint(bookId);
      if (checkpoint) {
        bookContext.log('info', 'Checkpoint found — resuming from stage: ' + checkpoint.completedStage);
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
        try {
          const photoBuf = await downloadBuffer(childPhotoUrl);
          const mime = childPhotoUrl.includes('.png') ? 'image/png' : 'image/jpeg';
          cachedPhotoBase64 = photoBuf.toString('base64');
          cachedPhotoMime = mime;
          bookContext.log('info', 'Child photo cached for illustrations', { bytes: photoBuf.length });
          console.log(`[server] Cached child photo for book ${bookId} (${photoBuf.length} bytes, ${mime})`);
        } catch (photoErr) {
          bookContext.log('warn', 'Failed to cache child photo', { error: photoErr.message });
          console.warn(`[server] Failed to cache child photo for book ${bookId}: ${photoErr.message}`);
        }
      }
      bookContext.touchActivity();

      const resolvedChildPhotoUrl = childPhotoUrl;

      const stage1Ms = Date.now() - stage1Start;
      bookContext.log('info', 'Photo cache complete', { ms: stage1Ms, hasPhotoCache: !!cachedPhotoBase64 });

      console.log(`[server] Stage timing: photo_cache=${stage1Ms}ms (book ${bookId})`);

      // Character reference generation skipped — Gemini illustrations use child photo directly
      const characterRef = null;

      // Stage 3: Plan story spreads
      let storyPlan;
      if (checkpoint?.storyPlan) {
        storyPlan = checkpoint.storyPlan;
        bookContext.log('info', 'Resumed story plan from checkpoint', { spreads: storyPlan.spreads.length, title: storyPlan.title });
      } else {
        bookContext.log('info', 'Starting story planning', { theme: theme || 'adventure' });
        if (progressCallbackUrl) {
          reportProgress(progressCallbackUrl, { bookId, stage: 'story_planning', progress: 0.15, message: 'Planning story...', logs: bookContext.logs });
        }

        const stage3Start = Date.now();
        storyPlan = await planStory(childDetails, theme || 'adventure', format, customDetails || '', {
          apiKeys,
          costTracker,
          approvedTitle,
        });
        bookContext.touchActivity();
        const stage3Ms = Date.now() - stage3Start;
        bookContext.log('info', 'Story planned', { spreads: storyPlan.spreads.length, title: storyPlan.title, ms: stage3Ms });
        console.log(`[server] Stage timing: story=${stage3Ms}ms (book ${bookId})`);

        await saveCheckpoint(bookId, { bookId, completedStage: 'story_planning', storyPlan, timestamp: new Date().toISOString() });
      }

      // Stage 4: Generate text first (illustrations need the text to embed it)
      let spreadsWithText;
      if (checkpoint?.spreadsWithText) {
        spreadsWithText = checkpoint.spreadsWithText;
        bookContext.log('info', 'Resumed text from checkpoint', { spreads: spreadsWithText.length });
      } else {
        bookContext.log('info', 'Starting text generation');
        if (progressCallbackUrl) {
          reportProgress(progressCallbackUrl, { bookId, stage: 'text_generation', progress: 0.20, message: 'Writing story text...', logs: bookContext.logs });
        }

        const textResults = await generateAllText(storyPlan, childDetails, format, { apiKeys, costTracker, bookId, bookContext, progressCallbackUrl });

        // Attach generated text to each spread for illustration prompts
        spreadsWithText = storyPlan.spreads.map((spread, i) => ({
          ...spread,
          text: textResults[i]?.text || spread.text || '',
        }));

        await saveCheckpoint(bookId, { bookId, completedStage: 'text_generation', storyPlan, spreadsWithText, timestamp: new Date().toISOString() });
      }

      // Stage 5: Generate illustrations WITH text embedded in the images
      bookContext.log('info', 'Starting illustration generation with embedded text');
      if (progressCallbackUrl) {
        reportProgress(progressCallbackUrl, { bookId, stage: 'illustration', progress: 0.40, message: 'Generating illustrations with text...', logs: bookContext.logs });
      }

      const storyPlanWithText = { ...storyPlan, spreads: spreadsWithText };
      const illustrationResults = await generateAllIllustrations(storyPlanWithText, childDetails, characterRef, style, {
        apiKeys, costTracker, bookId, bookContext, progressCallbackUrl,
        resolvedChildPhotoUrl, cachedPhotoBase64, cachedPhotoMime,
        existingIllustrations: checkpoint?.illustrationResults || [],
        checkpointData: { bookId, storyPlan, spreadsWithText },
      });

      // Merge: each spread gets both .text and .imageUrl
      const mergedSpreads = spreadsWithText.map((spread, i) => ({
        ...spread,
        imageUrl: illustrationResults[i]?.imageUrl || null,
      }));

      bookContext.log('info', 'Text + illustrations complete', { spreads: mergedSpreads.length });
      console.log(`[server] Stage timing: text+illustrations(sequential) (book ${bookId})`);

      const illustrationFailures = illustrationResults.filter((r, i) => !r?.imageUrl && storyPlan.spreads[i]?.layoutType !== 'NO_TEXT').length;
      if (illustrationFailures > 0) {
        bookContext.log('warn', `${illustrationFailures}/${storyPlan.spreads.length} illustrations failed — using text-only spreads`);
        console.warn(`[server] Book ${bookId}: ${illustrationFailures}/${storyPlan.spreads.length} illustrations failed, continuing with text-only spreads`);
        bookWarnings.push(`${illustrationFailures} of ${storyPlan.spreads.length} illustrations failed`);
      }

      // Stage 6: Generate cover
      const stage6Start = Date.now();
      bookContext.log('info', approvedCoverUrl ? 'Using pre-approved cover' : 'Starting cover generation');
      if (progressCallbackUrl) {
        reportProgress(progressCallbackUrl, { bookId, stage: 'cover', progress: 0.80, message: 'Creating cover...', logs: bookContext.logs });
      }

      let preGeneratedCoverBuffer = null;
      if (approvedCoverUrl) {
        try {
          preGeneratedCoverBuffer = await withRetry(
            () => downloadBuffer(approvedCoverUrl),
            { maxRetries: 3, baseDelayMs: 1000, label: `download-approved-cover-${bookId}` }
          );
          bookContext.log('info', 'Approved cover downloaded', { bytes: preGeneratedCoverBuffer.length });
          console.log(`[server] Downloaded approved cover for book ${bookId} (${preGeneratedCoverBuffer.length} bytes)`);
        } catch (dlErr) {
          bookContext.log('warn', 'Failed to download approved cover — generating new', { error: dlErr.message });
          console.warn(`[server] Failed to download approved cover for book ${bookId}: ${dlErr.message} — generating new cover`);
        }
      }

      const coverData = await generateCover(storyPlan.title, childDetails, characterRef, format, {
        apiKeys,
        costTracker,
        bookId,
        preGeneratedCoverBuffer,
      });
      bookContext.touchActivity();
      bookContext.log('info', 'Cover complete', { ms: Date.now() - stage6Start });

      console.log(`[server] Stage timing: cover=${Date.now() - stage6Start}ms (book ${bookId})`);

      // Stage 7: Assemble PDF
      const stage7Start = Date.now();
      bookContext.log('info', 'Starting PDF assembly');
      if (progressCallbackUrl) {
        reportProgress(progressCallbackUrl, { bookId, stage: 'assembly', progress: 0.90, message: 'Assembling PDF...', logs: bookContext.logs });
      }

      // Download illustration URLs into buffers for PDF embedding (parallel)
      const spreadsWithBuffers = await Promise.all(
        mergedSpreads.map(async (spread) => {
          let illustrationBuffer = null;
          if (spread.imageUrl) {
            try {
              illustrationBuffer = await withRetry(
                () => downloadBuffer(spread.imageUrl),
                { maxRetries: 3, baseDelayMs: 1000, label: `download-spread-${spread.spreadNumber}` }
              );
            } catch (err) {
              bookContext.log('error', `Failed to download illustration for spread ${spread.spreadNumber}`, { error: err.message });
              console.error(`[server] Failed to download illustration for spread ${spread.spreadNumber} (book ${bookId}):`, err.message);
            }
          }
          return { ...spread, illustrationBuffer };
        })
      );

      const interiorPdf = await assemblePdf(spreadsWithBuffers, format, coverData, {
        title: storyPlan.title,
        childName: childDetails.name,
      });
      bookContext.touchActivity();
      const pdfPages = spreadsWithBuffers.length;
      bookContext.log('info', 'Interior PDF assembled', { pages: pdfPages, ms: Date.now() - stage7Start });

      console.log(`[server] Stage timing: pdf=${Date.now() - stage7Start}ms (book ${bookId})`);

      // Stage 8: Upload to GCS
      bookContext.log('info', 'Uploading PDFs to storage');
      const interiorPath = `children-jobs/${bookId}/interior.pdf`;
      const coverPath = `children-jobs/${bookId}/cover.pdf`;

      await uploadBuffer(interiorPdf, interiorPath, 'application/pdf');
      if (coverData.coverPdfBuffer) {
        await uploadBuffer(coverData.coverPdfBuffer, coverPath, 'application/pdf');
      }

      const interiorPdfUrl = await getSignedUrl(interiorPath, 30 * 24 * 60 * 60 * 1000);
      const coverPdfUrl = coverData.coverPdfBuffer
        ? await getSignedUrl(coverPath, 30 * 24 * 60 * 60 * 1000)
        : null;

      const previewImageUrls = mergedSpreads
        .filter(s => s.imageUrl)
        .slice(0, 5)
        .map(s => s.imageUrl);

      const totalMs = Date.now() - bookStartTime;
      const costSummary = costTracker.getSummary();
      bookContext.log('info', 'Book complete', { totalMs, spreads: mergedSpreads.length, cost: `$${costSummary.totalCost.toFixed(4)}`, warnings: bookWarnings.length });

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
                previewImageUrls,
                title: storyPlan.title,
                spreadCount: mergedSpreads.length,
                storyContent: { title: storyPlan.title, spreads: mergedSpreads.map(s => ({ spreadNumber: s.spreadNumber, text: s.text, illustrationDescription: s.illustrationDescription, layoutType: s.layoutType, hasImage: !!s.imageUrl })) },
                costs: costSummary,
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
        reportComplete(progressCallbackUrl, { bookId, interiorPdfUrl, coverPdfUrl, previewImageUrls, logs: bookContext.logs });
      }

      // Clear checkpoint on successful completion
      await clearCheckpoint(bookId);

      console.log(`[server] Book ${bookId} complete: ${mergedSpreads.length} spreads, cost: $${costSummary.totalCost.toFixed(4)}`);
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
      clearTimeout(absoluteTimer);
      removeBookContext(bookId);
    }
  })();
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
    const style = artStyle || 'watercolor';
    const sceneDesc = spreadPlan.illustrationDescription || text;
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

  const { bookId, title, spreads, coverData, bookFormat, childName, apiKeys } = req.body;

  console.log(`[server] /finalize-book: bookId=${bookId}, spreads=${spreads.length}`);
  const bookContext = createBookContext(bookId);

  try {
    // Download all spread images
    const spreadsWithBuffers = [];
    for (const spread of spreads) {
      let imageBuffer = null;
      if (spread.imageUrl) {
        imageBuffer = await downloadBuffer(spread.imageUrl);
      }
      spreadsWithBuffers.push({ ...spread, illustrationBuffer: imageBuffer });
      bookContext.touchActivity();
    }

    // Assemble final PDF
    const pdfBuffer = await assemblePdf(spreadsWithBuffers, bookFormat || 'picture_book', coverData || null, {
      title: title || 'My Story',
      childName: childName || '',
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
