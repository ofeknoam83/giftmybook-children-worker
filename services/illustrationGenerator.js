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

/** Themes where the parent should be shown via implied presence (not drawn in full) when they're not on the cover */
const PARENT_THEMES = new Set(['mothers_day', 'fathers_day']);

/** Maximum retry attempts per illustration (includes text verification retries) */
const BASE_MAX_RETRIES = 3;
const TEXT_HEAVY_MAX_RETRIES = 5;

const TEXT_VERIFY_MODEL = 'gemini-2.5-flash';

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
  graphic_novel_cinematic: {
    prefix: 'Cinematic 3D middle-grade graphic novel panel illustration,',
    suffix: 'Pixar-like 3D CGI animation adapted for sequential art, photorealistic subsurface skin scattering, volumetric cinematic lighting with dramatic rim lights, rich saturated color palette, emotionally expressive characters with readable facial acting, clean graphic silhouettes, simplified backgrounds in small panels with full environments in establishing shots, controlled depth of field, Disney-Pixar production quality, print-optimized color contrast, warm golden-hour atmosphere, premium sequential-art storytelling',
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

function buildComicPanelPrompt(sceneDescription, artStyle, childName, pageText, characterOutfit, characterDescription, recurringElement, keyObjects, opts = {}) {
  const requestedStyle = artStyle === 'cinematic_3d' || artStyle === 'pixar_premium'
    ? 'graphic_novel_cinematic'
    : artStyle;
  const styleConfig = ART_STYLE_CONFIG[requestedStyle] || ART_STYLE_CONFIG.graphic_novel_cinematic;
  const parts = [];
  const textFreeZone = opts.textFreeZone || 'top-right';
  const balloons = Array.isArray(opts.balloons) ? opts.balloons.filter((item) => item && item.text) : [];
  const captions = Array.isArray(opts.captions) ? opts.captions.filter((item) => item && item.text) : [];
  const sfx = Array.isArray(opts.sfx) ? opts.sfx.filter((item) => item && item.text) : [];
  const layoutHint = opts.layoutTemplate || opts.pageLayout || 'conversationGrid';

  parts.push('Create one premium middle-grade graphic novel panel.');
  parts.push('This is sequential art, not a picture-book spread and not a collage.');
  parts.push('The art must feel like a first-class designed graphic novel for ages 9-12.');
  parts.push('No text may appear inside the image. All dialogue, captions, and SFX will be added later in vector lettering.');
  parts.push('');

  if (childName) {
    parts.push(`PRIMARY HERO: ${childName}.`);
  }
  if (characterDescription) {
    parts.push(`LOCKED HERO APPEARANCE: ${characterDescription}`);
  }
  if (opts.characterAnchor) {
    parts.push(`CHARACTER ANCHOR LOCK: ${opts.characterAnchor}`);
  }
  if (characterOutfit) {
    parts.push(`OUTFIT LOCK: ${characterOutfit}`);
  }
  if (opts.additionalCoverCharacters) {
    parts.push(`ALLOWED SUPPORTING CHARACTERS ONLY: ${opts.additionalCoverCharacters}`);
    parts.push('SECONDARY CHARACTER CONSISTENCY: Same hair, skin tone, build, and features on every panel. Match the uploaded reference photo exactly.');
  } else {
    parts.push('NO FAMILY MEMBERS: Do NOT draw the child\'s parents, siblings, or grandparents. Only fictional characters (aliens, creatures, villains, etc.) may interact with the child.');
  }
  if (recurringElement) {
    parts.push(`RECURRING MOTIF: ${recurringElement}`);
  }
  if (keyObjects) {
    parts.push(`LOCKED RECURRING PROPS: ${keyObjects}`);
  }

  parts.push('');
  parts.push(`COMIC STAGING: ${sceneDescription}`);
  if (opts.panelType) parts.push(`PANEL TYPE: ${opts.panelType}`);
  if (opts.shot) parts.push(`SHOT SIZE: ${opts.shot}`);
  if (opts.cameraAngle) parts.push(`CAMERA ANGLE: ${opts.cameraAngle}`);
  if (opts.actingNotes) parts.push(`ACTING NOTES: ${opts.actingNotes}`);
  if (opts.backgroundComplexity) parts.push(`BACKGROUND COMPLEXITY: ${opts.backgroundComplexity}`);
  if (opts.colorScript) {
    parts.push(`COLOR SCRIPT: ${typeof opts.colorScript === 'string' ? opts.colorScript : JSON.stringify(opts.colorScript)}`);
  }
  parts.push(`LAYOUT CONTEXT: This panel belongs to the "${layoutHint}" page template. Compose for clear reading order and leave intentional open space for lettering.`);
  parts.push(`TEXT SAFE SPACE: preserve clean negative space in the ${textFreeZone} zone. Do not place faces, mouths, or the main action there.`);
  parts.push('CRITICAL TEXT WIDTH RULE: When text is overlaid later, it MUST occupy no more than 35% of the page width. This is a hard limit. Ensure the reserved text zone is narrow (no wider than 35% of the image width).');

  if (balloons.length) {
    parts.push(`LETTERING PLAN: ${balloons.length} speech balloons will be overlaid later. Keep the ${textFreeZone} zone uncluttered for them.`);
  }
  if (captions.length) {
    parts.push(`CAPTION PLAN: ${captions.length} caption box(es) will be overlaid later. Maintain a clean band for them.`);
  }
  if (sfx.length) {
    parts.push(`SFX PLAN: Reserve visual room for sound effects: ${sfx.map((item) => item.text).join(', ')}.`);
  }

  parts.push('');
  parts.push('COMIC ART DIRECTION RULES:');
  parts.push('- prioritize silhouette clarity and facial readability');
  parts.push('- simplify backgrounds in small or dialogue-heavy panels');
  parts.push('- use dramatic 3D cinematic lighting with volumetric light shafts and rim lights for depth');
  parts.push('- render characters with Pixar-quality subsurface skin scattering and expressive eyes');
  parts.push('- use rich saturated colors with clear value separation for print readability');
  parts.push('- avoid heavy bokeh, clutter, muddy shadows, or film-frame noise');
  parts.push('- keep one clear focal point');
  parts.push('- preserve continuity with previous panels and references');
  parts.push('- no split-screen, no multi-panel collage, no caption boxes, no speech bubbles, no letters, no words');
  parts.push('');
  parts.push(`STYLE: ${styleConfig.prefix} ${styleConfig.suffix}`);
  if (opts.aspectRatioHint) parts.push(`ASPECT RATIO INTENT: ${opts.aspectRatioHint}`);
  parts.push('Wholesome, family-friendly, emotionally expressive, premium sequential art.');

  if (pageText && !opts.skipTextEmbed) {
    parts.push('Do not render this text in the image. It is reference-only for performance and tone:');
    parts.push(pageText);
  }

  return parts.join('\n');
}

/**
 * Build a full-page comic prompt for graphic novels.
 * Instead of generating individual panels, this creates a prompt for the ENTIRE page
 * including panels, borders, speech bubbles with text, captions, and sound effects.
 * The AI image model renders everything in one shot.
 *
 * @param {string} fullPagePrompt - LLM-written page composition description (from story planner)
 * @param {string} artStyle - Art style key
 * @param {string} childName - Protagonist name
 * @param {object} opts - Character/world details and art direction
 * @returns {string} Complete prompt for full-page generation
 */
function buildComicPagePrompt(fullPagePrompt, artStyle, childName, opts = {}) {
  // Use the same Pixar/cinematic style as regular children's books — the user wants premium 3D, not a flat comic style
  const styleConfig = ART_STYLE_CONFIG[artStyle] || ART_STYLE_CONFIG.cinematic_3d || ART_STYLE_CONFIG.pixar_premium;
  const parts = [];

  // ── PRIORITY 1: What this image IS (comic page, not a single illustration) ──
  parts.push('⚠️ OUTPUT FORMAT — THIS IS A COMIC BOOK PAGE, NOT A SINGLE ILLUSTRATION:');
  parts.push('Render a complete COMIC BOOK PAGE with multiple PANELS arranged in a grid layout.');
  parts.push('The output must look like a page ripped from a premium Pixar-style graphic novel:');
  parts.push('- Multiple panels separated by dark ink borders and white gutters');
  parts.push('- White speech bubbles with dark outlines and pointed tails toward speakers');
  parts.push('- Caption boxes with text inside them');
  parts.push('- Sound effects as bold stylized lettering');
  parts.push('- White margins around the outer page edges');
  parts.push('This is NOT a single scene. It is a MULTI-PANEL COMIC PAGE with SEQUENTIAL STORYTELLING.');
  parts.push('');

  // ── PRIORITY 2: The page composition (what to draw) ──
  parts.push('=== PAGE COMPOSITION (follow this exactly) ===');
  parts.push(fullPagePrompt);
  parts.push('');

  // ── PRIORITY 3: Text rendering (CRITICAL) ──
  parts.push('=== TEXT & LETTERING (MANDATORY — pages without text will be REJECTED) ===');
  parts.push('You MUST render ALL text described above as visible, legible text in the image:');
  parts.push('• SPEECH BUBBLES: White oval/round bubbles with 1-2pt dark outline and a pointed tail toward the speaker. The EXACT dialogue text must be written inside in clean, readable black lettering.');
  parts.push('• THOUGHT BUBBLES: Cloud/puffy shape with small circles trailing to the thinker. Thought text inside.');
  parts.push('• SHOUT BUBBLES: Jagged/starburst spiky shape. Bold uppercase text inside.');
  parts.push('• CAPTION BOXES: Rectangular boxes. Narration = dark navy background with white text. Location = cream background with dark text.');
  parts.push('• SOUND EFFECTS: LIMIT to at most 1-2 per page. Use large bold stylized comic lettering only for genuinely impactful moments. Do NOT overuse sound words (BANG, WHOOSH, CRASH, SPLAT, etc.). Describe actions through vivid imagery and movement rather than excessive sound effects.');
  parts.push('• Text must be LARGE ENOUGH to read when printed at 6×9 inches. Minimum apparent font size: 8pt equivalent.');
  parts.push('• Reading order: top-to-bottom, left-to-right within each panel.');
  parts.push('• Every speech bubble, caption, and SFX mentioned in the page composition MUST appear as rendered text.');
  parts.push('');

  // ── PRIORITY 4: Art style (same premium Pixar 3D as children's books) ──
  parts.push('=== ART STYLE ===');
  parts.push(`${styleConfig.prefix} ${styleConfig.suffix}`);
  parts.push('The art in each panel must be PREMIUM 3D CINEMATIC PIXAR QUALITY — the same lush, photorealistic 3D CGI render style used in Pixar and DreamWorks animated films.');
  parts.push('Volumetric cinematic lighting with warm golden tones, subsurface skin scattering, rich saturated colors, dreamy depth-of-field bokeh backgrounds.');
  parts.push('Characters must be emotionally expressive with soft, appealing Pixar-style faces.');
  if (opts.colorScript) {
    const cs = typeof opts.colorScript === 'string' ? opts.colorScript : JSON.stringify(opts.colorScript);
    parts.push(`Color direction: ${cs}`);
  }
  parts.push('');

  // ── PRIORITY 5: Character identity (condensed) ──
  const charParts = [];
  if (childName) charParts.push(`Hero: ${childName}.`);
  if (opts.characterDescription) charParts.push(`Appearance: ${opts.characterDescription}`);
  if (opts.characterAnchor) charParts.push(`Anchor lock: ${opts.characterAnchor}`);
  if (opts.recurringElement) charParts.push(`Recurring motif: ${opts.recurringElement}`);
  if (opts.keyObjects) charParts.push(`Recurring props: ${opts.keyObjects}`);
  if (opts.characterDescription) {
    const negatives = buildHairNegatives(opts.characterDescription);
    if (negatives) charParts.push(negatives);
  }
  if (charParts.length > 0) {
    parts.push('=== CHARACTER IDENTITY (maintain consistency) ===');
    parts.push(charParts.join('\n'));
    parts.push('');
  }

  // ── OUTFIT LOCK (ported from buildCharacterPrompt for full consistency) ──
  if (opts.characterOutfit) {
    parts.push('=== OUTFIT LOCK (CRITICAL) ===');
    parts.push(`The child MUST wear EXACTLY this outfit on EVERY panel of EVERY page — no exceptions: ${opts.characterOutfit}`);
    parts.push('COLOR VERIFICATION: Before finishing, verify EACH garment\'s color matches the outfit description. A red shirt must be RED, not maroon, not pink, not orange.');
    parts.push('FORBIDDEN OUTFIT CHANGES: Do NOT add, remove, or swap ANY clothing item — not for swimming, sleeping, rain, sports, or any activity.');
    parts.push('Do NOT add accessories, hats, capes, helmets, or costumes that are not in the outfit description.');
    parts.push('The outfit must be pixel-for-pixel identical across all panels.');
    parts.push('');
  }

  // ── TEXT CONSISTENCY RULES ──
  parts.push('=== TEXT CONSISTENCY ===');
  parts.push('Font style and size must be consistent across all pages.');
  parts.push('CRITICAL TEXT WIDTH RULE: All text MUST occupy no more than 35% of the page width. This is a hard limit — text that exceeds 35% width will cause the page to be REJECTED. Use shorter lines and more line breaks rather than wide text blocks. Verify text width before finalizing.');
  parts.push('Use only embedded text — no overlays.');
  parts.push('');

  // ── PRIORITY 6: Family member rules ──
  if (opts.additionalCoverCharacters) {
    parts.push('=== ALLOWED SECONDARY CHARACTERS ===');
    parts.push(`The following characters appear on the book cover and MAY appear in panels. Draw them as described — do NOT invent new relatives or characters not listed here:`);
    parts.push(opts.additionalCoverCharacters);
    parts.push(`IMPORTANT: Only the characters listed above are allowed. Do NOT add any other family members, parents, siblings, or relatives beyond what is listed.`);
    parts.push('SECONDARY CHARACTER CONSISTENCY LOCK:');
    parts.push('- Same hair color, style, and length on every page');
    parts.push('- Same skin tone and facial features on every page');
    parts.push('- Same approximate age and build on every page');
    parts.push('- Do NOT change their ethnicity, hair, or skin tone between pages');
    parts.push('- Match their appearance to the uploaded reference photo');
    parts.push('');
  } else {
    parts.push('=== NO FAMILY MEMBERS IN PANELS ===');
    parts.push('Do NOT draw the child\'s parents, siblings, grandparents, or any real-life relatives. We do not have their photos and cannot depict them accurately.');
    parts.push('The child may interact with fictional characters (shopkeepers, aliens, talking animals, magical creatures, villains) but NEVER with family members.');
    parts.push('If a parent or relative is mentioned in dialogue, show only their EFFECT (a warm light, a hand at the edge of frame, a voice) — never their face or full body.');
    parts.push('');
  }

  // ── First-page reference image for outfit/style/text consistency ──
  if (opts.firstPageRefBase64) {
    parts.push('=== FIRST PAGE REFERENCE ===');
    parts.push('REFERENCE PAGE (first page): Match the outfit rendering, color palette, art style, text placement, and font from this reference page exactly.');
    parts.push('');
  }

  parts.push('ASPECT RATIO: 2:3 (vertical/portrait page).');
  parts.push('Wholesome, family-friendly, premium sequential art. Print-ready quality.');

  return parts.join('\n');
}

function determineAspectRatio(opts = {}) {
  if (opts.aspectRatio) return opts.aspectRatio;
  if (opts.comicPageMode) return '2:3';
  if (!opts.comicMode) return opts.isSpread ? '16:9' : '1:1';
  if (opts.layoutTemplate === 'fullBleedSplash' || opts.panelType === 'splash') return '3:4';
  if (opts.panelType === 'establishing' || opts.layoutTemplate === 'cinematicTopStrip') return '16:9';
  if (opts.panelType === 'closeup') return '3:4';
  return '4:3';
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
 * Simple Levenshtein distance implementation.
 */
function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Use single-row optimization
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Compare expected page text against OCR-extracted text from the generated image.
 * Uses word-frequency bags to detect duplications and missing words,
 * plus character-level Levenshtein distance for overall similarity.
 */
function compareTexts(expected, extracted) {
  const normalize = (s) => s.toLowerCase().replace(/[^\w\s']/g, '').replace(/\s+/g, ' ').trim();
  const toWordBag = (s) => {
    const bag = {};
    for (const w of normalize(s).split(' ').filter(Boolean)) {
      bag[w] = (bag[w] || 0) + 1;
    }
    return bag;
  };

  const normalizedExpected = normalize(expected);
  const normalizedExtracted = normalize(extracted);
  const expectedBag = toWordBag(expected);
  const extractedBag = toWordBag(extracted);
  const issues = [];

  // Existing word-bag duplicate check
  for (const [word, count] of Object.entries(extractedBag)) {
    const expectedCount = expectedBag[word] || 0;
    if (count > expectedCount) {
      issues.push(`"${word}" appears ${count}x in illustration (expected ${expectedCount}x) — text rendered twice`);
    }
  }

  let missingCount = 0;
  const uniqueExpected = Object.keys(expectedBag).length;
  for (const word of Object.keys(expectedBag)) {
    if (!extractedBag[word]) missingCount++;
  }
  if (uniqueExpected > 0 && missingCount / uniqueExpected > 0.25) {
    issues.push(`${missingCount}/${uniqueExpected} unique words missing`);
  }

  // NEW: Character-level similarity check
  if (normalizedExpected.length > 0 && normalizedExtracted.length > 0) {
    const editDist = levenshteinDistance(normalizedExpected, normalizedExtracted);
    const maxLen = Math.max(normalizedExpected.length, normalizedExtracted.length);
    const similarity = 1 - (editDist / maxLen);
    if (similarity < 0.85) {
      issues.push(`Character similarity ${(similarity * 100).toFixed(0)}% (need 85%+)`);
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Verify that the text rendered in a generated illustration matches the expected page text.
 * Uses Gemini Vision to OCR the image, then compares word-by-word.
 * Returns { valid, extractedText, issues } — on any error, returns valid=true (accept image).
 */
async function verifyImageText(imageBuffer, expectedText, abortSignal, costTracker) {
  if (!expectedText || !expectedText.trim()) return { valid: true };

  const apiKey = getNextApiKey();
  if (!apiKey) return { valid: true, reason: 'no API key' };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_VERIFY_MODEL}:generateContent?key=${apiKey}`;
  const imageBase64 = imageBuffer.toString('base64');

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mimeType: 'image/png', data: imageBase64 } },
        { text: 'Read ALL text visible in this image. Return ONLY the exact text as it appears, preserving word order. No commentary.' },
      ],
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 500 },
  };

  try {
    const start = Date.now();
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 30000, abortSignal);

    if (costTracker) costTracker.addTextUsage(TEXT_VERIFY_MODEL, 500, 100);

    if (!resp.ok) {
      console.warn(`[illustrationGenerator] Text verify API error ${resp.status} (${Date.now() - start}ms) — accepting image`);
      return { valid: true, reason: `API error ${resp.status}` };
    }

    const data = await resp.json();
    const extractedText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    console.log(`[illustrationGenerator] Text verify OCR (${Date.now() - start}ms): "${extractedText.slice(0, 120)}${extractedText.length > 120 ? '...' : ''}"`);

    if (!extractedText) return { valid: true, reason: 'no text extracted' };

    const result = compareTexts(expectedText, extractedText);
    if (!result.valid) {
      console.warn(`[illustrationGenerator] Text verify FAILED: ${result.issues.join('; ')}`);
    }
    return { ...result, extractedText };
  } catch (e) {
    console.warn(`[illustrationGenerator] Text verify error: ${e.message} — accepting image`);
    return { valid: true, reason: e.message };
  }
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
  if (opts.comicPageMode) {
    return buildComicPagePrompt(
      sceneDescription,  // In comicPageMode, sceneDescription IS the fullPagePrompt
      artStyle,
      childName,
      {
        characterDescription,
        characterAnchor: opts.characterAnchor,
        characterOutfit,
        additionalCoverCharacters: opts.additionalCoverCharacters,
        recurringElement,
        keyObjects,
        colorScript: opts.colorScript,
        firstPageRefBase64: opts.firstPageRefBase64,
      }
    );
  }
  if (opts.comicMode) {
    return buildComicPanelPrompt(
      sceneDescription,
      artStyle,
      childName,
      pageText,
      characterOutfit,
      characterDescription,
      recurringElement,
      keyObjects,
      opts
    );
  }

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

  // ── Character consistency prefix (Fix 5b + 6b) ──
  // Prepend character appearance, outfit, and recurring element to EVERY prompt
  // so the model never relies on "memory" from prior turns.
  if (opts.characterAnchor) {
    parts.push(`CHARACTER SKIN TONE & FEATURES (from uploaded photo — NEVER alter):`);
    parts.push(opts.characterAnchor);
    parts.push(`CRITICAL: The child's skin tone, hair color, and facial features must match the description above in EVERY illustration. Do not lighten, darken, or alter the child's appearance. Racial and ethnic features must be preserved exactly. The child's eyes must ALWAYS be drawn OPEN and expressive — never closed or squinting, even if the reference photo shows closed eyes.`);
    parts.push(``);
  }
  if (characterDescription) {
    parts.push(`CHARACTER APPEARANCE: ${characterDescription}`);
  }

  // Name interpretation rule — prevent literal depiction of names
  const childNameStr = opts.childName || childName || '';
  if (childNameStr) {
    parts.push(`\nNAME INTERPRETATION RULE (CRITICAL):\nAll character names are PROPER NOUNS referring to HUMAN characters.\n"${childNameStr}" is a HUMAN CHILD — do NOT depict as a literal ${childNameStr.toLowerCase()} (object/animal/flower/concept).`);
    if (opts.additionalCoverCharacters) {
      parts.push(`Any named characters in this story are HUMAN. Never depict a person as a literal object based on their name.`);
    }
  }
  if (characterOutfit) {
    parts.push(`CHARACTER OUTFIT (MUST match exactly — no changes): ${characterOutfit}`);
  }
  if (opts.firstSpreadRefBase64) {
    parts.push('OUTFIT & STYLE REFERENCE: The attached "first spread" image shows EXACTLY how this child\'s outfit should look in this book\'s art style. Match the outfit rendering — same garments, same colors, same style. Match the art style, lighting, and color palette.');
  }
  if (recurringElement) {
    parts.push(`RECURRING OBJECT: ${recurringElement}`);
  }
  parts.push(``);

  // C2: CHARACTER description is the VERY FIRST block in the prompt
  parts.push(`DRAW THIS EXACT CHILD — match the reference photo precisely:`);
  if (opts.characterAnchor) {
    parts.push(opts.characterAnchor);
  } else {
    parts.push(`${characterDescription ? characterDescription : 'Match the child in the reference photo exactly.'}`);
  }
  // Extract hair style from characterDescription for emphasis
  const hairMatch = (characterDescription || '').match(/hair[:\s]+([^.;,]+)/i) || (characterDescription || '').match(/((?:straight|curly|wavy|coily|braided|short|long|medium)[^.;]*hair[^.;]*)/i);
  const hairStyle = hairMatch ? hairMatch[1].trim() : (characterDescription || 'as shown in the reference photo');
  parts.push(`HAIR: ${hairStyle} — IDENTICAL in every illustration, never changes.`);
  parts.push(`OUTFIT: ${characterOutfit || 'match the reference photo'} — IDENTICAL in every illustration, never changes.`);
  parts.push(`This is the ONLY child in this book. Their appearance does NOT change between illustrations.`);
  parts.push(`Do not modify their hair, outfit, or any physical features.`);
  parts.push(``);

  // Change 22: Per-spread continuity anchor
  if (spreadIndex !== undefined) {
    parts.push(`CONTINUITY: This is illustration ${spreadIndex + 1} of ${totalSpreads} for the same book. The child's face, hair, body proportions, and clothing are IDENTICAL to all other illustrations in this book. However, each spread illustrates a DIFFERENT scene and moment — the composition, background, setting, camera angle, and character pose must all be visibly distinct from every other spread.`);
    parts.push(``);
  }

  parts.push(`\u26a0\ufe0f CRITICAL RULES (READ FIRST, VIOLATING ANY = REJECTED IMAGE):`);
  parts.push(``);
  let charCountRule;
  if (opts.additionalCoverCharacters) {
    charCountRule = `1. CHARACTER COUNT — STRICT:\n   - The image must contain EXACTLY the main child plus the additional cover characters listed below and no others.\n   - ZERO additional people anywhere: no background pedestrians, no shadow figures, no reflections showing extra people, no babies, no siblings, no pets unless explicitly in the scene text.\n   - No duplicate characters: the child appears ONCE, not as a reflection or shadow copy.\n   - When in doubt, FEWER characters is ALWAYS correct.`;
  } else if (opts.theme && PARENT_THEMES.has(opts.theme)) {
    charCountRule = `1. CHARACTER COUNT — STRICT:\n   - The image must contain EXACTLY the characters described in the scene text and no others.\n   - If the scene mentions ONLY the child → EXACTLY ONE person visible. No exceptions.\n   - If the scene mentions a parent → show the parent through IMPLIED PRESENCE ONLY: a hand reaching into frame, a shadow, feet at the edge, the child talking to someone just off-screen, or evidence of the parent (their coffee cup, bag, warm glow). NEVER draw the parent's full face or body — only hints and traces. The character count should still be ONE (just the child).\n   - ZERO additional people anywhere: no background pedestrians, no shadow figures, no reflections showing extra people, no babies, no siblings, no pets unless explicitly in the scene text.\n   - No duplicate characters: the child appears ONCE, not as a reflection or shadow copy.\n   - When in doubt, FEWER characters is ALWAYS correct.`;
  } else {
    charCountRule = `1. CHARACTER COUNT — STRICT:\n   - The image must contain EXACTLY the characters described in the scene text and no others.\n   - If the scene mentions ONLY the child → EXACTLY ONE person visible. No exceptions.\n   - If the scene mentions child + one parent → EXACTLY TWO people visible.\n   - ZERO additional people anywhere: no background pedestrians, no shadow figures, no reflections showing extra people, no babies, no siblings, no pets unless explicitly in the scene text.\n   - No duplicate characters: the child appears ONCE, not as a reflection or shadow copy.\n   - When in doubt, FEWER characters is ALWAYS correct.`;
  }
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
    parts.push(`5. OUTFIT LOCK (CRITICAL): The child MUST wear EXACTLY this outfit — verify EACH item: ${characterOutfit}`);
    parts.push(`   COLOR VERIFICATION: Before finishing, check EACH garment's color matches the description above. A red shirt must be RED, not maroon, not pink, not orange. A blue jacket must be BLUE, not teal, not purple.`);
    parts.push(`   Do NOT change any garment, color, pattern, or accessory. Do NOT add jackets, hats, capes, or accessories not listed. Do NOT remove any item. This outfit is IDENTICAL on every single page. If the outfit does not match this description exactly, the image will be rejected.`);
    parts.push(`   OUTFIT ADDITIONS FORBIDDEN: Do not add any item not explicitly listed in the outfit above. No scarves, hats, backpacks, capes, stickers, extra accessories, or additional clothing layers unless specifically named. The outfit is complete as described.`);
    parts.push(`   In THIS illustration, the child is wearing EXACTLY the outfit described above — every garment, color, pattern, and accessory. Do NOT change any item. Do NOT add or remove layers based on the scene's weather or activity. The outfit must be PIXEL-FOR-PIXEL IDENTICAL to every other illustration in this book.`);
    parts.push(`   FORBIDDEN OUTFIT CHANGES: Even if the story describes water, swimming, sleeping, rain, mud, snow, sports, cooking, or any other activity — the child wears the EXACT same outfit. Never adapt clothing to the scene. Never add rain gear, swimwear, sleepwear, costumes, aprons, helmets, or any activity-specific clothing. Never remove shoes, socks, or any garment. The outfit is UNCHANGEABLE regardless of context.`);
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

  // characterAnchor takes priority — it contains explicit ethnicity, eye shape, skin tone from cover
  if (opts.characterAnchor) {
    parts.push(`7. CHARACTER ANCHOR LOCK (CRITICAL — DO NOT DRIFT UNDER ANY CIRCUMSTANCES):`);
    parts.push(`   The following physical characteristics were extracted directly from the approved cover photo.`);
    parts.push(`   They MUST be reproduced IDENTICALLY in THIS illustration and every other illustration in this book.`);
    parts.push(`   ANY deviation — in ethnicity, skin tone, eye shape, or hair — is a rejection.`);
    parts.push(``);
    parts.push(opts.characterAnchor);
    parts.push(``);
    parts.push(`   CRITICAL RULES:`);
    parts.push(`   - ETHNICITY: Do NOT change the child's ethnicity or racial appearance between spreads`);
    parts.push(`   - SKIN TONE: The exact skin tone above must be matched in every spread — do NOT lighten, darken, or shift`);
    parts.push(`   - EYE SHAPE: The eye shape above must be reproduced exactly — pay special attention to monolid vs almond vs round`);
    parts.push(`   - EYE COLOR: Match exactly — do not substitute`);
    parts.push(`   - EYES MUST BE OPEN: The character's eyes must ALWAYS be drawn open and expressive. Even if the reference photo shows closed, squinting, or half-closed eyes (e.g. laughing, sleeping, squinting in sunlight), draw the character with open, bright, lively eyes. A photo captures one moment — the illustrations should show the child alert and engaged.`);
    parts.push(`   - HAIR: Color, texture, and length must match exactly — no variations`);
    parts.push(`   If the reference photo shows an East Asian child, ALL illustrations must show an East Asian child.`);
    parts.push(`   If the reference shows a Black child, ALL illustrations must show a Black child.`);
    parts.push(`   NEVER drift to a different ethnicity, skin tone, or eye shape — even after multiple spreads.`);
  } else if (characterDescription) {
    // Fallback: extract ethnicity from description text
    const ethnicityMatch = characterDescription.match(/\b(asian|east asian|southeast asian|south asian|black|african american|hispanic|latino|latina|white|caucasian|middle eastern|south american|mixed|biracial)\b/i);
    if (ethnicityMatch) {
      parts.push(`7. ETHNICITY LOCK (CRITICAL — DO NOT DRIFT): The child is ${ethnicityMatch[0]}. This MUST be consistent in every single illustration. Do NOT change the child's ethnicity, skin tone, or facial features between spreads. If the reference photo shows an ${ethnicityMatch[0]} child, ALL illustrations must show an ${ethnicityMatch[0]} child. Never drift to a different ethnicity.`);
    } else {
      parts.push(`7. SKIN TONE & ETHNICITY LOCK: The child's skin tone, ethnicity, and facial features are FIXED from the reference photo. Do NOT change them between spreads under any circumstances.`);
    }
  }

  // Secondary character appearance lock (when someone else appears in the uploaded photo)
  if (opts.additionalCoverCharacters) {
    parts.push(`8. SECONDARY CHARACTER CONSISTENCY LOCK (CRITICAL):`);
    parts.push(`   The following secondary character appears in the uploaded photo and MAY appear in this illustration. Their appearance must be IDENTICAL to every other illustration in this book:`);
    parts.push(`   ${opts.additionalCoverCharacters}`);
    parts.push(`   - Same hair color, style, and length on every spread`);
    parts.push(`   - Same skin tone and facial features on every spread`);
    parts.push(`   - Same approximate age and build on every spread`);
    parts.push(`   - Do NOT change their ethnicity, hair, or skin tone between spreads`);
    parts.push(`   - Match their appearance to the uploaded reference photo`);
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

  // C3: Stronger negative / consistency instructions at END of character section
  const anchorText = opts.characterAnchor || characterDescription || '';
  const skinToneMatch = anchorText.match(/skin[:\s]+([^.;,\n]+)/i) || anchorText.match(/((?:light|medium|dark|fair|olive|brown|tan|deep|pale)[^.;,\n]*skin[^.;,\n]*)/i);
  const skinTone = skinToneMatch ? skinToneMatch[1].trim() : 'as shown in the reference photo';
  // hairStyle already extracted above for C2
  const outfitDesc = characterOutfit || 'as shown in the reference photo';
  parts.push('');
  parts.push(`CONSISTENCY RULES (NON-NEGOTIABLE):`);
  parts.push(`- The child's FACE must have the same bone structure, nose shape, and eye placement as the reference photo`);
  parts.push(`- HAIR must be exactly ${hairStyle} — no variation, no accessories added or removed`);
  parts.push(`- SKIN TONE must be exactly ${skinTone} — not lighter, not darker, regardless of scene lighting`);
  parts.push(`- OUTFIT must be exactly ${outfitDesc} — same colors, same design, same details`);
  parts.push(`- If ANYTHING about the child doesn't match the reference, it is WRONG`);
  parts.push(`- Character consistency is MORE IMPORTANT than artistic creativity or scene composition`);

  parts.push('');
  parts.push(`SCENE TO ILLUSTRATE: ${cleanScene}`);

  // Shot type enforcement
  if (opts.shotType) {
    parts.push(`\nCOMPOSITION — SHOT TYPE: ${opts.shotType.toUpperCase()}`);
    if (opts.shotType === 'wide') {
      parts.push('This MUST be a WIDE SHOT. Show the full scene with characters visible head-to-toe in their environment. Do NOT crop to close-up or detail. Show the setting.');
    } else if (opts.shotType === 'medium') {
      parts.push('This MUST be a MEDIUM SHOT. Characters visible from approximately waist up, engaged in their activity.');
    } else if (opts.shotType === 'close-up') {
      parts.push('This MUST be a CLOSE-UP. Focus tightly on the character face, hands, or key detail. Fill the frame.');
    } else if (opts.shotType === 'overhead') {
      parts.push('This MUST be an OVERHEAD/BIRD\'S-EYE VIEW looking down on the scene from above.');
    }
  }

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
    parts.push('FORMAT: Wide cinematic panoramic landscape illustration, 16:9 aspect ratio.');
    parts.push('THIS IS ONE SINGLE SEAMLESS PAINTING — like a wide movie still or a panoramic photograph. The scene flows continuously from the left edge to the right edge with NO visual break, NO divider, NO seam, NO panel split, NO color change, NO lighting change, and NO composition break at the center or anywhere else.');
    parts.push('IMPORTANT: Do NOT treat this as two separate images side by side. There must be ZERO visual indication that this image will be split into two pages. Paint it as one unified wide scene.');
    parts.push('CHARACTER POSITION (CRITICAL): The main character MUST be positioned off-center horizontally — clearly in the left third or right third of the image. Do NOT place the main character at the horizontal midpoint (50%) of the image. The exact center of the image is reserved for background scenery, open space, or environmental elements. A character standing at dead-center will be rejected.');
    parts.push('SAFE ZONE (printing will crop edges):');
    parts.push('- Keep important content (faces, hands, key objects) within the middle 85% of the height. Top/bottom 7.5% may be cropped.');
  } else {
    parts.push('FORMAT: Square image, 1:1 aspect ratio. The image must be perfectly square.');
  }
  parts.push('Children\'s book illustration, whimsical, warm, fully clothed characters, family-friendly.');

  // Text handling — embed text when using chat illustrations with admin regen, otherwise no text
  parts.push('');
  if (opts.embedText && pageText && pageText.trim()) {
    parts.push('TEXT RENDERING RULES:');
    parts.push('- This illustration MUST include the story text rendered directly INTO the image');
    parts.push('- Use an elegant, classic serif font style similar to Lora — refined, delicate serifs');
    parts.push('- Use a SMALL font size — each line no taller than 3-4% of image height. Think delicate captions, not headlines. The full text block must occupy at most 10-15% of image area. The illustration dominates, text is a small elegant accent');
    parts.push('- Text must be CRISP and SHARP with clean edges — NOT blurry, fuzzy, or soft');
    parts.push('- White or light text with a subtle dark drop shadow or thin outline for readability');
    parts.push('- TEXT PLACEMENT (CRITICAL): Text can be anywhere EXCEPT it must NEVER cross the vertical center line');
    parts.push('- Keep a small padding from all edges (top, bottom, left, right) so text won\'t be cut in print');
    parts.push('- Main characters and key action should not be hidden behind the text');
    parts.push('');
    parts.push(`TEXT TO RENDER ON THIS PAGE (include exactly as written):`);
    parts.push(pageText.trim());
    parts.push('\nREMINDER: Text must NEVER cross the vertical center line. Padding from all edges.');
  } else {
    parts.push('NO TEXT IN THIS IMAGE. Do NOT render, write, or include ANY text, words, letters, numbers, or captions anywhere in this illustration.');
  }
  parts.push('FULL SCENE: The illustration must fill the ENTIRE canvas from edge to edge. Do NOT leave any blank, empty, or reserved areas anywhere in the image — no clean zones at top, bottom, or sides. Every part of the canvas should contain illustration artwork.');

  // Pre-generate checklist
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
  if (opts.embedText && pageText && pageText.trim()) {
    parts.push(`10. TEXT RENDERED: story text is included exactly as provided, not crossing the vertical center. \u2713`);
  } else {
    parts.push(`10. NO TEXT: absolutely zero text, letters, words, or numbers anywhere in the image. \u2713`);
  }
  parts.push(`11. FULL SCENE: illustration fills the entire canvas edge to edge — no blank areas anywhere. \u2713`);
  if (isSpread) {
    parts.push(`12. CHARACTER OFF-CENTER: the main character is positioned in the left third or right third of the image — NOT at the horizontal center. \u2713`);
    parts.push(`13. SEAMLESS SCENE: the illustration is ONE continuous painting with no visible split, seam, or panel break anywhere — uniform lighting and color across the entire width. \u2713`);
  }
  parts.push(`14. ART STYLE: ${styleConfig.prefix} ${styleConfig.suffix} \u2713`);
  parts.push('If any check fails, adjust the scene before generating.');
  parts.push('');
  parts.push(`FINAL STYLE REMINDER: This MUST be rendered as ${styleConfig.prefix} ${styleConfig.suffix}`);

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
 * @param {string} photoBase64 - Base64-encoded child photo (approved cover)
 * @param {string} photoMime - MIME type of the photo
 * @param {AbortSignal} abortSignal
 * @param {object} opts
 * @param {string} [opts.originalPhotoBase64] - Original uploaded photo (for first spread only — ground truth for ethnicity/skin tone)
 * @param {string} [opts.originalPhotoMime]
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

  // Build parts: text prompt + character references + optional style references
  // For spread 1: send both the original uploaded photo (ethnicity ground truth) AND the cover (rendered style)
  // For all other spreads: send only the cover
  const parts = [
    { text: prompt },
  ];

  if (opts.originalPhotoBase64) {
    // Spread 1: original photo first (real-world ground truth for ethnicity, skin tone, eye shape)
    parts.push({ text: 'CHARACTER REFERENCE — REAL PHOTO (ground truth): This is the actual photograph of the child. Use this as the definitive reference for: ethnicity, skin tone, eye shape, eye color, and facial features. These characteristics are LOCKED and must be reproduced exactly. IMPORTANT: If the child\'s eyes appear closed or squinting in this photo, IGNORE the eye state — always draw the child with open, bright, expressive eyes.' });
    parts.push({ inline_data: { mimeType: opts.originalPhotoMime || 'image/jpeg', data: opts.originalPhotoBase64 } });
    parts.push({ text: 'CHARACTER REFERENCE — BOOK COVER (rendered style): This is the approved book cover showing the same child in the book\'s art style. Use this as reference for: art style, rendering quality, hair depiction, outfit, and how the character looks in this specific illustration style. Combine both references — the real photo\'s ethnicity/features with the cover\'s art style.' });
    parts.push({ inline_data: { mimeType: photoMime || 'image/jpeg', data: photoBase64 } });
  } else {
    // All other spreads: cover only (already anchored by spread 1 as style reference)
    parts.push({ inline_data: { mimeType: photoMime || 'image/jpeg', data: photoBase64 } });
  }

  // Add all style reference images (multiple supported)
  const styleRefs = Array.isArray(opts.prevIllustrationRefs) && opts.prevIllustrationRefs.length > 0
    ? opts.prevIllustrationRefs
    : (opts.prevIllustrationBase64 ? [{ base64: opts.prevIllustrationBase64, mimeType: opts.prevIllustrationMime || 'image/jpeg' }] : []);
  if (styleRefs.length > 0) {
    parts.push({ text: `STYLE REFERENCE${styleRefs.length > 1 ? 'S' : ''} ONLY (${styleRefs.length} image${styleRefs.length > 1 ? 's' : ''}) — these are previous spreads from the same book. Match ONLY the art style, color palette, lighting mood, and character rendering quality. The NEW illustration must depict an ENTIRELY DIFFERENT scene, location, and moment as described above. IGNORE the setting, objects, background, poses, and layout of these reference images — do NOT reproduce or imitate the composition. IGNORE any text visible in these references. Only the rendering style transfers:` });
    for (const ref of styleRefs) {
      parts.push({ inline_data: { mimeType: ref.mimeType || 'image/jpeg', data: ref.base64 } });
    }
  }

  // Add first spread as outfit/style reference for subsequent spreads
  if (opts.firstSpreadRefBase64) {
    parts.push({ text: 'OUTFIT & STYLE REFERENCE — FIRST SPREAD: This is the first illustration from this book. Match the child\'s outfit rendering, art style, color palette, and lighting exactly. Do NOT include any text in the new illustration.' });
    parts.push({ inline_data: { mimeType: 'image/jpeg', data: opts.firstSpreadRefBase64 } });
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
  const fullPrompt = buildCharacterPrompt(sceneDescription, artStyle, childName, opts.pageText, opts.characterOutfit, opts.characterDescription, opts.recurringElement, opts.keyObjects, {
    skipTextEmbed: opts.skipTextEmbed,
    embedText: opts.embedText || false,
    coverArtStyle: opts.coverArtStyle,
    isSpread,
    spreadIndex: opts.spreadIndex,
    totalSpreads: opts.totalSpreads || 13,
    childAge: opts.childAge,
    promptInjection: opts.promptInjection,
    fontStyle: opts.fontStyle,
    additionalCoverCharacters: opts.additionalCoverCharacters || null,
    characterAnchor: opts.characterAnchor || null,
    bookFormat: opts.bookFormat || null,
    comicMode: opts.comicMode || false,
    comicPageMode: opts.comicPageMode || false,
    panelType: opts.panelType || '',
    shot: opts.shot || '',
    cameraAngle: opts.cameraAngle || '',
    actingNotes: opts.actingNotes || '',
    backgroundComplexity: opts.backgroundComplexity || '',
    textFreeZone: opts.textFreeZone || '',
    safeTextZones: opts.safeTextZones || null,
    balloons: opts.balloons || null,
    captions: opts.captions || null,
    sfx: opts.sfx || null,
    layoutTemplate: opts.layoutTemplate || '',
    pageLayout: opts.pageLayout || '',
    colorScript: opts.colorScript || null,
    aspectRatioHint: opts.aspectRatioHint || '',
    aspectRatio: opts.aspectRatio || '',
    firstSpreadRefBase64: opts.firstSpreadRefBase64 || null,
  });
  const aspectRatio = determineAspectRatio({ ...opts, isSpread });

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

  // Download previous illustrations as style references (admin regeneration only)
  // prevIllustrationUrls (array) takes precedence; falls back to single prevIllustrationUrl
  const refUrls = Array.isArray(opts.prevIllustrationUrls) && opts.prevIllustrationUrls.length > 0
    ? opts.prevIllustrationUrls
    : (opts.prevIllustrationUrl ? [opts.prevIllustrationUrl] : []);
  const prevIllustrationRefs = []; // [{ base64, mimeType }]
  for (const refUrl of refUrls) {
    try {
      const prev = await downloadPhotoAsBase64(refUrl);
      prevIllustrationRefs.push({ base64: prev.base64, mimeType: prev.mimeType });
      console.log(`[illustrationGenerator] Style reference loaded (${Math.round(prev.base64.length * 0.75 / 1024)}KB): ${refUrl.slice(0, 80)}`);
    } catch (e) {
      console.warn(`[illustrationGenerator] Could not load style reference: ${e.message}`);
    }
  }
  // Legacy single-ref compat
  const prevIllustrationBase64 = prevIllustrationRefs[0]?.base64 || null;
  const prevIllustrationMime = prevIllustrationRefs[0]?.mimeType || 'image/jpeg';

  // Build prompt variants for NSFW fallback
  const promptVariants = [
    { label: 'original', prompt: fullPrompt },
    { label: 'sanitized', prompt: sanitizePrompt(fullPrompt) },
    { label: 'generic-safe', prompt: buildGenericSafePrompt(artStyle) },
  ];

  let promptVariantIndex = 0;

  // Dynamic retry budget — text-heavy pages get more attempts
  const wordCount = opts.pageText ? opts.pageText.split(/\s+/).length : 0;
  const maxRetries = (wordCount > 8 && !opts.skipTextEmbed && !opts.comicPageMode)
    ? TEXT_HEAVY_MAX_RETRIES
    : BASE_MAX_RETRIES;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const variant = promptVariants[promptVariantIndex];
    try {
      const geminiStart = Date.now();

      let imageBuffer;
      // Always use cover image as reference for character likeness
      if (photoBase64) {
        // For spread 0 (first illustration): pass both the original uploaded photo AND the cover
        // The original photo is the ground truth for ethnicity/skin tone/eye shape
        // The cover shows the rendered art style the character should match
        // Send the original uploaded photo as ethnicity/skin tone ground truth for ALL spreads, not just the first
        const originalPhotoBase64 = opts._cachedPhotoBase64 || null;
        const originalPhotoMime = opts._cachedPhotoMime || 'image/jpeg';
        imageBuffer = await callGeminiImageApi(variant.prompt, photoBase64, photoMime, opts.abortSignal, { aspectRatio, prevIllustrationBase64, prevIllustrationMime, prevIllustrationRefs, originalPhotoBase64, originalPhotoMime, firstSpreadRefBase64: opts.firstSpreadRefBase64 || null });
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

      // Verify embedded text accuracy (skip on last attempt — accept best effort)
      const hasEmbeddedText = opts.pageText && !opts.skipTextEmbed;
      if (hasEmbeddedText && attempt < maxRetries) {
        const textCheck = await verifyImageText(imageBuffer, opts.pageText, opts.abortSignal, costTracker);
        if (!textCheck.valid) {
          console.warn(`[illustrationGenerator] Text verification failed on attempt ${attempt} for book ${bookId || 'unknown'}: ${textCheck.issues.join('; ')} — regenerating`);
          continue;
        }
        console.log(`[illustrationGenerator] Text verification passed on attempt ${attempt}`);
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
      if (attempt === maxRetries) {
        throw new Error(`Illustration generation failed after ${maxRetries} attempts: ${genErr.message}`);
      }
    }
  }

  throw new Error('No illustration generated after all attempts');
}

/**
 * Quick Gemini Flash check: does the generated illustration match the character reference?
 * Returns { consistent: boolean, issues: string[] }
 */
async function checkCharacterConsistency(generatedImageBase64, referenceImageBase64, characterAnchor, characterOutfit, secondaryCharacterDescription) {
  if (!generatedImageBase64 || !referenceImageBase64) return { consistent: true, issues: [] };

  const apiKey = getNextApiKey();
  if (!apiKey) return { consistent: true, issues: [] };

  const hasSecondary = secondaryCharacterDescription && secondaryCharacterDescription.toUpperCase() !== 'NONE';
  const secondaryCheck = hasSecondary
    ? `\n5. SECONDARY CHARACTER: If a secondary character (parent/adult) appears in the generated image, check that their hair color/style, skin tone, general appearance, AND OUTFIT match this description: ${secondaryCharacterDescription}. The secondary character must wear the SAME outfit (same garment type, same colors) across all illustrations — flag any outfit change. If the secondary character is NOT present in the generated image, skip this check.`
    : '';

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { text: `Compare these two images. Image 1 is the REFERENCE (correct appearance). Image 2 is the GENERATED illustration.

Check ONLY these critical dimensions — ignore everything else:

1. ETHNICITY/SKIN: Is the child the same ethnicity with a similar skin tone? Minor lighting-based shade differences are acceptable.
2. HAIR: Same general style (e.g., pigtails, braids, short) and color? Minor accessory differences (different beads, slightly different ties) are acceptable.
3. CORE GARMENTS: ${characterOutfit ? `The DEFINED outfit is: ${characterOutfit}. Use this text description as the ground truth for what the child should be wearing — it overrides whatever clothing appears in the reference image (the reference photo may show a different outfit). Check that the generated illustration matches THIS outfit description.` : 'Same main clothing items (top, bottom, shoes) with similar colors?'} Minor detail differences (button count, pocket placement, exact trim pattern) are acceptable.
4. FACE: Similar facial structure and features?${secondaryCheck}

IMPORTANT: If additional people appear in the generated image who are NOT the main child, focus your consistency check ONLY on the main child. Do not flag issues about other characters unless they were explicitly described in the expected outfit.

DO NOT FLAG any of these — they are expected variations:
- Items the character is holding (these change per scene)
- Left/right mirroring (common in AI-generated images)
- Minor color shade differences due to scene lighting
- Accessories that are scene-specific (backpack design, cape presence)
- Whether specific small details like patches or badges are visible
- Text width or text-related issues (checked separately)
- Eye open/closed state: if the reference shows closed or squinting eyes but the illustration shows open eyes, this is CORRECT and expected — do NOT flag it as inconsistent
- Outfit differences between the reference image and the defined outfit text — the outfit TEXT is the authority, not the reference image

${characterAnchor ? `Expected character: ${characterAnchor}` : ''}
${characterOutfit ? `Expected outfit (AUTHORITATIVE — use this, not the reference image, for outfit checks): ${characterOutfit}` : ''}

Respond with ONLY valid JSON:
{"consistent": true} or {"consistent": false, "issues": ["skin tone is significantly different", "hair is completely different style"]}
Only return consistent:false if the character would be unrecognizable or clearly a different person. Minor variations are acceptable.` },
            { inline_data: { mime_type: 'image/jpeg', data: referenceImageBase64 } },
            { inline_data: { mime_type: 'image/jpeg', data: typeof generatedImageBase64 === 'string' ? generatedImageBase64 : generatedImageBase64.toString('base64') } },
          ]}],
          generationConfig: { maxOutputTokens: 1024, temperature: 0.1, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );

    if (!resp.ok) return { consistent: true, issues: [] };
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const cleaned = text.replace(/```json\s*/i, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      const result = JSON.parse(match[0]);
      return { consistent: !!result.consistent, issues: result.issues || [] };
    }
  } catch (e) {
    console.warn('[illustrationGenerator] Consistency check failed:', e.message);
  }
  return { consistent: true, issues: [] };
}

/**
 * Count visible human characters in a generated illustration and compare against expected.
 * Returns { passed: boolean, message: string }
 */
async function checkCharacterCount(imageBase64, expectedCharacters) {
  if (!imageBase64 || !expectedCharacters) return { passed: true };

  const apiKey = getNextApiKey();
  if (!apiKey) return { passed: true };

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { text: `How many distinct human characters are visible in this children's book illustration?
Count each unique person (not reflections, shadows, or background art/paintings/posters on walls).
Return ONLY valid JSON: {"children": N, "adults": N}` },
            { inline_data: { mime_type: 'image/jpeg', data: typeof imageBase64 === 'string' ? imageBase64 : imageBase64.toString('base64') } },
          ]}],
          generationConfig: { maxOutputTokens: 256, temperature: 0.1, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );

    if (!resp.ok) return { passed: true };
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const cleaned = text.replace(/```json\s*/i, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      const result = JSON.parse(match[0]);
      const actualChildren = result.children || 0;
      const actualAdults = result.adults || 0;
      const expectedChildren = expectedCharacters.childCount || 0;
      const expectedAdults = expectedCharacters.adultCount;
      // adultCount === -1 means skip adult check (partial parent presence — count is unreliable)
      const skipAdultCheck = expectedAdults === -1;
      const effectiveExpectedAdults = skipAdultCheck ? actualAdults : (expectedAdults || 0);
      if (actualChildren !== expectedChildren || (!skipAdultCheck && actualAdults !== effectiveExpectedAdults)) {
        return {
          passed: false,
          message: `Expected ${expectedChildren} child(ren) and ${skipAdultCheck ? 'any' : effectiveExpectedAdults} adult(s), but found ${actualChildren} child(ren) and ${actualAdults} adult(s)`,
        };
      }
      return { passed: true };
    }
  } catch (e) {
    console.warn('[illustrationGenerator] Character count check failed:', e.message);
  }
  return { passed: true };
}

/**
 * Detect if text in the illustration is placed on an opaque box/banner overlay.
 * Returns { passed: boolean, description: string }
 */
async function checkTextPresentation(imageBase64) {
  if (!imageBase64) return { passed: true };

  const apiKey = getNextApiKey();
  if (!apiKey) return { passed: true };

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { text: `Look at the text in this children's book illustration.
Is the text placed on a solid-color opaque rectangle/box/banner that covers part of the artwork?
A solid white, cream, or colored box behind the text counts as an overlay.
Text in a dedicated margin/negative space area is fine.
Text with a subtle shadow or outline is fine.
Only flag solid opaque boxes that obscure the illustration.
Return ONLY valid JSON: {"hasOpaqueOverlay": true/false, "description": "brief description"}` },
            { inline_data: { mime_type: 'image/jpeg', data: typeof imageBase64 === 'string' ? imageBase64 : imageBase64.toString('base64') } },
          ]}],
          generationConfig: { maxOutputTokens: 256, temperature: 0.1, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );

    if (!resp.ok) return { passed: true };
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const cleaned = text.replace(/```json\s*/i, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      const result = JSON.parse(match[0]);
      if (result.hasOpaqueOverlay) {
        return { passed: false, description: result.description || 'text on opaque overlay detected' };
      }
      return { passed: true };
    }
  } catch (e) {
    console.warn('[illustrationGenerator] Text presentation check failed:', e.message);
  }
  return { passed: true };
}

/**
 * Compare current spread's text font rendering against the first spread reference.
 * Only runs for spreads after the first one (spread index > 0).
 * Returns { passed: boolean, issues: string[] }
 */
async function checkFontConsistency(currentImageBase64, firstSpreadBase64) {
  if (!currentImageBase64 || !firstSpreadBase64) return { passed: true };

  const apiKey = getNextApiKey();
  if (!apiKey) return { passed: true };

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { text: `Compare the text rendering in these two children's book illustrations.
Image 1 is the REFERENCE (correct style). Image 2 is the one to check.
Does Image 2 use the same: font family, font size (relative to page), font weight, text color?
Minor variations are acceptable (AI rendering is imperfect).
Only flag OBVIOUS differences — clearly different font, dramatically different size, different color.
Return ONLY valid JSON: {"consistent": true/false, "issues": ["different font family", "larger font size", etc.]}` },
            { inline_data: { mime_type: 'image/jpeg', data: typeof firstSpreadBase64 === 'string' ? firstSpreadBase64 : firstSpreadBase64.toString('base64') } },
            { inline_data: { mime_type: 'image/jpeg', data: typeof currentImageBase64 === 'string' ? currentImageBase64 : currentImageBase64.toString('base64') } },
          ]}],
          generationConfig: { maxOutputTokens: 512, temperature: 0.1, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );

    if (!resp.ok) return { passed: true };
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const cleaned = text.replace(/```json\s*/i, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      const result = JSON.parse(match[0]);
      if (!result.consistent) {
        return { passed: false, issues: result.issues || [] };
      }
      return { passed: true };
    }
  } catch (e) {
    console.warn('[illustrationGenerator] Font consistency check failed:', e.message);
  }
  return { passed: true };
}

