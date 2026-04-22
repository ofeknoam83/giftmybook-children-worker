/**
 * Illustrator V2 — Gemini Chat Session Wrapper
 *
 * Manages a persistent Gemini chat session with:
 * - History management with thoughtSignature preservation
 * - Sliding window (cover + last 3 spreads)
 * - Turn-level API calls
 * - Image extraction from responses
 */

const sharp = require('sharp');
const {
  GEMINI_IMAGE_MODEL,
  CHAT_API_BASE,
  TURN_TIMEOUT_MS,
  ESTABLISHMENT_TIMEOUT_MS,
  SLIDING_WINDOW_SIZE,
  MAX_HISTORY_IMAGES,
  MAX_HISTORY_IMAGE_BYTES,
  GEMINI_IMAGE_MAX_OUTPUT_TOKENS,
  CONSISTENCY_REGEN_MAX_THUMB_BYTES,
  CONSISTENCY_REGEN_MAX_THUMBS,
} = require('./config');
const { fetchWithTimeout } = require('../illustrationGenerator');
const { buildSystemInstruction } = require('./prompts/system');
const { shrinkSpreadForReview } = require('./quality/bookWideGate');

/**
 * Pick ONE API key for the entire session (stateful chat needs consistent key).
 */
/** Approximate decoded byte size of a base64 string. */
function decodedB64Bytes(b64) {
  return Math.floor((b64.length * 3) / 4);
}

/**
 * Extra shrink for consistency-regen reference thumbs when still over payload budget.
 * @param {string} imageBase64
 * @param {number} maxEdgePx
 * @param {number} jpegQuality
 * @returns {Promise<string>} base64 jpeg
 */
async function shrinkSpreadAggressive(imageBase64, maxEdgePx, jpegQuality) {
  const buf = Buffer.from(imageBase64, 'base64');
  const out = await sharp(buf)
    .resize(maxEdgePx, maxEdgePx, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: jpegQuality })
    .toBuffer();
  return out.toString('base64');
}

/**
 * Neighbor-first reference thumbnails under a byte budget (decoded inline JPEG size).
 * Prefers spreads closest to spreadIndex; drops farthest first; then downscales if needed.
 *
 * @param {number} spreadIndex - 0-based
 * @param {Array<{index: number, imageBase64: string}>} otherSpreads
 * @param {number} maxBytes
 * @returns {Promise<Array<{index: number, thumbB64: string}>>}
 */
async function selectReferenceThumbnails(spreadIndex, otherSpreads, maxBytes) {
  const maxCount = CONSISTENCY_REGEN_MAX_THUMBS || 6;
  const sorted = [...otherSpreads]
    .sort((a, b) => Math.abs(a.index - spreadIndex) - Math.abs(b.index - spreadIndex))
    .slice(0, maxCount);

  /** @type {Array<{index: number, thumbB64: string, sourceB64: string}>} */
  let refs = [];
  for (const s of sorted) {
    const thumbB64 = await shrinkSpreadForReview(s.imageBase64);
    refs.push({ index: s.index, thumbB64, sourceB64: s.imageBase64 });
  }

  let total = refs.reduce((acc, r) => acc + decodedB64Bytes(r.thumbB64), 0);

  while (total > maxBytes && refs.length > 1) {
    const dropped = refs.pop();
    total -= decodedB64Bytes(dropped.thumbB64);
  }

  const downscalePasses = [
    { edge: 448, q: 78 },
    { edge: 320, q: 72 },
    { edge: 256, q: 68 },
  ];
  for (const pass of downscalePasses) {
    if (total <= maxBytes) break;
    const newRefs = [];
    for (const r of refs) {
      const thumbB64 = await shrinkSpreadAggressive(r.sourceB64, pass.edge, pass.q);
      newRefs.push({ index: r.index, thumbB64, sourceB64: r.sourceB64 });
    }
    refs = newRefs;
    total = refs.reduce((acc, r) => acc + decodedB64Bytes(r.thumbB64), 0);
  }

  if (total > maxBytes) {
    console.warn(
      `[illustrator/session] Consistency regen: reference thumbs still ~${Math.round(total / 1024)}KB (budget ${Math.round(maxBytes / 1024)}KB) — sending anyway`,
    );
  }

  return refs.map(({ index, thumbB64 }) => ({ index, thumbB64 }));
}

