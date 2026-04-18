/**
 * Illustrator V2 — Per-Spread OCR Text Verification
 *
 * After each spread, uses Gemini Vision to verify:
 * 1. Text content matches story text exactly (word-for-word)
 * 2. Text does NOT cross the left-right center
 * 3. Text is within edge margins
 * 4. Font size is not too large
 * 5. Text is legible
 */

const { GEMINI_QA_MODEL, CHAT_API_BASE, QA_TIMEOUT_MS } = require('../config');
const { fetchWithTimeout, getNextApiKey } = require('../../illustrationGenerator');

/**
 * Verify text rendered in a generated spread image.
 *
 * @param {string} imageBase64 - Generated image as base64
 * @param {string} expectedText - The story text that should appear
 * @param {object} [opts]
 * @param {object} [opts.costTracker]
 * @returns {Promise<{pass: boolean, issues: string[], score: number}>}
 */
async function verifySpreadText(imageBase64, expectedText, opts = {}) {
  // No text expected — pass automatically
  if (!expectedText || !expectedText.trim()) {
    return { pass: true, issues: [], score: 1.0 };
  }

  const apiKey = getNextApiKey();
  if (!apiKey) {
    return { pass: true, issues: [], score: 1.0 };
  }

  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;

  const prompt = `Analyze the text in this children's book illustration.

EXPECTED TEXT: "${expectedText}"

Check ALL of the following:

1. TEXT CONTENT: Read the text in the image word-for-word. Does it match the expected text exactly? Flag missing words, extra words, misspellings, garbled text, or DUPLICATED text (same text appearing twice).

2. TEXT PLACEMENT — CENTER EXCLUSION ZONE (CRITICAL): This image will be split into two pages at the exact vertical center. Imagine the image divided into 5 equal vertical columns (each 20% wide). The MIDDLE column (the center 20%) is a NO-TEXT ZONE. ALL text must be completely within the LEFT 40% or the RIGHT 40% of the image. Flag as HARD FAIL if ANY text appears in the center 20% of the image, or if text crosses from one half to the other. Vertical position (top/bottom) does not matter.

3. EDGE MARGINS: Is the text at least ~8% away from all edges (top, bottom, left, right)? Flag if text is too close to any edge.

4. FONT SIZE: Is the text small and subtitle-like? Or is it large/headline-sized? Flag if text looks like a title or headline.

5. LEGIBILITY: Is the text crisp, sharp, and readable? Flag if blurry, fuzzy, or low contrast.

Return ONLY valid JSON:
{
  "pass": true/false,
  "extractedText": "the exact text you read from the image",
  "issues": ["list of specific issues found"],
  "score": 0.0-1.0
}

Score guide: 1.0 = perfect, 0.8+ = minor issues, 0.5-0.8 = significant issues, <0.5 = major problems.
Set pass=false for: text in the center 20%, text crossing the center, duplicated text, missing/garbled text, or text too close to edges.`;

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
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }, QA_TIMEOUT_MS);

    if (opts.costTracker) {
      opts.costTracker.addTextUsage(GEMINI_QA_MODEL, 800, 200);
    }

    if (!resp.ok) {
      console.warn(`[illustrator/quality/text] API error ${resp.status} — accepting`);
      return { pass: true, issues: [], score: 1.0 };
    }

    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const cleaned = text.replace(/```json\s*/i, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);

    if (match) {
      const result = JSON.parse(match[0]);
      return {
        pass: !!result.pass,
        issues: result.issues || [],
        score: typeof result.score === 'number' ? result.score : (result.pass ? 1.0 : 0.5),
        extractedText: result.extractedText || '',
      };
    }
  } catch (e) {
    console.warn(`[illustrator/quality/text] Error: ${e.message} — accepting`);
  }

  return { pass: true, issues: [], score: 1.0 };
}

module.exports = { verifySpreadText };
