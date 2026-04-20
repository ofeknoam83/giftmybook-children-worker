/**
 * Game Dialogue Generator (M2)
 *
 * Uses OpenAI chat completions (JSON mode) to produce a per-book dialogue
 * line map covering every recipe in the sandbox + idle chatter for each NPC.
 *
 * Input:  { bookId, narrative, recipeIds, npcKinds }
 * Output: { dialogues: { [lineId]: { text, speaker } }, tookMs }
 *
 * Callers cache the `dialogues` payload on the book row (gameDialogueJson)
 * so repeat fetches are free.
 */

'use strict';

const DEFAULT_MODEL = process.env.OPENAI_DIALOGUE_MODEL || 'gpt-4o-mini';

// The full recipe list the caller may pass in. We default to a known pool so
// the worker stays useful even when the client is out of sync.
const DEFAULT_RECIPE_IDS = [
  'eat_apple', 'eat_banana', 'eat_bread', 'eat_cupcake', 'eat_pizza',
  'drink_milk', 'drink_juice',
  'teddy_on_character', 'teddy_on_bed',
  'pillow_on_bed',
  'water_plant',
  'ball_on_character',
  'duck_on_bath', 'toothbrush_on_character',
  'apple_on_pot', 'bread_on_stove',
  'chef_hat_on_character', 'pizza_to_character',
  'swing_use', 'slide_use', 'shovel_on_sandbox',
  'open_present', 'cake_on_character', 'wear_party_hat', 'pop_balloon',
  'read_storybook', 'hug_teddy_special',
  'smell_bouquet', 'read_card', 'read_letter',
  'paint_easel', 'play_music_note',
];

const DEFAULT_NPC_KINDS = ['mom', 'cat'];

/**
 * Build the system + user prompts. Kept short so token usage is minimal.
 */
function buildMessages(narrative, recipeIds, npcKinds) {
  const childName = narrative?.childName || 'the child';
  const momName   = narrative?.momName   || 'Mom';
  const dadName   = narrative?.dadName   || null;
  const pet       = narrative?.pet?.kind || null;
  const theme     = narrative?.theme || 'adventure_play';
  const age       = narrative?.childAge || 5;

  const sys = [
    'You write warm, age-appropriate one-sentence dialogue lines for a toddler/preschool sandbox game.',
    'Every line must be SHORT (max 10 words), spoken by the given speaker, and appropriate for ages 3-7.',
    'Never include the child\'s age, parental instructions, product names, brands, or emoji.',
    'If the speaker is a pet or a non-speaking object, use onomatopoeia ("Meow!", "Woof!") or a simple cheer.',
    'Return ONLY valid JSON matching the requested shape; no prose, no preamble, no code fences.',
  ].join('\n');

  const context = {
    childName,
    childAge: age,
    momName,
    dadName,
    pet,
    theme,
    openingLine: narrative?.openingLine || null,
  };

  const user = [
    `Write one dialogue line per interaction id below, plus 5 idle-chatter lines per NPC.`,
    `Context: ${JSON.stringify(context)}`,
    `Interaction ids (each must be a key):`,
    recipeIds.map(id => `- ${id}`).join('\n'),
    `NPC kinds (write idle_<kind>_1..5 for each):`,
    npcKinds.map(k => `- ${k}`).join('\n'),
    `Also produce:`,
    `- "opening": a single narrator line welcoming ${childName} (<= 10 words)`,
    `- "closing": a single narrator line for bedtime (<= 10 words)`,
    ``,
    `Output shape:`,
    `{`,
    `  "dialogues": {`,
    `    "<lineId>": { "text": "<<=10 words>", "speaker": "child"|"mom"|"dad"|"narrator"|"cat"|"dog"|"bunny" }`,
    `  }`,
    `}`,
    ``,
    `Rules:`,
    `- "speaker" must be one of child, mom, dad, narrator, cat, dog, bunny, sibling.`,
    `- "eat_*", "drink_*", "open_*", "wear_*", "hug_*", "read_*", "play_*", "paint_*", "smell_*" → speaker: child.`,
    `- "idle_mom_*" → speaker: mom. "idle_dad_*" → speaker: dad.`,
    `- "idle_cat_*" / "idle_dog_*" / "idle_bunny_*" → that pet speaker with onomatopoeia.`,
    `- "opening" + "closing" → speaker: narrator.`,
    `- Address ${childName} by name in at least 30% of lines.`,
    `- Keep tone warm, silly, playful, never didactic.`,
  ].join('\n');

  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

async function callOpenAIJson({ messages, timeoutMs = 30000 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages,
        temperature: 0.8,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(t);
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`OpenAI ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || '';
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error(`Dialogue JSON parse failed: ${e.message} / ${content.slice(0, 200)}`);
  }
}

/**
 * @param {object} input
 * @param {string} input.bookId
 * @param {object} [input.narrative]
 * @param {string[]} [input.recipeIds]
 * @param {string[]} [input.npcKinds]
 * @returns {Promise<{dialogues:object, tookMs:number}>}
 */
async function generateGameDialogue(input) {
  const started = Date.now();
  const bookId = input?.bookId;
  if (!bookId) throw new Error('bookId is required');

  const narrative = input?.narrative || {};
  const recipeIds = Array.isArray(input?.recipeIds) && input.recipeIds.length
    ? Array.from(new Set(input.recipeIds.map(String))).slice(0, 80)
    : DEFAULT_RECIPE_IDS;
  const npcKinds = Array.isArray(input?.npcKinds) && input.npcKinds.length
    ? Array.from(new Set(input.npcKinds.map(String))).slice(0, 6)
    : DEFAULT_NPC_KINDS;

  const messages = buildMessages(narrative, recipeIds, npcKinds);
  const parsed = await callOpenAIJson({ messages });

  const dialogues = (parsed && typeof parsed === 'object' && parsed.dialogues) || {};
  // Defensive: clamp text length + restrict speakers.
  const ALLOWED = new Set(['child', 'mom', 'dad', 'narrator', 'cat', 'dog', 'bunny', 'sibling']);
  const out = {};
  for (const [lineId, entry] of Object.entries(dialogues)) {
    if (!entry || typeof entry !== 'object') continue;
    const text = String(entry.text || '').trim().slice(0, 140);
    const speaker = ALLOWED.has(entry.speaker) ? entry.speaker : 'narrator';
    if (text) out[lineId] = { text, speaker };
  }

  return { dialogues: out, tookMs: Date.now() - started };
}

module.exports = { generateGameDialogue, DEFAULT_RECIPE_IDS, DEFAULT_NPC_KINDS };
