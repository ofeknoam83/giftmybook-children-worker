/**
 * Illustrator V2 — Gemini Chat Session Wrapper
 *
 * Manages a persistent Gemini chat session with:
 * - History management with thoughtSignature preservation
 * - Sliding window (cover + last 3 spreads)
 * - Turn-level API calls
 * - Image extraction from responses
 */

const {
  GEMINI_IMAGE_MODEL,
  CHAT_API_BASE,
  TURN_TIMEOUT_MS,
  ESTABLISHMENT_TIMEOUT_MS,
  SLIDING_WINDOW_SIZE,
  MAX_HISTORY_IMAGES,
  GEMINI_IMAGE_MAX_OUTPUT_TOKENS,
} = require('./config');
const { fetchWithTimeout } = require('../illustrationGenerator');
const { buildSystemInstruction } = require('./prompts/system');

/**
 * Pick ONE API key for the entire session (stateful chat needs consistent key).
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
  return keys[Math.floor(Math.random() * keys.length)];
}

/**
 * Create a new illustration chat session.
 *
 * @param {object} opts
 * @param {string} opts.style - Art style key
 * @param {string} opts.coverBase64 - Approved cover image as base64
 * @param {string} opts.coverMime - MIME type of cover
 * @param {string} [opts.childPhotoBase64] - Original uploaded child photo
 * @param {string} [opts.childPhotoMime] - MIME type of photo
 * @param {boolean} opts.hasParentOnCover - Whether the themed parent (a woman
 *   for mother's day, a man for father's day) is actually on the cover.
 *   A sibling or grandparent on the cover does NOT count as the parent.
 * @param {boolean} [opts.hasSecondaryOnCover] - Whether ANY non-child person is
 *   on the cover. Independent of hasParentOnCover.
 * @param {string} [opts.additionalCoverCharacters] - Description of secondary chars
 * @param {string} [opts.theme] - Book theme
 * @returns {object} Session object
 */
function createSession(opts) {
  const apiKey = pickSessionApiKey();
  if (!apiKey) throw new Error('No API key available for illustrator V2 session');

  const systemInstruction = buildSystemInstruction({
    style: opts.style,
    hasParentOnCover: opts.hasParentOnCover,
    hasSecondaryOnCover: opts.hasSecondaryOnCover,
    theme: opts.theme,
    parentOutfit: opts.parentOutfit,
  });

  return {
    apiKey,
    model: GEMINI_IMAGE_MODEL,
    systemInstruction,
    history: [],           // [{role: 'user'|'model', parts: [...]}]
    coverBase64: opts.coverBase64,
    coverMime: opts.coverMime || 'image/jpeg',
    childPhotoBase64: opts.childPhotoBase64 || null,
    childPhotoMime: opts.childPhotoMime || 'image/jpeg',
    generatedSpreads: [],  // [{index, imageBase64}] — for sliding window
    turnsUsed: 0,
    startedAt: Date.now(),
    abandoned: false,
    opts,
  };
}

/**
 * Establish character references in the session's first turn.
 * Sends uploaded photo + cover image. Asks for text-only acknowledgment.
 *
 * @param {object} session
 * @returns {Promise<void>}
 */
