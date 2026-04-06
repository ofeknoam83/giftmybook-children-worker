/**
 * Illustration generator service.
 *
 * Generates children's book illustrations using Gemini image API.
 * Uses the child's actual photo as reference for face-consistent
 * character rendering via Gemini's image-to-image capabilities.
 */

const { uploadBuffer } = require('./gcsStorage');
const { withRetry } = require('./retry');

// ── Multi-key round-robin pool for parallel illustration generation ──
// Keys are spread across multiple GCP projects to avoid per-project backend queuing.
const GEMINI_MODEL = 'gemini-3.1-flash-image-preview';

function buildKeyPool() {
  const keys = [];
  // Numbered keys: GEMINI_API_KEY_1, GEMINI_API_KEY_2, ...
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  // Fallback to single key env vars
  if (keys.length === 0) {
    const single = process.env.GOOGLE_AI_STUDIO_KEY || process.env.GEMINI_API_KEY || '';
    if (single) keys.push(single);
  }
  return keys;
}

const API_KEY_POOL = buildKeyPool();
let keyIndex = 0;
let stickyKeyIndex = -1; // If a key responds fast, stick with it
let stickyKeyExpiry = 0;

function getNextApiKey() {
  if (API_KEY_POOL.length === 0) return '';
  // If we have a sticky key that responded fast recently, prefer it
  if (stickyKeyIndex >= 0 && Date.now() < stickyKeyExpiry) {
    return API_KEY_POOL[stickyKeyIndex % API_KEY_POOL.length];
  }
  stickyKeyIndex = -1; // expired
  const key = API_KEY_POOL[keyIndex % API_KEY_POOL.length];
  keyIndex++;
  return key;
}

/** Mark a key as "fast" so we stick with it for a while */
function markKeyFast(idx) {
  stickyKeyIndex = idx;
  stickyKeyExpiry = Date.now() + 5 * 60 * 1000; // stick for 5 minutes
  console.log(`[illustrationGenerator] Key public-${idx} marked as fast — sticking for 5 min`);
}

console.log(`[IllustrationGenerator] API key pool: ${API_KEY_POOL.length} keys across ${API_KEY_POOL.length} projects`);
if (API_KEY_POOL.length === 0) {
  console.warn('[IllustrationGenerator] WARNING: No API keys configured — illustrations will fail');
}

// Gemini proxy endpoint (optional fallback)
const PROXY_URL = process.env.GEMINI_PROXY_URL || '';
const PROXY_API_KEY = process.env.GEMINI_PROXY_API_KEY || '';

/** Fetch with an AbortController timeout */
async function fetchWithTimeout(url, opts, timeoutMs = 180000, parentSignal) { // 3 min default timeout for Gemini image gen
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // If parent aborts (book-level timeout), abort this fetch too
  const onParentAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) { clearTimeout(timer); throw new Error('Parent already aborted'); }
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    return resp;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Gemini image API timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw e;
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
  }
}

/** Maximum retry attempts per illustration */
const MAX_RETRIES = 2;

/**
 * Art style configurations for illustration prompts.
 */
const ART_STYLE_CONFIG = {
  pixar_premium: {
    prefix: 'Cinematic 3D Pixar-like soft render children\'s book illustration,',
    suffix: 'photorealistic 3D CGI render, soft volumetric cinematic lighting, subsurface skin scattering, warm saturated color palette, emotionally expressive face and posture, rich fabric textures, dreamy depth-of-field bokeh background, Disney-Pixar production quality, magical storybook atmosphere',
  },
  watercolor: {
    prefix: 'children\'s book watercolor illustration,',
    suffix: 'soft watercolor textures, gentle colors, hand-painted look, paper texture visible, warm natural lighting',
  },
  digital_painting: {
    prefix: 'children\'s book digital painting illustration,',
    suffix: 'vibrant colors, clean lines, professional digital art, warm lighting, friendly atmosphere',
  },
  gouache: {
    prefix: 'children\'s book gouache illustration,',
    suffix: 'thick opaque paint texture, bold flat color areas, visible brushstrokes, matte finish, earthy warm palette',
  },
  pencil_sketch: {
    prefix: 'children\'s book pencil sketch illustration,',
    suffix: 'detailed graphite on cream paper, crosshatching for shadows, delicate linework, warm sepia tones with selective soft color washes',
  },
  paper_cutout: {
    prefix: 'children\'s book paper cutout collage illustration,',
    suffix: 'layered paper shapes with visible cut edges and shadows between layers, textured craft paper, bold simple shapes, Eric Carle inspired',
  },
  storybook_classic: {
    prefix: 'classic golden age children\'s storybook illustration,',
    suffix: 'detailed pen and ink with delicate watercolor tints, ornate borders, Beatrix Potter and Arthur Rackham inspired, vintage whimsical charm',
  },
  anime: {
    prefix: 'Studio Ghibli inspired children\'s book illustration,',
    suffix: 'large expressive eyes, soft pastel colors, dreamy atmospheric lighting, detailed fantasy background, Hayao Miyazaki style',
  },
  pixel_art: {
    prefix: 'retro pixel art children\'s book illustration,',
    suffix: '16-bit video game aesthetic, chunky visible pixels, limited color palette, nostalgic warm tones, charming blocky characters',
  },
  storybook: {
    prefix: 'classic children\'s storybook illustration,',
    suffix: 'whimsical style, soft pastel colors, detailed backgrounds, cozy atmosphere, fairytale quality',
  },
  scandinavian_minimal: {
    prefix: 'Scandinavian minimal children\'s book illustration,',
    suffix: 'clean simple shapes, flat design with subtle texture, muted Nordic color palette (soft sage, dusty rose, warm cream, birch white), generous negative space, cozy hygge atmosphere, elegant simplicity',
  },
  cinematic_3d: {
    prefix: 'Cinematic 3D animated children\'s book illustration,',
    suffix: 'photorealistic 3D CGI render, volumetric cinematic lighting, depth of field, rich textures, dramatic warm golden glow, Disney-Pixar production quality, emotionally expressive characters, vivid saturated palette, subsurface skin scattering, magical storybook atmosphere',
  },
};

