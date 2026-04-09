'use strict';

const { getNextApiKey, downloadPhotoAsBase64, fetchWithTimeout } = require('./illustrationGenerator');
const sharp = require('sharp');

const GEMINI_MODEL = 'gemini-3.1-flash-image-preview';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Force an image buffer to pure black-and-white (no grays, no color).
 * Converts to grayscale then applies a hard threshold so every pixel
 * is either 0x00 (black line) or 0xFF (white paper).
 * @param {Buffer} buf
 * @returns {Promise<Buffer>}
 */
async function enforceBlackAndWhite(buf) {
  return sharp(buf)
    .grayscale()
    .threshold(200)
    .png()
    .toBuffer();
}

// ── Trace mode: convert an existing illustration to line art ──

const TRACE_COLORING_PROMPT = `This is a children's book illustration. Convert it into a COLORING BOOK PAGE:
- Keep EVERY character, object, and scene element exactly as they appear — nothing removed or simplified
- Replace ALL colors with CLEAN BLACK OUTLINES ONLY on a pure white background
- Lines must be THICK and BOLD (suitable for a child to color with crayons or markers)
- NO fill colors, NO gray tones, NO shading, NO watercolor washes, NO color gradients
- The character faces, hair, clothing details, and all scene objects must all have clear outlines
- Style: classic children's coloring book — like a Dover coloring book page
- Maintain the EXACT SAME composition, proportions, characters and layout as the original
- This is a wide landscape illustration — maintain the 16:9 wide format
- ABSOLUTELY NO TEXT, LETTERS, WORDS, NUMBERS, or LOGOS anywhere in the image — remove any text that appears in the source`;

// ── Generate mode: create an original coloring scene from a text prompt + child photo ──

/**
 * Build the Gemini prompt for generating an original coloring page scene.
 * @param {string} scenePrompt - Description of the scene to draw
 * @param {string} [characterDescription] - Appearance of the child character
 * @returns {string}
 */
function buildGeneratePrompt(scenePrompt, characterDescription) {
  const charBlock = characterDescription
    ? `\nThe main character looks like this: ${characterDescription}`
    : '';
  return `Create an original COLORING BOOK PAGE for children. The scene:
${scenePrompt}${charBlock}

STRICT RULES:
- BLACK OUTLINES ONLY on a pure white background — no fills, no gray, no shading, no gradients
- Lines must be THICK and BOLD, suitable for a young child to color with crayons or markers
- Style: classic children's coloring book — like a Dover coloring book page
- Include rich background details (clouds, trees, objects) so the page is fun to color
- Wide landscape composition (16:9 aspect ratio)
- ABSOLUTELY NO TEXT, LETTERS, WORDS, NUMBERS, or LOGOS anywhere in the image`;
}

/**
 * Call Gemini image generation and extract the resulting image buffer.
 * Shared between trace and generate modes.
 * @param {Array<object>} parts - Gemini content parts (text + optional images)
 * @param {number} [timeoutMs=120000]
 * @returns {Promise<Buffer>}
 */
