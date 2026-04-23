/**
 * Illustrator — Text QA (OCR)
 *
 * Per-spread, stateless vision call to gemini-2.5-flash. Reads every text
 * element rendered on the illustration and returns:
 *   - ocrText: concatenation of all detected text, in reading order
 *   - leftText / rightText / centerText: text split by horizontal position
 *   - textCrossesMidline: boolean (a single block spans left↔right)
 *
 * Then compares against the expected passage on the expected side:
 *   - Opposite side must be empty (no duplicated caption, no stray text).
 *   - Center band must be empty.
 *   - Expected side must contain the full expected caption, char-for-char.
 *   - No unexpected words on either side ("the end", signatures, decorative).
 *
 * Returns {pass, issues, tags, ocrText, infra}.
 */

const {
  GEMINI_QA_MODEL,
  CHAT_API_BASE,
  QA_TIMEOUT_MS,
  QA_HTTP_ATTEMPTS,
  TEXT_RULES,
  defaultTextSide,
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
    if (e > 0 && o === 0) { issues.push(`Word "${t}" missing from illustration (manuscript ${e}×, illustration 0×)`); tags.push('missing_word'); }
    else if (e === 0 && o > 0) { issues.push(`Unexpected word "${t}" in illustration (not in manuscript)`); tags.push('extra_word'); }
    else if (o > e) { issues.push(`Word "${t}" repeated: manuscript ${e}×, illustration ${o}×`); tags.push('duplicated_word'); }
    else { issues.push(`Word "${t}" under-rendered: manuscript ${e}×, illustration ${o}×`); tags.push('missing_word'); }
  }
  return { issues, tags: [...new Set(tags)] };
}

/**
 * Detect duplicated-caption pattern (50%+ of unique tokens at exactly 2×).
 * A common model failure mode is to print the caption on BOTH sides.
 */
function hasDuplicatedCaption(expected, ocr) {
  const E = countMap(tokenizeForWordCounts(expected));
  const O = countMap(tokenizeForWordCounts(ocr));
  if (E.size < 3) return false;
  const doubled = [...E.keys()].filter(t => {
    const e = E.get(t) || 0;
    const o = O.get(t) || 0;
    return e > 0 && o === 2 * e;
  });
  return doubled.length / E.size >= 0.5;
}

/**
 * Normalizes typographic differences between manuscript and rendered OCR
 * (curly quotes, dashes, extra wrapping quotes) for comparison.
 *
 * @param {string} s
 * @returns {string}
 */
function normalizeCaptionForOcrCompare(s) {
  let t = sanitizeMixedScriptString(String(s || ''));
  t = t
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u00B4\u0060\u02B9\u02BC\uFF07\u201C\u201D\u201E\u00AB\u00BB\u2039\u203A\uFEFF]/g, "'")
    .replace(/[\u2013\u2014\u2212\uFE63\uFF0D]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === b) && (a === "'" || a === '"')) t = t.slice(1, -1).trim();
  }
  return t;
}

/**
 * Resolve expected text + side from either the new shape ({text, side}) or
 * the legacy split shape ({leftText, rightText}).
 */
