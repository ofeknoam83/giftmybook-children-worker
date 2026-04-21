/**
 * Illustrator V2 — Cross-Spread Consistency Check
 *
 * After all 13 spreads are generated, checks uniformity across the set:
 * 1. Character face/hair/outfit consistency
 * 2. Art style consistency
 * 3. Font consistency
 * 4. Object consistency
 */

const { GEMINI_QA_MODEL, CHAT_API_BASE, QA_TIMEOUT_MS, QA_HTTP_ATTEMPTS } = require('../config');
const { fetchWithTimeout, getNextApiKey } = require('../../illustrationGenerator');
const { extractGeminiResponseText, parseQaJsonFromText } = require('./geminiJson');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Fail-closed: flag every spread in the batch so regen can run. */
function failWholeBatch(batch, reason) {
  return {
    passed: false,
    failedIndices: batch.map(s => ({ index: s.index, issues: [reason] })),
  };
}

/** QA infra failure — cannot judge consistency; pass the batch (no false regens). */
function passBatchInfra(batch, reason) {
  console.warn(`[illustrator/quality/consistency] Cross-spread batch passed (infra): ${reason}`);
  return {
    passed: true,
    failedIndices: [],
    infra: true,
  };
}

const MAX_IMAGES_PER_BATCH = 4;
const CHARACTER_BATCH_STRIDE = 3; // Overlap 1 image between adjacent character batches

/**
 * Split array into chunks (non-overlapping).
 */
function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Split array into overlapping windows for cross-boundary drift detection.
 */
function overlappingWindows(arr, windowSize, stride) {
  const windows = [];
  for (let i = 0; i < arr.length; i += stride) {
    const win = arr.slice(i, i + windowSize);
    if (win.length >= 2) windows.push(win);
    if (i + windowSize >= arr.length) break;
  }
  return windows;
}

function _finalizeAgentResults(checkResults, failedSpreadMap, logLabel) {
  const totalChecks = checkResults.length || 1;
  const passedChecks = checkResults.filter(r => r.passed).length;
  const overallScore = passedChecks / totalChecks;
  const failedSpreads = Array.from(failedSpreadMap.entries())
    .map(([index, issues]) => ({ index, issues }))
    .sort((a, b) => {
      const d = b.issues.length - a.issues.length;
      return d !== 0 ? d : a.index - b.index;
    });
  console.log(`[illustrator/quality/consistency] ${logLabel}: score=${(overallScore * 100).toFixed(0)}%, failedSpreads=${failedSpreads.length}`);
  return { overallScore, failedSpreads };
}

/**
 * Cross-spread Agent 1 — character continuity (face, hair, outfit, secondaries, bible).
 * Run and pass before Agent 2.
 *
 * @param {Array<{index: number, imageBase64: string, pageText: string}>} spreads
 * @param {object} [opts]
 * @returns {Promise<{overallScore: number, failedSpreads: Array<{index: number, issues: string[]}>}>}
 */
async function checkCrossSpreadAgent1(spreads, opts = {}) {
  if (spreads.length < 2) {
    return { overallScore: 1.0, failedSpreads: [] };
  }

  const failedSpreadMap = new Map();
  const checkResults = [];
  const bibleBlock = _formatBibleForQa(opts.storyBible);

  const batches = overlappingWindows(spreads, MAX_IMAGES_PER_BATCH, CHARACTER_BATCH_STRIDE);
  for (const batch of batches) {
    try {
      const result = await _checkBatchCharacterConsistency(batch, { ...opts, bibleBlock });
      checkResults.push(result);
      if (result.failedIndices) {
        for (const { index, issues } of result.failedIndices) {
          if (!failedSpreadMap.has(index)) failedSpreadMap.set(index, []);
          failedSpreadMap.get(index).push(...issues.map(i => `[character] ${i}`));
        }
      }
    } catch (e) {
      console.warn(`[illustrator/quality/consistency] Agent1 character batch error: ${e.message}`);
      for (const s of batch) {
        if (!failedSpreadMap.has(s.index)) failedSpreadMap.set(s.index, []);
        failedSpreadMap.get(s.index).push(`[character] QA batch exception: ${e.message}`);
      }
      checkResults.push({ passed: false, failedIndices: batch.map(s => ({ index: s.index, issues: [e.message] })) });
    }
  }

  return _finalizeAgentResults(checkResults, failedSpreadMap, 'Cross-spread Agent1 (character)');
}

