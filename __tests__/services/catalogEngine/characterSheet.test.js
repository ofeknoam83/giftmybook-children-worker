/**
 * Character model sheet (ce-9 Book Bible §3.1) — best-of-N generation,
 * structured judge, single-winner GCS election, the identity_kit_failed
 * failure contract (never a silent cover-only fallback), the kill-switch,
 * cooldowns, and sanitization of everything that can reach a prompt.
 */

jest.mock('../../../services/illustrationGenerator', () => ({
  getNextApiKey: jest.fn(() => 'test-key'),
  GEMINI_MODEL: 'test-image-model',
  fetchWithTimeout: jest.fn(),
  renderStyleBlock: jest.fn(() => 'STYLE BLOCK'),
}));
jest.mock('../../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(),
  uploadBuffer: jest.fn(),
  uploadBufferIfAbsent: jest.fn(),
}));

const sharp = require('sharp');
const { fetchWithTimeout } = require('../../../services/illustrationGenerator');
const { downloadBuffer, uploadBuffer, uploadBufferIfAbsent } = require('../../../services/gcsStorage');
const { GEMINI_IMAGE_SAFETY_SETTINGS } = require('../../../services/shared/illustration/config');
const { STYLE_VERSION } = require('../../../services/catalogEngine/versions');
const { fnv1a } = require('../../../services/catalogEngine/selection');
const {
  getCharacterSheet, characterSheetPath, characterSheetSidecarPath, buildSheetPrompt, buildSheetQaPrompt,
  cleanDescription, parseSheetVerdict, sheetCandidateCount, anchorHash, FAILURE_CODE, PHOTO_LIKENESS_ADVISORY, COVER_LIKENESS_MIN,
} = require('../../../services/catalogEngine/illustrator/bible/characterSheet');

const REF = { base64: 'YW5jaG9y', mimeType: 'image/png' };
// Photo bytes are diagnostic QA input only; never a render reference.
const PHOTO = { base64: 'cGhvdG8=', mimeType: 'image/jpeg' };
/** A real, decodable JPEG photo (built in beforeAll) to verify that even a decodable photo stays out of generation. */
let PHOTO_JPEG;
const PROFILE = { name: 'Mia', age: 5 };
const IMAGE_MODEL_URL = 'test-image-model';

/** Tiny real PNGs (distinct bytes per candidate) made with sharp. */
const CANDIDATE_PNGS = [];
beforeAll(async () => {
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00'];
  for (const background of colors) {
    CANDIDATE_PNGS.push(await sharp({ create: { width: 16, height: 9, channels: 3, background } }).png().toBuffer());
  }
  const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#8899aa' } }).jpeg().toBuffer();
  PHOTO_JPEG = { base64: jpeg.toString('base64'), mimeType: 'image/jpeg' };
});

const CLEAN_VERDICT = {
  readable_text: false, figure_count: 3, one_child: true, feet_visible: true,
  outfit_consistent_across_views: true, anatomy_ok: true, likeness: 0.8,
  cover_identity_matches: true, cover_outfit_matches: true, outfit_findings: [],
};
const imageResponse = buffer => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: buffer.toString('base64') } }] } }] }),
});
const qaResponse = verdict => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text: typeof verdict === 'string' ? verdict : JSON.stringify(verdict) }] } }] }),
});

/**
 * Transport that hands candidate i the i-th PNG and answers its judge call
 * with verdicts[i] (a verdict object, a raw text string, or a response
 * override function). Image calls hit the image model URL; judge calls
 * carry the candidate bytes as the first inline_data part, which is how
 * the judge answer is matched back to its candidate.
 */
