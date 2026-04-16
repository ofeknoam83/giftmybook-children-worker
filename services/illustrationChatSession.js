/**
 * Illustration Chat Session — Gemini multi-turn image generation
 *
 * Manages a persistent chat session with Gemini for generating children's book
 * illustrations. By maintaining conversation history (with generated images),
 * the model "remembers" the character across spreads, improving consistency
 * without re-attaching reference photos every turn.
 *
 * Key design:
 * - Turn 1: character establishment (photo + cover + description) → text-only ack
 * - Subsequent turns: spread prompts → image generation
 * - thought_signature fields preserved in history (required by Gemini 3)
 * - Sliding window keeps history under 14-image API limit
 * - Single API key per session (stateful via history)
 * - Falls back to stateless generateIllustration() on failure
 */

const { fetchWithTimeout, ART_STYLE_CONFIG, PARENT_THEMES } = require('./illustrationGenerator');

const GEMINI_MODEL = 'gemini-3.1-flash-image-preview';
const CHAT_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TURN_TIMEOUT_MS = 180000; // 3 minutes per turn
const MAX_HISTORY_IMAGES = 10; // Start trimming when history has this many images
const KEEP_RECENT_TURNS = 3; // Always keep the last N spread turns

// ── API Key Selection ──
// Pick ONE key for the entire session to avoid cross-key state issues.
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
  // Pick a random key for this session to distribute load
  return keys[Math.floor(Math.random() * keys.length)];
}

/**
 * Create a new illustration chat session for a book.
 *
 * @param {object} opts
 * @param {string} [opts.apiKey] - Override API key (otherwise picked from pool)
 * @param {string} [opts.model] - Gemini model (default: gemini-3.1-flash-image-preview)
 * @param {string} [opts.characterPhotoBase64] - Original uploaded photo (ground truth)
 * @param {string} [opts.characterPhotoMime] - MIME type of the photo
 * @param {string} [opts.coverBase64] - Approved cover image
 * @param {string} [opts.coverMime] - MIME type of the cover
 * @param {string} [opts.characterAnchor] - Structured ethnicity/features
 * @param {string} [opts.characterDescription] - Hair, appearance details
 * @param {string} [opts.characterOutfit] - Exact outfit description
 * @param {string} [opts.style] - Art style key (e.g. 'watercolor')
 * @param {string} [opts.childName] - Child's name
 * @param {string} [opts.childAge] - Child's age
 * @param {number} [opts.totalSpreads] - Total spreads in the book
 * @param {string} [opts.additionalCoverCharacters] - Secondary character descriptions
 * @param {string} [opts.recurringElement] - Recurring companion/object
 * @param {string} [opts.keyObjects] - Key objects that must stay consistent
 * @returns {object} session object
 */
function createIllustrationSession(opts = {}) {
  const apiKey = opts.apiKey || pickSessionApiKey();
  if (!apiKey) throw new Error('No API key available for illustration chat session');

  const model = opts.model || GEMINI_MODEL;
  const styleConfig = ART_STYLE_CONFIG[opts.style] || ART_STYLE_CONFIG.watercolor;

  const session = {
    apiKey,
    model,
    history: [], // [{role: 'user'|'model', parts: [...]}]
    styleConfig,
    opts, // Keep original opts for reference
    turnsUsed: 0,
    spreadSummaries: [], // Track what each spread depicted (for trimming placeholders)
    startedAt: Date.now(),
    abandoned: false, // Set to true if session becomes corrupted
  };

  return session;
}

/**
 * Establish the character in the session's first turn.
 * Sends reference images + description, asks for text-only acknowledgment.
 *
 * @param {object} session - Session object from createIllustrationSession
 * @returns {Promise<void>}
 */