async function callGeminiImage(parts, timeoutMs = 120000) {
  const apiKey = getNextApiKey();
  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }),
  }, timeoutMs);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Gemini ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  if (!data?.candidates?.[0]?.content?.parts) {
    throw new Error(`Unexpected response: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const imgPart = data.candidates[0].content.parts.find(p => p.inlineData?.data);
  if (!imgPart) {
    throw new Error(`No image in response parts: ${JSON.stringify(data.candidates[0].content.parts.map(p => Object.keys(p))).slice(0, 200)}`);
  }
  return Buffer.from(imgPart.inlineData.data, 'base64');
}

// ── Trace mode helpers ──

/**
 * Convert a single illustration to a coloring book page via Gemini.
 * @param {string} base64 - base64-encoded source image
 * @param {string} mimeType - image mime type
 * @returns {Promise<Buffer>} - coloring page image buffer
 */
async function convertToColoringPage(base64, mimeType) {
  const MAX_ATTEMPTS = 3;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const parts = [
        { text: TRACE_COLORING_PROMPT },
        { inline_data: { mime_type: mimeType || 'image/jpeg', data: base64 } },
      ];
      const raw = await callGeminiImage(parts);
      return await enforceBlackAndWhite(raw);
    } catch (err) {
      lastError = err;
      console.warn(`[coloringBookGenerator] trace attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  throw lastError;
}

/**
 * Convert all spread illustrations to coloring pages sequentially.
 * @param {string[]} illustrationUrls
 * @returns {Promise<Array<{index: number, buffer: Buffer|null, success: boolean}>>}
 */
async function generateColoringPages(illustrationUrls) {
  const results = [];

  for (let i = 0; i < illustrationUrls.length; i++) {
    const url = illustrationUrls[i];
    console.log(`[coloringBookGenerator] Converting spread ${i + 1}/${illustrationUrls.length}`);
    try {
      const photo = await downloadPhotoAsBase64(url);
      const buffer = await convertToColoringPage(photo.base64, photo.mimeType);
      results.push({ index: i, buffer, success: true });
      console.log(`[coloringBookGenerator] Spread ${i + 1} done (${Math.round(buffer.length / 1024)}KB)`);
    } catch (err) {
      console.error(`[coloringBookGenerator] Spread ${i + 1} failed: ${err.message}`);
      results.push({ index: i, buffer: null, success: false, error: err.message });
    }
  }

  return results;
}

// ── Generate mode helpers ──

/**
 * Generate a single original coloring page from a scene description + child photo reference.
 * @param {string} scenePrompt
 * @param {{ base64: string, mimeType: string }|null} characterRef - child photo for likeness
 * @param {{ characterDescription?: string, characterAnchor?: { base64: string, mimeType: string } }} [opts]
 * @returns {Promise<Buffer>}
 */
async function generateOriginalColoringPage(scenePrompt, characterRef, opts = {}) {
  const MAX_ATTEMPTS = 3;
  let lastError;

  const textPrompt = buildGeneratePrompt(scenePrompt, opts.characterDescription);
  const parts = [{ text: textPrompt }];

  if (characterRef?.base64) {
    parts.push({
      text: 'Here is a photo of the child — draw the main character with the same face, hair, and build:',
    });
    parts.push({
      inline_data: { mime_type: characterRef.mimeType || 'image/jpeg', data: characterRef.base64 },
    });
  }

  if (opts.characterAnchor?.base64) {
    parts.push({
      text: 'Here is a reference illustration of how the character looks in the book — match the character but draw a NEW scene:',
    });
    parts.push({
      inline_data: { mime_type: opts.characterAnchor.mimeType || 'image/jpeg', data: opts.characterAnchor.base64 },
    });
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await callGeminiImage(parts);
      return await enforceBlackAndWhite(raw);
    } catch (err) {
      lastError = err;
      console.warn(`[coloringBookGenerator] generate attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  throw lastError;
}

/**
 * Generate original coloring pages for all scene prompts.
 * @param {string[]} scenePrompts
 * @param {{ base64: string, mimeType: string }|null} characterRef
 * @param {{ characterDescription?: string, characterAnchor?: { base64: string, mimeType: string } }} [opts]
 * @returns {Promise<Array<{index: number, buffer: Buffer|null, success: boolean, error?: string}>>}
 */
async function generateOriginalColoringPages(scenePrompts, characterRef, opts = {}) {
  const results = [];

  for (let i = 0; i < scenePrompts.length; i++) {
    console.log(`[coloringBookGenerator] Generating scene ${i + 1}/${scenePrompts.length}`);
    try {
      const buffer = await generateOriginalColoringPage(scenePrompts[i], characterRef, opts);
      results.push({ index: i, buffer, success: true });
      console.log(`[coloringBookGenerator] Scene ${i + 1} done (${Math.round(buffer.length / 1024)}KB)`);
    } catch (err) {
      console.error(`[coloringBookGenerator] Scene ${i + 1} failed: ${err.message}`);
      results.push({ index: i, buffer: null, success: false, error: err.message });
    }
  }

  return results;
}

// ── Scene planner: generate coloring-book scene prompts from book metadata ──

const SCENE_PLANNER_MODEL = 'gemini-3-flash-preview';

/**
 * Use Gemini to invent original coloring-book scene descriptions for a child,
 * based on the book's title, synopsis, and character description.
 * Scenes are deliberately different from the book's own spreads.
 *
 * @param {{ title: string, synopsis?: string, characterDescription?: string, childName?: string, age?: number, count?: number }} meta
 * @returns {Promise<string[]>} Array of scene prompt strings
 */
async function planColoringScenes(meta) {
  const { title, synopsis, characterDescription, childName, age, count = 12 } = meta;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured for scene planner');

  const systemPrompt = `You are a creative director for a children's coloring book companion. Given a storybook's metadata, invent ${count} unique coloring-page scene descriptions that:
- Feature the SAME main character in recognizable but BRAND-NEW situations (NOT scenes from the book)
- Are fun, age-appropriate bonus activities (playing, exploring, celebrating, discovering)
- Each scene stands alone — no sequential story needed
- Include enough environment detail (setting, objects, weather) to make a rich coloring page
- Keep each description to 1-2 sentences

Return ONLY a JSON array of ${count} strings. No commentary.`;

  const userPrompt = [
    `Book title: "${title}"`,
    synopsis ? `Synopsis: ${synopsis}` : '',
    characterDescription ? `Character: ${characterDescription}` : '',
    childName ? `Child's name: ${childName}` : '',
    age ? `Age: ${age}` : '',
  ].filter(Boolean).join('\n');

  const resp = await fetch(
    `${GEMINI_BASE}/${SCENE_PLANNER_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.9,
          maxOutputTokens: 2000,
          responseMimeType: 'application/json',
        },
      }),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Scene planner Gemini ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  const scenes = JSON.parse(raw);
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error('Scene planner returned no scenes');
  }
  return scenes.map(s => String(s));
}

module.exports = {
  generateColoringPages,
  convertToColoringPage,
  generateOriginalColoringPages,
  generateOriginalColoringPage,
  planColoringScenes,
};