/**
 * Cross-spread Agent 2 — font + rendered art style consistency across spreads.
 * Only meaningful after Agent 1 passes.
 *
 * @param {Array<{index: number, imageBase64: string, pageText: string}>} spreads
 * @param {object} [opts]
 * @returns {Promise<{overallScore: number, failedSpreads: Array<{index: number, issues: string[]}>}>}
 */
async function checkCrossSpreadAgent2(spreads, opts = {}) {
  if (spreads.length < 2) {
    return { overallScore: 1.0, failedSpreads: [] };
  }

  const failedSpreadMap = new Map();
  const checkResults = [];

  const textSpreads = spreads.filter(s => s.pageText && s.pageText.trim());
  if (textSpreads.length >= 2) {
    const fontBatches = chunk(textSpreads, MAX_IMAGES_PER_BATCH);
    for (const batch of fontBatches) {
      try {
        const result = await _checkBatchFontConsistency(batch, opts);
        checkResults.push(result);
        if (result.failedIndices) {
          for (const { index, issues } of result.failedIndices) {
            if (!failedSpreadMap.has(index)) failedSpreadMap.set(index, []);
            failedSpreadMap.get(index).push(...issues.map(i => `[font] ${i}`));
          }
        }
      } catch (e) {
        console.warn(`[illustrator/quality/consistency] Agent2 font batch error: ${e.message}`);
        for (const s of batch) {
          if (!failedSpreadMap.has(s.index)) failedSpreadMap.set(s.index, []);
          failedSpreadMap.get(s.index).push(`[font] QA batch exception: ${e.message}`);
        }
        checkResults.push({ passed: false, failedIndices: batch.map(s => ({ index: s.index, issues: [e.message] })) });
      }
    }
  }

  const anchor = spreads[0];
  const nonAnchorSpreads = spreads.slice(1);
  const styleBatches = chunk(nonAnchorSpreads, MAX_IMAGES_PER_BATCH - 1);
  for (const batch of styleBatches) {
    const anchoredBatch = [anchor, ...batch];
    try {
      const result = await _checkBatchStyleConsistency(anchoredBatch, opts);
      checkResults.push(result);
      if (result.failedIndices) {
        for (const { index, issues } of result.failedIndices) {
          if (!failedSpreadMap.has(index)) failedSpreadMap.set(index, []);
          failedSpreadMap.get(index).push(...issues.map(i => `[style] ${i}`));
        }
      }
    } catch (e) {
      console.warn(`[illustrator/quality/consistency] Agent2 style batch error: ${e.message}`);
      for (const s of anchoredBatch) {
        if (!failedSpreadMap.has(s.index)) failedSpreadMap.set(s.index, []);
        failedSpreadMap.get(s.index).push(`[style] QA batch exception: ${e.message}`);
      }
      checkResults.push({ passed: false, failedIndices: anchoredBatch.map(s => ({ index: s.index, issues: [e.message] })) });
    }
  }

  if (checkResults.length === 0) {
    return { overallScore: 1.0, failedSpreads: [] };
  }

  return _finalizeAgentResults(checkResults, failedSpreadMap, 'Cross-spread Agent2 (font+style)');
}

/**
 * Sequential cross-spread QA: Agent 1 then Agent 2 (both must pass for empty failedSpreads).
 *
 * @param {Array<{index: number, imageBase64: string, pageText: string}>} spreads
 * @param {object} [opts]
 * @returns {Promise<{overallScore: number, failedSpreads: Array<{index: number, issues: string[]}>}>}
 */
async function checkCrossSpreadConsistency(spreads, opts = {}) {
  const a1 = await checkCrossSpreadAgent1(spreads, opts);
  if (a1.failedSpreads.length > 0) {
    return a1;
  }
  return checkCrossSpreadAgent2(spreads, opts);
}

// ── Internal batch checks ──

