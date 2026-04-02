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
 * Set the API token (used per-request when token comes from standalone app).
 */
function setApiToken(token) {
  if (token) {
    client = new Replicate({ auth: token });
  }
}

module.exports = { runModel, setApiToken };
