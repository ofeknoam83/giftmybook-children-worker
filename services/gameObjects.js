/**
 * Game Objects Stylesheet — one coordinated AI call per book.
 *
 * Replaces per-room object generation. Produces ONE image containing all
 * ~80 game items tiled on a grid with identical art style, then Sharp-slices,
 * chromakeys white → transparent, alpha-trims, and uploads each cell.
 *
 * Cost: ~1 Gemini image call per book. Produces visually coherent art because
 * every item was rendered by the same generation pass, with the book cover
 * supplied as a style anchor.
 *
 * Output manifest:
 *   {
 *     manifestUrl: string,          // pointer to the full JSON on GCS
 *     items: { [itemId]: string },  // per-item PNG URLs
 *     sheetUrl: string,             // the raw uncropped sheet (for debug)
 *   }
 */

const sharp = require('sharp');
const { GEMINI_IMAGE_MODEL, CHAT_API_BASE } = require('./illustrator/config');
const { fetchWithTimeout, downloadPhotoAsBase64 } = require('./illustrationGenerator');
const { uploadBuffer } = require('./gcsStorage');

// ── Key picker (mirrors gameCharacter.js) ──
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

/**
 * Pick a grid shape that fits `count` items with roughly square cells, up to
 * a 10-column cap (Gemini's single-image resolution can't reliably resolve
 * more than ~10 cells per side).
 */
function pickGridShape(count) {
  const cols = Math.min(10, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / cols);
  return { cols, rows };
}

/**
 * Build the stylesheet prompt.
 *
 * `items` is an array of { id, label } — label is the human prompt (e.g. "red
 * apple"), id is the dictionary key used for the output map.
 */
function stylesheetPrompt(items, { style, rows, cols }) {
  const lines = items.map((it, i) => {
    const row = Math.floor(i / cols) + 1;
    const col = (i % cols) + 1;
    return `  • row ${row}, col ${col}: ${it.label || it.id}`;
  });

  return [
    `Generate ONE sticker-sheet image: a ${rows}-row × ${cols}-column grid of ${items.length} children's-book illustrated items.`,
    `All items MUST share the exact same art style — consistent line weight, shading, palette, and finish.`,
    '',
    'LAYOUT (critical — must follow exactly):',
    `- The image is split into ${rows * cols} equal cells with thin white gutters between them.`,
    `- Each cell contains exactly ONE item, centred, tight-cropped, filling ~75% of the cell.`,
    '- Items point "up" (not rotated / not tilted). No item bleeds into adjacent cells.',
    '',
    'ITEM LIST (one item per cell, in row-major order):',
    ...lines,
    '',
    'STYLE:',
    `- Illustrated picture-book look, ${style || 'pixar_premium'}.`,
    '- Thick confident outlines (~2–3 px), soft shading, subtle rim shine on round objects.',
    '- Bright saturated colour, warm palette, cheerful mood.',
    '- Consistent 3/4 angle on all volumetric items (mugs, stoves, plush toys).',
    '',
    'BACKGROUND (ABSOLUTELY CRITICAL — we chromakey this):',
    '- Every non-item pixel is pure flat white (#FFFFFF).',
    '- Gutters between cells are also pure white.',
    '- No cream, no pastel, no gradient, no vignette, no ground shadow, no rim glow.',
    '- Crisp item edges with no outer halo or soft fade.',
    '',
    'ABSOLUTE RULES:',
    '- NO text, NO labels, NO numbers, NO borders, NO logos ANYWHERE.',
    '- NO arrows, NO crop marks, NO watermark.',
    '- Just the items on pure white in a tidy grid.',
    '',
    'Output: ONE single image containing the whole sticker sheet. Do NOT output multiple images.',
  ].join('\n');
}

/**
 * Gemini single-call for the stylesheet, using the cover + (optional)
 * character reference as style anchors.
 */
