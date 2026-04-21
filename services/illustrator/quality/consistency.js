/**
 * Illustrator V2 — Cross-Spread Consistency Check
 *
 * After all 13 spreads are generated, checks uniformity across the set:
 * 1. Character face/hair/outfit consistency
 * 2. Art style consistency
 * 3. Font consistency
 * 4. Object consistency
 */

const { GEMINI_QA_MODEL, CHAT_API_BASE, QA_TIMEOUT_MS } = require('../config');
const { fetchWithTimeout, getNextApiKey } = require('../../illustrationGenerator');

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

/**
 * Parse JSON from Gemini response text.
 */
function parseJsonResponse(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*/i, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { return null; }
  }
  return null;
}

/**
 * Run cross-spread consistency checks on all generated spreads.
 *
 * @param {Array<{index: number, imageBase64: string, pageText: string}>} spreads
 * @param {object} [opts]
 * @param {object} [opts.costTracker]
 * @returns {Promise<{overallScore: number, failedSpreads: Array<{index: number, issues: string[]}>}>}
 */
async function checkCrossSpreadConsistency(spreads, opts = {}) {
  if (spreads.length < 2) {
    return { overallScore: 1.0, failedSpreads: [] };
  }

  const failedSpreadMap = new Map(); // index -> issues[]
  const checkResults = [];
  const bibleBlock = _formatBibleForQa(opts.storyBible);

  // ── Check 1: Character consistency (overlapping windows of 4, stride 3) ──
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
      console.warn(`[illustrator/quality/consistency] Character batch check error: ${e.message}`);
    }
  }

  // ── Check 2: Font consistency (only spreads with text) ──
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
        console.warn(`[illustrator/quality/consistency] Font batch check error: ${e.message}`);
      }
    }
  }

  // ── Check 3: Art style consistency (anchored to spread 1) ──
  // Chunk non-anchor spreads at MAX_IMAGES_PER_BATCH - 1 so anchor + batch fits in one batch
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
      console.warn(`[illustrator/quality/consistency] Style batch check error: ${e.message}`);
    }
  }

  // Calculate overall score
  const totalChecks = checkResults.length || 1;
  const passedChecks = checkResults.filter(r => r.passed).length;
  const overallScore = passedChecks / totalChecks;

  const failedSpreads = Array.from(failedSpreadMap.entries()).map(([index, issues]) => ({
    index,
    issues,
  }));

  console.log(`[illustrator/quality/consistency] Cross-spread QA: score=${(overallScore * 100).toFixed(0)}%, failedSpreads=${failedSpreads.length}`);

  return { overallScore, failedSpreads };
}

// ── Internal batch checks ──

