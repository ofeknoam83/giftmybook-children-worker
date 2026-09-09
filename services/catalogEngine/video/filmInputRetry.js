const storage = require('../../gcsStorage');
const { digest } = require('../../shared/llm/visualJudge');
const { pending } = require('../illustrator/referenceContract');

async function read(key) {
  try { return await storage.downloadBuffer(key); }
  catch (err) { if (Number(err.code) === 404) return null; throw err; }
}
async function json(key) {
  const bytes = await read(key);
  if (!bytes) return null;
  if (bytes.length > 50000) throw new Error('Saved input retry record exceeds the size limit');
  return JSON.parse(bytes.toString());
}
function rootFor(bookId, evidenceKey) {
  const prefix = `children-jobs/${bookId}/gift-video/inputs/`;
  if (typeof bookId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(bookId)
    || typeof evidenceKey !== 'string' || !evidenceKey.startsWith(prefix)
    || !/^gfi-1\/[a-f0-9]{24}$/.test(evidenceKey.slice(prefix.length))) {
    throw Object.assign(new Error('Invalid saved video input'), { status: 400 });
  }
  return evidenceKey;
}
function reject(message) { throw Object.assign(new Error(message), { status: 409 }); }

// An explicit admin action grants exactly one extra slot in this input's
// existing namespace. Repeated clicks cannot renew or enlarge that grant.
async function grantFilmInputRetry({ bookId, evidenceKey, requestedBy }) {
  const root = rootFor(bookId, evidenceKey);
  if (typeof requestedBy !== 'string' || !requestedBy.trim() || requestedBy.length > 320) {
    throw Object.assign(new Error('Admin identity required'), { status: 400 });
  }
  let id;
  for (let n = 0; n < 2; n++) {
    const key = `${root}/candidate-${n}`;
    const claim = await json(`${key}.json`);
    const failure = await json(`${key}.failure.json`);
    if (await read(`${key}.png`)) reject('This input already has a saved image; resume saved work');
    const recovery = failure?.recovery;
    if (!claim || typeof claim.id !== 'string' || !/^[a-f0-9]{64}$/.test(claim.id)
      || (id && claim.id !== id) || recovery?.retryable !== true
      || recovery.reason !== 'verification_unavailable' || !Array.isArray(recovery.issues)
      || !recovery.issues.length || recovery.issues.some(issue => issue?.status !== 'transient' || issue?.promptBlock || issue?.finishReason)) {
      reject('Only two recorded transient input failures are eligible; inspect saved evidence');
    }
    id = claim.id;
  }
  const extra = `${root}/candidate-2`;
  if (await read(`${extra}.png`)) return { ok: true, alreadyCompleted: true };
  if (await read(`${extra}.json`) || await read(`${extra}.failure.json`)) {
    reject('The additional input attempt has already been used; inspect saved evidence');
  }
  const grantKey = `${root}/manual-retry.json`;
  await storage.uploadBufferIfAbsent(Buffer.from(JSON.stringify({ version: 1, id, limit: 3,
    requestedBy, requestedAt: new Date().toISOString() })), grantKey, 'application/json');
  const grant = await json(grantKey);
  if (grant?.version !== 1 || grant.id !== id || grant.limit !== 3) reject('Saved input retry grant does not match');
  return { ok: true };
}

async function filmInputAttemptLimit(root, identity) {
  try {
    const grant = await json(`${root}/manual-retry.json`);
    if (!grant) return 2;
    if (grant.version !== 1 || grant.limit !== 3 || grant.id !== digest(identity)) throw new Error('Input retry identity mismatch');
    return 3;
  } catch (err) {
    throw pending('Video input retry state unavailable; saved work is retained.',
      { status: 'configuration', reason: 'Cannot verify the saved input retry allowance', evidenceKey: root }, 'scene_generation');
  }
}

module.exports = { grantFilmInputRetry, filmInputAttemptLimit };
