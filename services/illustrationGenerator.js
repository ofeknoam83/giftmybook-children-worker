/**
 * Illustration generator service.
 *
 * Generates children's book illustrations using Replicate API with Flux.1 multi-lora.
 * Uses a generated character reference image (NOT the child's real photo) for
 * face-consistent character rendering. Includes NSFW fallback and retry logic.
 */

const { runModel } = require('./replicateClient');
const { uploadFromUrl } = require('./gcsStorage');
const { withRetry } = require('./retry');

/** Maximum retry attempts per illustration */
const MAX_RETRIES = 3;

/** Base seed — each spread gets a unique seed derived from this + spread index */
const BASE_SEED = 12345;

/**
 * Art style configurations for illustration prompts.
 */
const ART_STYLE_CONFIG = {
  watercolor: {
    prefix: 'children\'s book watercolor illustration,',
    suffix: 'soft watercolor textures, gentle colors, hand-painted look, paper texture visible, warm natural lighting',
    negativePrompt: 'photorealistic, photo, realistic, 3d render, dark, scary, violent, text, words, letters, naked, nude',
  },
  digital_painting: {
    prefix: 'children\'s book digital painting illustration,',
    suffix: 'vibrant colors, clean lines, professional digital art, warm lighting, friendly atmosphere',
    negativePrompt: 'photorealistic, photo, realistic, dark, scary, violent, text, words, letters, blurry, naked, nude',
  },
  storybook: {
    prefix: 'classic children\'s storybook illustration,',
    suffix: 'whimsical style, soft pastel colors, detailed backgrounds, cozy atmosphere, fairytale quality',
    negativePrompt: 'photorealistic, photo, realistic, 3d render, dark, scary, violent, text, words, letters, anime, naked, nude',
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
  return `${styleConfig.prefix} children's book illustration of a happy child in a colorful scene, wholesome, family-friendly, child-safe, bright colors, joyful atmosphere, non-realistic, fully clothed ${styleConfig.suffix}`;
}

/**
 * Build a structured illustration prompt with character identity anchoring.
 *
 * Always includes safety anchors ("children's book illustration", "non-realistic",
 * "fully clothed") and character consistency markers.
 *
 * @param {string} sceneDescription - Scene to illustrate
 * @param {string} artStyle - Art style key
 * @param {string} [childAppearance] - Appearance description text
 * @param {string} [childName] - Child's name for character anchoring
 * @returns {string} Complete prompt
 */
function buildCharacterPrompt(sceneDescription, artStyle, childAppearance, childName) {
  const styleConfig = ART_STYLE_CONFIG[artStyle] || ART_STYLE_CONFIG.watercolor;

  // IMPORTANT: Scene description goes FIRST so FLUX prioritizes it.
  // Character description is secondary — it anchors the look but shouldn't overpower the scene.
  const parts = [
    styleConfig.prefix,
    sceneDescription,  // Scene FIRST — this is what makes each illustration unique
  ];

  // Brief character anchor (keep short so scene dominates)
  if (childName && childAppearance) {
    parts.push(`The main character is ${childName}: ${childAppearance.split('.').slice(0, 2).join('.')}.`);
  } else if (childName) {
    parts.push(`The main character is a child named ${childName}.`);
  }

  parts.push(styleConfig.suffix);
  parts.push('children\'s book illustration, non-realistic, fully clothed, wholesome, family-friendly, child-safe');

  return parts.join(' ');
}

/**
 * Generate a single illustration for a book spread.
 *
 * Uses Flux.1 multi-lora on Replicate. The `characterRefUrl` should be the
 * GENERATED reference image (from faceEngine.generateCharacterReference), NOT
 * the child's real photo.
 *
 * @param {string} sceneDescription - What the illustration should depict
 * @param {string} characterRefUrl - URL to the generated character reference sheet (NOT kid photo)
 * @param {string} artStyle - 'watercolor', 'digital_painting', or 'storybook'
 * @param {object} faceEmbedding - Face embedding data from faceEngine
 * @param {object} [opts] - { apiKeys, costTracker, bookId, childAppearance, childName }
 * @returns {Promise<string>} URL of the generated illustration
 */
async function generateIllustration(sceneDescription, characterRefUrl, artStyle, faceEmbedding, opts = {}) {
  const totalStart = Date.now();
  const { costTracker, bookId, childAppearance, childName, spreadIndex } = opts;
  // Unique seed per spread so each illustration is visually different
  const seed = BASE_SEED + (spreadIndex || Math.floor(Math.random() * 10000));
  const styleConfig = ART_STYLE_CONFIG[artStyle] || ART_STYLE_CONFIG.watercolor;

  // Build structured prompt with character identity anchoring
  const fullPrompt = buildCharacterPrompt(sceneDescription, artStyle, childAppearance, childName);

  console.log(`[illustrationGenerator] Generating illustration for book ${bookId || 'unknown'}`);
  console.log(`[illustrationGenerator] Prompt built (${fullPrompt.length} chars): ${fullPrompt.slice(0, 150)}...`);

  // Build prompt variants for NSFW fallback
  const promptVariants = [
    { label: 'original', prompt: fullPrompt, guidanceScale: 3.5 },
    { label: 'sanitized', prompt: sanitizePrompt(fullPrompt), guidanceScale: 4.0 },
    { label: 'generic-safe', prompt: buildGenericSafePrompt(artStyle), guidanceScale: 4.5 },
  ];

  let promptVariantIndex = 0;
  let useCharacterRef = !!characterRefUrl; // May be disabled on NSFW from the reference image

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const variant = promptVariants[promptVariantIndex];
    try {
      const modelId = 'lucataco/flux-dev-multi-lora:ad0314563856e714367fdc7244b19b160d25926d305fec270c9e00f64665d352';

      const input = {
        prompt: variant.prompt,
        negative_prompt: styleConfig.negativePrompt,
        num_outputs: 1,
        aspect_ratio: '1:1',
        output_format: 'png',
        guidance_scale: variant.guidanceScale,
        num_inference_steps: 30,
        seed,
      };

      // Add GENERATED character reference image (NOT the kid's real photo)
      if (useCharacterRef && characterRefUrl) {
        input.image = characterRefUrl;
        input.ip_adapter_scale = 0.35; // Low value so scene description dominates over character reference
      }

      const fluxStart = Date.now();
      const output = await runModel(modelId, input, { timeout: 120000 });

      if (!output || (Array.isArray(output) && output.length === 0)) {
        console.warn(`[illustrationGenerator] Attempt ${attempt}: empty output (${Date.now() - fluxStart}ms)`);
        continue;
      }

      let imageUrl = Array.isArray(output) ? output[0] : output;
      if (typeof imageUrl === "object" && imageUrl.url) imageUrl = imageUrl.url();
      if (typeof imageUrl !== "string") imageUrl = String(imageUrl);

      console.log(`[illustrationGenerator] FLUX model called (attempt ${attempt}, seed ${seed}, ${variant.label}, ${Date.now() - fluxStart}ms)`);

      if (costTracker) {
        costTracker.addImageGeneration('flux-dev', 1);
      }

      console.log(`[illustrationGenerator] Accepted illustration on attempt ${attempt} (${variant.label}) for book ${bookId || 'unknown'}`);

      // Upload to GCS for persistence
      if (bookId) {
        const uploadStart = Date.now();
        const gcsPath = `children-jobs/${bookId}/illustrations/${Date.now()}.png`;
        const gcsUrl = await withRetry(
          () => uploadFromUrl(imageUrl, gcsPath),
          { maxRetries: 3, baseDelayMs: 1000, label: `upload-illustration-${bookId}` }
        );
        console.log(`[illustrationGenerator] Illustration uploaded to GCS (${Date.now() - uploadStart}ms)`);
        console.log(`[illustrationGenerator] Total illustration time: ${Date.now() - totalStart}ms`);
        return gcsUrl;
      }
      console.log(`[illustrationGenerator] Total illustration time: ${Date.now() - totalStart}ms`);
      return imageUrl;
    } catch (genErr) {
      // NSFW error: first try dropping face reference, then advance prompt variants
      if (genErr.isNsfw) {
        console.warn(`[illustrationGenerator] NSFW detected on attempt ${attempt} (${variant.label}) for book ${bookId || 'unknown'}: ${genErr.message}`);

        // If we were using the character reference image, try without it first
        if (useCharacterRef) {
          console.warn(`[illustrationGenerator] Dropping character reference image for book ${bookId || 'unknown'} and retrying`);
          useCharacterRef = false;
          continue;
        }

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
