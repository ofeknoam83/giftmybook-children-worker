const sharp = require('sharp');
const { createTypographyGuide, chooseBookTextInk, GUIDE_HEIGHT, GUIDE_WIDTH } = require('../../../services/catalogEngine/illustrator/typographyGuide');
const { resolveBookTextRules } = require('../../../services/shared/illustration/config');
const { repairNote } = require('../../../services/catalogEngine/illustrator/spreadQa');

const png = color => sharp({ create: { width: 80, height: 80, channels: 3, background: color } }).png().toBuffer();

test('ink is selected once from the cover lighting, with safe unreadable-reference fallback', async () => {
  expect(await chooseBookTextInk(await png('#13303a'))).toBe('light');
  expect(await chooseBookTextInk(await png('#ddddbb'))).toBe('dark');
  expect(await chooseBookTextInk(Buffer.from('bad image'))).toBe('dark');
});

test('the guide has actual small glyphs and transparent space, without a panel', async () => {
  const guide = await createTypographyGuide({ childAge: 6, ink: 'light', text: 'A quiet adventure begins.' });
  const { data, info } = await sharp(Buffer.from(guide.base64, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(info).toMatchObject({ width: GUIDE_WIDTH, height: GUIDE_HEIGHT, channels: 4 });
  const ys = [];
  let painted = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) { painted++; ys.push(Math.floor((i - 3) / 4 / info.width)); }
  expect(painted / (info.width * info.height)).toBeLessThan(.02);
  expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(GUIDE_HEIGHT * .02);
  expect(guide.inkHex).toBe('#FFF4DE');
});

test('the same book gets the same guide, but a different ink or size cannot reuse its cache key', async () => {
  const input = { childAge: 6, ink: 'dark', text: 'A quiet adventure begins.' };
  const a = await createTypographyGuide(input);
  expect((await createTypographyGuide(input)).hash).toBe(a.hash);
  expect((await createTypographyGuide({ ...input, ink: 'light' })).hash).not.toBe(a.hash);
  expect((await createTypographyGuide({ ...input, childAge: 10 })).hash).not.toBe(a.hash);
  expect(resolveBookTextRules(6, 'untrusted color').fontColorHex).toBe('#2A1C12');
});

test('ivory repair directions do not contradict the pinned light ink', () => {
  const note = repairNote(['embedded story text ink colour differs'], '', { inkHex: '#FFF4DE' });
  expect(note).toContain('warm ivory');
  expect(note).not.toContain('never white, ivory');
});

test('the guide never invalidates existing or partially generated artwork on an ordinary retry', async () => {
  const { canUseTypographyGuide } = require('../../../services/catalogEngine/illustrator/typographyGuide');
  const input = { enabled: true, reviewedOnly: false, forceRerender: false, legacyPaths: ['pin', 'spread1', 'spread2'] };
  expect(await canUseTypographyGuide(input, async key => key === 'spread2')).toBe(false);
  expect(await canUseTypographyGuide(input, async () => false)).toBe(true);
  expect(await canUseTypographyGuide(input, async () => { throw new Error('storage unavailable'); })).toBe(false);
  expect(await canUseTypographyGuide({ ...input, forceRerender: true }, async () => true)).toBe(true);
  expect(await canUseTypographyGuide({ ...input, reviewedOnly: true, forceRerender: true }, async () => false)).toBe(false);
});

test('retry after an explicit typography upgrade stays with the new saved artwork even when old renders remain', async () => {
  const { canUseTypographyGuide } = require('../../../services/catalogEngine/illustrator/typographyGuide');
  expect(await canUseTypographyGuide({ enabled: true, legacyPaths: ['old1', 'old2'], guidePaths: ['new1', 'new2'] },
    async key => ['old1', 'old2', 'new1'].includes(key))).toBe(true);
});


test('guide geometry and prompt share one face and one numeric size for each age tier', () => {
  const { resolveTypographyGuideRules } = require('../../../services/shared/illustration/config');
  const compact = resolveTypographyGuideRules(6, 'dark');
  expect(compact.fontStyle).toContain('Playfair Display Regular');
  expect(compact.fontSize).toContain('cap height 0.95%');
  expect(compact.fontSize).not.toContain('1.1%');
  expect(compact.capHeightPercent).toBe(.95);
  expect(compact.fontColor).toContain('never more than 0.05%');
  expect(resolveTypographyGuideRules(2).fontSize).toContain('cap height 1.1%');
  expect(resolveBookTextRules(6).fontStyle).toContain('resembling Georgia');
});
