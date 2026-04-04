/**
 * Story planner service.
 *
 * Takes child details, theme, and book format, then generates a
 * spread-by-spread story outline using GPT 5.4 (with Gemini fallback).
 *
 * Picture books: 12-16 spreads, ~30-60 words per spread
 * Early readers: 24-32 pages, ~60-150 words per page
 */

const { STORY_PLANNER_SYSTEM: PB_SYSTEM, STORY_PLANNER_USER: pbUserPrompt } = require('../prompts/pictureBook');
const { STORY_PLANNER_SYSTEM: ER_SYSTEM, STORY_PLANNER_USER: erUserPrompt } = require('../prompts/earlyReader');

const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Call OpenAI GPT 5.4 chat completions API.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} opts - { apiKey, temperature, maxTokens, jsonMode }
 * @returns {Promise<{ text: string, inputTokens: number, outputTokens: number }>}
 */
async function callOpenAI(systemPrompt, userPrompt, opts = {}) {
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error('OpenAI API key not available');

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-5.4',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: opts.temperature || 0.8,
      max_tokens: opts.maxTokens || 4000,
      response_format: opts.jsonMode ? { type: 'json_object' } : undefined,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  return {
    text: data.choices?.[0]?.message?.content || '',
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  };
}

/**
 * Call Gemini text generation API (fallback).
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} genConfig - { maxOutputTokens, temperature, responseMimeType? }
 * @returns {Promise<{ text: string, inputTokens: number, outputTokens: number, finishReason: string }>}
 */
