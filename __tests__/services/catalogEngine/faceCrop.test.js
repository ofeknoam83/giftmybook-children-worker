/**
 * faceCrop — the character sheet's likeness references (2026-09-07): the
 * child's photo upright + a tight face crop from one strict-JSON locate
 * read. Fail-open everywhere: no decodable photo, no judge, no plausible
 * box ⇒ the raw photo and no crop, never a throw.
 */

jest.mock('../../../services/illustrationGenerator', () => ({
  getNextApiKey: jest.fn(() => 'test-key'),
  fetchWithTimeout: jest.fn(),
}));

const sharp = require('sharp');
const { fetchWithTimeout } = require('../../../services/illustrationGenerator');
const {
  prepareLikenessReferences, locateFace, normalizeFaceBox, faceCropRect, LOCATE_PROMPT, CROP_PAD,
} = require('../../../services/catalogEngine/illustrator/bible/faceCrop');

const jsonResponse = obj => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }) });
const decode = b64 => sharp(Buffer.from(b64, 'base64')).metadata();

let PHOTO; // 64×48 JPEG
beforeAll(async () => {
  const buf = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#a0b0c0' } }).jpeg().toBuffer();
  PHOTO = { base64: buf.toString('base64'), mimeType: 'image/jpeg' };
});
beforeEach(() => { fetchWithTimeout.mockReset(); });

describe('normalizeFaceBox', () => {
  test('accepts a plausible unit-square box, clamps a box that runs off the frame', () => {
    expect(normalizeFaceBox({ x: 0.3, y: 0.2, w: 0.3, h: 0.4 })).toEqual({ x: 0.3, y: 0.2, w: 0.3, h: 0.4 });
    expect(normalizeFaceBox({ x: 0.8, y: 0.8, w: 0.5, h: 0.5 })).toEqual({ x: 0.8, y: 0.8, w: expect.closeTo(0.2, 10), h: expect.closeTo(0.2, 10) });
  });
  test('tolerates a percent-scaled answer (the app\'s analyze-photo dialect)', () => {
    expect(normalizeFaceBox({ x: 30, y: 20, w: 30, h: 40 })).toEqual({ x: 0.3, y: 0.2, w: 0.3, h: 0.4 });
  });
  test('rejects non-numbers, inherited fields, a sliver, the whole frame, and a box outside the frame', () => {
    expect(normalizeFaceBox(null)).toBeNull();
    expect(normalizeFaceBox([0.1, 0.1, 0.2, 0.2])).toBeNull();
    expect(normalizeFaceBox({ x: '0.3', y: 0.2, w: 0.3, h: 0.4 })).toBeNull();
    expect(normalizeFaceBox({ x: 0.3, y: 0.2, w: 0.3 })).toBeNull();
    expect(normalizeFaceBox(Object.create({ x: 0.3, y: 0.2, w: 0.3, h: 0.4 }))).toBeNull();
    expect(normalizeFaceBox({ x: 0.3, y: 0.2, w: 0.01, h: 0.01 })).toBeNull(); // 0.0001 of the frame: not a face
    expect(normalizeFaceBox({ x: 0, y: 0, w: 1, h: 1 })).toBeNull(); // the whole frame
    expect(normalizeFaceBox({ x: 1.2, y: 0.2, w: 0.3, h: 0.4 })).toBeNull(); // 120%: not a percent dialect either
    expect(normalizeFaceBox({ x: -0.1, y: 0.2, w: 0.3, h: 0.4 })).toBeNull();
    expect(normalizeFaceBox({ x: 0.3, y: 0.2, w: 0, h: 0.4 })).toBeNull();
  });
});

