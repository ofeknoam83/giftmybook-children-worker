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
    .threshold(150) // 150 keeps medium grays (skin, hair mid-tones) white; only true dark outlines go black
    .png()
    .toBuffer();
}

// ── Age-adapted complexity helper ──

function ageComplexityInstruction(age) {
  const n = parseInt(age) || 5;
  if (n <= 4) return 'SIMPLE: large shapes only, very thick outlines (5px+), maximum 2 characters, minimal background, no tiny details — ideal for a toddler with thick crayons';
  if (n <= 7) return 'MODERATE: clear scene, medium detail, 3-5 colorable areas, mix of character and simple background elements';
  return 'DETAILED: rich scene with many elements, intricate patterns, architectural details, varied textures — challenging and satisfying for an older child';
}

// ── Dark-fill detection ──

async function darkPixelRatio(imageBuffer) {
  const { data } = await sharp(imageBuffer).grayscale().raw().toBuffer({ resolveWithObject: true });
  let dark = 0;
  for (let i = 0; i < data.length; i++) { if (data[i] < 80) dark++; }
  return dark / data.length;
}

const DARK_FILL_RETRY_WARNING = `⚠️ CRITICAL RETRY: The previous attempt had too much solid black. This is UNACCEPTABLE for a coloring book. ALL interior areas — including dark hair, dark skin, dark clothing — MUST be pure white with only outlines. Zero solid fills.`;

// ── Trace mode: convert an existing illustration to line art ──

function buildTracePrompt(age) {
  return `This is a children's book illustration. Convert it into a COLORING BOOK PAGE:
- Keep EVERY character, object, and scene element exactly as they appear — nothing removed or simplified
- Replace ALL colors with CLEAN BLACK OUTLINES ONLY on a PURE WHITE background
- Lines must be THICK and BOLD (suitable for a child to color with crayons or markers)
- CRITICAL — ALL AREAS INSIDE OUTLINES MUST BE PURE WHITE, INCLUDING:
  * Dark hair → draw hair strands as OUTLINES only, interior must be white
  * Dark or brown skin → draw the face/body shape as OUTLINES only, interior must be white
  * Dark clothing → draw fabric shape as OUTLINES with white interior
  * Dark objects (sofas, trees, shadows) → OUTLINES only, NO solid black fills
- ZERO solid fills anywhere — every enclosed area must be empty white so a child can color it
- NO fill colors, NO gray tones, NO shading, NO watercolor washes, NO color gradients
- Style: classic children's coloring book — like a Dover coloring book page
- ${ageComplexityInstruction(age)}
- Maintain the EXACT SAME composition, proportions, characters and layout as the original
- PORTRAIT orientation — taller than wide (3:4 aspect ratio), like a standard coloring book page. Do NOT use landscape orientation.
- ABSOLUTELY NO TEXT, LETTERS, WORDS, NUMBERS, or LOGOS anywhere in the image — remove any text that appears in the source`;
}

// ── Generate mode: create an original coloring scene from a text prompt + child photo ──

/**
 * Build the Gemini prompt for generating an original coloring page scene.
 * @param {string} scenePrompt - Description of the scene to draw
 * @param {string} [characterDescription] - Appearance of the child character
 * @param {number|string} [age] - Child's age for complexity adaptation
 * @returns {string}
 */
