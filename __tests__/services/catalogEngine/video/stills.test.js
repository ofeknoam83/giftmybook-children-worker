/**
 * Start frames (gv-1): the canonical-key validator, the source fetch
 * failure code, the 16:9 preparation (blur-fill), and the text gate's
 * verdicts (blocking text, fail-open outage, malformed verdict).
 */

jest.mock('../../../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(), uploadBuffer: jest.fn(), uploadBufferIfAbsent: jest.fn(), getSignedUrl: jest.fn(), deletePrefix: jest.fn(), saveJson: jest.fn(), loadJson: jest.fn(), objectExists: jest.fn(),
}));
jest.mock('../../../../services/illustrationGenerator', () => ({
  fetchWithTimeout: jest.fn(), getNextApiKey: jest.fn(() => 'test-key'), downloadPhotoAsBase64: jest.fn(), isModestBathWaterScene: jest.fn(() => false),
}));

const sharp = require('sharp');
const { downloadBuffer } = require('../../../../services/gcsStorage');
const { fetchWithTimeout } = require('../../../../services/illustrationGenerator');
const { validateRenders, fetchStill, prepareStartFrame, textGate, contentHash } = require('../../../../services/catalogEngine/video/stills');

const key = (spread, aspect = 'wide-plain', book = 'b1') => `children-jobs/${book}/ce-renders/ce-9/abc-b12/spread-${spread}.${aspect}.png`;

describe('validateRenders', () => {
  test('accepts canonical keys of this book and flags embedded ones', () => {
    const r = validateRenders('b1', [{ spread: 2, storageKey: key(2, 'wide') }, { spread: 1, storageKey: key(1) }, { spread: 3, storageKey: key(3, 'square') }]);
    expect(r.ok).toBe(true);
    expect(r.entries.map(e => [e.spread, e.aspect, e.embedded])).toEqual([[1, 'wide-plain', false], [2, 'wide', true], [3, 'square', false]]);
  });
  test('rejects another book, candidate keys, traversal, mismatched spreads, duplicates, bad counts', () => {
    expect(validateRenders('b1', [{ spread: 1, storageKey: key(1, 'wide-plain', 'b2') }]).error).toMatch(/another book/);
    expect(validateRenders('b1', [{ spread: 1, storageKey: key(1).replace('.png', '.c1.png') }]).error).toMatch(/not a canonical/);
    expect(validateRenders('b1', [{ spread: 1, storageKey: 'children-jobs/b1/ce-renders/../x/spread-1.wide.png' }]).error).toMatch(/not a canonical/);
    expect(validateRenders('b1', [{ spread: 1, storageKey: key(2) }]).error).toMatch(/names spread 2/);
    expect(validateRenders('b1', [{ spread: 1, storageKey: key(1) }, { spread: 1, storageKey: key(1) }]).error).toMatch(/twice/);
    expect(validateRenders('b1', []).error).toMatch(/1-12/);
    expect(validateRenders('b1', [{ spread: 13, storageKey: key(13) }]).error).toMatch(/between 1 and 12/);
    expect(validateRenders('b1', 'nope').ok).toBe(false);
  });
});

describe('fetchStill', () => {
  test('a missing object is video_source_missing', async () => {
    downloadBuffer.mockRejectedValueOnce(new Error('404'));
    await expect(fetchStill(key(1), 'render of spread 1')).rejects.toMatchObject({ failureCode: 'video_source_missing' });
    downloadBuffer.mockResolvedValueOnce(Buffer.alloc(0));
    await expect(fetchStill(key(1), 'render of spread 1')).rejects.toMatchObject({ failureCode: 'video_source_missing' });
  });
  test('returns the bytes and their content hash', async () => {
    downloadBuffer.mockResolvedValueOnce(Buffer.from('png-bytes'));
    const r = await fetchStill(key(1), 'x');
    expect(r.hash).toBe(contentHash(Buffer.from('png-bytes')));
  });
});

describe('prepareStartFrame', () => {
  test('a 16:9 source is resized as is; a square source is blur-filled to 16:9', async () => {
    const wide = await sharp({ create: { width: 192, height: 108, channels: 3, background: '#3355aa' } }).png().toBuffer();
    const square = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#aa5533' } }).png().toBuffer();
    const a = await prepareStartFrame(wide, { width: 384, height: 216 });
    const b = await prepareStartFrame(square, { width: 384, height: 216 });
    expect(a.blurFilled).toBe(false);
    expect(b.blurFilled).toBe(true);
    const ma = await sharp(a.buffer).metadata();
    const mb = await sharp(b.buffer).metadata();
    expect([ma.width, ma.height, mb.width, mb.height]).toEqual([384, 216, 384, 216]);
    expect(a.mimeType).toBe('image/jpeg');
  });
});

describe('textGate', () => {
  const verdict = (json) => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }) });
  test('painted text fails the gate with the transcript', async () => {
    fetchWithTimeout.mockResolvedValueOnce(verdict({ text_present: true, transcript: 'Hello farm!' }));
    const r = await textGate(Buffer.from('x'));
    expect(r).toEqual({ pass: false, textPresent: true, transcript: 'Hello farm !' });
  });
  test('a clean frame passes', async () => {
    fetchWithTimeout.mockResolvedValueOnce(verdict({ text_present: false, transcript: '' }));
    expect(await textGate(Buffer.from('x'))).toEqual({ pass: true, textPresent: false, transcript: null });
  });
  test('an outage or a malformed verdict fails open with a named reason', async () => {
    fetchWithTimeout.mockRejectedValueOnce(new Error('offline'));
    expect((await textGate(Buffer.from('x'))).unavailable).toMatch(/errored: offline/);
    fetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 503 });
    expect((await textGate(Buffer.from('x'))).unavailable).toMatch(/HTTP 503/);
    fetchWithTimeout.mockResolvedValueOnce(verdict({ nope: true }));
    expect((await textGate(Buffer.from('x'))).unavailable).toMatch(/malformed/);
  });
});
