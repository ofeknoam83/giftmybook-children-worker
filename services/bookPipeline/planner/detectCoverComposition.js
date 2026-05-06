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

const PARENT_THEMES = new Set(['mothers_day', 'fathers_day', 'grandparents_day']);

const VISION_MODEL = 'gemini-2.5-flash';
const VISION_TIMEOUT_MS = 30_000;

const VISION_PROMPT = `Look at this children's book cover. Are there any characters visible BESIDES the main child?

If yes, for EACH non-child character, write ONE line in this exact format:
- [relationship if apparent, e.g. grandmother/elderly woman/adult man/teen boy]: gender=[woman|man|boy|girl|unclear]; age=[adult|teen|child|elderly]; [brief appearance — hair, skin, clothing, distinguishing features]

Rules for gender:
- "woman" = adult female (any age 18+, including elderly).
- "man" = adult male (any age 18+, including elderly).
- "boy"/"girl" = a child or young teen.
- "unclear" = genuinely ambiguous (back view, heavily obscured, androgynous).

If the main child is the ONLY character, respond with exactly: NONE`;

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

// Stick-figure / hand-drawn representations of Mom inside the cover render
// are NOT a usable photoreal cover reference; locking QA to them causes
// endless cover_secondary_mismatch. Treat as no secondary.
const DEPICTION_REGEX = /\b(stick\s*-?\s*figure|scribble|doodle|(?:hand[- ]?)?drawing|drawn|sketched?|crayon|(?:marker|paint(?:ing|ed)?)\s+(?:of|drawing|on)|\bdrawing[:\s]|illustration of|cartoon character on|kid'?s drawing)\b/i;

const HAS_WOMAN_REGEX = /gender\s*=\s*woman\b|\badult\s+(?:woman|female)\b/i;
const HAS_MAN_REGEX = /gender\s*=\s*man\b|\badult\s+(?:man|male)\b/i;

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
 * @returns {Promise<{ rawText: string|null, additionalCoverCharacters: string|null, hasWoman: boolean, hasMan: boolean, isDepictionOnly: boolean }>}
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
          generationConfig: { maxOutputTokens: 500, temperature: 0.2 },
        }),
        signal: signal || controller?.signal,
      },
    );
    if (!resp.ok) {
      throw new Error(`vision HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
    const data = await resp.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    const isNone = !rawText || /^none[.!]?$/i.test(rawText.trim()) || rawText.trim().length <= 5;
    if (isNone) {
      return { rawText, additionalCoverCharacters: null, hasWoman: false, hasMan: false, isDepictionOnly: false };
    }
    const isDepictionOnly = DEPICTION_REGEX.test(rawText);
    if (isDepictionOnly) {
      return { rawText, additionalCoverCharacters: null, hasWoman: false, hasMan: false, isDepictionOnly: true };
    }
    return {
      rawText,
      additionalCoverCharacters: rawText,
      hasWoman: HAS_WOMAN_REGEX.test(rawText),
      hasMan: HAS_MAN_REGEX.test(rawText),
      isDepictionOnly: false,
    };
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
  //   2. Vision verdict (this stage).
  //   3. Safe fallback: false.
  let coverParentPresent;
  if (explicitCallerValue !== null) {
    coverParentPresent = explicitCallerValue;
  } else if (detection && !detectionError) {
    if (theme === 'mothers_day') coverParentPresent = detection.hasWoman;
    else if (theme === 'fathers_day') coverParentPresent = detection.hasMan;
    else if (theme === 'grandparents_day') coverParentPresent = detection.hasWoman || detection.hasMan;
    else coverParentPresent = false;
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
      coverCaregiverAppearance,
    },
  });

  return withStageResult(traced, {
    brief: {
      ...traced.brief,
      coverParentPresent,
      additionalCoverCharacters,
      coverCaregiverAppearance,
    },
  });
}

module.exports = { detectCoverComposition };
