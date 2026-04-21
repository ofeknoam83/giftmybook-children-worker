/**
 * Game Character Asset Pipeline — grid-sheet mode.
 *
 * PRIMARY PATH: one Gemini call produces a 4×3 grid of all twelve poses at once,
 * then sharp slices it. This keeps character silhouette/proportions IDENTICAL
 * across poses (critical for clean crossfade) AND cuts latency ~12×
 * vs. sequential generation.
 *
 * FALLBACK PATH: if the grid doesn't produce a usable image (refused, wrong
 * shape, near-empty cells), fall back to the sequential chat-session approach.
 *
 * Output: twelve transparent-background PNGs + manifest on GCS, per-book.
 *
 * Poses:
 *   [idle    walk_a  walk_b]
 *   [jump    eat     sleep ]
 *   [cheer   wave    sit   ]
 *   [read    dance   surprise]
 *
 * We use walk_a / walk_b so HouseScene can alternate them every ~220ms to
 * produce a lively walk cycle without a separate flipbook.
 */

const sharp = require('sharp');
const { GEMINI_IMAGE_MODEL, CHAT_API_BASE } = require('./illustrator/config');
const { fetchWithTimeout, downloadPhotoAsBase64 } = require('./illustrationGenerator');
const { uploadBuffer } = require('./gcsStorage');

const POSES = [
  'idle', 'walk_a', 'walk_b',
  'jump', 'eat',    'sleep',
  'cheer','wave',   'sit',
  'read', 'dance',  'surprise',
];
const GRID_COLS = 3;
const GRID_ROWS = 4;

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
    `Generate a 4-row × 3-column POSE SHEET of the SAME character "${name}" for a children's game.`,
    ageLine,
    `The character MUST match the identity shown in the reference images exactly — same face, skin tone, hair, clothing, style.`,
    '',
    'LAYOUT (critical — must follow exactly):',
    'The output image is a 4-row × 3-column grid with thin WHITE gutters separating 12 equal cells.',
    'Row 1 (left→right): [IDLE] [WALK-A] [WALK-B]',
    'Row 2 (left→right): [JUMP] [EAT] [SLEEP]',
    'Row 3 (left→right): [CHEER] [WAVE] [SIT]',
    'Row 4 (left→right): [READ] [DANCE] [SURPRISE]',
    '',
    'CHARACTER POSITIONING (critical — must be identical across cells):',
    '- The same character appears in all 12 cells, same size, same facing direction.',
    '- Feet (or body base for SIT) near the bottom of each cell at the same vertical position.',
    '- Head at the same height in each cell.',
    '- Same body proportions in each cell — ONLY the pose changes.',
    '- Absolutely no ground shadow, no floor line, no props outside the character.',
    '',
    'POSES (each cell must show EXACTLY this pose and nothing else):',
    '- IDLE: standing relaxed, arms at sides, soft smile, open bright eyes, facing forward.',
    '- WALK-A: mid-stride, LEFT foot forward on ground, right foot lifting behind; RIGHT arm forward, LEFT arm back; happy smile.',
    '- WALK-B: opposite stride — RIGHT foot forward on ground, left foot lifting behind; LEFT arm forward, RIGHT arm back; happy smile. Must be clearly different from WALK-A.',
    '- JUMP: airborne with both feet off ground, knees bent and tucked, arms raised in a V; open-mouth smile; head tilted slightly back.',
    '- EAT: holding a small piece of food with both hands near the mouth, eyes closed happily, cheeks lightly puffed.',
    '- SLEEP: standing upright but with eyes closed, head tilted to one side resting on palm-to-palm hands pressed to cheek; peaceful smile.',
    '- CHEER: arms thrown up high in a V, open-mouth joyful smile, eyes sparkling; feet slightly apart.',
    '- WAVE: standing, right arm raised high waving hello, left arm relaxed at side, big friendly smile.',
    '- SIT: sitting cross-legged on the ground (feet-position represents the ground), hands resting on knees, calm smile, facing forward.',
    '- READ: standing holding an open small book in both hands in front of chest, looking down at the book, gentle smile.',
    '- DANCE: one foot lifted in a playful dance step, arms swinging asymmetrically (one up, one out), joyful open-mouth smile.',
    '- SURPRISE: standing wide-eyed with both hands near cheeks, open round mouth in an "oh!" expression.',
    '',
    'BACKGROUND (ABSOLUTELY CRITICAL — we will chromakey this out):',
    '- Fill every pixel that is NOT the character with pure flat white (#FFFFFF).',
    '- No off-white, no cream, no pale grey, no gradient, no texture, no pattern, no vignette.',
    '- No ground plate, no shadow plate, no drop shadow, no rim glow.',
    '- No props, no floor line, no wall behind the character.',
    '- Gutters between cells are also pure white.',
    '- The image must look like it was composited onto a white sheet — crisp character edges against flat white.',
    '',
    'EDGES (critical for clean matting):',
    '- Sharp, well-defined character edges.',
    '- No anti-aliased halo where character meets white — keep edges crisp.',
    '- Do NOT draw an outer glow or soft fade around the character.',
    '',
    'TEXT / DECOR (absolute rules):',
    '- NO text, letters, labels, numbers, borders, logos, cell dividers, or watermark ANYWHERE.',
    '- Just the 12 characters on pure white.',
    '',
    'RENDERING:',
    '- Same illustrated style as the reference images (color, line weight, rendering).',
    '- Soft 2-3px outer INK outline around each character for a sticker-sheet feel (not a glow).',
    `- Style: ${style || 'pixar_premium'}.`,
    '',
    'Output: ONE single image containing the 4×3 grid. Do NOT output separate images. Do NOT include any text annotations.',
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
 * Luminance chromakey — pure white / near-white to transparent.
 *
 * Tightened for the full-body pose pipeline: thresholds are aggressive so any
 * model-produced haze ends up fully alpha=0 rather than the leaky-grey fringe
 * that used to bleed through (producing the visible bounding boxes around
 * parts). Followed by an alpha bbox trim in `trimToAlpha` below.
 */
