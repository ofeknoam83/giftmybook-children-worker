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

  console.log(`[faceEngine] Extracting face embedding from ${photoUrls.length} photo(s)`);

  const embeddings = [];
  let primaryPhotoUrl = photoUrls[0];

  for (const photoUrl of photoUrls) {
    try {
      // Use InsightFace face analysis model on Replicate
      const output = await runModel(
        'daanelson/insightface:f6b8b0a5ad07053f0d4c9e400525fa85fba1c3a2ea1a78c4f1b97139b6576d6e',
        {
          image: photoUrl,
          return_embeddings: true,
        },
        { timeout: 60000 }
      );

      if (output && output.faces && output.faces.length > 0) {
        // Take the largest face (most likely the child, not background people)
        const sortedFaces = output.faces.sort((a, b) => {
          const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
          const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
          return areaB - areaA;
        });

        const primaryFace = sortedFaces[0];
        if (primaryFace.embedding) {
          embeddings.push(primaryFace.embedding);
        }

        console.log(`[faceEngine] Found ${output.faces.length} face(s) in photo, using largest`);
      } else {
        console.warn(`[faceEngine] No faces detected in photo: ${photoUrl}`);
      }
    } catch (err) {
      console.warn(`[faceEngine] Failed to process photo ${photoUrl}: ${err.message}`);
    }
  }

  if (embeddings.length === 0) {
    throw new Error('No faces could be detected in any of the provided photos');
  }

  // Average the embeddings from multiple photos for better representation
  const avgEmbedding = embeddings[0].map((_, i) => {
    const sum = embeddings.reduce((acc, emb) => acc + emb[i], 0);
    return sum / embeddings.length;
  });

  // Normalize the averaged embedding
  const magnitude = Math.sqrt(avgEmbedding.reduce((sum, val) => sum + val * val, 0));
  const normalizedEmbedding = avgEmbedding.map(val => val / magnitude);

  console.log(`[faceEngine] Face embedding extracted from ${embeddings.length} photo(s), dimension: ${normalizedEmbedding.length}`);

  return {
    embedding: normalizedEmbedding,
    faceCount: embeddings.length,
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
  if (!referenceEmbedding || !referenceEmbedding.embedding) {
    throw new Error('Reference embedding is required for face consistency check');
  }

  try {
    // Extract face from generated image
    const output = await runModel(
      'daanelson/insightface:f6b8b0a5ad07053f0d4c9e400525fa85fba1c3a2ea1a78c4f1b97139b6576d6e',
      {
        image: generatedImageUrl,
        return_embeddings: true,
      },
      { timeout: 60000 }
    );

    if (!output || !output.faces || output.faces.length === 0) {
      console.warn(`[faceEngine] No face detected in generated image`);
      return 0.0;
    }

    // Find the largest face in the generated image
    const sortedFaces = output.faces.sort((a, b) => {
      const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
      const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
      return areaB - areaA;
    });

    const generatedEmbedding = sortedFaces[0].embedding;
    if (!generatedEmbedding) {
      console.warn(`[faceEngine] No embedding returned for generated face`);
      return 0.0;
    }

    // Cosine similarity between reference and generated embeddings
    const similarity = cosineSimilarity(referenceEmbedding.embedding, generatedEmbedding);

    console.log(`[faceEngine] Face consistency score: ${similarity.toFixed(4)}`);
    return Math.max(0, Math.min(1, similarity));
  } catch (err) {
    console.warn(`[faceEngine] Face verification error: ${err.message}`);
    return 0.0;
  }
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
