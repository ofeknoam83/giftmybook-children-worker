/**
 * Game Pose Animations (M5).
 *
 * Generates 2×2 frame-grids for three animation cycles: walk, jump, cheer.
 * Each grid is a single Gemini image containing 4 evenly-spaced keyframes of
 * that animation, which we then slice into individual PNGs and upload to GCS.
 *
 * Layout per grid (left→right, top→bottom):
 *   walk:  [stride-A] [contact-R] [stride-B] [contact-L]     (2-beat loop)
 *   jump:  [crouch]   [takeoff]   [apex]     [land]           (one-shot)
 *   cheer: [rise-1]   [rise-2]    [peak]     [settle]         (one-shot)
 *
 * Output manifest:
 *   {
 *     bookId,
 *     generatedAt,
 *     anims: {
 *       walk:  { frames: [url, url, url, url], fps: 8, loop: true },
 *       jump:  { frames: [url, url, url, url], fps: 10, loop: false },
 *       cheer: { frames: [url, url, url, url], fps: 8, loop: false },
 *     }
 *   }
 *
 * Why grids: a single image per animation is ~4× faster and costs ~4× less
 * than generating 4 sequential frames, and (crucially) the model keeps the
 * character's silhouette consistent across frames in the same image.
 */

const sharp = require('sharp');
const { GEMINI_IMAGE_MODEL, CHAT_API_BASE } = require('./illustrator/config');
const { fetchWithTimeout, downloadPhotoAsBase64 } = require('./illustrationGenerator');
const { uploadBuffer } = require('./gcsStorage');

