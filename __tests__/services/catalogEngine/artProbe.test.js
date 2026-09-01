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
  uploadBufferIfAbsent: jest.fn().mockResolvedValue({ created: true }),
  deletePrefix: jest.fn().mockResolvedValue(undefined),
  getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/render.png'),
}));

const { generateIllustration, fetchWithTimeout } = require('../../../services/illustrationGenerator');
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
              readable_text: false, child_absent: false, multiple_children: false, flat_or_photo_style: false, ...over,
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

  test('each repair pass is steered by the LATEST check\'s defects, up to the default budget of 2', async () => {
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
    readable_text: false, child_absent: false, multiple_children: false, flat_or_photo_style: false,
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

describe('QA marker integrity (renderHash)', () => {
  const { fnv1a } = require('../../../services/catalogEngine/selection');
  const markerFor = (bytes, advisories = []) => Buffer.from(JSON.stringify({
    advisories, tuningTag: 'none', renderHash: fnv1a(bytes.toString('base64')).toString(36),
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
