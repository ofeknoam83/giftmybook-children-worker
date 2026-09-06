process.env.CATALOG_CHARACTER_SHEET = '0';
process.env.CATALOG_PROP_SHEETS = '0';
process.env.CATALOG_EMOTION_PLAN = '0';
process.env.CATALOG_OUTFIT_LOCK = '0';

jest.mock('../../../services/illustrationGenerator', () => ({
  generateIllustration: jest.fn(),
  verifyImageText: jest.fn((buffer, text) => require('../../../services/shared/illustration/manuscript').verifyManuscript(text, async () => text)),
  downloadPhotoAsBase64: jest.fn().mockResolvedValue({ base64: 'b64', mimeType: 'image/jpeg' }),
  fetchWithTimeout: jest.fn().mockRejectedValue(new Error('offline test')),
  getNextApiKey: jest.fn().mockReturnValue('test-key'),
  isModestBathWaterScene: jest.fn().mockReturnValue(false),
}));
jest.mock('../../../services/catalogEngine/illustrator/textAnchor', () => ({
  ...jest.requireActual('../../../services/catalogEngine/illustrator/textAnchor'),
  electTypographyAnchor: jest.fn(),
}));
jest.mock('../../../services/gcsStorage', () => ({
  objectExists: jest.fn(),
  downloadBuffer: jest.fn(), uploadBuffer: jest.fn(),
  uploadBufferIfAbsent: jest.fn(), deletePrefix: jest.fn(),
  getSignedUrl: jest.fn(async key => `https://signed.example/${key}`),
}));

const { illustrateStory } = require('../../../services/catalogEngine/illustrator');
const { getBook } = require('../../../services/catalogEngine/catalog');
const { fnv1a } = require('../../../services/catalogEngine/selection');
const { QA_VERSION } = require('../../../services/catalogEngine/versions');
const { generateIllustration, verifyImageText } = require('../../../services/illustrationGenerator');
const { electTypographyAnchor } = require('../../../services/catalogEngine/illustrator/textAnchor');
const { objectExists, downloadBuffer, uploadBuffer, uploadBufferIfAbsent, deletePrefix } = require('../../../services/gcsStorage');

