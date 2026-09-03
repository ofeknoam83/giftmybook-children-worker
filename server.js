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

const { downloadPhotoAsBase64 } = require('./services/illustrationGenerator');
const { assemblePdf, buildEmbeddedPreviewPdf, OVERLAY } = require('./services/layoutEngine');
const { generateCover, generateFrontCoverImage, generateUpsellCovers } = require('./services/coverGenerator');
const { computeCoverPdfMetadata } = require('./services/coverMetadata');
const { uploadBuffer, getSignedUrl, downloadBuffer, deletePrefix } = require('./services/gcsStorage');
const { reportProgress, reportProgressForce, reportComplete, reportError, clearThrottle } = require('./services/progressReporter');
const { CostTracker } = require('./services/costTracker');
const { validateFinalizeBookRequest } = require('./services/validation');
const catalogEngine = require('./services/catalogEngine');
const { runBookPipeline, resolveStory } = require('./services/catalogEngine/pipeline');
const { renderStorySpreads } = require('./services/catalogEngine/illustrator');


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
  // Every authenticated request resets the global idle clock: the watchdog's
  // clean-exit path must never fire while a SYNC endpoint (cover render,
  // prepare-identity) is mid-request on an instance whose last tracked book
  // finished ~10 minutes ago. Health checks deliberately bypass this.
  global.__lastGlobalActivity = Date.now();
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
  const { assertLlmConfig } = require('./services/shared/llm/openaiClient');
  const llm = assertLlmConfig({ require: ['OPENAI_API_KEY'] });
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

// ── Catalog Engine endpoints (V1.3 fixed-catalog system) ────────────────────
//
// The writer never invents or selects a plot. Flow:
//   /v13/select-books    → deterministic 3-candidate selection (sync, no LLM)
//   /v13/generate-stories → 3 parallel validated stories (202 + callback)
//   /generate-book        → illustrate + PDF the CHOSEN story (202 + callbacks)

const BOOK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// The text-layout vocabulary: 'caption' (art page + white text page),
// 'half' (art page + solid-color text panel — same square renders/cache as
// caption, layout-engine only), 'embedded' (wide art with Gemini-painted
// text). Unknown values fall back to caption.
const TEXT_LAYOUTS = ['caption', 'half', 'embedded'];
const normalizeTextLayout = (v) => {
  const t = String(v || '').toLowerCase().trim();
  return TEXT_LAYOUTS.includes(t) ? t : 'caption';
};

// GET /v13/themes — the catalog's theme vocabulary (single source of truth
// for the main app's picker).
app.get('/v13/themes', authenticate, (req, res) => {
  res.json({ success: true, catalogVersion: catalogEngine.catalogVersion(), themes: catalogEngine.listThemes() });
});

// GET /v13/coverage — sidecar authoring coverage + flag state (admin/release
// gate), plus the pinned engine versions and live model choices so the main
// app's Writer Anatomy view can show the writer's real current configuration.
app.get('/v13/coverage', authenticate, (req, res) => {
  const { WRITER_MODEL } = require('./services/catalogEngine/writer');
  res.json({
    success: true,
    coverage: catalogEngine.coverageReport(),
    flags: {
      fitRanking: catalogEngine.flags.fitRankingEnabled(),
      personalizationMaps: catalogEngine.flags.personalizationMapsEnabled(),
      evidenceRequired: catalogEngine.flags.evidenceRequired(),
      tuningLayer: catalogEngine.flags.tuningLayerEnabled(),
      stylePolish: catalogEngine.flags.stylePolishEnabled(),
      catalogOverlay: catalogEngine.flags.catalogOverlayEnabled(),
      artTuningLayer: catalogEngine.flags.artTuningLayerEnabled(),
    },
    versions: {
      writer_engine: catalogEngine.versions.WRITER_ENGINE_VERSION,
      age_engine: catalogEngine.versions.AGE_ENGINE_VERSION,
      map_schema: catalogEngine.versions.MAP_SCHEMA_VERSION,
      book_definition: catalogEngine.versions.BOOK_DEFINITION_VERSION,
      selector: catalogEngine.versions.SELECTOR_VERSION,
      prompt_template: catalogEngine.versions.PROMPT_TEMPLATE_VERSION,
      style: catalogEngine.versions.STYLE_VERSION,
      catalog: catalogEngine.catalogVersion(),
    },
    models: {
      writer: WRITER_MODEL(),
      qaVision: process.env.CATALOG_QA_VISION_MODEL || 'gemini-2.5-flash',
    },
  });
});

// ── Catalog Overlay (admin plot editing — Catalog Studio) ───────────────────
// The base catalog.json stays frozen in git; overlays are validated prose
// patches persisted in GCS and activated explicitly from the main app.

// GET /v13/catalog — the merged catalog + the frozen base (for diffing) +
// the active overlay state. Admin editor's source of truth.
app.get('/v13/catalog', authenticate, (req, res) => {
  res.json({
    success: true,
    tag: catalogEngine.catalogVersion(),
    activeOverlay: catalogEngine.activeOverlayHash(),
    overlayEnabled: catalogEngine.flags.catalogOverlayEnabled(),
    catalog: catalogEngine.mergedCatalog(),
    base: catalogEngine.baseCatalog(),
  });
});

