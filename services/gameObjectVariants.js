/**
 * Game Object Variants (Toca-Level H).
 *
 * For each hero object (stove, fridge, bath, sink, tv, toilet, washer, oven,
 * toybox, bed), generate a single horizontal "strip" image containing N
 * visual state variants — e.g. `stove: [off, burner-glow, flames, pot-cooking]`
 * — then slice the strip into per-variant PNGs and upload to GCS. The client
 * loads these as textures keyed `hero:<objectId>:<variant>` and swaps between
 * them to express runtime state.
 *
 * Why one strip per object (not per-variant images):
 *   - Keeps silhouette identical across variants.
 *   - 1× Gemini call vs N for cheaper + stable identity.
 *
 * Output manifest:
 *   {
 *     bookId,
 *     generatedAt,
 *     objects: { stove: { off: url, flames: url, ... }, fridge: {...}, ... },
 *     failed:  [{ id, error }],
 *     tookMs,
 *   }
 */

const sharp = require('sharp');
const { GEMINI_IMAGE_MODEL, CHAT_API_BASE } = require('./illustrator/config');
const { fetchWithTimeout, downloadPhotoAsBase64 } = require('./illustrationGenerator');
const { uploadBuffer } = require('./gcsStorage');

// Per-object prompt hints so Gemini knows what the runtime state means
// visually. These are small, concrete descriptions the model can draw.
const VARIANT_HINTS = {
  stove: {
    'off':            'a 4-burner stovetop, all burners off, clean and cold',
    'burner-glow':    'same stove, one front burner glowing red/orange heat-warning ring (no flames yet)',
    'flames':         'same stove, one front burner with bright yellow-orange flames dancing upward, rest of stove identical',
    'pot-cooking':    'same stove with a metal cooking pot sitting on the front burner, small wisps of steam rising, flames visible beneath',
  },
  fridge: {
    'closed':         'a tall two-door refrigerator, both doors closed, handles visible',
    'open-empty':     'same fridge with the right door swung open showing empty glass shelves inside and a cold blue glow',
    'open-stocked':   'same fridge with the right door swung open showing milk, juice, cheese, apples, cupcake on the shelves, cold blue glow',
  },
  bath: {
    'empty':          'a clawfoot bathtub seen from the side, empty, shiny white porcelain with a faucet',
    'water':          'same bathtub filled halfway with clear turquoise water, small surface ripples, no bubbles',
    'bubbles':        'same bathtub filled with water plus a pile of foamy white bubble-bath bubbles overflowing slightly',
  },
  sink: {
    'off':            'a white porcelain kitchen sink with a curved chrome faucet, no water',
    'running':        'same sink with a stream of water pouring from the faucet and light splashing in the basin',
  },
  tv: {
    'off':            'a flat-screen TV on a stand, dark black screen, power button visible',
    'ch1':            'same TV turned on, showing a cheerful cartoon sun and clouds on the screen',
    'ch2':            'same TV turned on, showing a simple cartoon forest with a fox on the screen',
    'ch3':            'same TV turned on, showing a colorful cartoon underwater scene with a smiling fish on the screen',
  },
  toilet: {
    'lid-down':       'a white porcelain toilet seen from the side, lid closed',
    'lid-up':         'same toilet with the lid flipped up, seat visible, clear water in the bowl',
    'flushing':       'same toilet with water swirling in the bowl, small splash motion, lid up',
  },
  washer: {
    'open':           'a front-loading washing machine with the round glass door open, empty drum inside',
    'closed':         'same washing machine, door closed, idle',
    'spinning':       'same machine, door closed, soapy water and tumbling clothes visible through the glass, slight motion blur',
    'done':           'same machine, door closed, inside glass is clear/empty, soft green indicator light glow',
  },
  oven: {
    'off':            'a freestanding oven, door closed, dark window, cold',
    'preheating':     'same oven, door closed, faint orange glow through the window',
    'baking':         'same oven, door closed, warm orange glow through the window, hint of a cake visible through the glass',
    'done':           'same oven with the door open showing a finished golden-brown cake on the rack inside',
  },
  toybox: {
    'closed':         'a wooden toybox, closed lid, colorful stickers on the side',
    'open-pile':      'same toybox with the lid flipped open, toys spilling out on top: a teddy, ball, blocks, a book',
  },
  bed: {
    'made':           'a child-sized bed with a neatly tucked patterned blanket and two pillows',
    'messy':          'same bed with rumpled blanket, pillow slightly off-center, a stuffed teddy peeking out',
    'sleeping-char':  'same bed with the blanket pulled up and a silhouette of a small sleeping child, eyes closed, serene',
  },
};

function pickApiKey() {
  const keys = [];
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  if (keys.length === 0) {
    const single = process.env.GOOGLE_AI_STUDIO_KEY || process.env.GEMINI_API_KEY || '';
    if (single) keys.push(single);
  }
  if (keys.length === 0) throw new Error('No Gemini API key available');
  return keys[Math.floor(Math.random() * keys.length)];
}

