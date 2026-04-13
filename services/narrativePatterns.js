/**
 * Narrative Pattern Selector
 *
 * Selects 5-7 storytelling patterns tailored to each story's format, age, tone,
 * and emotional core. Runs after brainstormStorySeed() and feeds patterns into
 * generateStoryText() and masterCritic().
 *
 * Primary LLM: GPT-4.1-Mini (cheap/fast classification task)
 * Fallback: Gemini 3-Flash
 */

const DEFAULT_TIMEOUT_MS = 30000;

// ─────────────────────────────────────────
// Pattern Libraries
// ─────────────────────────────────────────

const SHARED_PATTERNS = {
  // OPENING
  concrete_opening: {
    category: 'opening',
    desc: 'Start with a specific, physical image or action. Avoid generic openings.',
  },
  in_motion_opening: {
    category: 'opening',
    desc: 'Start mid-action. No explanation. Context is implied through movement.',
  },
  mystery_object: {
    category: 'opening',
    desc: 'Introduce an unexplained object early. Its meaning unfolds later.',
  },

  // TENSION
  micro_failure: {
    category: 'tension',
    desc: 'Character tries 2-3 different approaches. Each fails for a different reason.',
  },
  escalation: {
    category: 'tension',
    desc: 'Each obstacle becomes harder. Avoid repetition.',
  },
  false_solution: {
    category: 'tension',
    desc: 'A solution seems to work, then quickly fails.',
  },
  constraint_shift: {
    category: 'tension',
    desc: 'Rules of the problem change. What worked before no longer works.',
  },

  // CHARACTER
  voice_spike: {
    category: 'character',
    desc: 'One short, memorable, slightly imperfect or funny line.',
  },
  literal_logic: {
    category: 'character',
    desc: 'Child interprets something in a literal or unexpected way.',
  },
  small_defiance: {
    category: 'character',
    desc: 'Character briefly resists or hesitates. Adds personality.',
  },
  unexpected_reaction: {
    category: 'character',
    desc: 'Character reacts in a slightly surprising but believable way.',
  },

  // STRUCTURE
  page_turn: {
    category: 'structure',
    desc: 'End a spread with an unresolved action or question.',
  },
  rule_of_three_break: {
    category: 'structure',
    desc: 'Pattern repeats twice, third time breaks expectation.',
  },

  // EMOTIONAL
  understated_peak: {
    category: 'emotional',
    desc: 'Emotional moment shown through action, not explained.',
  },
  quiet_pause: {
    category: 'emotional',
    desc: 'Slow moment before resolution. Fewer words, one action.',
  },
  physical_emotion: {
    category: 'emotional',
    desc: 'Emotion shown through touch, movement, or posture.',
  },

  // SURPRISE
  controlled_surprise: {
    category: 'surprise',
    desc: 'One small but meaningful unexpected shift that feels earned.',
  },
  role_reversal: {
    category: 'surprise',
    desc: 'Helper becomes obstacle or vice versa.',
  },
  scale_shift: {
    category: 'surprise',
    desc: 'Change perception of size or importance (small becomes big, etc.).',
  },

  // LANGUAGE
  rhythm_contrast: {
    category: 'language',
    desc: 'Mix long and very short sentences for read-aloud flow.',
  },
  sensory_anchor: {
    category: 'language',
    desc: 'Include one concrete sensory detail (smell, texture, sound).',
  },
};

