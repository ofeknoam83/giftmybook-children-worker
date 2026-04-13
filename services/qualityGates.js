/**
 * Quality gate checks for generated children's book stories.
 * W3: Custom details usage enforcement (log-only).
 * W7: Story critic scoring (log-only).
 *
 * Self-contained LLM routing: tries OpenAI GPT 5.4 first, falls back to Gemini.
 */

const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// ── Lightweight LLM routing (mirrors storyPlanner.callLLM) ──

async function fetchWithTimeout(url, init, timeoutMs, label) {
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => { didTimeout = true; controller.abort(); }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (didTimeout) throw new Error(`${label || 'LLM request'} timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAI(systemPrompt, userPrompt, opts = {}) {
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error('OpenAI API key not available');

  const resp = await fetchWithTimeout(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: opts.temperature || 0.2,
        max_tokens: opts.maxTokens || 500,
        ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    },
    opts.timeout || 15000,
    'qualityGates-openai',
  );
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await resp.text().catch(() => 'unknown')}`);
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || '';
  return { text, inputTokens: data.usage?.prompt_tokens || 0, outputTokens: data.usage?.completion_tokens || 0 };
}

async function callGeminiText(systemPrompt, userPrompt, opts = {}) {
  const apiKey = process.env.GOOGLE_AI_STUDIO_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not available');

  const resp = await fetchWithTimeout(
    `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          maxOutputTokens: opts.maxTokens || 500,
          temperature: opts.temperature || 0.2,
          ...(opts.jsonMode ? { responseMimeType: 'application/json' } : {}),
        },
      }),
    },
    opts.timeout || 15000,
    'qualityGates-gemini',
  );
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${await resp.text().catch(() => 'unknown')}`);
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return { text, inputTokens: data.usageMetadata?.promptTokenCount || 0, outputTokens: data.usageMetadata?.candidatesTokenCount || 0 };
}

async function callLLM(systemPrompt, userPrompt, opts = {}) {
  const openaiKey = opts.openaiApiKey || process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const result = await callOpenAI(systemPrompt, userPrompt, { ...opts, apiKey: openaiKey });
      if (opts.costTracker) opts.costTracker.addTextUsage('gpt-4.1-mini', result.inputTokens, result.outputTokens);
      return result;
    } catch (err) {
      console.warn(`[qualityGates] OpenAI failed, falling back to Gemini: ${err.message}`);
    }
  }
  const result = await callGeminiText(systemPrompt, userPrompt, opts);
  if (opts.costTracker) opts.costTracker.addTextUsage(GEMINI_MODEL, result.inputTokens, result.outputTokens);
  return result;
}

// ── W3: Custom details usage check ──

/**
 * Check if the story uses the key details from customDetails.
 * Returns { details: Array, score: number, missingCritical: string[] }
 */
async function checkCustomDetailsUsage(storyEntries, customDetails, opts = {}) {
  if (!customDetails || !storyEntries || storyEntries.length === 0) {
    return { details: [], score: 10, missingCritical: [] };
  }

  const storyText = storyEntries
    .map(e => e.text || [e.left?.text, e.right?.text].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' ');

  const systemPrompt = `You are a children's book quality checker. Given the parent's input about their child (customDetails) and the generated story, check if the story actually uses the personal details.`;

  const userPrompt = `CUSTOM DETAILS (what the parent told us):
${customDetails}

GENERATED STORY:
${storyText.slice(0, 3000)}

Extract the 5 most important personal details from customDetails (names, activities, foods, toys, pets, habits, memorable moments).
For each: check if it appears in the story (directly or referenced).

Return JSON only:
{
  "details": [
    { "detail": "loves tractors", "found": true },
    { "detail": "baby sister Audrey", "found": false }
  ],
  "score": 7,
  "missingCritical": ["baby sister Audrey"]
}

score: 0-10 (10 = all details used). missingCritical: details that SHOULD be in the story but aren't.`;

  try {
    const resp = await callLLM(systemPrompt, userPrompt, {
      temperature: 0.1,
      maxTokens: 500,
      jsonMode: true,
      timeout: 8000,
      ...opts,
    });
    const text = (resp.text || '').replace(/```json\s*/i, '').replace(/```/g, '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch (e) {
    console.warn('[qualityGates] customDetails check failed:', e.message);
  }
  return { details: [], score: 10, missingCritical: [] };
}

// ── W7: Story critic ──

/**
 * Run a quality critic on the generated story.
 * Returns { scores: object, total: number, approved: boolean, weakestSpreads: number[], feedback: string }
 */
async function criticStory(storyEntries, customDetails, theme, childAge, opts = {}) {
  if (!storyEntries || storyEntries.length === 0) {
    return { approved: true, total: 60, feedback: '' };
  }

  const storyText = storyEntries
    .map(e => e.text || [e.left?.text, e.right?.text].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n---\n');

  const systemPrompt = `You are a children's book editor. Score this story on 4 criteria not covered by the main critic.`;

  const userPrompt = `CHILD AGE: ${childAge || 'unknown'}
THEME: ${theme || 'general'}
CUSTOM DETAILS: ${(customDetails || '').slice(0, 500)}

STORY (each section separated by --- is one spread):
${storyText.slice(0, 4000)}

Score each criterion 1-10:
1. PERSONALIZATION: Does the story use the child's specific details (name, interests, food, etc.)?
2. DIALOGUE: Is there natural, engaging, surprising character dialogue? Does the child sound like a real child (concrete, curious, sometimes funny)?
3. THEME FIT: Does the ending match the theme (birthday=celebratory, bedtime=peaceful, mothers_day=heartfelt)?
4. NO FILLER: Does every spread advance the story? Are there any greeting-card lines that should be cut?

Return JSON only:
{
  "scores": { "personalization": 8, "dialogue": 5, "theme_fit": 9, "no_filler": 8 },
  "total": 30,
  "approved": true,
  "weakestSpreads": [3, 7],
  "feedback": "Spread 3 feels generic — add a specific detail about the child's interests. Spread 7 lacks dialogue."
}

approved = true if total >= 24 (out of 40). weakestSpreads = spread numbers that need improvement.`;

  try {
    const resp = await callLLM(systemPrompt, userPrompt, {
      temperature: 0.2,
      maxTokens: 600,
      jsonMode: true,
      timeout: 10000,
      ...opts,
    });
    const text = (resp.text || '').replace(/```json\s*/i, '').replace(/```/g, '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch (e) {
    console.warn('[qualityGates] story critic failed:', e.message);
  }
  return { approved: true, total: 60, feedback: '' };
}

module.exports = { checkCustomDetailsUsage, criticStory };
