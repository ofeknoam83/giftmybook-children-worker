/**
 * PR Z fast QA harness — planner + writer only.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... OPENAI_API_KEY=... \
 *     node scripts/qaPlannerWriter.js <bookId>
 *
 * What it does:
 *   1. Pulls the bookrequest row from the standalone DB by id.
 *   2. Reconstructs the /generate-book payload (the same shape
 *      server.js builds when it calls generateBook).
 *   3. Runs only the planner + writer stages (no illustrator):
 *        normalize → cover-detect → storyBible → visualBible → spreadSpecs
 *        → draftBookText → writerQaAndRewrite
 *   4. Prints:
 *        - the resolved BOOK SUBJECT block + anchor allocation
 *        - the per-spread spec mustUseDetails (so you can see ANCHOR lines)
 *        - the final manuscript (13 spreads of verse)
 *        - per-spread anchor coverage report (which beats landed)
 *        - book-level signature beat coverage
 *        - any writer-QA issues that survived
 *
 * Skips the illustrator entirely — that's the expensive (~5 min) GPU stage.
 */

const path = require('path');

// Load env from .env if present so OPENAI_API_KEY etc. are picked up the
// same way the worker would.
try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch (_e) { /* dotenv optional */ }

const { Client } = require('pg');

const { normalizeRequest } = require('../services/bookPipeline/input/normalizeRequest');
const { detectCoverComposition } = require('../services/bookPipeline/planner/detectCoverComposition');
const { createStoryBible } = require('../services/bookPipeline/planner/createStoryBible');
const { createVisualBible } = require('../services/bookPipeline/planner/createVisualBible');
const { createSpreadSpecs } = require('../services/bookPipeline/planner/createSpreadSpecs');
const { draftBookText } = require('../services/bookPipeline/writer/draftBookText');
const { writerQaAndRewrite } = require('../services/bookPipeline/writer/rewriteBookText');
const {
  buildAnchorAllocation,
  renderAllocationBlockForStoryBible,
  renderAllocationBlockForPlanner,
} = require('../services/bookPipeline/planner/anchorAllocation');
const { checkSignatureBeatCoverage, describeBeat } = require('../services/bookPipeline/qa/signatureBeats');
const { createBookDocument, appendStageTrace } = require('../services/bookPipeline/schema/bookDocument');

async function loadBookRequestById(bookId) {
  const conn = process.env.DATABASE_URL;
  if (!conn) throw new Error('DATABASE_URL not set');
  const client = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const r = await client.query('SELECT * FROM bookrequests WHERE id = $1 LIMIT 1', [bookId]);
    if (r.rowCount === 0) throw new Error(`bookrequest ${bookId} not found`);
    return r.rows[0];
  } finally {
    await client.end();
  }
}

/**
 * Reconstruct the /generate-book pipelineRequest payload from the saved DB
 * row. Mirrors server.js routes that build `pipelineRequest`.
 */
function buildPipelineRequest(row) {
  const b = row.brief || {};
  const child = b.child || {};

  // server.js puts the questionnaire fields in brief.child as a flat shape
  // (funny_thing, meaningful_moment, calls_mom, ...). The pipeline reads
  // them from raw.childAnecdotes via normalizeRequest.
  const childAnecdotes = {
    funny_thing: child.funny_thing,
    meaningful_moment: child.meaningful_moment,
    moms_favorite_moment: child.moms_favorite_moment,
    dads_favorite_moment: child.dads_favorite_moment,
    anything_else: child.anything_else,
    calls_mom: child.calls_mom,
    calls_dad: child.calls_dad,
    mom_name: child.mom_name,
    dad_name: child.dad_name,
    favorite_activities: child.favorite_activities,
    favorite_food: child.favorite_food,
    favorite_toys: child.favorite_toys,
    other_detail: child.other_detail,
    favorite_cake_flavor: child.favorite_cake_flavor,
    birth_date: child.birth_date,
  };
  // Drop empty values so the snapshot doesn't render blank lines.
  for (const k of Object.keys(childAnecdotes)) {
    if (childAnecdotes[k] == null || String(childAnecdotes[k]).trim() === '') {
      delete childAnecdotes[k];
    }
  }

  const childPayload = {
    name: row.child_name || child.name,
    age: row.child_age != null ? row.child_age : child.age,
    gender: row.child_gender || child.gender,
    interests: Array.isArray(row.child_interests) ? row.child_interests : [],
  };

  return {
    bookId: row.id,
    format: (row.book_format || 'PICTURE_BOOK').toLowerCase(),
    theme: row.theme || child.theme || b.theme || 'mothers_day',
    child: childPayload,
    childAnecdotes,
    customDetails: row.custom_details || {},
    cover: {
      title: row.title || row.cover_title_options?.[0] || 'My Story',
      imageUrl: row.cover_image_url || null,
    },
  };
}

