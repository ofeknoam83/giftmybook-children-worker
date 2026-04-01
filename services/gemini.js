/**
 * Gemini API client — for fast/cheap tasks (vocabulary checks, quality validation)
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

let genAI = null;

const MODELS = {
  flash: 'gemini-2.5-flash',
  fast: 'gemini-2.5-flash',
};

function getClient() {
  if (!genAI) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is not set');
    genAI = new GoogleGenerativeAI(key);
  }
  return genAI;
}

/**
 * Generate text content using Gemini.
 * @param {string} prompt
 * @param {object} opts - { model, systemPrompt, temperature, maxTokens }
 * @returns {Promise<string>}
 */
async function generateContent(prompt, opts = {}) {
  const client = getClient();
  const modelName = opts.model || MODELS.flash;
  const model = client.getGenerativeModel({
    model: modelName,
    ...(opts.systemPrompt ? { systemInstruction: opts.systemPrompt } : {}),
  });

  const genConfig = {};
  if (opts.temperature != null) genConfig.temperature = opts.temperature;
  if (opts.maxTokens) genConfig.maxOutputTokens = opts.maxTokens;

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: genConfig,
      });
      const text = result.response.text();
      if (!text) throw new Error('Empty response from Gemini');
      return text;
    } catch (err) {
      lastError = err;
      if (err.status === 429 || (err.message && err.message.includes('429'))) {
        const wait = Math.pow(2, attempt + 1) * 1000;
        console.warn(`[Gemini] Rate limited, retrying in ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Generate content with a function call schema (structured output).
 * @param {string} prompt
 * @param {object} functionDecl - { name, description, parameters }
 * @param {object} opts
 * @returns {Promise<object>} Parsed function call arguments
 */
async function functionCall(prompt, functionDecl, opts = {}) {
  const client = getClient();
  const modelName = opts.model || MODELS.flash;
  const model = client.getGenerativeModel({
    model: modelName,
    ...(opts.systemPrompt ? { systemInstruction: opts.systemPrompt } : {}),
    tools: [{ functionDeclarations: [functionDecl] }],
  });

  const genConfig = {};
  if (opts.temperature != null) genConfig.temperature = opts.temperature;
  if (opts.maxTokens) genConfig.maxOutputTokens = opts.maxTokens;

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: genConfig,
  });

  const response = result.response;
  const candidates = response.candidates || [];
  for (const candidate of candidates) {
    for (const part of candidate.content?.parts || []) {
      if (part.functionCall) {
        return part.functionCall.args;
      }
    }
  }

  // Fallback: try to parse text as JSON
  const text = response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('No function call in Gemini response and text is not valid JSON');
  }
}

/**
 * Reset the API key (used per-request when keys come from the standalone app).
 */
function setApiKey(key) {
  if (key) {
    genAI = new GoogleGenerativeAI(key);
  }
}

module.exports = { generateContent, functionCall, setApiKey, MODELS };
