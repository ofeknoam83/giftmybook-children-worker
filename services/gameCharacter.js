/**
 * Game Character Asset Pipeline — grid-sheet mode.
 *
 * PRIMARY PATH: one Gemini call produces a 2×3 grid of all six poses at once,
 * then sharp slices it. This keeps character silhouette/proportions IDENTICAL
 * across poses (critical for clean crossfade rig) AND cuts latency ~6×
 * vs. sequential generation.
 *
 * FALLBACK PATH: if the grid doesn't produce a usable image (refused, wrong
 * shape, near-empty cells), fall back to the sequential chat-session approach.
 *
 * Output: six transparent-background PNGs + manifest on GCS, per-book.
 *
 * Poses: idle / walk / jump / eat / sleep / cheer
 * Grid layout (after slicing):
 *   [idle  walk  jump ]
 *   [eat   sleep cheer]
 */

const sharp = require('sharp');
const { GEMINI_IMAGE_MODEL, CHAT_API_BASE } = require('./illustrator/config');
const { fetchWithTimeout, downloadPhotoAsBase64 } = require('./illustrationGenerator');
const { uploadBuffer } = require('./gcsStorage');

const POSES = ['idle', 'walk', 'jump', 'eat', 'sleep', 'cheer'];
const GRID_COLS = 3;
const GRID_ROWS = 2;

// ── Key picker (same as before) ──
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

// ── Prompt for the grid call ──
function gridPrompt(childDetails, style) {
  const name = childDetails?.name || 'the child';
  const age = childDetails?.age != null ? String(childDetails.age) : '';
  const ageLine = age ? `The character is ${age} years old.` : '';

  return [
    `Generate a 2×3 POSE SHEET of the SAME character "${name}" for a children's game.`,
    ageLine,
    `The character MUST match the identity shown in the reference images exactly — same face, skin tone, hair, clothing, style.`,
    '',
    'LAYOUT (critical — must follow exactly):',
    'The output image is a 2-row × 3-column grid with thin white gutters separating 6 equal cells.',
    'Top row (left→right): [IDLE] [WALK] [JUMP]',
    'Bottom row (left→right): [EAT] [SLEEP] [CHEER]',
    '',
    'CHARACTER POSITIONING (critical — must be identical across cells):',
    '- The same character appears in all 6 cells, standing at the same baseline.',
    '- Feet near the bottom of each cell (same vertical position).',
    '- Head at the same height in each cell.',
    '- Same body size and proportions in each cell — ONLY the pose changes.',
    '- No ground shadow, no floor line, no props.',
    '',
    'POSES:',
    '- IDLE: standing relaxed, arms at sides, soft smile, open bright eyes, facing forward.',
    '- WALK: mid-stride, left foot forward on ground, right foot lifting; arms swing opposite to legs; happy smile.',
    '- JUMP: airborne with both feet off ground, knees bent and tucked, arms raised in a V; open-mouth smile; head tilted slightly back.',
    '- EAT: holding a small piece of food with both hands near the mouth, eyes closed happily, cheeks lightly puffed.',
    '- SLEEP: standing upright but with eyes closed, head tilted to one side resting on palm-to-palm hands pressed to cheek; peaceful smile.',
    '- CHEER: arms thrown up high in a V, open-mouth joyful smile, eyes sparkling; feet slightly apart.',
    '',
    'BACKGROUND (critical):',
    '- Pure white (#FFFFFF) fill everywhere — inside cells, gutters, and borders.',
    '- NO text, NO letters, NO labels, NO numbers, NO borders, NO logos, NO cell dividers visible as ink — just white gutters.',
    '- NO props, shadows, gradients, or textures.',
    '',
    'RENDERING:',
    '- Same illustrated style as the reference images (color, line weight, rendering).',
    '- Soft 2-3px outer outline around each character for a sticker-sheet feel.',
    `- Style: ${style || 'pixar_premium'}.`,
    '',
    'Output: ONE single image containing the 2×3 grid. Do NOT output 6 separate images. Do NOT include any text annotations.',
  ].join('\n');
}

/**
 * Slice a grid-sheet image into an array of per-pose buffers.
 */
async function sliceGrid(inputBuffer) {
  const img = sharp(inputBuffer);
  const meta = await img.metadata();
  const { width, height } = meta;
  if (!width || !height) throw new Error('Could not read grid dimensions');

  const cellW = Math.floor(width / GRID_COLS);
  const cellH = Math.floor(height / GRID_ROWS);

  const cells = {};
  let idx = 0;
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const poseName = POSES[idx++];
      const left = col * cellW;
      const top = row * cellH;
      const buf = await sharp(inputBuffer)
        .extract({ left, top, width: cellW, height: cellH })
        .toBuffer();
      cells[poseName] = buf;
    }
  }
  return cells;
}

