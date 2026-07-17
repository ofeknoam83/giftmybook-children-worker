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
    for (const mapKey of inFlight) {
      const ctx = activeBooks.get(mapKey);
      // Abort in-progress LLM calls so the generation fails fast
      ctx?.abortController?.abort();
      if (ctx?.progressCallbackUrl) {
        const { reportProgressForce } = require('./services/progressReporter');
        reportProgressForce(ctx.progressCallbackUrl, {
          bookId: ctx.bookId,
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
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const pLimit = require('p-limit');
const { v4: uuidv4 } = require('uuid');

const { brainstormStorySeed } = require('./services/storyPlanner');
const { EMOTIONAL_THEMES, getEmotionalTier } = require('./services/shared/emotionalTiers');
const { generateIllustration, downloadPhotoAsBase64, canonicalBookArtStyle } = require('./services/illustrationGenerator');
// generateIllustration is only used for chapter books and graphic novels.
// Picture book illustration is handled exclusively by services/illustrator (new minimal module).
// V3: compositeTextOnIllustration removed (V1 illustration pipeline)
const { assemblePdf } = require('./services/layoutEngine');
const { generateCover, generateUpsellCovers } = require('./services/coverGenerator');
const { computeCoverPdfMetadata } = require('./services/coverMetadata');
const { uploadBuffer, getSignedUrl, downloadBuffer, deletePrefix } = require('./services/gcsStorage');
const { reportProgress, reportProgressForce, reportComplete, reportError, clearThrottle } = require('./services/progressReporter');
const { CostTracker } = require('./services/costTracker');
const { buildWriterBrief, buildV2Brief, buildChildContext, getAgeProfile, getAgeTier } = require('./prompts/writerBrief');
const { validateGenerateBookRequest, validateGenerateSpreadRequest, validateFinalizeBookRequest } = require('./services/validation');
const { resolveBookPipeline } = require('./services/pipelineRouter');
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
 * Map key for coloring jobs — must NOT collide with parent /generate-book (same bookId).
 * Otherwise a race right after completion (callback before parent finally removes ctx)
 * returns 409 and the standalone marks the coloring add-on failed.
 * @param {string} bookId - parent children's book id
 * @returns {string}
 */
function coloringActiveJobKey(bookId) {
  return `coloring:${bookId}`;
}

/**
 * Create a tracking context for an active book generation.
 * @param {string} bookId - logical book id (used in callbacks / progress payloads)
 * @param {{ progressCallbackUrl?: string, callbackUrl?: string, mapKey?: string }} [opts]
 *   mapKey — if set, register under this key in activeBooks (e.g. coloringActiveJobKey(bookId))
 * @returns {{ bookId: string, lastActivity: number, abortController: AbortController, abortSignal: AbortSignal }}
 */
function createBookContext(bookId, opts = {}) {
  const abortController = new AbortController();
  const mapKey = opts.mapKey || bookId;
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
  activeBooks.set(mapKey, context);
  return context;
}

function removeBookContext(mapKey) {
  const ctx = activeBooks.get(mapKey);
  activeBooks.delete(mapKey);
  clearThrottle(mapKey);
  // Progress throttling keys use logical bookId (parent id), not e.g. coloring:${bookId}
  if (ctx?.bookId) clearThrottle(ctx.bookId);
}

// Per-book watchdog: abort books idle > 20 minutes.
// Was 15min historically; bumped to 20 because v2 picture-book runs can
// legitimately spend several minutes inside a single activity (page writer
// with revision rounds + critic + rhyme judge). The workflow engine emits
// a periodic heartbeat every 30s while an activity is in flight, so this
// threshold is now a true "something is broken, kill it" backstop, not a
// bound on individual activity duration.
setInterval(() => {
  const now = Date.now();
  for (const [bookId, ctx] of activeBooks) {
    const idle = now - ctx.lastActivity;
    if (idle > 1200000) {
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
// Timing-safe API key comparison; fail-closed if misconfigured.
function authenticate(req, res, next) {
  if (!API_KEY) {
    console.error('[auth] API_KEY not configured — rejecting request');
    return res.status(500).json({ success: false, error: 'Server misconfigured' });
  }
  const provided = req.headers['x-api-key'];
  if (typeof provided !== 'string' || provided.length !== API_KEY.length) {
    return res.status(403).json({ success: false, error: 'Forbidden: invalid API key' });
  }
  if (!crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(API_KEY))) {
    return res.status(403).json({ success: false, error: 'Forbidden: invalid API key' });
  }
  next();
}

// Legacy pipeline functions deleted: generateAllText (V2), the graphic-novel
// helpers (W12), and generateAllIllustrations (native-illustrator cutover —
// interiors render inside bookPipelineV3).

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

// /healthz — deep readiness check (PR AA-1, post silent-fallback incident).
// Returns 503 when LLM config is broken so Cloud Run/load balancers can
// refuse to promote a revision that would silently degrade to Gemini for
// every book request. Cheap to call — no LLM round-trip.
app.get('/healthz', (req, res) => {
  const { assertLlmConfig } = require('./services/llm');
  const llm = assertLlmConfig({ require: ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY'] });
  const status = llm.ok ? 200 : 503;
  res.status(status).json({
    status: llm.ok ? 'ready' : 'degraded',
    service: 'giftmybook-children-worker',
    version: versionInfo.version,
    writerVersion: versionInfo.writerVersion,
    activeBooks: activeBooks.size,
    llm: {
      ok: llm.ok,
      missing: llm.missing,
      gemini_fallback_available: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_STUDIO_KEY),
    },
  });
});

// ── POST /generate-style-variant — DEPRECATED ──
// Picture-book illustrations are now locked to the 3D Premium Pixar style, so
// there is no meaningful "variant" to produce. The endpoint returns 410 Gone
// so legacy admin clients surface a clear error instead of silently generating
// a misleading "gouache variant" that is actually Pixar.
app.post('/generate-style-variant', authenticate, (req, res) => {
  const { bookId, style } = req.body || {};
  console.warn(`[server] /generate-style-variant rejected (deprecated) — book=${bookId} style=${style}`);
  return res.status(410).json({
    success: false,
    error: 'Style variants are no longer supported — picture books are locked to the 3D Premium Pixar style. Use /regenerate-illustration to re-render individual spreads.',
  });
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

  // Explicit pipeline selection ('v2' | 'v3'), sent by the admin test path.
  // Resolved against env kill-switches and the checkpoint in pipelineRouter.
  // W12: v3 is the only pipeline — v1/v2 were deleted. An explicit 'v2'
  // request now fails loudly instead of silently running a different engine.
  let requestedPipelineVersion = null;
  if (req.body.pipelineVersion !== undefined && req.body.pipelineVersion !== null && req.body.pipelineVersion !== '') {
    const v = String(req.body.pipelineVersion).toLowerCase().trim();
    if (v !== 'v3') {
      return res.status(400).json({ success: false, error: `Unsupported pipelineVersion '${req.body.pipelineVersion}' — v3 is the only pipeline (legacy pipelines were deleted)` });
    }
    requestedPipelineVersion = v;
  }

  // The native illustrator is the only illustrator (2026-07-15 cutover;
  // legacy was deleted). Same contract as pipelineVersion: anything but
  // 'native' 400s before the 202 — there is no other code to run.
  let requestedIllustratorVersion = null;
  if (req.body.illustratorVersion !== undefined && req.body.illustratorVersion !== null && req.body.illustratorVersion !== '') {
    const v = String(req.body.illustratorVersion).toLowerCase().trim();
    if (v !== 'native') {
      return res.status(400).json({ success: false, error: `Unsupported illustratorVersion '${req.body.illustratorVersion}' — 'native' is the only illustrator` });
    }
    requestedIllustratorVersion = v;
  }

  // Text layout (2026-07-17, admin-selectable): 'caption' (typeset white
  // verso + square art recto, default) or 'embedded' (wide art across both
  // pages, caption typeset OVER the quiet zone). Same contract as
  // illustratorVersion: anything else 400s before the 202.
  let requestedTextLayout = null;
  if (req.body.textLayout !== undefined && req.body.textLayout !== null && req.body.textLayout !== '') {
    const t = String(req.body.textLayout).toLowerCase().trim();
    if (t !== 'caption' && t !== 'embedded') {
      return res.status(400).json({ success: false, error: `Unsupported textLayout '${req.body.textLayout}' — expected 'caption' or 'embedded'` });
    }
    requestedTextLayout = t;
  }

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
  const style = canonicalBookArtStyle(artStyle);
  const costTracker = new CostTracker();
  // Which pipeline actually generated this book — reported in every callback
  // so pipeline A/B comparisons stay trustworthy. Null for chapter/GN formats.
  let pipelineVersionUsed = null;
  // Which illustrator rendered a v3 book (native|legacy) — reported beside
  // pipelineVersionUsed so illustrator A/B comparisons stay auditable.
  let illustratorVersionUsed = null;
  // Minor QA observations on the SHIPPED images (closed-gate architecture:
  // judges block only on critical defects; everything else ships as a
  // recorded advisory). Carried on completion callbacks + the checkpoint.
  let qaAdvisories = null;


  // Auto-derive emotional tier from age for emotional books
  let emotionalTierInfo = null;
  if (isEmotionalBook) {
    emotionalTierInfo = getEmotionalTier(childAge || 5);
    if (!format || format === 'picture_book') {
      format = emotionalTierInfo.bookFormat.toLowerCase();
      console.log(`[server] [emotional] Tier ${emotionalTierInfo.tier} derived from age ${childAge} → format=${format}, spreads=${emotionalTierInfo.spreads}`);
    }
  }

  const { computeCelebrationAge } = require('./services/celebrationAge');
  const { resolveEffectiveAge } = require('./services/effectiveAge');
  const birthDateRaw = childAnecdotes?.birth_date || req.body.childBirthDate || null;
  const celebrationAge = computeCelebrationAge(
    { birthDate: birthDateRaw, age: childAge, childAge },
    new Date(),
  );

  // PR K — parent-theme picture books (Mother's Day / Father's Day) now also
  // read age from the birth date when the client provided one. Lap-baby
  // (under-1.5) books were silently routing to PB_TODDLER because the
  // client had been sending a stale `childAge` (e.g. 2) for an 8-month-old
  // whose birth_date was correct. PB_TODDLER bypasses every infant-band PR
  // (H/I/J.1/J.4) and produces dance/run/twirl/dialogue text the lap-baby
  // cannot perform. Birth date is the ground-truth signal — when present,
  // it wins on birthday + parent themes.
  const { age: effectiveAge, source: _effectiveAgeSource } = resolveEffectiveAge({
    theme,
    birthDateRaw,
    childAge,
    celebrationAge,
  });
  if (
    _effectiveAgeSource === 'celebrationAge' &&
    (theme === 'mothers_day' || theme === 'fathers_day') &&
    celebrationAge !== childAge
  ) {
    console.log(
      `[server] [parent-theme age fix] childAge=${childAge} overridden by ` +
      `birth-date-derived age=${celebrationAge} (birthDate=${birthDateRaw}, theme=${theme}) ` +
      '(PR K)'
    );
  }

  const childDetails = {
    name: childName,
    age: effectiveAge,
    celebrationAge,
    birthDate: birthDateRaw || undefined,
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
            // Download original and resize (HEIC fallback via heic-convert when sharp/libvips cannot decode)
            const { resizeChildPhotoForCache } = require('./services/childPhotoDecode');
            const photoBuf = await downloadBuffer(childPhotoUrl);
            const resizedBuf = await resizeChildPhotoForCache(photoBuf, childPhotoUrl);
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
        // Caption-mode backfill for checkpoints written BEFORE toLegacyStoryPlan
        // carried illustrationAspect/captionText (2026-07-16): a native-rendered
        // book resumed from such a checkpoint would otherwise lay out on the
        // legacy wide-split path — square art bisected, story text missing.
        // The manuscript text was always stashed on entry.left.text.
        // Advisories recorded at illustration time survive the resume.
        if (Array.isArray(checkpoint.qaAdvisories) && checkpoint.qaAdvisories.length > 0) {
          qaAdvisories = checkpoint.qaAdvisories;
        }
        if (checkpoint.illustratorVersion === 'native' && Array.isArray(storyPlan.entries)) {
          const { backfillCaptionModeEntries } = require('./services/bookPipelineV3/contract/toLegacyStoryPlan');
          const backfilled = backfillCaptionModeEntries(storyPlan.entries);
          if (backfilled > 0) {
            bookContext.log('warn', `Caption-mode backfill: ${backfilled} native spread entr${backfilled === 1 ? 'y' : 'ies'} from a pre-caption checkpoint marked square + captionText from stashed manuscript text`);
          }
        }
        const itemCount = storyPlan.isGraphicNovel
          ? (storyPlan.pages || []).length
          : storyPlan.isChapterBook
            ? (storyPlan.chapters || []).length
            : (storyPlan.entries || []).filter(e => e.type === 'spread').length;
        bookContext.log('info', 'Resumed story plan from checkpoint', { items: itemCount, title: storyPlan.title, isChapterBook: !!storyPlan.isChapterBook, isGraphicNovel: !!storyPlan.isGraphicNovel });
      } else {
        // ── Book pipeline — plan/write/illustrate/QA engine (v3 default) ──
        // Chapter-book and graphic-novel planning branches were deleted in
        // the W12 cleanup: retired formats are rejected 400 at validation,
        // so only picture books reach this point.
        bookContext.checkAbort();
        // NOTE: the pipeline VERSION is decided by resolveBookPipeline below —
        // this line must stay version-neutral (a hardcoded "v1" here confused
        // production log readers for months).
        bookContext.log('info', 'Starting book pipeline generation', { theme: theme || 'adventure', format });

        if (apiKeys) {
          for (const [key, val] of Object.entries(apiKeys)) {
            if (val && !process.env[key]) process.env[key] = val;
          }
        }

        // ── Pipeline version routing ──
        // Precedence: env kill-switches → checkpoint (resumes stay on the
        // pipeline they started on) → explicit request ('v2'|'v3' from the
        // admin test path) → default (v2 for picture books per the AA-CW-29
        // hard cutover, v1 for early readers). See services/pipelineRouter.js.
        const routed = resolveBookPipeline({
          format,
          requestedVersion: requestedPipelineVersion,
          checkpointVersion: checkpoint?.pipelineVersion || null,
          log: (msg) => bookContext.log('warn', msg),
        });
        pipelineVersionUsed = routed.version;
        const { generateBook, PipelineError } = require(routed.modulePath);
        const { toLegacyStoryPlan } = require('./services/bookPipelineV3/contract/toLegacyStoryPlan');
        bookContext.log('info', `Pipeline routing: format=${format} → ${routed.moduleName} (version=${routed.version}, source=${routed.source}, requested=${requestedPipelineVersion || 'none'})`);

        const stage3Start = Date.now();
        const pipelineRequest = {
          ...sanitized,
          bookId,
          format,
          theme,
          pipelineVersion: routed.version,
          child: childDetails,
          customDetails: plannerCustomDetails || sanitized.customDetails || {},
          cover: {
            title: approvedTitle || sanitized.approvedTitle || 'My Story',
            imageUrl: approvedCoverUrl || null,
          },
          // Admin review resolution (set by /v3/review/* on a needs_review
          // checkpoint). 'ship_best' lets the workflow ship the best-scoring
          // manuscript on panel exhaustion instead of failing again.
          ...(checkpoint?.reviewResolution ? { reviewResolution: checkpoint.reviewResolution } : {}),
          // Milestone-2 illustrator flag: request override + checkpoint pin,
          // resolved inside the v3 workflow (checkpoint → request → env → default).
          ...(requestedIllustratorVersion ? { illustratorVersion: requestedIllustratorVersion } : {}),
          ...(checkpoint?.illustratorVersion ? { checkpointIllustratorVersion: checkpoint.illustratorVersion } : {}),
          ...(requestedTextLayout ? { textLayout: requestedTextLayout } : {}),
          ...(checkpoint?.textLayout ? { checkpointTextLayout: checkpoint.textLayout } : {}),
        };

        let pipelineResult;
        try {
          pipelineResult = await generateBook(pipelineRequest, {
            bookId,
            abortSignal: bookContext.abortController.signal,
            touchActivity: () => bookContext.touchActivity(),
            onProgress: (event) => {
              if (!progressCallbackUrl) return;
              // Stage progress bands. The illustrating band is deliberately
              // wide (0.30 → 0.85) because it's by far the longest stage
              // (~4–5 min of a ~5–6 min run). We interpolate within it using
              // the per-spread `subProgress` the pipeline emits.
              const stageBands = {
                input: [0.08, 0.12],
                planning: [0.12, 0.22],
                writing: [0.22, 0.26],
                writerQa: [0.26, 0.30],
                illustrating: [0.30, 0.85],
                bookWideQa: [0.85, 0.90],
                layout: [0.90, 0.95],
              };
              const band = stageBands[event.step];
              let progress;
              if (band && typeof event.subProgress === 'number') {
                const t = Math.max(0, Math.min(1, event.subProgress));
                progress = band[0] + (band[1] - band[0]) * t;
              } else if (band) {
                progress = band[0];
              } else {
                progress = 0.30;
              }
              reportProgress(progressCallbackUrl, {
                bookId,
                stage: event.step || 'generating',
                progress,
                message: event.message || 'Generating...',
                logs: bookContext.logs,
              });

              // When the pipeline attaches a live document snapshot (after
              // writerQa and after every accepted spread), push an updated
              // storyContent payload to the admin content tab so text and
              // per-spread hasImage flags populate incrementally rather
              // than all at the end of the run.
              if (event.document) {
                try {
                  const { storyPlan: livePlan, entriesWithIllustrations: liveEntries } = toLegacyStoryPlan(event.document);
                  const liveStoryContent = {
                    title: livePlan.title,
                    entries: liveEntries.map(e => ({
                      type: e.type,
                      spread: e.spread,
                      left: e.left,
                      right: e.right,
                      spreadText: event.document.spreads.find(s => s.spreadNumber === e.spread)?.manuscript?.text || '',
                      hasImage: !!(e.spreadIllustrationUrl || e.illustrationUrl),
                    })),
                    characterDescription: livePlan.characterDescription,
                    characterOutfit: livePlan.characterOutfit,
                    pipelineVersion: livePlan._pipelineVersion,
                    synopsis: livePlan.synopsis || null,
                    plotSynopsis: livePlan.plotSynopsis || null,
                    tagline: livePlan.tagline || null,
                    storyBible: event.document.storyBible,
                    writerQa: event.document.writerQa,
                    bookWideQa: event.document.bookWideQa,
                  };
                  reportProgressForce(progressCallbackUrl, {
                    bookId,
                    stage: event.step || 'generating',
                    storyContent: liveStoryContent,
                    logs: bookContext.logs,
                  }).catch(() => {});
                } catch (adapterErr) {
                  console.warn(`[server] incremental storyContent push skipped: ${adapterErr.message}`);
                }
              }
            },
          });
        } catch (pipelineErr) {
          if (pipelineErr instanceof PipelineError) {
            bookContext.log('error', `bookPipeline failed: ${pipelineErr.failureCode || 'unknown'}`, {
              stage: pipelineErr.stage,
              issues: pipelineErr.issues,
            });
            // needs_review is a terminal REVIEW state, not a plain failure
            // (design D6 / cutover plan W2): persist the structured payload
            // in the checkpoint so the /v3/review/* endpoints can resolve it,
            // and carry it to the failure callbacks so the main app's review
            // dashboard gets the full context (defects, judge history).
            if (pipelineErr.failureCode === 'needs_review' && pipelineErr.needsReview) {
              await saveCheckpoint(bookId, {
                completedStage: 'needs_review',
                pipelineVersion: routed.version,
                needsReview: pipelineErr.needsReview,
                request: { theme, format },
              });
            }
            const wrapped = new Error(`bookPipeline [${pipelineErr.failureCode || 'unknown'}] at ${pipelineErr.stage || 'n/a'}: ${pipelineErr.message}`);
            wrapped.failureCode = pipelineErr.failureCode || null;
            wrapped.needsReview = pipelineErr.needsReview || null;
            throw wrapped;
          }
          throw pipelineErr;
        }

        illustratorVersionUsed = pipelineResult.document?.v3?.illustrator?.version || null;
        qaAdvisories = Array.isArray(pipelineResult.document?.qaAdvisories) && pipelineResult.document.qaAdvisories.length > 0
          ? pipelineResult.document.qaAdvisories
          : null;
        if (qaAdvisories) {
          bookWarnings.push(`QA advisories: ${qaAdvisories.length} minor observation(s) on shipped images (spreads ${[...new Set(qaAdvisories.map(a => a.spread))].join(', ')}) — see qaAdvisories`);
        }
        const synthesized = toLegacyStoryPlan(pipelineResult.document);
        storyPlan = synthesized.storyPlan;

        bookContext.touchActivity();
        const stage3Ms = Date.now() - stage3Start;
        bookContext.log('info', 'bookPipeline v1 complete', {
          spreads: pipelineResult.document.spreads.length,
          writerQaPass: pipelineResult.document.writerQa?.pass,
          bookWideQaPass: pipelineResult.document.bookWideQa?.pass,
          ms: stage3Ms,
        });
        console.log(`[server] Stage timing: bookPipelineV1=${stage3Ms}ms (book ${bookId})`);

        if (progressCallbackUrl) {
          const storyContentForDb = {
            title: storyPlan.title,
            entries: storyPlan.entries.map(e => ({
              type: e.type,
              spread: e.spread,
              left: e.left,
              right: e.right,
              spreadText: pipelineResult.document.spreads.find(s => s.spreadNumber === e.spread)?.manuscript?.text || '',
            })),
            characterDescription: storyPlan.characterDescription,
            characterOutfit: storyPlan.characterOutfit,
            pipelineVersion: storyPlan._pipelineVersion,
            synopsis: storyPlan.synopsis || null,
            plotSynopsis: storyPlan.plotSynopsis || null,
            tagline: storyPlan.tagline || null,
            storyBible: pipelineResult.document.storyBible,
            writerQa: pipelineResult.document.writerQa,
            bookWideQa: pipelineResult.document.bookWideQa,
          };
          reportProgressForce(progressCallbackUrl, { bookId, stage: 'story_planning', storyContent: storyContentForDb, logs: bookContext.logs }).catch(() => {});
        }

        // New pipeline has already rendered + QA'd all spreads and uploaded
        // them to GCS, so we mark the checkpoint as 'illustration' complete.
        await saveCheckpoint(bookId, {
          bookId,
          completedStage: 'illustration',
          storyPlan,
          illustrationResults: storyPlan.entries,
          pipelineVersion: routed.version,
          // Pin the illustrator a v3 book rendered on so retries/resumes
          // finish on it (native|legacy, milestone-2 flag).
          ...(pipelineResult.document?.v3?.illustrator?.version
            ? { illustratorVersion: pipelineResult.document.v3.illustrator.version }
            : {}),
          ...(pipelineResult.document?.v3?.textLayout
            ? { textLayout: pipelineResult.document.v3.textLayout }
            : {}),
          ...(qaAdvisories ? { qaAdvisories } : {}),
          timestamp: new Date().toISOString(),
          accumulatedCosts: costTracker.getSummary(),
        });
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

          // Legacy cover vision analysis deleted (native-illustrator cutover) —
          // the v3 pipeline derives the cast policy internally from the
          // approved cover.
        } catch (dlErr) {
          bookContext.log('warn', 'Failed to download approved cover for reference, using original photo', { error: dlErr.message });
        }
      }

      // Legacy secondary-cast merge + scene policy gate deleted
      // (native-illustrator cutover) — the v3 pipeline owns cast policy.

      // If we still have no characterAnchor but parent provided one, use it
      if (!storyPlan.characterAnchor && parentCharacterAnchor) {
        storyPlan.characterAnchor = parentCharacterAnchor;
        bookContext.log('info', '[generate-book] Using parentCharacterAnchor from parent book');
      }

      bookContext.log('info', 'Character reference ready', { refBytes: characterRefBase64?.length || 0, coverBytes: coverForIllustratorBase64?.length || 0, ms: Date.now() - stage6Start });

      // Birthday theme: ensure spread 13 illustration prompt shows cake/candles
      if (theme === 'birthday') {
        const spreads = storyPlan.entries.filter(e => e.type === 'spread');
        const lastSpread = spreads[spreads.length - 1];
        if (lastSpread && lastSpread.spread_image_prompt) {
          const prompt = lastSpread.spread_image_prompt.toLowerCase();
          if (!prompt.includes('cake') && !prompt.includes('candle')) {
            const candleAge = childDetails.celebrationAge ?? childDetails.age ?? childDetails.childAge ?? 5;
            const candleDesc = `${candleAge} lit candles`;
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

      // The v3 pipeline (native illustrator) already rendered and QA'd every
      // spread — the entries carry signed URLs; adopt them directly. The
      // legacy in-server illustration stage was deleted in the cutover.
      bookContext.log('info', 'Using illustrations rendered by bookPipelineV3');
      entriesWithIllustrations = storyPlan.entries.slice();
      spreadEntries = entriesWithIllustrations.filter(e => e.type === 'spread');

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

      // Chapter-book / graphic-novel PDF-assembly arms deleted (W12) —
      // retired formats never reach this stage.
      {
        // ── Standard picture-book PDF assembly ──
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
            const parentDescription = ((theme === 'mothers_day' || theme === 'fathers_day') && storyPlan?.coverParentPresent && storyPlan?.additionalCoverCharacters)
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
        const coverMetaSource = { ...storyPlan, entries: entriesWithBuffers };
        const { pageCount, synopsis } = computeCoverPdfMetadata(coverMetaSource, childDetails, {});

        coverData = await generateCover(bookTitle, childDetails, characterRef, format, {
          apiKeys, costTracker, bookId, preGeneratedCoverBuffer, pageCount, synopsis,
          heartfeltNote, bookFrom, bindingType,
          coverSourceUrl: approvedCoverUrl || '',
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
      const itemCount = entriesWithIllustrations.length;
      bookContext.log('info', 'Book complete', { totalMs, items: itemCount, cost: `$${costSummary.totalCost.toFixed(4)}`, warnings: bookWarnings.length });

      // Build storyContent for DB (chapter/GN arms deleted in W12)
      let storyContent;
      {
        storyContent = {
          title: bookTitle,
          entries: entriesWithIllustrations.map(e => ({ type: e.type, spread: e.spread, left: e.left, right: e.right, hasImage: !!(e.spreadIllustrationUrl || e.illustrationUrl) })),
          characterDescription: storyPlan.characterDescription || null,
          characterOutfit: storyPlan.characterOutfit || null,
          characterAnchor: storyPlan.characterAnchor || null,
          additionalCoverCharacters: storyPlan.additionalCoverCharacters || null,
          synopsis: storyPlan.synopsis || null,
          plotSynopsis: storyPlan.plotSynopsis || null,
          tagline: storyPlan.tagline || null,
          storyBible: storyPlan.storyBible || null,
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
                pipelineVersionUsed,
                ...(illustratorVersionUsed ? { illustratorVersionUsed } : {}),
                ...(qaAdvisories ? { qaAdvisories } : {}),
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
          pipelineVersionUsed,
          ...(illustratorVersionUsed ? { illustratorVersionUsed } : {}),
          ...(qaAdvisories ? { qaAdvisories } : {}),
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
              body: JSON.stringify({
                success: false,
                bookId,
                error: err.message,
                pipelineVersionUsed,
                ...(illustratorVersionUsed ? { illustratorVersionUsed } : {}),
                logs: bookContext.logs,
                ...(err.failureCode ? { failureCode: err.failureCode } : {}),
                ...(err.needsReview ? { needsReview: err.needsReview } : {}),
              }),
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
        reportError(progressCallbackUrl, {
          bookId,
          error: err.message,
          pipelineVersionUsed,
          ...(illustratorVersionUsed ? { illustratorVersionUsed } : {}),
          logs: bookContext.logs,
          ...(err.failureCode ? { failureCode: err.failureCode } : {}),
          ...(err.needsReview ? { needsReview: err.needsReview } : {}),
        });
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

// ── POST /regenerate-illustration — 410 GONE (native-illustrator cutover) ──
// The legacy per-spread regen painted the caption into a wide image anchored
// on the cover — that renderer was deleted. Native books re-render single
// spreads through the v3 review flow instead: POST /v3/review/regen-spread
// (records the resolution; the re-dispatched /generate-book replays every
// other spread from GCS and re-renders only the target, QA included).
app.post('/regenerate-illustration', authenticate, (req, res) => {
  const { bookId, spreadIndex } = req.body || {};
  console.log(`[server] /regenerate-illustration is retired (bookId=${bookId}, spread=${spreadIndex})`);
  res.status(410).json({
    success: false,
    error: 'Legacy per-spread regeneration was removed with the legacy illustrator. For native books, use POST /v3/review/regen-spread and re-dispatch /generate-book (cached spreads replay from GCS); legacy-rendered books must be regenerated in full.',
  });
});

// /generate-spread removed — V2 pipeline generates sequentially, this endpoint was unused.

// ── POST /generate-game-character ─────────────────────────────────────────────
// Admin-only Children Web Game support. Generates a clean full-body standalone
// character sprite (PNG with alpha) in the book's art style, for injection
// into the sandbox game. Single-shot + chromakey; typically <20s.
app.post('/generate-game-character', authenticate, async (req, res) => {
  const { bookId, characterRefUrl, childPhotoUrl, coverImageUrl, style, childDetails } = req.body || {};

  if (!bookId) {
    return res.status(400).json({ success: false, error: 'bookId is required' });
  }
  if (!characterRefUrl && !coverImageUrl && !childPhotoUrl) {
    return res.status(400).json({
      success: false,
      error: 'At least one of characterRefUrl / coverImageUrl / childPhotoUrl is required',
    });
  }

  console.log(`[server] /generate-game-character: bookId=${bookId}, style=${style || 'default'}`);

  try {
    const { generateGameCharacter } = require('./services/gameCharacter');
    const result = await generateGameCharacter({
      bookId,
      characterRefUrl,
      childPhotoUrl,
      coverImageUrl,
      style,
      childDetails,
      poses: req.body?.poses,   // optional filter for partial regen
    });

    res.json({
      success: true,
      bookId,
      gameSpriteUrl: result.gameSpriteUrl,
      gamePoseAtlasUrl: result.gamePoseAtlasUrl,
      poses: result.poses,
      tookMs: result.tookMs,
    });
  } catch (err) {
    console.error(`[server] generate-game-character failed for ${bookId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /generate-character-face ─────────────────────────────────────────────
// Crop the child's stylised reference to a circular 256×256 face disc that the
// Rive rig uses as a facial overlay (vector body + AI identity face).
app.post('/generate-character-face', authenticate, async (req, res) => {
  const { bookId, characterRefUrl, childPhotoUrl, coverImageUrl, style, childDetails } = req.body || {};
  if (!bookId) return res.status(400).json({ success: false, error: 'bookId is required' });
  console.log(`[server] /generate-character-face: bookId=${bookId}`);
  try {
    const { generateCharacterFace } = require('./services/gameCharacter');
    const result = await generateCharacterFace({
      bookId, characterRefUrl, childPhotoUrl, coverImageUrl, style, childDetails,
    });
    res.json({ success: true, bookId, ...result });
  } catch (err) {
    console.error(`[server] generate-character-face failed for ${bookId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /generate-character-sheet ────────────────────────────────────────────
// Alias for /generate-game-character — the 2.5D pivot names it "sheet"
// because the client consumes a 12-pose atlas rather than a single sprite.
app.post('/generate-character-sheet', authenticate, async (req, res) => {
  const { bookId, characterRefUrl, childPhotoUrl, coverImageUrl, style, childDetails } = req.body || {};

  if (!bookId) return res.status(400).json({ success: false, error: 'bookId is required' });
  if (!characterRefUrl && !coverImageUrl && !childPhotoUrl) {
    return res.status(400).json({
      success: false,
      error: 'At least one of characterRefUrl / coverImageUrl / childPhotoUrl is required',
    });
  }

  console.log(`[server] /generate-character-sheet: bookId=${bookId}, style=${style || 'default'}`);
  try {
    const { generateGameCharacter } = require('./services/gameCharacter');
    const result = await generateGameCharacter({
      bookId, characterRefUrl, childPhotoUrl, coverImageUrl, style, childDetails,
    });
    res.json({
      success: true,
      bookId,
      gameSpriteUrl: result.gameSpriteUrl,
      gamePoseAtlasUrl: result.gamePoseAtlasUrl,
      poses: result.poses,
      tookMs: result.tookMs,
    });
  } catch (err) {
    console.error(`[server] generate-character-sheet failed for ${bookId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /generate-hero-props ─────────────────────────────────────────────────
// Generate book-specific hero-prop sprites (transparent painted PNGs) via
// Gemini. Accepts an array of { id, name, prompt, itemId?, roomId?,
// interaction? } and returns a manifest of { url, width, height, interaction }
// entries the 2.5D client loads.
app.post('/generate-hero-props', authenticate, async (req, res) => {
  const { bookId, props, characterRefUrl, coverImageUrl } = req.body || {};
  if (!bookId) return res.status(400).json({ success: false, error: 'bookId is required' });
  if (!Array.isArray(props) || props.length === 0) {
    return res.status(400).json({ success: false, error: 'props array is required' });
  }
  console.log(`[server] /generate-hero-props: bookId=${bookId}, props=${props.length}`);
  try {
    const { generateHeroProps } = require('./services/gameHeroProps');
    const result = await generateHeroProps({ bookId, props, characterRefUrl, coverImageUrl });
    res.json({ success: true, bookId, ...result });
  } catch (err) {
    console.error(`[server] generate-hero-props failed for ${bookId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /generate-npc-sprite ─────────────────────────────────────────────────
// Generate full-body painted NPC sprites (mom / dad / pet) in the shared
// 2.5D Don't Starve style. Accepts `descriptors: [{ kind, name?, prompt? }]`
// and returns `{ npcs: { kind: { url, width, height, name } } }`.
app.post('/generate-npc-sprite', authenticate, async (req, res) => {
  const { bookId, descriptors, characterRefUrl, coverImageUrl } = req.body || {};
  if (!bookId) return res.status(400).json({ success: false, error: 'bookId is required' });
  if (!Array.isArray(descriptors) || descriptors.length === 0) {
    return res.status(400).json({ success: false, error: 'descriptors array is required' });
  }
  console.log(`[server] /generate-npc-sprite: bookId=${bookId}, npcs=${descriptors.map((d) => d.kind || d.name).join(',')}`);
  try {
    const { generateNpcSprites } = require('./services/gameNpcSprite');
    const result = await generateNpcSprites({ bookId, descriptors, characterRefUrl, coverImageUrl });
    res.json({ success: true, bookId, ...result });
  } catch (err) {
    console.error(`[server] generate-npc-sprite failed for ${bookId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /generate-game-stylesheet ────────────────────────────────────────────
// Generate one coordinated ~80-item sticker sheet for a book's art style, slice
// into transparent per-item PNGs on GCS. Replaces per-room object generation.
app.post('/generate-game-stylesheet', authenticate, async (req, res) => {
  const { bookId, coverImageUrl, characterRefUrl, items, style } = req.body || {};
  if (!bookId) return res.status(400).json({ success: false, error: 'bookId is required' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: 'items array is required' });
  }
  console.log(`[server] /generate-game-stylesheet: bookId=${bookId}, items=${items.length}`);
  try {
    const { generateGameStylesheet } = require('./services/gameObjects');
    const result = await generateGameStylesheet({
      bookId, coverImageUrl, characterRefUrl, items, style,
    });
    res.json({ success: true, bookId, ...result });
  } catch (err) {
    console.error(`[server] generate-game-stylesheet failed for ${bookId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /generate-game-npcs ──────────────────────────────────────────────────
// Generate AI-styled NPC sprites (mom / dad / cat) in the book's art style
// so they don't visually clash with the injected child character.
app.post('/generate-game-npcs', authenticate, async (req, res) => {
  const { bookId, characters, characterRefUrl, coverImageUrl, style, briefMoments } = req.body || {};
  if (!bookId) return res.status(400).json({ success: false, error: 'bookId is required' });
  console.log(`[server] /generate-game-npcs: bookId=${bookId}, characters=${(characters||['mom','cat']).join(',')}`);
  try {
    const { generateGameNpcs } = require('./services/gameNpcs');
    const result = await generateGameNpcs({
      bookId, characters, characterRefUrl, coverImageUrl, style, briefMoments,
    });
    res.json({ success: true, bookId, ...result });
  } catch (err) {
    console.error(`[server] generate-game-npcs failed for ${bookId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /generate-game-world ─────────────────────────────────────────────────
// Generate a room background + set of object sprites under the book's art style.
app.post('/generate-game-world', authenticate, async (req, res) => {
  const { bookId, room, objects, characterRefUrl, coverImageUrl, style } = req.body || {};
  if (!bookId) return res.status(400).json({ success: false, error: 'bookId is required' });
  if (!room)   return res.status(400).json({ success: false, error: 'room is required' });

  console.log(`[server] /generate-game-world: bookId=${bookId}, room=${room}, objectCount=${(objects||[]).length}`);

  try {
    const { generateWorldAssets } = require('./services/gameWorldAssets');
    const result = await generateWorldAssets({
      bookId, room, objects, characterRefUrl, coverImageUrl, style,
    });
    res.json({ success: true, bookId, room, ...result });
  } catch (err) {
    console.error(`[server] generate-game-world failed for ${bookId}/${room}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /generate-game-dialogue ──────────────────────────────────────────────
// Generate a dialogue line map for a given book's narrative using the OpenAI
// chat completions JSON mode. Cheap (~$0.01/book); callers cache on the DB.
app.post('/generate-game-dialogue', authenticate, async (req, res) => {
  const { bookId, narrative, recipeIds, npcKinds } = req.body || {};
  if (!bookId) return res.status(400).json({ success: false, error: 'bookId is required' });

  console.log(`[server] /generate-game-dialogue: bookId=${bookId}, recipeIds=${(recipeIds||[]).length}, npcKinds=${(npcKinds||[]).join(',')}`);

  try {
    const { generateGameDialogue } = require('./services/gameDialogue');
    const result = await generateGameDialogue({ bookId, narrative, recipeIds, npcKinds });
    res.json({ success: true, bookId, ...result });
  } catch (err) {
    console.error(`[server] generate-game-dialogue failed for ${bookId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /generate-game-voices ────────────────────────────────────────────────
// Synthesize all dialogue lines to MP3 via Google Cloud TTS and upload to GCS.
// Returns a manifest { [lineId]: signedUrl }.
app.post('/generate-game-voices', authenticate, async (req, res) => {
  const { bookId, dialogues, gender } = req.body || {};
  if (!bookId) return res.status(400).json({ success: false, error: 'bookId is required' });
  if (!dialogues || typeof dialogues !== 'object') {
    return res.status(400).json({ success: false, error: 'dialogues map is required' });
  }

  console.log(`[server] /generate-game-voices: bookId=${bookId}, lines=${Object.keys(dialogues).length}, gender=${gender || 'any'}`);

  try {
    const { generateGameVoices } = require('./services/gameVoices');
    const result = await generateGameVoices({ bookId, dialogues, gender });
    res.json({ success: true, bookId, ...result });
  } catch (err) {
    console.error(`[server] generate-game-voices failed for ${bookId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /generate-game-pose-anims ────────────────────────────────────────────
// Generates 2×2 animation grids (walk / jump / cheer) and slices them into
// per-frame PNGs on GCS. Returns manifest of { anims: { name: { frames, fps, loop } } }.
app.post('/generate-game-pose-anims', authenticate, async (req, res) => {
  const { bookId, characterRefUrl, coverImageUrl, childPhotoUrl, idlePoseUrl, style, childDetails, anims } = req.body || {};
  if (!bookId) return res.status(400).json({ success: false, error: 'bookId is required' });

  console.log(`[server] /generate-game-pose-anims: bookId=${bookId}, anims=${(anims || ['walk','jump','cheer']).join(',')}`);

  try {
    const { generateGamePoseAnims } = require('./services/gamePoseAnims');
    const result = await generateGamePoseAnims({
      bookId, characterRefUrl, coverImageUrl, childPhotoUrl, idlePoseUrl,
      style, childDetails, anims,
    });
    res.json({ success: true, bookId, ...result });
  } catch (err) {
    console.error(`[server] generate-game-pose-anims failed for ${bookId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /generate-game-character-atlas ───────────────────────────────────────
// Generates a single 4×4 Gemini grid of character parts (head poses, eyes,
// mouths, body+arms+hair). Returns a manifest with part URLs + anchor points
// the client uses to assemble a rigged multi-part character.
app.post('/generate-game-character-atlas', authenticate, async (req, res) => {
  const { bookId, characterRefUrl, coverImageUrl, childPhotoUrl, idlePoseUrl, style, childDetails } = req.body || {};
  if (!bookId) return res.status(400).json({ success: false, error: 'bookId is required' });

  console.log(`[server] /generate-game-character-atlas: bookId=${bookId}`);

  try {
    const { generateGameCharacterAtlas } = require('./services/gameCharacterAtlas');
    const result = await generateGameCharacterAtlas({
      bookId, characterRefUrl, coverImageUrl, childPhotoUrl, idlePoseUrl,
      style, childDetails,
    });
    res.json({ success: true, bookId, ...result });
  } catch (err) {
    console.error(`[server] generate-game-character-atlas failed for ${bookId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /generate-game-object-variants ───────────────────────────────────────
// Generates per-hero-object AI art variants (stove:off/flames/pot-cooking, etc)
// as strip-grids, slices them, and returns a manifest of { objectId: { variant: url } }.
app.post('/generate-game-object-variants', authenticate, async (req, res) => {
  const { bookId, heroObjects, coverImageUrl, childPhotoUrl, style, theme } = req.body || {};
  if (!bookId) return res.status(400).json({ success: false, error: 'bookId is required' });
  if (!Array.isArray(heroObjects) || heroObjects.length === 0) {
    return res.status(400).json({ success: false, error: 'heroObjects array is required' });
  }

  console.log(`[server] /generate-game-object-variants: bookId=${bookId}, objects=${heroObjects.map((h) => h.id).join(',')}`);

  try {
    const { generateGameObjectVariants } = require('./services/gameObjectVariants');
    const result = await generateGameObjectVariants({
      bookId, heroObjects, coverImageUrl, childPhotoUrl, style, theme,
    });
    res.json({ success: true, bookId, ...result });
  } catch (err) {
    console.error(`[server] generate-game-object-variants failed for ${bookId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

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

  // Reject only if a coloring job is already in flight (not parent /generate-book — different map key)
  const coloringKey = coloringActiveJobKey(bookId);
  if (activeBooks.has(coloringKey)) {
    return res.status(409).json({ success: false, error: 'Coloring book generation already in progress for this bookId' });
  }

  res.status(202).json({ success: true, bookId, status: 'generating' });

  // Register with activeBooks under a dedicated key so parent book + coloring can overlap safely
  const bookContext = createBookContext(bookId, {
    progressCallbackUrl,
    callbackUrl,
    mapKey: coloringKey,
  });

  // Absolute timeout for coloring book generation
  const absoluteTimer = setTimeout(() => {
    console.error(`[server] Coloring book ${bookId} hit absolute timeout (${ABSOLUTE_TIMEOUT_MS / 60000} min) — aborting`);
    bookContext.abortController.abort();
  }, ABSOLUTE_TIMEOUT_MS);

  // Background generation
  (async () => {
    const startMs = Date.now();

    function checkCancelled() {
      if (bookContext.abortController.signal.aborted) {
        throw new Error('Coloring book generation cancelled');
      }
    }

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

      checkCancelled();
      await reportProgress('planning', 0.05, 'Preparing coloring book generation');
      bookContext.touchActivity();

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
      bookContext.touchActivity();

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
      bookContext.touchActivity();
      checkCancelled();

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
          checkCancelled();
          resolvedScenePrompts = await planColoringScenes({
            title, synopsis, characterDescription, childName, age,
            count: sceneCount || 12,
            storyMoments: Array.isArray(storyMoments) ? storyMoments : undefined,
          });
          console.log(`[server] Planned ${resolvedScenePrompts.length} coloring scenes${Array.isArray(storyMoments) && storyMoments.length ? ` (grounded in ${storyMoments.length} parent story moments)` : ''}`);
        }
        totalScenes = resolvedScenePrompts.length;
        await reportProgress('illustration', 0.10, `Generating ${totalScenes} coloring pages`);
        bookContext.touchActivity();
        checkCancelled();

        pages = await generateOriginalColoringPages(resolvedScenePrompts, characterRef, {
          characterDescription,
          characterAnchor,
          abortSignal: bookContext.abortController.signal,
          onPageComplete: (doneCount) => {
            bookContext.touchActivity();
            const pct = 0.10 + (doneCount / totalScenes) * 0.65;
            reportProgress('illustration', pct, `Coloring page ${doneCount}/${totalScenes} done`);
          },
        });
      }

      bookContext.touchActivity();
      checkCancelled();

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

      bookContext.touchActivity();
      checkCancelled();

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

      bookContext.touchActivity();
      checkCancelled();

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
        const isCancelled = err.message.includes('cancelled') || bookContext.abortController.signal.aborted;
        const errorResult = { success: false, bookId, error: err.message, mode, cancelled: isCancelled, elapsedMs: Date.now() - startMs };
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
    } finally {
      clearTimeout(absoluteTimer);
      removeBookContext(coloringKey);
    }
  })();
});

// ── POST /cancel-coloring-book ──────────────────────────────────────────────
// Cancel an in-progress coloring book generation by aborting its AbortController.
app.post('/cancel-coloring-book', authenticate, async (req, res) => {
  const { bookId } = req.body;
  if (!bookId) {
    return res.status(400).json({ success: false, error: 'bookId is required' });
  }

  const ctx = activeBooks.get(coloringActiveJobKey(bookId));
  if (!ctx) {
    return res.status(404).json({ success: false, error: 'No active generation found for this bookId' });
  }

  console.log(`[server] /cancel-coloring-book: aborting bookId=${bookId}`);
  ctx.abortController.abort();

  res.json({ success: true, bookId, message: 'Cancellation signal sent' });
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
// ── POST /v3/review/* — resolution endpoints for needs_review books ──
// A V3 book that exhausts a quality budget terminates as `needs_review`
// with a structured payload persisted in its GCS checkpoint (design D6,
// cutover plan W2). These endpoints record the admin's resolution in the
// checkpoint; the caller (main app) then re-dispatches /generate-book,
// and the workflow honors the resolution on that run. They deliberately
// do NOT re-trigger generation themselves — the worker never stores the
// full request payload, the main app does.
const V3_REVIEW_BOOK_ID = /^[A-Za-z0-9_-]{1,128}$/;

async function loadNeedsReviewCheckpoint(bookId, res) {
  if (!bookId || !V3_REVIEW_BOOK_ID.test(String(bookId))) {
    res.status(400).json({ success: false, error: 'invalid bookId' });
    return null;
  }
  const checkpoint = await loadCheckpoint(bookId);
  if (!checkpoint) {
    res.status(404).json({ success: false, error: `no checkpoint for book ${bookId}` });
    return null;
  }
  if (!checkpoint.needsReview) {
    res.status(409).json({ success: false, error: `book ${bookId} is not awaiting review (completedStage=${checkpoint.completedStage || 'n/a'})` });
    return null;
  }
  return checkpoint;
}

async function resolveNeedsReview(bookId, checkpoint, resolution) {
  const next = {
    ...checkpoint,
    reviewResolution: resolution,
    resolvedNeedsReview: checkpoint.needsReview,
  };
  delete next.needsReview; // needsReview present ⇔ awaiting review
  await saveCheckpoint(bookId, next);
}

// Approve as-is: ship the best-scoring manuscript despite panel exhaustion.
app.post('/v3/review/approve', authenticate, async (req, res) => {
  try {
    const { bookId, note } = req.body || {};
    const checkpoint = await loadNeedsReviewCheckpoint(bookId, res);
    if (!checkpoint) return;
    const { buildReviewResolution } = require('./services/bookPipelineV3/reviewQueue/payload');
    const resolution = buildReviewResolution({ action: 'ship_best', note, admin: req.body?.admin || null });
    await resolveNeedsReview(bookId, checkpoint, resolution);
    console.log(`[v3-review] ${bookId} approved (ship_best) by ${resolution.admin || 'admin'}`);
    res.json({ success: true, bookId, action: 'ship_best', next: 'redispatch_generate_book' });
  } catch (err) {
    console.error('[v3-review] approve failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Regenerate the manuscript from scratch (fresh writer run on re-dispatch).
app.post('/v3/review/regen-manuscript', authenticate, async (req, res) => {
  try {
    const { bookId, note } = req.body || {};
    const checkpoint = await loadNeedsReviewCheckpoint(bookId, res);
    if (!checkpoint) return;
    const { buildReviewResolution } = require('./services/bookPipelineV3/reviewQueue/payload');
    const resolution = buildReviewResolution({ action: 'regen_manuscript', note, admin: req.body?.admin || null });
    await resolveNeedsReview(bookId, checkpoint, resolution);
    console.log(`[v3-review] ${bookId} resolved (regen_manuscript) by ${resolution.admin || 'admin'}`);
    res.json({ success: true, bookId, action: 'regen_manuscript', next: 'redispatch_generate_book' });
  } catch (err) {
    console.error('[v3-review] regen-manuscript failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Spread-level actions (W10, native V3 illustrator): the admin picks one
// of a failed spread's candidates, or forces a fresh render with a note.
// Both only record the resolution — the main app re-dispatches, and the
// native illustrator honors it (pick bypasses QA for that candidate;
// regen ignores the spread's cached renders and feeds the note into the
// prompt). Cached candidates for the other spreads replay from GCS, so
// the re-run only spends on the resolved spread.
app.post('/v3/review/pick-candidate', authenticate, async (req, res) => {
  try {
    const { bookId, spread, candidateUrl, note } = req.body || {};
    if (!Number.isFinite(Number(spread))) return res.status(400).json({ success: false, error: 'spread (number) is required' });
    if (!candidateUrl || typeof candidateUrl !== 'string') return res.status(400).json({ success: false, error: 'candidateUrl is required' });
    const checkpoint = await loadNeedsReviewCheckpoint(bookId, res);
    if (!checkpoint) return;
    const { buildReviewResolution } = require('./services/bookPipelineV3/reviewQueue/payload');
    const resolution = buildReviewResolution({
      action: 'pick_candidate', note, spread: Number(spread), candidateUrl, admin: req.body?.admin || null,
    });
    await resolveNeedsReview(bookId, checkpoint, resolution);
    console.log(`[v3-review] ${bookId} resolved (pick_candidate spread=${spread}) by ${resolution.admin || 'admin'}`);
    res.json({ success: true, bookId, action: 'pick_candidate', spread: Number(spread), next: 'redispatch_generate_book' });
  } catch (err) {
    console.error('[v3-review] pick-candidate failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/v3/review/regen-spread', authenticate, async (req, res) => {
  try {
    const { bookId, spread, note } = req.body || {};
    if (!Number.isFinite(Number(spread))) return res.status(400).json({ success: false, error: 'spread (number) is required' });
    const checkpoint = await loadNeedsReviewCheckpoint(bookId, res);
    if (!checkpoint) return;
    const { buildReviewResolution } = require('./services/bookPipelineV3/reviewQueue/payload');
    const resolution = buildReviewResolution({
      action: 'regen_spread', note, spread: Number(spread), admin: req.body?.admin || null,
    });
    await resolveNeedsReview(bookId, checkpoint, resolution);
    console.log(`[v3-review] ${bookId} resolved (regen_spread spread=${spread}) by ${resolution.admin || 'admin'}`);
    res.json({ success: true, bookId, action: 'regen_spread', spread: Number(spread), next: 'redispatch_generate_book' });
  } catch (err) {
    console.error('[v3-review] regen-spread failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Identity-kit resolution: after an identity_kit_exhausted needs_review
// (payload carries candidateUrls of the judged-but-rejected sheets), the
// admin picks one — human judgment outranks the automated likeness judges.
// The re-dispatched run uses the picked candidate as the model sheet.
app.post('/v3/review/pick-sheet', authenticate, async (req, res) => {
  try {
    const { bookId, candidateUrl, note } = req.body || {};
    if (!candidateUrl || typeof candidateUrl !== 'string') return res.status(400).json({ success: false, error: 'candidateUrl is required' });
    const checkpoint = await loadNeedsReviewCheckpoint(bookId, res);
    if (!checkpoint) return;
    const { buildReviewResolution } = require('./services/bookPipelineV3/reviewQueue/payload');
    const resolution = buildReviewResolution({
      action: 'pick_sheet', note, candidateUrl, admin: req.body?.admin || null,
    });
    await resolveNeedsReview(bookId, checkpoint, resolution);
    console.log(`[v3-review] ${bookId} resolved (pick_sheet) by ${resolution.admin || 'admin'}`);
    res.json({ success: true, bookId, action: 'pick_sheet', next: 'redispatch_generate_book' });
  } catch (err) {
    console.error('[v3-review] pick-sheet failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

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
        coverSourceUrl: coverImageUrl || '',
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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=${apiKey}`,
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
// OPENAI_API_KEY is required for the planner + writer stages. The legacy
// list omitted it, which is how the silent-Gemini-fallback incident shipped
// for weeks (PR AA-1, 2026-05-06).
const REQUIRED_ENV = ['API_KEY', 'GEMINI_API_KEY', 'GCS_BUCKET_NAME', 'OPENAI_API_KEY'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
// /qa/generate-story removed (W12) — Writer V2 was deleted with the legacy pipelines.

if (missingEnv.length > 0 && process.env.NODE_ENV !== 'test') {
  console.error(`[startup] Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

if (require.main === module) {
  // Single grep-friendly LLM-config line at boot — makes silent fallback
  // visible in Cloud Run logs without waiting for the first book to fail.
  try {
    const { assertLlmConfig } = require('./services/llm');
    assertLlmConfig({ require: ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY'] });
  } catch (e) {
    console.error(`[LLM_CONFIG] startup check threw: ${e.message}`);
  }
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
// gcsPath, when provided, must be scoped to the same bookId and to one of the
// known per-book prefixes. Otherwise an authorized caller could overwrite any
// object in the bucket — including other books' covers and cached face data.
const SAFE_BOOK_ID_RE = /^[a-zA-Z0-9_-]+$/;
const SAFE_FILE_NAME_RE = /^[a-zA-Z0-9._-]+$/;
function parseBooleanFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
  }
  return false;
}
function isAllowedComicFaceCropUrl(faceCropUrl, comicId) {
  if (typeof faceCropUrl !== 'string' || typeof comicId !== 'string') return false;
  try {
    const url = new URL(faceCropUrl);
    if (url.protocol !== 'https:') return false;
    const hostname = url.hostname.toLowerCase();
    const isGcsHost = hostname === 'storage.googleapis.com' || hostname.endsWith('.storage.googleapis.com');
    if (!isGcsHost) return false;
    const expectedRaw = `comics/${comicId}/faces/`;
    const expectedEncoded = `comics%2F${comicId}%2Ffaces%2F`;
    const decodedPath = decodeURIComponent(url.pathname || '');
    const rawHref = faceCropUrl;
    return decodedPath.includes(`/${expectedRaw}`) || rawHref.includes(expectedRaw) || rawHref.includes(expectedEncoded);
  } catch (_) {
    return false;
  }
}
function validateUploadImagePath(customPath, bookId) {
  if (!customPath) return null;
  if (typeof customPath !== 'string') return 'gcsPath must be a string';
  if (customPath.includes('..') || customPath.startsWith('/')) return 'gcsPath must be relative and contain no traversal';
  const m = customPath.match(/^children-(covers|jobs|spreads)\/([^/]+)\/([^/]+)$/);
  if (!m) return 'gcsPath must match children-(covers|jobs|spreads)/<bookId>/<file>';
  if (m[2] !== bookId) return 'gcsPath bookId segment must match request bookId';
  if (!SAFE_FILE_NAME_RE.test(m[3])) return 'gcsPath filename has unsafe characters';
  return null;
}

app.post('/upload-image', authenticate, async (req, res) => {
  const { bookId, imageBase64, mimeType, gcsPath: customPath } = req.body;
  if (!bookId || !imageBase64) return res.status(400).json({ error: 'bookId and imageBase64 required' });
  if (typeof bookId !== 'string' || !SAFE_BOOK_ID_RE.test(bookId)) {
    return res.status(400).json({ error: 'bookId has unsafe characters' });
  }
  const pathErr = validateUploadImagePath(customPath, bookId);
  if (pathErr) return res.status(400).json({ error: pathErr });
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

// ─── POST /comics/detect-faces ────────────────────────────────────────────────
// Admin-only: detect human faces in a group photo via Gemini Vision and return
// normalized 0..1 bounding boxes (top-left origin). Cached in GCS by URL hash.
app.post('/comics/detect-faces', authenticate, async (req, res) => {
  const { groupPhotoUrl } = req.body || {};
  if (!groupPhotoUrl || typeof groupPhotoUrl !== 'string') {
    return res.status(400).json({ success: false, error: 'groupPhotoUrl is required' });
  }
  console.log(`[server] /comics/detect-faces: url=${groupPhotoUrl.slice(0, 100)}`);
  try {
    const { detectFaces } = require('./services/comics/detectFaces');
    const result = await detectFaces(groupPhotoUrl);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(`[server] /comics/detect-faces failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /comics/crop-face ───────────────────────────────────────────────────
// Admin-only: extract a padded JPEG face crop from a group photo given a
// normalized box, upload it to GCS, and return the signed URL.
app.post('/comics/crop-face', authenticate, async (req, res) => {
  const { comicId, groupPhotoUrl, box, padding } = req.body || {};
  if (!comicId || typeof comicId !== 'string') {
    return res.status(400).json({ success: false, error: 'comicId is required' });
  }
  if (!SAFE_BOOK_ID_RE.test(comicId)) {
    return res.status(400).json({ success: false, error: 'comicId has unsafe characters' });
  }
  if (!groupPhotoUrl || typeof groupPhotoUrl !== 'string') {
    return res.status(400).json({ success: false, error: 'groupPhotoUrl is required' });
  }
  if (!box) {
    return res.status(400).json({ success: false, error: 'box is required' });
  }
  if (padding !== undefined && (!Number.isFinite(padding) || padding < 0 || padding > 2)) {
    return res.status(400).json({ success: false, error: 'padding must be a finite number between 0 and 2' });
  }
  console.log(`[server] /comics/crop-face: comicId=${comicId}`);
  try {
    const { cropFace } = require('./services/comics/cropFace');
    const opts = { comicId };
    if (typeof padding === 'number') opts.padding = padding;
    const result = await cropFace(groupPhotoUrl, box, opts);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(`[server] /comics/crop-face failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /comics/generate-refsheet ───────────────────────────────────────────
// Admin-only: turn a cropped face into a locked ADULT comic-style character
// reference sheet + visualLocks JSON. Idempotent via GCS cache; `force` bypass.
app.post('/comics/generate-refsheet', authenticate, async (req, res) => {
  const {
    comicId,
    characterId,
    faceCropUrl,
    name,
    role,
    definingTrait,
    signatureProp,
    signatureColor,
    artStyle,
    portrayalDial,
    force,
  } = req.body || {};

  if (!comicId || typeof comicId !== 'string') {
    return res.status(400).json({ success: false, error: 'comicId is required' });
  }
  if (!SAFE_BOOK_ID_RE.test(comicId)) {
    return res.status(400).json({ success: false, error: 'comicId has unsafe characters' });
  }
  if (!characterId || typeof characterId !== 'string') {
    return res.status(400).json({ success: false, error: 'characterId is required' });
  }
  if (!SAFE_BOOK_ID_RE.test(characterId)) {
    return res.status(400).json({ success: false, error: 'characterId has unsafe characters' });
  }
  if (!faceCropUrl || typeof faceCropUrl !== 'string') {
    return res.status(400).json({ success: false, error: 'faceCropUrl is required' });
  }
  if (!isAllowedComicFaceCropUrl(faceCropUrl, comicId)) {
    return res.status(400).json({
      success: false,
      error: 'faceCropUrl must be an HTTPS GCS URL under comics/<comicId>/faces/',
    });
  }
  const forceFlag = parseBooleanFlag(force);

  console.log(`[server] /comics/generate-refsheet: comicId=${comicId} characterId=${characterId} force=${forceFlag}`);
  try {
    const { generateCharacterRefSheet } = require('./services/comics/castVisualBible');
    const result = await generateCharacterRefSheet({
      comicId,
      characterId,
      faceCropUrl,
      name,
      role,
      definingTrait,
      signatureProp,
      signatureColor,
      artStyle,
      portrayalDial,
      force: forceFlag,
    });
    res.json({ success: true, refSheetUrl: result.refSheetUrl, visualLocks: result.visualLocks });
  } catch (err) {
    console.error(`[server] /comics/generate-refsheet failed: ${err.message}`);
    const msg = String(err.message || err);
    // 502 for upstream model/network failures; 500 for everything else.
    const isUpstream = /HTTP\s\d{3}|No image|refsheet image|vision HTTP|timed out|timeout|aborted|abort/i.test(msg);
    res.status(isUpstream ? 502 : 500).json({ success: false, error: msg });
  }
});
