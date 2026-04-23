/**
 * Illustrator — Gemini Chat Session Wrapper (lean)
 *
 * A single persistent chat session carries style + character continuity across
 * all 13 spreads. The session holds:
 *   - system instruction (frozen, built once)
 *   - pinned BOOK COVER as the character + style ground truth
 *   - sliding window of the last N ACCEPTED spreads (accepted = passed QA)
 *
 * Design rules (why this is much simpler than the old engine):
 *   1. Only ACCEPTED spreads enter the history sliding window. Failed
 *      (safety-blocked, QA-rejected, empty) exchanges are pruned immediately
 *      so history never gets poisoned by a bad image or a flagged turn.
 *   2. At most ONE session rebuild per book on safety blocks. A rebuild
 *      re-establishes character from the cover and carries forward the already-
 *      accepted spreads so continuity survives.
 *   3. No proxy fallback, no safety rewrite, no thumbnail selection gymnastics
 *      — if corrections + one rebuild can't get a spread through, the book
 *      fails fast.
 */

const {
  GEMINI_IMAGE_MODEL,
  CHAT_API_BASE,
  TURN_TIMEOUT_MS,
  ESTABLISHMENT_TIMEOUT_MS,
  SLIDING_WINDOW_ACCEPTED_SPREADS,
  GEMINI_IMAGE_MAX_OUTPUT_TOKENS,
} = require('./config');
const { fetchWithTimeout } = require('../illustrationGenerator');
const { buildSystemInstruction } = require('./systemInstruction');
const { sanitizeForGemini, sanitizeHistory } = require('../promptSanitizer');

// Gemini finishReason values that mean the response was suppressed by a safety
// or policy filter rather than a transient glitch. These should trigger a
// session rebuild (once) rather than more in-session retries.
//
// Note: `IMAGE_OTHER` (and empty `content.parts`) is *not* in this set — the API
// can return it for capacity/transient model issues. `renderAllSpreads` retries
// those as transient before failing the book.
const SAFETY_FINISH_REASONS = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'RECITATION',
  'BLOCKLIST',
  'SPII',
  'BLOCKED',
]);

let _sessionKeyRound = 0;

/**
 * Picks a Gemini API key with deterministic round-robin across the key pool
 * (per new session) so different books spread load; avoids retrying the same
 * key after safety blocks.
 */
function pickSessionApiKey() {
  const keys = [];
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  if (keys.length === 0) {
    const single = process.env.GOOGLE_AI_STUDIO_KEY || process.env.GEMINI_API_KEY || '';
    if (single) keys.push(single);
  }
  if (keys.length === 0) return '';
  const idx = _sessionKeyRound % keys.length;
  _sessionKeyRound += 1;
  return keys[idx];
}

/**
 * @typedef {Object} AcceptedSpread
 * @property {number} index - 0-based spread index
 * @property {string} imageBase64 - Approved image base64 (for sliding window)
 * @property {Array<object>} [modelParts] - Full model `parts` array from the turn
 *   that produced this accepted image. Carries `thoughtSignature` fields that
 *   Gemini 3.x requires when model-generated parts are replayed as history.
 *   Absent for checkpoint-resume seeds (GCS images have no signature) — in
 *   that case seedHistoryFromAccepted falls back to a text-only reference.
 */

/**
 * @typedef {Object} IllustratorSession
 * @property {string} apiKey
 * @property {string} model
 * @property {string} systemInstruction
 * @property {Array<{role: string, parts: any[]}>} history - Alternating user/model turns. Only accepted exchanges are kept.
 * @property {string} coverBase64
 * @property {string} coverMime
 * @property {AcceptedSpread[]} acceptedSpreads - All accepted spreads in book order (not just the sliding window).
 * @property {number} turnsUsed
 * @property {number} rebuilds
 * @property {boolean} abandoned
 * @property {AbortSignal|null} abortSignal
 * @property {object} opts - Original options (preserved for rebuild)
 */

