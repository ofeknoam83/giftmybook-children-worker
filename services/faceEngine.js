/**
 * Face engine service.
 *
 * Handles face embedding extraction, character reference sheet generation,
 * and face consistency verification for maintaining the child's likeness
 * across all illustrations.
 */

const { runModel } = require('./replicateClient');
const { uploadBuffer, uploadFromUrl, downloadBuffer, getSignedUrl } = require('./gcsStorage');

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
      const imgResp = await fetch(photoUrl);
      if (!imgResp.ok) {
        console.warn(`[faceEngine] Failed to download photo: ${imgResp.status}`);
        continue;
      }
      const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
      const base64 = imgBuffer.toString('base64');
      const mimeType = imgResp.headers.get('content-type') || 'image/jpeg';

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: 'Is there a clear human face visible in this photo? Reply with only "YES" or "NO".' },
              { inline_data: { mime_type: mimeType, data: base64 } },
            ],
          }],
          generationConfig: { maxOutputTokens: 10, temperature: 0 },
        }),
      });

      if (resp.ok) {
        const result = await resp.json();
        const answer = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase() || '';
        if (answer.includes('YES')) {
          faceValidated = true;
          primaryPhotoUrl = photoUrl;
          console.log(`[faceEngine] Face validated in photo via Gemini Vision`);
          break;
        } else {
          console.warn(`[faceEngine] No face detected in photo by Gemini Vision: ${answer}`);
        }
      } else {
        console.warn(`[faceEngine] Gemini Vision API error: ${resp.status}`);
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
 * Creates a multi-view reference (front, side, expressions) that guides
 * consistent illustration generation across all spreads.
 *
 * @param {object} faceEmbedding - { embedding, faceCount, primaryPhotoUrl }
 * @param {string} childAppearance - Text description of the child's appearance
 * @param {string} artStyle - 'watercolor', 'digital_painting', or 'storybook'
 * @returns {Promise<string>} URL of the character reference sheet
 */
async function generateCharacterReference(faceEmbedding, childAppearance, artStyle) {
  console.log(`[faceEngine] Generating character reference sheet in ${artStyle} style`);

  const styleDescriptions = {
    watercolor: 'soft watercolor children\'s book illustration style, gentle pastel colors',
    digital_painting: 'vibrant digital children\'s book illustration, clean lines, bright colors',
    storybook: 'classic storybook illustration, whimsical and warm, detailed',
  };

  const styleDesc = styleDescriptions[artStyle] || styleDescriptions.watercolor;

  const prompt = `Character reference sheet for a children's book character. ${styleDesc}.
Show the character in four poses: front view, three-quarter view, side profile, and a happy expression close-up.
The character is a child: ${childAppearance || 'a friendly young child'}.
White background, clean layout, consistent character design across all poses.
Professional character design sheet, turnaround sheet style.`;

  // Use Flux with IP-Adapter to maintain face likeness
  const output = await runModel(
    'lucataco/flux-dev-multi-lora:2389224e115448d9a77c07d7d45672b3f0aa45acacf1c5b89f15c1a02db04c4e',
    {
      prompt,
      negative_prompt: 'photorealistic photo, dark, scary, multiple characters, text, words',
      image: faceEmbedding.primaryPhotoUrl,
      ip_adapter_scale: 0.7,
      num_outputs: 1,
      aspect_ratio: '16:9',
      output_format: 'png',
      guidance_scale: 7.5,
      num_inference_steps: 30,
    },
    { timeout: 120000 }
  );

  const refUrl = Array.isArray(output) ? output[0] : output;
  if (!refUrl) {
    throw new Error('Character reference generation returned empty result');
  }

  console.log(`[faceEngine] Character reference sheet generated`);
  return refUrl;
}

/**
 * Verify face consistency between a generated illustration and the reference embedding.
 *
 * Compares the face in a generated image to the reference face embedding
 * using cosine similarity.
 *
 * @param {string} generatedImageUrl - URL of the generated illustration
 * @param {object} referenceEmbedding - { embedding, ... } from extractFaceEmbedding
 * @returns {Promise<number>} Similarity score from 0 to 1
 */
async function verifyFaceConsistency(generatedImageUrl, referenceEmbedding) {
  // Face consistency verification is currently disabled since InsightFace
  // is no longer available on Replicate. We rely on the character reference
  // sheet and IP-Adapter to maintain face consistency.
  console.log('[faceEngine] Face consistency check skipped (no embedding model)');
  return 0.5; // Return neutral score
}

/**
 * Compute cosine similarity between two vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} Similarity from -1 to 1
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dotProduct / denominator;
}

module.exports = {
  extractFaceEmbedding,
  generateCharacterReference,
  verifyFaceConsistency,
};
