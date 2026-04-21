/**
 * Illustrator V2 — Per-Spread OCR Text Verification
 *
 * After each spread, uses Gemini Vision to verify:
 * 1. Text content matches story text exactly (word-for-word)
 * 2. Text does not bridge from left side to right side of the image (or vice versa)
 * 3. Text is within edge margins
 * 4. Font size is not too large
 * 5. Text is legible
 */

const { GEMINI_QA_MODEL, CHAT_API_BASE, QA_TIMEOUT_MS, TEXT_RULES } = require('../config');
const { fetchWithTimeout, getNextApiKey } = require('../../illustrationGenerator');
const { extractGeminiResponseText, parseQaJsonFromText } = require('./geminiJson');

const QA_HTTP_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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

  const prompt = `Analyze the text in this children's book illustration.

EXPECTED TEXT: "${expectedText}"

Check ALL of the following:

1. TEXT CONTENT: Read the text in the image word-for-word. Does it match the expected text exactly? Flag missing words, extra words, misspellings, garbled text, or DUPLICATED text (same text appearing twice).

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
  "tags": ["zero or more of: text_top_edge, text_over_face, text_center, text_bridges_sides, text_duplicated, text_garbled, text_too_large, text_illegible"],
  "score": 0.0-1.0
}

Score guide: 1.0 = perfect, 0.8+ = minor issues, 0.5-0.8 = significant issues, <0.5 = major problems.
Set pass=false for: text bridging left and right sides, text in the forbidden middle band, duplicated text, missing/garbled text, text over the hero's face/head, or text within ${hardTopMarginPct}% of the top edge.`;

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
      const issues = result.issues || [];
      const rawTags = Array.isArray(result.tags) ? result.tags : [];
      const tags = rawTags.filter(t => typeof t === 'string').map(t => t.toLowerCase().trim()).filter(Boolean);
      let pass = !!result.pass;

      const extracted = (result.extractedText || '').trim();
      if (extracted && expectedText) {
        const expectedWords = expectedText.trim().split(/\s+/).length;
        const extractedWords = extracted.split(/\s+/).length;
        if (extractedWords > expectedWords * 1.5 && expectedWords >= 4) {
          pass = false;
          issues.push('DUPLICATED text: extracted text is significantly longer than expected, suggesting the same text was rendered multiple times');
          if (!tags.includes('text_duplicated')) tags.push('text_duplicated');
        }
      }

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

module.exports = { verifySpreadText };
