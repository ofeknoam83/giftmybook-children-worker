/**
 * renderStorySpreads probe mechanics: per-spread failure isolation
 * (allSettled — one thrown render costs only that spread), the identity-
 * keyed probe cache (an anchor/description change must never replay another
 * child's renders; a signed-URL re-sign must NOT bust the cache), seed
 * keying, and the full-book path still failing loudly on a missing buffer.
 */

jest.mock('../../../services/illustrationGenerator', () => ({
  generateIllustration: jest.fn(),
  downloadPhotoAsBase64: jest.fn().mockResolvedValue({ base64: 'b64', mimeType: 'image/jpeg' }),
  fetchWithTimeout: jest.fn().mockRejectedValue(new Error('offline test')),
  getNextApiKey: jest.fn().mockReturnValue('test-key'),
}));
jest.mock('../../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(),
  uploadBuffer: jest.fn().mockResolvedValue(undefined),
  getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/render.png'),
}));

const { generateIllustration } = require('../../../services/illustrationGenerator');
const { downloadBuffer } = require('../../../services/gcsStorage');
const { renderStorySpreads, illustrateStory } = require('../../../services/catalogEngine/illustrator');
const { getBook } = require('../../../services/catalogEngine/catalog');

const BOOK_ID = 'farm_2_3_hello_farm';
const PROFILE = { name: 'Emma', age: 2, pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' } };

const story = (spreads) => ({
  book_id: BOOK_ID,
  spreads: spreads.map(n => ({ spread: n, text: `Spread ${n} text.` })),
  personalization_evidence: [],
});

const baseParams = (over = {}) => ({
  bookId: 'probe-book-1',
  story: story(over.spreadNos || [1, 3]),
  bookDef: getBook(BOOK_ID),
  profile: PROFILE,
  approvedCoverUrl: null,
  childPhotoUrl: 'https://photos.example/child.png?sig=abc',
  spreads: over.spreadNos || [1, 3],
  log: () => {},
  ...over,
});

beforeEach(() => {
  // Cache-check misses on the FIRST download of each render key (fresh
  // render), hits on later calls (the post-render download / a replay); QA
  // markers never exist. The QA checker itself is offline (fetch rejects),
  // so every render ships pass-with-unchecked-advisory — irrelevant here.
  const seen = new Map();
  downloadBuffer.mockImplementation(async (key) => {
    if (key.endsWith('.qa.json')) throw new Error('no marker');
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n === 1) throw new Error('cache miss');
    return Buffer.from('png-bytes');
  });
  generateIllustration.mockImplementation(async () => 'https://x/render.png');
});

test('one thrown spread render costs ONLY that spread — the others keep their results', async () => {
  generateIllustration.mockImplementation(async (scene) => {
    if (scene.includes('Scene 3 of 12')) throw new Error('boom');
    return 'https://x/render.png';
  });
  const { results } = await renderStorySpreads(baseParams());
  expect(results).toHaveLength(2);
  const [s1, s3] = results;
  expect(s1.spread).toBe(1);
  expect(s1.buffer).not.toBeNull();
  expect(s3.spread).toBe(3);
  expect(s3.buffer).toBeNull();
  expect(s3.advisories[0].note).toContain('render errored: boom');
});

test('the full-book path still fails the run when any spread has no buffer', async () => {
  generateIllustration.mockImplementation(async (scene) => {
    if (scene.includes('Scene 3 of 12')) throw new Error('boom');
    return 'https://x/render.png';
  });
  await expect(illustrateStory(baseParams({
    spreadNos: Array.from({ length: 12 }, (_, i) => i + 1),
    spreads: null,
  }))).rejects.toMatchObject({ failureCode: 'render_failed' });
});

