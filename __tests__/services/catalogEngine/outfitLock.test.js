/**
 * Outfit lock — per-anchor derivation, single-winner GCS election,
 * fail-open discipline, and sanitization. Mirrors the world plate's
 * contract: any failure resolves null (lock-less renders), never a throw.
 *
 * v2 (ce-8): the derivation answers a STRUCTURED per-slot spec —
 * top/bottom/footwear required, anchor-cropped slots elected as `inferred`
 * completions — rendered into one pinned sentence; blobs live under the
 * v2/ GCS path so v1 free-sentence blobs are never half-parsed.
 */

jest.mock('../../../services/illustrationGenerator', () => ({
  getNextApiKey: jest.fn(() => 'test-key'),
  fetchWithTimeout: jest.fn(),
}));
jest.mock('../../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(),
  uploadBufferIfAbsent: jest.fn(),
}));

const { fetchWithTimeout } = require('../../../services/illustrationGenerator');
const { downloadBuffer, uploadBufferIfAbsent } = require('../../../services/gcsStorage');
const { getOutfitLock, outfitLockPath, anchorHash, cleanOutfit, renderOutfitSpec } = require('../../../services/catalogEngine/illustrator/outfitLock');
const { fnv1a } = require('../../../services/catalogEngine/selection');

const REF = { base64: 'aGk=', mimeType: 'image/png' };
const SPEC_JSON = {
  top: { desc: 'red short-sleeved t-shirt with a white cat graphic', visibility: 'seen' },
  bottom: { desc: 'full-length blue jeans reaching the ankles', visibility: 'inferred' },
  footwear: { desc: 'white low-top sneakers', visibility: 'inferred' },
  accessories: [],
};
const RENDERED_SPEC = 'Top: red short-sleeved t-shirt with a white cat graphic. Bottom: full-length blue jeans reaching the ankles. Footwear: white low-top sneakers.';
const outfitJson = (json = SPEC_JSON) => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }),
});

// Module-level caches (spec LRU + failure cooldown) persist across tests —
// every test uses its own anchor URL so no state leaks between them.
let anchorSeq = 0;
const freshAnchor = () => `https://covers.example/anchor-${anchorSeq++}.png?sig=abc`;

beforeEach(() => {
  fetchWithTimeout.mockReset();
  downloadBuffer.mockReset().mockRejectedValue(new Error('not found'));
  uploadBufferIfAbsent.mockReset().mockResolvedValue({ created: true });
  delete process.env.CATALOG_OUTFIT_LOCK;
});

test('derives, elects, and caches one spec per anchor; a re-signed URL reuses it', async () => {
  fetchWithTimeout.mockResolvedValue(outfitJson());
  const anchorUrl = freshAnchor();
  const lock = await getOutfitLock({ anchorUrl, refPhoto: REF });
  expect(lock).toMatchObject({ outfit: RENDERED_SPEC, hash: fnv1a(RENDERED_SPEC).toString(36) });
  expect(uploadBufferIfAbsent).toHaveBeenCalledWith(
    expect.any(Buffer), outfitLockPath(anchorHash(anchorUrl)), 'application/json',
  );
  // v2 blobs live under their own path — v1 sentence blobs are never read.
  expect(outfitLockPath(anchorHash(anchorUrl))).toContain('/v2/');
  // Same object under a rotated signature: in-process cache, no new calls.
  const resigned = await getOutfitLock({ anchorUrl: anchorUrl.replace('sig=abc', 'sig=OTHER'), refPhoto: REF });
  expect(resigned).toEqual(lock);
  expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
});

test('a stored GCS spec is adopted without a vision call', async () => {
  downloadBuffer.mockResolvedValue(Buffer.from(JSON.stringify({ outfit: 'green raincoat, yellow boots' })));
  const lock = await getOutfitLock({ anchorUrl: freshAnchor(), refPhoto: REF });
  expect(lock.outfit).toBe('green raincoat, yellow boots');
  expect(fetchWithTimeout).not.toHaveBeenCalled();
});

test('losing the creation race adopts the winning words (and their hash)', async () => {
  fetchWithTimeout.mockResolvedValue(outfitJson());
  uploadBufferIfAbsent.mockResolvedValue({ created: false });
  downloadBuffer
    .mockRejectedValueOnce(new Error('not found')) // pre-derivation cache check
    .mockResolvedValueOnce(Buffer.from(JSON.stringify({ outfit: 'the winning outfit words' })));
  const lock = await getOutfitLock({ anchorUrl: freshAnchor(), refPhoto: REF });
  expect(lock.outfit).toBe('the winning outfit words');
  expect(lock.hash).toBe(fnv1a('the winning outfit words').toString(36));
});

test('vision failure fails open and cools down — no per-book retry storm', async () => {
  fetchWithTimeout.mockRejectedValue(new Error('socket hangup'));
  const anchorUrl = freshAnchor();
  await expect(getOutfitLock({ anchorUrl, refPhoto: REF })).resolves.toBeNull();
  expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  // Second resolution inside the cooldown: no new derivation attempt.
  await expect(getOutfitLock({ anchorUrl, refPhoto: REF })).resolves.toBeNull();
  expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
});

