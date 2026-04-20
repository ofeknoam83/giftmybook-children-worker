/**
 * Step Into Your Story — game asset builder
 *
 * For a completed children's book, produce:
 *   1. Hero sprite sheet: 8 poses in the book's art style, 2048x1024 PNG + JSON atlas.
 *      Reuses the existing illustration chat session so the hero matches the book exactly.
 *   2. Narration audio: splash + per-chapter MP3 files via Gemini TTS.
 *   3. Compressed chapter backgrounds: 1600w WebP per spread (mobile-friendly).
 *
 * All uploaded to GCS under `games/<bookId>/`. Standalone is called back via
 * <callbackUrl> with the signed URLs.
 */

const sharp = require('sharp');
const { uploadBuffer, getSignedUrl, downloadBuffer } = require('./gcsStorage');
// Node 18+ has global fetch

// 8 hero poses — matches the atlas keys the client expects
const POSES = [
  { key: 'idle',    prompt: 'standing at ease, smiling, arms relaxed, looking forward' },
  { key: 'run',     prompt: 'running energetically to the right, one leg forward, arms pumping' },
  { key: 'jump',    prompt: 'mid-jump with knees bent, arms up in excitement, joyful expression' },
  { key: 'cheer',   prompt: 'arms raised in victory with both hands up, big smile, celebrating' },
  { key: 'wave',    prompt: 'waving hello with right hand up, warm friendly smile' },
  { key: 'think',   prompt: 'finger on chin, looking up curiously, thoughtful expression' },
  { key: 'sad',     prompt: 'slight frown, hands clasped in front, looking down softly, gentle not dramatic' },
  { key: 'victory', prompt: 'standing tall arms wide open, proud happy expression, confident pose' },
];

const SPRITE_SIZE = 512;               // each pose tile
const SPRITE_COLS = 4;
const SPRITE_ROWS = 2;                 // 4x2 = 8 poses
const SHEET_W = SPRITE_SIZE * SPRITE_COLS;  // 2048
const SHEET_H = SPRITE_SIZE * SPRITE_ROWS;  // 1024

/**
 * Main entry — called by /build-game endpoint.
 * Returns { spriteSheetUrl, atlas, narration, backgrounds, builtAt }.
 */
async function buildGameAssets({
  bookId, slug, childName, title, artStyle,
  characterRefUrl, spreads, storyBeats,
  apiKeys,
}) {
  const t0 = Date.now();
  console.log(`[gameBuilder] START bookId=${bookId} slug=${slug} poses=${POSES.length} spreads=${spreads.length}`);

  // ── Run sprite sheet + background compression in parallel ──
  const [spriteResult, backgrounds, narration] = await Promise.all([
    buildSpriteSheet({ bookId, childName, artStyle, characterRefUrl, apiKeys }),
    compressBackgrounds({ bookId, spreads }),
    buildNarration({ bookId, childName, title, storyBeats, apiKeys }),
  ]);

  const result = {
    spriteSheetUrl: spriteResult.spriteSheetUrl,
    atlas: spriteResult.atlas,
    backgrounds,
    narration,
    builtAt: new Date().toISOString(),
    buildMs: Date.now() - t0,
  };
  console.log(`[gameBuilder] DONE bookId=${bookId} in ${result.buildMs}ms`);
  return result;
}

