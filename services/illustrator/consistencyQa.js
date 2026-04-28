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
 * @param {string} [opts.previousSpreadBase64] - Optional prior accepted interior (JPEG/PNG base64) — catches hair/outfit drift vs cover-only QA.
 * @param {string} [opts.previousSpreadMime] - MIME for previous spread (default image/jpeg).
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
  const previousSpreadBase64 = typeof opts.previousSpreadBase64 === 'string' && opts.previousSpreadBase64.length > 200
    ? opts.previousSpreadBase64
    : null;
  const previousSpreadMime = typeof opts.previousSpreadMime === 'string' && opts.previousSpreadMime.trim()
    ? opts.previousSpreadMime.trim()
    : 'image/jpeg';

  const prompt = buildConsistencyPrompt({
    hasSecondaryOnCover: !!opts.hasSecondaryOnCover,
    characterDescription: charDesc,
    hasChildPhoto: !!childPhoto,
    hasPreviousSpread: !!previousSpreadBase64,
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
  );
  let nextImageNum = 2;
  if (previousSpreadBase64) {
    userParts.push(
      {
        text: `IMAGE ${nextImageNum} — PREVIOUS ACCEPTED INTERIOR SPREAD (same book, immediately before the one under review). Continuity anchor: hero hairstyle family, visible hair accessories, and ordinary-scene outfit should stay consistent with this image unless situational change rules apply (see prompt).`,
      },
      { inline_data: { mimeType: previousSpreadMime, data: previousSpreadBase64 } },
    );
    nextImageNum += 1;
  }
  userParts.push(
    { text: `IMAGE ${nextImageNum} — GENERATED INTERIOR SPREAD (to verify — **this is always the LAST image** in this request):` },
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
      return evaluateConsistencyResult(parsed, { hasPreviousSpread: !!previousSpreadBase64 });
    } catch (err) {
      lastErr = err;
      await sleep(500 * attempt);
    }
  }

  console.warn(`[illustrator/consistencyQa] Fail-open after ${QA_HTTP_ATTEMPTS} attempts: ${lastErr?.message}`);
  return {
    pass: true,
    issues: [],
    tags: ['qa_api_error'],
    infra: true,
    warning: `Consistency QA skipped after infra error: ${lastErr?.message || 'unknown'}`,
    artStyleIs3DPixar: null,
    artStyleSeverity: null,
  };
}

