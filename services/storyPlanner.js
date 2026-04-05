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
 * Brainstorm a unique story seed based on the child's details.
 * Returns { favorite_object, fear, setting, storySeed } with creative,
 * non-generic elements tailored to this specific child.
 *
 * @param {object} childDetails - { name, age, gender, interests }
 * @param {string} customDetails - freeform text from the customer
 * @param {string} approvedTitle - if set, the story must fit this title
 * @param {object} [opts] - { apiKeys, costTracker }
 * @returns {Promise<object>} { favorite_object, fear, setting, storySeed }
 */
async function brainstormStorySeed(childDetails, customDetails, approvedTitle, opts = {}) {
  const { costTracker, apiKeys } = opts;
  const openaiKey = apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  const name = childDetails.name || childDetails.childName || 'the child';
  const age = childDetails.age || childDetails.childAge || 5;
  const gender = childDetails.gender || childDetails.childGender || '';
  const interests = (childDetails.interests || childDetails.childInterests || []).filter(Boolean);

  const systemPrompt = `You are a creative children's book story developer. Your job is to brainstorm a UNIQUE, ORIGINAL story concept for a personalized bedtime picture book.

You will receive details about a child. From these details, invent:

1. favorite_object: A specific companion or object the child carries through the story. NOT a generic teddy bear unless the customer mentioned one. Be creative — it could be a blanket with a name, a toy dinosaur, a music box, a pair of rain boots, a jar of fireflies, etc. If the child has interests, draw from those.

2. fear: A gentle challenge or emotional tension for a bedtime story. NOT always "the dark". Could be: a sound they can't identify, a missing thing they need to find, a place that looks different at night, a friend who isn't answering, being too small to reach something, a storm outside, the feeling of being alone, etc. Make it age-appropriate and specific.

3. setting: A vivid, specific world for the story. NOT "an enchanted forest" every time. Could be: the garden behind their house at twilight, a houseboat on a still lake, a rooftop where pigeons sleep, a grandmother's kitchen that transforms at night, a library after closing time, a train car with curtained windows, etc.

4. storySeed: One sentence describing the unique emotional journey. Example: "A child discovers that the rumbling sound in the walls is just the old house settling, and learns to hear it as a lullaby."

Be ORIGINAL. Never repeat the same combination twice. Draw from the child's name, age, gender, interests, and any custom details to make this feel personal.

You MUST return ONLY a JSON object with exactly these 4 fields, nothing else:
{"favorite_object": "...", "fear": "...", "setting": "...", "storySeed": "..."}`;

  const parts = [`Child: ${name}, age ${age}`];
  if (gender && gender !== 'neutral' && gender !== 'not specified') {
    parts.push(gender === 'male' ? 'boy' : gender === 'female' ? 'girl' : gender);
  }
  if (interests.length) parts.push(`Interests: ${interests.join(', ')}`);
  if (customDetails) parts.push(`Customer note: ${customDetails}`);
  if (approvedTitle) parts.push(`The book title is already chosen: "${approvedTitle}". The story seed must fit this title.`);

  const userPrompt = parts.join('. ');

  console.log(`[storyPlanner] Brainstorming story seed for ${name}...`);
  const seedStart = Date.now();

  const response = await callLLM(systemPrompt, userPrompt, {
    openaiApiKey: openaiKey,
    maxTokens: 500,
    temperature: 0.9,
    jsonMode: true,
    costTracker,
  });

  const seedMs = Date.now() - seedStart;
  console.log(`[storyPlanner] Story seed brainstormed in ${seedMs}ms (${response.model})`);

  let content = response.text;
  console.log(`[storyPlanner] Raw brainstorm response (${content.length} chars): ${content.slice(0, 300)}`);
  content = content.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');

  let seed;
  try {
    seed = JSON.parse(content);
  } catch (e) {
    // Try stripping markdown fences
    const stripped = content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      seed = JSON.parse(stripped);
    } catch (_) {
      console.warn(`[storyPlanner] Story seed JSON parse failed. Raw response (first 500 chars): ${content.slice(0, 500)}`);
      console.warn(`[storyPlanner] Parse error: ${e.message}`);
      // Last resort: try to extract values with regex from free text
      const extractField = (field) => {
        const match = content.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`, 'i'));
        return match ? match[1] : null;
      };
      const extracted = {
        favorite_object: extractField('favorite_object') || 'a stuffed bear',
        fear: extractField('fear') || 'the dark',
        setting: extractField('setting') || 'a magical place',
        storySeed: extractField('storySeed') || extractField('story_seed') || '',
      };
      if (extracted.favorite_object !== 'a stuffed bear' || extracted.fear !== 'the dark') {
        console.log(`[storyPlanner] Recovered seed from malformed JSON: ${JSON.stringify(extracted)}`);
        return extracted;
      }
      return extracted;
    }
  }

  // Validate that we got real values, not empty strings
  if (!seed.favorite_object && !seed.fear && !seed.setting) {
    console.warn(`[storyPlanner] Story seed returned empty fields. Raw: ${content.slice(0, 300)}`);
    return { favorite_object: 'a stuffed bear', fear: 'the dark', setting: 'a magical place', storySeed: '' };
  }

  console.log(`[storyPlanner] Story seed: object="${seed.favorite_object}", fear="${seed.fear}", setting="${seed.setting}"`);
  return seed;
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

  // Propagate visual consistency fields from planner output
  if (parsed.characterOutfit) plan.characterOutfit = parsed.characterOutfit;
  if (parsed.characterDescription) plan.characterDescription = parsed.characterDescription;
  if (parsed.recurringElement) plan.recurringElement = parsed.recurringElement;
  if (parsed.keyObjects) plan.keyObjects = parsed.keyObjects;

  console.log(`[storyPlanner] Plan complete: "${title}" with ${spreads.length} spreads, ${entries.length} total entries`);
  if (plan.characterOutfit) console.log(`[storyPlanner] Character outfit: ${plan.characterOutfit}`);
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

// ── Self-Critic + Auto-Rewrite prompt ──

const SELF_CRITIC_SYSTEM = `CHILDREN'S BOOK — SELF-CRITIC + AUTO-REWRITE

You are a strict children's book editor.

Your job is to:
1) Critically evaluate the story
2) Identify weak or non-compliant lines
3) Rewrite ONLY what needs improvement
4) Return a stronger version of the SAME story

