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
const { STORY_PLANNER_SYSTEM: ER_SYSTEM, STORY_PLANNER_USER: erUserPrompt, EARLY_READER_CRITIC_SYSTEM } = require('../prompts/earlyReader');
const { getAgeTier, getEmotionalAgeTier } = require('../prompts/writerBrief');
const { enrichCustomDetails } = require('./customDetailsEnricher');
const { checkPronounConsistency, simpleReplace } = require('./pronouns');
const { selectNarrativePatterns, formatPatternsForWriter, formatPatternsForCritic, formatPatternsForChunks, formatPatternsForStoryBible } = require('./narrativePatterns');

const EMOTIONAL_THEMES = new Set(['anxiety', 'anger', 'fear', 'grief', 'loneliness', 'new_beginnings', 'self_worth', 'family_change']);
const DEFAULT_LLM_TIMEOUT_MS = 120000;
const GRAPHIC_NOVEL_FULL_PLAN_TIMEOUT_MS = 480000;
const GRAPHIC_NOVEL_CHUNK_TIMEOUT_MS = 240000;
const THEME_SUBTITLES = {
  adventure: 'An adventure story',
  anxiety: 'A story about being brave',
  anger: 'A story about big feelings',
  bedtime: 'A bedtime story',
  birthday: 'A birthday story',
  birthday_magic: 'A birthday story',
  family_change: 'A story about family',
  fantasy: 'A fantasy quest',
  fathers_day: 'A story about love',
  fear: 'A story about courage',
  friendship: 'A friendship story',
  grief: 'A story about remembering',
  holiday: 'A holiday story',
  loneliness: 'A story about connection',
  mothers_day: 'A story about love',
  nature: 'A nature story',
  new_beginnings: 'A story about new beginnings',
  school: 'A school story',
  self_worth: 'A story about being you',
  space: 'A space adventure',
  underwater: 'An underwater adventure',
};

// ── W1: Beat structure per spread ──
const BEAT_STRUCTURE = `BEAT STRUCTURE — each spread has a PURPOSE:
Spread 1 (THE HOOK): [child] in their world. Something catches their attention. End with curiosity or excitement.
Spread 2 (THE DISCOVERY): The adventure begins. Show wonder and excitement. Introduce the setting.
Spread 3 (RISING FUN): First challenge or new discovery. Use a specific detail from customDetails here.
Spread 4 (DEEPER IN): The world expands. More characters, places, or surprises.
Spread 5 (THE HEART): The emotional core of the story. For birthday: the celebration moment. For mothers_day: the deepest bond. For adventure: the biggest obstacle.
Spread 6 (TURNING POINT): Something changes. A challenge, a surprise, or an emotional shift.
Spread 7 (PEAK MOMENT): The climax. Maximum joy, tension, or wonder. The most dramatic illustration.
Spread 8 (AFTERMATH): The immediate result of the peak. Emotion settling. Characters react.
Spread 9 (RESOLUTION): The challenge is overcome. The celebration is complete. Things come together.
Spread 10 (NEW WORLD): The world feels different now. Show what changed.
Spread 11 (WARM GLOW): Quiet warmth. Characters together. Gratitude, love, connection.
Spread 12 (REFLECTION): Looking back on the adventure. A moment of peace.
Spread 13 (THE LAST LINE): One perfect closing image. THE most beautiful, memorable sentence in the entire book. This is what parents will quote.`;

// ── W2: Theme-specific story rules ──
const THEME_RULES = {
  birthday: `BIRTHDAY THEME — EVERY spread must feel like a celebration:
- The child's birthday is the CENTRAL EVENT of the entire story
- Favorite cake/food from customDetails MUST appear in at least one spread
- Favorite toys/activities MUST appear as birthday elements (gifts, decorations, games)
- Energy: joyful, excited, celebrated — this child is the STAR today
- Ending: triumphant, celebratory — NEVER sleepy or quiet
- The whole world celebrates THIS specific child`,

  birthday_magic: `BIRTHDAY THEME — EVERY spread must feel like a celebration:
- The child's birthday is the CENTRAL EVENT of the entire story
- Favorite cake/food from customDetails MUST appear in at least one spread
- Favorite toys/activities MUST appear as birthday elements
- Energy: joyful, excited, celebrated — this child is the STAR today
- Ending: triumphant, celebratory — NEVER sleepy or quiet`,

  bedtime: `BEDTIME THEME — calm, cozy, magical:
- Every spread has a gentle, warm, dreamy tone — the world softens as night comes
- Include the sweet bedtime moment from customDetails as a specific scene
- Story arc: active play → winding down → magical quiet → peaceful sleep
- Ending: the child drifts peacefully to sleep — this IS a bedtime story
- Use dreamy imagery: stars, glowing night lights, soft moonlight, warm blankets`,

  bedtime_wonder: `BEDTIME THEME — calm, cozy, magical:
- Every spread has a gentle, warm, dreamy tone — the world softens as night comes
- Include the sweet bedtime moment from customDetails as a specific scene
- Ending: the child drifts peacefully to sleep — dreamy, warm, safe
- Use dreamy imagery: stars, moonlight, soft glow, warm blankets`,

  mothers_day: `MOTHER'S DAY THEME — a love letter from child to mom:
- Mom is a NAMED CHARACTER — use the name from customDetails (calls_mom / mom_name). If not provided, use "Mommy"
- Mom MUST appear in at least 6 of 13 spreads — she is co-protagonist
- Story is told from the child's perspective of love and gratitude for mom
- Include the meaningful_moment from customDetails as a specific scene
- Include moms_favorite_moment if provided
- NARRATIVE SPINE: The story MUST follow one simple through-line (a journey together, a shared project, or a gift the child prepares). Every spread connects to this spine. Do NOT write a slideshow of unrelated activities.
- CELEBRATION WITH MOMENTUM: NO tantrums, NO crying, NO anger, NO conflict. But the story MUST have forward momentum — anticipation, a small goal, curiosity, or a surprise that pulls the reader through. Every spread should make the reader want to turn the page. A flat sequence of "nice moments" is not a story.
- SCENE PACING: Use no more than 3-4 distinct locations or activities across 13 spreads. Each scene gets 2-4 spreads to develop. Single-spread activities create a disjointed slideshow.
- TRANSITIONS: Every scene change must be clear to a 3-year-old listener. Show HOW they got from one place to the next.
- NO BEDTIME ENDING: The story must NOT end with sleeping, goodnight, tucking in, dreams, nightlights, or the house going quiet. End in DAYLIGHT with warmth, togetherness, and joy.
- CREATIVITY: At least 2 spreads must use the child's imagination — transforming something ordinary into something magical WITHIN the story's spine. Include one reversal where the child tries to take care of Mom. Avoid flat documentary narration.
- Ending: warm, bright, celebratory — a joyful image of mother and child together. NOT quiet, NOT sleepy.
- This book should make a mother cry happy tears`,

  fathers_day: `FATHER'S DAY THEME — a bonding adventure:
- Dad is a NAMED CHARACTER — use the name from customDetails (calls_dad / dad_name). If not provided, use "Daddy"
- Dad MUST appear in at least 6 of 13 spreads — he is co-protagonist
- Include shared activities from customDetails as story scenes
- Include meaningful_moment as a specific spread
- NARRATIVE SPINE: The story MUST follow one simple through-line (an adventure together, a shared project, or a challenge they tackle). Every spread connects to this spine. Do NOT write a slideshow of unrelated activities.
- CELEBRATION WITH MOMENTUM: NO tantrums, NO crying, NO anger, NO conflict. But the story MUST have forward momentum — anticipation, excitement, a goal. Every spread should make the reader want to turn the page.
- SCENE PACING: Use no more than 3-4 distinct locations or activities across 13 spreads. Each scene gets 2-4 spreads to develop.
- TRANSITIONS: Every scene change must be clear to a 3-year-old listener.
- Tone: adventurous, proud, bonding, playful
- Ending: heartfelt — child expressing love and admiration for dad. Concrete and specific, not abstract.`,

  adventure: `ADVENTURE THEME — a quest with a goal:
- State the quest/mission clearly in spread 1 or 2
- The meaningful_moment from customDetails inspires the quest destination or reward
- The child's activities from customDetails become skills used during the adventure
- Pacing: builds urgency through middle spreads, peaks at spread 7
- Ending: triumphant — child returns changed/grown, mission accomplished`,

  adventure_play: `ADVENTURE THEME — a quest with a goal:
- State the quest/mission clearly in spread 1 or 2
- The child's favorite activities become skills used during the adventure
- Pacing: builds urgency, peaks at spread 7
- Ending: triumphant — child returns changed/grown`,

  learning_discovery: `LEARNING THEME — curiosity-driven story:
- Story built around something the child is curious about
- Arc: wonder → question → exploration → discovery → understanding
- The child asks questions and discovers answers through adventure
- Ending: child shares their new knowledge with someone they love`,

  creative_arts: `CREATIVE ARTS THEME — imagination is the hero:
- The child's creative activity (drawing/singing/dancing/building) DRIVES the plot
- The child's imagination creates or transforms the world
- Tone: joyful, expressive, colorful
- Ending: the child's creation is celebrated by everyone`,

  friendship: `FRIENDSHIP THEME — kindness and togetherness:
- If a friend name is in customDetails, use it as a named character
- Story centers on friendship, sharing, and being there for each other
- Include the friendship moment from customDetails
- Ending: friendship is celebrated and strengthened`,

  friendship_fun: `FRIENDSHIP THEME — kindness and togetherness:
- If a friend name is in customDetails, use it as a named character
- Story centers on friendship, sharing, kindness
- Ending: friendship celebrated`,
};

// ── W4: Dialogue minimum rule ──
const DIALOGUE_RULE = `DIALOGUE RULE: At least 4 of the 13 spreads MUST contain character dialogue in quotation marks.
Children love reading dialogue aloud. Mix narration and dialogue naturally — never have more than 3 consecutive spreads without dialogue.

DIALOGUE QUALITY (CRITICAL — bad dialogue kills a book):
- The child's voice must sound REAL: short sentences, concrete words, unexpected observations. Children don't say "What a beautiful day!" — they say "That cloud looks like a shoe."
- Let the child be FUNNY in dialogue. Kids say surprising things: "I think the moon follows me." / "Do worms have dreams?" / "That's not how birds work." These moments make a book feel alive.
- Dialogue must DO something: reveal character, create humor, advance the plot, or surprise the reader. If dialogue just states what the reader already knows ("Look, a castle!"), cut it.
- The child's voice must be DISTINCT from the narrator's voice. If you can't tell who's speaking without quotation marks, the dialogue is too flat.
- Fictional characters (animals, creatures, objects) can have personality in dialogue too: a grumpy map, a nervous star, a door that asks riddles. Give non-child characters a distinct voice — formal, overly polite, hilariously literal.
- ONE great line of dialogue is worth more than four dutiful ones. Aim for at least one line the parent will remember.

DIALOGUE GRAMMAR (CRITICAL):
All dialogue MUST be grammatically correct, regardless of the character's age.
- For toddlers/young children: use SIMPLE grammar, SHORT sentences, EASY words — but never broken grammar.
- Write "Can I help?" not "me help?"
- Write "I want to come too!" not "come too?"
- Write "Look at that!" not "me see!"
- The adult reading this aloud should never stumble over incorrect grammar.
- Simple ≠ broken. A 2-year-old in a book says "I love you, Mama" not "me love Mama".`;

// ── W5: Age-aware vocabulary ──
function ageVocabularyRules(age) {
  const n = parseInt(age) || 5;
  if (n <= 3) return `VOCABULARY (age ${n}): SIMPLICITY is king. Use only common toddler words a ${n}-year-old hears daily. Simple, repetitive, rhythmic patterns. No metaphors, no words above 2 syllables. Grammar must always be correct — no baby talk. But simple does NOT mean broken. Complete, musical sentences: "The stars came out one by one. Goodnight moon, goodnight sun." NOT "Stars. Out. One."`;
  if (n <= 5) return `VOCABULARY (age ${n}): Simple, familiar words a ${n}-year-old already knows. Two-syllable words are fine; occasional three-syllable words are fine if they sound natural when read aloud ("adventure", "tomorrow", "beautiful"). The writing should be SIMPLE but BEAUTIFUL — think Julia Donaldson, Margaret Wise Brown, Sandra Boynton. Complete, flowing sentences. Rhyming couplets that sing. Grammar must always be correct. Example: "She followed the path where the wild roses grow, past the tree with the swing and the creek running slow."`;
  if (n <= 8) return `VOCABULARY (age ${n}): Full children's vocabulary. Metaphors and similes welcome. Varied sentence rhythm. Example: "She felt like a brave explorer discovering a hidden world that no one had ever seen before."`;
  return `VOCABULARY (age ${n}): Young adult vocabulary. Longer sentences fine. Nuanced emotion. Subtext and irony allowed.`;
}

// ── W6: Rhythmic prose rule ──
const RHYTHM_RULE = `RHYTHM — these books are READ ALOUD by parents. Every line must sound good in someone's mouth:
- Vary sentence length: short punchy sentences followed by flowing ones. A three-word sentence after a long one hits like a drum. "The forest opened up before her, canopy dripping with gold and shadow and the last light of afternoon. She stepped through."
- Write for the EAR: "She stepped inside" has energy (short vowel, hard consonant). "She walked into the room" is flat (soft consonants, no surprise). Choose words that feel good to say. Prefer verbs with texture: crept, tumbled, slid, pressed, clung, drifted.
- RHYME FOR MUSICALITY: Use rhyming couplets and AABB rhyme schemes throughout — every spread should aim for at least one rhyming pair. Think Dr. Seuss or Julia Donaldson. When exact rhymes would feel forced, use near-rhymes: "The wind was gone. The leaves held still." Internal echoes (gone/long, still/hill) create a feeling of pattern. Prioritize natural-sounding rhymes over forced ones. Use alliteration where natural — never stack it.
- End each spread with a sentence that feels COMPLETE and SATISFYING to say out loud — a sentence you'd want to repeat. Not a summary. An image.
- ONE-WORD or TWO-WORD sentences are powerful when earned: "Silence." / "Not yet." / "Almost." Use sparingly — max 2 per story.
- The LAST LINE of spread 13 must be the most beautiful sentence in the entire book. It should feel inevitable — like the only possible ending. A parent should want to read it twice.
- At least ONE line in the story must be memorable enough that a parent would quote it at dinner — not because it's wise, but because it's perfectly said.
- PACING WITHIN SPREADS: The left page sets up. The right page lands. Don't put all the energy on one side. The page turn between left and right is a breath; the page turn between spreads is a heartbeat.`;

function getAgeAppropriateFallbackObject(age) {
  const a = Number(age) || 5;
  if (a <= 3)  return 'a small stuffed animal'; // ok for toddlers
  if (a <= 6)  return 'a favorite toy';          // generic but not infantilizing
  if (a <= 9)  return 'a small backpack or special item'; // school-age appropriate
  return 'something they always carry';           // vague but not babyish for 10+
}

function getEmotionalTier(age) {
  const a = Number(age) || 5;
  if (a <= 3)  return { tier: 'E1', bookFormat: 'PICTURE_BOOK', spreads: 8,  minPages: 32 };
  if (a <= 6)  return { tier: 'E2', bookFormat: 'PICTURE_BOOK', spreads: 13, minPages: 32 };
  if (a <= 9)  return { tier: 'E3', bookFormat: 'EARLY_READER', spreads: 18, minPages: 48 };
  return       { tier: 'E4', bookFormat: 'EARLY_READER', spreads: 20, minPages: 56 };
}

const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Call OpenAI GPT 5.4 chat completions API.
 */
async function fetchWithTimeout(url, init, timeoutMs, requestLabel) {
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (didTimeout) {
      throw new Error(`${requestLabel || 'LLM request'} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAI(systemPrompt, userPrompt, opts = {}) {
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error('OpenAI API key not available');

  // Use streaming for large token budgets to avoid connection timeout on long generations
  const useStream = (opts.maxTokens || 4000) > 8000;

  const resp = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
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
      stream: useStream || undefined,
      ...(useStream ? { stream_options: { include_usage: true } } : {}),
    }),
  }, opts.timeoutMs || DEFAULT_LLM_TIMEOUT_MS, opts.requestLabel || 'OpenAI request');

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${err.slice(0, 200)}`);
  }

  if (useStream && typeof resp.text === 'function') {
    // Read SSE stream and collect content + usage
    const rawText = await resp.text();
    if (rawText.trimStart().startsWith('data:')) {
      const lines = rawText.split('\n');
      let content = '';
      let finishReason = 'stop';
      let inputTokens = 0;
      let outputTokens = 0;

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') break;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) content += delta.content;
          const reason = chunk.choices?.[0]?.finish_reason;
          if (reason) finishReason = reason;
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens || inputTokens;
            outputTokens = chunk.usage.completion_tokens || outputTokens;
          }
        } catch (_) { /* skip malformed SSE lines */ }
      }

      finishReason = finishReason === 'length' ? 'MAX_TOKENS' : (finishReason || 'stop');
      return { text: content, inputTokens, outputTokens, finishReason };
    }
    // Response is plain JSON despite stream request — parse normally
    const data = JSON.parse(rawText);
    const choice = data.choices?.[0];
    const fr = choice?.finish_reason === 'length' ? 'MAX_TOKENS' : (choice?.finish_reason || 'stop');
    let ct = choice?.message?.content || '';
    return { text: typeof ct === 'string' ? ct : '', inputTokens: data.usage?.prompt_tokens || 0, outputTokens: data.usage?.completion_tokens || 0, finishReason: fr };
  }

  const data = await resp.json();
  const choice = data.choices?.[0];
  const finishReason = choice?.finish_reason === 'length' ? 'MAX_TOKENS' : (choice?.finish_reason || 'stop');
  let content = choice?.message?.content || '';
  if (Array.isArray(content)) {
    content = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        return '';
      })
      .join('');
  }
  return {
    text: typeof content === 'string' ? content : '',
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
    finishReason,
  };
}

/**
 * Call Gemini text generation API (fallback).
 */
async function callGeminiText(systemPrompt, userPrompt, genConfig) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const { timeoutMs, requestLabel, ...geminiGenConfig } = genConfig || {};

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: geminiGenConfig,
  };

  let resp;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      resp = await fetchWithTimeout(
        `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        timeoutMs || DEFAULT_LLM_TIMEOUT_MS,
        requestLabel || `Gemini request attempt ${attempt}`
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
        timeoutMs: opts.timeoutMs,
        requestLabel: opts.requestLabel,
      });
      if (opts.jsonMode && !String(result.text || '').trim()) {
        throw new Error('GPT 5.4 returned empty JSON-mode content');
      }
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
    timeoutMs: opts.timeoutMs,
    requestLabel: opts.requestLabel,
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
 * @param {object} [opts] - { apiKeys, costTracker, theme }
 * @returns {Promise<object>} { favorite_object, fear, setting, storySeed }
 */
// ── E2 13-spread emotional arc (extracted helper) ──
function getEmotionalBeatStructure_E2(emotion, situation) {
  const situationHint = situation ? `\nThe specific situation: "${situation}"` : '';

  const baseArc = `8. beats: An array of exactly 13 one-line descriptions — one per spread. Follow this EMOTIONAL ARC:
   - Spread 1: RECOGNITION — The child is seen exactly as they are. Their world, their feeling, named without judgment.${situationHint}
   - Spread 2: THE WORLD — A glimpse of the child's daily life. Something ordinary that the emotion has changed or colored.
   - Spread 3: THE STORM — The emotion arrives fully. It feels big, real, overwhelming. The child is inside it.
   - Spread 4: THE STUCK — The child tries to manage alone. It doesn't work. They feel more alone with it.
   - Spread 5: THE BRIDGE — Something or someone creates a small opening. Not a solution — a presence, a moment, a question.
   - Spread 6: THE COMPANION — The coping resource enters. A person, object, or action that holds space for the feeling.
   - Spread 7: THE NAMING — The child finds a word, an image, or a gesture for what they feel. The emotion becomes smaller when named.
   - Spread 8: THE TOOL — The child uses the coping strategy. Not perfectly — but genuinely.
   - Spread 9: THE TURN — One small brave step. Not a cure — one manageable action despite the feeling.
   - Spread 10: THE BREATH — A moment of rest. The emotion has not disappeared, but the child has room again.
   - Spread 11: LOOKING BACK — The child remembers what they felt at Spread 3. They are still that child — and also more.
   - Spread 12: VISUALLY SILENT — No text. A warm, open image. The child in their world, slightly bigger now.
   - Spread 13: THE LANDING — The emotion is still present but the child is its companion, not its prisoner. The last line must give the parent a phrase they can repeat outside this book.`;

  const emotionSpecific = {
    anxiety: `\n\nANXIETY-SPECIFIC RULES:\n- The worry is NEVER dismissed or minimized ("there's nothing to be scared of" is forbidden)\n- Spread 3: The worry grows visibly — it has weight and presence\n- Spread 6: The companion externalizes the worry — makes it visible and nameable\n- Spread 7: The child names their specific worry out loud — this is the turning point\n- Spread 13 usable phrase: something the child can say when anxious (e.g. "I feel worried. And I am brave anyway.")`,
    anger: `\n\nANGER-SPECIFIC RULES:\n- The anger is NEVER punished or shamed in the narrative\n- Spread 3: Describe the PHYSICAL experience of anger — heat, tight chest, shaky hands\n- Spread 5: The companion does NOT tell the child to calm down — they witness the anger first\n- Spread 8: The coping tool is a sequence: notice the body → breathe → name it\n- Spread 13 usable phrase: something that helps name big feelings (e.g. "My feelings are big. I know what to do.")`,
    fear: `\n\nFEAR-SPECIFIC RULES:\n- Fear and desire COEXIST — the child wants to do the thing AND is scared simultaneously\n- Spread 3: Show the child at the edge — frozen, wanting to move forward but unable\n- Spread 9: The brave step is MICRO — the smallest possible action counts\n- At spread 13 the child may STILL be scared — and that is explicitly okay. Bravery ≠ absence of fear\n- Spread 13 usable phrase: something about courage as action-despite-fear`,
    grief: `\n\nGRIEF-SPECIFIC RULES:\n- The loss is NEVER minimized, explained away, or rushed past\n- Spread 3: The absence is felt — an empty space, a missing sound, a changed routine\n- Spread 5: Connection is maintained across the loss — love does not disappear\n- Spread 8: A memory ritual — something the child can DO to stay connected\n- The story does NOT promise the pain ends — it promises the child is not alone in it\n- Spread 13 usable phrase: a phrase about love persisting (e.g. "I carry you with me everywhere I go.")`,
    loneliness: `\n\nLONELINESS-SPECIFIC RULES:\n- The child's feeling of invisibility is validated fully before any resolution begins\n- Spread 4: The child watches others connect — and feels outside it\n- Spread 6: One small act of noticing from another — not a full friendship, just a moment of being seen\n- Spread 9: The child initiates one micro-connection — a word, a wave, a shared thing\n- Spread 13 usable phrase: something about being seen (e.g. "I am here. I am worth knowing.")`,
    new_beginnings: `\n\nNEW BEGINNINGS-SPECIFIC RULES:\n- Validate both the excitement AND the fear of change — they coexist\n- Spread 3: The old familiar world is held — the child misses what was\n- Spread 7: Something familiar is found inside the new — one anchor\n- Spread 9: The child chooses to take one step toward the new\n- Spread 13 usable phrase: something about carrying the old into the new`,
    self_worth: `\n\nSELF-WORTH-SPECIFIC RULES:\n- The feeling of not-enough is validated — never dismissed as wrong to feel\n- Spread 3: A specific moment of shame, comparison, or failure — concrete, not abstract\n- Spread 5: Someone sees the child exactly as they are — not their achievement\n- Spread 8: A reframe: the "flaw" is looked at differently, not erased\n- Spread 13 usable phrase: something about inherent worth (e.g. "I am enough, exactly as I am.")`,
    family_change: `\n\nFAMILY CHANGE-SPECIFIC RULES:\n- The confusion and insecurity are validated without taking sides or explaining adult situations\n- Spread 3: The change is felt — something that was solid now feels uncertain\n- Spread 5: Love is confirmed — from the person who gave this book, explicitly present\n- Spread 8: Something stable is named — what has NOT changed\n- Spread 13 usable phrase: something about love being constant (e.g. "Some things change. My love for you never will.")`,
  };

  return baseArc + (emotionSpecific[emotion] || '');
}

