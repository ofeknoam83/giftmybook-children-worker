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
  let cancelled = false;

  const tasks = scenes.map((scene, i) =>
    limit(async () => {
      // Check abort signal before starting each page
      if (opts.abortSignal?.aborted || cancelled) {
        return { index: i, buffer: null, success: false, title: typeof scene === 'string' ? undefined : scene.title, error: 'Generation cancelled' };
      }
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
        // If this is a cancellation, mark cancelled so remaining tasks skip
        if (err.message.includes('cancelled') || opts.abortSignal?.aborted) {
          cancelled = true;
          return { index: i, buffer: null, success: false, title: sceneTitle, error: 'Generation cancelled' };
        }
        console.error(`[coloringBookGenerator] Scene ${i + 1} failed: ${err.message}`);
        completedCount++;
        if (typeof opts.onPageComplete === 'function') opts.onPageComplete(completedCount);
        return { index: i, buffer: null, success: false, title: sceneTitle, error: err.message };
      }
    })
  );

  const results = await Promise.all(tasks);

  // If cancelled, throw so the caller can handle it
  if (cancelled || opts.abortSignal?.aborted) {
    throw new Error('Coloring book generation cancelled');
  }

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
    ? `Story moments from the parent picture book (in order):
${storyMoments.map((m, i) => `${i + 1}. ${m}`).join('\n')}

EACH coloring scene must COMPLEMENT — not duplicate — one of these story moments. Think of them as "what happened just before / just after / the next day / a quieter parallel moment" for each spread. Reference specific locations, props, and characters named above so the coloring book feels like the same world. Do NOT simply retell the same scene the child already saw in color in the parent book.`
    : 'Plan fun, varied adventure scenes for this child that would feel at home in a gentle picture-book world.';

  const systemPrompt = `You are planning ${count} original coloring book pages that accompany a children's picture book.
Book title: "${title}"
Child's name: ${childName || 'the child'}, age ${age || 5}
${storyBlock}

For each scene provide:
- "title": short fun label, max 5 words (e.g. "Isabella Finds the Map")
- "prompt": detailed image generation prompt describing the coloring-page scene in one paragraph. Always name the child in the prompt and describe concrete actions, setting, and props.

Hard rules:
- Every scene features the same child as the hero.
- Scenes must be varied (different setting, pose, time of day, or activity from scene to scene).
- Keep scenes gentle, wholesome, age-appropriate; no peril, no dark imagery.

Return a JSON array: [{"title":"...","prompt":"..."}, ...]
Return ONLY valid JSON, no markdown.`;

  const userPrompt = [
    synopsis ? `Synopsis: ${synopsis}` : '',
    characterDescription ? `Character: ${characterDescription}` : '',
  ].filter(Boolean).join('\n') || 'Generate the scenes.';

  const resp = await fetchWithTimeout(
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
    },
    120000 // 2 min timeout — prevents indefinite hang if Gemini stalls
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
 * Detect an image MIME type from a raw buffer by inspecting the magic bytes.
 * Falls back to image/jpeg if the header isn't recognized.
 */
function detectImageMime(buf) {
  if (!buf || buf.length < 12) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return 'image/jpeg';
}

/**
 * Convert a parent children's book cover into a PENCIL-SKETCH cover for the
 * coloring book. Unlike interior pages (pure B&W coloring line-art), the cover
 * is decorative graphite-pencil artwork so the book still looks like a finished
 * product. Keeps the parent cover's composition, characters, and poses but
 * re-renders in graphite; re-frames from the parent's square (8.5x8.5) into
 * 3:4 portrait to fit the coloring book's 8.5x11 trim.
 *
 * @param {Buffer} parentCoverBuffer
 * @param {string} [parentCoverMime] - optional mime override; otherwise detected
 * @returns {Promise<Buffer>}
 */