// POST /v13/catalog-overlay/validate — dry-run: allowlist shape + full boot
// invariants on the merged result. Never touches the live catalog.
app.post('/v13/catalog-overlay/validate', authenticate, (req, res) => {
  try {
    const overlay = req.body?.overlay;
    const base = catalogEngine.baseCatalog();
    const errors = catalogEngine.catalogOverlay.validateOverlayShape(overlay, base);
    if (errors.length === 0) {
      const merged = catalogEngine.catalogOverlay.applyOverlay(base, overlay);
      errors.push(...require('./services/catalogEngine/catalog').validateCatalog(merged));
    }
    const hash8 = catalogEngine.catalogOverlay.overlayHash(overlay).slice(0, 8);
    res.json({
      success: true,
      ok: errors.length === 0,
      errors,
      tag: catalogEngine.catalogOverlay.overlayTag(String(base.version), hash8),
      summary: catalogEngine.catalogOverlay.overlaySummary(overlay),
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /v13/catalog-overlay/activate — validate, persist blob + pointer to
// GCS (survives restarts), hot-swap the live catalog. Explicit admin action.
app.post('/v13/catalog-overlay/activate', authenticate, async (req, res) => {
  try {
    if (!catalogEngine.flags.catalogOverlayEnabled()) {
      return res.status(409).json({ success: false, error: 'CATALOG_OVERLAY=0 — overlays are disabled on this revision' });
    }
    const overlay = req.body?.overlay;
    const base = catalogEngine.baseCatalog();
    const errors = catalogEngine.catalogOverlay.validateOverlayShape(overlay, base);
    if (errors.length === 0) {
      const merged = catalogEngine.catalogOverlay.applyOverlay(base, overlay);
      errors.push(...require('./services/catalogEngine/catalog').validateCatalog(merged));
    }
    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }
    const hash8 = await catalogEngine.catalogOverlay.saveOverlayBlob(overlay);
    await catalogEngine.catalogOverlay.setActivePointer(hash8);
    const tag = catalogEngine.applyCatalogOverlay(overlay, hash8);
    console.log(`[v13] catalog overlay ${hash8} activated (tag ${tag})`);
    res.json({ success: true, tag, activeOverlay: hash8 });
  } catch (err) {
    console.error('[v13] catalog overlay activation failed:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /v13/catalog-overlay/deactivate — back to the frozen base catalog.
app.post('/v13/catalog-overlay/deactivate', authenticate, async (req, res) => {
  try {
    await catalogEngine.catalogOverlay.setActivePointer(null);
    const tag = catalogEngine.resetCatalogOverlay();
    console.log('[v13] catalog overlay deactivated');
    res.json({ success: true, tag, activeOverlay: null });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /v13/select-books — deterministic candidate selection. Synchronous:
// pure code, no LLM. The caller persists the result BEFORE any generation;
// refresh must never reselect.
app.post('/v13/select-books', authenticate, (req, res) => {
  try {
    const { themeId, sessionId } = req.body || {};
    const profile = catalogEngine.normalizeProfile(req.body?.profile);
    if (!themeId) return res.status(400).json({ success: false, error: 'themeId is required' });
    const ageBand = req.body?.ageBand || catalogEngine.ageBandForAge(profile.age);
    const selection = catalogEngine.selectBooks({
      profile,
      themeId,
      ageBand,
      sessionId: sessionId || 'session_unknown',
      count: Math.min(Number(req.body?.count) || 3, 3),
    });
    res.json({ success: true, themeId, ageBand, profile, selection });
  } catch (err) {
    const status = err.statusCode || (err.message.includes('unknown theme') || err.message.includes('age band') ? 400 : 500);
    res.status(status).json({ success: false, error: err.message });
  }
});

// POST /v13/generate-stories — generate stories for up to 3 candidate books
// in parallel (202 + completion callback). Each candidate succeeds or fails
// independently; a failed candidate never substitutes a different plot.
app.post('/v13/generate-stories', authenticate, async (req, res) => {
  const { bookId, sessionId, locale, callbackUrl, progressCallbackUrl } = req.body || {};
  const dispatchId = typeof req.body?.dispatchId === 'string' ? req.body.dispatchId.slice(0, 100) : null;
  const bookIds = Array.isArray(req.body?.bookIds) ? req.body.bookIds : [];
  if (!bookId || !BOOK_ID_RE.test(String(bookId))) {
    return res.status(400).json({ success: false, error: 'invalid bookId' });
  }
  if (bookIds.length < 1 || bookIds.length > 3) {
    return res.status(400).json({ success: false, error: 'bookIds must contain 1-3 catalog book ids' });
  }
  let profile;
  try {
    profile = catalogEngine.normalizeProfile(req.body?.profile);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  const tuningError = catalogEngine.validateTuningInput(req.body?.writerTuning);
  if (tuningError) {
    return res.status(400).json({ success: false, error: tuningError });
  }
  const profileBand = catalogEngine.ageBandForAge(profile.age);
  for (const id of bookIds) {
    const hit = catalogEngine.getBook(id);
    if (!hit) {
      return res.status(400).json({ success: false, error: `unknown catalog book id '${id}'` });
    }
    if (hit.ageBand !== profileBand) {
      return res.status(400).json({ success: false, error: `book '${id}' is age band ${hit.ageBand} but the profile (age ${profile.age}) routes to ${profileBand}` });
    }
  }

  res.status(202).json({ success: true, bookId, accepted: bookIds });

  // Same watchdog registration as the render probe below: a story run is
  // background work after the 202, and an unregistered run is killed by the
  // global idle exit ~10 minutes in (structural retries + repair passes on
  // three stories can legitimately run longer than that).
  const storiesKey = `stories:${bookId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const storiesContext = createBookContext(bookId, { mapKey: storiesKey, callbackUrl });
  (async () => {
    const started = Date.now();
    let done = 0;
    try {
      const { stories, failures } = await catalogEngine.generateStories({
        bookIds,
        profile,
        sessionId: sessionId || bookId,
        locale,
        tuning: req.body?.writerTuning || null,
        onProgress: ({ bookId: candidateId, status }) => {
          storiesContext.touchActivity();
          if (status === 'done' || status === 'failed') done += 1;
          if (progressCallbackUrl) {
            reportProgress(progressCallbackUrl, {
              bookId,
              stage: 'stories',
              progress: 0.1 + (done / bookIds.length) * 0.85,
              message: `Story ${candidateId}: ${status} (${done}/${bookIds.length})`,
            }).catch(() => {});
          }
        },
      });
      console.log(`[v13] stories for ${bookId}: ${stories.length} ok, ${failures.length} failed in ${Date.now() - started}ms`);
      if (callbackUrl) {
        await postWithRetry(callbackUrl, {
          success: stories.length > 0,
          bookId,
          engine: 'catalog-v13',
          ...(dispatchId ? { dispatchId } : {}),
          stories: stories.map(s => ({
            bookDefinitionId: s.request.book_id,
            request: s.request,
            response: s.response,
            nameOnly: s.nameOnly,
            attempts: s.attempts,
            usage: s.usage,
            // Provenance flags for the feedback loop: whether the shipped
            // text went through the targeted repair or style-polish pass.
            repaired: !!s.repaired,
            polished: !!s.polished,
          })),
          failures,
        });
      }
    } catch (err) {
      console.error(`[v13] generate-stories failed for ${bookId}:`, err);
      if (callbackUrl) {
        await postWithRetry(callbackUrl, {
          success: false, bookId, engine: 'catalog-v13', ...(dispatchId ? { dispatchId } : {}), stories: [], failures: [{ message: err.message }],
        });
      }
    } finally {
      removeBookContext(storiesKey);
    }
  })();
});

// POST /v13/render-spreads — the illustration-workbench PROBE: render a
// SUBSET of an existing validated story's spreads through the exact
// production render path (cache → render → QA → repair → marker), with no
// PDFs, cover, upsell, or checkpoint. This is the admin render-test mode —
// the story is reused, never regenerated (zero writer spend), and image
// spend is len(spreads) renders instead of 12. Like /v13/generate-stories,
// every validation happens BEFORE the 202 and results arrive by callback
// only (docs/AI_ILLUSTRATION_FEEDBACK_LOOP_PLAN.md §7.1).
app.post('/v13/render-spreads', authenticate, async (req, res) => {
  const body = req.body || {};
  const { bookId, callbackUrl, dispatchId } = body;
  if (!bookId || !BOOK_ID_RE.test(String(bookId))) {
    return res.status(400).json({ success: false, error: 'invalid bookId' });
  }
  if (!callbackUrl) {
    return res.status(400).json({ success: false, error: 'callbackUrl is required — probe results are delivered by callback only' });
  }
  const spreads = Array.isArray(body.spreads) ? body.spreads : null;
  if (!spreads || spreads.length < 1 || spreads.length > 12
    || !spreads.every(n => Number.isInteger(n) && n >= 1 && n <= 12)
    || new Set(spreads).size !== spreads.length) {
    return res.status(400).json({ success: false, error: 'spreads must be 1-12 unique integers between 1 and 12' });
  }
  // Per-spread force re-render ("make this one spread match the rest"):
  // the listed spreads render fresh while the others replay from cache as
  // world-gate references. Must be a subset of `spreads`.
  let rerenderSpreads = null;
  if (body.rerenderSpreads !== undefined && body.rerenderSpreads !== null) {
    const rr = body.rerenderSpreads;
    if (!Array.isArray(rr)
      || !rr.every(n => Number.isInteger(n) && spreads.includes(n))
      || new Set(rr).size !== rr.length) {
      return res.status(400).json({ success: false, error: 'rerenderSpreads must be unique integers drawn from spreads' });
    }
    rerenderSpreads = rr.length > 0 ? [...rr].sort((a, b) => a - b) : null;
  }
  let profile;
  try {
    profile = catalogEngine.normalizeProfile(body.profile);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  const artTuningError = catalogEngine.validateArtTuningInput(body.illustrationTuning);
  if (artTuningError) {
    return res.status(400).json({ success: false, error: artTuningError });
  }
  if (body.seed !== undefined && body.seed !== null && !Number.isInteger(body.seed)) {
    return res.status(400).json({ success: false, error: 'seed must be an integer' });
  }
  const storyPair = body.story && body.story.request && body.story.response ? body.story : null;
  if (!storyPair) {
    return res.status(400).json({ success: false, error: 'story {request, response} is required — the probe renders an existing validated story, never a fresh one' });
  }
  const approvedCoverUrl = body.approvedCoverUrl || null;
  const childPhotoUrl = Array.isArray(body.childPhotoUrls) ? body.childPhotoUrls[0] : null;
  if (!approvedCoverUrl && !childPhotoUrl) {
    return res.status(400).json({ success: false, error: 'no approvedCoverUrl and no childPhotoUrls — the renders would have no identity anchor', failureCode: 'missing_identity_reference' });
  }
  // Bind + re-validate the pair exactly like /generate-book's pipeline does:
  // a probe must never render an invalid or foreign story.
  let story;
  try {
    story = await resolveStory({
      storyPair,
      checkpointStory: null,
      bookDefinitionId: null,
      profile,
      sessionId: body.sessionId || bookId,
      log: (level, msg) => console.log(`[renderSpreads:${bookId}] ${msg}`),
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message, failureCode: err.failureCode || null });
  }
  // Scenes must come from the story's PINNED definitions (resolveStory just
  // resolved this same tag, so this only misses if the overlay vanished) —
  // a probe rendered against currently-active beats would not reproduce
  // what production prints for this story.
  const bookDef = await catalogEngine.getBookForTag(story.request.book_id, story.request?.versions?.catalog);
  if (!bookDef) {
    return res.status(400).json({
      success: false,
      error: `story pins catalog '${story.request?.versions?.catalog}' which is no longer resolvable — regenerate the story`,
      failureCode: 'missing_book_definition',
    });
  }

  res.status(202).json({ success: true, bookId, accepted: [...spreads].sort((a, b) => a - b), engine: 'catalog-v13' });

  // Register the probe in the per-book activity tracking under its OWN map
  // key (never the raw bookId — a running probe must not 409 a concurrent
  // /generate-book of the same workbench book). Without this the run is
  // invisible to the watchdog: activeBooks stays empty, so the global idle
  // check exits the process 10 minutes after the last tracked activity —
  // killing a long probe mid-render with no callback ever sent (a 12-spread
  // ce-9 run takes well over 10 minutes; the bench then stalls out at its
  // 45-minute reconcile with nothing in the logs but a clean exit).
  const probeKey = `probe:${bookId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const probeContext = createBookContext(bookId, { mapKey: probeKey, callbackUrl });
  const costTracker = new CostTracker();
  (async () => {
    const started = Date.now();
    let payload;
    try {
      const art = await renderStorySpreads({
        bookId,
        story: story.response,
        bookDef,
        profile,
        approvedCoverUrl,
        childPhotoUrl,
        characterDescription: body.characterDescription || null,
        textLayout: normalizeTextLayout(body.textLayout),
        spreads: [...spreads].sort((a, b) => a - b),
        rerenderSpreads,
        tuning: body.illustrationTuning || null,
        // Probe cache keys carry the identity anchor: a workbench book's
        // anchor is admin-mutable, and a swapped anchor must never replay
        // the prior child's cached renders.
        // ce-9: an admin per-spread re-render of a CUSTOMER book sends
        // identityKeyed:false so the fresh render lands on the customer's
        // un-salted cache key (and the next /generate-book replays it).
        identityKeyed: body.identityKeyed !== false,
        seed: Number.isInteger(body.seed) ? body.seed : null,
        probeNonce: body.probeNonce || null,
        costTracker,
        forceRerender: !!body.forceRerender,
        // The illustrator's 30s phase heartbeats (bible build, render loop,
        // both set gates) land here and keep the per-book watchdog's idle
        // clock at zero for a healthy run — the same wiring /generate-book
        // has always had.
        onProgress: () => probeContext.touchActivity(),
        log: (level, msg) => console.log(`[renderSpreads:${bookId}] ${msg}`),
      });
      const renders = art.results.filter(r => r.buffer).map(r => ({
        spread: r.spread,
        url: r.url,
        storageKey: r.storageKey,
        qa: {
          pass: r.advisories.filter(a => a.stage === 'spreadQa').length === 0,
          advisories: r.advisories,
        },
      }));
      const failures = art.results.filter(r => !r.buffer).map(r => ({
        spread: r.spread,
        message: r.advisories.map(a => a.note).join('; ') || 'render failed',
        // Per-attempt render diagnostics (variant ladder, NSFW blocks,
        // Gemini finish/block reasons, the model's refusal text) so the
        // admin sees WHY a spread failed, not just that it did.
        ...(r.advisories.find(a => a.detail) ? { detail: r.advisories.find(a => a.detail).detail } : {}),
      }));
      payload = {
        success: renders.length > 0,
        bookId,
        engine: 'catalog-v13',
        ...(dispatchId ? { dispatchId } : {}),
        renders,
        failures,
        illustrationTuningUsed: art.tuningTag,
        // Which outfit-lock spec (content hash) pinned these renders, or
        // 'none' — the bench must be able to SEE a lock-less round (silent
        // lock-less renders are how outfit drift shipped unnoticed).
        outfitLockUsed: art.outfitLockUsed,
        // ce-15: which page's painted text the other spreads were held to
        // (`s{spread}.{hash8}`) or 'none' — the bench must SEE an anchor-less round.
        typographyAnchorUsed: art.typographyAnchorUsed || 'none',
        // Book-level advisories (e.g. stage 'outfitLock' when the spec
        // could not be derived) — per-spread advisories ride qa.advisories.
        advisories: art.advisories,
        // Book-level world-consistency verdict for the probe's spreads —
        // ALWAYS present: null when the gate did not run (kill-switch, or a
        // single-spread probe with nothing to compare), so every probe
        // callback has one stable shape; per-spread findings ride
        // qa.advisories.
        worldQa: art.worldQa || null,
        // ce-9: contact-sheet gate verdict, the bible the probe rendered
        // against, and any spreads whose BLOCKING defects survived.
        contactQa: art.contactQa || null,
        // ce-18: the book-level ink verdict (null when the gate did not run).
        textInkQa: art.textInkQa || null,
        bookBible: art.bookBible || null,
        unresolved: art.unresolved || [],
        aspect: art.aspect,
        costs: costTracker.getSummary(),
      };
      console.log(`[v13] render-spreads for ${bookId}: ${renders.length} ok, ${failures.length} failed, tuning=${art.tuningTag} in ${Date.now() - started}ms`);
    } catch (err) {
      console.error(`[v13] render-spreads failed for ${bookId}:`, err);
      payload = {
        success: false,
        bookId,
        engine: 'catalog-v13',
        ...(dispatchId ? { dispatchId } : {}),
        renders: [],
        failures: [{ message: err.message, failureCode: err.failureCode || null }],
        illustrationTuningUsed: 'none',
        outfitLockUsed: 'none',
        typographyAnchorUsed: 'none',
        advisories: [],
        // Same stable shape as the success payload: the gate never ran here.
        worldQa: null,
        contactQa: null,
        textInkQa: null,
        bookBible: null,
        unresolved: [],
        costs: costTracker.getSummary(),
      };
    }
    try {
      await postWithRetry(callbackUrl, payload);
    } finally {
      removeBookContext(probeKey);
    }
  })();
});

// POST /v13/prepare-identity — build (or fetch) the Book Bible's IDENTITY
// KIT for one anchor: the character model sheet + the outfit spec derived
// from it (ce-9, plan §7.2). Synchronous like /v13/generate-cover-image —
// the app calls it when the parent approves a cover so the sheet is ready
// before /generate-book (which builds it lazily if absent; GCS election
// makes both paths converge on one sheet). Returns the callback-shaped
// bookBible summary (signed URLs, hashes, spec text, advisories).
app.post('/v13/prepare-identity', authenticate, async (req, res) => {
  const body = req.body || {};
  const { bookId } = body;
  if (!bookId || !BOOK_ID_RE.test(String(bookId))) {
    return res.status(400).json({ success: false, error: 'invalid bookId' });
  }
  const isHttp = u => typeof u === 'string' && /^https?:\/\//i.test(u);
  const anchorUrl = isHttp(body.approvedCoverUrl) ? body.approvedCoverUrl : null;
  const childPhotoUrl = Array.isArray(body.childPhotoUrls) ? body.childPhotoUrls.find(isHttp) || null : null;
  if (!anchorUrl && !childPhotoUrl) {
    return res.status(400).json({ success: false, error: 'no approvedCoverUrl and no childPhotoUrls — an identity kit needs an anchor', failureCode: 'missing_identity_reference' });
  }
  const rawProfile = body.profile && typeof body.profile === 'object' ? body.profile : {};
  const rawName = rawProfile.name;
  if (rawName !== undefined && rawName !== null && (typeof rawName !== 'string' || /[\u0000-\u001f\u007f]/.test(rawName))) {
    return res.status(400).json({ success: false, error: 'profile.name must be a plain string (no control characters)' });
  }
  const profile = {
    name: typeof rawName === 'string' ? rawName.normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, 60) : null,
    age: Number.isInteger(rawProfile.age) && rawProfile.age >= 1 && rawProfile.age <= 10 ? rawProfile.age : null,
  };
  if (body.characterDescription !== undefined && body.characterDescription !== null
    && (typeof body.characterDescription !== 'string' || /[\u0000-\u001f\u007f]/.test(body.characterDescription))) {
    return res.status(400).json({ success: false, error: 'characterDescription must be a plain string (no control characters)' });
  }
  const characterDescription = typeof body.characterDescription === 'string' ? body.characterDescription.trim().slice(0, 400) || null : null;
  const costTracker = new CostTracker();
  const log = (level, msg) => console.log(`[prepareIdentity:${bookId}] ${msg}`);
  try {
    const { prepareIdentity } = require('./services/catalogEngine/illustrator/bible');
    const bookBible = await prepareIdentity({
      bookId,
      anchorUrl: anchorUrl || childPhotoUrl,
      childPhotoUrl: anchorUrl ? childPhotoUrl : null,
      profile, characterDescription, costTracker, log,
    });
    return res.json({ success: true, bookId, bookBible, costs: costTracker.getSummary() });
  } catch (err) {
    console.error(`[prepareIdentity:${bookId}] failed:`, err.message);
    const status = err.failureCode === 'identity_kit_failed' ? 422 : (err.failureCode === 'missing_identity_reference' ? 400 : 500);
    return res.status(status).json({
      success: false, bookId, error: err.message,
      failureCode: err.failureCode || null,
      ...(Array.isArray(err.advisories) && err.advisories.length > 0 ? { advisories: err.advisories } : {}),
      costs: costTracker.getSummary(),
    });
  }
});

// POST /v13/pick-candidate — promote one scored candidate render (from a
// consistency_unresolved failure payload) to its spread's canonical cache
// key with an admin-vouched QA marker, so the next /generate-book dispatch
// (without forceRerender) replays it into the PDFs (ce-9, plan §5.5).
app.post('/v13/pick-candidate', authenticate, async (req, res) => {
  const body = req.body || {};
  const { bookId, storageKey } = body;
  if (!bookId || !BOOK_ID_RE.test(String(bookId))) {
    return res.status(400).json({ success: false, error: 'invalid bookId' });
  }
  if (typeof storageKey !== 'string' || storageKey.length > 512) {
    return res.status(400).json({ success: false, error: 'storageKey (a candidate render key of this book) is required' });
  }
  try {
    const { pickCandidate } = require('./services/catalogEngine/illustrator/candidates');
    const r = await pickCandidate({ bookId, candidateKey: storageKey, log: (level, msg) => console.log(`[pickCandidate:${bookId}] ${msg}`) });
    return res.json({ success: true, bookId, spread: r.spread, storageKey: r.storageKey, renderHash: r.renderHash });
  } catch (err) {
    console.error(`[pickCandidate:${bookId}] failed:`, err.message);
    return res.status(err.statusCode || 500).json({ success: false, bookId, error: err.message });
  }
});

// POST /v13/generate-video — the GIFT VIDEO (gv-1, docs/GIFT_VIDEO_PLAN.md):
// a 10-second, text-free, fully animated film of a finished book — the
// approved cover coming alive, the opening spread, the emotional peak, the
// resolution — one image-to-video clip per segment starting on the exact
// shipped render, identity pinned by the Book Bible's character sheet as
// the video model's reference and verified per clip, stitched by ffmpeg.
// 202 + callback like /v13/render-spreads: every validation happens BEFORE
// the 202 (the app's render KEYS are validated as canonical keys of THIS
// book; a story pair is re-validated; the provider/model must be enabled);
// the run registers a book context so the idle watchdog sees a job that
// polls a vendor for minutes. A segment whose candidates all fail
// verification fails the film `video_unresolved` with the scored candidates
// attached — never a silent degrade to stills.
app.post('/v13/generate-video', authenticate, async (req, res) => {
  if (!catalogEngine.flags.giftVideoEnabled()) {
    return res.status(503).json({ success: false, error: 'the gift video is disabled on this revision (CATALOG_GIFT_VIDEO=0)', failureCode: 'gift_video_disabled' });
  }
  const body = req.body || {};
  const { bookId, callbackUrl, progressCallbackUrl, dispatchId } = body;
  if (!bookId || !BOOK_ID_RE.test(String(bookId))) {
    return res.status(400).json({ success: false, error: 'invalid bookId' });
  }
  if (!callbackUrl) {
    return res.status(400).json({ success: false, error: 'callbackUrl is required — the film is delivered by callback only' });
  }
  const { validateRenders } = require('./services/catalogEngine/video/stills');
  const rendersCheck = validateRenders(String(bookId), body.renders);
  if (!rendersCheck.ok) {
    return res.status(400).json({ success: false, error: rendersCheck.error, failureCode: 'video_no_sources' });
  }
  let profile;
  try {
    profile = catalogEngine.normalizeProfile(body.profile);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  const videoTuningError = catalogEngine.validateArtTuningInput(body.illustrationTuning);
  if (videoTuningError) {
    return res.status(400).json({ success: false, error: videoTuningError });
  }
  if (body.seed !== undefined && body.seed !== null && !Number.isInteger(body.seed)) {
    return res.status(400).json({ success: false, error: 'seed must be an integer' });
  }
  const storyPair = body.story && body.story.request && body.story.response ? body.story : null;
  if (!storyPair) {
    return res.status(400).json({ success: false, error: 'story {request, response} is required — the film animates an existing validated story, never a fresh one' });
  }
  const { resolveProvider } = require('./services/catalogEngine/video/providers');
  const providerPick = resolveProvider({ provider: body.provider || null, model: body.model || null });
  if (!providerPick.ok) {
    return res.status(400).json({ success: false, error: providerPick.error, failureCode: 'video_provider_unavailable' });
  }
  const aspect = body.aspect === undefined || body.aspect === null ? '16:9' : body.aspect;
  if (aspect !== '16:9' && aspect !== '9:16') {
    return res.status(400).json({ success: false, error: "aspect must be '16:9' or '9:16'" });
  }
  const music = body.music === undefined || body.music === null ? catalogEngine.flags.videoMusic() : body.music;
  if (typeof music !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(music)) {
    return res.status(400).json({ success: false, error: "music must be 'none' or a bundled track name" });
  }
  const isHttp = u => typeof u === 'string' && /^https?:\/\//i.test(u);
  const approvedCoverUrl = isHttp(body.approvedCoverUrl) ? body.approvedCoverUrl : null;
  const childPhotoUrl = Array.isArray(body.childPhotoUrls) ? body.childPhotoUrls.find(isHttp) || null : null;
  if (!approvedCoverUrl && !childPhotoUrl) {
    return res.status(400).json({ success: false, error: 'no approvedCoverUrl and no childPhotoUrls — the clips would have no identity reference', failureCode: 'missing_identity_reference' });
  }
  let story;
  try {
    story = await resolveStory({
      storyPair,
      checkpointStory: null,
      bookDefinitionId: null,
      profile,
      sessionId: body.sessionId || bookId,
      log: (level, msg) => console.log(`[giftVideo:${bookId}] ${msg}`),
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message, failureCode: err.failureCode || null });
  }
  const videoBookDef = await catalogEngine.getBookForTag(story.request.book_id, story.request?.versions?.catalog);
  if (!videoBookDef) {
    return res.status(400).json({
      success: false,
      error: `story pins catalog '${story.request?.versions?.catalog}' which is no longer resolvable — regenerate the story`,
      failureCode: 'missing_book_definition',
    });
  }
  const videoVersion = catalogEngine.versions.VIDEO_VERSION;
  res.status(202).json({
    success: true, bookId, ...(dispatchId ? { dispatchId } : {}), engine: 'catalog-v13', videoVersion,
    provider: providerPick.provider, model: providerPick.model,
    accepted: { spreads: rendersCheck.entries.map(e => e.spread) },
  });

  const costTracker = new CostTracker();
  const mapKey = `video:${bookId}`;
  const ctx = createBookContext(bookId, { mapKey, callbackUrl, progressCallbackUrl: progressCallbackUrl || null });
  (async () => {
    const started = Date.now();
    const stable = { bookId, ...(dispatchId ? { dispatchId } : {}), engine: 'catalog-v13', videoVersion, provider: providerPick.provider, model: providerPick.model };
    let payload;
    try {
      const { generateGiftVideo } = require('./services/catalogEngine/video');
      const r = await generateGiftVideo({
        bookId,
        story: story.response,
        bookDef: videoBookDef,
        profile,
        renders: rendersCheck.entries.map(e => ({ spread: e.spread, storageKey: e.storageKey })),
        approvedCoverUrl,
        childPhotoUrl,
        characterDescription: body.characterDescription || null,
        textLayout: normalizeTextLayout(body.textLayout),
        tuning: body.illustrationTuning || null,
        identityKeyed: body.identityKeyed === true,
        seed: Number.isInteger(body.seed) ? body.seed : null,
        probeNonce: body.probeNonce || null,
        provider: providerPick.provider,
        model: providerPick.model,
        aspect,
        music,
        forceNew: !!body.forceNew,
        // The app injects its Replicate token into every worker request
        // body; the revision's own env wins when set (providers/replicate.js).
        providerToken: typeof body.REPLICATE_API_TOKEN === 'string' ? body.REPLICATE_API_TOKEN : null,
        costTracker,
        onProgress: (fraction, message) => {
          ctx.touchActivity();
          if (progressCallbackUrl) {
            reportProgress(progressCallbackUrl, { bookId, stage: 'video', progress: Math.round(Math.max(0, Math.min(1, fraction)) * 100), message, ...(dispatchId ? { dispatchId } : {}) }).catch(() => {});
          }
        },
        touch: () => ctx.touchActivity(),
        abortSignal: ctx.abortSignal,
        log: (level, msg) => ctx.log(level, msg),
      });
      payload = {
        success: true, ...stable, provider: r.provider, model: r.model,
        video: r.video, plan: r.plan, textGate: r.textGate, bookBible: r.bookBible,
        unresolved: r.unresolved || [], advisories: r.advisories, warnings: r.warnings,
        costs: costTracker.getSummary(), failureCode: null, error: null,
      };
      console.log(`[v13] generate-video for ${bookId}: ${r.video.cached ? 'replayed' : 'built'} ${r.video.durationSeconds}s in ${Date.now() - started}ms`);
    } catch (err) {
      console.error(`[v13] generate-video failed for ${bookId}:`, err.message);
      const d = err.details || {};
      payload = {
        success: false, ...stable,
        video: null, plan: d.plan || [], textGate: d.textGate || [], bookBible: d.bookBible || null,
        unresolved: d.unresolved || [], advisories: d.advisories || [], warnings: d.warnings || [],
        costs: costTracker.getSummary(), failureCode: err.failureCode || null, error: err.message,
      };
    } finally {
      removeBookContext(mapKey);
    }
    await postWithRetry(callbackUrl, payload);
  })();
});

// POST /v13/pick-clip — promote one scored candidate clip (from a
// video_unresolved failure payload) to its segment's canonical clip key
// with an admin-vouched marker, so the next /v13/generate-video dispatch
// (no forceNew) replays it and only re-stitches (gv-1, mirrors
// /v13/pick-candidate).
app.post('/v13/pick-clip', authenticate, async (req, res) => {
  if (!catalogEngine.flags.giftVideoEnabled()) {
    return res.status(503).json({ success: false, error: 'the gift video is disabled on this revision (CATALOG_GIFT_VIDEO=0)', failureCode: 'gift_video_disabled' });
  }
  const body = req.body || {};
  const { bookId, storageKey } = body;
  if (!bookId || !BOOK_ID_RE.test(String(bookId))) {
    return res.status(400).json({ success: false, error: 'invalid bookId' });
  }
  if (typeof storageKey !== 'string' || storageKey.length > 512) {
    return res.status(400).json({ success: false, error: 'storageKey (a candidate clip key of this book) is required' });
  }
  try {
    const { pickClip } = require('./services/catalogEngine/video/clips');
    const r = await pickClip({ bookId, candidateKey: storageKey, log: (level, msg) => console.log(`[pickClip:${bookId}] ${msg}`) });
    return res.json({ success: true, bookId, segment: r.segment, storageKey: r.storageKey, clipHash: r.clipHash });
  } catch (err) {
    console.error(`[pickClip:${bookId}] failed:`, err.message);
    return res.status(err.statusCode || 500).json({ success: false, bookId, error: err.message });
  }
});

// POST /v13/generate-cover-image — admin probe-anchor cover for the
// illustration feedback loop (docs/AI_ILLUSTRATION_FEEDBACK_LOOP_PLAN.md
// §5.1): render ONLY the front-cover key art from a child photo through the
// exact production cover path (coverScene → one render → wardrobe QA + one
// hardened retry → anatomy QA + one hardened retry, ship-and-flag), so Art
// Bench probes can anchor on a cover the way production books do. Synchronous
// like /rebuild-cover-pdf — one render + bounded QA, no PDFs, no upsell.
// `title` is accepted for labeling/log parity but never painted into the
// image (D5: words are PDF type, never pixels — the wrap PDF typesets it).
app.post('/v13/generate-cover-image', authenticate, async (req, res) => {
  const body = req.body || {};
  const { bookId } = body;
  if (!bookId || !BOOK_ID_RE.test(String(bookId))) {
    return res.status(400).json({ success: false, error: 'invalid bookId' });
  }
  if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') {
    return res.status(400).json({ success: false, error: 'title must be a string' });
  }
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : null;
  // Same posture as profile.js cleanString: the name lands in an image
  // prompt, so control characters are hostile input, never data.
  const rawName = body.childName;
  if (typeof rawName !== 'string' || /[\u0000-\u001f\u007f]/.test(rawName)) {
    return res.status(400).json({ success: false, error: 'childName is required (plain string, no control characters)' });
  }
  const childName = rawName.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!childName || childName.length > 60) {
    return res.status(400).json({ success: false, error: 'childName is required (1-60 characters)' });
  }
  const parsedAge = Number(body.childAge);
  const childAge = Number.isInteger(parsedAge) && parsedAge >= 1 && parsedAge <= 10 ? parsedAge : undefined;
  const childPhotoUrl = (typeof body.childPhotoUrl === 'string' && body.childPhotoUrl)
    ? body.childPhotoUrl
    : (Array.isArray(body.childPhotoUrls) ? body.childPhotoUrls.find(u => typeof u === 'string' && u) : null);
  if (!childPhotoUrl || !/^https?:\/\//i.test(childPhotoUrl)) {
    return res.status(400).json({
      success: false,
      error: 'childPhotoUrl (or childPhotoUrls[]) with an http(s) URL is required',
      failureCode: 'missing_identity_reference',
    });
  }
  const fmt = String(body.bookFormat || 'PICTURE_BOOK').toLowerCase();
  const isHardcover = String(body.bindingType || '').toUpperCase().includes('HARDCOVER');
  const costTracker = new CostTracker();
  const started = Date.now();
  try {
    const front = await generateFrontCoverImage(
      { childName, childAge },
      childPhotoUrl,
      {
        artStyle: body.artStyle,
        isGraphicNovel: fmt === 'graphic_novel',
        isSquareTrim: fmt === 'picture_book' || fmt === 'early_reader',
        isHardcover,
        costTracker,
        bookId,
        childPhotoUrl,
      },
    );
    if (!front.frontCoverBuffer) {
      return res.status(502).json({ success: false, error: 'cover render produced no image', costs: costTracker.getSummary() });
    }
    const gcsPath = `children-covers/${bookId}/anchor-cover-${Date.now()}.png`;
    const coverUrl = await uploadBuffer(front.frontCoverBuffer, gcsPath, 'image/png');
    console.log(`[v13] generate-cover-image for ${bookId} ("${title || ''}") done in ${Date.now() - started}ms → ${gcsPath}`);
    return res.json({
      success: true,
      bookId,
      coverUrl,
      gcsPath,
      title,
      coverAnatomyAdvisory: front.coverAnatomyAdvisory,
      costs: costTracker.getSummary(),
    });
  } catch (err) {
    console.error(`[v13] generate-cover-image failed for ${bookId}:`, err.message);
    return res.status(500).json({ success: false, error: err.message, costs: costTracker.getSummary() });
  }
});

// POST /generate-book — full pipeline for the CHOSEN story: renders (cached,
// cover-anchored), interior PDF, cover PDF, callbacks. 202-then-background.
app.post('/generate-book', authenticate, async (req, res) => {
  const body = req.body || {};
  const { bookId, callbackUrl, progressCallbackUrl } = body;
  if (!bookId || !BOOK_ID_RE.test(String(bookId))) {
    return res.status(400).json({ success: false, error: 'invalid bookId' });
  }
  try {
    catalogEngine.normalizeProfile(body.profile);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  const bookTuningError = catalogEngine.validateTuningInput(body.writerTuning);
  if (bookTuningError) {
    return res.status(400).json({ success: false, error: bookTuningError });
  }
  const bookArtTuningError = catalogEngine.validateArtTuningInput(body.illustrationTuning);
  if (bookArtTuningError) {
    return res.status(400).json({ success: false, error: bookArtTuningError });
  }
  // Probe-compat cache keying (the Art Bench "create final book" dispatch):
  // when the bench sends the SAME identityKeyed/seed it probed with — plus
  // the same anchor URL, characterDescription, tuning, and textLayout — the
  // final book REPLAYS the exact approved probe renders from cache instead
  // of re-rendering twelve new (possibly different) images. Absent both,
  // customer books keep the legacy un-salted keys byte-identical.
  if (body.seed !== undefined && body.seed !== null && !Number.isInteger(body.seed)) {
    return res.status(400).json({ success: false, error: 'seed must be an integer' });
  }
  const storyPair = body.story && body.story.request && body.story.response ? body.story : null;
  if (!storyPair && !body.bookDefinitionId && body.catalogThemeId) {
    // Legacy/admin retry fallback: no chosen story or definition — select the
    // top-fit candidate for the theme deterministically (same seed rules as
    // /v13/select-books) so old rows can always regenerate.
    try {
      const profile = catalogEngine.normalizeProfile(body.profile);
      const selection = catalogEngine.selectBooks({
        profile,
        themeId: body.catalogThemeId,
        ageBand: catalogEngine.ageBandForAge(profile.age),
        sessionId: body.sessionId || bookId,
      });
      body.bookDefinitionId = selection.candidates[0]?.bookId || null;
      console.log(`[v13] ${bookId}: no story/definition — auto-selected ${body.bookDefinitionId} from theme '${body.catalogThemeId}'`);
    } catch (selErr) {
      return res.status(400).json({ success: false, error: `catalogThemeId fallback failed: ${selErr.message}` });
    }
  }
  if (!storyPair && !body.bookDefinitionId) {
    return res.status(400).json({ success: false, error: 'either story {request, response}, bookDefinitionId, or catalogThemeId is required' });
  }
  if (body.bookDefinitionId) {
    const hit = catalogEngine.getBook(body.bookDefinitionId);
    if (!hit) {
      return res.status(400).json({ success: false, error: `unknown catalog book id '${body.bookDefinitionId}'` });
    }
    // A fresh generation must use the band the profile routes to (a stored
    // story pair is exempt here — it re-validates against its own pinned
    // request). The profile normalized above the fallback block.
    if (!storyPair) {
      const profileBand = catalogEngine.ageBandForAge(catalogEngine.normalizeProfile(body.profile).age);
      if (hit.ageBand !== profileBand) {
        return res.status(400).json({ success: false, error: `book '${body.bookDefinitionId}' is age band ${hit.ageBand} but the profile routes to ${profileBand}` });
      }
    }
  }
  if (activeBooks.has(bookId)) {
    return res.status(409).json({ success: false, error: `book ${bookId} is already generating on this instance` });
  }

  res.status(202).json({ success: true, bookId, message: 'accepted', engine: 'catalog-v13' });

  const bookContext = createBookContext(bookId, { progressCallbackUrl });
  const costTracker = new CostTracker();
  const startedAt = Date.now();
  (async () => {
    try {
      if (body.forceNew) await clearCheckpoint(bookId);
      let checkpoint = body.forceNew ? null : await loadCheckpoint(bookId);
      if (checkpoint && checkpoint.engine !== 'catalog-v13') {
        bookContext.log('warn', `Legacy checkpoint (stage ${checkpoint.completedStage || '?'}) predates the catalog engine — restarting fresh`);
        await clearCheckpoint(bookId);
        checkpoint = null;
      }
      reportProgressForce(progressCallbackUrl, { bookId, stage: 'generating', progress: 0.02, message: 'Starting catalog pipeline...', logs: bookContext.logs }).catch(() => {});

      const payload = await runBookPipeline({
        bookId,
        bookDefinitionId: body.bookDefinitionId || null,
        profile: body.profile,
        sessionId: body.sessionId || bookId,
        storyPair,
        writerTuning: body.writerTuning || null,
        illustrationTuning: body.illustrationTuning || null,
        checkpoint,
        saveCheckpoint: cp => saveCheckpoint(bookId, cp),
        approvedCoverUrl: body.approvedCoverUrl || null,
        childPhotoUrl: Array.isArray(body.childPhotoUrls) ? body.childPhotoUrls[0] : null,
        characterDescription: body.characterDescription || null,
        textLayout: normalizeTextLayout(body.textLayout),
        heartfeltNote: body.heartfeltNote || null,
        bookFrom: body.bookFrom || null,
        bindingType: body.bindingType || null,
        forceRerender: !!body.forceRerender,
        identityKeyed: !!body.identityKeyed,
        seed: Number.isInteger(body.seed) ? body.seed : null,
        costTracker,
        onProgress: (stage, frac, message) => {
          bookContext.touchActivity();
          reportProgress(progressCallbackUrl, { bookId, stage, progress: frac, message, logs: bookContext.logs }).catch(() => {});
        },
        log: (level, msg) => bookContext.log(level, msg),
      });

      const completion = {
        success: true,
        bookId,
        ...payload,
        costs: costTracker.getSummary(),
        pipelineVersionUsed: 'catalog-v13',
        illustratorVersionUsed: 'catalog-slim',
        warnings: payload.warnings.length > 0 ? payload.warnings : undefined,
        logs: bookContext.logs,
      };
      if (callbackUrl) await postWithRetry(callbackUrl, completion);
      if (progressCallbackUrl) reportComplete(progressCallbackUrl, completion);
      await clearCheckpoint(bookId);
      console.log(`[server] Book ${bookId} complete in ${Math.round((Date.now() - startedAt) / 1000)}s, cost $${costTracker.getSummary().totalCost?.toFixed?.(4) ?? '?'}`);
    } catch (err) {
      bookContext.log('error', `Book generation failed: ${err.message}`);
      console.error(`[server] Book ${bookId} failed:`, err);
      const failure = {
        success: false,
        bookId,
        error: err.message,
        pipelineVersionUsed: 'catalog-v13',
        ...(err.failureCode ? { failureCode: err.failureCode } : {}),
        ...(err.validationErrors?.length ? { validationErrors: err.validationErrors } : {}),
        // Per-spread render diagnostics (render_failed): which spreads failed
        // and why, attempt by attempt — same shape as the probe callback's
        // failures[].
        ...(err.renderFailures?.length ? { renderFailures: err.renderFailures } : {}),
        // ce-9 graded ship policy (consistency_unresolved): the spreads whose
        // BLOCKING defects survived candidates + repairs, each with its scored
        // candidate renders (signed URLs + storage keys) for the admin's
        // pick-candidate / re-render-spread decision, plus the bible.
        ...(err.unresolved?.length ? { unresolved: err.unresolved } : {}),
        ...(err.qaAdvisories?.length ? { qaAdvisories: err.qaAdvisories } : {}),
        ...(err.bookBible ? { bookBible: err.bookBible } : {}),
        logs: bookContext.logs,
      };
      if (callbackUrl) await postWithRetry(callbackUrl, failure);
      if (progressCallbackUrl) reportError(progressCallbackUrl, { ...failure, stage: 'failed', progress: 0 });
    } finally {
      removeBookContext(bookId);
    }
  })();
});

/**
 * POST a JSON payload with the worker API key and 3 bounded retries — the
 * shared delivery path for completion/failure callbacks. A non-2xx answer
 * counts as a FAILED attempt: fetch resolves on 403/500, and treating those
 * as delivered silently loses the callback (the app-side round then hangs
 * until its stall reconcile) whenever the app hiccups on capture.
 */
async function postWithRetry(url, payload) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY || '' },
        body: JSON.stringify(payload),
        signal: abort.signal,
      });
      if (!res.ok) throw new Error(`callback endpoint answered ${res.status}`);
      return;
    } catch (err) {
      console.error(`[server] callback attempt ${attempt + 1}/3 to ${url} failed: ${err.message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
    } finally {
      clearTimeout(timeout);
    }
  }
  console.error(`[server] callback to ${url} LOST after 3 attempts — the caller must reconcile this run as stalled`);
}

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
  // Embedded-overlay metrics from layout (empty for caption/legacy books) —
  // returned to the caller so re-finalizes surface low-contrast spreads too.
  const finalizeOverlayReport = [];

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
        overlayReport: finalizeOverlayReport,
      });
    }
    bookContext.touchActivity();

    // Upload to GCS
    const pdfPath = `children-jobs/${bookId}/interior.pdf`;
    await uploadBuffer(pdfBuffer, pdfPath, 'application/pdf');
    const pdfUrl = await getSignedUrl(pdfPath, 30 * 24 * 60 * 60 * 1000);

    removeBookContext(bookId);
    res.json({
      success: true,
      bookId,
      interiorPdfUrl: pdfUrl,
      ...(finalizeOverlayReport.length > 0 ? { overlayReport: finalizeOverlayReport, minContrast: OVERLAY.MIN_CONTRAST } : {}),
    });
  } catch (err) {
    removeBookContext(bookId);
    console.error(`[server] Finalize failed for ${bookId}:`, err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /rebuild-cover-pdf — Rebuild cover PDF only (binding-aware) ──
//
// Rebuilds the Lulu wrap-around cover PDF using the exact same pipeline as
// ── POST /v13/set-text-layout — flip caption ↔ embedded on an EXISTING book ──
// Records the layout change on the book's catalog-engine checkpoint so the
// next /generate-book dispatch renders in the new mode. The story is kept;
// renders for the TARGET aspect replay from the aspect-keyed cache (flipping
// back re-renders nothing). Completed books have no checkpoint — the next
// dispatch simply carries the new textLayout in the request.
app.post('/v13/set-text-layout', authenticate, async (req, res) => {
  try {
    const { bookId } = req.body || {};
    const t = String(req.body?.textLayout || '').toLowerCase().trim();
    if (!bookId || !BOOK_ID_RE.test(String(bookId))) {
      return res.status(400).json({ success: false, error: 'invalid bookId' });
    }
    if (!TEXT_LAYOUTS.includes(t)) {
      return res.status(400).json({ success: false, error: `Unsupported textLayout '${req.body?.textLayout}' — expected 'caption', 'half', or 'embedded'` });
    }
    const checkpoint = await loadCheckpoint(bookId);
    if (!checkpoint || checkpoint.engine !== 'catalog-v13') {
      return res.json({ success: true, bookId, textLayout: t, changed: false, checkpoint: false, next: 'redispatch_generate_book' });
    }
    const current = checkpoint.textLayout || 'caption';
    if (current === t) {
      return res.json({ success: true, bookId, textLayout: t, changed: false, checkpoint: true });
    }
    const next = {
      ...checkpoint,
      textLayout: t,
      completedStage: 'story',
      textLayoutChange: { from: current, to: t, at: new Date().toISOString() },
    };
    delete next.renderKeys;
    await saveCheckpoint(bookId, next);
    console.log(`[v13] ${bookId} textLayout ${current} → ${t}`);
    res.json({ success: true, bookId, textLayout: t, changed: true, checkpoint: true, next: 'redispatch_generate_book' });
  } catch (err) {
    console.error('[v13] set-text-layout failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /v13/preview/embedded-overlay — pre-print QA preview (admin) ──
// Renders the ACTUAL embedded-overlay PDF pages (same layout code path that
// ships) plus per-spread overlay metrics. Entries come from the request —
// the main app persists them from the completion callback's storyContent.
app.post('/v13/preview/embedded-overlay', authenticate, async (req, res) => {
  const { bookId, bookFormat } = req.body || {};
  if (!bookId || !BOOK_ID_RE.test(String(bookId))) {
    return res.status(400).json({ success: false, error: 'invalid bookId' });
  }
  try {
    const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
    const embedded = entries.filter((e) => (!e.type || e.type === 'spread')
      && e.textLayout === 'embedded'
      && e.captionText !== undefined);
    if (embedded.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'no embedded-mode spread entries found — pass storyContent.entries, or the book is laid out in caption mode',
      });
    }
    const resolved = [];
    for (const e of embedded) {
      const src = e.spreadIllustrationStorageKey || e.spreadIllustrationUrl || null;
      let buffer = null;
      if (src) {
        try { buffer = await downloadBuffer(src); }
        catch (err) { console.warn(`[v13-preview] spread ${e.spread}: art download failed (${err.message}) — previewing overlay geometry only`); }
      }
      resolved.push({
        type: 'spread',
        spread: e.spread,
        textLayout: 'embedded',
        textZone: e.textZone || 'left-top',
        heroBox: e.heroBox || null,
        figuresBox: e.figuresBox || null,
        captionText: e.captionText || '',
        // Art with Gemini-painted text must preview WITHOUT the typeset
        // overlay — same rule the shipping layout follows.
        textEmbeddedInArt: !!e.textEmbeddedInArt,
        spreadIllustrationBuffer: buffer,
      });
    }
    const { buffer, report } = await buildEmbeddedPreviewPdf(resolved, bookFormat || 'picture_book');
    const previewPath = `children-jobs/${bookId}/previews/embedded-overlay-${Date.now()}.pdf`;
    await uploadBuffer(buffer, previewPath, 'application/pdf');
    const previewPdfUrl = await getSignedUrl(previewPath, 7 * 24 * 60 * 60 * 1000);
    res.json({ success: true, bookId, previewPdfUrl, minContrast: OVERLAY.MIN_CONTRAST, spreads: report });
  } catch (err) {
    console.error(`[v13-preview] embedded overlay preview failed for ${bookId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
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

// ── POST /get-spread-data — 410 GONE (catalog-engine cutover) ──
// The catalog engine's checkpoints store the story, not per-spread scene
// prompts; per-spread regeneration is driven by the admin re-dispatching
// /generate-book with forceRerender.
app.post('/get-spread-data', authenticate, (req, res) => {
  res.status(410).json({
    success: false,
    error: 'GONE: /get-spread-data was removed in the catalog-engine cutover.',
  });
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
    const { assertLlmConfig } = require('./services/shared/llm/openaiClient');
    assertLlmConfig({ require: ['OPENAI_API_KEY'] });
  } catch (e) {
    console.error(`[LLM_CONFIG] startup check threw: ${e.message}`);
  }
  // Catalog + approved sidecars must validate at boot: an invalid catalog or
  // sidecar set fails the revision instead of 202-ing books it cannot build.
  try {
    catalogEngine.assertCatalogEngine();
  } catch (e) {
    console.error(`[startup] CATALOG INVALID — refusing to start: ${e.message}`);
    process.exit(1);
  }
  // Restore the active catalog overlay (if any) BEFORE serving: fail-safe —
  // any overlay problem logs loudly and the base catalog serves instead.
  catalogEngine.initCatalogOverlay()
    .catch(e => console.error(`[startup] catalog overlay init failed: ${e.message} — serving the base catalog`))
    .finally(() => {
      // Cloud Run runs many warm instances but only the one that served an
      // activate/deactivate call hot-swaps immediately — the pointer watch
      // converges every other instance within the poll interval.
      catalogEngine.startCatalogOverlayWatch();
      app.listen(PORT, () => {
        console.log(`giftmybook-children-worker listening on port ${PORT}`);
      });
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
