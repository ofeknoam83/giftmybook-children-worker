/**
 * Game Character Atlas (Milestone F).
 *
 * Generates a single 4×4 Gemini image containing 16 evenly-spaced parts of the
 * child character — head poses, eye variants, mouth expressions, and body/arm
 * pieces — so the client can assemble a fully-rigged multi-part sprite
 * (Toca-Boca style) with pointer-tracking eyes, expression swaps, idle fidgets
 * and secondary motion.
 *
 * Grid layout (left→right, top→bottom):
 *   row 1: head-front      head-3q-left    head-3q-right   head-down
 *   row 2: eyes-open       eyes-closed     eyes-left       eyes-right
 *   row 3: mouth-smile     mouth-open      mouth-surprise  mouth-frown
 *   row 4: body-standing   arm-left        arm-right       hair-back
 *
 * Why a single 4×4 grid: one call keeps identity & style consistent across all
 * parts AND is 16× cheaper than generating parts individually. The model is
 * explicitly instructed to render eyes/mouths as isolated transparent strips
 * so the client can composite them at calibration anchors.
 *
 * Output manifest:
 *   {
 *     bookId,
 *     generatedAt,
 *     parts: {
 *       'head-front':     { url, w, h },
 *       'head-3q-left':   { url, w, h },
 *       ...
 *       'body-standing':  { url, w, h },
 *     },
 *     anchors: {
 *       // All in the 0..1 range relative to the body-standing cell's bbox.
 *       neck:        { x, y },   // where head sits on the body
 *       eyeL:        { x, y },   // where left eye anchors on the head
 *       eyeR:        { x, y },
 *       mouth:       { x, y },
 *       shoulderL:   { x, y },
 *       shoulderR:   { x, y },
 *     },
 *     cellSize:   { w, h },      // raw pixel size of each cell
 *     manifestUrl,
 *     tookMs,
 *   }
 */

const sharp = require('sharp');
const { GEMINI_IMAGE_MODEL, CHAT_API_BASE } = require('./illustrator/config');
const { fetchWithTimeout, downloadPhotoAsBase64 } = require('./illustrationGenerator');
const { uploadBuffer } = require('./gcsStorage');

// Ordered flat list of the 16 parts; index → (row,col).
const PART_ORDER = [
  'head-front', 'head-3q-left', 'head-3q-right', 'head-down',
  'eyes-open',  'eyes-closed',  'eyes-left',     'eyes-right',
  'mouth-smile','mouth-open',   'mouth-surprise','mouth-frown',
  'body-standing', 'arm-left',  'arm-right',     'hair-back',
];

