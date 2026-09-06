'use strict';

// Deliver once through the primary endpoint; the progress endpoint is a
// fallback, not a second completion that repeats downstream side effects.
async function deliverBookCompletion({ callbackUrl, progressCallbackUrl, completion, postWithRetry, clearCheckpoint, log }) {
  for (const url of new Set([callbackUrl, progressCallbackUrl].filter(Boolean))) {
    if (await postWithRetry(url, completion)) {
      await clearCheckpoint(completion.bookId);
      return true;
    }
  }
  log('warn', 'PDFs are complete but completion delivery failed; the checkpoint is preserved for recovery.');
  return false;
}

module.exports = { deliverBookCompletion };
