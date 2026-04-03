/**
 * Illustration generator service.
 *
 * Generates children's book illustrations using Gemini image API.
 * Uses the child's actual photo as reference for face-consistent
 * character rendering via Gemini's image-to-image capabilities.
 */

const { uploadBuffer } = require('./gcsStorage');
const { withRetry } = require('./retry');
// Vertex AI global endpoint — Nano Banana 2 with API key auth
const GCP_PROJECT = process.env.GCP_PROJECT_ID || 'gen-lang-client-0521120270';
const VERTEX_MODEL = 'gemini-3.1-flash-image-preview'; // Nano Banana 2
const VERTEX_ENDPOINT = `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/global/publishers/google/models/${VERTEX_MODEL}:generateContent`;
const VERTEX_AI_KEY = process.env.VERTEX_AI_KEY || process.env.GOOGLE_AI_STUDIO_KEY || '';
if (!VERTEX_AI_KEY) {
  console.warn('[IllustrationGenerator] WARNING: No VERTEX_AI_KEY or GOOGLE_AI_STUDIO_KEY set — illustrations will fail with 401');
}

/** Fetch with a 2-minute AbortController timeout */
async function fetchWithTimeout(url, opts, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    return resp;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Gemini image API timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Maximum retry attempts per illustration */
const MAX_RETRIES = 3;

/**
 * Art style configurations for illustration prompts.
 */
const ART_STYLE_CONFIG = {
  watercolor: {
    prefix: 'children\'s book watercolor illustration,',
    suffix: 'soft watercolor textures, gentle colors, hand-painted look, paper texture visible, warm natural lighting',
  },
  digital_painting: {
    prefix: 'children\'s book digital painting illustration,',
    suffix: 'vibrant colors, clean lines, professional digital art, warm lighting, friendly atmosphere',
  },
  storybook: {
    prefix: 'classic children\'s storybook illustration,',
    suffix: 'whimsical style, soft pastel colors, detailed backgrounds, cozy atmosphere, fairytale quality',
  },
};

/** Words that may trigger NSFW filters in children's book contexts */
const NSFW_TRIGGER_WORDS = /\b(naked|nude|bare|undress|strip|bath(?:ing|e)?|blood|kill|dead|death|gun|knife|weapon|fight|violent|scary|horror|monster|demon|devil|drunk|alcohol|drug|kiss|love|romantic|sexy|seductive|provocative|sensual|intimate|bedroom|lingerie)\b/gi;

/**
 * Sanitize a prompt to reduce NSFW filter triggers.
 */
function sanitizePrompt(prompt) {
  let cleaned = prompt.replace(NSFW_TRIGGER_WORDS, '');
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  return `${cleaned}, wholesome, family-friendly, child-safe, innocent`;
}

/**
 * Build a very generic safe fallback prompt for when sanitization isn't enough.
 */
function buildGenericSafePrompt(artStyle) {
  const styleConfig = ART_STYLE_CONFIG[artStyle] || ART_STYLE_CONFIG.watercolor;
  return `${styleConfig.prefix} children's book illustration of a happy child in a colorful scene, wholesome, family-friendly, child-safe, bright colors, joyful atmosphere, non-realistic, fully clothed ${styleConfig.suffix}`;
}

/**
 * Build a structured illustration prompt with character identity anchoring.
 *
 * @param {string} sceneDescription - Scene to illustrate
 * @param {string} artStyle - Art style key
 * @param {string} [childAppearance] - Appearance description text
 * @param {string} [childName] - Child's name for character anchoring
 * @returns {string} Complete prompt
 */
function buildCharacterPrompt(sceneDescription, artStyle, childAppearance, childName) {
  const styleConfig = ART_STYLE_CONFIG[artStyle] || ART_STYLE_CONFIG.watercolor;

  // For Gemini with photo reference: CHARACTER IDENTITY must be the dominant instruction.
  // The reference photo is sent as inlineData — Gemini needs strong anchoring to use it consistently.
  const parts = [
    `CRITICAL: The attached photo shows the EXACT child who is the main character of this children's book.`,
    `Transform this child into a ${styleConfig.prefix} illustration while preserving their EXACT appearance:`,
    `- Keep the same face shape, features, expression style, skin tone`,
    `- Keep the same hair (color, style, length) — do NOT change the hair`,
    `- Keep the same age and body proportions`,
    `- The illustrated character must be instantly recognizable as the child in the photo`,
    ``,
    `The character's name is ${childName || 'the child'}.`,
  ];

  if (childAppearance) {
    parts.push(`Character details: ${childAppearance}`);
  }

  parts.push('');
  parts.push(`SCENE TO ILLUSTRATE: ${sceneDescription}`);
  parts.push('');
  parts.push(`STYLE: ${styleConfig.prefix} ${styleConfig.suffix}`);
  parts.push('Children\'s book illustration, non-realistic but recognizable, fully clothed, wholesome, family-friendly.');
  parts.push('Draw ONLY the child from the reference photo as the main character. Do NOT add other children or change who the character is between illustrations.');

  return parts.join('\n');
}

/**
 * Download a photo from URL and return { base64, mimeType }.
 */
async function downloadPhotoAsBase64(url) {
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) throw new Error(`Failed to download photo: ${resp.status} ${resp.statusText}`);
  const contentType = resp.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await resp.arrayBuffer());
  return { base64: buffer.toString('base64'), mimeType: contentType };
}

