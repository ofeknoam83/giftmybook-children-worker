/**
 * Text generator service.
 *
 * Generates and refines the text for each spread/page based on the story plan.
 * Enforces age-appropriate vocabulary and style constraints.
 */

const { TEXT_GENERATOR_SYSTEM: PB_TEXT_SYSTEM, VOCABULARY_CHECK_PROMPT } = require('../prompts/pictureBook');
const { TEXT_GENERATOR_SYSTEM: ER_TEXT_SYSTEM } = require('../prompts/earlyReader');
const gemini = require('./gemini');
const { getPronounInfo, buildPronounInstruction, checkPronounConsistency, simpleReplace } = require('./pronouns');

/**
 * Remove em-dashes, en-dashes, and normalize punctuation for children's books.
 * Applied to all generated story text as a post-processing step.
 */
function sanitizePunctuation(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/\s*\u2014\s*/g, '. ')   // em-dash → period + space
    .replace(/\s*\u2013\s*/g, ', ')   // en-dash → comma + space
    .replace(/\.(\s*\.)+/g, '.')      // collapse multiple periods
    .replace(/,\s*\./g, '.')          // fix ", ." → "."
    .replace(/\.\s*,/g, '.')          // fix ". ," → "."
    .replace(/\s{2,}/g, ' ')          // collapse double spaces
    .trim();
}

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Age group word limits and style rules.
 */
const FORMAT_RULES = {
  picture_book: {
    minWords: 8,
    maxWords: 20,
    ageGroup: '3-6',
    style: 'One or two SHORT complete sentences. Each page\'s text must stand alone — never split a sentence across pages. Simple words, rhyming welcome.',
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
      break; // success
    } catch (fetchErr) {
      console.warn(`[textGenerator] Fetch attempt ${attempt}/3 failed: ${fetchErr.message}`);
      if (attempt === 3) throw fetchErr;
      await new Promise(r => setTimeout(r, 2000 * attempt)); // 2s, 4s backoff
    }
  }

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

  const pronouns = getPronounInfo(childDetails.gender);
  const pronounInstruction = buildPronounInstruction(childDetails.name, childDetails.gender);

  const userPrompt = `Story title: "${storyContext.title || 'Untitled'}"
Child character: ${childDetails.name}, age ${childDetails.age}, ${childDetails.gender} (ALWAYS use ${pronouns.pair} pronouns)
Spread ${spreadPlan.spreadNumber} of ${storyContext.totalSpreads || '?'}
Layout: ${spreadPlan.layoutType}
Mood: ${spreadPlan.mood || 'cheerful'}
${pronounInstruction ? `\n${pronounInstruction}\n` : ''}
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

  // Sanitize dashes and normalize punctuation for children's books
  text = sanitizePunctuation(text);

  // Vocabulary check via Gemini (fast + cheap)
  try {
    const vocabResult = await checkVocabulary(text, rules.ageGroup, opts.apiKeys, costTracker);
    if (vocabResult && vocabResult !== text) {
      text = vocabResult;
    }
  } catch (vocabErr) {
    console.warn(`[textGenerator] Vocabulary check failed (using original text): ${vocabErr.message}`);
  }

  // Pronoun consistency check and auto-correct
  try {
    const pronounCheck = checkPronounConsistency(text, childDetails.gender);
    if (!pronounCheck.valid) {
      console.log(`[pronoun-fix] Spread ${spreadPlan.spreadNumber}: mismatch detected — wrong pronouns: ${pronounCheck.issues.map(i => `"${i.pronoun}" near "${i.context.trim()}"`).join(', ')}`);

      // Step 1: Try simple string replacement (fast, free)
      const replaced = simpleReplace(text, childDetails.gender);
      const recheck = checkPronounConsistency(replaced, childDetails.gender);

      if (recheck.valid) {
        console.log(`[pronoun-fix] Spread ${spreadPlan.spreadNumber}: fixed via simple replacement`);
        text = replaced;
      } else {
        // Step 2: Fall back to LLM correction
        console.log(`[pronoun-fix] Spread ${spreadPlan.spreadNumber}: simple replacement insufficient (${recheck.issues.length} issues remain), trying LLM correction`);
        try {
          const correctionPrompt = `Fix the pronouns in this children's book text. ${childDetails.name} is a ${childDetails.gender === 'female' ? 'girl' : 'boy'} — use ONLY ${pronouns.pair} pronouns when referring to ${childDetails.name}. Keep everything else exactly the same. Do not add, remove, or change any other words.\n\nText to fix:\n${replaced}\n\nFixed text:`;
          const correctionResult = await callGeminiText(
            'You are a precise text editor. Fix only the pronouns as instructed. Return only the corrected text.',
            correctionPrompt,
            { maxOutputTokens: 500, temperature: 0.1 }
          );
          if (correctionResult.text && correctionResult.text.trim()) {
            const llmFixed = correctionResult.text.trim();
            const finalCheck = checkPronounConsistency(llmFixed, childDetails.gender);
            if (finalCheck.valid) {
              console.log(`[pronoun-fix] Spread ${spreadPlan.spreadNumber}: fixed via LLM correction`);
              text = llmFixed;
            } else {
              console.log(`[pronoun-fix] Spread ${spreadPlan.spreadNumber}: LLM correction still has ${finalCheck.issues.length} issues — using simple-replaced version`);
              text = replaced;
            }
            if (costTracker) {
              costTracker.addTextUsage(GEMINI_MODEL, correctionResult.inputTokens, correctionResult.outputTokens);
            }
          }
        } catch (llmErr) {
          console.warn(`[pronoun-fix] Spread ${spreadPlan.spreadNumber}: LLM correction failed (${llmErr.message}) — using simple-replaced version`);
          text = replaced;
        }
      }
    }
  } catch (pronounErr) {
    console.warn(`[pronoun-fix] Spread ${spreadPlan.spreadNumber}: pronoun check failed: ${pronounErr.message}`);
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

module.exports = { generateSpreadText, sanitizePunctuation };
