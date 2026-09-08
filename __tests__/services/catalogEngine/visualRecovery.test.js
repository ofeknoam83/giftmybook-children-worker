jest.mock('../../../services/gcsStorage', () => ({ downloadBuffer: jest.fn(), uploadBufferIfAbsent: jest.fn(), uploadBuffer: jest.fn() }));
jest.mock('../../../services/illustrationGenerator', () => ({ getNextApiKey: () => 'test-key', fetchWithTimeout: jest.fn() }));
const storage = require('../../../services/gcsStorage');
const { fetchWithTimeout: fetch } = require('../../../services/illustrationGenerator');
const { judgeImage, recoveryFor } = require('../../../services/shared/llm/visualJudge');
const { referenceRules, resolveReferenceContract } = require('../../../services/catalogEngine/illustrator/referenceContract');
const { durableCandidate } = require('../../../services/catalogEngine/illustrator/durableCandidate');
const { spreadDependencies } = require('../../../services/catalogEngine/illustrator/visualDependencies');
const files = new Map();
const { createHmac } = require('crypto');
const { handleReview } = require('../../../services/shared/llm/visualReview');
const ok = json => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }) });
const opts = () => ({ parts: [{ text: 'Check all identity, count, state and scene-quality requirements' }, { inline_data: { mimeType: 'image/png', data: 'c2NlbmU=' } }], model: 'gemini-test', recoveryRoot: 'children-jobs/test/qa', label: 'test', validate: j => typeof j?.pass === 'boolean' ? null : 'pass must be boolean' });
beforeEach(() => {
  jest.clearAllMocks(); files.clear();
  delete process.env.CATALOG_QA_SECONDARY_MODEL;
  delete process.env.VISUAL_REVIEW_SECRET;
  storage.downloadBuffer.mockImplementation(async k => { if (files.has(k)) return files.get(k); throw Object.assign(new Error('not found'), { code: 404 }); });
  storage.uploadBuffer.mockImplementation(async (b, k) => { files.set(k, b); });
  storage.uploadBufferIfAbsent.mockImplementation(async (b, k) => { if (files.has(k)) return { created: false }; files.set(k, b); return { created: true }; });
  fetch.mockResolvedValue(ok({ pass: true }));
});