function buildConsistencyPrompt({ hasSecondaryOnCover, characterDescription, hasChildPhoto, hasPreviousSpread, qaAllowedHumansNote }) {
  const desc = typeof characterDescription === 'string' && characterDescription.trim()
    ? ` Story-author reference (may clarify intent; COVER is still the render truth): ${characterDescription.trim()}`
    : '';
  const photoNote = hasChildPhoto
    ? ' If a real child photo was also provided, use it only to disambiguate identity when the cover is ambiguous. The generated spread (**last image**) must still match the RENDER of the child on the COVER (Image 1), not necessarily the snapshot lighting in the photo.'
    : '';
  const castNote = qaAllowedHumansNote
    ? `\n\nCAST / POLICY NOTE (from production — honor when judging explicitStranger): ${qaAllowedHumansNote}\nWhen this note lists customer-confirmed adults who are NOT drawn on the cover, those specific people may still appear as full figures if they match the descriptions. Do NOT flag them as explicitStranger. Still forbid random invented adults or crowds not covered by the note.`
    : '';
  const continuityNote = hasPreviousSpread
    ? `

**Continuity vs PREVIOUS interior** (the image immediately before the LAST image, when that middle image is provided): That frame is the last **accepted** interior before the one under review. Use it to catch **book-internal drift** that still looks "okay" vs the cover alone.
- In **ordinary** scenes (not pajamas, swim, bath/bubbles, towel wrap, or obvious cold-weather layering), **fail heroChildMatches** if the generated spread (**last image**) shows a **clearly different hairstyle family** vs the previous interior (e.g. chin-length bob with full bangs vs short side-parted crop; long vs short silhouette) when the change is **not** explained by wind, motion blur, or extreme angle.
- **Hair accessories:** **fail heroChildMatches** if the generated spread **adds or removes** a visible accessory (bow, headband, clips, flowers, large barrettes) compared to the **previous interior**, unless the same accessory is **clearly visible on the cover** or the scene is an explicit situational change (e.g. bath cap). Small ties/elastic implied by the same hairstyle are not an automatic fail.
- Still require overall identity to match **Image 1 (cover)** as below; the previous interior tightens **within-book** consistency.
`
    : '';
  return `You are a quality reviewer comparing the BOOK COVER (Image 1) to the GENERATED interior spread (**always the LAST image** in this request). When a PREVIOUS interior is included, it is the image immediately before that last image. All should be from the same 3D CGI Pixar **feature-film** children's book — a frame from a modern Pixar movie, photoreal subsurface skin scattering, rendered hair strands, physically based materials, volumetric ray-traced lighting, real optical depth-of-field. NOT a 2D illustration, NOT a painted children's book illustration, NOT a photograph.${photoNote}${desc}${castNote}${continuityNote}

Judgment style: fail **heroChildMatches** or **outfitMatches** only on a **clear** mismatch. If uncertain whether there is a problem, prefer **true** (pass) for **lighting, shadow, resolution, and mild foreshortening** effects.

**Hero identity (Image 1 cover = fixed age and hair for the whole book):** The cover is a **single** rendered model — not a "younger self" in a time-jump story. The **generated spread (last image)** hero must look like the **same developmental age and build** and the **same hair length and style family** (cut, not materially longer or shorter) as the cover, across every spread. **Fail heroChildMatches** if the generated hero would read as clearly **older/younger**, a **taller/older-teen face**, or with **clearly different hair length** (e.g. cover shows bob-length hair and spread shows hair past shoulders) that cannot be explained by **camera angle, wind, or partial view alone**. Differences in **lighting, highlight on hair, motion blur, or partial occlusion** are **not** automatic fails — if the **silhouette and apparent length** still match the cover, pass. If **jaw, face proportions, or hair length** clearly diverge from the cover, **fail** (that is not "just lighting").

**Outfit (Image 1 cover vs generated spread — last image):** Compare only the **visible clothing** on the hero in Image 1 to the **last image**. Set **outfitMatches: true** if the spread shows the **same outfit family** (same type of top/bottom/dress, same overall color story) as the cover, even if: colors shift slightly under different light, a jacket is open vs closed, or only part of the outfit is visible. Set **outfitMatches: true** for **explicit situational swaps** that the scene could explain (pajamas, swimwear, towel, heavy coat in snow) **if** they read as that situation. **Small add-on props** the story text may imply (scarf, ribbon, hat, mittens) **pass** when the **primary shirt/top and pants/skirt/dress** still clearly match the cover’s garment types and color family — treat those as situational illustration detail, not a full outfit swap. Set **outfitMatches: false** only when the **main garments** are **clearly** a different set (e.g. cover in a red dress, spread in unrelated blue overalls; overalls vs dress; different core color story) with no plausible situational reason.

Return STRICT JSON with this schema (no markdown, no commentary):

{
  "heroChildMatches": <true if the spread hero (**last image**) is clearly the same identity as the child on the cover (Image 1) — same apparent age band, same face and ethnicity, same skin tone, same **hair color and length class** and style, same eye color, within normal illustration variance (lighting/angle is not a pass for a clearly different age or much longer hair). When a previous interior is provided, also enforce the CONTINUITY rules above.>,
  "heroChildDifferences": "<short description of any visible differences, or empty string>",
  "outfitMatches": <true per the OUTFIT rules above; prefer true when in doubt.>,
  "artStyleIs3DPixar": <true if the spread reads as a 3D CGI Pixar-film frame with REAL volumetric 3D rendering — photoreal subsurface skin scattering, rendered hair strands (not painted hair shapes), physically based materials (real fabric weave, real wood grain, real foliage volume), ray-traced volumetric lighting, and genuine optical depth-of-field. False if the **last image** reads as ANY of: a real photograph, stock photo, 2D flat illustration, soft painted children's-book illustration, watercolor, gouache, pencil sketch, ink-and-wash, anime cel-shading, paper cutout, pixel art, digital painting, or "illustrated storybook" with flat painted background + soft shaded figures. Faces with flat painted-looking skin, hair that reads as painted shapes instead of strands, or a background that reads as a flat painted image with blur (instead of a real 3D environment with lens bokeh) = false.>,
  "artStyleNotes": "<short description if artStyleIs3DPixar is false — e.g. 'skin and hair read as painted illustration, not 3D CGI', 'background is a flat painted image with blur, not a 3D environment'>",
  "artStyleSeverity": "<exactly one of: ok | soft_grading | wrong_medium | wrong_other — If artStyleIs3DPixar is true: use ok, or soft_grading only when the frame is clearly premium 3D Pixar CGI but color grading or exposure is borderline (still same medium). If artStyleIs3DPixar is false: use wrong_medium (painted storybook, heavy illustration) or wrong_other (photo, anime, watercolor, pixel art, wrong 3D engine). Never use soft_grading for watercolor or non-CGI.>",
  "heroCount": <integer — how many copies of the hero child appear in the spread. 1 is correct; 2+ is a duplicated-hero bug>,
  "heroBodyConnected": <true if the hero's body reads as ONE single continuous anatomy: head → neck → shoulders → torso → hips → legs → feet are all attached in one clean silhouette, the upper-body garment visibly connects to the lower-body garment on the same torso, and there are no floating "ghost" torsos, no stray extra pairs of legs/shorts/shoes rendered beside the hero, no visible body-segmentation seam, no two overlapping halves of the child. False if the child reads as two misaligned halves (e.g. an upper body in one pose on one side and a disembodied pair of legs/shorts standing beside them), if the shirt/top does NOT connect to the pants/shorts/skirt on the same body, or if an extra torso/legs ghosts next to the main figure. When clearly connected, true; when clearly broken, false; when unclear, prefer true.>,
  "heroBodyConnectedNotes": "<short description if heroBodyConnected is false (e.g. 'upper body in white shirt on left, disconnected legs in blue shorts standing to the right'), else empty string>",
  "splitPanel": <true if the spread looks like two separate illustrations joined together: visible vertical seam or "hard line" down the middle; abrupt change in lighting, color grade, perspective, or art style at center; background elements that do not align across the midline; a person or large object cut off unnaturally at center as if the right half were a different render; two different skies/horizons meeting at center. FALSE for a single coherent wide scene where the middle is open path, garden, sky, stairs, or **letter markers along one continuous walkway** — one ground plane and one light direction count as ONE shot even if letter stones or railings repeat. When unsure, prefer **false** (not split).>,
  "explicitStranger": <true ONLY if the spread shows a non-child human's FULL FACE or a FULL-BODY adult figure that is forbidden by the policy above AND not covered by the CAST / POLICY NOTE. ${hasSecondaryOnCover ? 'Adults visible on the cover are allowed to appear fully — they are NOT strangers.' : 'When no adult is on the cover AND no policy note allows extra named adults, a fully-rendered adult (face visible, or full body figure) is a failure.'} Two full adults (e.g. a man and a woman) pushing a stroller ONLY fails if they are not allowed by the cast note. Hands, arms, back-of-head, a shoulder, or a cropped torso with the face out of frame are NOT explicit — do not flag those as strangers. A full-body adult seen from the back (face not visible) still counts as a full-body adult figure — treat as explicitStranger true unless the cast note explicitly allows that person. Distant, soft silhouettes without facial detail are usually NOT strangers unless they read as two full parents beside the child.>,
  "strangerDescription": "<short description of the explicit stranger (full face or full body), or empty>",
  "recurringItemConcerns": "<empty string, or a short note if a previously-introduced item (pet, toy, accessory) appears with a clearly different design from how it would be established in the book's reference cover>",
  "impliedParentSkinMismatch": <true ONLY if the **last image** shows visible skin on an implied adult's partial body (hands, forearms, legs, arms) AND that skin is clearly inconsistent with the hero child's skin tone on Image 1 (e.g. clearly different ethnicity or a large tone gap — such as dark brown adult hands with a fair-skinned child on the cover). false if no partial adult skin is visible, or skin matches plausibly for a parent and child, or comparison is unclear — when unclear, prefer false.>,
  "impliedParentSkinNotes": "<short note if impliedParentSkinMismatch is true, else empty string>",
  "disembodiedLimb": <true ONLY if the **last image** shows a partial-presence limb (hand, arm, shoulder) that looks UNCANNY: a hand or arm floating in mid-frame with no visible path to a body, a limb that does not enter from a frame edge or from behind a foreground object, a limb whose off-frame body would be physically impossible for the staging, an extra/duplicated limb, a ghostly second arm, or a silhouette pasted at an obviously wrong depth/scale. false if any visible limb clearly continues off the edge of the frame in a believable way (wrist + forearm + sleeve continuing off-screen) and an off-frame body is plausible for the composition (e.g. parent seated beside the child, kneeling above, leaning over a railing). When unclear, prefer false.>,
  "disembodiedLimbNotes": "<short note if disembodiedLimb is true (which limb, why it reads as floating), else empty string>",
  "parentTurnedAway": <true ONLY if a mother or father appears in the **last image** (full figure OR partial presence — visible limb or silhouette) AND their body language is clearly disconnected from the hero child in a way that reads as unnatural for a children's book: the parent's back is turned to the child with no narrative reason, the parent is walking away from the child, the parent is looking off into empty space while the child is behind them, or (for partial presence) the implied hand/arm extends AWAY from the child instead of toward them. false if the parent is oriented toward the child, leaning in, holding the child, sharing the child's focus on a shared object, walking ALONGSIDE the child, leading the child by the hand in profile, or both facing a shared focus together (fireworks, sunset, cake). false if no parent is in the frame. When unclear, prefer false.>,
  "parentTurnedAwayNotes": "<short note if parentTurnedAway is true (e.g. 'mother walking away from child with her back turned, child sitting behind looking at her'), else empty string>",
  "bathModestyOk": <true if the scene is not a bath/shower/swim modesty context, OR if it is, the child is modest per preschool picture-book standards (bubble cover, towel wrap, modest swimwear) — not naked with explicit detail and not fully dressed in street clothes submerged in water. false only on clear modesty violations.>,
  "bathModestyNotes": "<empty or short note if bathModestyOk is false>"
}

Be strict on art style — drift toward a "soft painted storybook illustration" look is a fail even if it is CGI-ish. The bar is "frame from a modern Pixar feature film", not "premium children's-book illustration". Photo-realistic drift and duplicated-hero / diptych seams are also fails. On **identity**, do not fail for **minor** hair or face variance from lighting — but **do** fail when the child **clearly** looks like a different age or hair length than the cover${hasPreviousSpread ? ', or when continuity vs the previous interior fails per the rules above' : ''}. Return ONLY the JSON.`;
}

