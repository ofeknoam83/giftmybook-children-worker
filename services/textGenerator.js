/**
 * Text generator service.
 *
 * Generates and refines the text for each spread/page based on the story plan.
 * Enforces age-appropriate vocabulary and style constraints.
 */

const { TEXT_GENERATOR_SYSTEM: PB_TEXT_SYSTEM, VOCABULARY_CHECK_PROMPT } = require('../prompts/pictureBook');
const { TEXT_GENERATOR_SYSTEM: ER_TEXT_SYSTEM } = require('../prompts/earlyReader');
const gemini = require('./gemini');

const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

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
 * Call Gemini 3.1 Flash text generation API.
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
    throw new Error(`Gemini text API error ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const result = await resp.json();
  const candidate = result.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text || '';
  const inputTokens = result.usageMetadata?.promptTokenCount || 0;
  const outputTokens = result.usageMetadata?.candidatesTokenCount || 0;

  return { text, inputTokens, outputTokens };
}

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
  const { costTracker } = opts;
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

  const textGenStart = Date.now();
  const response = await callGeminiText(systemPrompt, userPrompt, {
    maxOutputTokens: 500,
    temperature: 0.7,
  });
  const textGenMs = Date.now() - textGenStart;

  if (costTracker) {
    costTracker.addTextUsage(GEMINI_MODEL, response.inputTokens, response.outputTokens);
  }

  let text = (response.text || '').trim();
  if (!text) {
    throw new Error(`Empty text response for spread ${spreadPlan.spreadNumber}`);
  }

  // Strip any markdown formatting the model might add
  text = text.replace(/^#+\s*/gm, '').replace(/\*\*/g, '').replace(/\*/g, '').trim();

  // Vocabulary check via Gemini (fast + cheap)
  try {
    const vocabResult = await checkVocabulary(text, rules.ageGroup, opts.apiKeys, costTracker);
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

  console.log(`[textGenerator] Spread ${spreadPlan.spreadNumber} generated in ${textGenMs}ms (${wordCount} words, ${response.inputTokens}+${response.outputTokens} tokens)`);

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

  const resultText = typeof result === 'string' ? result : result.text;
  const inputTokens = typeof result === 'object' ? result.inputTokens : 0;
  const outputTokens = typeof result === 'object' ? result.outputTokens : 0;

  if (costTracker) {
    costTracker.addTextUsage('gemini-2.5-flash', inputTokens, outputTokens);
  }

  const response = (resultText || '').trim();

  try {
    const cleaned = response.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.approved === true || parsed.approved === 'true') {
      return null;
    }
    if (parsed.suggestion && typeof parsed.suggestion === 'string' && parsed.suggestion.length > 10) {
      return parsed.suggestion;
    }
    return null;
  } catch {
    // Not JSON — use the old heuristic
  }

  if (response.toLowerCase().includes('no changes') || response.toLowerCase().includes('text is appropriate') || response.toLowerCase().includes('approved')) {
    return null;
  }

  if (response.length > 10 && response.length < text.length * 2 && !response.startsWith('{')) {
    return response;
  }

  return null;
}

module.exports = { generateSpreadText };
