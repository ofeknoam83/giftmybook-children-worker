/**
 * renderStorySpreads probe mechanics: per-spread failure isolation
 * (allSettled — one thrown render costs only that spread), the identity-
 * keyed probe cache (an anchor/description change must never replay another
 * child's renders; a signed-URL re-sign must NOT bust the cache), seed
 * keying, and the full-book path still failing loudly on a missing buffer.
 */

// ce-9: these suites pin the pre-bible render path (one candidate rendered
// straight to the shipped key; no character/prop sheets, no emotion plan).
// The Book Bible has its own suites (characterSheet, propSheet, emotionPlan,
// metrics, contactSheet, bibleIndex); here it is switched off so the legacy
// cache/replay/repair contracts stay observable on their own.
process.env.CATALOG_TYPOGRAPHY_GUIDE = '0'; // exercise the retained page-anchor compatibility path
process.env.CATALOG_CHARACTER_SHEET = '0';
process.env.CATALOG_PROP_SHEETS = '0';
process.env.CATALOG_EMOTION_PLAN = '0';
process.env.CATALOG_RENDER_CANDIDATES = '1';

jest.mock('../../../services/illustrationGenerator', () => ({
  generateIllustration: jest.fn(),
  downloadPhotoAsBase64: jest.fn().mockResolvedValue({ base64: 'b64', mimeType: 'image/jpeg' }),
  fetchWithTimeout: jest.fn().mockRejectedValue(new Error('offline test')),
  getNextApiKey: jest.fn().mockReturnValue('test-key'),
  isModestBathWaterScene: jest.fn().mockReturnValue(false),
  compareTexts: jest.requireActual('../../../services/illustrationGenerator').compareTexts,
}));
// ce-15: the typography anchor's crop needs real PNG bytes — this harness
// renders 'png-bytes'; inject a crop so the election path runs for real.
jest.mock('../../../services/catalogEngine/illustrator/textAnchor', () => {
  const real = jest.requireActual('../../../services/catalogEngine/illustrator/textAnchor');
  return {
    ...real,
    electTypographyAnchor: jest.fn((params) => real.electTypographyAnchor({ ...params, crop: async (buf, side) => (buf ? Buffer.from(`crop-${side}`) : null) })),
  };
});
jest.mock('../../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(),
  objectExists: jest.fn(async () => false),
  uploadBuffer: jest.fn().mockResolvedValue(undefined),
  uploadBufferIfAbsent: jest.fn().mockResolvedValue({ created: true }),
  deletePrefix: jest.fn().mockResolvedValue(undefined),
  getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/render.png'),
}));

const { generateIllustration, fetchWithTimeout, isModestBathWaterScene } = require('../../../services/illustrationGenerator');
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
    // Candidate keys (`.cK` / `.rPcK`, ce-9) are never cache-checked —
    // they are only downloaded right after their own render.
    if (/\.(?:r\d+)?c\d\.png$/.test(key)) return Buffer.from('png-bytes');
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n === 1) throw new Error('cache miss');
    return Buffer.from('png-bytes');
  });
  generateIllustration.mockImplementation(async () => 'https://x/render.png');
  // The outfit lock derives via its own fetch — keep it out of every test
  // that queues fetch verdicts or asserts key composition; the dedicated
  // outfit describe re-enables it explicitly.
  process.env.CATALOG_OUTFIT_LOCK = '0';
});

afterAll(() => {
  delete process.env.CATALOG_OUTFIT_LOCK;
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
  const { uploadBuffer } = require('../../../services/gcsStorage');
  uploadBuffer.mockClear();
  generateIllustration.mockImplementation(async (scene) => {
    if (scene.includes('Scene 3 of 12')) throw new Error('boom');
    return 'https://x/render.png';
  });
  await expect(illustrateStory(baseParams({
    spreadNos: Array.from({ length: 12 }, (_, i) => i + 1),
    spreads: null,
  }))).rejects.toMatchObject({ failureCode: 'render_failed' });
  const saved = uploadBuffer.mock.calls.find(([, key]) => key.endsWith('/reviewed-art.json'));
  expect(saved).toBeDefined();
  const manifest = JSON.parse(saved[0]);
  expect(Object.keys(manifest.renderKeys)).toHaveLength(12);
  expect(manifest.renderKeys[3]).toContain('/spread-3.square.png');
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

  test('stories pinned to different catalog overlays never share cache keys', async () => {
    // Scenes come from the PINNED definitions, so the same manuscript under
    // a different overlay (patched beats/world naming) renders different
    // prompts — the overlay tag must salt the key.
    const withTag = tag => ({ story: { ...story([1]), versions: { catalog: tag } } });
    const a = await keyFor(withTag('1.1.0+aaaaaaaa'));
    const b = await keyFor(withTag('1.1.0+bbbbbbbb'));
    const aAgain = await keyFor(withTag('1.1.0+aaaaaaaa'));
    expect(b).not.toBe(a);
    expect(aAgain).toBe(a);
    expect(a).toContain('-c');
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

  test('the world-law card rides every render — the generic-safe fallback suffix included', async () => {
    generateIllustration.mockClear();
    await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
    const [scene, , , opts] = generateIllustration.mock.calls[0];
    // In the scene itself, and handed to the renderer so its scene-discarding
    // NSFW fallback variant keeps the world laws too.
    expect(scene).toContain('WORLD LAWS');
    expect(opts.safeFallbackSuffix).toContain('WORLD LAWS');
  });

  test('half layout renders a text-FREE full-spread wide composition on its own cache path', async () => {
    generateIllustration.mockClear();
    const { results, aspect } = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1], textLayout: 'half' }));
    const [scene, , , opts] = generateIllustration.mock.calls[0];
    expect(aspect).toBe('wide');
    expect(opts.aspectRatio).toBe('16:9');
    expect(opts.skipTextEmbed).toBe(true);
    expect(opts.embedText).toBeUndefined();
    // The model is told the left half dies under the text panel.
    expect(scene).toContain('COMPOSITION FOR PRINT (HALF-PAGE LAYOUT)');
    expect(scene).toContain('RIGHT half');
    // wide-plain cache: a half render can never replay an embedded book's
    // Gemini-painted wide render (or vice versa).
    expect(results[0].storageKey).toContain('.wide-plain.png');
    const embedded = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1], textLayout: 'embedded' }));
    expect(embedded.results[0].storageKey).toContain('.wide.png');
    expect(embedded.results[0].storageKey).not.toContain('wide-plain');
  });

  test('illustrateStory marks embedded entries textEmbeddedInArt so layout never double-typesets', async () => {
    const all = Array.from({ length: 12 }, (_, i) => i + 1);
    const embedded = await illustrateStory(baseParams({ spreadNos: all, spreads: null, textLayout: 'embedded' }));
    expect(embedded.entries.every(e => e.textEmbeddedInArt === true)).toBe(true);
    const caption = await illustrateStory(baseParams({ spreadNos: all, spreads: null }));
    expect(caption.entries.every(e => e.textEmbeddedInArt === undefined)).toBe(true);
  });
});

