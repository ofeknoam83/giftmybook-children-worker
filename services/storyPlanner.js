/**
 * Story planner service — V2.
 *
 * Takes child details, theme, and book format, then generates a
 * complete story with front matter + left/right spreads using
 * GPT 5.4 (with Gemini fallback).
 *
 * V2 output: array of entries (title_page, blank, dedication_page, spread)
 * with text AND illustration prompts in a single LLM call.
 */

const { buildStoryPlannerSystem, STORY_PLANNER_USER: pbUserPrompt } = require('../prompts/pictureBook');
const { STORY_PLANNER_SYSTEM: ER_SYSTEM, STORY_PLANNER_USER: erUserPrompt } = require('../prompts/earlyReader');

const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Call OpenAI GPT 5.4 chat completions API.
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
 */
async function callGeminiText(systemPrompt, userPrompt, genConfig) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: genConfig,
  };

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
 */
async function callLLM(systemPrompt, userPrompt, opts = {}) {
  const openaiKey = opts.openaiApiKey;

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
 * Plan a complete V2 story.
 *
 * @param {object} childDetails - { name, age, gender, appearance, interests }
 * @param {string} theme
 * @param {string} bookFormat - 'picture_book' or 'early_reader'
 * @param {string} customDetails
 * @param {object} [opts] - { apiKeys, costTracker, approvedTitle, v2Vars }
 * @returns {Promise<{ title: string, entries: Array<object> }>}
 */
async function planStory(childDetails, theme, bookFormat, customDetails, opts = {}) {
  const { costTracker, approvedTitle, apiKeys, v2Vars } = opts;

  const isPictureBook = bookFormat === 'picture_book';
  const childAge = childDetails.age || childDetails.childAge || 5;

  let systemPrompt, userPrompt;

  if (isPictureBook) {
    // V2: build system prompt with full variable substitution
    const briefVars = v2Vars || {
      name: childDetails.name || childDetails.childName || 'the child',
      age: childAge,
      favorite_object: 'a stuffed bear',
      fear: 'the dark',
      setting: '',
      dedication: `For ${childDetails.name || childDetails.childName || 'the child'}`,
    };
    systemPrompt = buildStoryPlannerSystem(briefVars);
    userPrompt = pbUserPrompt(childDetails, theme, customDetails, v2Vars);
  } else {
    systemPrompt = ER_SYSTEM;
    userPrompt = erUserPrompt(childDetails, theme, customDetails);
  }

  if (approvedTitle) {
    userPrompt += `\n\nIMPORTANT: The book title has already been chosen by the customer: "${approvedTitle}". You MUST use this exact title. Build the story around this title. Do not invent a different title.`;
  }

  const openaiKey = apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  console.log(`[storyPlanner] Planning ${bookFormat} story for ${childDetails.name}, theme: ${theme}`);

  const llmStart = Date.now();
  const response = await callLLM(systemPrompt, userPrompt, {
    openaiApiKey: openaiKey,
    maxTokens: 10000,
    temperature: 0.8,
    jsonMode: true,
    costTracker,
  });
  const llmMs = Date.now() - llmStart;

  console.log(`[storyPlanner] ${response.model} call completed in ${llmMs}ms (input: ${response.inputTokens}, output: ${response.outputTokens} tokens)`);

  let content = response.text;
  const finishReason = response.finishReason;

  if (!content) {
    throw new Error(`Empty response from story planner (finish_reason: ${finishReason})`);
  }

  if (finishReason === 'MAX_TOKENS') {
    console.warn(`[storyPlanner] Response truncated (finish_reason: MAX_TOKENS, ${content.length} chars). Attempting to salvage...`);
  }
  console.log(`[storyPlanner] Response received: ${content.length} chars, finish_reason: ${finishReason || 'n/a'}`);

  // Sanitize common JSON issues from LLM output
  // Fix invalid \' escapes (GPT sometimes escapes apostrophes which is not valid JSON)
  content = content.replace(/\\'/g, "'");
  // Fix smart/curly quotes
  content = content.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (parseErr) {
    // Try to extract balanced JSON object
    const firstBrace = content.indexOf('{');
    if (firstBrace !== -1) {
      let depth = 0;
      let inString = false;
      let escape = false;
      let endIdx = -1;
      for (let ci = firstBrace; ci < content.length; ci++) {
        const ch = content[ci];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') { depth--; if (depth === 0) { endIdx = ci; break; } }
      }
      if (endIdx !== -1) {
        try {
          parsed = JSON.parse(content.slice(firstBrace, endIdx + 1));
          console.warn(`[storyPlanner] Extracted balanced JSON from response`);
        } catch (_) { /* fall through */ }
      }
    }
    if (!parsed && finishReason === 'MAX_TOKENS') {
      const repaired = repairTruncatedJson(content);
      if (repaired) {
        console.warn(`[storyPlanner] Salvaged truncated JSON after repair`);
        parsed = repaired;
      }
    }
    if (!parsed) {
      const stripped = content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
      try {
        parsed = JSON.parse(stripped);
        console.warn(`[storyPlanner] Parsed after stripping markdown fences`);
      } catch (_) {
        throw new Error(`Failed to parse story plan JSON: ${parseErr.message}`);
      }
    }
  }

  // Normalize: V2 format wraps entries in { "entries": [...] }
  // But models might also return a raw array or { "spreads": [...] } etc.
  let entries;
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (Array.isArray(parsed.entries)) {
    entries = parsed.entries;
  } else if (Array.isArray(parsed.spreads)) {
    // Legacy format fallback — convert to V2
    entries = convertLegacyToV2(parsed);
  } else {
    // Try to find any array that looks like entries
    const firstArray = Object.values(parsed).find(v => Array.isArray(v) && v.length > 0 && v[0]?.type);
    if (firstArray) {
      entries = firstArray;
    } else {
      throw new Error('Invalid story plan: cannot find entries array');
    }
  }

  // Extract title from title_page entry or from parsed object
  const titleEntry = entries.find(e => e.type === 'title_page');
  const title = approvedTitle || titleEntry?.title || parsed.title || 'My Story';

  // Validate V2 structure
  const spreads = entries.filter(e => e.type === 'spread');
  if (spreads.length < 8) {
    console.warn(`[storyPlanner] Only ${spreads.length} spreads — expected 14-16`);
  }
  if (spreads.length > 16) {
    console.warn(`[storyPlanner] ${spreads.length} spreads — truncating to 16`);
    // Keep front matter + first 16 spreads
    const frontMatter = entries.filter(e => e.type !== 'spread');
    const trimmedSpreads = spreads.slice(0, 16).map((s, i) => ({ ...s, spread: i + 1 }));
    entries = [...frontMatter, ...trimmedSpreads];
  }

  // Ensure front matter exists — add if missing
  const hasTitle = entries.some(e => e.type === 'title_page');
  const hasDedication = entries.some(e => e.type === 'dedication_page');
  if (!hasTitle || !hasDedication) {
    const frontMatter = [];
    if (!hasTitle) {
      frontMatter.push({ type: 'title_page', page: 'right', title, subtitle: `A bedtime story for ${childDetails.name || 'the child'}`, image_prompt: null });
      frontMatter.push({ type: 'blank', page: 'left' });
    }
    if (!hasDedication) {
      const dedText = (v2Vars?.dedication) || `For ${childDetails.name || 'the child'}`;
      frontMatter.push({ type: 'dedication_page', page: 'right', text: dedText, image_prompt: null });
      frontMatter.push({ type: 'blank', page: 'left' });
    }
    entries = [...frontMatter, ...entries];
  }

  // Override with approved title
  if (approvedTitle && titleEntry) {
    titleEntry.title = approvedTitle;
  }

  const plan = { title, entries };

  console.log(`[storyPlanner] Plan complete: "${title}" with ${spreads.length} spreads, ${entries.length} total entries`);
  return plan;
}

/**
 * Convert legacy format { title, spreads: [{spreadNumber, text, illustrationPrompt, ...}] }
 * to V2 entries array.
 */
function convertLegacyToV2(legacyPlan) {
  const entries = [
    { type: 'title_page', page: 'right', title: legacyPlan.title || 'My Story', subtitle: '', image_prompt: null },
    { type: 'blank', page: 'left' },
    { type: 'dedication_page', page: 'right', text: '', image_prompt: null },
    { type: 'blank', page: 'left' },
  ];

  for (const spread of (legacyPlan.spreads || [])) {
    entries.push({
      type: 'spread',
      spread: spread.spreadNumber,
      left: { text: spread.text || '', image_prompt: null },
      right: { text: null, image_prompt: null },
      spread_image_prompt: spread.illustrationPrompt || spread.illustrationDescription || '',
    });
  }

  return entries;
}

/**
 * Attempt to repair truncated JSON by closing unclosed brackets/braces.
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