/**
 * Create a new illustration chat session.
 *
 * @param {object} opts
 * @param {string} opts.coverBase64 - Approved cover image as base64 (character + style ground truth).
 * @param {string} [opts.coverMime='image/jpeg']
 * @param {boolean} [opts.hasParentOnCover] - True if the themed parent appears on the cover (same as server coverParentPresent).
 * @param {boolean} [opts.hasSecondaryOnCover] - True if any non-hero person appears on the cover.
 * @param {string} [opts.additionalCoverCharacters]
 * @param {string} [opts.theme]
 * @param {string} [opts.parentOutfit]
 * @param {string} [opts.childAppearance]
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {IllustratorSession}
 */
function createSession(opts) {
  const apiKey = pickSessionApiKey();
  if (!apiKey) throw new Error('No Gemini API key available for illustrator session');

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
    model: GEMINI_IMAGE_MODEL,
    systemInstruction,
    history: [],
    coverBase64: opts.coverBase64,
    coverMime: opts.coverMime || 'image/jpeg',
    acceptedSpreads: [],
    turnsUsed: 0,
    rebuilds: 0,
    abandoned: false,
    abortSignal: opts.abortSignal || null,
    opts, // preserved for rebuildSession
  };
}

/**
 * First turn: send the cover image, ask for a TEXT-ONLY acknowledgment.
 * Establishes the canonical character + style reference in the session history.
 *
 * @param {IllustratorSession} session
 * @returns {Promise<void>}
 */
async function establishCharacterReference(session) {
  if (!session.coverBase64) {
    throw new Error('establishCharacterReference: coverBase64 is required');
  }

  const parts = [
    {
      text: [
        'BOOK COVER — CHARACTER + STYLE GROUND TRUTH.',
        'This is the approved rendered likeness of the hero child. It is a 3D CGI Pixar-film render — NOT a 2D illustration, NOT a painted children\'s-book illustration, NOT a photograph, NOT live-action.',
        'Use it as the canonical reference for BOTH the character (face shape, skin tone, hair, outfit) AND the art style (3D CGI Pixar-film render).',
        'Every interior spread must read as the SAME feature-film render as this cover:',
        '  - photoreal 3D CGI with subsurface skin scattering, individually rendered hair strands, physically based materials, ray-traced volumetric lighting, and real optical depth-of-field.',
        '  - FORBIDDEN styles for interior spreads (hard fail): 2D flat illustration, painterly soft storybook illustration, watercolor, gouache, pencil, ink-and-wash, cel-shaded anime, paper cutout, pixel art, digital painting, or any "drawn" look.',
        '  - If the cover reads as a Pixar film frame, every interior spread reads as a Pixar film frame.',
        'Every interior spread is also ONE continuous wide panorama (16:9) — never two illustrations stitched side-by-side.',
      ].join('\n'),
    },
    {
      inline_data: { mimeType: session.coverMime, data: session.coverBase64 },
    },
    {
      text: 'Study this reference carefully. Acknowledge with TEXT ONLY — do NOT generate an image yet. Confirm you have the character AND the 3D CGI Pixar-film style locked in (not a 2D illustration style).',
    },
  ];

  const response = await _sendTurn(session, parts, {
    textOnly: true,
    timeout: ESTABLISHMENT_TIMEOUT_MS,
  });

  const ackText = response?.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';
  console.log(`[illustrator/session] Character established. Ack: "${ackText.slice(0, 120)}"`);
  session.turnsUsed = 1;
}

/**
 * Generate a spread within the chat session. Does NOT automatically mark the
 * spread as accepted — the caller (index.js) accepts after QA passes.
 *
 * History is trimmed BEFORE the turn so the sliding window is honored.
 *
 * @param {IllustratorSession} session
 * @param {string} spreadPromptText - From prompt.js buildSpreadTurn()
 * @param {number} spreadIndex - 0-based
 * @returns {Promise<{imageBuffer: Buffer, imageBase64: string}>}
 */
