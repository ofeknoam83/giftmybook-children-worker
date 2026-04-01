/**
 * Progress Reporter — sends progress updates + completion callbacks to standalone app
 */

const THROTTLE_MS = 10_000; // 10 seconds between progress updates
const lastReportTimes = new Map();

/**
 * Report generation progress to the standalone app (throttled).
 * @param {string} callbackUrl - Progress callback URL
 * @param {object} data - { bookId, stage, progress, message, previewUrls, characterRefUrl, storyContent }
 */
async function reportProgress(callbackUrl, data) {
  if (!callbackUrl) return;

  const key = data.bookId || 'unknown';
  const now = Date.now();
  const lastTime = lastReportTimes.get(key) || 0;

  if (now - lastTime < THROTTLE_MS) return;
  lastReportTimes.set(key, now);

  try {
    await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch (err) {
    console.warn(`[ProgressReporter] Failed to report progress for ${key}:`, err.message);
  }
}

/**
 * Force-send progress (bypass throttle).
 */
async function reportProgressForce(callbackUrl, data) {
  if (!callbackUrl) return;
  const key = data.bookId || 'unknown';
  lastReportTimes.set(key, Date.now());

  try {
    await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch (err) {
    console.warn(`[ProgressReporter] Failed to report progress for ${key}:`, err.message);
  }
}

/**
 * Report generation complete.
 * @param {string} callbackUrl - Completion callback URL
 * @param {object} data - { bookId, interiorPdfUrl, coverPdfUrl, previewImageUrls, title, pageCount, spreads }
 */
async function reportComplete(callbackUrl, data) {
  if (!callbackUrl) return;

  try {
    await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, success: true }),
    });
    console.log(`[ProgressReporter] Reported completion for ${data.bookId}`);
  } catch (err) {
    console.error(`[ProgressReporter] Failed to report completion for ${data.bookId}:`, err.message);
  }
}

/**
 * Report generation failure.
 * @param {string} callbackUrl
 * @param {object} data - { bookId, error }
 */
async function reportError(callbackUrl, data) {
  if (!callbackUrl) return;

  try {
    await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, success: false }),
    });
    console.log(`[ProgressReporter] Reported error for ${data.bookId}`);
  } catch (err) {
    console.error(`[ProgressReporter] Failed to report error for ${data.bookId}:`, err.message);
  }
}

module.exports = { reportProgress, reportProgressForce, reportComplete, reportError };