/**
 * Normalize vision model severity for logging / downstream gates.
 * @param {unknown} raw
 * @returns {'ok'|'soft_grading'|'wrong_medium'|'wrong_other'|null}
 */
function normalizeArtStyleSeverity(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (s === 'soft_grading' || s === 'wrong_medium' || s === 'wrong_other' || s === 'ok') return s;
  return null;
}

/**
 * @param {object} parsed
 * @param {object} [evalOpts]
 * @param {boolean} [evalOpts.hasPreviousSpread]
 */
function evaluateConsistencyResult(parsed, evalOpts = {}) {
  const issues = [];
  const tags = [];
  const hasPreviousSpread = !!evalOpts.hasPreviousSpread;

  const artStyleSeverityRaw = normalizeArtStyleSeverity(parsed.artStyleSeverity) || (
    parsed.artStyleIs3DPixar === false ? 'wrong_medium' : 'ok'
  );

  if (parsed.heroChildMatches === false) {
    const diff = (parsed.heroChildDifferences || '').trim();
    const head = hasPreviousSpread
      ? 'Hero child does not match cover or previous spread'
      : 'Hero child does not match cover';
    issues.push(`${head}${diff ? `: ${diff}` : ''}`);
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
    if (artStyleSeverityRaw === 'wrong_other') tags.push('style_drift_wrong_other');
    if (artStyleSeverityRaw === 'wrong_medium') tags.push('style_drift_wrong_medium');
  }
  if (parsed.artStyleIs3DPixar === true && artStyleSeverityRaw === 'soft_grading') {
    tags.push('style_grading_note');
  }
  if (Number(parsed.heroCount) > 1) {
    issues.push(`Hero child appears ${parsed.heroCount}× (should be 1×)`);
    tags.push('duplicated_hero');
  }
  if (parsed.heroBodyConnected === false) {
    const notes = (parsed.heroBodyConnectedNotes || '').trim();
    issues.push(`Hero body is not one connected anatomy${notes ? `: ${notes}` : ''}`);
    tags.push('body_disconnected');
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
  if (parsed.disembodiedLimb === true) {
    const notes = (parsed.disembodiedLimbNotes || '').trim();
    issues.push(`Uncanny partial presence — a limb appears without a plausibly anchored off-frame body${notes ? `: ${notes}` : ''}`);
    tags.push('disembodied_limb');
  }
  if (parsed.parentTurnedAway === true) {
    const notes = (parsed.parentTurnedAwayNotes || '').trim();
    issues.push(`Parent is unnaturally facing away from the hero child${notes ? `: ${notes}` : ''}`);
    tags.push('parent_turned_away');
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
    artStyleIs3DPixar: parsed.artStyleIs3DPixar === true,
    artStyleSeverity: artStyleSeverityRaw,
  };
}

module.exports = {
  checkSpreadConsistency,
  evaluateConsistencyResult,
  normalizeArtStyleSeverity,
};