describe('bounded spread-QA repair loop (CATALOG_SPREAD_QA_MAX_REPAIRS)', () => {
  const qaVerdict = (over = {}) => ({
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              // shot_type_mismatch is required since ce-8 (the shot plan is
              // ON by default, so every render carries an assigned shot).
              readable_text: false, child_absent: false, multiple_children: false, flat_or_photo_style: false, shot_type_mismatch: false, ...over,
            }),
          }],
        },
      }],
    }),
  });
  const probeOne = () => renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));

  afterEach(() => {
    delete process.env.CATALOG_SPREAD_QA_MAX_REPAIRS;
    fetchWithTimeout.mockRejectedValue(new Error('offline test'));
  });

  test('each repair pass is steered by the LATEST check\'s defects, up to a configured budget of 2', async () => {
    process.env.CATALOG_SPREAD_QA_MAX_REPAIRS = '2';
    // Check 1: painted text → repair 1. Check 2: child missing (a DIFFERENT
    // defect) → repair 2 must carry the child fix, not the stale text fix.
    // Check 3: clean → no residual advisory.
    fetchWithTimeout
      .mockResolvedValueOnce(qaVerdict({ readable_text: true }))
      .mockResolvedValueOnce(qaVerdict({ child_absent: true }))
      .mockResolvedValueOnce(qaVerdict());
    generateIllustration.mockClear();
    const { results } = await probeOne();
    expect(generateIllustration).toHaveBeenCalledTimes(3); // base + 2 repairs
    expect(generateIllustration.mock.calls[1][0]).toContain('ABSOLUTELY NO text');
    expect(generateIllustration.mock.calls[2][0]).toContain('clearly visible and central');
    expect(generateIllustration.mock.calls[2][0]).not.toContain('ABSOLUTELY NO text');
    expect(results[0].advisories).toEqual([]);
    expect(results[0].fresh).toBe(true);
  });

  test('the total candidate cap overrides large general and drift budgets', async () => {
    process.env.CATALOG_SPREAD_QA_MAX_REPAIRS = '4';
    process.env.CATALOG_DRIFT_MAX_REPAIRS = '4';
    process.env.CATALOG_RENDER_CANDIDATES = '3';
    try {
      fetchWithTimeout.mockResolvedValue(qaVerdict({ child_absent: true }));
      generateIllustration.mockClear();
      const { results } = await probeOne();
      expect(generateIllustration).toHaveBeenCalledTimes(3);
      expect(results[0].blocking).toContain('child hero missing from the scene');
      expect(results[0].candidateFiles).toHaveLength(3);
    } finally {
      delete process.env.CATALOG_DRIFT_MAX_REPAIRS;
      process.env.CATALOG_RENDER_CANDIDATES = '1';
    }
  });

  test('a spread still failing when the budget runs out ships with the residual advisory', async () => {
    process.env.CATALOG_SPREAD_QA_MAX_REPAIRS = '1';
    fetchWithTimeout
      .mockResolvedValueOnce(qaVerdict({ readable_text: true }))
      .mockResolvedValueOnce(qaVerdict({ readable_text: true }));
    generateIllustration.mockClear();
    const { results } = await probeOne();
    expect(generateIllustration).toHaveBeenCalledTimes(2); // base + 1 repair
    expect(results[0].advisories).toEqual([
      expect.objectContaining({ stage: 'spreadQa', note: expect.stringContaining('residual defects after 1 repair render(s)') }),
    ]);
  });

  test('CATALOG_SPREAD_QA_MAX_REPAIRS=0 disables repairs — the failing render ships straight to advisory', async () => {
    process.env.CATALOG_SPREAD_QA_MAX_REPAIRS = '0';
    fetchWithTimeout.mockResolvedValueOnce(qaVerdict({ readable_text: true }));
    generateIllustration.mockClear();
    const { results } = await probeOne();
    expect(generateIllustration).toHaveBeenCalledTimes(1);
    expect(results[0].advisories).toEqual([
      expect.objectContaining({ note: expect.stringContaining('repairs disabled') }),
    ]);
  });

  test('a repair render that returns null aborts the loop and ships the last render (no double advisory)', async () => {
    fetchWithTimeout.mockResolvedValueOnce(qaVerdict({ readable_text: true }));
    generateIllustration.mockClear();
    generateIllustration
      .mockImplementationOnce(async () => 'https://x/render.png')
      .mockImplementationOnce(async () => null);
    const { results } = await probeOne();
    expect(generateIllustration).toHaveBeenCalledTimes(2);
    expect(results[0].buffer).not.toBeNull();
    expect(results[0].advisories).toEqual([
      expect.objectContaining({ note: expect.stringContaining('repair render failed') }),
    ]);
  });
});

describe('per-spread force re-render (rerenderSpreads)', () => {
  const { fnv1a } = require('../../../services/catalogEngine/selection');
  const markerFor = bytes => Buffer.from(JSON.stringify({
    advisories: [], tuningTag: 'none', renderHash: fnv1a(bytes.toString('base64')).toString(36),
  }));
  const cleanSpreadVerdict = JSON.stringify({
    readable_text: false, child_absent: false, multiple_children: false, flat_or_photo_style: false, shot_type_mismatch: false,
  });
  const geminiText = text => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  });

  afterEach(() => fetchWithTimeout.mockRejectedValue(new Error('offline test')));

  const seedCachedRenders = () => {
    // Every render key holds QA-vouched pixels — without a force, everything
    // would replay.
    const png = Buffer.from('png-bytes');
    downloadBuffer.mockImplementation(async (key) => {
      if (key.endsWith('.qa.json')) return markerFor(png);
      return png;
    });
  };

  test('listed spreads render fresh while the rest replay as world-gate references', async () => {
    seedCachedRenders();
    fetchWithTimeout.mockImplementation(async (url, opts) => {
      const prompt = JSON.parse(opts.body).contents[0].parts[0].text;
      if (prompt.includes('CROSS-SPREAD CONSISTENCY')) return geminiText(JSON.stringify({ consistent: true, flagged: [] }));
      return geminiText(cleanSpreadVerdict);
    });
    generateIllustration.mockClear();
    const { results } = await renderStorySpreads(baseParams({ rerenderSpreads: [1] }));
    expect(generateIllustration).toHaveBeenCalledTimes(1);
    expect(generateIllustration.mock.calls[0][0]).toContain('Scene 1 of 12');
    expect(results.find(r => r.spread === 1).fresh).toBe(true);
    expect(results.find(r => r.spread === 3).fresh).toBe(false);
  });

  test('the world gate may correct the forced spread against the replayed references', async () => {
    seedCachedRenders();
    let gateCalls = 0;
    fetchWithTimeout.mockImplementation(async (url, opts) => {
      const prompt = JSON.parse(opts.body).contents[0].parts[0].text;
      if (prompt.includes('CROSS-SPREAD CONSISTENCY')) {
        gateCalls += 1;
        return geminiText(JSON.stringify({
          consistent: false,
          flagged: [{ spread: 1, defect: 'character_rendering', note: 'child reads older than on the other spreads' }],
        }));
      }
      return geminiText(cleanSpreadVerdict);
    });
    generateIllustration.mockClear();
    const { results, worldQa } = await renderStorySpreads(baseParams({ rerenderSpreads: [1] }));
    // Base fresh render + the gate's corrective re-render — spread 3 replays
    // untouched (its storageKey is shared with earlier rounds).
    expect(gateCalls).toBe(1);
    expect(generateIllustration).toHaveBeenCalledTimes(2);
    expect(generateIllustration.mock.calls[1][0]).toContain('same apparent age');
    expect(generateIllustration.mock.calls.every(c => c[0].includes('Scene 1 of 12'))).toBe(true);
    expect(worldQa.rerendered).toEqual([1]);
    const s1 = results.find(r => r.spread === 1);
    expect(s1.fresh).toBe(true);
    expect(s1.advisories.some(a => a.stage === 'worldQa' && a.note.includes('child reads older'))).toBe(true);
  });
});

