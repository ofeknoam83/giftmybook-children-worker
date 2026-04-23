/**
 * Structured retry memory for the new pipeline.
 *
 * Each stage that fails QA and retries MUST record a structured entry so
 * later attempts can be told exactly what to change and what to keep.
 * Free-form "you failed, try again" instructions are banned by contract.
 */

/**
 * @typedef {Object} RetryMemoryEntry
 * @property {string} stage - e.g. 'storyBible', 'writer', 'spreadRender'
 * @property {number|null} spreadNumber - 1-based, or null for book-wide stages
 * @property {number} failedAttemptNumber - 1-based count of prior failures in this stage/spread
 * @property {string[]} failureTags - machine tags ('extra_text', 'hero_identity_drift', ...)
 * @property {string[]} mustChange - plain-English directives for the next attempt
 * @property {string[]} mustPreserve - things that were fine and must stay
 * @property {string[]} bannedRepeats - literal patterns that must NOT recur
 */

/**
 * Build a new retry memory entry.
 *
 * @param {Partial<RetryMemoryEntry>} entry
 * @returns {RetryMemoryEntry}
 */
function buildRetryEntry(entry) {
  return {
    stage: entry.stage || 'unknown',
    spreadNumber: entry.spreadNumber ?? null,
    failedAttemptNumber: entry.failedAttemptNumber || 1,
    failureTags: Array.isArray(entry.failureTags) ? entry.failureTags : [],
    mustChange: Array.isArray(entry.mustChange) ? entry.mustChange : [],
    mustPreserve: Array.isArray(entry.mustPreserve) ? entry.mustPreserve : [],
    bannedRepeats: Array.isArray(entry.bannedRepeats) ? entry.bannedRepeats : [],
  };
}

/**
 * Filter retry memory for a given stage and optional spread.
 * @param {RetryMemoryEntry[]} memory
 * @param {string} stage
 * @param {number|null} [spreadNumber]
 * @returns {RetryMemoryEntry[]}
 */
function selectRetryMemory(memory, stage, spreadNumber = null) {
  return memory.filter(m => m.stage === stage && (spreadNumber == null || m.spreadNumber === spreadNumber));
}

/**
 * Render retry memory entries into a compact prompt block. Intended to be
 * injected directly into the next attempt's user prompt. Returns empty
 * string if there is nothing to say.
 *
 * @param {RetryMemoryEntry[]} entries
 * @returns {string}
 */
function renderRetryMemoryForPrompt(entries) {
  if (!entries || entries.length === 0) return '';
  const lines = ['Prior attempts failed. Each next attempt MUST materially differ from these failures:'];
  for (const e of entries) {
    lines.push(`- attempt ${e.failedAttemptNumber} (${e.failureTags.join(', ') || 'unspecified'}):`);
    if (e.mustChange.length) lines.push(`  must change: ${e.mustChange.join(' | ')}`);
    if (e.mustPreserve.length) lines.push(`  must preserve: ${e.mustPreserve.join(' | ')}`);
    if (e.bannedRepeats.length) lines.push(`  banned repeats: ${e.bannedRepeats.join(' | ')}`);
  }
  return lines.join('\n');
}

module.exports = {
  buildRetryEntry,
  selectRetryMemory,
  renderRetryMemoryForPrompt,
};
