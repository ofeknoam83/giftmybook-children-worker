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
  QA_MAX_OUTPUT_TOKENS,
} = require('./config');
const {
  extractGeminiResponseText,
  extractFinishReason,
  parseJsonBlock,
} = require('./qaResponseParser');
const { fetchWithTimeout, getNextApiKey } = require('../illustrationGenerator');
const { QA_RECENT_INTERIOR_REFERENCES } = require('../bookPipeline/constants');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
    theme: typeof opts.theme === 'string' ? opts.theme : '',
    caregiverLock: opts.caregiverLock || null,
  });
  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;

  /**
   * Build a request body for a given attempt, progressively shrinking the
   * payload on retries. Empty `len=0, finishReason=n/a` responses from
   * gemini-2.5-flash are most often a request-side rejection (safety pre-block,
   * over-large multimodal payload, or a per-key throttle returning a
   * candidate-less envelope). On retry we trim the payload to the smallest
   * shape that still answers the question — cover + candidate alone — so a
   * sustained block on the full 5-image shape doesn't burn the whole spread's
   * QA budget on identical failures.
   */
  function buildBody(attempt) {
    const includePhoto = childPhoto && attempt === 1;
    const recentForAttempt = attempt === 1
      ? recentRefs
      : (attempt === 2 ? recentRefs.slice(-1) : []);
    const userParts = [];
    let imageNum = 1;
    if (includePhoto) {
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
    for (const ref of recentForAttempt) {
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
    return {
      body: {
        contents: [{ role: 'user', parts: userParts }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
          thinkingConfig: { thinkingBudget: 0 },
          maxOutputTokens: QA_MAX_OUTPUT_TOKENS,
        },
      },
      shape: {
        attempt,
        photo: !!includePhoto,
        recentRefs: recentForAttempt.length,
        totalImages: 1 + (includePhoto ? 1 : 0) + recentForAttempt.length + 1,
      },
    };
  }

  let lastErr = null;
  let lastFinishReason = null;
  for (let attempt = 1; attempt <= QA_HTTP_ATTEMPTS; attempt++) {
    const { body, shape } = buildBody(attempt);
    try {
      const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, QA_TIMEOUT_MS, opts.abortSignal);
      if (!resp.ok) { lastErr = new Error(`Consistency QA HTTP ${resp.status}`); await sleep(500 * attempt); continue; }
      const data = await resp.json();
      lastFinishReason = extractFinishReason(data) || lastFinishReason;
      const txt = extractGeminiResponseText(data);
      const { parsed, repaired } = parseJsonBlock(txt);
      if (!parsed) {
        // Diagnostic: when len=0 AND finishReason is missing, the response
        // came back with no candidates at all — the canonical shape of a
        // pre-model rejection (safety pre-block, payload throttle, or
        // promptFeedback-only error envelope). Surface enough of the raw
        // response so we can confirm the cause from logs without re-running.
        if (!txt && !lastFinishReason) {
          const promptFeedback = data && typeof data === 'object' ? data.promptFeedback : null;
          const blockReason = promptFeedback?.blockReason || promptFeedback?.block_reason || null;
          const safetyRatings = Array.isArray(promptFeedback?.safetyRatings)
            ? promptFeedback.safetyRatings.filter(r => r && (r.blocked === true || r.probability === 'HIGH'))
            : [];
          const candidatesLen = Array.isArray(data?.candidates) ? data.candidates.length : 0;
          console.warn(
            `[illustrator/consistencyQa] Empty response diagnostic ` +
            `attempt=${attempt} payloadShape=${JSON.stringify(shape)} ` +
            `candidates=${candidatesLen} blockReason=${blockReason || 'null'} ` +
            `flaggedSafetyRatings=${safetyRatings.length > 0 ? JSON.stringify(safetyRatings) : 'none'} ` +
            `keys=${data && typeof data === 'object' ? Object.keys(data).join(',') : '(no body)'}`,
          );
        }
        lastErr = new Error(
          `Consistency QA unparseable response (finishReason=${lastFinishReason || 'n/a'}, len=${txt.length})`,
        );
        await sleep(500 * attempt);
        continue;
      }
      if (repaired) {
        console.warn(
          `[illustrator/consistencyQa] Recovered from truncated JSON ` +
          `(finishReason=${lastFinishReason || 'n/a'}, attempt=${attempt})`,
        );
      }
      if (attempt > 1) {
        console.warn(
          `[illustrator/consistencyQa] Recovered on retry attempt=${attempt} ` +
          `payloadShape=${JSON.stringify(shape)} — earlier attempt(s) returned empty`,
        );
      }
      return evaluateConsistencyResult(parsed, recentCount);
    } catch (err) {
      lastErr = err;
      await sleep(500 * attempt);
    }
  }

  // Preserve original semantics: fail-open returns pass:false with infra:true.
  // The caller in services/illustrator/index.js promotes this to an accept on
  // the final attempt + final rebuild, so a sustained Gemini outage still
  // unblocks the book — just not silently on the first attempt.
  console.warn(
    `[illustrator/consistencyQa] Fail-open after ${QA_HTTP_ATTEMPTS} attempts ` +
    `(finishReason=${lastFinishReason || 'n/a'}): ${lastErr?.message}`,
  );
  return {
    pass: false,
    issues: [`Consistency QA infra error: ${lastErr?.message || 'unknown'}`],
    tags: ['qa_api_error'],
    infra: true,
  };
}