async function convertCoverToColoringStyle(parentCoverBuffer, parentCoverMime) {
  const MAX_ATTEMPTS = 3;
  let lastError;

  const base64 = parentCoverBuffer.toString('base64');
  const mimeType = parentCoverMime || detectImageMime(parentCoverBuffer);
  const prompt = `You are given a children's book cover. Re-create it as a GRAPHITE PENCIL DRAWING suitable as the cover of a coloring book companion to this same book.

- Keep the SAME characters, SAME composition, SAME poses, SAME outfits, SAME background elements as the original cover — this must clearly be the same cover, just in pencil-drawing form
- Render in HAND-DRAWN PENCIL style: graphite-on-paper look with soft tonal shading, visible fine hatching and cross-hatching, delicate pencil strokes
- Tones allowed: black, dark grey, mid grey, light grey, and white paper. Subtle gradients and soft shadows are fine — this is NOT a coloring page, it is finished pencil artwork.
- Avoid bold cartoon coloring-book outlines. Use sketchy, artist-quality pencil linework with natural variation in line weight.
- No color. Pure monochrome pencil drawing.
- RE-FRAME into PORTRAIT orientation (taller than wide, 3:4 aspect ratio). The source cover is square (1:1). Extend the scene naturally at the top and bottom so nothing important is cropped — do NOT letterbox or add blank bars, paint a pencil extension of the environment.

TITLE TEXT RULE:
- If the original cover already contains a title, name, or any typography, PRESERVE it exactly as it appears — reproduce those words in the same position and style, hand-lettered in pencil. This cover must keep its original title.
- Do NOT add any new text, labels, subtitles, author names, or logos that were not already in the source cover. Never invent a title. No "Coloring Book" stamp, no branding, no extra words.

Professional pencil-drawing quality suitable for a printed coloring book cover. The cover wrap PDF will embed this image full-bleed with no additional overlays — what you draw is what prints.`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const parts = [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64 } },
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
 * Flatten a questionnaire object into a short textual summary suitable for
 * an LLM scene planner. Keeps each field labeled; clips obviously long fields.
 */
function summarizeQuestionnaire(q = {}) {
  const lines = [];
  const push = (label, val) => {
    if (val == null) return;
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed) lines.push(`${label}: ${trimmed.slice(0, 500)}`);
      return;
    }
    if (Array.isArray(val)) {
      const joined = val.filter(x => typeof x === 'string' && x.trim()).join(', ');
      if (joined) lines.push(`${label}: ${joined}`);
      return;
    }
    if (typeof val === 'object') {
      const s = JSON.stringify(val);
      if (s && s !== '{}' && s !== '[]') lines.push(`${label}: ${s.slice(0, 500)}`);
    }
  };
  push('Interests', q.childInterests);
  push('Custom details', q.customDetails);
  push('Brief', q.brief);
  push('Emotion intake', q.emotionIntakeData);
  push('Emotional situation', q.emotionalSituation);
  push('Parent goal', q.emotionalParentGoal);
  push('Coping resource hint', q.copingResourceHint);
  push('Child appearance', q.childAppearance);
  return lines.join('\n');
}

const BACK_COVER_PLANNER_MODEL = 'gemini-2.5-flash';

/**
 * Pick ONE personal, heart-warming detail from the questionnaire and turn it
 * into a pencil-sketch back-cover scene featuring the child. Returns a fallback
 * on any LLM failure so a back cover can always be rendered.
 *
 * @param {{ childName?: string, age?: number|string, questionnaire?: object }} opts
 * @returns {Promise<{ chosenDetail: string, scenePrompt: string, rationale: string }>}
 */
