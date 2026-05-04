/**
 * Illustrator — Consistency QA
 *
 * Per-spread, stateless vision call to gemini-2.5-flash that compares the
 * generated spread against the pinned BOOK COVER. Optionally includes 1–3
 * recent approved interior images so hair/outfit can be checked against
 * on-story continuity, not only the cover. Checks:
 *   - Hero child: same face, ethnicity, skin tone, hair, eye color
 *   - Outfit: same outfit family as cover (unless situational swap)
 *   - Continuity (when refs provided): hair/outfit vs recent interiors — clear drift only
 *   - Art style: still 3D Pixar render
 *   - Secondary people / strangers policy
 *   - One hero + seamless composition
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
const { QA_RECENT_INTERIOR_REFERENCES } = require('../bookPipeline/constants');

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
 * @param {string} [opts.childPhotoBase64] - Optional real photo; disambiguation only — rendered hero must still match the COVER.
 * @param {Array<{ base64: string, mimeType?: string, spreadNumber?: number }>} [opts.recentInteriorRefs]
 *   Recent accepted interiors (JPEG base64), oldest→newest within the array; capped in this function.
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

  const rawRecent = Array.isArray(opts.recentInteriorRefs) ? opts.recentInteriorRefs : [];
  const recentRefs = rawRecent
    .filter(r => r && typeof r.base64 === 'string' && r.base64.length > 50)
    .slice(0, QA_RECENT_INTERIOR_REFERENCES);
  const recentCount = recentRefs.length;

  const prompt = buildConsistencyPrompt({
    hasSecondaryOnCover: !!opts.hasSecondaryOnCover,
    characterDescription: charDesc,
    hasChildPhoto: !!childPhoto,
    qaAllowedHumansNote: typeof opts.qaAllowedHumansNote === 'string' ? opts.qaAllowedHumansNote.trim() : '',
    recentInteriorCount: recentCount,
  });
  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;

  const userParts = [];
  let imageNum = 1;
  if (childPhoto) {
    userParts.push(
      { text: 'IMAGE 0 — REAL PHOTO of the child (rough identity; lighting and age may differ from the book). Use only to disambiguate when the cover is unclear — the CANONICAL rendered look is still the BOOK COVER (next image).' },
      { inline_data: { mimeType: 'image/jpeg', data: childPhoto } },
    );
  }
  userParts.push(
    { text: `IMAGE ${imageNum} — BOOK COVER (ground truth for 3D Pixar hero, outfit, and style):` },
    { inline_data: { mimeType: 'image/jpeg', data: coverBase64 } },
  );
  imageNum += 1;
  for (const ref of recentRefs) {
    const sn = ref.spreadNumber != null ? ref.spreadNumber : imageNum - 1;
    userParts.push(
      { text:
        `IMAGE ${imageNum} — RECENT APPROVED INTERIOR (spread ${sn}, continuity reference; these are ordered oldest → newest):`,
      },
      { inline_data: { mimeType: ref.mimeType || 'image/jpeg', data: ref.base64 } },
    );
    imageNum += 1;
  }
  userParts.push(
    { text: `IMAGE ${imageNum} — GENERATED SPREAD UNDER REVIEW (candidate interior; judge this image):` },
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
      return evaluateConsistencyResult(parsed, recentCount);
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

function buildConsistencyPrompt({
  hasSecondaryOnCover,
  characterDescription,
  hasChildPhoto,
  qaAllowedHumansNote,
  recentInteriorCount,
}) {
  const recent = typeof recentInteriorCount === 'number' && recentInteriorCount > 0 ? recentInteriorCount : 0;
  const desc = typeof characterDescription === 'string' && characterDescription.trim()
    ? ` Story-author reference (may clarify intent; COVER is still the render truth): ${characterDescription.trim()}`
    : '';
  const photoNote = hasChildPhoto
    ? ' If a real child photo was also provided, use it only to disambiguate identity when the cover is ambiguous. The CANDIDATE spread (last image) must still match the RENDER of the child on the COVER, not necessarily the snapshot lighting in the photo.'
    : '';
  const castNote = qaAllowedHumansNote
    ? `\n\nCAST / POLICY NOTE (from production — honor when judging explicitStranger): ${qaAllowedHumansNote}\nWhen this note lists customer-confirmed adults who are NOT drawn on the cover, those specific people may still appear as full figures if they match the descriptions. Do NOT flag them as explicitStranger. Still forbid random invented adults or crowds not covered by the note.`
    : '';
  const continuityBlock = recent > 0
    ? `\n\n**Continuity (${recent} recent approved interior image(s)):** Between COVER and CANDIDATE you see recent interiors in **story order** (oldest → newest). The CANDIDATE hero's **hair** and **outfit** should stay consistent with those references as well as the COVER (same child, same story-so-far look). Set **hairConsistentWithRecentInteriors** / **outfitConsistentWithRecentInteriors** to **false** only on **clear** drift vs the recent refs **or** the cover; lighting, angle, and partial occlusion are not failures. If uncertain, prefer **true**.`
    : '';
  const continuitySchema = recent > 0 ? `,
  "hairConsistentWithRecentInteriors": <true if the CANDIDATE hero's hair (color family, length, style) is clearly consistent with the RECENT interior reference images and the COVER; false only on clear mid-book drift; if uncertain, prefer true>,
  "outfitConsistentWithRecentInteriors": <true if the CANDIDATE hero's visible outfit is clearly consistent with the RECENT interiors' clothing story and the COVER (situational swaps like pajamas/swim still OK if the scene supports it); if uncertain, prefer true>,
  "hairContinuityNotes": "<short or empty>",
  "outfitContinuityNotes": "<short or empty>"` : '';

  return `You are a quality reviewer comparing the BOOK COVER to a generated interior SPREAD (CANDIDATE — **last image** in this message). Images may include optional real photo (IMAGE 0), then COVER, then optional RECENT APPROVED INTERIORS, then CANDIDATE. Both COVER and CANDIDATE should read as frames from the same 3D CGI Pixar **feature-film** children's book — photoreal subsurface skin scattering, rendered hair strands, physically based materials, volumetric ray-traced lighting, real optical depth-of-field. NOT a 2D illustration, NOT a painted children's book illustration, NOT a photograph.${photoNote}${desc}${castNote}${continuityBlock}

Judgment style: fail heroChildMatches or outfitMatches only on a **clear** mismatch. If uncertain, prefer **true** (pass). Differences in **lighting, shadow, wrinkle/fold, viewing angle, foreshortening, or partial occlusion** are NOT outfit failures. Baby vs older toddler: not an automatic fail for identity — only fail on clearly different hair color family, face shape, skin tone, or a clearly different child.

**Outfit (COVER vs CANDIDATE — no external text list):** Compare only the **visible clothing** on the hero on the COVER to the CANDIDATE. Set **outfitMatches: true** if the spread shows the **same outfit family** (same type of top/bottom/dress, same overall color story) as the cover, even if: colors shift slightly under different light, a jacket is open vs closed, or only part of the outfit is visible. Set **outfitMatches: true** for **explicit situational swaps** that the scene could explain (pajamas, swimwear, towel, heavy coat in snow) **if** they read as that situation. Set **outfitMatches: false** only when the main garments are **clearly** a different set (e.g. cover in a red dress, spread in unrelated blue overalls; or a complete style change) with no plausible situational reason.

Return STRICT JSON with this schema (no markdown, no commentary):

{
  "heroChildMatches": <true if the CANDIDATE spread hero is clearly the same identity as the child on the COVER — same face, ethnicity, skin tone, hair color/style, eye color, within normal illustration variance>,
  "heroChildDifferences": "<short description of any visible differences, or empty string>",
  "outfitMatches": <true per the OUTFIT rules above; prefer true when in doubt.>,
  "artStyleIs3DPixar": <true if the CANDIDATE reads as a 3D CGI Pixar-film frame with REAL volumetric 3D rendering — photoreal subsurface skin scattering, rendered hair strands (not painted hair shapes), physically based materials (real fabric weave, real wood grain, real foliage volume), ray-traced volumetric lighting, and genuine optical depth-of-field. False if the CANDIDATE reads as ANY of: a real photograph, stock photo, 2D flat illustration, soft painted children's-book illustration, watercolor, gouache, pencil sketch, ink-and-wash, anime cel-shading, paper cutout, pixel art, digital painting, or "illustrated storybook" with flat painted background + soft shaded figures. Faces with flat painted-looking skin, hair that reads as painted shapes instead of strands, or a background that reads as a flat painted image with blur (instead of a real 3D environment with lens bokeh) = false.>,
  "artStyleNotes": "<short description if artStyleIs3DPixar is false — e.g. 'skin and hair read as painted illustration, not 3D CGI', 'background is a flat painted image with blur, not a 3D environment'>",
  "heroCount": <integer — how many copies of the hero child appear in the spread. 1 is correct; 2+ is a duplicated-hero bug>,
  "heroBodyConnected": <true if the hero's body reads as ONE single continuous anatomy: head → neck → shoulders → torso → hips → legs → feet are all attached in one clean silhouette, the upper-body garment visibly connects to the lower-body garment on the same torso, and there are no floating "ghost" torsos, no stray extra pairs of legs/shorts/shoes rendered beside the hero, no visible body-segmentation seam, no two overlapping halves of the child. False if the child reads as two misaligned halves (e.g. an upper body in one pose on one side and a disembodied pair of legs/shorts standing beside them), if the shirt/top does NOT connect to the pants/shorts/skirt on the same body, or if an extra torso/legs ghosts next to the main figure. When clearly connected, true; when clearly broken, false; when unclear, prefer true.>,
  "heroBodyConnectedNotes": "<short description if heroBodyConnected is false (e.g. 'upper body in white shirt on left, disconnected legs in blue shorts standing to the right'), else empty string>",
  "splitPanel": <true if the spread looks like two separate illustrations joined together: visible vertical seam or "hard line" down the middle; abrupt change in lighting, color grade, perspective, or art style at center; background elements that do not align across the midline; a person or large object cut off unnaturally at center as if the right half were a different render; two different skies/horizons meeting at center. FALSE for a single coherent wide scene where the middle is just open garden/path/sky with natural continuity.>,
  "explicitStranger": <true ONLY if the CANDIDATE shows a non-child human's FULL FACE or a FULL-BODY adult figure that is forbidden by the policy above AND not covered by the CAST / POLICY NOTE. ${hasSecondaryOnCover ? 'Adults visible on the cover are allowed to appear fully — they are NOT strangers.' : 'When no adult is on the cover AND no policy note allows extra named adults, a fully-rendered adult (face visible, or full body figure) is a failure.'} Two full adults (e.g. a man and a woman) pushing a stroller ONLY fails if they are not allowed by the cast note. Hands, arms, back-of-head, a shoulder, or a cropped torso with the face out of frame are NOT explicit — do not flag those as strangers. A full-body adult seen from the back (face not visible) still counts as a full-body adult figure — treat as explicitStranger true unless the cast note explicitly allows that person. Distant, soft silhouettes without facial detail are usually NOT strangers unless they read as two full parents beside the child.>,
  "strangerDescription": "<short description of the explicit stranger (full face or full body), or empty>",
  "recurringItemConcerns": "<empty string, or a short note if a previously-introduced item (pet, toy, accessory) appears with a clearly different design from how it would be established in the book's reference cover>",
  "impliedParentSkinMismatch": <true ONLY if the CANDIDATE shows visible skin on an implied adult's partial body (hands, forearms, legs, arms) AND that skin is clearly inconsistent with the hero child's skin tone on the COVER (e.g. clearly different ethnicity or a large tone gap — such as dark brown adult hands with a fair-skinned child on the cover). false if no partial adult skin is visible, or skin matches plausibly for a parent and child, or comparison is unclear — when unclear, prefer false.>,
  "impliedParentSkinNotes": "<short note if impliedParentSkinMismatch is true, else empty string>",
  "impliedParentOutfitDrift": <true ONLY if RECENT APPROVED INTERIORS are present AND the CANDIDATE shows an implied parent (visible sleeve/cuff fragment, visible jewelry on a hand, or visible cropped-torso garment) whose sleeve color, fabric, or signature accessory (ring/watch/necklace) clearly does NOT match what the implied parent wore on the recent interior references. false if no recent interiors, or the implied parent does not appear in this spread, or the implied parent appearance is consistent, or comparison is unclear — when unclear, prefer false.>,
  "impliedParentOutfitNotes": "<short note if impliedParentOutfitDrift is true (e.g. 'previous spreads showed a mauve cardigan, this spread shows a navy jacket'), else empty string>",
  "disembodiedLimb": <true ONLY if the CANDIDATE shows a partial-presence limb (hand, arm, shoulder) that looks UNCANNY: a hand or arm floating in mid-frame with no visible path to a body, a limb that does not enter from a frame edge or from behind a foreground object, a limb whose off-frame body would be physically impossible for the staging, an extra/duplicated limb, a ghostly second arm, or a silhouette pasted at an obviously wrong depth/scale. false if any visible limb clearly continues off the edge of the frame in a believable way (wrist + forearm + sleeve continuing off-screen) and an off-frame body is plausible for the composition (e.g. parent seated beside the child, kneeling above, leaning over a railing). When unclear, prefer false.>,
  "disembodiedLimbNotes": "<short note if disembodiedLimb is true (which limb, why it reads as floating), else empty string>",
  "parentTurnedAway": <true ONLY if a mother or father appears in the CANDIDATE (full figure OR partial presence — visible limb or silhouette) AND their body language is clearly disconnected from the hero child in a way that reads as unnatural for a children's book: the parent's back is turned to the child with no narrative reason, the parent is walking away from the child, the parent is looking off into empty space while the child is behind them, or (for partial presence) the implied hand/arm extends AWAY from the child instead of toward them. false if the parent is oriented toward the child, leaning in, holding the child, sharing the child's focus on a shared object, walking ALONGSIDE the child, leading the child by the hand in profile, or both facing a shared focus together (fireworks, sunset, cake). false if no parent is in the frame. When unclear, prefer false.>,
  "parentTurnedAwayNotes": "<short note if parentTurnedAway is true (e.g. 'mother walking away from child with her back turned, child sitting behind looking at her'), else empty string>",
  "bathModestyOk": <true if the scene is not a bath/shower/swim modesty context, OR if it is, the child is modest per preschool picture-book standards (bubble cover, towel wrap, modest swimwear) — not naked with explicit detail and not fully dressed in street clothes submerged in water. false only on clear modesty violations.>,
  "bathModestyNotes": "<empty or short note if bathModestyOk is false>"${continuitySchema}
}

Be strict on art style — drift toward a "soft painted storybook illustration" look is a fail even if it is CGI-ish. The bar is "frame from a modern Pixar feature film", not "premium children's-book illustration". Photo-realistic drift and duplicated-hero / diptych seams are also fails. Be conservative on face matching — do not mark heroChildMatches false over minor or ambiguous differences. Return ONLY the JSON.`;
}

/**
 * @param {object} parsed - Model JSON
 * @param {number} [recentInteriorCount] - If >0, apply continuity fields from parsed
 */