// Heuristic default anchor points (fractions of body cell). The model is also
// asked to return anchor points as JSON but these fallbacks keep the rig
// assembleable if the model omits or malforms the JSON.
const DEFAULT_ANCHORS = {
  neck:      { x: 0.50, y: 0.28 },
  eyeL:      { x: 0.44, y: 0.20 },
  eyeR:      { x: 0.56, y: 0.20 },
  mouth:     { x: 0.50, y: 0.30 },
  shoulderL: { x: 0.38, y: 0.42 },
  shoulderR: { x: 0.62, y: 0.42 },
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

function atlasPrompt(childDetails, style) {
  const name = childDetails?.name || 'the child';

  return [
    `Generate ONE image containing a 4×4 grid of CHARACTER PARTS for "${name}".`,
    'These parts will be assembled by a 2D rigging engine into a living character,',
    'so identity, skin tone, hair, clothing, and line weight MUST match the reference images exactly.',
    '',
    'GRID LAYOUT (16 cells, 4 rows × 4 columns, thin white gutters between cells):',
    'Row 1 (HEAD POSES — head-only, cropped at the neckline, looking at camera):',
    '  [head-front]   [head-3q-left]   [head-3q-right]   [head-down]',
    'Row 2 (EYES — the eyes ONLY, NOT the whole head; just the pair of eyes with eyelids and eyelashes, no hair, no face outline, floating on pure white):',
    '  [eyes-open]    [eyes-closed]    [eyes-look-left]  [eyes-look-right]',
    'Row 3 (MOUTHS — the mouth ONLY, just lips and teeth when visible, no face outline, floating on pure white):',
    '  [mouth-smile]  [mouth-open]     [mouth-surprise]  [mouth-frown]',
    'Row 4 (BODY PARTS — no head; the rig will compose head separately):',
    '  [body-standing]  [arm-left]   [arm-right]   [hair-back]',
    '',
    'DETAILED INSTRUCTIONS:',
    '- HEAD cells: draw the full head (hair + face + ears) only. Cut off cleanly at the neck. Eyes open, neutral smile. The 3q-left/right poses rotate roughly 30° off-axis.',
    '- EYES cells: isolated eyes floating on pure white. Include eyelashes. Do NOT draw the face, nose, or hair. Align eyes horizontally centered in the cell.',
    '- MOUTH cells: isolated mouth on pure white. Do NOT draw nose, chin, or teeth unless the pose requires (mouth-open, mouth-surprise can show teeth).',
    '- BODY cell: headless torso + legs in a relaxed standing pose. Leave the neck stump visible at the top so the head composites cleanly.',
    '- ARM cells: a single isolated arm in a neutral forward-hanging position, floating on white. arm-left faces the character\'s left (mirror of arm-right).',
    '- HAIR-BACK cell: the long-hair component that sits BEHIND the head (a silhouette of the hair flowing behind shoulders). If the character has short hair, draw a small empty hair tuft / neck-shadow shape.',
    '',
    'CHARACTER CONSISTENCY (critical):',
    '- Same skin tone, hair color, clothing colors in every cell (HEAD poses, BODY, ARMS).',
    '- Same outline weight and rendering style throughout.',
    '- No props, no shadows, no ground.',
    '',
    'BACKGROUND:',
    '- Pure white (#FFFFFF) fill everywhere — inside cells, gutters, borders.',
    '- NO text, NO labels, NO numbers, NO legend, NO arrows.',
    '',
    'RENDERING:',
    `- Match the reference illustration style (color palette, line weight, shading).`,
    `- Style: ${style || 'pixar_premium'}.`,
    '- Soft 2-3px outer outline around each part for a sticker-sheet feel.',
    '',
    'ANCHOR POINTS (return as a JSON block IN ADDITION to the image):',
    'After the image, include a short text response with a JSON object describing where head/eyes/mouth/arms attach on the body-standing cell.',
    'Format exactly:',
    '```json',
    '{"anchors":{"neck":{"x":0.50,"y":0.28},"eyeL":{"x":0.44,"y":0.20},"eyeR":{"x":0.56,"y":0.20},"mouth":{"x":0.50,"y":0.30},"shoulderL":{"x":0.38,"y":0.42},"shoulderR":{"x":0.62,"y":0.42}}}',
    '```',
    'Coordinates are fractions 0..1 relative to the body-standing cell (x=left→right, y=top→bottom).',
    '',
    'Output: ONE single 1:1 image containing the 4×4 grid + optional JSON text block. Do NOT output separate images. Do NOT include any text inside the image.',
  ].join('\n');
}

async function callGeminiAtlas({ apiKey, prompt, refs }) {
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
      imageConfig: { aspectRatio: '1:1' },
    },
  };

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 120000);

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Atlas Gemini ${resp.status}: ${t.slice(0, 300)}`);
  }
  const data = await resp.json();
  const parts2 = data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts2.find((p) => p.inlineData || p.inline_data);
  const b64 = imgPart?.inlineData?.data || imgPart?.inline_data?.data;
  if (!b64) {
    const t = parts2.find((p) => p.text)?.text || '';
    throw new Error(`No atlas image returned. Text: "${t.slice(0, 200)}"`);
  }
  const textBlocks = parts2.filter((p) => p.text).map((p) => p.text).join('\n');
  return { image: Buffer.from(b64, 'base64'), text: textBlocks };
}

function extractAnchorsFromText(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*?"anchors"[\s\S]*?\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    if (obj?.anchors && typeof obj.anchors === 'object') return obj.anchors;
  } catch (_) {}
  return null;
}

async function sliceGrid4x4(inputBuffer) {
  const img = sharp(inputBuffer);
  const meta = await img.metadata();
  const { width, height } = meta;
  if (!width || !height) throw new Error('Could not read atlas grid dimensions');

  const cellW = Math.floor(width / 4);
  const cellH = Math.floor(height / 4);
  const out = [];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const buf = await sharp(inputBuffer)
        .extract({ left: col * cellW, top: row * cellH, width: cellW, height: cellH })
        .toBuffer();
      out.push(buf);
    }
  }
  return { cells: out, cellW, cellH };
}

// Two-pass matte chromakey.
//
// Pass 1: saturation-aware color-distance threshold. A pixel is considered
// background when it's both bright (near white) AND desaturated. This keeps
// pale skin / light hair from being chewed away while killing gutter white.
//
// Pass 2: blur the alpha channel lightly to feather hard edges, then erode
// (push low alpha to 0) so we don't leave a 1-pixel white halo around the
// silhouette — that halo is the "bounding-box outline" the user was seeing.
async function softChromakeyWhiteToTransparent(inputBuffer) {
  const img = sharp(inputBuffer).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (channels < 3) return inputBuffer;

  const pxCount = width * height;
  const rgba = Buffer.alloc(pxCount * 4);

  const SAT_KEEP = 0.10;
  const DIST_CLEAR = 5;
  const DIST_KEEP = 28;

  for (let i = 0; i < pxCount; i++) {
    const srcIdx = i * channels;
    const dstIdx = i * 4;
    const r = data[srcIdx];
    const g = data[srcIdx + 1];
    const b = data[srcIdx + 2];
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const sat = maxC > 0 ? (maxC - minC) / maxC : 0;
    const dist = 255 - minC;

    let alpha;
    if (sat > SAT_KEEP) alpha = 255;
    else if (dist < DIST_CLEAR) alpha = 0;
    else if (dist > DIST_KEEP) alpha = 255;
    else alpha = Math.round(255 * (dist - DIST_CLEAR) / (DIST_KEEP - DIST_CLEAR));

    rgba[dstIdx] = r;
    rgba[dstIdx + 1] = g;
    rgba[dstIdx + 2] = b;
    rgba[dstIdx + 3] = alpha;
  }

  let alphaChan;
  try {
    alphaChan = await sharp(rgba, { raw: { width, height, channels: 4 } })
      .extractChannel('alpha')
      .blur(0.6)
      .raw()
      .toBuffer();
  } catch (_) {
    alphaChan = null;
  }

  if (alphaChan && alphaChan.length === pxCount) {
    for (let i = 0; i < pxCount; i++) {
      let a = alphaChan[i];
      if (a < 30) a = 0;
      else if (a < 230) a = Math.min(255, a + 12);
      rgba[i * 4 + 3] = a;
    }
  }

  return sharp(rgba, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

// Crop transparent padding to the 99th-percentile alpha bbox, then re-extend
// by 6px of full-transparency padding. The padding guarantees the client can
// composite the part without clipping semi-transparent edge feather.
async function trimAlpha(buffer) {
  try {
    const trimmed = await sharp(buffer)
      .trim({ threshold: 4 })
      .png({ compressionLevel: 9 })
      .toBuffer();
    return await sharp(trimmed)
      .extend({
        top: 6, bottom: 6, left: 6, right: 6,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch (_) {
    return buffer;
  }
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

async function collectRefs({ idlePoseUrl, characterRefUrl, coverImageUrl, childPhotoUrl }) {
  const refs = [];
  if (idlePoseUrl) {
    try {
      const r = await downloadPhotoAsBase64(idlePoseUrl);
      refs.push({ label: 'IDLE POSE (identity + style anchor — character must match exactly):', base64: r.base64, mime: r.mimeType || 'image/png' });
    } catch (_) {}
  }
  if (characterRefUrl) {
    try {
      const r = await downloadPhotoAsBase64(characterRefUrl);
      refs.push({ label: 'CHARACTER REFERENCE:', base64: r.base64, mime: r.mimeType || 'image/png' });
    } catch (_) {}
  }
  if (coverImageUrl && refs.length < 2) {
    try {
      const r = await downloadPhotoAsBase64(coverImageUrl);
      refs.push({ label: 'BOOK COVER (art style):', base64: r.base64, mime: r.mimeType || 'image/jpeg' });
    } catch (_) {}
  }
  if (childPhotoUrl && refs.length < 2) {
    try {
      const r = await downloadPhotoAsBase64(childPhotoUrl);
      refs.push({ label: 'REAL CHILD PHOTO (identity ground truth):', base64: r.base64, mime: r.mimeType || 'image/jpeg' });
    } catch (_) {}
  }
  return refs;
}

/**
 * Main entry — generate the character atlas for a book.
 *
 * @param {object} input
 * @param {string} input.bookId
 * @param {string} [input.characterRefUrl]
 * @param {string} [input.coverImageUrl]
 * @param {string} [input.childPhotoUrl]
 * @param {string} [input.idlePoseUrl]
 * @param {string} [input.style]
 * @param {object} [input.childDetails] - { name, age, gender, ... }
 * @returns {Promise<object>} manifest
 */
async function generateGameCharacterAtlas(input) {
  const startMs = Date.now();
  const {
    bookId,
    characterRefUrl,
    coverImageUrl,
    childPhotoUrl,
    idlePoseUrl,
    style,
    childDetails,
  } = input || {};

  if (!bookId) throw new Error('bookId is required');

  const refs = await collectRefs({ idlePoseUrl, characterRefUrl, coverImageUrl, childPhotoUrl });
  if (refs.length === 0) throw new Error('Could not download any reference image');

  console.log(`[gameCharacterAtlas] Generating atlas for book ${bookId}`);

  const apiKey = pickApiKey();
  const prompt = atlasPrompt(childDetails, style);

  // Try up to 2 times — character atlases are identity-critical and Gemini
  // occasionally drops eyes/mouth rows or returns non-4×4 layouts.
  let raw;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      raw = await callGeminiAtlas({ apiKey, prompt, refs });
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`[gameCharacterAtlas] attempt ${attempt + 1} failed: ${err.message}`);
    }
  }
  if (!raw) throw lastErr || new Error('Atlas generation failed');

  const { cells, cellW, cellH } = await sliceGrid4x4(raw.image);

  // Chromakey every cell. For body+head cells we keep the full cell bounds so
  // the client can use LLM-returned anchors (fractions of the body cell) to
  // position head on body, arms on shoulders, etc. without bookkeeping the
  // trim offset. For small parts (eyes/mouth/arms/hair-back) we alpha-trim
  // to avoid wasted pixels — the client positions them by anchor + center.
  const NO_TRIM = new Set(['head-front', 'head-3q-left', 'head-3q-right', 'head-down', 'body-standing']);
  const uploadedParts = {};
  for (let i = 0; i < cells.length; i++) {
    const partName = PART_ORDER[i];
    try {
      const keyed = await softChromakeyWhiteToTransparent(cells[i]);
      const trimmed = NO_TRIM.has(partName) ? keyed : await trimAlpha(keyed);
      const fill = await cellFill(trimmed);
      if (fill < 0.01) {
        console.warn(`[gameCharacterAtlas] skipping empty part ${partName} (fill=${fill.toFixed(3)})`);
        continue;
      }
      const meta = await sharp(trimmed).metadata();
      const path = `game-characters/${bookId}/atlas/${partName}.png`;
      const url = await uploadBuffer(trimmed, path, 'image/png');
      uploadedParts[partName] = { url, w: meta.width || cellW, h: meta.height || cellH };
    } catch (err) {
      console.warn(`[gameCharacterAtlas] part ${partName} failed: ${err.message}`);
    }
  }

  if (Object.keys(uploadedParts).length < 8) {
    throw new Error(`Atlas produced only ${Object.keys(uploadedParts).length}/16 parts`);
  }

  // Ensure critical parts exist; fall back by mirroring if needed.
  if (!uploadedParts['arm-right'] && uploadedParts['arm-left']) {
    uploadedParts['arm-right'] = uploadedParts['arm-left'];
  }
  if (!uploadedParts['eyes-right'] && uploadedParts['eyes-left']) {
    uploadedParts['eyes-right'] = uploadedParts['eyes-left'];
  }
  if (!uploadedParts['head-3q-right'] && uploadedParts['head-3q-left']) {
    uploadedParts['head-3q-right'] = uploadedParts['head-3q-left'];
  }

  const modelAnchors = extractAnchorsFromText(raw.text);
  const anchors = { ...DEFAULT_ANCHORS, ...(modelAnchors || {}) };

  const manifest = {
    bookId,
    generatedAt: new Date().toISOString(),
    parts: uploadedParts,
    anchors,
    cellSize: { w: cellW, h: cellH },
  };
  const manifestUrl = await uploadBuffer(
    Buffer.from(JSON.stringify(manifest, null, 2)),
    `game-characters/${bookId}/atlas/manifest.json`,
    'application/json',
  );

  const tookMs = Date.now() - startMs;
  console.log(`[gameCharacterAtlas] Done in ${tookMs}ms (${Object.keys(uploadedParts).length} parts)`);

  return { ...manifest, manifestUrl, tookMs };
}

module.exports = { generateGameCharacterAtlas, PART_ORDER, DEFAULT_ANCHORS };