async function softChromakeyWhiteToTransparent(inputBuffer) {
  const img = sharp(inputBuffer).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (channels < 3) return inputBuffer;

  const pxCount = width * height;
  const out = Buffer.alloc(pxCount * 4);
  // Aggressive thresholds — anything brighter than LOW fades fast and anything
  // above HIGH is fully transparent. We also require the channels to be close
  // to each other (desaturated) so coloured shirts near white don't vanish.
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
    // Only treat as background if it's BOTH near white AND desaturated.
    const whitish = minC >= LOW && spread <= CHANNEL_SPREAD;
    if (!whitish) {
      alpha = 255;
    } else if (minC >= HIGH) {
      alpha = 0;
    } else {
      // Smooth fade in the LOW..HIGH band.
      alpha = Math.round(255 * (HIGH - minC) / (HIGH - LOW));
    }

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
 * Alpha-trim a cell to the tight bounding box of its opaque pixels, plus an
 * 8px safety pad. This eliminates the phantom "cell size" halo where the cell
 * has transparent borders that still participate in layout / shadow math on
 * the client.
 */
async function trimToAlpha(inputBuffer, pad = 8) {
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
    if (maxX < 0) return inputBuffer; // fully transparent — don't crop
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
      // 3 cols × 4 rows — 3:4 portrait keeps each cell reasonably square.
      imageConfig: { aspectRatio: '3:4' },
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
      totalFill += await cellFill(keyed);
      keyedCells[name] = await trimToAlpha(keyed, 8);
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
    idle:     'IDLE: standing relaxed, arms at sides, soft smile, eyes open.',
    walk_a:   'WALK-A: mid-stride, LEFT foot forward on ground, right foot lifting; RIGHT arm forward, LEFT arm back; happy smile.',
    walk_b:   'WALK-B: opposite stride — RIGHT foot forward on ground, left foot lifting; LEFT arm forward, RIGHT arm back; happy smile.',
    jump:     'JUMP: airborne with knees tucked and arms up in a V, joyful smile.',
    eat:      'EAT: holding food with both hands near mouth, eyes closed, cheeks puffed.',
    sleep:    'SLEEP: eyes closed, head tilted on hands pressed to cheek, peaceful.',
    cheer:    'CHEER: arms thrown up in a V, wide open-mouth smile, feet apart.',
    wave:     'WAVE: right arm raised high waving hello, left arm relaxed, big friendly smile.',
    sit:      'SIT: sitting cross-legged on the ground, hands on knees, calm smile, facing forward.',
    read:     'READ: standing holding an open small book in both hands at chest, looking down at it, gentle smile.',
    dance:    'DANCE: one foot lifted in a playful dance step, arms asymmetric (one up one out), joyful open-mouth smile.',
    surprise: 'SURPRISE: wide eyes, both hands near cheeks, round open mouth in "oh!" expression.',
  };

  const results = {};
  for (const pose of POSES) {
    try {
      const p = [
        `Generate a clean full-body ${pose.toUpperCase()} pose sprite of the same character on PURE FLAT WHITE (#FFFFFF) background.`,
        poseLines[pose],
        'CRITICAL:',
        '- Every non-character pixel must be pure white #FFFFFF — no gradient, no off-white, no shadow plate, no ground line.',
        '- Square frame, character centered, feet (or sit-base) at bottom.',
        '- No text, no props, no floor.',
        '- Crisp character edges (soft 2-3px ink outline only).',
        '- SAME identity and body proportions as prior images.',
        `Style: ${style || 'pixar_premium'}.`,
      ].join('\n');
      const buf = await sendTurn(session, [{ text: p }]);
      const keyed = await softChromakeyWhiteToTransparent(buf);
      results[pose] = await trimToAlpha(keyed, 8);
    } catch (e) {
      console.warn(`[gameCharacter/sequential] pose ${pose} failed: ${e.message}`);
      if (results.idle) results[pose] = results.idle;
    }
  }
  if (Object.keys(results).length === 0) throw new Error('All sequential poses failed');
  // Guarantee walk_a exists so the client walk cycle has at least one frame.
  if (!results.walk_a && results.idle) results.walk_a = results.idle;
  if (!results.walk_b && results.walk_a) results.walk_b = results.walk_a;
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

/**
 * Generate a tight circular face-disc crop of the child reference, with the
 * background chromakeyed out. Used by the Rive rig as a face overlay so the
 * AI-generated identity rides on top of the vector body.
 *
 * Input:
 *   - characterRefUrl OR childPhotoUrl (we prefer characterRefUrl — it's
 *     already stylised to match the book).
 *   - bookId (for GCS path).
 *
 * Output:
 *   - { faceUrl, size }  — 256×256 transparent PNG on GCS.
 */
async function generateCharacterFace({ bookId, characterRefUrl, childPhotoUrl, coverImageUrl, style, childDetails }) {
  if (!bookId) throw new Error('bookId is required');
  const sourceUrl = characterRefUrl || childPhotoUrl || coverImageUrl;
  if (!sourceUrl) throw new Error('characterRefUrl or childPhotoUrl is required');

  const apiKey = pickApiKey();
  const refs = await collectRefs({ characterRefUrl, coverImageUrl, childPhotoUrl });
  if (refs.length === 0) throw new Error('Could not download any reference image');

  const name = childDetails?.name || 'the child';
  const facePrompt = [
    `Generate a SINGLE head-and-shoulders portrait of the same character "${name}" from the reference images.`,
    'Same identity (face, skin tone, eyes, hair, expression) — match exactly.',
    '',
    'COMPOSITION (critical):',
    '- Tight head-and-shoulders crop, face centred in the frame.',
    '- The top of the hair is ~10% from the top edge.',
    '- The chin is ~60% from the top (so the whole face fits a face disc).',
    '- Character facing the camera, soft warm smile, both eyes visible.',
    '',
    'BACKGROUND (ABSOLUTELY CRITICAL — we will chromakey this out):',
    '- Every non-character pixel is pure flat white (#FFFFFF).',
    '- No gradient, no off-white, no shadow, no rim-light.',
    '- Crisp character edges with no outer halo.',
    '',
    `Style: ${style || 'pixar_premium'}, same illustrated style as the references.`,
    'Output: ONE portrait image only. No text, no watermark, no border.',
  ].join('\n');

  let imgBuf;
  try {
    imgBuf = await callGeminiGrid({ apiKey, prompt: facePrompt, refs });
  } catch (err) {
    throw new Error(`Face portrait generation failed: ${err.message}`);
  }

  const keyed = await softChromakeyWhiteToTransparent(imgBuf);
  const trimmed = await trimToAlpha(keyed, 12);

  const DISC_SIZE = 256;
  const metadata = await sharp(trimmed).metadata();
  const srcW = metadata.width || DISC_SIZE;
  const srcH = metadata.height || DISC_SIZE;
  const side = Math.min(srcW, srcH);
  const left = Math.max(0, Math.floor((srcW - side) / 2));
  const top = Math.max(0, Math.floor((srcH - side) / 3));
  const square = await sharp(trimmed)
    .extract({ left, top, width: Math.min(side, srcW - left), height: Math.min(side, srcH - top) })
    .resize(DISC_SIZE, DISC_SIZE, { fit: 'cover' })
    .toBuffer();

  const discMask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${DISC_SIZE}" height="${DISC_SIZE}">` +
      `<circle cx="${DISC_SIZE / 2}" cy="${DISC_SIZE / 2}" r="${DISC_SIZE / 2 - 2}" fill="#fff"/>` +
    `</svg>`
  );
  const discPng = await sharp(square)
    .composite([{ input: discMask, blend: 'dest-in' }])
    .png({ compressionLevel: 9 })
    .toBuffer();

  const faceUrl = await uploadBuffer(
    discPng,
    `game-characters/${bookId}/face-disc.png`,
    'image/png'
  );

  return { faceUrl, size: DISC_SIZE };
}

module.exports = { generateGameCharacter, generateCharacterFace, POSES };