/** Words that may trigger NSFW filters in children's book contexts */
const NSFW_TRIGGER_WORDS = /\b(naked|nude|bare|undress|strip|blood|kill|dead|death|gun|knife|weapon|fight|violent|scary|horror|monster|demon|devil|drunk|alcohol|drug|kiss|love|romantic|sexy|seductive|provocative|sensual|intimate|lingerie)\b/gi;

/**
 * Sanitize a prompt to reduce NSFW filter triggers.
 */
function sanitizePrompt(prompt) {
  let cleaned = prompt.replace(NSFW_TRIGGER_WORDS, '');
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  return `${cleaned}, wholesome, family-friendly, child-safe, innocent`;
}

/**
 * Build a very generic safe fallback prompt for when sanitization isn't enough.
 */
function buildGenericSafePrompt(artStyle) {
  const styleConfig = ART_STYLE_CONFIG[artStyle] || ART_STYLE_CONFIG.watercolor;
  return `${styleConfig.prefix} children's book illustration of a happy child in a colorful scene, wholesome, family-friendly, child-safe, bright colors, joyful atmosphere, non-realistic, fully clothed ${styleConfig.suffix}`;
}

/**
 * Strip hair-accessory mentions from a per-spread scene description so
 * the only hair info reaching the image model comes from the locked
 * characterDescription, preventing per-spread contradictions.
 */
