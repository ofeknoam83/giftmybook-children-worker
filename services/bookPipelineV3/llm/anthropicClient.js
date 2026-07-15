/**
 * Anthropic (Claude) text client for bookPipelineV3.
 *
 * Mirrors the conventions of services/bookPipeline/llm/openaiClient.js —
 * one entry point (`callClaude`), fetch-based, uniform result shape,
 * bounded retries, truncation auto-extend — and reuses its error classes
 * so the workflow engine's `isTransient` handling stays uniform.
 *
 * Anthropic-specific facts this client encodes:
 *   - Messages API: POST /v1/messages with `x-api-key` +
 *     `anthropic-version: 2023-06-01`; `max_tokens` is REQUIRED.
 *   - `temperature`/`top_p` are REJECTED (400) by claude-opus-4-8.
 *     This client never sends them. Draft diversity in V3 comes from
 *     prompt variants, not sampling params — do not "fix" this by
 *     adding temperature back.
 *   - `stop_reason === 'max_tokens'` means truncation → retry with a
 *     doubled budget (cap 16000 — the largest V3 call, a full 13-spread
 *     manuscript, is ~4-6K output tokens).
 *   - `stop_reason === 'refusal'` is non-transient; children's-book
 *     prompts should never trip it, so fail loud naming the label.
 *   - 429 / 408 / 5xx / 529 (overloaded) are transient.
 *   - NO cross-family fallback, ever. A missing/invalid ANTHROPIC_API_KEY
 *     is a deploy bug (same post-incident AA-1 policy as openaiClient):
 *     the prompts are Claude-tuned and silently swapping families masks
 *     the bug while shipping degraded books.
 */

const {
  LlmTransientError,
  LlmAuthError,
  LlmTruncationError,
  parseJsonLoose,
  fetchWithTimeout,
  isNetworkError,
} = require('../../shared/llm/openaiClient');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 300000; // Opus is slower than gpt-5.4; WRITER-class calls need headroom
const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_OUTPUT_TOKENS = 16000; // non-streaming safety ceiling

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveAnthropicKey(override) {
  const key = override || process.env.ANTHROPIC_API_KEY;
  if (!key || String(key).trim() === '') {
    throw new LlmAuthError(
      'Anthropic API key missing (ANTHROPIC_API_KEY is empty or unset). This is a deploy/config bug — refusing to fall back to another model family because the V3 prompts are tuned for Claude.',
      { missingKey: true },
    );
  }
  return key;
}

/**
 * Extract text from a Messages API response (content blocks).
 */
function extractContent(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks
    .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('');
}

/**
 * Single Messages API call. Throws typed errors; returns
 * { text, inputTokens, outputTokens, stopReason }.
 */
async function callAnthropicOnce({ model, systemPrompt, userPrompt, maxTokens, timeoutMs, apiKey, label }) {
  const key = resolveAnthropicKey(apiKey);

  const body = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    // No temperature/top_p — rejected by claude-opus-4-8 (400). See module doc.
  };

  const resp = await fetchWithTimeout(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  }, timeoutMs, label);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    if (resp.status === 401 || resp.status === 403) {
      throw new LlmAuthError(`${label} anthropic HTTP ${resp.status}: ${errText.slice(0, 400)}`, { httpStatus: resp.status });
    }
    const transient = resp.status >= 500 || resp.status === 429 || resp.status === 408 || resp.status === 529;
    throw new (transient ? LlmTransientError : Error)(
      `${label} anthropic HTTP ${resp.status}: ${errText.slice(0, 400)}`,
    );
  }

  const data = await resp.json();
  return {
    text: extractContent(data),
    inputTokens: data?.usage?.input_tokens || 0,
    outputTokens: data?.usage?.output_tokens || 0,
    stopReason: data?.stop_reason || 'end_turn',
  };
}

/**
 * Call Claude with uniform retry + timeout + truncation guard. Result
 * shape matches openaiClient.callText so modelRouter callers are
 * family-agnostic.
 *
 * @param {object} params
 * @param {string} params.model
 * @param {string} params.systemPrompt
 * @param {string} params.userPrompt
 * @param {boolean} [params.jsonMode=false]
 * @param {number} [params.maxTokens]
 * @param {number} [params.timeoutMs]
 * @param {number} [params.maxAttempts]
 * @param {string} [params.apiKey]
 * @param {AbortSignal} [params.abortSignal]
 * @param {string} [params.label]
 * @returns {Promise<{text:string, json:any|null, usage:object, model:string, attempts:number, label:string, finishReason:string}>}
 */
