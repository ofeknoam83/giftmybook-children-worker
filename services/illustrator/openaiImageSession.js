/**
 * Illustrator — OpenAI Images 2.0 (gpt-image-2) Adapter
 *
 * Presents the SAME function surface as `services/illustrator/session.js`
 * (Gemini chat), so `renderAllSpreads.js` can swap providers by flipping
 * `MODELS.SPREAD_RENDER` in `services/bookPipeline/constants.js`.
 *
 * Why an adapter and not a full rewrite:
 *   Gemini 3.x Flash Image supports a multi-turn chat with persistent image
 *   memory (cover + last N accepted spreads carried in history). The OpenAI
 *   Image API is STATELESS — every call is one HTTP POST that must re-send
 *   whatever reference images the model should see. We emulate the chat
 *   session by:
 *     - storing the cover + last N accepted spreads on the session object
 *     - re-uploading them as `image[]` on every `/v1/images/generations` call
 *     - prepending the full system instruction to the user prompt text
 *     - treating "markSpreadAccepted" as "add to references"
 *
 * Provider dispatch is handled by `services/illustrator/sessionDispatch.js`.
 */

const {
  OPENAI_IMAGE_MODEL,
  OPENAI_IMAGES_GENERATIONS_URL,
  OPENAI_IMAGE_SIZE,
  OPENAI_IMAGE_QUALITY,
  TURN_TIMEOUT_MS,
  SLIDING_WINDOW_ACCEPTED_SPREADS,
} = require('./config');
const { postImagesGenerations } = require('./openaiImagesHttp');
const { buildSystemInstruction } = require('./systemInstruction');

/**
 * @typedef {Object} OpenAIImageSession
 * @property {string} apiKey
 * @property {string} model
 * @property {string} systemInstruction
 * @property {string} coverBase64
 * @property {string} coverMime
 * @property {Array<{index: number, imageBase64: string}>} acceptedSpreads
 * @property {number} turnsUsed
 * @property {number} rebuilds
 * @property {boolean} abandoned
 * @property {AbortSignal|null} abortSignal
 * @property {object} opts
 */

/**
 * Build a new stateless OpenAI image session.
 *
 * Mirrors `services/illustrator/session.createSession` in option shape.
 *
 * @param {object} opts
 * @returns {OpenAIImageSession}
 */
function createSession(opts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing for illustrator session (MODELS.SPREAD_RENDER is gpt-image-2)');

  const systemInstruction = buildSystemInstruction({
    hasParentOnCover: opts.hasParentOnCover,
    hasSecondaryOnCover: opts.hasSecondaryOnCover,
    additionalCoverCharacters: opts.additionalCoverCharacters,
    theme: opts.theme,
    parentOutfit: opts.parentOutfit,
    childAppearance: opts.childAppearance,
    locationPalette: opts.locationPalette,
  });

  return {
    apiKey,
    model: OPENAI_IMAGE_MODEL,
    systemInstruction,
    coverBase64: opts.coverBase64,
    coverMime: opts.coverMime || 'image/jpeg',
    acceptedSpreads: [],
    turnsUsed: 0,
    rebuilds: 0,
    abandoned: false,
    abortSignal: opts.abortSignal || null,
    opts,
  };
}

/**
 * In the Gemini adapter this uses one turn to pin the cover in history and
 * get a TEXT-ONLY acknowledgment. gpt-image-2 is stateless — every spread
 * call re-attaches the cover as IMAGE 1 anyway, so this is a cheap noop that
 * just validates inputs.
 *
 * @param {OpenAIImageSession} session
 */
async function establishCharacterReference(session) {
  if (!session.coverBase64) {
    throw new Error('establishCharacterReference: coverBase64 is required');
  }
  session.turnsUsed = 1;
  console.log('[illustrator/openaiImageSession] Cover anchored (stateless — will be re-sent on every turn)');
}

