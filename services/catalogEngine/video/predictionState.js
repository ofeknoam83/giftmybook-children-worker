const { loadJson } = require('../../gcsStorage');

// A failed read is not evidence that a paid prediction does not exist.
// Only an absent object permits submission; outages and corrupt checkpoints
// must leave saved work intact for a later resume.
async function loadPrediction(key) {
  try { return await loadJson(key); }
  catch (cause) {
    const code = cause.code || cause.statusCode || cause.response?.status;
    if (Number(code) === 404) return null;
    const transient = [408, 429, 500, 502, 503, 504].includes(Number(code))
      || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'].includes(code);
    const error = new Error('Saved video prediction could not be read; no replacement was submitted. Retry after storage access is restored.', { cause });
    error.failureCode = 'video_prediction_state_unavailable';
    error.recovery = {
      version: 1, status: 'verification_pending', stage: 'video_generation', provider: 'gcs',
      reason: transient ? 'storage_unavailable' : 'configuration',
      nextAction: transient ? 'resume_saved_work' : 'repair_configuration', retryable: transient,
      issues: [{ status: transient ? 'transient' : 'configuration', reason: 'Saved prediction state could not be read.' }],
    };
    throw error;
  }
}

function checkPredictionAbort(signal) {
  if (signal?.aborted) {
    throw Object.assign(new Error('Film generation cancelled.'), { failureCode: 'cancelled' });
  }
}

module.exports = { loadPrediction, checkPredictionAbort };