async function callGeminiStylesheet({ apiKey, prompt, refs, aspectRatio = '1:1' }) {
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
  }, 120000);

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Stylesheet Gemini ${resp.status}: ${t.slice(0, 300)}`);
  }
  const data = await resp.json();
  const mp = data?.candidates?.[0]?.content?.parts || [];
  const imgPart = mp.find(p => p.inlineData || p.inline_data);
  const b64 = imgPart?.inlineData?.data || imgPart?.inline_data?.data;
  if (!b64) {
    const t = mp.find(p => p.text)?.text || '';
    throw new Error(`No stylesheet image returned. Text: "${t.slice(0, 200)}"`);
  }
  return Buffer.from(b64, 'base64');
}

async function collectRefs({ coverImageUrl, characterRefUrl }) {
  const refs = [];
  if (coverImageUrl) {
    try {
      const r = await downloadPhotoAsBase64(coverImageUrl);
      refs.push({ label: 'BOOK COVER (match this art style exactly):', base64: r.base64, mime: r.mimeType || 'image/jpeg' });
    } catch (_) {}
  }
  if (characterRefUrl && refs.length < 2) {
    try {
      const r = await downloadPhotoAsBase64(characterRefUrl);
      refs.push({ label: 'CHARACTER REFERENCE (style anchor):', base64: r.base64, mime: r.mimeType || 'image/png' });
    } catch (_) {}
  }
  return refs;
}

/**
 * Same chromakey + alpha-trim pipeline as character poses, factored out here
 * so we don't cross-import private helpers.
 */
async function chromakeyWhite(inputBuffer) {
  const img = sharp(inputBuffer).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (channels < 3) return inputBuffer;

  const pxCount = width * height;
  const out = Buffer.alloc(pxCount * 4);
  const LOW = 220, HIGH = 246;
  const CHANNEL_SPREAD = 18;

  for (let i = 0; i < pxCount; i++) {
    const srcIdx = i * channels;
    const dstIdx = i * 4;
    const r = data[srcIdx];
    const g = data[srcIdx + 1];
    const b = data[srcIdx + 2];
    const minC = Math.min(r, g, b);
    const maxC = Math.max(r, g, b);
    const spread = maxC - minC;

    let alpha;
    const whitish = minC >= LOW && spread <= CHANNEL_SPREAD;
    if (!whitish) alpha = 255;
    else if (minC >= HIGH) alpha = 0;
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

async function trimToAlpha(inputBuffer, pad = 6) {
  try {
    const { data, info } = await sharp(inputBuffer).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    const ALPHA_THRESH = 24;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const a = data[(y * width + x) * channels + 3];
        if (a > ALPHA_THRESH) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return inputBuffer;
    const left = Math.max(0, minX - pad);
    const top = Math.max(0, minY - pad);
    const right = Math.min(width - 1, maxX + pad);
    const bottom = Math.min(height - 1, maxY + pad);
    const w = right - left + 1;
    const h = bottom - top + 1;
    return sharp(inputBuffer).extract({ left, top, width: w, height: h })
      .png({ compressionLevel: 9 }).toBuffer();
  } catch (_) {
    return inputBuffer;
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

/**
 * Main entry — generate a single coordinated sticker sheet for a book.
 */
async function generateGameStylesheet(input) {
  const startMs = Date.now();
  const { bookId, coverImageUrl, characterRefUrl, items, style } = input || {};
  if (!bookId) throw new Error('bookId is required');
  if (!Array.isArray(items) || items.length === 0) throw new Error('items array is required');

  // Normalise each entry to { id, label }. Accept strings for simple ids.
  const normItems = items.map((it) => {
    if (typeof it === 'string') return { id: it, label: it.replace(/_/g, ' ') };
    return { id: it.id, label: it.label || it.id.replace(/_/g, ' ') };
  }).filter((it) => it.id);

  if (normItems.length === 0) throw new Error('items list is empty after normalisation');
  if (normItems.length > 100) {
    console.warn(`[gameObjects] item count ${normItems.length} > 100, truncating`);
    normItems.length = 100;
  }

  const { cols, rows } = pickGridShape(normItems.length);
  const apiKey = pickApiKey();
  const refs = await collectRefs({ coverImageUrl, characterRefUrl });
  if (refs.length === 0) {
    console.warn(`[gameObjects] No style references available for ${bookId}; generating without anchor`);
  }

  const aspect = rows >= cols ? '3:4' : (rows === cols ? '1:1' : '4:3');
  console.log(`[gameObjects] bookId=${bookId}: ${normItems.length} items → ${rows}×${cols} grid (aspect ${aspect})`);

  const prompt = stylesheetPrompt(normItems, { style, rows, cols });
  const sheetBuf = await callGeminiStylesheet({ apiKey, prompt, refs, aspectRatio: aspect });

  // Upload raw sheet for debugging.
  let sheetUrl = '';
  try {
    sheetUrl = await uploadBuffer(sheetBuf, `game-stylesheets/${bookId}/sheet.png`, 'image/png');
  } catch (_) {}

  const meta = await sharp(sheetBuf).metadata();
  const sheetW = meta.width || 0;
  const sheetH = meta.height || 0;
  if (!sheetW || !sheetH) throw new Error('Could not read stylesheet dimensions');

  const cellW = Math.floor(sheetW / cols);
  const cellH = Math.floor(sheetH / rows);

  const urls = {};
  let uploaded = 0;
  for (let i = 0; i < normItems.length; i++) {
    const { id } = normItems[i];
    const row = Math.floor(i / cols);
    const col = i % cols;
    try {
      const cellBuf = await sharp(sheetBuf)
        .extract({ left: col * cellW, top: row * cellH, width: cellW, height: cellH })
        .toBuffer();
      const keyed = await chromakeyWhite(cellBuf);
      const fill = await cellFill(keyed);
      if (fill < 0.01) {
        console.warn(`[gameObjects] ${id}: cell nearly empty (fill=${fill.toFixed(3)}), skipping upload`);
        continue;
      }
      const trimmed = await trimToAlpha(keyed, 6);
      const pngUrl = await uploadBuffer(
        trimmed,
        `game-stylesheets/${bookId}/items/${id}.png`,
        'image/png'
      );
      urls[id] = pngUrl;
      uploaded++;
    } catch (err) {
      console.warn(`[gameObjects] ${id}: slice/upload failed: ${err.message}`);
    }
  }

  if (uploaded === 0) throw new Error('All stylesheet cells failed to upload');

  const manifest = {
    bookId,
    generatedAt: new Date().toISOString(),
    grid: { rows, cols },
    sheetUrl,
    items: urls,
    sourceItems: normItems,
  };
  const manifestUrl = await uploadBuffer(
    Buffer.from(JSON.stringify(manifest, null, 2)),
    `game-stylesheets/${bookId}/manifest.json`,
    'application/json'
  );

  const tookMs = Date.now() - startMs;
  console.log(`[gameObjects] Done in ${tookMs}ms (${uploaded}/${normItems.length} items uploaded)`);

  return {
    manifestUrl,
    items: urls,
    sheetUrl,
    grid: { rows, cols },
    uploaded,
    tookMs,
  };
}

module.exports = { generateGameStylesheet };