function installTransport(verdicts, { imageFailures = [] } = {}) {
  let imageCall = 0;
  fetchWithTimeout.mockImplementation(async (url, init) => {
    if (url.includes(IMAGE_MODEL_URL)) {
      const i = imageCall++;
      if (imageFailures.includes(i)) return { ok: false, status: 503, text: async () => 'overloaded' };
      return imageResponse(CANDIDATE_PNGS[i]);
    }
    const body = JSON.parse(init.body);
    const sheetB64 = body.contents[0].parts.find(p => p.inline_data).inline_data.data;
    const i = CANDIDATE_PNGS.findIndex(png => png.toString('base64') === sheetB64);
    const v = verdicts[i];
    if (typeof v === 'function') return v();
    return qaResponse(v);
  });
}

const imageCalls = () => fetchWithTimeout.mock.calls.filter(c => c[0].includes(IMAGE_MODEL_URL));
const judgeCalls = () => fetchWithTimeout.mock.calls.filter(c => !c[0].includes(IMAGE_MODEL_URL));

// Module-level caches (sheet LRU + failure cooldown) persist across tests —
// every test uses its own anchor URL so no state leaks between them.
const objects = new Map();
let anchorSeq = 0;
const freshAnchor = () => `https://covers.example/book/anchor-${anchorSeq++}.png?sig=abc&X-Goog-Expires=60`;

beforeEach(() => {
  fetchWithTimeout.mockReset();
  objects.clear();
  downloadBuffer.mockReset().mockImplementation(async key => {
    if (!objects.has(key)) throw Object.assign(new Error('not found'), { code: 404 });
    return objects.get(key);
  });
  uploadBuffer.mockReset().mockImplementation(async (buffer, key) => { objects.set(key, buffer); });
  uploadBufferIfAbsent.mockReset().mockImplementation(async (buffer, key) => {
    if (objects.has(key)) return { created: false };
    objects.set(key, buffer); return { created: true };
  });
  delete process.env.CATALOG_CHARACTER_SHEET;
  delete process.env.CATALOG_SHEET_CANDIDATES;
  delete process.env.CATALOG_SHEET_PHOTO_LIKENESS_MIN;
});


describe('cleanDescription', () => {
  test('strips control chars, quotes and backticks, collapses whitespace, caps at 300, rejects empties', () => {
    expect(cleanDescription('a  "b"\r\n`c` d')).toBe('a b c d');
    expect(cleanDescription('x'.repeat(500))).toHaveLength(300);
    expect(cleanDescription('   ')).toBeNull();
    expect(cleanDescription('"`\'')).toBeNull();
    expect(cleanDescription(42)).toBeNull();
    expect(cleanDescription(null)).toBeNull();
  });
});

describe('parseSheetVerdict', () => {
  test('type-checks every field; malformed ⇒ null (unverifiable), never a pass', () => {
    expect(parseSheetVerdict(null)).toBeNull();
    expect(parseSheetVerdict([])).toBeNull();
    expect(parseSheetVerdict({ ...CLEAN_VERDICT, readable_text: 'false' })).toBeNull();
    expect(parseSheetVerdict({ ...CLEAN_VERDICT, figure_count: '3' })).toBeNull();
    expect(parseSheetVerdict({ ...CLEAN_VERDICT, figure_count: 3.5 })).toBeNull();
    expect(parseSheetVerdict({ ...CLEAN_VERDICT, likeness: 'high' })).toBeNull();
    expect(parseSheetVerdict({ ...CLEAN_VERDICT, likeness: NaN })).toBeNull();
    expect(parseSheetVerdict({ ...CLEAN_VERDICT, anatomy_ok: undefined })).toBeNull();
    expect(parseSheetVerdict({ ...CLEAN_VERDICT, cover_identity_matches: undefined })).toBeNull();
    expect(parseSheetVerdict({ ...CLEAN_VERDICT, cover_outfit_matches: 'true' })).toBeNull();
  });
  test('passes only the closed set of conditions and clamps likeness into 0-1', () => {
    expect(parseSheetVerdict(CLEAN_VERDICT)).toEqual({ pass: true, defects: [], likeness: 0.8, photoLikeness: null });
    expect(parseSheetVerdict({ ...CLEAN_VERDICT, likeness: 7 }).likeness).toBe(1);
    expect(parseSheetVerdict({ ...CLEAN_VERDICT, likeness: -2 }).likeness).toBe(0);
    expect(parseSheetVerdict({ ...CLEAN_VERDICT, figure_count: 4 })).toEqual({ pass: false, defects: ['4 full-body figures (expected 3)'], likeness: 0.8, photoLikeness: null });
  });
  test('photo_likeness is optional: clamped when a finite number, null otherwise — never a malformed verdict', () => {
    expect(parseSheetVerdict({ ...CLEAN_VERDICT, photo_likeness: 0.62 }).photoLikeness).toBe(0.62);
    expect(parseSheetVerdict({ ...CLEAN_VERDICT, photo_likeness: 3 }).photoLikeness).toBe(1);
    expect(parseSheetVerdict({ ...CLEAN_VERDICT, photo_likeness: -1 }).photoLikeness).toBe(0);
    expect(parseSheetVerdict({ ...CLEAN_VERDICT, photo_likeness: 'high' })).toMatchObject({ pass: true, photoLikeness: null });
    expect(parseSheetVerdict({ ...CLEAN_VERDICT, photo_likeness: NaN })).toMatchObject({ pass: true, photoLikeness: null });
  });
  test('only own properties count — inherited fields never satisfy the schema', () => {
    const inherited = Object.create({ ...CLEAN_VERDICT });
    expect(parseSheetVerdict(inherited)).toBeNull();
  });
});