// ── Tier-aware emotional beat structure ──
function getEmotionalBeatStructure(emotion, age, situation) {
  const emotionalTier = getEmotionalTier(age);
  const situationHint = situation ? `\nThe specific situation: "${situation}"` : '';

  // E1: 8 spreads, simple comfort arc (no 6-act)
  if (emotionalTier.tier === 'E1') {
    return `8. beats: An array of exactly 8 one-line descriptions — one per spread. Follow this TODDLER COMFORT arc:
   - Spread 1: The child is doing something ordinary. Something shifts — a feeling arrives.
   - Spread 2: The feeling is described in the BODY only (tight tummy, hot face, shaky hands).
   - Spread 3: The feeling gets bigger.
   - Spread 4: The child tries to ignore it. It doesn't work.
   - Spread 5: Something comforting arrives (a person, an object, a familiar thing).
   - Spread 6: The child and the comfort are together. The feeling is still there but less alone.
   - Spread 7: The feeling begins to soften — not disappear, just ease.
   - Spread 8: The child is held, safe, known. The last line is a phrase a parent can say out loud.${situationHint}`;
  }

  // E2: 13 spreads, full 6-act arc
  if (emotionalTier.tier === 'E2') {
    return getEmotionalBeatStructure_E2(emotion, situation);
  }

  // E3: 18 spreads, expanded 6-act arc
  if (emotionalTier.tier === 'E3') {
    return `8. beats: An array of exactly 18 one-line descriptions — one per spread. Follow this ILLUSTRATED STORY EMOTIONAL arc:
   - Spread 1: RECOGNITION — The child is seen exactly as they are. Their world, their feeling, named.${situationHint}
   - Spread 2: ORDINARY WORLD — A day in the child's life, now colored by the emotion.
   - Spread 3: THE TRIGGER — The specific moment or situation where the emotion intensifies.
   - Spread 4: THE STORM BEGINS — The emotion takes hold. Physical and behavioral signs.
   - Spread 5: THE STORM PEAKS — The child is fully inside the feeling. Interior monologue visible.
   - Spread 6: THE STUCK — The child tries to manage alone. Strategy 1 fails.
   - Spread 7: MORE STUCK — The child tries again. Strategy 2 fails. They feel worse.
   - Spread 8: ISOLATION — The emotion separates the child from connection.
   - Spread 9: THE BRIDGE — A secondary character or moment creates an opening.
   - Spread 10: THE COMPANION — The coping resource enters. A presence, not a fix.
   - Spread 11: THE NAMING — The child finds language for what they feel.
   - Spread 12: THE TOOL — The coping strategy is used for the first time. Imperfect but real.
   - Spread 13: THE PRACTICE — The child uses the strategy again. It works a little better.
   - Spread 14: THE TURN — One brave step. Small. Concrete. Earned.
   - Spread 15: THE RIPPLE — Something small changes as a result of the step.
   - Spread 16: THE BREATH — Rest. The emotion has not gone — but the child has space.
   - Spread 17: LOOKING BACK — The child remembers Spread 5. They see how far they've come.
   - Spread 18: THE LANDING + REFLECTION — The child is bigger than the feeling now. Ends with 3 reflection questions the reader can sit with.`;
  }

  // E4: 20 spreads, full literary arc
  return `8. beats: An array of exactly 20 one-line descriptions — one per spread. Follow this STORY + REFLECTION arc:
   - Spread 1: RECOGNITION — The child's world. The emotion present but not yet named.${situationHint}
   - Spread 2: ORDINARY — Daily life carrying the weight of the emotion.
   - Spread 3: THE TRIGGER — A specific moment. Interior monologue begins.
   - Spread 4: THE STORM — Emotion takes hold fully. Physical, behavioral, and internal.
   - Spread 5: ISOLATION — The emotion separates the child from those around them.
   - Spread 6: FIRST ATTEMPT — The child tries to manage. It fails. Self-criticism follows.
   - Spread 7: DEEPER STUCK — The child questions whether the feeling will ever change.
   - Spread 8: THE WITNESS — Someone sees the child without trying to fix them.
   - Spread 9: THE QUESTION — An honest exchange. The secondary character asks the right question.
   - Spread 10: THE NAMING — The child finds language — not perfect language, but theirs.
   - Spread 11: THE COMPANION — The coping resource emerges from the child's own resources.
   - Spread 12: THE TOOL TRIED — First use of the strategy. Awkward, imperfect, but real.
   - Spread 13: THE RESISTANCE — The old pattern pulls back. A moment of relapse.
   - Spread 14: THE CHOICE — The child chooses the tool again, knowing the cost.
   - Spread 15: THE TURN — Small, earned, concrete. The brave step.
   - Spread 16: CHANGE VISIBLE — Something in the child's world responds.
   - Spread 17: THE BREATH — Spaciousness. Not resolution — capacity.
   - Spread 18: LOOKING BACK — The child holds both: who they were at Spread 4 and who they are now.
   - Spread 19: FOR YOU (Reflection page) — Structured reflection with 3 prompts + space to respond.
   - Spread 20: FOR THE ADULT READING THIS — A note about the emotional approach used in this book and how to continue the conversation.`;
}

function getThemeBeatStructure(theme, age) {
  const candleText = age ? `exactly ${age} candles` : 'the correct number of candles matching the child\'s age';
  switch (theme) {
    case 'birthday':
      return `8. beats: An array of exactly 13 one-line descriptions — one per spread. Follow this BIRTHDAY arc:
   AGE-WEAVING RULE: The child is turning ${age}. This specific age must feel meaningful throughout — not just mentioned in spread 1. In at least 3 spreads, the story should reflect what it MEANS to be ${age}: something they can now do that they couldn't before, something they understand now, a milestone only a ${age}-year-old would have. The number ${age} should feel earned by spread 13.
   BIRTHDAY ENERGY RULE: This story should feel like the BEST DAY OF THE CHILD'S LIFE from the very first spread. Joy, warmth, and excitement are the emotional BASELINE — not something to be earned. The obstacle at spread 6 is light, quickly overcome, and never threatening. EVERY spread must feel drenched in birthday — decorations, friends, the smell of something baking, the specific golden light of a birthday afternoon, the feeling of being the most special person in the world today. The tension rule is SUSPENDED — joy fills every spread.
   BIRTHDAY SATURATION RULE: The birthday must be FELT in every single spread — not just spread 1 and 13. Balloons, streamers, friends gathering, wrapped gifts in the corner, candles being carried, a banner going up, the sound of singing practicing in another room — choose different birthday details for each spread so the celebration builds and accumulates. By spread 12 the reader should feel surrounded by birthday.
   - Spread 1: The child wakes up and the birthday hits them — something is immediately, unmistakably different. Balloons on the door, a banner, the smell of their favorite breakfast, a parent's voice singing. They are ${age} today and the whole world knows it.
   - Spread 2: The birthday morning unfolds — getting ready, something special about being ${age}. A birthday outfit, a birthday crown, a first look in the mirror at this new version of themselves.
   - Spread 3: First guests or celebrations arrive — friends, family, decorations going up. The house or location transforms into a birthday world.
   - Spread 4: A birthday activity or adventure — a game, an outing, a treasure hunt, something only the birthday child gets to lead.
   - Spread 5: A peak moment of joy — a gift, a surprise, a best friend arriving, something that makes the child's heart feel huge.
   - Spread 6: THE HINGE — one small thing goes slightly wrong (nothing scary, nothing sad — a lost ribbon, a wobbly tower of gifts, a game that needs fixing). The child handles it themselves with confidence, because they are ${age} now.
   - Spreads 7-8: The celebration continues and grows — more friends, more laughter, a shared moment of birthday magic. The child is surrounded by love.
   - Spreads 9-10: The celebration reaches its peak — the room is full, the energy is electric, everyone is together. The child realizes: this is the best day.
   - Spread 11: The birthday meal or party — everyone together, the noise and warmth of being celebrated. The favorite object is part of this moment.
   - Spread 12: The lights dim. Someone is carrying something. The room falls quiet and still. One line — the reader's heart lifts.
   - Spread 13: [ILLUSTRATION LOCKED] The birthday cake arrives, glowing. The child leans in, cheeks puffed, about to blow out ${candleText}. This is the moment the whole day was building toward. The world holds its breath.`;

    case 'holiday':
      return `8. beats: An array of exactly 13 one-line descriptions — one per spread. Follow this HOLIDAY arc:
   - Spread 1: Holiday preparations begin — the child sees or senses the magic coming.
   - Spread 2: A holiday mystery or mission starts (something to find, deliver, or discover).
   - Spreads 3-4: Journey through festive locations — each with wonder and a small obstacle.
   - Spread 5: A magical holiday encounter (a creature, a gift, a secret).
   - Spread 6: THE HINGE — the mission is at risk. Something unexpected blocks the path.
   - Spreads 7-8: The child finds a way through — holiday spirit and their favorite object help.
   - Spreads 9-10: The holiday magic is fulfilled — lights, warmth, belonging.
   - Spread 11: Heading home through the festive night.
   - Spread 12: Homecoming — one quiet settling line.
   - Spread 13: Cozy, warm, the holiday feeling settled in.`;

    case 'school':
      return `8. beats: An array of exactly 13 one-line descriptions — one per spread. Follow this SCHOOL arc:
   - Spread 1: The child arrives at school (first day, or a special day) — nervous but curious.
   - Spread 2: Something unexpected happens — a mystery, a challenge, or a new face.
   - Spreads 3-4: Exploring the school world — classroom, playground, hallway — each with its own moment.
   - Spread 5: A friendship or connection begins.
   - Spread 6: THE HINGE — something goes wrong (lost, excluded, a mistake in front of everyone).
   - Spreads 7-8: The child finds courage — their favorite object or the new friend helps.
   - Spreads 9-10: A triumph — a presentation, a game, a moment of belonging.
   - Spread 11: End of day, walking out — taller, more confident.
   - Spread 12: Homecoming — one quiet settling line.
   - Spread 13: Home. Settled. Tomorrow feels possible.`;

    case 'space':
      return `8. beats: An array of exactly 13 one-line descriptions — one per spread. Follow this SPACE arc:
   - Spread 1: The child discovers something (a signal, a telescope, a rocket) — the cosmos calls.
   - Spread 2: Launch — leaving Earth, the world shrinks below.
   - Spreads 3-4: First planets or star-fields — each visually distinct, each with a wonder and a challenge.
   - Spread 5: A cosmic encounter — a planet with personality, a star that speaks, a lost astronaut.
   - Spread 6: THE HINGE — the child is lost, the rocket stalls, or something vital is missing.
   - Spreads 7-8: Breakthrough — the favorite object holds a clue, or a new sky-friend helps navigate.
   - Spreads 9-10: The destination reached — a moon, a nebula, a discovery no one has seen before.
   - Spread 11: The journey home — Earth grows larger below.
   - Spread 12: Landing — one quiet line.
   - Spread 13: Standing at the window, face pressed against the glass, the universe still humming inside.`;

    case 'underwater':
      return `8. beats: An array of exactly 13 one-line descriptions — one per spread. Follow this UNDERWATER arc:
   - Spread 1: The child is near water — something shimmers, calls, or falls in.
   - Spread 2: The dive — the world transforms, colors shift, bubbles rise.
   - Spreads 3-4: Exploring the ocean — coral reef, deeper blue, dark deep. Each zone different and vivid.
   - Spread 5: A sea creature befriends them or leads them somewhere.
   - Spread 6: THE HINGE — the child is caught, tangled, or lost in the deep dark.
   - Spreads 7-8: Finding a way — the favorite object glows, floats, or guides.
   - Spreads 9-10: The discovery — a hidden treasure, a whale song, a light in the deep.
   - Spread 11: Rising back toward the surface — light growing above.
   - Spread 12: Breaking the surface — one quiet line.
   - Spread 13: On the shore, feet still damp, something from the deep glowing in their hand.`;

    case 'fantasy':
      return `8. beats: An array of exactly 13 one-line descriptions — one per spread. Follow this FANTASY QUEST arc:
   - Spread 1: The ordinary world — then a door, a map, or a creature appears.
   - Spread 2: Crossing the threshold — into the enchanted world.
   - Spreads 3-4: The quest unfolds — forest, castle, river, each with wonder and an obstacle.
   - Spread 5: An ally joins — a creature, a wise old figure, a magical being.
   - Spread 6: THE HINGE — the hardest challenge: a locked gate, a guardian, a riddle with no answer.
   - Spreads 7-8: The child solves it — cleverness or heart, not force. The favorite object is key.
   - Spreads 9-10: Victory — the quest fulfilled, the magic restored or the treasure found.
   - Spread 11: The journey back through the enchanted world.
   - Spread 12: Through the door — one quiet line.
   - Spread 13: Home. The magic still warm. Sleep comes easy.`;

    case 'nature':
      return `8. beats: An array of exactly 13 one-line descriptions — one per spread. Follow this NATURE arc:
   - Spread 1: The child steps outside — something in nature catches their eye or calls them.
   - Spread 2: Following the call — into the garden, the forest, the field, or the river.
   - Spreads 3-4: Discovery — animals, plants, weather. Each encounter vivid and specific.
   - Spread 5: The child finds something that needs help (a lost creature, a wilting plant, a blocked stream).
   - Spread 6: THE HINGE — the child can't fix it alone. Something is too big, too tangled, too far.
   - Spreads 7-8: Working with nature — patience, observation, the right tool (the favorite object).
   - Spreads 9-10: The natural world responds — healing, returning, blooming, moving.
   - Spread 11: Walking home through the changed landscape.
   - Spread 12: Arriving home — one quiet line.
   - Spread 13: On the porch steps, the garden glowing in the dusk, a creature somewhere near. Still.`;

    case 'friendship':
      return `8. beats: An array of exactly 13 one-line descriptions — one per spread. Follow this FRIENDSHIP arc:
   - Spread 1: The child is alone, or something changes — a new face, a strange creature, an unexpected meeting.
   - Spread 2: A hesitant approach — the child and the new friend circle each other.
   - Spreads 3-4: A shared adventure begins — exploring together, each bringing something different.
   - Spread 5: A moment of pure joy — they fit together perfectly.
   - Spread 6: THE HINGE — a misunderstanding or conflict. The friendship feels broken.
   - Spreads 7-8: The repair — honesty, the favorite object as a gift or gesture, finding each other again.
   - Spreads 9-10: The friendship deepens — a shared secret, a promise, a place that's just theirs.
   - Spread 11: Saying goodbye for now — but knowing they'll be back.
   - Spread 12: Going home — one quiet line.
   - Spread 13: At the window or doorstep, something the friend gave them in hand. The world is full.`;

    case 'mothers_day':
      return `8. beats: An array of exactly 13 one-line descriptions — one per spread. Follow this MOTHER'S DAY arc:
   MOM AS CO-PROTAGONIST RULE: Mom is a NAMED, VISIBLE character in this story. She MUST appear in the illustration prompts for at least 6 of the 13 spreads. When she appears, describe her presence explicitly (e.g. "Mom kneels beside the child", "Mom's hand rests on the child's shoulder"). Her appearance must be described consistently every time she is in an illustration prompt.
   EMOTIONAL ARC: This is a love letter from the child to their mother. Every spread should feel warm and deeply personal. The story builds emotional warmth steadily — from a quiet opening to joyful peak to tender close.
   CELEBRATION RULE: This story is a CELEBRATION — NO villain, NO loss, NO tantrums, NO crying, NO anger, NO bedtime, NO sleeping. However, the story MUST still have forward momentum: anticipation, a small goal, curiosity, or a surprise. The reader must want to turn the page. A story where every spread feels the same is not a celebration — it is a list.
   NARRATIVE SPINE RULE (CRITICAL): The story MUST follow ONE simple through-line that connects all 13 spreads. Choose ONE of these spines:
   A) A JOURNEY — child and Mom go somewhere together (a walk to the park, a trip to the market, a bus ride to a special place). Spreads follow the journey from leaving home to arriving.
   B) A PROJECT — child and Mom make or do something together (bake a cake, plant a garden, build a fort). Spreads follow the project from start to finish.
   C) A GIFT — child prepares something for Mom (a drawing, a surprise breakfast, a treasure hunt). Spreads follow the preparation and reveal.
   Every spread must connect to the spine. No standalone vignettes. A 3-year-old should be able to answer "what is this book about?" in one sentence.
   SCENE PACING: The 13 spreads should contain NO MORE than 3-4 distinct locations or activities. Each location/activity gets 2-4 spreads of development. Single-spread activities create a slideshow, not a story.
   CREATIVITY RULE: At least 2 spreads must use the child's IMAGINATION — transforming something ordinary into something magical. Include one spread where the child tries to take care of Mom (a reversal). These moments must happen WITHIN the spine, not as detours.
   TRANSITION RULE: Every spread-to-spread transition must be followable by a 3-year-old. The reader must always know WHERE the characters are and HOW they got there. If the location changes, show the movement.

   SCENE A — HOME (Spreads 1-3): Mom is VISIBLE in all.
   - Spread 1 (THE OPENING): Child and Mom in a specific moment at home — mid-action, not waking up. Establish the warm world AND hint at what the day holds (the spine).
   - Spread 2 (SETTLING IN): The spine takes shape — the shared activity begins, or preparation for the journey starts. Use favorite_activities from questionnaire. A small moment that reveals their bond.
   - Spread 3 (SOMETHING SPECIAL): A detail that makes THIS mother-child pair unique — a secret language, an inside joke, a private ritual from the questionnaire. Woven into the ongoing activity, not a standalone scene.

   SCENE B — THE ADVENTURE (Spreads 4-7): Mom is VISIBLE in all.
   - Spread 4 (SETTING OFF / DEEPENING): If journey spine: they leave home — show the transition. If project/gift spine: the activity deepens, something unexpected happens. Anticipation builds.
   - Spread 5 (IMAGINATION): Child transforms something ordinary into something magical — Mom plays along. This must connect to the spine (e.g. a puddle on the walk becomes an ocean, the cake batter becomes a potion).
   - Spread 6 (THE REVERSAL): Child tries to take care of Mom — earnest, funny, tender. Within the context of the spine (e.g. child "helps" navigate, child stirs the batter, child carries Mom's bag).
   - Spread 7 (MOM NOTICES): Mom sees something specific and wonderful about the child. The noticing IS the love. A quiet beat before the peak — the story breathes here.

   SCENE C — THE PEAK (Spreads 8-11): Mom is VISIBLE in at least 3.
   - Spread 8 (ARRIVING / COMPLETING): The journey reaches its destination, OR the project nears completion. The world opens up.
   - Spread 9 (PEAK JOY): The best moment of the day — physical, joyful, specific. Spinning, running, laughing, the thing they came here to do. Maximum energy.
   - Spread 10 (THE GIFT): Child gives Mom something imperfect and precious — a dandelion, a lopsided drawing, a found pebble. The gesture is small but it lands. Can happen at the destination or as part of the project.
   - Spread 11 (TOGETHER): Side by side, savoring the moment. Happy, vivid, warm. The emotional high point — not louder than spread 9, but deeper.

   SCENE D — THE CLOSE (Spreads 12-13): Mom is VISIBLE in both.
   - Spread 12 (HEADING HOME / WINDING DOWN): The journey home, or the finished project admired. One warm transitional beat. NOT sleepy, NOT bedtime.
   - Spread 13 (THE LAST LINE): One perfect closing image — warm, bright, celebratory. End in DAYLIGHT with togetherness. Concrete and specific, not abstract. A parent should want to read it twice.`;

    case 'fathers_day':
      return `8. beats: An array of exactly 13 one-line descriptions — one per spread. Follow this FATHER'S DAY arc:
   DAD AS CO-PROTAGONIST RULE: Dad is a NAMED, VISIBLE character in this story. He MUST appear in the illustration prompts for at least 6 of the 13 spreads. When he appears, describe his presence explicitly (e.g. "Dad lifts the child onto his shoulders", "Dad's hand steadies the child"). His appearance must be described consistently every time he is in an illustration prompt.
   EMOTIONAL ARC: This is a love letter from the child to their father. Every spread should feel warm, adventurous, and deeply personal. The story builds emotional warmth steadily — from a quiet opening to adventurous peak to heartfelt close.
   CELEBRATION RULE: This story is a CELEBRATION — NO villain, NO loss, NO tantrums, NO crying, NO anger, NO bedtime. However, the story MUST still have forward momentum: anticipation, a small goal, curiosity, or excitement about what comes next. The reader must want to turn the page.
   NARRATIVE SPINE RULE (CRITICAL): The story MUST follow ONE simple through-line that connects all 13 spreads. Choose ONE of these spines:
   A) AN ADVENTURE — child and Dad go somewhere together (a hike, a fishing trip, the workshop, the ball field). Spreads follow the outing from start to finish.
   B) A PROJECT — child and Dad build or make something together (a treehouse, a go-kart, a meal, a garden bed). Spreads follow the project from start to finish.
   C) A CHALLENGE — child and Dad tackle something together (learn to ride a bike, fix something broken, explore a new place). Spreads follow the attempt from start to finish.
   Every spread must connect to the spine. No standalone vignettes. A 3-year-old should be able to answer "what is this book about?" in one sentence.
   SCENE PACING: The 13 spreads should contain NO MORE than 3-4 distinct locations or activities. Each location/activity gets 2-4 spreads of development. Single-spread activities create a slideshow, not a story.
   TRANSITION RULE: Every spread-to-spread transition must be followable by a 3-year-old. The reader must always know WHERE the characters are and HOW they got there.

   SCENE A — HOME / LAUNCH (Spreads 1-3): Dad is VISIBLE in all.
   - Spread 1 (THE OPENING): Child and Dad in a specific moment — mid-action, not waking up. Establish the bond AND hint at what the day holds (the spine).
   - Spread 2 (GETTING READY): The spine takes shape — preparing for the adventure or starting the project. Use favorite_activities from questionnaire. A moment that shows how they work together.
   - Spread 3 (SOMETHING ONLY THEY DO): A detail that makes THIS father-child pair unique — a funny ritual, a shared joke, Dad's signature move from the questionnaire. Woven into the ongoing activity, not a standalone scene.

   SCENE B — THE ADVENTURE (Spreads 4-7): Dad is VISIBLE in all.
   - Spread 4 (SETTING OFF / DEEPENING): If adventure spine: they head out — show the transition and anticipation. If project spine: things get interesting, a new challenge within the task.
   - Spread 5 (DAD'S SUPERPOWER): Something Dad does that amazes the child — a skill, a trick, a moment of strength or gentleness. Use other_detail or funny_thing. Connected to the spine.
   - Spread 6 (LAUGHTER): A funny or playful moment within the adventure/project. Physical comedy, a shared joke, something goes slightly sideways in a fun way. Dad is VISIBLE.
   - Spread 7 (SIDE BY SIDE): A quieter beat — working together, watching something, a moment of focus. The story breathes here before the peak. Dad is VISIBLE.

   SCENE C — THE PEAK (Spreads 8-11): Dad is VISIBLE in at least 3.
   - Spread 8 (THE BIG MOMENT): The adventure reaches its destination, OR the project nears completion. Use meaningful_moment from questionnaire.
   - Spread 9 (PEAK JOY): The best moment — triumphant, exciting, the payoff. Maximum energy. Incorporate favorite food, toys, or activities from questionnaire.
   - Spread 10 (THE CHILD LEADS): The child does something that surprises or impresses Dad — shows what they have learned, takes a turn, steps up. A role reversal.
   - Spread 11 (PROUD): Dad and child share a look, a word, a gesture. Admiration flows both ways. The emotional high point — deeper than spread 9, not louder.

   SCENE D — THE CLOSE (Spreads 12-13): Dad is VISIBLE in both.
   - Spread 12 (HEADING HOME / FINISHING UP): The journey home, or the completed project admired. One warm transitional beat. NOT sleepy, NOT bedtime.
   - Spread 13 (THE LAST LINE): One perfect closing image of father-child love. Concrete and specific, not abstract. The most beautiful sentence. Dad is VISIBLE.`;

    case 'birthday_magic':
      return `8. beats: An array of exactly 13 one-line descriptions — one per spread. Follow this BIRTHDAY MAGIC arc:
   BIRTHDAY ENERGY RULE: This story should feel like the BEST DAY OF THE CHILD'S LIFE from the very first spread. Joy, warmth, and excitement are the emotional BASELINE — not something to be earned.
   CELEBRATION RULE: This story is a CELEBRATION. There is NO villain, NO doubt, NO loss to overcome. Every spread radiates birthday magic.
   BIRTHDAY SATURATION RULE: The birthday must be FELT in every single spread — balloons, streamers, friends, wrapped gifts, candles, the sound of singing, the smell of cake. Choose different birthday details for each spread so the celebration builds and accumulates.
   - Spread 1 (BIRTHDAY MORNING): Child wakes up — it's their birthday! Pure excitement and anticipation.
   - Spread 2 (THE CELEBRATION BEGINS): Decorations, preparations, or the first moment of birthday magic.
   - Spread 3 (FAVORITE ACTIVITY): The birthday activity they love most. Use favorite_activities from questionnaire.
   - Spread 4 (FRIENDS & FAMILY): People who love the child are there to celebrate. Warm togetherness.
   - Spread 5 (THE CAKE): The birthday cake appears! Use favorite_cake_flavor. A moment of pure delight.
   - Spread 6 (THE SURPRISE): Something unexpected and wonderful happens. Use funny_thing or other_detail.
   - Spread 7 (PEAK JOY): The most exciting moment of the birthday. Maximum happiness.
   - Spread 8 (FAVORITE THINGS): Incorporate favorite toys, food, or activities from questionnaire.
   - Spread 9 (THE WISH): The birthday wish moment — candles, hope, magic.
   - Spread 10 (GRATITUDE): Child feels grateful for everyone and everything they love.
   - Spread 11 (WARM GLOW): The golden feeling of being celebrated and loved.
   - Spread 12 (WINDING DOWN): The beautiful tiredness after a perfect day.
   - Spread 13 (THE LAST LINE): One perfect closing image of birthday magic. The most beautiful sentence. The child's eyes are bright, the cake still glowing, the world still humming with celebration.`;

    default: // adventure, bedtime
      return `8. beats: An array of exactly 13 one-line descriptions — one per spread — mapping the emotional journey. Each beat must name the SPECIFIC LOCATION and the ACTION that happens there. Follow this structure:
   QUEST RULE: This is an adventure story. The child's specific goal MUST be named in spread 1 — concrete, visual, and achievable. "Go on an adventure" is not a quest. A quest has a specific target: an object to find, a place to reach, a creature to help, a mystery to solve. The entire story builds toward this goal. Spread 13 resolves it with success.
   - Spread 1: THE QUEST IS NAMED — state the specific mission the child is setting out to do, find, or reach. It must be concrete and named (e.g. "find the lost color", "reach the top of Ember Hill", "return the golden acorn to the ancient tree"). The child sets off with clear intention. Do NOT start with "waking up" — start with the quest already beginning.
   - Spread 2: First steps into the adventure — the world opens up, first wonder or obstacle.
   - Spreads 3-5: Rising action (new locations, each with its own obstacle)
   - Spread 6: THE HINGE — child is stuck, blocked, or almost fails (this is the most important beat — make it specific and tense)
   - Spreads 7-9: Breakthrough (child uses the favorite object or courage to overcome the hinge obstacle, victory builds)
   - Spreads 10-11: Resolution (final challenge solved, journey home begins)
   - Spread 12: Homecoming — one quiet settling line (child arrives home, changed)
   - Spread 13: MISSION COMPLETE — the child has achieved exactly what they set out to do. The final image is triumphant stillness — they did it. The world is bigger because the quest succeeded. NOT rest, NOT sleep, NOT bedroom.`;
  }
}