async function generateSpread(session, spreadPromptText, spreadIndex) {
  if (session.abandoned) throw new Error('Session abandoned — cannot generate');

  _trimHistoryToSlidingWindow(session);
  const parts = [{ text: spreadPromptText }];

  const response = await _sendTurn(session, parts, { aspectRatio: '16:9' });
  session.turnsUsed++;

  try {
    return _extractImage(response, spreadIndex);
  } catch (err) {
    // Remove the failed exchange from history so we don't poison future turns.
    if (!response?.__historyAlreadyCleaned) _removeLastExchange(session);
    throw err;
  }
}

/**
 * Send an in-session correction turn (same spread, fix specific QA issues).
 * The caller builds the correction prompt via prompt.js buildCorrectionTurn.
 *
 * @param {IllustratorSession} session
 * @param {string} correctionPromptText
 * @param {number} spreadIndex
 * @param {object} [opts]
 * @param {boolean} [opts.reanchorCover] - If true, re-attach the pinned cover
 *   image as a live reference in this correction turn. Use when the previous
 *   attempt drifted on hero identity or outfit — the cover image is the only
 *   reliable anchor and sending it fresh on the rejecting turn dramatically
 *   improves match rates. Safe to call every correction turn, but we keep it
 *   optional so we don't inflate token spend when the reject was unrelated.
 * @returns {Promise<{imageBuffer: Buffer, imageBase64: string}>}
 */
async function sendCorrection(session, correctionPromptText, spreadIndex, opts = {}) {
  if (session.abandoned) throw new Error('Session abandoned — cannot correct');

  _trimHistoryToSlidingWindow(session);

  const parts = [];
  if (opts.reanchorCover && session.coverBase64) {
    parts.push({
      text: 'RE-ANCHOR — the approved BOOK COVER below is the canonical rendering of the hero child. Match it exactly: face shape, skin tone, hair color and texture, eye color, and outfit family. Do NOT invent a different child.',
    });
    parts.push({
      inline_data: { mimeType: session.coverMime, data: session.coverBase64 },
    });
  }
  parts.push({ text: correctionPromptText });

  const response = await _sendTurn(session, parts, { aspectRatio: '16:9' });
  session.turnsUsed++;

  try {
    return _extractImage(response, spreadIndex);
  } catch (err) {
    if (!response?.__historyAlreadyCleaned) _removeLastExchange(session);
    throw err;
  }
}

/**
 * Mark a spread as accepted. The last exchange in history (which produced this
 * spread's accepted image) stays. acceptedSpreads grows by one.
 *
 * The last model message's full `parts` array is snapshotted onto the record so
 * `thoughtSignature` fields are preserved. Without this, a subsequent session
 * rebuild that re-seeds accepted images will 400 with
 * "Image part is missing a thought_signature" from Gemini 3.x.
 *
 * @param {IllustratorSession} session
 * @param {number} spreadIndex
 * @param {string} imageBase64
 */
function markSpreadAccepted(session, spreadIndex, imageBase64) {
  const lastModel = [...session.history].reverse().find(m => m.role === 'model');
  const lastModelHasImage = lastModel?.parts?.some(p => {
    const inline = p.inlineData || p.inline_data;
    return inline && inline.data === imageBase64;
  });
  const modelParts = lastModelHasImage ? lastModel.parts : undefined;

  const existing = session.acceptedSpreads.findIndex(s => s.index === spreadIndex);
  if (existing >= 0) {
    session.acceptedSpreads[existing].imageBase64 = imageBase64;
    if (modelParts) session.acceptedSpreads[existing].modelParts = modelParts;
  } else {
    const entry = { index: spreadIndex, imageBase64 };
    if (modelParts) entry.modelParts = modelParts;
    session.acceptedSpreads.push(entry);
  }
}