describe('sheetCandidateCount', () => {
  test('defaults to 3 and clamps CATALOG_SHEET_CANDIDATES into 1-4', () => {
    expect(sheetCandidateCount()).toBe(3);
    process.env.CATALOG_SHEET_CANDIDATES = '1';
    expect(sheetCandidateCount()).toBe(1);
    process.env.CATALOG_SHEET_CANDIDATES = '4';
    expect(sheetCandidateCount()).toBe(4);
    process.env.CATALOG_SHEET_CANDIDATES = '9';
    expect(sheetCandidateCount()).toBe(3);
    process.env.CATALOG_SHEET_CANDIDATES = '0';
    expect(sheetCandidateCount()).toBe(3);
    process.env.CATALOG_SHEET_CANDIDATES = 'two';
    expect(sheetCandidateCount()).toBe(3);
  });
  test('the knob bounds the number of renders', async () => {
    process.env.CATALOG_SHEET_CANDIDATES = '1';
    installTransport([CLEAN_VERDICT]);
    const sheet = await getCharacterSheet({ anchorUrl: freshAnchor(), refPhoto: REF });
    expect(imageCalls()).toHaveLength(1);
    expect(sheet.candidates).toBe(1);
  });
});

describe('determinism', () => {
  test('buildSheetPrompt is pure for the same inputs and fixed apart from the sanitized child lines', () => {
    const a = buildSheetPrompt({ profile: PROFILE, characterDescription: 'freckles', hasChildPhoto: true });
    const b = buildSheetPrompt({ profile: { ...PROFILE }, characterDescription: 'freckles', hasChildPhoto: true });
    expect(a).toBe(b);
    expect(a).toContain('front view');
    expect(a).toContain('three-quarter view');
    expect(a).toContain('back view');
    expect(a).toContain('two small head-and-shoulders insets');
    expect(a).toContain('flat light-grey studio background');
    expect(a).toContain('exactly two arms and two hands with exactly five clearly separated fingers');
    expect(a).toContain('NO text, letters, labels, numbers');
    expect(a).not.toContain('REFERENCE 2');
    expect(a).toContain('must never override it or redesign the child');
    expect(buildSheetPrompt({})).not.toContain('The child is');
    expect(buildSheetPrompt({})).not.toContain('REFERENCE 2');
  });
  test('paths derive from the anchor PATH only and pin STYLE_VERSION', () => {
    const h = anchorHash('https://covers.example/a/b.png?sig=1');
    expect(h).toBe(anchorHash('https://covers.example/a/b.png?sig=2'));
    expect(h).toBe(fnv1a('https://covers.example/a/b.png').toString(36));
    expect(characterSheetPath(h)).toBe(`catalog-assets/character-sheets/${STYLE_VERSION}/${h}.png`);
    expect(characterSheetSidecarPath(h)).toBe(`catalog-assets/character-sheets/${STYLE_VERSION}/${h}.json`);
  });
});