async function _checkBatchCharacterConsistency(batch, opts) {
  const apiKey = getNextApiKey();
  if (!apiKey) return failWholeBatch(batch, 'Character QA unavailable: no Gemini API key');

  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;

  const bibleGroundTruth = opts?.bibleBlock
    ? `\n\nGROUND TRUTH — STORY BIBLE (these descriptions are the locked reference. Flag any image that contradicts them):\n${opts.bibleBlock}\n`
    : '';

  const isParentTheme = opts?.theme === 'mothers_day' || opts?.theme === 'fathers_day';
  const parentOnCover = opts?.hasParentOnCover === true;
  const coverSecondaryNote = opts?.additionalCoverCharacters && opts?.hasSecondaryOnCover
    ? `\n\nCOVER SECONDARY (locked reference): The book cover includes another person described as: ${String(opts.additionalCoverCharacters).slice(0, 700)}. Apply the OVERLAP RULE: wherever that same person clearly appears in 2+ of these images, visible traits (face, hair, skin, outfit, build) must match across those appearances. Do not flag absence in a crop as inconsistency.\n`
    : '';

  const parentResemblanceBlock = isParentTheme && !parentOnCover
    ? `\n8. PARENT (${opts.theme === 'mothers_day' ? 'mother' : 'father'} — face hidden / not on cover): The parent may appear only as partial body (hands, arms, back, cropped head). Apply the OVERLAP RULE to the parent's visible regions only: if the same parent's hands or arms appear clearly in 2+ images, those visible regions must match each other (same person). Do NOT require parent skin or hair to match the hero child's face. Do NOT flag minor lighting/shadow on skin. Flag only: (a) the same parent's visible parts looking like a different person across images where they overlap, or (b) clear categorical ethnicity mismatch if the parent's face were ever wrongly shown. Do not flag "parent vs child" skin differences when only partial parent is visible.`
    : isParentTheme
      ? `\n8. PARENT–CHILD FAMILY RESEMBLANCE (${opts.theme === 'mothers_day' ? 'mother' : 'father'}): Where a parent figure appears with any visible face or identifying features in 2+ images, those appearances must be consistent (same individual). Visible skin/hair should look plausibly related to the hero child where both are visible. Ignore minor lighting. Flag only clear categorical mismatch, obvious same-parent drift across overlapping views, or contradictory ethnicity pairing.`
      : `\n8. IMPLIED PARENT / ADULT CAREGIVER: If an adult is clearly the child's parent or primary caregiver and appears in 2+ images, apply the OVERLAP RULE to their visible traits. Ignore lighting variation. Flag only clear cross-spread drift (same adult looking like a different ethnicity in overlapping views) or obvious unrelated-ethnicity pairing with the child.`;

  const parts = [{
    text: `These are ${batch.length} illustrations from the same children's book. The SAME hero child appears in every image. Named secondary characters must stay visually stable.

CORE — OVERLAP RULE (applies to EVERY character, including the child):
- Different crops and framing are NORMAL. One image may show body parts or clothing regions that another does not show at all.
- Only evaluate a visual trait if it is CLEARLY VISIBLE in TWO OR MORE of these images. If hair, face, outfit, skin, etc. appears in multiple images, those visible instances must match (allow normal lighting/pose).
- Do NOT flag inconsistency because a detail appears in one image but is absent, occluded, or out of frame in another. Do NOT invent contradictions for regions you cannot see.

Be STRICT where overlap exists:
1. HERO — HAIR: If hair (color, length, style) is clearly visible in 2+ images, it must match across those images. If hair is only visible in one image, do not demand consistency with unseen hair in others.
2. HERO — OUTFIT / CLOTHING: If the same garment or a clearly visible clothing region (shirt, sleeves, overalls, etc.) appears in 2+ images, colors and style must match. If an outfit is only fully visible once, do not fail other images for details you cannot compare.
3. HERO — FACE & SKIN: If face or a specific skin region is visible in 2+ images, it must match (same child). Flag real drift between overlapping views — not lighting-only differences.
4. AGE & PROPORTIONS: If the child's full body or comparable framing appears in 2+ images, age and proportions must match. Flag toddler vs older child drift when comparable.
5. ANATOMY (per image): Flag wrong limb counts, extra limbs, merged parts, or a limb that should be visible but is missing in that image's composition.
6. SECONDARY CHARACTERS: If the same named secondary (friend, animal, adult) clearly appears in 2+ images, visible traits must match across those appearances (overlap rule). Do not flag because they are off-panel in some images.
7. SETTINGS: If multiple images depict the SAME named location, overlapping visible environment must match. Do not flag intentional scene changes.${parentResemblanceBlock}${coverSecondaryNote}${bibleGroundTruth}

Do NOT flag: left/right mirroring, minor lighting/shadow, eye open/closed, minor pose differences, intentional location/scene changes, or missing/occluded details with no overlapping contradiction.
DO flag: contradictory appearance of the SAME character/trait where that trait is visibly shown in 2+ images; age/proportion drift when comparable; anatomy errors; location contradiction vs ground truth; parent/cover-secondary issues as in section 8.

Return ONLY valid JSON:
{"consistent": true, "outlierImages": [], "issues": []}
outlierImages = 1-based indices of images that break consistency.`,
  }];

  for (const spread of batch) {
    parts.push({ inline_data: { mimeType: 'image/png', data: spread.imageBase64 } });
  }

  let lastHttp = null;
  for (let attempt = 0; attempt < QA_HTTP_ATTEMPTS; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 512,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }, QA_TIMEOUT_MS, opts.abortSignal);

      if (opts.costTracker) opts.costTracker.addTextUsage(GEMINI_QA_MODEL, 600, 100);

      if (!resp.ok) {
        lastHttp = resp.status;
        if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
        continue;
      }

      const data = await resp.json();
      const text = extractGeminiResponseText(data);
      const result = parseQaJsonFromText(text);

      if (!result) {
        if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
        else return passBatchInfra(batch, 'Character QA: unparseable model response after retries');
        continue;
      }

      if (!result.consistent) {
        const failedIndices = (result.outlierImages || []).map(imgNum => {
          const spread = batch[imgNum - 1];
          return spread ? { index: spread.index, issues: result.issues || ['character inconsistency'] } : null;
        }).filter(Boolean);
        return { passed: false, failedIndices };
      }
      return { passed: true, failedIndices: [] };
    } catch (e) {
      console.warn(`[illustrator/quality/consistency] Batch character check error: ${e.message}`);
      if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
      else return passBatchInfra(batch, `Character QA error: ${e.message}`);
    }
  }
  return passBatchInfra(batch, `Character QA HTTP failed after retries (${lastHttp || 'unknown'})`);
}