const spreads = Array.from({ length: 12 }, (_, i) => i + 1);
const params = () => ({
  bookId: 'review-book',
  story: { book_id: 'farm_2_3_hello_farm', spreads: spreads.map(spread => ({ spread, text: `Page ${spread}.` })), personalization_evidence: [] },
  bookDef: getBook('farm_2_3_hello_farm'),
  profile: { name: 'Emma', age: 2, pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' } },
  childPhotoUrl: 'https://photos.example/child.png?signature=original',
  textLayout: 'embedded', reviewedOnly: true, log: () => {},
});
const bytes = spread => Buffer.from(`approved-art-${spread}`);
const marker = spread => ({ renderHash: fnv1a(bytes(spread).toString('base64')).toString(36), qaVersion: QA_VERSION, adminPicked: true });
const missing = () => Object.assign(new Error('No such object'), { code: 404 });
let objects;
let oldPin;
let invalidMarker;
let missingSpread;
beforeEach(() => {
  process.env.CATALOG_SHIP_ON_EXHAUSTION = '0';
  jest.clearAllMocks();
  verifyImageText.mockImplementation((buffer, text) => require('../../../services/shared/illustration/manuscript').verifyManuscript(text, async () => text));
  objects = new Map(); oldPin = false; invalidMarker = null; missingSpread = null;
  downloadBuffer.mockImplementation(async key => {
    if (objects.has(key)) return objects.get(key);
    if (oldPin && /\/typo-anchor\.wide\.json$/.test(key)) {
      return Buffer.from(JSON.stringify({ spread: 1, side: 'right', png: Buffer.from('erroneously-elected-crop').toString('base64') }));
    }
    // All original renders were made without an anchor. A later buggy retry
    // may have pinned one, but its suffixed render namespace has no images.
    const match = /\/spread-(\d+)\.wide\.png(\.qa\.json)?$/.exec(key);
    if (match && !/-ta[^/]*\//.test(key)) {
      const spread = Number(match[1]);
      if (spread === missingSpread) throw missing();
      if (match[2]) return Buffer.from(JSON.stringify({ ...marker(spread), ...(invalidMarker || {}) }));
      return bytes(spread);
    }
    throw missing();
  });
  objectExists.mockImplementation(async key => {
    try { await downloadBuffer(key); return true; }
    catch (err) { if (err.code === 404) return false; throw err; }
  });
  uploadBuffer.mockImplementation(async (buffer, key) => { objects.set(key, buffer); });
});

afterEach(() => {
  expect(generateIllustration).not.toHaveBeenCalled();
  expect(electTypographyAnchor).not.toHaveBeenCalled();
  expect(uploadBufferIfAbsent).not.toHaveBeenCalled();
  expect(deletePrefix).not.toHaveBeenCalled();
  // Legacy recovery also saves the existing bible metadata. Neither path may
  // write an image or typography pin. A new spelling audit may update QA metadata.
  expect(uploadBuffer.mock.calls.every(([, key]) => (/\/(reviewed-art|bible)\.json$/.test(key) || key.endsWith('.qa.json')))).toBe(true);
});

test.each([false, true])('all twelve approved spreads replay unchanged, including a previous buggy pin: %s', async pin => {
  oldPin = pin;
  const result = await illustrateStory(params());
  expect(result.entries).toHaveLength(12);
  for (const entry of result.entries) {
    expect(entry.spreadIllustrationBuffer.equals(bytes(entry.spread))).toBe(true);
    expect(entry.spreadIllustrationStorageKey).not.toMatch(/-ta[^/]*\//);
    expect(entry.textEmbeddedInArt).toBe(true);
  }
  const saved = JSON.parse(objects.get('children-jobs/review-book/reviewed-art.json'));
  expect(Object.keys(saved.renderKeys)).toHaveLength(12);
});

test('a saved manifest replays the exact paths despite changed typography settings or active tuning', async () => {
  const original = await illustrateStory(params());
  oldPin = true;
  process.env.CATALOG_TEXT_ANCHOR = '0';
  try {
    const replay = await illustrateStory({ ...params(), childPhotoUrl: 'https://photos.example/child.png?signature=renewed', tuning: { versionLabel: 'changed', hash: '0123456789abcdef', text: 'New art direction' } });
    expect(replay.entries.map(e => e.spreadIllustrationStorageKey)).toEqual(original.entries.map(e => e.spreadIllustrationStorageKey));
    expect(replay.typographyAnchorUsed).toBe(original.typographyAnchorUsed);
    expect(replay.illustrationTuningUsed).toBe(original.illustrationTuningUsed);
  } finally { delete process.env.CATALOG_TEXT_ANCHOR; }
});

test.each([
  { renderHash: 'wrong-pixels' },
  { unresolved: true },
  { qaVersion: 'obsolete-checker' },
])('unapproved or mismatched artwork stops the rebuild without replacements: %j', async badMarker => {
  oldPin = true; invalidMarker = badMarker;
  await expect(illustrateStory(params())).rejects.toMatchObject({ failureCode: 'reviewed_art_unavailable' });
  expect(objects.has('children-jobs/review-book/reviewed-art.json')).toBe(false);
});

test('an unavailable saved render does not replace the manifest or fall back to a different version', async () => {
  await illustrateStory(params());
  const saved = objects.get('children-jobs/review-book/reviewed-art.json');
  missingSpread = 7; uploadBuffer.mockClear();
  await expect(illustrateStory(params())).rejects.toMatchObject({ failureCode: 'reviewed_art_unavailable', message: expect.stringContaining('spread(s) 7') });
  expect(objects.get('children-jobs/review-book/reviewed-art.json')).toEqual(saved);
  expect(uploadBuffer).not.toHaveBeenCalled();
});

test('a different layout or identity cannot use the saved manifest', async () => {
  await illustrateStory(params());
  await expect(illustrateStory({ ...params(), textLayout: 'half' })).rejects.toThrow('different story, layout, or identity');
  await expect(illustrateStory({ ...params(), childPhotoUrl: 'https://photos.example/different-child.png' })).rejects.toThrow('different story, layout, or identity');
});

test('a manifest cannot reference another book or a candidate instead of canonical art', async () => {
  await illustrateStory(params());
  const path = 'children-jobs/review-book/reviewed-art.json';
  const saved = JSON.parse(objects.get(path));
  saved.renderKeys[7] = saved.renderKeys[7].replace('/review-book/', '/other-book/');
  objects.set(path, Buffer.from(JSON.stringify(saved)));
  await expect(illustrateStory(params())).rejects.toThrow('path is invalid for spread 7');
});

test('a storage permission error is not treated as a missing manifest', async () => {
  downloadBuffer.mockRejectedValue(Object.assign(new Error('Access denied'), { code: 403 }));
  await expect(illustrateStory(params())).rejects.toThrow('Access denied');
});

test('legacy recovery never falls back past a corrupt marker at the pinned path', async () => {
  const original = await illustrateStory(params());
  objects.delete('children-jobs/review-book/reviewed-art.json');
  oldPin = true;
  const pinHash = fnv1a(Buffer.from('erroneously-elected-crop').toString('base64')).toString(36).slice(0, 8);
  const key = original.entries[6].spreadIllustrationStorageKey.replace('/spread-7', `-ta${pinHash}/spread-7`);
  objects.set(key, Buffer.from('different-pixels'));
  objects.set(`${key}.qa.json`, Buffer.from(JSON.stringify(marker(7))));
  await expect(illustrateStory(params())).rejects.toMatchObject({ failureCode: 'reviewed_art_unavailable', message: expect.stringContaining('spread(s) 7') });
});

test.each([true, false])('automatic completion keeps cached winners and QA warnings without generating: reviewedOnly=%s', async reviewedOnly => {
  delete process.env.CATALOG_SHIP_ON_EXHAUSTION;
  invalidMarker = { unresolved: true, qa: { blocking: ['outfit break: jacket differs'], score: -80 } };
  const result = await illustrateStory({ ...params(), reviewedOnly });
  expect(result.entries).toHaveLength(12);
  expect(result.qaAdvisories).toContainEqual(expect.objectContaining({ stage: 'shipPolicy', note: expect.stringContaining('Automatically used') }));
});

test.each(['mismatch', 'unverified'])('an admin pick cannot bypass a %s manuscript check', async status => {
  const { verifyManuscript } = require('../../../services/shared/illustration/manuscript');
  process.env.CATALOG_SHIP_ON_EXHAUSTION = '1';
  verifyImageText.mockImplementation(async (buffer, text) => {
    const good = await verifyManuscript(text, async () => text);
    return text === 'Page 7.' ? { ...good, status, valid: false, issues: ['Test text problem'] } : good;
  });
  await expect(illustrateStory(params())).rejects.toMatchObject({
    failureCode: 'consistency_unresolved', unresolved: [expect.objectContaining({ spread: 7 })],
  });
  expect(verifyImageText).toHaveBeenCalledTimes(12);
});

test('spelling verification is cached against both artwork bytes and the approved manuscript', async () => {
  await illustrateStory(params());
  expect(verifyImageText).toHaveBeenCalledTimes(12);
  verifyImageText.mockClear();
  await illustrateStory(params());
  expect(verifyImageText).not.toHaveBeenCalled();
});
