/**
 * Chat Session Manager for Illustration Generation
 *
 * Wraps Gemini's chat API to maintain visual memory across all spreads
 * in a children's book. The chat session remembers previously generated
 * illustrations, enabling consistent character depiction without
 * re-sending reference images on every turn.
 *
 * Fallback: if the chat session fails, callers should fall back to
 * standalone generateIllustration() calls.
 */

const { getNextApiKey, fetchWithTimeout, ART_STYLE_CONFIG } = require('./illustrationGenerator');

const GEMINI_MODEL = 'gemini-3.1-flash-image-preview';
const CHAT_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// After this many spreads, start a new chat session to avoid token limits
const MAX_SPREADS_PER_SESSION = 14;

class ChatSessionManager {
  /**
   * @param {string} [modelName] - Gemini model name (defaults to gemini-3.1-flash-image-preview)
   */
  constructor(modelName) {
    this.model = modelName || GEMINI_MODEL;
    this.history = []; // Chat history: [{role, parts}]
    this.systemInstruction = '';
    this.turnsUsed = 0;
    this.startedAt = null;
    this.characterRefParts = []; // Stored for session refresh
    this.styleConfig = null;
    this.bookContext = null;
  }

  /**
   * Start a new book illustration session.
   *
   * Sets up the system instruction and sends the first turn with character
   * reference images + description so the model "learns" the character.
   *
   * @param {Array<{base64: string, mimeType: string}>} characterRefImages - Reference photos
   * @param {object} styleConfig - { artStyle, characterDescription, characterOutfit, characterAnchor, additionalCoverCharacters }
   * @param {object} bookContext - { childName, childAge, totalSpreads, recurringElement, keyObjects }
   */
  async startBookSession(characterRefImages, styleConfig, bookContext) {
    this.startedAt = Date.now();
    this.styleConfig = styleConfig;
    this.bookContext = bookContext;
    this.characterRefParts = characterRefImages || [];

    const artStyleConfig = ART_STYLE_CONFIG[styleConfig.artStyle] || ART_STYLE_CONFIG.watercolor;

    // Build system instruction
    this.systemInstruction = this._buildSystemInstruction(artStyleConfig, styleConfig, bookContext);

    // Build the first turn: introduce character references
    const firstTurnParts = [];

    firstTurnParts.push({
      text: `Study this character carefully. All illustrations in this book must depict this EXACT character with identical face, hair, skin tone, body proportions, and outfit.

CHARACTER: ${styleConfig.characterDescription || 'Match the reference photo exactly.'}
OUTFIT: ${styleConfig.characterOutfit || 'Match the reference photo exactly.'}
${styleConfig.characterAnchor ? `ANCHOR: ${styleConfig.characterAnchor}` : ''}
${styleConfig.additionalCoverCharacters ? `SECONDARY CHARACTERS: ${styleConfig.additionalCoverCharacters}` : ''}

Acknowledge that you understand this character's appearance and will maintain perfect consistency across all illustrations.`,
    });

    // Attach character reference images
    for (const ref of characterRefImages) {
      if (ref.base64) {
        firstTurnParts.push({
          inline_data: { mimeType: ref.mimeType || 'image/jpeg', data: ref.base64 },
        });
      }
    }

    // Send the first turn
    try {
      const response = await this._sendMessage(firstTurnParts);
      this.turnsUsed = 1;

      // Extract text acknowledgment (we don't need the content, just confirm it worked)
      const textPart = response?.candidates?.[0]?.content?.parts?.find(p => p.text);
      console.log(`[chatSessionManager] Session started. Model acknowledgment: "${(textPart?.text || '').slice(0, 100)}"`);

      return true;
    } catch (err) {
      console.error(`[chatSessionManager] Failed to start session: ${err.message}`);
      throw err;
    }
  }

