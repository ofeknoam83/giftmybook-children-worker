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

process.on('SIGTERM', () => {
  console.warn('[PROCESS] Received SIGTERM — Cloud Run is shutting down this instance');
  // Allow 10s for cleanup
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

const { planStory } = require('./services/storyPlanner');
const { generateSpreadText } = require('./services/textGenerator');
const { generateIllustration } = require('./services/illustrationGenerator');
const { assemblePdf } = require('./services/layoutEngine');
const { generateCover } = require('./services/coverGenerator');
const { uploadBuffer, getSignedUrl, downloadBuffer, deletePrefix } = require('./services/gcsStorage');
const { reportProgress, reportComplete, reportError } = require('./services/progressReporter');
const { CostTracker } = require('./services/costTracker');
const { buildWriterBrief, buildV2Brief, buildChildContext, getAgeProfile, getAgeTier } = require('./prompts/writerBrief');
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
    existingIllustrations, checkpointData,
  } = opts;

  // Count how many illustrations we need
  const illustratableEntries = entries.map((entry, idx) => {
    if (entry.type === 'blank') return null;
    if (entry.type === 'title_page' && entry.image_prompt) return { idx, prompt: entry.image_prompt, field: 'illustrationUrl' };
    if (entry.type === 'dedication_page' && entry.image_prompt) return { idx, prompt: entry.image_prompt, field: 'illustrationUrl' };
    if (entry.type === 'spread') {
      // Primary: spread_image_prompt (one illustration for both pages)
      if (entry.spread_image_prompt) return { idx, prompt: entry.spread_image_prompt, field: 'spreadIllustrationUrl' };
      // Fallback: separate left/right image prompts
      const jobs = [];
      if (entry.left?.image_prompt) jobs.push({ idx, prompt: entry.left.image_prompt, field: 'leftIllustrationUrl' });
      if (entry.right?.image_prompt) jobs.push({ idx, prompt: entry.right.image_prompt, field: 'rightIllustrationUrl' });
      if (jobs.length) return jobs;
      return null;
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

      // Skip if already resumed from checkpoint
      if (results[idx]?.[field]) {
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
          const illustrationPromise = generateIllustration(prompt, characterRef, style, {
            apiKeys,
            costTracker,
            bookId,
            childName: childDetails.name,
            characterOutfit: outfit,
            characterDescription: storyPlan.characterDescription || '',
            recurringElement: storyPlan.recurringElement || '',
            keyObjects: storyPlan.keyObjects || '',
            childPhotoUrl: resolvedChildPhotoUrl,
            _cachedPhotoBase64: cachedPhotoBase64,
            _cachedPhotoMime: cachedPhotoMime,
            spreadIndex: idx,
            skipTextEmbed: true, // V2: text overlaid by layout engine
            deadlineMs: 450000,
            abortSignal: bookContext.abortController.signal,
          });
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Illustration ${entryLabel} timed out after 8 minutes`)), 480000)
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

  const generationWork = (async () => {
    const bookWarnings = [];
    const bookStartTime = Date.now();
    bookContext.log('info', 'Book generation started', { childName, format, style, theme });
    const absoluteTimer = setTimeout(() => {
      bookContext.log('error', 'Absolute timeout reached — aborting', { timeoutMin: ABSOLUTE_TIMEOUT_MS / 60000 });
      console.error(`[server] Book ${bookId} hit absolute timeout (${ABSOLUTE_TIMEOUT_MS / 60000}min) — aborting`);
      bookContext.abortController.abort();
    }, ABSOLUTE_TIMEOUT_MS);

    // Send heartbeat every 30s so standalone knows we're alive
    const heartbeatInterval = setInterval(() => {
      if (progressCallbackUrl) {
        reportProgress(progressCallbackUrl, {
          bookId,
          heartbeat: true,
          logs: bookContext.logs,
        }).catch(() => {}); // fire-and-forget, don't crash on failure
      }
    }, 30000);

    try {
      // If forceNew, wipe all GCS data and checkpoints for a truly fresh start
      const forceNew = req.body.forceNew === true;
      let checkpoint = null;
      if (forceNew) {
        bookContext.log('info', 'Full regeneration requested — clearing all checkpoints and GCS data');
        try {
          await deletePrefix(`children-jobs/${bookId}/`);
          bookContext.log('info', 'GCS data cleared for fresh start');
        } catch (e) {
          bookContext.log('warn', 'Failed to clear GCS data — continuing anyway', { error: e?.message || String(e), code: e?.code });
          // Non-fatal: continue with generation even if old data persists
        }
      } else {
        // Load checkpoint for resume support
        checkpoint = await loadCheckpoint(bookId);
      }
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
          const sharp = require('sharp');
          const photoBuf = await downloadBuffer(childPhotoUrl);
          // Resize photo to reduce payload size — 512px is enough for face reference
          const resizedBuf = await sharp(photoBuf)
            .resize(64, 64, { fit: 'cover' })
            .jpeg({ quality: 60 })
            .toBuffer();
          cachedPhotoBase64 = resizedBuf.toString('base64');
          cachedPhotoMime = 'image/jpeg';
          bookContext.log('info', 'Child photo cached (resized to 64px)', { originalBytes: photoBuf.length, resizedBytes: resizedBuf.length });
          console.log(`[server] Cached child photo for book ${bookId} (${photoBuf.length} -> ${resizedBuf.length} bytes)`);
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

      // ── V2 Variables ──
      const favorite_object = (childDetails.interests && childDetails.interests[0]) ? `a ${childDetails.interests[0]}` : 'a stuffed bear';
      const fear = 'the dark'; // default for bedtime books
      const setting = theme === 'adventure' ? 'an enchanted forest' :
                      theme === 'bedtime' ? 'a cozy bedroom' :
                      theme === 'birthday' ? 'a birthday party world' : 'a magical place';
      const dedication = `For ${childDetails.name || 'the child'}`;
      const v2Vars = { name: childDetails.name, age: childDetails.age || 5, favorite_object, fear, setting, dedication };

      // Stage 2: V2 Story Planning (returns complete story with text + image prompts)
      let storyPlan;
      if (checkpoint?.storyPlan && Array.isArray(checkpoint.storyPlan.entries)) {
        // V2 checkpoint — resume
        storyPlan = checkpoint.storyPlan;
        const spreads = storyPlan.entries.filter(e => e.type === 'spread');
        bookContext.log('info', 'Resumed V2 story plan from checkpoint', { spreads: spreads.length, title: storyPlan.title });
      } else {
        // Always start fresh for V2 (incompatible with old checkpoint format)
        bookContext.log('info', 'Starting V2 story planning', { theme: theme || 'adventure' });
        if (progressCallbackUrl) {
          reportProgress(progressCallbackUrl, { bookId, stage: 'story_planning', progress: 0.15, message: 'Planning story...', logs: bookContext.logs });
        }

        const stage3Start = Date.now();
        storyPlan = await planStory(childDetails, theme || 'adventure', format, customDetails || '', {
          apiKeys,
          costTracker,
          approvedTitle,
          v2Vars,
        });
        bookContext.touchActivity();
        const stage3Ms = Date.now() - stage3Start;
        const spreads = storyPlan.entries.filter(e => e.type === 'spread');
        bookContext.log('info', 'V2 story planned', { spreads: spreads.length, entries: storyPlan.entries.length, title: storyPlan.title, ms: stage3Ms });
        console.log(`[server] Stage timing: story=${stage3Ms}ms (book ${bookId})`);

        await saveCheckpoint(bookId, { bookId, completedStage: 'story_planning', storyPlan, timestamp: new Date().toISOString() });
      }

      // V2: Text is already in the story plan — no separate text generation needed.

      // Stage 3: Prepare cover + character reference
      const stage6Start = Date.now();
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
          let coverUrl = approvedCoverUrl;
          try { coverUrl = await ensureAccessibleUrl(approvedCoverUrl); } catch (e) { /* use original */ }
          const coverBuf = await withRetry(
            () => downloadBuffer(coverUrl),
            { maxRetries: 3, baseDelayMs: 1000, label: `download-cover-ref-${bookId}` }
          );
          preGeneratedCoverBuffer = coverBuf;
          const resizedCover = await sharp(coverBuf)
            .resize(64, 64, { fit: 'cover' })
            .jpeg({ quality: 60 })
            .toBuffer();
          characterRefBase64 = resizedCover.toString('base64');
          characterRefMime = 'image/jpeg';
          bookContext.log('info', 'Cover downloaded and resized for character reference', { originalBytes: coverBuf.length, refBytes: resizedCover.length, ms: Date.now() - stage6Start });

          // Extract detailed character appearance from the cover using Gemini vision
          try {
            const apiKey = process.env.GOOGLE_AI_STUDIO_KEY || process.env.GEMINI_API_KEY;
            const visionResp = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ role: 'user', parts: [
                    { text: `Describe the child character on this book cover in precise visual detail for an illustrator. Include:\n- Hair: color, style, length (e.g., "short curly brown hair")\n- Eyes: color, shape (e.g., "big round green eyes")\n- Skin tone (e.g., "light olive skin with rosy cheeks")\n- Age appearance (e.g., "looks about 5 years old")\n- Face shape and distinguishing features\n- Exact outfit and accessories\n\nBe very specific so another illustrator can draw the EXACT same character. Respond with ONLY the description, no introduction.` },
                    { inline_data: { mime_type: 'image/jpeg', data: characterRefBase64 } },
                  ]}],
                  generationConfig: { maxOutputTokens: 500, temperature: 0.2 },
                }),
                signal: bookContext.abortController.signal,
              }
            );
            if (visionResp.ok) {
              const visionData = await visionResp.json();
              const extractedDesc = visionData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
              if (extractedDesc && extractedDesc.length > 20) {
                storyPlan.characterDescription = extractedDesc;
                bookContext.log('info', 'Character appearance extracted from cover', { description: extractedDesc.slice(0, 100) });
              }
            }
          } catch (visionErr) {
            bookContext.log('warn', 'Failed to extract character appearance from cover', { error: visionErr.message });
          }
        } catch (dlErr) {
          bookContext.log('warn', 'Failed to download approved cover for reference, using original photo', { error: dlErr.message });
        }
      }

      bookContext.log('info', 'Character reference ready, starting illustrations', { refBytes: characterRefBase64?.length || 0, ms: Date.now() - stage6Start });

      // Stage 4: Generate illustrations (V2 — text overlaid by layout engine, not embedded in images)
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
      });

      bookContext.log('info', 'All illustrations complete', { entries: entriesWithIllustrations.length });

      // Count illustration failures for spreads
      const spreadEntries = entriesWithIllustrations.filter(e => e.type === 'spread');
      const illustrationFailures = spreadEntries.filter(e => e.spread_image_prompt && !e.spreadIllustrationUrl && !e.leftIllustrationUrl).length;
      if (illustrationFailures > 0) {
        bookContext.log('warn', `${illustrationFailures}/${spreadEntries.length} spread illustrations failed`);
        bookWarnings.push(`${illustrationFailures} of ${spreadEntries.length} illustrations failed`);
      }

      // Stage 5: Assemble PDF
      const stage7Start = Date.now();
      bookContext.log('info', 'Starting V2 PDF assembly');
      if (progressCallbackUrl) {
        reportProgress(progressCallbackUrl, { bookId, stage: 'assembly', progress: 0.90, message: 'Assembling PDF...', logs: bookContext.logs });
      }

      // Download illustration URLs into buffers for PDF embedding
      // Use pLimit(4) to avoid overwhelming GCS, with 60s timeout per download
      const downloadLimit = pLimit(4);
      async function downloadWithTimeout(url, label) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000); // 60s timeout
        try {
          const buf = await downloadBuffer(url);
          clearTimeout(timer);
          return buf;
        } catch (err) {
          clearTimeout(timer);
          throw err;
        }
      }

      bookContext.log('info', 'Downloading illustration buffers for PDF');
      const entriesWithBuffers = await Promise.all(
        entriesWithIllustrations.map((entry) => downloadLimit(async () => {
          const result = { ...entry };

          if (entry.spreadIllustrationUrl) {
            try {
              result.spreadIllustrationBuffer = await downloadWithTimeout(entry.spreadIllustrationUrl, `spread-${entry.spread || entry.type}`);
              bookContext.log('info', `Downloaded spread ${entry.spread || entry.type} illustration`);
            } catch (err) {
              bookContext.log('error', `Failed to download spread illustration`, { error: err.message, spread: entry.spread });
            }
          }

          if (entry.leftIllustrationUrl) {
            try {
              result.leftIllustrationBuffer = await downloadWithTimeout(entry.leftIllustrationUrl, `left-${entry.spread}`);
            } catch (err) {
              bookContext.log('error', `Failed to download left illustration`, { error: err.message });
            }
          }
          if (entry.rightIllustrationUrl) {
            try {
              result.rightIllustrationBuffer = await downloadWithTimeout(entry.rightIllustrationUrl, `right-${entry.spread}`);
            } catch (err) {
              bookContext.log('error', `Failed to download right illustration`, { error: err.message });
            }
          }

          if (entry.illustrationUrl) {
            try {
              result.illustrationBuffer = await downloadWithTimeout(entry.illustrationUrl, entry.type);
              bookContext.log('info', `Downloaded ${entry.type} illustration`);
            } catch (err) {
              bookContext.log('error', `Failed to download ${entry.type} illustration`, { error: err.message });
            }
          }

          return result;
        }))
      );
      bookContext.log('info', 'All illustration buffers downloaded');

      const bookTitle = approvedTitle || storyPlan?.title || 'My Story';
      const interiorPdf = await assemblePdf(entriesWithBuffers, format, {
        title: bookTitle,
        childName: childDetails.name,
        dedication,
      });
      bookContext.touchActivity();
      bookContext.log('info', 'Interior PDF assembled', { entries: entriesWithBuffers.length, ms: Date.now() - stage7Start });

      console.log(`[server] Stage timing: pdf=${Date.now() - stage7Start}ms (book ${bookId})`);

      // Stage 6: Upload interior PDF to GCS
      bookContext.log('info', 'Uploading interior PDF to storage');
      const interiorPath = `children-jobs/${bookId}/interior.pdf`;
      await uploadBuffer(interiorPdf, interiorPath, 'application/pdf');
      const interiorPdfUrl = await getSignedUrl(interiorPath, 30 * 24 * 60 * 60 * 1000);

      // Stage 7: Build cover PDF separately (after interior is done)
      let coverPdfUrl = null;
      const coverPath = `children-jobs/${bookId}/cover.pdf`;
      try {
        bookContext.log('info', 'Building cover PDF...');
        // Calculate actual interior page count for spine width
        // V2: count pages from entries (blank=1, title/dedication=1, spread=2)
        let pageCount = 0;
        for (const entry of entriesWithBuffers) {
          if (entry.type === 'spread') pageCount += 2;
          else pageCount += 1;
        }
        pageCount = Math.max(32, pageCount % 2 === 0 ? pageCount : pageCount + 1);
        const coverData = await generateCover(bookTitle, childDetails, characterRef, format, {
          apiKeys, costTracker, bookId, preGeneratedCoverBuffer, pageCount,
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
                previewImageUrls,
                title: bookTitle,
                spreadCount: spreadEntries.length,
                storyContent: { title: bookTitle, entries: entriesWithIllustrations.map(e => ({ type: e.type, spread: e.spread, left: e.left, right: e.right, hasImage: !!(e.spreadIllustrationUrl || e.illustrationUrl) })) },
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
      clearInterval(heartbeatInterval);
      clearTimeout(absoluteTimer);
      removeBookContext(bookId);
    }
  })();

  // Hard wall: kill generation after 45 minutes no matter what
  const hardTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Generation exceeded 45 minute hard limit')), 45 * 60 * 1000)
  );

  Promise.race([generationWork, hardTimeout]).catch(async (err) => {
    console.error(`[server] Book ${bookId} hit hard timeout: ${err.message}`);
    // Make sure we report the failure
    if (callbackUrl) {
      try {
        await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY || '' },
          body: JSON.stringify({ success: false, bookId, error: err.message }),
        });
      } catch (cbErr) {
        console.error(`[server] Failed to report hard timeout: ${cbErr.message}`);
      }
    }
    // Force abort all pending operations
    bookContext.abortController.abort();
    clearInterval(heartbeatInterval);
    clearTimeout(absoluteTimer);
    removeBookContext(bookId);
  });
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

// Diagnostic: test Gemini image generation latency
app.get('/test-gemini-image', async (req, res) => {
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