Do NOT change:
- plot
- structure
- characters
- number of spreads
- which page (left/right) has text vs null

Only improve the writing quality.

-------------------------------------
EVALUATION CRITERIA (STRICT)
-------------------------------------

Score each category from 1-10:

1. Emotional Writing
- Is emotion shown (not told)?
- Any "she felt / she was scared" → penalty

2. Language Quality
- Any generic phrases?
- Any replaceable sentences?

3. Imagery
- Are visuals specific and vivid?
- Or vague and common?

4. Authorial Voice
- Does it feel like a real author?
- Or like AI-generated text?

5. Child Agency
- Does the child actively drive the story?

6. Transformation
- Does the repeated element evolve meaningfully?

7. Ending Quality
- Is the ending soft, poetic, and non-generic?

-------------------------------------
VIOLATION DETECTION (MANDATORY)
-------------------------------------

List ALL lines that violate:

- Emotion telling
- Explanation (e.g. "she realized", "it was not scary")
- Generic wording
- Weak imagery
- Overused similes ("felt like", "like a...")
- Flat or unnecessary sentences

Be precise. Quote exact lines.

-------------------------------------
REWRITE RULES (CRITICAL)
-------------------------------------

- Rewrite ONLY flagged lines
- Keep original meaning
- Make language:
  - more specific
  - more sensory
  - more natural when read aloud

- Replace:
  - explanation → implication
  - telling → action or imagery

- Reduce similes if overused
- Improve rhythm (sentence variation)
- CUT TEXT: if any spread has more than ~25 words total, cut ruthlessly. Trust the illustration. Shorter is better.

-------------------------------------
ENDING UPGRADE (SPECIAL RULE)
-------------------------------------

If the ending is generic or explicit:
- Rewrite the final 1-3 lines to be:
  - softer
  - more poetic
  - non-explanatory
  - emotionally resonant

-------------------------------------
OUTPUT FORMAT (JSON)
-------------------------------------

Return a JSON object with exactly this structure:
{
  "scores": {
    "emotional_writing": <1-10>,
    "language_quality": <1-10>,
    "imagery": <1-10>,
    "authorial_voice": <1-10>,
    "child_agency": <1-10>,
    "transformation": <1-10>,
    "ending_quality": <1-10>
  },
  "issues": [
    { "line": "<exact quote>", "reason": "<violation type>" }
  ],
  "improved_spreads": [
    { "spread": 1, "left": "...", "right": "..." },
    ...
  ]
}