/**
 * Call Gemini image generation API.
 *
 * @param {string} prompt - Scene prompt
 * @param {string} photoBase64 - Base64-encoded child photo
 * @param {string} photoMime - MIME type of the photo
 * @returns {Promise<Buffer>} Generated image buffer
 */
async function callGeminiImageApi(prompt, photoBase64, photoMime) {
  

  const body = {
    contents: [{ parts: [
      { text: prompt },
      { inlineData: { mimeType: photoMime, data: photoBase64 } },
    ] }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  };

  const resp = await fetchWithTimeout(
    VERTEX_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': VERTEX_AI_KEY },
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    const isNsfw = resp.status === 400 && (errText.includes('SAFETY') || errText.includes('blocked'));
    const err = new Error(`Gemini image API error ${resp.status}: ${errText.slice(0, 200)}`);
    err.isNsfw = isNsfw;
    throw err;
  }

  const result = await resp.json();
  const imagePart = result.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!imagePart) {
    // Check for safety block
    const blockReason = result.candidates?.[0]?.finishReason;
    if (blockReason === 'SAFETY') {
      const err = new Error('Gemini blocked image generation for safety reasons');
      err.isNsfw = true;
      throw err;
    }
    throw new Error('Gemini image API returned no image data');
  }

  return Buffer.from(imagePart.inlineData.data, 'base64');
}

/**
 * Call Gemini image generation API without a reference photo.
 *
 * @param {string} prompt - Scene prompt
 * @returns {Promise<Buffer>} Generated image buffer
 */
async function callGeminiImageApiNoPhoto(prompt) {
  

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  };

  const resp = await fetchWithTimeout(
    VERTEX_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': VERTEX_AI_KEY },
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    const isNsfw = resp.status === 400 && (errText.includes('SAFETY') || errText.includes('blocked'));
    const err = new Error(`Gemini image API error ${resp.status}: ${errText.slice(0, 200)}`);
    err.isNsfw = isNsfw;
    throw err;
  }

  const result = await resp.json();
  const imagePart = result.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!imagePart) {
    const blockReason = result.candidates?.[0]?.finishReason;
    if (blockReason === 'SAFETY') {
      const err = new Error('Gemini blocked image generation for safety reasons');
      err.isNsfw = true;
      throw err;
    }
    throw new Error('Gemini image API returned no image data');
  }

  return Buffer.from(imagePart.inlineData.data, 'base64');
}

/**
 * Generate a single illustration for a book spread.
 *
 * Uses Gemini image API with the child's photo as reference for
 * face-consistent illustrations.
 *
 * @param {string} sceneDescription - What the illustration should depict
 * @param {string} characterRefUrl - (ignored, kept for API compat)
 * @param {string} artStyle - 'watercolor', 'digital_painting', or 'storybook'
 * @param {object} faceEmbedding - (ignored, kept for API compat)
 * @param {object} [opts] - { apiKeys, costTracker, bookId, childAppearance, childName, childPhotoUrl, _cachedPhotoBase64, _cachedPhotoMime, spreadIndex }
 * @returns {Promise<string|null>} URL of the generated illustration, or null if skipped
 */