function stripHairFromScene(scene) {
  const hairAccessoryPattern = /\b(headband|hair\s*band|hair\s*bow|bow\s+in\s+(?:her|his)\s+hair|hair\s*clip|barrette|ribbon\s+in\s+(?:her|his)\s+hair|hair\s*elastic|scrunchie|hair\s*tie|pigtails?|ponytail|braid|braided|cornrow|puff|puffs|bun|updo|afro\s*puffs?|two\s+puffs?|pink\s+bow|purple\s+bow)\b/gi;
  return scene.replace(hairAccessoryPattern, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Build explicit negative instructions for hair accessories NOT present in
 * the character description. Tells the model exactly what NOT to add.
 */
function buildHairNegatives(characterDescription) {
  const desc = (characterDescription || '').toLowerCase();
  const allAccessories = [
    { word: 'headband', pattern: /headband/i },
    { word: 'bow', pattern: /\bbow\b/i },
    { word: 'ribbon', pattern: /ribbon/i },
    { word: 'clip', pattern: /\bclip\b/i },
    { word: 'barrette', pattern: /barrette/i },
    { word: 'scrunchie', pattern: /scrunchie/i },
    { word: 'hair tie', pattern: /hair\s*tie/i },
    { word: 'flower', pattern: /flower/i },
    { word: 'tiara', pattern: /tiara|crown/i },
    { word: 'hat', pattern: /\bhat\b/i },
    { word: 'beanie', pattern: /beanie/i },
  ];
  const banned = allAccessories.filter(a => !a.pattern.test(desc)).map(a => a.word);
  if (banned.length > 0) {
    return `DO NOT add any of these to the child's hair: ${banned.join(', ')}. Only accessories explicitly described above are allowed.`;
  }
  return '';
}

/**
 * Build a structured illustration prompt with character identity anchoring.
 *
 * @param {string} sceneDescription - Scene to illustrate
 * @param {string} artStyle - Art style key
 * @param {string} [childName] - Child's name for character anchoring
 * @returns {string} Complete prompt
 */
function buildCharacterPrompt(sceneDescription, artStyle, childName, pageText, characterOutfit, characterDescription, recurringElement, keyObjects, opts = {}) {
  const styleConfig = ART_STYLE_CONFIG[artStyle] || ART_STYLE_CONFIG.watercolor;
  const skipTextEmbed = opts.skipTextEmbed || false;
  const isSpread = opts.isSpread || false;
  const spreadIndex = opts.spreadIndex;
  const totalSpreads = opts.totalSpreads || 13;
  const childAge = opts.childAge;

  // Strip any hair-accessory mentions from the per-spread scene so only the
  // locked characterDescription defines the child's hair.
  const cleanScene = stripHairFromScene(sceneDescription);

  // Use full characterDescription (no regex extraction) — Change 14
  const hairstyleDesc = characterDescription || '';

  const parts = [];

  // Change 13: LOCKED APPEARANCE at position 1 (before everything)
  parts.push(`LOCKED CHARACTER APPEARANCE (READ THIS BEFORE ANYTHING ELSE):`);
  parts.push(`${characterDescription ? characterDescription : 'Match the child in the reference photo exactly.'}`);
  parts.push(`OUTFIT (do not change): ${characterOutfit || 'match the reference photo'}`);
  parts.push(`This is the ONLY child in this book. Their appearance does NOT change between illustrations.`);
  parts.push(`Do not modify their hair, outfit, or any physical features.`);
  parts.push(``);

  // Change 22: Per-spread continuity anchor
  if (spreadIndex !== undefined) {
    parts.push(`CONTINUITY: This is illustration ${spreadIndex + 1} of ${totalSpreads} for the same book. The child's face, hair, body proportions, and clothing are IDENTICAL to all other illustrations in this book. Only the scene, action, and background change between illustrations.`);
    parts.push(``);
  }

  parts.push(`\u26a0\ufe0f CRITICAL RULES (READ FIRST, VIOLATING ANY = REJECTED IMAGE):`);
  parts.push(``);
  const charCountRule = opts.additionalCoverCharacters
    ? `1. CHARACTER COUNT: The MAIN CHILD plus the additional cover characters listed below are allowed. No invented characters beyond those listed. Do NOT duplicate the child.`
    : `1. CHARACTER COUNT: EXACTLY ONE CHILD in this image. Only one. Not two. Not a smaller version in the background. Not a reflection. Not a shadow copy. ONE CHILD TOTAL in the entire image. If you draw two children, the image will be rejected.`;
  parts.push(charCountRule);
  parts.push(``);
  parts.push(`2. ANATOMY: The child has exactly TWO arms, TWO hands (with 5 fingers each), TWO legs, TWO feet. No extra limbs. No missing limbs. Count them before finishing: 2 arms, 2 hands, 2 legs, 2 feet.`);
  parts.push(``);
  parts.push(`3. COMPOSITION: This is ONE single moment in time. NOT a comic strip. NOT a sequence. NOT a before/after. NOT multiple panels. ONE scene, ONE viewpoint, ONE moment.`);
  parts.push(``);
  // If additional characters appear on the approved cover, they are allowed in illustrations
  if (opts.additionalCoverCharacters) {
    parts.push(`4. ADDITIONAL CHARACTERS ALLOWED: The following characters appear on the book cover and MAY appear in illustrations. Draw them as described — do NOT invent new relatives or characters not listed here:`);
    parts.push(opts.additionalCoverCharacters);
    parts.push(`   IMPORTANT: Only the characters listed above are allowed. Do NOT add any other family members, parents, siblings, or relatives beyond what is listed.`);
  } else {
    parts.push(`4. NO FAMILY MEMBERS: Do NOT draw the child's parents, siblings, grandparents, or any real-life relatives. We do not have their photos and cannot depict them accurately. The child may interact with fictional characters (shopkeepers, fairies, talking animals, imaginary friends) but NEVER with family members. If a parent or relative is mentioned in the story, show only their EFFECT (a warm light, a hand at the edge of frame, a voice) — never their face or full body. If any relative appears, the image will be rejected.`);
  }
  parts.push(``);

  if (characterOutfit) {
    parts.push(`5. OUTFIT LOCK: The child MUST wear EXACTLY this outfit in EVERY illustration — no substitutions, no additions, no removals, no seasonal variations: ${characterOutfit}`);
    parts.push(`   Do NOT change any garment, color, pattern, or accessory. Do NOT add jackets, hats, capes, or accessories not listed. Do NOT remove any item. This outfit is IDENTICAL on every single page. If the outfit does not match this description exactly, the image will be rejected.`);
    // Change 19: Outfit additions forbidden
    parts.push(`   OUTFIT ADDITIONS FORBIDDEN: Do not add any item not explicitly listed in the outfit above. No scarves, hats, backpacks, capes, stickers, extra accessories, or additional clothing layers unless specifically named. The outfit is complete as described. Any addition is a violation of this rule.`);
    parts.push(``);
  }

  if (characterDescription) {
    parts.push(`6. HAIRSTYLE LOCK: The child MUST have EXACTLY this appearance in EVERY illustration — no changes, no variations, no wind-blown alternatives: ${characterDescription}`);
    parts.push(`   HAIR ACCESSORIES: If the description above mentions headbands, bows, ribbons, clips, or any hair accessories, include EXACTLY those and NOTHING else. If NO accessories are mentioned, the child has NO hair accessories — do NOT invent any.`);
    parts.push(`   Same hair style, same hair accessories, same hair color, same hair length, same hair texture on every page. Do NOT add headbands, bows, or hair accessories not listed. Do NOT change the hairstyle for any reason (weather, activity, sleep). If the hairstyle does not match this description exactly, the image will be rejected.`);
    parts.push(``);
  } else {
    parts.push(`6. HAIRSTYLE LOCK: The child's hair MUST look EXACTLY the same in every illustration — same style, color, length, texture, and accessories as shown in the reference photo. Do NOT add any hair accessories (headbands, bows, clips, ribbons) unless they are clearly visible in the reference photo. Do NOT change the hairstyle for any reason.`);
    parts.push(``);
  }

  parts.push(`Create a single children's book illustration page.`);
  parts.push(``);
  parts.push(`MAIN CHARACTER \u2014 ${childName || 'the child'} (THE ONLY CHILD IN THIS IMAGE):`);

  if (characterDescription) {
    parts.push(characterDescription);
  }

  parts.push('');
  parts.push('CHARACTER LIKENESS (MUST MATCH REFERENCE PHOTO EXACTLY):');
  parts.push('- The child MUST closely resemble the reference photo. Match face shape, skin tone, hair color, hair style, hair length, hair texture, and eye color from the photo.');
  parts.push('- NEVER change hair style, hair color, hair length, eye color, or skin tone from the reference — not even slightly.');
  parts.push('- The child\'s hair must be IDENTICAL in every illustration: same style, same color, same length, same parting, same accessories.');
  parts.push('- ZERO INVENTION RULE: Do NOT add hair accessories (headbands, bows, ribbons, clips, barrettes, flowers) that are not explicitly described. If the description says nothing about accessories, the child has NONE.');
  const hairNegatives = buildHairNegatives(characterDescription);
  if (hairNegatives) {
    parts.push(`- ${hairNegatives}`);
  }
  parts.push('- The child\'s clothing must be IDENTICAL in every illustration: same garments, same colors, same patterns.');
  if (characterDescription) {
    parts.push(`- APPEARANCE (copy exactly): ${characterDescription}`);
  }
  if (characterOutfit) {
    parts.push(`- OUTFIT (copy exactly): ${characterOutfit}`);
  }

  if (recurringElement) {
    parts.push('');
    parts.push(`RECURRING COMPANION (appears in every scene): ${recurringElement}`);
    parts.push('This companion must look identical across all pages.');
  }

  if (keyObjects) {
    parts.push('');
    parts.push('KEY OBJECTS (must look EXACTLY the same on every page \u2014 same colors, same details):');
    parts.push(keyObjects);
    parts.push('Do NOT change the color or appearance of any object between pages.');
  }

  parts.push('');
  parts.push(`SCENE TO ILLUSTRATE: ${cleanScene}`);

  // Admin prompt injection — placed immediately after scene, with high-priority framing
  if (opts.promptInjection && opts.promptInjection.trim()) {
    parts.push('');
    parts.push(`⚠️ ADMIN OVERRIDE — HIGHEST PRIORITY (overrides scene description above if conflicting):`);
    parts.push(opts.promptInjection.trim());
    parts.push(`This override MUST be reflected in the final image. If it conflicts with the scene above, follow THIS instruction.`);
  }

  // Change 16: Scene grounding — BACKGROUND RULE
  parts.push('');
  const bgRule = opts.additionalCoverCharacters
    ? `BACKGROUND RULE: Only the main child and the additional cover characters listed above may appear as human figures. No other human faces or silhouettes in the background. Fictional animals, creatures, and fantastical beings are fine.`
    : `BACKGROUND RULE: No human faces, silhouettes, or figures visible in the background or anywhere in the scene. Any human presence (family, caregivers) is implied only through objects — a cup of tea on a table, a light left on in a window, a handmade quilt on a chair. Fictional animals, creatures, and fantastical beings are fine.`;
  parts.push(bgRule);

  // Change 17: Board book complexity limit
  if (childAge !== undefined && childAge <= 2) {
    parts.push('');
    parts.push('BOARD BOOK COMPOSITION (age 0-2): Extreme close-up or simple centered composition. Maximum 2-3 objects total in the scene. High contrast between subject and background. No complex or busy backgrounds. One clear emotional focal point.');
  }

  parts.push('');
  // Always use the configured art style (pixar_premium by default)
  parts.push(`STYLE: ${styleConfig.prefix} ${styleConfig.suffix}`);
  if (isSpread) {
    parts.push('FORMAT: Wide cinematic landscape illustration spanning TWO facing pages (a book spread). 16:9 aspect ratio.');
    parts.push('SAFE ZONE RULES (CRITICAL — image will be cropped ~6% from top and bottom, and split down the center):');
    parts.push('- Keep ALL important content (faces, text, key objects, hands) within the MIDDLE 85% of the image HEIGHT. The top 7.5% and bottom 7.5% will be cropped — use only for sky/ground/background.');
    parts.push('- GUTTER: The CENTER VERTICAL STRIP (~8% of width) will be hidden in the spine. Never place faces, text, or key objects in the center.');
    parts.push('- Subject centered: place the child and main action in the CENTER 60% of the image width, with background extending to the edges.');
    parts.push('- The left half and right half should each work as a complete, balanced composition.');
  } else {
    parts.push('FORMAT: Square image, 1:1 aspect ratio. The image must be perfectly square.');
  }
  parts.push('Children\'s book illustration, whimsical, warm, fully clothed characters, family-friendly.');

  // Embed story text directly in the illustration
  if (pageText && !skipTextEmbed) {
    parts.push('');
    parts.push('TEXT IN IMAGE:');
    parts.push('Include the following story text as part of this illustration page:');
    parts.push(`"${pageText}"`);
    parts.push('');
    parts.push('TEXT RULES:');
    parts.push('- Render ALL of the text above \u2014 do NOT truncate, cut off, or omit any words');
    parts.push('- The COMPLETE text must be visible and readable in the image');
    const fontInstruction = opts.fontStyle
      ? `- FONT: ${opts.fontStyle} This EXACT same font style MUST be used on EVERY page of the book — no variations, no switching between fonts.`
      : '- FONT: Use Fredoka One exclusively — rounded, bubbly, friendly. This EXACT font MUST appear on every single page of the book. Do NOT switch fonts, do NOT use a different font on any page. Fredoka One only, consistently throughout.';
    parts.push(fontInstruction);
    parts.push('- Place the text in the top or bottom portion where the background is simplest/softest');
    parts.push('- Ensure high contrast between text and background (use a subtle semi-transparent band if needed)');
    parts.push('- Text must be perfectly legible, correctly spelled, and easy to read');
    parts.push('- Integrate the text naturally into the composition');
    parts.push('- Do NOT place text over the character\'s face or the main action');
  }

  // Change 20: Text integration quality rules
  if (pageText && !skipTextEmbed) {
    parts.push('');
    parts.push('TEXT RENDERING RULES (if page text is provided):');
    parts.push('- Render the text EXACTLY as written — no paraphrasing, no additions, no removals');
    parts.push('- Text should appear naturally integrated into the scene: in the sky, on the ground, woven into the environment — never in a box, bubble, banner, or caption');
    parts.push('- Font style should feel handwritten or storybook-style, harmonizing with the illustration');
    parts.push('- Text color should contrast with its immediate background for readability');
  }

  // Change 15: Enumerated anti-weird-stuff checklist (replaces old FINAL CHECK)
  parts.push('');
  parts.push('\u26a0\ufe0f MANDATORY PRE-GENERATE CHECKLIST — mentally verify each before generating:');
  parts.push(`1. CHILD COUNT: exactly 1 child visible in the scene. \u2713`);
  parts.push(`2. ARM COUNT: exactly 2 arms on the child. \u2713`);
  parts.push(`3. HAND COUNT: exactly 2 hands, each with exactly 5 fingers. \u2713`);
  parts.push(`4. LEG COUNT: exactly 2 legs. \u2713`);
  parts.push(`5. NO FLOATING: all held objects are gripped; all resting objects are on surfaces. \u2713`);
  parts.push(`6. CORRECT SCALE: the child's head, body, and limbs are in normal human proportion. \u2713`);
  parts.push(`7. NO DUPLICATES: the child does not appear twice; no reflections showing the child's face. \u2713`);
  parts.push(`8. OUTFIT MATCH: child is wearing exactly: ${characterOutfit || '[match reference photo]'}. \u2713`);
  parts.push(`9. HAIR MATCH: child's hair looks exactly as described in LOCKED APPEARANCE above. \u2713`);
  parts.push(`10. TEXT EXACT: any text rendered in the image matches EXACTLY what is specified in the page text field — no additions, no rewording. \u2713`);
  parts.push(`11. FONT CONSISTENCY: the text font is ${opts.fontStyle ? 'the admin-specified font' : 'Fredoka One'} — the same font used on every other page of this book. \u2713`);
  parts.push('If any check fails, adjust the scene before generating.');

  return parts.join('\n');
}

/**
 * Download a photo from URL and return { base64, mimeType }.
 */
async function downloadPhotoAsBase64(url) {
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) throw new Error(`Failed to download photo: ${resp.status} ${resp.statusText}`);
  const contentType = resp.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await resp.arrayBuffer());
  return { base64: buffer.toString('base64'), mimeType: contentType };
}