describe('continuity kill-switch is cache-keyed (carried-prop and prop-less renders never replay each other)', () => {
  const objectStory = () => ({
    ...story([1]),
    personalization_evidence: [
      { spread: 1, visual_required: true, moment_type: 'object_presence', source_field: 'object', source_value: 'toy fox' },
    ],
  });
  const keyFor = async (over) => {
    const { results } = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1], ...over }));
    return results[0].storageKey;
  };

  beforeEach(() => { process.env.CATALOG_WORLD_PLATE = '0'; });
  afterEach(() => {
    delete process.env.CATALOG_WORLD_PLATE;
    delete process.env.CATALOG_PROP_CONTINUITY;
  });

  test('a disabled revision re-keys ONLY stories carrying visual object evidence', async () => {
    const enabledKey = await keyFor({ story: objectStory() });
    expect(enabledKey).not.toContain('-p0'); // default keys stay byte-identical
    process.env.CATALOG_PROP_CONTINUITY = '0';
    const disabledKey = await keyFor({ story: objectStory() });
    expect(disabledKey).toContain('-p0');
    expect(disabledKey).not.toBe(enabledKey);
    // No eligible evidence → identical prompts in both modes → one shared key.
    const plainDisabled = await keyFor({});
    delete process.env.CATALOG_PROP_CONTINUITY;
    const plainEnabled = await keyFor({});
    expect(plainDisabled).toBe(plainEnabled);
    expect(plainDisabled).not.toContain('-p0');
  });
});

describe('bench final book: identityKeyed + seed replay the approved probe renders', () => {
  const { fnv1a } = require('../../../services/catalogEngine/selection');
  const markerFor = bytes => Buffer.from(JSON.stringify({
    advisories: [], tuningTag: 'none', renderHash: fnv1a(bytes.toString('base64')).toString(36),
  }));

  // The world plate folds a content hash into cache keys and keeps
  // module-level cooldown state — disable it so both calls compose the
  // same key deterministically.
  beforeEach(() => { process.env.CATALOG_WORLD_PLATE = '0'; });
  afterEach(() => {
    delete process.env.CATALOG_WORLD_PLATE;
    fetchWithTimeout.mockRejectedValue(new Error('offline test'));
  });

  test('illustrateStory under the probe cache knobs replays probe-keyed renders without a single re-render', async () => {
    const all = Array.from({ length: 12 }, (_, i) => i + 1);
    const fullStory = story(all);
    const knobs = { identityKeyed: true, seed: 42, characterDescription: 'curly hair' };

    // Capture the key the PROBE writes for spread 1 under these knobs.
    const probe = await renderStorySpreads(baseParams({ story: fullStory, spreads: [1], ...knobs }));
    const probeKey = probe.results[0].storageKey;
    expect(probeKey).toContain('-i');
    expect(probeKey).toContain('-s42');

    // The final-book dispatch: every render key already holds QA-vouched
    // pixels (the bench's approved renders) — the full book must replay
    // them all instead of re-rendering a single spread.
    const png = Buffer.from('png-bytes');
    downloadBuffer.mockImplementation(async key => (key.endsWith('.qa.json') ? markerFor(png) : png));
    generateIllustration.mockClear();
    const book = await illustrateStory(baseParams({ story: fullStory, spreads: null, ...knobs }));
    expect(generateIllustration).not.toHaveBeenCalled();
    expect(book.entries).toHaveLength(12);
    expect(book.entries.find(e => e.spread === 1).spreadIllustrationStorageKey).toBe(probeKey);
    for (const e of book.entries) {
      expect(e.spreadIllustrationStorageKey).toContain('-i');
      expect(e.spreadIllustrationStorageKey).toContain('-s42');
    }
  });

  test('without the knobs the full-book path stays on legacy keys — no accidental probe replay', async () => {
    const all = Array.from({ length: 12 }, (_, i) => i + 1);
    const png = Buffer.from('png-bytes');
    downloadBuffer.mockImplementation(async key => (key.endsWith('.qa.json') ? markerFor(png) : png));
    const book = await illustrateStory(baseParams({ story: story(all), spreads: null }));
    for (const e of book.entries) {
      expect(e.spreadIllustrationStorageKey).not.toContain('-i');
      expect(e.spreadIllustrationStorageKey).not.toContain('-s');
    }
  });
});

describe('outfit lock arms the renderer and rides the cache key', () => {
  let lockedKey = null;
  // v2 (ce-8): the derivation answers a STRUCTURED per-slot spec; the lock
  // pins the rendered sentence built from it.
  const outfitJson = () => ({
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              top: { desc: 'red short-sleeved t-shirt with a white cat graphic', visibility: 'seen' },
              bottom: { desc: 'full-length blue jeans reaching the ankles', visibility: 'inferred' },
              footwear: { desc: 'white low-top sneakers', visibility: 'inferred' },
              accessories: [],
            }),
          }],
        },
      }],
    }),
  });
  const RENDERED_SPEC = 'Top: red short-sleeved t-shirt with a white cat graphic. Bottom: full-length blue jeans reaching the ankles. Footwear: white low-top sneakers.';

  beforeEach(() => {
    delete process.env.CATALOG_OUTFIT_LOCK; // re-enable (default ON)
    process.env.CATALOG_WORLD_PLATE = '0'; // deterministic keys
  });
  afterEach(() => {
    delete process.env.CATALOG_WORLD_PLATE;
    fetchWithTimeout.mockRejectedValue(new Error('offline test'));
  });

  test('the derived spec reaches every render as characterOutfit and folds into the -b bible key', async () => {
    fetchWithTimeout.mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body);
      const prompt = body.contents[0].parts[0].text || '';
      if (prompt.includes('OUTFIT LOCK')) return outfitJson();
      throw new Error('offline test'); // QA stays offline — irrelevant here
    });
    generateIllustration.mockClear();
    const { results, outfitLockUsed, advisories } = await renderStorySpreads(baseParams({
      childPhotoUrl: 'https://photos.example/outfit-child-A.png?sig=1',
    }));
    // ce-9: the outfit spec's hash rides the ONE bible fold (-b{bibleHash})
    // — a locked and a lock-less run never share a key (see the next test).
    expect(results[0].storageKey).toMatch(/-b[0-9a-z]+/);
    lockedKey = results[0].storageKey;
    for (const call of generateIllustration.mock.calls) {
      expect(call[3].characterOutfit).toBe(RENDERED_SPEC);
    }
    // The callback echo carries the lock's content hash; a locked run has
    // no lock-less advisory.
    expect(outfitLockUsed).not.toBe('none');
    expect(advisories).toEqual([]);
  });

  test('a derivation failure fails open — lock-less renders on the un-folded key, LOUDLY', async () => {
    // fetch stays offline for everything (the afterEach default).
    fetchWithTimeout.mockRejectedValue(new Error('offline test'));
    generateIllustration.mockClear();
    const { results, outfitLockUsed, advisories } = await renderStorySpreads(baseParams({
      spreadNos: [1], spreads: [1],
      childPhotoUrl: 'https://photos.example/outfit-child-B.png?sig=1',
    }));
    expect(results[0].buffer).not.toBeNull();
    // Lock-less renders fold a DIFFERENT bible hash than the locked run above.
    expect(results[0].storageKey).toMatch(/-b[0-9a-z]+/);
    if (lockedKey) expect(results[0].storageKey.replace(/spread-\d+\..*$/, '')).not.toBe(lockedKey.replace(/spread-\d+\..*$/, ''));
    expect(generateIllustration.mock.calls[0][3].characterOutfit).toBeUndefined();
    // Never silent: a lock-less run with the switch ON says so on the callback.
    expect(outfitLockUsed).toBe('none');
    expect(advisories).toEqual([expect.objectContaining({ stage: 'outfitLock' })]);
  });

  test('CATALOG_OUTFIT_LOCK=0 disables derivation entirely', async () => {
    process.env.CATALOG_OUTFIT_LOCK = '0';
    fetchWithTimeout.mockImplementation(async () => {
      throw new Error('no call expected for the outfit');
    });
    const { results, outfitLockUsed, advisories } = await renderStorySpreads(baseParams({
      spreadNos: [1], spreads: [1],
      childPhotoUrl: 'https://photos.example/outfit-child-C.png?sig=1',
    }));
    expect(results[0].storageKey).toMatch(/-b[0-9a-z]+/);
    // Disabled-by-kill-switch is an operator choice, not an advisory.
    expect(outfitLockUsed).toBe('none');
    expect(advisories).toEqual([]);
  });
});

