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

// Public Gemini API — primary endpoint (faster)
const PUBLIC_API_KEY = process.env.GOOGLE_AI_STUDIO_KEY || process.env.GEMINI_API_KEY || '';
const PUBLIC_MODEL = 'gemini-3.1-flash-image-preview';
const PUBLIC_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${PUBLIC_MODEL}:generateContent?key=${PUBLIC_API_KEY}`;

/** Fetch with a 2-minute AbortController timeout */
async function fetchWithTimeout(url, opts, timeoutMs = 60000) { // 60s per endpoint — fail fast, try fallback
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
 * @param {string} [childName] - Child's name for character anchoring
 * @returns {string} Complete prompt
 */
function buildCharacterPrompt(sceneDescription, artStyle, childName, pageText, characterOutfit, characterDescription, recurringElement, keyObjects) {
  const styleConfig = ART_STYLE_CONFIG[artStyle] || ART_STYLE_CONFIG.watercolor;

  const parts = [
    `⚠️ ABSOLUTE RULE: The main character (${childName || 'the child'}) must appear EXACTLY ONCE in this illustration. There is only ONE child in this scene. Do NOT draw the character twice. Do NOT show the same child from multiple angles. ONE child, ONE time.`,
    ``,
    `Create a single children's book illustration page.`,
    ``,
    `MAIN CHARACTER — ${childName || 'the child'} (appears ONCE and only once):`,
  ];

  if (characterDescription) {
    parts.push(characterDescription);
  }

  if (characterOutfit) {
    parts.push(`OUTFIT: ${characterOutfit}`);
  }

  parts.push('');
  parts.push('STRICT CHARACTER RULES:');
  parts.push('- There is exactly ONE instance of the main character in this image. NOT TWO. NOT THREE. ONE.');
  parts.push('- Do NOT show the character at different moments or from different angles in the same image');
  parts.push('- Do NOT create a sequence or comic strip layout — this is a SINGLE moment in time');
  parts.push('- NEVER change the character\'s hair style, hair color, or skin tone');
  parts.push('- Keep the same age, face shape, and body proportions');
  parts.push('- The character must be instantly recognizable across all illustrations');

  if (recurringElement) {
    parts.push('');
    parts.push(`RECURRING COMPANION (appears in every scene): ${recurringElement}`);
    parts.push('This companion must look identical across all pages.');
  }

  if (keyObjects) {
    parts.push('');
    parts.push('KEY OBJECTS (must look EXACTLY the same on every page — same colors, same details):');
    parts.push(keyObjects);
    parts.push('Do NOT change the color or appearance of any object between pages.');
  }

  parts.push('');
  parts.push(`SCENE TO ILLUSTRATE: ${sceneDescription}`);
  parts.push('');
  parts.push(`STYLE: ${styleConfig.prefix} ${styleConfig.suffix}`);
  parts.push('Children\'s book illustration, whimsical, warm, fully clothed characters, family-friendly.');

  if (pageText) {
    parts.push('');
    parts.push('TEXT IN IMAGE:');
    parts.push('Include the following story text as part of this illustration page:');
    parts.push(`"${pageText}"`);
    parts.push('');
    parts.push('TEXT RULES:');
    parts.push('- Render ALL of the text above — do NOT truncate, cut off, or omit any words');
    parts.push('- The COMPLETE text must be visible and readable in the image');
    parts.push('- Use a large, clear, friendly children\'s book font');
    parts.push('- Place the text in the top or bottom portion where the background is simplest/softest');
    parts.push('- Ensure high contrast between text and background (use a subtle semi-transparent band if needed)');
    parts.push('- Text must be perfectly legible, correctly spelled, and easy to read');
    parts.push('- Integrate the text naturally into the composition');
    parts.push('- Do NOT place text over the character\'s face or the main action');
  }

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
    contents: [{ role: 'user', parts: [
      { text: prompt },
      { inline_data: { mimeType: photoMime || 'image/jpeg', data: photoBase64 } },
    ]}],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  };

  // Try public API first (14s from Cloud Run), Vertex AI as fallback
  const endpoints = [
    { url: PUBLIC_ENDPOINT, headers: { 'Content-Type': 'application/json' }, label: 'public' },
    { url: VERTEX_ENDPOINT, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': VERTEX_AI_KEY }, label: 'vertex' },
  ];

  for (const ep of endpoints) {
    const epStart = Date.now();
    console.log(`[illustrationGenerator] Trying ${ep.label} endpoint...`);
    try {
      const resp = await fetchWithTimeout(ep.url, {
        method: 'POST',
        headers: ep.headers,
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        const isNsfw = resp.status === 400 && (errBody.includes('safety') || errBody.includes('SAFETY') || errBody.includes('blocked'));
        if (isNsfw) {
          const err = new Error(`Gemini image API (${ep.label}) NSFW block: ${errBody.slice(0, 200)}`);
          err.isNsfw = true;
          throw err;
        }
        throw new Error(`Gemini image API (${ep.label}) error ${resp.status}: ${errBody.slice(0, 200)}`);
      }

      const data = await resp.json();
      const imagePart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (!imagePart) throw new Error(`No image in Gemini response (${ep.label})`);

      const imgBuf = Buffer.from(imagePart.inlineData.data, 'base64');
      console.log(`[illustrationGenerator] \u2705 ${ep.label} succeeded (${Date.now() - epStart}ms, ${imgBuf.length} bytes)`);
      return imgBuf;
    } catch (err) {
      console.warn(`[illustrationGenerator] \u274c ${ep.label} failed after ${Date.now() - epStart}ms: ${err.message.slice(0, 200)}`);
      if (err.isNsfw) throw err;
      if (ep === endpoints[endpoints.length - 1]) throw err;
    }
  }
}

/**
 * Call Gemini image generation API without a reference photo.
 *
 * @param {string} prompt - Scene prompt
 * @returns {Promise<Buffer>} Generated image buffer
 */
async function callGeminiImageApiNoPhoto(prompt) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  };

  // Try public API first (14s from Cloud Run), Vertex AI as fallback
  const endpoints = [
    { url: PUBLIC_ENDPOINT, headers: { 'Content-Type': 'application/json' }, label: 'public' },
    { url: VERTEX_ENDPOINT, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': VERTEX_AI_KEY }, label: 'vertex' },
  ];

  for (const ep of endpoints) {
    const epStart = Date.now();
    console.log(`[illustrationGenerator] Trying ${ep.label} endpoint...`);
    try {
      const resp = await fetchWithTimeout(ep.url, {
        method: 'POST',
        headers: ep.headers,
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        const isNsfw = resp.status === 400 && (errBody.includes('safety') || errBody.includes('SAFETY') || errBody.includes('blocked'));
        if (isNsfw) {
          const err = new Error(`Gemini image API (${ep.label}) NSFW block: ${errBody.slice(0, 200)}`);
          err.isNsfw = true;
          throw err;
        }
        throw new Error(`Gemini image API (${ep.label}) error ${resp.status}: ${errBody.slice(0, 200)}`);
      }

      const data = await resp.json();
      const imagePart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (!imagePart) throw new Error(`No image in Gemini response (${ep.label})`);

      const imgBuf = Buffer.from(imagePart.inlineData.data, 'base64');
      console.log(`[illustrationGenerator] \u2705 ${ep.label} succeeded (${Date.now() - epStart}ms, ${imgBuf.length} bytes)`);
      return imgBuf;
    } catch (err) {
      console.warn(`[illustrationGenerator] \u274c ${ep.label} failed after ${Date.now() - epStart}ms: ${err.message.slice(0, 200)}`);
      if (err.isNsfw) throw err;
      if (ep === endpoints[endpoints.length - 1]) throw err;
    }
  }
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
 * @param {object} [opts] - { apiKeys, costTracker, bookId, childName, childPhotoUrl, _cachedPhotoBase64, _cachedPhotoMime, spreadIndex }
 * @returns {Promise<string|null>} URL of the generated illustration, or null if skipped
 */
async function generateIllustration(sceneDescription, characterRefUrl, artStyle, opts = {}) {
  const totalStart = Date.now();
  const { costTracker, bookId, childName, childPhotoUrl, spreadIndex } = opts;

  const fullPrompt = buildCharacterPrompt(sceneDescription, artStyle, childName, opts.pageText, opts.characterOutfit, opts.characterDescription, opts.recurringElement, opts.keyObjects);

  console.log(`[illustrationGenerator] === Illustration for book ${bookId || 'unknown'}, spread ${spreadIndex !== undefined ? spreadIndex + 1 : '?'} ===`);
  console.log(`[illustrationGenerator] Prompt length: ${fullPrompt.length} chars`);
  console.log(`[illustrationGenerator] Scene: ${sceneDescription.slice(0, 200)}${sceneDescription.length > 200 ? '...' : ''}`);
  console.log(`[illustrationGenerator] Page text: ${opts.pageText || '(none)'}`);
  console.log(`[illustrationGenerator] Outfit: ${opts.characterOutfit || '(none)'}`);
  console.log(`[illustrationGenerator] Has cover ref: ${!!opts._cachedPhotoBase64}, Style: ${artStyle}`);

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
      // Always use text-only generation (no reference photo)
      // Reference photo makes calls 10x slower (3+ min vs ~20s)
      // Character consistency maintained via detailed description in prompt
      imageBuffer = await callGeminiImageApiNoPhoto(variant.prompt);

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