async function establishCharacterReferences(session) {
  const parts = [];

  // Send the child's photo as ground truth
  if (session.childPhotoBase64) {
    parts.push({
      text: 'CHARACTER REFERENCE \u2014 REAL PHOTO: ground truth for ethnicity, skin tone, facial features. IMPORTANT: If eyes appear closed/squinting in this photo, IGNORE the eye state \u2014 always draw the child with open, bright, expressive eyes.',
    });
    parts.push({
      inline_data: {
        mimeType: session.childPhotoMime,
        data: session.childPhotoBase64,
      },
    });
  }

  // Send the approved cover as art style reference
  if (session.coverBase64) {
    parts.push({
      text: 'BOOK COVER \u2014 RENDERED STYLE: reference for art style, character rendering, outfit, and how the character looks in this illustration style.',
    });
    parts.push({
      inline_data: {
        mimeType: session.coverMime,
        data: session.coverBase64,
      },
    });
  }

  // Parent / secondary visibility notes — composed additively.
  const { hasParentOnCover, hasSecondaryOnCover, additionalCoverCharacters, theme } = session.opts;
  const isParentTheme = theme === 'mothers_day' || theme === 'fathers_day';
  const secondaryOnCover = (typeof hasSecondaryOnCover === 'boolean') ? hasSecondaryOnCover : !!additionalCoverCharacters;

  // Universal lock: any non-child on the cover (parent or otherwise, any
  // theme) must appear identical to their cover appearance on every spread.
  if (secondaryOnCover) {
    let note = 'NOTE: Every non-child character visible on this cover must appear in illustrations EXACTLY as shown on the cover — same face, hair, skin tone, outfit, build. This rule applies to each of them individually.';
    if (hasParentOnCover) {
      note += ' The themed parent IS among these cover characters and falls under this same lock.';
    } else if (isParentTheme) {
      const isMother = theme === 'mothers_day';
      note += ` IMPORTANT: The person visible on the cover is NOT the ${isMother ? 'mother' : 'father'} — they are a sibling, grandparent, or friend. Do NOT treat them as the parent.`;
    }
    parts.push({ text: note });
  }

  if (!hasParentOnCover && isParentTheme) {
    const isMother = theme === 'mothers_day';
    const parentLabel = isMother ? 'MOTHER (a woman/female)' : 'FATHER (a man/male)';
    const parentOutfit = session.opts.parentOutfit;
    let note = `NOTE: The story references the child's ${parentLabel} but the ${isMother ? 'mother' : 'father'} is NOT on the cover${secondaryOnCover ? ` (the character visible on the cover is a different person — a sibling, grandparent, or friend, NOT the ${isMother ? 'mother' : 'father'})` : ''}. The parent is ${isMother ? 'FEMALE — always draw a woman, never a man' : 'MALE — always draw a man, never a woman'}. The parent must NEVER show their full face — but their body must ALWAYS face TOWARD the child (leaning in, reaching out, kneeling beside). Show the parent through hands, arms, side view with face cropped/obscured, or kneeling with face just out of frame. NEVER show the parent facing away or with their back to the child. FAMILY RESEMBLANCE: The ${isMother ? 'mother' : 'father'}'s visible skin, hair color, and ethnicity MUST match the child in the reference photo — same skin tone, same hair-color family, same ethnicity. Never invent a different ethnicity for the parent.`;
    if (parentOutfit) {
      note += ` PARENT OUTFIT LOCK: The ${isMother ? 'mother' : 'father'} wears EXACTLY this outfit in every illustration: ${parentOutfit}`;
    }
    parts.push({ text: note });
  }

  parts.push({
    text: 'Study these reference images carefully. You will generate 13 spread illustrations maintaining perfect character consistency based on these references. Acknowledge with text ONLY \u2014 do NOT generate an image yet.',
  });

  // Send establishment turn (text-only response)
  const response = await _sendTurn(session, parts, { textOnly: true, timeout: ESTABLISHMENT_TIMEOUT_MS });

  const ackText = response?.candidates?.[0]?.content?.parts?.find(p => p.text);
  console.log(`[illustrator/session] Character established. Ack: "${(ackText?.text || '').slice(0, 150)}"`);

  session.turnsUsed = 1;
}

/**
 * Generate a spread within the chat session.
 *
 * @param {object} session
 * @param {string} spreadPrompt - Full prompt from prompts/spread.js
 * @param {number} spreadIndex - 0-based spread index
 * @returns {Promise<{imageBuffer: Buffer, imageBase64: string}>}
 */
async function generateSpread(session, spreadPrompt, spreadIndex) {
  if (session.abandoned) {
    throw new Error('Session abandoned \u2014 cannot generate');
  }

  // Trim history before adding new turn
  _trimHistory(session);

  // Build user turn parts
  const parts = [];

  // Re-send child photo as face/feature ground truth every spread
  if (session.childPhotoBase64) {
    parts.push({
      text: 'CHILD PHOTO (face ground truth — match age, proportions, and features):',
    });
    parts.push({
      inline_data: {
        mimeType: session.childPhotoMime,
        data: session.childPhotoBase64,
      },
    });
  }

  // Include cover image as visual anchor (if available)
  if (session.coverBase64) {
    parts.push({
      text: 'COVER REFERENCE (visual anchor):',
    });
    parts.push({
      inline_data: {
        mimeType: session.coverMime,
        data: session.coverBase64,
      },
    });
  }

  // Include last N generated spreads as sliding window context
  const recentSpreads = session.generatedSpreads.slice(-SLIDING_WINDOW_SIZE);
  if (recentSpreads.length > 0) {
    parts.push({
      text: `RECENT SPREADS (${recentSpreads.length} of ${session.generatedSpreads.length} generated so far) \u2014 maintain consistency:`,
    });
    for (const recent of recentSpreads) {
      parts.push({
        inline_data: {
          mimeType: 'image/png',
          data: recent.imageBase64,
        },
      });
    }
  }

  // The actual spread prompt
  parts.push({ text: spreadPrompt });

  // Send the turn
  const response = await _sendTurn(session, parts, { aspectRatio: '16:9' });
  session.turnsUsed++;

  // Extract image — if Gemini returned text-only (no image), clean up the
  // failed exchange so subsequent turns don't inherit a poisoned history.
  let result;
  try {
    result = _extractImage(response, spreadIndex);
  } catch (extractErr) {
    _removeLastExchange(session);
    throw extractErr;
  }

  // Store for sliding window
  session.generatedSpreads.push({
    index: spreadIndex,
    imageBase64: result.imageBase64,
  });

  return result;
}

