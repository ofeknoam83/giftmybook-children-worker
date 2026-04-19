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
 * Run anatomy, quality, and scene-coherence check on a spread image.
 *
 * @param {string} imageBase64 - Generated image as base64
 * @param {object} [opts]
 * @param {object} [opts.costTracker]
 * @param {string} [opts.spreadText] - Story text for this spread (for action-coherence check)
 * @returns {Promise<{pass: boolean, issues: string[]}>}
 */
async function checkAnatomy(imageBase64, opts = {}) {
  const apiKey = getNextApiKey();
  if (!apiKey) {
    return { pass: true, issues: [] };
  }

  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;

  const sceneCoherenceBlock = opts.spreadText
    ? `\n8. ACTION COHERENCE (CRITICAL): The story text for this spread is:
"${opts.spreadText.slice(0, 400)}"
Does the illustration match the KEY ACTIONS described in the text? Check:
- If the text says a character points/looks/moves in a DIRECTION, does the illustration show the same direction?
- If the text describes a specific action (pointing, holding, climbing, running), is the character doing that action?
- If the text mentions a specific object being interacted with, is it shown?
Flag as "ACTION MISMATCH" if the character's action clearly contradicts the text (e.g., text says "points at the door" but child points away from any door).
Do NOT flag minor differences in pose — only flag clear contradictions.`
    : '';

  const prompt = `You are a QA inspector for children's book illustrations. Check this image for anatomy, quality, and composition defects.

STEP-BY-STEP PROCEDURE (follow exactly):

1. PERSON COUNT: How many distinct people (adults + children) are in this image? List each one.

2. HAND COUNT PER PERSON (CRITICAL — most common defect):
   For EACH person, trace their arms from shoulder to hand. Count:
   - How many arms does person 1 have? How many hands?
   - How many arms does person 2 have? (if present) How many hands?
   A human has EXACTLY 2 arms and 2 hands. If ANY person has 3+ hands or 3+ arms visible, this is a FAIL.
   Be suspicious of hands near bags, objects, or overlapping areas — these are where extra-hand artifacts hide.
   Partially hidden or cropped limbs are OK. But if you can see 3 distinct hands attached to or near one person's body, that is a defect.

3. FINGERS: Do visible hands have 5 fingers each? Flag extra or missing fingers.

4. BODY HORROR: Merged limbs, distorted faces, extra body parts, arms splitting into two, hands growing from wrong positions.

5. DUPLICATE ITEMS: Obvious cloned/copy-pasted objects (multiple similar items like books on a shelf are fine).

6. CHILD APPEARANCE: Does the child look like a young child? Flag if they look adult.

7. SEAMLESS COMPOSITION (CRITICAL): This should be ONE continuous panoramic painting. Flag "SPLIT PANEL" if: there is a visible vertical divider or seam near the center, two clearly different scenes/backgrounds on left vs right, or an abrupt lighting/color change at the center.
${sceneCoherenceBlock}
Do NOT flag: stylistic exaggeration (large eyes, simplified features), left/right mirroring, or artistic proportions.

Return ONLY valid JSON:
{"pass": true/false, "issues": ["list of specific issues"]}
Set pass=false for: 3+ hands on one person, 3+ arms, wrong finger count, body horror, SPLIT PANEL, or ACTION MISMATCH.`;

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
          thinkingConfig: { thinkingBudget: 2048 },
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
    const parts = data.candidates?.[0]?.content?.parts || [];
    const responsePart = parts.find(p => !p.thought) || parts[parts.length - 1] || {};
    const text = (responsePart.text || '').trim();
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
