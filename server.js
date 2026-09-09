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
const { deliverBookCompletion } = require('./services/deliverBookCompletion');
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
// Generic worker authentication alone cannot authorize a reviewed recheck.
// The signed app attestation binds the active admin, book, exact saved
// request and the explicitly configured Gemini 2.5 Pro destination.
app.post('/v13/review-visual-check', authenticate, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    return res.json(await require('./services/shared/llm/visualReview').handleReview(req.body?.approval));
  } catch {
    return res.status(403).json({ success: false, error: 'Valid admin approval for this evidence and Gemini 2.5 Pro is required' });
  }
});

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
  const upsellOffer = req.body?.upsellOffer;
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
  if (upsellOffer && (bookIds.length !== 1 || bookIds[0] !== 'printed-upsell')) {
    return res.status(400).json({ success: false, error: 'A printed offer generates exactly one story' });
  }
  for (const id of upsellOffer ? [] : bookIds) {
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
      const { stories, failures } = upsellOffer ? {
        stories: [await require('./services/catalogEngine/upsellOffer').generateOfferStory({
          ...upsellOffer, profile, themeId: req.body.catalogThemeId,
          sessionId: sessionId || bookId, tuning: req.body?.writerTuning || null,
          // The outline call plus up to 3 attempts + 2 repairs + polish can
          // outlast the per-book idle window; every model call is a heartbeat.
          onProgress: () => storiesContext.touchActivity(),
        })], failures: [],
      } : await catalogEngine.generateStories({
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
          success: false, bookId, engine: 'catalog-v13', ...(dispatchId ? { dispatchId } : {}), stories: [],
          failures: [{ bookId: err.bookId || null, message: err.message, errors: err.validationErrors || [] }],
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
        // 2026-09-07: the shipped pixel size (null when unreadable) — the
        // bench must be able to SEE a render that came back below 4K.
        size: r.size || null,
        // pq-1: the print-crop preview (trim / safety / fold guides) — the
        // bench judges what prints, not the raw 16:9 frame.
        printPreviewUrl: r.printPreviewUrl || null,
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
    const status = err.recovery || err.failureCode === 'identity_kit_failed' ? 422 : (err.failureCode === 'missing_identity_reference' ? 400 : 500);
    return res.status(status).json({
      success: false, bookId, error: err.message,
      failureCode: err.failureCode || null,
      ...(err.recovery ? { recovery: err.recovery } : {}),
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

// POST /v13/generate-video — the GIFT VIDEO (gv-2, docs/GIFT_VIDEO_PLAN.md
// revision 4): a 10-second, text-free, fully animated film of a finished
// book as ONE continuous take — the still-selection gate first judges every
// shipped render and picks the best three COMPLETE pictures (no painted
// text, no side reserved for a text panel, no band, the child fully in
// frame), then one image-to-video clip carries the child through them
// (start frame = the first pick, end frame = the last, the camera angle
// changing per act), identity pinned by the Book Bible's character sheet
// as the video model's reference and verified per clip, finished by ffmpeg.
// 202 + callback like /v13/render-spreads: every validation happens BEFORE
// the 202 (the app's render KEYS are validated as canonical keys of THIS
// book; a story pair is re-validated; the provider/model must be enabled);
// the run registers a book context so the idle watchdog sees a job that
// polls a vendor for minutes. A take whose candidates all fail
// verification fails the film `video_unresolved` with the scored candidates
// attached — never a silent degrade to stills.
// Capability handshake prevents a newer app from dispatching a full story to a
// legacy worker that would silently ignore `mode` and return a ten-second trailer.
app.post('/v13/video-capabilities', authenticate, (req, res) => {
  res.json({ success: true, modes: catalogEngine.flags.giftVideoEnabled() ? ['trailer', 'full-story'] : [], fullStoryVideoVersion: catalogEngine.versions.FULL_STORY_VIDEO_VERSION });
});

app.post('/v13/generate-video', authenticate, async (req, res) => {
  if (!catalogEngine.flags.giftVideoEnabled()) {
    return res.status(503).json({ success: false, error: 'the gift video is disabled on this revision (CATALOG_GIFT_VIDEO=0)', failureCode: 'gift_video_disabled' });
  }
  const body = req.body || {};
  const mode = body.mode || 'trailer';
  if (!['trailer', 'full-story'].includes(mode)) return res.status(400).json({ success: false, error: 'mode must be trailer or full-story' });
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
  const providerPick = resolveProvider({ provider: body.provider || null, model: body.model || (mode === 'full-story' ? 'kwaivgi/kling-v3-omni-video' : null) });
  if (!providerPick.ok) {
    return res.status(400).json({ success: false, error: providerPick.error, failureCode: 'video_provider_unavailable' });
  }
  const aspect = body.aspect === undefined || body.aspect === null ? '16:9' : body.aspect;
  if (aspect !== '16:9' && aspect !== '9:16') {
    return res.status(400).json({ success: false, error: "aspect must be '16:9' or '9:16'" });
  }
  const music = body.music === undefined || body.music === null ? (mode === 'full-story' ? 'story-score' : catalogEngine.flags.videoMusic()) : body.music;
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
  if (mode === 'full-story') {
    try {
      require('./services/catalogEngine/video/fullStory').validateFullStoryInput({
        bookId, story: story.response, renders: rendersCheck.entries, model: providerPick.model,
        language: body.language || 'en', voiceProvider: body.voiceProvider,
        injectedKeys: body, music,
      });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message, failureCode: err.failureCode });
    }
  }
  if (activeBooks.has(`video:${bookId}`)) return res.status(409).json({ success: false, error: 'A video run is already active for this book.', failureCode: 'in_flight' });
  const videoVersion = mode === 'full-story' ? catalogEngine.versions.FULL_STORY_VIDEO_VERSION : catalogEngine.versions.VIDEO_VERSION;
  res.status(202).json({
    success: true, bookId, mode, ...(dispatchId ? { dispatchId } : {}), engine: 'catalog-v13', videoVersion,
    provider: providerPick.provider, model: providerPick.model,
    accepted: { spreads: rendersCheck.entries.map(e => e.spread) },
  });

  const costTracker = new CostTracker();
  const mapKey = `video:${bookId}`;
  const ctx = createBookContext(bookId, { mapKey, callbackUrl, progressCallbackUrl: progressCallbackUrl || null });
  (async () => {
    const started = Date.now();
    const stable = { bookId, mode, ...(dispatchId ? { dispatchId } : {}), engine: 'catalog-v13', videoVersion, provider: providerPick.provider, model: providerPick.model };
    let payload;
    try {
      const generateGiftVideo = mode === 'full-story' ? require('./services/catalogEngine/video/fullStory').generateFullStoryFilm : require('./services/catalogEngine/video').generateGiftVideo;
      const r = await generateGiftVideo({
        bookId,
        language: body.language || 'en',
        voiceProvider: body.voiceProvider || null,
        injectedKeys: body,
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
        video: r.video, cast: r.cast || [], language: r.language || null, plan: r.plan, stills: r.stills || [], textGate: r.textGate, bookBible: r.bookBible,
        unresolved: r.unresolved || [], advisories: r.advisories, warnings: r.warnings,
        costs: costTracker.getSummary(), failureCode: null, error: null,
      };
      console.log(`[v13] generate-video for ${bookId}: ${r.video.cached ? 'replayed' : 'built'} ${r.video.durationSeconds}s in ${Date.now() - started}ms`);
    } catch (err) {
      console.error(`[v13] generate-video failed for ${bookId}:`, err.message);
      const d = err.details || {};
      payload = {
        success: false, ...stable,
        video: null, plan: d.plan || [], stills: d.stills || [], textGate: d.textGate || [], bookBible: d.bookBible || null,
        unresolved: d.unresolved || [], recovery: err.recovery || d.recovery || null, advisories: d.advisories || [], warnings: d.warnings || [],
        costs: costTracker.getSummary(), failureCode: err.failureCode || null, error: err.message,
      };
    } finally {
      removeBookContext(mapKey);
    }
    await postWithRetry(callbackUrl, payload);
  })();
});

// POST /v13/pick-clip — promote one scored candidate clip (from a
// video_unresolved failure payload) to the take's canonical clip key
// with an admin-vouched marker, so the next /v13/generate-video dispatch
// (no forceNew) replays it and only re-finishes the film (gv-1, mirrors
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

// ── POST /v13/generate-coloring-book — the coloring book (cb-1,
// docs/COLORING_BOOK_V2_PLAN.md): companion scenes from the story world
// authored from the catalog as a closed grammar of "beside-the-story" kinds,
// drawn as verified LINE ART starring the book's own hero (identity through
// the Book Bible as line-art model sheets), every page judged + measured,
// selected among candidates, repaired within a budget, failed closed
// (`coloring_unresolved` with the scored candidates attached), typeset for
// Lulu (saddle-stitch 8.5×11, preflighted) with a cover built from the
// approved cover's OWN pixels. 202 + callback; every callback key present on
// failure. Replaces the deleted /generate-coloring-book.
app.post('/v13/generate-coloring-book', authenticate, async (req, res) => {
  if (!catalogEngine.flags.coloringBookEnabled()) {
    return res.status(503).json({ success: false, error: 'the coloring book is disabled on this revision (CATALOG_COLORING_BOOK=0)', failureCode: 'coloring_disabled' });
  }
  const body = req.body || {};
  const { bookId, callbackUrl, progressCallbackUrl, dispatchId } = body;
  if (!bookId || !BOOK_ID_RE.test(String(bookId))) {
    return res.status(400).json({ success: false, error: 'invalid bookId' });
  }
  if (!callbackUrl) {
    return res.status(400).json({ success: false, error: 'callbackUrl is required — the coloring book is delivered by callback only' });
  }
  if (dispatchId !== undefined && dispatchId !== null && (typeof dispatchId !== 'string' || dispatchId.length > 128)) {
    return res.status(400).json({ success: false, error: 'dispatchId must be a string' });
  }
  let profile;
  try {
    profile = catalogEngine.normalizeProfile(body.profile);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  const storyPair = body.story && body.story.request && body.story.response ? body.story : null;
  if (!storyPair) {
    return res.status(400).json({ success: false, error: 'story {request, response} is required — the coloring book draws beside an existing validated story, never a fresh one' });
  }
  const { MIN_PAGES, MAX_PAGES, PAGES_BY_BAND } = require('./services/catalogEngine/coloring/plan');
  if (body.pageCount !== undefined && body.pageCount !== null && (!Number.isInteger(body.pageCount) || body.pageCount < MIN_PAGES || body.pageCount > MAX_PAGES)) {
    return res.status(400).json({ success: false, error: `pageCount must be an integer between ${MIN_PAGES} and ${MAX_PAGES}` });
  }
  if (body.pages !== undefined && body.pages !== null) {
    const ok = Array.isArray(body.pages) && body.pages.length > 0 && body.pages.length <= MAX_PAGES
      && body.pages.every(n => Number.isInteger(n) && n >= 1 && n <= MAX_PAGES) && new Set(body.pages).size === body.pages.length;
    if (!ok) return res.status(400).json({ success: false, error: `pages must be a unique list of page indices between 1 and ${MAX_PAGES}` });
  }
  const isHttp = u => typeof u === 'string' && /^https?:\/\//i.test(u);
  const approvedCoverUrl = isHttp(body.approvedCoverUrl) ? body.approvedCoverUrl : null;
  const childPhotoUrl = Array.isArray(body.childPhotoUrls) ? body.childPhotoUrls.find(isHttp) || null : null;
  if (!approvedCoverUrl && !childPhotoUrl) {
    return res.status(400).json({ success: false, error: 'no approvedCoverUrl and no childPhotoUrls — the pages would have no identity reference', failureCode: 'missing_identity_reference' });
  }
  let story;
  try {
    story = await resolveStory({
      storyPair, checkpointStory: null, bookDefinitionId: null, profile,
      sessionId: body.sessionId || bookId,
      log: (level, msg) => console.log(`[coloring:${bookId}] ${msg}`),
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message, failureCode: err.failureCode || 'invalid_story' });
  }
  const coloringBookDef = await catalogEngine.getBookForTag(story.request.book_id, story.request?.versions?.catalog);
  if (!coloringBookDef) {
    return res.status(400).json({ success: false, error: `story pins catalog '${story.request?.versions?.catalog}' which is no longer resolvable — regenerate the story`, failureCode: 'missing_book_definition' });
  }
  const coloringKey = coloringActiveJobKey(bookId);
  if (activeBooks.has(coloringKey)) {
    return res.status(409).json({ success: false, error: 'a coloring book run is already in progress for this bookId', failureCode: 'in_flight' });
  }
  const coloringVersion = catalogEngine.versions.COLORING_VERSION;
  const qaVersion = catalogEngine.versions.COLORING_QA_VERSION;
  const plannedPages = Number.isInteger(body.pageCount) ? body.pageCount : (catalogEngine.flags.coloringPages() || PAGES_BY_BAND[coloringBookDef.ageBand] || PAGES_BY_BAND['4-5']);
  res.status(202).json({
    success: true, bookId, ...(dispatchId ? { dispatchId } : {}), engine: 'catalog-v13', coloringVersion,
    plan: { band: coloringBookDef.ageBand, pages: plannedPages },
  });

  const costTracker = new CostTracker();
  const ctx = createBookContext(bookId, { mapKey: coloringKey, callbackUrl, progressCallbackUrl: progressCallbackUrl || null });
  const absoluteTimer = setTimeout(() => {
    console.error(`[coloring:${bookId}] hit the absolute timeout (${catalogEngine.flags.coloringTimeoutMinutes()} min) — aborting`);
    ctx.abortController.abort();
  }, catalogEngine.flags.coloringTimeoutMinutes() * 60 * 1000);
  (async () => {
    const started = Date.now();
    const stable = { bookId, ...(dispatchId ? { dispatchId } : {}), engine: 'catalog-v13', coloringVersion, qaVersion };
    let payload;
    try {
      const { generateColoringBook } = require('./services/catalogEngine/coloring');
      const r = await generateColoringBook({
        bookId,
        story: story.response,
        bookDef: coloringBookDef,
        profile,
        approvedCoverUrl,
        childPhotoUrl,
        characterDescription: typeof body.characterDescription === 'string' ? body.characterDescription : null,
        pageCount: Number.isInteger(body.pageCount) ? body.pageCount : undefined,
        pages: Array.isArray(body.pages) ? body.pages : undefined,
        forceNew: !!body.forceNew,
        costTracker,
        onProgress: (fraction, message) => {
          ctx.touchActivity();
          if (progressCallbackUrl) {
            reportProgress(progressCallbackUrl, { bookId, stage: 'coloring', progress: Math.round(Math.max(0, Math.min(1, fraction)) * 100), message, ...(dispatchId ? { dispatchId } : {}) }).catch(() => {});
          }
        },
        touch: () => ctx.touchActivity(),
        abortSignal: ctx.abortSignal,
        log: (level, msg) => ctx.log(level, msg),
      });
      payload = {
        success: true, ...stable, planHash: r.planHash, cached: !!r.cached,
        interiorPdfUrl: r.interiorPdfUrl, coverPdfUrl: r.coverPdfUrl, coverImageUrl: r.coverImageUrl, previewImageUrls: r.previewImageUrls || [],
        pageCount: r.pageCount, coloringPageCount: r.coloringPageCount, pages: r.pages, plan: r.plan, bookBible: r.bookBible,
        gates: r.gates, unresolved: r.unresolved || [], preflight: r.preflight || null, ...(r.subset ? { subset: true } : {}),
        advisories: r.advisories, warnings: r.warnings, costs: costTracker.getSummary(), elapsedMs: Date.now() - started, failureCode: null, error: null,
      };
      console.log(`[v13] generate-coloring-book for ${bookId}: ${r.cached ? 'replayed' : 'built'} ${r.coloringPageCount} pages in ${Date.now() - started}ms`);
    } catch (err) {
      console.error(`[v13] generate-coloring-book failed for ${bookId}:`, err.message);
      const d = err.details || {};
      payload = {
        success: false, ...stable, planHash: d.planHash || null, cached: false,
        interiorPdfUrl: null, coverPdfUrl: null, coverImageUrl: null, previewImageUrls: [],
        pageCount: null, coloringPageCount: null, pages: d.pages || [], plan: d.plan || null, bookBible: d.bookBible || null,
        gates: d.gates || { contact: null, stroke: null }, unresolved: d.unresolved || [], preflight: d.preflight || null,
        advisories: d.advisories || [], warnings: d.warnings || [], costs: costTracker.getSummary(), elapsedMs: Date.now() - started,
        failureCode: err.failureCode || null, error: err.message, cancelled: err.failureCode === 'cancelled' || ctx.abortSignal.aborted,
      };
    } finally {
      clearTimeout(absoluteTimer);
      removeBookContext(coloringKey);
    }
    await postWithRetry(callbackUrl, payload);
  })();
});

// POST /v13/pick-coloring-candidate — promote one scored candidate page
// (from a coloring_unresolved failure payload) to its canonical key with an
// admin-vouched marker, so the next /v13/generate-coloring-book dispatch (no
// forceNew) replays it into the PDFs (cb-1, mirrors /v13/pick-candidate).
app.post('/v13/pick-coloring-candidate', authenticate, async (req, res) => {
  if (!catalogEngine.flags.coloringBookEnabled()) {
    return res.status(503).json({ success: false, error: 'the coloring book is disabled on this revision (CATALOG_COLORING_BOOK=0)', failureCode: 'coloring_disabled' });
  }
  const body = req.body || {};
  const { bookId, storageKey } = body;
  if (!bookId || !BOOK_ID_RE.test(String(bookId))) {
    return res.status(400).json({ success: false, error: 'invalid bookId' });
  }
  if (typeof storageKey !== 'string' || storageKey.length > 512) {
    return res.status(400).json({ success: false, error: 'storageKey (a candidate page key of this book) is required' });
  }
  try {
    const { pickColoringCandidate } = require('./services/catalogEngine/coloring/candidates');
    const r = await pickColoringCandidate({ bookId, candidateKey: storageKey, log: (level, msg) => console.log(`[pickColoringCandidate:${bookId}] ${msg}`) });
    return res.json({ success: true, bookId, page: r.page, storageKey: r.storageKey, renderHash: r.renderHash });
  } catch (err) {
    console.error(`[pickColoringCandidate:${bookId}] failed:`, err.message);
    return res.status(err.statusCode || 500).json({ success: false, bookId, error: err.message });
  }
});

// POST /v13/cancel-coloring-book — abort an in-flight coloring run (cb-1).
app.post('/v13/cancel-coloring-book', authenticate, (req, res) => {
  const { bookId } = req.body || {};
  if (!bookId || !BOOK_ID_RE.test(String(bookId))) {
    return res.status(400).json({ success: false, error: 'invalid bookId' });
  }
  const ctx = activeBooks.get(coloringActiveJobKey(bookId));
  if (!ctx) {
    return res.status(404).json({ success: false, error: 'No active coloring book run found for this bookId' });
  }
  console.log(`[v13] cancel-coloring-book: aborting bookId=${bookId}`);
  ctx.abortController.abort();
  return res.json({ success: true, bookId, message: 'Cancellation signal sent' });
});

// ── Audiobook (ab-1 — docs/AUDIOBOOK_V2_PLAN.md) ─────────────────────────
// The performed read-aloud of one finished V1.3 story with a per-theme
// score and sound design: POST /v13/generate-audiobook (202 + callback),
// POST /v13/audiobook-audition (sync: one spread on a cast),
// POST /v13/pick-take (the audiobook_unresolved remedy) and
// POST /v13/cancel-audiobook. Every validation happens BEFORE the 202; the
// callback payload carries every key on success and on failure.

/** @param {string} bookId @returns {string} the watchdog map key of an audiobook run */
function audiobookActiveJobKey(bookId) {
  return `audiobook:${bookId}`;
}

const AUDIO_LANGUAGES = ['en', 'es', 'he'];
const AUDIO_SPREAD_MAX = 12;

/**
 * Validate the shared audiobook request fields (story, profile, language,
 * cast, dedication, tuning). Returns `{error, failureCode}` or the resolved
 * inputs.
 * @param {object} body
 * @returns {Promise<object>}
 */
async function resolveAudiobookInputs(body) {
  let profile;
  try {
    profile = catalogEngine.normalizeProfile(body.profile);
  } catch (err) {
    return { error: err.message };
  }
  const storyPair = body.story && body.story.request && body.story.response ? body.story : null;
  if (!storyPair) return { error: 'story {request, response} is required — the audiobook reads an existing validated story, never a fresh one' };
  if (body.language !== undefined && body.language !== null && !AUDIO_LANGUAGES.includes(body.language)) return { error: `language must be one of ${AUDIO_LANGUAGES.join(', ')}` };
  const cast = body.cast && typeof body.cast === 'object' && !Array.isArray(body.cast) ? body.cast : {};
  for (const k of ['narrator', 'companion']) {
    if (cast[k] !== undefined && cast[k] !== null && (typeof cast[k] !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(cast[k]))) return { error: `cast.${k} must be a voice key` };
  }
  let dedication = null;
  if (body.dedication && typeof body.dedication === 'object') {
    const text = typeof body.dedication.text === 'string' ? body.dedication.text.trim().slice(0, 1200) : '';
    const from = typeof body.dedication.from === 'string' ? body.dedication.from.trim().slice(0, 80) : '';
    if (text) dedication = { text, from };
  }
  if (body.audioTuning !== undefined && body.audioTuning !== null && (typeof body.audioTuning !== 'object' || Array.isArray(body.audioTuning))) return { error: 'audioTuning must be an object {versionLabel, hash, text}' };
  let story;
  try {
    story = await resolveStory({ storyPair, checkpointStory: null, bookDefinitionId: null, profile, sessionId: body.sessionId || body.bookId, log: (level, msg) => console.log(`[audiobook:${body.bookId}] ${msg}`) });
  } catch (err) {
    return { error: err.message, failureCode: err.failureCode || 'invalid_story' };
  }
  const bookDef = await catalogEngine.getBookForTag(story.request.book_id, story.request?.versions?.catalog);
  if (!bookDef) return { error: `story pins catalog '${story.request?.versions?.catalog}' which is no longer resolvable — regenerate the story`, failureCode: 'missing_book_definition' };
  return { profile, story, bookDef, cast: { narrator: cast.narrator || undefined, companion: cast.companion || undefined }, dedication, language: body.language || 'en', audioTuning: body.audioTuning || null };
}

app.post('/v13/generate-audiobook', authenticate, async (req, res) => {
  if (!catalogEngine.flags.audiobookEnabled()) {
    return res.status(503).json({ success: false, error: 'the audiobook is disabled on this revision (CATALOG_AUDIOBOOK=0)', failureCode: 'audiobook_disabled' });
  }
  const body = req.body || {};
  const { bookId, callbackUrl, progressCallbackUrl, dispatchId } = body;
  if (!bookId || !BOOK_ID_RE.test(String(bookId))) return res.status(400).json({ success: false, error: 'invalid bookId' });
  if (!callbackUrl) return res.status(400).json({ success: false, error: 'callbackUrl is required — the audiobook is delivered by callback only' });
  if (dispatchId !== undefined && dispatchId !== null && (typeof dispatchId !== 'string' || dispatchId.length > 128)) return res.status(400).json({ success: false, error: 'dispatchId must be a string' });
  const subsetOk = list => Array.isArray(list) && list.length > 0 && list.length <= AUDIO_SPREAD_MAX && list.every(n => Number.isInteger(n) && n >= 1 && n <= AUDIO_SPREAD_MAX) && new Set(list).size === list.length;
  if (body.segments !== undefined && body.segments !== null && !subsetOk(body.segments)) return res.status(400).json({ success: false, error: `segments must be a unique list of spread numbers between 1 and ${AUDIO_SPREAD_MAX}` });
  if (body.forceRetake !== undefined && body.forceRetake !== null && !subsetOk(body.forceRetake)) return res.status(400).json({ success: false, error: `forceRetake must be a unique list of spread numbers between 1 and ${AUDIO_SPREAD_MAX}` });
  const inputs = await resolveAudiobookInputs(body);
  if (inputs.error) return res.status(400).json({ success: false, error: inputs.error, ...(inputs.failureCode ? { failureCode: inputs.failureCode } : {}) });
  const jobKey = audiobookActiveJobKey(bookId);
  if (activeBooks.has(jobKey)) return res.status(409).json({ success: false, error: 'an audiobook run is already in progress for this bookId', failureCode: 'in_flight' });
  const audioVersion = catalogEngine.versions.AUDIO_VERSION;
  const qaVersion = catalogEngine.versions.AUDIO_QA_VERSION;
  res.status(202).json({
    success: true, bookId, ...(dispatchId ? { dispatchId } : {}), engine: 'catalog-v13', audioVersion,
    cast: inputs.cast, language: inputs.language, accepted: { segments: Array.isArray(body.segments) ? body.segments : inputs.bookDef.book.beats.map(b => b.spread) },
  });

  const costTracker = new CostTracker();
  const ctx = createBookContext(bookId, { mapKey: jobKey, callbackUrl, progressCallbackUrl: progressCallbackUrl || null });
  const absoluteTimer = setTimeout(() => {
    console.error(`[audiobook:${bookId}] hit the absolute timeout (${catalogEngine.flags.audioTimeoutMinutes()} min) — aborting`);
    ctx.abortController.abort();
  }, catalogEngine.flags.audioTimeoutMinutes() * 60 * 1000);
  (async () => {
    const started = Date.now();
    const stable = { bookId, ...(dispatchId ? { dispatchId } : {}), engine: 'catalog-v13', audioVersion, qaVersion };
    const empty = { cached: false, audiobookUrl: null, storageKey: null, timelineUrl: null, timeline: null, durationSeconds: null, bytes: null, loudness: null, cast: null, script: null, audioTuningUsed: 'none', language: inputs.language, pronunciations: [], segments: [], music: null, sfx: null, ambience: null, gates: null, unresolved: [], advisories: [], warnings: [] };
    let payload;
    try {
      const { generateAudiobook } = require('./services/catalogEngine/audio');
      const r = await generateAudiobook({
        bookId, story: inputs.story.response, bookDef: inputs.bookDef, profile: inputs.profile,
        language: inputs.language, cast: inputs.cast, dedication: inputs.dedication, audioTuning: inputs.audioTuning,
        segments: Array.isArray(body.segments) ? body.segments : undefined, forceRetake: Array.isArray(body.forceRetake) ? body.forceRetake : undefined, forceNew: !!body.forceNew,
        injectedKeys: { ELEVENLABS_API_KEY: typeof body.ELEVENLABS_API_KEY === 'string' ? body.ELEVENLABS_API_KEY : null, apiKeys: body.apiKeys && typeof body.apiKeys === 'object' ? body.apiKeys : {} },
        costTracker,
        onProgress: (fraction, message) => {
          ctx.touchActivity();
          if (progressCallbackUrl) {
            reportProgress(progressCallbackUrl, { bookId, stage: 'audiobook', progress: Math.round(Math.max(0, Math.min(1, fraction)) * 100), message, ...(dispatchId ? { dispatchId } : {}) }).catch(() => {});
          }
        },
        touch: () => ctx.touchActivity(),
        abortSignal: ctx.abortSignal,
        log: (level, msg) => ctx.log(level, msg),
      });
      const { cached, ...rest } = r;
      payload = { success: true, ...stable, ...empty, ...rest, cached: !!cached, ...(r.subset ? { subset: true } : {}), costs: costTracker.getSummary(), elapsedMs: Date.now() - started, failureCode: null, error: null };
      console.log(`[v13] generate-audiobook for ${bookId}: ${r.cached ? 'replayed' : 'built'}${r.durationSeconds ? ` ${Math.round(r.durationSeconds)}s` : ' (takes only)'} in ${Date.now() - started}ms`);
    } catch (err) {
      console.error(`[v13] generate-audiobook failed for ${bookId}:`, err.message);
      const d = err.details || {};
      payload = { success: false, ...stable, ...empty, ...d, cached: false, costs: costTracker.getSummary(), elapsedMs: Date.now() - started, failureCode: err.failureCode || null, error: err.message, cancelled: err.failureCode === 'cancelled' || ctx.abortSignal.aborted };
    } finally {
      clearTimeout(absoluteTimer);
      removeBookContext(jobKey);
    }
    await postWithRetry(callbackUrl, payload);
  })();
});

// POST /v13/audiobook-audition — one spread through the full take path on a
// cast (sync): the Audio Bench's voice picker.
app.post('/v13/audiobook-audition', authenticate, async (req, res) => {
  if (!catalogEngine.flags.audiobookEnabled()) {
    return res.status(503).json({ success: false, error: 'the audiobook is disabled on this revision (CATALOG_AUDIOBOOK=0)', failureCode: 'audiobook_disabled' });
  }
  const body = req.body || {};
  const { bookId } = body;
  if (!bookId || !BOOK_ID_RE.test(String(bookId))) return res.status(400).json({ success: false, error: 'invalid bookId' });
  if (body.spread !== undefined && body.spread !== null && (!Number.isInteger(body.spread) || body.spread < 1 || body.spread > AUDIO_SPREAD_MAX)) return res.status(400).json({ success: false, error: `spread must be an integer between 1 and ${AUDIO_SPREAD_MAX}` });
  const inputs = await resolveAudiobookInputs(body);
  if (inputs.error) return res.status(400).json({ success: false, error: inputs.error, ...(inputs.failureCode ? { failureCode: inputs.failureCode } : {}) });
  const costTracker = new CostTracker();
  const started = Date.now();
  try {
    const { auditionAudiobook } = require('./services/catalogEngine/audio');
    const r = await auditionAudiobook({
      bookId, story: inputs.story.response, bookDef: inputs.bookDef, profile: inputs.profile, language: inputs.language, cast: inputs.cast,
      spread: Number.isInteger(body.spread) ? body.spread : 1, forceNew: !!body.forceNew,
      injectedKeys: { ELEVENLABS_API_KEY: typeof body.ELEVENLABS_API_KEY === 'string' ? body.ELEVENLABS_API_KEY : null, apiKeys: body.apiKeys && typeof body.apiKeys === 'object' ? body.apiKeys : {} },
      costTracker, log: (level, msg) => console.log(`[audition:${bookId}] ${msg}`),
    });
    return res.json({ success: true, bookId, audioVersion: catalogEngine.versions.AUDIO_VERSION, ...r, costs: costTracker.getSummary(), elapsedMs: Date.now() - started });
  } catch (err) {
    console.error(`[v13] audiobook-audition failed for ${bookId}:`, err.message);
    return res.status(err.failureCode === 'audiobook_provider_unavailable' ? 503 : 500).json({ success: false, bookId, error: err.message, failureCode: err.failureCode || null, costs: costTracker.getSummary() });
  }
});

// POST /v13/pick-take — promote one scored candidate take (from an
// audiobook_unresolved failure payload) to its canonical key with an
// admin-vouched marker, so the next /v13/generate-audiobook dispatch (no
// forceNew) replays it into the mix (mirrors /v13/pick-candidate).
app.post('/v13/pick-take', authenticate, async (req, res) => {
  if (!catalogEngine.flags.audiobookEnabled()) {
    return res.status(503).json({ success: false, error: 'the audiobook is disabled on this revision (CATALOG_AUDIOBOOK=0)', failureCode: 'audiobook_disabled' });
  }
  const body = req.body || {};
  const { bookId, storageKey } = body;
  if (!bookId || !BOOK_ID_RE.test(String(bookId))) return res.status(400).json({ success: false, error: 'invalid bookId' });
  if (typeof storageKey !== 'string' || storageKey.length > 512) return res.status(400).json({ success: false, error: 'storageKey (a candidate take key of this book) is required' });
  try {
    const { pickTake } = require('./services/catalogEngine/audio/candidates');
    const r = await pickTake({ bookId, candidateKey: storageKey, log: (level, msg) => console.log(`[pickTake:${bookId}] ${msg}`) });
    return res.json({ success: true, bookId, ...r });
  } catch (err) {
    console.error(`[pickTake:${bookId}] failed:`, err.message);
    return res.status(err.statusCode || 500).json({ success: false, bookId, error: err.message });
  }
});

// POST /v13/cancel-audiobook — abort an in-flight audiobook run.
app.post('/v13/cancel-audiobook', authenticate, (req, res) => {
  const { bookId } = req.body || {};
  if (!bookId || !BOOK_ID_RE.test(String(bookId))) return res.status(400).json({ success: false, error: 'invalid bookId' });
  const ctx = activeBooks.get(audiobookActiveJobKey(bookId));
  if (!ctx) return res.status(404).json({ success: false, error: 'No active audiobook run found for this bookId' });
  console.log(`[v13] cancel-audiobook: aborting bookId=${bookId}`);
  ctx.abortController.abort();
  return res.json({ success: true, bookId, message: 'Cancellation signal sent' });
});

// GET /v13/audiobook-cast — the cast vocabulary (narrator + companion voice
// keys with labels) and the worker's recommended default for a theme/band,
// so the app's Audio Bench offers exactly the voices this revision can
// perform (the app never duplicates cast.json).
app.get('/v13/audiobook-cast', authenticate, (req, res) => {
  try {
    const cast = require('./services/catalogEngine/audio/cast');
    const themeId = typeof req.query.themeId === 'string' ? req.query.themeId.trim().slice(0, 60) : null;
    const ageBand = typeof req.query.ageBand === 'string' ? req.query.ageBand.trim().slice(0, 10) : null;
    const theme = themeId ? catalogEngine.mergedCatalog().themes[themeId] || null : null;
    const recommended = themeId ? cast.defaultNarratorKey({ themeId, ageBand: ageBand || '4-5', seedBasis: '' }) : null;
    const companion = theme ? cast.companionCastKey(theme) : null;
    return res.json({
      success: true, audioVersion: catalogEngine.versions.AUDIO_VERSION, castHash: cast.castFileHash(),
      narrators: cast.narratorOptions(), companions: cast.companionOptions(),
      recommended: { narrator: recommended, companion },
      languages: AUDIO_LANGUAGES, enabled: catalogEngine.flags.audiobookEnabled(),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
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
      // 2026-09-07: non-null when the render depicted a BOOK (mockup / framed
      // art) and shipped after the one hardened retry — the bench sees it.
      coverArtworkAdvisory: front.coverArtworkAdvisory,
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
    const hit = storyPair?.request?.versions?.catalog?.startsWith('upsell-v1-')
      ? await catalogEngine.getBookForTag(body.bookDefinitionId, storyPair.request.versions.catalog)
      : catalogEngine.getBook(body.bookDefinitionId);
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
        reviewedOnly: body.reviewedOnly === true,
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
      await deliverBookCompletion({
        callbackUrl, progressCallbackUrl, completion, postWithRetry, clearCheckpoint,
        log: (level, message) => bookContext.log(level, message),
      });
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
        ...(err.recovery ? { recovery: err.recovery } : {}),
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
        // A cover failure retains the completed interior and artwork; retries
        // resume PDF assembly instead of starting another illustration run.
        ...(err.interiorPdfUrl ? { interiorPdfUrl: err.interiorPdfUrl } : {}),
        ...(err.pageCount ? { pageCount: err.pageCount } : {}),
        ...(err.previewImageUrls?.length ? { previewImageUrls: err.previewImageUrls } : {}),
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
      return true;
    } catch (err) {
      console.error(`[server] callback attempt ${attempt + 1}/3 to ${url} failed: ${err.message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
    } finally {
      clearTimeout(timeout);
    }
  }
  console.error(`[server] callback to ${url} LOST after 3 attempts — the caller must reconcile this run as stalled`);
  return false;
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

// ── /generate-coloring-book, /cancel-coloring-book — DELETED (cb-1) ──────────
// The pre-cb-1 coloring book (free-text scene invention, raw-photo identity,
// a hard threshold as the line-art mechanism, no QA, a model-lettered pencil
// cover) was deleted outright — docs/COLORING_BOOK_V2_PLAN.md §5.3. The
// replacement is POST /v13/generate-coloring-book (+ /v13/pick-coloring-
// candidate, /v13/cancel-coloring-book). 410 so a stale caller fails loudly.
app.post('/generate-coloring-book', authenticate, (req, res) => {
  console.warn(`[server] /generate-coloring-book rejected (deleted, cb-1) — book=${req.body?.bookId}`);
  return res.status(410).json({ success: false, error: 'The legacy coloring book generator was deleted (cb-1). Use POST /v13/generate-coloring-book with the V1.3 inputs (story pair, profile, approvedCoverUrl).', failureCode: 'gone' });
});
app.post('/cancel-coloring-book', authenticate, (req, res) => {
  return res.status(410).json({ success: false, error: 'Deleted (cb-1). Use POST /v13/cancel-coloring-book.', failureCode: 'gone' });
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
    interiorPdfUrl,
    story: chosenStory,
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
    const { resolveCoverRebuildMetadata } = require('./services/coverMetadata');
    const { pageCount, synopsis } = await resolveCoverRebuildMetadata({
      storyContent, chosenStory, interiorPdfUrl, childDetails: resolvedChildDetails, flags,
      pageCount: legacyPageCount, synopsis: legacySynopsis,
      bookId, title, refreshPictureBlurb: /^(picture_book|early_reader)$/i.test(bookFormat || 'PICTURE_BOOK'),
      log: (level, message) => console[level === 'warn' ? 'warn' : 'log'](`[rebuild-cover-pdf] ${message}`),
    }, downloadBuffer);

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
        requireCompleteCover: true,
        reuseApprovedArtworkOnly: true,
        allowBackCoverGeneration: true,
        cacheBackCover: true,
        preserveApprovedCoverBounds: chosenStory?.request?.versions?.catalog?.startsWith('upsell-v1-'),
      },
    );
    if (!coverData?.coverPdfBuffer) throw new Error('generateCover returned no buffer');

    // Lulu preflight (picture books): the wrap must be ONE page of exactly
    // the canvas the binding + interior page count demand — the same check
    // the full pipeline runs, so a rebuilt cover can never drift from the
    // interior it will be ordered with.
    let preflight = null;
    if (/^(picture_book|early_reader)$/i.test(bookFormat || 'PICTURE_BOOK')) {
      preflight = await require('./services/luluSpec').preflightPictureBook({ coverPdf: coverData.coverPdfBuffer, pageCount, bindingType });
      if (!preflight.ok) throw new Error(`Cover PDF failed the Lulu preflight: ${preflight.errors.join('; ')}`);
    }

    const coverPath = `children-jobs/${bookId}/cover.pdf`;
    await uploadBuffer(coverData.coverPdfBuffer, coverPath, 'application/pdf');
    const coverPdfUrl = await getSignedUrl(coverPath, 30 * 24 * 60 * 60 * 1000);
    console.log(`[rebuild-cover-pdf] Done for book ${bookId}: ${coverPdfUrl} (pages=${pageCount}, binding=${bindingType || 'paperback'})`);
    return res.json({ success: true, coverPdfUrl, preflight,
      backCoverImageUrl: coverData.backCoverImageUrl,
      backCoverDesignAdvisory: coverData.backCoverDesignAdvisory,
      backCoverRepairNote: coverData.backCoverRepairNote,
      backCoverDiagnostics: coverData.backCoverDiagnostics,
    });
  } catch (err) {
    console.error(`[rebuild-cover-pdf] Error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /rebuild-coloring-cover-pdf — DELETED (cb-1) ─────────────────────────
// The coloring cover is no longer a model output: it is built from the
// approved cover's OWN pixels by /v13/generate-coloring-book, and a re-dispatch
// (no forceNew) replays every page and rebuilds both PDFs for free.
app.post('/rebuild-coloring-cover-pdf', authenticate, (req, res) => {
  console.warn(`[server] /rebuild-coloring-cover-pdf rejected (deleted, cb-1) — book=${req.body?.bookId}`);
  return res.status(410).json({ success: false, error: 'Deleted (cb-1). Re-dispatch POST /v13/generate-coloring-book (without forceNew) to rebuild the PDFs from the cached pages.', failureCode: 'gone' });
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