function fmtSpread(spread) {
  const n = spread.spreadNumber;
  const text = (spread.manuscript?.text || '').replace(/\n/g, ' / ');
  const side = spread.manuscript?.side || '?';
  return `  sp ${String(n).padStart(2, ' ')} (${side.padEnd(5)}) ${text}`;
}

function reportAnchorCoverage(brief, doc) {
  const coverage = checkSignatureBeatCoverage(brief, doc.spreads || []);
  const lines = [];
  lines.push(`\n=== SIGNATURE BEAT COVERAGE (book-level) ===`);
  if (coverage.beats.length === 0) {
    lines.push('  (no signature beats in brief)');
  } else {
    for (const b of coverage.landed) lines.push(`  ✓ landed: ${describeBeat(b)}`);
    for (const b of coverage.missing) lines.push(`  ✗ MISSING: ${describeBeat(b)}`);
  }
  return lines.join('\n');
}

function reportPerSpreadVerbatim(allocation, doc) {
  const lines = [];
  lines.push(`\n=== PER-SPREAD VERBATIM TOKEN CHECK ===`);
  for (const a of allocation.allocations) {
    if (a.isAddress) continue;
    if (a.spreadNumber == null) continue;
    const sp = (doc.spreads || []).find(s => s.spreadNumber === a.spreadNumber);
    const text = (sp?.manuscript?.text || '').toLowerCase();
    const tokens = a.loadBearingTokens || [];
    if (tokens.length === 0) continue;
    const landed = tokens.filter(t => text.includes(t));
    const missing = tokens.filter(t => !text.includes(t));
    const status = missing.length === 0 ? '✓' : '✗';
    lines.push(
      `  ${status} sp ${a.spreadNumber} (${a.role}) · ${a.key}: ` +
      `landed=[${landed.join(', ')}] missing=[${missing.join(', ')}]`,
    );
  }
  return lines.join('\n');
}

