/**
 * NPC sprite pipeline — one painted full-body PNG per named supporting
 * character (mom / dad / pet cat / …).
 *
 * Replaces the old avatar-face-disc call that fed the 3D rig. Payload
 * shape (persisted on `ChildrenBook.gameNpcFacesJson`):
 *
 *   {
 *     mom: { url, width, height, name },
 *     dad: { url, width, height, name },
 *     cat: { url, width, height, name },
 *   }
 *
 * The legacy client (Npc.jsx) understands both `url` and the older
 * `faceUrl`, so migrating books are safe even without a regeneration.
 */

const { uploadBuffer } = require('./gcsStorage');
const { generateSpritePng } = require('./gameSpriteCore');
const { spritePrompt } = require('./spriteStyle');

function subjectLine(descriptor) {
  const kind = descriptor.kind || 'person';
  const base = descriptor.prompt || descriptor.describe || null;
  if (base) return `Draw a full-body children's-book NPC: ${base}.`;
  if (kind === 'cat') return 'Draw a full-body children\'s-book NPC: a friendly tabby house cat sitting upright.';
  if (kind === 'dog') return 'Draw a full-body children\'s-book NPC: a friendly golden puppy standing.';
  if (kind === 'mom') return `Draw a full-body children's-book NPC: a warm mom in casual house clothes, mid-30s, smiling gently.`;
  if (kind === 'dad') return `Draw a full-body children's-book NPC: a warm dad in casual house clothes, mid-30s, smiling gently.`;
  return `Draw a full-body children's-book NPC: ${descriptor.name || kind}.`;
}

function buildNpcPrompt(descriptor) {
  const extra = [
    'SUBJECT RULES:',
    `- The subject is exactly "${descriptor.name || descriptor.kind}" — one character, full body in frame, feet to crown visible.`,
    '- Friendly, approachable pose; arms at sides or waving.',
    '- Do NOT draw the child hero, any props, or any secondary characters.',
  ];
  return spritePrompt(subjectLine(descriptor), extra);
}

function resolveRefs({ characterRefUrl, coverImageUrl }) {
  const refs = [];
  if (characterRefUrl) refs.push({ url: characterRefUrl, label: 'BOOK ART STYLE (match line weight + palette — do NOT copy the child character):' });
  if (coverImageUrl && refs.length < 2) refs.push({ url: coverImageUrl, label: 'BOOK COVER (style only):' });
  return refs;
}

async function generateNpcSprite({ bookId, descriptor, characterRefUrl, coverImageUrl }) {
  if (!bookId) throw new Error('bookId required');
  if (!descriptor?.kind && !descriptor?.name) throw new Error('descriptor.kind or .name required');

  const slug = (descriptor.kind || descriptor.name || 'npc').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
  const prompt = buildNpcPrompt(descriptor);
  const refs = resolveRefs({ characterRefUrl, coverImageUrl });
  const { buffer, width, height } = await generateSpritePng({ prompt, refs, aspectRatio: '3:4' });
  const url = await uploadBuffer(
    buffer,
    `game-npcs/${bookId}/${slug}.png`,
    'image/png',
  );
  return { url, width, height, name: descriptor.name || descriptor.kind };
}

async function generateNpcSprites({ bookId, descriptors, characterRefUrl, coverImageUrl }) {
  if (!Array.isArray(descriptors) || descriptors.length === 0) {
    return { npcs: {}, partialFailures: [] };
  }
  const npcs = {};
  const partialFailures = [];
  for (const d of descriptors) {
    try {
      const out = await generateNpcSprite({ bookId, descriptor: d, characterRefUrl, coverImageUrl });
      npcs[d.kind || d.name] = out;
    } catch (e) {
      console.warn(`[npcSprite] ${d.kind || d.name} failed: ${e.message}`);
      partialFailures.push({ kind: d.kind || d.name, error: e.message });
    }
  }
  return { npcs, partialFailures };
}

module.exports = { generateNpcSprite, generateNpcSprites };