test('CATALOG_OUTFIT_LOCK=0 disables everything', async () => {
  process.env.CATALOG_OUTFIT_LOCK = '0';
  await expect(getOutfitLock({ anchorUrl: freshAnchor(), refPhoto: REF })).resolves.toBeNull();
  expect(downloadBuffer).not.toHaveBeenCalled();
  expect(fetchWithTimeout).not.toHaveBeenCalled();
});

test('an answer missing a REQUIRED slot fails open — no partial lock', async () => {
  // v2's whole point: a spec with an unspecified garment would leave that
  // garment per-spread freedom, so it is refused rather than pinned.
  fetchWithTimeout.mockResolvedValue(outfitJson({ ...SPEC_JSON, bottom: undefined }));
  await expect(getOutfitLock({ anchorUrl: freshAnchor(), refPhoto: REF })).resolves.toBeNull();
});

describe('renderOutfitSpec', () => {
  test('renders the full sentence with outerwear and accessories', () => {
    const out = renderOutfitSpec({
      ...SPEC_JSON,
      outerwear: { desc: 'yellow rain jacket', visibility: 'seen' },
      accessories: [{ desc: 'red glasses', visibility: 'seen' }, { desc: 'blue backpack', visibility: 'inferred' }],
    });
    expect(out.outfit).toBe(
      'Top: red short-sleeved t-shirt with a white cat graphic. Bottom: full-length blue jeans reaching the ankles. '
      + 'Footwear: white low-top sneakers. Outerwear: yellow rain jacket. Accessories: red glasses; blue backpack.',
    );
    expect(out.spec.bottom.visibility).toBe('inferred');
  });

  test('quotes and control chars are stripped from slot descriptions (the spec is quoted into the QA prompt)', () => {
    const out = renderOutfitSpec({
      ...SPEC_JSON,
      top: { desc: 'red "hero" t-shirt\nwith `stars`', visibility: 'seen' },
    });
    expect(out.outfit).toContain('Top: red hero t-shirt with stars.');
  });

  test('required slots gate: null on a missing/empty top, bottom, or footwear', () => {
    expect(renderOutfitSpec({ ...SPEC_JSON, top: { desc: '', visibility: 'seen' } })).toBeNull();
    expect(renderOutfitSpec({ ...SPEC_JSON, footwear: null })).toBeNull();
    expect(renderOutfitSpec(null)).toBeNull();
    expect(renderOutfitSpec('a sentence')).toBeNull();
  });

  test('unknown visibility values normalize to seen; accessories cap at 6', () => {
    const out = renderOutfitSpec({
      ...SPEC_JSON,
      top: { desc: 'plain green t-shirt', visibility: 'sideways' },
      accessories: Array.from({ length: 9 }, (_, i) => ({ desc: `charm number ${i}`, visibility: 'seen' })),
    });
    expect(out.spec.top.visibility).toBe('seen');
    expect(out.spec.accessories).toHaveLength(6);
  });
});

describe('cleanOutfit', () => {
  test('collapses control chars and whitespace, caps length, rejects stubs', () => {
    expect(cleanOutfit('red  shirt\n and\t blue  jeans')).toBe('red shirt and blue jeans');
    expect(cleanOutfit(`${'x'.repeat(800)}`)).toHaveLength(700);
    expect(cleanOutfit('tiny')).toBeNull();
    expect(cleanOutfit(42)).toBeNull();
    expect(cleanOutfit(null)).toBeNull();
  });
});

describe('renderOutfitSpec hardening (review fixes)', () => {
  test('a required slot too thin to lock (no color/cut/length detail) is rejected', () => {
    // "shoes" / "blue pants" cannot pin the hem or footwear detail the
    // drift lives in — reject and let derivation retry, never pin a
    // partial lock.
    expect(renderOutfitSpec({ ...SPEC_JSON, footwear: { desc: 'shoes', visibility: 'seen' } })).toBeNull();
    expect(renderOutfitSpec({ ...SPEC_JSON, bottom: { desc: 'blue pants', visibility: 'seen' } })).toBeNull();
  });

  test('an oversized rendered sentence drops trailing accessories WHOLE — spec and sentence stay consistent, nothing truncates mid-item', () => {
    const long = n => `a very detailed ${'x'.repeat(120)} accessory number ${n}`;
    const out = renderOutfitSpec({
      top: { desc: 'red short-sleeved cotton t-shirt with a white cat graphic on the chest', visibility: 'seen' },
      bottom: { desc: 'full-length medium-blue denim jeans reaching the ankles', visibility: 'inferred' },
      footwear: { desc: 'white low-top canvas sneakers with white laces', visibility: 'inferred' },
      accessories: [1, 2, 3, 4, 5, 6].map(n => ({ desc: long(n), visibility: 'seen' })),
    });
    expect(out).not.toBeNull();
    expect(out.outfit.length).toBeLessThanOrEqual(700);
    // Every accessory KEPT in the spec appears whole in the sentence; every
    // dropped one appears nowhere — the pinned words and the stored spec
    // never disagree about what is locked.
    expect(out.spec.accessories.length).toBeLessThan(6);
    for (const a of out.spec.accessories) expect(out.outfit).toContain(a.desc);
    expect(out.outfit).not.toContain(`accessory number ${out.spec.accessories.length + 1}`);
    // The garment slots always survive.
    expect(out.outfit).toContain('Top:');
    expect(out.outfit).toContain('Bottom:');
    expect(out.outfit).toContain('Footwear:');
  });
});