const outfitMismatch = {
  ...CLEAN_VERDICT, likeness: 0.9, cover_outfit_matches: false,
  outfit_findings: [{ slot: 'top', attribute: 'colour', reference_visibility: 'visible', expected: 'rose pink dress', observed: 'blue dress' }],
};
const run = (anchorUrl = freshAnchor(), more = {}) => getCharacterSheet({ anchorUrl, refPhoto: REF, childPhoto: PHOTO, profile: PROFILE, ...more });
const bytes = (i = 0) => CANDIDATE_PNGS[i].toString('base64');
const pngKeys = () => [...objects.keys()].filter(k => /candidate-\d\.png$/.test(k));

test('first complete passing sheet is saved and elected without buying unused candidates', async () => {
  installTransport([CLEAN_VERDICT]);
  const costTracker = { addImageGeneration: jest.fn() };
  const anchorUrl = freshAnchor();
  const sheet = await run(anchorUrl, { costTracker });
  expect(sheet).toMatchObject({ base64: bytes(), likeness: 0.8, candidates: 1, storageKey: characterSheetPath(anchorHash(anchorUrl)) });
  expect(imageCalls()).toHaveLength(1);
  expect(judgeCalls()).toHaveLength(1);
  expect(pngKeys()).toHaveLength(1);
  expect(costTracker.addImageGeneration).toHaveBeenCalledTimes(1);
  const body = JSON.parse(imageCalls()[0][1].body);
  expect(body.safetySettings).toEqual(GEMINI_IMAGE_SAFETY_SETTINGS);
  expect(body.contents[0].parts.filter(p => p.inline_data)).toEqual([{ inline_data: { mimeType: REF.mimeType, data: REF.base64 } }]);
  expect(JSON.stringify(body)).not.toContain(PHOTO.base64);
  const check = JSON.parse(judgeCalls()[0][1].body);
  expect(check.contents[0].parts.filter(p => p.inline_data).map(p => p.inline_data.data)).toEqual([bytes(), REF.base64, PHOTO.base64]);
  const evidence = [...objects.entries()].find(([k]) => k.endsWith('/request.json'));
  expect(JSON.parse(evidence[1]).parts).toEqual(check.contents[0].parts);
});

test('repairs the specific visible clothing defect immediately, preserving the cover and previous completion', async () => {
  installTransport([outfitMismatch, { ...CLEAN_VERDICT, likeness: 0.95 }]);
  const sheet = await run();
  expect(sheet.base64).toBe(bytes(1));
  expect(imageCalls()).toHaveLength(2);
  expect(pngKeys()).toHaveLength(2);
  const repairParts = JSON.parse(imageCalls()[1][1].body).contents[0].parts;
  expect(repairParts.filter(p => p.inline_data).map(p => p.inline_data.data)).toEqual([REF.base64, bytes(0)]);
  expect(repairParts[3].text).toContain('cover shows rose pink dress; sheet shows blue dress');
  expect(repairParts[3].text).toContain('already completed hidden hems and shoes');
  expect(repairParts[3].text).toContain('approved cover remains authoritative');
});

test('all required identity, anatomy, layout and text checks remain blocking through the repair budget', async () => {
  installTransport([
    { ...CLEAN_VERDICT, cover_identity_matches: false, likeness: 1 },
    { ...CLEAN_VERDICT, anatomy_ok: false },
    { ...CLEAN_VERDICT, readable_text: true, figure_count: 2, feet_visible: false },
  ]);
  const anchorUrl = freshAnchor();
  const failure = await run(anchorUrl).catch(e => e);
  expect(failure).toMatchObject({ failureCode: 'visual_recovery_pending', recovery: { stage: 'character_sheet', reason: 'confirmed_defect', retryable: false } });
  expect(failure.message).toMatch(/readable text/);
  expect(objects.has(characterSheetPath(anchorHash(anchorUrl)))).toBe(false);
  expect(pngKeys()).toHaveLength(3);
  const calls = fetchWithTimeout.mock.calls.length;
  const again = await run(anchorUrl).catch(e => e);
  expect(again.message).toBe(failure.message);
  expect(again.message).not.toMatch(/cooldown/);
  expect(fetchWithTimeout).toHaveBeenCalledTimes(calls);
});

