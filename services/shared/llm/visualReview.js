const { createHmac, timingSafeEqual } = require('crypto');
const storage = require('../../gcsStorage');
const destination = () => process.env.CATALOG_QA_SECONDARY_MODEL === 'gemini-2.5-pro' ? 'gemini-2.5-pro' : null;
function verifyApproval(token, { expired = false } = {}) {
  const secret = process.env.VISUAL_REVIEW_SECRET;
  if (!secret || secret.length < 32 || !destination()) throw new Error('Visual review is not configured');
  if (!token || typeof token.payload !== 'string' || typeof token.signature !== 'string') throw new Error('Signed admin approval required');
  const expected = createHmac('sha256', secret).update(token.payload).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(token.signature)) throw new Error('Invalid admin approval');
  const expectedBytes = Buffer.from(expected, 'hex');
  const signatureBytes = Buffer.from(token.signature, 'hex');
  if (signatureBytes.length !== expectedBytes.length || !timingSafeEqual(signatureBytes, expectedBytes)) throw new Error('Invalid admin approval');
  const claim = JSON.parse(token.payload);
  if (claim.version !== 1 || claim.audience !== 'children-visual-review' || claim.provider !== 'gemini' || claim.model !== destination()
    || !['inspect', 'benign_verification'].includes(claim.decision) || !claim.adminId || !claim.reviewedBy
    || !/^[a-f0-9-]{36}$/.test(claim.bookId) || !/^[a-f0-9]{64}$/.test(claim.fingerprint)
    || typeof claim.evidenceKey !== 'string' || !claim.evidenceKey.endsWith(`/${claim.fingerprint}/request.json`)
    || !Number.isFinite(claim.expiresAt) || (!expired && (claim.expiresAt < Date.now() || claim.expiresAt > Date.now() + 16 * 60000))) throw new Error('Approval does not match the permitted review');
  if (claim.evidenceKey.includes('..') || !(claim.evidenceKey.startsWith(`children-jobs/${claim.bookId}/`) || claim.evidenceKey.startsWith('catalog-assets/'))) throw new Error('Evidence outside the approved scope');
  return claim;
}
async function handleReview(token) {
  const claim = verifyApproval(token);
  const root = claim.evidenceKey.slice(0, -'/request.json'.length);
  const request = JSON.parse((await storage.downloadBuffer(claim.evidenceKey)).toString());
  const { digest, VERSION } = require('./visualJudge');
  if (request.version !== VERSION || request.fingerprint !== claim.fingerprint || digest({ version: VERSION, model: request.model, parts: request.parts }) !== claim.fingerprint || request.model === claim.model) throw new Error('Evidence changed or destination is not secondary');
  let blocked = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const bytes = await storage.downloadBuffer(`${root}/attempt-${attempt}.result.json`).catch(err => {
      if (err.code === 404 || /not found|No such object/i.test(err.message)) return null;
      throw err;
    });
    if (bytes && JSON.parse(bytes.toString()).status === 'provider_blocked') blocked = true;
  }
  if (!blocked) throw new Error('Only a saved provider block can be reviewed');
  if (claim.decision === 'inspect') return { fingerprint: claim.fingerprint, provider: claim.provider, model: claim.model, parts: request.parts };
  await storage.uploadBufferIfAbsent(Buffer.from(JSON.stringify(token)), `${root}/review.json`, 'application/json');
  return { approved: true, fingerprint: claim.fingerprint, provider: claim.provider, model: claim.model };
}
module.exports = { verifyApproval, handleReview };
