/**
 * Cover composition detector.
 *
 * Runs Gemini Vision on the approved cover image and asks "are there any
 * non-child characters here?". Writes the verdict to:
 *   - doc.brief.coverParentPresent     (boolean) — true iff the themed
 *                                       parent (woman for mothers_day, man
 *                                       for fathers_day) is visible on the
 *                                       cover. Drives the implied-vs-full
 *                                       parent rendering policy in
 *                                       systemInstruction.js + the
 *                                       hasSecondaryOnCover gate in
 *                                       consistencyQa.js.
 *   - doc.brief.additionalCoverCharacters (string|null) — the raw vision
 *                                       output describing non-child cover
 *                                       characters (used downstream by
 *                                       supportingCast lock building).
 *
 * The new bookPipeline previously skipped this detection (the legacy
 * detector at server.js:1448-1517 was disabled at server.js:1443: "Skipping
 * legacy cover vision analysis (new pipeline handled cast policy)") and
 * fell back to a hardcoded `mothers_day → true` default. That default is
 * wrong any time the customer chose a child-only cover variant, and it
 * silently disables the off-cover-parent enforcement path. This stage
 * restores the authoritative source of truth.
 *
 * The vision prompt and parsing logic are ported verbatim from the legacy
 * detector — battle-tested, including the depiction-only carve-out that
 * stops stick-figure / hand-drawn "Mom" representations from being treated
 * as a real cover character.
 */

const sharp = require('sharp');

const { downloadBuffer } = require('../../gcsStorage');
const { getNextApiKey } = require('../../illustrationGenerator');
const { appendLlmCall, withStageResult } = require('../schema/bookDocument');
const { synthesizeCaregiverLockFallback } = require('./caregiverLockFallback');

const PARENT_THEMES = new Set(['mothers_day', 'fathers_day', 'grandparents_day']);

const VISION_MODEL = 'gemini-2.5-flash';
const VISION_TIMEOUT_MS = 30_000;

// AA-CW-5a — promoted from plain-text + 3 regexes (HAS_WOMAN_REGEX,
// HAS_MAN_REGEX, DEPICTION_REGEX) to a single jsonMode vision call. The
// LLM now decides categorically whether each cover-character signal is
// present; we just read fields. This eliminates three regex dependencies
// from the planner pipeline (per refactor manifesto: "only LLM calls")
// and removes a real bug source: the prior regex match on the phrase
// "adult woman" would mis-fire on captions like "as an adult, woman of
// the house" written by the vision model in unstructured prose. The
// jsonMode response is structurally guaranteed and has no parsing layer
// downstream.
const VISION_PROMPT = `Look at this children's book cover. The main character is a young child. Decide whether any OTHER characters are present, and classify them.

Return STRICT JSON (no markdown, no commentary) with this exact schema:

{
  "hasNonChildCharacter": <true if any character besides the main child is visible on the cover; false otherwise>,
  "hasAdultWoman": <true if at least ONE adult female (18+, including elderly) is clearly visible as a real character in the scene; false otherwise>,
  "hasAdultMan": <true if at least ONE adult male (18+, including elderly) is clearly visible as a real character in the scene; false otherwise>,
  "isDepictionOnly": <true if the only non-child characters on the cover are stick figures, scribbles, hand-drawings, doodles, sketches, crayon drawings, or paintings of people INSIDE the cover render (i.e. a child's drawing of Mom on the wall, not Mom herself); false if any non-child character is rendered as a real person in the scene>,
  "characters": [
    {
      "role": "<short label, e.g. 'mother', 'grandmother', 'elderly woman', 'adult man', 'teen boy', 'sibling girl'>",
      "gender": "<one of: woman | man | boy | girl | unclear>",
      "ageGroup": "<one of: adult | teen | child | elderly>",
      "appearance": "<short description: hair, skin, clothing, distinguishing features>"
    }
  ],
  "rawDescription": "<one short paragraph describing the non-child characters in plain prose; empty string if none>"
}

Rules:
- "woman" / "man" must be ADULTS (18+, including elderly). Teens and children do NOT count as adult woman / adult man.
- A stick-figure or hand-drawn "Mom" rendered on a wall, page, or surface inside the cover is NOT a real character — set isDepictionOnly true and leave hasAdultWoman/hasAdultMan false unless there is ALSO a real adult character.
- If the main child is the only character, return: { "hasNonChildCharacter": false, "hasAdultWoman": false, "hasAdultMan": false, "isDepictionOnly": false, "characters": [], "rawDescription": "" }.

Return ONLY the JSON object.`;

