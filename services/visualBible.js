/**
 * Visual Story Bible generator.
 *
 * Generates a locked visual reference document for a book's illustrations.
 * Called once after story planning, before illustration generation.
 * The bible defines color palette, lighting arc, recurring environment details,
 * and canonical object descriptions — ensuring visual continuity across all spreads.
 */

const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * @param {string} url
 * @param {object} init
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => { didTimeout = true; controller.abort(); }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (didTimeout) throw new Error(`Visual bible request timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const VISUAL_BIBLE_SYSTEM = `You are a visual director for a children's picture book. Given the story text and illustration prompts for every spread, you produce a VISUAL STORY BIBLE — a locked reference document that ensures every illustration feels like it belongs in the same book.

OUTPUT FORMAT — respond with EXACTLY these labeled sections and nothing else:

COLOR_PALETTE:
List 5-6 dominant colors for the entire book (e.g., "warm coral, soft sage green, buttery gold, deep teal, creamy white"). These should feel cohesive and age-appropriate.

LIGHTING_ARC:
For each spread, describe the lighting in 5-8 words (e.g., "Spread 1: soft morning gold through curtains"). The lighting should progress naturally through the story — matching the emotional arc (e.g., warm and bright for joy, muted for tension, radiant for triumph).

RECURRING_ENVIRONMENTS:
For each unique location that appears more than once, write a CANONICAL DESCRIPTION (3-4 sentences). Include: wall/floor/ground colors, key furniture or landscape features, distinctive details (a specific pattern, a particular tree shape, a notable object). These descriptions are LOCKED — every spread set in this location must match.

RECURRING_OBJECTS:
For EACH recurring object (favorite toy, companion animal, special item), write ONE locked visual description (1-2 sentences). Include exact colors, size relative to the child, material/texture, and any distinctive marks. This description is used VERBATIM in every illustration prompt.

CAMERA_PLAN:
For each spread, specify the shot type in 3-5 words. Use a deliberate MIX: wide establishing shots, medium action shots, close-up emotional shots, over-shoulder views. Never use the same shot type for 3 consecutive spreads.

TEXT_ZONES:
For each spread, specify where embedded text should go (e.g., "upper-left over sky", "bottom-center over grass", "upper-right over wall"). Alternate positions across spreads for visual variety. Choose areas likely to have simple, low-detail backgrounds based on the scene description.

RULES:
- The palette must feel unified — no jarring color shifts between spreads unless the story demands it
- Lighting shifts must be GRADUAL (no jumping from sunset to noon between consecutive spreads)
- Every recurring object/location must be described specifically enough that an illustrator could draw it identically each time
- Camera variety is mandatory — the reader should feel like they're moving through the world, not seeing the same framing repeated`;

/**
 * Generate a Visual Story Bible from the story plan.
 *
 * @param {object} storyPlan - Full story plan with entries
 * @param {object} childDetails - { name, age, gender }
 * @param {object} [opts] - { costTracker, bookContext }
 * @returns {Promise<object>} Parsed bible sections
 */
async function generateVisualBible(storyPlan, childDetails, opts = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[visualBible] No GEMINI_API_KEY — skipping visual bible generation');
    return null;
  }

  const entries = storyPlan.entries || [];
  const spreads = entries.filter(e => e.type === 'spread');
  if (spreads.length === 0) return null;

  // Build the user prompt with all spread info
  const spreadSummaries = spreads.map((entry, i) => {
    const text = [entry.left?.text, entry.right?.text].filter(Boolean).join(' ');
    const prompt = entry.spread_image_prompt || entry.left?.image_prompt || '';
    return `Spread ${i + 1}:\n  TEXT: ${text}\n  ILLUSTRATION PROMPT: ${prompt}`;
  }).join('\n\n');

  const userPrompt = `BOOK TITLE: ${storyPlan.title || 'Untitled'}
CHILD: ${childDetails.name || 'the child'}, age ${childDetails.age || 5}, ${childDetails.gender || 'unknown gender'}
CHARACTER DESCRIPTION: ${storyPlan.characterDescription || 'not specified'}
CHARACTER OUTFIT: ${storyPlan.characterOutfit || 'not specified'}
RECURRING ELEMENT: ${storyPlan.recurringElement || 'none'}
KEY OBJECTS: ${storyPlan.keyObjects || 'none'}
ART STYLE: ${storyPlan.coverArtStyle || 'cinematic 3D Pixar-like'}
TOTAL SPREADS: ${spreads.length}

STORY SPREADS:
${spreadSummaries}

Generate the Visual Story Bible for this book. Ensure the color palette complements the art style and the lighting arc matches the emotional journey.`;

  const body = {
    systemInstruction: { parts: [{ text: VISUAL_BIBLE_SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 3000,
    },
  };

  try {
    const resp = await fetchWithTimeout(
      `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      60000
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.warn(`[visualBible] Gemini API failed: ${resp.status} ${errText.slice(0, 200)}`);
      return null;
    }

    const result = await resp.json();
    const rawText = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const inputTokens = result.usageMetadata?.promptTokenCount || 0;
    const outputTokens = result.usageMetadata?.candidatesTokenCount || 0;

    if (opts.costTracker) {
      opts.costTracker.addLLMCall('gemini-3-flash-preview', inputTokens, outputTokens);
    }

    if (opts.bookContext) {
      opts.bookContext.log('info', 'Visual Story Bible generated', { inputTokens, outputTokens, length: rawText.length });
    }

    return parseBible(rawText, spreads.length);
  } catch (err) {
    console.warn(`[visualBible] Failed to generate visual bible: ${err.message}`);
    if (opts.bookContext) {
      opts.bookContext.log('warn', 'Visual Story Bible generation failed (non-blocking)', { error: err.message });
    }
    return null;
  }
}

/**
 * Parse the raw bible text into structured sections.
 *
 * @param {string} rawText - Raw LLM output
 * @param {number} spreadCount - Number of spreads
 * @returns {object} { colorPalette, lightingArc, recurringEnvironments, recurringObjects, cameraPlan, textZones, raw }
 */
function parseBible(rawText, spreadCount) {
  const sections = {};
  const sectionNames = ['COLOR_PALETTE', 'LIGHTING_ARC', 'RECURRING_ENVIRONMENTS', 'RECURRING_OBJECTS', 'CAMERA_PLAN', 'TEXT_ZONES'];

  for (let i = 0; i < sectionNames.length; i++) {
    const name = sectionNames[i];
    const nextName = sectionNames[i + 1];
    const pattern = nextName
      ? new RegExp(`${name}[:\\s]+([\\s\\S]*?)(?=${nextName}[:\\s])`, 'i')
      : new RegExp(`${name}[:\\s]+([\\s\\S]*)$`, 'i');
    const match = rawText.match(pattern);
    sections[name] = match ? match[1].trim() : '';
  }

  // Parse per-spread fields into arrays
  const lightingArc = parsePerSpread(sections.LIGHTING_ARC, spreadCount);
  const cameraPlan = parsePerSpread(sections.CAMERA_PLAN, spreadCount);
  const textZones = parsePerSpread(sections.TEXT_ZONES, spreadCount);

  return {
    colorPalette: sections.COLOR_PALETTE,
    lightingArc,
    recurringEnvironments: sections.RECURRING_ENVIRONMENTS,
    recurringObjects: sections.RECURRING_OBJECTS,
    cameraPlan,
    textZones,
    raw: rawText,
  };
}

/**
 * Parse a per-spread section into an array indexed by spread number.
 *
 * @param {string} text - Section text with "Spread N: ..." lines
 * @param {number} spreadCount
 * @returns {string[]} Array where index i = description for spread i+1
 */
function parsePerSpread(text, spreadCount) {
  const result = new Array(spreadCount).fill('');
  const lines = text.split('\n');
  for (const line of lines) {
    const match = line.match(/spread\s*(\d+)[:\s-]+(.+)/i);
    if (match) {
      const idx = parseInt(match[1], 10) - 1;
      if (idx >= 0 && idx < spreadCount) {
        result[idx] = match[2].trim();
      }
    }
  }
  return result;
}

/**
 * Build the visual bible context to prepend to a spread's illustration prompt.
 *
 * @param {object} bible - Parsed visual bible
 * @param {number} spreadIndex - 0-based spread index
 * @returns {string} Context string to prepend to the illustration prompt
 */
function buildBibleContext(bible, spreadIndex) {
  if (!bible) return '';

  const parts = [];
  parts.push('VISUAL STORY BIBLE (LOCKED — maintain these across all illustrations):');

  if (bible.colorPalette) {
    parts.push(`COLOR PALETTE: ${bible.colorPalette}`);
  }

  if (bible.lightingArc && bible.lightingArc[spreadIndex]) {
    parts.push(`LIGHTING FOR THIS SPREAD: ${bible.lightingArc[spreadIndex]}`);
    // Include adjacent spreads for smooth transitions
    if (spreadIndex > 0 && bible.lightingArc[spreadIndex - 1]) {
      parts.push(`  (previous spread was: ${bible.lightingArc[spreadIndex - 1]})`);
    }
  }

  if (bible.recurringEnvironments) {
    parts.push(`RECURRING ENVIRONMENTS (use these EXACT descriptions when the scene revisits a location):\n${bible.recurringEnvironments}`);
  }

  if (bible.recurringObjects) {
    parts.push(`RECURRING OBJECTS (LOCKED visual descriptions — copy verbatim):\n${bible.recurringObjects}`);
  }

  if (bible.cameraPlan && bible.cameraPlan[spreadIndex]) {
    parts.push(`CAMERA/SHOT: ${bible.cameraPlan[spreadIndex]}`);
  }

  if (bible.textZones && bible.textZones[spreadIndex]) {
    parts.push(`TEXT ZONE: Leave a calm, low-detail area at ${bible.textZones[spreadIndex]} for embedded text.`);
  }

  parts.push('');
  return parts.join('\n');
}

module.exports = { generateVisualBible, buildBibleContext, parseBible };
