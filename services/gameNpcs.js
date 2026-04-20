/**
 * Game NPC Sprite Generator
 *
 * Produces AI-styled NPC sprites (mom, dad, pet cat) in the book's art style
 * so they don't clash visually with the injected child character.
 *
 * Generates all NPCs in ONE Gemini call via a horizontal grid so identity,
 * style, and lighting are identical. Sliced with sharp, keyed to transparent
 * PNGs, uploaded to GCS under game-npcs/{bookId}/.
 *
 * Output: { npcs: { mom: url, dad: url, cat: url }, manifestUrl, tookMs }
 */

const sharp = require('sharp');
const { GEMINI_IMAGE_MODEL, CHAT_API_BASE } = require('./illustrator/config');
const { fetchWithTimeout, downloadPhotoAsBase64 } = require('./illustrationGenerator');
const { uploadBuffer } = require('./gcsStorage');

const NPC_TYPES = ['mom', 'dad', 'cat', 'dog', 'bunny', 'sibling'];

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

function buildPrompt(characters, style, briefMoments) {
  const cols = characters.length;
  const labels = characters.map(c => c.toUpperCase()).join(', ');

  const descLines = {
    mom:     'MOM: a warm smiling mother figure, standing relaxed, arms soft at sides, gentle welcoming expression. Clothing in the palette of the reference.',
    dad:     'DAD: a warm smiling father figure, standing relaxed, arms soft at sides, friendly expression. Clothing in the palette of the reference.',
    cat:     'CAT: a friendly small house cat sitting upright, tail curled around paws, bright eyes, soft furry body. Same illustrated style as the reference.',
    dog:     'DOG: a friendly small family dog sitting upright, tongue slightly out, waggy tail, soft fur. Same illustrated style as the reference.',
    bunny:   'BUNNY: a friendly cartoon rabbit sitting upright, long soft ears, fluffy tail, bright eyes. Same illustrated style as the reference.',
    sibling: 'SIBLING: a warm smiling child (younger or older sibling of the protagonist), standing relaxed, friendly expression. Clothing in the palette of the reference.',
  };

  const hintParts = [];
  if (briefMoments?.momName) hintParts.push(`The mother is called "${briefMoments.momName}" in the book`);
  if (briefMoments?.dadName) hintParts.push(`the father is called "${briefMoments.dadName}"`);
  if (briefMoments?.petName) hintParts.push(`the pet is called "${briefMoments.petName}"`);
  if (briefMoments?.siblingName) hintParts.push(`the sibling is called "${briefMoments.siblingName}"`);
  const hintBlock = hintParts.length
    ? `${hintParts.join('; ')} but DON'T include any text.`
    : '';

  return [
    `Generate a 1×${cols} CHARACTER SHEET containing the following side by side: ${labels}.`,
    '',
    'LAYOUT:',
    `${cols} equal-width cells in a single row, separated by thin white gutters. Each cell contains ONE character at the same baseline, same head height.`,
    '',
    'CHARACTERS:',
    ...characters.map(c => '- ' + descLines[c]),
    hintBlock,
    '',
    'CRITICAL:',
    '- Pure white (#FFFFFF) background in every cell and gutter. NO shadows, props, gradients, or textures.',
    '- NO text, letters, logos, or labels anywhere.',
    '- Each character fills ~70% of their cell, centered.',
    '- Soft 2-3px outer outline per character for a sticker-sheet feel.',
    '- Match the art style (line weight, palette, rendering) of the reference images exactly.',
    `- Style: ${style || 'pixar_premium'}.`,
    '',
    'Output: ONE single image containing the character sheet. No annotations.',
  ].filter(Boolean).join('\n');
}

async function callGrid({ apiKey, prompt, refs, aspectRatio }) {
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
      imageConfig: { aspectRatio },
    },
  };
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 80000);
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`NPC grid ${resp.status}: ${t.slice(0, 300)}`);
  }
  const data = await resp.json();
  const p = data?.candidates?.[0]?.content?.parts || [];
  const b64 = p.find(x => x.inlineData || x.inline_data)?.inlineData?.data
    || p.find(x => x.inlineData || x.inline_data)?.inline_data?.data;
  if (!b64) {
    const t = p.find(x => x.text)?.text || '';
    throw new Error(`No image returned. Text: "${t.slice(0, 200)}"`);
  }
  return Buffer.from(b64, 'base64');
}

async function sliceHorizontal(buffer, n) {
  const meta = await sharp(buffer).metadata();
  const { width, height } = meta;
  const cellW = Math.floor(width / n);
  const cells = [];
  for (let i = 0; i < n; i++) {
    const left = i * cellW;
    const buf = await sharp(buffer)
      .extract({ left, top: 0, width: cellW, height })
      .toBuffer();
    cells.push(buf);
  }
  return cells;
}

