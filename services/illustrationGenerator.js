/**
 * Illustration generator service.
 *
 * Generates children's book illustrations using Replicate API with Flux.1 + IP-Adapter FaceID
 * for face-consistent character rendering. Includes face similarity verification and retry logic.
 */

const { runModel } = require('./replicateClient');
const { verifyFaceConsistency } = require('./faceEngine');
const { uploadFromUrl } = require('./gcsStorage');
const { ILLUSTRATION_PROMPT_BUILDER } = require('../prompts/pictureBook');

/** Maximum retry attempts per illustration */
const MAX_RETRIES = 3;

/** Minimum face similarity score (0-1) before accepting an illustration */
const MIN_FACE_SIMILARITY = 0.65;

/**
 * Art style configurations for illustration prompts.
 */
const ART_STYLE_CONFIG = {
  watercolor: {
    prefix: 'children\'s book watercolor illustration,',
    suffix: 'soft watercolor textures, gentle colors, hand-painted look, paper texture visible, warm natural lighting',
    negativePrompt: 'photorealistic, 3d render, dark, scary, violent, text, words, letters',
  },
  digital_painting: {
    prefix: 'children\'s book digital painting illustration,',
    suffix: 'vibrant colors, clean lines, professional digital art, warm lighting, friendly atmosphere',
    negativePrompt: 'photorealistic, dark, scary, violent, text, words, letters, blurry',
  },
  storybook: {
    prefix: 'classic children\'s storybook illustration,',
    suffix: 'whimsical style, soft pastel colors, detailed backgrounds, cozy atmosphere, fairytale quality',
    negativePrompt: 'photorealistic, 3d render, dark, scary, violent, text, words, letters, anime',
  },
};

/** Words that may trigger NSFW filters in children's book contexts */
const NSFW_TRIGGER_WORDS = /\b(naked|nude|bare|undress|strip|bath(?:ing|e)?|blood|kill|dead|death|gun|knife|weapon|fight|violent|scary|horror|monster|demon|devil|drunk|alcohol|drug|kiss|love|romantic|sexy|seductive|provocative|sensual|intimate|bedroom|lingerie)\b/gi;

/**
 * Sanitize a prompt to reduce NSFW filter triggers.
 * Removes potentially problematic words and adds safe-content modifiers.
 */
function sanitizePrompt(prompt) {
  let cleaned = prompt.replace(NSFW_TRIGGER_WORDS, '');
  // Collapse multiple spaces
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  return `${cleaned}, wholesome, family-friendly, child-safe, innocent`;
}

/**
 * Build a very generic safe fallback prompt for when sanitization isn't enough.
 */
function buildGenericSafePrompt(artStyle) {
  const styleConfig = ART_STYLE_CONFIG[artStyle] || ART_STYLE_CONFIG.watercolor;
  return `${styleConfig.prefix} children's book illustration of a happy child in a colorful scene, wholesome, family-friendly, child-safe, bright colors, joyful atmosphere ${styleConfig.suffix}`;
}

/**
 * Generate a single illustration for a book spread.
 *
 * Uses Flux.1 with IP-Adapter FaceID on Replicate for face-consistent generation.
 * Verifies face similarity and retries if the generated face doesn't match the reference.
 *
 * @param {string} sceneDescription - What the illustration should depict
 * @param {string} characterRefUrl - URL to the character reference sheet
 * @param {string} artStyle - 'watercolor', 'digital_painting', or 'storybook'
 * @param {object} faceEmbedding - Face embedding data from faceEngine
 * @param {object} [opts] - { apiKeys, costTracker, bookId }
 * @returns {Promise<string>} URL of the generated illustration
 */
