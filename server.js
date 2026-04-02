require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');

const { planStory } = require('./services/storyPlanner');
const { generateSpreadText } = require('./services/textGenerator');
const { generateIllustration } = require('./services/illustrationGenerator');
const { extractFaceEmbedding, generateCharacterReference, verifyFaceConsistency, describeChildAppearance } = require('./services/faceEngine');
const { assemblePdf } = require('./services/layoutEngine');
const { generateCover } = require('./services/coverGenerator');
const { uploadBuffer, getSignedUrl, downloadBuffer, deletePrefix } = require('./services/gcsStorage');
const { enqueueSpreadJob, enqueueFinalizeJob } = require('./services/taskQueue');
const { reportProgress, reportComplete, reportError } = require('./services/progressReporter');
const { CostTracker } = require('./services/costTracker');

const app = express();

app.use(helmet());
app.use(cors());
app.use(compression());
app.use(morgan('short'));
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY;

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
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return res.status(403).json({ success: false, error: 'Forbidden: invalid API key' });
  }
  next();
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
// Full pipeline: story planning -> face embedding -> illustrations -> PDF assembly
app.post('/generate-book', authenticate, async (req, res) => {
  const {
    bookId, childName, childAge, childGender, childAppearance,
    childInterests, childPhotoUrls, bookFormat, theme, customDetails,
    artStyle, callbackUrl, progressCallbackUrl, apiKeys, childId,
  } = req.body;

  if (!bookId || !childName || !childPhotoUrls || childPhotoUrls.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: bookId, childName, childPhotoUrls',
    });
  }

  const format = bookFormat || 'picture_book';
  const style = artStyle || 'watercolor';
  const costTracker = new CostTracker();

  const childDetails = {
    name: childName,
    age: childAge || 5,
    gender: childGender || 'neutral',
    appearance: childAppearance || '',
    interests: childInterests || [],
    photoUrls: childPhotoUrls,
  };

  console.log(`[server] /generate-book: bookId=${bookId}, child=${childName}, format=${format}, style=${style}`);

  const bookContext = createBookContext(bookId);

  // Respond 202 immediately, process in background
  res.status(202).json({ success: true, status: 'processing', bookId });

  (async () => {
    try {
      // Stage 1: Extract face embedding + describe appearance (in parallel for speed)
      if (progressCallbackUrl) {
        reportProgress(progressCallbackUrl, { bookId, stage: 'face_extraction', progress: 0.05, message: 'Analyzing photos...' });
      }
      bookContext.touchActivity();

      const stage1Start = Date.now();
      let childAppearanceDesc = '';

      const [faceEmbedding, appearanceResult] = await Promise.all([
        extractFaceEmbedding(childDetails.photoUrls),
        describeChildAppearance(childDetails.photoUrls, childDetails, { childId }).catch(descErr => {
          console.warn(`[server] describeChildAppearance failed for book ${bookId}: ${descErr.message}`);
          return '';
        }),
      ]);
      childAppearanceDesc = appearanceResult;
      bookContext.touchActivity();

      // Store Gemini-generated description on childDetails for downstream use
      if (childAppearanceDesc) {
        childDetails.appearance = childAppearanceDesc;
      }

      console.log(`[server] Stage timing: face+description=${Date.now() - stage1Start}ms (book ${bookId})`);

      if (progressCallbackUrl) {
        reportProgress(progressCallbackUrl, { bookId, stage: 'character_reference', progress: 0.10, message: 'Creating character reference...' });
      }

      // Stage 2: Generate character reference sheet (text-only, NO kid photo to FLUX)
      const stage2Start = Date.now();
      let characterRef = null;
      try {
        characterRef = await generateCharacterReference(faceEmbedding, childAppearanceDesc || childDetails.appearance, style);
        bookContext.touchActivity();
      } catch (charRefErr) {
        console.warn(`[server] Character reference failed for book ${bookId} (continuing without face consistency): ${charRefErr.message}`);
        characterRef = null;
      }
      console.log(`[server] Stage timing: charRef=${Date.now() - stage2Start}ms (book ${bookId})`);

      if (progressCallbackUrl) {
        reportProgress(progressCallbackUrl, { bookId, stage: 'story_planning', progress: 0.15, message: 'Planning story...' });
      }

      // Stage 3: Plan story spreads
      const stage3Start = Date.now();
      const storyPlan = await planStory(childDetails, theme || 'adventure', format, customDetails || '', {
        apiKeys,
        costTracker,
      });
      bookContext.touchActivity();
      console.log(`[server] Stage timing: story=${Date.now() - stage3Start}ms (book ${bookId})`);

      if (progressCallbackUrl) {
        reportProgress(progressCallbackUrl, { bookId, stage: 'text_generation', progress: 0.20, message: 'Writing story text...' });
      }

      // Stage 4: Generate text for each spread
      const stage4Start = Date.now();
      const spreadsWithText = [];
      for (let i = 0; i < storyPlan.spreads.length; i++) {
        const spreadPlan = storyPlan.spreads[i];
        const storyContext = {
          title: storyPlan.title,
          previousSpreads: spreadsWithText.map(s => s.text),
          totalSpreads: storyPlan.spreads.length,
        };

        const text = await generateSpreadText(spreadPlan, childDetails, format, storyContext, {
          apiKeys,
          costTracker,
        });
        bookContext.touchActivity();

        spreadsWithText.push({ ...spreadPlan, text });

        if (progressCallbackUrl) {
          const progress = 0.20 + (0.20 * (i + 1) / storyPlan.spreads.length);
          reportProgress(progressCallbackUrl, {
            bookId,
            stage: 'text_generation',
            progress,
            message: `Writing spread ${i + 1} of ${storyPlan.spreads.length}...`,
          });
        }
      }

      console.log(`[server] Stage timing: text=${Date.now() - stage4Start}ms (book ${bookId})`);

      // Stage 5: Generate illustrations in parallel (3 at a time)
      const stage5Start = Date.now();
      const spreadsWithImages = new Array(spreadsWithText.length);
      let illustrationFailures = 0;
      let completedCount = 0;

      // Simple semaphore for concurrency limiting
      const CONCURRENCY = 3;
      let running = 0;
      const queue = [];

      function releaseSemaphore() {
        running--;
        if (queue.length > 0) {
          const next = queue.shift();
          running++;
          next();
        }
      }

      function acquireSemaphore() {
        return new Promise((resolve) => {
          if (running < CONCURRENCY) {
            running++;
            resolve();
          } else {
            queue.push(resolve);
          }
        });
      }

      const illustrationPromises = spreadsWithText.map((spread, i) => {
        return (async () => {
          if (spread.layoutType !== 'NO_TEXT' && !spread.illustrationDescription) {
            spreadsWithImages[i] = { ...spread, imageUrl: null };
            completedCount++;
            return;
          }

          await acquireSemaphore();
          let imageUrl = null;
          try {
            const sceneDesc = spread.illustrationDescription || spread.text;
            imageUrl = await generateIllustration(sceneDesc, characterRef, style, faceEmbedding, {
              apiKeys,
              costTracker,
              bookId,
              childAppearance: childAppearanceDesc,
              childName: childDetails.name,
            });
            bookContext.touchActivity();
          } catch (illustrationErr) {
            illustrationFailures++;
            console.error(`[server] Illustration ${i + 1}/${spreadsWithText.length} failed for book ${bookId} (continuing): ${illustrationErr.message}`);
          } finally {
            releaseSemaphore();
          }

          spreadsWithImages[i] = { ...spread, imageUrl };
          completedCount++;

          if (progressCallbackUrl) {
            const progress = 0.40 + (0.35 * completedCount / spreadsWithText.length);
            reportProgress(progressCallbackUrl, {
              bookId,
              stage: 'illustration',
              progress,
              message: `Generating illustration ${completedCount} of ${spreadsWithText.length}...`,
              previewUrls: spreadsWithImages.filter(s => s && s.imageUrl).map(s => s.imageUrl).slice(-3),
            });
          }
        })();
      });

      await Promise.all(illustrationPromises);

      console.log(`[server] Stage timing: illustrations=${Date.now() - stage5Start}ms (book ${bookId})`);

      if (illustrationFailures > 0) {
        console.warn(`[server] Book ${bookId}: ${illustrationFailures}/${spreadsWithText.length} illustrations failed, continuing with text-only spreads`);
      }

      // Stage 6: Generate cover
      const stage6Start = Date.now();
      if (progressCallbackUrl) {
        reportProgress(progressCallbackUrl, { bookId, stage: 'cover', progress: 0.80, message: 'Creating cover...' });
      }

      const coverData = await generateCover(storyPlan.title, childDetails, characterRef, format, {
        apiKeys,
        costTracker,
        bookId,
      });
      bookContext.touchActivity();

      console.log(`[server] Stage timing: cover=${Date.now() - stage6Start}ms (book ${bookId})`);

      // Stage 7: Assemble PDF
      const stage7Start = Date.now();
      if (progressCallbackUrl) {
        reportProgress(progressCallbackUrl, { bookId, stage: 'assembly', progress: 0.90, message: 'Assembling PDF...' });
      }

      // Download illustration URLs into buffers for PDF embedding
      const spreadsWithBuffers = [];
      for (const spread of spreadsWithImages) {
        let illustrationBuffer = null;
        if (spread.imageUrl) {
          try {
            illustrationBuffer = await downloadBuffer(spread.imageUrl);
          } catch (err) {
            console.error(`[server] Failed to download illustration for spread ${spread.spreadNumber} (book ${bookId}):`, err.message);
          }
        }
        spreadsWithBuffers.push({ ...spread, illustrationBuffer });
      }

      const interiorPdf = await assemblePdf(spreadsWithBuffers, format, coverData, {
        title: storyPlan.title,
        childName: childDetails.name,
      });
      bookContext.touchActivity();

      console.log(`[server] Stage timing: pdf=${Date.now() - stage7Start}ms (book ${bookId})`);

      // Stage 8: Upload to GCS
      const interiorPath = `children-jobs/${bookId}/interior.pdf`;
      const coverPath = `children-jobs/${bookId}/cover.pdf`;

      await uploadBuffer(interiorPdf, interiorPath, 'application/pdf');
      if (coverData.coverPdfBuffer) {
        await uploadBuffer(coverData.coverPdfBuffer, coverPath, 'application/pdf');
      }

      const interiorPdfUrl = await getSignedUrl(interiorPath, 7 * 24 * 60 * 60 * 1000);
      const coverPdfUrl = coverData.coverPdfBuffer
        ? await getSignedUrl(coverPath, 7 * 24 * 60 * 60 * 1000)
        : null;

      const previewImageUrls = spreadsWithImages
        .filter(s => s.imageUrl)
        .slice(0, 5)
        .map(s => s.imageUrl);

      // Report completion
      if (callbackUrl) {
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
              spreadCount: spreadsWithImages.length,
              costs: costTracker.getSummary(),
            }),
          });
        } catch (cbErr) {
          console.error(`[server] Completion callback failed:`, cbErr.message);
        }
      }

      if (progressCallbackUrl) {
        reportComplete(progressCallbackUrl, { bookId, interiorPdfUrl, coverPdfUrl, previewImageUrls });
      }

      console.log(`[server] Book ${bookId} complete: ${spreadsWithImages.length} spreads, cost: $${costTracker.getSummary().totalCost.toFixed(4)}`);
    } catch (err) {
      console.error(`[server] Book ${bookId} failed:`, err);

      if (callbackUrl) {
        try {
          const errorAbort = new AbortController();
          const errorTimeout = setTimeout(() => errorAbort.abort(), 10000);
          await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY || '' },
            body: JSON.stringify({ success: false, bookId, error: err.message }),
            signal: errorAbort.signal,
          });
          clearTimeout(errorTimeout);
        } catch (cbErr) {
          console.error(`[server] Error callback failed:`, cbErr.message);
        }
      }

      if (progressCallbackUrl) {
        reportError(progressCallbackUrl, { bookId, error: err.message });
      }
    } finally {
      removeBookContext(bookId);
    }
  })();
});