/**
 * Rebuild the session from scratch after a persistent safety block. A fresh
 * API key + clean history + re-established character from the cover usually
 * clears the block. Previously accepted spreads are carried forward AND seeded
 * into the new session's history (last SLIDING_WINDOW_ACCEPTED_SPREADS) so the
 * sliding window survives the rebuild and continuity is preserved.
 *
 * Caller should replace its session reference with the returned session.
 *
 * @param {IllustratorSession} oldSession
 * @returns {Promise<IllustratorSession>}
 */
async function rebuildSession(oldSession) {
  const carriedAccepted = oldSession.acceptedSpreads.slice();
  const newSession = createSession(oldSession.opts);
  newSession.rebuilds = oldSession.rebuilds + 1;
  await establishCharacterReference(newSession);
  newSession.acceptedSpreads = carriedAccepted;
  seedHistoryFromAccepted(newSession, carriedAccepted);
  oldSession.abandoned = true;
  console.log(
    `[illustrator/session] Rebuilt session (rebuild #${newSession.rebuilds}) — carried forward ${carriedAccepted.length} accepted spread(s)`,
  );
  return newSession;
}

/**
 * Seed a fresh session's history with previously accepted spread images so the
 * sliding window has real continuity references. Used for:
 *   - Session rebuilds (carry accepted spreads across the rebuild).
 *   - Checkpoint resume (inject already-approved spreads from GCS).
 *
 * Only the last SLIDING_WINDOW_ACCEPTED_SPREADS spreads are seeded — matches
 * what _trimHistoryToSlidingWindow would keep after trimming anyway.
 *
 * Each seeded spread becomes one user+model exchange:
 *   - user: a short text message tagging which spread it was
 *   - model: the accepted image as inline_data
 *
 * @param {IllustratorSession} session
 * @param {AcceptedSpread[]} acceptedSpreads - Spreads with imageBase64.
 */