async function generateIllustration(sceneDescription, characterRefUrl, artStyle, faceEmbedding, opts = {}) {
  const { costTracker, bookId } = opts;
  const styleConfig = ART_STYLE_CONFIG[artStyle] || ART_STYLE_CONFIG.watercolor;

  const prompt = ILLUSTRATION_PROMPT_BUILDER(sceneDescription, artStyle, '');
  const fullPrompt = `${styleConfig.prefix} ${prompt} ${styleConfig.suffix}`;

  console.log(`[illustrationGenerator] Generating illustration for book ${bookId || 'unknown'}`);

  // Build prompt variants for NSFW fallback
  const promptVariants = [
    { label: 'original', prompt: fullPrompt, guidanceScale: 7.5 },
    { label: 'sanitized', prompt: sanitizePrompt(fullPrompt), guidanceScale: 8.5 },
    { label: 'generic-safe', prompt: buildGenericSafePrompt(artStyle), guidanceScale: 9.0 },
  ];

  let bestResult = null;
  let bestSimilarity = 0;
  let promptVariantIndex = 0;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const variant = promptVariants[promptVariantIndex];
    try {
      // Use Flux.1 with IP-Adapter FaceID for face-consistent generation
      const modelId = 'lucataco/flux-dev-multi-lora:ad0314563856e714367fdc7244b19b160d25926d305fec270c9e00f64665d352';

      const input = {
        prompt: variant.prompt,
        negative_prompt: styleConfig.negativePrompt,
        num_outputs: 1,
        aspect_ratio: '1:1',
        output_format: 'png',
        guidance_scale: variant.guidanceScale,
        num_inference_steps: 30,
      };

      // Add face reference if available
      if (characterRefUrl) {
        input.image = characterRefUrl;
        input.ip_adapter_scale = 0.6;
      }

      const output = await runModel(modelId, input, { timeout: 120000 });

      if (!output || (Array.isArray(output) && output.length === 0)) {
        console.warn(`[illustrationGenerator] Attempt ${attempt}: empty output`);
        continue;
      }

      let imageUrl = Array.isArray(output) ? output[0] : output;
      if (typeof imageUrl === "object" && imageUrl.url) imageUrl = imageUrl.url();
      if (typeof imageUrl !== "string") imageUrl = String(imageUrl);

      if (costTracker) {
        costTracker.addImageGeneration('flux-dev', 1);
      }

      // Verify face consistency if we have a reference embedding
      if (faceEmbedding && faceEmbedding.embedding) {
        try {
          const similarity = await verifyFaceConsistency(imageUrl, faceEmbedding);

          if (similarity > bestSimilarity) {
            bestSimilarity = similarity;
            bestResult = imageUrl;
          }

          if (similarity >= MIN_FACE_SIMILARITY) {
            console.log(`[illustrationGenerator] Face similarity ${similarity.toFixed(3)} >= ${MIN_FACE_SIMILARITY} - accepted on attempt ${attempt} (${variant.label})`);

            // Upload to GCS for persistence
            if (bookId) {
              const gcsPath = `children-jobs/${bookId}/illustrations/${Date.now()}.png`;
              const gcsUrl = await uploadFromUrl(imageUrl, gcsPath);
              return gcsUrl;
            }
            return imageUrl;
          }

          console.warn(`[illustrationGenerator] Face similarity ${similarity.toFixed(3)} < ${MIN_FACE_SIMILARITY} - retrying (attempt ${attempt}/${MAX_RETRIES})`);
        } catch (verifyErr) {
          console.warn(`[illustrationGenerator] Face verification failed (accepting image): ${verifyErr.message}`);
          bestResult = imageUrl;
          bestSimilarity = 1.0; // Accept if verification fails
        }
      } else {
        // No face reference - accept first result
        bestResult = imageUrl;
        bestSimilarity = 1.0;
        break;
      }
    } catch (genErr) {
      // NSFW error: advance to next prompt variant and retry
      if (genErr.isNsfw) {
        console.warn(`[illustrationGenerator] NSFW detected on attempt ${attempt} (${variant.label}) for book ${bookId || 'unknown'}: ${genErr.message}`);
        promptVariantIndex++;

        if (promptVariantIndex >= promptVariants.length) {
          // All prompt variants exhausted — skip this illustration
          console.error(`[illustrationGenerator] All ${promptVariants.length} prompt variants triggered NSFW for book ${bookId || 'unknown'}. Skipping illustration.`);
          return null;
        }
        // Continue to next attempt with the next prompt variant
        continue;
      }

      console.error(`[illustrationGenerator] Attempt ${attempt} failed: ${genErr.message}`);
      if (attempt === MAX_RETRIES) {
        throw new Error(`Illustration generation failed after ${MAX_RETRIES} attempts: ${genErr.message}`);
      }
    }
  }

  if (!bestResult) {
    throw new Error('No illustration generated after all attempts');
  }

  // Use the best result we got (even if below similarity threshold)
  if (bestSimilarity < MIN_FACE_SIMILARITY) {
    console.warn(`[illustrationGenerator] Using best result with similarity ${bestSimilarity.toFixed(3)} (below threshold ${MIN_FACE_SIMILARITY})`);
  }

  // Upload to GCS
  if (bookId) {
    const gcsPath = `children-jobs/${bookId}/illustrations/${Date.now()}.png`;
    const gcsUrl = await uploadFromUrl(bestResult, gcsPath);
    return gcsUrl;
  }

  return bestResult;
}

module.exports = { generateIllustration };