/**
 * Generate an illustration with anchor images (top-scoring spreads) as visual references.
 * Wraps generateIllustration but injects anchor images into the Gemini request
 * so the model can see what "good" looks like.
 *
 * @param {string} sceneDescription
 * @param {string} characterRefUrl
 * @param {string} artStyle
 * @param {Array<{imageBase64: string, label: string}>} anchorImages - Up to 2 anchor images
 * @param {object} opts - Same opts as generateIllustration
 * @returns {Promise<string|null>} URL or null
 */
async function generateIllustrationWithAnchors(sceneDescription, characterRefUrl, artStyle, anchorImages, opts = {}) {
  if (!anchorImages || anchorImages.length === 0) {
    return generateIllustration(sceneDescription, characterRefUrl, artStyle, opts);
  }

  // Limit to max 2 anchor images (Gemini model has image input limits)
  const anchors = anchorImages.slice(0, 2);

  // Build anchor prefix for the prompt
  const anchorPrefix = `STYLE & CHARACTER REFERENCE — ANCHOR IMAGES (${anchors.length} provided):
Match the style, characters, and font of these reference illustrations exactly.
These are the highest-quality spreads from this book — use them as your visual standard.
${anchors.map((a, i) => `Anchor ${i + 1}: ${a.label}`).join('\n')}

`;

  // Inject anchor images as additional prevIllustrationRefs
  // The existing code in callGeminiImageApi already handles prevIllustrationRefs as inline image parts
  const existingRefs = Array.isArray(opts.prevIllustrationRefs) ? opts.prevIllustrationRefs : [];
  const anchorRefs = anchors.map(a => ({
    base64: a.imageBase64,
    mimeType: 'image/jpeg',
  }));

  // Combine: existing refs + anchor refs (anchor refs take priority in the prompt)
  // But keep total refs reasonable — max 2 anchors + existing
  const combinedRefs = [...anchorRefs, ...existingRefs].slice(0, 3);

  return generateIllustration(
    anchorPrefix + sceneDescription,
    characterRefUrl,
    artStyle,
    {
      ...opts,
      prevIllustrationRefs: combinedRefs,
      // Also set single ref for backward compat
      prevIllustrationBase64: combinedRefs[0]?.base64 || opts.prevIllustrationBase64,
      prevIllustrationMime: combinedRefs[0]?.mimeType || opts.prevIllustrationMime,
    }
  );
}

module.exports = { generateIllustration, generateIllustrationWithAnchors, buildCharacterPrompt, buildComicPagePrompt, getNextApiKey, ART_STYLE_CONFIG, PARENT_THEMES, fetchWithTimeout, downloadPhotoAsBase64, checkCharacterConsistency, checkCharacterCount, checkTextPresentation, checkFontConsistency };