  /**
   * Generate an illustration for a specific spread within the chat session.
   *
   * @param {string} sceneDescription - Scene to illustrate
   * @param {number} spreadIndex - 0-based spread index
   * @param {string} textPlacementHint - Where to leave space for text ('bottom', 'top', etc.)
   * @param {object} [opts] - { aspectRatio, shotType }
   * @returns {Promise<{imageBuffer: Buffer, imageBase64: string}>}
   */
  async generateSpread(sceneDescription, spreadIndex, textPlacementHint, opts = {}) {
    // Check if we need a session refresh (sliding window for large books)
    if (this.turnsUsed > MAX_SPREADS_PER_SESSION) {
      console.log(`[chatSessionManager] Session refresh at spread ${spreadIndex} (${this.turnsUsed} turns used)`);
      await this._refreshSession();
    }

    const totalSpreads = this.bookContext?.totalSpreads || 13;
    const placement = textPlacementHint || 'bottom';

    const messageParts = [{
      text: `Generate illustration for page ${spreadIndex + 1} of ${totalSpreads}:
Scene: ${sceneDescription}
Text area: Leave clean empty space at the ${placement} ~25% of the image for text placement.
${opts.shotType ? `Shot type: ${opts.shotType}` : ''}

Remember: NO text, words, letters, or writing in the image. The character must look IDENTICAL to all previous illustrations.`,
    }];

    const response = await this._sendMessage(messageParts, {
      aspectRatio: opts.aspectRatio || '16:9',
    });
    this.turnsUsed++;

    return this._extractImage(response, spreadIndex);
  }

  /**
   * Retry a spread within the same chat session, providing feedback on what was wrong.
   *
   * @param {string} issue - Description of the problem
   * @param {string} corrections - What to fix
   * @param {object} [opts] - { aspectRatio }
   * @returns {Promise<{imageBuffer: Buffer, imageBase64: string}>}
   */
  async retrySpread(issue, corrections, opts = {}) {
    const messageParts = [{
      text: `The previous illustration had an issue: ${issue}.
Please regenerate it with these corrections: ${corrections}.
Keep the character looking identical to earlier illustrations.
DO NOT include any text in the illustration.
Leave clean empty space for text placement.`,
    }];

    const response = await this._sendMessage(messageParts, {
      aspectRatio: opts.aspectRatio || '16:9',
    });
    this.turnsUsed++;

    return this._extractImage(response, -1);
  }