const PARENT_THEMES_QA = new Set(['mothers_day', 'fathers_day', 'grandparents_day']);

function buildConsistencyPrompt({
  hasSecondaryOnCover,
  characterDescription,
  hasChildPhoto,
  qaAllowedHumansNote,
  recentInteriorCount,
  theme,
  caregiverLock,
}) {
  const recent = typeof recentInteriorCount === 'number' && recentInteriorCount > 0 ? recentInteriorCount : 0;
  const isParentTheme = PARENT_THEMES_QA.has(String(theme || '').toLowerCase());
  const desc = typeof characterDescription === 'string' && characterDescription.trim()
    ? ` Story-author reference (may clarify intent; COVER is still the render truth): ${characterDescription.trim()}`
    : '';
  const photoNote = hasChildPhoto
    ? ' If a real child photo was also provided, use it only to disambiguate identity when the cover is ambiguous. The CANDIDATE spread (last image) must still match the RENDER of the child on the COVER, not necessarily the snapshot lighting in the photo.'
    : '';
  const castNote = qaAllowedHumansNote
    ? `\n\nCAST / POLICY NOTE (from production — honor when judging explicitStranger): ${qaAllowedHumansNote}\nWhen this note lists customer-confirmed adults who are NOT drawn on the cover, those specific people may still appear as full figures if they match the descriptions. Do NOT flag them as explicitStranger. Still forbid random invented adults or crowds not covered by the note.`
    : '';
  // Parent-theme picture books are gift products — hair drift on a printed
  // gift book is a hard fail. Flip the "when uncertain prefer true" default
  // for parent themes so even subtle hair-color or hair-length shifts trigger
  // a regen. Non-parent themes keep the lenient default.
  const continuityStrictness = isParentTheme
    ? '**Strictness for this book (parent-theme gift product):** be STRICT on hair and outfit continuity — even small drifts are a failure on a printed gift book. When uncertain, prefer **false** (fail).'
    : 'If uncertain, prefer **true**.';
  const continuityBlock = recent > 0
    ? `\n\n**Continuity (${recent} recent approved interior image(s)):** Between COVER and CANDIDATE you see recent interiors in **story order** (oldest → newest). The CANDIDATE hero's **hair** and **outfit** should stay consistent with those references as well as the COVER (same child, same story-so-far look). Set **hairConsistentWithRecentInteriors** / **outfitConsistentWithRecentInteriors** to **false** on **clear** drift vs the recent refs **or** the cover; lighting, angle, and partial occlusion are not failures. ${continuityStrictness}`
    : '';
  // Caregiver visual lock block — included whenever a caregiverLock is
  // present (caregiver IS on the cover). Gives the QA call the SAME
  // ground-truth identity the renderer was instructed to render. Drives the
  // three new tags below: caregiver_shadow_substitution, caregiver_skin_drift,
  // phantom_arms.
  const lock = caregiverLock || null;
  const caregiverLockBlock = lock
    ? `\n\n**Caregiver visual lock (cover-derived — the SAME caregiver that is rendered on the COVER):**\n  - role: ${lock.role || 'caregiver'}\n  - skin tone (LOCK — from the caregiver\'s OWN pixels on the cover, not the child): ${lock.skinTone || '(see cover render)'}\n  - skin family vs the child: ${lock.skinFamilyVsChild || 'unclear'}\n  - hair: ${lock.hair || '(see cover render)'}\n  - outfit: ${lock.outfit || '(see cover render)'}\n  - build: ${lock.build || '(see cover render)'}\n  - face: ${lock.face || '(see cover render)'}\n  When judging the candidate, compare the caregiver in the candidate against THIS lock and against the caregiver as rendered on the COVER — NOT against the hero child. The caregiver is allowed to have a different skin family from the child if the lock says so; what matters is consistency with the lock and the cover.`
    : '';

  // New schema fields driven by the caregiver lock. These are extra tags on
  // top of the existing schema so we keep backwards compatibility with the
  // old prompt; evaluateConsistencyResult also handles missing keys.
  const caregiverSchema = lock ? `,
  "caregiverShadowSubstitution": <true ONLY if the caregiver is supposed to be PHYSICALLY in this scene (manuscript text + composition imply she is holding, sitting beside, walking with, or otherwise present with the child) BUT the candidate has REPLACED her body with a flat, featureless cast shadow on a wall, floor, or ceiling instead of rendering her actual visible body. The shadow has no facial features and no rendered torso — it is just a dark profile shape on a surface where her body should be. false if she is genuinely off-frame and only her shadow is shown as ambient atmosphere; false if she is rendered with a real body (head + torso + arms attached). When uncertain, prefer false.>,
  "caregiverShadowSubstitutionNotes": "<short note if true (e.g. 'spread should show Mama sitting on the bench holding the child, but Mama is rendered as a flat dark profile shadow on the wall behind the bench, with no body in the scene'), else empty string>",
  "caregiverShadowSubstitutionRepair": "<if true, write a SURGICAL repair instruction in the form: \"Spread N BAD: <one-sentence description of what the candidate did wrong, named concretely>. FIX: <one-sentence description of what to render instead, named concretely, including the caregiver lock skin tone>.\" Example: \"Spread 7 BAD: Mama is rendered as a flat profile shadow on the wall behind the bench, with no body in the scene. FIX: render Mama's full body sitting on the bench holding the child — head, torso, and both arms attached to her single torso, skin tone ${lock.skinTone || '(see cover render)'}, hair ${lock.hair || '(see cover render)'}, outfit ${lock.outfit || '(see cover render)'}. One Mama, two arms, no wall-shadow substitute.\" Else empty string.>",
  "caregiverSkinDrift": <true ONLY if the caregiver is visibly rendered in the candidate (any meaningful skin patch on the caregiver — face, jaw, neck, shoulder, torso, arm, hand) AND the caregiver's skin family in the candidate clearly differs from the caregiver lock above (and the caregiver as rendered on the COVER) — a clear ≥2-shade gap in lightness OR an obvious undertone shift. Compare against the LOCK / COVER, NOT against the child. The child being lighter than the caregiver is fine when the lock says so. When uncertain, prefer false.>,
  "caregiverSkinDriftNotes": "<short note if true (e.g. 'cover Mama reads as light warm beige with peachy undertone, candidate Mama reads as medium-tan with cool olive undertone — clear two-shade gap and undertone shift'), else empty string>",
  "caregiverSkinDriftRepair": "<if true, write a SURGICAL repair instruction in the form: \"Spread N BAD: <how the candidate's caregiver skin drifted vs the lock>. FIX: <restate the locked skin tone and what to render>.\" Example: \"Spread 4 BAD: Mama's arm and shoulder read as medium-tan with a warm olive undertone — darker than her cover render. FIX: render Mama's skin as ${lock.skinTone || '(see cover render)'} on every visible patch (face, neck, arm, hand) so she is clearly the SAME person as on the cover. Do not drift darker than the cover even under warm light.\" Else empty string.>",
  "phantomArms": <true ONLY if the candidate shows EXTRA or DUPLICATE arms wrapping or reaching toward the child that do NOT anatomically connect to a single visible torso in the frame: a third arm coming from behind the child with no body in the scene, two pairs of caregiver arms (one wrapping the child + another reaching from another direction), a disembodied arm next to the caregiver's actual arm with no body to anchor it, etc. Different from disembodiedLimb (which is about ANY uncanny limb): phantom_arms is specifically about caregiver arms multiplying around the child. When uncertain, prefer false.>
  ,"phantomArmsNotes": "<short note if true (e.g. 'Mama has one arm visibly holding the child from the left AND a second arm wrapping from behind the child with no torso visible behind the child to anchor it'), else empty string>",
  "phantomArmsRepair": "<if true, write a SURGICAL repair instruction in the form: \"Spread N BAD: <how the phantom arms appear>. FIX: <restate the one-torso, two-arms rule>.\" Example: \"Spread 4 BAD: a second pair of darker arms wraps the child from behind, with no second torso visible to anchor them. FIX: render Mama as ONE single body — head, torso, two arms, both arms attached to the same visible torso. The child is held by ONE pair of Mama-arms, not two. Skin tone of every Mama-arm must read as ${lock.skinTone || '(see cover render)'}.\" Else empty string.>",
  "caregiverBodyDuplicated": <true ONLY if the manuscript implies that exactly ONE caregiver is in this scene (one ${lock.role || 'caregiver'} present with the child) BUT the candidate renders TWO OR MORE distinct adult-body instances that all read as the SAME caregiver: two full-body caregivers in different poses around the child, one fully-rendered caregiver + one headless torso/kneeling body wrapping the child, two cropped adult torsos in the same frame each with arms reaching toward the child, a kneeling/bending adult body on one side AND a separate fully-rendered adult body on the other side both interacting with the child, etc. Different from phantomArms (which is only about ARMS multiplying around the child): caregiverBodyDuplicated catches a duplicated TORSO / WHOLE BODY — the renderer drew the caregiver twice. Different from heroCount (which counts duplicated children). Trigger when you can clearly identify two separate adult-body silhouettes that should have been ONE single caregiver. Distinct adults who are policy-allowed (e.g. both parents on the cover, a grandparent + parent both on the cover) do NOT trigger this — they are different people. When uncertain whether the two bodies are the same caregiver duplicated vs two distinct allowed adults, prefer false. When uncertain whether there's actually a second body or just the caregiver's own body in an unusual pose, prefer false.>,
  "caregiverBodyDuplicatedNotes": "<short note if true, naming both bodies concretely (e.g. 'one Dada visible on the left as a headless kneeling body in tan pants and blue sleeve wrapping the baby from behind, AND a second fully-rendered Dada on the right with face + torso + arms in blue sweater reaching for the baby — two separate adult bodies for what should be ONE Dada'), else empty string>",
  "caregiverBodyDuplicatedRepair": "<if true, write a SURGICAL repair instruction in the form: \"Spread N BAD: <how the duplicated caregiver bodies appear, named concretely>. FIX: <one-sentence description of what to render instead, restating ONE caregiver, one body, one head, one torso, two arms, with the caregiver lock.>\" Example: \"Spread 10 BAD: two separate Dada bodies in the frame — a headless kneeling body in tan pants on the left wrapping the baby AND a fully-rendered Dada with face + torso on the right reaching for her. FIX: render exactly ONE Dada in the frame — ONE head, ONE torso, ONE pair of arms, ONE pair of legs, all attached on a single body. Place him in a single clear pose interacting with Scarlett (e.g. kneeling beside her on the rug holding her with both arms). Skin tone ${lock.skinTone || '(see cover render)'}, hair ${lock.hair || '(see cover render)'}, outfit ${lock.outfit || '(see cover render)'}. NEVER two Dadas in the same frame.\" Else empty string.>"` : '';

  const continuitySchema = recent > 0 ? `,
  "hairConsistentWithRecentInteriors": <true if the CANDIDATE hero's hair (color family, length, texture, style) is clearly consistent with the RECENT interior reference images and the COVER. Set false ONLY on CLEAR drifts of THE HAIR ITSELF: COLOR FAMILY shift (dark-brown → light-brown, brown → blond, blond → red, brunette → ash); TEXTURE shift (curly mop → straight wispy, tight coils → loose waves, straight → curly); LENGTH/VOLUME shift (full thick mop → short wispy, long → short, dense → sparse). Lighting can change brightness or sheen; lighting CANNOT change color family, texture, or volume. **CRITICAL — accessories are NOT hair drift:** a headband, hairband, bow, ribbon, clip, scrunchie, hat, bandana, headphones, or hood appearing or disappearing across spreads is NOT hair drift — it is a wardrobe / accessory choice that the renderer is allowed to vary. Do NOT trigger this tag because the candidate has a bow/headband/clip the references don't, or vice versa. Only trigger when the hair UNDERNEATH any accessory has clearly drifted in color, texture, or length. Hair drift on a printed gift book is a hard fail — customers notice — but only on the hair itself. ${isParentTheme ? 'For this parent-theme gift book, also false on subtle drift — when uncertain prefer false.' : 'When uncertain about a borderline case, prefer true; when the drift is named-and-obvious (e.g. dark-brown curly mop on cover → light-brown straight wispy hair on spread), prefer false.'}>,
  "outfitConsistentWithRecentInteriors": <true if the CANDIDATE hero's visible outfit is clearly consistent with the RECENT interiors' clothing story and the COVER (situational swaps like pajamas/swim still OK if the scene supports it)${isParentTheme ? '; for this parent-theme gift book, prefer false when uncertain' : '; if uncertain, prefer true'}>,
  "hairContinuityNotes": "<short or empty>",
  "outfitContinuityNotes": "<short or empty>"` : '';

  return `You are a quality reviewer comparing the BOOK COVER to a generated interior SPREAD (CANDIDATE — **last image** in this message). Images may include optional real photo (IMAGE 0), then COVER, then optional RECENT APPROVED INTERIORS, then CANDIDATE. Both COVER and CANDIDATE should read as frames from the SAME RENDERING TRADITION — whatever rendering tradition the cover uses (3D CGI / 2D illustration / painted / watercolor / gouache / digital painting). Style consistency between cover and interiors is the contract; the cover is the single visual style ground truth.${photoNote}${desc}${castNote}${caregiverLockBlock}${continuityBlock}

Judgment style: fail heroChildMatches or outfitMatches only on a **clear** mismatch. If uncertain, prefer **true** (pass). Differences in **lighting, shadow, wrinkle/fold, viewing angle, foreshortening, or partial occlusion** are NOT outfit failures.

**Age & proportions across spreads (HARD RULE — gift book continuity):** the hero must read as the SAME AGE as the cover child across every interior spread. Do NOT excuse age drift as artistic license. A lap baby on the cover (head-to-body ratio ~1:3, no rendered teeth, cannot stand independently, soft rounded limbs) cannot become a standing/walking toddler on an interior spread (head-to-body ratio ~1:4–1:5, visible teeth, lengthened limbs, independent stance). A toddler on the cover cannot become a preschooler on an interior. The cover sets the age; every spread must render that same-age child. Pose may vary (sitting, held, reaching, looking) — age, proportions, and developmental stage must NOT. This is a hard fail on a printed gift product.

**Outfit (COVER vs CANDIDATE — no external text list):** Compare only the **visible clothing** on the hero on the COVER to the CANDIDATE. Set **outfitMatches: true** if the spread shows the **same outfit family** (same type of top/bottom/dress, same overall color story) as the cover, even if: colors shift slightly under different light, a jacket is open vs closed, or only part of the outfit is visible. Set **outfitMatches: true** for **explicit situational swaps** that the scene could explain (pajamas, swimwear, towel, heavy coat in snow) **if** they read as that situation. Set **outfitMatches: false** only when the main garments are **clearly** a different set (e.g. cover in a red dress, spread in unrelated blue overalls; or a complete style change) with no plausible situational reason.

Return STRICT JSON with this schema (no markdown, no commentary):

{
  "heroChildMatches": <true if the CANDIDATE spread hero is clearly the same identity as the child on the COVER — same face, ethnicity, skin tone, hair color/style, eye color, within normal illustration variance. SKIN TONE is a separate dimension from "face shape" — a clearly different skin family (e.g. cover child fair-skinned, candidate medium-tan; cover deep-brown, candidate light-brown) is NOT "normal illustration variance" — mark heroChildMatches false on a clear skin-tone gap even if the face shape and hair are otherwise the same person.>,
  "heroChildDifferences": "<short description of any visible differences, or empty string>",
  "heroAgeAndProportionsMatchCover": <true if the CANDIDATE hero reads as the SAME AGE as the cover child — same head-to-body ratio, same developmental stage, same dental development (no rendered teeth on a baby), same limb proportions, same standing-vs-supported expectation. false on any CLEAR age drift: cover is a lap baby (~1:3 head-to-body, no teeth, soft rounded limbs, sitting/held) but spread renders a standing/walking toddler with lengthened limbs and visible teeth; cover is a toddler but spread renders a preschooler with lengthened limbs and a thinner face; cover is a preschooler but spread renders a baby. Pose change (sitting vs reaching vs looking) is fine; age change is not. When uncertain, prefer **true**, but on an unambiguous head-to-body or developmental gap (lap baby → standing toddler is the canonical fail), prefer **false**.>,
  "heroAgeAndProportionsNotes": "<short note if heroAgeAndProportionsMatchCover is false (e.g. 'cover shows a lap baby with ~1:3 head-to-body ratio, no rendered teeth, sitting on a lap; candidate shows a standing toddler walking independently with ~1:4 head-to-body ratio, lengthened limbs, and a visible toothy smile'), else empty string>",
  "outfitMatches": <true per the OUTFIT rules above; prefer true when in doubt.>,
  "artStyleMatchesCover": <true if the CANDIDATE spread visually reads as the SAME RENDERING TRADITION as the COVER — same surface treatment (whatever the cover shows: 3D CGI / 2D illustration / painted / watercolor / gouache / digital painting), same shading approach, same hair-rendering approach (rendered strands vs painted shapes — match the cover), same materials, same lighting language, same level of detail. Lighting / camera angle / mood may differ between spread and cover; rendering tradition must not. False ONLY when the spread's rendering tradition CLEARLY differs from the cover's (e.g., cover is 3D CGI but spread reads as 2D painted illustration; cover is painted but spread reads as photoreal CGI). When uncertain, prefer true. Real photographs are always false (a book illustration is never a real photograph).>,
  "artStyleNotes": "<short description if artStyleMatchesCover is false — e.g. 'cover reads as 3D CGI but spread reads as flat painted illustration', 'cover is painted but spread reads as photoreal CGI'>",
  "heroCount": <integer — how many copies of the hero child appear in the spread. 1 is correct; 2+ is a duplicated-hero bug>,
  "heroBodyConnected": <true if the hero's body reads as ONE single continuous anatomy: head → neck → shoulders → torso → hips → legs → feet are all attached in one clean silhouette, the upper-body garment visibly connects to the lower-body garment on the same torso, and there are no floating "ghost" torsos, no stray extra pairs of legs/shorts/shoes rendered beside the hero, no visible body-segmentation seam, no two overlapping halves of the child. False if the child reads as two misaligned halves (e.g. an upper body in one pose on one side and a disembodied pair of legs/shorts standing beside them), if the shirt/top does NOT connect to the pants/shorts/skirt on the same body, or if an extra torso/legs ghosts next to the main figure. When clearly connected, true; when clearly broken, false; when unclear, prefer true.>,
  "heroBodyConnectedNotes": "<short description if heroBodyConnected is false (e.g. 'upper body in white shirt on left, disconnected legs in blue shorts standing to the right'), else empty string>",
  "splitPanel": <true if the spread looks like two separate illustrations joined together: visible vertical seam or "hard line" down the middle; abrupt change in lighting, color grade, perspective, or art style at center; background elements that do not align across the midline; a person or large object cut off unnaturally at center as if the right half were a different render; two different skies/horizons meeting at center. FALSE for a single coherent wide scene where the middle is just open garden/path/sky with natural continuity.>,
  "explicitStranger": <true ONLY if the CANDIDATE shows a non-child human's FULL FACE or a FULL-BODY adult figure that is forbidden by the policy above AND not covered by the CAST / POLICY NOTE. ${hasSecondaryOnCover ? 'Adults visible on the cover are allowed to appear fully — they are NOT strangers.' : 'When no adult is on the cover AND no policy note allows extra named adults, a fully-rendered adult (face visible, or full body figure) is a HARD FAILURE for this book — when uncertain, prefer **true**. The whole point of this book\'s policy is that the parent is implied only; any visible parent face on an interior spread is a violation, not an artistic choice. This includes ANY interpretable face: a clearly-rendered woman / mother / man / father face in the frame, a partial face with eyes + mouth visible, a face emerging through hair or shadow, OR a stylized adult silhouette with rendered facial features (eyes, mouth, eye-glow, smile) — all count as a full face for this rule.'} Two full adults (e.g. a man and a woman) pushing a stroller ONLY fails if they are not allowed by the cast note. Hands, arms, back-of-head, a shoulder, or a cropped torso with the face out of frame are NOT explicit — do not flag those as strangers. A full-body adult seen from the back (face not visible) still counts as a full-body adult figure — treat as explicitStranger true unless the cast note explicitly allows that person. Distant, soft silhouettes WITHOUT any facial detail (no eyes, no mouth, no glow inside the head shape) are usually NOT strangers unless they read as two full parents beside the child.>,
  "strangerDescription": "<short description of the explicit stranger (full face or full body), or empty>",
  "recurringItemConcerns": "<empty string, or a short note if a previously-introduced item (pet, toy, accessory) appears with a clearly different design from how it would be established in the book's reference cover>",
  "heroSkinToneMatchesCover": <true if the HERO CHILD's visible skin in the CANDIDATE spread reads as the SAME skin family as the hero child on the COVER — same lightness, same warmth, same undertone. Trigger false on any clear gap: cover child reads as fair / very pale and the candidate reads as medium-tan / olive / sun-kissed / any visibly darker family; cover reads as medium and the candidate reads as much darker or much lighter; cover reads as deep brown and the candidate reads as a lighter family; OR the undertone clearly drifts (warm-to-cool or cool-to-warm) even if lightness is similar. Lighting may shift brightness slightly across spreads, NOT skin family. When uncertain about whether a gap exists, prefer **false** — this is a customer-visible failure that the user has explicitly flagged. true ONLY when no hero child skin is visible in the candidate (e.g. fully suited / fully covered) — in that case set true and leave notes empty.>,
  "heroSkinToneNotes": "<short note if heroSkinToneMatchesCover is false (e.g. 'cover child reads as fair / very pale, candidate child reads as medium-tan with warm undertone — clear two-shade gap'), else empty string>",
  "impliedParentSkinMismatch": <true ONLY if the CANDIDATE shows visible skin on an implied adult (hands, forearms, wrist, fingers, neck/jawline, partial face, cropped torso with skin showing) AND that adult skin reads as an UNAMBIGUOUSLY DIFFERENT family from the hero child on the COVER — a clear ≥2-shade gap in lightness AND/OR an obvious undertone shift (warm vs cool) that any viewer would call out. Trigger ONLY when you can name the gap concretely (e.g. 'cover child fair/peachy, adult hand reads medium-tan with warm olive undertone'). DO NOT trigger on borderline cases: light vs lighting-affected; small lightness differences explainable by ambient warm/cool light; minor warm shifts on a hand from a sunset/window-light scene; tiny patches of skin (a couple of fingers) where the comparison is inherently noisy. Lighting changes brightness, NOT skin family — but lighting absolutely DOES change perceived warmth on small skin patches, so single-finger or sleeve-cuff fragments under colored light should NOT trigger this tag. Prefer **false** when uncertain — repeated false-positive triggers on this tag burn the entire repair budget and fail the book; the cost of a false positive is far higher than a borderline true positive that ships. false also when no adult skin is visible at all.>,
  "impliedParentSkinNotes": "<short note if impliedParentSkinMismatch is true, naming the gap (e.g. 'cover child is fair-skinned but the mother's hand and arm read as medium-tan — clear two-shade gap'), else empty string>",
  "impliedParentOutfitDrift": <true ONLY if RECENT APPROVED INTERIORS are present AND the CANDIDATE shows a VISIBLE part of the implied parent's BODY (sleeve cuff on a real arm, ring/watch on a real hand, cropped torso with worn garment) AND that body's clothing or accessory clearly does NOT match what the implied parent wore on the recent interior references — the SAME garment in a different color / fabric, or a clearly different signature accessory ON THE PARENT'S BODY. CRITICAL: Set this **false** when (a) the parent is NOT in the frame at all, (b) the only thing visible is a "signature object" without the parent (a cardigan draped over a chair, a mug on a table, a coat hanging on a branch, a pair of glasses on a windowsill — all of these are policy-allowed object-stand-ins for an absent parent and are NOT outfit drift), (c) the parent's body cannot be confirmed visible (face-not-shown, unsure if it's the same item, a garment that "could be" theirs but no body to anchor it), or (d) comparison is unclear. Only trigger when you can name BOTH a visible body part AND a clear garment/accessory mismatch on that body. When unclear, prefer **false** — this tag burns repair budget on borderline calls.>,
  "impliedParentOutfitNotes": "<short note if impliedParentOutfitDrift is true (e.g. 'previous spreads showed a mauve cardigan, this spread shows a navy jacket'), else empty string>",
  "fullBodyParentSkinMismatch": <true ONLY if the CANDIDATE shows a SUBSTANTIALLY-rendered adult (full face in frame, partial face such as jaw/ear/cheek alongside hair, full body in frame, OR a large torso/arm presence that goes well beyond a single hand/sleeve fragment) AND that adult's visible skin reads as an UNAMBIGUOUSLY DIFFERENT family from the hero child on the COVER — clear ≥2-shade gap in lightness AND/OR obvious undertone shift (warm vs cool) that any viewer would call out. Trigger ONLY when you can name the gap concretely in the notes (e.g. 'cover child fair/peachy, mother's full torso + jaw read as medium-tan'). DO NOT trigger on borderline cases or on small skin patches (single hand + sleeve) — those belong to impliedParentSkinMismatch, and even there should be evaluated conservatively. Triggers regardless of whether the adult is "allowed" to appear fully — catches both off-cover-parent policy violations AND on-cover parents whose interior render drifted to a clearly different skin family. Prefer **false** when uncertain — repeated false-positive triggers on this tag burn the entire repair budget and fail the book.>,
  "fullBodyParentSkinNotes": "<short note if fullBodyParentSkinMismatch is true (e.g. 'mother's torso, arm, hand, jaw, and ear visible — skin reads as medium-tan, cover child is fair'), else empty string>",
  "tooManyHands": <true if ANY single human character in the CANDIDATE visibly has MORE THAN TWO HANDS attached (or apparently attached) to their body — e.g. an adult holding the child with one arm visible on each side AND a third hand also touching/gesturing toward the child; a parent reaching with three or four arms; a child with a third arm emerging from the torso; a hand floating in the same body's silhouette region with no second arm to explain it. Count both fully-rendered hands and obvious 'half hands' (a fingers-only fragment in the same body's reach zone). Two characters each with two hands = false. A clearly disembodied limb belonging to no character belongs in disembodiedLimb, NOT here — here we count extra hands ON ONE BODY. When uncertain, prefer **false** (pass) UNLESS the extra hand is unmistakable. Do not flag a hand seen palm + back simultaneously due to a wrist twist; only flag separate hand instances.>,
  "tooManyHandsNotes": "<short note if true (which character, where the extras are — e.g. 'mother has three hands: one on the stroller bar, one on the child's shoulder, and a third reaching from behind the child'), else empty string>",
  "objectIntegrityOk": <true if all prominent man-made objects in the CANDIDATE (stroller, pram, shopping cart, bicycle, scooter, wagon, table, chair, ladder, swing, slide, crib, high chair) read as STRUCTURALLY COHERENT — each handle attaches to a real frame, wheels are paired correctly, seats sit on a believable base, no duplicated bars or floating segments, no two halves fused at impossible angles. false ONLY when a prominent object is clearly broken: a stroller handle that does not connect to the stroller body; a cart with a handle attaching mid-air; two seats fused to one wheel; a bicycle with a handlebar floating beside the frame; a chair with three legs at the front and none at the back; a ladder rungs that don't span between the rails. Background props with minor wonkiness are FINE — only flag prominent in-focus objects with clear structural failure. When uncertain, prefer **true** (pass).>,
  "objectIntegrityNotes": "<short note if objectIntegrityOk is false (which object, what's broken — e.g. 'stroller handle floats above the stroller body with no visible bar connecting the two; the handle ends in mid-air'), else empty string>",
  "disembodiedLimb": <true ONLY if the CANDIDATE shows a partial-presence limb (hand, arm, shoulder) that looks UNCANNY: a hand or arm floating in mid-frame with no visible path to a body, a limb that does not enter from a frame edge or from behind a foreground object, a limb whose off-frame body would be physically impossible for the staging, an extra/duplicated limb, a ghostly second arm, or a silhouette pasted at an obviously wrong depth/scale. false if any visible limb clearly continues off the edge of the frame in a believable way (wrist + forearm + sleeve continuing off-screen) and an off-frame body is plausible for the composition (e.g. parent seated beside the child, kneeling above, leaning over a railing). When unclear, prefer false.>,
  "disembodiedLimbNotes": "<short note if disembodiedLimb is true (which limb, why it reads as floating), else empty string>",
  "parentAsCharacterSilhouette": <true ${hasSecondaryOnCover ? '' : 'ONLY '}if the CANDIDATE shows the themed parent rendered as an ANTHROPOMORPHIZED silhouette / shadow / dark figure that has been turned into a CHARACTER instead of a soft implied presence. Trigger when the silhouette has any of: visible eyes, glowing eyes, a visible mouth or smile, a clearly-rendered hand silhouette gesturing at the child, body language that frames it as a co-actor in the scene rather than ambient presence, or a head shape with a face-like blank / glow that reads as expressive. ${hasSecondaryOnCover ? 'A parent who is allowed on the cover may still fail this if they are rendered ONLY as a creepy face-having shadow rather than as the cover person.' : 'Because the parent is NOT on the cover for this book, the parent must remain a SOFT implied presence — a hand, a shoulder-back, a cropped torso, an empty chair, or a plain unfeatured silhouette / shadow with no face details. The moment the silhouette gains eyes, a mouth, an expressive face, or a gesturing hand silhouette, it becomes a forbidden full character — set this true.'} false ONLY for genuinely featureless background silhouettes (a plain dark profile with no facial detail and no character gestures), or when no parent silhouette is in frame.>,
  "parentAsCharacterSilhouetteNotes": "<short note if true (e.g. 'mother rendered as a tall shadow with two glowing eyes, an open mouth, and a hand silhouette gesturing at the child'), else empty string>",
  "parentTurnedAway": <true ONLY if a mother or father appears in the CANDIDATE (full figure OR partial presence — visible limb or silhouette) AND their body language is clearly disconnected from the hero child in a way that reads as unnatural for a children's book: the parent's back is turned to the child with no narrative reason, the parent is walking away from the child, the parent is looking off into empty space while the child is behind them, or (for partial presence) the implied hand/arm extends AWAY from the child instead of toward them. false if the parent is oriented toward the child, leaning in, holding the child, sharing the child's focus on a shared object, walking ALONGSIDE the child, leading the child by the hand in profile, or both facing a shared focus together (fireworks, sunset, cake). false if no parent is in the frame. When unclear, prefer false.>,
  "parentTurnedAwayNotes": "<short note if parentTurnedAway is true (e.g. 'mother walking away from child with her back turned, child sitting behind looking at her'), else empty string>",
  "bathModestyOk": <true if the scene is not a bath/shower/swim modesty context, OR if it is, the child is modest per preschool picture-book standards (bubble cover, towel wrap, modest swimwear) — not naked with explicit detail and not fully dressed in street clothes submerged in water. false only on clear modesty violations.>,
  "bathModestyNotes": "<empty or short note if bathModestyOk is false>"${caregiverSchema}${continuitySchema}
}

Style judgment: compare spread to cover, not to an external bar. If the spread's rendering tradition clearly differs from the cover's (e.g. cover is 3D CGI but spread reads as soft painted storybook; or cover is painted but spread reads as photoreal CGI), set artStyleMatchesCover=false. If the spread's rendering tradition matches the cover's — even if the cover itself happens to be a softer painted style — set artStyleMatchesCover=true. Photo-realistic drift (a real photograph) is always a fail; a book illustration is never a photograph regardless of cover style. Duplicated-hero / diptych seams are also fails. Be conservative on face matching — do not mark heroChildMatches false over minor or ambiguous differences. Return ONLY the JSON.`;
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
  if (parsed.heroAgeAndProportionsMatchCover === false) {
    const notes = (parsed.heroAgeAndProportionsNotes || '').trim();
    issues.push(`Hero age / proportions drift from the cover${notes ? `: ${notes}` : ''}`);
    tags.push('hero_age_proportions_drift');
  }
  if (parsed.outfitMatches === false) {
    issues.push('Hero outfit differs from the cover (and not an explicit situational swap)');
    tags.push('outfit_mismatch');
  }
  if (parsed.artStyleMatchesCover === false) {
    const notes = (parsed.artStyleNotes || '').trim();
    issues.push(`Spread's rendering tradition does not match the BOOK COVER${notes ? `: ${notes}` : ''}`);
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
  if (parsed.parentAsCharacterSilhouette === true) {
    const notes = (parsed.parentAsCharacterSilhouetteNotes || '').trim();
    issues.push(`Themed parent rendered as an anthropomorphized character silhouette / shadow with face features${notes ? `: ${notes}` : ''}`);
    tags.push('parent_as_character_silhouette');
  }
  if (parsed.recurringItemConcerns && String(parsed.recurringItemConcerns).trim()) {
    issues.push(`Recurring item concern: ${parsed.recurringItemConcerns}`);
    tags.push('recurring_item_drift');
  }
  if (parsed.heroSkinToneMatchesCover === false) {
    const notes = (parsed.heroSkinToneNotes || '').trim();
    issues.push(`Hero child's skin tone drifts from the cover${notes ? `: ${notes}` : ''}`);
    tags.push('hero_skin_drift');
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
  if (parsed.fullBodyParentSkinMismatch === true) {
    const notes = (parsed.fullBodyParentSkinNotes || '').trim();
    issues.push(`Visible full-body adult skin tone does not match the hero child on the cover${notes ? `: ${notes}` : ''}`);
    tags.push('full_body_parent_skin_mismatch');
  }
  if (parsed.tooManyHands === true) {
    const notes = (parsed.tooManyHandsNotes || '').trim();
    issues.push(`A character has more than two hands${notes ? `: ${notes}` : ''}`);
    tags.push('extra_limbs');
  }
  if (parsed.objectIntegrityOk === false) {
    const notes = (parsed.objectIntegrityNotes || '').trim();
    issues.push(`A prominent object is structurally broken${notes ? `: ${notes}` : ''}`);
    tags.push('object_integrity');
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

  // New caregiver-lock-driven tags. Each surfaces a surgical BAD/FIX repair
  // instruction that the orchestrator threads forward to the illustrator on
  // the next attempt so the model gets concrete guidance instead of generic
  // tag-derived correction text.
  const repairInstructions = [];
  if (parsed.caregiverShadowSubstitution === true) {
    const notes = (parsed.caregiverShadowSubstitutionNotes || '').trim();
    issues.push(`Caregiver body replaced by a flat cast shadow on a surface${notes ? `: ${notes}` : ''}`);
    tags.push('caregiver_shadow_substitution');
    const repair = (parsed.caregiverShadowSubstitutionRepair || '').trim();
    if (repair) repairInstructions.push(repair);
  }
  if (parsed.caregiverSkinDrift === true) {
    const notes = (parsed.caregiverSkinDriftNotes || '').trim();
    issues.push(`Caregiver skin family drifted vs cover render / caregiver lock${notes ? `: ${notes}` : ''}`);
    tags.push('caregiver_skin_drift');
    const repair = (parsed.caregiverSkinDriftRepair || '').trim();
    if (repair) repairInstructions.push(repair);
  }
  if (parsed.phantomArms === true) {
    const notes = (parsed.phantomArmsNotes || '').trim();
    issues.push(`Phantom / duplicate caregiver arms with no second torso to anchor them${notes ? `: ${notes}` : ''}`);
    tags.push('phantom_arms');
    const repair = (parsed.phantomArmsRepair || '').trim();
    if (repair) repairInstructions.push(repair);
  }
  if (parsed.caregiverBodyDuplicated === true) {
    const notes = (parsed.caregiverBodyDuplicatedNotes || '').trim();
    issues.push(`Caregiver body duplicated — two distinct adult bodies rendered for what should be ONE caregiver${notes ? `: ${notes}` : ''}`);
    tags.push('caregiver_body_duplicated');
    const repair = (parsed.caregiverBodyDuplicatedRepair || '').trim();
    if (repair) repairInstructions.push(repair);
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
    repairInstructions,
  };
}

module.exports = { checkSpreadConsistency, evaluateConsistencyResult };
