/**
 * Vision client for bookPipelineV3 — role-routed multimodal calls
 * (image(s) in, text/JSON out) for the native illustrator's judges and
 * the art director (milestone 2).
 *
 * Families:
 *   gemini — generativelanguage generateContent with inline_data parts
 *            (same wire shape faceEngine uses)
 *   openai — chat/completions with image_url data-URI content parts
 *
 * Anthropic/deepseek are not wired for vision — deepseek has no vision
 * API and anthropic stays an A/B option for TEXT roles only. A role
 * override that routes a vision role to an unsupported family fails
 * loudly (no silent family swap — same principle as callWithRole).
 */

const { modelFor } = require('./modelRouter');
const { parseJsonLoose, LlmParseError, fetchWithTimeout } = require('../../shared/llm/openaiClient');

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_ATTEMPTS = 3;

class VisionTransientError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VisionTransientError';
    this.isTransient = true;
  }
}

function isTransientStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function resolveGeminiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_STUDIO_KEY || null;
}

async function callGeminiVision({ model, prompt, images, timeoutMs, abortSignal }) {
  const apiKey = resolveGeminiKey();
  if (!apiKey) throw new Error('visionClient: no GEMINI_API_KEY / GOOGLE_AI_STUDIO_KEY set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const parts = [{ text: prompt }];
  for (const img of images) {
    parts.push({ inline_data: { mime_type: img.mimeType || 'image/jpeg', data: img.base64 } });
  }
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }] }),
    signal: abortSignal,
  }, timeoutMs);
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = isTransientStatus(resp.status)
      ? new VisionTransientError(`gemini vision ${resp.status}: ${body.slice(0, 300)}`)
      : new Error(`gemini vision ${resp.status}: ${body.slice(0, 300)}`);
    throw err;
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('\n') || '';
  const usage = data?.usageMetadata
    ? { inputTokens: data.usageMetadata.promptTokenCount || 0, outputTokens: data.usageMetadata.candidatesTokenCount || 0 }
    : null;
  return { text, usage };
}

async function callOpenAiVision({ model, prompt, images, timeoutMs, abortSignal }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('visionClient: no OPENAI_API_KEY set');
  const content = [{ type: 'text', text: prompt }];
  for (const img of images) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}` },
    });
  }
  const resp = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }] }),
    signal: abortSignal,
  }, timeoutMs);
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = isTransientStatus(resp.status)
      ? new VisionTransientError(`openai vision ${resp.status}: ${body.slice(0, 300)}`)
      : new Error(`openai vision ${resp.status}: ${body.slice(0, 300)}`);
    throw err;
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content || '';
  const usage = data?.usage
    ? { inputTokens: data.usage.prompt_tokens || 0, outputTokens: data.usage.completion_tokens || 0 }
    : null;
  return { text, usage };
}

const FAMILY_DISPATCH = {
  gemini: callGeminiVision,
  openai: callOpenAiVision,
};

/**
 * Call a vision-capable role with images.
 *
 * @param {string} role - modelRouter role (QA_VISION, LIKENESS_JUDGE_A/B, ART_DIRECTOR)
 * @param {object} params
 * @param {string} params.prompt
 * @param {Array<{base64: string, mimeType?: string}>} params.images
 * @param {string} [params.label] - Cloud Logging label
 * @param {boolean} [params.expectJson] - parse the reply with parseJsonLoose
 * @param {number} [params.timeoutMs]
 * @param {AbortSignal} [params.abortSignal]
 * @returns {Promise<{ text: string, json?: object, model: string, family: string, usage: object|null }>}
 */
async function callVisionRole(role, { prompt, images = [], label, expectJson = false, timeoutMs = DEFAULT_TIMEOUT_MS, abortSignal } = {}) {
  if (!prompt) throw new Error('callVisionRole: prompt is required');
  const { model, family } = modelFor(role);
  const dispatch = FAMILY_DISPATCH[family];
  if (!dispatch) {
    throw new Error(
      `visionClient: role ${role} resolves to family '${family}' which has no vision support — `
      + `check BOOK_PIPELINE_V3_${role}_FAMILY overrides (supported: ${Object.keys(FAMILY_DISPATCH).join(', ')})`,
    );
  }
  const tag = label || `v3.vision.${role.toLowerCase()}`;

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const { text, usage } = await dispatch({ model, prompt, images, timeoutMs, abortSignal });
      const out = { text, model, family, usage };
      if (expectJson) {
        try {
          out.json = parseJsonLoose(text);
        } catch (parseErr) {
          if (parseErr instanceof LlmParseError && attempt < MAX_ATTEMPTS) {
            console.warn(`[visionClient] ${tag}: unparseable JSON (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying`);
            lastErr = parseErr;
            continue;
          }
          throw parseErr;
        }
      }
      return out;
    } catch (err) {
      lastErr = err;
      const retryable = err?.isTransient === true || err?.name === 'AbortError' && false;
      if (retryable && attempt < MAX_ATTEMPTS) {
        const delay = 1000 * 2 ** (attempt - 1);
        console.warn(`[visionClient] ${tag}: transient failure (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${delay}ms: ${err.message}`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

module.exports = {
  callVisionRole,
  VisionTransientError,
  // exported for tests
  callGeminiVision,
  callOpenAiVision,
};
