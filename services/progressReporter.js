/**
 * Progress Reporter — sends progress updates + completion callbacks to standalone app
 */

const THROTTLE_MS = 3_000; // 3 seconds between progress updates
const lastReportTimes = new Map();
const API_KEY = process.env.API_KEY || '';

/**
 * Report generation progress to the standalone app (throttled).
 * @param {string} callbackUrl - Progress callback URL
 * @param {object} data - { bookId, stage, progress, message, previewUrls, characterRefUrl, storyContent }
 */
async function reportProgress(callbackUrl, data) {
  if (!callbackUrl) return null;

  const key = data.bookId || 'unknown';
  const now = Date.now();
  const lastTime = lastReportTimes.get(key) || 0;

  if (now - lastTime < THROTTLE_MS) return null;
  lastReportTimes.set(key, now);

  try {
    const res = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify(data),
    });
    const body = await res.json().catch(() => null);
    return body;
  } catch (err) {
    console.warn(`[ProgressReporter] Failed to report progress for ${key}:`, err.message);
    return null;
  }
}

/**
 * Force-send progress (bypass throttle).
 */
async function reportProgressForce(callbackUrl, data) {
  if (!callbackUrl) return null;
  const key = data.bookId || 'unknown';
  lastReportTimes.set(key, Date.now());

  try {
    const res = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify(data),
    });
    const body = await res.json().catch(() => null);
    return body;
  } catch (err) {
    console.warn(`[ProgressReporter] Failed to report progress for ${key}:`, err.message);
    return null;
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
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
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
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ ...data, success: false }),
    });
    console.log(`[ProgressReporter] Reported error for ${data.bookId}`);
  } catch (err) {
    console.error(`[ProgressReporter] Failed to report error for ${data.bookId}:`, err.message);
  }
}

function clearThrottle(bookId) {
  if (bookId) lastReportTimes.delete(bookId);
}

module.exports = { reportProgress, reportProgressForce, reportComplete, reportError, clearThrottle };
