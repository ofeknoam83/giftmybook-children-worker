#!/usr/bin/env node
/**
 * Judge calibration harness (milestone 2 plan §8) — run the native
 * illustrator's judges against a human-labeled set of historical spread
 * images and report judge–human agreement.
 *
 * An uncalibrated vision judge is worse than none: it launders defects
 * with a green checkmark. Gate (before any threshold is trusted):
 *   ≥90% agreement on hard-fail classes (lettering, duplicated hero,
 *   wrong child / skin-tone mismatch). Re-run on every judge-model or
 *   prompt-version bump.
 *
 * Usage:
 *   node scripts/calibrateIllustratorJudges.js labels.json [--limit N]
 *
 * labels.json: [
 *   {
 *     "imageUrl": "https://.../spread.png",      // or "imagePath" (local file)
 *     "photoUrls": ["https://.../child.jpg"],    // required for likeness cases
 *     "labels": {                                 // human ground truth
 *       "hasText": false,
 *       "duplicatedHero": false,
 *       "wrongChild": false,
 *       "acceptable": true                        // overall human verdict
 *     },
 *     "sceneContract": { ... }                    // optional, enables spread-judge scoring
 *   }, ...
 * ]
 *
 * Requires GEMINI_API_KEY (+ OPENAI_API_KEY for the cross-family likeness
 * judge) in the environment. Spends real API calls — size the set accordingly.
 */

const fs = require('fs');
const path = require('path');

const { letterformCheck } = require('../services/bookPipelineV3/illustrator/qa/deterministicChecks');
const { judgeSpreadCandidate } = require('../services/bookPipelineV3/illustrator/qa/spreadJudge');
const { judgeLikenessCrossFamily } = require('../services/bookPipelineV3/illustrator/qa/likenessJudge');
const { downloadPhotoAsBase64 } = require('../services/illustrationGenerator');

async function loadImage(entry) {
  if (entry.imagePath) {
    const buf = fs.readFileSync(path.resolve(entry.imagePath));
    const ext = path.extname(entry.imagePath).toLowerCase();
    return { base64: buf.toString('base64'), mimeType: ext === '.png' ? 'image/png' : 'image/jpeg' };
  }
  return downloadPhotoAsBase64(entry.imageUrl);
}

function agreement(name, results) {
  const decided = results.filter((r) => r.human !== undefined && r.judge !== undefined);
  if (!decided.length) return { name, n: 0, agreement: null };
  const agree = decided.filter((r) => r.human === r.judge).length;
  const falseNegatives = decided.filter((r) => r.human === true && r.judge === false).length;
  return {
    name,
    n: decided.length,
    agreement: Number((agree / decided.length).toFixed(3)),
    falseNegatives, // defect present, judge missed it — the dangerous direction
  };
}

async function main() {
  const [, , labelsFile, ...rest] = process.argv;
  if (!labelsFile) {
    console.error('usage: node scripts/calibrateIllustratorJudges.js labels.json [--limit N]');
    process.exit(1);
  }
  const limitIdx = rest.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(rest[limitIdx + 1]) : Infinity;

  const entries = JSON.parse(fs.readFileSync(path.resolve(labelsFile), 'utf8')).slice(0, limit);
  console.log(`[calibrate] ${entries.length} labeled entries`);

  const letterform = [];
  const dupHero = [];
  const wrongChild = [];
  const overall = [];

  for (const [i, entry] of entries.entries()) {
    const tag = `#${i + 1}/${entries.length}`;
    try {
      const image = await loadImage(entry);

      // Hard-fail class 1: lettering
      if (entry.labels.hasText !== undefined) {
        const res = await letterformCheck(image);
        letterform.push({ human: entry.labels.hasText, judge: !res.pass });
      }

      // Hard-fail class 2: duplicated hero (via spread judge tags)
      if (entry.labels.duplicatedHero !== undefined && entry.sceneContract) {
        const res = await judgeSpreadCandidate({ candidate: image, sceneContract: entry.sceneContract });
        dupHero.push({ human: entry.labels.duplicatedHero, judge: res.tags.includes('duplicated_hero') || res.scores.cast <= 1 });
        if (entry.labels.acceptable !== undefined) {
          overall.push({ human: entry.labels.acceptable, judge: res.pass });
        }
      }

      // Hard-fail class 3: wrong child (cross-family likeness).
      // Since the cover-relative QA change, the judge references APPROVED
      // ART (cover and/or model sheet) — label rows should set
      // `referenceUrls` to the book's cover/sheet; `photoUrls` is kept as
      // a legacy fallback for old label files.
      const refUrls = entry.referenceUrls?.length ? entry.referenceUrls : entry.photoUrls;
      if (entry.labels.wrongChild !== undefined && refUrls?.length) {
        const referenceImages = await Promise.all(refUrls.map((u) => downloadPhotoAsBase64(u)));
        const res = await judgeLikenessCrossFamily({ candidate: image, referenceImages });
        wrongChild.push({ human: entry.labels.wrongChild, judge: res.verdicts.some((v) => v.wrongChild) });
      }

      console.log(`[calibrate] ${tag} done`);
    } catch (err) {
      console.error(`[calibrate] ${tag} FAILED: ${err.message}`);
    }
  }

  const report = [
    agreement('lettering (hard fail)', letterform),
    agreement('duplicated hero (hard fail)', dupHero),
    agreement('wrong child (hard fail)', wrongChild),
    agreement('overall acceptability', overall),
  ];

  console.log('\n=== JUDGE–HUMAN AGREEMENT ===');
  for (const r of report) {
    const verdict = r.agreement === null ? 'no data'
      : r.name.includes('hard fail')
        ? (r.agreement >= 0.9 ? 'PASS (≥0.90)' : 'FAIL (<0.90 — do NOT trust this judge yet)')
        : '';
    console.log(`${r.name.padEnd(32)} n=${String(r.n).padEnd(4)} agreement=${r.agreement ?? '—'} falseNegatives=${r.falseNegatives ?? '—'} ${verdict}`);
  }
  console.log('\nGate: every hard-fail class ≥0.90 before any spread-QA threshold is trusted (plan §8).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