/**
 * Send a correction/retry turn within the same session.
 *
 * @param {object} session
 * @param {string} correctionPrompt - What to fix
 * @param {number} spreadIndex - Which spread is being retried
 * @returns {Promise<{imageBuffer: Buffer, imageBase64: string}>}
 */
async function sendCorrection(session, correctionPrompt, spreadIndex) {
  if (session.abandoned) {
    throw new Error('Session abandoned \u2014 cannot send correction');
  }

  const parts = [];

  // Re-attach child photo so the model keeps face/proportion ground truth
  if (session.childPhotoBase64) {
    parts.push({
      text: 'CHILD PHOTO (face ground truth — match age, proportions, and features):',
    });
    parts.push({
      inline_data: {
        mimeType: session.childPhotoMime,
        data: session.childPhotoBase64,
      },
    });
  }

  // Re-attach cover as visual anchor
  if (session.coverBase64) {
    parts.push({
      text: 'COVER REFERENCE (visual anchor):',
    });
    parts.push({
      inline_data: {
        mimeType: session.coverMime,
        data: session.coverBase64,
      },
    });
  }

  // Re-attach recent spreads for style/character continuity
  const recentSpreads = session.generatedSpreads.slice(-SLIDING_WINDOW_SIZE);
  if (recentSpreads.length > 0) {
    parts.push({
      text: `RECENT SPREADS (${recentSpreads.length}) \u2014 maintain consistency:`,
    });
    for (const recent of recentSpreads) {
      parts.push({
        inline_data: {
          mimeType: 'image/png',
          data: recent.imageBase64,
        },
      });
    }
  }

  parts.push({ text: correctionPrompt });
  const response = await _sendTurn(session, parts, { aspectRatio: '16:9' });
  session.turnsUsed++;

  let result;
  try {
    result = _extractImage(response, spreadIndex);
  } catch (extractErr) {
    _removeLastExchange(session);
    throw extractErr;
  }

  // Replace the last stored spread with the corrected version
  const existing = session.generatedSpreads.findIndex(s => s.index === spreadIndex);
  if (existing >= 0) {
    session.generatedSpreads[existing].imageBase64 = result.imageBase64;
  } else {
    session.generatedSpreads.push({ index: spreadIndex, imageBase64: result.imageBase64 });
  }

  return result;
}

// ── Private helpers ──

/**
 * Remove the last user+model exchange from history.
 * Called when _extractImage fails (Gemini returned text-only, no image).
 * Prevents poisoning subsequent turns with a broken exchange.
 */
function _removeLastExchange(session) {
  const h = session.history;
  if (h.length >= 2 && h[h.length - 1].role === 'model' && h[h.length - 2].role === 'user') {
    h.splice(-2, 2);
    console.log('[illustrator/session] Removed text-only exchange from history to keep session clean');
  } else if (h.length >= 1 && h[h.length - 1].role === 'user') {
    h.pop();
    console.log('[illustrator/session] Removed orphaned user message from history');
  }
}

/**
 * Send a turn to the Gemini REST API and manage history.
 */