async function establishCharacter(session) {
  const { opts } = session;
  const parts = [];

  // Character establishment prompt
  parts.push({
    text: _buildCharacterEstablishmentPrompt(session),
  });

  // Attach original photo (ground truth for ethnicity/skin tone)
  if (opts.characterPhotoBase64) {
    parts.push({
      text: 'CHARACTER REFERENCE — REAL PHOTO (ground truth): This is the actual photograph of the child. Use this as the definitive reference for: ethnicity, skin tone, eye shape, eye color, and facial features. These characteristics are LOCKED and must be reproduced exactly. IMPORTANT: If the child\'s eyes appear closed or squinting in this photo, IGNORE the eye state — always draw the child with open, bright, expressive eyes.',
    });
    parts.push({
      inline_data: {
        mimeType: opts.characterPhotoMime || 'image/jpeg',
        data: opts.characterPhotoBase64,
      },
    });
  }

  // Attach approved cover
  if (opts.coverBase64) {
    parts.push({
      text: 'CHARACTER REFERENCE — BOOK COVER (rendered style): This is the approved book cover showing the same child in the book\'s art style. Use this as reference for: art style, rendering quality, hair depiction, outfit, and how the character looks in this specific illustration style.',
    });
    parts.push({
      inline_data: {
        mimeType: opts.coverMime || 'image/jpeg',
        data: opts.coverBase64,
      },
    });
  }

  parts.push({
    text: 'Study these reference images carefully. Acknowledge that you understand this character\'s appearance and will maintain perfect consistency across all illustrations. Reply with text ONLY — do NOT generate an image yet.',
  });

  // Send the establishment turn (text-only response expected)
  const response = await _sendTurn(session, parts, { textOnly: true });

  // Extract and log acknowledgment
  const textPart = response?.candidates?.[0]?.content?.parts?.find(p => p.text);
  console.log(`[illustrationChatSession] Character established. Model ack: "${(textPart?.text || '').slice(0, 150)}"`);

  session.turnsUsed = 1;
}

/**
 * Generate a single spread illustration within the chat session.
 *
 * @param {object} session - Session object
 * @param {string} prompt - Full spread prompt (including character consistency prefix)
 * @param {object} [opts]
 * @param {string} [opts.aspectRatio] - Image aspect ratio (e.g. '16:9', '1:1')
 * @param {string} [opts.shotType] - Camera shot type
 * @param {number} [opts.spreadIndex] - 0-based spread index
 * @param {string} [opts.sceneSummary] - Short summary for history trimming
 * @returns {Promise<{imageBuffer: Buffer, imageBase64: string}>}
 */
