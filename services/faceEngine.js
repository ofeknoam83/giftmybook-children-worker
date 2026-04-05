/**
 * Face engine service.
 *
 * Handles face embedding extraction, character reference sheet generation,
 * and face consistency verification for maintaining the child's likeness
 * across all illustrations.
 */

const crypto = require('crypto');
const { runModel } = require('./replicateClient');
const { uploadBuffer, uploadFromUrl, downloadBuffer, getSignedUrl, saveJson, loadJson } = require('./gcsStorage');
const { withRetry } = require('./retry');

/** Current prompt version — bump to invalidate cached descriptions */
const APPEARANCE_PROMPT_VERSION = 'v3';

/** GCS prefix for cached appearance descriptions */
const APPEARANCE_CACHE_PREFIX = 'appearance-cache';

/** Fixed seed for deterministic character reference generation */
const CHARACTER_REF_SEED = 42;

/**
 * Compute a GCS cache key for a child's appearance description.
 *
 * Uses childId if provided, otherwise SHA-256 of sorted photo URLs.
 *
 * @param {string[]} photoUrls - Child photo URLs
 * @param {string} [childId] - Optional stable child identifier
 * @returns {string} GCS object path for the cache entry
 */
function computeAppearanceCacheKey(photoUrls, childId) {
  if (childId) {
    return `${APPEARANCE_CACHE_PREFIX}/child-${childId}.json`;
  }
  const sorted = [...photoUrls].sort();
  const hash = crypto.createHash('sha256').update(sorted.join('|')).digest('hex');
  return `${APPEARANCE_CACHE_PREFIX}/photos-${hash}.json`;
}

/**
 * Try to load a cached appearance description from GCS.
 *
 * @param {string} cacheKey - GCS object path
 * @returns {Promise<string|null>} Cached description or null on miss
 */
async function getCachedAppearance(cacheKey) {
  const start = Date.now();
  try {
    const data = await loadJson(cacheKey);
    if (data && data.promptVersion === APPEARANCE_PROMPT_VERSION) {
      console.log(`[faceEngine] Cache check: HIT for key ${cacheKey} (${Date.now() - start}ms)`);
      return data.description;
    }
    console.log(`[faceEngine] Cache check: STALE (promptVersion=${data?.promptVersion}) for key ${cacheKey} (${Date.now() - start}ms)`);
    return null;
  } catch (err) {
    console.log(`[faceEngine] Cache check: MISS for key ${cacheKey} (${Date.now() - start}ms)`);
    return null;
  }
}

/**
 * Save an appearance description to GCS cache (best-effort).
 *
 * @param {string} cacheKey - GCS object path
 * @param {string} description - Appearance description text
 * @param {string[]} photoUrls - Original photo URLs
 * @param {string} [childName] - Child's name
 */
async function setCachedAppearance(cacheKey, description, photoUrls, childName) {
  const start = Date.now();
  try {
    await saveJson({
      version: 1,
      description,
      photoUrls,
      childName: childName || null,
      createdAt: new Date().toISOString(),
      promptVersion: APPEARANCE_PROMPT_VERSION,
    }, cacheKey);
    console.log(`[faceEngine] Cache saved to ${cacheKey} (${Date.now() - start}ms)`);
  } catch (err) {
    console.warn(`[faceEngine] Cache save failed for ${cacheKey}: ${err.message} (${Date.now() - start}ms)`);
  }
}

/**
 * Extract face embedding from one or more child photos.
 *
 * Downloads photos, runs face detection/embedding model on Replicate,
 * and returns a consolidated face embedding.
 *
 * @param {string[]} photoUrls - GCS or public URLs of child photos
 * @returns {Promise<{ embedding: number[], faceCount: number, primaryPhotoUrl: string }>}
 */