describe('QA marker integrity (renderHash)', () => {
  const { fnv1a } = require('../../../services/catalogEngine/selection');
  const { QA_VERSION } = require('../../../services/catalogEngine/versions');
  // ce-9: a marker vouches only under the CURRENT checker version.
  const markerFor = (bytes, advisories = []) => Buffer.from(JSON.stringify({
    advisories, tuningTag: 'none', renderHash: fnv1a(bytes.toString('base64')).toString(36), qaVersion: QA_VERSION,
  }));

  test('a marker whose renderHash matches the cached bytes replays without rendering or re-checking', async () => {
    const png = Buffer.from('png-bytes');
    downloadBuffer.mockImplementation(async (key) => {
      if (key.endsWith('.qa.json')) return markerFor(png, [{ stage: 'spreadQa', spread: 1, note: 'prior advisory' }]);
      return png;
    });
    generateIllustration.mockClear();
    const { results } = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
    expect(generateIllustration).not.toHaveBeenCalled();
    expect(results[0].fresh).toBe(false);
    expect(results[0].advisories).toEqual([{ stage: 'spreadQa', spread: 1, note: 'prior advisory' }]);
  });

  test('a marker for OTHER pixels is never trusted — the cached render is re-checked instead', async () => {
    // The failed-overwrite window: GCS holds new pixels beside a marker
    // written for the old ones. The replay must drop the stale verdict and
    // re-run QA on what is actually cached.
    const png = Buffer.from('png-bytes');
    downloadBuffer.mockImplementation(async (key) => {
      if (key.endsWith('.qa.json')) return markerFor(Buffer.from('DIFFERENT-bytes'), [{ stage: 'spreadQa', spread: 1, note: 'stale verdict' }]);
      return png;
    });
    generateIllustration.mockClear();
    const { results } = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
    // Pixels are reused (no re-render) but the stale advisories are dropped
    // and QA re-runs — offline here, so it ships with the unchecked advisory.
    expect(generateIllustration).not.toHaveBeenCalled();
    expect(results[0].buffer).toEqual(png);
    expect(results[0].advisories.some(a => a.note?.includes('UNCHECKED'))).toBe(true);
    expect(results[0].advisories.some(a => a.note === 'stale verdict')).toBe(false);
  });
});