function objectPrompt({ objectId, variants, style, theme }) {
  const hints = VARIANT_HINTS[objectId] || {};
  const lines = variants.map((v, i) => `${i + 1}. [${v}] — ${hints[v] || v}`);

  // Aspect ratio: strip of N cells side-by-side.
  const n = variants.length;

  return [
    `Generate ONE image containing a HORIZONTAL STRIP of ${n} variants of the SAME ${objectId.toUpperCase()} for a children's game.`,
    '',
    'LAYOUT (critical — must follow exactly):',
    `The image is divided into ${n} equal-width cells from left to right, separated by thin white gutters.`,
    'Each cell contains the same object in a different state. The object silhouette, perspective, size and position MUST be identical across all cells — only the state-specific details change.',
    '',
    `VARIANTS (left→right, label → description):`,
    ...lines,
    '',
    'CONSISTENCY (critical):',
    '- Same camera angle, same object size in every cell.',
    '- Same color palette, line weight, rendering style.',
    '- NO text, NO labels, NO numbers, NO borders.',
    '- NO ground, NO floor, NO shadow (the client composites these).',
    '',
    'BACKGROUND:',
    '- Pure white (#FFFFFF) fill everywhere — inside cells and gutters.',
    '',
    'RENDERING:',
    `- Style: ${style || 'pixar_premium'}${theme ? `, theme: ${theme}` : ''}.`,
    '- Cheerful, Toca Boca-style illustration: soft rounded shapes, saturated color, 3-4 px outer outline.',
    `- Aspect ratio: the image should be ${n}:1 (${n} times wider than tall).`,
    '',
    `Output: ONE single image, ${n}:1 strip of ${n} cells. Do NOT output multiple images.`,
  ].join('\n');
}

function aspectForCount(n) {
  // Gemini accepts a small set of aspect ratios. We pick the closest to N:1.
  if (n <= 2) return '16:9';
  if (n <= 3) return '16:9';
  return '16:9';
}

