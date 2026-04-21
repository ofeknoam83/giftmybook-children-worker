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

2a. MISSING LIMBS (CRITICAL — HARD FAIL, tag "missing_limb"):
    For the MAIN CHILD (the hero), both arms, both hands, and both legs must be accounted for unless cleanly cropped by the image frame or clearly hidden behind their own body / an object / the edge of the picture.
    Flag as a HARD FAIL if:
    - An arm simply ENDS at the shoulder or mid-upper-arm with no hand and no object hiding it (amputated look).
    - A hand ENDS at the wrist with no fingers visible and no sleeve covering it (stump).
    - A leg ENDS mid-thigh with no boot, no covering, no frame crop.
    - The child's torso is shown whole but only ONE arm is visible and the other is NOT accounted for by pose, hiding, or frame cropping.
    Do NOT flag: limbs hidden behind the body/pose, limbs cleanly cropped by the image edge, or a limb tucked behind a prop. Only flag true anatomical omissions where a limb should continue but visibly terminates.

2b. HERO COUNT — MAIN CHILD DUPLICATION (CRITICAL):
    Identify the main child (the hero — the young child the book is about).
    How many times does THAT SAME child appear in this image?
    The hero must appear EXACTLY ONCE. If you see two children that share the same face, hair, outfit, age, and build, the hero has been duplicated — this is a FAIL. Tag as "duplicated_hero".
    Watch for: a twin sibling in matching clothes, a before/after pose of the same child, a second identical child standing next to the main one.
    A reflection in a mirror or a framed photograph of the child is OK ONLY IF it is clearly framed as such (visible mirror frame, visible photo frame). Otherwise treat it as duplication.
    If a parent/adult or a clearly different-looking child is present, that is NOT duplication.

3. FINGERS: Do visible hands have 5 fingers each? Flag extra or missing fingers.

4. BODY HORROR: Merged limbs, distorted faces, extra body parts, arms splitting into two, hands growing from wrong positions.

5. DUPLICATE ITEMS: Obvious cloned/copy-pasted objects (multiple similar items like books on a shelf are fine).

6. CHILD APPEARANCE: Does the child look like a young child? Flag if they look adult.

6b. HERO FRAMING — HEAD CROPPING (CRITICAL — HARD FAIL, tag "head_cropped"):
    Look at the main child (the hero). Is the hero's HEAD and FACE fully inside the frame?
    - Flag as HARD FAIL if the top of the hero's head is cut off by the TOP edge of the image.
    - Flag as HARD FAIL if part of the hero's face is cut off by the BOTTOM, LEFT, or RIGHT edge.
    - Flag as HARD FAIL if there is NO visible space above the top of the hero's head (the head touches or exceeds the top edge).
    An adult or parent whose face is intentionally hidden (back view, face cropped out on purpose) is OK — that rule applies only to the MAIN CHILD (the hero).

7. SEAMLESS COMPOSITION (CRITICAL — HARD FAIL): This must be ONE continuous panoramic painting — one moment, one camera, one unified lighting and background from left edge to right edge. Tag as "split_panel" and FAIL if ANY of the following are visible:
   - A vertical divider, seam, gutter, border, or frame line anywhere (especially near the center)
   - A diptych layout — two compositions joined into one image
   - Mirrored halves (one side is an obvious mirror of the other)
   - Two clearly different scenes, rooms, backgrounds, or settings meeting mid-image
   - Two distinct action moments of the same character shown side by side (before/after, left-scene/right-scene, sequence)
   - An abrupt lighting, color-temperature, or palette change that reads as a panel boundary
   - Any vertical band of lighting or color that makes the image feel like a diptych or comic strip
   - A filmstrip, comic grid, or panel arrangement of any kind
   CONTINUITY TEST: drawing an imaginary vertical line anywhere in the image — if the two halves of that line would not be the same room / same outdoor setting / same lighting / same time of day, that is a split panel and must fail.
   A subtle environmental gradient (window light falling off, natural sunset blend) is fine; a clear hand-off from one setting to another is NOT.
${sceneCoherenceBlock}
Do NOT flag: stylistic exaggeration (large eyes, simplified features), left/right mirroring, or artistic proportions.

Return ONLY valid JSON:
{"pass": true/false, "issues": ["list of specific issues"], "tags": ["zero or more of: duplicated_hero, split_panel, head_cropped, extra_hands, extra_fingers, missing_limb, body_horror, duplicate_items, action_mismatch"]}
Set pass=false for: 3+ hands on one person, 3+ arms, wrong finger count, body horror, MISSING LIMB, DUPLICATED HERO, SPLIT PANEL, HEAD CROPPED, or ACTION MISMATCH.
Always include the relevant tags when pass=false so downstream tooling can route a specific correction.`;

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
      return { pass: true, issues: [], tags: [] };
    }

    const data = await resp.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const responsePart = parts.find(p => !p.thought) || parts[parts.length - 1] || {};
    const text = (responsePart.text || '').trim();
    const cleaned = text.replace(/```json\s*/i, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);

    if (match) {
      const result = JSON.parse(match[0]);
      const rawTags = Array.isArray(result.tags) ? result.tags : [];
      const tags = rawTags
        .filter(t => typeof t === 'string')
        .map(t => t.toLowerCase().trim())
        .filter(Boolean);
      return {
        pass: !!result.pass,
        issues: result.issues || [],
        tags,
      };
    }
  } catch (e) {
    console.warn(`[illustrator/quality/anatomy] Error: ${e.message} — accepting`);
  }

  return { pass: true, issues: [], tags: [] };
}

module.exports = { checkAnatomy };
