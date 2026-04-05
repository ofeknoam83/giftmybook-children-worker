/**
 * Story planner service.
 *
 * Two-phase pipeline for picture books:
 *   1. Text generation (free-form, no JSON) — focused on literary quality
 *   2. JSON structuring (JSON mode) — adds illustration prompts + visual metadata
 *
 * Falls back to single-call for early readers or if the two-phase parse fails.
 */

const { buildStoryPlannerSystem, STORY_PLANNER_USER: pbUserPrompt } = require('../prompts/pictureBook');
const { buildStoryWriterSystem, STORY_WRITER_USER, buildStoryStructurerSystem, STORY_STRUCTURER_USER } = require('../prompts/pictureBook');
const { STORY_PLANNER_SYSTEM: ER_SYSTEM, STORY_PLANNER_USER: erUserPrompt } = require('../prompts/earlyReader');
const { getAgeTier } = require('../prompts/writerBrief');

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
      max_completion_tokens: opts.maxTokens || 4000,
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
  const openaiKey = opts.openaiApiKey || process.env.OPENAI_API_KEY;

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

  const systemPrompt = `You are a creative children's book story developer. Your job is to brainstorm a UNIQUE, ORIGINAL story concept for a personalized bedtime picture book (12 spreads).

You will receive details about a child. From these details, invent:

1. favorite_object: A specific companion or object the child carries through the story. NOT a generic teddy bear unless the customer mentioned one. Be creative — it could be a blanket with a name, a toy dinosaur, a music box, a pair of rain boots, a jar of fireflies, etc. If the child has interests, draw from those.

2. fear: A gentle challenge or emotional tension for a bedtime story. NOT always "the dark". Could be: a sound they can't identify, a missing thing they need to find, a place that looks different at night, a friend who isn't answering, being too small to reach something, a storm outside, the feeling of being alone, etc. Make it age-appropriate and specific.

3. setting: A vivid, specific world for the story. NOT "an enchanted forest" every time. Could be: the garden behind their house at twilight, a houseboat on a still lake, a rooftop where pigeons sleep, a grandmother's kitchen that transforms at night, a library after closing time, a train car with curtained windows, etc.

4. storySeed: One sentence describing the unique emotional journey. Example: "A child discovers that the rumbling sound in the walls is just the old house settling, and learns to hear it as a lullaby."

5. repeated_phrase: A short, soothing phrase (2-6 words) that will repeat through the story and evolve in meaning. NOT generic ("everything will be okay"). Should feel like it belongs in THIS story. Example: "hush now, little seed" or "the house remembers."

6. phrase_arc: Three short descriptions of how the repeated phrase evolves:
   - early: how it feels the first time (playful, uncertain, questioning)
   - middle: how it shifts (guiding, braver, searching)
   - end: how it lands (calm, safe, transformed)

7. beats: An array of exactly 12 one-line descriptions — one per spread — mapping the emotional journey. Follow this structure:
   - Spreads 1-2: Setup (normal world + emotional need)
   - Spreads 3-6: Rising tension (problem grows, uncertainty increases)
   - Spreads 7-9: Turning point + resolution (child takes action)
   - Spreads 10-11: Emotional release (world softens)
   - Spread 12: Sleep / stillness

ILLUSTRATION CONSTRAINT — NO FAMILY MEMBERS IN IMAGES:
The story text MAY mention family members (parents, grandparents, siblings) by name — they can speak, tuck the child in, etc. However, family members must NEVER appear as visible characters in illustrations. We only have the child's photo, so any depiction of relatives would be a fabricated guess. In illustration prompts, a caregiver's presence can be implied (a warm voice, a light from a doorway, a hand at the frame's edge, a tucked-in blanket) but never shown as a full person with a face. Keep this in mind when designing the setting and beats — scenes should center the child visually even when family is mentioned in text.

Be ORIGINAL. Never repeat the same combination twice. Draw from the child's name, age, gender, interests, and any custom details to make this feel personal.

You MUST return ONLY a JSON object with these fields:
{"favorite_object": "...", "fear": "...", "setting": "...", "storySeed": "...", "repeated_phrase": "...", "phrase_arc": ["early meaning", "middle meaning", "end meaning"], "beats": ["spread 1 beat", "spread 2 beat", ..., "spread 12 beat"]}`;

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
    maxTokens: 1500,
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
      console.warn(`[storyPlanner] Story seed JSON parse failed. Raw (500 chars): ${content.slice(0, 500)}`);
      // Last resort: regex extraction
      const extractField = (field) => {
        const match = content.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`, 'i'));
        return match ? match[1] : null;
      };
      return {
        favorite_object: extractField('favorite_object') || 'a stuffed bear',
        fear: extractField('fear') || 'the dark',
        setting: extractField('setting') || 'a magical place',
        storySeed: extractField('storySeed') || extractField('story_seed') || '',
        repeated_phrase: extractField('repeated_phrase') || '',
        phrase_arc: [],
        beats: [],
      };
    }
  }

  // Handle nested responses: GPT sometimes wraps in { storySeed: { ... } } or { data: { ... } }
  if (seed && !seed.favorite_object && typeof seed === 'object') {
    const inner = seed.storySeed || seed.data || seed.seed || seed.story || Object.values(seed)[0];
    if (inner && typeof inner === 'object' && inner.favorite_object) {
      console.log(`[storyPlanner] Unwrapped nested seed response`);
      seed = inner;
    }
  }

  // Validate we got usable values
  if (!seed || (!seed.favorite_object && !seed.fear && !seed.setting)) {
    console.warn(`[storyPlanner] Story seed has no usable fields. Parsed: ${JSON.stringify(seed).slice(0, 300)}`);
    return { favorite_object: 'a stuffed bear', fear: 'the dark', setting: 'a magical place', storySeed: '', repeated_phrase: '', phrase_arc: [], beats: [] };
  }

  if (!seed.repeated_phrase) seed.repeated_phrase = '';
  if (!Array.isArray(seed.phrase_arc)) seed.phrase_arc = [];
  if (!Array.isArray(seed.beats)) seed.beats = [];

  console.log(`[storyPlanner] Story seed: object="${seed.favorite_object}", fear="${seed.fear}", setting="${seed.setting}"`);
  if (seed.repeated_phrase) console.log(`[storyPlanner] Repeated phrase: "${seed.repeated_phrase}"`);
  if (seed.beats.length) console.log(`[storyPlanner] Beat sheet: ${seed.beats.length} beats`);
  return seed;
}

// ── Two-Phase Pipeline ──

/**
 * Parse free-form story text output into structured spread data.
 * Expected format:
 *   TITLE: ...
 *   DEDICATION: ...
 *   SPREAD 1:
 *   Left: "..." or null
 *   Right: "..." or null
 *   ...
 *
 * @param {string} text
 * @returns {{ title: string, dedication: string, spreads: Array<{ left: string|null, right: string|null }> } | null}
 */
function parseStoryText(text) {
  if (!text || typeof text !== 'string') return null;

  const titleMatch = text.match(/^TITLE:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim().replace(/^["']|["']$/g, '') : null;

  const dedMatch = text.match(/^DEDICATION:\s*(.+)$/m);
  const dedication = dedMatch ? dedMatch[1].trim().replace(/^["']|["']$/g, '') : null;

  const spreadBlocks = text.split(/^SPREAD\s+\d+\s*:/im).slice(1);
  if (spreadBlocks.length < 8) return null;

  const spreads = spreadBlocks.map(block => {
    const leftMatch = block.match(/^Left:\s*(.+)$/m);
    const rightMatch = block.match(/^Right:\s*(.+)$/m);

    const parsePageText = (match) => {
      if (!match) return null;
      const val = match[1].trim();
      if (/^null$/i.test(val) || /^\[visual\]$/i.test(val) || val === '-') return null;
      return val.replace(/^["']|["']$/g, '').trim() || null;
    };

    return {
      left: parsePageText(leftMatch),
      right: parsePageText(rightMatch),
    };
  });

  if (!title || spreads.length < 8) return null;
  return { title, dedication, spreads };
}

/**
 * Phase 1: Generate story text freely (no JSON mode).
 * Returns raw text output from the LLM.
 */
async function generateStoryText(childDetails, theme, customDetails, opts = {}) {
  const { costTracker, apiKeys, approvedTitle, v2Vars } = opts;
  const openaiKey = apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  const briefVars = v2Vars || {
    name: childDetails.name || childDetails.childName || 'the child',
    age: childDetails.age || childDetails.childAge || 5,
    favorite_object: 'a stuffed bear',
    fear: 'the dark',
    setting: '',
  };

  const systemPrompt = buildStoryWriterSystem(briefVars);
  let userPrompt = STORY_WRITER_USER(childDetails, theme, customDetails, v2Vars);

  if (approvedTitle) {
    userPrompt += `\n\nIMPORTANT: The book title has already been chosen: "${approvedTitle}". You MUST use this exact title.`;
  }

  console.log(`[storyPlanner] Phase 1: Generating story text (free-form, no JSON)...`);
  const start = Date.now();

  const response = await callLLM(systemPrompt, userPrompt, {
    openaiApiKey: openaiKey,
    maxTokens: 4000,
    temperature: 0.85,
    jsonMode: false,
    costTracker,
  });

  const ms = Date.now() - start;
  console.log(`[storyPlanner] Phase 1 complete in ${ms}ms (${response.model}, ${response.outputTokens} tokens)`);

  return response.text;
}

/**
 * Phase 2: Convert story text into structured JSON with illustration prompts.
 * Uses JSON mode for reliable parsing.
 */
async function structureStoryPlan(storyText, childDetails, opts = {}) {
  const { costTracker, apiKeys, v2Vars } = opts;
  const openaiKey = apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  const briefVars = {
    name: childDetails.name || childDetails.childName || 'the child',
    favorite_object: v2Vars?.favorite_object || 'a stuffed bear',
  };

  const systemPrompt = buildStoryStructurerSystem(briefVars);
  const userPrompt = STORY_STRUCTURER_USER(storyText, childDetails, v2Vars);

  console.log(`[storyPlanner] Phase 2: Structuring into JSON with illustration prompts...`);
  const start = Date.now();

  const response = await callLLM(systemPrompt, userPrompt, {
    openaiApiKey: openaiKey,
    maxTokens: 8000,
    temperature: 0.3,
    jsonMode: true,
    costTracker,
  });

  const ms = Date.now() - start;
  console.log(`[storyPlanner] Phase 2 complete in ${ms}ms (${response.model}, ${response.outputTokens} tokens)`);

  return response.text;
}

/**
 * Validate story text quality programmatically.
 * Returns { valid, issues } where issues is an array of detected problems.
 *
 * @param {object} storyPlan - { entries: [...] }
 * @param {number} [maxWordsPerSpread]
 * @returns {{ valid: boolean, issues: Array<{ spread?: number, type: string, message: string }> }}
 */
function validateStoryText(storyPlan, maxWordsPerSpread) {
  const spreads = storyPlan.entries.filter(e => e.type === 'spread');
  const issues = [];
  const maxWords = maxWordsPerSpread || 30;

  for (const s of spreads) {
    const leftText = s.left?.text || '';
    const rightText = s.right?.text || '';
    const leftWords = leftText.split(/\s+/).filter(Boolean).length;
    const rightWords = rightText.split(/\s+/).filter(Boolean).length;
    const total = leftWords + rightWords;
    if (total > maxWords * 1.5) {
      issues.push({ spread: s.spread, type: 'word_count', message: `${total} words (limit ${maxWords})` });
    }
  }

  const TELLING_PATTERNS = [
    /\b(?:she|he|they|the child|the boy|the girl)\s+(?:felt|was|seemed|looked|appeared)\s+(?:happy|sad|scared|afraid|brave|excited|angry|worried|nervous|lonely|proud|surprised|relieved|safe|calm|tired)/i,
    /\b(?:realized|understood|knew) that\b/i,
    /\bit (?:was(?:n't| not)|wasn't) scary\b/i,
  ];
  for (const s of spreads) {
    const allText = [s.left?.text, s.right?.text].filter(Boolean).join(' ');
    for (const pattern of TELLING_PATTERNS) {
      const match = allText.match(pattern);
      if (match) {
        issues.push({ spread: s.spread, type: 'emotion_telling', message: `"${match[0]}"` });
      }
    }
  }

  const visualOnly = spreads.filter(s => !s.left?.text || !s.right?.text);
  if (visualOnly.length < 2) {
    issues.push({ type: 'visual_spreads', message: `Only ${visualOnly.length} visual-only pages (need >=2)` });
  }

  if (spreads.length < 10) {
    issues.push({ type: 'spread_count', message: `Only ${spreads.length} spreads (need 10-12)` });
  }

  const blocking = issues.filter(i => i.type === 'emotion_telling' || i.type === 'spread_count');
  return { valid: blocking.length === 0, issues };
}

/**
 * Single-call fallback — the original pipeline for when two-phase fails or for early readers.
 */
async function planStorySingleCall(childDetails, theme, bookFormat, customDetails, opts = {}) {
  const { costTracker, approvedTitle, apiKeys, v2Vars } = opts;
  const isPictureBook = bookFormat === 'picture_book';
  const childAge = childDetails.age || childDetails.childAge || 5;

  let systemPrompt, userPrompt;

  if (isPictureBook) {
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

  const llmStart = Date.now();
  const response = await callLLM(systemPrompt, userPrompt, {
    openaiApiKey: openaiKey,
    maxTokens: 10000,
    temperature: 0.8,
    jsonMode: true,
    costTracker,
  });
  const llmMs = Date.now() - llmStart;

  console.log(`[storyPlanner] Single-call ${response.model} completed in ${llmMs}ms (input: ${response.inputTokens}, output: ${response.outputTokens} tokens)`);

  return parseJsonPlan(response.text, response.finishReason);
}

/**
 * Parse a JSON plan response, handling common LLM output issues.
 * @param {string} content - raw LLM output
 * @param {string} [finishReason]
 * @returns {object} parsed JSON
 */
function parseJsonPlan(content, finishReason) {
  if (!content) {
    throw new Error(`Empty response from story planner (finish_reason: ${finishReason})`);
  }

  content = content.replace(/\\'/g, "'");
  content = content.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (parseErr) {
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

  return parsed;
}

/**
 * Normalize a parsed JSON plan into the canonical entry structure.
 * @param {object} parsed - raw parsed JSON from LLM
 * @param {object} childDetails
 * @param {object} opts - { approvedTitle, v2Vars }
 * @returns {{ title: string, entries: Array<object>, characterOutfit?: string, characterDescription?: string, recurringElement?: string, keyObjects?: string }}
 */
function normalizePlan(parsed, childDetails, opts = {}) {
  const { approvedTitle, v2Vars } = opts;

  let entries;
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (Array.isArray(parsed.entries)) {
    entries = parsed.entries;
  } else if (Array.isArray(parsed.spreads)) {
    entries = convertLegacyToV2(parsed);
  } else {
    const firstArray = Object.values(parsed).find(v => Array.isArray(v) && v.length > 0 && v[0]?.type);
    if (firstArray) {
      entries = firstArray;
    } else {
      throw new Error('Invalid story plan: cannot find entries array');
    }
  }

  const titleEntry = entries.find(e => e.type === 'title_page');
  const title = approvedTitle || titleEntry?.title || parsed.title || 'My Story';

  let spreads = entries.filter(e => e.type === 'spread');
  if (spreads.length < 10) {
    console.warn(`[storyPlanner] Only ${spreads.length} spreads — expected 10-12`);
  }
  if (spreads.length > 12) {
    console.warn(`[storyPlanner] ${spreads.length} spreads — truncating to 12`);
    spreads = spreads.slice(0, 12).map((s, i) => ({ ...s, spread: i + 1 }));
  }

  const dedEntry = entries.find(e => e.type === 'dedication_page');
  const dedText = dedEntry?.text || v2Vars?.dedication || `For ${childDetails.name || 'the child'}`;
  const subtitle = `A bedtime story for ${childDetails.name || 'the child'}`;

  entries = [
    { type: 'half_title_page', title },
    { type: 'blank' },
    { type: 'title_page', title, subtitle },
    { type: 'copyright_page' },
    { type: 'dedication_page', text: dedText },
    ...spreads,
    { type: 'blank' },
    { type: 'closing_page' },
    { type: 'blank' },
  ];

  const plan = { title, entries };

  if (parsed.characterOutfit) plan.characterOutfit = parsed.characterOutfit;
  if (parsed.characterDescription) plan.characterDescription = parsed.characterDescription;
  if (parsed.recurringElement) plan.recurringElement = parsed.recurringElement;
  if (parsed.keyObjects) plan.keyObjects = parsed.keyObjects;

  console.log(`[storyPlanner] Plan complete: "${title}" with ${spreads.length} spreads, ${entries.length} total entries`);
  if (plan.characterOutfit) console.log(`[storyPlanner] Character outfit: ${plan.characterOutfit}`);
  return plan;
}

/**
 * Plan a complete story.
 *
 * For picture books: uses two-phase pipeline (text generation → JSON structuring)
 * with single-call fallback. For early readers: uses single-call directly.
 *
 * @param {object} childDetails - { name, age, gender, appearance, interests }
 * @param {string} theme
 * @param {string} bookFormat - 'picture_book' or 'early_reader'
 * @param {string} customDetails
 * @param {object} [opts] - { apiKeys, costTracker, approvedTitle, v2Vars }
 * @returns {Promise<{ title: string, entries: Array<object> }>}
 */
async function planStory(childDetails, theme, bookFormat, customDetails, opts = {}) {
  const { costTracker, approvedTitle, v2Vars } = opts;
  const isPictureBook = bookFormat === 'picture_book';

  console.log(`[storyPlanner] Planning ${bookFormat} story for ${childDetails.name}, theme: ${theme}`);

  if (!isPictureBook) {
    const parsed = await planStorySingleCall(childDetails, theme, bookFormat, customDetails, opts);
    return normalizePlan(parsed, childDetails, opts);
  }

  // ── Two-phase pipeline for picture books ──
  const pipelineStart = Date.now();

  try {
    // Phase 1: Generate story text freely
    const storyText = await generateStoryText(childDetails, theme, customDetails, opts);

    // Try to parse the free-form text
    const parsedText = parseStoryText(storyText);
    if (!parsedText) {
      console.warn(`[storyPlanner] Free-form text parse failed — falling back to single-call`);
      throw new Error('Text parse failed');
    }
    console.log(`[storyPlanner] Parsed ${parsedText.spreads.length} spreads from free-form text, title: "${parsedText.title}"`);

    // Phase 2: Structure into JSON with illustration prompts
    const jsonContent = await structureStoryPlan(storyText, childDetails, opts);
    const parsed = parseJsonPlan(jsonContent);

    // Override title if customer approved one
    if (approvedTitle) parsed.title = approvedTitle;

    const plan = normalizePlan(parsed, childDetails, opts);

    // Validate the text quality programmatically
    const childAge = childDetails.age || childDetails.childAge || 5;
    const { config } = getAgeTier(childAge);
    const validation = validateStoryText(plan, config.maxWordsPerSpread);
    if (validation.issues.length > 0) {
      console.log(`[storyPlanner] Validation found ${validation.issues.length} issues:`);
      for (const issue of validation.issues) {
        console.log(`  - [${issue.type}] ${issue.spread ? `spread ${issue.spread}: ` : ''}${issue.message}`);
      }
    }

    const totalMs = Date.now() - pipelineStart;
    console.log(`[storyPlanner] Two-phase pipeline complete in ${totalMs}ms`);
    return plan;

  } catch (twoPhaseErr) {
    console.warn(`[storyPlanner] Two-phase pipeline failed: ${twoPhaseErr.message} — falling back to single-call`);
    const parsed = await planStorySingleCall(childDetails, theme, bookFormat, customDetails, opts);
    const plan = normalizePlan(parsed, childDetails, opts);

    const totalMs = Date.now() - pipelineStart;
    console.log(`[storyPlanner] Fallback single-call complete in ${totalMs}ms`);
    return plan;
  }
}

/**
 * Convert legacy format { title, spreads: [{spreadNumber, text, illustrationPrompt, ...}] }
 * to V2 entries array.
 */
function convertLegacyToV2(legacyPlan) {
  const title = legacyPlan.title || 'My Story';
  const spreads = (legacyPlan.spreads || []).map(spread => ({
    type: 'spread',
    spread: spread.spreadNumber,
    left: { text: spread.text || '', image_prompt: null },
    right: { text: null, image_prompt: null },
    spread_image_prompt: spread.illustrationPrompt || spread.illustrationDescription || '',
  }));

  const entries = [
    { type: 'half_title_page', title },
    { type: 'blank' },
    { type: 'title_page', title, subtitle: '' },
    { type: 'copyright_page' },
    { type: 'dedication_page', text: '' },
    ...spreads,
    { type: 'blank' },
    { type: 'closing_page' },
    { type: 'blank' },
  ];

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

module.exports = { planStory, polishStory, brainstormStorySeed, validateStoryText };