  /**
   * Get metadata about the current session.
   */
  getSessionInfo() {
    return {
      turnsUsed: this.turnsUsed,
      model: this.model,
      startedAt: this.startedAt,
      historyLength: this.history.length,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  // ── Private Methods ──

  /**
   * Build the system instruction for the chat session.
   */
  _buildSystemInstruction(artStyleConfig, styleConfig, bookContext) {
    const parts = [];
    parts.push('You are creating illustrations for a personalized children\'s book.');
    parts.push('');
    parts.push(`STYLE: ${artStyleConfig.prefix} ${artStyleConfig.suffix}`);
    parts.push(`CHARACTER: ${styleConfig.characterDescription || 'Match the reference photos exactly.'}`);
    if (styleConfig.characterAnchor) {
      parts.push(`CHARACTER ANCHOR: ${styleConfig.characterAnchor}`);
    }
    if (styleConfig.characterOutfit) {
      parts.push(`OUTFIT: ${styleConfig.characterOutfit}`);
    }
    parts.push('');
    parts.push('RULES:');
    parts.push('1. Every illustration must show the EXACT same character — same face shape, same hair color and style, same skin tone, same body proportions, same outfit (unless a scene change explicitly requires different clothing).');
    parts.push('2. NEVER include any text, words, letters, numbers, or writing in the illustrations. The text will be added separately.');
    parts.push('3. Leave clean empty space in the designated area for text to be placed later.');
    parts.push('4. Maintain the same art style throughout — same line weight, shading, color palette warmth, level of detail.');
    parts.push('5. Characters must have correct anatomy — 5 fingers per hand, 2 arms, 2 legs, proportional features.');
    parts.push('6. All content must be age-appropriate for children ages 2-8.');
    parts.push('7. Each illustration is ONE single moment — not a comic strip, not a sequence, not multiple panels.');
    if (bookContext.recurringElement) {
      parts.push(`8. Recurring companion: ${bookContext.recurringElement} — must appear in every scene and look identical.`);
    }
    if (bookContext.keyObjects) {
      parts.push(`9. Key objects (must look identical across all pages): ${bookContext.keyObjects}`);
    }
    if (styleConfig.additionalCoverCharacters) {
      parts.push(`10. Allowed secondary characters: ${styleConfig.additionalCoverCharacters}. No other family members may appear.`);
    } else {
      parts.push('10. NO family members (parents, siblings, grandparents). Only fictional characters may interact with the child.');
    }

    return parts.join('\n');
  }

  /**
   * Send a message in the chat session via the Gemini REST API.
   * Maintains history manually since we use the REST endpoint directly.
   */
  async _sendMessage(parts, genConfig = {}) {
    const apiKey = getNextApiKey();
    if (!apiKey) throw new Error('No API key available for chat session');

    const url = `${CHAT_API_BASE}/${this.model}:generateContent?key=${apiKey}`;

    // Add the new user message to history
    this.history.push({ role: 'user', parts });

    const generationConfig = {
      responseModalities: ['TEXT', 'IMAGE'],
    };
    if (genConfig.aspectRatio) {
      generationConfig.imageConfig = { aspectRatio: genConfig.aspectRatio };
    }

    const body = {
      systemInstruction: { parts: [{ text: this.systemInstruction }] },
      contents: this.history,
      generationConfig,
    };

    const startMs = Date.now();
    console.log(`[chatSessionManager] Sending turn ${this.turnsUsed + 1} (history: ${this.history.length} messages)...`);

    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 180000); // 3 min timeout

    if (!resp.ok) {
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
    console.log(`[chatSessionManager] Turn ${this.turnsUsed + 1} complete (${elapsedMs}ms)`);

    // Add model response to history
    const modelContent = data.candidates?.[0]?.content;
    if (modelContent) {
      // Store a trimmed version of the response in history to save tokens
      // Keep text parts but replace image data with a placeholder reference
      const trimmedParts = modelContent.parts.map(part => {
        if (part.inlineData) {
          // Store the actual image data only for the last 3 responses (sliding window)
          return part;
        }
        return part;
      });
      this.history.push({ role: 'model', parts: trimmedParts });
    }

    return data;
  }

  /**
   * Extract the generated image from a Gemini response.
   */
  _extractImage(response, spreadIndex) {
    const parts = response?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData);

    if (!imagePart) {
      throw new Error(`No image in chat response for spread ${spreadIndex + 1}`);
    }

    const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
    const imageBase64 = imagePart.inlineData.data;

    console.log(`[chatSessionManager] Generated image for spread ${spreadIndex + 1}: ${imageBuffer.length} bytes`);

    return { imageBuffer, imageBase64 };
  }

  /**
   * Refresh the session for large books (sliding window).
   * Creates a new chat with:
   * - Original character references
   * - The first spread (style anchor)
   * - Last 3 generated spreads (continuity)
   */
  async _refreshSession() {
    console.log(`[chatSessionManager] Refreshing session (was ${this.history.length} messages)`);

    // Keep: system instruction (automatic), first user turn + model response, last 3 exchanges
    const firstExchange = this.history.slice(0, 2); // User turn 1 + model response
    const lastExchanges = this.history.slice(-6); // Last 3 user+model pairs

    this.history = [...firstExchange, ...lastExchanges];
    console.log(`[chatSessionManager] Session refreshed to ${this.history.length} messages`);
  }
}

module.exports = { ChatSessionManager };
