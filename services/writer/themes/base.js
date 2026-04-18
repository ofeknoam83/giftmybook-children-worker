/**
 * BaseThemeWriter — shared logic for all theme-specific writers.
 *
 * Provides: age tier detection, LLM calling (GPT-5.4 primary, Gemini fallback),
 * spread parsing, structure validation, pronoun helpers, parent name resolution.
 *
 * Subclasses implement: plan(), write(), revise()
 */

const { WRITER_CONFIG } = require('../config');
const { getPronounInfo, buildPronounInstruction, checkAndFixPronouns } = require('../quality/pronoun');

// LLM infrastructure — reuse the same HTTP + timeout helpers from storyPlanner
const DEFAULT_LLM_TIMEOUT_MS = WRITER_CONFIG.timeouts.defaultLLM;
const GEMINI_MODEL = 'gemini-2.5-pro';
const GEMINI_FLASH_MODEL = 'gemini-2.5-flash';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// ── HTTP helpers ──

async function fetchWithTimeout(url, init, timeoutMs, requestLabel) {
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (didTimeout) throw new Error(`${requestLabel || 'LLM request'} timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAI(systemPrompt, userPrompt, opts = {}) {
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error('OpenAI API key not available');

  const useStream = (opts.maxTokens || 4000) > 8000;
  const resp = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-5.4',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: opts.temperature || 0.8,
      max_completion_tokens: opts.maxTokens || 4000,
      response_format: opts.jsonMode ? { type: 'json_object' } : undefined,
      stream: useStream || undefined,
      ...(useStream ? { stream_options: { include_usage: true } } : {}),
    }),
  }, opts.timeoutMs || DEFAULT_LLM_TIMEOUT_MS, opts.requestLabel || 'OpenAI request');

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${err.slice(0, 200)}`);
  }

  if (useStream) {
    const rawText = await resp.text();
    if (rawText.trimStart().startsWith('data:')) {
      const lines = rawText.split('\n');
      let content = '';
      let finishReason = 'stop';
      let inputTokens = 0;
      let outputTokens = 0;
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') break;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) content += delta.content;
          const reason = chunk.choices?.[0]?.finish_reason;
          if (reason) finishReason = reason;
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens || inputTokens;
            outputTokens = chunk.usage.completion_tokens || outputTokens;
          }
        } catch (_) { /* skip malformed SSE lines */ }
      }
      finishReason = finishReason === 'length' ? 'MAX_TOKENS' : (finishReason || 'stop');
      return { text: content, inputTokens, outputTokens, finishReason };
    }
    const data = JSON.parse(rawText);
    const choice = data.choices?.[0];
    return {
      text: choice?.message?.content || '',
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
      finishReason: choice?.finish_reason === 'length' ? 'MAX_TOKENS' : (choice?.finish_reason || 'stop'),
    };
  }

  const data = await resp.json();
  const choice = data.choices?.[0];
  let content = choice?.message?.content || '';
  if (Array.isArray(content)) {
    content = content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  return {
    text: typeof content === 'string' ? content : '',
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
    finishReason: choice?.finish_reason === 'length' ? 'MAX_TOKENS' : (choice?.finish_reason || 'stop'),
  };
}

