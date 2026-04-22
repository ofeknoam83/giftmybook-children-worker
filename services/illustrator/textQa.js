/**
 * Illustrator — Text QA (OCR)
 *
 * Per-spread, stateless vision call to gemini-2.5-flash. Reads every text
 * element rendered on the illustration and returns:
 *   - ocrText: concatenation of all detected text, in reading order
 *   - leftText / rightText / centerText: text split by horizontal position
 *   - textInCenterBand: boolean (any text whose bbox overlaps the center band)
 *   - textCrossesMidline: boolean (a single block that spans left↔right)
 *
 * Then compares against the expected LEFT / RIGHT text passages:
 *   - spelling: exact character match (after unicode normalization)
 *   - word counts: each expected token appears the expected number of times
 *   - placement: nothing in the center band, no cross-midline spans
 *   - extras: no unexpected words ("the end", signatures, decorative quotes)
 *
 * Returns {pass, issues, tags, ocrText, infra}.
 */

const {
  GEMINI_QA_MODEL,
  CHAT_API_BASE,
  QA_TIMEOUT_MS,
  QA_HTTP_ATTEMPTS,
  TEXT_RULES,
} = require('./config');
const { fetchWithTimeout, getNextApiKey } = require('../illustrationGenerator');
const { sanitizeMixedScriptString } = require('../writer/quality/sanitize');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractGeminiResponseText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter(p => p && typeof p.text === 'string' && p.text.length && p.thought !== true)
    .map(p => p.text)
    .join('\n')
    .trim();
}

function parseJsonBlock(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*/i, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

/**
 * Tokens for per-word frequency (manuscript vs illustration must match).
 * Lowercase; apostrophes of any style are stripped so "McDonald's" / "McDonalds"
 * and "don't" / "dont" count as the same token regardless of quote glyph.
 */
function tokenizeForWordCounts(s) {
  const ascii = sanitizeMixedScriptString(String(s || ''));
  return ascii
    .toLowerCase()
    .replace(/['\u2018\u2019\u02B9\u02BB\u02BC\u055A\uFF07\u201B\u2032\uA78C]/g, '')
    .match(/[a-z0-9]+/g) || [];
}

function countMap(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

/**
 * Compare expected vs OCR tokens and produce readable issues.
 * @returns {{issues: string[], tags: string[]}}
 */
function diffTokens(expected, ocr) {
  const E = countMap(tokenizeForWordCounts(expected));
  const O = countMap(tokenizeForWordCounts(ocr));
  const keys = new Set([...E.keys(), ...O.keys()]);
  const issues = [];
  const tags = [];
  for (const t of keys) {
    const e = E.get(t) || 0;
    const o = O.get(t) || 0;
    if (e === o) continue;
    if (e > 0 && o === 0) { issues.push(`Word "${t}" missing from illustration (manuscript 1×, illustration 0×)`); tags.push('missing_word'); }
    else if (e === 0 && o > 0) { issues.push(`Unexpected word "${t}" in illustration (not in manuscript)`); tags.push('extra_word'); }
    else if (o > e) { issues.push(`Word "${t}" repeated: manuscript ${e}×, illustration ${o}×`); tags.push('duplicated_word'); }
    else { issues.push(`Word "${t}" under-rendered: manuscript ${e}×, illustration ${o}×`); tags.push('missing_word'); }
  }
  return { issues, tags: [...new Set(tags)] };
}

/**
 * Detect duplicated-caption pattern (50%+ of unique tokens at exactly 2×).
 */
function hasDuplicatedCaption(expected, ocr) {
  const E = countMap(tokenizeForWordCounts(expected));
  const O = countMap(tokenizeForWordCounts(ocr));
  if (E.size < 3) return false;
  const doubled = [...E.keys()].filter(t => (O.get(t) || 0) === 2 * (E.get(t) || 0) && (E.get(t) || 0) > 0);
  return doubled.length / E.size >= 0.5;
}

/**
 * Verify text rendered on a generated spread image.
 *
 * @param {string} imageBase64
 * @param {{leftText?: string, rightText?: string}} expected
 * @param {object} [opts]
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{pass: boolean, issues: string[], tags: string[], ocrText?: string, infra?: boolean}>}
 */
async function verifySpreadText(imageBase64, expected, opts = {}) {
  const leftExpected = (expected?.leftText || '').trim();
  const rightExpected = (expected?.rightText || '').trim();
  const anyExpected = !!(leftExpected || rightExpected);

  const apiKey = getNextApiKey();
  if (!apiKey) {
    return { pass: false, issues: ['Text QA unavailable: no Gemini API key configured'], tags: ['qa_unavailable'], infra: true };
  }

  const prompt = buildOcrPrompt({ leftExpected, rightExpected, anyExpected });
  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mimeType: 'image/png', data: imageBase64 } },
        { text: prompt },
      ],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  let lastErr = null;
  for (let attempt = 1; attempt <= QA_HTTP_ATTEMPTS; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, QA_TIMEOUT_MS, opts.abortSignal);

      if (!resp.ok) {
        lastErr = new Error(`Text QA HTTP ${resp.status}`);
        await sleep(500 * attempt);
        continue;
      }
      const data = await resp.json();
      const txt = extractGeminiResponseText(data);
      const parsed = parseJsonBlock(txt);
      if (!parsed) {
        lastErr = new Error('Text QA returned unparseable response');
        await sleep(500 * attempt);
        continue;
      }
      return evaluateOcrResult(parsed, { leftExpected, rightExpected, anyExpected });
    } catch (err) {
      lastErr = err;
      await sleep(500 * attempt);
    }
  }

  // Fail-open on infra errors — the caller can decide whether to trust it or retry.
  console.warn(`[illustrator/textQa] Fail-open after ${QA_HTTP_ATTEMPTS} attempts: ${lastErr?.message}`);
  return {
    pass: false,
    issues: [`Text QA infra error: ${lastErr?.message || 'unknown'}`],
    tags: ['qa_api_error'],
    infra: true,
  };
}