function resolveExpected(expected, spreadIndex) {
  if (!expected) return { text: '', side: defaultTextSide(spreadIndex || 0) };

  let text = typeof expected.text === 'string' ? expected.text.trim() : '';
  let side = (expected.side === 'left' || expected.side === 'right') ? expected.side : null;

  if (!text) {
    const parts = [expected.leftText, expected.rightText]
      .filter(s => typeof s === 'string' && s.trim().length > 0)
      .map(s => s.trim());
    text = parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  if (!side) side = defaultTextSide(spreadIndex || 0);
  return { text, side };
}

/**
 * Verify text rendered on a generated spread image.
 *
 * @param {string} imageBase64
 * @param {{text?: string, side?: 'left'|'right', leftText?: string, rightText?: string}} expected
 * @param {object} [opts]
 * @param {number} [opts.spreadIndex] - 0-based; used to derive side when not given.
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{pass: boolean, issues: string[], tags: string[], ocrText?: string, infra?: boolean}>}
 */
async function verifySpreadText(imageBase64, expected, opts = {}) {
  const { text: expectedText, side: expectedSide } = resolveExpected(expected || {}, opts.spreadIndex);
  const anyExpected = expectedText.length > 0;

  const apiKey = getNextApiKey();
  if (!apiKey) {
    return { pass: false, issues: ['Text QA unavailable: no Gemini API key configured'], tags: ['qa_unavailable'], infra: true };
  }

  const prompt = buildOcrPrompt({ expectedText, expectedSide, anyExpected });
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
      return evaluateOcrResult(parsed, { expectedText, expectedSide, anyExpected });
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

function buildOcrPrompt({ expectedText, expectedSide, anyExpected }) {
  const activeMax = TEXT_RULES.activeSideMaxPercent / 100;

  return `You are an OCR + layout analyst for a children's book illustration. Read the image and return a STRICT JSON object with this schema (no commentary, no markdown fences):

{
  "ocrText": "<every text element visible on the image, concatenated in natural reading order, exactly as rendered>",
  "leftText": "<only the text whose horizontal bounding-box MIDPOINT is strictly in the LEFT half (x < 0.5)>",
  "rightText": "<only the text whose horizontal bounding-box MIDPOINT is strictly in the RIGHT half (x > 0.5)>",
  "centerText": "<text whose bounding box overlaps the center band (x ∈ [${activeMax.toFixed(3)}, ${(1 - activeMax).toFixed(3)}])>",
  "crossesMidline": <true if ANY single text block has a bounding box that spans from x < ${activeMax.toFixed(3)} to x > ${(1 - activeMax).toFixed(3)}, otherwise false>,
  "textOnBothSides": <true if there is text whose bbox is entirely in x < 0.5 AND text whose bbox is entirely in x > 0.5, otherwise false>,
  "fontLooksPlainBookSerif": <true ONLY if the text is rendered in an upright, plain book serif (Georgia / Book Antiqua style). Return false if the text is handwritten, script, cursive, calligraphic, italic, bold display, rounded bubble, decorative, Comic Sans, Papyrus, or any marker/chalk/crayon style.>
}

Coordinate system: x=0 is the left edge of the image, x=1 is the right edge. Use the MIDPOINT of each text block's bounding box to assign it to left/right/center.

${anyExpected
  ? `Expected text for reference only — DO NOT edit what you read, report the EXACT glyphs on the image:
  TEXT (expected): ${JSON.stringify(expectedText)}
  EXPECTED SIDE: ${expectedSide.toUpperCase()}
  Per the spread's rules, ALL of the caption text should be on the ${expectedSide.toUpperCase()} side. The opposite side and the center band should be text-free.`
  : 'No text is expected on this spread. If you see any text at all, include it in the response.'}

Return ONLY the JSON object.`;
}

/**
 * @param {object} parsed - OCR model JSON
 * @param {object} ctx
 * @param {string} ctx.expectedText
 * @param {'left'|'right'} ctx.expectedSide
 * @param {boolean} ctx.anyExpected
 */
function evaluateOcrResult(parsed, { expectedText, expectedSide, anyExpected }) {
  const issues = [];
  const tags = [];

  const ocrText = String(parsed.ocrText || '').trim();
  const leftOcr = String(parsed.leftText || '').trim();
  const rightOcr = String(parsed.rightText || '').trim();
  const centerOcr = String(parsed.centerText || '').trim();
  const crossesMidline = !!parsed.crossesMidline;
  const textOnBothSides = !!parsed.textOnBothSides;
  const fontOk = parsed.fontLooksPlainBookSerif !== false; // missing -> treat as OK (fail-safe on infra)

  // ── No-text case ──
  if (!anyExpected) {
    if (ocrText) {
      issues.push(`Unexpected text on a no-text spread: "${ocrText.slice(0, 120)}"`);
      tags.push('unexpected_text');
    }
    return { pass: issues.length === 0, issues, tags, ocrText };
  }

  const expectedOcr = expectedSide === 'left' ? leftOcr : rightOcr;
  const oppositeOcr = expectedSide === 'left' ? rightOcr : leftOcr;
  const oppositeSide = expectedSide === 'left' ? 'right' : 'left';

  // ── Placement: single-side enforcement ──
  if (centerOcr) {
    issues.push(`Text in center band: "${centerOcr.slice(0, 80)}"`);
    tags.push('text_in_center_band');
  }
  if (crossesMidline) {
    issues.push('A text block crosses the midline (spans left↔right)');
    tags.push('text_crosses_midline');
  }
  if (textOnBothSides || oppositeOcr) {
    issues.push(
      textOnBothSides
        ? `Text appears on BOTH sides. The spread's caption must be on the ${expectedSide.toUpperCase()} side only; the ${oppositeSide.toUpperCase()} side must be text-free.`
        : `Unexpected text on the ${oppositeSide.toUpperCase()} side (should be text-free): "${oppositeOcr.slice(0, 120)}"`
    );
    tags.push('text_on_both_sides');
  }

  // ── Font ──
  if (!fontOk) {
    issues.push('Font is not a plain book serif (Georgia/Book Antiqua style)');
    tags.push('wrong_font');
  }

  // ── Expected-side spelling + tokens (typography-tolerant) ──
  const expNorm = sanitizeMixedScriptString(expectedText).replace(/\s+/g, ' ').trim();
  const gotNorm = sanitizeMixedScriptString(expectedOcr).replace(/\s+/g, ' ').trim();
  const expCanon = normalizeCaptionForOcrCompare(expectedText);
  const gotCanon = normalizeCaptionForOcrCompare(expectedOcr);
  const stringMatchAfterNormalize = expCanon === gotCanon;
  if (!stringMatchAfterNormalize && expNorm !== gotNorm) {
    issues.push(`${expectedSide.toUpperCase()}-side text mismatch. Expected: "${expectedText}". Got: "${expectedOcr}"`);
    tags.push('spelling_mismatch');
  }
  const d = stringMatchAfterNormalize
    ? { issues: [], tags: [] }
    : diffTokens(expCanon, gotCanon);
  if (d.issues.length && !issues.some(i => i.includes('-side text mismatch'))) {
    issues.push(...d.issues.map(i => `${expectedSide.toUpperCase()}: ${i}`));
  }
  tags.push(...d.tags);

  // ── Caption-doubled (common failure: print caption on BOTH sides) ──
  if (hasDuplicatedCaption(expectedText, ocrText)) {
    issues.push('Caption appears to be printed twice on the image (likely duplicated onto both sides)');
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
  resolveExpected,
  normalizeCaptionForOcrCompare,
  evaluateOcrResult,
  hasDuplicatedCaption,
};
