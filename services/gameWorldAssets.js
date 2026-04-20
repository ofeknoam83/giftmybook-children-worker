/**
 * Game World Asset Pipeline
 *
 * Generates a book's world visual assets — one room background + a small set
 * of object sprites — in a SINGLE Gemini chat session seeded by the book's
 * cover/characterRef so everything shares the book's art style.
 *
 * Call with { bookId, room, objects } where:
 *   - room is a room id like "kitchen" | "bedroom" | "bathroom" | "playground"
 *   - objects is a string[] of object ids to generate (subset of SUPPORTED_OBJECTS)
 *
 * Output: GCS URLs keyed by asset name, plus a manifest.json.
 *
 * Cost: ~1 Gemini turn per asset (~6-12s). A typical kitchen = 1 BG + 8 objects
 * = 9 turns → ~60-90s, ~$0.50. Result is cached per (book, room) forever, so
 * it's a one-time cost per book+room.
 */

const sharp = require('sharp');
const { GEMINI_IMAGE_MODEL, CHAT_API_BASE } = require('./illustrator/config');
const { fetchWithTimeout, downloadPhotoAsBase64 } = require('./illustrationGenerator');
const { uploadBuffer } = require('./gcsStorage');

// ── Prompt library — each asset has a focused, composition-locked prompt. ──

const ROOM_PROMPTS = {
  kitchen: [
    'Illustrate a warm, bright, cozy children\'s book KITCHEN scene at daytime.',
    'Wide horizontal 16:9 composition. NO people, NO characters — empty room only.',
    'Include: wooden floor in foreground, cream walls, a window with soft sunlight,',
    'a stove, a fridge, counters with a couple of jars, a potted plant in the corner,',
    'picture frames on the wall. Everything is rounded, friendly, inviting.',
    'Color palette: warm creams, soft peach, buttery yellows, mint green, sky blue accents, warm wood brown.',
    'NO text anywhere. NO logos. NO foreground characters. Treat this as an empty stage the child will play on.',
  ].join(' '),

  bedroom: [
    'Illustrate a soft, cozy children\'s book BEDROOM scene at daytime.',
    'Wide horizontal 16:9 composition. NO people, NO characters — empty room only.',
    'Include: a small bed with plush pillow and blanket, nightstand, a window with curtains,',
    'some plush toys in the corner, a small rug, soft warm light.',
    'Color palette: soft pinks, cream, lavender, plum, mint green accents, cozy wood tones.',
    'NO text. NO logos. NO foreground characters.',
  ].join(' '),

  bathroom: [
    'Illustrate a bright, cheerful children\'s book BATHROOM scene at daytime.',
    'Wide horizontal 16:9 composition. NO people, NO characters — empty room only.',
    'Include: a bathtub with bubbles, a sink with a mirror, fluffy towels,',
    'a rubber duck on the edge of the tub, checkered floor tiles, a small window.',
    'Color palette: soft sky blue, white, butter yellow, coral pink accents.',
    'NO text. NO logos. NO foreground characters.',
  ].join(' '),

  playground: [
    'Illustrate a sunny, cheerful children\'s book PLAYGROUND scene.',
    'Wide horizontal 16:9 composition. NO people, NO characters — empty scene only.',
    'Include: bright blue sky with fluffy clouds, green rolling grass hills,',
    'a red/coral slide, a swing set, a wooden sandbox with sand, a friendly sun in the corner.',
    'Warm daytime light, cheerful vibe. No playground equipment in the immediate foreground.',
    'Color palette: sky blue, mint green, leaf green, butter yellow, soft coral, warm wood.',
    'NO text. NO logos. NO foreground characters.',
  ].join(' '),

  restaurant: [
    'Illustrate a warm, cozy children\'s book RESTAURANT interior.',
    'Wide horizontal 16:9 composition. NO people, NO characters — empty room only.',
    'Include: a wooden counter/bar on one side, small round tables, hanging pendant lamps with warm light,',
    'a window showing a leafy street view, checker-tiled floor, a plant in the corner.',
    'Homely, small-family-eatery feel (not luxurious). Warm evening-daytime light.',
    'Color palette: warm creams, wood brown, coral, butter yellow, sky blue accents.',
    'NO text, NO menu boards with readable letters, NO logos, NO foreground characters.',
  ].join(' '),
};

