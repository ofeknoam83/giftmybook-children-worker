/**
 * Illustrator — Consistency QA
 *
 * Per-spread, stateless vision call to gemini-2.5-flash that compares the
 * generated spread against the pinned BOOK COVER. Checks:
 *   - Hero child: same face, ethnicity, skin tone, hair, eye color
 *   - Outfit: same outfit family as cover (unless cover + spread are clearly
 *     in different situations like bedtime pajamas or swimwear)
 *   - Art style: still 3D Pixar render (NOT 2D flat, watercolor, sketch, etc.)
 *   - Secondary people: if the cover has secondaries, they appear here with
 *     the same cover look; if the cover has ONLY the child, no random
 *     strangers appear on the spread.
 *   - One hero (no duplicates) + seamless composition (no split panels)
 *
 * Returns structured tags so the caller can build a concise correction note.
 */

const {
  GEMINI_QA_MODEL,
  CHAT_API_BASE,
  QA_TIMEOUT_MS,
  QA_HTTP_ATTEMPTS,
} = require('./config');
const { fetchWithTimeout, getNextApiKey } = require('../illustrationGenerator');

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
 * @param {string} spreadBase64 - Generated spread image.
 * @param {string} coverBase64 - Pinned reference cover image.
 * @param {object} [opts]
 * @param {boolean} [opts.hasSecondaryOnCover]
 * @param {string} [opts.characterDescription] - Writer/face copy; disambiguates identity when judging cover vs spread.
 * @param {string} [opts.childPhotoBase64] - Optional real photo; third reference only — rendered hero must still match the COVER.
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{pass: boolean, issues: string[], tags: string[], infra?: boolean}>}
 */