/**
 * Regenerate one spread with child photo, cover, and all other finished spreads as references.
 * Updates session.generatedSpreads for spreadIndex.
 *
 * @param {object} session
 * @param {object} opts
 * @param {number} opts.spreadIndex - 0-based
 * @param {string} opts.illustrationPrompt - Full spread prompt (e.g. from buildSpreadPrompt)
 * @param {string} opts.correctionNote - Book-wide QA issues and directives
 * @param {Array<{index: number, imageBase64: string}>} opts.otherSpreads - All approved spreads except the one being regenerated
 * @returns {Promise<{imageBuffer: Buffer, imageBase64: string}>}
 */
async function regenerateWithFullContext(session, opts) {
  const { spreadIndex, illustrationPrompt, correctionNote, otherSpreads } = opts;
  if (session.abandoned) {
    throw new Error('Session abandoned \u2014 cannot regenerate');
  }
  if (!otherSpreads || otherSpreads.length === 0) {
    throw new Error('regenerateWithFullContext requires at least one reference spread');
  }
  if (typeof illustrationPrompt !== 'string' || !illustrationPrompt.trim()) {
    throw new Error('regenerateWithFullContext requires illustrationPrompt');
  }
  if (typeof correctionNote !== 'string' || !correctionNote.trim()) {
    throw new Error('regenerateWithFullContext requires correctionNote');
  }

  const maxBytes = CONSISTENCY_REGEN_MAX_THUMB_BYTES || 5 * 1024 * 1024;
  const thumbnails = await selectReferenceThumbnails(spreadIndex, otherSpreads, maxBytes);
  const omitted = otherSpreads.length - thumbnails.length;
  if (omitted > 0) {
    console.log(`[illustrator/session] Consistency regen: omitted ${omitted} farthest reference spread(s) for payload budget`);
  }

  const parts = [];

  if (session.childPhotoBase64) {
    parts.push({
      text: 'CHILD PHOTO (face ground truth \u2014 match age, proportions, and features):',
    });
    parts.push({
      inline_data: {
        mimeType: session.childPhotoMime,
        data: session.childPhotoBase64,
      },
    });
  }

  if (session.coverBase64) {
    parts.push({
      text: 'COVER REFERENCE (visual anchor \u2014 art style and character rendering):',
    });
    parts.push({
      inline_data: {
        mimeType: session.coverMime,
        data: session.coverBase64,
      },
    });
  }

  parts.push({
    text: `APPROVED INTERIOR SPREADS (${thumbnails.length} of ${otherSpreads.length} \u2014 book order). Use these as the canonical look for the hero child, recurring adults/secondaries, outfits, and illustration style. The image you generate MUST match them:`,
  });

  for (const t of thumbnails) {
    parts.push({
      text: `Spread ${t.index + 1} (reference \u2014 MATCH this hero / secondary / style):`,
    });
    parts.push({
      inline_data: { mimeType: 'image/jpeg', data: t.thumbB64 },
    });
  }

  parts.push({
    text: `${correctionNote}\n\nNow generate ONE new 16:9 illustration for spread ${spreadIndex + 1} only. Output a single full-bleed image (no split panels). Follow the illustration specification below exactly for scene and on-image text:\n\n${illustrationPrompt}`,
  });

  // Stateless one-off call — consistency regen intentionally bypasses the
  // accumulated chat history (which by this point holds 13 spreads' worth of
  // images and would push the input past Gemini's 131072-token cap when we
  // append child photo + cover + reference thumbnails on top).
  const response = await _sendStatelessTurn(session, parts, { aspectRatio: '16:9' });

  const result = _extractImage(response, spreadIndex);

  const existing = session.generatedSpreads.findIndex(s => s.index === spreadIndex);
  if (existing >= 0) {
    session.generatedSpreads[existing].imageBase64 = result.imageBase64;
  } else {
    session.generatedSpreads.push({ index: spreadIndex, imageBase64: result.imageBase64 });
  }

  return result;
}

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
    abortSignal: opts.abortSignal || null,
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
    const parentOutfit = session.opts.parentOutfit;
    const lines = [
      `NOTE: Full illustration policy (hidden-face parent, family words vs companions, anatomy, text, composition) is in the session system instruction — follow it on every spread.`,
      `Turn-1 reminder: ${isMother ? 'Mom' : 'Dad'} is not on the cover${secondaryOnCover ? `; anyone else on the cover is not the ${isMother ? 'mother' : 'father'}` : ''}. Non-humans stay companions at true scale — never as the human ${isMother ? 'mother' : 'father'}.`,
    ];
    if (parentOutfit) {
      lines.push(`Parent outfit lock: ${parentOutfit}`);
    }
    parts.push({ text: lines.join(' ') });
  }

  parts.push({
    text: 'Study these reference images carefully. You will generate spread illustrations maintaining perfect character consistency based on these references. Acknowledge with text ONLY \u2014 do NOT generate an image yet.',
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
 * Send a one-off turn to the Gemini REST API WITHOUT appending to session
 * history. Used for consistency regen, where the accumulated chat history
 * would push the multimodal input past the 131072-token cap. Uses the same
 * apiKey, model, and systemInstruction as the session for stylistic parity.
 */
async function _sendStatelessTurn(session, userParts, genConfigOpts = {}) {
  const { apiKey, model, systemInstruction } = session;
  const url = `${CHAT_API_BASE}/${model}:generateContent?key=${apiKey}`;

  const generationConfig = {
    responseModalities: ['TEXT', 'IMAGE'],
    maxOutputTokens: GEMINI_IMAGE_MAX_OUTPUT_TOKENS,
  };
  if (genConfigOpts.aspectRatio) {
    generationConfig.imageConfig = { aspectRatio: genConfigOpts.aspectRatio };
  }

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: userParts }],
    generationConfig,
  };

  const timeout = genConfigOpts.timeout || TURN_TIMEOUT_MS;
  const startMs = Date.now();
  const imgCount = userParts.reduce((n, p) => n + ((p.inline_data || p.inlineData) ? 1 : 0), 0);
  console.log(`[illustrator/session] Stateless regen turn (images: ${imgCount})...`);

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, timeout, session.abortSignal);

  if (!resp.ok) {
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
  console.log(`[illustrator/session] Stateless regen turn complete (${elapsedMs}ms)`);
  return data;
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
    }, timeout, session.abortSignal);
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
/**
 * Sum approximate decoded byte size of all inline images in history (for token safety).
 */
function _imageBytesInHistory(history) {
  let n = 0;
  for (const msg of history) {
    for (const part of msg.parts || []) {
      const id = part.inline_data || part.inlineData;
      const b64 = id?.data;
      if (typeof b64 === 'string' && b64.length) {
        n += Math.floor((b64.length * 3) / 4);
      }
    }
  }
  return n;
}

function _trimHistory(session) {
  const imageCount = _countImages(session.history);
  const imageBytes = _imageBytesInHistory(session.history);
  if (imageCount <= MAX_HISTORY_IMAGES && imageBytes <= MAX_HISTORY_IMAGE_BYTES) return;

  console.log(`[illustrator/session] Trimming history: ${imageCount} images (~${Math.round(imageBytes / 1024)}KB), ${session.history.length} messages`);

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
  regenerateWithFullContext,
};