async function generateSpreadInSession(session, prompt, opts = {}) {
  if (session.abandoned) {
    throw new Error('Chat session has been abandoned — use stateless fallback');
  }

  // Trim history if we're approaching the image limit
  trimSessionHistory(session);

  const spreadIndex = opts.spreadIndex != null ? opts.spreadIndex : session.turnsUsed - 1;

  // Build the user turn
  const pageText = opts.pageText || '';
  const textInstruction = pageText.trim()
    ? `\nSTORY TEXT TO RENDER ON THIS PAGE (include exactly as written, consistent font style):\n${pageText}\n\nTEXT PLACEMENT RULE (CRITICAL): The text can be placed anywhere in the image EXCEPT it must NEVER cross the vertical center line. Keep a small padding from all edges so text won't be cut in print. Maximum 6 words per line. FONT SIZE: Use a medium-small, comfortably readable font — clearly legible but not overpowering. The text area should occupy roughly 20-30% of the total image area. TEXT CLARITY: The text must be crisp and sharp with clean edges — NOT blurry, fuzzy, or soft. Use solid, well-defined letterforms with high contrast against the background.`
    : '\nDo NOT render any text, words, letters, or numbers in the illustration.';

  let secondaryCharReminder = '';
  if (opts.additionalCoverCharacters) {
    secondaryCharReminder = `\nSECONDARY CHARACTER OUTFIT REMINDER: If a parent/adult character appears in this scene, they must wear the EXACT SAME outfit as in all previous illustrations. Do NOT change their clothes — same garment type, same colors, same style as established earlier.`;
  } else if (opts.theme && PARENT_THEMES.has(opts.theme)) {
    secondaryCharReminder = `\nPARENT WITHOUT REFERENCE IMAGE: The story references a parent but we do NOT have a reference image for them. You MUST still show the parent physically present in the scene — they are real, NOT invisible. However, since we have no reference photo, NEVER show the parent's full face (it would look different on every page). Instead show them partially: hands on the table, arms reaching out, back or side view, a shoulder and arm, kneeling with face turned away, or cropped at the frame edge so only their torso/hands are visible. The parent should feel warm and physically THERE — just with their face hidden or turned away from the viewer.`;
  }

  // Reinforce art style on every spread
  const styleReminder = `ART STYLE REMINDER: ${session.styleConfig.prefix} ${session.styleConfig.suffix}`;

  const parts = [{
    text: `Generate illustration for spread ${spreadIndex + 1}:

${prompt}

${opts.shotType ? `Shot type: ${opts.shotType}` : ''}

${styleReminder}
Fill the entire canvas with the illustration — edge to edge, no blank areas.${textInstruction}
All characters must look IDENTICAL to the reference images from Turn 1 and all previous illustrations — this applies to BOTH the child AND any secondary characters (parents/adults). Same face, hair, skin tone, AND outfit for every character.${secondaryCharReminder}`,
  }];

  // Send the turn and get image response
  const response = await _sendTurn(session, parts, {
    aspectRatio: opts.aspectRatio || '16:9',
  });

  session.turnsUsed++;

  // Store scene summary for trimming placeholders
  const summary = opts.sceneSummary || `Spread ${spreadIndex + 1}`;
  session.spreadSummaries[session.turnsUsed - 1] = summary;

  // Extract image from response
  return _extractImage(response, spreadIndex);
}

/**
 * Sliding window trimming to stay under the image limit.
 * Always keeps Turn 1 (character establishment with photo + cover).
 * Keeps the last KEEP_RECENT_TURNS turns.
 * Drops middle turns, replacing with text summary placeholders.
 *
 * @param {object} session - Session object
 */
function trimSessionHistory(session) {
  const imageCount = _countImagesInHistory(session.history);
  if (imageCount <= MAX_HISTORY_IMAGES) return;

  console.log(`[illustrationChatSession] Trimming history: ${imageCount} images, ${session.history.length} messages`);

  // Structure: [turn1_user, turn1_model, turn2_user, turn2_model, ..., turnN_user, turnN_model]
  // Each turn = 2 messages (user + model pair)

  // Always keep first exchange (character establishment): indices 0, 1
  const firstExchange = session.history.slice(0, 2);

  // Keep last KEEP_RECENT_TURNS exchanges
  const keepTailMessages = KEEP_RECENT_TURNS * 2;
  const lastExchanges = session.history.slice(-keepTailMessages);

  // Build text summaries for dropped middle turns
  const middleSummaries = [];
  const middleStart = 2; // After first exchange
  const middleEnd = session.history.length - keepTailMessages;

  for (let i = middleStart; i < middleEnd; i += 2) {
    // i = user message, i+1 = model response
    const turnIndex = Math.floor(i / 2);
    const summary = session.spreadSummaries[turnIndex] || `Spread ${turnIndex}`;
    middleSummaries.push(`[Previously generated: ${summary}]`);
  }

  // Build new history
  const newHistory = [...firstExchange];

  // Add a single user+model summary turn for all dropped middle turns
  if (middleSummaries.length > 0) {
    newHistory.push({
      role: 'user',
      parts: [{ text: `Context: The following spreads were generated previously but removed from history to save space:\n${middleSummaries.join('\n')}\nContinue generating with the same character appearance and art style.` }],
    });
    newHistory.push({
      role: 'model',
      parts: [{ text: 'Understood. I will continue with the same character appearance, outfit, and art style as established.' }],
    });
  }

  // Add recent turns
  newHistory.push(...lastExchanges);

  const newImageCount = _countImagesInHistory(newHistory);
  console.log(`[illustrationChatSession] History trimmed: ${session.history.length} → ${newHistory.length} messages, ${imageCount} → ${newImageCount} images`);

  session.history = newHistory;
}