async function planBackCoverScene(opts = {}) {
  const { childName, age, questionnaire = {} } = opts;
  const summary = summarizeQuestionnaire(questionnaire);
  const fallbackScene = (() => {
    const firstInterest = Array.isArray(questionnaire.childInterests)
      ? questionnaire.childInterests.find(i => typeof i === 'string' && i.trim())
      : null;
    const firstCustom = typeof questionnaire.customDetails === 'string'
      ? questionnaire.customDetails.split(/[.\n]/).map(s => s.trim()).find(Boolean)
      : null;
    const detail = firstInterest || firstCustom || 'playing outdoors';
    return {
      chosenDetail: detail,
      scenePrompt: `${childName || 'The child'} enjoying ${detail}, warm and wholesome, simple composition centered on the child`,
      rationale: 'deterministic fallback',
    };
  })();

  if (!summary) return fallbackScene;

  const apiKey = getNextApiKey();
  if (!apiKey) return fallbackScene;

  const systemPrompt = `You are designing the BACK COVER of a personalized children's coloring book for ${childName || 'the child'}${age ? `, age ${age}` : ''}.

Read the questionnaire below. Pick ONE small, concrete, heart-warming detail about this specific child that would make a charming pencil-sketch back-cover scene. Prefer unique personal details (a pet by name, a favorite toy, a cherished activity, a special place) over generic interests. Avoid sensitive or sad content.

Then describe a single calm pencil-sketch scene that features the child doing/holding/being-with that detail. The scene should complement the book cover — same child, gentle mood, one clear focal point.

Return ONLY valid JSON:
{
  "chosenDetail": "one short phrase naming the detail you picked",
  "scenePrompt": "one sentence describing the scene to draw, featuring the child and the chosen detail",
  "rationale": "one short sentence explaining why this detail is a good fit"
}`;

  try {
    const url = `${GEMINI_BASE}/${BACK_COVER_PLANNER_MODEL}:generateContent?key=${apiKey}`;
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: summary }] }],
        generationConfig: {
          temperature: 0.6,
          maxOutputTokens: 400,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }, 30000);

    if (!resp.ok) {
      console.warn(`[coverArt] planBackCoverScene API ${resp.status} — using fallback`);
      return fallbackScene;
    }

    const data = await resp.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const cleaned = raw.replace(/```json\s*/i, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return fallbackScene;

    const parsed = JSON.parse(match[0]);
    const chosenDetail = typeof parsed.chosenDetail === 'string' ? parsed.chosenDetail.trim() : '';
    const scenePrompt = typeof parsed.scenePrompt === 'string' ? parsed.scenePrompt.trim() : '';
    if (!scenePrompt) return fallbackScene;
    return {
      chosenDetail: chosenDetail || fallbackScene.chosenDetail,
      scenePrompt,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '',
    };
  } catch (err) {
    console.warn(`[coverArt] planBackCoverScene error: ${err.message} — using fallback`);
    return fallbackScene;
  }
}

/**
 * Generate cover art, preferring derivation from the parent book's cover.
 * Falls back to generating from scratch if no parent cover is available.
 * @param {{ childName?: string, title?: string, age?: number|string, characterDescription?: string, parentCoverBuffer?: Buffer, parentCoverMime?: string, questionnaire?: object, characterRef?: {base64: string, mimeType: string}, characterAnchor?: {base64: string, mimeType: string} }} opts
 * @returns {Promise<{ frontCoverBuffer: Buffer, backCoverBuffer: Buffer, backCoverMeta?: {chosenDetail: string, scenePrompt: string, rationale: string} }>}
 */
async function generateCoverArtFromParent(opts = {}) {
  const { parentCoverBuffer, parentCoverMime, questionnaire, characterRef, characterAnchor, ...rest } = opts;

  if (parentCoverBuffer) {
    console.log(`[coverArt] Deriving coloring cover from parent book cover`);

    // Plan the back-cover scene from the questionnaire in parallel with the
    // front cover conversion so total latency stays low.
    const [backPlan, frontCoverBuffer] = await Promise.all([
      planBackCoverScene({ childName: rest.childName, age: rest.age, questionnaire }),
      convertCoverToColoringStyle(parentCoverBuffer, parentCoverMime),
    ]);
    console.log(`[coverArt] Back-cover scene chosen: "${backPlan.chosenDetail}" — ${backPlan.rationale}`);

    const backCoverBuffer = await generateBackCoverImage({
      ...rest,
      scenePrompt: backPlan.scenePrompt,
      chosenDetail: backPlan.chosenDetail,
      characterRef,
      characterAnchor,
    });

    return { frontCoverBuffer, backCoverBuffer, backCoverMeta: backPlan };
  }

  return generateCoverArt({ ...rest, questionnaire, characterRef, characterAnchor });
}

/**
 * Render the back cover as a pencil sketch of the child inside a questionnaire-
 * driven scene. Uses the child's photo (and optionally the parent's character
 * reference illustration) so the child look matches the chosen front cover.
 */
async function generateBackCoverImage(opts = {}) {
  const prompt = buildBackCoverPrompt(opts);
  const parts = [{ text: prompt }];
  if (opts.characterRef?.base64) {
    parts.push({ text: 'Here is a photo of the child — the child in the scene must match this face, hair, and build:' });
    parts.push({ inline_data: { mime_type: opts.characterRef.mimeType || 'image/jpeg', data: opts.characterRef.base64 } });
  }
  if (opts.characterAnchor?.base64) {
    parts.push({ text: 'Here is the character reference illustration from the parent book — match this exact character look, translated into pencil style:' });
    parts.push({ inline_data: { mime_type: opts.characterAnchor.mimeType || 'image/jpeg', data: opts.characterAnchor.base64 } });
  }

  const MAX_ATTEMPTS = 3;
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const buf = await callGeminiImage(parts, 120000);
      console.log(`[coverArt] back cover generated (${Math.round(buf.length / 1024)}KB) on attempt ${attempt}`);
      return buf;
    } catch (err) {
      lastError = err;
      console.warn(`[coverArt] back cover attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  throw lastError;
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
function buildFrontCoverPrompt({ childName, age, characterDescription }) {
  const charBlock = characterDescription
    ? `\nThe main character looks like this: ${characterDescription}`
    : '';
  return `Create a children's coloring book FRONT COVER as a GRAPHITE PENCIL DRAWING.
Child's name: ${childName || 'a child'}, age ${age || 5}${charBlock}

STYLE REQUIREMENTS:
- HAND-DRAWN PENCIL style: graphite-on-paper look with soft tonal shading, visible fine hatching and cross-hatching, delicate pencil strokes
- Tones allowed: black, dark grey, mid grey, light grey, and white paper. Subtle gradients and soft shadows are fine — this is finished pencil artwork.
- Whimsical, inviting composition with fun characters — the child should be the clear focal point
- No color. Pure monochrome pencil drawing.
- PORTRAIT orientation (taller than wide, 3:4 aspect ratio)
- ABSOLUTELY NO TEXT, LETTERS, WORDS, NUMBERS, or LOGOS anywhere in the image — no title, no author name, no subtitles, no branding
- The pencil drawing should fill the frame naturally — no reserved text boxes or clear bands
- Professional pencil-drawing quality suitable for a printed coloring book cover`;
}

/**
 * Build a Gemini prompt for the back cover — a graphite pencil sketch of
 * the child inside a scene chosen from the questionnaire. Matches the
 * pencil-drawing style used on the front cover (which is a pencil rendering
 * of the parent book's cover).
 *
 * @param {{ childName?: string, age?: number|string, characterDescription?: string, scenePrompt?: string, chosenDetail?: string }} opts
 */
function buildBackCoverPrompt({ childName, age, characterDescription, scenePrompt, chosenDetail }) {
  const charBlock = characterDescription
    ? `\nThe child looks like this: ${characterDescription}`
    : '';
  const scene = scenePrompt
    || `${childName || 'The child'} enjoying ${chosenDetail || 'a favorite moment'}, warm and wholesome`;
  return `Create the BACK COVER of a children's coloring book as a GRAPHITE PENCIL DRAWING.

SCENE TO DRAW:
${scene}

The child (${childName || 'the child'}${age ? `, age ${age}` : ''}) must be the clear focal point, featured prominently in the scene.${charBlock}

STYLE REQUIREMENTS:
- HAND-DRAWN PENCIL style: graphite-on-paper look with soft tonal shading, visible fine hatching and cross-hatching, delicate pencil strokes
- Tones allowed: black, dark grey, mid grey, light grey, white paper. Subtle gradients and soft shadows are fine — this is NOT a coloring page, it is finished pencil artwork.
- Match the style of the FRONT cover exactly so both covers look like the same artist drew them.
- Avoid bold cartoon coloring-book outlines. Use sketchy, artist-quality pencil linework with natural variation in line weight.
- No color. Pure monochrome pencil drawing.
- Calmer and simpler than the front cover — ONE clear focal point (the child + the scene element), uncluttered background, plenty of clean paper.

COMPOSITION:
- PORTRAIT orientation (taller than wide, 3:4 aspect ratio)
- The child must be clearly depicted and recognizable as the same child on the front cover
- The pencil drawing should fill the frame naturally — no reserved white boxes, no barcode clear-zone, no ISBN area. We do not print a barcode or ISBN on this book.

STRICT:
- ABSOLUTELY NO TEXT, LETTERS, WORDS, NUMBERS, or LOGOS anywhere in the image — no title, no author name, no taglines, no back-cover blurb
- No frames, no borders, no decorative stickers — just the pencil scene on paper`;
}

/**
 * Generate front and back cover art from scratch via Gemini image generation.
 * Used as a fallback when no parent cover is available.
 * @param {{ childName?: string, title?: string, age?: number|string, characterDescription?: string, questionnaire?: object, characterRef?: {base64:string,mimeType:string}, characterAnchor?: {base64:string,mimeType:string} }} opts
 * @returns {Promise<{ frontCoverBuffer: Buffer, backCoverBuffer: Buffer, backCoverMeta?: object }>}
 */
async function generateCoverArt(opts = {}) {
  const frontPrompt = buildFrontCoverPrompt(opts);
  const backPlan = await planBackCoverScene({
    childName: opts.childName,
    age: opts.age,
    questionnaire: opts.questionnaire,
  });
  console.log(`[coverArt] (scratch) back-cover scene: "${backPlan.chosenDetail}" — ${backPlan.rationale}`);

  const [frontCoverBuffer, backCoverBuffer] = await Promise.all([
    generateCoverArtSingle(frontPrompt, 'front cover'),
    generateBackCoverImage({
      ...opts,
      scenePrompt: backPlan.scenePrompt,
      chosenDetail: backPlan.chosenDetail,
    }),
  ]);

  return { frontCoverBuffer, backCoverBuffer, backCoverMeta: backPlan };
}

module.exports = {
  generateColoringPages,
  convertToColoringPage,
  generateOriginalColoringPages,
  generateOriginalColoringPage,
  planColoringScenes,
  generateCoverArt,
  generateCoverArtFromParent,
  generateBackCoverImage,
  convertCoverToColoringStyle,
  buildBackCoverPrompt,
  planBackCoverScene,
  summarizeQuestionnaire,
  detectImageMime,
};