function seedHistoryFromAccepted(session, acceptedSpreads) {
  if (!Array.isArray(acceptedSpreads) || acceptedSpreads.length === 0) return;
  const sorted = acceptedSpreads
    .filter(s => s && typeof s.index === 'number' && s.imageBase64)
    .sort((a, b) => a.index - b.index);
  const tail = sorted.slice(-SLIDING_WINDOW_ACCEPTED_SPREADS);

  let seededWithImage = 0;
  let seededTextOnly = 0;
  for (const accepted of tail) {
    session.history.push({
      role: 'user',
      parts: [{ text: `[Context: spread ${accepted.index + 1} (accepted reference for continuity).]` }],
    });

    // Replay the exact model parts (carrying thoughtSignature) if we have them.
    // Otherwise fall back to a text-only acknowledgment — replaying an image
    // part without its signature triggers a hard 400 on Gemini 3.x.
    if (Array.isArray(accepted.modelParts) && accepted.modelParts.length > 0) {
      session.history.push({ role: 'model', parts: accepted.modelParts });
      seededWithImage++;
    } else {
      session.history.push({
        role: 'model',
        parts: [{ text: `Acknowledged — spread ${accepted.index + 1} is accepted and matches the locked character and 3D Pixar style.` }],
      });
      seededTextOnly++;
    }
  }
  console.log(
    `[illustrator/session] Seeded history with ${tail.length} accepted spread(s) for continuity ` +
    `(${seededWithImage} with image, ${seededTextOnly} text-only fallback)`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trim history so only the first exchange (character establishment) + the
 * most recent SLIDING_WINDOW_ACCEPTED_SPREADS accepted spread exchanges remain.
 *
 * Since we already prune failed exchanges eagerly via _removeLastExchange,
 * history length maps 1:1 to (1 establishment + N accepted spreads).
 */
function _trimHistoryToSlidingWindow(session) {
  const KEEP_PAIRS = SLIDING_WINDOW_ACCEPTED_SPREADS;
  const keepTailMessages = KEEP_PAIRS * 2;
  const firstExchangeLen = 2;
  const maxLen = firstExchangeLen + keepTailMessages;
  if (session.history.length <= maxLen) return;

  const firstExchange = session.history.slice(0, firstExchangeLen);
  const lastExchanges = session.history.slice(-keepTailMessages);
  const droppedPairs = Math.floor((session.history.length - firstExchangeLen - keepTailMessages) / 2);

  const summary = droppedPairs > 0 ? [
    {
      role: 'user',
      parts: [{ text: `[Context: ${droppedPairs} earlier accepted spreads have been trimmed from history to stay within the token budget. Continue using the same character, outfits, and art style established from the cover and visible in the recent spreads below.]` }],
    },
    {
      role: 'model',
      parts: [{ text: 'Understood. Character, outfits, and 3D Pixar style remain locked from the cover.' }],
    },
  ] : [];

  session.history = [...firstExchange, ...summary, ...lastExchanges];
}

function _removeLastExchange(session) {
  const h = session.history;
  if (h.length >= 2 && h[h.length - 1].role === 'model' && h[h.length - 2].role === 'user') {
    h.splice(-2, 2);
    console.log('[illustrator/session] Pruned failed user+model exchange from history');
  } else if (h.length >= 1 && h[h.length - 1].role === 'user') {
    h.pop();
    console.log('[illustrator/session] Pruned orphaned user message from history');
  }
}

/**
 * Prune the most recent user+model exchange. Use this after a QA failure to
 * remove the rejected model image from history before the next correction
 * turn, so the bad render can never leak into the next attempt as a visual
 * anchor (the "I LOVE MAMA ghost" bug).
 *
 * @param {IllustratorSession} session
 */
function pruneLastTurn(session) {
  _removeLastExchange(session);
}

/**
 * Send a turn to the Gemini REST API. Appends user message to history; appends
 * model response to history on success. On error, pops the user message to
 * keep history well-formed.
 */
async function _sendTurn(session, userParts, genConfigOpts = {}) {
  const { apiKey, model, history, systemInstruction } = session;
  const url = `${CHAT_API_BASE}/${model}:generateContent?key=${apiKey}`;

  history.push({ role: 'user', parts: userParts });

  const generationConfig = {};
  if (genConfigOpts.textOnly) {
    generationConfig.responseModalities = ['TEXT'];
  } else {
    generationConfig.responseModalities = ['TEXT', 'IMAGE'];
    generationConfig.maxOutputTokens = GEMINI_IMAGE_MAX_OUTPUT_TOKENS;
  }
  if (genConfigOpts.aspectRatio) {
    generationConfig.imageConfig = { aspectRatio: genConfigOpts.aspectRatio };
  }

  const safeSystem = sanitizeForGemini(systemInstruction, { mode: 'image' });
  const safeHistory = sanitizeHistory(history, { mode: 'image' });

  const body = {
    systemInstruction: { parts: [{ text: safeSystem }] },
    contents: safeHistory,
    generationConfig,
  };

  const timeout = genConfigOpts.timeout || TURN_TIMEOUT_MS;
  const startMs = Date.now();
  console.log(`[illustrator/session] Sending turn ${session.turnsUsed + 1} (history: ${history.length} msgs)...`);

  let resp;
  try {
    resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, timeout, session.abortSignal);
  } catch (err) {
    history.pop();
    throw err;
  }

  if (!resp.ok) {
    history.pop();
    const errBody = await resp.text().catch(() => '');
    const isNsfw = resp.status === 400
      && /\b(safety|prohibited_content|image_safety|image_prohibited_content|blockReason|content_?policy)\b/i.test(errBody);
    const isSignatureError = resp.status === 400
      && /thought_signature|thoughtSignature/i.test(errBody);
    const err = new Error(`Session API error ${resp.status}: ${errBody.slice(0, 300)}`);
    if (isNsfw) {
      err.isSafetyBlock = true;
      err.isEmptyResponse = true;
    }
    if (isSignatureError) {
      err.isSignatureError = true;
      console.error(
        '[illustrator/session] thought_signature 400 — an accepted spread was replayed without its signature. ' +
        'Check markSpreadAccepted / seedHistoryFromAccepted.',
      );
    }
    throw err;
  }

  const data = await resp.json();
  const elapsedMs = Date.now() - startMs;
  console.log(`[illustrator/session] Turn ${session.turnsUsed + 1} complete (${elapsedMs}ms)`);

  // Preserve thoughtSignature when storing model response — Gemini requires
  // it for continuation of thinking across turns.
  const modelParts = data.candidates?.[0]?.content?.parts;
  if (Array.isArray(modelParts) && modelParts.length > 0) {
    const preservedParts = modelParts.map(part => {
      const preserved = {};
      if (part.text !== undefined) preserved.text = part.text;
      if (part.inlineData) preserved.inlineData = part.inlineData;
      if (part.inline_data) preserved.inline_data = part.inline_data;
      if (part.thoughtSignature !== undefined) preserved.thoughtSignature = part.thoughtSignature;
      return preserved;
    });
    history.push({ role: 'model', parts: preservedParts });
  } else {
    history.pop();
    data.__historyAlreadyCleaned = true;
    console.warn(`[illustrator/session] Turn returned no content parts — pruned user message`);
  }

  return data;
}

/**
 * Extract the generated image from a Gemini response.
 * Tags thrown errors with `.isEmptyResponse` (always) and `.isSafetyBlock`
 * (when finishReason / promptFeedback indicates a filtered candidate).
 */
function _extractImage(response, spreadIndex) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData || p.inline_data);

  if (!imagePart) {
    const candidate = response?.candidates?.[0] || {};
    const finishReason = candidate.finishReason || 'unknown';
    const textSnippet = (parts.find(p => p.text)?.text || '').slice(0, 200);
    const promptFeedback = response?.promptFeedback || null;
    const blockReason = promptFeedback?.blockReason || null;
    const safetyRatings = candidate.safetyRatings || promptFeedback?.safetyRatings || null;
    const isSafetyBlock = SAFETY_FINISH_REASONS.has(finishReason) || !!blockReason;

    console.warn(
      `[illustrator/session] No image for spread ${spreadIndex + 1}: finishReason=${finishReason}, parts=${parts.length}${
        isSafetyBlock ? `, safety=true(${blockReason || finishReason})` : ''
      }${textSnippet ? `, snippet="${textSnippet}"` : ''}`,
    );

    const err = new Error(
      isSafetyBlock
        ? `Safety-blocked response for spread ${spreadIndex + 1} (finishReason=${finishReason}${blockReason ? `, blockReason=${blockReason}` : ''})`
        : `No image in response for spread ${spreadIndex + 1}`,
    );
    err.isEmptyResponse = true;
    err.finishReason = finishReason;
    if (isSafetyBlock) {
      err.isSafetyBlock = true;
      if (blockReason) err.blockReason = blockReason;
      if (safetyRatings) err.safetyRatings = safetyRatings;
    }
    throw err;
  }

  const inline = imagePart.inlineData || imagePart.inline_data;
  const imageBase64 = inline.data;
  const imageBuffer = Buffer.from(imageBase64, 'base64');
  console.log(`[illustrator/session] Generated image for spread ${spreadIndex + 1}: ${imageBuffer.length} bytes`);
  return { imageBuffer, imageBase64 };
}

module.exports = {
  createSession,
  establishCharacterReference,
  generateSpread,
  sendCorrection,
  markSpreadAccepted,
  pruneLastTurn,
  rebuildSession,
  seedHistoryFromAccepted,
};