async function _checkBatchFontConsistency(batch, opts) {
  const apiKey = getNextApiKey();
  if (!apiKey) return failWholeBatch(batch, 'Font QA unavailable: no Gemini API key');

  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;

  const parts = [{
    text: `These are ${batch.length} pages from the same children's book. The text font on every page MUST be PIXEL-IDENTICAL — same typeface, same weight, same slant, same x-height, same stroke contrast.

Be STRICT. Do NOT give the benefit of the doubt. Flag ANY visible font difference:
1. Font FAMILY — must be clearly the same typeface on every page. Two different serifs = FAIL. A serif on one page and a sans on another = FAIL. A script, handwritten, bubble, or decorative font on any page = FAIL.
2. SLANT — all pages must be upright. ANY italic or oblique rendering = FAIL.
3. WEIGHT — all pages must be the same weight (all regular OR all bold). Mixed weights = FAIL.
4. X-HEIGHT and letter shapes — lowercase letters must look the same size and shape on every page. Different x-heights = FAIL.
5. SIZE (relative to page) — must be visibly consistent. Sizes that vary noticeably = FAIL.
6. COLOR — must be the same color/treatment (same hue, same drop shadow) on every page.

ACCEPTABLE fonts: plain traditional book serifs (Georgia, Book Antiqua, Times-like). Nothing else.
UNACCEPTABLE on ANY page (instant fail for that page): handwritten, script, cursive, italic, bubble, rounded, Comic Sans, Papyrus, Chalkboard, Impact, Marker, decorative, stenciled, condensed, display.

Find the MAJORITY font (or spread 1's font if no majority) and flag EVERY page that drifts. Err on the side of flagging — font drift is a hard defect.

Return ONLY valid JSON:
{"consistent": true, "outlierImages": [], "issues": []}
outlierImages = 1-based indices of pages whose font drifts from the majority/reference.
issues = short human-readable reasons for each flagged page.`,
  }];

  for (const spread of batch) {
    parts.push({ inline_data: { mimeType: 'image/png', data: spread.imageBase64 } });
  }

  let lastHttp = null;
  for (let attempt = 0; attempt < QA_HTTP_ATTEMPTS; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 512,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }, QA_TIMEOUT_MS, opts.abortSignal);

      if (opts.costTracker) opts.costTracker.addTextUsage(GEMINI_QA_MODEL, 500, 100);

      if (!resp.ok) {
        lastHttp = resp.status;
        if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
        continue;
      }

      const data = await resp.json();
      const text = extractGeminiResponseText(data);
      const result = parseQaJsonFromText(text);

      if (!result) {
        if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
        else return passBatchInfra(batch, 'Font QA: unparseable model response after retries');
        continue;
      }

      if (!result.consistent) {
        const failedIndices = (result.outlierImages || []).map(imgNum => {
          const spread = batch[imgNum - 1];
          return spread ? { index: spread.index, issues: result.issues || ['font inconsistency'] } : null;
        }).filter(Boolean);
        return { passed: false, failedIndices };
      }
      return { passed: true, failedIndices: [] };
    } catch (e) {
      console.warn(`[illustrator/quality/consistency] Batch font check error: ${e.message}`);
      if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
      else return passBatchInfra(batch, `Font QA error: ${e.message}`);
    }
  }
  return passBatchInfra(batch, `Font QA HTTP failed after retries (${lastHttp || 'unknown'})`);
}