async function _checkBatchCharacterConsistency(batch, opts) {
  const apiKey = getNextApiKey();
  if (!apiKey) return { passed: true, failedIndices: [] };

  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;

  const bibleGroundTruth = opts?.bibleBlock
    ? `\n\nGROUND TRUTH — STORY BIBLE (these descriptions are the locked reference. Flag any image that contradicts them):\n${opts.bibleBlock}\n`
    : '';

  const isParentTheme = opts?.theme === 'mothers_day' || opts?.theme === 'fathers_day';
  const parentResemblanceBlock = isParentTheme
    ? `\n8. PARENT–CHILD FAMILY RESEMBLANCE (${opts.theme === 'mothers_day' ? 'mother' : 'father'}, face is hidden by design): Wherever any parent figure appears (visible through hands, arms, neck, back of head, ears, shoulders), the parent's visible SKIN TONE must match the child's skin tone, and the parent's hair color must be in the same color family as the child's. Flag any image where the parent is visibly a different ethnicity or skin tone from the child (e.g., Black parent with a white child, East Asian parent with a white child, etc.). Also flag if the parent's skin tone is inconsistent across spreads (light in one spread, dark in another).`
    : '';

  const parts = [{
    text: `These are ${batch.length} illustrations from the same children's book. The SAME child appears in every image; named secondary characters must look identical whenever they appear.

Check character consistency across ALL images — be STRICT:
1. HAIR: Is the hair color, length, and style the SAME in every image? Flag if hair changes color (e.g., dark to light), changes length (short to long), or changes style (curly to straight, ponytail to loose).
2. OUTFIT: Is the child wearing the SAME clothes in every image? Flag if clothing color, style, or type changes between images. The outfit must be identical on every page.
3. FACE: Same face shape and skin tone across all?
4. AGE & PROPORTIONS: Does the child look the SAME AGE in every image? Flag if the child looks like a toddler in one image but a 5-6 year old in another. Body proportions (height, head-to-body ratio, limb length) must be consistent. This is CRITICAL — age drift between spreads is a major defect.
5. ANATOMY: Does every image show the correct number of limbs? Flag any image with 3 hands, 3 arms, extra limbs, or merged body parts. Also flag any image where a character is MISSING a limb that should be visible (one arm when both should show, one leg when both should show, a hand ending mid-wrist where a hand should be).
6. SECONDARY CHARACTERS: if any named secondary character (a friend, animal companion, adult, etc.) appears across multiple images, their appearance must match across those images — same species, same face/fur, same outfit, same colors. Flag any image where a secondary character's appearance drifts.
7. SETTINGS: if multiple images take place in the same named location, the setting must match (same room, same landmarks, same color palette baseline). Flag a location mismatch only when the text/scene says it's the SAME place but the visuals disagree.${parentResemblanceBlock}${bibleGroundTruth}

Do NOT flag: left/right mirroring, minor lighting/shadow differences, eye open/closed state, minor pose differences, or intentional location changes between scenes.
DO flag: any change in hair color/style/length, any change in outfit/clothing, any skin tone shift, any age/proportion shift, any anatomy errors (extra OR missing limbs), any secondary character drift, any location mismatch that contradicts the ground truth${isParentTheme ? ', any parent–child ethnicity/skin-tone mismatch' : ''}.

Return ONLY valid JSON:
{"consistent": true, "outlierImages": [], "issues": []}
outlierImages = 1-based indices of images that break consistency.`,
  }];

  for (const spread of batch) {
    parts.push({ inline_data: { mimeType: 'image/png', data: spread.imageBase64 } });
  }

  try {
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 512, thinkingConfig: { thinkingBudget: 0 } },
      }),
    }, QA_TIMEOUT_MS);

    if (opts.costTracker) opts.costTracker.addTextUsage(GEMINI_QA_MODEL, 600, 100);
    if (!resp.ok) return { passed: true, failedIndices: [] };

    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const result = parseJsonResponse(text);

    if (result && !result.consistent) {
      const failedIndices = (result.outlierImages || []).map(imgNum => {
        const spread = batch[imgNum - 1];
        return spread ? { index: spread.index, issues: result.issues || ['character inconsistency'] } : null;
      }).filter(Boolean);
      return { passed: false, failedIndices };
    }
  } catch (e) {
    console.warn(`[illustrator/quality/consistency] Batch character check error: ${e.message}`);
  }

  return { passed: true, failedIndices: [] };
}

async function _checkBatchFontConsistency(batch, opts) {
  const apiKey = getNextApiKey();
  if (!apiKey) return { passed: true, failedIndices: [] };

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

  try {
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 512, thinkingConfig: { thinkingBudget: 0 } },
      }),
    }, QA_TIMEOUT_MS);

    if (opts.costTracker) opts.costTracker.addTextUsage(GEMINI_QA_MODEL, 500, 100);
    if (!resp.ok) return { passed: true, failedIndices: [] };

    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const result = parseJsonResponse(text);

    if (result && !result.consistent) {
      const failedIndices = (result.outlierImages || []).map(imgNum => {
        const spread = batch[imgNum - 1];
        return spread ? { index: spread.index, issues: result.issues || ['font inconsistency'] } : null;
      }).filter(Boolean);
      return { passed: false, failedIndices };
    }
  } catch (e) {
    console.warn(`[illustrator/quality/consistency] Batch font check error: ${e.message}`);
  }

  return { passed: true, failedIndices: [] };
}

async function _checkBatchStyleConsistency(batch, opts) {
  const apiKey = getNextApiKey();
  if (!apiKey) return { passed: true, failedIndices: [] };

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

  try {
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 512, thinkingConfig: { thinkingBudget: 0 } },
      }),
    }, QA_TIMEOUT_MS);

    if (opts.costTracker) opts.costTracker.addTextUsage(GEMINI_QA_MODEL, 500, 100);
    if (!resp.ok) return { passed: true, failedIndices: [] };

    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const result = parseJsonResponse(text);

    if (result && !result.consistent) {
      const failedIndices = (result.outlierImages || []).map(imgNum => {
        const spread = batch[imgNum - 1];
        return spread ? { index: spread.index, issues: result.issues || ['art style inconsistency'] } : null;
      }).filter(Boolean);
      return { passed: false, failedIndices };
    }
  } catch (e) {
    console.warn(`[illustrator/quality/consistency] Batch style check error: ${e.message}`);
  }

  return { passed: true, failedIndices: [] };
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

module.exports = { checkCrossSpreadConsistency };