const OBJECT_PROMPTS = {
  apple:    'a single glossy red apple with a green leaf and brown stem',
  banana:   'a single ripe yellow banana slightly curved',
  bread:    'a friendly loaf of golden crusty bread',
  milk:     'a carton of milk with a cheerful blue label, shaped like a kid\'s milk carton',
  cupcake:  'a pink-frosted cupcake with sprinkles and a red cherry on top',
  juice:    'a tall glass of orange juice with a straw',
  ball:     'a bouncy mint-green ball with a single white stripe',
  teddy:    'a chubby brown plush teddy bear with a small red ribbon',
  pillow:   'a soft sky-blue pillow with a white heart embroidered on it',
  pot:      'a dark cooking pot with two handles and a subtle wooden lid knob',
  toothbrush: 'a kid-sized toothbrush in pink with soft bristles',
  duck:     'a bright yellow rubber ducky with an orange beak',
  book:     'a small picture book standing upright, friendly colorful cover, no readable text',
  moon:     'a friendly buttery-yellow crescent moon with two tiny white stars',
  // Playground
  shovel:   'a small kid\'s beach shovel with a blue scoop and red handle',
  // Restaurant
  plate:    'a white round dinner plate, empty, viewed from a 3/4 top angle',
  spoon:    'a cheerful silver soup spoon standing upright',
  chef_hat: 'a fluffy tall white chef\'s toque hat with a curved top',
  pizza:    'a small cheerful whole pizza pie with tomato sauce and cheese, no readable text',

  // ── Theme signature items (M1). Kept generic / wordless; match book style. ──
  // Mother's Day
  mothers_day_card: 'a folded greeting card with a big coral heart on the cover, pastel pink background, handmade feel, NO text',
  bouquet:          'a cheerful bouquet of assorted cartoon flowers (pink, yellow, peach) wrapped in paper',
  family_photo:     'a wooden framed photo-frame (picture side facing camera) showing a simple abstract silhouette of a family, no readable details',
  // Father's Day
  dad_mug:          'a light-blue coffee mug with a tiny red heart on the front, wisps of steam rising',
  tie:              'a classic neck-tie shape, navy-and-butter striped, lying flat',
  toolbox:          'a coral-red toolbox with a sturdy handle on top, closed lid, clean cartoon style',
  // Birthday
  birthday_cake:    'a small two-tier birthday cake, pink frosting, one lit candle on top, white frosting drips',
  present:          'a wrapped gift box with berry-colored paper and a butter-yellow ribbon with a big bow',
  party_hat:        'a cone party hat, coral with polka dots, pom-pom on the tip',
  balloon:          'a single coral-colored helium balloon with a short white string, slight highlight for volume',
  // Bedtime wonder
  storybook:        'an open storybook with soft illustrations (a star + a moon) on its pages, no readable letters',
  nightlight:       'a small children\'s nightlight lamp with a warm butter-yellow glow, cute star cut-out on the shade',
  teddy_special:    'a soft blue plush keepsake teddy bear with a yellow star embroidered on its tummy',
  // Adventure
  map:              'a rolled-out treasure map, aged cream paper, dashed path and a red X, NO readable text',
  compass:          'a wooden-ringed compass with a red/white needle pointing north, vintage friendly style',
  binoculars:       'a pair of kid\'s binoculars, berry-colored barrels with sky-blue eyepieces',
  // Learning / discovery
  magnifier:        'a cartoon magnifying glass with a wooden handle, light glint on the lens',
  globe:            'a small desk globe on a wooden stand, blue oceans with soft green continents',
  // Creative arts
  crayons:          'a neat row of five chunky crayons (pink, yellow, mint, sky-blue, berry) with paper labels',
  easel:            'a small child\'s wooden easel with a canvas showing a bright sun and a tree, no text',
  music_note:       'a single cheerful berry-colored eighth note with a rounded flag',
  // Friendship
  friendship_bracelet: 'a colorful beaded friendship bracelet in a loose circle, multi-colored beads on a coral string',
  letter:           'a cream envelope slightly opened, with a tiny coral heart wax seal, no readable text',
};