// ── Private helpers ──

/**
 * Build the character establishment prompt text.
 */
function _buildCharacterEstablishmentPrompt(session) {
  const { opts, styleConfig } = session;
  const parts = [];

  parts.push('You are creating illustrations for a personalized children\'s book.');
  parts.push('');
  parts.push(`ART STYLE: ${styleConfig.prefix} ${styleConfig.suffix}`);
  parts.push('');

  if (opts.characterAnchor) {
    parts.push('CHARACTER SKIN TONE & FEATURES (from uploaded photo — NEVER alter):');
    parts.push(opts.characterAnchor);
    parts.push('');
  }

  if (opts.characterDescription) {
    parts.push(`CHARACTER APPEARANCE: ${opts.characterDescription}`);
  }

  if (opts.childName) {
    parts.push(`\nNAME: "${opts.childName}" is a HUMAN CHILD — this is a proper noun, not a literal object.`);
  }

  if (opts.characterOutfit) {
    parts.push(`\nOUTFIT (MUST match exactly — no changes across all spreads): ${opts.characterOutfit}`);
  }

  if (opts.additionalCoverCharacters) {
    parts.push(`\nSECONDARY CHARACTERS (appearance LOCKED across all illustrations): ${opts.additionalCoverCharacters}`);
    parts.push('SECONDARY CHARACTER OUTFIT LOCK (CRITICAL):');
    parts.push('- The secondary character (parent/adult) must wear the EXACT SAME outfit in EVERY illustration throughout the book.');
    parts.push('- In the FIRST illustration where this character appears, establish their outfit clearly.');
    parts.push('- In ALL subsequent illustrations, reproduce that EXACT outfit — same garment type, same color, same style. NO changes.');
    parts.push('- This is just as important as the child\'s outfit consistency — readers will notice if the parent\'s clothes change between pages.');
    parts.push('- Same hair color, style, length, skin tone, facial features, and approximate age on every spread.');
  }

  if (opts.recurringElement) {
    parts.push(`\nRECURRING COMPANION: ${opts.recurringElement} — must appear in every scene and look identical.`);
  }

  if (opts.keyObjects) {
    parts.push(`\nKEY OBJECTS (must stay consistent): ${opts.keyObjects}`);
  }

  parts.push('');
  parts.push('RULES:');
  parts.push('1. Every illustration must show the EXACT same characters — same face, hair, skin tone, body proportions, outfit for ALL characters (child AND any secondary characters like parents).');
  parts.push('2. Maintain the same art style throughout — same line weight, shading, color palette warmth, level of detail.');
  parts.push('3. Correct anatomy: 5 fingers per hand, 2 arms, 2 legs, proportional features.');
  parts.push('4. All content must be age-appropriate for children ages 2-8.');
  parts.push('5. Each illustration is ONE single moment — not a comic strip or sequence.');
  parts.push('6. The child\'s eyes must ALWAYS be drawn OPEN and expressive.');
  if (!opts.additionalCoverCharacters) {
    parts.push('7. NO family members (parents, siblings, grandparents) unless explicitly mentioned in the scene prompt.');
  }
  parts.push('');
  parts.push('COMPOSITION:');
  parts.push('- Fill the ENTIRE image edge to edge with the illustration scene.');
  parts.push('- Do NOT leave any blank, empty, or reserved areas.');
  parts.push('');
  parts.push('TEXT RENDERING RULES FOR ALL ILLUSTRATIONS:');
  parts.push('- Every illustration MUST include the story text rendered directly INTO the image');
  parts.push('- Use an elegant, classic serif font style similar to Lora — refined, delicate serifs');
  parts.push('- Use a medium-small, comfortably readable font size — clearly legible but not overpowering');
  parts.push('- Text must be CRISP and SHARP with clean edges — NOT blurry, fuzzy, or soft');
  parts.push('- White or light text with a subtle dark drop shadow or thin outline for readability');
  parts.push('- The EXACT same lettering style, size, weight, and color must appear on EVERY page');
  parts.push('- NEVER change the font style, size, or color between pages — consistency is critical');
  parts.push('- For each spread, evaluate the story text length and compose the illustration accordingly');
  parts.push('- Text must NOT cross the vertical center of the image — keep it in the top or bottom half');
  parts.push('- Keep a small padding from the top and bottom edges so text is not cut when printed');
  parts.push('- Main characters and key action should not be hidden behind the text');

  return parts.join('\n');
}

