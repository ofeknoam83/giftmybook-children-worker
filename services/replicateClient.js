/**
 * Replicate API client — wrapper for Flux.1 + IP-Adapter FaceID
 */

const Replicate = require('replicate');

let client = null;

const DEFAULT_TIMEOUT_MS = 180_000; // 3 minutes per prediction
const MAX_RETRIES = 3;

function getClient() {
  if (!client) {
    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) throw new Error('REPLICATE_API_TOKEN is not set');
    client = new Replicate({ auth: token });
  }
  return client;
}

/**
 * Run a Replicate model and wait for the result.
 * @param {string} modelId - e.g. "lucataco/flux-dev-lora"
 * @param {object} input - Model-specific input parameters
 * @param {object} opts - { timeout }
 * @returns {Promise<string|string[]>} Output URL(s)
 */
async function runModel(modelId, input, opts = {}) {
  const replicate = getClient();
  const timeout = opts.timeout || DEFAULT_TIMEOUT_MS;

  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const output = await Promise.race([
        replicate.run(modelId, { input }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Replicate timeout after ${timeout}ms`)), timeout)
        ),
      ]);
      return output;
    } catch (err) {
      lastError = err;
      console.warn(`[Replicate] Attempt ${attempt + 1}/${MAX_RETRIES} failed for ${modelId}:`, err.message);

      // NSFW errors are deterministic for the same input — retrying won't help
      if (err.message && /nsfw/i.test(err.message)) {
        const nsfwErr = new Error(`NSFW content detected: ${err.message}`);
        nsfwErr.isNsfw = true;
        throw nsfwErr;
      }

      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
      }
    }
  }
  throw lastError;
}

/**
 * Generate a face-consistent illustration using Flux + IP-Adapter FaceID.
 * @param {string} prompt - Scene description
 * @param {string} faceImageUrl - Reference face image URL
 * @param {object} opts - { width, height, numOutputs, guidanceScale, ipAdapterScale }
 * @returns {Promise<string[]>} Generated image URL(s)
 */
async function generateWithFace(prompt, faceImageUrl, opts = {}) {
  const width = opts.width || 1024;
  const height = opts.height || 1024;
  const numOutputs = opts.numOutputs || 1;

  // IP-Adapter FaceID model on Replicate
  // This model takes a face reference and generates images maintaining that face identity
  const output = await runModel(
    'lucataco/ip-adapter-faceid:fb81ef963e74776af72e6f380949013533d46dd5c6228a9e586c57db6303d7cd',
    {
      prompt,
      face_image: faceImageUrl,
      width,
      height,
      num_outputs: numOutputs,
      guidance_scale: opts.guidanceScale || 7.5,
      ip_adapter_scale: opts.ipAdapterScale || 0.7,
      num_inference_steps: opts.steps || 30,
      negative_prompt: 'blurry, low quality, deformed, ugly, bad anatomy, bad hands, text, watermark',
    },
    { timeout: opts.timeout },
  );

  const results = Array.isArray(output) ? output : [output];
  return results.map(r => (typeof r === 'object' && r.url) ? r.url() : (typeof r !== 'string' ? String(r) : r));
}

/**
 * Generate a standard illustration without face reference.
 * @param {string} prompt
 * @param {object} opts
 * @returns {Promise<string[]>}
 */
async function generateImage(prompt, opts = {}) {
  const width = opts.width || 1024;
  const height = opts.height || 1024;

  const output = await runModel(
    'black-forest-labs/flux-1.1-pro',
    {
      prompt,
      width,
      height,
      num_inference_steps: opts.steps || 25,
      guidance_scale: opts.guidanceScale || 3.5,
    },
    { timeout: opts.timeout },
  );

  const results = Array.isArray(output) ? output : [output];
  return results.map(r => (typeof r === 'object' && r.url) ? r.url() : (typeof r !== 'string' ? String(r) : r));
}

/**
 * Set the API token (used per-request when token comes from standalone app).
 */
function setApiToken(token) {
  if (token) {
    client = new Replicate({ auth: token });
  }
}

module.exports = { runModel, generateWithFace, generateImage, setApiToken };