const GN_PATTERNS = {
  // TENSION (GN-specific)
  scene_cliffhanger: {
    category: 'tension',
    desc: 'End a scene mid-action or mid-revelation. Next scene picks up after a beat.',
  },
  parallel_threads: {
    category: 'tension',
    desc: 'Cut between two simultaneous events across panels to build suspense.',
  },

  // CHARACTER (GN-specific)
  inner_monologue: {
    category: 'character',
    desc: "One caption box revealing what the character thinks but doesn't say.",
  },
  silent_panel_sequence: {
    category: 'character',
    desc: '2-3 wordless panels that carry emotion through visual storytelling alone.',
  },

  // STRUCTURE (GN-specific)
  splash_reveal: {
    category: 'structure',
    desc: 'Full-page or half-page panel at a key moment for dramatic weight.',
  },
  panel_rhythm: {
    category: 'structure',
    desc: 'Vary panel sizes deliberately — small tight panels for tension, wide for release.',
  },

  // LANGUAGE (GN-specific — these affect dialogue/captions)
  dialogue_subtext: {
    category: 'language',
    desc: 'Characters say one thing but mean another. Subtext visible in art.',
  },
  sound_typography: {
    category: 'language',
    desc: 'One impactful onomatopoeia or stylized sound effect that adds energy.',
  },
};

// ─────────────────────────────────────────
// Hardcoded fallback sets
// ─────────────────────────────────────────

const PB_FALLBACK = {
  selected_patterns: [
    { id: 'concrete_opening', how_to_apply: 'Open on a specific physical image or action.' },
    { id: 'understated_peak', how_to_apply: 'Show the emotional peak through action, not words.' },
    { id: 'physical_emotion', how_to_apply: 'Show emotion through touch, movement, or posture.' },
    { id: 'micro_failure', how_to_apply: 'Character tries 2-3 approaches, each fails differently.' },
    { id: 'page_turn', how_to_apply: 'End key spreads with unresolved action or question.' },
  ],
  strategy: 'Grounded opening, physical storytelling, tension through failure, page-turn momentum.',
};

const GN_FALLBACK = {
  selected_patterns: [
    { id: 'concrete_opening', how_to_apply: 'Open on a specific physical image or action.' },
    { id: 'understated_peak', how_to_apply: 'Show the emotional peak through action, not words.' },
    { id: 'physical_emotion', how_to_apply: 'Show emotion through touch, movement, or posture.' },
    { id: 'scene_cliffhanger', how_to_apply: 'End a scene mid-action for suspense.' },
    { id: 'splash_reveal', how_to_apply: 'Use a full-page panel at the key dramatic moment.' },
  ],
  strategy: 'Grounded opening, visual emotion, cliffhanger pacing, splash-page drama.',
};

// ─────────────────────────────────────────
// Library access
// ─────────────────────────────────────────

function getPatternLibrary(format) {
  if (format === 'graphic_novel') {
    return { ...SHARED_PATTERNS, ...GN_PATTERNS };
  }
  return { ...SHARED_PATTERNS };
}

// ─────────────────────────────────────────
// Prompt builder
// ─────────────────────────────────────────

function buildSelectorPrompt(inputs, patternLibrary) {
  const { story_type, age, goal, setting, tone } = inputs;
  const isGN = story_type === 'graphic_novel';
  const maxPatterns = isGN ? 7 : 6;

  const patternList = Object.entries(patternLibrary)
    .map(([id, p]) => `  ${id} [${p.category}]: ${p.desc}`)
    .join('\n');

  const gnInstruction = isGN
    ? '\nPrefer GN-specific patterns when they fit — they are designed for panel-based visual storytelling.'
    : '';

  return `You are a narrative pattern selector for children's books.

Given a story's parameters, select the best combination of storytelling patterns from the library below.

STORY PARAMETERS:
- Format: ${story_type}
- Age: ${age}
- Emotional goal: ${goal || 'joy'}
- Setting: ${setting || 'unspecified'}
- Tone: ${tone || 'playful'}

PATTERN LIBRARY:
${patternList}

SELECTION RULES:
1. ALWAYS include these 3 patterns: concrete_opening, understated_peak, physical_emotion
2. Then select: 1 tension pattern, 1 structure pattern, 1 character pattern, 1 surprise pattern
3. Optional: 1 language pattern (only if it genuinely fits the tone and age)
4. Maximum ${maxPatterns} patterns total${gnInstruction}

ANTI-GENERIC RULE:
Do NOT select patterns just because they're safe. Choose patterns that create TENSION and SPECIFICITY for this particular story. A bedtime story about a child afraid of thunder needs different patterns than a birthday adventure about a child who loves dinosaurs.

QUALITY RULES:
- Each pattern must have a specific, concrete "how_to_apply" that references the story's setting, characters, or emotional goal
- "how_to_apply" should be 1-2 sentences max
- The "strategy" field should explain how the patterns work TOGETHER as a system
- Do not repeat the pattern description — show how it applies to THIS story

Return JSON:
{
  "selected_patterns": [
    { "id": "pattern_id", "how_to_apply": "Specific application for this story" }
  ],
  "strategy": "How these patterns work together for this specific story"
}`;
}