async function callGeminiText(systemPrompt, userPrompt, genConfig) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: genConfig,
  };

  // Retry up to 3 times on transient network errors
  let resp;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      resp = await fetch(
        `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      break;
    } catch (fetchErr) {
      console.warn(`[storyPlanner] Fetch attempt ${attempt}/3 failed: ${fetchErr.message}`);
      if (attempt === 3) throw fetchErr;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`[storyPlanner] Gemini API call failed: ${resp.status} ${errText.slice(0, 300)}`);
    throw new Error(`Story planner API call failed: ${resp.status} ${errText.slice(0, 200)}`);
  }

  const result = await resp.json();
  const candidate = result.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text || '';
  const finishReason = candidate?.finishReason || 'unknown';
  const inputTokens = result.usageMetadata?.promptTokenCount || 0;
  const outputTokens = result.usageMetadata?.candidatesTokenCount || 0;

  return { text, inputTokens, outputTokens, finishReason };
}

/**
 * Call the best available LLM — GPT 5.4 first, Gemini fallback.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} opts - { openaiApiKey, maxTokens, temperature, jsonMode, costTracker }
 * @returns {Promise<{ text: string, inputTokens: number, outputTokens: number, model: string }>}
 */
async function callLLM(systemPrompt, userPrompt, opts = {}) {
  const openaiKey = opts.openaiApiKey;

  // Try GPT 5.4 first
  if (openaiKey) {
    try {
      console.log('[storyPlanner] Calling GPT 5.4...');
      const result = await callOpenAI(systemPrompt, userPrompt, {
        apiKey: openaiKey,
        temperature: opts.temperature || 0.8,
        maxTokens: opts.maxTokens || 8000,
        jsonMode: opts.jsonMode,
      });
      if (opts.costTracker) {
        opts.costTracker.addTextUsage('gpt-5.4', result.inputTokens, result.outputTokens);
      }
      return { ...result, model: 'gpt-5.4' };
    } catch (err) {
      console.warn(`[storyPlanner] GPT 5.4 failed, falling back to Gemini: ${err.message}`);
    }
  }

  // Fallback to Gemini
  console.log(`[storyPlanner] Calling Gemini (${GEMINI_MODEL})...`);
  const result = await callGeminiText(systemPrompt, userPrompt, {
    maxOutputTokens: opts.maxTokens || 8000,
    temperature: opts.temperature || 0.8,
    responseMimeType: opts.jsonMode ? 'application/json' : undefined,
  });
  if (opts.costTracker) {
    opts.costTracker.addTextUsage(GEMINI_MODEL, result.inputTokens, result.outputTokens);
  }
  return { ...result, model: GEMINI_MODEL };
}

/**
 * Plan a complete story with spread-by-spread outline.
 *
 * @param {object} childDetails - { name, age, gender, appearance, interests }
 * @param {string} theme - Story theme (adventure, friendship, bedtime, etc.)
 * @param {string} bookFormat - 'picture_book' or 'early_reader'
 * @param {string} customDetails - Additional story requirements from the customer
 * @param {object} [opts] - { apiKeys, costTracker }
 * @returns {Promise<{ title: string, spreads: Array<{ spreadNumber: number, text: string, illustrationDescription: string, layoutType: string, mood: string }> }>}
 */
async function planStory(childDetails, theme, bookFormat, customDetails, opts = {}) {
  const { costTracker, approvedTitle, apiKeys } = opts;

  const isPictureBook = bookFormat === 'picture_book';
  const systemPrompt = isPictureBook ? PB_SYSTEM : ER_SYSTEM;
  let userPrompt = isPictureBook
    ? pbUserPrompt(childDetails, theme, customDetails)
    : erUserPrompt(childDetails, theme, customDetails);

  // If there's an approved title from the cover selection, inject it into the prompt
  if (approvedTitle) {
    userPrompt += `\n\nIMPORTANT: The book title has already been chosen by the customer: "${approvedTitle}". You MUST use this exact title. Build the story around this title. Do not invent a different title.`;
  }

  const openaiKey = apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  console.log(`[storyPlanner] Planning ${bookFormat} story for ${childDetails.name}, theme: ${theme}`);

  const llmStart = Date.now();
  const response = await callLLM(systemPrompt, userPrompt, {
    openaiApiKey: openaiKey,
    maxTokens: 8000,
    temperature: 0.8,
    jsonMode: true,
    costTracker,
  });
  const llmMs = Date.now() - llmStart;

  console.log(`[storyPlanner] ${response.model} call completed in ${llmMs}ms (input: ${response.inputTokens}, output: ${response.outputTokens} tokens)`);

  const content = response.text;
  const finishReason = response.finishReason;

  if (!content) {
    console.error('[storyPlanner] Empty response from LLM');
    throw new Error(`Empty response from story planner (finish_reason: ${finishReason})`);
  }

  if (finishReason === 'MAX_TOKENS') {
    console.warn(`[storyPlanner] Response truncated (finish_reason: MAX_TOKENS, ${content.length} chars). Attempting to salvage...`);
  }
  console.log(`[storyPlanner] Response received: ${content.length} chars, finish_reason: ${finishReason || 'n/a'}`);

  let plan;
  try {
    plan = JSON.parse(content);
  } catch (parseErr) {
    // Try to extract JSON object from response (GPT sometimes adds text after the JSON)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        plan = JSON.parse(jsonMatch[0]);
        console.warn(`[storyPlanner] Extracted JSON from response with trailing text (${content.length} chars, JSON: ${jsonMatch[0].length} chars)`);
      } catch (_) { /* fall through */ }
    }
    if (!plan && finishReason === 'MAX_TOKENS') {
      const repaired = repairTruncatedJson(content);
      if (repaired) {
        console.warn(`[storyPlanner] Salvaged truncated JSON after repair`);
        plan = repaired;
      }
    }
    if (!plan) {
      // Try stripping markdown code fences
      const stripped = content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
      try {
        plan = JSON.parse(stripped);
        console.warn(`[storyPlanner] Parsed after stripping markdown fences`);
      } catch (_) {
        throw new Error(`Failed to parse story plan JSON: ${parseErr.message}`);
      }
    }
  }

  // Validate plan structure
  if (!plan.title || !Array.isArray(plan.spreads) || plan.spreads.length === 0) {
    throw new Error('Invalid story plan: missing title or spreads array');
  }

  const validLayouts = ['FULL_BLEED', 'TEXT_BOTTOM', 'TEXT_LEFT', 'NO_TEXT'];
  for (const spread of plan.spreads) {
    if (!spread.spreadNumber) {
      throw new Error('Each spread must have a spreadNumber');
    }
    if (!validLayouts.includes(spread.layoutType)) {
      spread.layoutType = 'TEXT_BOTTOM';
    }
    spread.illustrationDescription = spread.illustrationDescription || '';
    spread.mood = spread.mood || 'cheerful';
    spread.text = spread.text || '';
  }

  // For picture books, do a rhyme/rhythm pass
  if (isPictureBook && plan.spreads.length > 0) {
    plan = await applyRhymePass(plan, childDetails, costTracker, openaiKey);
  }

  // Enforce spread cap
  if (plan.spreads.length > 16) {
    console.warn(`[storyPlanner] Plan has ${plan.spreads.length} spreads — truncating to 16 (keeping first 3 + last 3, cutting middle)`);
    const first = plan.spreads.slice(0, 3);
    const last = plan.spreads.slice(-3);
    const middle = plan.spreads.slice(3, -3).slice(0, 10);
    plan.spreads = [...first, ...middle, ...last];
    plan.spreads.forEach((s, i) => { s.spreadNumber = i + 1; });
  }

  const spreadRange = isPictureBook ? [12, 16] : [24, 32];
  if (plan.spreads.length < spreadRange[0]) {
    console.warn(`[storyPlanner] Plan has only ${plan.spreads.length} spreads (expected ${spreadRange[0]}-${spreadRange[1]})`);
  }

  // Override with the approved title if provided
  if (approvedTitle) {
    plan.title = approvedTitle;
  }

  console.log(`[storyPlanner] Plan complete: "${plan.title}" with ${plan.spreads.length} spreads`);
  return plan;
}

/**
 * Apply a rhyme/rhythm refinement pass for picture books.
 *
 * @param {object} plan
 * @param {object} childDetails
 * @param {object} [costTracker]
 * @param {string} [openaiKey]
 * @returns {Promise<object>}
 */
async function applyRhymePass(plan, childDetails, costTracker, openaiKey) {
  console.log(`[storyPlanner] Applying rhyme/rhythm pass...`);

  const spreadTexts = plan.spreads.map(s => `Spread ${s.spreadNumber}: ${s.text}`).join('\n');

  const systemPrompt = `You are a children's picture book poet. Your job is to refine story text so it has a consistent rhythm and rhyming pattern (AABB or ABAB). Keep each spread's text to 30-60 words. Maintain the same story beats and character names. The child character is named ${childDetails.name}.

Return a JSON object with a "spreads" array. Each item must have "spreadNumber" (integer) and "text" (refined rhyming text).`;

  const userPrompt = `Refine these spread texts to have a consistent rhyme scheme and rhythm:\n\n${spreadTexts}`;

  const rhymeStart = Date.now();
  const response = await callLLM(systemPrompt, userPrompt, {
    openaiApiKey: openaiKey,
    maxTokens: 6000,
    temperature: 0.7,
    jsonMode: true,
    costTracker,
  });
  console.log(`[storyPlanner] Rhyme pass ${response.model} call completed in ${Date.now() - rhymeStart}ms (input: ${response.inputTokens}, output: ${response.outputTokens} tokens)`);

  try {
    const refined = JSON.parse(response.text || '{}');
    if (Array.isArray(refined.spreads)) {
      for (const refinedSpread of refined.spreads) {
        const original = plan.spreads.find(s => s.spreadNumber === refinedSpread.spreadNumber);
        if (original && refinedSpread.text) {
          original.text = refinedSpread.text;
        }
      }
    }
  } catch (err) {
    console.warn(`[storyPlanner] Rhyme pass failed to parse, using original text: ${err.message}`);
  }

  return plan;
}

/**
 * Attempt to repair truncated JSON by closing unclosed brackets/braces.
 * @param {string} str - Truncated JSON string
 * @returns {object|null} Parsed object or null if repair fails
 */
function repairTruncatedJson(str) {
  const lastBrace = str.lastIndexOf('}');
  if (lastBrace === -1) return null;

  let candidate = str.slice(0, lastBrace + 1);

  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escape = false;
  for (const ch of candidate) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') openBraces++;
    if (ch === '}') openBraces--;
    if (ch === '[') openBrackets++;
    if (ch === ']') openBrackets--;
  }

  const suffix = ']'.repeat(Math.max(0, openBrackets)) + '}'.repeat(Math.max(0, openBraces));
  try {
    return JSON.parse(candidate + suffix);
  } catch {
    return null;
  }
}

module.exports = { planStory };