/**
 * Call Gemini image generation API.
 *
 * @param {string} prompt - Scene prompt
 * @param {string} photoBase64 - Base64-encoded child photo
 * @param {string} photoMime - MIME type of the photo
 * @returns {Promise<Buffer>} Generated image buffer
 */
async function callGeminiImageApi(prompt, photoBase64, photoMime, abortSignal, opts = {}) {
  const apiKey = getNextApiKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const keyIdx = (keyIndex - 1) % API_KEY_POOL.length;

  const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
  if (opts.aspectRatio) {
    generationConfig.imageConfig = { aspectRatio: opts.aspectRatio };
  }

  // Build parts: text prompt + cover reference + optional previous illustration reference
  const parts = [
    { text: prompt },
    { inline_data: { mimeType: photoMime || 'image/jpeg', data: photoBase64 } },
  ];

  if (opts.prevIllustrationBase64) {
    parts.push({ text: 'PREVIOUS SPREAD ILLUSTRATION (reference for style consistency — match the art style, color palette, lighting mood, and character rendering quality from this image. Apply to the NEW scene described above. Do NOT copy the scene or composition):' });
    parts.push({ inline_data: { mimeType: opts.prevIllustrationMime || 'image/jpeg', data: opts.prevIllustrationBase64 } });
  }

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig,
  };

  const epStart = Date.now();
  console.log(`[illustrationGenerator] Trying public-${keyIdx} with photo reference${opts.prevIllustrationBase64 ? ' + prev illustration' : ''}...`);
  try {
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 180000, abortSignal);

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      const isNsfw = resp.status === 400 && (errBody.includes('safety') || errBody.includes('SAFETY') || errBody.includes('blocked'));
      if (isNsfw) {
        const err = new Error(`Gemini image API (public-${keyIdx}) NSFW block: ${errBody.slice(0, 200)}`);
        err.isNsfw = true;
        throw err;
      }
      throw new Error(`Gemini image API (public-${keyIdx}) error ${resp.status}: ${errBody.slice(0, 200)}`);
    }

    const data = await resp.json();
    const imagePart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!imagePart) throw new Error(`No image in Gemini response (public-${keyIdx})`);

    const imgBuf = Buffer.from(imagePart.inlineData.data, 'base64');
    const elapsedMs = Date.now() - epStart;
    console.log(`[illustrationGenerator] \u2705 public-${keyIdx} with photo succeeded (${elapsedMs}ms, ${imgBuf.length} bytes)`);
    // If this key responded fast, stick with it
    if (elapsedMs < 60000) {
      markKeyFast(keyIdx);
    }
    return imgBuf;
  } catch (err) {
    console.warn(`[illustrationGenerator] \u274c public-${keyIdx} with photo failed after ${Date.now() - epStart}ms: ${err.message.slice(0, 200)}`);
    throw err;
  }
}