function buildOcrPrompt({ leftExpected, rightExpected, anyExpected }) {
  const imgW = 1; // normalized coords
  const centerHalfWidth = TEXT_RULES.centerExclusionPercent / 100;
  const leftBoundary = 0.5 - centerHalfWidth;
  const rightBoundary = 0.5 + centerHalfWidth;

  return `You are an OCR + layout analyst for a children's book illustration. Read the image and return a STRICT JSON object with this schema (no commentary, no markdown fences):

{
  "ocrText": "<every text element visible on the image, concatenated in natural reading order, exactly as rendered>",
  "leftText": "<only the text whose horizontal bounding-box midpoint is in the LEFT half (x < ${leftBoundary.toFixed(3)})>",
  "rightText": "<only the text whose horizontal bounding-box midpoint is in the RIGHT half (x > ${rightBoundary.toFixed(3)})>",
  "centerText": "<text whose bounding box overlaps the center band (${leftBoundary.toFixed(3)} <= x <= ${rightBoundary.toFixed(3)})>",
  "crossesMidline": <true if ANY single text block has a bounding box that spans from x < ${leftBoundary.toFixed(3)} to x > ${rightBoundary.toFixed(3)}, otherwise false>,
  "fontLooksPlainBookSerif": <true ONLY if the text is rendered in an upright, plain book serif (Georgia / Book Antiqua style). Return false if the text is handwritten, script, cursive, calligraphic, italic, bold display, rounded bubble, decorative, Comic Sans, Papyrus, or any marker/chalk/crayon style.>
}

Coordinate system: x=0 is the left edge of the image, x=${imgW} is the right edge. Use the MIDPOINT of each text block's bounding box to assign it to left/right/center.

${anyExpected
  ? `Expected text for reference only — DO NOT edit what you read, report the EXACT glyphs on the image:
  LEFT (expected): ${leftExpected ? JSON.stringify(leftExpected) : '""'}
  RIGHT (expected): ${rightExpected ? JSON.stringify(rightExpected) : '""'}`
  : 'No text is expected on this spread. If you see any text at all, include it in the response.'}

Return ONLY the JSON object.`;
}