describe('shot plan rides the render path (ce-8)', () => {
  const cleanVerdict = JSON.stringify({
    readable_text: false, child_absent: false, multiple_children: false, flat_or_photo_style: false, shot_type_mismatch: false,
  });
  const geminiText = text => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  });

  afterEach(() => {
    delete process.env.CATALOG_SHOT_PLAN;
    fetchWithTimeout.mockRejectedValue(new Error('offline test'));
  });

  test('every render carries its ASSIGNED composition: scene block, opts.shotType, and the NSFW fallback suffix', async () => {
    generateIllustration.mockClear();
    const { results } = await renderStorySpreads(baseParams({ spreadNos: [1, 3], spreads: [1, 3] }));
    expect(results[0].buffer).not.toBeNull();
    for (const call of generateIllustration.mock.calls) {
      const [scene, , , opts] = call;
      expect(scene).toContain('COMPOSITION (ASSIGNED FOR THIS SPREAD');
      expect(typeof opts.shotType).toBe('string');
      expect(opts.safeFallbackSuffix).toContain('COMPOSITION (ASSIGNED FOR THIS SPREAD');
    }
    // Spread 1 is the wide establishing bookend by contract.
    expect(generateIllustration.mock.calls[0][3].shotType).toBe('wide');
  });

  test('CATALOG_SHOT_PLAN=0 renders plan-less on a -sp0 folded key (never replaying planned renders)', async () => {
    const planned = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
    process.env.CATALOG_SHOT_PLAN = '0';
    generateIllustration.mockClear();
    const plainless = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
    expect(plainless.results[0].storageKey).toContain('-sp0');
    expect(planned.results[0].storageKey).not.toContain('-sp0');
    const [scene, , , opts] = generateIllustration.mock.calls[0];
    expect(scene).not.toContain('COMPOSITION (ASSIGNED FOR THIS SPREAD');
    expect(opts.shotType).toBeUndefined();
  });

  test('set-level repairs share the same per-spread candidate budget', async () => {
    process.env.CATALOG_RENDER_BUDGET_PER_SPREAD = '1';
    try {
      fetchWithTimeout.mockImplementation(async (url, opts) => {
        const prompt = JSON.parse(opts.body).contents[0].parts[0].text;
        return geminiText(prompt.includes('CROSS-SPREAD CONSISTENCY')
          ? JSON.stringify({ consistent: false, flagged: [{ spread: 3, defect: 'composition_duplicate', note: 'duplicate' }] })
          : cleanVerdict);
      });
      generateIllustration.mockClear();
      const result = await renderStorySpreads(baseParams({ spreadNos: [1, 3], spreads: [1, 3] }));
      expect(generateIllustration).toHaveBeenCalledTimes(2); // one per spread, no set repair
      expect(result.worldQa.rerendered).toEqual([]);
      expect(result.results.every(r => r.buffer)).toBe(true);
      expect(result.results.find(r => r.spread === 3).advisories.some(a => a.note.includes('budget exhausted'))).toBe(true);
    } finally { delete process.env.CATALOG_RENDER_BUDGET_PER_SPREAD; }
  });

  test('a composition_duplicate gate finding re-renders the flagged spread against its OWN plan directive', async () => {
    fetchWithTimeout.mockImplementation(async (url, opts) => {
      const prompt = JSON.parse(opts.body).contents[0].parts[0].text;
      if (prompt.includes('CROSS-SPREAD CONSISTENCY')) {
        return geminiText(JSON.stringify({
          consistent: false,
          flagged: [{ spread: 3, defect: 'composition_duplicate', note: 'spreads 1 and 3 read as the same mid-shot' }],
        }));
      }
      return geminiText(cleanVerdict);
    });
    generateIllustration.mockClear();
    const { worldQa } = await renderStorySpreads(baseParams({ spreadNos: [1, 3], spreads: [1, 3] }));
    expect(worldQa.rerendered).toEqual([3]);
    const repairScene = generateIllustration.mock.calls.at(-1)[0];
    expect(repairScene).toContain('duplicates another spread\'s composition');
    expect(repairScene).toContain('Obey THIS spread\'s assigned composition exactly:');
    expect(repairScene).toContain('COMPOSITION (ASSIGNED FOR THIS SPREAD');
  });

  test('multiple flagged spreads re-render CONCURRENTLY and report spread-ordered', async () => {
    // Set repairs used to run one full re-render cycle at a time — the
    // dominant wall-clock tail of a many-spread run. They now share the
    // render-phase concurrency limit; the reported list stays deterministic
    // (spread order) regardless of which repair finishes first.
    fetchWithTimeout.mockImplementation(async (url, opts) => {
      const prompt = JSON.parse(opts.body).contents[0].parts[0].text;
      if (prompt.includes('CROSS-SPREAD CONSISTENCY')) {
        return geminiText(JSON.stringify({
          consistent: false,
          flagged: [
            { spread: 3, defect: 'palette_lighting', note: 'colder palette than the rest' },
            { spread: 1, defect: 'character_rendering', note: 'child reads older' },
          ],
        }));
      }
      return geminiText(cleanVerdict);
    });
    // Overlap probe: a repair render parks on a macrotask before resolving,
    // so BOTH repairs are in flight together only if the second starts
    // before the first finishes — under the old serial loop the peak never
    // exceeded 1 (every await before the render call is an already-resolved
    // mock, so both tasks deterministically reach the render while parked).
    let activeRepairs = 0;
    let peakActiveRepairs = 0;
    generateIllustration.mockClear();
    generateIllustration.mockImplementation(async (scene) => {
      if (scene.includes('WORLD CONSISTENCY REPAIR')) {
        activeRepairs += 1;
        peakActiveRepairs = Math.max(peakActiveRepairs, activeRepairs);
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
        activeRepairs -= 1;
      }
      return 'https://x/render.png';
    });
    const { worldQa, results } = await renderStorySpreads(baseParams({ spreadNos: [1, 3], spreads: [1, 3] }));
    expect(worldQa.rerendered).toEqual([1, 3]);
    expect(peakActiveRepairs).toBe(2);
    // 2 base renders + 2 corrective re-renders, each flagged spread repaired
    // against its own defect note.
    expect(generateIllustration).toHaveBeenCalledTimes(4);
    for (const r of results) expect(r.fresh).toBe(true);
    expect(results.find(r => r.spread === 1).advisories.some(a => a.stage === 'worldQa' && a.note.includes('child reads older'))).toBe(true);
    expect(results.find(r => r.spread === 3).advisories.some(a => a.stage === 'worldQa' && a.note.includes('colder palette'))).toBe(true);
  });

  test('a set re-render that comes back WORSE (blocking defects) never replaces a clean flagged render', async () => {
    // Base QA passes both spreads; the gate flags spread 3; every QA call
    // from the corrective re-render onwards reports a missing child (a
    // BLOCKING defect). The ship policy must keep the clean original.
    let spreadQaCalls = 0;
    fetchWithTimeout.mockImplementation(async (url, opts) => {
      const prompt = JSON.parse(opts.body).contents[0].parts[0].text;
      if (prompt.includes('CROSS-SPREAD CONSISTENCY')) {
        return geminiText(JSON.stringify({ consistent: false, flagged: [{ spread: 3, defect: 'palette_lighting', note: 'colder palette' }] }));
      }
      spreadQaCalls += 1;
      if (spreadQaCalls > 2) return geminiText(JSON.stringify({ readable_text: false, child_absent: true, multiple_children: false, flat_or_photo_style: false, shot_type_mismatch: false }));
      return geminiText(cleanVerdict);
    });
    const { worldQa, results, unresolved } = await renderStorySpreads(baseParams({ spreadNos: [1, 3], spreads: [1, 3] }));
    const s3 = results.find(r => r.spread === 3);
    expect(worldQa.rerendered).toEqual([]);
    expect(s3.blocking).toEqual([]);
    expect(s3.advisories.some(a => a.stage === 'worldQa' && a.note.includes('kept the flagged render'))).toBe(true);
    expect(unresolved || []).toEqual([]);
  });

  test('bath/water spreads reach the world gate as outfit-exempt', async () => {
    isModestBathWaterScene.mockImplementation(scene => scene.includes('Scene 3 of 12'));
    let gatePrompt = null;
    fetchWithTimeout.mockImplementation(async (url, opts) => {
      const prompt = JSON.parse(opts.body).contents[0].parts[0].text;
      if (prompt.includes('CROSS-SPREAD CONSISTENCY')) {
        gatePrompt = prompt;
        return geminiText(JSON.stringify({ consistent: true, flagged: [] }));
      }
      return geminiText(cleanVerdict);
    });
    try {
      await renderStorySpreads(baseParams());
      expect(gatePrompt).toContain('spread(s) 3 are bath/water scenes');
    } finally {
      isModestBathWaterScene.mockReset().mockReturnValue(false);
    }
  });
});