function approval(result, over = {}) {
  const bookId = '6979a16e-d8c9-42af-a09e-f8874c3f7e97';
  const payload = JSON.stringify({ version: 1, audience: 'children-visual-review', bookId,
    adminId: 'admin-1', reviewedBy: 'reviewer@giftmybook.com', decision: 'benign_verification',
    fingerprint: result.fingerprint, evidenceKey: result.evidenceKey, provider: 'gemini', model: 'gemini-2.5-pro', expiresAt: Date.now() + 60000, ...over });
  return { payload, signature: createHmac('sha256', process.env.VISUAL_REVIEW_SECRET).update(payload).digest('hex') };
}
test('reviewed fallback uses the identical full evidence and schema, then reuses its result', async () => {
  process.env.VISUAL_REVIEW_SECRET = 's'.repeat(40); process.env.CATALOG_QA_SECONDARY_MODEL = 'gemini-2.5-pro';
  const p = { ...opts(), recoveryRoot: 'children-jobs/6979a16e-d8c9-42af-a09e-f8874c3f7e97/qa' };
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] }) }).mockResolvedValue(ok({ pass: true }));
  const blocked = await judgeImage(p);
  await expect(handleReview(approval(blocked))).resolves.toMatchObject({ approved: true, model: 'gemini-2.5-pro' });
  const result = await judgeImage(p);
  expect(result).toMatchObject({ status: 'verified', model: 'gemini-2.5-pro' });
  expect(fetch.mock.calls[1][0]).toContain('/gemini-2.5-pro:generateContent');
  expect(JSON.parse(fetch.mock.calls[1][1].body).contents[0].parts).toEqual(p.parts);
  await judgeImage(p);
  expect(fetch).toHaveBeenCalledTimes(2);
});
test.each(['signature', 'model', 'bookId', 'expiresAt', 'fingerprint'])('rejects an approval with invalid %s', async field => {
  process.env.VISUAL_REVIEW_SECRET = 's'.repeat(40); process.env.CATALOG_QA_SECONDARY_MODEL = 'gemini-2.5-pro';
  const p = { ...opts(), recoveryRoot: 'children-jobs/6979a16e-d8c9-42af-a09e-f8874c3f7e97/qa' };
  const result = await judgeImage(p);
  const values = { model: 'another-model', bookId: '11111111-1111-1111-1111-111111111111', expiresAt: Date.now() - 1, fingerprint: 'a'.repeat(64) };
  const token = approval(result, field === 'signature' ? {} : { [field]: values[field] });
  if (field === 'signature') token.signature = '0'.repeat(64);
  await expect(handleReview(token)).rejects.toThrow();
  expect([...files.keys()].some(k => k.endsWith('/review.json'))).toBe(false);
});
test('a secondary refusal stops without another model or modified evidence', async () => {
  process.env.VISUAL_REVIEW_SECRET = 's'.repeat(40); process.env.CATALOG_QA_SECONDARY_MODEL = 'gemini-2.5-pro';
  const p = { ...opts(), recoveryRoot: 'children-jobs/6979a16e-d8c9-42af-a09e-f8874c3f7e97/qa' };
  fetch.mockResolvedValue({ ok: true, json: async () => ({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }) });
  const result = await judgeImage(p); await handleReview(approval(result));
  expect(await judgeImage(p)).toMatchObject({ status: 'provider_blocked', model: 'gemini-2.5-pro' });
  await judgeImage(p);
  expect(fetch).toHaveBeenCalledTimes(2);
});
test('a provider block is saved once and stays unavailable across repeated dispatches', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ candidates: [{ finishReason: 'PROHIBITED_CONTENT' }], responseId: 'saved-id' }) });
  const first = await judgeImage(opts());
  expect(first).toMatchObject({ status: 'provider_blocked', finishReason: 'PROHIBITED_CONTENT' });
  expect(await judgeImage(opts())).toMatchObject({ status: 'provider_blocked', cached: true });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(recoveryFor([first])).toMatchObject({ retryable: false, nextAction: 'review_provider_block' });
  expect(JSON.parse(files.get(first.evidenceKey))).toMatchObject({ parts: opts().parts });
});
test('malformed response gets one complete recheck of identical evidence, then a durable stop', async () => {
  fetch.mockResolvedValue(ok({}));
  expect(await judgeImage(opts())).toMatchObject({ status: 'malformed', exhausted: true });
  await judgeImage(opts());
  expect(fetch).toHaveBeenCalledTimes(2);
  const second = JSON.parse(fetch.mock.calls[1][1].body);
  expect(second.contents[0].parts.slice(0, 2)).toEqual(opts().parts);
  expect(second.safetySettings).toBeUndefined();
});
test('503 backs off until a later dispatch, then reuses a verified verdict', async () => {
  fetch.mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValue(ok({ pass: true }));
  expect(await judgeImage(opts())).toMatchObject({ status: 'transient' });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await judgeImage(opts())).toMatchObject({ status: 'verified' });
  expect(await judgeImage(opts())).toMatchObject({ status: 'verified', cached: true });
  expect(fetch).toHaveBeenCalledTimes(2);
});
test('storage failure prevents untracked verifier spending', async () => {
  storage.uploadBufferIfAbsent.mockRejectedValue(new Error('storage outage'));
  expect(await judgeImage(opts())).toMatchObject({ status: 'configuration' });
  expect(fetch).not.toHaveBeenCalled();
});
test('confirmed defects and changed evidence cannot reuse a passing judgment', async () => {
  fetch.mockResolvedValueOnce(ok({ pass: false })).mockResolvedValue(ok({ pass: true }));
  expect((await judgeImage(opts())).json.pass).toBe(false);
  expect((await judgeImage({ ...opts(), parts: [{ text: 'changed image or rules' }] })).json.pass).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(recoveryFor([{ status: 'confirmed_defect' }]).retryable).toBe(false);
});
test.each(['single', 'group', 'assembly', 'scene'])('%s references retain their explicit representation without another classifier', async kind => {
  const reference = { kind, subject: kind === 'group' ? 'creature' : 'object', description: 'Grounded in the frozen story design' };
  expect(await resolveReferenceContract({ reference })).toEqual(reference);
  expect(referenceRules(reference)).toContain(JSON.stringify(reference));
  expect(fetch).not.toHaveBeenCalled();
});
test('a group is one coherent view, assemblies allow parts and scenes preserve context', () => {
  expect(referenceRules({ kind: 'group' })).toContain('Multiple members are required');
  expect(referenceRules({ kind: 'assembly' })).toContain('Components are not unwanted');
  expect(referenceRules({ kind: 'scene' })).toContain('Reflections are not extra physical objects');
});
test('candidate reservations reuse saved pixels and cap spending across restarts', async () => {
  const generate = jest.fn(async () => Buffer.from('candidate'));
  const run = identity => durableCandidate({ root: 'images/test', identity, generate, limit: 2 });
  await run('one'); await run('one'); await run('two');
  await expect(run('three')).rejects.toMatchObject({ failureCode: 'visual_recovery_pending', recovery: { retryable: false } });
  expect(generate).toHaveBeenCalledTimes(2);
});
test('a settled image failure consumes its slot and retries without a false in-progress lease', async () => {
  const generate = jest.fn().mockRejectedValueOnce(new Error('interrupted')).mockResolvedValue(Buffer.from('recovered'));
  const run = () => durableCandidate({ root: 'images/test', identity: 'one', generate, limit: 2 });
  await expect(run()).rejects.toMatchObject({ recovery: { retryable: true } });
  expect(files.has('images/test/candidate-0.failure.json')).toBe(true);
  expect(await run()).toEqual(Buffer.from('recovered'));
  expect(generate).toHaveBeenCalledTimes(2);
});
test('a live image reservation still prevents duplicate paid generation', async () => {
  const { digest } = require('../../../services/shared/llm/visualJudge');
  files.set('images/test/candidate-0.json', Buffer.from(JSON.stringify({ id: digest('one'), at: Date.now() })));
  const generate = jest.fn(async () => Buffer.from('recovered'));
  const run = () => durableCandidate({ root: 'images/test', identity: 'one', generate, limit: 2 });
  await expect(run()).rejects.toMatchObject({ recovery: { retryable: true, issues: [expect.objectContaining({ reason: 'Illustration generation in progress' })] } });
  expect(generate).not.toHaveBeenCalled();
  const claim = JSON.parse(files.get('images/test/candidate-0.json')); claim.at -= 20 * 60000;
  files.set('images/test/candidate-0.json', Buffer.from(JSON.stringify(claim)));
  expect(await run()).toEqual(Buffer.from('recovered'));
  expect(generate).toHaveBeenCalledTimes(1);
});
test('saved provider blocks are not retried as failed illustration slots', async () => {
  const { pending } = require('../../../services/catalogEngine/illustrator/referenceContract');
  const generate = jest.fn().mockRejectedValue(pending('Blocked', { status: 'provider_blocked', reason: 'PROHIBITED_CONTENT' }));
  const run = () => durableCandidate({ root: 'images/test', identity: 'one', generate, limit: 3 });
  await expect(run()).rejects.toMatchObject({ recovery: { retryable: false, reason: 'provider_blocked' } });
  await expect(run()).rejects.toMatchObject({ recovery: { retryable: false, reason: 'provider_blocked' } });
  expect(generate).toHaveBeenCalledTimes(1);
});
test('repeated completed failures cannot reset the durable generation budget', async () => {
  const generate = jest.fn().mockRejectedValue(new Error('transport error'));
  const run = () => durableCandidate({ root: 'images/test', identity: 'one', generate, limit: 2 });
  await expect(run()).rejects.toHaveProperty('recovery');
  await expect(run()).rejects.toHaveProperty('recovery');
  await expect(run()).rejects.toMatchObject({ recovery: { retryable: false } });
  expect(generate).toHaveBeenCalledTimes(2);
});
test('raw generator refusal diagnostics are preserved instead of becoming automatic retries', async () => {
  const generate = jest.fn().mockRejectedValue(Object.assign(new Error('No image returned'), { attempts: [{ finishReason: 'PROHIBITED_CONTENT', nsfw: true }] }));
  const run = () => durableCandidate({ root: 'images/test', identity: 'one', generate, limit: 3 });
  await expect(run()).rejects.toMatchObject({ recovery: { retryable: false, reason: 'provider_blocked' } });
  await expect(run()).rejects.toMatchObject({ recovery: { retryable: false, reason: 'provider_blocked' } });
  expect(generate).toHaveBeenCalledTimes(1);
});
test('changing an object invalidates only the spreads that depend on it', () => {
  const bible = { manifest: { props: [], anchorHash: 'child' }, storyObjects: { objects: [{ id: 'box', name: 'box', design: 'red', occurrences: [{ spread: 1, state: 'closed' }] }] } };
  const before = [1, 2].map(s => spreadDependencies(bible, s));
  bible.storyObjects.objects[0].design = 'blue';
  expect(spreadDependencies(bible, 1)).not.toEqual(before[0]);
  expect(spreadDependencies(bible, 2)).toEqual(before[1]);
  bible.manifest.anchorHash = 'different-child';
  expect(spreadDependencies(bible, 2)).not.toEqual(before[1]);
});