describe('faceCropRect', () => {
  test('pads the longer side by CROP_PAD on each side, squares around the centre, stays inside the frame', () => {
    expect(CROP_PAD).toBe(0.55);
    const r = faceCropRect({ x: 0.3, y: 0.2, w: 0.3, h: 0.4 }, 1000, 1000);
    // box 300×400 → side 400 × 2.1 = 840, centred on (450, 400) → clamped to the top edge
    expect(r).toEqual({ left: 30, top: 0, width: 840, height: 840 });
    const r2 = faceCropRect({ x: 0.45, y: 0.45, w: 0.1, h: 0.1 }, 2000, 1000);
    expect(r2.width).toBe(r2.height);
    expect(r2.width).toBe(Math.round(200 * 2.1)); // the LONGER side (200 px of the 2000-px width) pads the square
    expect(r2.left + r2.width).toBeLessThanOrEqual(2000);
    expect(r2.top + r2.height).toBeLessThanOrEqual(1000);
  });
  test('a face larger than the short edge yields the short edge, never a crop off the frame', () => {
    const r = faceCropRect({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, 640, 480);
    expect(r).toEqual({ left: 80, top: 0, width: 480, height: 480 });
  });
});

describe('prepareLikenessReferences', () => {
  test('re-encodes the photo upright and crops the located face; ONE locate read carries the upright photo', async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse({ found: true, face_bbox: { x: 0.3, y: 0.2, w: 0.3, h: 0.4 } }));
    const log = jest.fn();
    const out = await prepareLikenessReferences(PHOTO, { log });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    const [url, init, timeout] = fetchWithTimeout.mock.calls[0];
    expect(url).toContain('gemini-2.5-flash');
    expect(timeout).toBe(30000);
    const body = JSON.parse(init.body);
    expect(body.contents[0].parts[0].text).toBe(LOCATE_PROMPT);
    expect(body.contents[0].parts[1].inline_data.data).toBe(out.photo.base64);
    expect(body.generationConfig).toMatchObject({ temperature: 0, responseMimeType: 'application/json' });
    expect(out.photo.mimeType).toBe('image/jpeg');
    expect(await decode(out.photo.base64)).toMatchObject({ width: 64, height: 48, format: 'jpeg' });
    expect(out.box).toEqual({ x: 0.3, y: 0.2, w: 0.3, h: 0.4 });
    const face = await decode(out.face.base64);
    expect(face.format).toBe('jpeg');
    expect(face.width).toBe(face.height);
    expect(face.width).toBe(40); // max(19.2, 19.2) × 2.1 = 40.3 → 40, inside the 48-px short edge
    expect(log).toHaveBeenCalledWith('info', expect.stringMatching(/^face crop derived \(40×40 px at 9,0 of 64×48\)/));
  });

  test('applies EXIF orientation before locating: a sideways phone photo comes back upright and the crop follows', async () => {
    const rotated = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#a0b0c0' } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    fetchWithTimeout.mockResolvedValue(jsonResponse({ found: true, face_bbox: { x: 0.25, y: 0.25, w: 0.5, h: 0.4 } }));
    const out = await prepareLikenessReferences({ base64: rotated.toString('base64'), mimeType: 'image/jpeg' });
    const meta = await decode(out.photo.base64);
    expect([meta.width, meta.height]).toEqual([48, 64]);
    expect(meta.orientation).toBeUndefined();
    expect(out.face).not.toBeNull();
  });

  test('caps the long edge at 1536 px without enlarging small photos', async () => {
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#ffffff' } }).jpeg({ quality: 50 }).toBuffer();
    fetchWithTimeout.mockResolvedValue(jsonResponse({ found: false, face_bbox: null }));
    const out = await prepareLikenessReferences({ base64: big.toString('base64'), mimeType: 'image/jpeg' });
    expect(await decode(out.photo.base64)).toMatchObject({ width: 1536, height: 1152 });
    expect(out.face).toBeNull();
  });

  test('an undecodable photo passes through untouched with no locate read', async () => {
    const raw = { base64: 'cGhvdG8=', mimeType: 'image/jpeg' };
    const log = jest.fn();
    const out = await prepareLikenessReferences(raw, { log });
    expect(out).toEqual({ photo: raw, face: null, box: null });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('warn', expect.stringMatching(/could not be normalized .* no face crop$/));
    expect(await prepareLikenessReferences({ base64: '' })).toMatchObject({ face: null, box: null });
  });

  test('a locate outage, a "no face", an unparseable or implausible answer each yield the upright photo and no crop (fail-open)', async () => {
    fetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'busy' });
    expect((await prepareLikenessReferences(PHOTO)).face).toBeNull();
    fetchWithTimeout.mockResolvedValueOnce(jsonResponse({ found: false, face_bbox: null }));
    expect((await prepareLikenessReferences(PHOTO)).face).toBeNull();
    fetchWithTimeout.mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'no json here' }] } }] }) });
    expect((await prepareLikenessReferences(PHOTO)).face).toBeNull();
    fetchWithTimeout.mockResolvedValueOnce(jsonResponse({ found: true, face_bbox: { x: 0.5, y: 0.5, w: 0.001, h: 0.001 } }));
    expect((await prepareLikenessReferences(PHOTO)).face).toBeNull();
    fetchWithTimeout.mockRejectedValueOnce(new Error('socket hangup'));
    const out = await prepareLikenessReferences(PHOTO);
    expect(out.face).toBeNull();
    expect(await decode(out.photo.base64)).toMatchObject({ width: 64, height: 48 });
  });

  test('locateFace never throws and ignores a hostile verdict shape', async () => {
    fetchWithTimeout.mockResolvedValueOnce(jsonResponse({ found: 'yes', face_bbox: { x: 0.3, y: 0.2, w: 0.3, h: 0.4 } }));
    expect(await locateFace(PHOTO)).toBeNull();
    fetchWithTimeout.mockResolvedValueOnce(jsonResponse({ __proto__: { found: true }, face_bbox: null }));
    expect(await locateFace(PHOTO)).toBeNull();
    expect({}.found).toBeUndefined();
  });
});