describe('ce-15: the book\'s own first painted page is the typography reference for its other embedded spreads', () => {
  const { electTypographyAnchor } = require('../../../services/catalogEngine/illustrator/textAnchor');
  const { uploadBufferIfAbsent } = require('../../../services/gcsStorage');

  // Reference election now requires a real size verdict. These tests used
  // to elect references while QA was offline; model the measured success
  // path explicitly, keeping the real QA parser and size calculation.
  const measuredVerdict = (textBbox = { x: 0.1, y: 0.15, w: 0.04, h: 0.015 }) => async (url, opts) => {
    const prompt = JSON.parse(opts.body).contents[0].parts[0].text;
    const expected = prompt.match(/STORY TEXT THAT MUST APPEAR IN THE IMAGE:\n"([^"]*)"/)?.[1] || '';
    const verdict = { child_absent: false, multiple_children: false, flat_or_photo_style: false,
      readable_text: !!expected, visible_text: expected, companion: { present: true, look_match: true },
      text_split_both_sides: false, text_on_band: false, text_backdrop_treated: false,
      text_in_center_gutter: false, text_lines_misaligned: false, text_style_inconsistent: false,
      text_bbox: textBbox, consistent: true, flagged: [] };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdict) }] } }] }) };
  };
  beforeEach(() => fetchWithTimeout.mockImplementation(measuredVerdict()));
  afterEach(() => {
    delete process.env.CATALOG_TEXT_ANCHOR;
    fetchWithTimeout.mockReset().mockRejectedValue(new Error('offline test'));
  });

  test.each([null, { x: 0.1, y: 0.15, w: 0.12, h: 0.045 }])('an unmeasured or moderately oversized first page is kept without copying it or spending extra renders (%j)', async bbox => {
    fetchWithTimeout.mockImplementation(measuredVerdict(bbox));
    generateIllustration.mockClear(); electTypographyAnchor.mockClear();
    const { results, typographyAnchorUsed, advisories } = await renderStorySpreads(baseParams({ spreadNos: [1, 3, 5], spreads: [1, 3, 5], textLayout: 'embedded' }));
    expect(results).toHaveLength(3);
    expect(results.every(r => r.buffer && r.blocking.length === 0)).toBe(true);
    expect(results[0].qa.qaUnavailable).toBeUndefined();
    if (bbox) expect(results[0].qa.textSizeRatio).toBeGreaterThan(1.5);
    else expect(results[0].qa.textSizeRatio).toBeNull();
    expect(generateIllustration).toHaveBeenCalledTimes(3);
    expect(electTypographyAnchor).not.toHaveBeenCalled();
    expect(typographyAnchorUsed).toBe('none');
    expect(generateIllustration.mock.calls.every(c => !c[3].typographyRef)).toBe(true);
    expect(advisories.filter(a => a.stage === 'typographyAnchor')).toEqual([
      expect.objectContaining({ note: expect.stringContaining('its illustration is kept') }),
    ]);
  });

  test('the first spread renders ALONE and un-referenced; the others carry the crop as the LAST reference, the assigned text side, and the -ta fold', async () => {
    generateIllustration.mockClear();
    electTypographyAnchor.mockClear();
    uploadBufferIfAbsent.mockClear();
    const order = [];
    generateIllustration.mockImplementation(async (scene) => { order.push(scene.match(/Scene (\d+) of 12/)[1]); return 'https://x/render.png'; });
    const { results, typographyAnchorUsed, advisories } = await renderStorySpreads(baseParams({ spreadNos: [1, 3, 5], spreads: [1, 3, 5], textLayout: 'embedded' }));
    // Spread 1's candidates all finish before any other spread starts.
    const firstOther = order.findIndex(n => n !== '1');
    expect(firstOther).toBeGreaterThan(0);
    expect(order.slice(0, firstOther).every(n => n === '1')).toBe(true);
    expect(electTypographyAnchor).toHaveBeenCalledTimes(1);
    expect(electTypographyAnchor.mock.calls[0][0]).toMatchObject({ spread: 1, pinKey: expect.stringMatching(/\/typo-anchor\.wide\.json$/) });
    expect(uploadBufferIfAbsent).toHaveBeenCalledWith(expect.any(Buffer), expect.stringMatching(/typo-anchor\.wide\.json$/), 'application/json');
    const [s1, s3, s5] = results;
    expect(s1.spread).toBe(1);
    expect(s1.storageKey).not.toContain('-ta');
    expect(s3.storageKey).toMatch(/-ta[a-z0-9]{1,8}\/spread-3\.wide\.png$/);
    expect(s5.storageKey).toMatch(/-ta[a-z0-9]{1,8}\/spread-5\.wide\.png$/);
    expect(typographyAnchorUsed).toMatch(/^s1\.[a-z0-9]{1,8}$/);
    expect(advisories.some(a => a.stage === 'typographyAnchor')).toBe(false);
    // The anchor spread's own renders: no typography reference; the others: the crop LAST, cited by index, with the assigned side forwarded.
    const calls = generateIllustration.mock.calls;
    const forSpread = (n) => calls.filter(([scene]) => scene.includes(`Scene ${n} of 12`)).map(c => c[3]);
    // The anchor and remaining spreads each start with a single candidate.
    expect(forSpread(1)).toHaveLength(1);
    expect(forSpread(3)).toHaveLength(1);
    for (const o of forSpread(1)) {
      expect(o.typographyRef).toBeUndefined();
      expect((o.referencePack || []).some(r => r.kind === 'typography')).toBe(false);
    }
    for (const n of [3, 5]) {
      for (const o of forSpread(n)) {
        const pack = o.referencePack;
        expect(pack[pack.length - 1].kind).toBe('typography');
        expect(pack[pack.length - 1].label).toContain('TYPOGRAPHY REFERENCE (page 1 of THIS book');
        expect(pack[pack.length - 1].label).toContain('TYPE ONLY');
        expect(o.typographyRef).toBe(pack.length);
        expect(['left', 'right']).toContain(o.textSide);
      }
    }
  });

  test('every embedded scene carries the TEXT COLUMN calm-scenery hint on its assigned side, in the fallback suffix too', async () => {
    generateIllustration.mockClear();
    await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1], textLayout: 'embedded' }));
    const [scene, , , opts] = generateIllustration.mock.calls[0];
    expect(scene).toContain('COMPOSITION FOR PRINT (TEXT COLUMN)');
    expect(scene).toMatch(/painted over the (LEFT|RIGHT) column/);
    // ce-17: the column is the scene at full sharpness — never a haze zone.
    expect(scene).toContain('NEVER blur, fog, soften, darken, lighten, desaturate, or empty it');
    // ce-18: the fill is dark ink, so the legibility edge is a PALE hairline —
    // this hint rides every embedded scene and must not contradict the spec.
    expect(scene).toContain('their own thin, tight contrasting hairline');
    expect(scene).toContain('not from treating the background or changing the book’s ink');
    expect(scene).not.toContain('thin dark outline');
    expect(scene).not.toContain('gentle depth haze');
    expect(opts.safeFallbackSuffix).toContain('COMPOSITION FOR PRINT (TEXT COLUMN)');
    const caption = await (async () => { generateIllustration.mockClear(); await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] })); return generateIllustration.mock.calls[0][0]; })();
    expect(caption).not.toContain('TEXT COLUMN');
  });

  test('a pinned page is reused by every later run whatever its subset: no serialization, the pinned page keeps its plain key, every other spread folds the pin', async () => {
    const { anchorHash } = jest.requireActual('../../../services/catalogEngine/illustrator/textAnchor');
    const crop = Buffer.from('pinned-crop');
    const seen = new Map();
    // Keys the (mocked) renderer was asked to write hold bytes afterwards —
    // a forced render skips the replay check, so its canonical key's first
    // download is the post-render one (the default harness's first-miss
    // rule would wrongly fail it).
    const rendered = new Set();
    generateIllustration.mockImplementation(async (scene, ref, style, opts) => { if (opts && opts.gcsPath) rendered.add(opts.gcsPath); return 'https://x/render.png'; });
    downloadBuffer.mockImplementation(async (key) => {
      if (key.endsWith('typo-anchor.wide.json')) return Buffer.from(JSON.stringify({ spread: 4, side: 'right', hash: anchorHash(crop), png: crop.toString('base64') }));
      if (key.endsWith('.qa.json')) throw new Error('no marker');
      if (rendered.has(key)) return Buffer.from('png-bytes');
      if (/\.(?:r\d+)?c\d\.png$/.test(key)) return Buffer.from('png-bytes');
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      if (n === 1) throw new Error('cache miss');
      return Buffer.from('png-bytes');
    });
    generateIllustration.mockClear();
    electTypographyAnchor.mockClear();
    // A probe that does not even contain the pinned page: both spreads render against it.
    const probe = await renderStorySpreads(baseParams({ spreadNos: [1, 3], spreads: [1, 3], textLayout: 'embedded' }));
    expect(electTypographyAnchor).not.toHaveBeenCalled(); // no election — the pin is the anchor
    const fold = `-ta${anchorHash(crop).slice(0, 8)}`;
    expect(probe.results.map(r => r.storageKey)).toEqual([
      expect.stringMatching(new RegExp(`${fold}/spread-1\\.wide\\.png$`)),
      expect.stringMatching(new RegExp(`${fold}/spread-3\\.wide\\.png$`)),
    ]);
    expect(probe.typographyAnchorUsed).toBe(`s4.${anchorHash(crop).slice(0, 8)}`);
    for (const [, , , o] of generateIllustration.mock.calls) {
      const last = o.referencePack[o.referencePack.length - 1];
      expect(last.kind).toBe('typography');
      expect(last.label).toContain('TYPOGRAPHY REFERENCE (page 4 of THIS book');
      expect(last.label).toContain('the RIGHT half');
      expect(last.base64).toBe(crop.toString('base64'));
      expect(o.typographyRef).toBe(o.referencePack.length);
    }
    // A run that contains the pinned page: page 4 keeps its plain key and still gets its own crop as reference.
    generateIllustration.mockClear();
    const withPinned = await renderStorySpreads(baseParams({ spreadNos: [4, 6], spreads: [4, 6], textLayout: 'embedded' }));
    expect(withPinned.results[0].storageKey).not.toContain('-ta');
    expect(withPinned.results[1].storageKey).toContain(fold);
    expect(generateIllustration.mock.calls.every(c => c[3].typographyRef > 0)).toBe(true);
    // forceRerender re-elects from THIS run's first spread instead of reusing the pin.
    generateIllustration.mockClear();
    electTypographyAnchor.mockClear();
    const forced = await renderStorySpreads(baseParams({ spreadNos: [1, 3], spreads: [1, 3], textLayout: 'embedded', forceRerender: true }));
    expect(electTypographyAnchor).toHaveBeenCalledTimes(1);
    expect(electTypographyAnchor.mock.calls[0][0]).toMatchObject({ spread: 1, reelect: true });
    expect(forced.results[0].storageKey).not.toContain('-ta');
    expect(forced.typographyAnchorUsed).toMatch(/^s1\./);
  });

  test('CATALOG_EMBEDDED_IMAGE_SIZE rides embedded renders as imageSize and folds -is{size} into their keys; caption renders never carry it', async () => {
    process.env.CATALOG_EMBEDDED_IMAGE_SIZE = '2k';
    try {
      generateIllustration.mockClear();
      const { results } = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1], textLayout: 'embedded' }));
      expect(results[0].storageKey).toMatch(/-is2k-[^/]*\/spread-1\.wide\.png$/);
      expect(generateIllustration.mock.calls[0][3].imageSize).toBe('2K');
      generateIllustration.mockClear();
      const caption = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
      expect(caption.results[0].storageKey).not.toContain('-is');
      expect(generateIllustration.mock.calls[0][3].imageSize).toBeUndefined();
      process.env.CATALOG_EMBEDDED_IMAGE_SIZE = 'huge';
      generateIllustration.mockClear();
      const bad = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1], textLayout: 'embedded' }));
      expect(bad.results[0].storageKey).not.toContain('-is');
      expect(generateIllustration.mock.calls[0][3].imageSize).toBeUndefined();
    } finally {
      delete process.env.CATALOG_EMBEDDED_IMAGE_SIZE;
    }
  });

  test('needsRepair: the oversized advisory shades selection only; every other embedded-text finding still repairs', () => {
    const { needsRepair } = require('../../../services/catalogEngine/illustrator');
    expect(needsRepair({ blocking: [], advisory: ['embedded story text oversized (about 1.3× the book\'s fixed size)'] })).toBe(false);
    expect(needsRepair({ blocking: [], advisory: ['embedded story text lines misaligned (tilted)'] })).toBe(true);
    expect(needsRepair({ blocking: ['embedded story text too large (about 2× the book\'s fixed size)'], advisory: [] })).toBe(true);
    expect(needsRepair({ blocking: [], advisory: ['face hidden: turned away'] })).toBe(false);
  });

  test('CATALOG_TEXT_ANCHOR=0: no election, no reference, and every embedded key folds -ta0', async () => {
    process.env.CATALOG_TEXT_ANCHOR = '0';
    generateIllustration.mockClear();
    electTypographyAnchor.mockClear();
    const { results, typographyAnchorUsed } = await renderStorySpreads(baseParams({ spreadNos: [1, 3], spreads: [1, 3], textLayout: 'embedded' }));
    expect(electTypographyAnchor).not.toHaveBeenCalled();
    expect(results.every(r => /-ta0\/spread-\d+\.wide\.png$/.test(r.storageKey))).toBe(true);
    expect(typographyAnchorUsed).toBe('none');
    expect(generateIllustration.mock.calls.every(c => c[3].typographyRef === undefined)).toBe(true);
  });

  test('a single-spread probe is its own anchor: nothing to reference, plain key, no advisory; an anchor spread that fails to render is advisory, never fatal', async () => {
    generateIllustration.mockClear();
    const one = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1], textLayout: 'embedded' }));
    expect(one.results[0].storageKey).not.toContain('-ta');
    expect(one.typographyAnchorUsed).toBe('none');
    expect(one.advisories.some(a => a.stage === 'typographyAnchor')).toBe(false);
    generateIllustration.mockImplementation(async (scene) => {
      if (scene.includes('Scene 1 of 12')) throw new Error('boom');
      return 'https://x/render.png';
    });
    const failed = await renderStorySpreads(baseParams({ spreadNos: [1, 3], spreads: [1, 3], textLayout: 'embedded' }));
    expect(failed.results[0].buffer).toBeNull();
    expect(failed.results[1].buffer).not.toBeNull();
    expect(failed.typographyAnchorUsed).toBe('none');
    expect(failed.advisories).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'typographyAnchor' })]));
    expect(failed.results[1].storageKey).not.toContain('-ta');
  });
});