/**
 * Call Gemini image generation API without a reference photo.
 *
 * @param {string} prompt - Scene prompt
 * @param {number} [deadlineMs] - Milliseconds remaining before outer deadline
 * @returns {Promise<Buffer>} Generated image buffer
 */
async function callGeminiImageApiNoPhoto(prompt, deadlineMs, abortSignal, opts = {}) {
  const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
  if (opts.aspectRatio) {
    generationConfig.imageConfig = { aspectRatio: opts.aspectRatio };
  }

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
  };

  // Round-robin across API key pool (each key = different GCP project)
  const apiKey = getNextApiKey();
  const publicUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  // Build endpoint list: primary (round-robin key) + proxy fallback
  const endpoints = [
    { url: publicUrl, headers: { 'Content-Type': 'application/json' }, label: `public-${(keyIndex - 1) % API_KEY_POOL.length}` },
    ...(PROXY_URL ? [{
      url: `${PROXY_URL}/generate-image`,
      headers: { 'Content-Type': 'application/json', 'x-api-key': PROXY_API_KEY },
      label: 'gemini-proxy',
      bodyTransform: (b) => ({ prompt: b.contents[0].parts[0].text, model: 'gemini-3.1-flash-image-preview' })
    }] : []),
  ];

  for (const ep of endpoints) {
    // Deadline check: skip if less than 10s remaining
    if (deadlineMs !== undefined && deadlineMs < 10000) {
      console.warn(`[illustrationGenerator] Skipping ${ep.label} \u2014 only ${Math.round(deadlineMs / 1000)}s remaining before deadline`);
      break;
    }
    const endpointTimeout = deadlineMs !== undefined ? Math.max(10000, deadlineMs - 5000) : 120000;

    const epStart = Date.now();
    console.log(`[illustrationGenerator] Trying ${ep.label} endpoint (timeout ${Math.round(endpointTimeout / 1000)}s)...`);
    try {
      let resp;
      if (ep.label === 'gemini-proxy') {
        const proxyBody = { prompt: body.contents[0].parts[0].text, model: 'gemini-3.1-flash-image-preview' };
        resp = await fetchWithTimeout(ep.url, {
          method: 'POST',
          headers: ep.headers,
          body: JSON.stringify(proxyBody),
        }, endpointTimeout, abortSignal);
      } else {
        resp = await fetchWithTimeout(ep.url, {
          method: 'POST',
          headers: ep.headers,
          body: JSON.stringify(body),
        }, endpointTimeout, abortSignal);
      }

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        const isNsfw = resp.status === 400 && (errBody.includes('safety') || errBody.includes('SAFETY') || errBody.includes('blocked'));
        if (isNsfw) {
          const err = new Error(`Gemini image API (${ep.label}) NSFW block: ${errBody.slice(0, 200)}`);
          err.isNsfw = true;
          throw err;
        }
        throw new Error(`Gemini image API (${ep.label}) error ${resp.status}: ${errBody.slice(0, 200)}`);
      }

      if (ep.label === 'gemini-proxy') {
        const data = await resp.json();
        if (!data.imageBase64) throw new Error('No image from gemini-proxy');
        const imgBuf = Buffer.from(data.imageBase64, 'base64');
        console.log(`[illustrationGenerator] \u2705 ${ep.label} succeeded (${Date.now() - epStart}ms, ${imgBuf.length} bytes)`);
        return imgBuf;
      }

      const data = await resp.json();
      const imagePart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (!imagePart) throw new Error(`No image in Gemini response (${ep.label})`);

      const imgBuf = Buffer.from(imagePart.inlineData.data, 'base64');
      console.log(`[illustrationGenerator] \u2705 ${ep.label} succeeded (${Date.now() - epStart}ms, ${imgBuf.length} bytes)`);
      return imgBuf;
    } catch (err) {
      console.warn(`[illustrationGenerator] \u274c ${ep.label} failed after ${Date.now() - epStart}ms: ${err.message.slice(0, 200)}`);
      if (err.isNsfw) throw err;
      if (ep === endpoints[endpoints.length - 1]) throw err;
      // Update remaining deadline for next endpoint
      if (deadlineMs !== undefined) {
        deadlineMs -= (Date.now() - epStart);
      }
    }
  }
}

