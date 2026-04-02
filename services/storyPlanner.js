/**
 * Story planner service.
 *
 * Takes child details, theme, and book format, then generates a
 * spread-by-spread story outline using Gemini 3.1 Flash.
 *
 * Picture books: 12-16 spreads, ~30-60 words per spread
 * Early readers: 24-32 pages, ~60-150 words per page
 */

const { STORY_PLANNER_SYSTEM: PB_SYSTEM, STORY_PLANNER_USER: pbUserPrompt } = require('../prompts/pictureBook');
const { STORY_PLANNER_SYSTEM: ER_SYSTEM, STORY_PLANNER_USER: erUserPrompt } = require('../prompts/earlyReader');

const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Call Gemini 3.1 Flash text generation API.
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

  const resp = await fetch(
    `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

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
  const { costTracker, approvedTitle } = opts;

  const isPictureBook = bookFormat === 'picture_book';
  const systemPrompt = isPictureBook ? PB_SYSTEM : ER_SYSTEM;
  let userPrompt = isPictureBook
    ? pbUserPrompt(childDetails, theme, customDetails)
    : erUserPrompt(childDetails, theme, customDetails);

  // If there's an approved title from the cover selection, inject it into the prompt
  if (approvedTitle) {
    userPrompt += `\n\nIMPORTANT: The book title has already been chosen by the customer: "${approvedTitle}". You MUST use this exact title. Build the story around this title. Do not invent a different title.`;
  }

  console.log(`[storyPlanner] Planning ${bookFormat} story for ${childDetails.name}, theme: ${theme}`);
  console.log(`[storyPlanner] Using model: ${GEMINI_MODEL}, system prompt: ${systemPrompt.length} chars, user prompt: ${userPrompt.length} chars`);

  const geminiStart = Date.now();
  const response = await callGeminiText(systemPrompt, userPrompt, {
    maxOutputTokens: 8000,
    temperature: 0.8,
    responseMimeType: 'application/json',
  });
  const geminiMs = Date.now() - geminiStart;

  console.log(`[storyPlanner] Gemini API call completed in ${geminiMs}ms (input: ${response.inputTokens}, output: ${response.outputTokens} tokens)`);

  if (costTracker) {
    costTracker.addTextUsage(GEMINI_MODEL, response.inputTokens, response.outputTokens);
  }

  const content = response.text;
  const finishReason = response.finishReason;

  if (!content) {
    console.error('[storyPlanner] Empty response from Gemini');
    throw new Error(`Empty response from story planner (finish_reason: ${finishReason})`);
  }

  if (finishReason === 'MAX_TOKENS') {
    console.warn(`[storyPlanner] Response truncated (finish_reason: MAX_TOKENS, ${content.length} chars). Attempting to salvage...`);
  }
  console.log(`[storyPlanner] Response received: ${content.length} chars, finish_reason: ${finishReason}`);

  let plan;
  try {
    plan = JSON.parse(content);
  } catch (parseErr) {
    if (finishReason === 'MAX_TOKENS') {
      const repaired = repairTruncatedJson(content);
      if (repaired) {
        console.warn(`[storyPlanner] Salvaged truncated JSON after repair`);
        plan = repaired;
      } else {
        throw new Error(`Failed to parse or repair truncated story plan JSON: ${parseErr.message}`);
      }
    } else {
      throw new Error(`Failed to parse story plan JSON: ${parseErr.message}`);
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
    plan = await applyRhymePass(plan, childDetails, costTracker);
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
 * @returns {Promise<object>}
 */
async function applyRhymePass(plan, childDetails, costTracker) {
  console.log(`[storyPlanner] Applying rhyme/rhythm pass...`);

  const spreadTexts = plan.spreads.map(s => `Spread ${s.spreadNumber}: ${s.text}`).join('\n');

  const systemPrompt = `You are a children's picture book poet. Your job is to refine story text so it has a consistent rhythm and rhyming pattern (AABB or ABAB). Keep each spread's text to 30-60 words. Maintain the same story beats and character names. The child character is named ${childDetails.name}.

Return a JSON object with a "spreads" array. Each item must have "spreadNumber" (integer) and "text" (refined rhyming text).`;

  const userPrompt = `Refine these spread texts to have a consistent rhyme scheme and rhythm:\n\n${spreadTexts}`;

  const rhymeStart = Date.now();
  const response = await callGeminiText(systemPrompt, userPrompt, {
    maxOutputTokens: 6000,
    temperature: 0.7,
    responseMimeType: 'application/json',
  });
  console.log(`[storyPlanner] Rhyme pass Gemini call completed in ${Date.now() - rhymeStart}ms (input: ${response.inputTokens}, output: ${response.outputTokens} tokens)`);

  if (costTracker) {
    costTracker.addTextUsage(GEMINI_MODEL, response.inputTokens, response.outputTokens);
  }

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