test('reviewed rebuild never generates replacement art on a cache miss', async () => {
  generateIllustration.mockClear();
  downloadBuffer.mockRejectedValue(Object.assign(new Error('missing'), { code: 404 }));
  const { results } = await renderStorySpreads(baseParams({ reviewedOnly: true }));
  expect(generateIllustration).not.toHaveBeenCalled();
  expect(results.every(r => !r.buffer)).toBe(true);
});


test('reviewed rebuild preserves cached pixels and skips automatic repair gates', async () => {
  const { fnv1a } = require('../../../services/catalogEngine/selection');
  const { QA_VERSION } = require('../../../services/catalogEngine/versions');
  const png = Buffer.from('reviewed-pixels');
  downloadBuffer.mockImplementation(async key => {
    if (key.endsWith('/reviewed-art.json')) throw Object.assign(new Error('missing'), { code: 404 });
    return key.endsWith('.qa.json')
      ? Buffer.from(JSON.stringify({ renderHash: fnv1a(png.toString('base64')).toString(36), qaVersion: QA_VERSION, adminPicked: true })) : png;
  });
  generateIllustration.mockClear();
  const result = await renderStorySpreads(baseParams({ reviewedOnly: true }));
  expect(result.results.every(r => r.buffer.equals(png))).toBe(true);
  expect(generateIllustration).not.toHaveBeenCalled();
  expect(result.contactQa).toBeNull();
  expect(result.worldQa).toBeNull();
});