async function extractFaceEmbedding(photoUrls) {
  if (!photoUrls || photoUrls.length === 0) {
    throw new Error('At least one photo URL is required for face extraction');
  }

  const totalStart = Date.now();
  console.log(`[faceEngine] Validating face in ${photoUrls.length} photo(s) via Gemini Vision`);

  let primaryPhotoUrl = photoUrls[0];
  let faceValidated = false;

  // Use Gemini Vision to validate a face exists in the photos
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[faceEngine] No GEMINI_API_KEY — skipping face validation, using first photo');
    return { embedding: null, faceCount: 1, primaryPhotoUrl };
  }

  for (const photoUrl of photoUrls) {
    try {
      // Download the image and send to Gemini Vision
      const dlStart = Date.now();
      const imgResp = await withRetry(
        async () => {
          const resp = await fetch(photoUrl);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return resp;
        },
        { maxRetries: 3, baseDelayMs: 1000, label: 'face-photo-download' }
      );
      const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
      console.log(`[faceEngine] Photo downloaded: ${photoUrl.slice(0, 80)}... (${imgBuffer.length} bytes, ${Date.now() - dlStart}ms)`);
      const base64 = imgBuffer.toString('base64');
      const mimeType = imgResp.headers.get('content-type') || 'image/jpeg';

      const geminiStart = Date.now();
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: 'This is a photo of a child provided by their parent for a personalized children\'s storybook. Is there a clear human face visible? Reply with only YES or NO.' },
              { inline_data: { mime_type: mimeType, data: base64 } },
            ],
          }],
          generationConfig: { maxOutputTokens: 10, temperature: 0 },
        }),
      });

      if (resp.ok) {
        const result = await resp.json();
        const answer = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase() || '';
        console.log(`[faceEngine] Gemini face validation: "${answer}" (${Date.now() - geminiStart}ms)`);
        if (answer.includes('YES')) {
          faceValidated = true;
          primaryPhotoUrl = photoUrl;
          console.log(`[faceEngine] Face validated in photo via Gemini Vision`);
          break;
        } else {
          console.warn(`[faceEngine] No face detected in photo by Gemini Vision: ${answer}`);
        }
      } else {
        console.warn(`[faceEngine] Gemini Vision API error: ${resp.status} (${Date.now() - geminiStart}ms)`);
      }
    } catch (err) {
      console.warn(`[faceEngine] Failed to validate photo ${photoUrl}: ${err.message}`);
    }
  }

  if (!faceValidated) {
    // If Gemini Vision couldn't validate, accept the photo anyway and let
    // downstream illustration generation handle it. Better to produce a book
    // with a potentially wrong face than to block entirely.
    console.warn('[faceEngine] Face validation inconclusive — proceeding with first photo as fallback');
    primaryPhotoUrl = photoUrls[0];
  }

  console.log(`[faceEngine] extractFaceEmbedding completed (${Date.now() - totalStart}ms)`);

  // Return a compatible object — embedding is null since we no longer use InsightFace,
  // but primaryPhotoUrl is set for character reference generation
  return {
    embedding: null,
    faceCount: 1,
    primaryPhotoUrl,
  };
}

/**
 * Generate a character reference sheet showing the child in the target art style.
 *
 * Creates a multi-view reference (front, side, expressions) using ONLY the text
 * description — the child's real photo is NEVER passed to FLUX. The generated
 * reference image is then used as the visual anchor for all subsequent illustrations.
 *
 * @param {object} faceEmbedding - { embedding, faceCount, primaryPhotoUrl }
 * @param {string} childAppearance - Text description of the child's appearance
 * @param {string} artStyle - 'watercolor', 'digital_painting', or 'storybook'
 * @returns {Promise<string>} URL of the character reference sheet
 */