// ── POST /generate-spread ──
// Generate a single spread (for Cloud Tasks parallelism)
app.post('/generate-spread', authenticate, async (req, res) => {
  const {
    bookId, spreadPlan, characterRef, faceEmbedding,
    childDetails, bookFormat, storyContext, artStyle, apiKeys,
  } = req.body;

  if (!bookId || !spreadPlan || !characterRef) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: bookId, spreadPlan, characterRef',
    });
  }

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
    const imageUrl = await generateIllustration(sceneDesc, characterRef, style, faceEmbedding, {
      apiKeys,
      costTracker,
      bookId,
    });
    global.touchActivity(bookId);

    // Upload spread image to GCS
    const spreadPath = `children-jobs/${bookId}/spreads/spread-${spreadPlan.spreadNumber}.png`;
    const imageBuffer = await downloadBuffer(imageUrl);
    await uploadBuffer(imageBuffer, spreadPath, 'image/png');
    const spreadImageUrl = await getSignedUrl(spreadPath, 7 * 24 * 60 * 60 * 1000);

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
  const { bookId, title, spreads, coverData, bookFormat, childName, apiKeys } = req.body;

  if (!bookId || !spreads || spreads.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: bookId, spreads',
    });
  }

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
    const pdfUrl = await getSignedUrl(pdfPath, 7 * 24 * 60 * 60 * 1000);

    removeBookContext(bookId);
    res.json({ success: true, bookId, interiorPdfUrl: pdfUrl });
  } catch (err) {
    removeBookContext(bookId);
    console.error(`[server] Finalize failed for ${bookId}:`, err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`giftmybook-children-worker listening on port ${PORT}`);
});
