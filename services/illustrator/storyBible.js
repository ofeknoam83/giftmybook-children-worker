/**
 * Illustrator V2 — Story Bible Builder
 *
 * Scans all spread prompts ONCE before illustration generation and extracts a
 * per-book "bible" of named secondary characters, locations, and recurring
 * objects with locked visual descriptions.
 *
 * The bible is injected (per-spread, matched by name) into every spread prompt
 * so secondary characters do not morph and settings do not shift illogically
 * between pages. It is also passed into cross-spread consistency QA so Vision
 * has a ground truth to compare against.
 *
 * A single Gemini Flash call — graceful fallback to an empty bible on error.
 */

const { GEMINI_QA_MODEL, CHAT_API_BASE, QA_TIMEOUT_MS } = require('./config');
const { fetchWithTimeout, getNextApiKey } = require('../illustrationGenerator');

/**
 * Build a story bible from all spread image prompts.
 *
 * @param {object} opts
 * @param {Array<{spreadPrompt: string, spreadText?: string}>} opts.spreadEntries
 * @param {string} [opts.childName] - To exclude the hero from secondary characters
 * @param {string} [opts.theme]
 * @param {object} [opts.costTracker]
 * @returns {Promise<{
 *   characters: Array<{name: string, description: string}>,
 *   locations: Array<{name: string, description: string}>,
 *   objects: Array<{name: string, description: string}>,
 * }>}
 */
async function buildStoryBible(opts) {
  const { spreadEntries, childName, theme, costTracker } = opts || {};
  const empty = { characters: [], locations: [], objects: [] };
  if (!Array.isArray(spreadEntries) || spreadEntries.length === 0) return empty;

  const apiKey = getNextApiKey();
  if (!apiKey) return empty;

  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;

  const joinedPrompts = spreadEntries
    .map((s, i) => `--- Spread ${i + 1} ---\n${(s.spreadPrompt || '').slice(0, 1200)}${s.spreadText ? `\n(text: ${s.spreadText.slice(0, 300)})` : ''}`)
    .join('\n\n');

  const systemText = `You are an illustration continuity editor for a children's picture book. You will be given the scene prompts for all spreads of one book. Your job is to build a "story bible" — a short, locked visual description of every named secondary character, every location, and every recurring object that appears across the book.

RULES:
- The main child (the hero the book is about) is "${childName || 'the child'}" — DO NOT list the hero in characters. Only secondary characters.
- Theme: ${theme || 'unspecified'}.
- CHARACTERS: only include entities that are NAMED or clearly recurring (a talking fox, "Luna the rabbit", "Grandma", "the mapmaker"). Skip one-off crowd extras. Never invent names not present in the prompts.
- For each character, give a SINGLE locked visual description (species/type, age range if human, hair color/style, skin tone, outfit color + kind, distinguishing features). Keep it under 30 words. This description will be reused on every page the character appears on, so it must be concrete and unambiguous.
- LOCATIONS: list distinct places the story visits (e.g. "Ember Hill", "the toy shop", "the kitchen"). One locked description each (time of day baseline, dominant colors, key landmarks). Under 30 words.
- OBJECTS: list recurring meaningful objects (a golden acorn, a red kite). Skip background props.
- Match descriptions to what the prompts already suggest — do NOT contradict them. Where prompts are vague, pick a specific choice and lock it.
- If the prompts do not clearly reference a category, return an empty array for that category.

Return ONLY valid JSON with this exact shape:
{
  "characters": [{"name": "...", "description": "..."}],
  "locations":  [{"name": "...", "description": "..."}],
  "objects":    [{"name": "...", "description": "..."}]
}`;

  const userText = `Here are the illustration prompts for all ${spreadEntries.length} spreads of this book:\n\n${joinedPrompts}\n\nBuild the story bible now. Return ONLY the JSON object.`;

  try {
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { role: 'system', parts: [{ text: systemText }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1500,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }, QA_TIMEOUT_MS);

    if (costTracker) costTracker.addTextUsage(GEMINI_QA_MODEL, 1200, 600);
    if (!resp.ok) return empty;

    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const cleaned = text.replace(/```json\s*/i, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return empty;
    const parsed = JSON.parse(match[0]);
    const bible = {
      characters: _sanitizeList(parsed.characters, childName),
      locations: _sanitizeList(parsed.locations, null),
      objects: _sanitizeList(parsed.objects, null),
    };
    return bible;
  } catch (err) {
    console.warn(`[illustrator/storyBible] Build failed: ${err.message} — continuing without bible`);
    return empty;
  }
}

function _sanitizeList(list, excludeName) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  const excludeLower = excludeName ? excludeName.toLowerCase() : null;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = (item.name || '').toString().trim();
    const description = (item.description || '').toString().trim();
    if (!name || !description) continue;
    const nameLower = name.toLowerCase();
    if (excludeLower && nameLower === excludeLower) continue;
    if (seen.has(nameLower)) continue;
    seen.add(nameLower);
    out.push({ name, description: description.slice(0, 240) });
  }
  return out.slice(0, 20);
}

/**
 * Given a story bible and a specific spread prompt + text, return only the
 * entries whose names are mentioned in this spread (case-insensitive whole-word match).
 * Used to inject per-spread continuity reminders without bloating every prompt.
 */
function selectBibleEntriesForSpread(bible, spreadPrompt, spreadText) {
  if (!bible) return { characters: [], locations: [], objects: [] };
  const haystack = `${spreadPrompt || ''} ${spreadText || ''}`.toLowerCase();
  const pick = (list) => (list || []).filter((entry) => {
    if (!entry?.name) return false;
    const needle = entry.name.toLowerCase();
    // Match as a word (avoid matching "a" inside other words).
    const re = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return re.test(haystack);
  });
  return {
    characters: pick(bible.characters),
    locations: pick(bible.locations),
    objects: pick(bible.objects),
  };
}

/**
 * Render the per-spread bible section as a prompt string. Returns empty string
 * when nothing in the spread matches the bible.
 */
function renderBibleSection(selected) {
  if (!selected) return '';
  const lines = [];
  if (selected.characters?.length) {
    lines.push('### STORY BIBLE — CHARACTERS (continuity is mandatory)');
    lines.push('Every character below MUST look EXACTLY as described. Same appearance on every spread they appear on:');
    selected.characters.forEach((c) => lines.push(`- ${c.name}: ${c.description}`));
  }
  if (selected.locations?.length) {
    if (lines.length) lines.push('');
    lines.push('### STORY BIBLE — LOCATIONS (continuity is mandatory)');
    lines.push('When this spread takes place in one of these named locations, the setting MUST match the locked description:');
    selected.locations.forEach((l) => lines.push(`- ${l.name}: ${l.description}`));
  }
  if (selected.objects?.length) {
    if (lines.length) lines.push('');
    lines.push('### STORY BIBLE — OBJECTS');
    lines.push('Recurring objects in this book MUST look the same every time they appear:');
    selected.objects.forEach((o) => lines.push(`- ${o.name}: ${o.description}`));
  }
  return lines.join('\n');
}

module.exports = { buildStoryBible, selectBibleEntriesForSpread, renderBibleSection };