async function callClaude(params) {
  const {
    model,
    systemPrompt,
    userPrompt,
    jsonMode = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    apiKey,
    abortSignal,
    label = 'anthropic.callClaude',
  } = params;
  let maxTokens = params.maxTokens || DEFAULT_MAX_TOKENS;

  if (!model) throw new Error('callClaude: model required');
  if (!systemPrompt) throw new Error('callClaude: systemPrompt required');
  if (!userPrompt) throw new Error('callClaude: userPrompt required');

  const effectiveUserPrompt = jsonMode
    ? `${userPrompt}\n\nRespond with a single valid JSON object only. No markdown fences, no prose before or after the JSON.`
    : userPrompt;

  console.log(`[llm:${label}] calling ${model} (provider=anthropic, maxTokens=${maxTokens}, jsonMode=${!!jsonMode})`);
  const overallStart = Date.now();
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (abortSignal?.aborted) throw new Error(`${label} aborted`);
    const attemptStart = Date.now();
    try {
      const resp = await callAnthropicOnce({
        model, systemPrompt, userPrompt: effectiveUserPrompt, maxTokens, timeoutMs, apiKey, label,
      });

      if (resp.stopReason === 'max_tokens') {
        if (attempt < maxAttempts && maxTokens < MAX_OUTPUT_TOKENS) {
          const bumped = Math.min(maxTokens * 2, MAX_OUTPUT_TOKENS);
          console.warn(`[llm:${label}] truncated after ${Date.now() - attemptStart}ms (out=${resp.outputTokens}); bumping budget ${maxTokens} -> ${bumped} and retrying`);
          maxTokens = bumped;
          lastErr = new LlmTruncationError(`${label} truncated at ${resp.outputTokens} tokens`, resp.text);
          await sleep(300);
          continue;
        }
        throw new LlmTruncationError(`${label} truncated at ${resp.outputTokens} tokens`, resp.text);
      }

      if (resp.stopReason === 'refusal') {
        throw new Error(`${label} anthropic refused the request (stop_reason=refusal) — inspect the prompt for this stage`);
      }

      let json = null;
      if (jsonMode) {
        try {
          json = parseJsonLoose(resp.text);
        } catch (err) {
          if (attempt < maxAttempts) {
            console.warn(`[llm:${label}] JSON parse failed on attempt ${attempt} (${err.message}); retrying`);
            lastErr = err;
            await sleep(300 * attempt);
            continue;
          }
          throw err;
        }
      }

      console.log(`[llm:${label}] done ${model} in ${Date.now() - overallStart}ms (in=${resp.inputTokens} out=${resp.outputTokens} stop=${resp.stopReason} attempts=${attempt})`);
      return {
        text: resp.text,
        json,
        usage: { inputTokens: resp.inputTokens, outputTokens: resp.outputTokens },
        model,
        attempts: attempt,
        label,
        finishReason: resp.stopReason === 'end_turn' ? 'stop' : resp.stopReason,
      };
    } catch (err) {
      lastErr = err;
      if (err?.isAuthError) {
        console.error(`[LLM_AUTH_FAIL] label=${label} model=${model} provider=anthropic httpStatus=${err.httpStatus || 'none'} missingKey=${err.missingKey ? 'true' : 'false'} msg='${String(err.message).slice(0, 300)}' — no cross-family fallback; fix ANTHROPIC_API_KEY and redeploy`);
        throw err;
      }
      const retryable = err?.isTransient === true || isNetworkError(err);
      if (!retryable) {
        console.error(`[llm:${label}] non-transient error after ${Date.now() - attemptStart}ms: ${err.message}`);
        throw err;
      }
      if (attempt >= maxAttempts) {
        console.error(`[llm:${label}] exhausted ${maxAttempts} attempts after ${Date.now() - overallStart}ms: ${err.message}`);
        throw err;
      }
      console.warn(`[llm:${label}] transient error on attempt ${attempt} after ${Date.now() - attemptStart}ms: ${err.message}; will retry`);
      await sleep(400 * attempt);
    }
  }

  throw lastErr || new Error(`${label} exhausted attempts`);
}

module.exports = {
  callClaude,
  ANTHROPIC_URL,
  ANTHROPIC_VERSION,
};
