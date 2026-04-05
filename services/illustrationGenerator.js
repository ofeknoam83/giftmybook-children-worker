/**
 * Illustration generator service.
 *
 * Generates children's book illustrations using Gemini image API.
 * Uses the child's actual photo as reference for face-consistent
 * character rendering via Gemini's image-to-image capabilities.
 */

const { uploadBuffer } = require('./gcsStorage');
const { withRetry } = require('./retry');

// ── Multi-key round-robin pool for parallel illustration generation ──
// Keys are spread across multiple GCP projects to avoid per-project backend queuing.
const GEMINI_MODEL = 'gemini-3.1-flash-image-preview'; // Nano Banana 2

function buildKeyPool() {
  const keys = [];
  // Numbered keys: GEMINI_API_KEY_1, GEMINI_API_KEY_2, ...
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  // Fallback to single key env vars
  if (keys.length === 0) {
    const single = process.env.GOOGLE_AI_STUDIO_KEY || process.env.GEMINI_API_KEY || '';
    if (single) keys.push(single);
  }
  return keys;
}

const API_KEY_POOL = buildKeyPool();
let keyIndex = 0;

function getNextApiKey() {
  if (API_KEY_POOL.length === 0) return '';
  const key = API_KEY_POOL[keyIndex % API_KEY_POOL.length];
  keyIndex++;
  return key;
}

console.log(`[IllustrationGenerator] API key pool: ${API_KEY_POOL.length} keys across ${API_KEY_POOL.length} projects`);
if (API_KEY_POOL.length === 0) {
  console.warn('[IllustrationGenerator] WARNING: No API keys configured — illustrations will fail');
}

// Gemini proxy endpoint (optional fallback)
const PROXY_URL = process.env.GEMINI_PROXY_URL || '';
const PROXY_API_KEY = process.env.GEMINI_PROXY_API_KEY || '';

/** Fetch with an AbortController timeout */
async function fetchWithTimeout(url, opts, timeoutMs = 420000, parentSignal) { // 7 min default — Gemini image gen can take 4-5 min under load
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // If parent aborts (book-level timeout), abort this fetch too
  const onParentAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) { clearTimeout(timer); throw new Error('Parent already aborted'); }
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    return resp;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Gemini image API timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw e;
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
  }
}

/** Maximum retry attempts per illustration */
const MAX_RETRIES = 2;

/**
 * Art style configurations for illustration prompts.
 */