function framing(assetKind, assetDescription) {
  if (assetKind === 'room') {
    return [
      'CRITICAL: Wide 16:9 horizontal composition. Empty scene — NO people or characters.',
      'Match the art style of the reference images exactly (line weight, color palette, rendering).',
      'Illustrate all the way to the edges so the scene tiles as a full background.',
      'No text, letters, numbers, or logos anywhere.',
    ].join(' ');
  }
  // object
  return [
    'Generate a clean object sprite:',
    assetDescription,
    'CRITICAL COMPOSITION RULES:',
    '- Single object only, centered.',
    '- Square 1:1 frame. Object takes ~70% of frame, leaving margin on all sides.',
    '- Background: pure white (#FFFFFF) solid color. No shadows, no props, no gradient.',
    '- No text, letters, logos.',
    '- Soft outer outline for a sticker-sheet feel, 2-3px.',
    '- Same art style as the reference images.',
  ].join('\n');
}

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

async function sendTurn(session, userParts, aspectRatio) {
  const url = `${CHAT_API_BASE}/${session.model}:generateContent?key=${session.apiKey}`;
  session.history.push({ role: 'user', parts: userParts });

  const body = {
    contents: session.history,
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: aspectRatio ? { aspectRatio } : undefined,
    },
  };

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 90000);

  if (!resp.ok) {
    session.history.pop();
    const errText = await resp.text().catch(() => '');
    throw new Error(`Gemini ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  const modelParts = data?.candidates?.[0]?.content?.parts || [];

  if (modelParts.length > 0) {
    const preserved = modelParts.map(p => {
      const out = {};
      if (p.text !== undefined) out.text = p.text;
      if (p.inlineData) out.inlineData = p.inlineData;
      if (p.inline_data) out.inlineData = p.inline_data;
      if (p.thoughtSignature !== undefined) out.thoughtSignature = p.thoughtSignature;
      return out;
    });
    session.history.push({ role: 'model', parts: preserved });
  } else {
    session.history.pop();
  }

  // Trim session history to keep context manageable
  if (session.history.length > 14) {
    const head = session.history.slice(0, 2);
    const tail = session.history.slice(-10);
    session.history = [...head, ...tail];
  }

  const imgPart = modelParts.find(p => p.inlineData || p.inline_data);
  const b64 = imgPart?.inlineData?.data || imgPart?.inline_data?.data;
  if (!b64) {
    const textPart = modelParts.find(p => p.text)?.text || '';
    throw new Error(`Gemini returned no image. Text: "${textPart.slice(0, 200)}"`);
  }
  return Buffer.from(b64, 'base64');
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

async function establishSession(session, refs) {
  const parts = [];
  for (const ref of refs) {
    if (!ref || !ref.base64) continue;
    parts.push({ text: ref.label });
    parts.push({ inline_data: { mimeType: ref.mime || 'image/jpeg', data: ref.base64 } });
  }
  parts.push({
    text: 'These references establish the art style (color palette, line weight, rendering, mood) for a children\'s game world. Every image you generate in this session MUST match this style. Acknowledge with text only — do not generate an image yet.',
  });

  const url = `${CHAT_API_BASE}/${session.model}:generateContent?key=${session.apiKey}`;
  session.history.push({ role: 'user', parts });
  const body = {
    contents: session.history,
    generationConfig: { responseModalities: ['TEXT'] },
  };
  const resp = await fetchWithTimeout(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, 30000);
  if (!resp.ok) {
    session.history.pop();
    const t = await resp.text().catch(() => '');
    throw new Error(`Establish ${resp.status}: ${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  const modelParts = data?.candidates?.[0]?.content?.parts || [];
  if (modelParts.length > 0) {
    const preserved = modelParts.map(p => {
      const o = {};
      if (p.text !== undefined) o.text = p.text;
      if (p.thoughtSignature !== undefined) o.thoughtSignature = p.thoughtSignature;
      return o;
    });
    session.history.push({ role: 'model', parts: preserved });
  } else {
    session.history.pop();
  }
}

/**
 * Generate world assets for a single room. Returns urls + manifest.
 *
 * @param {object} input
 * @param {string} input.bookId
 * @param {string} input.room              - 'kitchen' | 'bedroom' | 'bathroom' | etc.
 * @param {string[]} [input.objects]       - object ids to generate; default: a sensible list per room
 * @param {string} [input.characterRefUrl] - style anchor
 * @param {string} [input.coverImageUrl]   - style anchor
 * @param {string} [input.style]
 * @returns {Promise<{roomBackgroundUrl, objects: {id: url}, manifestUrl, tookMs}>}
 */
async function generateWorldAssets(input) {
  const startMs = Date.now();
  const { bookId, room, objects, characterRefUrl, coverImageUrl, style } = input || {};

  if (!bookId) throw new Error('bookId is required');
  if (!room || !ROOM_PROMPTS[room]) throw new Error(`Unsupported room: ${room}`);
  const objectIds = Array.isArray(objects) && objects.length > 0
    ? objects.filter(id => OBJECT_PROMPTS[id])
    : defaultObjectsForRoom(room);

  const apiKey = pickApiKey();
  const session = { apiKey, model: GEMINI_IMAGE_MODEL, history: [] };

  // ── Collect references ──
  const refs = [];
  if (coverImageUrl) {
    try {
      const r = await downloadPhotoAsBase64(coverImageUrl);
      refs.push({ label: 'BOOK COVER (primary art style reference):', base64: r.base64, mime: r.mimeType || 'image/jpeg' });
    } catch (e) {
      console.warn(`[gameWorldAssets] Could not download cover: ${e.message}`);
    }
  }
  if (characterRefUrl && refs.length < 2) {
    try {
      const r = await downloadPhotoAsBase64(characterRefUrl);
      refs.push({ label: 'CHARACTER REFERENCE (art style + rendering):', base64: r.base64, mime: r.mimeType || 'image/png' });
    } catch (e) {
      console.warn(`[gameWorldAssets] Could not download characterRef: ${e.message}`);
    }
  }
  if (refs.length === 0) throw new Error('No reference images available for style locking');

  console.log(`[gameWorldAssets] Generating room=${room} + ${objectIds.length} objects for book ${bookId}`);

  await establishSession(session, refs);

  // ── Room background (16:9) ──
  let roomBackgroundUrl = null;
  try {
    const roomPrompt = [ROOM_PROMPTS[room], '', framing('room'), `Style: ${style || 'pixar_premium'}.`].join('\n');
    const bgImage = await sendTurn(session, [{ text: roomPrompt }], '16:9');
    const clean = await sharp(bgImage).png({ compressionLevel: 9 }).toBuffer();
    const path = `game-worlds/${bookId}/${room}/background.png`;
    roomBackgroundUrl = await uploadBuffer(clean, path, 'image/png');
    console.log(`[gameWorldAssets] Background done`);
  } catch (e) {
    console.warn(`[gameWorldAssets] Background failed: ${e.message}`);
  }

  // ── Objects (1:1 each) ──
  const objectUrls = {};
  for (const id of objectIds) {
    const t0 = Date.now();
    try {
      const prompt = [framing('object', OBJECT_PROMPTS[id]), `Style: ${style || 'pixar_premium'}.`].join('\n');
      const raw = await sendTurn(session, [{ text: prompt }], '1:1');
      const keyed = await softChromakeyWhiteToTransparent(raw);
      const path = `game-worlds/${bookId}/${room}/${id}.png`;
      objectUrls[id] = await uploadBuffer(keyed, path, 'image/png');
      console.log(`[gameWorldAssets] ${id} done in ${Date.now() - t0}ms`);
    } catch (e) {
      console.warn(`[gameWorldAssets] Object ${id} failed: ${e.message}`);
    }
  }

  const manifest = {
    bookId,
    room,
    style: style || null,
    generatedAt: new Date().toISOString(),
    roomBackgroundUrl,
    objects: objectUrls,
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
  const manifestUrl = await uploadBuffer(
    manifestBuf,
    `game-worlds/${bookId}/${room}/manifest.json`,
    'application/json',
  );

  const tookMs = Date.now() - startMs;
  console.log(`[gameWorldAssets] room=${room} done in ${tookMs}ms`);

  return { roomBackgroundUrl, objects: objectUrls, manifestUrl, tookMs };
}

function defaultObjectsForRoom(room) {
  if (room === 'kitchen')    return ['apple', 'banana', 'bread', 'milk', 'cupcake', 'juice', 'pot', 'moon'];
  if (room === 'bedroom')    return ['teddy', 'pillow', 'book', 'moon'];
  if (room === 'bathroom')   return ['duck', 'toothbrush', 'ball'];
  if (room === 'playground') return ['ball', 'shovel', 'teddy'];
  if (room === 'restaurant') return ['plate', 'spoon', 'pizza', 'chef_hat', 'cupcake', 'juice'];
  return [];
}

module.exports = { generateWorldAssets, ROOM_PROMPTS, OBJECT_PROMPTS };