/**
 * Generate a spread image. Stateless POST to `/v1/images/edits` with the
 * cover + the last N accepted spreads as reference images and the full
 * system instruction prepended to the per-spread prompt.
 *
 * @param {OpenAIImageSession} session
 * @param {string} spreadPromptText
 * @param {number} spreadIndex
 * @returns {Promise<{imageBuffer: Buffer, imageBase64: string}>}
 */
async function generateSpread(session, spreadPromptText, spreadIndex) {
  if (session.abandoned) throw new Error('Session abandoned — cannot generate');
  const result = await _postEdit(session, spreadPromptText, { spreadIndex });
  session.turnsUsed++;
  return result;
}

/**
 * Correction turn for the same spread. gpt-image-2 has no conversational
 * memory, so we bundle the correction note with the original-style prompt
 * text each time. Callers already re-build that combined prompt via
 * `buildCorrectionTurn`, which is fine for the stateless path too.
 *
 * @param {OpenAIImageSession} session
 * @param {string} correctionPromptText
 * @param {number} spreadIndex
 * @param {object} [opts]
 * @param {boolean} [opts.reanchorCover] - Ignored: the cover is re-sent on
 *   every turn with OpenAI Images anyway, so there is no "un-anchored" state.
 * @returns {Promise<{imageBuffer: Buffer, imageBase64: string}>}
 */
async function sendCorrection(session, correctionPromptText, spreadIndex) {
  if (session.abandoned) throw new Error('Session abandoned — cannot correct');
  const result = await _postEdit(session, correctionPromptText, { spreadIndex, isCorrection: true });
  session.turnsUsed++;
  return result;
}

/**
 * Record the accepted image so it travels as a continuity reference on the
 * next spread's call.
 *
 * @param {OpenAIImageSession} session
 * @param {number} spreadIndex
 * @param {string} imageBase64
 */
function markSpreadAccepted(session, spreadIndex, imageBase64) {
  const existing = session.acceptedSpreads.findIndex(s => s.index === spreadIndex);
  if (existing >= 0) {
    session.acceptedSpreads[existing].imageBase64 = imageBase64;
  } else {
    session.acceptedSpreads.push({ index: spreadIndex, imageBase64 });
  }
}

/**
 * Gemini adapter prunes failed exchanges from history. OpenAI is stateless,
 * so there is no history to prune. Kept as a no-op for interface parity.
 */
function pruneLastTurn(_session) {
  // noop — stateless path
}

/**
 * Build a fresh session after a safety block, carrying accepted spreads
 * forward so continuity references survive.
 *
 * @param {OpenAIImageSession} oldSession
 * @returns {Promise<OpenAIImageSession>}
 */
