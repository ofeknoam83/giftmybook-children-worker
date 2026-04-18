/**
 * Illustrator V2 — Per-Spread Anatomy/Quality Check
 *
 * Quick Gemini Vision check for:
 * 1. Correct number of fingers
 * 2. No body horror / anatomical issues
 * 3. No duplicate items in the same illustration
 * 4. Characters look like children
 */

const { GEMINI_QA_MODEL, CHAT_API_BASE, QA_TIMEOUT_MS } = require('../config');
const { fetchWithTimeout, getNextApiKey } = require('../../illustrationGenerator');

/**
 * Run a quick anatomical and quality check on a spread image.
 *
 * @param {string} imageBase64 - Generated image as base64
 * @param {object} [opts]
 * @param {object} [opts.costTracker]
 * @returns {Promise<{pass: boolean, issues: string[]}>}
 */
async function checkAnatomy(imageBase64, opts = {}) {
  const apiKey = getNextApiKey();
  if (!apiKey) {
    return { pass: true, issues: [] };
  }

  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;

  const prompt = `Check this children's book illustration for anatomy and quality issues.

Check ALL of the following carefully:
1. LIMB COUNT (CRITICAL): Count the number of hands and arms visible for EACH person in the image. Every person must have EXACTLY 2 hands and 2 arms. Flag IMMEDIATELY if anyone has 3 hands, 3 arms, 1 arm, or any wrong number of limbs. This is the MOST IMPORTANT check.
2. FINGERS: Do visible hands have the correct number of fingers (5 per hand)? Flag extra or missing fingers.
3. BODY HORROR: Any merged limbs, distorted faces, extra body parts, or unnatural anatomy? Pay special attention to arms that split into two, hands growing from wrong positions, or limbs at impossible angles.
4. DUPLICATE ITEMS: Any specific object that appears to be cloned/copy-pasted? (Multiple similar items like books on a shelf are fine — only flag obvious AI cloning artifacts.)
5. CHILD APPEARANCE: Does the character look like a young child? Flag if they look like an adult or are distorted.

Do NOT flag:
- Minor stylistic exaggeration (large eyes, simplified features — normal for children's book art)
- Left/right mirroring
- Artistic choice in proportions

Return ONLY valid JSON:
{"pass": true/false, "issues": ["list of specific issues"]}
Set pass=false for: wrong number of hands/arms/legs, extra limbs, wrong finger count, distorted body parts, or any body horror.`;

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
          maxOutputTokens: 512,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }, QA_TIMEOUT_MS);

    if (opts.costTracker) {
      opts.costTracker.addTextUsage(GEMINI_QA_MODEL, 500, 100);
    }

    if (!resp.ok) {
      console.warn(`[illustrator/quality/anatomy] API error ${resp.status} — accepting`);
      return { pass: true, issues: [] };
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
      };
    }
  } catch (e) {
    console.warn(`[illustrator/quality/anatomy] Error: ${e.message} — accepting`);
  }

  return { pass: true, issues: [] };
}

module.exports = { checkAnatomy };
