/**
 * Text generator service.
 *
 * Generates and refines the text for each spread/page based on the story plan.
 * Enforces age-appropriate vocabulary and style constraints.
 */

const OpenAI = require('openai');
const { TEXT_GENERATOR_SYSTEM: PB_TEXT_SYSTEM, VOCABULARY_CHECK_PROMPT } = require('../prompts/pictureBook');
const { TEXT_GENERATOR_SYSTEM: ER_TEXT_SYSTEM } = require('../prompts/earlyReader');
const gemini = require('./gemini');

/** @type {OpenAI | null} */
let openaiClient = null;

/**
 * @param {object} [apiKeys]
 * @returns {OpenAI}
 */
function getOpenAI(apiKeys) {
  const key = apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured');
  if (apiKeys?.OPENAI_API_KEY || !openaiClient) {
    openaiClient = new OpenAI({ apiKey: key });
  }
  return openaiClient;
}

/**
 * Age group word limits and style rules.
 */
const FORMAT_RULES = {
  picture_book: {
    minWords: 20,
    maxWords: 60,
    ageGroup: '3-6',
    style: 'Simple, rhythmic sentences. Short words. Repetition and rhyme welcome. No complex vocabulary.',
  },
  early_reader: {
    minWords: 40,
    maxWords: 150,
    ageGroup: '6-9',
    style: 'Simple but varied sentences. Common words a first-grader can read. Short paragraphs. No long descriptions.',
  },
};

/**
 * Generate text for a single spread/page.
 *
 * @param {object} spreadPlan - { spreadNumber, text, illustrationDescription, layoutType, mood }
 * @param {object} childDetails - { name, age, gender, appearance, interests }
 * @param {string} bookFormat - 'picture_book' or 'early_reader'
 * @param {object} storyContext - { title, previousSpreads, totalSpreads }
 * @param {object} [opts] - { apiKeys, costTracker }
 * @returns {Promise<string>} The generated text for this spread
 */
async function generateSpreadText(spreadPlan, childDetails, bookFormat, storyContext, opts = {}) {
  const { apiKeys, costTracker } = opts;
  const client = getOpenAI(apiKeys);
  const rules = FORMAT_RULES[bookFormat] || FORMAT_RULES.picture_book;

  const isPictureBook = bookFormat === 'picture_book';
  const systemPrompt = isPictureBook ? PB_TEXT_SYSTEM : ER_TEXT_SYSTEM;

  const previousContext = (storyContext.previousSpreads || [])
    .slice(-3)
    .map((t, i) => `[Previous spread]: ${t}`)
    .join('\n');

  const userPrompt = `Story title: "${storyContext.title || 'Untitled'}"
Child character: ${childDetails.name}, age ${childDetails.age}, ${childDetails.gender}
Spread ${spreadPlan.spreadNumber} of ${storyContext.totalSpreads || '?'}
Layout: ${spreadPlan.layoutType}
Mood: ${spreadPlan.mood || 'cheerful'}

Scene outline: ${spreadPlan.text || spreadPlan.illustrationDescription || 'Continue the story'}

${previousContext ? `Recent story context:\n${previousContext}\n` : ''}
Write the final text for this spread. ${rules.minWords}-${rules.maxWords} words. ${rules.style}`;

  const response = await client.chat.completions.create({
    model: 'gpt-5.4',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    max_completion_tokens: 500,
  });

  if (costTracker) {
    costTracker.addTextUsage('gpt-5.4', response.usage?.prompt_tokens || 0, response.usage?.completion_tokens || 0);
  }

  let text = (response.choices[0]?.message?.content || '').trim();
  if (!text) {
    throw new Error(`Empty text response for spread ${spreadPlan.spreadNumber}`);
  }

  // Strip any markdown formatting the model might add
  text = text.replace(/^#+\s*/gm, '').replace(/\*\*/g, '').replace(/\*/g, '').trim();

  // Vocabulary check via Gemini (fast + cheap)
  try {
    const vocabResult = await checkVocabulary(text, rules.ageGroup, apiKeys, costTracker);
    if (vocabResult && vocabResult !== text) {
      text = vocabResult;
    }
  } catch (vocabErr) {
    console.warn(`[textGenerator] Vocabulary check failed (using original text): ${vocabErr.message}`);
  }

  // Word count validation
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount > rules.maxWords * 1.5) {
    console.warn(`[textGenerator] Spread ${spreadPlan.spreadNumber} has ${wordCount} words (max ${rules.maxWords}) - may need trimming`);
  }

  return text;
}

/**
 * Check vocabulary is age-appropriate using Gemini Flash (fast + cheap).
 *
 * @param {string} text
 * @param {string} ageGroup - e.g. '3-6' or '6-9'
 * @param {object} [apiKeys]
 * @param {object} [costTracker]
 * @returns {Promise<string|null>} Corrected text, or null if text is fine
 */
async function checkVocabulary(text, ageGroup, apiKeys, costTracker) {
  const prompt = VOCABULARY_CHECK_PROMPT(text, ageGroup);

  const result = await gemini.generateContent(prompt, {
    apiKeys,
    maxTokens: 500,
  });

  if (costTracker) {
    costTracker.addTextUsage('gemini-2.5-flash', result.inputTokens || 0, result.outputTokens || 0);
  }

  const response = (result.text || '').trim();

  // If Gemini says it's fine, return null (no changes needed)
  if (response.toLowerCase().includes('no changes') || response.toLowerCase().includes('text is appropriate')) {
    return null;
  }

  // If it returned corrected text, use it
  if (response.length > 10 && response.length < text.length * 2) {
    return response;
  }

  return null;
}

module.exports = { generateSpreadText };
