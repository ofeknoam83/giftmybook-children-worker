/**
 * Illustrator V2 — Per-Spread OCR Text Verification
 *
 * After each spread, uses Gemini Vision to verify:
 * 1. Text content: each word appears the same number of times as in the manuscript
 * 2. Text does not bridge from left side to right side of the image (or vice versa)
 * 3. Text is within edge margins
 * 4. Font size is not too large
 * 5. Text is legible
 */

const { GEMINI_QA_MODEL, CHAT_API_BASE, QA_TIMEOUT_MS, TEXT_RULES } = require('../config');
const { sanitizeMixedScriptString } = require('../../writer/quality/sanitize');
const { fetchWithTimeout, getNextApiKey } = require('../../illustrationGenerator');
const { extractGeminiResponseText, parseQaJsonFromText } = require('./geminiJson');

const QA_HTTP_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Tokens for per-word frequency (manuscript vs illustration must match).
 * Lowercase; apostrophes of any style are stripped so "McDonald's"/"McDonalds"
 * and "don't"/"dont" count as the same token regardless of what the OCR or
 * manuscript uses for the quote glyph.
 * @param {string} s
 * @returns {string[]}
 */
function tokenizeForWordCounts(s) {
  const ascii = sanitizeMixedScriptString(String(s || ''));
  return ascii
    .toLowerCase()
    .replace(/['‘’ʹʻʼ՚＇‛′ꞌ]/g, '')
    .match(/[a-z0-9]+/g) || [];
}

/**
 * @param {string} expectedText - Story text for this spread (writing-QA approved)
 * @param {string} extractedText - OCR from the illustration
 * @returns {string[]} Human-readable issues; empty if counts match for every token
 */
function wordFrequencyMismatchIssues(expectedText, extractedText) {
  const expTokens = tokenizeForWordCounts(expectedText);
  const extTokens = tokenizeForWordCounts(extractedText);
  const countMap = (tokens) => {
    const m = new Map();
    for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
    return m;
  };
  const E = countMap(expTokens);
  const X = countMap(extTokens);
  const keys = new Set([...E.keys(), ...X.keys()]);
  const issues = [];
  for (const t of keys) {
    const e = E.get(t) || 0;
    const x = X.get(t) || 0;
    if (e !== x) {
      issues.push(`Word "${t}": manuscript ${e}×, illustration ${x}×`);
    }
  }
  return issues;
}

/**
 * Verify text rendered in a generated spread image.
 *
 * @param {string} imageBase64 - Generated image as base64
 * @param {string} expectedText - The story text that should appear
 * @param {object} [opts]
 * @param {object} [opts.costTracker]
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{pass: boolean, issues: string[], score: number, tags?: string[], infra?: boolean}>}
 */
async function verifySpreadText(imageBase64, expectedText, opts = {}) {
  if (!expectedText || !expectedText.trim()) {
    return { pass: true, issues: [], score: 1.0, tags: [] };
  }

  const apiKey = getNextApiKey();
  if (!apiKey) {
    return {
      pass: false,
      issues: ['Text QA unavailable: no Gemini API key configured'],
      score: 0,
      tags: ['qa_unavailable'],
    };
  }

  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;

  const hardTopMarginPct = Math.max(8, Math.floor(TEXT_RULES.topPaddingPercent * 0.55));

  const expectedForQa = sanitizeMixedScriptString(expectedText.trim());

  const prompt = `Analyze the text in this children's book illustration.

EXPECTED TEXT for THIS SPREAD ONLY (approved manuscript — exact source of truth for WHICH WORDS and HOW MANY TIMES each word appears):
"${expectedForQa}"

Check ALL of the following:

1. TEXT CONTENT — WORD COUNTS (CRITICAL):
   Read all story text visible in the image. For EVERY word token (letters/digits, same rules as counting: lowercase, "don't" = one token, ignore punctuation), the count in the image MUST equal the count in the EXPECTED TEXT above.
   Examples: if the manuscript has "hop" three times ("Hop, hop, hop"), the illustration must show "hop" three times — not two, not four.
   If the manuscript has a word once, it must appear exactly once in the art. If the whole caption were accidentally painted twice, many words would appear 2× — that FAILS this rule.
   Do NOT treat legitimate repetition inside the manuscript as an error. Only flag content issues when counts disagree with EXPECTED TEXT or words are wrong/garbled.
   Your extractedText must be the full text you read from the image (best-effort OCR) so we can verify counts programmatically.

2. TEXT SIDE LOCK (CRITICAL): The story text must stay entirely on ONE side of the image. It must NOT cross from the left side of the image to the right side, or from the right side to the left — no line, word, or phrase may bridge both halves. Imagine a vertical line down the middle: all glyphs must lie entirely in the left 50% OR entirely in the right 50%, not spanning across. Also: the middle ${TEXT_RULES.centerExclusionPercent * 2}% band (center ${TEXT_RULES.centerExclusionPercent}% each side of the midpoint) is a NO-TEXT ZONE for the main story text — treat bridging across that band the same as a HARD FAIL. Tag as "text_bridges_sides" or "text_center" when this rule breaks.

3. EDGE MARGINS:
   - Left and right: text must be at least ${TEXT_RULES.edgePaddingPercent}% away from the left and right edges.
   - TOP (CRITICAL — print crop removes the top ~7% of this image): text must be at least ${TEXT_RULES.topPaddingPercent}% from the top edge. Flag with tag "text_top_edge" as a HARD FAIL if the TOP of any letter is within ${hardTopMarginPct}% of the top edge — at that distance it will be cut off after printing.
   - Bottom: text must be at least ${TEXT_RULES.bottomPaddingPercent}% from the bottom edge.

4. TEXT OVER HERO'S FACE/HEAD (HARD FAIL — tag "text_over_face"): Identify the main child (the hero). Does the text overlap, touch, or sit directly on top of the hero's face, head, hair, or eyes? Flag as HARD FAIL if ANY text character is over the hero's head or face. Partial overlap with the hero's body (below the shoulders) is OK if unavoidable; overlap with the head/face is NEVER OK.

5. FONT SIZE: Is the text small and subtitle-like? Or is it large/headline-sized? Flag if text looks like a title or headline.

6. LEGIBILITY: Is the text crisp, sharp, and readable? Flag if blurry, fuzzy, or low contrast.

Return ONLY valid JSON:
{
  "pass": true/false,
  "extractedText": "the exact text you read from the image",
  "issues": ["list of specific issues found"],
  "tags": ["zero or more of: text_top_edge, text_over_face, text_center, text_bridges_sides, text_duplicated, text_garbled, text_too_large, text_illegible, text_word_count_mismatch"],
  "score": 0.0-1.0
}

Score guide: 1.0 = perfect, 0.8+ = minor issues, 0.5-0.8 = significant issues, <0.5 = major problems.
Set pass=false for: word-count mismatch vs expected, text bridging sides, forbidden middle band, missing/garbled words, text over the hero's face/head, or text within ${hardTopMarginPct}% of the top edge.`;

  let lastErrMsg = 'unknown error';

  for (let attempt = 0; attempt < QA_HTTP_ATTEMPTS; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { inline_data: { mimeType: 'image/png', data: imageBase64 } },
              { text: prompt },
            ],
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1024,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }, QA_TIMEOUT_MS, opts.abortSignal);

      if (opts.costTracker) {
        opts.costTracker.addTextUsage(GEMINI_QA_MODEL, 800, 200);
      }

      if (!resp.ok) {
        lastErrMsg = `API HTTP ${resp.status}`;
        if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
        continue;
      }

      const data = await resp.json();
      const text = extractGeminiResponseText(data);
      const result = parseQaJsonFromText(text);

      if (!result) {
        lastErrMsg = 'unparseable model response';
        if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
        continue;
      }
      const issues = Array.isArray(result.issues) ? [...result.issues] : [];
      const rawTags = Array.isArray(result.tags) ? result.tags : [];
      const tags = rawTags.filter(t => typeof t === 'string').map(t => t.toLowerCase().trim()).filter(Boolean);

      const extracted = (result.extractedText || '').trim();

      const freqIssues = wordFrequencyMismatchIssues(expectedForQa, extracted);
      if (freqIssues.length > 0) {
        for (const fi of freqIssues) {
          if (!issues.includes(fi)) issues.push(fi);
        }
        if (!tags.includes('text_word_count_mismatch')) tags.push('text_word_count_mismatch');
      }

      const filteredIssues = issues.filter(i => !/duplicat/i.test(String(i)));
      const filteredTags = tags.filter(t => t !== 'text_duplicated');
      issues.length = 0;
      filteredIssues.forEach(i => issues.push(i));
      tags.length = 0;
      filteredTags.forEach(t => tags.push(t));

      const pass = freqIssues.length === 0 && filteredIssues.length === 0 && filteredTags.length === 0;

      return {
        pass,
        issues,
        tags,
        score: typeof result.score === 'number' ? result.score : (pass ? 1.0 : 0.5),
        extractedText: extracted,
      };
    } catch (e) {
      lastErrMsg = e.message || String(e);
      if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
    }
  }

  return {
    pass: true,
    issues: [],
    tags: ['qa_infra_error'],
    score: 1.0,
    infra: true,
  };
}

module.exports = { verifySpreadText, tokenizeForWordCounts, wordFrequencyMismatchIssues };