// Second vision call — runs only when the first call detected an adult on
// the cover (themed parent: woman for mothers_day, man for fathers_day,
// either for grandparents_day). Extracts a structured visual lock for that
// adult so interior spreads have the SAME identity to render and the spread
// QA call has the SAME identity to compare against. Returns strict JSON.
// This closes the bug class "Mama renders as a flat shadow on the wall" /
// "caregiver skin tone drifts darker than the child" — the renderer now has
// the cover-derived caregiver appearance and the QA pass has it as the
// ground-truth comparison target.
const CAREGIVER_VISION_PROMPT = `Look at this children's book cover. There is the hero child AND at least one adult caregiver (mother, father, grandparent, or similar). Describe the **caregiver** with a structured visual lock so a different illustration model can render the SAME caregiver on interior spreads.

Return STRICT JSON (no markdown, no commentary) with this exact schema:

{
  "present": <true if a caregiver adult is clearly visible on the cover; false otherwise>,
  "role": "<one of: mother | father | grandmother | grandfather | other_adult | unclear>",
  "skinTone": "<concrete visual description, e.g. 'fair / peachy with cool undertone', 'medium-tan with warm olive undertone', 'deep brown with neutral undertone'. Compare against the child: state whether the caregiver's skin reads SAME family as the child, slightly LIGHTER, or slightly DARKER. Be specific — this descriptor will be used as the LOCK across every interior spread.>",
  "skinFamilyVsChild": "<one of: same | lighter | darker | unclear>",
  "hair": "<short — color family + length + style, e.g. 'medium-brown, shoulder-length, loose waves, side-parted'>",
  "outfit": "<short — top + bottom + signature accessory, e.g. 'cream cable-knit cardigan over a plain white tee, jeans, plain gold band on left ring finger'>",
  "build": "<short — body build / age impression, e.g. 'slim, late 20s to early 30s'>",
  "face": "<short — distinguishing facial features, e.g. 'soft round cheeks, warm smile, no glasses, no visible makeup'>"
}

If no caregiver adult is on the cover, return: {"present": false, "role": "unclear", "skinTone": "", "skinFamilyVsChild": "unclear", "hair": "", "outfit": "", "build": "", "face": ""}.

Return ONLY the JSON object.`;

// AA-CW-5a — DEPICTION_REGEX, HAS_WOMAN_REGEX, HAS_MAN_REGEX deleted. The
// vision call now returns structured JSON with explicit fields; no regex
// is used to parse the response. See VISION_PROMPT above.

/**
 * Resolve the approved cover to a base64 JPEG suitable for the Vision call.
 * Mirrors `resolveCoverBase64` in renderAllSpreads.js but kept local so the
 * planner stage doesn't depend on the illustrator package layout.
 *
 * @param {object} cover
 * @returns {Promise<{ base64: string, mime: string }>}
 */