async function brainstormStorySeed(childDetails, customDetails, approvedTitle, opts = {}) {
  const { costTracker, apiKeys, theme, additionalCoverCharacters } = opts;
  const openaiKey = apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  const name = childDetails.name || childDetails.childName || 'the child';
  const age = childDetails.age || childDetails.childAge || 5;
  const gender = childDetails.gender || childDetails.childGender || '';
  const interests = (childDetails.interests || childDetails.childInterests || []).filter(Boolean);

  const isEmotional = EMOTIONAL_THEMES.has(theme);
  const emotionalTierInfo = isEmotional ? getEmotionalTier(age) : null;
  const spreadCount = emotionalTierInfo ? emotionalTierInfo.spreads : 13;
  const beatStructure = isEmotional
    ? getEmotionalBeatStructure(theme, age, opts.emotionalSituation || '')
    : getThemeBeatStructure(theme, age);

  const systemPrompt = `You are a world-class children's book story developer. Your job is to brainstorm a UNIQUE, ORIGINAL story concept for a personalized picture book (${spreadCount} spreads).

NARRATIVE STRUCTURE (READ THIS FIRST — it overrides all other instructions):
- The story MUST follow ONE simple through-line: a journey, a project, or a gift. This is the "spine."
- The ${spreadCount} beats must contain NO MORE than 3-4 distinct locations or activities.
- Each location/activity spans 2-4 consecutive beats. Single-beat activities are FORBIDDEN.
- Beats must be grouped into SCENES (e.g. Scene A: home, Scene B: the walk, Scene C: the park, Scene D: heading home) — NOT ${spreadCount} standalone vignettes.
- If your beats read like a list of unrelated activities (reading, then eating, then drawing, then riding a bus, then jumping in puddles), STOP and restructure around the spine.
- A 3-year-old listener must be able to follow every transition. The reader should always know WHERE the characters are.
- Test: can you describe this story in one sentence? ("They walk to the park together." / "She bakes Dad a surprise cake.") If not, the spine is missing.

You will receive details about a child and a THEME. The theme is NOT optional context — it is the structural backbone of the story. Every field you return must serve the theme.

THEME: ${theme || 'adventure'}

Return a JSON object with these fields:

1. favorite_object: A specific companion or object the child carries through the story. IMPORTANT: Match the object to the child's age. For toddlers (age 1-3), a small stuffed animal is fine. For ages 4-6, choose a specific toy or comfort object. For ages 7+, choose something age-appropriate: a ball, a notebook, a special backpack, a tool, an instrument, a gadget. NEVER give a 7+ year old a teddy bear unless the parent specifically mentioned one.

2. fear: The specific emotional challenge or obstacle the child must face IN THIS STORY. It must fit the theme — for birthday it might be "the celebration almost ruined", for space it's "lost between stars", for adventure it's a physical barrier. NOT always "the dark".

3. setting: A vivid, specific world matching the theme. One sentence describing the overall world (e.g. "a glittering undersea kingdom beneath the bay at the end of their street"). The beats will name the specific locations within it.

4. storySeed: One sentence describing the unique emotional journey. Must reflect the theme's arc.

5. narrative_spine: One sentence describing the SINGLE through-line of the story. This is the answer to "what is this book about?" Format: "[Child] and [person] [do one thing]." Examples: "Logan and Mama walk to the park together", "Gianna bakes Mama a surprise cake", "Liam and Dad build a birdhouse in the backyard." The spine must be concrete and specific — not "they have a nice day" or "they share love." Every beat must connect to this spine.

6. emotional_core: One sentence for what the PARENT feels after reading. The emotional truth beyond the plot.

7. repeated_phrase: A short phrase (2-8 words) that repeats through the story and evolves. Must match the theme's energy — birthday phrases feel celebratory, bedtime phrases feel soothing, adventure phrases feel bold. NOT generic.
   The phrase MUST be poetic and sensory — specific and unexpected, never generic motivation. REJECT: "ready to fly", "you've got this", "believe in yourself", "anything is possible", "shine bright", "dream big", "you are enough". REQUIRE: phrases that carry a physical sensation or unexpected image. If your phrase could appear on a motivational poster, discard it and try again.
   Theme-specific examples of GOOD phrases (for calibration — do NOT copy these):
   - Adventure: "the map remembers", "boots on stone", "one bridge left", "the trail hums back"
   - Bedtime: "the dark has a sound now", "still here, still mine", "the blanket knows", "hush is a color"
   - Birthday: "this cake, this day", "the room is singing", "candles counting down", "frosting on her chin"
   - Space/Underwater: "bubbles know the way", "salt on her tongue", "the stars are listening", "deep enough to echo"
   - Emotional: "my hands are shaking still", "the knot unwound", "smaller than it was", "the weight has a name now"
   - Nature/Friendship: "the roots remember", "your hand in mine", "the river kept going", "bark under her nails"

8. phrase_arc: Three short descriptions of how the phrase evolves:
   - early: how it feels the first time
   - middle: how it shifts
   - end: how it lands

${beatStructure}

STORY ARC RULE:
- Build the story DIRECTLY from the user's questionnaire answers. Every spread should reference specific details the parent provided.
- Do NOT invent abstract conflicts, metaphorical bridges, missing-item quests, or mysterious challenges unless they come from the user's input.
- For occasion themes (Mother's Day, Father's Day, Birthday): the story is a CELEBRATION — no villain, no doubt, no loss. But remember: the NARRATIVE STRUCTURE rules above still apply. The narrative_spine field must drive every beat.

MANDATORY PERSONALIZATION:
If the customer provided specific details (a real person, a specific place, a family quirk, a pet's name, a real fear), these MUST appear concretely in the beats. Do not treat them as optional flavor. Weave them into the specific locations and actions.

${theme === 'mothers_day'
  ? (additionalCoverCharacters
    ? `MOTHER'S DAY — MOM IN ILLUSTRATIONS + SECONDARY CHARACTERS:
Mom is a co-protagonist in this story. She MUST appear in beats for at least 6 of 13 spreads.
When writing beats that include Mom, note her presence explicitly so downstream illustration prompts can include her.
Describe Mom warmly and consistently each time.
ADDITIONALLY, the uploaded photo contains a secondary person:
${additionalCoverCharacters}
CRITICAL: Their appearance must be CONSISTENT across all illustrations. Only Mom and the secondary character(s) listed above are allowed in illustrations — do NOT invent any other family members.`
    : `MOTHER'S DAY — MOM IN ILLUSTRATIONS (FACE COMPLETELY HIDDEN):
Mom is a co-protagonist in this story. She MUST appear in beats for at least 6 of 13 spreads.
When writing beats that include Mom, note her presence explicitly so downstream illustration prompts can include her.
CRITICAL: We have NO reference image for Mom. She is FEMALE (a woman — never draw a man). Her face must NEVER be visible in ANY illustration — no eyes, no mouth, no facial features. In EVERY beat where Mom appears, describe a specific hidden-face pose: "Mom's hands wrap around the child from behind", "seen from behind, Mom kneels beside...", "Mom's arm reaches in from the side". NEVER write "Mom smiles" or "Mom looks at" — these cause the illustrator to draw her face. Her warmth comes through body language, hands, and posture only.
Other family members (siblings, grandparents, dad) must NOT appear in illustrations — text only.`)
  : theme === 'fathers_day'
  ? (additionalCoverCharacters
    ? `FATHER'S DAY — DAD IN ILLUSTRATIONS + SECONDARY CHARACTERS:
Dad is a co-protagonist in this story. He MUST appear in beats for at least 6 of 13 spreads.
When writing beats that include Dad, note his presence explicitly so downstream illustration prompts can include him.
Describe Dad warmly and consistently each time.
ADDITIONALLY, the uploaded photo contains a secondary person:
${additionalCoverCharacters}
CRITICAL: Their appearance must be CONSISTENT across all illustrations. Only Dad and the secondary character(s) listed above are allowed in illustrations — do NOT invent any other family members.`
    : `FATHER'S DAY — DAD IN ILLUSTRATIONS (FACE COMPLETELY HIDDEN):
Dad is a co-protagonist in this story. He MUST appear in beats for at least 6 of 13 spreads.
When writing beats that include Dad, note his presence explicitly so downstream illustration prompts can include him.
CRITICAL: We have NO reference image for Dad. He is MALE (a man — never draw a woman). His face must NEVER be visible in ANY illustration — no eyes, no mouth, no facial features. In EVERY beat where Dad appears, describe a specific hidden-face pose: "Dad's strong hands lift the child", "seen from behind, Dad walks beside...", "Dad's arm reaches in from the side". NEVER write "Dad smiles" or "Dad looks at" — these cause the illustrator to draw his face. His warmth comes through body language, hands, and posture only.
Other family members (siblings, grandparents, mom) must NOT appear in illustrations — text only.`)
  : (additionalCoverCharacters
    ? `SECONDARY CHARACTERS (from the uploaded photo):
The uploaded photo contains more than one person. The following secondary character(s) appear on the cover and MAY appear in illustrations. Include them naturally in the story where appropriate.
${additionalCoverCharacters}
CRITICAL: Their appearance must be CONSISTENT across all illustrations — same hair, same skin, same build, same clothing style. Write their presence into illustration prompts just as you do for the child. They are LOCKED to the reference photo.
Do NOT invent other family members beyond what is listed above.`
    : `ILLUSTRATION CONSTRAINT — NO FAMILY MEMBERS IN IMAGES:
Story text MAY mention family members by name. However, family members must NEVER appear as visible characters in illustrations — we only have the child's photo. Design beats so scenes center the child visually.`)}

INTERESTS vs. VISUAL THEMES (CRITICAL):
When the child's interests include character names (Bluey, Pinkalicious, Peppa Pig, Spider-Man, Elsa, etc.), these are CHARACTERS the child likes — NOT literal color or visual themes. "Pinkalicious" means the child enjoys those books, not "make everything pink." "Bluey" means the child watches that show, not "make everything blue." Use these interests as INSPIRATION for tone, energy, or a subtle nod — but NEVER flood the story with a single color or visual motif. The story should have a natural, varied color palette. A subtle reference is charming; saturation is overwhelming.
Similarly, if a color is listed as an interest (e.g., "pink", "blue"), it can appear as ONE detail (a favorite shirt, a special object) — but it should NOT dominate every spread's setting, objects, and imagery.

Be ORIGINAL. The child's name, age, interests, and custom details must make this feel like it was written for exactly this child and no one else.

STYLE MODE SELECTION:
Before generating the seed, select a style mode for this story. Consider the theme, the child's age, and the emotional need.

Modes:
- "sparse": Sendak/Jeffers. Short sentences. Maximum economy. Trust silence.
- "playful": Willems/Dahl. Deadpan humor. Absurd logic. The narrator winks.
- "lyrical": Donaldson/Seuss. Strong rhythm. Rhyming couplets. The story sings.
- "tender": Klassen/Portis. Quiet. Observational. Gentle pacing. Emotion through stillness.
- "mischievous": Barnett/Jeffers. Kinetic energy. Rules broken. Slightly naughty child.

Choose the mode that best fits THIS specific story.

TECHNIQUE BUDGET:
Select 2-3 advanced techniques to execute with conviction. Do NOT select all of them.

Pick from:
A. "rule_of_three" — Three attempts/encounters/obstacles. The third breaks the pattern.
B. "surprise" — One genuinely unexpected moment.
C. "humor" — Comic timing, running gags, deadpan delivery.
D. "page_turn_hooks" — Use the physical page turn as a dramatic device.
E. "lyrical_repetition" — A repeated structure that creates rhythm and evolves.

Output these in your JSON: "style_mode": "sparse|playful|lyrical|tender|mischievous", "techniques": ["rule_of_three", "humor"]

You MUST return ONLY a valid JSON object with: favorite_object, fear, setting, storySeed, narrative_spine, emotional_core, repeated_phrase, phrase_arc, beats, style_mode, techniques.`;

  const genderLabel = gender === 'male' ? 'boy' : gender === 'female' ? 'girl' : (gender && gender !== 'neutral' && gender !== 'not specified' ? gender : '');
  const pronounPair = gender === 'female' ? 'she/her' : gender === 'male' ? 'he/him' : 'they/them';

  let userPrompt = `THEME: ${theme || 'adventure'}
Child: ${name}, age ${age}${genderLabel ? `, ${genderLabel}` : ''} (${pronounPair} pronouns)
Interests: ${interests.length ? interests.join(', ') : 'not specified'}
${gender && gender !== 'neutral' && gender !== 'not specified' ? `CRITICAL: ${name} uses ${pronounPair} pronouns. Always use the correct pronouns throughout the story.` : ''}`;

  if (customDetails && customDetails.trim()) {
    userPrompt += `\n\n⚠️ MANDATORY CUSTOMER DETAILS — These are real facts the parent wrote about their child. Every specific person, place, object, or quirk mentioned here MUST appear concretely in the story beats. Do not ignore or generalize any of it:\n${customDetails.trim()}`;
  }

  if (isEmotional && opts.emotionalSituation) {
    userPrompt += `\n\n⚠️ EMOTIONAL SITUATION — THIS IS WHAT IS ACTUALLY HAPPENING WITH THIS CHILD RIGHT NOW:\n"${opts.emotionalSituation}"\nEvery beat must be grounded in THIS specific situation. Do not generalize. The child's specific triggers, patterns, and context should be woven throughout.`;
  }
  if (isEmotional && opts.copingResourceHint) {
    userPrompt += `\n\nCOPING RESOURCE: The parent says "${opts.copingResourceHint}" already helps this child. Build this into the story as the child's companion or tool in Acts 5–8.`;
  }

  if (approvedTitle) {
    userPrompt += `\n\nThe book title is already chosen: "${approvedTitle}". The story seed and beats must fit this title exactly.`;
  }

  if (theme === 'birthday') {
    userPrompt += `\n\nBIRTHDAY PHRASE RULE: The repeated_phrase must feel celebratory and bright — a birthday refrain, not a lullaby. Examples: "this is the day", "one more wish", "${name}'s whole bright day". REJECT wistful or introspective phrases.

BIRTHDAY STORY RULE: The story_seed must be ABOUT the birthday itself — not an adventure that starts on a birthday. Every beat should be a birthday moment: decorations, friends, a special activity, gifts, the smell of cake, the sound of singing. The birthday must be felt in every spread. The favorite_object should appear in the party setting, not on a quest. The fear/obstacle is a small birthday hiccup (a wobbly cake, a missing bow, a game that needs saving) — never a scary or sad obstacle.`;
  }

  userPrompt += `\n\nTIME OF DAY: Choose a time that serves the story's emotional logic. Not every book must start in the morning or end at night. Only bedtime-themed stories should default to evening. Adventures, birthdays, science, and space stories can begin at any hour.`;

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
        favorite_object: extractField('favorite_object') || getAgeAppropriateFallbackObject(age),
        fear: extractField('fear') || 'the dark',
        setting: extractField('setting') || 'a magical place',
        storySeed: extractField('storySeed') || extractField('story_seed') || '',
        narrative_spine: extractField('narrative_spine') || '',
        emotional_core: extractField('emotional_core') || '',
        repeated_phrase: extractField('repeated_phrase') || '',
        phrase_arc: [],
        beats: [],
        style_mode: extractField('style_mode') || 'playful',
        techniques: ['rule_of_three', 'humor'],
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
    return { favorite_object: getAgeAppropriateFallbackObject(age), fear: 'the dark', setting: 'a magical place', storySeed: '', narrative_spine: '', emotional_core: '', repeated_phrase: '', phrase_arc: [], beats: [], style_mode: 'playful', techniques: ['rule_of_three', 'humor'] };
  }

  if (!seed.narrative_spine) seed.narrative_spine = '';
  if (!seed.emotional_core) seed.emotional_core = '';
  if (!seed.repeated_phrase) seed.repeated_phrase = '';
  if (!Array.isArray(seed.phrase_arc)) seed.phrase_arc = [];
  if (!Array.isArray(seed.beats)) seed.beats = [];

  // Extract style mode and techniques
  const VALID_STYLE_MODES = ['sparse', 'playful', 'lyrical', 'tender', 'mischievous'];
  if (!seed.style_mode || !VALID_STYLE_MODES.includes(seed.style_mode)) {
    seed.style_mode = 'playful';
  }
  const VALID_TECHNIQUES = ['rule_of_three', 'surprise', 'humor', 'page_turn_hooks', 'lyrical_repetition'];
  if (!Array.isArray(seed.techniques) || seed.techniques.length === 0) {
    seed.techniques = ['rule_of_three', 'humor'];
  } else {
    seed.techniques = seed.techniques.filter(t => VALID_TECHNIQUES.includes(t));
    if (seed.techniques.length === 0) seed.techniques = ['rule_of_three', 'humor'];
  }

  console.log(`[storyPlanner] Story seed: object="${seed.favorite_object}", fear="${seed.fear}", setting="${seed.setting}"`);
  if (seed.narrative_spine) console.log(`[storyPlanner] Narrative spine: "${seed.narrative_spine}"`);
  if (seed.emotional_core) console.log(`[storyPlanner] Emotional core: "${seed.emotional_core}"`);
  if (seed.repeated_phrase) console.log(`[storyPlanner] Repeated phrase: "${seed.repeated_phrase}"`);
  if (seed.beats.length) console.log(`[storyPlanner] Beat sheet: ${seed.beats.length} beats`);
  console.log(`[storyPlanner] Style mode: ${seed.style_mode}, Techniques: ${seed.techniques.join(', ')}`);

  // Validate seed quality and retry once if issues found
  const seedValidation = validateSeedQuality(seed, theme, age);
  if (!seedValidation.valid) {
    console.log(`[storyPlanner] Seed validation failed: ${seedValidation.issues.map(i => `${i.field}:${i.reason}`).join(', ')} — retrying`);
    const issueDescriptions = seedValidation.issues.map(i => {
      if (i.reason === 'generic_motivational') return `- repeated_phrase: "${seed.repeated_phrase}" sounds like a motivational poster. Generate a phrase with a physical sensation or concrete image — something that could NOT appear on a greeting card.`;
      if (i.reason === 'too_generic') return `- setting: "${seed.setting}" is too vague. Make the setting vivid and specific — one sentence with color, texture, or atmosphere.`;
      if (i.reason === 'default_fear_for_non_bedtime') return `- fear: "the dark" is the default fear. Choose a fear that fits the ${theme} theme specifically.`;
      if (i.reason === 'wrong_length') return `- repeated_phrase: "${seed.repeated_phrase}" is the wrong length (must be 2-8 words).`;
      if (i.reason === 'missing_spine') return `- narrative_spine: Missing or too vague. Provide a concrete one-sentence spine in the format "[Child] and [person] [do one thing]." Example: "Logan and Mama walk to the park together."`;
      if (i.reason === 'too_many_scenes') return `- beats: The beats describe too many unrelated scenes (${i.detail || 'too many scene breaks'}). Restructure ALL beats around the narrative_spine. Group beats into 3-4 connected scenes (e.g. Scene A: home, Scene B: walking, Scene C: at the park, Scene D: heading home). Consecutive beats should share the same location or activity. Do NOT write 13 different standalone activities.`;
      return `- ${i.field}: ${i.reason}`;
    });

    try {
      const retryPrompt = userPrompt + `\n\nYour previous response had these quality issues:\n${issueDescriptions.join('\n')}\n\nReturn the COMPLETE corrected JSON with ALL fields (favorite_object, fear, setting, storySeed, narrative_spine, emotional_core, repeated_phrase, phrase_arc, beats). Fix ONLY the flagged fields — keep everything else the same.`;
      const retryResponse = await callLLM(systemPrompt, retryPrompt, {
        openaiApiKey: openaiKey,
        maxTokens: 1500,
        temperature: 0.95,
        jsonMode: true,
        costTracker,
      });
      let retryContent = retryResponse.text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
      let retrySeed;
      try {
        retrySeed = JSON.parse(retryContent);
      } catch (_) {
        const stripped = retryContent.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
        retrySeed = JSON.parse(stripped);
      }
      // Unwrap nested responses
      if (retrySeed && !retrySeed.favorite_object && typeof retrySeed === 'object') {
        const inner = retrySeed.storySeed || retrySeed.data || retrySeed.seed || Object.values(retrySeed)[0];
        if (inner && typeof inner === 'object' && inner.favorite_object) retrySeed = inner;
      }
      if (retrySeed && retrySeed.favorite_object) {
        const flaggedFields = new Set(seedValidation.issues.map(i => i.field).filter(Boolean));
        // When beats have too many scenes, ensure both beats and spine are replaced
        if (seedValidation.issues.some(i => i.reason === 'too_many_scenes')) {
          flaggedFields.add('beats');
          flaggedFields.add('narrative_spine');
        }
        const mergedRetrySeed = { ...seed };
        for (const field of flaggedFields) {
          if (Object.prototype.hasOwnProperty.call(retrySeed, field)) {
            mergedRetrySeed[field] = retrySeed[field];
          }
        }
        const retryValidation = validateSeedQuality(mergedRetrySeed, theme, age);
        if (retryValidation.valid || retryValidation.issues.length < seedValidation.issues.length) {
          console.log(`[storyPlanner] Seed retry improved quality (${seedValidation.issues.length} -> ${retryValidation.issues.length} issues)`);
          if (!mergedRetrySeed.narrative_spine) mergedRetrySeed.narrative_spine = '';
          if (!mergedRetrySeed.emotional_core) mergedRetrySeed.emotional_core = '';
          if (!mergedRetrySeed.repeated_phrase) mergedRetrySeed.repeated_phrase = '';
          if (!Array.isArray(mergedRetrySeed.phrase_arc)) mergedRetrySeed.phrase_arc = [];
          if (!Array.isArray(mergedRetrySeed.beats)) mergedRetrySeed.beats = [];
          return mergedRetrySeed;
        }
        console.log(`[storyPlanner] Seed retry did not improve — keeping original`);
      }
    } catch (retryErr) {
      console.warn(`[storyPlanner] Seed retry failed: ${retryErr.message} — keeping original`);
    }
  }

  return seed;
}

