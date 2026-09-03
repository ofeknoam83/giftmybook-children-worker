/**
 * ce-15 — the typography anchor: the book's own first painted page (a
 * text-side crop at full height, never a whole sibling frame) as the type
 * reference for every other embedded spread; elected once per story
 * (pinned, single winner), fail-open.
 */

jest.mock('../../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(),
  uploadBuffer: jest.fn().mockResolvedValue(undefined),
  uploadBufferIfAbsent: jest.fn().mockResolvedValue({ created: true }),
}));

const sharp = require('sharp');
const { downloadBuffer, uploadBuffer, uploadBufferIfAbsent } = require('../../../services/gcsStorage');
const {
  anchorCropRect, cropTypographyAnchor, anchorHash, anchorPinPath, parsePin, readPinnedTypographyAnchor, electTypographyAnchor, ANCHOR_HALF_WIDTH, ANCHOR_MAX_HEIGHT,
} = require('../../../services/catalogEngine/illustrator/textAnchor');

const pinBlob = (spread, side, bytes) => Buffer.from(JSON.stringify({ spread, side, hash: anchorHash(bytes), png: bytes.toString('base64') }));

const png = (width, height) => sharp({ create: { width, height, channels: 3, background: { r: 120, g: 160, b: 200 } } }).png().toBuffer();

beforeEach(() => {
  downloadBuffer.mockReset();
  uploadBuffer.mockClear();
  uploadBufferIfAbsent.mockReset().mockResolvedValue({ created: true });
});

test('the crop is the fold-safe text-side half at FULL height (scale survives, composition does not)', async () => {
  expect(anchorCropRect('left')).toEqual({ x: 0, y: 0, w: ANCHOR_HALF_WIDTH, h: 1 });
  expect(anchorCropRect('right')).toEqual({ x: 1 - ANCHOR_HALF_WIDTH, y: 0, w: ANCHOR_HALF_WIDTH, h: 1 });
  expect(anchorCropRect(null)).toBeNull();
  const src = await png(1600, 900);
  const left = await cropTypographyAnchor(src, 'left');
  const meta = await sharp(left).metadata();
  // 45% of 1600 = 720 wide, capped to ANCHOR_MAX_HEIGHT tall (aspect kept).
  expect(meta.height).toBe(ANCHOR_MAX_HEIGHT);
  expect(Math.round(meta.width / meta.height * 100)).toBe(Math.round(720 / 900 * 100));
  const small = await cropTypographyAnchor(await png(400, 225), 'right');
  expect((await sharp(small).metadata()).height).toBe(225); // under the cap: untouched height
});

test('an unreadable image or unknown side is fail-open (null), never a throw', async () => {
  expect(await cropTypographyAnchor(Buffer.from('not a png'), 'left')).toBeNull();
  expect(await cropTypographyAnchor(await png(100, 100), 'top')).toBeNull();
  expect(await cropTypographyAnchor(null, 'left')).toBeNull();
});

test('the pin is ONE json object beside the renders in the story\'s un-folded directory; a foreign or truncated pin is "no pin"', () => {
  expect(anchorPinPath('children-jobs/b1/ce-renders/ce-15/abc-bdef/spread-1.wide.png')).toBe('children-jobs/b1/ce-renders/ce-15/abc-bdef/typo-anchor.wide.json');
  const bytes = Buffer.from('crop-bytes');
  expect(parsePin(pinBlob(4, 'right', bytes))).toEqual({ spread: 4, side: 'right', bytes, hash: anchorHash(bytes), pinned: true });
  expect(parsePin(Buffer.from('png-bytes'))).toBeNull();
  expect(parsePin(Buffer.from(JSON.stringify({ spread: 13, side: 'left', png: 'YQ==' })))).toBeNull();
  expect(parsePin(Buffer.from(JSON.stringify({ spread: 2, side: 'top', png: 'YQ==' })))).toBeNull();
  expect(parsePin(Buffer.from(JSON.stringify({ spread: 2, side: 'left', png: '' })))).toBeNull();
});

test('election: a pinned anchor is reused; otherwise the crop is pinned create-if-absent (with its spread and side) and a lost race adopts the winner', async () => {
  const src = await png(640, 360);
  const PIN = 'k/typo-anchor.wide.json';
  // No pin yet → crop, pin, use.
  downloadBuffer.mockRejectedValueOnce(new Error('no pin'));
  const first = await electTypographyAnchor({ buffer: src, side: 'left', spread: 1, pinKey: PIN });
  expect(first.pinned).toBe(false);
  expect(first.spread).toBe(1);
  expect(first.hash).toBe(anchorHash(first.bytes));
  expect(uploadBufferIfAbsent).toHaveBeenCalledWith(expect.any(Buffer), PIN, 'application/json');
  const written = JSON.parse(uploadBufferIfAbsent.mock.calls[0][0].toString('utf8'));
  expect(written).toMatchObject({ spread: 1, side: 'left', hash: first.hash });
  expect(Buffer.from(written.png, 'base64').equals(first.bytes)).toBe(true);
  // Pinned → reused without cropping anything (a null buffer is fine), whatever spread asks.
  downloadBuffer.mockResolvedValueOnce(pinBlob(1, 'left', first.bytes));
  const again = await electTypographyAnchor({ buffer: null, side: 'right', spread: 7, pinKey: PIN });
  expect(again).toEqual({ spread: 1, side: 'left', bytes: first.bytes, hash: first.hash, pinned: true });
  expect(await readPinnedTypographyAnchor(PIN)).toBeNull(); // the default mock resolves undefined → no pin
  // Lost the create race → the winner's page, not ours.
  const winner = Buffer.from('winner-bytes');
  downloadBuffer.mockRejectedValueOnce(new Error('no pin')).mockResolvedValueOnce(pinBlob(4, 'right', winner));
  uploadBufferIfAbsent.mockResolvedValueOnce({ created: false });
  const raced = await electTypographyAnchor({ buffer: src, side: 'left', spread: 1, pinKey: PIN });
  expect(raced).toEqual({ spread: 4, side: 'right', bytes: winner, hash: anchorHash(winner), pinned: true });
  // forceRerender re-elects: overwrites the pin, never reads it.
  const re = await electTypographyAnchor({ buffer: src, side: 'left', spread: 1, pinKey: PIN, reelect: true });
  expect(re.pinned).toBe(false);
  expect(uploadBuffer).toHaveBeenCalledWith(expect.any(Buffer), PIN, 'application/json');
  // No render to crop and no pin → null (the caller's advisory).
  downloadBuffer.mockRejectedValueOnce(new Error('no pin'));
  expect(await electTypographyAnchor({ buffer: null, side: 'left', spread: 1, pinKey: PIN })).toBeNull();
});