// ─── Sprite sheet ────────────────────────────────────────────
async function buildSpriteSheet({ bookId, childName, artStyle, characterRefUrl, apiKeys }) {
  // We try to reuse illustrationChatSession so the character matches the book.
  // If unavailable, fall back to direct Gemini image calls with the character ref.
  const { createIllustrationSession, generateSpreadInSession, establishCharacter } = require('./illustrationChatSession');

  const session = await createSessionWithRef({
    childName, artStyle, characterRefUrl, apiKeys, bookId,
    createIllustrationSession, establishCharacter,
  });

  const tiles = {};
  for (const pose of POSES) {
    try {
      const prompt = buildPosePrompt({ childName, pose });
      const buf = await generatePoseImage({ session, prompt, pose, bookId, generateSpreadInSession });
      // Normalize to square 512x512 transparent PNG
      const normalized = await sharp(buf)
        .resize(SPRITE_SIZE, SPRITE_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      tiles[pose.key] = normalized;
      console.log(`[gameBuilder] pose ${pose.key} rendered (${normalized.length} bytes)`);
    } catch (err) {
      console.warn(`[gameBuilder] pose ${pose.key} failed: ${err.message} — using placeholder`);
      tiles[pose.key] = await placeholderTile(pose.key);
    }
  }

  // Composite into a 2048x1024 sheet (4 cols x 2 rows)
  const atlas = {};
  const composites = POSES.map((pose, idx) => {
    const col = idx % SPRITE_COLS;
    const row = Math.floor(idx / SPRITE_COLS);
    const x = col * SPRITE_SIZE;
    const y = row * SPRITE_SIZE;
    atlas[pose.key] = { x, y, w: SPRITE_SIZE, h: SPRITE_SIZE };
    return { input: tiles[pose.key], left: x, top: y };
  });

  const sheet = await sharp({
    create: { width: SHEET_W, height: SHEET_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite(composites).png().toBuffer();

  const destPath = `games/${bookId}/sprite-sheet.png`;
  await uploadBuffer(sheet, destPath, 'image/png');
  const spriteSheetUrl = await getSignedUrl(destPath, 7 * 24 * 3600 * 1000);
  return { spriteSheetUrl, atlas };
}

async function createSessionWithRef({ childName, artStyle, characterRefUrl, apiKeys, bookId, createIllustrationSession, establishCharacter }) {
  try {
    const charRefBuffer = await downloadBuffer(characterRefUrl);
    const session = createIllustrationSession({
      bookId,
      childName,
      style: artStyle || 'pixar_premium',
      apiKey: apiKeys && apiKeys[0],
      // Use the rendered cover as the style ref for the chat session
      coverBase64: charRefBuffer.toString('base64'),
      coverMime: 'image/png',
    });
    await establishCharacter(session);
    return session;
  } catch (err) {
    console.warn(`[gameBuilder] chat session init failed: ${err.message} — using direct mode`);
    return { direct: true, characterRefUrl, artStyle, apiKeys };
  }
}

function buildPosePrompt({ childName, pose }) {
  return [
    `A full-body illustration of ${childName || 'the main character'}, the SAME character established earlier.`,
    `POSE: ${pose.prompt}.`,
    `Render on a pure transparent background (no scenery, no shadow, no ground line).`,
    `Center the character in the frame with a small margin on all sides.`,
    `Keep the exact art style, facial features, hair, skin tone, and outfit consistent with the reference.`,
    `Output a single square image.`,
  ].join(' ');
}

async function generatePoseImage({ session, prompt, pose, bookId, generateSpreadInSession }) {
  if (session.direct) {
    // Fallback: direct Gemini call with the character reference photo
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const key = (session.apiKeys && session.apiKeys[0]) || process.env.GEMINI_API_KEY;
    if (!key) throw new Error('No Gemini API key for direct pose generation');
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-image-preview' });
    const refBuf = await downloadBuffer(session.characterRefUrl);
    const b64 = refBuf.toString('base64');
    const result = await model.generateContent([
      { inlineData: { mimeType: 'image/png', data: b64 } },
      prompt,
    ]);
    const response = result.response;
    const parts = response.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData?.data) return Buffer.from(part.inlineData.data, 'base64');
    }
    throw new Error(`Direct Gemini returned no image for pose ${pose.key}`);
  }
  // Use the shared illustration chat session
  const { imageBuffer } = await generateSpreadInSession(session, prompt, { aspectRatio: '1:1', spreadIndex: -1, sceneSummary: `sprite-${pose.key}` });
  if (!imageBuffer) throw new Error(`chat session produced no image for ${pose.key}`);
  return imageBuffer;
}

async function placeholderTile(label) {
  // Last-resort: a solid translucent square with pose label, so the game still runs.
  const svg = Buffer.from(`<svg xmlns='http://www.w3.org/2000/svg' width='512' height='512'>
    <rect width='512' height='512' fill='#F26A5D' rx='64'/>
    <text x='50%' y='50%' text-anchor='middle' dominant-baseline='middle' font-family='sans-serif' font-size='42' fill='white'>${label}</text>
  </svg>`);
  return sharp(svg).png().toBuffer();
}

// ─── Narration (Gemini TTS) ──────────────────────────────────
async function buildNarration({ bookId, childName, title, storyBeats, apiKeys }) {
  const narration = { splash: null, chapters: [] };
  const firstName = (childName || 'friend').split(/\s+/)[0];
  const splashLine = `Hi ${firstName}! Ready to step into the world of ${title || 'your storybook'}? Let's go find some treasures!`;

  try {
    const splashMp3 = await synthesize(splashLine, { apiKeys });
    const splashPath = `games/${bookId}/narration/splash.mp3`;
    await uploadBuffer(splashMp3, splashPath, 'audio/mpeg');
    narration.splash = await getSignedUrl(splashPath, 7 * 24 * 3600 * 1000);
  } catch (err) {
    console.warn(`[gameBuilder] splash narration failed: ${err.message}`);
  }

  for (let i = 0; i < storyBeats.length; i++) {
    const beat = storyBeats[i]?.beat || `Chapter ${i + 1}. ${firstName}, your adventure continues!`;
    try {
      const line = shortenForTTS(beat, 240);
      const mp3 = await synthesize(line, { apiKeys });
      const dest = `games/${bookId}/narration/chapter-${i + 1}.mp3`;
      await uploadBuffer(mp3, dest, 'audio/mpeg');
      const url = await getSignedUrl(dest, 7 * 24 * 3600 * 1000);
      narration.chapters.push(url);
    } catch (err) {
      console.warn(`[gameBuilder] narration chapter ${i + 1} failed: ${err.message}`);
      narration.chapters.push(null);
    }
  }
  return narration;
}

function shortenForTTS(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).replace(/[,;:.]\s[^.]*$/, '') + '.';
}

/**
 * Gemini TTS — uses the text-to-speech REST endpoint.
 * If unavailable (preview model gated), returns a silent mp3 so the client can fall back
 * to browser SpeechSynthesis without breaking.
 */
async function synthesize(text, { apiKeys }) {
  const key = (apiKeys && apiKeys[0]) || process.env.GEMINI_API_KEY;
  if (!key) throw new Error('No Gemini API key for TTS');

  // Gemini TTS (preview): gemini-2.5-flash-preview-tts
  // See https://ai.google.dev/gemini-api/docs/speech-generation
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
      },
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: 60_000,
  });
  if (!res.ok) {
    const errTxt = await res.text().catch(() => '');
    throw new Error(`TTS HTTP ${res.status}: ${errTxt.slice(0, 200)}`);
  }
  const json = await res.json();
  const parts = json.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      // Gemini returns PCM audio as base64; wrap minimal WAV header so browsers can play it.
      // Convert to MP3 via sharp? — sharp only handles images. We ship as WAV (`audio/wav`) instead.
      const pcm = Buffer.from(part.inlineData.data, 'base64');
      return pcmToWav(pcm);
    }
  }
  throw new Error('TTS returned no audio');
}

/** Wrap raw 16-bit PCM (24000 Hz mono) in a WAV container. */
function pcmToWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const dataSize = pcm.length;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);              // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, 44);
  return buf;
}

// ─── Backgrounds (compress existing spreads) ────────────────
async function compressBackgrounds({ bookId, spreads }) {
  const out = [];
  for (let i = 0; i < spreads.length; i++) {
    const s = spreads[i];
    if (!s.imageUrl) { out.push(null); continue; }
    try {
      const srcBuf = await downloadBuffer(s.imageUrl);
      const webp = await sharp(srcBuf)
        .resize({ width: 1600, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      const dest = `games/${bookId}/backgrounds/chapter-${i + 1}.webp`;
      await uploadBuffer(webp, dest, 'image/webp');
      out.push(await getSignedUrl(dest, 7 * 24 * 3600 * 1000));
    } catch (err) {
      console.warn(`[gameBuilder] background ${i + 1} failed: ${err.message}`);
      out.push(null);
    }
  }
  return out;
}

module.exports = { buildGameAssets, POSES };
