#!/usr/bin/env node
/**
 * gpt-image-2 health check + reference-image verification.
 *
 * Two modes:
 *   1. text-only generation (no `--cover` flag) — original smoke test
 *   2. reference-image conditioning (`--cover <path>`) — POSTs `image[]`
 *      multipart with the cover JPEG, then a second pass with cover +
 *      first output. Saves both outputs to `/tmp/gpt-image-2-ref-*.png`
 *      so a human can confirm the rendered hero matches the cover.
 *
 * The same `OPENAI_API_KEY` the children worker uses on Cloud Run is set at deploy
 * from GitHub Actions (`secrets.OPENAI_API_KEY` in `.github/workflows/deploy.yml`).
 * You cannot read that value back with `gcloud run services describe` — set it locally
 * to match, or use `OPENAI_API_KEY_FILE` (e.g. from Secret Manager in Cloud Shell:
 * `gcloud secrets versions access latest --secret=YOUR_SECRET > /tmp/k`).
 *
 * Run (text-only):
 *   node -r dotenv/config scripts/testGptImage2Generations.js
 *
 * Run (reference verification — REQUIRED before flipping the illustrator default):
 *   node -r dotenv/config scripts/testGptImage2Generations.js --cover /path/to/cover.jpg
 *
 * The reference-verification pass is what gates the gpt-image-2 migration: if
 * the second image's hero does NOT visually match the cover, /v1/images/generations
 * is silently ignoring `image[]` for this model and we must move to the
 * Responses API path before continuing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function loadApiKey() {
  if (process.env.OPENAI_API_KEY && String(process.env.OPENAI_API_KEY).trim()) {
    return String(process.env.OPENAI_API_KEY).trim();
  }
  const filePath = process.env.OPENAI_API_KEY_FILE;
  if (filePath && fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8').trim();
  }
  return '';
}

function parseArgs(argv) {
  const out = { coverPath: null, quality: 'high', size: '1024x1024' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cover') out.coverPath = argv[++i];
    else if (a === '--quality') out.quality = argv[++i];
    else if (a === '--size') out.size = argv[++i];
  }
  return out;
}

async function postJson(key, body) {
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, ok: r.ok, text };
}

async function postMultipart(key, { model, prompt, size, quality, imageFiles }) {
  if (typeof FormData === 'undefined' || typeof Blob === 'undefined') {
    throw new Error('Node >= 20 required for FormData / Blob');
  }
  const fd = new FormData();
  fd.append('model', model);
  fd.append('prompt', prompt);
  fd.append('n', '1');
  if (size) fd.append('size', size);
  if (quality) fd.append('quality', quality);
  for (const f of imageFiles) {
    fd.append('image[]', new Blob([f.buffer], { type: f.mimeType || 'image/jpeg' }), f.filename);
  }
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: fd,
  });
  const text = await r.text();
  return { status: r.status, ok: r.ok, text };
}

function decodeImage(rawJson) {
  const j = JSON.parse(rawJson);
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new Error('Response had no b64_json');
  return { buffer: Buffer.from(b64, 'base64'), usage: j.usage || null };
}

async function runTextOnly(key, { size, quality }) {
  console.log(`\n=== Test 1: text-only generation (size=${size}, quality=${quality}) ===`);
  const r = await postJson(key, {
    model: 'gpt-image-2',
    prompt: 'Minimal test: one small solid green circle on a light gray background, flat, no text.',
    n: 1,
    size,
    quality,
  });
  console.log('HTTP', r.status);
  if (!r.ok) {
    console.error(r.text);
    process.exit(1);
  }
  const { buffer, usage } = decodeImage(r.text);
  const outPath = '/tmp/gpt-image-2-textonly.png';
  fs.writeFileSync(outPath, buffer);
  console.log(`OK — wrote ${buffer.length} bytes to ${outPath}`);
  if (usage) console.log('usage:', usage);
}

async function runReferenceVerification(key, { coverPath, size, quality }) {
  if (!fs.existsSync(coverPath)) {
    console.error(`Cover not found: ${coverPath}`);
    process.exit(1);
  }
  const coverBuf = fs.readFileSync(coverPath);
  const coverMime = coverPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  console.log(`\n=== Test 2: reference-image conditioning (cover=${coverPath}, ${(coverBuf.length / 1024).toFixed(0)}KB) ===`);

  const promptA =
    'Render the same hero child shown in the reference image, in 3D Pixar feature-film style. ' +
    'The child is sitting in a sunlit meadow holding a small daisy. Match the child\'s face, hair, ' +
    'skin tone, and outfit from the reference image EXACTLY. No on-image text. Single square frame.';

  const ra = await postMultipart(key, {
    model: 'gpt-image-2',
    prompt: promptA,
    size,
    quality,
    imageFiles: [{ buffer: coverBuf, filename: path.basename(coverPath), mimeType: coverMime }],
  });
  console.log('Pass A HTTP', ra.status);
  if (!ra.ok) {
    console.error(ra.text);
    process.exit(1);
  }
  const a = decodeImage(ra.text);
  const aPath = '/tmp/gpt-image-2-ref-A.png';
  fs.writeFileSync(aPath, a.buffer);
  console.log(`Pass A OK — wrote ${a.buffer.length} bytes to ${aPath}`);
  if (a.usage) console.log('Pass A usage:', a.usage);

  const promptB =
    'Render the same hero child shown in reference image 1 (the cover), continuing from reference image 2 ' +
    '(an earlier approved spread of this same book). The child is now standing at a kitchen table ' +
    'reaching for a chocolate-chip cookie. Match face, hair, skin tone, and outfit from the cover and the ' +
    'previous spread EXACTLY. 3D Pixar feature-film style. No on-image text. Single square frame.';

  const rb = await postMultipart(key, {
    model: 'gpt-image-2',
    prompt: promptB,
    size,
    quality,
    imageFiles: [
      { buffer: coverBuf, filename: path.basename(coverPath), mimeType: coverMime },
      { buffer: a.buffer, filename: 'spread-1.png', mimeType: 'image/png' },
    ],
  });
  console.log('Pass B HTTP', rb.status);
  if (!rb.ok) {
    console.error(rb.text);
    process.exit(1);
  }
  const b = decodeImage(rb.text);
  const bPath = '/tmp/gpt-image-2-ref-B.png';
  fs.writeFileSync(bPath, b.buffer);
  console.log(`Pass B OK — wrote ${b.buffer.length} bytes to ${bPath}`);
  if (b.usage) console.log('Pass B usage:', b.usage);

  console.log(`
=========================================================================
MANUAL VERIFICATION REQUIRED:
  open ${coverPath} (the cover)
  open ${aPath} (pass A — should show SAME hero as cover, in a meadow)
  open ${bPath} (pass B — should show SAME hero as cover and pass A, at a table)

If hero face / hair / skin / outfit MATCHES the cover across all three →
  /v1/images/generations DOES use image[] references for gpt-image-2.
  Migration can proceed.

If hero looks like a different child in A or B →
  /v1/images/generations is IGNORING image[] for gpt-image-2.
  STOP — switch the adapter to the Responses API (/v1/responses with
  input_image content parts) before flipping the default.
=========================================================================`);
}

async function main() {
  const key = loadApiKey();
  if (!key) {
    console.error(
      'Set OPENAI_API_KEY or OPENAI_API_KEY_FILE (e.g. `node -r dotenv/config scripts/testGptImage2Generations.js`).',
    );
    process.exit(1);
  }
  const args = parseArgs(process.argv);
  await runTextOnly(key, args);
  if (args.coverPath) {
    await runReferenceVerification(key, args);
  } else {
    console.log('\n(skipped reference verification — pass `--cover <path>` to test image[] conditioning)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