async function generateCharacterReference(faceEmbedding, childAppearance, artStyle) {
  const totalStart = Date.now();
  console.log(`[faceEngine] Generating character reference sheet in ${artStyle} style (text-only, no kid photo)`);

  const styleDescriptions = {
    watercolor: 'soft watercolor children\'s book illustration style, gentle pastel colors',
    digital_painting: 'vibrant digital children\'s book illustration, clean lines, bright colors',
    storybook: 'classic storybook illustration, whimsical and warm, detailed',
  };

  const styleDesc = styleDescriptions[artStyle] || styleDescriptions.watercolor;

  const prompt = `Child-safe children's book illustration for a personalized children's storybook, commissioned by the child's parent. Character reference sheet. ${styleDesc}.
Show the character in four poses: front view, three-quarter view, side profile, and a happy expression close-up.
The character is a young child: ${childAppearance || 'a friendly young child with a warm smile'}.
Non-realistic, fully clothed, illustrated style.
White background, clean layout, consistent character design across all poses.
Professional character design sheet, turnaround sheet style.
Wholesome, family-friendly, child-safe, age-appropriate.`;

  const baseInput = {
    prompt,
    negative_prompt: 'photorealistic, photo, realistic, dark, scary, multiple characters, text, words, nsfw, adult content, inappropriate, naked, nude',
    num_outputs: 1,
    aspect_ratio: '16:9',
    output_format: 'png',
    guidance_scale: 3.5,
    num_inference_steps: 20,
    seed: CHARACTER_REF_SEED,
  };

  // Attempt 1: Text-only prompt (NO kid photo, NO IP-Adapter)
  try {
    const fluxStart = Date.now();
    const output = await runModel(
      'lucataco/flux-dev-multi-lora:ad0314563856e714367fdc7244b19b160d25926d305fec270c9e00f64665d352',
      baseInput,
      { timeout: 120000 }
    );

    let refUrl = Array.isArray(output) ? output[0] : output;
    if (!refUrl) {
      throw new Error('Character reference generation returned empty result');
    }
    if (typeof refUrl === 'object' && refUrl.url) refUrl = refUrl.url();
    if (typeof refUrl !== 'string') refUrl = String(refUrl);

    console.log(`[faceEngine] Character reference sheet generated (text-only): ${refUrl.slice(0, 100)}... (${Date.now() - fluxStart}ms)`);
    console.log(`[faceEngine] generateCharacterReference completed (${Date.now() - totalStart}ms)`);
    return refUrl;
  } catch (err) {
    if (!err.isNsfw) throw err;

    console.warn(`[faceEngine] NSFW filter triggered on character reference — retrying with simplified prompt (${Date.now() - totalStart}ms)`);
  }

  // Attempt 2: Simplified safe prompt
  try {
    const fluxStart = Date.now();
    const safePrompt = `Child-safe children's book illustration. Character reference sheet. ${styleDesc}.
A friendly young child character in four poses. Non-realistic, fully clothed, illustrated style.
White background, clean layout, wholesome, family-friendly, child-safe.`;

    const output = await runModel(
      'lucataco/flux-dev-multi-lora:ad0314563856e714367fdc7244b19b160d25926d305fec270c9e00f64665d352',
      { ...baseInput, prompt: safePrompt, guidance_scale: 4.0 },
      { timeout: 120000 }
    );

    let refUrl = Array.isArray(output) ? output[0] : output;
    if (!refUrl) {
      throw new Error('Character reference generation returned empty result');
    }
    if (typeof refUrl === 'object' && refUrl.url) refUrl = refUrl.url();
    if (typeof refUrl !== 'string') refUrl = String(refUrl);

    console.log(`[faceEngine] Character reference sheet generated (safe fallback): ${refUrl.slice(0, 100)}... (${Date.now() - fluxStart}ms)`);
    console.log(`[faceEngine] generateCharacterReference completed (${Date.now() - totalStart}ms)`);
    return refUrl;
  } catch (err) {
    if (err.isNsfw) {
      console.warn(`[faceEngine] NSFW filter triggered even with safe prompt — skipping character reference entirely (${Date.now() - totalStart}ms)`);
      return null;
    }
    throw err;
  }
}

/**
 * Describe a child's physical appearance using Gemini Vision.
 *
 * Generates a structured 3-5 sentence description covering hair, eyes, face shape,
 * skin tone, expression, clothing, and general vibe. Results are cached in GCS
 * so the same child photos always produce the same description.
 *
 * The child's real photo is ONLY used here (Gemini Vision analysis) and is
 * NEVER passed to FLUX for image generation.
 *
 * @param {string[]} photoUrls - Child photo URLs
 * @param {{ name?: string, age?: number, gender?: string }} [childDetails] - Fallback details
 * @param {{ childId?: string }} [opts] - Options including optional childId for cache key
 * @returns {Promise<string>} Appearance description for illustration prompts
 */
