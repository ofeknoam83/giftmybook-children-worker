const storage = require('../../gcsStorage');
const { digest, responseOutcome } = require('../../shared/llm/visualJudge');
const { pending } = require('./referenceContract');
async function read(key) {
  try { return await storage.downloadBuffer(key); }
  catch (err) { if (err.code === 404 || /not found|No such object|cache miss|no marker/i.test(err.message)) return null; throw err; }
}
/** Preserve a generator's refusal evidence before classifying an ordinary
 * failed attempt as retryable. A retry never routes around a provider block.
 * @param {Error} err
 * @param {string} root
 * @returns {Error}
 */
function generationFailure(err, root) {
  if (err.recovery) return err;
  const attempts = [...(err.attempts || []), ...(err.geminiDetail ? [err.geminiDetail] : [])];
  for (const attempt of attempts) {
    const outcome = responseOutcome({ promptFeedback: { blockReason: attempt.blockReason }, candidates: [{ finishReason: attempt.finishReason }] });
    if (outcome?.status === 'provider_blocked' || attempt.nsfw) return pending('Illustration provider blocked generation; inspect the saved attempt.',
      { ...outcome, status: 'provider_blocked', reason: 'Illustration provider blocked generation', evidenceKey: root }, 'scene_generation');
  }
  if (err.isNsfw) return pending('Illustration provider blocked generation; inspect the saved attempt.', { status: 'provider_blocked', reason: 'Illustration provider blocked generation', evidenceKey: root }, 'scene_generation');
  return pending('Illustration attempt failed; saved work can resume with the remaining attempts.',
    { status: 'transient', reason: 'Illustration attempt failed', evidenceKey: root }, 'scene_generation');
}
// Reserve before spending. Candidate slots survive process restarts, checker
// outages and simultaneous retries; a lost renderer never gets an unlimited
// fresh budget. Explicitly new artwork has a different dependency namespace.
async function durableCandidate({ root, identity, limit = 3, generate, costTracker }) {
  const id = digest(identity);
  try {
    for (let n = 0; n < limit; n++) {
      const key = `${root}/candidate-${n}`;
      let claimBytes = await read(`${key}.json`);
      if (!claimBytes) {
        const claim = { id, at: Date.now() };
        const elected = await storage.uploadBufferIfAbsent(Buffer.from(JSON.stringify(claim)), `${key}.json`, 'application/json');
        if (elected.created) {
          let buffer;
          try { buffer = await generate(`${key}.png`); }
          catch (err) {
            // A returned failure is no longer running. Consume this slot, but
            // let a later dispatch use the next slot without a false lease wait.
            // Explicit provider blocks/configuration holds retain their verdict.
            const failure = generationFailure(err, root);
            await storage.uploadBufferIfAbsent(Buffer.from(JSON.stringify({ recovery: failure.recovery })), `${key}.failure.json`, 'application/json');
            throw failure;
          }
          await storage.uploadBufferIfAbsent(buffer, `${key}.png`, 'image/png');
          return buffer;
        }
        claimBytes = await read(`${key}.json`);
      }
      const claim = JSON.parse(claimBytes.toString());
      if (claim.id !== id) continue;
      const buffer = await read(`${key}.png`);
      if (buffer) { costTracker?.recordReuse?.('image'); return buffer; }
      const failed = await read(`${key}.failure.json`);
      if (failed) {
        const { recovery } = JSON.parse(failed.toString());
        if (!recovery?.retryable) {
          const err = pending('Illustration attempt needs review; saved work is retained.', recovery?.issues?.[0] || { status: 'configuration', reason: 'Saved illustration failure is unavailable' }, 'scene_generation');
          if (recovery) err.recovery = recovery;
          throw err;
        }
        continue;
      }
      if (Date.now() - claim.at < 15 * 60000) throw pending('An illustration attempt is already reserved; saved work is retained.', { status: 'transient', reason: 'Illustration generation in progress', evidenceKey: root }, 'scene_generation');
      // An interrupted slot counts against the total, but another reserved
      // slot may finish the same request on a later, backed-off dispatch.
    }
    throw pending('Illustration attempt budget reached; review saved candidates.', { status: 'exhausted', reason: 'No approved candidate within the saved attempt budget', exhausted: true, evidenceKey: root }, 'scene_generation');
  } catch (err) {
    if (err.recovery) throw err;
    throw pending('Illustration recovery is waiting; saved work retained.', { status: 'configuration', reason: 'Candidate storage or generation unavailable', evidenceKey: root }, 'scene_generation');
  }
}
module.exports = { durableCandidate };