/**
 * Soft luminance chromakey — pure white to transparent with feathered edge.
 */
async function softChromakeyWhiteToTransparent(inputBuffer) {
  const img = sharp(inputBuffer).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (channels < 3) return inputBuffer;

  const pxCount = width * height;
  const out = Buffer.alloc(pxCount * 4);
  const LOW = 235, HIGH = 252;

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

/**
 * Sanity check — a cell should have non-trivial opaque area after chromakey.
 * Returns the opaque pixel fraction (0-1).
 */
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
 * Direct single-shot Gemini call — request ONE grid image.
 */
async function callGeminiGrid({ apiKey, prompt, refs }) {
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
      imageConfig: { aspectRatio: '3:2' }, // 3 cols × 2 rows
    },
  };

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 90000);

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Grid Gemini ${resp.status}: ${t.slice(0, 300)}`);
  }
  const data = await resp.json();
  const parts2 = data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts2.find(p => p.inlineData || p.inline_data);
  const b64 = imgPart?.inlineData?.data || imgPart?.inline_data?.data;
  if (!b64) {
    const t = parts2.find(p => p.text)?.text || '';
    throw new Error(`No image returned. Text: "${t.slice(0, 200)}"`);
  }
  return Buffer.from(b64, 'base64');
}

/**
 * Download references for identity + style.
 */
async function collectRefs({ characterRefUrl, coverImageUrl, childPhotoUrl }) {
  const refs = [];
  if (characterRefUrl) {
    try {
      const r = await downloadPhotoAsBase64(characterRefUrl);
      refs.push({ label: 'CHARACTER REFERENCE (style + identity — match exactly):', base64: r.base64, mime: r.mimeType || 'image/png' });
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
 * Main entry — generates full 6-pose set + uploads + returns manifest.
 *
 * Tries grid-mode first. If slicing produces cells that are mostly empty
 * (indicates Gemini returned a single character instead of a grid), falls
 * back to individual generation.
 */
async function generateGameCharacter(input) {
  const startMs = Date.now();
  const { bookId, characterRefUrl, childPhotoUrl, coverImageUrl, style, childDetails } = input || {};

  if (!bookId) throw new Error('bookId is required');
  if (!characterRefUrl && !coverImageUrl && !childPhotoUrl) {
    throw new Error('At least one of characterRefUrl / coverImageUrl / childPhotoUrl is required');
  }

  const apiKey = pickApiKey();
  const refs = await collectRefs({ characterRefUrl, coverImageUrl, childPhotoUrl });
  if (refs.length === 0) throw new Error('Could not download any reference image');

  console.log(`[gameCharacter] Grid-mode generation for book ${bookId}`);

  let poseBuffers = null;

  // ── Primary: grid single-call ──
  try {
    const prompt = gridPrompt(childDetails, style);
    const gridRaw = await callGeminiGrid({ apiKey, prompt, refs });
    const cells = await sliceGrid(gridRaw);

    // Sanity: average fill across all 6 cells must exceed 4%.
    // If the model returned a single character zoomed in, 5 cells will be empty.
    const keyedCells = {};
    let totalFill = 0;
    for (const [name, buf] of Object.entries(cells)) {
      const keyed = await softChromakeyWhiteToTransparent(buf);
      keyedCells[name] = keyed;
      totalFill += await cellFill(keyed);
    }
    const avgFill = totalFill / POSES.length;

    if (avgFill < 0.04) {
      console.warn(`[gameCharacter] Grid result looks empty (avgFill=${avgFill.toFixed(3)}); falling back to sequential`);
      poseBuffers = null;
    } else {
      poseBuffers = keyedCells;
      console.log(`[gameCharacter] Grid success (avgFill=${avgFill.toFixed(3)})`);
    }
  } catch (err) {
    console.warn(`[gameCharacter] Grid mode failed: ${err.message}; falling back to sequential`);
  }

  // ── Fallback: sequential chat session (old path) ──
  if (!poseBuffers) {
    poseBuffers = await generateSequential({ apiKey, refs, childDetails, style });
  }

  // ── Upload each pose + manifest ──
  const poseUrls = {};
  for (const [name, buf] of Object.entries(poseBuffers)) {
    try {
      const path = `game-characters/${bookId}/${name}.png`;
      poseUrls[name] = await uploadBuffer(buf, path, 'image/png');
    } catch (e) {
      console.warn(`[gameCharacter] upload ${name} failed: ${e.message}`);
    }
  }
  if (!poseUrls.idle) {
    const first = Object.keys(poseUrls)[0];
    if (first) poseUrls.idle = poseUrls[first];
  }
  if (!poseUrls.idle) throw new Error('All pose uploads failed');

  const manifest = {
    bookId,
    generatedAt: new Date().toISOString(),
    poses: poseUrls,
    atlasType: 'grid-sliced',
  };
  const manifestUrl = await uploadBuffer(
    Buffer.from(JSON.stringify(manifest, null, 2)),
    `game-characters/${bookId}/manifest.json`,
    'application/json',
  );

  const tookMs = Date.now() - startMs;
  console.log(`[gameCharacter] Done in ${tookMs}ms (${Object.keys(poseUrls).length} poses)`);

  return {
    gameSpriteUrl: poseUrls.idle,
    gamePoseAtlasUrl: manifestUrl,
    poses: poseUrls,
    tookMs,
  };
}

// ── Fallback sequential path (kept minimal) ──
async function generateSequential({ apiKey, refs, childDetails, style }) {
  const session = { apiKey, model: GEMINI_IMAGE_MODEL, history: [] };

  // Establishment turn
  const parts = [];
  for (const ref of refs) {
    parts.push({ text: ref.label });
    parts.push({ inline_data: { mimeType: ref.mime || 'image/jpeg', data: ref.base64 } });
  }
  parts.push({ text: 'Study these references. You will generate 6 character pose sprites on pure white, keeping identity and style consistent. Acknowledge with text only.' });

  const estUrl = `${CHAT_API_BASE}/${session.model}:generateContent?key=${session.apiKey}`;
  session.history.push({ role: 'user', parts });
  const estResp = await fetchWithTimeout(estUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: session.history, generationConfig: { responseModalities: ['TEXT'] } }),
  }, 30000);
  if (!estResp.ok) {
    session.history.pop();
    throw new Error(`Sequential establish ${estResp.status}`);
  }
  const estData = await estResp.json();
  const estParts = estData?.candidates?.[0]?.content?.parts || [];
  if (estParts.length) session.history.push({ role: 'model', parts: estParts });
  else session.history.pop();

  const poseLines = {
    idle:  'IDLE: standing relaxed, arms at sides, soft smile, eyes open.',
    walk:  'WALK: mid-stride walking, opposite arm/leg swing, happy smile.',
    jump:  'JUMP: airborne with knees tucked and arms up in a V, joyful smile.',
    eat:   'EAT: holding food with both hands near mouth, eyes closed, cheeks puffed.',
    sleep: 'SLEEP: eyes closed, head tilted on hands pressed to cheek, peaceful.',
    cheer: 'CHEER: arms thrown up in a V, wide open-mouth smile, feet apart.',
  };

  const results = {};
  for (const pose of POSES) {
    try {
      const p = [
        `Generate a clean full-body ${pose.toUpperCase()} pose sprite of the same character on pure white background.`,
        poseLines[pose],
        `CRITICAL: square frame, character centered, feet at bottom, no shadows, no text, no props, SAME identity and body proportions as prior images.`,
        `Style: ${style || 'pixar_premium'}.`,
      ].join('\n');
      const buf = await sendTurn(session, [{ text: p }]);
      results[pose] = await softChromakeyWhiteToTransparent(buf);
    } catch (e) {
      console.warn(`[gameCharacter/sequential] pose ${pose} failed: ${e.message}`);
      if (results.idle) results[pose] = results.idle;
    }
  }
  if (Object.keys(results).length === 0) throw new Error('All sequential poses failed');
  return results;
}

async function sendTurn(session, userParts) {
  const url = `${CHAT_API_BASE}/${session.model}:generateContent?key=${session.apiKey}`;
  session.history.push({ role: 'user', parts: userParts });
  const body = {
    contents: session.history,
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '1:1' },
    },
  };
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 90000);
  if (!resp.ok) {
    session.history.pop();
    throw new Error(`Turn ${resp.status}: ${await resp.text().catch(() => '')}`);
  }
  const data = await resp.json();
  const mp = data?.candidates?.[0]?.content?.parts || [];
  if (mp.length) {
    const preserved = mp.map(p => {
      const o = {};
      if (p.text !== undefined) o.text = p.text;
      if (p.inlineData) o.inlineData = p.inlineData;
      if (p.inline_data) o.inlineData = p.inline_data;
      if (p.thoughtSignature !== undefined) o.thoughtSignature = p.thoughtSignature;
      return o;
    });
    session.history.push({ role: 'model', parts: preserved });
  } else session.history.pop();

  if (session.history.length > 14) {
    session.history = [...session.history.slice(0, 2), ...session.history.slice(-10)];
  }

  const imgPart = mp.find(p => p.inlineData || p.inline_data);
  const b64 = imgPart?.inlineData?.data || imgPart?.inline_data?.data;
  if (!b64) throw new Error('No image in response');
  return Buffer.from(b64, 'base64');
}

module.exports = { generateGameCharacter, POSES };