test('a restarted worker reuses the durable budget, images and verifier outcomes', async () => {
  installTransport([outfitMismatch, outfitMismatch, outfitMismatch]);
  const anchorUrl = freshAnchor();
  await expect(run(anchorUrl)).rejects.toHaveProperty('recovery.reason', 'confirmed_defect');
  jest.resetModules();
  const nextStorage = require('../../../services/gcsStorage');
  nextStorage.downloadBuffer.mockImplementation(async key => {
    if (!objects.has(key)) throw Object.assign(new Error('not found'), { code: 404 });
    return objects.get(key);
  });
  nextStorage.uploadBufferIfAbsent.mockImplementation(async (b, k) => {
    if (objects.has(k)) return { created: false };
    objects.set(k, b); return { created: true };
  });
  const nextFetch = require('../../../services/illustrationGenerator').fetchWithTimeout;
  nextFetch.mockReset();
  const nextWorker = require('../../../services/catalogEngine/illustrator/bible/characterSheet');
  await expect(nextWorker.getCharacterSheet({ anchorUrl, refPhoto: REF, childPhoto: PHOTO, profile: PROFILE })).rejects.toHaveProperty('recovery.reason', 'confirmed_defect');
  expect(nextFetch).not.toHaveBeenCalled();
});

test('a transient QA failure is rechecked immediately on resume using the SAME saved image', async () => {
  let checks = 0;
  installTransport([() => ++checks === 1 ? { ok: false, status: 503 } : qaResponse(CLEAN_VERDICT)]);
  const anchorUrl = freshAnchor();
  await expect(run(anchorUrl)).rejects.toMatchObject({ recovery: { retryable: true, reason: 'verification_unavailable' } });
  expect(imageCalls()).toHaveLength(1);
  expect(pngKeys()).toHaveLength(1);
  const sheet = await run(anchorUrl);
  expect(sheet.base64).toBe(bytes());
  expect(judgeCalls()).toHaveLength(2);
  expect(imageCalls()).toHaveLength(1);
});

test('an exhausted checker stays unverified and does not buy replacement images', async () => {
  installTransport([() => ({ ok: false, status: 503 })]);
  const anchorUrl = freshAnchor();
  await run(anchorUrl).catch(() => {});
  await expect(run(anchorUrl)).rejects.toMatchObject({ recovery: { retryable: false, reason: 'verification_unavailable' } });
  await expect(run(anchorUrl)).rejects.toMatchObject({ recovery: { retryable: false } });
  expect(judgeCalls()).toHaveLength(2);
  expect(imageCalls()).toHaveLength(1);
});

test('a vague or hidden-garment rejection is unverifiable, never a confirmed defect or permission to redraw', async () => {
  installTransport([{ ...outfitMismatch, outfit_findings: [] }]);
  await expect(run()).rejects.toMatchObject({ recovery: { reason: 'verification_unavailable', retryable: false } });
  expect(imageCalls()).toHaveLength(1);
  expect(judgeCalls()).toHaveLength(2);
  expect(parseSheetVerdict({ ...outfitMismatch, outfit_findings: [{ ...outfitMismatch.outfit_findings[0], reference_visibility: 'not_visible' }] }, { detailed: true })).toBeNull();
  expect(parseSheetVerdict({ ...outfitMismatch, cover_outfit_matches: true }, { detailed: true })).toBeNull();
  expect(buildSheetQaPrompt(true)).toContain('Ignore the held bell');
  expect(buildSheetQaPrompt(true)).toContain('never reject them for differing from an invisible reference');
});