async function callGeminiText(systemPrompt, userPrompt, genConfig) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const { timeoutMs, requestLabel, model, ...geminiGenConfig } = genConfig || {};
  const geminiModel = model || GEMINI_MODEL;

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: geminiGenConfig,
  };

  let resp;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      resp = await fetchWithTimeout(
        `${GEMINI_BASE_URL}/${geminiModel}:generateContent?key=${apiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        timeoutMs || DEFAULT_LLM_TIMEOUT_MS,
        requestLabel || `Gemini request attempt ${attempt}`,
      );
      break;
    } catch (fetchErr) {
      console.warn(`[writerV2] Gemini fetch attempt ${attempt}/3 failed: ${fetchErr.message}`);
      if (attempt === 3) throw fetchErr;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const result = await resp.json();
  const candidate = result.candidates?.[0];
  return {
    text: candidate?.content?.parts?.[0]?.text || '',
    inputTokens: result.usageMetadata?.promptTokenCount || 0,
    outputTokens: result.usageMetadata?.candidatesTokenCount || 0,
    finishReason: candidate?.finishReason || 'unknown',
  };
}

// ── BaseThemeWriter class ──

class BaseThemeWriter {
  constructor(themeName) {
    this.themeName = themeName;
  }

  /**
   * Get age tier name based on child's age.
   * Two tiers: young-picture (0-3) and picture-book (4-6).
   * Both produce 13-spread books; tier affects vocabulary, not structure.
   * @param {number|string} age
   * @returns {string} 'young-picture' or 'picture-book'
   */
  getAgeTier(age) {
    const a = Number(age) || 3;
    if (a <= 3) return 'young-picture';
    return 'picture-book';
  }

  /**
   * Get word count limits for an age tier.
   * @param {number|string} age
   * @returns {{ maxWords: number, wordsPerSpread: { min: number, max: number } }}
   */
  getWordLimits(age) {
    const tierName = this.getAgeTier(age);
    const tier = WRITER_CONFIG.ageTiers[tierName];
    return { maxWords: tier.maxWords, wordsPerSpread: tier.wordsPerSpread };
  }

  /**
   * Get spread count range for an age tier.
   * @param {number|string} age
   * @returns {{ min: number, max: number }}
   */
  getSpreadCount(age) {
    const tierName = this.getAgeTier(age);
    return WRITER_CONFIG.ageTiers[tierName].spreads;
  }

  /**
   * Call the best available LLM — GPT-5.4 primary, Gemini fallback.
   * @param {string} role - 'planner', 'writer', 'critic', 'reviser'
   * @param {string} systemPrompt
   * @param {string} userPrompt
   * @param {object} opts - { jsonMode, maxTokens, timeoutMs }
   * @returns {{ text: string, model: string, inputTokens: number, outputTokens: number }}
   */
  async callLLM(role, systemPrompt, userPrompt, opts = {}) {
    const modelConfig = WRITER_CONFIG.models[role] || WRITER_CONFIG.models.writer;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (openaiKey) {
      try {
        console.log(`[writerV2] Calling GPT-5.4 for ${role}...`);
        const result = await callOpenAI(systemPrompt, userPrompt, {
          apiKey: openaiKey,
          temperature: opts.temperature || modelConfig.temperature,
          maxTokens: opts.maxTokens || 8000,
          jsonMode: opts.jsonMode,
          timeoutMs: opts.timeoutMs,
          requestLabel: `writerV2-${role}`,
        });
        if (opts.jsonMode && !String(result.text || '').trim()) {
          throw new Error('GPT-5.4 returned empty JSON-mode content');
        }
        const llmResult = { ...result, model: 'gpt-5.4' };
        this._recordLLMCall(role, llmResult, systemPrompt, userPrompt);
        return llmResult;
      } catch (err) {
        console.warn(`[writerV2] GPT-5.4 failed for ${role}, falling back to Gemini: ${err.message}`);
      }
    }

    // Fallback to Gemini
    const fallbackModel = modelConfig.fallback || GEMINI_MODEL;
    const isFlash = fallbackModel.includes('flash');
    console.log(`[writerV2] Calling Gemini ${fallbackModel} for ${role}...`);
    const result = await callGeminiText(systemPrompt, userPrompt, {
      maxOutputTokens: opts.maxTokens || 8000,
      temperature: opts.temperature || modelConfig.temperature,
      responseMimeType: opts.jsonMode ? 'application/json' : undefined,
      timeoutMs: opts.timeoutMs,
      requestLabel: `writerV2-${role}`,
      model: isFlash ? GEMINI_FLASH_MODEL : GEMINI_MODEL,
    });
    const llmResult = { ...result, model: fallbackModel };
    this._recordLLMCall(role, llmResult, systemPrompt, userPrompt);
    return llmResult;
  }

  /**
   * Record raw LLM call data for pipeline transparency.
   * Only records if _pipeline was set by the engine.
   */
  _recordLLMCall(role, result, systemPrompt, userPrompt) {
    if (!this._pipeline) return;
    this._pipeline.llmCalls.push({
      role,
      model: result.model,
      systemPrompt: systemPrompt.substring(0, 500) + (systemPrompt.length > 500 ? '...' : ''),
      userPrompt: userPrompt.substring(0, 1000) + (userPrompt.length > 1000 ? '...' : ''),
      rawResponse: result.text.substring(0, 2000) + (result.text.length > 2000 ? '...' : ''),
      tokens: { input: result.inputTokens, output: result.outputTokens },
      finishReason: result.finishReason,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Parse LLM output into structured spread array.
   * Handles ---SPREAD N--- delimited format.
   * @param {string} rawText
   * @returns {Array<{ spread: number, text: string }>}
   */
  parseSpreads(rawText) {
    const spreads = [];
    // Match ---SPREAD N--- or similar patterns
    const pattern = /---\s*SPREAD\s+(\d+)\s*---/gi;
    const parts = rawText.split(pattern);

    // parts alternates: [preamble, "1", text1, "2", text2, ...]
    for (let i = 1; i < parts.length; i += 2) {
      const spreadNum = parseInt(parts[i], 10);
      const text = (parts[i + 1] || '').trim();
      if (text) {
        spreads.push({ spread: spreadNum, text });
      }
    }

    // Fallback: try splitting by "Spread N:" or numbered patterns
    if (spreads.length === 0) {
      const fallbackPattern = /(?:^|\n)\s*(?:Spread\s+)?(\d+)[:.]\s*/gi;
      const fallbackParts = rawText.split(fallbackPattern);
      for (let i = 1; i < fallbackParts.length; i += 2) {
        const spreadNum = parseInt(fallbackParts[i], 10);
        const text = (fallbackParts[i + 1] || '').trim();
        if (text && spreadNum >= 1 && spreadNum <= 20) {
          spreads.push({ spread: spreadNum, text });
        }
      }
    }

    // Last resort: split by double newlines and number them
    if (spreads.length === 0 && rawText.trim()) {
      const chunks = rawText.trim().split(/\n\s*\n/).filter(c => c.trim());
      chunks.forEach((chunk, i) => {
        spreads.push({ spread: i + 1, text: chunk.trim() });
      });
    }

    return spreads;
  }

  /**
   * Validate spread structure against age tier requirements.
   * @param {Array<{ spread: number, text: string }>} spreads
   * @param {number|string} age
   * @returns {{ valid: boolean, issues: string[] }}
   */
  validateStructure(spreads, age) {
    const tierName = this.getAgeTier(age);
    const tier = WRITER_CONFIG.ageTiers[tierName];
    const issues = [];

    // Check spread count
    if (spreads.length < tier.spreads.min) {
      issues.push(`Too few spreads: got ${spreads.length}, need at least ${tier.spreads.min}`);
    }
    if (spreads.length > tier.spreads.max) {
      issues.push(`Too many spreads: got ${spreads.length}, max is ${tier.spreads.max}`);
    }

    // Check total word count
    const totalWords = spreads.reduce((sum, s) => sum + (s.text || '').split(/\s+/).length, 0);
    if (totalWords > tier.maxWords * 1.2) {
      issues.push(`Total word count too high: ${totalWords} words, max is ${tier.maxWords}`);
    }

    // Check per-spread word counts
    for (const s of spreads) {
      const words = (s.text || '').split(/\s+/).length;
      if (words > tier.wordsPerSpread.max * 1.5) {
        issues.push(`Spread ${s.spread} has ${words} words, max is ${tier.wordsPerSpread.max}`);
      }
    }

    return { valid: issues.length === 0, issues };
  }

  /**
   * Get the child's word for their parent based on theme.
   * @param {object} child - { anecdotes: { calls_mom, calls_dad } }
   * @param {object} book - { theme }
   * @returns {string|null}
   */
  getParentName(child, book) {
    const theme = book.theme || this.themeName;
    if (theme === 'mothers_day' || theme === 'mom_birthday') {
      return child.anecdotes?.calls_mom || 'Mama';
    }
    if (theme === 'fathers_day' || theme === 'dad_birthday') {
      return child.anecdotes?.calls_dad || 'Daddy';
    }
    return null;
  }

  /**
   * Get pronoun info for the child.
   * @param {object} child - { gender }
   * @returns {{ subject: string, object: string, possessive: string, pair: string }}
   */
  getPronouns(child) {
    return getPronounInfo(child.gender);
  }

  // ── Abstract methods — subclasses MUST implement ──

  async plan(child, book) {
    throw new Error(`${this.constructor.name} must implement plan()`);
  }

  async write(plan, child, book) {
    throw new Error(`${this.constructor.name} must implement write()`);
  }

  async revise(story, feedback, child, book) {
    throw new Error(`${this.constructor.name} must implement revise()`);
  }
}

module.exports = { BaseThemeWriter };