async function run() {
  const bookId = process.argv[2];
  if (!bookId) {
    console.error('usage: node scripts/qaPlannerWriter.js <bookId>');
    process.exit(2);
  }

  const t0 = Date.now();
  console.log(`[qa] loading bookrequest ${bookId} from DB...`);
  const row = await loadBookRequestById(bookId);
  const pipelineRequest = buildPipelineRequest(row);

  console.log(`[qa] reconstructed pipelineRequest:`);
  console.log(JSON.stringify({
    bookId: pipelineRequest.bookId,
    format: pipelineRequest.format,
    theme: pipelineRequest.theme,
    child: pipelineRequest.child,
    childAnecdotes: pipelineRequest.childAnecdotes,
    cover: { title: pipelineRequest.cover.title, hasImageUrl: !!pipelineRequest.cover.imageUrl },
  }, null, 2));

  const operationalContext = { bookId, onProgress: (e) => console.log(`[qa:${e.step}] ${e.message || ''}`) };

  console.log(`\n[qa] normalizing request...`);
  const normalized = await normalizeRequest(pipelineRequest, { operationalContext });
  let doc = createBookDocument({
    request: normalized.request,
    brief: normalized.brief,
    cover: normalized.cover,
    operationalContext,
  });
  doc = appendStageTrace(doc, { name: 'input', durationMs: 0 });

  // Show the BOOK SUBJECT and ANCHOR ALLOCATION blocks BEFORE running the
  // LLM so we can verify what the planner will see.
  const allocation = buildAnchorAllocation(doc.brief);
  console.log(`\n=== BOOK SUBJECT (story-bible block) ===`);
  console.log(renderAllocationBlockForStoryBible(allocation) || '  (empty)');
  console.log(`\n=== ANCHOR ALLOCATION (spread-specs block) ===`);
  console.log(renderAllocationBlockForPlanner(allocation) || '  (empty)');

  console.log(`\n[qa] stage: coverComposition`);
  doc = await detectCoverComposition(doc);
  doc = appendStageTrace(doc, { name: 'coverComposition', durationMs: 0 });

  console.log(`[qa] stage: storyBible`);
  const t1 = Date.now();
  doc = await createStoryBible(doc);
  console.log(`[qa] storyBible done in ${Date.now() - t1}ms`);
  console.log(`  narrativeSpine: ${doc.storyBible.narrativeSpine}`);
  console.log(`  beginningHook:  ${doc.storyBible.beginningHook}`);
  console.log(`  middleEscalation: ${doc.storyBible.middleEscalation}`);
  console.log(`  endingPayoff:   ${doc.storyBible.endingPayoff}`);
  console.log(`  emotionalArc:   ${doc.storyBible.emotionalArc}`);
  console.log(`  humorStrategy:  ${doc.storyBible.humorStrategy}`);
  console.log(`  personalizationTargets: ${JSON.stringify(doc.storyBible.personalizationTargets)}`);
  console.log(`  recurringVisualMotifs:  ${JSON.stringify(doc.storyBible.recurringVisualMotifs)}`);

  console.log(`\n[qa] stage: visualBible`);
  const t2 = Date.now();
  doc = await createVisualBible(doc);
  console.log(`[qa] visualBible done in ${Date.now() - t2}ms`);

  console.log(`\n[qa] stage: spreadSpecs`);
  const t3 = Date.now();
  doc = await createSpreadSpecs(doc);
  console.log(`[qa] spreadSpecs done in ${Date.now() - t3}ms`);

  // Show per-spread mustUseDetails so we can verify the deterministic
  // ANCHOR injection landed on opening / heart / peak2 / closing.
  console.log(`\n=== PER-SPREAD mustUseDetails ===`);
  for (const s of doc.spreads || []) {
    const md = s.spec?.mustUseDetails || [];
    const role = s.spec?.anchorRole;
    if (md.length === 0 && !role) continue;
    console.log(`  sp ${s.spreadNumber}${role ? ` (anchorRole=${role})` : ''}:`);
    for (const d of md) console.log(`    - ${d}`);
  }

  console.log(`\n[qa] stage: writerDraft`);
  const t4 = Date.now();
  doc = await draftBookText(doc);
  console.log(`[qa] writerDraft done in ${Date.now() - t4}ms`);

  console.log(`\n[qa] stage: writerQaAndRewrite`);
  const t5 = Date.now();
  doc = await writerQaAndRewrite(doc);
  console.log(`[qa] writerQaAndRewrite done in ${Date.now() - t5}ms`);

  console.log(`\n=== FINAL MANUSCRIPT ===`);
  for (const s of doc.spreads || []) console.log(fmtSpread(s));

  console.log(reportAnchorCoverage(doc.brief, doc));
  console.log(reportPerSpreadVerbatim(allocation, doc));

  if (doc.writerQa) {
    console.log(`\n=== WRITER QA STATUS ===`);
    console.log(`  pass=${doc.writerQa.pass} waves=${doc.writerQa.waves}`);
    if (!doc.writerQa.pass) {
      const failures = (doc.writerQa.perSpread || []).filter(s => !s.pass);
      for (const f of failures) {
        console.log(`  ✗ sp ${f.spreadNumber}: ${(f.tags || []).join(', ')}`);
        for (const i of (f.issues || [])) console.log(`      - ${i}`);
      }
      const bookLevel = doc.writerQa.bookLevel || [];
      for (const b of bookLevel) {
        console.log(`  ✗ book-level: ${b.tag} — ${b.issue}`);
      }
    }
  }

  // Persist a JSON dump for offline inspection.
  const out = {
    bookId,
    elapsedMs: Date.now() - t0,
    request: pipelineRequest,
    storyBible: doc.storyBible,
    spreadSpecs: (doc.spreads || []).map(s => ({ spreadNumber: s.spreadNumber, spec: s.spec })),
    manuscript: (doc.spreads || []).map(s => ({ spreadNumber: s.spreadNumber, ...s.manuscript })),
    writerQa: doc.writerQa,
    anchorAllocation: {
      allocations: allocation.allocations,
      compression: allocation.compression,
    },
    signatureBeatCoverage: checkSignatureBeatCoverage(doc.brief, doc.spreads || []),
  };
  const outPath = path.resolve(__dirname, '..', `qa_${bookId}_${Date.now()}.json`);
  require('fs').writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n[qa] saved full dump to ${outPath}`);
  console.log(`[qa] total elapsed: ${Date.now() - t0}ms`);
}

run().catch(err => {
  console.error('[qa] FAILED:', err.stack || err.message || err);
  process.exit(1);
});