async function _checkBatchStyleConsistency(batch, opts) {
  const apiKey = getNextApiKey();
  if (!apiKey) return failWholeBatch(batch, 'Style QA unavailable: no Gemini API key');

  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;

  const parts = [{
    text: `These are ${batch.length} illustrations from the same children's book.

Check art style consistency:
1. Rendering technique — all the same (watercolor, digital, 3D, etc.)?
2. Level of detail — consistent?
3. Line weight/quality — consistent?
4. Color palette warmth — consistent?

Minor AI variations are expected. Only flag OBVIOUS style breaks.

Return ONLY valid JSON:
{"consistent": true, "outlierImages": [], "issues": []}
outlierImages = 1-based indices that break the style.`,
  }];

  for (const spread of batch) {
    parts.push({ inline_data: { mimeType: 'image/png', data: spread.imageBase64 } });
  }

  let lastHttp = null;
  for (let attempt = 0; attempt < QA_HTTP_ATTEMPTS; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 512,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }, QA_TIMEOUT_MS, opts.abortSignal);

      if (opts.costTracker) opts.costTracker.addTextUsage(GEMINI_QA_MODEL, 500, 100);

      if (!resp.ok) {
        lastHttp = resp.status;
        if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
        continue;
      }

      const data = await resp.json();
      const text = extractGeminiResponseText(data);
      const result = parseQaJsonFromText(text);

      if (!result) {
        if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
        else return passBatchInfra(batch, 'Style QA: unparseable model response after retries');
        continue;
      }

      if (!result.consistent) {
        const failedIndices = (result.outlierImages || []).map(imgNum => {
          const spread = batch[imgNum - 1];
          return spread ? { index: spread.index, issues: result.issues || ['art style inconsistency'] } : null;
        }).filter(Boolean);
        return { passed: false, failedIndices };
      }
      return { passed: true, failedIndices: [] };
    } catch (e) {
      console.warn(`[illustrator/quality/consistency] Batch style check error: ${e.message}`);
      if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
      else return passBatchInfra(batch, `Style QA error: ${e.message}`);
    }
  }
  return passBatchInfra(batch, `Style QA HTTP failed after retries (${lastHttp || 'unknown'})`);
}

/**
 * Render the story bible into a compact text block for vision QA ground truth.
 */
function _formatBibleForQa(bible) {
  if (!bible) return '';
  const lines = [];
  if (bible.characters?.length) {
    lines.push('Characters:');
    bible.characters.forEach((c) => lines.push(`- ${c.name}: ${c.description}`));
  }
  if (bible.locations?.length) {
    if (lines.length) lines.push('');
    lines.push('Locations:');
    bible.locations.forEach((l) => lines.push(`- ${l.name}: ${l.description}`));
  }
  if (bible.objects?.length) {
    if (lines.length) lines.push('');
    lines.push('Objects:');
    bible.objects.forEach((o) => lines.push(`- ${o.name}: ${o.description}`));
  }
  return lines.join('\n');
}

module.exports = {
  checkCrossSpreadConsistency,
  checkCrossSpreadAgent1,
  checkCrossSpreadAgent2,
  formatBibleForQa: _formatBibleForQa,
};