Rules for improved_spreads:
- Return ALL spreads (same count as input)
- If a spread needed no changes, return its text unchanged
- If left or right was null in the input, keep it null
- No explanations inside the story text

-------------------------------------
QUALITY BAR
-------------------------------------

Only return the rewritten story if it is CLEARLY better than the original.
If not, keep refining internally before output.`;

/**
 * Self-Critic + Auto-Rewrite pass — evaluates the story against strict
 * quality criteria, identifies violations, and rewrites only what needs
 * improvement. Returns a stronger version of the same story.
 *
 * @param {object} storyPlan - { title, entries: [...] }
 * @param {object} [opts] - { apiKeys, costTracker }
 * @returns {Promise<object>} Polished story plan with same structure
 */
async function polishStory(storyPlan, opts = {}) {
  const { costTracker, apiKeys } = opts;
  const openaiKey = apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  // Build a compact representation of just the text to rewrite
  const spreads = storyPlan.entries.filter(e => e.type === 'spread');
  const textMap = spreads.map(s => ({
    spread: s.spread,
    left: s.left?.text || null,
    right: s.right?.text || null,
  }));

  const userPrompt = `Here is the story to evaluate and improve (${spreads.length} spreads):\n\n${JSON.stringify(textMap)}`;

  console.log(`[storyPlanner] Starting self-critic + rewrite pass (${spreads.length} spreads)...`);
  const polishStart = Date.now();

  const response = await callLLM(SELF_CRITIC_SYSTEM, userPrompt, {
    openaiApiKey: openaiKey,
    maxTokens: 10000,
    temperature: 0.5,
    jsonMode: true,
    costTracker,
  });

  const polishMs = Date.now() - polishStart;
  console.log(`[storyPlanner] Self-critic pass completed in ${polishMs}ms (${response.model}, ${response.outputTokens} tokens)`);

  let content = response.text;
  // Sanitize common JSON issues
  content = content.replace(/\\'/g, "'");
  content = content.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');

  let result;
  try {
    result = JSON.parse(content);
  } catch (parseErr) {
    // Try stripping markdown fences
    const stripped = content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      result = JSON.parse(stripped);
    } catch (_) {
      console.warn(`[storyPlanner] Self-critic JSON parse failed: ${parseErr.message} — using original text`);
      return storyPlan;
    }
  }

  // Log scores and issues
  if (result.scores) {
    const scores = result.scores;
    const avg = Object.values(scores).reduce((a, b) => a + b, 0) / Object.values(scores).length;
    console.log(`[storyPlanner] Self-critic scores: ${JSON.stringify(scores)} (avg: ${avg.toFixed(1)})`);
  }
  if (result.issues && result.issues.length > 0) {
    console.log(`[storyPlanner] Self-critic found ${result.issues.length} issues:`);
    for (const issue of result.issues.slice(0, 10)) {
      console.log(`  - [${issue.reason}] "${(issue.line || '').slice(0, 80)}..."`);
    }
  }

  // Extract the improved spreads
  const polishedArray = result.improved_spreads || result.spreads || result.entries || [];
  if (!Array.isArray(polishedArray)) {
    console.warn(`[storyPlanner] Self-critic returned no improved_spreads array — using original text`);
    return storyPlan;
  }

  if (polishedArray.length !== spreads.length) {
    console.warn(`[storyPlanner] Self-critic returned ${polishedArray.length} spreads, expected ${spreads.length} — using original text`);
    return storyPlan;
  }

  // Apply improved text back into the story plan entries
  let changedCount = 0;
  const updatedEntries = storyPlan.entries.map(entry => {
    if (entry.type !== 'spread') return entry;
    const match = polishedArray.find(p => p.spread === entry.spread);
    if (!match) return entry;

    const updated = { ...entry };
    if (match.left !== undefined && entry.left) {
      if (match.left !== entry.left.text) changedCount++;
      updated.left = { ...entry.left, text: match.left };
    }
    if (match.right !== undefined && entry.right) {
      if (match.right !== entry.right.text) changedCount++;
      updated.right = { ...entry.right, text: match.right };
    }
    return updated;
  });

  console.log(`[storyPlanner] Self-critic pass: ${changedCount} page texts improved out of ${spreads.length * 2} pages`);

  return {
    ...storyPlan,
    entries: updatedEntries,
    _criticScores: result.scores || null,
    _criticIssueCount: (result.issues || []).length,
  };
}

module.exports = { planStory, polishStory, brainstormStorySeed };