/**
 * Generate a single illustration for a book spread.
 *
 * Uses Gemini image API with the child's photo as reference for
 * face-consistent illustrations.
 *
 * @param {string} sceneDescription - What the illustration should depict
 * @param {string} characterRefUrl - (ignored, kept for API compat)
 * @param {string} artStyle - 'watercolor', 'digital_painting', or 'storybook'
 * @param {object} [opts] - { apiKeys, costTracker, bookId, childName, childPhotoUrl, _cachedPhotoBase64, _cachedPhotoMime, spreadIndex, deadlineMs }
 * @returns {Promise<string|null>} URL of the generated illustration, or null if skipped
 */
async function generateIllustration(sceneDescription, characterRefUrl, artStyle, opts = {}) {
  const totalStart = Date.now();
  const { costTracker, bookId, childName, childPhotoUrl, spreadIndex } = opts;

  const isSpread = opts.isSpread || false;
  const fullPrompt = buildCharacterPrompt(sceneDescription, artStyle, childName, opts.pageText, opts.characterOutfit, opts.characterDescription, opts.recurringElement, opts.keyObjects, { skipTextEmbed: opts.skipTextEmbed, coverArtStyle: opts.coverArtStyle, isSpread, spreadIndex: opts.spreadIndex, totalSpreads: opts.totalSpreads || 13, childAge: opts.childAge, promptInjection: opts.promptInjection, fontStyle: opts.fontStyle, additionalCoverCharacters: opts.additionalCoverCharacters || null });
  const aspectRatio = isSpread ? '16:9' : '1:1';

  console.log(`[illustrationGenerator] === Illustration for book ${bookId || 'unknown'}, spread ${spreadIndex !== undefined ? spreadIndex + 1 : '?'} ===`);
  console.log(`[illustrationGenerator] Prompt length: ${fullPrompt.length} chars`);
  console.log(`[illustrationGenerator] Scene: ${sceneDescription.slice(0, 200)}${sceneDescription.length > 200 ? '...' : ''}`);
  console.log(`[illustrationGenerator] Page text: ${opts.pageText || '(none)'}`);
  console.log(`[illustrationGenerator] Outfit: ${opts.characterOutfit || '(none)'}`);
  console.log(`[illustrationGenerator] Has cover ref: ${!!opts._cachedPhotoBase64}, Style: ${artStyle}`);

  // Resolve photo base64 (use cached if available)
  let photoBase64 = opts._cachedPhotoBase64 || null;
  let photoMime = opts._cachedPhotoMime || 'image/jpeg';
  const hasPhoto = !!(photoBase64 || childPhotoUrl);

  if (!photoBase64 && childPhotoUrl) {
    try {
      const photo = await downloadPhotoAsBase64(childPhotoUrl);
      photoBase64 = photo.base64;
      photoMime = photo.mimeType;
    } catch (dlErr) {
      console.warn(`[illustrationGenerator] Failed to download child photo for book ${bookId}: ${dlErr.message} \u2014 generating without photo reference`);
    }
  }

  // Download previous illustration as reference (admin regeneration only)
  let prevIllustrationBase64 = null;
  let prevIllustrationMime = 'image/jpeg';
  if (opts.prevIllustrationUrl) {
    try {
      const prev = await downloadPhotoAsBase64(opts.prevIllustrationUrl);
      prevIllustrationBase64 = prev.base64;
      prevIllustrationMime = prev.mimeType;
      console.log(`[illustrationGenerator] Previous illustration loaded as reference (${Math.round(prev.base64.length * 0.75 / 1024)}KB)`);
    } catch (e) {
      console.warn(`[illustrationGenerator] Could not load prev illustration reference: ${e.message}`);
    }
  }

  // Build prompt variants for NSFW fallback
  const promptVariants = [
    { label: 'original', prompt: fullPrompt },
    { label: 'sanitized', prompt: sanitizePrompt(fullPrompt) },
    { label: 'generic-safe', prompt: buildGenericSafePrompt(artStyle) },
  ];

  let promptVariantIndex = 0;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const variant = promptVariants[promptVariantIndex];
    try {
      const geminiStart = Date.now();

      let imageBuffer;
      // Always use cover image as reference for character likeness
      if (photoBase64) {
        imageBuffer = await callGeminiImageApi(variant.prompt, photoBase64, photoMime, opts.abortSignal, { aspectRatio, prevIllustrationBase64, prevIllustrationMime });
      } else {
        const elapsed = Date.now() - totalStart;
        const remaining = opts.deadlineMs ? opts.deadlineMs - elapsed : undefined;
        imageBuffer = await callGeminiImageApiNoPhoto(variant.prompt, remaining, opts.abortSignal, { aspectRatio });
      }

      const geminiMs = Date.now() - geminiStart;
      console.log(`[illustrationGenerator] Gemini image generated (attempt ${attempt}, ${variant.label}, ${geminiMs}ms, ${imageBuffer.length} bytes)`);

      if (costTracker) {
        costTracker.addImageGeneration('gemini-3.1-flash-image-preview', 1);
      }

      console.log(`[illustrationGenerator] Accepted illustration on attempt ${attempt} (${variant.label}) for book ${bookId || 'unknown'}`);

      // Upload to GCS
      if (bookId) {
        const uploadStart = Date.now();
        const gcsPath = `children-jobs/${bookId}/illustrations/${Date.now()}.png`;
        const gcsUrl = await withRetry(
          () => uploadBuffer(imageBuffer, gcsPath, 'image/png'),
          { maxRetries: 3, baseDelayMs: 1000, label: `upload-illustration-${bookId}` }
        );
        console.log(`[illustrationGenerator] Illustration uploaded to GCS (${Date.now() - uploadStart}ms)`);
        console.log(`[illustrationGenerator] Total illustration time: ${Date.now() - totalStart}ms`);
        return gcsUrl;
      }

      // No bookId \u2014 can't upload, but this shouldn't happen in production
      console.log(`[illustrationGenerator] Total illustration time: ${Date.now() - totalStart}ms`);
      return null;
    } catch (genErr) {
      if (genErr.isNsfw) {
        console.warn(`[illustrationGenerator] NSFW detected on attempt ${attempt} (${variant.label}) for book ${bookId || 'unknown'}: ${genErr.message}`);
        promptVariantIndex++;
        if (promptVariantIndex >= promptVariants.length) {
          console.error(`[illustrationGenerator] All ${promptVariants.length} prompt variants triggered NSFW for book ${bookId || 'unknown'}. Skipping illustration. (${Date.now() - totalStart}ms)`);
          return null;
        }
        continue;
      }

      console.error(`[illustrationGenerator] Attempt ${attempt} failed: ${genErr.message} (${Date.now() - totalStart}ms)`);
      if (attempt === MAX_RETRIES) {
        throw new Error(`Illustration generation failed after ${MAX_RETRIES} attempts: ${genErr.message}`);
      }
    }
  }

  throw new Error('No illustration generated after all attempts');
}

module.exports = { generateIllustration, buildCharacterPrompt, getNextApiKey, ART_STYLE_CONFIG, fetchWithTimeout };