function buildGeneratePrompt(scenePrompt, characterDescription, age) {
  const charBlock = characterDescription
    ? `\nThe main character looks like this: ${characterDescription}`
    : '';
  return `Create an original COLORING BOOK PAGE for children. The scene:
${scenePrompt}${charBlock}

STRICT RULES:
- BLACK OUTLINES ONLY on a PURE WHITE background — no fills, no gray, no shading, no gradients
- Lines must be THICK and BOLD, suitable for a young child to color with crayons or markers
- CRITICAL — ALL AREAS INSIDE OUTLINES MUST BE PURE WHITE, INCLUDING:
  * Hair → draw as outlined strands, white interior (never a solid dark mass)
  * Skin → draw face/body as outlined shape, white interior (even dark skin tones must be white inside)
  * Clothing, objects, backgrounds → outlined shapes, white interiors
  * ZERO solid black fills anywhere in the image
- Style: classic children's coloring book — like a Dover coloring book page
- Include rich background details (clouds, trees, objects) so the page is fun to color
- ${ageComplexityInstruction(age)}
- PORTRAIT orientation — taller than wide (3:4 aspect ratio), like a standard coloring book page. Do NOT use landscape orientation.
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
 * @param {number|string} [age] - child's age for complexity adaptation
 * @returns {Promise<Buffer>} - coloring page image buffer
 */
async function convertToColoringPage(base64, mimeType, age) {
  const MAX_ATTEMPTS = 3;
  let lastError;
  let darkRetried = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const prompt = darkRetried
        ? `${DARK_FILL_RETRY_WARNING}\n\n${buildTracePrompt(age)}`
        : buildTracePrompt(age);
      const parts = [
        { text: prompt },
        { inline_data: { mime_type: mimeType || 'image/jpeg', data: base64 } },
      ];
      const raw = await callGeminiImage(parts);

      // Dark-fill detection: if ratio > 0.10, retry ONCE
      if (!darkRetried) {
        const ratio = await darkPixelRatio(raw);
        if (ratio > 0.10) {
          console.warn(`[coloringBookGenerator] trace dark pixel ratio ${(ratio * 100).toFixed(1)}% > 10%, retrying with warning`);
          darkRetried = true;
          // Don't count this as a failed attempt — retry immediately
          const retryPrompt = `${DARK_FILL_RETRY_WARNING}\n\n${buildTracePrompt(age)}`;
          const retryParts = [
            { text: retryPrompt },
            { inline_data: { mime_type: mimeType || 'image/jpeg', data: base64 } },
          ];
          const retryRaw = await callGeminiImage(retryParts);
          return await enforceBlackAndWhite(retryRaw);
        }
      }

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
 * Convert all spread illustrations to coloring pages (2 in parallel).
 * @param {string[]} illustrationUrls
 * @param {number|string} [age] - child's age for complexity adaptation
 * @returns {Promise<Array<{index: number, buffer: Buffer|null, success: boolean}>>}
 */
async function generateColoringPages(illustrationUrls, age) {
  const pLimit = require('p-limit');
  const limit = pLimit(2); // 2 concurrent — balances speed vs. Gemini rate limits

  const tasks = illustrationUrls.map((url, i) =>
    limit(async () => {
      console.log(`[coloringBookGenerator] Converting spread ${i + 1}/${illustrationUrls.length}`);
      try {
        const photo = await downloadPhotoAsBase64(url);
        const buffer = await convertToColoringPage(photo.base64, photo.mimeType, age);
        console.log(`[coloringBookGenerator] Spread ${i + 1} done (${Math.round(buffer.length / 1024)}KB)`);
        return { index: i, buffer, success: true };
      } catch (err) {
        console.error(`[coloringBookGenerator] Spread ${i + 1} failed: ${err.message}`);
        return { index: i, buffer: null, success: false, error: err.message };
      }
    })
  );

  const results = await Promise.all(tasks);
  return results.sort((a, b) => a.index - b.index); // preserve order
}

// ── Generate mode helpers ──

/**
 * Generate a single original coloring page from a scene description + child photo reference.
 * @param {string} scenePrompt
 * @param {{ base64: string, mimeType: string }|null} characterRef - child photo for likeness
 * @param {{ characterDescription?: string, characterAnchor?: { base64: string, mimeType: string }, age?: number|string }} [opts]
 * @returns {Promise<Buffer>}
 */
async function generateOriginalColoringPage(scenePrompt, characterRef, opts = {}) {
  const MAX_ATTEMPTS = 3;
  let lastError;
  let darkRetried = false;

  const textPrompt = buildGeneratePrompt(scenePrompt, opts.characterDescription, opts.age);
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

      // Dark-fill detection: if ratio > 0.10, retry ONCE
      if (!darkRetried) {
        const ratio = await darkPixelRatio(raw);
        if (ratio > 0.10) {
          console.warn(`[coloringBookGenerator] generate dark pixel ratio ${(ratio * 100).toFixed(1)}% > 10%, retrying with warning`);
          darkRetried = true;
          const retryParts = [
            { text: `${DARK_FILL_RETRY_WARNING}\n\n${buildGeneratePrompt(scenePrompt, opts.characterDescription, opts.age)}` },
            ...parts.slice(1), // keep image parts
          ];
          const retryRaw = await callGeminiImage(retryParts);
          return await enforceBlackAndWhite(retryRaw);
        }
      }

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
 * Generate original coloring pages for all scenes.
 * @param {Array<{prompt: string, title: string}>} scenes - scene objects with prompt and title
 * @param {{ base64: string, mimeType: string }|null} characterRef
 * @param {{ characterDescription?: string, characterAnchor?: { base64: string, mimeType: string }, age?: number|string }} [opts]
 * @returns {Promise<Array<{index: number, buffer: Buffer|null, success: boolean, title?: string, error?: string}>>}
 */
async function generateOriginalColoringPages(scenes, characterRef, opts = {}) {
  const pLimit = require('p-limit');
  const limit = pLimit(2); // 2 concurrent — balances speed vs. Gemini rate limits
  let completedCount = 0;

  const tasks = scenes.map((scene, i) =>
    limit(async () => {
      const scenePrompt = typeof scene === 'string' ? scene : scene.prompt;
      const sceneTitle = typeof scene === 'string' ? undefined : scene.title;
      console.log(`[coloringBookGenerator] Generating scene ${i + 1}/${scenes.length}`);
      try {
        const buffer = await generateOriginalColoringPage(scenePrompt, characterRef, opts);
        console.log(`[coloringBookGenerator] Scene ${i + 1} done (${Math.round(buffer.length / 1024)}KB)`);
        completedCount++;
        if (typeof opts.onPageComplete === 'function') opts.onPageComplete(completedCount);
        return { index: i, buffer, success: true, title: sceneTitle };
      } catch (err) {
        console.error(`[coloringBookGenerator] Scene ${i + 1} failed: ${err.message}`);
        completedCount++;
        if (typeof opts.onPageComplete === 'function') opts.onPageComplete(completedCount);
        return { index: i, buffer: null, success: false, title: sceneTitle, error: err.message };
      }
    })
  );

  const results = await Promise.all(tasks);
  return results.sort((a, b) => a.index - b.index);
}

// ── Scene planner: generate coloring-book scene prompts from book metadata ──

const SCENE_PLANNER_MODEL = 'gemini-3-flash-preview';

/**
 * Use Gemini to plan original coloring-book scenes for a child.
 * Returns objects with { prompt, title } for each scene.
 *
 * @param {{ title: string, synopsis?: string, characterDescription?: string, childName?: string, age?: number, count?: number, storyMoments?: string[] }} meta
 * @returns {Promise<Array<{prompt: string, title: string}>>}
 */
async function planColoringScenes(meta) {
  const { title, synopsis, characterDescription, childName, age, count = 16, storyMoments } = meta;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured for scene planner');

  const storyBlock = storyMoments && storyMoments.length > 0
    ? `Story moments from the book:\n${storyMoments.join('\n')}\n\nPlan scenes that feel like BONUS CHAPTERS of this exact story — same world, same adventure, new moments. Reference specific locations, objects, and events from the story above.`
    : 'Plan fun, varied adventure scenes for this child.';

  const systemPrompt = `You are planning ${count} original coloring book pages for a children's book.
Book title: "${title}"
Child's name: ${childName || 'the child'}, age ${age || 5}
${storyBlock}

For each scene provide:
- "title": short fun label, max 5 words (e.g. "Isabella Finds the Map")
- "prompt": detailed image generation prompt for the coloring page scene

Return a JSON array: [{"title":"...","prompt":"..."}, ...]
Return ONLY valid JSON, no markdown.`;

  const userPrompt = [
    synopsis ? `Synopsis: ${synopsis}` : '',
    characterDescription ? `Character: ${characterDescription}` : '',
  ].filter(Boolean).join('\n') || 'Generate the scenes.';

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
          maxOutputTokens: 4000,
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
  // Normalize: ensure each item has { prompt, title }
  return scenes.map(s => {
    if (typeof s === 'string') return { prompt: s, title: '' };
    return { prompt: String(s.prompt || s), title: String(s.title || '') };
  });
}

// ── Cover derivation from parent book cover ──

/**
 * Convert a parent children's book cover into a coloring-edition cover.
 * Keeps the same composition/characters but re-renders in a whimsical,
 * colorful "coloring book cover" style — NOT pure B&W line art.
 * @param {Buffer} parentCoverBuffer - original cover image buffer
 * @returns {Promise<Buffer>}
 */
async function convertCoverToColoringStyle(parentCoverBuffer) {
  const MAX_ATTEMPTS = 3;
  let lastError;

  const base64 = parentCoverBuffer.toString('base64');
  const prompt = `You are given a children's book cover. Re-create it as a COLORING BOOK COVER:

- Keep the SAME characters, composition, and scene from the original cover
- Re-draw in a bright, playful, whimsical COLORING BOOK cover style
- Use vibrant, cheerful colors — this is a COVER (not an interior B&W page)
- Simplify fine details into bold, clean shapes suitable for a coloring book aesthetic
- PORTRAIT orientation (taller than wide, 3:4 aspect ratio)
- ABSOLUTELY NO TEXT, LETTERS, WORDS, NUMBERS, or LOGOS anywhere in the image
- Leave a CLEAN area at the TOP (top 15%) for title text overlay
- Leave a CLEAN area at the BOTTOM (bottom 10%) for branding text overlay
- High quality, professional children's coloring book cover art`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const parts = [
        { text: prompt },
        { inline_data: { mime_type: 'image/jpeg', data: base64 } },
      ];
      const buf = await callGeminiImage(parts, 120000);
      console.log(`[coverArt] convertCoverToColoringStyle done (${Math.round(buf.length / 1024)}KB) on attempt ${attempt}`);
      return buf;
    } catch (err) {
      lastError = err;
      console.warn(`[coverArt] convertCoverToColoringStyle attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  throw lastError;
}

/**
 * Generate cover art, preferring derivation from the parent book's cover.
 * Falls back to generating from scratch if no parent cover is available.
 * @param {{ childName?: string, title?: string, age?: number|string, characterDescription?: string, parentCoverBuffer?: Buffer }} opts
 * @returns {Promise<{ frontCoverBuffer: Buffer, backCoverBuffer: Buffer }>}
 */
async function generateCoverArtFromParent(opts = {}) {
  const { parentCoverBuffer, ...rest } = opts;

  if (parentCoverBuffer) {
    console.log(`[coverArt] Deriving coloring cover from parent book cover`);
    const backPrompt = buildBackCoverPrompt(rest);

    const [frontCoverBuffer, backCoverBuffer] = await Promise.all([
      convertCoverToColoringStyle(parentCoverBuffer),
      generateCoverArtSingle(backPrompt, 'back cover'),
    ]);

    return { frontCoverBuffer, backCoverBuffer };
  }

  return generateCoverArt(rest);
}

/**
 * Generate a single cover image with retries.
 * @param {string} promptText
 * @param {string} label
 * @returns {Promise<Buffer>}
 */
async function generateCoverArtSingle(promptText, label) {
  const MAX_ATTEMPTS = 3;
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const parts = [{ text: promptText }];
      const buf = await callGeminiImage(parts, 120000);
      console.log(`[coverArt] ${label} generated (${Math.round(buf.length / 1024)}KB) on attempt ${attempt}`);
      return buf;
    } catch (err) {
      lastError = err;
      console.warn(`[coverArt] ${label} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  throw lastError;
}

// ── Cover art generation (from scratch, no parent cover) ──

/**
 * Build a Gemini prompt for the front cover illustration.
 */
function buildFrontCoverPrompt({ childName, title, age, characterDescription }) {
  const charBlock = characterDescription
    ? `\nThe main character looks like this: ${characterDescription}`
    : '';
  return `Create a beautiful, colorful children's coloring book COVER illustration.
Book title: "${title || 'My Coloring Book'}"
Child's name: ${childName || 'a child'}, age ${age || 5}${charBlock}

STYLE REQUIREMENTS:
- Bright, vibrant, playful colors — looks like a real published children's coloring book cover
- Whimsical, inviting art style with fun characters and magical elements
- PORTRAIT orientation (taller than wide, 3:4 aspect ratio)
- ABSOLUTELY NO TEXT, LETTERS, WORDS, NUMBERS, or LOGOS anywhere in the image
- Leave a CLEAN, relatively uncluttered area at the TOP of the image (top 15%) for title text overlay
- Leave a CLEAN area at the BOTTOM of the image (bottom 10%) for branding text overlay
- The middle portion should be rich, detailed, and eye-catching
- High quality, professional children's book cover art`;
}

/**
 * Build a Gemini prompt for the back cover illustration.
 */
function buildBackCoverPrompt({ childName, title, age, characterDescription }) {
  const charBlock = characterDescription
    ? `\nThe characters look like this: ${characterDescription}`
    : '';
  return `Create a simple, complementary back cover illustration for a children's coloring book.
Book title: "${title || 'My Coloring Book'}"
Child's name: ${childName || 'a child'}${charBlock}

STYLE REQUIREMENTS:
- Simpler than a front cover — could be a gentle pattern, scattered coloring elements, or a soft scene
- Same playful, colorful art style as a children's coloring book
- PORTRAIT orientation (taller than wide, 3:4 aspect ratio)
- ABSOLUTELY NO TEXT, LETTERS, WORDS, NUMBERS, or LOGOS anywhere in the image
- Leave the LOWER-RIGHT area (bottom-right quadrant, roughly 2 inches by 1.2 inches) COMPLETELY CLEAR/EMPTY for a barcode — this area should be plain white or very light
- Gentle, inviting colors — not too busy
- High quality, professional illustration`;
}

/**
 * Generate front and back cover art from scratch via Gemini image generation.
 * @param {{ childName?: string, title?: string, age?: number|string, characterDescription?: string }} opts
 * @returns {Promise<{ frontCoverBuffer: Buffer, backCoverBuffer: Buffer }>}
 */
async function generateCoverArt(opts = {}) {
  const frontPrompt = buildFrontCoverPrompt(opts);
  const backPrompt = buildBackCoverPrompt(opts);

  const [frontCoverBuffer, backCoverBuffer] = await Promise.all([
    generateCoverArtSingle(frontPrompt, 'front cover'),
    generateCoverArtSingle(backPrompt, 'back cover'),
  ]);

  return { frontCoverBuffer, backCoverBuffer };
}

module.exports = {
  generateColoringPages,
  convertToColoringPage,
  generateOriginalColoringPages,
  generateOriginalColoringPage,
  planColoringScenes,
  generateCoverArt,
  generateCoverArtFromParent,
  convertCoverToColoringStyle,
};
