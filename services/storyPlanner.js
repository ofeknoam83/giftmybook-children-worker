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
const { getAgeTier, getEmotionalAgeTier } = require('../prompts/writerBrief');

const EMOTIONAL_THEMES = new Set(['anxiety', 'anger', 'fear', 'grief', 'loneliness', 'new_beginnings', 'self_worth', 'family_change']);

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
  const choice = data.choices?.[0];
  const finishReason = choice?.finish_reason === 'length' ? 'MAX_TOKENS' : (choice?.finish_reason || 'stop');
  return {
    text: choice?.message?.content || '',
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
   - Spread 1: The child wakes up — it's their birthday. Something feels different, magical, or surprising.
   - Spread 2: A birthday quest or surprise begins — something is missing, hidden, or has to be found/reached.
   - Spreads 3-4: The journey to find it — new locations, excitement building, friends or creatures along the way.
   - Spread 5: A wonderful discovery or first celebration moment.
   - Spread 6: THE HINGE — something goes wrong, almost ruins the celebration (lost item, wrong path, unexpected obstacle).
   - Spreads 7-8: The child fixes it — uses their favorite object or a new friend to turn it around.
   - Spreads 9-10: The celebration reaches its peak — wonder, joy, the moment they will remember.
   - Spread 11: Returning home, full of joy and birthday energy — the journey has made this moment even sweeter.
   - Spread 12: Everyone gathers. Something is coming. The room hushes. [visually silent, no text]
   - Spread 13: [ILLUSTRATION LOCKED] The birthday cake arrives. The child leans in cheeks puffed, about to blow out ${candleText} (either ${age} individual candles OR one numeral-"${age}" candle — no other count). This is what the whole day was building to.`;

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
   - Spread 12: Homecoming — visually silent.
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
   - Spread 12: Homecoming — visually silent.
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
   - Spread 12: Landing — visually silent.
   - Spread 13: Back in bed, stars through the window, carrying the universe inside.`;

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
   - Spread 12: Breaking the surface — visually silent.
   - Spread 13: On the shore or in bed, something from the deep still in hand.`;

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
   - Spread 12: Through the door — visually silent.
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
   - Spread 12: Arriving home — visually silent.
   - Spread 13: In bed, the sound of nature still outside. Connected.`;

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
   - Spread 12: Going home — visually silent.
   - Spread 13: In bed, something from the friend nearby. Not alone.`;

    default: // adventure, bedtime
      return `8. beats: An array of exactly 13 one-line descriptions — one per spread — mapping the emotional journey. Each beat must name the SPECIFIC LOCATION and the ACTION that happens there. Follow this structure:
   - Spreads 1-2: Setup (normal world → call to adventure, child leaves home)
   - Spreads 3-5: Rising action (new locations, each with its own obstacle)
   - Spread 6: THE HINGE — child is stuck, blocked, or almost fails (this is the most important beat — make it specific and tense)
   - Spreads 7-9: Breakthrough (child uses the favorite object or courage to overcome the hinge obstacle, victory builds)
   - Spreads 10-11: Resolution (final challenge solved, journey home begins)
   - Spread 12: Homecoming — visually silent, no text (child arrives home, changed)
   - Spread 13: Rest — settled, safe, the world feels bigger`;
  }
}

async function brainstormStorySeed(childDetails, customDetails, approvedTitle, opts = {}) {
  const { costTracker, apiKeys, theme } = opts;
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

You will receive details about a child and a THEME. The theme is NOT optional context — it is the structural backbone of the story. Every field you return must serve the theme.

THEME: ${theme || 'adventure'}

Return a JSON object with these fields:

1. favorite_object: A specific companion or object the child carries through the story. Draw from their interests — NOT a generic teddy bear unless the customer mentioned one. A toy dinosaur, a music box, rain boots, a jar of fireflies, a mini telescope, etc.

2. fear: The specific emotional challenge or obstacle the child must face IN THIS STORY. It must fit the theme — for birthday it might be "the celebration almost ruined", for space it's "lost between stars", for adventure it's a physical barrier. NOT always "the dark".

3. setting: A vivid, specific world matching the theme. One sentence describing the overall world (e.g. "a glittering undersea kingdom beneath the bay at the end of their street"). The beats will name the specific locations within it.

4. storySeed: One sentence describing the unique emotional journey. Must reflect the theme's arc.

5. emotional_core: One sentence for what the PARENT feels after reading. The emotional truth beyond the plot.

6. repeated_phrase: A short phrase (2-6 words) that repeats through the story and evolves. Must match the theme's energy — birthday phrases feel celebratory, bedtime phrases feel soothing, adventure phrases feel bold. NOT generic.

7. phrase_arc: Three short descriptions of how the phrase evolves:
   - early: how it feels the first time
   - middle: how it shifts
   - end: how it lands

${beatStructure}

MANDATORY PERSONALIZATION:
If the customer provided specific details (a real person, a specific place, a family quirk, a pet's name, a real fear), these MUST appear concretely in the beats. Do not treat them as optional flavor. Weave them into the specific locations and actions.

ILLUSTRATION CONSTRAINT — NO FAMILY MEMBERS IN IMAGES:
Story text MAY mention family members by name. However, family members must NEVER appear as visible characters in illustrations — we only have the child's photo. Design beats so scenes center the child visually.

Be ORIGINAL. The child's name, age, interests, and custom details must make this feel like it was written for exactly this child and no one else.

You MUST return ONLY a valid JSON object with: favorite_object, fear, setting, storySeed, emotional_core, repeated_phrase, phrase_arc, beats.`;

  const genderLabel = gender === 'male' ? 'boy' : gender === 'female' ? 'girl' : (gender && gender !== 'neutral' && gender !== 'not specified' ? gender : '');

  let userPrompt = `THEME: ${theme || 'adventure'}
Child: ${name}, age ${age}${genderLabel ? `, ${genderLabel}` : ''}
Interests: ${interests.length ? interests.join(', ') : 'not specified'}`;

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
        emotional_core: extractField('emotional_core') || '',
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
    return { favorite_object: 'a stuffed bear', fear: 'the dark', setting: 'a magical place', storySeed: '', emotional_core: '', repeated_phrase: '', phrase_arc: [], beats: [] };
  }

  if (!seed.emotional_core) seed.emotional_core = '';
  if (!seed.repeated_phrase) seed.repeated_phrase = '';
  if (!Array.isArray(seed.phrase_arc)) seed.phrase_arc = [];
  if (!Array.isArray(seed.beats)) seed.beats = [];

  console.log(`[storyPlanner] Story seed: object="${seed.favorite_object}", fear="${seed.fear}", setting="${seed.setting}"`);
  if (seed.emotional_core) console.log(`[storyPlanner] Emotional core: "${seed.emotional_core}"`);
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

  const systemPrompt = buildStoryWriterSystem(briefVars, theme);
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
  const beats = opts.beats || (v2Vars?.beats && Array.isArray(v2Vars.beats) ? v2Vars.beats : null);
  const userPrompt = STORY_STRUCTURER_USER(storyText, childDetails, v2Vars, beats);

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

  const visualOnly = spreads.filter(s => !s.left?.text || !s.right?.text);
  if (visualOnly.length < 2) {
    issues.push({ type: 'visual_spreads', message: `Only ${visualOnly.length} visual-only pages (need >=2)` });
  }

  if (spreads.length < 10) {
    issues.push({ type: 'spread_count', message: `Only ${spreads.length} spreads (need 10-13)` });
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
    console.warn(`[storyPlanner] Only ${spreads.length} spreads — expected 10-13`);
  }
  if (spreads.length > 13) {
    console.warn(`[storyPlanner] ${spreads.length} spreads — truncating to 13`);
    spreads = spreads.slice(0, 13).map((s, i) => ({ ...s, spread: i + 1 }));
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
    const jsonContent = await structureStoryPlan(storyText, childDetails, { ...opts, beats: v2Vars?.beats });
    const parsed = parseJsonPlan(jsonContent);

    // Override title if customer approved one
    if (approvedTitle) parsed.title = approvedTitle;

    const plan = normalizePlan(parsed, childDetails, opts);

    // Retry with single-call if spread count is too low
    const spreadCount = plan.entries.filter(e => e.type === 'spread').length;
    if (spreadCount < 10) {
      console.warn(`[storyPlanner] Only ${spreadCount} spreads from two-phase — retrying with single-call`);
      const retryParsed = await planStorySingleCall(childDetails, theme, bookFormat, customDetails, opts);
      return normalizePlan(retryParsed, childDetails, opts);
    }

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
    try {
      const parsed = await planStorySingleCall(childDetails, theme, bookFormat, customDetails, opts);
      const plan = normalizePlan(parsed, childDetails, opts);
      const totalMs = Date.now() - pipelineStart;
      console.log(`[storyPlanner] Fallback single-call complete in ${totalMs}ms`);
      return plan;
    } catch (singleCallErr) {
      // Last resort: retry single-call forcing Gemini (no OpenAI key passed)
      // Gemini handles long JSON output reliably and returns proper finishReason
      console.warn(`[storyPlanner] Single-call also failed: ${singleCallErr.message} — retrying with Gemini only`);
      const parsed = await planStorySingleCall(childDetails, theme, bookFormat, customDetails, {
        ...opts,
        apiKeys: null, // forces Gemini path
      });
      const plan = normalizePlan(parsed, childDetails, opts);
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

2. Language Quality & Musicality
- Any generic phrases?
- Any replaceable sentences?
- Are there natural rhymes, near-rhymes, or internal rhymes woven in?
  (Not forced AABB — subtle, musical touches that make lines satisfying to read aloud.)
  Where a natural rhyme opportunity exists, use it. Where it would feel forced, skip it.

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

8. Memorable Line
- Is there at least one line in this story that a parent would want to repeat to their child outside of the book?
- A line that could be a reassurance, a small philosophy, or a fragment of lullaby?
- Score 1: No such line exists
- Score 5: A line exists but is generic ("everything will be okay")
- Score 8-10: The line is specific to THIS story, poetic, and feels like it belongs to this child

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
    "ending_quality": <1-10>,
    "memorable_line": <1-10>
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
  const { costTracker, apiKeys, theme } = opts;
  const openaiKey = apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  // Build a compact representation of just the text to rewrite
  const spreads = storyPlan.entries.filter(e => e.type === 'spread');
  const textMap = spreads.map(s => ({
    spread: s.spread,
    left: s.left?.text || null,
    right: s.right?.text || null,
  }));

  let systemPrompt = SELF_CRITIC_SYSTEM;
  if (theme === 'birthday') {
    systemPrompt += `\n\n⚠️ BIRTHDAY THEME EXCEPTION:\nThis is a BIRTHDAY story. The ending rules are DIFFERENT:\n- Do NOT soften the ending into a whisper or sleepy tone.\n- The final spread (spread 13) is the birthday cake/candles moment — the emotional climax the whole story earned.\n- The ending should feel warm, joyful, and celebratory — not quiet.\n- "Ending Quality" score should reward a triumphant, emotionally resonant birthday ending.\n- The ENDING UPGRADE rule does NOT apply — do not make the ending softer or more poetic. Make it warmer and more joyful if needed.`;
  }

  const userPrompt = `Here is the story to evaluate and improve (${spreads.length} spreads):\n\n${JSON.stringify(textMap)}`;

  console.log(`[storyPlanner] Starting self-critic + rewrite pass (${spreads.length} spreads, theme: ${theme || 'default'})...`);
  const polishStart = Date.now();

  const response = await callLLM(systemPrompt, userPrompt, {
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

// ── Rhythm & Simplicity Critic ──

const COMBINED_CRITIC_SYSTEM = `You are a world-class children's book editor. You review the story in ONE pass and fix everything at once.

Your job covers four areas. Evaluate ALL of them, then produce ONE set of improved spreads.

─────────────────────────────────────────
1. RHYTHM & READ-ALOUD (highest priority)
─────────────────────────────────────────
Read every line aloud in your head. Fix any line that:
- Stumbles, feels clunky, or is hard to say smoothly
- Has consecutive hard consonants creating tongue twisters
- Has words over 3 syllables (unless a name or meaningful invented word)
- Violates the 8–14 syllable preference per sentence
- Contains a forced or strained rhyme that bends the meaning

Rules for rhythm fixes:
- Keep fixes shorter or equal length to the original
- Maintain 8–14 syllables per sentence
- Every spread must have at least one short sentence (≤5 words) for contrast
- Near-rhymes and internal rhymes are always better than strained end-rhymes
- If a rhyme feels forced, drop it — the story always wins over the sound

─────────────────────────────────────────
2. EMOTIONAL ARC
─────────────────────────────────────────
Check:
- ESCALATION: Each spread slightly increases curiosity, movement, or wonder through the middle
- DOUBT MOMENT: There is a clear moment of uncertainty or tension in spreads 5–8
- ENDING: The final 2 spreads feel like a whisper — soft, resolved, dream-like (not a conclusion)

Fix weak spreads. Do NOT add new characters, events, or settings.

─────────────────────────────────────────
3. MEMORABLE LINE
─────────────────────────────────────────
Ensure at least ONE line exists that a parent would want to repeat to their child outside the book.
It should be specific to THIS child and THIS story — not generic.
If no such line exists, create one naturally within the existing story structure.

─────────────────────────────────────────
4. LANGUAGE QUALITY
─────────────────────────────────────────
- Replace any generic filler words: "very", "nice", "special", "magical", "wonderful", "beautiful" used as descriptors
- Replace any emotion-telling: "she felt scared", "he was happy" → show through action/sensation
- Sharpen one word per spread if a more specific/sensory word fits better
- Only reduce or maintain word count — never increase

─────────────────────────────────────────
RULES FOR ALL REWRITES
─────────────────────────────────────────
- Rewrite ONLY what genuinely needs it — if a line already works, leave it exactly as-is
- Do NOT change: plot, structure, characters, spread count, left/right assignments, null pages
- Quality bar: only return a rewrite if it is clearly better than the original
- The ending (spreads 12–13) must feel like settling into sleep — soft, not triumphant

Return JSON:
{
  "issues": [
    { "spread": 1, "area": "rhythm|arc|memorable|language", "line": "exact quote", "reason": "brief description" }
  ],
  "improved_spreads": [
    { "spread": 1, "left": "...", "right": "..." }
  ]
}

- Return ALL spreads in improved_spreads (unchanged spreads returned as-is)
- If left or right was null, keep it null
- issues array may be empty if the story is already strong`;

/**
 * Combined critic — rhythm, emotional arc, memorable line, language quality in one pass.
 * Replaces the three separate rhythm/arc/polish critics.
 */
async function combinedCritic(storyPlan, opts = {}) {
  const { costTracker, apiKeys, theme } = opts;
  const openaiKey = apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  const spreads = storyPlan.entries.filter(e => e.type === 'spread');
  const textMap = spreads.map(s => ({
    spread: s.spread,
    left: s.left?.text || null,
    right: s.right?.text || null,
  }));

  let systemPrompt = COMBINED_CRITIC_SYSTEM;
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

  return applyImprovedSpreads(storyPlan, result.improved_spreads || []);
}

module.exports = { planStory, polishStory, brainstormStorySeed, validateStoryText, combinedCritic, EMOTIONAL_THEMES, getEmotionalTier };