async function generateIllustration(sceneDescription, characterRefUrl, artStyle, faceEmbedding, opts = {}) {
  const totalStart = Date.now();
  const { costTracker, bookId, childAppearance, childName, childPhotoUrl, spreadIndex } = opts;

  const fullPrompt = buildCharacterPrompt(sceneDescription, artStyle, childAppearance, childName);

  console.log(`[illustrationGenerator] Generating illustration for book ${bookId || 'unknown'}`);
  console.log(`[illustrationGenerator] Prompt built (${fullPrompt.length} chars): ${fullPrompt.slice(0, 150)}...`);

  // Resolve photo base64 (use cached if available)
  let photoBase64 = opts._cachedPhotoBase64 || null;
  let photoMime = opts._cachedPhotoMime || 'image/jpeg';
  const hasPhoto = !!(photoBase64 || childPhotoUrl);

  if (!photoBase64 && childPhotoUrl) {
    try {
      const photo = await downloadPhotoAsBase64(childPhotoUrl);
      photoBase64 = photo.base64;
      photoMime = photo.mimeType;
    } catch (dlErr) {
      console.warn(`[illustrationGenerator] Failed to download child photo for book ${bookId}: ${dlErr.message} — generating without photo reference`);
    }
  }

  // Build prompt variants for NSFW fallback
  const promptVariants = [
    { label: 'original', prompt: fullPrompt },
    { label: 'sanitized', prompt: sanitizePrompt(fullPrompt) },
    { label: 'generic-safe', prompt: buildGenericSafePrompt(artStyle) },
  ];

  let promptVariantIndex = 0;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const variant = promptVariants[promptVariantIndex];
    try {
      const geminiStart = Date.now();

      let imageBuffer;
      if (photoBase64) {
        imageBuffer = await callGeminiImageApi(variant.prompt, photoBase64, photoMime);
      } else {
        imageBuffer = await callGeminiImageApiNoPhoto(variant.prompt);
      }

      const geminiMs = Date.now() - geminiStart;
      console.log(`[illustrationGenerator] Gemini image generated (attempt ${attempt}, ${variant.label}, ${geminiMs}ms, ${imageBuffer.length} bytes)`);

      if (costTracker) {
        costTracker.addImageGeneration('gemini-3.1-flash-image-preview', 1);
      }

      console.log(`[illustrationGenerator] Accepted illustration on attempt ${attempt} (${variant.label}) for book ${bookId || 'unknown'}`);

      // Upload to GCS
      if (bookId) {
        const uploadStart = Date.now();
        const gcsPath = `children-jobs/${bookId}/illustrations/${Date.now()}.png`;
        const gcsUrl = await withRetry(
          () => uploadBuffer(imageBuffer, gcsPath, 'image/png'),
          { maxRetries: 3, baseDelayMs: 1000, label: `upload-illustration-${bookId}` }
        );
        console.log(`[illustrationGenerator] Illustration uploaded to GCS (${Date.now() - uploadStart}ms)`);
        console.log(`[illustrationGenerator] Total illustration time: ${Date.now() - totalStart}ms`);
        return gcsUrl;
      }

      // No bookId — can't upload, but this shouldn't happen in production
      console.log(`[illustrationGenerator] Total illustration time: ${Date.now() - totalStart}ms`);
      return null;
    } catch (genErr) {
      if (genErr.isNsfw) {
        console.warn(`[illustrationGenerator] NSFW detected on attempt ${attempt} (${variant.label}) for book ${bookId || 'unknown'}: ${genErr.message}`);
        promptVariantIndex++;
        if (promptVariantIndex >= promptVariants.length) {
          console.error(`[illustrationGenerator] All ${promptVariants.length} prompt variants triggered NSFW for book ${bookId || 'unknown'}. Skipping illustration. (${Date.now() - totalStart}ms)`);
          return null;
        }
        continue;
      }

      console.error(`[illustrationGenerator] Attempt ${attempt} failed: ${genErr.message} (${Date.now() - totalStart}ms)`);
      if (attempt === MAX_RETRIES) {
        throw new Error(`Illustration generation failed after ${MAX_RETRIES} attempts: ${genErr.message}`);
      }
    }
  }

  throw new Error('No illustration generated after all attempts');
}

module.exports = { generateIllustration, buildCharacterPrompt };