async function resolveCoverForVision(cover) {
  if (cover.imageBase64) {
    return { base64: cover.imageBase64, mime: cover.coverMime || 'image/jpeg' };
  }
  const storageKey = cover.imageStorageKey || cover.gcsPath;
  let buf;
  if (storageKey) {
    buf = await downloadBuffer(storageKey);
  } else if (cover.imageUrl) {
    buf = await downloadBuffer(cover.imageUrl);
  } else {
    throw new Error('cover missing imageBase64, imageUrl, and imageStorageKey/gcsPath');
  }
  // 1024px is enough for the vision model to identify adults and skin tone
  // — same resize the illustrator pre-pass uses so we get consistent
  // detection vs. what the illustrator session is anchored on.
  const resized = await sharp(buf)
    .resize({ width: 1024, withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  return { base64: resized.toString('base64'), mime: 'image/jpeg' };
}

/**
 * Second vision call — caregiver visual lock extraction. Runs only when the
 * first call already concluded a caregiver is on the cover. Uses jsonMode
 * (responseMimeType: application/json) so the parse is robust without regex.
 *
 * @param {string} imageBase64
 * @param {string} mime
 * @param {AbortSignal} [signal]
 * @returns {Promise<object|null>} Parsed JSON object on success, null on any failure.
 */
async function callCaregiverVision(imageBase64, mime, signal) {
  const apiKey = getNextApiKey() || process.env.GOOGLE_AI_STUDIO_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const controller = signal ? null : new AbortController();
  const timeoutId = controller ? setTimeout(() => controller.abort(), VISION_TIMEOUT_MS) : null;
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: CAREGIVER_VISION_PROMPT },
              { inline_data: { mime_type: mime, data: imageBase64 } },
            ],
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: 600,
            temperature: 0.1,
          },
        }),
        signal: signal || controller?.signal,
      },
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    if (!rawText) return null;
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && typeof parsed === 'object' && parsed.present === true) return parsed;
      return null;
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Run Gemini Vision on the approved cover and return parsed verdict.
 *
 * @param {string} imageBase64
 * @param {string} mime
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ rawText: string|null, parsed: object|null, additionalCoverCharacters: string|null, hasWoman: boolean, hasMan: boolean, isDepictionOnly: boolean }>}
 */