test('a malformed answer can recover by rechecking, with no image replacement', async () => {
  let calls = 0;
  installTransport([() => qaResponse(++calls === 1 ? 'not JSON' : CLEAN_VERDICT)]);
  expect((await run()).base64).toBe(bytes());
  expect(imageCalls()).toHaveLength(1);
  expect(judgeCalls()).toHaveLength(2);
});

test('a provider QA block stops with exact saved evidence; repeated resumes do not bypass it', async () => {
  installTransport([() => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] }) })]);
  const anchorUrl = freshAnchor();
  const failure = await run(anchorUrl).catch(e => e);
  expect(failure.recovery).toMatchObject({ reason: 'provider_blocked', retryable: false });
  expect(failure.recovery.issues[0]).toMatchObject({ finishReason: 'PROHIBITED_CONTENT', fingerprint: expect.any(String), evidenceKey: expect.stringContaining('/request.json') });
  await run(anchorUrl).catch(() => {});
  expect(imageCalls()).toHaveLength(1);
  expect(judgeCalls()).toHaveLength(1);
});

test('a render provider block does not trigger alternative generation slots', async () => {
  fetchWithTimeout.mockResolvedValue({ ok: true, json: async () => ({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }) });
  const anchorUrl = freshAnchor();
  await expect(run(anchorUrl)).rejects.toMatchObject({ recovery: { reason: 'provider_blocked' } });
  await run(anchorUrl).catch(() => {});
  expect(imageCalls()).toHaveLength(1);
  expect(judgeCalls()).toHaveLength(0);
});

test('a known failed render moves to the next bounded slot without a cooldown', async () => {
  installTransport([CLEAN_VERDICT, CLEAN_VERDICT], { imageFailures: [0] });
  expect((await run()).base64).toBe(bytes(1));
  expect(imageCalls()).toHaveLength(2);
  expect(judgeCalls()).toHaveLength(1);
});

test('all failed renders retain their reasons across retries and cannot exceed the reserved budget', async () => {
  installTransport([], { imageFailures: [0, 1, 2] });
  const anchorUrl = freshAnchor();
  await expect(run(anchorUrl)).rejects.toMatchObject({ recovery: { retryable: false } });
  const calls = imageCalls().length;
  await run(anchorUrl).catch(() => {});
  expect(imageCalls()).toHaveLength(calls);
  expect(calls).toBe(3);
});

test('storage read or reservation failures stop before any paid work', async () => {
  downloadBuffer.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { code: 403 }));
  await expect(run()).rejects.toHaveProperty('recovery.reason', 'configuration');
  expect(fetchWithTimeout).not.toHaveBeenCalled();
  uploadBufferIfAbsent.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(run()).rejects.toHaveProperty('recovery.reason', 'configuration');
  expect(fetchWithTimeout).not.toHaveBeenCalled();
});

test('an election outage retains verified candidates so immediate retry only saves the winner', async () => {
  installTransport([CLEAN_VERDICT]);
  const anchorUrl = freshAnchor();
  const canonical = characterSheetPath(anchorHash(anchorUrl));
  const upload = uploadBufferIfAbsent.getMockImplementation();
  uploadBufferIfAbsent.mockImplementation(async (...args) => {
    if (args[1] === canonical) throw new Error('temporary election outage');
    return upload(...args);
  });
  await expect(run(anchorUrl)).rejects.toHaveProperty('recovery.reason', 'configuration');
  uploadBufferIfAbsent.mockImplementation(upload);
  expect((await run(anchorUrl)).base64).toBe(bytes());
  expect(imageCalls()).toHaveLength(1);
  expect(judgeCalls()).toHaveLength(1);
});