async function checkSpreadConsistency(spreadBase64, coverBase64, opts = {}) {
  const apiKey = getNextApiKey();
  if (!apiKey) {
    return { pass: false, issues: ['Consistency QA unavailable: no Gemini API key'], tags: ['qa_unavailable'], infra: true };
  }
  if (!coverBase64) {
    return { pass: false, issues: ['Consistency QA needs cover reference'], tags: ['qa_unavailable'], infra: true };
  }

  const charDesc = typeof opts.characterDescription === 'string' ? opts.characterDescription.trim() : '';
  const childPhoto = typeof opts.childPhotoBase64 === 'string' && opts.childPhotoBase64.length > 200
    ? opts.childPhotoBase64
    : null;

  const prompt = buildConsistencyPrompt({
    hasSecondaryOnCover: !!opts.hasSecondaryOnCover,
    characterDescription: charDesc,
    hasChildPhoto: !!childPhoto,
    qaAllowedHumansNote: typeof opts.qaAllowedHumansNote === 'string' ? opts.qaAllowedHumansNote.trim() : '',
  });
  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;

  const userParts = [];
  if (childPhoto) {
    userParts.push(
      { text: 'IMAGE 0 — REAL PHOTO of the child (rough identity; lighting and age may differ from the book). Use only to disambiguate when the cover is unclear — the CANONICAL rendered look is still IMAGE 1.' },
      { inline_data: { mimeType: 'image/jpeg', data: childPhoto } },
    );
  }
  userParts.push(
    { text: 'IMAGE 1 — BOOK COVER (ground truth for 3D Pixar hero, outfit, and style):' },
    { inline_data: { mimeType: 'image/jpeg', data: coverBase64 } },
    { text: 'IMAGE 2 — GENERATED SPREAD (to verify):' },
    { inline_data: { mimeType: 'image/png', data: spreadBase64 } },
    { text: prompt },
  );

  const body = {
    contents: [{
      role: 'user',
      parts: userParts,
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
      if (!resp.ok) { lastErr = new Error(`Consistency QA HTTP ${resp.status}`); await sleep(500 * attempt); continue; }
      const data = await resp.json();
      const txt = extractGeminiResponseText(data);
      const parsed = parseJsonBlock(txt);
      if (!parsed) { lastErr = new Error('Consistency QA unparseable response'); await sleep(500 * attempt); continue; }
      return evaluateConsistencyResult(parsed);
    } catch (err) {
      lastErr = err;
      await sleep(500 * attempt);
    }
  }

  console.warn(`[illustrator/consistencyQa] Fail-open after ${QA_HTTP_ATTEMPTS} attempts: ${lastErr?.message}`);
  return {
    pass: false,
    issues: [`Consistency QA infra error: ${lastErr?.message || 'unknown'}`],
    tags: ['qa_api_error'],
    infra: true,
  };
}

function buildConsistencyPrompt({ hasSecondaryOnCover, characterDescription, hasChildPhoto, qaAllowedHumansNote }) {
  const desc = typeof characterDescription === 'string' && characterDescription.trim()
    ? ` Story-author reference (may clarify intent; COVER is still the render truth): ${characterDescription.trim()}`
    : '';
  const photoNote = hasChildPhoto
    ? ' If a real child photo was also provided, use it only to disambiguate identity when the cover is ambiguous. The interior spread (Image 2) must still match the RENDER of the child on the COVER (Image 1), not necessarily the snapshot lighting in the photo.'
    : '';
  const castNote = qaAllowedHumansNote
    ? `\n\nCAST / POLICY NOTE (from production — honor when judging explicitStranger): ${qaAllowedHumansNote}\nWhen this note lists customer-confirmed adults who are NOT drawn on the cover, those specific people may still appear as full figures if they match the descriptions. Do NOT flag them as explicitStranger. Still forbid random invented adults or crowds not covered by the note.`
    : '';
  return `You are a quality reviewer comparing a book COVER (Image 1) to a generated interior SPREAD (Image 2). Both should be from the same 3D Pixar children's book (stylized CGI — NOT a real photograph).${photoNote}${desc}${castNote}

Judgment style: fail heroChildMatches or outfitMatches only on a **clear** mismatch. If uncertain, prefer **true** (pass). Differences in **lighting, shadow, wrinkle/fold, viewing angle, foreshortening, or partial occlusion** are NOT outfit failures. Baby vs older toddler: not an automatic fail for identity — only fail on clearly different hair color family, face shape, skin tone, or a clearly different child.

**Outfit (Image 1 cover vs Image 2 spread only — no external text list):** Compare only the **visible clothing** on the hero in Image 1 to Image 2. Set **outfitMatches: true** if the spread shows the **same outfit family** (same type of top/bottom/dress, same overall color story) as the cover, even if: colors shift slightly under different light, a jacket is open vs closed, or only part of the outfit is visible. Set **outfitMatches: true** for **explicit situational swaps** that the scene could explain (pajamas, swimwear, towel, heavy coat in snow) **if** they read as that situation. Set **outfitMatches: false** only when the main garments are **clearly** a different set (e.g. cover in a red dress, spread in unrelated blue overalls; or a complete style change) with no plausible situational reason.

Return STRICT JSON with this schema (no markdown, no commentary):

{
  "heroChildMatches": <true if the spread hero (Image 2) is clearly the same identity as the child on the cover (Image 1) — same face, ethnicity, skin tone, hair color/style, eye color, within normal illustration variance>,
  "heroChildDifferences": "<short description of any visible differences, or empty string>",
  "outfitMatches": <true per the OUTFIT rules above; prefer true when in doubt.>,
  "artStyleIs3DPixar": <true if the spread is rendered in a 3D Pixar CGI style matching the cover — stylized soft CGI render, volumetric lighting, subsurface skin scattering, warm palette. False if Image 2 looks like a real photograph, smartphone snapshot, stock photo, 2D flat, watercolor, pencil sketch, gouache, anime cel, storybook ink, paper cutout, or any non-CGI style.>,
  "artStyleNotes": "<short description if artStyleIs3DPixar is false>",
  "heroCount": <integer — how many copies of the hero child appear in the spread. 1 is correct; 2+ is a duplicated-hero bug>,
  "splitPanel": <true if the spread looks like two separate illustrations joined together: visible vertical seam or "hard line" down the middle; abrupt change in lighting, color grade, perspective, or art style at center; background elements that do not align across the midline; a person or large object cut off unnaturally at center as if the right half were a different render; two different skies/horizons meeting at center. FALSE for a single coherent wide scene where the middle is just open garden/path/sky with natural continuity.>,
  "explicitStranger": <true ONLY if the spread shows a non-child human's FULL FACE or a FULL-BODY adult figure that is forbidden by the policy above AND not covered by the CAST / POLICY NOTE. ${hasSecondaryOnCover ? 'Adults visible on the cover are allowed to appear fully — they are NOT strangers.' : 'When no adult is on the cover AND no policy note allows extra named adults, a fully-rendered adult (face visible, or full body figure) is a failure.'} Two full adults (e.g. a man and a woman) pushing a stroller ONLY fails if they are not allowed by the cast note. Hands, arms, back-of-head, a shoulder, or a cropped torso with the face out of frame are NOT explicit — do not flag those as strangers. A full-body adult seen from the back (face not visible) still counts as a full-body adult figure — treat as explicitStranger true unless the cast note explicitly allows that person. Distant, soft silhouettes without facial detail are usually NOT strangers unless they read as two full parents beside the child.>,
  "strangerDescription": "<short description of the explicit stranger (full face or full body), or empty>",
  "recurringItemConcerns": "<empty string, or a short note if a previously-introduced item (pet, toy, accessory) appears with a clearly different design from how it would be established in the book's reference cover>",
  "impliedParentSkinMismatch": <true ONLY if Image 2 shows visible skin on an implied adult's partial body (hands, forearms, legs, arms) AND that skin is clearly inconsistent with the hero child's skin tone on Image 1 (e.g. clearly different ethnicity or a large tone gap — such as dark brown adult hands with a fair-skinned child on the cover). false if no partial adult skin is visible, or skin matches plausibly for a parent and child, or comparison is unclear — when unclear, prefer false.>,
  "impliedParentSkinNotes": "<short note if impliedParentSkinMismatch is true, else empty string>",
  "bathModestyOk": <true if the scene is not a bath/shower/swim modesty context, OR if it is, the child is modest per preschool picture-book standards (bubble cover, towel wrap, modest swimwear) — not naked with explicit detail and not fully dressed in street clothes submerged in water. false only on clear modesty violations.>,
  "bathModestyNotes": "<empty or short note if bathModestyOk is false>"
}

Be strict on art style (photo-realistic drift or 2D drift is a fail) and on duplicated hero / diptych seams. Be conservative on face matching — do not mark heroChildMatches false over minor or ambiguous differences. Return ONLY the JSON.`;
}

function evaluateConsistencyResult(parsed) {
  const issues = [];
  const tags = [];

  if (parsed.heroChildMatches === false) {
    const diff = (parsed.heroChildDifferences || '').trim();
    issues.push(`Hero child does not match cover${diff ? `: ${diff}` : ''}`);
    tags.push('hero_mismatch');
  }
  if (parsed.outfitMatches === false) {
    issues.push('Hero outfit differs from the cover (and not an explicit situational swap)');
    tags.push('outfit_mismatch');
  }
  if (parsed.artStyleIs3DPixar === false) {
    const notes = (parsed.artStyleNotes || '').trim();
    issues.push(`Art style drifts from 3D Pixar${notes ? `: ${notes}` : ''}`);
    tags.push('style_drift');
  }
  if (Number(parsed.heroCount) > 1) {
    issues.push(`Hero child appears ${parsed.heroCount}× (should be 1×)`);
    tags.push('duplicated_hero');
  }
  if (parsed.splitPanel === true) {
    issues.push('Spread looks like a split panel / diptych with a visible seam');
    tags.push('split_panel');
  }
  // Only a full FACE or full-body adult figure not on the cover is a failure.
  // Implicit presence (hands, arms, back-of-head, cropped torso without face)
  // is allowed because per-spread prompts often reference a parent who is not
  // on the cover (e.g. "Analeigh wakes by Mommy").
  if (parsed.explicitStranger === true) {
    const who = (parsed.strangerDescription || '').trim();
    issues.push(`Unexpected person on spread${who ? `: ${who}` : ''}`);
    tags.push('unexpected_person');
  }
  if (parsed.recurringItemConcerns && String(parsed.recurringItemConcerns).trim()) {
    issues.push(`Recurring item concern: ${parsed.recurringItemConcerns}`);
    tags.push('recurring_item_drift');
  }
  if (parsed.impliedParentSkinMismatch === true) {
    const notes = (parsed.impliedParentSkinNotes || '').trim();
    issues.push(`Implied parent's visible skin does not match the hero child's skin on the cover${notes ? `: ${notes}` : ''}`);
    tags.push('implied_parent_skin_mismatch');
  }
  if (parsed.bathModestyOk === false) {
    const bn = (parsed.bathModestyNotes || '').trim();
    issues.push(`Bath/swim modesty issue${bn ? `: ${bn}` : ''}`);
    tags.push('bath_modesty');
  }

  return {
    pass: issues.length === 0,
    issues,
    tags: [...new Set(tags)],
  };
}

module.exports = { checkSpreadConsistency, evaluateConsistencyResult };