/**
 * Send a turn in the chat session via Gemini REST API.
 * Handles history management and thought_signature preservation.
 */
async function _sendTurn(session, userParts, genConfigOpts = {}) {
  const { apiKey, model, history } = session;

  const url = `${CHAT_API_BASE}/${model}:generateContent?key=${apiKey}`;

  // Append user message to history
  history.push({ role: 'user', parts: userParts });

  // Build generation config
  const generationConfig = {};
  if (genConfigOpts.textOnly) {
    generationConfig.responseModalities = ['TEXT'];
  } else {
    generationConfig.responseModalities = ['TEXT', 'IMAGE'];
  }
  if (genConfigOpts.aspectRatio) {
    generationConfig.imageConfig = { aspectRatio: genConfigOpts.aspectRatio };
  }

  const body = {
    contents: history,
    generationConfig,
  };

  const startMs = Date.now();
  console.log(`[illustrationChatSession] Sending turn ${session.turnsUsed + 1} (history: ${history.length} messages, images: ${_countImagesInHistory(history)})...`);

  let resp;
  try {
    resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, TURN_TIMEOUT_MS);
  } catch (err) {
    // Remove the user message we just added since the turn failed
    history.pop();
    throw err;
  }

  if (!resp.ok) {
    // Remove the failed user message from history
    history.pop();
    const errBody = await resp.text().catch(() => '');
    const isNsfw = resp.status === 400 && (errBody.includes('safety') || errBody.includes('SAFETY') || errBody.includes('blocked'));
    if (isNsfw) {
      const err = new Error(`Chat session NSFW block: ${errBody.slice(0, 200)}`);
      err.isNsfw = true;
      throw err;
    }
    throw new Error(`Chat session API error ${resp.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await resp.json();
  const elapsedMs = Date.now() - startMs;
  console.log(`[illustrationChatSession] Turn ${session.turnsUsed + 1} complete (${elapsedMs}ms)`);

  // CRITICAL: Preserve thought_signature fields when adding model response to history
  const modelContent = data.candidates?.[0]?.content;
  if (modelContent) {
    const preservedParts = modelContent.parts.map(part => {
      const preserved = {};
      // Keep text content
      if (part.text !== undefined) preserved.text = part.text;
      // Keep inline image data
      if (part.inlineData) preserved.inlineData = part.inlineData;
      // CRITICAL: Preserve thoughtSignature on every part that has it (Gemini REST API uses camelCase)
      if (part.thoughtSignature !== undefined) preserved.thoughtSignature = part.thoughtSignature;
      return preserved;
    });
    history.push({ role: 'model', parts: preservedParts });
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
    throw new Error(`No image in chat response for spread ${spreadIndex + 1}`);
  }

  const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
  const imageBase64 = imagePart.inlineData.data;

  console.log(`[illustrationChatSession] Generated image for spread ${spreadIndex + 1}: ${imageBuffer.length} bytes`);

  return { imageBuffer, imageBase64 };
}

/**
 * Count the total number of inline images in the history.
 */
function _countImagesInHistory(history) {
  let count = 0;
  for (const msg of history) {
    for (const part of msg.parts || []) {
      if (part.inline_data || part.inlineData) count++;
    }
  }
  return count;
}

module.exports = {
  createIllustrationSession,
  establishCharacter,
  generateSpreadInSession,
  trimSessionHistory,
  // Exported for testing
  _countImagesInHistory,
  _buildCharacterEstablishmentPrompt,
};
