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
  anchorCropRect, cropTypographyAnchor, anchorHash, anchorPinPath, electTypographyAnchor, ANCHOR_HALF_WIDTH, ANCHOR_MAX_HEIGHT,
} = require('../../../services/catalogEngine/illustrator/textAnchor');

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

test('the pin lives beside the renders under the anchor spread\'s own (un-folded) directory', () => {
  expect(anchorPinPath('children-jobs/b1/ce-renders/ce-15/abc-bdef/spread-1.wide.png')).toBe('children-jobs/b1/ce-renders/ce-15/abc-bdef/typo-anchor.wide.png');
});

test('election: a pinned anchor is reused; otherwise the crop is pinned create-if-absent and a lost race adopts the winner', async () => {
  const src = await png(640, 360);
  // No pin yet → crop, pin, use.
  downloadBuffer.mockRejectedValueOnce(new Error('no pin'));
  const first = await electTypographyAnchor({ buffer: src, side: 'left', pinKey: 'k/typo-anchor.wide.png' });
  expect(first.pinned).toBe(false);
  expect(uploadBufferIfAbsent).toHaveBeenCalledWith(expect.any(Buffer), 'k/typo-anchor.wide.png', 'image/png');
  expect(first.hash).toBe(anchorHash(first.bytes));
  // Pinned → reused without cropping anything (a null buffer is fine).
  downloadBuffer.mockResolvedValueOnce(first.bytes);
  const again = await electTypographyAnchor({ buffer: null, side: 'left', pinKey: 'k/typo-anchor.wide.png' });
  expect(again).toEqual({ bytes: first.bytes, hash: first.hash, pinned: true });
  // Lost the create race → the winner's bytes.
  const winner = Buffer.from('winner-bytes');
  downloadBuffer.mockRejectedValueOnce(new Error('no pin')).mockResolvedValueOnce(winner);
  uploadBufferIfAbsent.mockResolvedValueOnce({ created: false });
  const raced = await electTypographyAnchor({ buffer: src, side: 'right', pinKey: 'k/typo-anchor.wide.png' });
  expect(raced).toEqual({ bytes: winner, hash: anchorHash(winner), pinned: true });
  // forceRerender re-elects: overwrites the pin, never reads it.
  const re = await electTypographyAnchor({ buffer: src, side: 'left', pinKey: 'k/typo-anchor.wide.png', reelect: true });
  expect(re.pinned).toBe(false);
  expect(uploadBuffer).toHaveBeenCalledWith(expect.any(Buffer), 'k/typo-anchor.wide.png', 'image/png');
  // No render to crop and no pin → null (the caller's advisory).
  downloadBuffer.mockRejectedValueOnce(new Error('no pin'));
  expect(await electTypographyAnchor({ buffer: null, side: 'left', pinKey: 'k/typo-anchor.wide.png' })).toBeNull();
});