async function callGeminiStrip({ apiKey, prompt, refs, aspect }) {
  const url = `${CHAT_API_BASE}/${GEMINI_IMAGE_MODEL}:generateContent?key=${apiKey}`;
  const parts = [];
  for (const ref of refs) {
    if (!ref?.base64) continue;
    parts.push({ text: ref.label });
    parts.push({ inline_data: { mimeType: ref.mime || 'image/jpeg', data: ref.base64 } });
  }
  parts.push({ text: prompt });

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: aspect },
    },
  };

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 120000);

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Variants Gemini ${resp.status}: ${t.slice(0, 300)}`);
  }
  const data = await resp.json();
  const parts2 = data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts2.find((p) => p.inlineData || p.inline_data);
  const b64 = imgPart?.inlineData?.data || imgPart?.inline_data?.data;
  if (!b64) {
    const t = parts2.find((p) => p.text)?.text || '';
    throw new Error(`No variant image returned. Text: "${t.slice(0, 200)}"`);
  }
  return Buffer.from(b64, 'base64');
}

async function sliceStrip(inputBuffer, n) {
  const img = sharp(inputBuffer);
  const meta = await img.metadata();
  const { width, height } = meta;
  if (!width || !height) throw new Error('Could not read strip dimensions');

  const cellW = Math.floor(width / n);
  const out = [];
  for (let i = 0; i < n; i++) {
    const buf = await sharp(inputBuffer)
      .extract({ left: i * cellW, top: 0, width: cellW, height })
      .toBuffer();
    out.push(buf);
  }
  return out;
}

async function softChromakeyWhiteToTransparent(inputBuffer) {
  const img = sharp(inputBuffer).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (channels < 3) return inputBuffer;

  const pxCount = width * height;
  const out = Buffer.alloc(pxCount * 4);
  const LOW = 235;
  const HIGH = 252;

  for (let i = 0; i < pxCount; i++) {
    const srcIdx = i * channels;
    const dstIdx = i * 4;
    const r = data[srcIdx];
    const g = data[srcIdx + 1];
    const b = data[srcIdx + 2];
    const minC = Math.min(r, g, b);
    let alpha;
    if (minC >= HIGH) alpha = 0;
    else if (minC <= LOW) alpha = 255;
    else alpha = Math.round(255 * (HIGH - minC) / (HIGH - LOW));
    out[dstIdx] = r;
    out[dstIdx + 1] = g;
    out[dstIdx + 2] = b;
    out[dstIdx + 3] = alpha;
  }

  return sharp(out, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function cellFill(buffer) {
  try {
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const n = width * height;
    let opaque = 0;
    for (let i = 0; i < n; i++) {
      if (data[i * channels + 3] > 40) opaque++;
    }
    return opaque / n;
  } catch (_) {
    return 0;
  }
}

async function collectRefs({ coverImageUrl, childPhotoUrl }) {
  const refs = [];
  if (coverImageUrl) {
    try {
      const r = await downloadPhotoAsBase64(coverImageUrl);
      refs.push({ label: 'BOOK COVER (art style — match line weight, palette, shading):', base64: r.base64, mime: r.mimeType || 'image/jpeg' });
    } catch (_) {}
  }
  if (childPhotoUrl && refs.length < 1) {
    try {
      const r = await downloadPhotoAsBase64(childPhotoUrl);
      refs.push({ label: 'CHILD PHOTO (background style reference):', base64: r.base64, mime: r.mimeType || 'image/jpeg' });
    } catch (_) {}
  }
  return refs;
}

async function generateOneObject({ objectId, variants, refs, style, theme, bookId }) {
  const apiKey = pickApiKey();
  const prompt = objectPrompt({ objectId, variants, style, theme });
  const aspect = aspectForCount(variants.length);

  const stripRaw = await callGeminiStrip({ apiKey, prompt, refs, aspect });
  const cells = await sliceStrip(stripRaw, variants.length);

  const out = {};
  for (let i = 0; i < cells.length; i++) {
    const variant = variants[i];
    try {
      const keyed = await softChromakeyWhiteToTransparent(cells[i]);
      const fill = await cellFill(keyed);
      if (fill < 0.02) {
        console.warn(`[gameObjectVariants] ${objectId}:${variant} appears empty (fill=${fill.toFixed(3)}) — skipping`);
        continue;
      }
      const path = `game-objects/${bookId}/${objectId}/${variant}.png`;
      const url = await uploadBuffer(keyed, path, 'image/png');
      out[variant] = url;
    } catch (err) {
      console.warn(`[gameObjectVariants] ${objectId}:${variant} upload failed: ${err.message}`);
    }
  }

  if (Object.keys(out).length < Math.ceil(variants.length / 2)) {
    throw new Error(`Only ${Object.keys(out).length}/${variants.length} variants produced for ${objectId}`);
  }

  return { id: objectId, variants: out };
}

/**
 * Main entry — generate AI art variants for the requested hero objects.
 *
 * @param {object} input
 * @param {string} input.bookId
 * @param {Array<{id:string, variants:string[]}>} input.heroObjects
 * @param {string} [input.coverImageUrl]
 * @param {string} [input.childPhotoUrl]
 * @param {string} [input.style]
 * @param {string} [input.theme]
 */
async function generateGameObjectVariants(input) {
  const startMs = Date.now();
  const {
    bookId,
    heroObjects,
    coverImageUrl,
    childPhotoUrl,
    style,
    theme,
  } = input || {};

  if (!bookId) throw new Error('bookId is required');
  if (!Array.isArray(heroObjects) || heroObjects.length === 0) throw new Error('heroObjects is required');

  const refs = await collectRefs({ coverImageUrl, childPhotoUrl });
  if (refs.length === 0) {
    // Proceed without refs — objects don't strictly need the child photo, but
    // the style won't match the book as closely.
    console.warn(`[gameObjectVariants] no refs available, generating with defaults`);
  }

  console.log(`[gameObjectVariants] Generating ${heroObjects.length} hero objects for book ${bookId}`);

  // Run up to 4 objects concurrently. Too many parallel Gemini calls hit rate
  // limits; too few underuses the available key pool.
  const MAX_CONCURRENT = 4;
  const objectsOut = {};
  const failed = [];

  for (let i = 0; i < heroObjects.length; i += MAX_CONCURRENT) {
    const batch = heroObjects.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.allSettled(
      batch.map((h) => generateOneObject({
        objectId: h.id,
        variants: h.variants || [],
        refs,
        style,
        theme,
        bookId,
      })),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const req = batch[j];
      if (r.status === 'fulfilled') {
        objectsOut[r.value.id] = r.value.variants;
      } else {
        const msg = r.reason?.message || String(r.reason);
        console.warn(`[gameObjectVariants] ${req.id} failed: ${msg}`);
        failed.push({ id: req.id, error: msg });
      }
    }
  }

  if (Object.keys(objectsOut).length === 0) {
    throw new Error('All hero-object generations failed');
  }

  const manifest = {
    bookId,
    generatedAt: new Date().toISOString(),
    objects: objectsOut,
    failed,
  };
  try {
    await uploadBuffer(
      Buffer.from(JSON.stringify(manifest, null, 2)),
      `game-objects/${bookId}/manifest.json`,
      'application/json',
    );
  } catch (_) {}

  const tookMs = Date.now() - startMs;
  console.log(`[gameObjectVariants] Done in ${tookMs}ms (${Object.keys(objectsOut).length}/${heroObjects.length} objects)`);

  return { objects: objectsOut, failed, tookMs };
}

module.exports = { generateGameObjectVariants, VARIANT_HINTS };
