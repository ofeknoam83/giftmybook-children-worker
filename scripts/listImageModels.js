#!/usr/bin/env node
/**
 * Ops aid: list the image-capable model ids actually provisioned on the
 * Generative Language API for this project's key(s).
 *
 * Why: the pro-tier renderer upgrade has twice been attempted with a GUESSED
 * model id that 404'd in production (illustrator/config.js history), and
 * imageClient then silently fell back to flash for the process lifetime.
 * The config comment says "confirm the id from ListModels" — this script IS
 * that step.
 *
 * Usage:
 *   GEMINI_API_KEY=... node scripts/listImageModels.js
 *   (also checks GEMINI_API_KEY_1 and GOOGLE_AI_STUDIO_KEY as fallbacks)
 *
 * Then set BOOK_PIPELINE_V3_SPREAD_RENDERER_MODEL / _SHEET_RENDERER_MODEL to
 * a listed id. The identity-kit and render caches are keyed by the model, so
 * the flip re-renders cleanly — no manual cache-version bump needed.
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function main() {
  const key = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_1 || process.env.GOOGLE_AI_STUDIO_KEY;
  if (!key) {
    console.error('Set GEMINI_API_KEY (or GEMINI_API_KEY_1 / GOOGLE_AI_STUDIO_KEY) and re-run.');
    process.exit(1);
  }
  const models = [];
  let pageToken = '';
  do {
    const url = `${BASE}?key=${encodeURIComponent(key)}&pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`ListModels failed: HTTP ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    const body = await res.json();
    models.push(...(body.models || []));
    pageToken = body.nextPageToken || '';
  } while (pageToken);

  const imageCapable = models.filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')
    && (/image/i.test(m.name) || /image/i.test(m.description || '')));

  console.log(`\n${models.length} models visible to this key; ${imageCapable.length} look image-capable:\n`);
  for (const m of imageCapable) {
    console.log(`  ${m.name.replace(/^models\//, '')}  —  ${m.displayName || ''}`);
  }
  console.log('\nSet BOOK_PIPELINE_V3_SPREAD_RENDERER_MODEL / _SHEET_RENDERER_MODEL to one of the ids above (without the models/ prefix).');
}

main().catch((err) => { console.error(err); process.exit(1); });