async function softChromakeyWhiteToTransparent(inputBuffer) {
  const img = sharp(inputBuffer).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (channels < 3) return inputBuffer;
  const n = width * height;
  const out = Buffer.alloc(n * 4);
  const LOW = 235, HIGH = 252;
  for (let i = 0; i < n; i++) {
    const si = i * channels, di = i * 4;
    const r = data[si], g = data[si + 1], b = data[si + 2];
    const m = Math.min(r, g, b);
    let a;
    if (m >= HIGH) a = 0;
    else if (m <= LOW) a = 255;
    else a = Math.round(255 * (HIGH - m) / (HIGH - LOW));
    out[di] = r; out[di + 1] = g; out[di + 2] = b; out[di + 3] = a;
  }
  return sharp(out, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
}

async function cellFill(buffer) {
  try {
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const n = info.width * info.height;
    let opaque = 0;
    for (let i = 0; i < n; i++) if (data[i * info.channels + 3] > 40) opaque++;
    return opaque / n;
  } catch (_) {
    return 0;
  }
}

async function collectRefs({ characterRefUrl, coverImageUrl }) {
  const refs = [];
  if (coverImageUrl) {
    try {
      const r = await downloadPhotoAsBase64(coverImageUrl);
      refs.push({ label: 'BOOK COVER (primary art style reference):', base64: r.base64, mime: r.mimeType || 'image/jpeg' });
    } catch (_) {}
  }
  if (characterRefUrl && refs.length < 2) {
    try {
      const r = await downloadPhotoAsBase64(characterRefUrl);
      refs.push({ label: 'CHARACTER REFERENCE (art style + rendering):', base64: r.base64, mime: r.mimeType || 'image/png' });
    } catch (_) {}
  }
  return refs;
}

/**
 * Generate requested NPCs in one call, slice, key, and upload.
 *
 * @param {object} input
 * @param {string} input.bookId
 * @param {string[]} [input.characters] - subset of NPC_TYPES (default: ['mom','cat'])
 * @param {string} [input.characterRefUrl]
 * @param {string} [input.coverImageUrl]
 * @param {string} [input.style]
 * @param {object} [input.briefMoments]  - optional name hints
 */
async function generateGameNpcs(input) {
  const startMs = Date.now();
  const { bookId, characterRefUrl, coverImageUrl, style, briefMoments } = input || {};
  const characters = Array.isArray(input?.characters) && input.characters.length
    ? input.characters.filter(c => NPC_TYPES.includes(c))
    : ['mom', 'cat'];

  if (!bookId) throw new Error('bookId is required');

  const refs = await collectRefs({ characterRefUrl, coverImageUrl });
  if (refs.length === 0) throw new Error('Could not download reference images for NPCs');

  const apiKey = pickApiKey();
  const prompt = buildPrompt(characters, style, briefMoments);

  // aspect ratio: ~1×N ratio; Gemini supports 4:3/3:2/16:9/1:1/2:3/3:4 etc.
  const aspect = characters.length === 1 ? '1:1' : characters.length === 2 ? '16:9' : '3:2';

  console.log(`[gameNpcs] Generating ${characters.length} NPCs for book ${bookId}: ${characters.join(',')}`);

  const gridRaw = await callGrid({ apiKey, prompt, refs, aspectRatio: aspect });
  const cells = await sliceHorizontal(gridRaw, characters.length);

  // Sanity check — each cell should be non-trivial
  const out = {};
  for (let i = 0; i < characters.length; i++) {
    const id = characters[i];
    const keyed = await softChromakeyWhiteToTransparent(cells[i]);
    const fill = await cellFill(keyed);
    if (fill < 0.03) {
      console.warn(`[gameNpcs] ${id} cell looks empty (fill=${fill.toFixed(3)}); skipping`);
      continue;
    }
    const path = `game-npcs/${bookId}/${id}.png`;
    out[id] = await uploadBuffer(keyed, path, 'image/png');
  }

  if (Object.keys(out).length === 0) throw new Error('All NPC cells were empty — grid generation failed');

  const manifest = {
    bookId,
    generatedAt: new Date().toISOString(),
    npcs: out,
  };
  const manifestUrl = await uploadBuffer(
    Buffer.from(JSON.stringify(manifest, null, 2)),
    `game-npcs/${bookId}/manifest.json`,
    'application/json',
  );

  const tookMs = Date.now() - startMs;
  console.log(`[gameNpcs] Done in ${tookMs}ms (${Object.keys(out).length} NPCs)`);

  return { npcs: out, manifestUrl, tookMs };
}

module.exports = { generateGameNpcs, NPC_TYPES };