test('a simultaneous election adopts the other verified winner and its metadata', async () => {
  installTransport([CLEAN_VERDICT]);
  const anchorUrl = freshAnchor();
  const canonical = characterSheetPath(anchorHash(anchorUrl));
  const upload = uploadBufferIfAbsent.getMockImplementation();
  uploadBufferIfAbsent.mockImplementation(async (...args) => {
    if (args[1] === canonical) {
      objects.set(canonical, CANDIDATE_PNGS[2]);
      objects.set(characterSheetSidecarPath(anchorHash(anchorUrl)), Buffer.from(JSON.stringify({ likeness: 0.94, candidates: 2 })));
      return { created: false };
    }
    return upload(...args);
  });
  expect(await run(anchorUrl)).toMatchObject({ base64: bytes(2), likeness: 0.94 });
});

test('an active cross-process render reservation is not mistaken for a completed failure', async () => {
  const upload = uploadBufferIfAbsent.getMockImplementation();
  uploadBufferIfAbsent.mockImplementation(async (b, k, type) => {
    if (k.endsWith('candidate-0.claim.json')) {
      objects.set(k, b); return { created: false };
    }
    return upload(b, k, type);
  });
  await expect(run()).rejects.toMatchObject({ recovery: { issues: [expect.objectContaining({ reason: 'A character sheet is already being generated' })] } });
  expect(fetchWithTimeout).not.toHaveBeenCalled();
});

test('same-process concurrent callers share a sheet and re-signed URLs reuse the elected reference', async () => {
  installTransport([CLEAN_VERDICT]);
  const anchorUrl = freshAnchor();
  const [a, b] = await Promise.all([run(anchorUrl), run(anchorUrl)]);
  expect(a).toEqual(b);
  expect((await run(anchorUrl.replace('sig=abc', 'sig=next'))).base64).toBe(a.base64);
  expect(imageCalls()).toHaveLength(1);
  b.advisories.push({ stage: 'x', note: 'caller edit' });
  expect((await run(anchorUrl)).advisories).toEqual([]);
});

test('verified legacy sheets remain usable without regeneration', async () => {
  const anchorUrl = freshAnchor();
  objects.set(characterSheetPath(anchorHash(anchorUrl)), CANDIDATE_PNGS[0]);
  objects.set(characterSheetSidecarPath(anchorHash(anchorUrl)), Buffer.from(JSON.stringify({ likeness: 0.9, photoLikeness: 0.75, candidates: 3 })));
  expect(await run(anchorUrl)).toMatchObject({ base64: bytes(), likeness: 0.9, photoLikeness: 0.75 });
  expect(fetchWithTimeout).not.toHaveBeenCalled();
});

test('low photo likeness is advisory; approved cover identity remains authoritative', async () => {
  installTransport([{ ...CLEAN_VERDICT, likeness: 0.9, photo_likeness: 0.3 }]);
  expect(await run()).toMatchObject({ likeness: 0.9, photoLikeness: 0.3, advisories: [expect.objectContaining({ note: expect.stringContaining('review the cover') })] });
});

test('sheet kill switch remains the only null result; invalid anchors do no work', async () => {
  process.env.CATALOG_CHARACTER_SHEET = '0';
  expect(await run()).toBeNull();
  delete process.env.CATALOG_CHARACTER_SHEET;
  await expect(run('', { refPhoto: REF })).rejects.toHaveProperty('failureCode', FAILURE_CODE);
  expect(fetchWithTimeout).not.toHaveBeenCalled();
});

test('caller image metadata and a larger runtime limit cannot reset an existing image budget', async () => {
  installTransport([outfitMismatch, outfitMismatch, outfitMismatch, CLEAN_VERDICT]);
  const anchorUrl = freshAnchor();
  await expect(run(anchorUrl)).rejects.toHaveProperty('recovery.reason', 'confirmed_defect');
  process.env.CATALOG_SHEET_CANDIDATES = '4';
  await expect(run(anchorUrl, { refPhoto: { mimeType: 'image/png', base64: REF.base64, transportMetadata: 'changed' } })).rejects.toHaveProperty('recovery.reason', 'confirmed_defect');
  expect(imageCalls()).toHaveLength(3);
});