function evaluateOcrResult(parsed, { leftExpected, rightExpected, anyExpected }) {
  const issues = [];
  const tags = [];

  const ocrText = String(parsed.ocrText || '').trim();
  const leftOcr = String(parsed.leftText || '').trim();
  const rightOcr = String(parsed.rightText || '').trim();
  const centerOcr = String(parsed.centerText || '').trim();
  const crossesMidline = !!parsed.crossesMidline;
  const fontOk = parsed.fontLooksPlainBookSerif !== false; // missing -> treat as OK (fail-safe on infra)

  // ── No-text case ──
  if (!anyExpected) {
    if (ocrText) {
      issues.push(`Unexpected text on a no-text spread: "${ocrText.slice(0, 120)}"`);
      tags.push('unexpected_text');
    }
    return { pass: issues.length === 0, issues, tags, ocrText };
  }

  // ── Placement ──
  if (centerOcr) {
    issues.push(`Text in center band: "${centerOcr.slice(0, 80)}"`);
    tags.push('text_in_center_band');
  }
  if (crossesMidline) {
    issues.push('A text block crosses the midline (spans left↔right)');
    tags.push('text_crosses_midline');
  }

  // ── Font ──
  if (!fontOk) {
    issues.push('Font is not a plain book serif (Georgia/Book Antiqua style)');
    tags.push('wrong_font');
  }

  // ── Left side spelling + tokens ──
  const leftExpNorm = sanitizeMixedScriptString(leftExpected);
  const leftOcrNorm = sanitizeMixedScriptString(leftOcr);
  if (leftExpected) {
    if (leftExpNorm.replace(/\s+/g, ' ').trim() !== leftOcrNorm.replace(/\s+/g, ' ').trim()) {
      issues.push(`Left-side text mismatch. Expected: "${leftExpected}". Got: "${leftOcr}"`);
      tags.push('spelling_mismatch');
    }
    const d = diffTokens(leftExpected, leftOcr);
    if (d.issues.length && !issues.some(i => i.startsWith('Left-side text mismatch'))) {
      issues.push(...d.issues.map(i => `Left: ${i}`));
    }
    tags.push(...d.tags);
  } else if (leftOcr) {
    issues.push(`Unexpected text on the left half: "${leftOcr.slice(0, 80)}"`);
    tags.push('extra_word');
  }

  // ── Right side spelling + tokens ──
  const rightExpNorm = sanitizeMixedScriptString(rightExpected);
  const rightOcrNorm = sanitizeMixedScriptString(rightOcr);
  if (rightExpected) {
    if (rightExpNorm.replace(/\s+/g, ' ').trim() !== rightOcrNorm.replace(/\s+/g, ' ').trim()) {
      issues.push(`Right-side text mismatch. Expected: "${rightExpected}". Got: "${rightOcr}"`);
      tags.push('spelling_mismatch');
    }
    const d = diffTokens(rightExpected, rightOcr);
    if (d.issues.length && !issues.some(i => i.startsWith('Right-side text mismatch'))) {
      issues.push(...d.issues.map(i => `Right: ${i}`));
    }
    tags.push(...d.tags);
  } else if (rightOcr) {
    issues.push(`Unexpected text on the right half: "${rightOcr.slice(0, 80)}"`);
    tags.push('extra_word');
  }

  // ── Caption-doubled ──
  const fullExpected = [leftExpected, rightExpected].filter(Boolean).join(' ');
  if (hasDuplicatedCaption(fullExpected, ocrText)) {
    issues.push('Caption appears to be printed twice on the image');
    tags.push('text_duplicated_caption');
  }

  return {
    pass: issues.length === 0,
    issues,
    tags: [...new Set(tags)],
    ocrText,
  };
}

module.exports = {
  verifySpreadText,
  // exported for unit-tests
  tokenizeForWordCounts,
  diffTokens,
};
