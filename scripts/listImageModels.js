#!/usr/bin/env node
/**
 * Ops aid: list the model ids actually provisioned on the Generative
 * Language API for this project's key(s).
 *
 * Why: the pro-tier renderer upgrade has twice been attempted with a GUESSED
 * model id that 404'd in production (illustrator/config.js history), and
 * imageClient then silently fell back to flash for the process lifetime.
 * The config comment says "confirm the id from ListModels" — this script IS
 * that step. Since the 2026-09-16 Gemini migration the text / vision /
 * audio / TTS ids live in services/shared/llm/models.js behind env knobs
 * (CATALOG_QA_VISION_MODEL, CATALOG_QA_PRO_MODEL, CATALOG_TEXT_FALLBACK_MODEL,
 * CATALOG_AUDIO_STT_MODEL, CATALOG_AUDIO_TTS_MODEL) — `--all` is the step
 * that confirms THOSE ids before a revision pins one.
 *
 * Usage:
 *   GEMINI_API_KEY=... node scripts/listImageModels.js          # image-capable ids (default)
 *   GEMINI_API_KEY=... node scripts/listImageModels.js --all    # every model + its supportedGenerationMethods
 *   (also checks GEMINI_API_KEY_1 and GOOGLE_AI_STUDIO_KEY as fallbacks)
 *
 * Then set BOOK_PIPELINE_V3_SPREAD_RENDERER_MODEL / _SHEET_RENDERER_MODEL to
 * a listed id. The identity-kit and render caches are keyed by the model, so
 * the flip re-renders cleanly — no manual cache-version bump needed.
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Whether a ListModels entry looks like an image generator.
 * @param {{name?: string, description?: string, supportedGenerationMethods?: string[]}} m
 * @returns {boolean}
 */
function isImageCapable(m) {
  return (m.supportedGenerationMethods || []).includes('generateContent')
    && (/image/i.test(m.name) || /image/i.test(m.description || ''));
}

/**
 * Every model visible to the key, across ListModels pages.
 * @param {string} key
 * @returns {Promise<object[]>}
 */
async function listModels(key) {
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
  return models;
}

async function main() {
  const all = process.argv.slice(2).includes('--all');
  const key = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_1 || process.env.GOOGLE_AI_STUDIO_KEY;
  if (!key) {
    console.error('Set GEMINI_API_KEY (or GEMINI_API_KEY_1 / GOOGLE_AI_STUDIO_KEY) and re-run.');
    process.exit(1);
  }
  const models = await listModels(key);

  if (all) {
    const sorted = [...models].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    console.log(`\n${models.length} models visible to this key (id — display name — supportedGenerationMethods):\n`);
    for (const m of sorted) {
      const methods = (m.supportedGenerationMethods || []).join(', ') || '(none listed)';
      console.log(`  ${String(m.name).replace(/^models\//, '')}  —  ${m.displayName || ''}  —  ${methods}`);
    }
    console.log('\nPin a text / vision / audio / TTS id from the list above on its CATALOG_* env (services/shared/llm/models.js).');
    return;
  }

  const imageCapable = models.filter(isImageCapable);

  console.log(`\n${models.length} models visible to this key; ${imageCapable.length} look image-capable:\n`);
  for (const m of imageCapable) {
    console.log(`  ${m.name.replace(/^models\//, '')}  —  ${m.displayName || ''}`);
  }
  console.log('\nSet BOOK_PIPELINE_V3_SPREAD_RENDERER_MODEL / _SHEET_RENDERER_MODEL to one of the ids above (without the models/ prefix).');
  console.log('Pass --all to list every model with its supportedGenerationMethods (text / audio / TTS ids too).');
}

main().catch((err) => { console.error(err); process.exit(1); });