async function rebuildSession(oldSession) {
  const carried = oldSession.acceptedSpreads.slice();
  const newSession = createSession(oldSession.opts);
  newSession.rebuilds = oldSession.rebuilds + 1;
  newSession.acceptedSpreads = carried;
  await establishCharacterReference(newSession);
  oldSession.abandoned = true;
  console.log(
    `[illustrator/openaiImageSession] Rebuilt session (rebuild #${newSession.rebuilds}) — carried ${carried.length} accepted spread(s)`,
  );
  return newSession;
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the combined prompt text posted to gpt-image-2. Prepends the full
 * system instruction (character + style + composition locks) and labels the
 * reference images so the model knows which is the cover and which are
 * previously accepted spreads.
 */
function buildCombinedPrompt({ systemInstruction, userPrompt, continuityCount }) {
  const refGuide = continuityCount > 0
    ? `REFERENCE IMAGES — the request includes ${continuityCount + 1} reference images:\n`
      + '  • Reference 1 is the APPROVED BOOK COVER — this is the canonical rendered likeness of the hero child AND the canonical 3D CGI Pixar feature-film art style. Match both exactly.\n'
      + `  • References 2..${continuityCount + 1} are previously APPROVED interior spreads from this same book. They establish continuity — same character, same outfit family, same rendered style, same location palette where relevant.\n`
      + 'Every new spread must read as the SAME feature-film render as the cover and the accepted spreads. NEVER switch to a 2D painterly, watercolor, or "storybook illustration" look.'
    : 'REFERENCE IMAGE — the request includes 1 reference image:\n'
      + '  • Reference 1 is the APPROVED BOOK COVER — canonical character (face, hair, skin, outfit) AND canonical 3D CGI Pixar feature-film art style. Match both exactly.';

  return [
    '=== SYSTEM INSTRUCTION (non-negotiable rules for every illustration) ===',
    systemInstruction,
    '',
    '=== REFERENCE NOTES ===',
    refGuide,
    '',
    '=== THIS SPREAD ===',
    userPrompt,
    '',
    'Output exactly ONE image for this spread, full-bleed 16:9 landscape, one single continuous scene (no diptych seam). Caption: exact manuscript wording, same book-wide serif + modest readable size + natural blend as system instruction — not large display type.',
  ].join('\n');
}

/**
 * Cover + last N accepted spreads as buffers for `images/edits` `image[]` parts.
 * @returns {{ imageFiles: Array<{ buffer: Buffer, filename: string, mimeType: string }>, continuityCount: number }}
 */
function collectEditImageFiles(session) {
  const coverBuf = Buffer.from(session.coverBase64, 'base64');
  const imageFiles = [
    {
      buffer: coverBuf,
      filename: `cover.${(session.coverMime || 'image/jpeg').includes('png') ? 'png' : 'jpg'}`,
      mimeType: session.coverMime || 'image/jpeg',
    },
  ];
  const tail = [...session.acceptedSpreads]
    .filter(s => s && typeof s.index === 'number' && s.imageBase64)
    .sort((a, b) => a.index - b.index)
    .slice(-SLIDING_WINDOW_ACCEPTED_SPREADS);
  for (const accepted of tail) {
    imageFiles.push({
      buffer: Buffer.from(accepted.imageBase64, 'base64'),
      filename: `spread-${accepted.index + 1}.png`,
      mimeType: 'image/png',
    });
  }
  return { imageFiles, continuityCount: tail.length };
}

async function _postEdit(session, userPrompt, { spreadIndex, isCorrection = false }) {
  const { imageFiles, continuityCount } = collectEditImageFiles(session);
  const combinedPrompt = buildCombinedPrompt({
    systemInstruction: session.systemInstruction,
    userPrompt,
    continuityCount,
  });

  const turnLabel = isCorrection ? 'correction' : 'generate';
  const startMs = Date.now();
  console.log(
    `[illustrator/openaiImageSession] ${turnLabel} spread ${spreadIndex + 1} `
    + `(${continuityCount + 1} reference images, size=${OPENAI_IMAGE_SIZE})...`,
  );

  let result;
  try {
    result = await postImagesGenerations({
      apiKey: session.apiKey,
      url: OPENAI_IMAGES_GENERATIONS_URL,
      model: session.model,
      prompt: combinedPrompt,
      size: OPENAI_IMAGE_SIZE,
      quality: OPENAI_IMAGE_QUALITY,
      imageFiles,
      timeoutMs: TURN_TIMEOUT_MS,
      signal: session.abortSignal,
    });
  } catch (err) {
    throw new Error(`OpenAI image ${turnLabel} network error: ${err.message}`);
  }

  if (!result.ok) {
    const errBody = result.text || '';
    const err = new Error(`OpenAI image API ${result.status}: ${errBody.slice(0, 400)}`);
    if (/moderation_blocked|safety|policy_violation|content_policy/i.test(errBody)) {
      err.isSafetyBlock = true;
      err.isEmptyResponse = true;
    }
    throw err;
  }

  const b64 = result.data?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error('OpenAI image API returned no b64_json payload');
  }
  const elapsedMs = Date.now() - startMs;
  console.log(`[illustrator/openaiImageSession] spread ${spreadIndex + 1} ${turnLabel} complete (${elapsedMs}ms)`);

  const imageBuffer = Buffer.from(b64, 'base64');
  return { imageBuffer, imageBase64: b64 };
}

module.exports = {
  createSession,
  establishCharacterReference,
  generateSpread,
  sendCorrection,
  markSpreadAccepted,
  pruneLastTurn,
  rebuildSession,
};