describe('identity-keyed probe cache', () => {
  const keyFor = async (over) => {
    const { results } = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1], ...over }));
    return results[0].storageKey;
  };

  test('an anchor or characterDescription change re-keys; a signed-URL re-sign does not', async () => {
    const a = await keyFor({ identityKeyed: true, characterDescription: 'curly hair' });
    const resigned = await keyFor({
      identityKeyed: true,
      characterDescription: 'curly hair',
      childPhotoUrl: 'https://photos.example/child.png?sig=DIFFERENT',
    });
    const otherChild = await keyFor({
      identityKeyed: true,
      characterDescription: 'curly hair',
      childPhotoUrl: 'https://photos.example/OTHER-child.png?sig=abc',
    });
    const otherDesc = await keyFor({ identityKeyed: true, characterDescription: 'straight hair' });
    expect(resigned).toBe(a);
    expect(otherChild).not.toBe(a);
    expect(otherDesc).not.toBe(a);
    expect(a).toContain('-i');
  });

  test('the full-book path stays un-salted (legacy keys, byte-identical)', async () => {
    const key = await keyFor({});
    expect(key).not.toContain('-i');
    expect(key).not.toContain('-s');
  });

  test('a probe seed re-keys so differently-seeded probes never replay each other', async () => {
    const unseeded = await keyFor({ identityKeyed: true });
    const seeded = await keyFor({ identityKeyed: true, seed: 42 });
    expect(seeded).not.toBe(unseeded);
    expect(seeded).toContain('-s42');
  });
});

describe('render-failure diagnostics reach the failure advisory', () => {
  test('a thrown render carries its per-attempt log onto advisory.detail', async () => {
    generateIllustration.mockImplementation(async (scene, ref, style, opts) => {
      if (Array.isArray(opts.attemptLog)) {
        opts.attemptLog.push({ attempt: 1, variant: 'public', error: 'No image in Gemini response (public-2)', finishReason: 'IMAGE_SAFETY', modelText: 'refusal explanation' });
      }
      const err = new Error('Illustration generation failed after 5 attempts: No image in Gemini response (public-2)');
      err.attempts = opts.attemptLog;
      throw err;
    });
    const { results } = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
    expect(results[0].buffer).toBeNull();
    const advisory = results[0].advisories[0];
    expect(advisory.note).toContain('render errored');
    expect(advisory.detail.attempts).toHaveLength(1);
    expect(advisory.detail.attempts[0]).toMatchObject({ finishReason: 'IMAGE_SAFETY', modelText: 'refusal explanation' });
  });

  test('the NSFW-exhausted null return keeps its attempt log too', async () => {
    generateIllustration.mockImplementation(async (scene, ref, style, opts) => {
      if (Array.isArray(opts.attemptLog)) {
        opts.attemptLog.push({ attempt: 1, variant: 'public', error: 'NSFW block', nsfw: true });
        opts.attemptLog.push({ attempt: 2, variant: 'generic-safe', error: 'NSFW block', nsfw: true });
      }
      return null;
    });
    const { results } = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
    expect(results[0].buffer).toBeNull();
    const advisory = results[0].advisories[0];
    expect(advisory.note).toContain('all prompt variants rejected');
    expect(advisory.detail.attempts.map(a => a.nsfw)).toEqual([true, true]);
  });
});

describe('layout-aware text embedding (ce-2)', () => {
  test('embedded layout runs the renderer text-embed path with the EXACT spread text', async () => {
    generateIllustration.mockClear();
    await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1], textLayout: 'embedded' }));
    const [scene, , , opts] = generateIllustration.mock.calls[0];
    expect(opts.skipTextEmbed).toBe(false);
    expect(opts.embedText).toBe(true);
    expect(opts.pageText).toBe('Spread 1 text.');
    expect(opts.aspectRatio).toBe('16:9');
    expect(scene).toContain('this EXACT text IS rendered into the image');
    expect(scene).not.toContain('NEVER paint these words');
  });

  test('caption layout (default) keeps the text-free contract', async () => {
    generateIllustration.mockClear();
    await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
    const [scene, , , opts] = generateIllustration.mock.calls[0];
    expect(opts.skipTextEmbed).toBe(true);
    expect(opts.embedText).toBeUndefined();
    expect(opts.pageText).toBeUndefined();
    expect(opts.aspectRatio).toBe('1:1');
    expect(scene).toContain('NEVER paint these words');
  });

  test('illustrateStory marks embedded entries textEmbeddedInArt so layout never double-typesets', async () => {
    const all = Array.from({ length: 12 }, (_, i) => i + 1);
    const embedded = await illustrateStory(baseParams({ spreadNos: all, spreads: null, textLayout: 'embedded' }));
    expect(embedded.entries.every(e => e.textEmbeddedInArt === true)).toBe(true);
    const caption = await illustrateStory(baseParams({ spreadNos: all, spreads: null }));
    expect(caption.entries.every(e => e.textEmbeddedInArt === undefined)).toBe(true);
  });
});