async function _sendTurn(session, userParts, genConfigOpts = {}) {
  const { apiKey, model, history, systemInstruction } = session;

  const url = `${CHAT_API_BASE}/${model}:generateContent?key=${apiKey}`;

  // Append user message to history
  history.push({ role: 'user', parts: userParts });

  // Build generation config
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

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: history,
    generationConfig,
  };

  const timeout = genConfigOpts.timeout || TURN_TIMEOUT_MS;
  const startMs = Date.now();
  console.log(`[illustrator/session] Sending turn ${session.turnsUsed + 1} (history: ${history.length} msgs, images: ${_countImages(history)})...`);

  let resp;
  try {
    resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, timeout);
  } catch (err) {
    history.pop(); // Remove failed user message
    throw err;
  }

  if (!resp.ok) {
    history.pop();
    const errBody = await resp.text().catch(() => '');
    const isNsfw = resp.status === 400 && (errBody.includes('safety') || errBody.includes('SAFETY') || errBody.includes('blocked'));
    if (isNsfw) {
      const err = new Error(`Session NSFW block: ${errBody.slice(0, 200)}`);
      err.isNsfw = true;
      throw err;
    }
    throw new Error(`Session API error ${resp.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await resp.json();
  const elapsedMs = Date.now() - startMs;
  console.log(`[illustrator/session] Turn ${session.turnsUsed + 1} complete (${elapsedMs}ms)`);

  // CRITICAL: Preserve thoughtSignature fields when storing model response.
  // If we can't store a valid model response, pop the user message to keep
  // history well-formed (alternating user/model turns).
  const modelContent = data.candidates?.[0]?.content;
  const modelParts = modelContent?.parts;
  if (modelParts && Array.isArray(modelParts) && modelParts.length > 0) {
    const preservedParts = modelParts.map(part => {
      const preserved = {};
      if (part.text !== undefined) preserved.text = part.text;
      if (part.inlineData) preserved.inlineData = part.inlineData;
      if (part.thoughtSignature !== undefined) preserved.thoughtSignature = part.thoughtSignature;
      return preserved;
    });
    history.push({ role: 'model', parts: preservedParts });
  } else {
    // No valid model response — remove the user message to keep history alternating
    history.pop();
    console.warn(`[illustrator/session] Turn ${session.turnsUsed + 1} returned no content parts — removed user message from history`);
  }

  return data;
}

/**
 * Extract the generated image from a Gemini response.
 */
function _extractImage(response, spreadIndex) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData);

  if (!imagePart) {
    const candidate = response?.candidates?.[0] || {};
    const finishReason = candidate.finishReason || 'unknown';
    const textSnippet = (parts.find(p => p.text)?.text || '').slice(0, 200);
    const hasCandidates = Array.isArray(response?.candidates) && response.candidates.length > 0;
    console.warn(
      `[illustrator/session] No image for spread ${spreadIndex + 1}: finishReason=${finishReason}, hasCandidates=${hasCandidates}, parts=${parts.length}` +
      (textSnippet ? `, textSnippet="${textSnippet}"` : ''),
    );
    throw new Error(`No image in response for spread ${spreadIndex + 1}`);
  }

  const imageBase64 = imagePart.inlineData.data;
  const imageBuffer = Buffer.from(imageBase64, 'base64');

  console.log(`[illustrator/session] Generated image for spread ${spreadIndex + 1}: ${imageBuffer.length} bytes`);

  return { imageBuffer, imageBase64 };
}

/**
 * Sliding window trimming.
 * Always keeps Turn 1 (character establishment).
 * Keeps the last SLIDING_WINDOW_SIZE spread turn pairs.
 * Replaces dropped middle turns with text summary placeholders.
 */
function _trimHistory(session) {
  const imageCount = _countImages(session.history);
  if (imageCount <= MAX_HISTORY_IMAGES) return;

  console.log(`[illustrator/session] Trimming history: ${imageCount} images, ${session.history.length} messages`);

  // Always keep first exchange (establishment): indices 0, 1
  const firstExchange = session.history.slice(0, 2);

  // Keep last SLIDING_WINDOW_SIZE exchanges
  const keepTailMessages = SLIDING_WINDOW_SIZE * 2;
  const lastExchanges = session.history.slice(-keepTailMessages);

  // Build summary for dropped middle turns
  const middleStart = 2;
  const middleEnd = session.history.length - keepTailMessages;
  const droppedCount = Math.floor((middleEnd - middleStart) / 2);

  const newHistory = [...firstExchange];

  if (droppedCount > 0) {
    newHistory.push({
      role: 'user',
      parts: [{ text: `Context: ${droppedCount} earlier spreads were generated (removed from history to save space). Continue with the same character appearance and art style established in Turn 1.` }],
    });
    newHistory.push({
      role: 'model',
      parts: [{ text: 'Understood. I will continue with the same character appearance, outfit, and art style.' }],
    });
  }

  newHistory.push(...lastExchanges);

  const newImageCount = _countImages(newHistory);
  console.log(`[illustrator/session] Trimmed: ${session.history.length} -> ${newHistory.length} msgs, ${imageCount} -> ${newImageCount} images`);

  session.history = newHistory;
}

/**
 * Count inline images in history.
 */
function _countImages(history) {
  let count = 0;
  for (const msg of history) {
    for (const part of msg.parts || []) {
      if (part.inline_data || part.inlineData) count++;
    }
  }
  return count;
}

module.exports = {
  createSession,
  establishCharacterReferences,
  generateSpread,
  sendCorrection,
};