// ─────────────────────────────────────────
// LLM callers (lightweight, dedicated)
// ─────────────────────────────────────────

async function callPatternSelectorOpenAI(systemPrompt, userPrompt, opts = {}) {
  const apiKey = opts.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API key not available');

  const controller = new AbortController();
  let didTimeout = false;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => { didTimeout = true; controller.abort(); }, timeoutMs);

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.4,
        max_completion_tokens: 600,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenAI API error ${resp.status}: ${err.slice(0, 200)}`);
    }

    const data = await resp.json();
    const choice = data.choices?.[0];
    return {
      text: choice?.message?.content || '',
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
      model: 'gpt-4.1-mini',
    };
  } catch (err) {
    clearTimeout(timer);
    if (didTimeout) throw new Error(`Pattern selector timed out after ${timeoutMs}ms`);
    throw err;
  }
}

async function callPatternSelectorGemini(systemPrompt, userPrompt, opts = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const model = 'gemini-3-flash-preview';
  const baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => { didTimeout = true; controller.abort(); }, timeoutMs);

  try {
    const resp = await fetch(`${baseUrl}/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          maxOutputTokens: 600,
          temperature: 0.4,
          responseMimeType: 'application/json',
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Gemini API error ${resp.status}: ${err.slice(0, 200)}`);
    }

    const data = await resp.json();
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text || '';
    const usage = data.usageMetadata || {};
    return {
      text,
      inputTokens: usage.promptTokenCount || 0,
      outputTokens: usage.candidatesTokenCount || 0,
      model,
    };
  } catch (err) {
    clearTimeout(timer);
    if (didTimeout) throw new Error(`Pattern selector Gemini fallback timed out after ${timeoutMs}ms`);
    throw err;
  }
}

// ─────────────────────────────────────────
// Main selector
// ─────────────────────────────────────────

/**
 * Select narrative patterns for a story.
 *
 * @param {{ story_type: string, age: number, goal: string, setting: string, tone: string }} inputs
 * @param {{ costTracker?: object, apiKeys?: object }} opts
 * @returns {Promise<{ selected_patterns: Array<{id: string, how_to_apply: string}>, strategy: string }>}
 */
async function selectNarrativePatterns(inputs, opts = {}) {
  const format = inputs.story_type || 'picture_book';
  const isGN = format === 'graphic_novel';
  const fallback = isGN ? GN_FALLBACK : PB_FALLBACK;

  try {
    const patternLibrary = getPatternLibrary(format);
    const systemPrompt = buildSelectorPrompt(inputs, patternLibrary);
    const userPrompt = 'Select the best narrative patterns for this story. Return JSON only.';

    let response;
    const openaiKey = opts.apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

    // Primary: GPT-4.1-Mini
    if (openaiKey) {
      try {
        console.log('[narrativePatterns] Calling GPT-4.1-Mini...');
        response = await callPatternSelectorOpenAI(systemPrompt, userPrompt, {
          openaiApiKey: openaiKey,
        });
      } catch (err) {
        console.warn(`[narrativePatterns] GPT-4.1-Mini failed, falling back to Gemini: ${err.message}`);
      }
    }

    // Fallback: Gemini 3-Flash
    if (!response) {
      console.log('[narrativePatterns] Calling Gemini 3-Flash...');
      response = await callPatternSelectorGemini(systemPrompt, userPrompt);
    }

    // Track cost
    if (opts.costTracker && response) {
      opts.costTracker.addTextUsage(response.model, response.inputTokens, response.outputTokens);
    }

    // Parse response
    let content = response.text;
    content = content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const result = JSON.parse(content);

    // Validate result structure
    if (!Array.isArray(result.selected_patterns) || result.selected_patterns.length === 0) {
      console.warn('[narrativePatterns] LLM returned empty or invalid patterns — using fallback');
      return fallback;
    }

    // Enforce max budget
    const maxPatterns = isGN ? 7 : 6;
    if (result.selected_patterns.length > maxPatterns) {
      result.selected_patterns = result.selected_patterns.slice(0, maxPatterns);
    }

    console.log(`[narrativePatterns] Selected ${result.selected_patterns.length} patterns: ${result.selected_patterns.map(p => p.id).join(', ')}`);
    return result;
  } catch (err) {
    console.warn(`[narrativePatterns] Pattern selection failed — using fallback: ${err.message}`);
    return fallback;
  }
}

// ─────────────────────────────────────────
// Formatters for prompt injection
// ─────────────────────────────────────────

/**
 * Format patterns for injection into the writer's system prompt.
 * @param {{ selected_patterns: Array, strategy: string }} patterns
 * @returns {string}
 */
function formatPatternsForWriter(patterns) {
  if (!patterns || !patterns.selected_patterns || patterns.selected_patterns.length === 0) {
    return '';
  }
  const lines = patterns.selected_patterns.map(p => `\u2022 ${p.id}: ${p.how_to_apply}`).join('\n');
  return `\nNARRATIVE PATTERNS (use these as structural guides \u2014 not checklists):\n${lines}\n\nStrategy: ${patterns.strategy || ''}\n\nThese patterns should feel invisible to the reader. Don\u2019t force them \u2014 let them shape the story\u2019s skeleton.`;
}

/**
 * Format patterns for injection into the critic's system prompt.
 * @param {{ selected_patterns: Array, strategy: string }} patterns
 * @returns {string}
 */
function formatPatternsForCritic(patterns) {
  if (!patterns || !patterns.selected_patterns || patterns.selected_patterns.length === 0) {
    return '';
  }
  const lines = patterns.selected_patterns.map(p => `\u2022 ${p.id}: ${p.how_to_apply}`).join('\n');
  return `\nNARRATIVE PATTERNS SELECTED FOR THIS STORY:\n${lines}\n\nWhen evaluating, check that selected patterns are present and working.\nDo NOT add patterns that weren\u2019t selected \u2014 the budget is intentional.`;
}

/**
 * Format patterns for injection into GN chunk prompts.
 * @param {{ selected_patterns: Array }} patterns
 * @returns {string}
 */
function formatPatternsForChunks(patterns) {
  if (!patterns || !patterns.selected_patterns || patterns.selected_patterns.length === 0) {
    return '';
  }
  const lines = patterns.selected_patterns.map(p => `\u2022 ${p.id}: ${p.how_to_apply}`).join('\n');
  return `\nNARRATIVE PATTERNS FOR THIS STORY:\n${lines}\n\nApply these patterns across scenes \u2014 not every scene needs every pattern.`;
}

/**
 * Format patterns for injection into GN story bible prompt.
 * @param {{ selected_patterns: Array }} patterns
 * @returns {string}
 */
function formatPatternsForStoryBible(patterns) {
  if (!patterns || !patterns.selected_patterns || patterns.selected_patterns.length === 0) {
    return '';
  }
  const lines = patterns.selected_patterns.map(p => `\u2022 ${p.id}`).join('\n');
  return `\nSTRUCTURAL PATTERNS TO WEAVE IN:\n${lines}\n\nWhen planning the 7 scenes, note which scene each pattern fits most naturally.`;
}

module.exports = {
  SHARED_PATTERNS,
  GN_PATTERNS,
  getPatternLibrary,
  buildSelectorPrompt,
  selectNarrativePatterns,
  formatPatternsForWriter,
  formatPatternsForCritic,
  formatPatternsForChunks,
  formatPatternsForStoryBible,
};
