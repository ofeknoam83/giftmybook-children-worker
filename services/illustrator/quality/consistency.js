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

/**
 * Split array into chunks.
 */
function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
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

  // ── Check 1: Character consistency (batches of 4) ──
  const batches = chunk(spreads, MAX_IMAGES_PER_BATCH);
  for (const batch of batches) {
    try {
      const result = await _checkBatchCharacterConsistency(batch, opts);
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

  const parts = [{
    text: `These are ${batch.length} illustrations from the same children's book.

Check character consistency across ALL images:
1. Face shape, features — same person across all?
2. Hair color, style — same across all?
3. Skin tone — same across all?
4. Outfit — same clothing in every image?

Do NOT flag: left/right mirroring, minor lighting differences, eye open/closed state.
Only flag OBVIOUS differences where the character is unrecognizable.

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
    text: `These are ${batch.length} pages from the same children's book.

Compare the text rendering — the font must be IDENTICAL across all pages:
1. Font family — is it clearly the same serif font on every page? Different serif families count as a FAIL.
2. Font size (relative to page) — consistent?
3. Font weight/boldness — consistent?
4. Text color — same?

Find the MAJORITY style. Flag any page that uses a visibly different font family, weight, or size.
The font should look like the same typeface was used — not just "both are serifs."

Return ONLY valid JSON:
{"consistent": true, "outlierImages": [], "issues": []}
outlierImages = 1-based indices of pages that differ from the majority.`,
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

module.exports = { checkCrossSpreadConsistency };