describe('generated small-type guide', () => {
  beforeEach(() => { process.env.CATALOG_TYPOGRAPHY_GUIDE = '1'; process.env.CATALOG_TYPOGRAPHY_TEMPLATE = '0'; generateIllustration.mockClear(); });
  afterEach(() => { process.env.CATALOG_TYPOGRAPHY_GUIDE = '0'; delete process.env.CATALOG_TYPOGRAPHY_TEMPLATE; });
  test('every Gemini spread gets the same guide, including the first, with no extra image attempts', async () => {
    const result = await renderStorySpreads(baseParams({ spreadNos: [1, 3, 5], spreads: [1, 3, 5], textLayout: 'embedded' }));
    expect(generateIllustration).toHaveBeenCalledTimes(3);
    const options = generateIllustration.mock.calls.map(c => c[3]);
    const refs = options.map(o => o.referencePack.find(r => r.kind === 'typography'));
    expect(refs.every(Boolean)).toBe(true);
    expect(new Set(refs.map(r => r.base64)).size).toBe(1);
    expect(refs[0].label).toContain('TYPOGRAPHY SIZE AND INK GUIDE');
    expect(options.every(o => o.embedText === true && o.bookTextInk === 'dark' && o.typographyGuide === true)).toBe(true);
    expect(options.every(o => /-ta/.test(o.gcsPath))).toBe(true);
    expect(result.typographyAnchorUsed).toMatch(/^guide\./);
  });
  test('a probe of a later spread uses the same guide and namespace as the full book', async () => {
    await renderStorySpreads(baseParams({ spreadNos: [1, 3, 5], spreads: [3], textLayout: 'embedded' }));
    const first = generateIllustration.mock.calls[0][3];
    generateIllustration.mockClear();
    await renderStorySpreads(baseParams({ spreadNos: [1, 3, 5], spreads: [1, 3, 5], textLayout: 'embedded', forceRerender: true }));
    const full = generateIllustration.mock.calls.find(c => c[3].spreadIndex === 2)[3];
    expect(first.gcsPath).toBe(full.gcsPath);
    expect(first.referencePack.find(r => r.kind === 'typography').base64).toBe(full.referencePack.find(r => r.kind === 'typography').base64);
  });
});

describe('per-spread full-canvas lettering template', () => {
  const { objectExists } = require('../../../services/gcsStorage');
  beforeEach(() => {
    process.env.CATALOG_TYPOGRAPHY_GUIDE = '1';
    process.env.CATALOG_TYPOGRAPHY_TEMPLATE = '1';
    generateIllustration.mockClear();
    objectExists.mockImplementation(async () => false);
  });
  afterEach(() => {
    process.env.CATALOG_TYPOGRAPHY_GUIDE = '0';
    delete process.env.CATALOG_TYPOGRAPHY_TEMPLATE;
    objectExists.mockImplementation(async () => false);
  });
  test('opt-in gives each request its own manuscript at the same size; a subset keeps the full-book namespace', async () => {
    const params = { spreadNos: [1, 3, 5], spreads: [1, 3, 5], textLayout: 'embedded' };
    const result = await renderStorySpreads(baseParams(params));
    expect(generateIllustration).toHaveBeenCalledTimes(3);
    const options = generateIllustration.mock.calls.map(c => c[3]);
    expect(options.every(o => o.typographyTemplate && o.imageSize === '4K')).toBe(true);
    const refs = options.map(o => o.referencePack.find(r => r.kind === 'typography-template'));
    expect(new Set(refs.map(r => r.base64)).size).toBe(3);
    expect(refs.every(r => r.label.includes('ENTIRE 16:9 canvas'))).toBe(true);
    expect(result.typographyAnchorUsed).toMatch(/^template\./);
    generateIllustration.mockClear();
    const subset = await renderStorySpreads(baseParams({ ...params, spreads: [3], forceRerender: true }));
    expect(subset.results[0].storageKey).toBe(result.results[1].storageKey);
    expect(generateIllustration.mock.calls[0][3].referencePack.find(r => r.kind === 'typography-template').base64).toBe(refs[1].base64);
  });
  test('the template is disabled for new books by default pending size approval', async () => {
    delete process.env.CATALOG_TYPOGRAPHY_TEMPLATE;
    const result = await renderStorySpreads(baseParams({ textLayout: 'embedded' }));
    expect(result.typographyAnchorUsed).toMatch(/^guide\./);
    expect(generateIllustration.mock.calls.every(c => !c[3].typographyTemplate && !c[3].imageSize)).toBe(true);
  });
  test('an existing guide book stays on its paid-for namespace unless explicitly upgraded', async () => {
    process.env.CATALOG_TYPOGRAPHY_TEMPLATE = '0';
    const params = { spreadNos: [1, 3], spreads: [1, 3], textLayout: 'embedded' };
    const old = await renderStorySpreads(baseParams(params));
    process.env.CATALOG_TYPOGRAPHY_TEMPLATE = '1';
    objectExists.mockImplementation(async key => key === old.results[1].storageKey);
    generateIllustration.mockClear();
    const resumed = await renderStorySpreads(baseParams(params));
    expect(resumed.results.map(r => r.storageKey)).toEqual(old.results.map(r => r.storageKey));
    expect(resumed.typographyAnchorUsed).toBe(old.typographyAnchorUsed);
    const upgraded = await renderStorySpreads(baseParams({ ...params, forceRerender: true }));
    expect(upgraded.typographyAnchorUsed).toMatch(/^template\./);
    objectExists.mockImplementation(async key => [old.results[1].storageKey, upgraded.results[0].storageKey].includes(key));
    const retry = await renderStorySpreads(baseParams(params));
    expect(retry.results.map(r => r.storageKey)).toEqual(upgraded.results.map(r => r.storageKey));
    process.env.CATALOG_TYPOGRAPHY_TEMPLATE = '0';
    generateIllustration.mockClear();
    const rollbackRetry = await renderStorySpreads(baseParams(params));
    expect(rollbackRetry.results.map(r => r.storageKey)).toEqual(upgraded.results.map(r => r.storageKey));
    expect(generateIllustration).not.toHaveBeenCalled();
  });
});