async function describeChildAppearance(photoUrls, childDetails, opts = {}) {
  const totalStart = Date.now();
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey || !photoUrls || photoUrls.length === 0) {
    console.log(`[faceEngine] No API key or photos — using fallback description`);
    return buildFallbackDescription(childDetails);
  }

  // Check GCS cache first
  const cacheKey = computeAppearanceCacheKey(photoUrls, opts.childId);
  const cached = await getCachedAppearance(cacheKey);
  if (cached) {
    console.log(`[faceEngine] Using cached appearance description (${cached.length} chars, ${Date.now() - totalStart}ms)`);
    return cached;
  }

  for (const photoUrl of photoUrls) {
    try {
      const dlStart = Date.now();
      const imgResp = await withRetry(
        async () => {
          const resp = await fetch(photoUrl);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return resp;
        },
        { maxRetries: 3, baseDelayMs: 1000, label: 'appearance-photo-download' }
      );
      const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
      console.log(`[faceEngine] Photo downloaded for description: ${photoUrl.slice(0, 80)}... (${imgBuffer.length} bytes, ${Date.now() - dlStart}ms)`);
      const base64 = imgBuffer.toString('base64');
      const mimeType = imgResp.headers.get('content-type') || 'image/jpeg';

      const geminiStart = Date.now();
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: `This is a photo of a child provided by their parent for a personalized children's storybook.

Describe this child's physical appearance for an illustrator who will draw them as a storybook character. Cover:
- Hair: color, texture, length, and exact style (e.g., "short curly dark brown hair with no accessories", "straight blonde hair in two pigtails with pink elastics"). IMPORTANT: If the child has any hair accessories (headbands, bows, ribbons, clips, elastics, barrettes), describe them exactly. If the child has NO hair accessories, explicitly state "no hair accessories."
- Eyes: color and shape (if visible)
- Face shape: round, oval, etc.
- Skin tone: general, using artistic terms (e.g., warm beige, deep brown, light peach)
- Expression: what expression they have (smiling, curious, thoughtful)
- Clothing: simple description of what they are wearing
- General vibe: energetic, calm, playful, shy, etc.

RULES:
- Do NOT guess the child's exact age; refer to them only as "a young child"
- Do NOT include any identifying information (no names, locations, backgrounds)
- Do NOT include any sensitive, inappropriate, or potentially harmful content
- Write a cohesive 3-5 sentence paragraph (not a bulleted list)
- Focus on visual details an illustrator would need to draw this child consistently across multiple pictures
- Be EXTREMELY precise about hair — an illustrator must reproduce the exact same hairstyle on every page` },
              { inline_data: { mime_type: mimeType, data: base64 } },
            ],
          }],
          generationConfig: { maxOutputTokens: 400, temperature: 0.2 },
        }),
      });

      if (resp.ok) {
        const result = await resp.json();
        const description = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (description) {
          console.log(`[faceEngine] Gemini Vision description generated (${description.length} chars, ${Date.now() - geminiStart}ms): ${description.slice(0, 120)}...`);

          // Cache the description in GCS
          await setCachedAppearance(cacheKey, description, photoUrls, childDetails?.name);

          console.log(`[faceEngine] describeChildAppearance completed (${Date.now() - totalStart}ms)`);
          return description;
        }
      } else {
        console.warn(`[faceEngine] Gemini Vision API error: ${resp.status} (${Date.now() - geminiStart}ms)`);
      }
    } catch (err) {
      console.warn(`[faceEngine] describeChildAppearance failed for ${photoUrl}: ${err.message}`);
    }
  }

  console.warn(`[faceEngine] All photos failed for appearance description — using fallback (${Date.now() - totalStart}ms)`);
  return buildFallbackDescription(childDetails);
}

/**
 * Build a fallback text description when photos or Gemini are unavailable.
 *
 * @param {{ name?: string, age?: number, gender?: string }} [childDetails]
 * @returns {string}
 */
function buildFallbackDescription(childDetails) {
  if (!childDetails) return 'a friendly young child with a warm smile and bright, curious eyes';
  const parts = ['a friendly young'];
  if (childDetails.gender && childDetails.gender !== 'neutral') {
    parts.push(childDetails.gender === 'male' ? 'boy' : 'girl');
  } else {
    parts.push('child');
  }
  if (childDetails.name) parts.push(`named ${childDetails.name}`);
  parts.push('with a warm smile and bright, curious eyes');
  return parts.join(' ');
}

module.exports = {
  extractFaceEmbedding,
  generateCharacterReference,
  describeChildAppearance,
  computeAppearanceCacheKey,
};
