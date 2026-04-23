/**
 * OpenAI-first text LLM client for the new pipeline.
 *
 * Provides one entry point (`callText`) that all planner/writer/QA stages
 * use. Handles:
 *   - chat-completions request to gpt-5.x models (uses max_completion_tokens)
 *   - streaming for large token budgets to avoid edge-proxy cutoffs
 *   - strict JSON mode when requested (response_format + robust parse)
 *   - Gemini fallback when the primary model fails
 *   - truncation detection (finish_reason === 'length') with auto-extend retry
 *   - timeouts and bounded retries on transient errors
 *   - uniform call metadata for the pipeline trace
 *
 * Image generation and vision QA stay on their own clients (image/vision
 * quality targets warrant different providers).
 */

const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_MAX_TOKENS = 12000;
const DEFAULT_MAX_ATTEMPTS = 3;
const STREAM_THRESHOLD_TOKENS = 6000;
const GEMINI_TEXT_MODEL = 'gemini-2.5-flash';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

class LlmTransientError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LlmTransientError';
    this.isTransient = true;
  }
}

class LlmParseError extends Error {
  constructor(message, raw) {
    super(message);
    this.name = 'LlmParseError';
    this.raw = raw;
  }
}

class LlmTruncationError extends Error {
  constructor(message, raw) {
    super(message);
    this.name = 'LlmTruncationError';
    this.raw = raw;
    this.isTruncation = true;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function resolveOpenaiKey(override) {
  const key = override || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OpenAI API key missing (OPENAI_API_KEY)');
  return key;
}

function resolveGeminiKey(override) {
  return override
    || process.env.GEMINI_API_KEY
    || process.env.GOOGLE_AI_STUDIO_KEY
    || null;
}

async function fetchWithTimeout(url, init, timeoutMs, label) {
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (didTimeout) throw new LlmTransientError(`${label} timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the textual content from a non-streaming chat-completions response.
 * GPT responses can come in multiple shapes — plain string, array of parts,
 * or structured content with text/type keys.
 */
function extractNonStreamContent(data) {
  const choice = data?.choices?.[0];
  const msg = choice?.message;
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map(p => {
        if (typeof p === 'string') return p;
        if (p && typeof p.text === 'string') return p.text;
        if (p?.type === 'text') return p.text || '';
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * Robust JSON extractor. Handles:
 *   - raw JSON
 *   - fenced ```json ... ``` blocks
 *   - leading/trailing prose
 *   - multiple code fences (picks the first JSON-shaped block)
 *   - partial JSON from truncated responses (last-resort brace matching)
 *
 * @param {string} raw
 * @returns {any}
 */
function parseJsonLoose(raw) {
  if (!raw) throw new LlmParseError('empty response');
  const s = String(raw).trim();

  try {
    return JSON.parse(s);
  } catch { /* try fenced extract */ }

  const fenceMatches = [...s.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)];
  for (const m of fenceMatches) {
    const inner = (m[1] || '').trim();
    if (!inner) continue;
    try { return JSON.parse(inner); } catch { /* try next */ }
  }

  const stripped = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try {
    return JSON.parse(stripped);
  } catch { /* try brace matching */ }

  const objMatch = stripped.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch { /* ignore */ }
  }
  const arrMatch = stripped.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch { /* ignore */ }
  }

  throw new LlmParseError('response is not valid JSON', raw);
}

/**
 * Read an OpenAI SSE stream and collect content + usage + finish_reason.
 *
 * @param {Response} resp
 * @returns {Promise<{text:string, inputTokens:number, outputTokens:number, finishReason:string}>}
 */
async function readOpenaiStream(resp) {
  const body = await resp.text();
  if (!body.trimStart().startsWith('data:')) {
    const parsed = JSON.parse(body);
    const choice = parsed.choices?.[0];
    return {
      text: extractNonStreamContent(parsed),
      inputTokens: parsed.usage?.prompt_tokens || 0,
      outputTokens: parsed.usage?.completion_tokens || 0,
      finishReason: choice?.finish_reason || 'stop',
    };
  }

  let content = '';
  let finishReason = 'stop';
  let inputTokens = 0;
  let outputTokens = 0;

  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload);
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        if (typeof delta.content === 'string') content += delta.content;
        else if (Array.isArray(delta.content)) {
          for (const p of delta.content) {
            if (typeof p === 'string') content += p;
            else if (p?.text) content += p.text;
          }
        }
      }
      const fr = chunk.choices?.[0]?.finish_reason;
      if (fr) finishReason = fr;
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens || inputTokens;
        outputTokens = chunk.usage.completion_tokens || outputTokens;
      }
    } catch (_) { /* skip malformed SSE frames */ }
  }

  return { text: content, inputTokens, outputTokens, finishReason };
}

/**
 * Call OpenAI chat-completions once.
 */
async function callOpenaiOnce(params) {
  const {
    model,
    systemPrompt,
    userPrompt,
    jsonMode,
    maxTokens,
    temperature,
    timeoutMs,
    apiKey,
    label,
  } = params;

  const key = resolveOpenaiKey(apiKey);
  const url = 'https://api.openai.com/v1/chat/completions';
  const useStream = maxTokens >= STREAM_THRESHOLD_TOKENS;

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature,
    max_completion_tokens: maxTokens,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  if (useStream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  }, timeoutMs, label);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const transient = resp.status >= 500 || resp.status === 429 || resp.status === 408;
    throw new (transient ? LlmTransientError : Error)(
      `${label} HTTP ${resp.status}: ${errText.slice(0, 400)}`,
    );
  }

  if (useStream) return readOpenaiStream(resp);

  const data = await resp.json();
  const choice = data.choices?.[0];
  return {
    text: extractNonStreamContent(data),
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
    finishReason: choice?.finish_reason || 'stop',
  };
}

/**
 * Call Gemini text (fallback when OpenAI is down).
 */
async function callGeminiOnce(params) {
  const {
    systemPrompt,
    userPrompt,
    jsonMode,
    maxTokens,
    temperature,
    timeoutMs,
    apiKey,
    label,
  } = params;

  const key = resolveGeminiKey(apiKey);
  if (!key) throw new Error(`${label}: no Gemini key for fallback`);

  const url = `${GEMINI_BASE_URL}/${GEMINI_TEXT_MODEL}:generateContent?key=${key}`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
    },
  };

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, timeoutMs, label);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const transient = resp.status >= 500 || resp.status === 429 || resp.status === 408;
    throw new (transient ? LlmTransientError : Error)(
      `${label} gemini HTTP ${resp.status}: ${errText.slice(0, 400)}`,
    );
  }

  const data = await resp.json();
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const text = parts.map(p => p?.text || '').join('');
  return {
    text,
    inputTokens: data.usageMetadata?.promptTokenCount || 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
    finishReason: candidate?.finishReason === 'MAX_TOKENS' ? 'length' : (candidate?.finishReason || 'stop'),
  };
}

/**
 * Call a text LLM with uniform retry + timeout + fallback + truncation guard.
 *
 * @param {object} params
 * @param {string} params.model
 * @param {string} params.systemPrompt
 * @param {string} params.userPrompt
 * @param {boolean} [params.jsonMode=false]
 * @param {number} [params.maxTokens]
 * @param {number} [params.temperature=0.8]
 * @param {number} [params.timeoutMs]
 * @param {number} [params.maxAttempts]
 * @param {string} [params.apiKey]
 * @param {string} [params.geminiApiKey]
 * @param {boolean} [params.allowGeminiFallback=true]
 * @param {boolean} [params.autoExtendOnTruncation=true]
 * @param {AbortSignal} [params.abortSignal]
 * @param {string} [params.label]
 * @returns {Promise<{text:string, json:any|null, usage:object, model:string, attempts:number, label:string, finishReason:string}>}
 */
async function callText(params) {
  const {
    model,
    systemPrompt,
    userPrompt,
    jsonMode = false,
    temperature = 0.8,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    apiKey,
    geminiApiKey,
    allowGeminiFallback = true,
    autoExtendOnTruncation = true,
    abortSignal,
    label = 'openai.callText',
  } = params;
  let maxTokens = params.maxTokens || DEFAULT_MAX_TOKENS;

  if (!model) throw new Error('callText: model required');
  if (!systemPrompt) throw new Error('callText: systemPrompt required');
  if (!userPrompt) throw new Error('callText: userPrompt required');

  let lastErr = null;
  let resolvedModel = model;

  console.log(`[llm:${label}] calling ${model} (maxTokens=${maxTokens}, jsonMode=${!!jsonMode}, temperature=${temperature}, stream=${maxTokens >= STREAM_THRESHOLD_TOKENS})`);
  const overallStart = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (abortSignal?.aborted) throw new Error(`${label} aborted`);

    const attemptStart = Date.now();
    try {
      const resp = await callOpenaiOnce({
        model,
        systemPrompt,
        userPrompt,
        jsonMode,
        maxTokens,
        temperature,
        timeoutMs,
        apiKey,
        label,
      });

      if (resp.finishReason === 'length') {
        if (autoExtendOnTruncation && attempt < maxAttempts) {
          const bumped = Math.min(maxTokens * 2, 32000);
          console.warn(`[llm:${label}] truncated after ${Date.now() - attemptStart}ms (out=${resp.outputTokens}); bumping budget ${maxTokens} -> ${bumped} and retrying`);
          maxTokens = bumped;
          lastErr = new LlmTruncationError(`${label} truncated at ${resp.outputTokens} tokens`, resp.text);
          await sleep(300);
          continue;
        }
        console.error(`[llm:${label}] truncated (final) after ${Date.now() - attemptStart}ms (out=${resp.outputTokens})`);
        throw new LlmTruncationError(`${label} truncated at ${resp.outputTokens} tokens`, resp.text);
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
          console.error(`[llm:${label}] JSON parse failed (final) after ${Date.now() - attemptStart}ms: ${err.message}`);
          throw err;
        }
      }

      resolvedModel = model;
      console.log(`[llm:${label}] done ${model} in ${Date.now() - overallStart}ms (in=${resp.inputTokens} out=${resp.outputTokens} finish=${resp.finishReason} attempts=${attempt})`);
      return {
        text: resp.text,
        json,
        usage: { inputTokens: resp.inputTokens, outputTokens: resp.outputTokens },
        model: resolvedModel,
        attempts: attempt,
        label,
        finishReason: resp.finishReason,
      };
    } catch (err) {
      lastErr = err;
      const transient = err?.isTransient === true;
      const truncation = err?.isTruncation === true;
      if (!transient && !truncation && !(err instanceof LlmParseError)) {
        if (allowGeminiFallback && resolveGeminiKey(geminiApiKey)) {
          try {
            console.warn(`[llm:${label}] OpenAI error after ${Date.now() - attemptStart}ms: '${err.message}', falling back to Gemini (${GEMINI_TEXT_MODEL})`);
            const fbStart = Date.now();
            const fb = await callGeminiOnce({
              systemPrompt,
              userPrompt,
              jsonMode,
              maxTokens,
              temperature,
              timeoutMs,
              apiKey: geminiApiKey,
              label,
            });
            let json = null;
            if (jsonMode) json = parseJsonLoose(fb.text);
            console.log(`[llm:${label}] gemini fallback done in ${Date.now() - fbStart}ms (in=${fb.inputTokens} out=${fb.outputTokens} finish=${fb.finishReason})`);
            return {
              text: fb.text,
              json,
              usage: { inputTokens: fb.inputTokens, outputTokens: fb.outputTokens },
              model: GEMINI_TEXT_MODEL,
              attempts: attempt,
              label,
              finishReason: fb.finishReason,
            };
          } catch (fbErr) {
            console.error(`[llm:${label}] gemini fallback failed: ${fbErr.message}`);
            throw new Error(`${label} failed on OpenAI (${err.message}) and Gemini fallback (${fbErr.message})`);
          }
        }
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
  callText,
  LlmTransientError,
  LlmParseError,
  LlmTruncationError,
  parseJsonLoose,
  fetchWithTimeout,
};