function evaluateConsistencyResult(parsed, recentInteriorCount = 0) {
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
  if (parsed.heroBodyConnected === false) {
    const notes = (parsed.heroBodyConnectedNotes || '').trim();
    issues.push(`Hero body is not one connected anatomy${notes ? `: ${notes}` : ''}`);
    tags.push('body_disconnected');
  }
  if (parsed.splitPanel === true) {
    issues.push('Spread looks like a split panel / diptych with a visible seam');
    tags.push('split_panel');
  }
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
  if (parsed.impliedParentOutfitDrift === true) {
    const notes = (parsed.impliedParentOutfitNotes || '').trim();
    issues.push(`Implied parent's outfit/accessory drifted vs recent approved interiors${notes ? `: ${notes}` : ''}`);
    tags.push('implied_parent_outfit_drift');
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

  const recent = typeof recentInteriorCount === 'number' && recentInteriorCount > 0 ? recentInteriorCount : 0;
  if (recent > 0) {
    if (parsed.hairConsistentWithRecentInteriors === false) {
      const notes = (parsed.hairContinuityNotes || '').trim();
      issues.push(`Hero hair drifts vs recent approved interiors${notes ? `: ${notes}` : ''}`);
      tags.push('hair_continuity_drift');
    }
    if (parsed.outfitConsistentWithRecentInteriors === false) {
      const notes = (parsed.outfitContinuityNotes || '').trim();
      issues.push(`Hero outfit drifts vs recent approved interiors${notes ? `: ${notes}` : ''}`);
      tags.push('outfit_continuity_drift');
    }
  }

  return {
    pass: issues.length === 0,
    issues,
    tags: [...new Set(tags)],
  };
}

module.exports = { checkSpreadConsistency, evaluateConsistencyResult };