/**
 * Validate the quality of a brainstormed story seed.
 * Returns { valid: boolean, issues: Array<{ field, reason }> }
 */
function validateSeedQuality(seed, theme, age) {
  const issues = [];

  // Generic repeated phrase detection — reject motivational poster patterns
  const GENERIC_PHRASE_PATTERNS = [
    /\b(?:ready to|you(?:'ve| have) got|believe in|anything is|you can|never give|follow your|dream big|shine bright|be brave|stay strong)\b/i,
    /\b(?:the magic|is possible|inside you|in your heart|makes you special|you are enough|world is yours)\b/i,
    /\b(?:reach for|shoot for|aim for)\s+(?:the stars|the sky|the moon)\b/i,
  ];
  if (seed.repeated_phrase) {
    for (const pattern of GENERIC_PHRASE_PATTERNS) {
      if (pattern.test(seed.repeated_phrase)) {
        issues.push({ field: 'repeated_phrase', reason: 'generic_motivational' });
        break;
      }
    }
    const wordCount = seed.repeated_phrase.trim().split(/\s+/).length;
    if (wordCount < 2 || wordCount > 8) {
      issues.push({ field: 'repeated_phrase', reason: 'wrong_length' });
    }
  }

  // Generic setting detection
  const GENERIC_SETTINGS = [
    /^a\s+magic(?:al)?\s+(?:forest|place|world|land|kingdom)$/i,
    /^a\s+beautiful\s/i,
    /^a\s+wonderful\s/i,
    /^a\s+special\s+place$/i,
  ];
  if (seed.setting) {
    for (const pattern of GENERIC_SETTINGS) {
      if (pattern.test(seed.setting.trim())) {
        issues.push({ field: 'setting', reason: 'too_generic' });
        break;
      }
    }
  }

  // "the dark" as fear for non-bedtime themes
  if (seed.fear && /^the dark$/i.test(seed.fear.trim()) && theme !== 'bedtime') {
    issues.push({ field: 'fear', reason: 'default_fear_for_non_bedtime' });
  }

  // Abstract conflict pattern detection for occasion themes
  const OCCASION_THEMES = new Set(['mothers_day', 'fathers_day', 'birthday_magic']);
  if (OCCASION_THEMES.has(theme) && Array.isArray(seed.beats)) {
    const ABSTRACT_CONFLICT_PATTERNS = [
      /bridge of (doubt|fear|worry)/i,
      /something.{0,20}(missing|lost|gone)/i,
      /doubt.{0,10}(crept|grew|whispered)/i,
      /mysterious.{0,10}(path|door|voice|shadow)/i,
      /quest to find/i,
      /had to prove/i,
      /faced a.{0,10}(challenge|obstacle|test)/i,
      /darkness.{0,10}(fell|crept|gathered)/i,
    ];
    for (let i = 0; i < seed.beats.length; i++) {
      const beat = seed.beats[i];
      if (typeof beat !== 'string') continue;
      for (const pattern of ABSTRACT_CONFLICT_PATTERNS) {
        if (pattern.test(beat)) {
          issues.push({ field: `beats[${i}]`, reason: 'abstract_conflict_in_occasion_theme' });
          break;
        }
      }
    }
  }

  // Narrative spine validation
  if (!seed.narrative_spine || seed.narrative_spine.trim().split(/\s+/).length < 5) {
    issues.push({ field: 'narrative_spine', reason: 'missing_spine' });
  }

  // Narrative coherence: detect slideshow beats (too many unrelated scenes)
  const SPINE_THEMES = new Set(['mothers_day', 'fathers_day', 'birthday_magic', 'birthday']);
  if (SPINE_THEMES.has(theme) && Array.isArray(seed.beats) && seed.beats.length >= 8) {
    const STOPWORDS = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
      'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'shall', 'can', 'this', 'that',
      'these', 'those', 'it', 'its', 'they', 'them', 'their', 'he', 'she',
      'his', 'her', 'we', 'our', 'you', 'your', 'i', 'me', 'my', 'not',
      'no', 'so', 'up', 'out', 'if', 'then', 'than', 'too', 'very', 'just',
      'about', 'into', 'over', 'after', 'before', 'between', 'through',
      'during', 'each', 'all', 'both', 'some', 'as', 'while', 'where',
      'when', 'how', 'what', 'who', 'which', 'there', 'here', 'also',
      'more', 'most', 'other', 'only', 'still', 'now', 'even',
      'mom', 'mama', 'mommy', 'dad', 'daddy', 'child', 'visible',
    ]);

    const extractKeywords = (text) => {
      if (typeof text !== 'string') return new Set();
      return new Set(
        text.toLowerCase()
          .replace(/[^a-z\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 2 && !STOPWORDS.has(w))
      );
    };

    let sceneBreaks = 0;
    for (let i = 1; i < seed.beats.length; i++) {
      const prevKeywords = extractKeywords(seed.beats[i - 1]);
      const currKeywords = extractKeywords(seed.beats[i]);
      let shared = 0;
      for (const word of currKeywords) {
        if (prevKeywords.has(word)) { shared++; break; }
      }
      if (shared === 0) sceneBreaks++;
    }

    if (sceneBreaks > 4) {
      issues.push({
        field: 'beats',
        reason: 'too_many_scenes',
        detail: `${sceneBreaks} scene breaks detected across ${seed.beats.length} beats (max 4). Beats should share locations/activities with their neighbors.`,
      });
    }
  }

  return { valid: issues.length === 0, issues };
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
  const result = { title, dedication, spreads };
  sanitizeAllStoryText(result);
  return result;
}

/**
 * Phase 1: Generate story text freely (no JSON mode).
 * Returns raw text output from the LLM.
 */
async function generateStoryText(childDetails, theme, customDetails, opts = {}) {
  const { costTracker, apiKeys, approvedTitle, v2Vars, additionalCoverCharacters, style_mode, techniques, narrativePatterns } = opts;
  const openaiKey = apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  const childAge = childDetails.age || childDetails.childAge || 5;
  const briefVars = v2Vars || {
    name: childDetails.name || childDetails.childName || 'the child',
    age: childAge,
    favorite_object: getAgeAppropriateFallbackObject(childAge),
    fear: 'the dark',
    setting: '',
  };
  // Fix 4D: Ensure gender is included in briefVars for pronoun enforcement
  briefVars.gender = briefVars.gender || childDetails.gender || childDetails.childGender || '';
  // Inject style_mode and techniques into briefVars for the writing brief
  if (style_mode) briefVars.style_mode = style_mode;
  if (techniques) briefVars.techniques = techniques;

  let systemPrompt = buildStoryWriterSystem(briefVars, theme, additionalCoverCharacters);

  // ── Inject prompt-level quality improvements (W1, W2, W4, W5, W6) ──
  // W1: Beat structure — BEFORE existing writing rules
  systemPrompt = BEAT_STRUCTURE + '\n\n' + systemPrompt;
  // W2: Theme-specific rules
  const themeRule = THEME_RULES[theme] || THEME_RULES[theme?.replace(/_/g, '')] || '';
  if (themeRule) {
    systemPrompt += '\n\n' + themeRule;
  }
  // W4: Dialogue minimum
  systemPrompt += '\n\n' + DIALOGUE_RULE;
  // W5: Age-aware vocabulary
  systemPrompt += '\n\n' + ageVocabularyRules(childDetails.childAge || childDetails.age);
  // W6: Rhythmic prose
  systemPrompt += '\n\n' + RHYTHM_RULE;

  // Narrative patterns (structural guides for the writer)
  const writerPatternBlock = formatPatternsForWriter(narrativePatterns);
  if (writerPatternBlock) {
    systemPrompt += '\n\n' + writerPatternBlock;
  }

  let userPrompt = STORY_WRITER_USER(childDetails, theme, customDetails, v2Vars, additionalCoverCharacters);

  // Allow/require the parent for parent-themed stories
  if (theme === 'mothers_day') {
    if (additionalCoverCharacters) {
      systemPrompt += `\n\n⚠️ MOTHER'S DAY OVERRIDE: Mom is a co-protagonist in this story and MUST appear in illustration prompts for at least 6 of 13 spreads. This overrides the "no family in illustrations" rule for Mom only. When writing scenes where Mom appears, describe her presence explicitly (her position, gesture, expression) so illustration prompts can include her. Describe Mom warmly and consistently. Other family members still follow the standard rule — text only, never illustrated.`;
    } else {
      systemPrompt += `\n\n⚠️ MOTHER'S DAY OVERRIDE — IMPLIED PRESENCE (FACE COMPLETELY HIDDEN): Mom is a co-protagonist and MUST appear in illustration prompts for at least 6 of 13 spreads. However, we have NO reference image for Mom. She is FEMALE (a woman). Her face must NEVER be shown in ANY illustration — no eyes, no mouth, no facial features.\n\nIn EVERY spread_image_prompt where Mom appears, you MUST explicitly describe a hidden-face pose. Examples:\n- "Mom's hands gently wrap around the child from behind"\n- "Mom kneels beside the child, her face just above the frame edge"\n- "We see Mom from behind, her arm around the child's shoulder"\n- "Mom's arm reaches in from the left side of the frame"\nNEVER write prompts like "Mom smiles at the child" or "Mom looks at the child lovingly" — these will cause the illustrator to draw her face. Her warmth comes through body language ONLY. Other family members — text only, never illustrated.`;
    }
  } else if (theme === 'fathers_day') {
    if (additionalCoverCharacters) {
      systemPrompt += `\n\n⚠️ FATHER'S DAY OVERRIDE: Dad is a co-protagonist in this story and MUST appear in illustration prompts for at least 6 of 13 spreads. This overrides the "no family in illustrations" rule for Dad only. When writing scenes where Dad appears, describe his presence explicitly (his position, gesture, expression) so illustration prompts can include him. Describe Dad warmly and consistently. Other family members still follow the standard rule — text only, never illustrated.`;
    } else {
      systemPrompt += `\n\n⚠️ FATHER'S DAY OVERRIDE — IMPLIED PRESENCE (FACE COMPLETELY HIDDEN): Dad is a co-protagonist and MUST appear in illustration prompts for at least 6 of 13 spreads. However, we have NO reference image for Dad. He is MALE (a man). His face must NEVER be shown in ANY illustration — no eyes, no mouth, no facial features.\n\nIn EVERY spread_image_prompt where Dad appears, you MUST explicitly describe a hidden-face pose. Examples:\n- "Dad's strong hands lift the child onto his shoulders, seen from behind"\n- "Dad kneels beside the child, his face just above the frame edge"\n- "We see Dad from behind, his arm around the child's shoulder"\n- "Dad's arm reaches in from the left side of the frame"\nNEVER write prompts like "Dad smiles at the child" or "Dad looks at the child proudly" — these will cause the illustrator to draw his face. His warmth comes through body language ONLY. Other family members — text only, never illustrated.`;
    }
  }

  // Override the "no family in illustrations" rule when secondary characters are detected
  if (additionalCoverCharacters) {
    systemPrompt += `\n\n⚠️ COVER PHOTO OVERRIDE: The uploaded photo contains a secondary person (e.g. a parent/family member). This overrides the "no family in illustrations" rule for THIS book only. The following secondary character IS allowed in illustrations and must appear consistently:\n${additionalCoverCharacters}\nWrite their description into illustration prompts whenever they appear naturally in the scene.`;
  }

  if (approvedTitle) {
    userPrompt += `\n\nIMPORTANT: The book title has already been chosen: "${approvedTitle}". You MUST use this exact title.`;
  }

  console.log(`[storyPlanner] Phase 1: Generating story text (free-form, no JSON)...`);
  const start = Date.now();

  const textTemperature = v2Vars?.retryTemperature || 0.85;
  const response = await callLLM(systemPrompt, userPrompt, {
    openaiApiKey: openaiKey,
    maxTokens: 4000,
    temperature: textTemperature,
    jsonMode: false,
    costTracker,
  });

  const ms = Date.now() - start;
  console.log(`[storyPlanner] Phase 1 complete in ${ms}ms (${response.model}, temp=${textTemperature}, ${response.outputTokens} tokens)`);

  return response.text;
}

/**
 * Phase 2: Convert story text into structured JSON with illustration prompts.
 * Uses JSON mode for reliable parsing.
 */
async function structureStoryPlan(storyText, childDetails, opts = {}) {
  const { costTracker, apiKeys, v2Vars, referenceContext, theme } = opts;
  const openaiKey = apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  const briefVars = {
    name: childDetails.name || childDetails.childName || 'the child',
    age: childDetails.age || childDetails.childAge || 5,
    theme,
    favorite_object: v2Vars?.favorite_object || getAgeAppropriateFallbackObject(childDetails.age || childDetails.childAge),
  };

  const systemPrompt = buildStoryStructurerSystem(briefVars);
  const beats = opts.beats || (v2Vars?.beats && Array.isArray(v2Vars.beats) ? v2Vars.beats : null);
  const userPrompt = STORY_STRUCTURER_USER(storyText, childDetails, v2Vars, beats, referenceContext);

  console.log(`[storyPlanner] Phase 2: Structuring into JSON with illustration prompts...`);
  const start = Date.now();

  const response = await callLLM(systemPrompt, userPrompt, {
    openaiApiKey: openaiKey,
    maxTokens: 14000,
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
    // Existing
    /\b(?:she|he|they|the child|the boy|the girl)\s+(?:felt|was|seemed|looked|appeared)\s+(?:happy|sad|scared|afraid|brave|excited|angry|worried|nervous|lonely|proud|surprised|relieved|safe|calm|tired)/i,
    /\b(?:realized|understood|knew) that\b/i,
    /\bit (?:was(?:n't| not)|wasn't) scary\b/i,
    // New patterns
    /\b(?:she|he|they)\s+(?:was|were)\s+(?:happy|excited|sad|afraid|brave|nervous|worried|relieved|calm)\s+to\b/i,
    /\bcould feel\b/i,
    /\bfelt a wave\b/i,
    /\bknew everything was\b/i,
    /\brelieved feeling\b/i,
    /\ba feeling of (?:relief|joy|happiness|sadness|fear|excitement|calm)\b/i,
    /\bwas filled with (?:joy|happiness|relief|fear|excitement)\b/i,
    /\bfinally (?:felt|was|understood|knew)\b/i,
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

  const visualBreathingSpreads = spreads.filter((s) => !s.left?.text || !s.right?.text).length;
  if (spreads.length > 0 && visualBreathingSpreads < Math.max(2, Math.ceil(spreads.length * 0.25))) {
    issues.push({
      type: 'visual_spreads',
      message: `Only ${visualBreathingSpreads} spreads leave one side visual. Picture books need more visual breathing room.`,
    });
  }

  // All spreads must have text — no visual-only spreads allowed
  const emptySpread = spreads.find(s => !s.left?.text && !s.right?.text);
  if (emptySpread) {
    issues.push({ spread: emptySpread.spread, type: 'empty_spread', message: `Spread ${emptySpread.spread} has no text on either page — all spreads must have text` });
  }

  if (spreads.length < 10) {
    issues.push({ type: 'spread_count', message: `Only ${spreads.length} spreads (need 10-13)` });
  }

  // Check spread 1 for opening cliches
  const firstSpread = spreads.find(s => s.spread === 1);
  if (firstSpread) {
    const openingText = [firstSpread.left?.text, firstSpread.right?.text].filter(Boolean).join(' ');
    const OPENING_CLICHE_PATTERNS = [
      /^one\s+(?:day|morning|evening|night|sunny|beautiful)/i,
      /^once\s+upon\s+a\s+time/i,
      /opened\s+(?:her|his|their)\s+eyes/i,
      /^it\s+was\s+a\s+(?:beautiful|sunny|warm|cold|rainy|quiet|special)/i,
      /\bwoke\s+up\b/i,
      /^the\s+(?:morning|day|sun)\s+(?:was|began|started|came)/i,
      /^the\s+day\s+(?:had|finally)/i,
    ];
    for (const pattern of OPENING_CLICHE_PATTERNS) {
      if (pattern.test(openingText)) {
        issues.push({ spread: 1, type: 'opening_cliche', message: `Generic opening: "${openingText.slice(0, 80)}..."` });
        break;
      }
    }
  }

  // Cross-spread phrase repetition detection
  const phraseMap = new Map();
  for (const s of spreads) {
    const allText = [s.left?.text, s.right?.text].filter(Boolean).join(' ').toLowerCase();
    const words = allText.split(/\s+/).filter(Boolean);
    const seenInThisSpread = new Set();
    for (let len = 3; len <= 5; len++) {
      for (let i = 0; i <= words.length - len; i++) {
        const phrase = words.slice(i, i + len).join(' ');
        if (seenInThisSpread.has(phrase)) continue;
        seenInThisSpread.add(phrase);
        if (!phraseMap.has(phrase)) phraseMap.set(phrase, []);
        phraseMap.get(phrase).push(s.spread);
      }
    }
  }
  for (const [phrase, spreadNums] of phraseMap) {
    if (spreadNums.length >= 3) {
      issues.push({
        type: 'phrase_repetition',
        message: `Phrase "${phrase}" repeats across ${spreadNums.length} spreads (${spreadNums.join(', ')})`,
      });
    }
  }

  const blocking = issues.filter(i => ['emotion_telling', 'spread_count', 'empty_spread'].includes(i.type));
  return { valid: blocking.length === 0, issues };
}

/**
 * Single-call fallback — the original pipeline for when two-phase fails or for early readers.
 */
async function planStorySingleCall(childDetails, theme, bookFormat, customDetails, opts = {}) {
  const { costTracker, approvedTitle, apiKeys, v2Vars, additionalCoverCharacters } = opts;
  const isPictureBook = bookFormat === 'picture_book';
  const childAge = childDetails.age || childDetails.childAge || 5;

  let systemPrompt, userPrompt;

  if (isPictureBook) {
    const briefVars = v2Vars || {
      name: childDetails.name || childDetails.childName || 'the child',
      age: childAge,
      favorite_object: getAgeAppropriateFallbackObject(childAge),
      fear: 'the dark',
      setting: '',
      dedication: `For ${childDetails.name || childDetails.childName || 'the child'}`,
    };
    systemPrompt = buildStoryPlannerSystem(briefVars, additionalCoverCharacters, theme);
    userPrompt = pbUserPrompt(childDetails, theme, customDetails, v2Vars, additionalCoverCharacters);
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
    maxTokens: 14000,
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
/**
 * Fix unescaped control characters inside JSON string values.
 * Walks the string tracking whether we're inside a quoted value and escapes
 * literal newlines / tabs / carriage returns that the LLM left unescaped.
 */
function sanitizeJsonStrings(raw) {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) { out += ch; escape = false; continue; }
    if (ch === '\\' && inString) { out += ch; escape = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString) {
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
    }
    out += ch;
  }
  return out;
}

/**
 * Strip em-dashes and en-dashes from story text, replacing with
 * periods or commas so printed children's books use simple punctuation.
 */
function sanitizeStoryText(text) {
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

/**
 * Apply sanitizeStoryText to all text fields in a parsed story plan.
 */
function sanitizeAllStoryText(plan) {
  if (!plan) return plan;
  if (plan.title) plan.title = sanitizeStoryText(plan.title);
  if (Array.isArray(plan.entries)) {
    for (const entry of plan.entries) {
      if (entry.left?.text) entry.left.text = sanitizeStoryText(entry.left.text);
      if (entry.right?.text) entry.right.text = sanitizeStoryText(entry.right.text);
      if (entry.text) entry.text = sanitizeStoryText(entry.text);
    }
  }
  if (Array.isArray(plan.spreads)) {
    for (const spread of plan.spreads) {
      if (spread.left) spread.left = sanitizeStoryText(spread.left);
      if (spread.right) spread.right = sanitizeStoryText(spread.right);
    }
  }
  return plan;
}

function parseJsonPlan(content, finishReason) {
  if (!content) {
    throw new Error(`Empty response from story planner (finish_reason: ${finishReason})`);
  }

  content = content.replace(/\\'/g, "'");
  content = content.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');

  const attempts = [
    // 1. Direct parse
    () => JSON.parse(content),
    // 2. Strip markdown fences then parse
    () => JSON.parse(content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim()),
    // 3. Sanitize unescaped control chars inside strings then parse
    () => JSON.parse(sanitizeJsonStrings(content)),
    // 4. Extract balanced JSON block and sanitize
    () => {
      const firstBrace = content.indexOf('{');
      if (firstBrace === -1) throw new Error('no opening brace');
      let depth = 0, inStr = false, esc = false, endIdx = -1;
      for (let ci = firstBrace; ci < content.length; ci++) {
        const ch = content[ci];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        if (ch === '}') { depth--; if (depth === 0) { endIdx = ci; break; } }
      }
      if (endIdx === -1) throw new Error('no balanced close');
      return JSON.parse(sanitizeJsonStrings(content.slice(firstBrace, endIdx + 1)));
    },
  ];

  for (let i = 0; i < attempts.length; i++) {
    try {
      const parsed = attempts[i]();
      if (i > 0) console.warn(`[storyPlanner] JSON parsed on attempt ${i + 1}`);
      return parsed;
    } catch (_) { /* try next */ }
  }

  // Last resort for truncated output
  if (finishReason === 'MAX_TOKENS') {
    const repaired = repairTruncatedJson(content);
    if (repaired) {
      console.warn(`[storyPlanner] Salvaged truncated JSON after repair`);
      return repaired;
    }
  }

  // Log enough of the raw output to diagnose the failure
  const preview = content.slice(0, 500);
  const tail = content.slice(-200);
  console.error(`[storyPlanner] JSON parse failed. finish_reason=${finishReason}. Length=${content.length}`);
  console.error(`[storyPlanner] Output start: ${preview}`);
  console.error(`[storyPlanner] Output end: ${tail}`);

  // Always try repair regardless of finishReason (GPT returns 'stop' even on truncation sometimes)
  const repaired = repairTruncatedJson(content);
  if (repaired) {
    console.warn(`[storyPlanner] Salvaged JSON via repair (finish_reason=${finishReason})`);
    return repaired;
  }

  throw new Error(`Failed to parse story plan JSON after all repair attempts`);
}

/**
 * Normalize a parsed JSON plan into the canonical entry structure.
 * @param {object} parsed - raw parsed JSON from LLM
 * @param {object} childDetails
 * @param {object} opts - { approvedTitle, v2Vars }
 * @returns {{ title: string, entries: Array<object>, characterOutfit?: string, characterDescription?: string, recurringElement?: string, keyObjects?: string }}
 */
function normalizePlan(parsed, childDetails, opts = {}) {
  const { approvedTitle, v2Vars, theme } = opts;

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
    console.warn(`[storyPlanner] Only ${spreads.length} spreads — expected 10-13`);
  }
  if (spreads.length > 13) {
    console.warn(`[storyPlanner] ${spreads.length} spreads — truncating to 13`);
    spreads = spreads.slice(0, 13).map((s, i) => ({ ...s, spread: i + 1 }));
  }

  const dedEntry = entries.find(e => e.type === 'dedication_page');
  const childName = childDetails.name || childDetails.childName || 'the child';
  const dedText = dedEntry?.text || v2Vars?.dedication || `For ${childName}`;
  const subtitlePrefix = (theme && THEME_SUBTITLES[theme]) || 'A bedtime story';
  const subtitle = `${subtitlePrefix} for ${childName}`;

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
  if (parsed.secondaryCharacterDescription) plan.secondaryCharacterDescription = parsed.secondaryCharacterDescription;
  if (parsed.parentOutfit) plan.parentOutfit = parsed.parentOutfit;

  console.log(`[storyPlanner] Plan complete: "${title}" with ${spreads.length} spreads, ${entries.length} total entries`);
  if (plan.characterOutfit) console.log(`[storyPlanner] Character outfit: ${plan.characterOutfit}`);
  if (plan.parentOutfit) console.log(`[storyPlanner] Parent outfit: ${plan.parentOutfit}`);

  // Strip em-dashes and en-dashes from all story text for clean children's book typography
  sanitizeAllStoryText(plan);

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

  // Enrich custom details + select narrative patterns in parallel
  const interests = (childDetails.interests || childDetails.childInterests || []).filter(Boolean);
  const childAge = childDetails.age || childDetails.childAge || 5;
  const [enrichedCustomDetails, narrativePatterns] = await Promise.all([
    enrichCustomDetails(
      customDetails,
      childDetails.name || childDetails.childName,
      childAge,
      interests
    ),
    selectNarrativePatterns({
      story_type: bookFormat,
      age: childAge,
      goal: v2Vars?.emotional_core || theme,
      setting: v2Vars?.setting || '',
      tone: v2Vars?.style_mode || 'playful',
    }, { costTracker, apiKeys: opts.apiKeys }).catch(err => {
      console.warn(`[storyPlanner] Narrative pattern selection failed — continuing without: ${err.message}`);
      return null;
    }),
  ]);

  console.log(`[storyPlanner] Planning ${bookFormat} story for ${childDetails.name}, theme: ${theme}`);

  const optsWithTheme = { ...opts, theme };

  if (!isPictureBook) {
    const parsed = await planStorySingleCall(childDetails, theme, bookFormat, enrichedCustomDetails, opts);
    const plan = normalizePlan(parsed, childDetails, optsWithTheme);
    // Carry style_mode and techniques from v2Vars
    if (v2Vars?.style_mode) plan._styleMode = v2Vars.style_mode;
    if (v2Vars?.techniques) plan._techniques = v2Vars.techniques;
    if (narrativePatterns) plan._narrativePatterns = narrativePatterns;
    return plan;
  }

  // ── Two-phase pipeline for picture books ──
  const pipelineStart = Date.now();

  try {
    // Phase 1: Generate story text freely (pass style_mode + techniques + narrative patterns)
    let storyText = await generateStoryText(childDetails, theme, enrichedCustomDetails, {
      ...opts,
      style_mode: v2Vars?.style_mode,
      techniques: v2Vars?.techniques,
      narrativePatterns,
    });

    // Fix 4C: Post-generation pronoun check and fix
    const gender = childDetails.gender || childDetails.childGender;
    if (gender && gender !== 'neutral' && gender !== 'not specified') {
      const pronounCheck = checkPronounConsistency(storyText, gender);
      if (!pronounCheck.valid) {
        console.log(`[storyPlanner] Pronoun inconsistency detected: ${pronounCheck.issues.length} issues — applying simpleReplace`);
        storyText = simpleReplace(storyText, gender);
      }
    }

    // Try to parse the free-form text
    const parsedText = parseStoryText(storyText);
    if (!parsedText) {
      console.warn(`[storyPlanner] Free-form text parse failed — falling back to single-call`);
      throw new Error('Text parse failed');
    }
    console.log(`[storyPlanner] Parsed ${parsedText.spreads.length} spreads from free-form text, title: "${parsedText.title}"`);

    // Phase 2: Structure into JSON with illustration prompts (with 1 retry on parse failure)
    const referenceContext = { interests, enrichedCustomDetails };
    let parsed;
    const phase2Opts = { ...opts, theme, beats: v2Vars?.beats, referenceContext };
    try {
      const jsonContent = await structureStoryPlan(storyText, childDetails, phase2Opts);
      parsed = parseJsonPlan(jsonContent);
    } catch (phase2Err) {
      console.warn(`[storyPlanner] Phase 2 JSON parse failed: ${phase2Err.message} — retrying Phase 2`);
      const retryJsonContent = await structureStoryPlan(storyText, childDetails, phase2Opts);
      parsed = parseJsonPlan(retryJsonContent); // let this throw if it fails again
    }

    // Override title if customer approved one
    if (approvedTitle) parsed.title = approvedTitle;

    const plan = normalizePlan(parsed, childDetails, optsWithTheme);

    // Fix 3A: Validate text presence — ensure spreads with text have illustration prompts
    const spreadsForTextCheck = plan.entries.filter(e => e.type === 'spread');
    for (const sp of spreadsForTextCheck) {
      const hasText = (sp.left?.text && sp.left.text.trim()) || (sp.right?.text && sp.right.text.trim());
      if (hasText && !sp.spread_image_prompt) {
        console.warn(`[storyPlanner] Spread ${sp.spread}: has text but no illustration prompt — text embedding may fail`);
      }
    }

    // Retry with single-call if spread count is too low
    const spreadCount = plan.entries.filter(e => e.type === 'spread').length;
    if (spreadCount < 10) {
      console.warn(`[storyPlanner] Only ${spreadCount} spreads from two-phase — retrying with single-call`);
      const retryParsed = await planStorySingleCall(childDetails, theme, bookFormat, enrichedCustomDetails, opts);
      return normalizePlan(retryParsed, childDetails, optsWithTheme);
    }

    // Validate the text quality programmatically
    const { config } = getAgeTier(childAge);
    const validation = validateStoryText(plan, config.maxWordsPerSpread);
    if (validation.issues.length > 0) {
      console.log(`[storyPlanner] Validation found ${validation.issues.length} issues:`);
      for (const issue of validation.issues) {
        console.log(`  - [${issue.type}] ${issue.spread ? `spread ${issue.spread}: ` : ''}${issue.message}`);
      }
    }
    // Attach validation issues for downstream critic passes
    plan._validationIssues = validation.issues;
    // Carry style_mode, techniques, and narrative patterns
    if (v2Vars?.style_mode) plan._styleMode = v2Vars.style_mode;
    if (v2Vars?.techniques) plan._techniques = v2Vars.techniques;
    if (narrativePatterns) plan._narrativePatterns = narrativePatterns;

    const totalMs = Date.now() - pipelineStart;
    console.log(`[storyPlanner] Two-phase pipeline complete in ${totalMs}ms`);
    return plan;

  } catch (twoPhaseErr) {
    console.warn(`[storyPlanner] Two-phase pipeline failed: ${twoPhaseErr.message} — falling back to single-call`);
    try {
      const parsed = await planStorySingleCall(childDetails, theme, bookFormat, enrichedCustomDetails, opts);
      const plan = normalizePlan(parsed, childDetails, optsWithTheme);
      if (narrativePatterns) plan._narrativePatterns = narrativePatterns;
      const totalMs = Date.now() - pipelineStart;
      console.log(`[storyPlanner] Fallback single-call complete in ${totalMs}ms`);
      return plan;
    } catch (singleCallErr) {
      // Last resort: retry single-call forcing Gemini (no OpenAI key passed)
      // Gemini handles long JSON output reliably and returns proper finishReason
      console.warn(`[storyPlanner] Single-call also failed: ${singleCallErr.message} — retrying with Gemini only`);
      const parsed = await planStorySingleCall(childDetails, theme, bookFormat, enrichedCustomDetails, {
        ...opts,
        apiKeys: null, // forces Gemini path
      });
      const plan = normalizePlan(parsed, childDetails, optsWithTheme);
      if (narrativePatterns) plan._narrativePatterns = narrativePatterns;
      const totalMs = Date.now() - pipelineStart;
      console.log(`[storyPlanner] Gemini-only fallback complete in ${totalMs}ms`);
      return plan;
    }
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

  if (escape) candidate += '\\';
  if (inString) candidate += '"';
  const suffix = ']'.repeat(Math.max(0, openBrackets)) + '}'.repeat(Math.max(0, openBraces));
  try {
    return JSON.parse(sanitizeJsonStrings(candidate + suffix));
  } catch {
    return null;
  }
}

// ── Age-Tier Preamble for Critics ──

const TIER_2_BANNED_WORDS = 'glistening, magnificent, whimsical, ethereal, luminous, iridescent, cascade, eloquent, radiant, resplendent, enchanting, mesmerizing, serene, tranquil, mystical, majestic, celestial, melodic, beckon, vespertine';

function buildAgeTierPreamble(tier, config, age) {
  let preamble = `\n\n─────────────────────────────────────────
AGE TIER CONSTRAINTS (CRITICAL — must respect these in ALL rewrites)
─────────────────────────────────────────
Age: ${age} | Tier: ${tier} (${config.label})
Vocabulary: ${config.vocabulary}
Max words per spread: ${config.maxWordsPerSpread || 30}
Sound words rule: ${config.soundWordsRule}`;

  if (config.maxWordsPerSentence) {
    preamble += `\nMax words per sentence: ${config.maxWordsPerSentence}`;
  }

  if (tier <= 2) {
    preamble += `\n
MUSICAL SIMPLICITY (Tier ${tier}):
- Simple vocabulary, but arranged in RHYMING COUPLETS that sing when read aloud.
- Do NOT write flat prose fragments ("She walked. She saw. She sat.") — that is primer-style, not picture-book quality.
- Do NOT upgrade to literary vocabulary ("glistening", "ethereal"). Simple words, beautiful rhymes.
- Vivid verbs are encouraged: whispered, tumbled, crept, wobbled, tiptoed — children know and love these.
- Test: does each spread SING when read aloud? If not, rewrite it with rhythm and rhyme.
- BANNED WORDS (too literary): ${TIER_2_BANNED_WORDS}`;
  }

  return preamble;
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

2. Language Quality & Musicality
- Any generic phrases?
- Any replaceable sentences?
- Are there rhyming couplets, near-rhymes, or internal rhymes woven throughout?
  The story should have a musical, rhythmic quality — think Dr. Seuss or Julia Donaldson.
  Use AABB rhyme schemes or rhyming couplets where they flow naturally.
  Every spread should aim for at least one rhyming pair.
  Where a natural rhyme opportunity exists, use it. Where it would feel forced, use a near-rhyme instead.
  Prioritize natural-sounding rhymes over forced ones.

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
- Does the ending match the theme's energy? Adventure/birthday/science/space books must end WARM and JOYFUL — not sleepy, not hushed. Friendship/nature ends with quiet joy. Only bedtime books end softly. If a non-bedtime book ends with the child going to sleep or feeling tired, flag it.

8. Memorable Line
- Is there at least one line in this story that a parent would want to repeat to their child outside of the book?
- A line that could be a reassurance, a small philosophy, or a fragment of lullaby?
- Score 1: No such line exists
- Score 5: A line exists but is generic ("everything will be okay")
- Score 8-10: The line is specific to THIS story, poetic, and feels like it belongs to this child

9. Verb Power
- Are verbs strong and specific? ("darted" not "walked quickly", "whispered" not "said quietly")
- Any weak verb + adverb combo is a penalty
- Score 8+: Every verb carries action AND emotion in a single word

10. Emotional Restraint
- Does the story trust the reader to feel the emotion?
- Are emotional moments understated rather than amplified?
- Penalty for: "a tear rolled down her cheek", "she had never been so happy", explaining emotions after showing them
- The most powerful moments use the FEWEST words

SCORING DISCIPLINE (CRITICAL):
Do NOT give any category a score above 7 if ANY of these are present in the story:
- A phrase with "felt", "was scared", "was happy", "seemed excited" (emotion telling)
- A generic filler word: "very", "nice", "special", "magical", "wonderful", "beautiful" used as a descriptor
- A sentence that could appear, unchanged, in a different children's book about a different child

If you find any of the above, cap that category's score at 6, regardless of other quality.

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
- Weak verb + adverb combos (e.g. "walked slowly", "said quietly", "ran fast") — replace with a single strong verb ("crept", "whispered", "bolted")
- Emotional over-explanation — if the emotion is already clear from context, the extra sentence weakens it. Trust the reader.
- Duplicate consecutive words (e.g. "round round", "the the", "and and") — any word repeated back-to-back is an error
- Single gifter appearing while co-gifter is absent: if the book is from multiple people (e.g., "Mom and Dad") and one is mentioned but the other is not

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
- Fix duplicate consecutive words immediately — rewrite the phrase so the word appears only once, preserving the meaning
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
    "ending_quality": <1-10>,
    "memorable_line": <1-10>,
    "verb_power": <1-10>,
    "emotional_restraint": <1-10>
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
  const { costTracker, apiKeys, theme, validationIssues, childAge } = opts;
  const openaiKey = apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  // Build a compact representation of just the text to rewrite
  const spreads = storyPlan.entries.filter(e => e.type === 'spread');
  const textMap = spreads.map(s => ({
    spread: s.spread,
    left: s.left?.text || null,
    right: s.right?.text || null,
  }));

  let systemPrompt = SELF_CRITIC_SYSTEM;

  // Inject age-tier constraints so the critic respects age-appropriate language
  const { tier: ageTier, config: ageConfig } = getAgeTier(childAge || 5);
  systemPrompt += buildAgeTierPreamble(ageTier, ageConfig, childAge || 5);

  if (theme === 'birthday') {
    systemPrompt += `\n\n⚠️ BIRTHDAY THEME EXCEPTION:\nThis is a BIRTHDAY story. The ending rules are DIFFERENT:\n- Do NOT soften the ending into a whisper or sleepy tone.\n- The final spread (spread 13) is the birthday cake/candles moment — the emotional climax the whole story earned.\n- The ending should feel warm, joyful, and celebratory — not quiet.\n- "Ending Quality" score should reward a triumphant, emotionally resonant birthday ending.\n- The ENDING UPGRADE rule does NOT apply — do not make the ending softer or more poetic. Make it warmer and more joyful if needed.`;
  }

  // Build user prompt with optional validation warnings
  let validationWarnings = '';
  if (validationIssues && validationIssues.length > 0) {
    const warnings = validationIssues.map(i => {
      if (i.type === 'opening_cliche') return `⚠️ SPREAD 1 HAS A GENERIC OPENING. The first spread MUST be rewritten to drop the reader into a specific moment — not "one day" or "woke up". This is the highest priority fix.`;
      if (i.type === 'word_count') return `⚠️ Spread ${i.spread}: ${i.message}. CUT this spread ruthlessly — trust the illustration.`;
      if (i.type === 'emotion_telling') return `⚠️ Spread ${i.spread}: emotion telling detected (${i.message}). Replace with action or sensation.`;
      if (i.type === 'critic_feedback') return `⚠️ CRITIC FEEDBACK: ${i.message}`;
      if (i.type === 'weak_spread') return `⚠️ Spread ${i.spread}: ${i.message}`;
      return null;
    }).filter(Boolean);
    if (warnings.length > 0) {
      validationWarnings = `\n\nPRE-IDENTIFIED ISSUES (fix these FIRST):\n${warnings.join('\n')}`;
    }
  }

  const userPrompt = `Here is the story to evaluate and improve (${spreads.length} spreads):\n\n${JSON.stringify(textMap)}${validationWarnings}`;

  console.log(`[storyPlanner] Starting self-critic + rewrite pass (${spreads.length} spreads, theme: ${theme || 'default'})...`);
  const polishStart = Date.now();

  const response = await callLLM(systemPrompt, userPrompt, {
    openaiApiKey: openaiKey,
    maxTokens: 10000,
    temperature: 0.6,
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

  const polished = {
    ...storyPlan,
    entries: updatedEntries,
    _criticScores: result.scores || null,
    _criticIssueCount: (result.issues || []).length,
  };

  // Sanitize em-dashes/en-dashes that the critic may have reintroduced
  sanitizeAllStoryText(polished);

  return polished;
}

// ── Rhythm & Simplicity Critic ──

function buildCombinedCriticSystem(childAge) {
  const { tier, config } = getAgeTier(childAge || 5);
  const isYoung = tier <= 2;

  // Age-conditional rhythm section
  const rhythmSection = isYoung
    ? `Read every line aloud in your head. Fix any line that:
- Stumbles, feels clunky, or is hard to say smoothly
- Has consecutive hard consonants creating tongue twisters
- Uses words a ${childAge || 3}-year-old would not know
- Sounds flat when spoken — but do NOT replace simple words with complex "textured" words. "Walked" is fine for this age. "Crept" may not be in their vocabulary.

Rules for rhythm fixes:
- Pattern over poetry. The best picture books for young children use REPETITION as their rhythm engine. Does the text rock like a lullaby or bounce like a game? If it just sits flat, rewrite.
- Alternate long and short sentences for natural breathing cadence.
- Keep fixes shorter or equal length to the original
- Every spread must have at least one short sentence (5 words or fewer) for contrast
- Use rhyming couplets or AABB rhyme schemes throughout — every spread should aim for at least one rhyming pair
- Near-rhymes and internal rhymes are welcome when exact rhymes would feel forced
- The story should have a musical, rhythmic quality — think Dr. Seuss or Julia Donaldson
- Every word must feel good in the MOUTH. Choose mouth-feel words over eye-pleasing words.
- Prioritize natural-sounding rhymes over forced ones
- Do NOT upgrade simple vocabulary to "sharper" or more literary alternatives`
    : `Read every line aloud in your head. Fix any line that:
- Stumbles, feels clunky, or is hard to say smoothly
- Has consecutive hard consonants creating tongue twisters
- Has words over 3 syllables (unless a name or meaningful invented word)
- Contains a forced or strained rhyme that bends the meaning
- Sounds flat when spoken — prefer words with texture and energy ("crept" over "walked", "pressed" over "put")

Rules for rhythm fixes:
- Keep fixes shorter or equal length to the original
- Vary sentence rhythm intentionally: a long image sentence followed by a 3-word punch. Prose should breathe.
- Every spread must have at least one short sentence (5 words or fewer) for contrast
- Use rhyming couplets and AABB rhyme schemes where they flow naturally — aim for at least one rhyming pair per spread
- Near-rhymes and internal rhymes are always better than strained end-rhymes
- The story should have a musical, rhythmic quality — think Dr. Seuss or Julia Donaldson
- Prioritize natural-sounding rhymes over forced ones — if a rhyme feels forced, use a near-rhyme instead`;

  // Age-conditional memorable line exemplar
  const memorableLineExemplar = isYoung
    ? 'A memorable line uses small words to say big things: "The moon hid. Then it came back." or "She held Momo tight. Two ears. One heart."'
    : 'A memorable line is NOT a wise statement — it\'s a perfectly observed image or feeling: "The dark had a sound now. Not a growl. A hum."';

  // Age-conditional language quality section
  const languageQuality = isYoung
    ? `- Replace any generic filler words: "very", "nice", "special", "magical", "wonderful", "beautiful" used as descriptors
- Replace any emotion-telling: "she felt scared", "he was happy" — show through action/sensation
- Do NOT replace simple words with "sharper" literary alternatives. "Walked" is fine. "Crept" may not be in a ${childAge || 3}-year-old's vocabulary.
- Only reduce or maintain word count — never increase
- BANNED WORDS: ${TIER_2_BANNED_WORDS}`
    : `- Replace any generic filler words: "very", "nice", "special", "magical", "wonderful", "beautiful" used as descriptors
- Replace any emotion-telling: "she felt scared", "he was happy" — show through action/sensation
- Sharpen one word per spread if a more specific/sensory word fits better
- Only reduce or maintain word count — never increase`;

  // Age-conditional humor section
  let humorSection = `Check for at least 2 genuinely funny or delightful moments in the story (spreads 2-10).
Not token jokes — real humor that a child would laugh at and a parent would smile at:
- Does the child say or do something unexpected and funny?
- Is there a running gag, a recurring absurd detail, or a creature/object with personality?
- Is there at least one moment of comic timing (setup then surprise)?
If humor is weak or missing, look for natural places to add it: a creature doing something absurd, the child's favorite object misbehaving, a deadpan observation. Humor makes tender moments land harder — it's not separate from emotion, it's fuel for it.
ONOMATOPOEIA LIMIT: LIMIT onomatopoeia to at most 1-2 per spread across the entire story. Do NOT overuse sound words (BANG, WHOOSH, CRASH, SPLAT, etc.). Describe actions through vivid imagery and movement rather than sound effects. Avoid excessive references to sounds — show, don't tell through noise.`;

  if (tier >= 4) {
    humorSection += '\nIMPORTANT: Do NOT add onomatopoeia or sound words. At this age (9-12) they feel juvenile and break the literary voice. Describe sounds with prose instead.';
  } else if (tier === 3) {
    humorSection += '\nSOUND WORDS: Maximum 1 across the entire story. Do not add any if one already exists. Never decorative.';
  }

  return `You are a world-class children's book editor. You review the story in ONE pass and fix everything at once.

Your job covers six areas. Evaluate ALL of them, then produce ONE set of improved spreads.

─────────────────────────────────────────
1. RHYTHM & READ-ALOUD (highest priority)
─────────────────────────────────────────
${rhythmSection}

─────────────────────────────────────────
2. EMOTIONAL ARC
─────────────────────────────────────────
Check:
- ESCALATION: Each spread slightly increases curiosity, movement, or wonder through the middle
- DOUBT MOMENT: There is a clear moment of uncertainty or tension in spreads 5–8
- ENDING: The final 2 spreads feel emotionally resolved — energy matches the theme

Fix weak spreads. Do NOT add new characters, events, or settings.

─────────────────────────────────────────
3. MEMORABLE LINE
─────────────────────────────────────────
Ensure at least ONE line exists that a parent would want to repeat to their child outside the book.
It should be specific to THIS child and THIS story — not generic.
If no such line exists, create one naturally within the existing story structure.
${memorableLineExemplar}

─────────────────────────────────────────
4. LANGUAGE QUALITY
─────────────────────────────────────────
${languageQuality}

─────────────────────────────────────────
5. HUMOR & DELIGHT
─────────────────────────────────────────
${humorSection}

─────────────────────────────────────────
6. ANTI-KITSCHY CHECK
─────────────────────────────────────────
Flag and fix any lines that feel like greeting cards, motivational posters, or generic sentiment:
- "The real treasure was..." / "Love is the strongest..." / "You are special just the way you are" / "With love, anything is possible" / "The magic was inside them all along"
- Any ending where the character announces what they learned or explains the story's moral
- Any vague emotional summary: "and the child felt warm and happy and loved"
- Any line that could appear in ANY children's book — replace with something only THIS story could say
Replace kitschy lines with specific, concrete images that earn the same emotion: "She pressed her nose against the window. The stars were still there." beats "She felt grateful for the beautiful night."

DETAIL INTEGRATION CHECK:
If the story includes personal details (child's interests, favorite foods, real people, real places), check:
- Do the details feel like natural parts of the story, or do they feel inserted/shoehorned?
- BAD: "Kyleigh loved rockets, so she put rockets on everything." (detail as label, not story element)
- GOOD: "She squinted at the sky and counted three, four, five — 'That one's a booster,' she whispered." (detail as character behavior)
- If a detail feels forced, either rewrite the scene so the detail emerges from the child's ACTIONS and OBSERVATIONS, or move it to a scene where it fits more naturally.

─────────────────────────────────────────
7. VERB POWER & EMOTIONAL RESTRAINT
─────────────────────────────────────────
VERB POWER: Scan every sentence for weak verb + adverb combos. Replace with a single strong verb:
- "walked slowly" → "crept" / "said loudly" → "bellowed" / "ran fast" → "bolted"

EMOTIONAL RESTRAINT: Trust the reader to feel the emotion. Do NOT amplify or explain.
- After a sad moment, do NOT add "and a tear rolled down her cheek." The situation is enough.
- After a triumph, do NOT add "she had never been so happy." Show the action.
- The most powerful emotional moments use the FEWEST words.
- When in doubt, CUT the emotional sentence. If the emotion is clear from context, the extra sentence weakens it.
UNDERSTATEMENT > OVERSTATEMENT. Always.

─────────────────────────────────────────
8. CROSS-SPREAD REPETITION (CRITICAL)
─────────────────────────────────────────
Read ALL spreads together. Flag any of these:
- The same phrase (3+ words) appearing in 3 or more different spreads (excluding the intentional repeated/evolving phrase from the story seed)
- The same sentence structure repeating on consecutive spreads (e.g. "She [verbed] the [noun]. Then she [verbed]." appearing on spreads 4, 5, and 6)
- The same descriptive pattern used for different moments (e.g. "one step, two step" used for walking, climbing, AND dancing)
- Overuse of any single adjective or verb across the story (same word on 4+ spreads)

Repetitive phrasing makes the story feel mechanical and AI-generated. Each spread must use FRESH language. If a phrase repeats, rewrite it with a completely different image or structure.

Exception: The story's intentional repeated phrase (from the seed) MAY appear 2-4 times — this is deliberate and should evolve in meaning. Everything else must be unique.

─────────────────────────────────────────
RULES FOR ALL REWRITES
─────────────────────────────────────────
- Rewrite ONLY what genuinely needs it — if a line already works, leave it exactly as-is
- Do NOT change: plot, structure, characters, spread count, left/right assignments, null pages
- Quality bar: only return a rewrite if it is clearly better than the original
- The ending (spreads 12–13) must feel emotionally resolved — the child is changed by the journey. For bedtime/friendship books: soft and settling. For adventure/science/space/nature/school/fantasy/underwater books: triumphant stillness, NOT a bedroom scene. Do NOT end non-bedtime books with the child going to sleep.

Return JSON:
{
  "scores": {
    "rhythm": <1-10>,
    "emotional_arc": <1-10>,
    "memorable_line": <1-10>,
    "language_quality": <1-10>,
    "humor": <1-10>,
    "anti_kitschy": <1-10>
  },
  "issues": [
    { "spread": 1, "area": "rhythm|arc|memorable|language|humor|kitschy", "line": "exact quote", "reason": "brief description" }
  ],
  "improved_spreads": [
    { "spread": 1, "left": "...", "right": "..." }
  ]
}

- scores: Rate the story AFTER your improvements on each of your 6 areas (1-10). Be strict — score 7+ only if genuinely strong.
- Return ALL spreads in improved_spreads (unchanged spreads returned as-is)
- If left or right was null, keep it null
- issues array may be empty if the story is already strong`;
}

function applyImprovedSpreads(storyPlan, improvedSpreads) {
  const spreads = storyPlan.entries.filter((entry) => entry.type === 'spread');
  if (!Array.isArray(improvedSpreads)) return storyPlan;
  if (improvedSpreads.length !== spreads.length) {
    console.warn(`[storyPlanner] Critic returned ${improvedSpreads.length} spreads, expected ${spreads.length} — using original text`);
    return storyPlan;
  }

  const updatedEntries = storyPlan.entries.map((entry) => {
    if (entry.type !== 'spread') return entry;
    const match = improvedSpreads.find((spread) => spread.spread === entry.spread);
    if (!match) return entry;

    const updated = { ...entry };
    if (entry.left && Object.prototype.hasOwnProperty.call(match, 'left')) {
      updated.left = { ...entry.left, text: match.left };
    }
    if (entry.right && Object.prototype.hasOwnProperty.call(match, 'right')) {
      updated.right = { ...entry.right, text: match.right };
    }
    return updated;
  });

  return {
    ...storyPlan,
    entries: updatedEntries,
  };
}

/**
 * Combined critic — rhythm, emotional arc, memorable line, language quality in one pass.
 * Replaces the three separate rhythm/arc/polish critics.
 */
async function combinedCritic(storyPlan, opts = {}) {
  const { costTracker, apiKeys, theme, childAge } = opts;
  const openaiKey = apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  const spreads = storyPlan.entries.filter(e => e.type === 'spread');
  const textMap = spreads.map(s => ({
    spread: s.spread,
    left: s.left?.text || null,
    right: s.right?.text || null,
  }));

  let systemPrompt = buildCombinedCriticSystem(childAge);
  if (theme === 'birthday') {
    systemPrompt += `\n\n⚠️ BIRTHDAY THEME EXCEPTION:\nThis is a BIRTHDAY story. The ending rules are DIFFERENT:\n- The rule "spreads 12-13 must feel like settling into sleep — soft, not triumphant" does NOT apply.\n- Spread 12 should be a held-breath moment — silent anticipation, the room hushing before the cake.\n- Spread 13 is the birthday cake/candles climax — warm, joyful, celebratory. This is the emotional payoff the whole story earned.\n- Do NOT soften or quiet the ending. Preserve its warmth and joy.\n- The emotional arc should PEAK at spread 13, not wind down.`;
  }

  console.log(`[storyPlanner] Starting combined critic (${spreads.length} spreads, theme: ${theme || 'default'})...`);
  const start = Date.now();

  const response = await callLLM(systemPrompt, JSON.stringify(textMap), {
    openaiApiKey: openaiKey,
    maxTokens: 7000,
    temperature: 0.35,
    jsonMode: true,
    costTracker,
  });

  console.log(`[storyPlanner] Combined critic completed in ${Date.now() - start}ms`);

  let result;
  try {
    let content = response.text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    result = JSON.parse(content);
  } catch (e) {
    const stripped = response.text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    try { result = JSON.parse(stripped); } catch (_) {
      console.warn('[storyPlanner] Combined critic JSON parse failed — using original');
      return storyPlan;
    }
  }

  if (result.scores) {
    console.log(`[storyPlanner] Combined critic scores: ${JSON.stringify(result.scores)}`);
  }

  if (result.issues && result.issues.length > 0) {
    console.log(`[storyPlanner] Combined critic found ${result.issues.length} issues:`);
    const byArea = {};
    for (const issue of result.issues) {
      byArea[issue.area] = (byArea[issue.area] || 0) + 1;
    }
    console.log(`  Areas: ${JSON.stringify(byArea)}`);
    for (const issue of result.issues.slice(0, 4)) {
      console.log(`  - Spread ${issue.spread} [${issue.area}]: "${(issue.line || '').slice(0, 60)}"`);
    }
  } else {
    console.log('[storyPlanner] Combined critic: no issues found — story is strong');
  }

  const improved = applyImprovedSpreads(storyPlan, result.improved_spreads || []);

  // Sanitize em-dashes/en-dashes that the critic may have reintroduced
  sanitizeAllStoryText(improved);

  improved._combinedCriticScores = result.scores || null;
  return improved;
}

/**
 * Self-critic / polish pass for a completed chapter book.
 * Sends all 5 chapters to the LLM for evaluation against 8 craft criteria.
 * If the total score is below the threshold (48/80), uses the rewritten version.
 * Returns the (possibly improved) chapter book.
 */
async function polishChapterBook(chapterPlan, childDetails, opts = {}) {
  const { apiKeys, costTracker, bookContext } = opts;
  const { CHAPTER_BOOK_CRITIC_SYSTEM } = require('../prompts/chapterBook');

  const SCORE_THRESHOLD = 48; // out of 80 — below this, apply the polished version

  // Build the full story text for the critic
  const storyForCritic = chapterPlan.chapters.map((ch, i) => {
    return `--- CHAPTER ${i + 1}: "${ch.chapterTitle}" ---\n${ch.text}`;
  }).join('\n\n');

  const userPrompt = `Here is a complete 5-chapter book titled "${chapterPlan.title}" for ${childDetails.name}, age ${childDetails.age}.

Evaluate and polish this story:

${storyForCritic}`;

  bookContext?.log('info', 'Running chapter book critic/polish pass');

  let criticResult;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await callLLM(CHAPTER_BOOK_CRITIC_SYSTEM, userPrompt, {
        openaiApiKey: apiKeys?.OPENAI_API_KEY,
        costTracker,
        temperature: 0.7,
        maxTokens: 16000,
        jsonMode: true,
        requestLabel: 'chapter-book-critic',
      });

      const text = resp.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in critic response');
      criticResult = JSON.parse(jsonMatch[0]);

      // Validate the critic response has the expected shape
      if (!criticResult.scores || !criticResult.total_score || !Array.isArray(criticResult.polished_chapters)) {
        throw new Error('Critic response missing required fields');
      }
      if (criticResult.polished_chapters.length < 5) {
        throw new Error(`Critic returned ${criticResult.polished_chapters.length} chapters, expected 5`);
      }
      break;
    } catch (err) {
      bookContext?.log('warn', `Chapter book critic attempt ${attempt} failed: ${err.message}`);
      if (attempt === 3) {
        bookContext?.log('warn', 'Chapter book critic failed after 3 attempts, keeping original');
        return chapterPlan;
      }
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  const totalScore = criticResult.total_score;
  bookContext?.log('info', 'Chapter book critic scores', {
    total: totalScore,
    threshold: SCORE_THRESHOLD,
    weakestChapter: criticResult.weakest_chapter,
    scores: criticResult.scores,
  });

  // Store critic scores on the plan for downstream logging
  chapterPlan._chapterCriticScores = criticResult.scores;
  chapterPlan._chapterCriticTotal = totalScore;

  if (totalScore >= SCORE_THRESHOLD) {
    bookContext?.log('info', `Chapter book scored ${totalScore}/80 (>= ${SCORE_THRESHOLD}), keeping original`);
    return chapterPlan;
  }

  // Apply polished chapters
  bookContext?.log('info', `Chapter book scored ${totalScore}/80 (< ${SCORE_THRESHOLD}), applying polished version`);
  for (const polished of criticResult.polished_chapters) {
    const idx = polished.number - 1;
    if (idx >= 0 && idx < chapterPlan.chapters.length && polished.text) {
      // Only apply if the polished text is substantial (not a stub or error)
      if (polished.text.length >= 500) {
        chapterPlan.chapters[idx].text = polished.text.trim();
      } else {
        bookContext?.log('warn', `Polished chapter ${polished.number} too short (${polished.text.length} chars), keeping original`);
      }
    }
  }

  return chapterPlan;
}

/**
 * Lightweight critic + polish pass for early reader stories.
 * Evaluates show-don't-tell, anti-kitschy, page-turn tension, rhyming,
 * economy, voice consistency, and surprise. If total score is below
 * threshold, uses the rewritten version; otherwise keeps original.
 *
 * @param {object} storyPlan - { title, entries: [...] }
 * @param {object} [opts] - { apiKeys, costTracker }
 * @returns {Promise<object>} Polished story plan with same structure
 */
async function polishEarlyReader(storyPlan, opts = {}) {
  const { costTracker, apiKeys } = opts;
  const openaiKey = apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  const spreads = storyPlan.entries.filter(e => e.type === 'spread');
  const textMap = spreads.map(s => ({
    spread: s.spread,
    left: s.left?.text || null,
    right: s.right?.text || null,
  }));

  console.log(`[storyPlanner] Starting early reader critic pass (${spreads.length} spreads)...`);
  const start = Date.now();

  const response = await callLLM(EARLY_READER_CRITIC_SYSTEM, JSON.stringify(textMap), {
    openaiApiKey: openaiKey,
    maxTokens: 10000,
    temperature: 0.4,
    jsonMode: true,
    costTracker,
  });

  console.log(`[storyPlanner] Early reader critic completed in ${Date.now() - start}ms (${response.model}, ${response.outputTokens} tokens)`);

  let result;
  try {
    let content = response.text.replace(/['']/g, "'").replace(/[""]/g, '"');
    result = JSON.parse(content);
  } catch (e) {
    const stripped = response.text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    try { result = JSON.parse(stripped); } catch (_) {
      console.warn('[storyPlanner] Early reader critic JSON parse failed — using original');
      return storyPlan;
    }
  }

  // Log scores
  if (result.scores) {
    const scores = result.scores;
    const values = Object.values(scores).filter(v => typeof v === 'number');
    const total = values.reduce((a, b) => a + b, 0);
    console.log(`[storyPlanner] Early reader critic scores: ${JSON.stringify(scores)} (total: ${total}/70)`);
  }

  // Log weak pages
  if (result.weakPages && result.weakPages.length > 0) {
    console.log(`[storyPlanner] Early reader critic weakest pages:`);
    for (const wp of result.weakPages.slice(0, 3)) {
      console.log(`  - Spread ${wp.spread}: ${wp.reason}`);
    }
  }

  // Decide whether to use rewritten version based on score threshold
  const SCORE_THRESHOLD = 42; // 42/70 = average of 6/10 per criterion
  const scores = result.scores || {};
  const scoreValues = Object.values(scores).filter(v => typeof v === 'number');
  const totalScore = scoreValues.reduce((a, b) => a + b, 0);

  const rewrittenArray = result.rewrittenStory || [];
  if (!Array.isArray(rewrittenArray) || rewrittenArray.length === 0) {
    console.warn('[storyPlanner] Early reader critic returned no rewrittenStory — using original');
    storyPlan._earlyReaderCriticScores = scores;
    return storyPlan;
  }

  if (rewrittenArray.length !== spreads.length) {
    console.warn(`[storyPlanner] Early reader critic returned ${rewrittenArray.length} spreads, expected ${spreads.length} — using original`);
    storyPlan._earlyReaderCriticScores = scores;
    return storyPlan;
  }

  if (totalScore >= SCORE_THRESHOLD) {
    console.log(`[storyPlanner] Early reader critic: total ${totalScore}/70 >= threshold ${SCORE_THRESHOLD} — keeping original`);
    storyPlan._earlyReaderCriticScores = scores;
    return storyPlan;
  }

  console.log(`[storyPlanner] Early reader critic: total ${totalScore}/70 < threshold ${SCORE_THRESHOLD} — applying rewrites`);

  // Apply rewritten text back into story plan
  let changedCount = 0;
  const updatedEntries = storyPlan.entries.map(entry => {
    if (entry.type !== 'spread') return entry;
    const match = rewrittenArray.find(p => p.spread === entry.spread);
    if (!match) return entry;

    const updated = { ...entry };
    if (match.left !== undefined && match.left !== null && entry.left) {
      if (match.left !== entry.left.text) changedCount++;
      updated.left = { ...entry.left, text: match.left };
    }
    return updated;
  });

  console.log(`[storyPlanner] Early reader critic: ${changedCount} pages improved out of ${spreads.length}`);

  const polished = {
    ...storyPlan,
    entries: updatedEntries,
    _earlyReaderCriticScores: scores,
    _earlyReaderWeakPages: (result.weakPages || []).length,
  };

  // Sanitize em-dashes/en-dashes that the critic may have reintroduced
  sanitizeAllStoryText(polished);

  return polished;
}

// ── Master Critic (consolidated from polishStory + combinedCritic + polishEarlyReader) ──

const { STYLE_MODES } = require('../prompts/writerBrief');

/**
 * Build the master critic system prompt.
 * @param {{ tier: number, childAge: number, theme: string, format: string, style_mode: string, techniques: string[] }} opts
 * @returns {string}
 */
function buildMasterCriticSystem(opts = {}) {
  const { tier, childAge, theme, format, style_mode, techniques } = opts;
  const { config: ageConfig } = getAgeTier(childAge || 5);
  const ageTier = tier || ageConfig.tier;
  const styleModeConfig = STYLE_MODES[style_mode] || STYLE_MODES.playful;
  const techList = Array.isArray(techniques) ? techniques : ['rule_of_three', 'humor'];
  const isER = format === 'early_reader' || ageTier >= 3;
  const isPB = format === 'picture_book' || ageTier <= 2;

  // Format-conditional criterion
  let formatSpecificCriterion;
  if (isPB || isER) {
    formatSpecificCriterion = `12. PAGE-TURN TENSION: Do at least 3 spreads end with a line that pulls the reader forward? Is the physical page turn used as a dramatic device?`;
  } else {
    formatSpecificCriterion = `12. SURPRISE: Does the story contain at least one genuinely unexpected moment?`;
  }

  // Technique awareness
  const techniqueSection = techList.length > 0
    ? `\nTECHNIQUES SELECTED: ${techList.join(', ')}
Only evaluate technique execution for these chosen techniques. Do NOT penalize the story for not including techniques it did not choose.`
    : '';

  let prompt = `CHILDREN'S BOOK — MASTER CRITIC + REWRITE

You are a world-class children's book editor performing a single comprehensive evaluation and rewrite pass.

STYLE MODE: ${style_mode || 'playful'} (${styleModeConfig.label})
STYLE CRITIC BIAS: ${styleModeConfig.criticBias}
${techniqueSection}

─────────────────────────────────────────
PRESERVATION RULE (CRITICAL)
─────────────────────────────────────────
Before rewriting, identify:
- The single strongest LINE in the story (most memorable, most specific, most resonant)
- The single strongest MOMENT (the spread where everything clicks)
- The single strongest IMAGE (the most vivid, illustratable, specific visual)

Output these in your response as "preserve" (see output format below).

THEN when rewriting:
- Do NOT change any spread listed in "preserve" unless it has a critical structural flaw
- If you must change a preserved spread, explain why in the issues array
- "Making it smoother" or "improving language" is NOT a valid reason to change a preserved element

─────────────────────────────────────────
EDGE ACCEPTANCE (IMPORTANT)
─────────────────────────────────────────
Great children's books have rough edges. Where the Wild Things Are is strange. The Giving Tree is asymmetrical. Goodnight Moon lists random objects.

Do NOT remove or smooth over:
- Unusual word choices that are coherent and specific
- Slightly strange or surreal moments that serve the story's internal logic
- Asymmetric structures (not every spread needs the same rhythm)
- Unexpected tonal shifts that feel intentional
- Invented words or phrases that fit the story's world

The goal is a story with CHARACTER, not a story with zero flaws.
A story that is slightly weird but deeply felt > a story that is perfectly polished but forgettable.

Ask yourself: "Would removing this make the story better, or just safer?"
If just safer — leave it.

─────────────────────────────────────────
EVALUATION CRITERIA (12 total — score each 1-10)
─────────────────────────────────────────

1. EMOTIONAL WRITING: Is emotion shown (not told)? Any "she felt / she was scared" → penalty.
2. LANGUAGE QUALITY & RHYTHM: Read every line OUT LOUD. Does it SING? Is the prose musical? Would a parent enjoy saying these words? Flag any line that sounds choppy, robotic, like a reading primer, or like AI filler. For young children (ages 0-5): the writing MUST use RHYMING COUPLETS — flat prose fragments are a critical failure. "The wind came knocking at the gate. It flipped the mat. It couldn't wait." = beautiful. "The wind came. It flipped the mat. It was loud." = unacceptable primer-style writing. Score below 4 if the story lacks rhyming couplets for this age group.
2b. RHYME QUALITY: For ages 0-8, MOST spreads should rhyme (AABB couplets). Count how many spreads have clear end-rhymes. If fewer than 9 of 13 spreads rhyme, flag it. Rhymes must feel EFFORTLESS and BEAUTIFUL — if a rhyme bends a sentence into an unnatural shape, flag it. The story should read like a poem, not prose with occasional rhymes tacked on.
3. IMAGERY: Are visuals specific and vivid? Or vague and common?
4. AUTHORIAL VOICE & CONSISTENCY: Does the voice feel like a real author — not AI? Is the vocabulary level CONSISTENT across all spreads? Flag any spread where the language suddenly becomes more literary, complex, or poetic than the surrounding text. A "gear shift" in sophistication is a voice failure.
5. CHILD AGENCY: Does the child actively drive the story?
6. PHRASE TRANSFORMATION & TIMING: Does the repeated element evolve meaningfully? Does it first appear by spread 2-3 (NOT later)? Does it appear at least 3 times total? Are appearances distributed across beginning, middle, and end — not clustered?
7. ENDING QUALITY: Does the ending match the theme's energy? Is the final line CONCRETE (a specific image or action) rather than abstract/poetic? "Crumbs in my palm. For Mama." = 10. "All my love, soft and grand" = 4. Abstract poetic summaries are a critical failure for young-child books.
8. MEMORABLE LINE: Is there at least one line a parent would want to repeat outside the book?
9. VERB POWER & RESTRAINT: Are verbs strong and specific? Does the story trust the reader to feel emotion without amplifying?
10. HUMOR & DELIGHT: Are there genuinely funny or delightful moments? Does humor emerge from character and situation?
11. ANTI-KITSCHY: Is the story free of generic sentiment, greeting-card language, and moralizing endings?
${formatSpecificCriterion}

SCORING DISCIPLINE:
Do NOT give any category above 7 if ANY of these are present:
- Emotion telling ("felt", "was scared", "was happy")
- Generic filler ("very", "nice", "special", "magical", "wonderful", "beautiful")
- A sentence that could appear unchanged in a different children's book
- Any spread where vocabulary suddenly jumps in complexity compared to surrounding spreads
- The motif/repeated phrase first appearing after spread 4
- An abstract or poetic final line when the target audience is under 6
- Flat prose fragments with no rhythm or rhyme when the target audience is under 6 ("She walked. She saw the book. Still here." is primer-style writing)
- Lines that sound choppy, robotic, or like a reading primer when read aloud
- Forced rhymes that bend sentences into unnatural shapes
- For ages 0-5: fewer than 9 of 13 spreads having clear rhyming couplets

─────────────────────────────────────────
REWRITE PROTOCOL
─────────────────────────────────────────

STEP 1 — FIX (mandatory):
Fix these issues — they are objectively broken:
- Emotion-telling ("she felt scared") → replace with action/sensation
- Generic filler words ("very", "nice", "special", "magical")
- Kitschy/greeting-card phrases
- Structural issues (contradictions, confused timeline, missing character)
- Word count violations (spread exceeding age-tier maximum)
- Weak verb + adverb combos → single strong verb
- Duplicate consecutive words
- Lines that sound choppy, robotic, or like a reading primer → rewrite as RHYMING COUPLETS for ages 0-5, or as complete flowing sentences for older ages
- Flat prose fragments without rhythm → rewrite as rhyming couplets for ages 0-5 ("The wind came knocking at the gate. It flipped the mat. It couldn't wait." not "The wind came. It flipped the mat.")
- Vocabulary ceiling violations (a spread using notably harder words than spread 1) → match the established level
- Motif/repeated phrase appearing too late → move first appearance to spread 2 or 3
- Abstract/poetic ending for young children → replace with concrete image or action

STEP 2 — ENHANCE (only if clearly needed):
Only make these changes if the improvement is OBVIOUS and SIGNIFICANT:
- Tighten a flabby sentence (but don't touch one that works)
- Improve a flat ending
- Add rhythm to a line that stumbles when read aloud

RULE: If you are unsure whether a change improves the line — leave it.
The writer's voice has value. Do not sand it smooth.

─────────────────────────────────────────
RULES FOR ALL REWRITES
─────────────────────────────────────────
- Do NOT change: plot, structure, characters, spread count, left/right assignments, null pages
- Quality bar: only return a rewrite if it is clearly better than the original
- The ending must feel emotionally resolved — energy matches the theme
- For bedtime books: soft and settling
- For adventure/birthday/science/space: warm and joyful, NOT sleepy`;

  // Inject age-tier constraints
  prompt += buildAgeTierPreamble(ageTier, ageConfig, childAge || 5);

  // Birthday theme exception
  if (theme === 'birthday') {
    prompt += `\n\n⚠️ BIRTHDAY THEME EXCEPTION:\nThis is a BIRTHDAY story. The ending rules are DIFFERENT:\n- Do NOT soften the ending into a whisper or sleepy tone.\n- The final spread is the birthday cake/candles moment — the emotional climax.\n- The ending should feel warm, joyful, and celebratory — not quiet.\n- Do NOT make the ending softer or more poetic. Make it warmer and more joyful if needed.`;
  }

  prompt += `

─────────────────────────────────────────
OUTPUT FORMAT (JSON)
─────────────────────────────────────────

Return a JSON object with exactly this structure:
{
  "preserve": {
    "strongest_line": { "spread": 7, "text": "exact quote" },
    "strongest_moment": { "spread": 12, "reason": "why" },
    "strongest_image": { "spread": 10, "reason": "why" }
  },
  "scores": {
    "emotional_writing": 8,
    "language_rhythm": 7,
    "imagery": 8,
    "authorial_voice": 7,
    "child_agency": 8,
    "phrase_transformation": 6,
    "ending_quality": 7,
    "memorable_line": 8,
    "verb_power_restraint": 7,
    "humor_delight": 6,
    "anti_kitschy": 8,
    "format_specific": 7
  },
  "issues": [
    { "spread": 3, "line": "exact quote", "type": "fix|enhance", "reason": "description" }
  ],
  "improved_spreads": [
    { "spread": 1, "left": "...", "right": "..." }
  ]
}

Rules for improved_spreads:
- Return ALL spreads (same count as input)
- If a spread needed no changes, return its text unchanged
- If left or right was null in the input, keep it null
- Mark each issue as "fix" (objectively broken) or "enhance" (optional improvement)`;

  return prompt;
}

/**
 * Master critic — single consolidated critic pass replacing polishStory + combinedCritic + polishEarlyReader.
 * Evaluates 12 criteria, preserves strongest lines, respects style mode, and rewrites.
 *
 * @param {object} storyPlan - { title, entries: [...] }
 * @param {object} [opts] - { apiKeys, costTracker, theme, childAge, format, style_mode, techniques }
 * @returns {Promise<object>} Polished story plan with same structure
 */
async function masterCritic(storyPlan, opts = {}) {
  const { costTracker, apiKeys, theme, childAge, format, style_mode, techniques } = opts;
  const narrativePatterns = opts.narrativePatterns || storyPlan._narrativePatterns || null;
  const openaiKey = apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  const spreads = storyPlan.entries.filter(e => e.type === 'spread');
  const textMap = spreads.map(s => ({
    spread: s.spread,
    left: s.left?.text || null,
    right: s.right?.text || null,
  }));

  const { tier: ageTier } = getAgeTier(childAge || 5);
  let systemPrompt = buildMasterCriticSystem({
    tier: ageTier,
    childAge: childAge || 5,
    theme,
    format,
    style_mode: style_mode || 'playful',
    techniques: techniques || ['rule_of_three', 'humor'],
  });

  // Inject narrative pattern awareness for the critic
  const criticPatternBlock = formatPatternsForCritic(narrativePatterns);
  if (criticPatternBlock) {
    systemPrompt += '\n\n' + criticPatternBlock;
  }

  const userPrompt = `Here is the story to evaluate and improve (${spreads.length} spreads):\n\n${JSON.stringify(textMap)}`;

  console.log(`[storyPlanner] Starting master critic (${spreads.length} spreads, theme: ${theme || 'default'}, style: ${style_mode || 'playful'})...`);
  const criticStart = Date.now();

  const response = await callLLM(systemPrompt, userPrompt, {
    openaiApiKey: openaiKey,
    maxTokens: 10000,
    temperature: 0.5,
    jsonMode: true,
    costTracker,
    requestLabel: 'masterCritic',
  });

  const criticMs = Date.now() - criticStart;
  console.log(`[storyPlanner] Master critic completed in ${criticMs}ms (${response.model}, ${response.outputTokens} tokens)`);

  let content = response.text;
  content = content.replace(/\\'/g, "'");
  content = content.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');

  let result;
  try {
    result = JSON.parse(content);
  } catch (parseErr) {
    const stripped = content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      result = JSON.parse(stripped);
    } catch (_) {
      // Try repairing truncated JSON
      const repaired = repairTruncatedJson(content);
      if (repaired) {
        console.warn(`[storyPlanner] Master critic JSON repaired from truncated response`);
        result = repaired;
      } else {
        console.warn(`[storyPlanner] Master critic JSON parse failed: ${parseErr.message} — using original text`);
        return storyPlan;
      }
    }
  }

  // Log scores
  if (result.scores) {
    const scores = result.scores;
    const values = Object.values(scores).filter(v => typeof v === 'number');
    const avg = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    console.log(`[storyPlanner] Master critic scores: ${JSON.stringify(scores)} (avg: ${avg.toFixed(1)})`);
  }

  // Log preservation
  if (result.preserve) {
    const p = result.preserve;
    if (p.strongest_line) console.log(`[storyPlanner] Preserved line (spread ${p.strongest_line.spread}): "${(p.strongest_line.text || '').slice(0, 80)}"`);
    if (p.strongest_moment) console.log(`[storyPlanner] Preserved moment (spread ${p.strongest_moment.spread}): ${p.strongest_moment.reason}`);
  }

  // Log issues
  if (result.issues && result.issues.length > 0) {
    const fixCount = result.issues.filter(i => i.type === 'fix').length;
    const enhanceCount = result.issues.filter(i => i.type === 'enhance').length;
    console.log(`[storyPlanner] Master critic found ${result.issues.length} issues (${fixCount} fixes, ${enhanceCount} enhancements)`);
    for (const issue of result.issues.slice(0, 5)) {
      console.log(`  - [${issue.type}] spread ${issue.spread}: "${(issue.line || '').slice(0, 60)}"`);
    }
  }

  // Extract the improved spreads
  const polishedArray = result.improved_spreads || result.spreads || result.entries || [];
  if (!Array.isArray(polishedArray)) {
    console.warn(`[storyPlanner] Master critic returned no improved_spreads array — using original text`);
    storyPlan._masterCriticScores = result.scores || null;
    return storyPlan;
  }

  if (polishedArray.length !== spreads.length) {
    console.warn(`[storyPlanner] Master critic returned ${polishedArray.length} spreads, expected ${spreads.length} — using original text`);
    storyPlan._masterCriticScores = result.scores || null;
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

  console.log(`[storyPlanner] Master critic: ${changedCount} page texts improved out of ${spreads.length * 2} pages`);

  const polished = {
    ...storyPlan,
    entries: updatedEntries,
    _masterCriticScores: result.scores || null,
    _masterCriticPreserve: result.preserve || null,
    _masterCriticIssueCount: (result.issues || []).length,
  };

  // Sanitize em-dashes/en-dashes that the critic may have reintroduced
  sanitizeAllStoryText(polished);

  return polished;
}

/**
 * Plan and write a full chapter book (T4 format for ages 9-12).
 * Returns an object with title + 5 chapters (each with chapterTitle, synopsis, imagePrompt, text).
 */
async function planChapterBook(childDetails, theme, customDetails, opts = {}) {
  const { apiKeys, costTracker, approvedTitle, bookContext, parentBookTitle, parentStoryContent, additionalCoverCharacters } = opts;
  const { CHAPTER_PLANNER_SYSTEM, CHAPTER_PLANNER_USER, CHAPTER_WRITER_SYSTEM, CHAPTER_WRITER_USER } = require('../prompts/chapterBook');

  // Step 1: Brainstorm seed + enrich custom details in parallel
  let seed;
  let enrichedCustomDetails;
  try {
    const [seedResult, enrichedResult] = await Promise.all([
      brainstormStorySeed(childDetails, customDetails || '', approvedTitle, { apiKeys, costTracker, theme, additionalCoverCharacters })
        .catch(err => {
          bookContext?.log('warn', 'Chapter book seed brainstorm failed, using defaults', { error: err.message });
          return { repeated_phrase: 'one step at a time', favorite_object: customDetails || 'a compass', setting: 'the neighborhood', fear: 'failing' };
        }),
      enrichCustomDetails(customDetails, childDetails.childName || childDetails.name, childDetails.childAge || childDetails.age,
        (childDetails.childInterests || childDetails.interests || []).filter(Boolean)),
    ]);
    seed = seedResult;
    enrichedCustomDetails = enrichedResult;
  } catch (err) {
    bookContext?.log('warn', 'Chapter book seed/enrich failed, using defaults', { error: err.message });
    seed = { repeated_phrase: 'one step at a time', favorite_object: customDetails || 'a compass', setting: 'the neighborhood', fear: 'failing' };
    enrichedCustomDetails = customDetails || '';
  }

  // Build parent story section if a parent picture book was provided
  let parentStorySection = '';
  if (parentStoryContent) {
    const origTitle = parentStoryContent.title || '';
    const texts = (parentStoryContent.entries || [])
      .map(e => e.text || [e.left?.text, e.right?.text].filter(Boolean).join(' ') || '')
      .filter(t => t.trim())
      .join(' ');
    if (origTitle || texts) {
      parentStorySection = `\n\nORIGINAL PICTURE BOOK (this chapter book MUST be an expanded retelling of this exact story — same world, same characters, same arc):\nTitle: "${origTitle}"\nStory: ${texts}`;
    }
  }

  const titleInstruction = parentBookTitle
    ? `\n\nIMPORTANT: The book title MUST be exactly: "${parentBookTitle}". Do not invent a new title.`
    : '';

  // Family member constraint for chapter book illustrations
  let familyConstraint = '';
  if (theme === 'mothers_day') {
    familyConstraint = additionalCoverCharacters
      ? `\n\n⚠️ MOTHER'S DAY OVERRIDE: Mom is a co-protagonist. She MUST appear in chapter illustrations frequently. Additionally, the uploaded photo contains a secondary person:\n${additionalCoverCharacters}\nOnly Mom and the secondary character(s) listed above are allowed in illustrations — do NOT invent any other family members.`
      : `\n\n⚠️ MOTHER'S DAY OVERRIDE: Mom is a co-protagonist. She MUST appear in chapter illustrations frequently — but with IMPLIED PRESENCE ONLY (no face). We have NO reference image for Mom. She is FEMALE (a woman). Her face must NEVER be shown in illustrations. Show her through: back view, hands, arms, silhouette, side view with face turned away, or cropped at frame edge. NEVER describe her facial features. Other family members (siblings, grandparents, dad) must NOT appear in illustrations — text only.`;
  } else if (theme === 'fathers_day') {
    familyConstraint = additionalCoverCharacters
      ? `\n\n⚠️ FATHER'S DAY OVERRIDE: Dad is a co-protagonist. He MUST appear in chapter illustrations frequently. Additionally, the uploaded photo contains a secondary person:\n${additionalCoverCharacters}\nOnly Dad and the secondary character(s) listed above are allowed in illustrations — do NOT invent any other family members.`
      : `\n\n⚠️ FATHER'S DAY OVERRIDE: Dad is a co-protagonist. He MUST appear in chapter illustrations frequently — but with IMPLIED PRESENCE ONLY (no face). We have NO reference image for Dad. He is MALE (a man). His face must NEVER be shown in illustrations. Show him through: back view, hands, arms, silhouette, side view with face turned away, or cropped at frame edge. NEVER describe his facial features. Other family members (siblings, grandparents, mom) must NOT appear in illustrations — text only.`;
  } else if (additionalCoverCharacters) {
    familyConstraint = `\n\n⚠️ COVER PHOTO OVERRIDE: The uploaded photo contains a secondary person (e.g. a parent/family member). This overrides the "no family in illustrations" rule for THIS book only. The following secondary character IS allowed in illustrations and must appear consistently:\n${additionalCoverCharacters}\nWrite their description into illustration prompts whenever they appear naturally in the scene. Do NOT invent other family members beyond what is listed above.`;
  } else {
    familyConstraint = `\n\nILLUSTRATION CONSTRAINT — NO FAMILY MEMBERS IN IMAGES:\nStory text MAY mention family members by name. However, family members must NEVER appear as visible characters in illustrations — we only have the child's photo. Design scenes so they center the child visually.`;
  }

  // Step 2: Plan chapter structure
  bookContext?.log('info', 'Planning chapter structure');
  const planUserPrompt = CHAPTER_PLANNER_USER(childDetails, theme, enrichedCustomDetails, seed) + parentStorySection + titleInstruction + familyConstraint;

  let chapterPlan;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await callLLM(CHAPTER_PLANNER_SYSTEM, planUserPrompt, {
        openaiApiKey: apiKeys?.OPENAI_API_KEY,
        costTracker,
        temperature: 0.8,
        maxTokens: 4096,
        jsonMode: true,
      });
      const text = resp.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');
      chapterPlan = JSON.parse(jsonMatch[0]);
      if (!chapterPlan.title || !Array.isArray(chapterPlan.chapters) || chapterPlan.chapters.length < 5) {
        throw new Error(`Invalid chapter plan: got ${chapterPlan.chapters?.length} chapters`);
      }
      break;
    } catch (err) {
      bookContext?.log('warn', `Chapter plan attempt ${attempt} failed: ${err.message}`);
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  // Override title if approved
  const bookTitle = approvedTitle || chapterPlan.title;
  chapterPlan.title = bookTitle;
  bookContext?.log('info', 'Chapter structure planned', { title: bookTitle, chapters: chapterPlan.chapters.map(c => c.chapterTitle) });

  // Step 3: Write prose for each chapter
  const bookContextForWriter = { title: bookTitle, chapters: chapterPlan.chapters, seed };

  for (let i = 0; i < chapterPlan.chapters.length; i++) {
    const chapter = chapterPlan.chapters[i];
    bookContext?.log('info', `Writing chapter ${i + 1}: ${chapter.chapterTitle}`);

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const writerSystem = CHAPTER_WRITER_SYSTEM(childDetails);
        const writerUser = CHAPTER_WRITER_USER(chapter, i, childDetails, bookContextForWriter);

        const resp = await callLLM(writerSystem, writerUser, {
          openaiApiKey: apiKeys?.OPENAI_API_KEY,
          costTracker,
          temperature: 0.85,
          maxTokens: 3000,
        });

        const prose = resp.text || '';
        if (!prose || prose.length < 500) throw new Error(`Chapter ${i+1} too short: ${prose?.length} chars`);
        chapter.text = prose.trim();
        bookContext?.log('info', `Chapter ${i + 1} written`, { words: prose.split(/\s+/).length });
        break;
      } catch (err) {
        bookContext?.log('warn', `Chapter ${i + 1} writing attempt ${attempt} failed: ${err.message}`);
        if (attempt === 3) throw err;
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }

  // Step 4: Self-critic / polish pass (all 5 chapters evaluated together)
  await polishChapterBook(chapterPlan, childDetails, { apiKeys, costTracker, bookContext });

  // Carry forward character details from seed
  chapterPlan.characterDescription = seed.characterDescription || null;
  chapterPlan.characterAnchor = seed.characterAnchor || null;
  chapterPlan.characterOutfit = seed.characterOutfit || null;
  chapterPlan.recurringElement = seed.favorite_object || null;
  chapterPlan.keyObjects = seed.keyObjects || null;
  if (additionalCoverCharacters) {
    chapterPlan.additionalCoverCharacters = additionalCoverCharacters;
  }

  return chapterPlan;
}

function parseJsonObjectFromText(text, finishReason) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Empty JSON response');
  try {
    return parseJsonPlan(raw, finishReason || 'unknown');
  } catch (err) {
    throw err;
  }
}

function compactGraphicNovelStoryBible(storyBible) {
  if (!storyBible || typeof storyBible !== 'object') return {};
  return {
    title: storyBible.title || '',
    tagline: storyBible.tagline || '',
    logline: storyBible.logline || '',
    audiencePromise: storyBible.audiencePromise || '',
    cast: Array.isArray(storyBible.cast)
      ? storyBible.cast.map((member) => ({
          id: member.id,
          name: member.name,
          role: member.role,
          voiceGuide: member.voiceGuide,
          visualAnchor: member.visualAnchor,
          actingNotes: member.actingNotes,
        }))
      : [],
    worldBible: storyBible.worldBible || {},
    recurringMotifs: storyBible.recurringMotifs || [],
    sceneColorScript: storyBible.sceneColorScript || [],
    sceneBlueprints: Array.isArray(storyBible.sceneBlueprints)
      ? storyBible.sceneBlueprints.map((scene) => ({
          sceneNumber: scene.sceneNumber,
          sceneTitle: scene.sceneTitle,
          purpose: scene.purpose,
          turningPoint: scene.turningPoint,
          pageCountTarget: scene.pageCountTarget,
          dominantEmotion: scene.dominantEmotion,
          pageTurnIntent: scene.pageTurnIntent,
        }))
      : [],
  };
}

function summarizeGraphicNovelStructure(plan) {
  const pageCount = Array.isArray(plan?.pages) ? plan.pages.length : 0;
  const sceneCount = Array.isArray(plan?.scenes) ? plan.scenes.length : 0;
  const panelCount = Array.isArray(plan?.allPanels) ? plan.allPanels.length : 0;
  const splashCount = Array.isArray(plan?.allPanels)
    ? plan.allPanels.filter((panel) => panel.panelType === 'splash').length
    : 0;
  const issues = [];
  if (pageCount < 24 || pageCount > 32) issues.push(`pages=${pageCount} (need 24-32)`);
  if (sceneCount !== 7) issues.push(`scenes=${sceneCount} (need 7)`);
  if (splashCount !== 2) issues.push(`splashPanels=${splashCount} (need 2)`);
  if (panelCount < Math.max(24, pageCount)) issues.push(`panels=${panelCount} looks too low for a graphic novel`);
  const emptyPages = (plan?.pages || []).filter((page) => !Array.isArray(page.panels) || page.panels.length === 0).length;
  if (emptyPages > 0) issues.push(`emptyPages=${emptyPages}`);
  return { pageCount, sceneCount, panelCount, splashCount, issues };
}

function buildGraphicNovelChunkSpecs(storyBible) {
  const sceneBlueprints = Array.isArray(storyBible?.sceneBlueprints)
    ? [...storyBible.sceneBlueprints].sort((a, b) => (a.sceneNumber || 0) - (b.sceneNumber || 0))
    : [];
  if (!sceneBlueprints.length) return [];

  const groups = [
    [1, 2],
    [3, 4],
    [5],
    [6],
    [7],
  ];

  return groups
    .map((sceneNumbers) => {
      const scenes = sceneBlueprints.filter((scene) => sceneNumbers.includes(scene.sceneNumber));
      if (!scenes.length) return null;
      return {
        scenes,
        expectedPages: scenes.reduce((sum, scene) => sum + Math.max(4, Number(scene.pageCountTarget) || 0), 0),
      };
    })
    .filter(Boolean);
}

function buildGraphicNovelStoryBibleChunk(storyBible, chunkSpec) {
  const compact = compactGraphicNovelStoryBible(storyBible);
  const sceneNumbers = new Set((chunkSpec?.scenes || []).map((scene) => scene.sceneNumber));
  return {
    ...compact,
    sceneBlueprints: (compact.sceneBlueprints || []).filter((scene) => sceneNumbers.has(scene.sceneNumber)),
    sceneColorScript: (compact.sceneColorScript || []).filter((scene) => sceneNumbers.has(scene.sceneNumber)),
  };
}

function buildGraphicNovelChunkPageAssignments(chunkSpec) {
  return (chunkSpec?.scenes || []).flatMap((scene) => Array.from(
    { length: Math.max(2, Number(scene.pageCountTarget) || 0) },
    () => ({
      sceneNumber: scene.sceneNumber,
      sceneTitle: scene.sceneTitle || `Scene ${scene.sceneNumber}`,
    })
  ));
}

function stampGraphicNovelChunkPages(rawPlan, chunkSpec) {
  if (!rawPlan || typeof rawPlan !== 'object') return rawPlan;
  const pageAssignments = buildGraphicNovelChunkPageAssignments(chunkSpec);
  if (!Array.isArray(rawPlan.pages)) return rawPlan;

  return {
    ...rawPlan,
    pages: rawPlan.pages.map((page, index) => {
      const assignment = pageAssignments[index] || pageAssignments[pageAssignments.length - 1] || {
        sceneNumber: 1,
        sceneTitle: 'Scene 1',
      };
      const stampedPanels = Array.isArray(page?.panels)
        ? page.panels.map((panel, panelIndex) => ({
            ...panel,
            sceneNumber: assignment.sceneNumber,
            sceneTitle: assignment.sceneTitle,
            panelNumber: Number.isFinite(panel?.panelNumber) ? panel.panelNumber : panelIndex + 1,
          }))
        : [];

      return {
        ...page,
        pageNumber: Number.isFinite(page?.pageNumber) ? page.pageNumber : index + 1,
        sceneNumber: assignment.sceneNumber,
        sceneTitle: page?.sceneTitle || assignment.sceneTitle,
        panels: stampedPanels,
      };
    }),
  };
}

function summarizeGraphicNovelChunkStructure(plan, chunkSpec) {
  const pages = Array.isArray(plan?.pages) ? plan.pages : [];
  const expectedPages = Number(chunkSpec?.expectedPages) || 0;
  const expectedSplashes = (chunkSpec?.scenes || []).filter((scene) => scene.sceneNumber === 6 || scene.sceneNumber === 7).length;
  const issues = [];

  // Allow flexibility — accept chunks with at least 3 pages or 40% of expected, whichever is lower
  const minAcceptable = Math.max(2, Math.min(3, Math.floor(expectedPages * 0.4)));
  if (pages.length < minAcceptable) issues.push(`pages=${pages.length} (need at least ${minAcceptable})`);
  // Check illustrated pages have panels (text interstitials don't need them)
  const emptyIllustrated = pages.filter((page) => page.pageType !== 'text_interstitial' && (!Array.isArray(page.panels) || page.panels.length === 0));
  if (emptyIllustrated.length > 0) issues.push(`${emptyIllustrated.length} illustrated pages have no panels`);
  // Splash page check is advisory — don't block chunk on missing splashes
  // The planner prompts request splashes but mocks/LLMs may not always include them

  return { issues };
}

async function planGraphicNovelChunk(childDetails, theme, customDetails, seed, storyBible, chunkSpec, opts = {}) {
  const {
    apiKeys,
    costTracker,
    approvedTitle,
    bookContext,
    narrativePatterns,
  } = opts;
  const {
    GRAPHIC_NOVEL_SCENE_PLANNER_SYSTEM,
    GRAPHIC_NOVEL_SCENE_PLANNER_USER,
  } = require('../prompts/graphicNovel');
  const { normalizeGraphicNovelPlan } = require('./graphicNovelQa');

  const chunkBible = buildGraphicNovelStoryBibleChunk(storyBible, chunkSpec);
  const chunkPatternBlock = formatPatternsForChunks(narrativePatterns);
  const chunkPrompt = GRAPHIC_NOVEL_SCENE_PLANNER_USER(
    childDetails,
    theme,
    customDetails,
    seed,
    chunkBible,
    chunkSpec
  ) + chunkPatternBlock;
  const chunkSceneLabel = (chunkSpec.scenes || []).map((scene) => scene.sceneNumber).join(', ');

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      bookContext?.log('info', 'Planning graphic novel chunk', {
        scenes: chunkSceneLabel,
        attempt,
        expectedPages: chunkSpec.expectedPages,
      });
      const resp = await callLLM(GRAPHIC_NOVEL_SCENE_PLANNER_SYSTEM, chunkPrompt, {
        openaiApiKey: apiKeys?.OPENAI_API_KEY,
        costTracker,
        temperature: 0.65,
        maxTokens: 24000,
        jsonMode: true,
        timeoutMs: GRAPHIC_NOVEL_CHUNK_TIMEOUT_MS,
        requestLabel: `Graphic novel chunk ${chunkSceneLabel} attempt ${attempt}`,
      });
      const parsedChunk = await parseStructuredJsonWithFallback(
        resp,
        GRAPHIC_NOVEL_SCENE_PLANNER_SYSTEM,
        chunkPrompt,
        {
          costTracker,
          temperature: 0.65,
          maxTokens: 24000,
          bookContext,
          timeoutMs: GRAPHIC_NOVEL_CHUNK_TIMEOUT_MS,
          requestLabel: `Graphic novel chunk ${chunkSceneLabel} attempt ${attempt}`,
        }
      );
      // Guard against truncation producing valid JSON with no usable content
      const chunkPageCount = Array.isArray(parsedChunk.pages) ? parsedChunk.pages.length : 0;
      const chunkSceneCount = Array.isArray(parsedChunk.scenes) ? parsedChunk.scenes.length : 0;
      if (chunkPageCount === 0 && chunkSceneCount === 0) {
        bookContext?.log('warn', 'Chunk parse returned no pages and no scenes', {
          scenes: chunkSceneLabel,
          attempt,
          finishReason: resp.finishReason,
          outputTokens: resp.outputTokens,
          parsedKeys: Object.keys(parsedChunk),
        });
        throw new Error(
          `Chunk for scenes ${chunkSceneLabel} produced 0 pages and 0 scenes` +
          ` (finishReason=${resp.finishReason}, outputTokens=${resp.outputTokens})`
        );
      }
      const stampedChunk = stampGraphicNovelChunkPages(parsedChunk, chunkSpec);
      let chunkPlan = legacyGraphicNovelScenesToPages(stampedChunk, childDetails);
      chunkPlan = normalizeGraphicNovelPlan(chunkPlan, { fallbackTitle: storyBible.title || approvedTitle });
      const structure = summarizeGraphicNovelChunkStructure(chunkPlan, chunkSpec);
      if (structure.issues.length > 0) {
        throw new Error(`Invalid chunk: ${structure.issues.join(', ')}`);
      }
      bookContext?.touchActivity?.();
      bookContext?.log('info', 'Graphic novel chunk planned', {
        scenes: chunkSceneLabel,
        pages: chunkPlan.pages.length,
      });
      return chunkPlan;
    } catch (err) {
      bookContext?.log('warn', `Graphic novel chunk plan failed for scenes ${chunkSceneLabel} attempt ${attempt}: ${err.message}`);
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }

  throw new Error('Chunk planning exhausted retries');
}

async function polishGraphicNovelChunk(chunkPlan, chunkIndex, totalChunks, storyBible, opts = {}) {
  const { apiKeys, costTracker, bookContext } = opts;
  const { GRAPHIC_NOVEL_POLISH_SYSTEM, GRAPHIC_NOVEL_POLISH_USER } = require('../prompts/graphicNovelCritic');
  const { normalizeGraphicNovelPlan } = require('./graphicNovelQa');

  try {
    bookContext?.log('info', `Polishing graphic novel chunk ${chunkIndex + 1}/${totalChunks}`);
    const polishPrompt = GRAPHIC_NOVEL_POLISH_USER(chunkPlan, chunkIndex, totalChunks, storyBible);
    // Use Gemini directly for polish — GPT consistently fails to produce valid JSON
    // for large rewrite tasks. Gemini handles big JSON output more reliably.
    const resp = await callGeminiText(GRAPHIC_NOVEL_POLISH_SYSTEM, polishPrompt, {
      temperature: 0.5,
      maxOutputTokens: 32000,
      timeoutMs: GRAPHIC_NOVEL_CHUNK_TIMEOUT_MS,
      requestLabel: `Graphic novel polish chunk ${chunkIndex + 1}`,
    });
    const polished = await parseStructuredJsonWithFallback(
      resp,
      GRAPHIC_NOVEL_POLISH_SYSTEM,
      polishPrompt,
      {
        costTracker,
        temperature: 0.5,
        maxTokens: 32000,
        bookContext,
        timeoutMs: GRAPHIC_NOVEL_CHUNK_TIMEOUT_MS,
        requestLabel: `Graphic novel polish chunk ${chunkIndex + 1}`,
      }
    );
    // Validate polished output has pages
    if (!Array.isArray(polished?.pages) || polished.pages.length === 0) {
      bookContext?.log('warn', `Polish returned no pages — using unpolished chunk ${chunkIndex + 1}`);
      return null;
    }
    const normalized = normalizeGraphicNovelPlan(polished, { fallbackTitle: storyBible?.title });
    bookContext?.log('info', `Polish complete for chunk ${chunkIndex + 1}`, { pages: normalized.pages.length });
    return normalized;
  } catch (err) {
    bookContext?.log('warn', `Polish failed for chunk ${chunkIndex + 1} — using unpolished`, { error: err.message });
    return null;
  }
}

async function planGraphicNovelByChunks(childDetails, theme, customDetails, seed, storyBible, opts = {}) {
  const { normalizeGraphicNovelPlan } = require('./graphicNovelQa');
  const chunkSpecs = buildGraphicNovelChunkSpecs(storyBible);
  const chunkPlans = [];
  opts.bookContext?.log('info', 'Starting chunked graphic novel planning', {
    chunkCount: chunkSpecs.length,
    chunks: chunkSpecs.map((chunkSpec) => ({
      scenes: (chunkSpec.scenes || []).map((scene) => scene.sceneNumber),
      expectedPages: chunkSpec.expectedPages,
    })),
  });

  for (let ci = 0; ci < chunkSpecs.length; ci++) {
    const chunkSpec = chunkSpecs[ci];
    let chunkPlan = await planGraphicNovelChunk(
      childDetails,
      theme,
      customDetails,
      seed,
      storyBible,
      chunkSpec,
      opts
    );
    // Polish pass — rewrite for publishable quality
    const polished = await polishGraphicNovelChunk(chunkPlan, ci, chunkSpecs.length, storyBible, opts);
    if (polished) chunkPlan = polished;
    chunkPlans.push(chunkPlan);
  }

  const mergedPages = chunkPlans.flatMap((chunkPlan) => chunkPlan.pages || []).map((page, pageIndex) => ({
    ...page,
    pageNumber: pageIndex + 1,
    panels: (page.panels || []).map((panel, panelIndex) => ({
      ...panel,
      pageNumber: pageIndex + 1,
      panelNumber: Number.isFinite(panel.panelNumber) ? panel.panelNumber : panelIndex + 1,
    })),
  }));

  return normalizeGraphicNovelPlan(
    {
      title: opts.approvedTitle || storyBible.title || chunkPlans[0]?.title || 'My Graphic Novel',
      tagline: chunkPlans[0]?.tagline || storyBible.tagline || '',
      pages: mergedPages,
    },
    { fallbackTitle: opts.approvedTitle || storyBible.title }
  );
}

async function repairGraphicNovelPlan(plan, storyBible, childDetails, opts = {}) {
  const {
    apiKeys,
    costTracker,
    bookContext,
  } = opts;
  const {
    GRAPHIC_NOVEL_REPAIR_SYSTEM,
    GRAPHIC_NOVEL_REPAIR_USER,
  } = require('../prompts/graphicNovelCritic');
  const summary = summarizeGraphicNovelStructure(plan);
  bookContext?.log('warn', 'Repairing invalid graphic novel plan', summary);
  const resp = await callLLM(
    GRAPHIC_NOVEL_REPAIR_SYSTEM,
    GRAPHIC_NOVEL_REPAIR_USER(plan, summary.issues, compactGraphicNovelStoryBible(storyBible)),
    {
      openaiApiKey: apiKeys?.OPENAI_API_KEY,
      costTracker,
      temperature: 0.45,
      maxTokens: 24000,
      jsonMode: true,
      timeoutMs: GRAPHIC_NOVEL_FULL_PLAN_TIMEOUT_MS,
      requestLabel: 'Graphic novel repair pass',
    }
  );
  const repairedParsed = await parseStructuredJsonWithFallback(
    resp,
    GRAPHIC_NOVEL_REPAIR_SYSTEM,
    GRAPHIC_NOVEL_REPAIR_USER(plan, summary.issues, compactGraphicNovelStoryBible(storyBible)),
    {
      costTracker,
      temperature: 0.45,
      maxTokens: 24000,
      bookContext,
      timeoutMs: GRAPHIC_NOVEL_FULL_PLAN_TIMEOUT_MS,
      requestLabel: 'Graphic novel repair pass',
    }
  );
  const repaired = legacyGraphicNovelScenesToPages(repairedParsed, childDetails);
  return repaired;
}

async function parseStructuredJsonWithFallback(resp, systemPrompt, userPrompt, opts = {}) {
  try {
    const parsed = parseJsonObjectFromText(resp.text, resp.finishReason);

    // Detect truncation: valid JSON but empty content due to token limit
    if (resp.finishReason === 'MAX_TOKENS') {
      const pageCount = Array.isArray(parsed.pages) ? parsed.pages.length : 0;
      const sceneCount = Array.isArray(parsed.scenes) ? parsed.scenes.length : 0;
      opts.bookContext?.log('warn', 'LLM response hit MAX_TOKENS — output may be truncated', {
        finishReason: resp.finishReason,
        model: resp.model,
        outputTokens: resp.outputTokens,
        parsedPages: pageCount,
        parsedScenes: sceneCount,
      });
      if (pageCount === 0 && sceneCount === 0) {
        throw new Error('LLM hit token limit (MAX_TOKENS) and produced no pages or scenes — likely truncated');
      }
    }

    return parsed;
  } catch (parseErr) {
    if (resp?.model !== 'gpt-5.4') throw parseErr;
    opts.bookContext?.log('warn', 'GPT returned malformed JSON for graphic novel stage, retrying with Gemini', {
      error: parseErr.message,
    });
    const geminiResp = await callGeminiText(systemPrompt, userPrompt, {
      maxOutputTokens: opts.maxTokens || 8000,
      temperature: opts.temperature || 0.8,
      responseMimeType: 'application/json',
      timeoutMs: opts.timeoutMs,
      requestLabel: opts.requestLabel ? `${opts.requestLabel} Gemini fallback` : 'Gemini fallback',
    });
    if (opts.costTracker) {
      opts.costTracker.addTextUsage(GEMINI_MODEL, geminiResp.inputTokens, geminiResp.outputTokens);
    }
    return parseJsonObjectFromText(geminiResp.text, geminiResp.finishReason);
  }
}

function legacyGraphicNovelScenesToPages(plan, childDetails = {}) {
  if (Array.isArray(plan.pages) && plan.pages.length) return plan;
  if (!Array.isArray(plan.scenes)) return plan;

  const CAPACITY = {
    splash: 1,
    'strip+2': 3,
    '1large+2small': 3,
    '3equal': 3,
    '2equal': 2,
    '4equal': 4,
  };
  const LAYOUT_TO_TEMPLATE = {
    splash: 'fullBleedSplash',
    'strip+2': 'cinematicTopStrip',
    '1large+2small': 'heroTopTwoBottom',
    '2equal': 'twoTierEqual',
    '3equal': 'conversationGrid',
    '4equal': 'fourGrid',
  };

  const allPanels = plan.scenes.flatMap((scene) => (scene.panels || []).map((panel) => ({
    ...panel,
    sceneNumber: scene.number,
    sceneTitle: scene.sceneTitle,
  })));

  const pages = [];
  let idx = 0;
  while (idx < allPanels.length) {
    const first = allPanels[idx];
    const pageLayout = first.pageLayout || '3equal';
    const cap = CAPACITY[pageLayout] || 3;
    const group = allPanels.slice(idx, idx + cap);
    pages.push({
      pageNumber: pages.length + 1,
      sceneNumber: first.sceneNumber || 1,
      sceneTitle: first.sceneTitle || `Scene ${first.sceneNumber || 1}`,
      pagePurpose: group[0]?.action || '',
      pageTurnIntent: 'question',
      dominantBeat: group[group.length - 1]?.action || '',
      layoutTemplate: LAYOUT_TO_TEMPLATE[pageLayout] || 'conversationGrid',
      panelCount: group.length,
      textDensity: 'medium',
      colorScript: {},
      panels: group.map((panel, panelIndex) => ({
        ...panel,
        panelNumber: panel.panelNumber || panelIndex + 1,
        balloons: panel.dialogue ? [{
          id: `p${pages.length + 1}b${panelIndex + 1}`,
          type: 'speech',
          speaker: childDetails?.name || childDetails?.childName || 'hero',
          text: panel.dialogue,
          order: 1,
          anchor: panel.speakerPosition || 'left',
        }] : [],
        captions: panel.caption ? [{
          id: `p${pages.length + 1}c${panelIndex + 1}`,
          type: 'narration',
          text: panel.caption,
          placement: 'top-band',
        }] : [],
        textFreeZone: panel.caption ? 'upper-band' : 'top-right',
        safeTextZones: panel.caption ? ['upper-band'] : ['top-right'],
        shot: panel.panelType === 'establishing' ? 'WS' : panel.panelType === 'closeup' ? 'CU' : 'MS',
        cameraAngle: 'eye-level',
        pacing: panel.panelType === 'action' ? 'fast' : 'medium',
        actingNotes: '',
        backgroundComplexity: panel.panelType === 'closeup' ? 'minimal' : 'simple',
      })),
    });
    idx += group.length;
  }

  return { ...plan, pages };
}

async function planGraphicNovel(childDetails, theme, customDetails, opts = {}) {
  const { apiKeys, costTracker, approvedTitle, bookContext, parentBookTitle, parentStoryContent, additionalCoverCharacters } = opts;
  const {
    GRAPHIC_NOVEL_PLANNER_SYSTEM,
    GRAPHIC_NOVEL_STORY_BIBLE_SYSTEM,
    GRAPHIC_NOVEL_STORY_BIBLE_USER,
    GRAPHIC_NOVEL_PLANNER_USER,
  } = require('../prompts/graphicNovel');
  const { GRAPHIC_NOVEL_CRITIC_SYSTEM, GRAPHIC_NOVEL_CRITIC_USER } = require('../prompts/graphicNovelCritic');
  const { normalizeGraphicNovelPlan, summarizeGraphicNovelIssues } = require('./graphicNovelQa');

  // Brainstorm seed + enrich custom details + select narrative patterns in parallel
  let seed;
  let enrichedCustomDetails;
  let narrativePatterns;
  const gnChildAge = childDetails.childAge || childDetails.age || 8;
  try {
    const [seedResult, enrichedResult, patternsResult] = await Promise.all([
      brainstormStorySeed(childDetails, customDetails || '', approvedTitle, { apiKeys, costTracker, theme, additionalCoverCharacters })
        .catch(e => {
          bookContext?.log('warn', 'Graphic novel seed brainstorm failed', { error: e.message });
          return { repeated_phrase: '', favorite_object: customDetails || 'a map', fear: 'failing', setting: 'the city' };
        }),
      enrichCustomDetails(customDetails, childDetails.childName || childDetails.name, gnChildAge,
        (childDetails.childInterests || childDetails.interests || []).filter(Boolean)),
      selectNarrativePatterns({
        story_type: 'graphic_novel',
        age: gnChildAge,
        goal: theme,
        setting: '',
        tone: 'playful',
      }, { costTracker, apiKeys }).catch(err => {
        bookContext?.log('warn', 'Graphic novel narrative pattern selection failed', { error: err.message });
        return null;
      }),
    ]);
    seed = seedResult;
    enrichedCustomDetails = enrichedResult;
    narrativePatterns = patternsResult;
  } catch (e) {
    bookContext?.log('warn', 'Graphic novel seed/enrich failed', { error: e.message });
    seed = { repeated_phrase: '', favorite_object: customDetails || 'a map', fear: 'failing', setting: 'the city' };
    enrichedCustomDetails = customDetails || '';
    narrativePatterns = null;
  }

  // Build parent story section if a parent picture book was provided
  let parentStorySection = '';
  if (parentStoryContent) {
    const origTitle = parentStoryContent.title || '';
    const texts = (parentStoryContent.entries || [])
      .map(e => e.text || [e.left?.text, e.right?.text].filter(Boolean).join(' ') || '')
      .filter(t => t.trim())
      .join(' ');
    if (origTitle || texts) {
      parentStorySection = `\n\nORIGINAL PICTURE BOOK (this graphic novel MUST be a comic-format adaptation of this exact story — same world, same characters, same arc):\nTitle: "${origTitle}"\nStory: ${texts}`;
    }
  }

  const titleInstruction = parentBookTitle
    ? `\n\nIMPORTANT: The book title MUST be exactly: "${parentBookTitle}". Do not invent a new title.`
    : '';

  // Family member constraint for graphic novel story bible
  let familyConstraint = '';
  if (theme === 'mothers_day') {
    familyConstraint = additionalCoverCharacters
      ? `\n\n⚠️ MOTHER'S DAY OVERRIDE: Mom is a co-protagonist. She MUST appear in scenes and illustration prompts frequently. Additionally, the uploaded photo contains a secondary person:\n${additionalCoverCharacters}\nOnly Mom and the secondary character(s) listed above are allowed in illustrations — do NOT invent any other family members.`
      : `\n\n⚠️ MOTHER'S DAY OVERRIDE: Mom is a co-protagonist. She MUST appear in scenes and illustration prompts frequently — but with IMPLIED PRESENCE ONLY (no face). We have NO reference image for Mom. She is FEMALE (a woman). Her face must NEVER be shown in illustrations. Show her through: back view, hands, arms, silhouette, side view with face turned away, or cropped at frame edge. NEVER describe her facial features. Other family members (siblings, grandparents, dad) must NOT appear in illustrations — text only.`;
  } else if (theme === 'fathers_day') {
    familyConstraint = additionalCoverCharacters
      ? `\n\n⚠️ FATHER'S DAY OVERRIDE: Dad is a co-protagonist. He MUST appear in scenes and illustration prompts frequently. Additionally, the uploaded photo contains a secondary person:\n${additionalCoverCharacters}\nOnly Dad and the secondary character(s) listed above are allowed in illustrations — do NOT invent any other family members.`
      : `\n\n⚠️ FATHER'S DAY OVERRIDE: Dad is a co-protagonist. He MUST appear in scenes and illustration prompts frequently — but with IMPLIED PRESENCE ONLY (no face). We have NO reference image for Dad. He is MALE (a man). His face must NEVER be shown in illustrations. Show him through: back view, hands, arms, silhouette, side view with face turned away, or cropped at frame edge. NEVER describe his facial features. Other family members (siblings, grandparents, mom) must NOT appear in illustrations — text only.`;
  } else if (additionalCoverCharacters) {
    familyConstraint = `\n\n⚠️ COVER PHOTO OVERRIDE: The uploaded photo contains a secondary person (e.g. a parent/family member). This overrides the "no family in illustrations" rule for THIS book only. The following secondary character IS allowed in illustrations and must appear consistently:\n${additionalCoverCharacters}\nWrite their description into illustration prompts whenever they appear naturally in the scene. Do NOT invent other family members beyond what is listed above.`;
  } else {
    familyConstraint = `\n\nILLUSTRATION CONSTRAINT — NO FAMILY MEMBERS IN IMAGES:\nStory text MAY mention family members by name. However, family members must NEVER appear as visible characters in illustrations — we only have the child's photo. Design scenes so they center the child visually. Family presence should be implied (a warm light, a voice, a hand at the edge of frame) — never a full face or body.`;
  }

  // Inject narrative pattern awareness into story bible prompt
  const storyBiblePatternBlock = formatPatternsForStoryBible(narrativePatterns);
  const storyBiblePrompt = GRAPHIC_NOVEL_STORY_BIBLE_USER(childDetails, theme, enrichedCustomDetails, seed) + parentStorySection + titleInstruction + familyConstraint + storyBiblePatternBlock;

  let storyBible;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await callLLM(GRAPHIC_NOVEL_STORY_BIBLE_SYSTEM, storyBiblePrompt, {
        openaiApiKey: apiKeys?.OPENAI_API_KEY,
        costTracker,
        temperature: 0.75,
        maxTokens: 8000,
        jsonMode: true,
        timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
        requestLabel: `Graphic novel story bible attempt ${attempt}`,
      });
      storyBible = await parseStructuredJsonWithFallback(resp, GRAPHIC_NOVEL_STORY_BIBLE_SYSTEM, storyBiblePrompt, {
        costTracker,
        temperature: 0.75,
        maxTokens: 8000,
        bookContext,
        timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
        requestLabel: `Graphic novel story bible attempt ${attempt}`,
      });
      if (!storyBible.title) throw new Error('Story bible missing title');
      bookContext?.touchActivity?.();
      break;
    } catch (e) {
      bookContext?.touchActivity?.();
      bookContext?.log('warn', `Graphic novel story bible attempt ${attempt} failed: ${e.message}`);
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }

  // Go straight to chunked planner — more reliable than generating
  // the entire 24-32 page plan in a single LLM call, which consistently
  // hits token limits, connection timeouts, or produces malformed JSON.
  let plan = await planGraphicNovelByChunks(
    childDetails,
    theme,
    enrichedCustomDetails,
    seed,
    storyBible,
    {
      apiKeys,
      costTracker,
      approvedTitle,
      bookContext,
      narrativePatterns,
    }
  );

  // Critic pass removed — it consistently fails for large graphic novel plans
  // (same token/timeout issues as the old full-plan approach) and adds 6+ minutes
  // of dead time. The chunked planner already validates each chunk independently.

  plan.storyBible = storyBible;
  if (narrativePatterns) plan._narrativePatterns = narrativePatterns;
  plan.storyBlueprint = storyBible.sceneBlueprints || [];
  plan.title = approvedTitle || plan.title || storyBible.title;
  plan.isGraphicNovel = true;
  plan.graphicNovelVersion = 'v2_premium';

  const issues = summarizeGraphicNovelIssues(plan, storyBible);
  if (issues.length > 0) {
    plan.qaSummary = { issues };
  }

  // Carry forward character details from seed
  plan.characterDescription = seed.characterDescription || null;
  plan.characterAnchor = seed.characterAnchor || null;
  plan.characterOutfit = seed.characterOutfit || null;
  plan.recurringElement = seed.favorite_object || null;
  plan.keyObjects = seed.keyObjects || null;
  if (additionalCoverCharacters) {
    plan.additionalCoverCharacters = additionalCoverCharacters;
  }

  bookContext?.log('info', 'Graphic novel plan created', {
    title: plan.title,
    scenes: plan.scenes.length,
    pages: plan.pages.length,
    panels: plan.allPanels.length,
  });

  return plan;
}

module.exports = { planStory, polishStory, brainstormStorySeed, validateStoryText, combinedCritic, polishEarlyReader, masterCritic, EMOTIONAL_THEMES, getEmotionalTier, planChapterBook, polishChapterBook, planGraphicNovel };
