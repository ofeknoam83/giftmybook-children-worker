/**
 * Story planner service.
 *
 * Takes child details, theme, and book format, then generates a
 * spread-by-spread story outline using GPT-5.4.
 *
 * Picture books: 12-16 spreads, ~30-60 words per spread
 * Early readers: 24-32 pages, ~60-150 words per page
 */

const OpenAI = require('openai');
const { STORY_PLANNER_SYSTEM: PB_SYSTEM, STORY_PLANNER_USER: pbUserPrompt } = require('../prompts/pictureBook');
const { STORY_PLANNER_SYSTEM: ER_SYSTEM, STORY_PLANNER_USER: erUserPrompt } = require('../prompts/earlyReader');

/** @type {OpenAI | null} */
let openaiClient = null;

/**
 * Get or create the OpenAI client.
 * @param {object} [apiKeys] - Optional API keys from request
 * @returns {OpenAI}
 */
function getOpenAI(apiKeys) {
  const key = apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured');
  // Always create fresh client if per-request key is provided
  if (apiKeys?.OPENAI_API_KEY || !openaiClient) {
    openaiClient = new OpenAI({ apiKey: key });
  }
  return openaiClient;
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
  const { apiKeys, costTracker } = opts;
  const client = getOpenAI(apiKeys);

  const isPictureBook = bookFormat === 'picture_book';
  const systemPrompt = isPictureBook ? PB_SYSTEM : ER_SYSTEM;
  const userPrompt = isPictureBook
    ? pbUserPrompt(childDetails, theme, customDetails)
    : erUserPrompt(childDetails, theme, customDetails);

  console.log(`[storyPlanner] Planning ${bookFormat} story for ${childDetails.name}, theme: ${theme}`);
  console.log(`[storyPlanner] Using model: gpt-5.4, system prompt: ${systemPrompt.length} chars, user prompt: ${userPrompt.length} chars`);

  let response;
  try {
    response = await client.chat.completions.create({
    model: 'gpt-5.4',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.8,
    max_completion_tokens: 8000,
  });
  } catch (apiErr) {
    console.error('[storyPlanner] OpenAI API call failed:', apiErr.message, apiErr.status || '', apiErr.code || '');
    throw new Error(`Story planner API call failed: ${apiErr.message}`);
  }

  if (costTracker) {
    costTracker.addTextUsage('gpt-5.4', response.usage?.prompt_tokens || 0, response.usage?.completion_tokens || 0);
  }

  const choice = response.choices[0];
  const content = choice?.message?.content;
  const finishReason = choice?.finish_reason || 'unknown';
  if (!content) {
    const refusal = choice?.message?.refusal || null;
    console.error('[storyPlanner] Empty response details:', JSON.stringify({
      finishReason, refusal, usage: response.usage, model: response.model,
    }));
    throw new Error(`Empty response from story planner (finish_reason: ${finishReason}, refusal: ${refusal || 'none'})`);
  }
  // If truncated by length, try to salvage partial JSON
  if (finishReason === 'length') {
    console.warn(`[storyPlanner] Response truncated (finish_reason: length, ${content.length} chars). Attempting to salvage...`);
  }
  console.log(`[storyPlanner] Response received: ${content.length} chars, finish_reason: ${choice.finish_reason}`);

  let plan;
  try {
    plan = JSON.parse(content);
  } catch (parseErr) {
    throw new Error(`Failed to parse story plan JSON: ${parseErr.message}`);
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
      spread.layoutType = 'TEXT_BOTTOM'; // default fallback
    }
    spread.illustrationDescription = spread.illustrationDescription || '';
    spread.mood = spread.mood || 'cheerful';
    spread.text = spread.text || '';
  }

  // For picture books, do a rhyme/rhythm pass
  if (isPictureBook && plan.spreads.length > 0) {
    plan = await applyRhymePass(client, plan, childDetails, costTracker);
  }

  // Enforce spread cap to prevent runaway generation costs
  if (plan.spreads.length > 16) {
    console.warn(`[storyPlanner] Plan has ${plan.spreads.length} spreads — truncating to 16 (keeping first 3 + last 3, cutting middle)`);
    const first = plan.spreads.slice(0, 3);
    const last = plan.spreads.slice(-3);
    const middle = plan.spreads.slice(3, -3).slice(0, 10);
    plan.spreads = [...first, ...middle, ...last];
    // Re-number spreads sequentially
    plan.spreads.forEach((s, i) => { s.spreadNumber = i + 1; });
  }

  const spreadRange = isPictureBook ? [12, 16] : [24, 32];
  if (plan.spreads.length < spreadRange[0]) {
    console.warn(`[storyPlanner] Plan has only ${plan.spreads.length} spreads (expected ${spreadRange[0]}-${spreadRange[1]})`);
  }

  console.log(`[storyPlanner] Plan complete: "${plan.title}" with ${plan.spreads.length} spreads`);
  return plan;
}

/**
 * Apply a rhyme/rhythm refinement pass for picture books.
 *
 * @param {OpenAI} client
 * @param {object} plan
 * @param {object} childDetails
 * @param {object} [costTracker]
 * @returns {Promise<object>}
 */
async function applyRhymePass(client, plan, childDetails, costTracker) {
  console.log(`[storyPlanner] Applying rhyme/rhythm pass...`);

  const spreadTexts = plan.spreads.map(s => `Spread ${s.spreadNumber}: ${s.text}`).join('\n');

  const response = await client.chat.completions.create({
    model: 'gpt-5.4',
    messages: [
      {
        role: 'system',
        content: `You are a children's picture book poet. Your job is to refine story text so it has a consistent rhythm and rhyming pattern (AABB or ABAB). Keep each spread's text to 30-60 words. Maintain the same story beats and character names. The child character is named ${childDetails.name}.

Return a JSON object with a "spreads" array. Each item must have "spreadNumber" (integer) and "text" (refined rhyming text).`,
      },
      {
        role: 'user',
        content: `Refine these spread texts to have a consistent rhyme scheme and rhythm:\n\n${spreadTexts}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7,
    max_completion_tokens: 6000,
  });

  if (costTracker) {
    costTracker.addTextUsage('gpt-5.4', response.usage?.prompt_tokens || 0, response.usage?.completion_tokens || 0);
  }

  try {
    const refined = JSON.parse(response.choices[0]?.message?.content || '{}');
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

module.exports = { planStory };