const ANIMS = {
  walk:  { frames: ['stride-A', 'contact-R', 'stride-B', 'contact-L'], fps: 8,  loop: true },
  jump:  { frames: ['crouch',   'takeoff',   'apex',     'land'],       fps: 10, loop: false },
  cheer: { frames: ['rise-1',   'rise-2',    'peak',     'settle'],     fps: 8,  loop: false },
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

function animPrompt(anim, frameLabels, childDetails, style) {
  const name = childDetails?.name || 'the child';

  const base = [
    `Generate a 2×2 ANIMATION FRAME SHEET of the SAME character "${name}" for a children's game.`,
    `Animation: ${anim.toUpperCase()}.`,
    'Character identity and style MUST match the reference images exactly — same face, skin tone, hair, clothing, outline style.',
    '',
    'LAYOUT (critical — must follow exactly):',
    'The output image is a 2-row × 2-column grid with thin white gutters separating 4 equal cells.',
    `Top row (left→right): [${frameLabels[0]}] [${frameLabels[1]}]`,
    `Bottom row (left→right): [${frameLabels[2]}] [${frameLabels[3]}]`,
    '',
    'CHARACTER POSITIONING (critical — must be identical across all 4 cells):',
    '- Same character appears in all 4 cells at the same size and vertical position.',
    '- Feet baseline is the same in each cell (except for JUMP apex where the character is airborne).',
    '- ONLY the pose/action changes between frames; head size, body proportions, clothing, hair length do NOT change.',
    '- No ground, no props, no shadow.',
  ];

  const perAnim = {
    walk: [
      '',
      'WALK CYCLE (16 px between frames of travel; loops 1↔4):',
      '- stride-A: left foot planted, right foot lifted and swinging forward; arms swing opposite to legs; soft smile.',
      '- contact-R: both feet nearly touching ground, right foot planting; body slightly compressed.',
      '- stride-B: mirror of stride-A — right foot planted, left foot lifted forward.',
      '- contact-L: mirror of contact-R — left foot planting.',
      'The cycle loops, so stride-A must be mirrorable/matchable to contact-L returning to it.',
    ],
    jump: [
      '',
      'JUMP (one-shot, frame 1→4 plays then holds on settle-frame idle):',
      '- crouch: knees bent deeply, arms back, body low to ground, looking forward.',
      '- takeoff: legs extending, pushing off the ground, arms starting to swing up.',
      '- apex: airborne, both feet off the ground, knees tucked, arms in a V above head, open-mouth smile.',
      '- land: feet just touched down, knees bent absorbing, arms at sides.',
    ],
    cheer: [
      '',
      'CHEER (one-shot; ends in the held peak):',
      '- rise-1: arms moving up from sides, small smile, one foot slightly raised.',
      '- rise-2: arms higher (near shoulders), open-mouth smile starting.',
      '- peak: arms fully raised in a V above head, open-mouth joyful smile, eyes sparkling, both feet slightly off ground.',
      '- settle: arms coming down slightly, smile soft, feet back on ground — so the anim resolves gracefully into idle.',
    ],
  };

  return [
    ...base,
    ...(perAnim[anim] || []),
    '',
    'BACKGROUND (critical):',
    '- Pure white (#FFFFFF) fill everywhere — inside cells, gutters, and borders.',
    '- NO text, NO labels, NO numbers, NO borders visible as ink — just white gutters between cells.',
    '- NO props, shadows, gradients, or textures.',
    '',
    'RENDERING:',
    '- Match the reference illustration style (color, line weight, rendering).',
    '- Soft 2-3 px outer outline around the character for a sticker-sheet feel.',
    `- Style: ${style || 'pixar_premium'}.`,
    '',
    'Output: ONE single image containing the 2×2 grid. Do NOT output 4 separate images. Do NOT include any text annotations.',
  ].join('\n');
}

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
      imageConfig: { aspectRatio: '1:1' }, // 2×2 square
    },
  };

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 90000);

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Anim Gemini ${resp.status}: ${t.slice(0, 300)}`);
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

async function sliceGrid2x2(inputBuffer) {
  const img = sharp(inputBuffer);
  const meta = await img.metadata();
  const { width, height } = meta;
  if (!width || !height) throw new Error('Could not read anim grid dimensions');

  const cellW = Math.floor(width / 2);
  const cellH = Math.floor(height / 2);
  const out = [];
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      const buf = await sharp(inputBuffer)
        .extract({ left: col * cellW, top: row * cellH, width: cellW, height: cellH })
        .toBuffer();
      out.push(buf);
    }
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

async function collectRefs({ characterRefUrl, coverImageUrl, childPhotoUrl, idlePoseUrl }) {
  const refs = [];
  // Prefer the already-generated IDLE pose as the identity anchor — it makes
  // animation frames silhouette-identical to the rig's base pose.
  if (idlePoseUrl) {
    try {
      const r = await downloadPhotoAsBase64(idlePoseUrl);
      refs.push({ label: 'IDLE POSE (identity + style anchor — character must match this exactly):', base64: r.base64, mime: r.mimeType || 'image/png' });
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

async function generateOneAnim({ animName, refs, childDetails, style, bookId }) {
  const apiKey = pickApiKey();
  const config = ANIMS[animName];
  const prompt = animPrompt(animName, config.frames, childDetails, style);

  const gridRaw = await callGeminiGrid({ apiKey, prompt, refs });
  const cells = await sliceGrid2x2(gridRaw);

  const keyedFrames = [];
  let totalFill = 0;
  for (const cell of cells) {
    const keyed = await softChromakeyWhiteToTransparent(cell);
    keyedFrames.push(keyed);
    totalFill += await cellFill(keyed);
  }
  const avgFill = totalFill / cells.length;
  if (avgFill < 0.04) {
    throw new Error(`Anim ${animName} grid looks empty (avgFill=${avgFill.toFixed(3)})`);
  }

  const frameUrls = [];
  for (let i = 0; i < keyedFrames.length; i++) {
    const path = `game-characters/${bookId}/anims/${animName}/frame-${i}.png`;
    const url = await uploadBuffer(keyedFrames[i], path, 'image/png');
    frameUrls.push(url);
  }

  return { name: animName, frames: frameUrls, fps: config.fps, loop: config.loop };
}

/**
 * Main entry — generate all animation grids for a book.
 *
 * Input:
 *   { bookId, characterRefUrl?, coverImageUrl?, childPhotoUrl?, idlePoseUrl?,
 *     style?, childDetails?, anims? (default: ['walk','jump','cheer']) }
 *
 * Output:
 *   { anims: {name: {frames, fps, loop}}, manifestUrl, tookMs }
 */
async function generateGamePoseAnims(input) {
  const startMs = Date.now();
  const {
    bookId,
    characterRefUrl,
    coverImageUrl,
    childPhotoUrl,
    idlePoseUrl,
    style,
    childDetails,
    anims = ['walk', 'jump', 'cheer'],
  } = input || {};

  if (!bookId) throw new Error('bookId is required');
  const wanted = anims.filter((a) => ANIMS[a]);
  if (wanted.length === 0) throw new Error('No valid anims requested');

  const refs = await collectRefs({ characterRefUrl, coverImageUrl, childPhotoUrl, idlePoseUrl });
  if (refs.length === 0) throw new Error('Could not download any reference image');

  console.log(`[gamePoseAnims] Generating anims ${wanted.join(', ')} for book ${bookId}`);

  // Run the 3 anims in parallel; each is an independent Gemini call.
  const results = await Promise.allSettled(
    wanted.map((a) => generateOneAnim({ animName: a, refs, childDetails, style, bookId })),
  );

  const animsOut = {};
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const name = wanted[i];
    if (r.status === 'fulfilled') {
      animsOut[name] = { frames: r.value.frames, fps: r.value.fps, loop: r.value.loop };
    } else {
      console.warn(`[gamePoseAnims] ${name} failed: ${r.reason?.message || r.reason}`);
    }
  }

  if (Object.keys(animsOut).length === 0) {
    throw new Error('All animation generations failed');
  }

  const manifest = {
    bookId,
    generatedAt: new Date().toISOString(),
    anims: animsOut,
  };
  const manifestUrl = await uploadBuffer(
    Buffer.from(JSON.stringify(manifest, null, 2)),
    `game-characters/${bookId}/anims/manifest.json`,
    'application/json',
  );

  const tookMs = Date.now() - startMs;
  console.log(`[gamePoseAnims] Done in ${tookMs}ms (${Object.keys(animsOut).length} anims)`);

  return { anims: animsOut, manifestUrl, tookMs };
}

module.exports = { generateGamePoseAnims, ANIMS };