const ART_STYLE_CONFIG = {
  pixar_premium: {
    prefix: 'premium children\'s book illustration, Pixar-inspired finish,',
    suffix: 'soft cinematic lighting, expressive character posing, warm color harmony, magical storybook detail, rich textures, professional quality, vibrant yet warm palette',
  },
  watercolor: {
    prefix: 'children\'s book watercolor illustration,',
    suffix: 'soft watercolor textures, gentle colors, hand-painted look, paper texture visible, warm natural lighting',
  },
  digital_painting: {
    prefix: 'children\'s book digital painting illustration,',
    suffix: 'vibrant colors, clean lines, professional digital art, warm lighting, friendly atmosphere',
  },
  gouache: {
    prefix: 'children\'s book gouache illustration,',
    suffix: 'thick opaque paint texture, bold flat color areas, visible brushstrokes, matte finish, earthy warm palette',
  },
  pencil_sketch: {
    prefix: 'children\'s book pencil sketch illustration,',
    suffix: 'detailed graphite on cream paper, crosshatching for shadows, delicate linework, warm sepia tones with selective soft color washes',
  },
  paper_cutout: {
    prefix: 'children\'s book paper cutout collage illustration,',
    suffix: 'layered paper shapes with visible cut edges and shadows between layers, textured craft paper, bold simple shapes, Eric Carle inspired',
  },
  storybook_classic: {
    prefix: 'classic golden age children\'s storybook illustration,',
    suffix: 'detailed pen and ink with delicate watercolor tints, ornate borders, Beatrix Potter and Arthur Rackham inspired, vintage whimsical charm',
  },
  anime: {
    prefix: 'Studio Ghibli inspired children\'s book illustration,',
    suffix: 'large expressive eyes, soft pastel colors, dreamy atmospheric lighting, detailed fantasy background, Hayao Miyazaki style',
  },
  pixel_art: {
    prefix: 'retro pixel art children\'s book illustration,',
    suffix: '16-bit video game aesthetic, chunky visible pixels, limited color palette, nostalgic warm tones, charming blocky characters',
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
function buildCharacterPrompt(sceneDescription, artStyle, childName, pageText, characterOutfit, characterDescription, recurringElement, keyObjects, opts = {}) {
  const styleConfig = ART_STYLE_CONFIG[artStyle] || ART_STYLE_CONFIG.watercolor;
  const skipTextEmbed = opts.skipTextEmbed || false;

  const parts = [
    `\u26a0\ufe0f ABSOLUTE RULE: The main character (${childName || 'the child'}) must appear EXACTLY ONCE in this illustration. There is only ONE child in this scene. Do NOT draw the character twice. Do NOT show the same child from multiple angles. ONE child, ONE time.`,
    ``,
    `Create a single children's book illustration page.`,
    ``,
    `MAIN CHARACTER \u2014 ${childName || 'the child'} (appears ONCE and only once):`,
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
  parts.push('- Do NOT create a sequence or comic strip layout \u2014 this is a SINGLE moment in time');
  parts.push('- CRITICAL: The child in the illustration MUST closely resemble the reference photo provided. Match the face shape, skin tone, hair color, hair style, and eye color exactly from the photo.');
  parts.push('- The illustrated character should be immediately recognizable as the same child from the photo, drawn in the art style of the book');
  parts.push('- NEVER change the character\'s hair style, hair color, eye color, or skin tone from what is shown in the reference photo');
  parts.push('- Keep the same age, face shape, and body proportions as the real child in the photo');

  if (recurringElement) {
    parts.push('');
    parts.push(`RECURRING COMPANION (appears in every scene): ${recurringElement}`);
    parts.push('This companion must look identical across all pages.');
  }

  if (keyObjects) {
    parts.push('');
    parts.push('KEY OBJECTS (must look EXACTLY the same on every page \u2014 same colors, same details):');
    parts.push(keyObjects);
    parts.push('Do NOT change the color or appearance of any object between pages.');
  }

  parts.push('');
  parts.push(`SCENE TO ILLUSTRATE: ${sceneDescription}`);
  parts.push('');
  // Use extracted cover art style for visual consistency, fallback to generic style config
  if (opts.coverArtStyle) {
    parts.push(`ART STYLE (match the cover exactly): ${opts.coverArtStyle}`);
    parts.push('CRITICAL: Every illustration must look like it belongs in the same book as the cover. Match the exact medium, color palette, line quality, texture, and lighting from the style description above.');
  } else {
    parts.push(`STYLE: ${styleConfig.prefix} ${styleConfig.suffix}`);
  }
  parts.push('FORMAT: Square image, 1:1 aspect ratio. The image must be perfectly square.');
  parts.push('Children\'s book illustration, whimsical, warm, fully clothed characters, family-friendly.');

  // Embed story text directly in the illustration
  if (pageText && !skipTextEmbed) {
    parts.push('');
    parts.push('TEXT IN IMAGE:');
    parts.push('Include the following story text as part of this illustration page:');
    parts.push(`"${pageText}"`);
    parts.push('');
    parts.push('TEXT RULES:');
    parts.push('- Render ALL of the text above \u2014 do NOT truncate, cut off, or omit any words');
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
  const apiKey = getNextApiKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const keyIdx = (keyIndex - 1) % API_KEY_POOL.length;

  const body = {
    contents: [{ role: 'user', parts: [
      { text: prompt },
      { inline_data: { mimeType: photoMime || 'image/jpeg', data: photoBase64 } },
    ]}],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  };

  const epStart = Date.now();
  console.log(`[illustrationGenerator] Trying public-${keyIdx} with photo reference...`);
  try {
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      const isNsfw = resp.status === 400 && (errBody.includes('safety') || errBody.includes('SAFETY') || errBody.includes('blocked'));
      if (isNsfw) {
        const err = new Error(`Gemini image API (public-${keyIdx}) NSFW block: ${errBody.slice(0, 200)}`);
        err.isNsfw = true;
        throw err;
      }
      throw new Error(`Gemini image API (public-${keyIdx}) error ${resp.status}: ${errBody.slice(0, 200)}`);
    }

    const data = await resp.json();
    const imagePart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!imagePart) throw new Error(`No image in Gemini response (public-${keyIdx})`);

    const imgBuf = Buffer.from(imagePart.inlineData.data, 'base64');
    console.log(`[illustrationGenerator] \u2705 public-${keyIdx} with photo succeeded (${Date.now() - epStart}ms, ${imgBuf.length} bytes)`);
    return imgBuf;
  } catch (err) {
    console.warn(`[illustrationGenerator] \u274c public-${keyIdx} with photo failed after ${Date.now() - epStart}ms: ${err.message.slice(0, 200)}`);
    throw err;
  }
}

/**
 * Call Gemini image generation API without a reference photo.
 *
 * @param {string} prompt - Scene prompt
 * @param {number} [deadlineMs] - Milliseconds remaining before outer deadline
 * @returns {Promise<Buffer>} Generated image buffer
 */
async function callGeminiImageApiNoPhoto(prompt, deadlineMs, abortSignal) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  };

  // Round-robin across API key pool (each key = different GCP project)
  const apiKey = getNextApiKey();
  const publicUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  // Build endpoint list: primary (round-robin key) + proxy fallback
  const endpoints = [
    { url: publicUrl, headers: { 'Content-Type': 'application/json' }, label: `public-${(keyIndex - 1) % API_KEY_POOL.length}` },
    ...(PROXY_URL ? [{
      url: `${PROXY_URL}/generate-image`,
      headers: { 'Content-Type': 'application/json', 'x-api-key': PROXY_API_KEY },
      label: 'gemini-proxy',
      bodyTransform: (b) => ({ prompt: b.contents[0].parts[0].text, model: 'gemini-3.1-flash-image-preview' })
    }] : []),
  ];

  for (const ep of endpoints) {
    // Deadline check: skip if less than 10s remaining
    if (deadlineMs !== undefined && deadlineMs < 10000) {
      console.warn(`[illustrationGenerator] Skipping ${ep.label} \u2014 only ${Math.round(deadlineMs / 1000)}s remaining before deadline`);
      break;
    }
    const endpointTimeout = deadlineMs !== undefined ? Math.max(10000, deadlineMs - 5000) : 120000;

    const epStart = Date.now();
    console.log(`[illustrationGenerator] Trying ${ep.label} endpoint (timeout ${Math.round(endpointTimeout / 1000)}s)...`);
    try {
      let resp;
      if (ep.label === 'gemini-proxy') {
        const proxyBody = { prompt: body.contents[0].parts[0].text, model: 'gemini-3.1-flash-image-preview' };
        resp = await fetchWithTimeout(ep.url, {
          method: 'POST',
          headers: ep.headers,
          body: JSON.stringify(proxyBody),
        }, endpointTimeout, abortSignal);
      } else {
        resp = await fetchWithTimeout(ep.url, {
          method: 'POST',
          headers: ep.headers,
          body: JSON.stringify(body),
        }, endpointTimeout, abortSignal);
      }

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

      if (ep.label === 'gemini-proxy') {
        const data = await resp.json();
        if (!data.imageBase64) throw new Error('No image from gemini-proxy');
        const imgBuf = Buffer.from(data.imageBase64, 'base64');
        console.log(`[illustrationGenerator] \u2705 ${ep.label} succeeded (${Date.now() - epStart}ms, ${imgBuf.length} bytes)`);
        return imgBuf;
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
      // Update remaining deadline for next endpoint
      if (deadlineMs !== undefined) {
        deadlineMs -= (Date.now() - epStart);
      }
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
 * @param {object} [opts] - { apiKeys, costTracker, bookId, childName, childPhotoUrl, _cachedPhotoBase64, _cachedPhotoMime, spreadIndex, deadlineMs }
 * @returns {Promise<string|null>} URL of the generated illustration, or null if skipped
 */
async function generateIllustration(sceneDescription, characterRefUrl, artStyle, opts = {}) {
  const totalStart = Date.now();
  const { costTracker, bookId, childName, childPhotoUrl, spreadIndex } = opts;

  const fullPrompt = buildCharacterPrompt(sceneDescription, artStyle, childName, opts.pageText, opts.characterOutfit, opts.characterDescription, opts.recurringElement, opts.keyObjects, { skipTextEmbed: opts.skipTextEmbed, coverArtStyle: opts.coverArtStyle });

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
      console.warn(`[illustrationGenerator] Failed to download child photo for book ${bookId}: ${dlErr.message} \u2014 generating without photo reference`);
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
      // Always use cover image as reference for character likeness
      if (photoBase64) {
        imageBuffer = await callGeminiImageApi(variant.prompt, photoBase64, photoMime);
      } else {
        const elapsed = Date.now() - totalStart;
        const remaining = opts.deadlineMs ? opts.deadlineMs - elapsed : undefined;
        imageBuffer = await callGeminiImageApiNoPhoto(variant.prompt, remaining, opts.abortSignal);
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

      // No bookId \u2014 can't upload, but this shouldn't happen in production
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

module.exports = { generateIllustration, buildCharacterPrompt, getNextApiKey };
