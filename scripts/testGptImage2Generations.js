#!/usr/bin/env node
/**
 * One-off health check: POST /v1/images/generations with model gpt-image-2 (JSON body).
 *
 * The same `OPENAI_API_KEY` the children worker uses on Cloud Run is set at deploy
 * from GitHub Actions (`secrets.OPENAI_API_KEY` in `.github/workflows/deploy.yml`).
 * You cannot read that value back with `gcloud run services describe` — set it locally
 * to match, or use `OPENAI_API_KEY_FILE` (e.g. from Secret Manager in Cloud Shell:
 * `gcloud secrets versions access latest --secret=YOUR_SECRET > /tmp/k`).
 *
 * Run:  node -r dotenv/config scripts/testGptImage2Generations.js
 *   or: OPENAI_API_KEY_FILE=/path/to/file node scripts/testGptImage2Generations.js
 */
'use strict';

const fs = require('fs');

function loadApiKey() {
  if (process.env.OPENAI_API_KEY && String(process.env.OPENAI_API_KEY).trim()) {
    return String(process.env.OPENAI_API_KEY).trim();
  }
  const path = process.env.OPENAI_API_KEY_FILE;
  if (path && fs.existsSync(path)) {
    return fs.readFileSync(path, 'utf8').trim();
  }
  return '';
}

async function main() {
  const key = loadApiKey();
  if (!key) {
    console.error(
      'Set OPENAI_API_KEY or OPENAI_API_KEY_FILE (e.g. `node -r dotenv/config scripts/testGptImage2Generations.js`).',
    );
    process.exit(1);
  }
  const body = {
    model: 'gpt-image-2',
    prompt: 'Minimal test: one small solid green circle on a light gray background, flat, no text.',
    n: 1,
    size: '1024x1024',
  };
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log('HTTP', r.status, r.statusText);
  if (!r.ok) {
    console.log(text);
    process.exit(1);
  }
  const j = JSON.parse(text);
  const b64 = j.data?.[0]?.b64_json;
  console.log('OK — b64_json length:', b64 ? b64.length : 0);
  if (j.usage) console.log('usage:', j.usage);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
