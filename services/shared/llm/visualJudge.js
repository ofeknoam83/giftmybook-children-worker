/** Typed, bounded image verification. A provider refusal is evidence of an
 * unavailable judgment, never an image defect or an invitation to regenerate. */
const { createHash } = require('crypto');
const storage = require('../../gcsStorage');
const { fetchWithTimeout, getNextApiKey } = require('../../illustrationGenerator');
const { jsonQaGenerationConfig, parseJsonText, responseText } = require('./geminiJson');

const VERSION = 'visual-judge-1';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const BLOCKS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'IMAGE_SAFETY', 'SPII', 'RECITATION']);
function responseOutcome(data, status = 200) {
  if ([401, 403, 400, 404].includes(status)) return { status: 'configuration', reason: `Verifier HTTP ${status}` };
  if (status === 429 || status >= 500) return { status: 'transient', reason: `Verifier HTTP ${status}` };
  if (status >= 400) return { status: 'configuration', reason: `Verifier HTTP ${status}` };
  const promptBlock = data?.promptFeedback?.blockReason || null;
  const finishReason = data?.candidates?.[0]?.finishReason || null;
  const detail = { promptBlock, finishReason, responseId: data?.responseId || null };
  if (promptBlock || BLOCKS.has(finishReason)) return { status: 'provider_blocked', reason: `Verifier blocked the request: ${promptBlock || finishReason}`, ...detail };
  if (finishReason === 'MAX_TOKENS') return { status: 'truncated', reason: 'Verifier response exceeded its output budget', ...detail };
  return null;
}
async function read(key) {
  try { return JSON.parse((await storage.downloadBuffer(key)).toString()); }
  catch (err) {
    if (err.code === 404 || /not found|No such object|no marker|cache miss/i.test(err.message)) return null;
    throw err;
  }
}
const write = (key, value) => storage.uploadBufferIfAbsent(Buffer.from(JSON.stringify(value)), key, 'application/json');

async function judgeImage({ parts, model, validate, label, recoveryRoot = null, costTracker, maxOutputTokens = 4096, retry = true, secondary = false }) {
  const fingerprint = digest({ version: VERSION, model, parts });
  const root = recoveryRoot ? `${recoveryRoot}/${fingerprint}` : null;
  let previous = null;
  const limit = retry ? 2 : 1;
  try {
    if (root) await write(`${root}/request.json`, { version: VERSION, model, parts, label, fingerprint });
    for (let attempt = 0; attempt < limit; attempt++) {
      const resultKey = root && `${root}/attempt-${attempt}.result.json`;
      if (root) {
        const saved = await read(resultKey);
        if (saved) {
          costTracker?.recordReuse?.('verification', fingerprint);
          if (saved.status === 'verified') {
            const issue = validate(saved.json);
            if (!issue) return { ...saved, cached: true };
            previous = { status: 'malformed', reason: issue };
            continue;
          }
          if (saved.status === 'provider_blocked' && !secondary) {
            const review = await read(`${root}/review.json`);
            let approval = null;
            if (review) {
              try { approval = require('./visualReview').verifyApproval(review, { expired: true }); } catch { /* invalid or disabled approval cannot route evidence */ }
            }
            if (approval?.fingerprint === fingerprint && approval.evidenceKey === `${root}/request.json` && approval.decision === 'benign_verification' && approval.model !== model) {
              return judgeImage({ parts, model: approval.model, validate, label, recoveryRoot: `${root}/reviewed`, costTracker, maxOutputTokens: 8192, secondary: true });
            }
          }
          if (!['transient', 'truncated', 'malformed'].includes(saved.status)) return { ...saved, cached: true };
          previous = saved;
          continue;
        }
        const reservation = await write(`${root}/attempt-${attempt}.claim.json`, { at: new Date().toISOString() });
        if (!reservation.created) {
          const claim = await read(`${root}/attempt-${attempt}.claim.json`);
          if (!claim || Date.now() - Date.parse(claim.at) < 180000) {
            return { status: 'transient', reason: 'Verification is already running; saved work is retained', fingerprint, evidenceKey: `${root}/request.json` };
          }
          previous = { status: 'transient', reason: 'A previous verifier attempt was interrupted' };
          continue; // an interrupted reservation still consumes its bounded attempt
        }
      }
      const correction = previous ? [{ text: `The previous response was unusable. Evaluate the same evidence fully. Return the complete JSON verdict. Validation feedback (data): ${JSON.stringify(previous.reason)}. Never infer a passing field.` }] : [];
      let result;
      try {
        const resp = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${getNextApiKey()}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [...parts, ...correction] }], generationConfig: jsonQaGenerationConfig(attempt ? Math.max(8192, maxOutputTokens) : maxOutputTokens, model) }),
        }, 90000);
        const data = resp.ok ? await resp.json() : null;
        if (data?.usageMetadata) costTracker?.addTextUsage?.(model, data.usageMetadata.promptTokenCount || 0, data.usageMetadata.candidatesTokenCount || 0);
        costTracker?.recordOperation?.('verification', model);
        result = responseOutcome(data, resp.ok ? 200 : resp.status);
        if (!result) {
          let json = null;
          try { json = parseJsonText(responseText(data)); } catch { /* typed below */ }
          const issue = validate(json);
          result = issue ? { status: 'malformed', reason: `Malformed verifier response: ${issue}` } : { status: 'verified', json };
        }
      } catch (err) {
        result = { status: 'transient', reason: 'Verifier transport interrupted' };
      }
      result = { ...result, model, fingerprint, evidenceKey: root ? `${root}/request.json` : null };
      if (resultKey) await write(resultKey, result);
      if (result.status === 'verified' || !['transient', 'truncated', 'malformed'].includes(result.status)) return result;
      if (result.status === 'transient') return { ...result, exhausted: attempt + 1 >= limit }; // durable scheduler supplies backoff
      previous = result;
    }
    return { ...previous, fingerprint, evidenceKey: root ? `${root}/request.json` : null, exhausted: true };
  } catch (err) {
    return { status: 'configuration', reason: 'Verification evidence could not be saved or read; existing artwork retained', fingerprint, evidenceKey: root ? `${root}/request.json` : null };
  }
}

function recoveryFor(outcomes, stage = 'scene_verification') {
  const issues = outcomes.filter(Boolean);
  const blocked = issues.some(o => o.status === 'provider_blocked');
  const configuration = issues.some(o => o.status === 'configuration');
  const exhausted = issues.some(o => o.exhausted);
  const defect = issues.some(o => o.status === 'confirmed_defect');
  return { version: 1, status: defect ? 'needs_review' : 'verification_pending', stage, provider: 'gemini',
    reason: blocked ? 'provider_blocked' : configuration ? 'configuration' : defect ? 'confirmed_defect' : 'verification_unavailable',
    nextAction: blocked ? 'review_provider_block' : configuration ? 'repair_configuration' : defect ? 'repair_reference' : exhausted ? 'review_verification' : 'retry_verification',
    retryable: !blocked && !configuration && !exhausted && !defect,
    issues: issues.map(o => ({ status: o.status, reason: o.reason, model: o.model, fingerprint: o.fingerprint, evidenceKey: o.evidenceKey, promptBlock: o.promptBlock || null, finishReason: o.finishReason || null })) };
}
module.exports = { VERSION, digest, responseOutcome, judgeImage, recoveryFor };