async function callVision(imageBase64, mime, signal) {
  const apiKey = getNextApiKey() || process.env.GOOGLE_AI_STUDIO_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('no Gemini API key available');
  const controller = signal ? null : new AbortController();
  const timeoutId = controller ? setTimeout(() => controller.abort(), VISION_TIMEOUT_MS) : null;
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: VISION_PROMPT },
              { inline_data: { mime_type: mime, data: imageBase64 } },
            ],
          }],
          // AA-CW-5a — jsonMode (responseMimeType: application/json) so the
          // response is structurally valid JSON and we never have to regex
          // over free-form prose. Mirrors the existing CAREGIVER_VISION_PROMPT
          // call further below.
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: 800,
            temperature: 0.1,
          },
        }),
        signal: signal || controller?.signal,
      },
    );
    if (!resp.ok) {
      throw new Error(`vision HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
    const data = await resp.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    if (!rawText) {
      return { rawText: null, parsed: null, additionalCoverCharacters: null, hasWoman: false, hasMan: false, isDepictionOnly: false };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // Malformed JSON despite jsonMode is rare but possible. Treat as a
      // safe "no detection" rather than throwing — coverParentPresent will
      // fall back to false, which is the safe direction (implied parent
      // rendering is recoverable; phantom full-Mom is not).
      return { rawText, parsed: null, additionalCoverCharacters: null, hasWoman: false, hasMan: false, isDepictionOnly: false };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { rawText, parsed: null, additionalCoverCharacters: null, hasWoman: false, hasMan: false, isDepictionOnly: false };
    }
    const isDepictionOnly = parsed.isDepictionOnly === true;
    // When the only non-child content is a depiction (drawing/scribble), we
    // treat the cover as child-only for caregiver-lock purposes — locking
    // QA against a stick-figure Mom is the bug class the legacy regex was
    // protecting against, and the jsonMode field carries that signal
    // explicitly now.
    if (isDepictionOnly) {
      return { rawText, parsed, additionalCoverCharacters: null, hasWoman: false, hasMan: false, isDepictionOnly: true };
    }
    const hasWoman = parsed.hasAdultWoman === true;
    const hasMan = parsed.hasAdultMan === true;
    const description = typeof parsed.rawDescription === 'string' ? parsed.rawDescription.trim() : '';
    const additionalCoverCharacters = parsed.hasNonChildCharacter === true && description
      ? description
      : null;
    return { rawText, parsed, additionalCoverCharacters, hasWoman, hasMan, isDepictionOnly: false };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Pipeline stage: detect whether the themed parent is on the approved cover
 * and persist the verdict on `doc.brief`. Safe to run for non-parent themes
 * — it still records `additionalCoverCharacters` (used downstream for
 * sibling/grandparent locks) and leaves coverParentPresent at its existing
 * value.
 *
 * Failure mode: any error (download failure, vision API failure, malformed
 * response) falls back to `coverParentPresent: false` for parent themes and
 * `additionalCoverCharacters: null`. This is the SAFE failure direction —
 * implied parent rendering is recoverable; phantom full-Mom is not.
 *
 * @param {object} doc
 * @returns {Promise<object>}
 */
async function detectCoverComposition(doc) {
  const theme = doc?.request?.theme || '';
  const isParentTheme = PARENT_THEMES.has(String(theme).toLowerCase());
  const cover = doc.cover || {};
  const explicitCallerValue = typeof doc?.brief?.coverParentPresent === 'boolean'
    ? doc.brief.coverParentPresent
    : null;

  let detection = null;
  let detectionError = null;
  let coverImage = null;
  try {
    coverImage = await resolveCoverForVision(cover);
    detection = await callVision(coverImage.base64, coverImage.mime, doc?.operationalContext?.abortSignal);
  } catch (err) {
    detectionError = err.message || String(err);
  }

  // Decide coverParentPresent.
  // Precedence (high → low):
  //   1. Explicit caller value (passed in /generate-book payload) — wins.
  //      This is the only place where a non-vision override can take effect.
  //      Already captured by normalizeRequest.resolveCoverParentPresent and
  //      copied to brief.coverParentPresent before this stage runs.
  //   2. Vision verdict (this stage), with Phase 3d double-check on
  //      vision-says-YES for parent themes (see below).
  //   3. Safe fallback: false.
  let coverParentPresent;
  let visionDisagreement = null;
  if (explicitCallerValue !== null) {
    coverParentPresent = explicitCallerValue;
  } else if (detection && !detectionError) {
    let raw;
    if (theme === 'mothers_day') raw = detection.hasWoman;
    else if (theme === 'fathers_day') raw = detection.hasMan;
    else if (theme === 'grandparents_day') raw = detection.hasWoman || detection.hasMan;
    else raw = false;

    // Phase 3d — double-check on vision-says-YES for parent themes. A single
    // false positive cascades into a full-body phantom-Mom in every interior
    // spread, which is the costliest failure mode of the cover-composition
    // call. We re-ask with a tighter prompt; if the two calls disagree, fall
    // back to the SAFE direction (false → implied-only rendering, which is
    // recoverable) and log the disagreement for monitoring.
    if (raw && isParentTheme && coverImage) {
      try {
        const confirmation = await callVision(
          coverImage.base64,
          coverImage.mime,
          doc?.operationalContext?.abortSignal,
        );
        let confirmRaw;
        if (theme === 'mothers_day') confirmRaw = confirmation.hasWoman;
        else if (theme === 'fathers_day') confirmRaw = confirmation.hasMan;
        else if (theme === 'grandparents_day') confirmRaw = confirmation.hasWoman || confirmation.hasMan;
        else confirmRaw = false;

        if (confirmRaw === raw) {
          coverParentPresent = raw;
        } else {
          visionDisagreement = { firstCall: raw, secondCall: confirmRaw, theme };
          console.warn(
            `[detectCoverComposition] vision double-check DISAGREED theme=${theme} ` +
            `firstCall=${raw} secondCall=${confirmRaw} — falling back to safe direction (false). ` +
            `Phantom-parent risk in interiors > implied-rendering risk; pick the recoverable side.`,
          );
          coverParentPresent = false;
        }
      } catch (err) {
        // Confirmation call failed — keep the first call's verdict. We don't
        // want a flaky second vision API to silently flip a real cover.
        console.warn(`[detectCoverComposition] confirmation call failed: ${err?.message || 'unknown'} — using first-call verdict`);
        coverParentPresent = raw;
      }
    } else {
      coverParentPresent = raw;
    }
  } else {
    coverParentPresent = false;
  }

  const additionalCoverCharacters = detection?.additionalCoverCharacters || null;

  // Second vision call — extract a structured caregiver visual lock when a
  // caregiver IS on the cover. This is the source of truth for caregiver
  // skin tone, hair, outfit on every interior spread + the QA comparison
  // target on every retry. Without this, the renderer extrapolates
  // caregiver appearance from text-only descriptions and frequently drifts
  // (Mama-as-shadow on the wall, caregiver skin two shades darker than the
  // child, outfit lineage breaking between spreads).
  let coverCaregiverAppearance = null;
  if (coverParentPresent && coverImage) {
    coverCaregiverAppearance = await callCaregiverVision(
      coverImage.base64,
      coverImage.mime,
      doc?.operationalContext?.abortSignal,
    );
  }

  // Phase-X — caregiver-lock fallback. The full chain of caregiver QA tags
  // (caregiver_body_duplicated, phantom_arms, caregiver_skin_drift,
  // caregiver_shadow_substitution) is gated on a non-null `caregiverLock`
  // in services/illustrator/consistencyQa.js (lines 255 + 262). When the
  // second vision call fails (transient HTTP, malformed JSON, model
  // returns present:false on a face it didn't recognize), the lock is null
  // and the QA model NEVER even sees the JSON field definitions for those
  // tags — the entire two-Mama defense vanishes silently. This was the
  // root cause of the "phantom Mom in the stroller" production image.
  if (coverParentPresent && !coverCaregiverAppearance) {
    coverCaregiverAppearance = synthesizeCaregiverLockFallback(theme);
    console.warn(
      `[detectCoverComposition] caregiver-lock synthesized (vision returned null) — ` +
      `role=${coverCaregiverAppearance.role} theme=${String(theme || '').toLowerCase() || 'none'}; ` +
      `QA tags will still fire on duplication / phantom arms / shadow substitution.`,
    );
  }

  // AA-CW-5a — also persist the structured jsonMode payload itself on
  // brief.coverComposition so downstream stages and tests can introspect
  // hasNonChildCharacter, isDepictionOnly, characters[] without having to
  // re-derive from the flat flags. The flat flags (coverParentPresent,
  // additionalCoverCharacters, coverCaregiverAppearance) remain for
  // back-compat with stages that already read them.
  const coverComposition = detection?.parsed && !detectionError
    ? {
      hasNonChildCharacter: detection.parsed.hasNonChildCharacter === true,
      hasAdultWoman: detection.parsed.hasAdultWoman === true,
      hasAdultMan: detection.parsed.hasAdultMan === true,
      isDepictionOnly: detection.parsed.isDepictionOnly === true,
      characters: Array.isArray(detection.parsed.characters) ? detection.parsed.characters : [],
      rawDescription: typeof detection.parsed.rawDescription === 'string' ? detection.parsed.rawDescription : '',
    }
    : null;

  // Trace the call so it shows up in the doc's llmCalls trail.
  const traced = appendLlmCall(doc, {
    stage: 'coverComposition',
    model: VISION_MODEL,
    attempts: 1,
    usage: null,
    metadata: {
      theme,
      isParentTheme,
      explicitCallerValue,
      detectionRawText: detection?.rawText || null,
      isDepictionOnly: detection?.isDepictionOnly || false,
      hasWoman: detection?.hasWoman || false,
      hasMan: detection?.hasMan || false,
      detectionError,
      finalCoverParentPresent: coverParentPresent,
      visionDisagreement,
      coverCaregiverAppearance,
      coverComposition,
    },
  });

  return withStageResult(traced, {
    brief: {
      ...traced.brief,
      coverParentPresent,
      additionalCoverCharacters,
      coverCaregiverAppearance,
      coverComposition,
    },
  });
}

module.exports = { detectCoverComposition };
