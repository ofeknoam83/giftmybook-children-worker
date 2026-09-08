const storage = require('../../gcsStorage');
const { digest } = require('../../shared/llm/visualJudge');
const { pending } = require('./referenceContract');
async function read(key) {
  try { return await storage.downloadBuffer(key); }
  catch (err) { if (err.code === 404 || /not found|No such object|cache miss|no marker/i.test(err.message)) return null; throw err; }
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
          const buffer = await generate(`${key}.png`);
          await storage.uploadBufferIfAbsent(buffer, `${key}.png`, 'image/png');
          return buffer;
        }
        claimBytes = await read(`${key}.json`);
      }
      const claim = JSON.parse(claimBytes.toString());
      if (claim.id !== id) continue;
      const buffer = await read(`${key}.png`);
      if (buffer) { costTracker?.recordReuse?.('image'); return buffer; }
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
