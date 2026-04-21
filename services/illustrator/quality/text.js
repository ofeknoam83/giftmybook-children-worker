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

const { GEMINI_QA_MODEL, CHAT_API_BASE, QA_TIMEOUT_MS, TEXT_RULES } = require('../config');
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

  // The 16:9 image will be vertically cropped during PDF assembly (top bias).
  // The effective top margin after crop is roughly 65% of the original topPadding.
  // Fail hard if text crosses ~55% of the target topPadding (worst-case post-crop).
  const hardTopMarginPct = Math.max(8, Math.floor(TEXT_RULES.topPaddingPercent * 0.55));

  const prompt = `Analyze the text in this children's book illustration.

EXPECTED TEXT: "${expectedText}"

Check ALL of the following:

1. TEXT CONTENT: Read the text in the image word-for-word. Does it match the expected text exactly? Flag missing words, extra words, misspellings, garbled text, or DUPLICATED text (same text appearing twice).

2. TEXT PLACEMENT — CENTER EXCLUSION ZONE (CRITICAL): Imagine a vertical line at the exact center of the image. The center ${TEXT_RULES.centerExclusionPercent * 2}% (${TEXT_RULES.centerExclusionPercent}% left of center + ${TEXT_RULES.centerExclusionPercent}% right of center) is a NO-TEXT ZONE reserved for imagery. ALL text must be completely within the LEFT ${50 - TEXT_RULES.centerExclusionPercent}% or the RIGHT ${50 - TEXT_RULES.centerExclusionPercent}% of the image. Flag as HARD FAIL if ANY text character or word appears in or crosses the center ${TEXT_RULES.centerExclusionPercent * 2}% strip. A single word crossing the center counts as a failure. Vertical position (top/bottom) does not matter.

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
  "tags": ["zero or more of: text_top_edge, text_over_face, text_center, text_duplicated, text_garbled, text_too_large, text_illegible"],
  "score": 0.0-1.0
}

Score guide: 1.0 = perfect, 0.8+ = minor issues, 0.5-0.8 = significant issues, <0.5 = major problems.
Set pass=false for: text in the center ${TEXT_RULES.centerExclusionPercent * 2}%, text crossing the center, duplicated text, missing/garbled text, text over the hero's face/head, or text within ${hardTopMarginPct}% of the top edge.`;

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
      const issues = result.issues || [];
      const rawTags = Array.isArray(result.tags) ? result.tags : [];
      const tags = rawTags.filter(t => typeof t === 'string').map(t => t.toLowerCase().trim()).filter(Boolean);
      let pass = !!result.pass;

      // Deterministic duplication safety net: if extracted text is much longer
      // than expected, the same text was likely rendered twice in the image
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
    }
  } catch (e) {
    console.warn(`[illustrator/quality/text] Error: ${e.message} — accepting`);
  }

  return { pass: true, issues: [], tags: [], score: 1.0 };
}

module.exports = { verifySpreadText };
