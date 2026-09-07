const sharp = require('sharp');
const { createTypographyGuide, letteringJudgeImage, GUIDE_HEIGHT, GUIDE_WIDTH, JUDGE_PAPER } = require('../../../services/catalogEngine/illustrator/typographyGuide');
const { resolveBookTextRules } = require('../../../services/shared/illustration/config');
const { repairNote } = require('../../../services/catalogEngine/illustrator/spreadQa');

const png = color => sharp({ create: { width: 80, height: 80, channels: 3, background: color } }).png().toBuffer();

test('ONE ink for every book: a formerly-light request draws the same dark cocoa glyphs (2026-09-07)', async () => {
  const dark = await createTypographyGuide({ childAge: 6, text: 'A quiet adventure begins.' });
  const light = await createTypographyGuide({ childAge: 6, ink: 'light', text: 'A quiet adventure begins.' });
  expect(dark.inkHex).toBe('#2A1C12');
  expect(light.inkHex).toBe('#2A1C12');
  expect(light.hash).toBe(dark.hash);
  expect(light.ink).toBeUndefined();
  expect(resolveBookTextRules(6, 'light').fontColorHex).toBe('#2A1C12');
  expect(typeof require('../../../services/catalogEngine/illustrator/typographyGuide').chooseBookTextInk).toBe('undefined');
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
  expect(guide.inkHex).toBe('#2A1C12');
});

test('the same book gets the same guide, but a different size tier cannot reuse its cache key', async () => {
  const input = { childAge: 6, text: 'A quiet adventure begins.' };
  const a = await createTypographyGuide(input);
  expect((await createTypographyGuide(input)).hash).toBe(a.hash);
  expect((await createTypographyGuide({ ...input, childAge: 10 })).hash).not.toBe(a.hash);
  expect(resolveBookTextRules(6, 'untrusted color').fontColorHex).toBe('#2A1C12');
});

test('the ink repair note always demands the one cocoa ink, cites the lettering reference, and never offers ivory', () => {
  const note = repairNote(['embedded story text ink colour differs'], '', { inkHex: '#2A1C12', typographyRef: 3 });
  expect(note).toContain('deep warm cocoa-brown, almost black (hex #2A1C12)');
  expect(note).toContain('never white, ivory');
  expect(note).toContain('REFERENCE IMAGE 3');
  expect(note).toContain("lighter calm area");
  expect(note).not.toContain('warm ivory');
  expect(repairNote(['embedded story text ink colour differs'], '', { inkHex: '#FFF4DE' })).not.toContain('warm ivory');
});

test('the judge copy of the lettering is the same glyphs flattened onto paper at a judge size (never transparent)', async () => {
  const template = await createTypographyGuide({ childAge: 6, text: 'A quiet adventure begins.', fullSpread: true, side: 'right', typographyScale: 1.5 });
  const judge = await letteringJudgeImage(template);
  expect(judge).toMatchObject({ mimeType: 'image/png', side: 'right', capHeightPercent: 1.425, inkHex: '#2A1C12' });
  const { data, info } = await sharp(Buffer.from(judge.base64, 'base64')).raw().toBuffer({ resolveWithObject: true });
  expect(info.height).toBe(1536);
  expect(info.width).toBe(Math.round(1536 * 16 / 9));
  expect(info.channels).toBe(3); // flattened: no alpha to vanish on a black composite
  const paper = [0xF5, 0xF0, 0xE6];
  expect(JUDGE_PAPER).toBe('#F5F0E6');
  expect([data[0], data[1], data[2]]).toEqual(paper); // top-left corner is paper
  let dark = 0;
  for (let i = 0; i < data.length; i += 3) if (data[i] < 90 && data[i + 1] < 80 && data[i + 2] < 70) dark++;
  expect(dark).toBeGreaterThan(200); // the glyphs are there, in the book ink
  expect(await letteringJudgeImage(null)).toBeNull();
  expect(await letteringJudgeImage({ base64: Buffer.from('not a png').toString('base64') })).toBeNull();
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
  const compact = resolveTypographyGuideRules(6);
  expect(compact.fontStyle).toContain('Playfair Display Regular');
  expect(compact.fontStyle).toContain('never outlined');
  expect(compact.fontColor).toContain('deep warm cocoa-brown #2A1C12');
  expect(compact.fontColor).toContain('NEVER white, ivory');
  expect(compact.fontSize).toContain('cap height 0.95%');
  expect(compact.fontSize).not.toContain('1.1%');
  expect(compact.capHeightPercent).toBe(.95);
  expect(compact.fontColor).toContain('never more than 0.05%');
  expect(resolveTypographyGuideRules(2).fontSize).toContain('cap height 1.1%');
  expect(resolveBookTextRules(6).fontStyle).toContain('resembling Georgia');
});

test('full-spread template carries the actual manuscript at fixed scale on either assigned side', async () => {
  const { createTypographyTemplate } = require('../../../services/catalogEngine/illustrator/typographyGuide');
  const input = { childAge: 6, ink: 'light', text: 'A quiet adventure begins.' };
  const left = await createTypographyTemplate({ ...input, side: 'left' });
  const right = await createTypographyTemplate({ ...input, side: 'right' });
  const bounds = async ref => {
    const { data, info } = await sharp(Buffer.from(ref.base64, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let minX = info.width, maxX = 0, minY = info.height, maxY = 0;
    for (let p = 0; p < info.width * info.height; p++) if (data[p * 4 + 3]) {
      minX = Math.min(minX, p % info.width); maxX = Math.max(maxX, p % info.width);
      minY = Math.min(minY, Math.floor(p / info.width)); maxY = Math.max(maxY, Math.floor(p / info.width));
    }
    return { ...info, minX, maxX, minY, maxY };
  };
  const a = await bounds(left), b = await bounds(right);
  expect(left.kind).toBe('template');
  expect(left.lines.join(' ')).toBe(input.text);
  expect(a.width / a.height).toBeCloseTo(16 / 9, 3);
  expect(b.minX).toBeGreaterThan(b.width * .6);
  expect(a.maxX).toBeLessThan(a.width * .4);
  expect(a.maxY - a.minY).toBe(b.maxY - b.minY);
  expect(a.maxY - a.minY).toBeLessThan(a.height * .02);
  expect(left.hash).not.toBe(right.hash);
  expect(left.hash).not.toBe((await createTypographyGuide(input)).hash);
});

test('template words are copied and its image is first without renumbering identity references', async () => {
  const { createTypographyTemplate } = require('../../../services/catalogEngine/illustrator/typographyGuide');
  const { buildReferencePack } = require('../../../services/catalogEngine/illustrator/bible');
  const { buildReferenceParts, buildCharacterPrompt } = require('../../../services/illustrationGenerator');
  const template = await createTypographyTemplate({ childAge: 6, text: 'The bells rang.', side: 'right' });
  const { pack, refs } = buildReferencePack({}, { refPhoto: { base64: 'cover' }, typographyAnchor: template });
  const prompt = buildCharacterPrompt('A forest.', 'pixar_premium', 'Test', 'The bells rang.', null, null, null, null,
    { embedText: true, isSpread: true, childAge: 6, typographyTemplate: true, typographyRef: refs.typographyRef });
  const parts = buildReferenceParts(prompt, pack);
  expect(parts[1].text).toContain('REFERENCE IMAGE 2');
  expect(parts[2].inline_data.data).toBe(template.base64);
  expect(parts[3].text).toContain('REFERENCE IMAGE 1');
  expect(prompt).toContain("Copy the template's words exactly");
  expect(prompt).not.toContain('never copy its words');
  expect(prompt).toContain('Playfair Display Regular');
});


test('the intermediate template enlarges glyphs and line pitch together without changing old guides', async () => {
  const { createTypographyTemplate } = require('../../../services/catalogEngine/illustrator/typographyGuide');
  const { resolveTypographyGuideRules } = require('../../../services/shared/illustration/config');
  const input = { childAge: 6, ink: 'light', text: 'A quiet adventure begins.' };
  const old = await createTypographyTemplate(input);
  const medium = await createTypographyTemplate({ ...input, typographyScale: 1.5 });
  expect(medium.capHeightPercent).toBe(1.425);
  expect(medium.hash).not.toBe(old.hash);
  expect(medium.lines).toEqual(old.lines);
  const rules = resolveTypographyGuideRules(6, 1.5);
  expect(rules.linePitchPercent).toBe(2.85);
  expect(rules.textAlignment).toContain('NEVER centre the rows');
  expect(rules.fontSize).toContain('cap height 1.425%');
  expect(rules.fontSize).toContain('line pitch 2.85%');
  expect((await createTypographyGuide({ ...input, typographyScale: 1.5 })).hash).toBe((await createTypographyGuide(input)).hash);
});


test('the readable template and actual prompt share sentence-led 5–7 word rows', async () => {
  const { createTypographyTemplate } = require('../../../services/catalogEngine/illustrator/typographyGuide');
  const { buildCharacterPrompt } = require('../../../services/illustrationGenerator');
  const { expectedTextBlock } = require('../../../services/shared/illustration/textBlock');
  const { resolveTypographyGuideRules } = require('../../../services/shared/illustration/config');
  const text = 'The little fox walked slowly through the forest and listened to the leaves. She looked up. “Where did the little blue bird go?”';
  const template = await createTypographyTemplate({ childAge: 6, text, typographyScale: 1.5 });
  const block = expectedTextBlock(text, resolveTypographyGuideRules(6, 1.5));
  expect(template.lines).toEqual(block.lines);
  expect(block.lines.filter(Boolean).join(' ')).toBe(text);
  expect(block.lines).toContain('She looked up.');
  expect(block.lines.at(-1)).toBe('“Where did the little blue bird go?”');
  expect(block.lines.slice(0, 2).every(line => line.split(/\s+/).length >= 5 && line.split(/\s+/).length <= 7)).toBe(true);
  const prompt = buildCharacterPrompt('A forest.', 'pixar_premium', 'Test', text, null, null, null, null, {
    embedText: true, isSpread: true, childAge: 6, typographyTemplate: true, typographyScale: 1.5, typographyRef: 2,
  });
  expect(prompt).toContain(block.lines.join('\n'));
  expect(prompt).toContain('Target 5–7 words per line');
  expect(prompt).toContain('exactly ONE completely empty line between sentences');
  expect(prompt).toContain('text lines plus 2 completely empty lines');
  expect(block.lines.filter(l => l === '')).toHaveLength(2);
  expect(prompt).toContain('start every sentence on a fresh line');
  expect(prompt).toContain('cap height 1.425%');
  expect(prompt).not.toContain('Err on the side of TOO SMALL');
  expect(prompt).not.toContain('Smaller is always safer');
  expect(block.widthPercent).toBeLessThanOrEqual(27);
});


test('sentence gaps fit inside print-safe bounds without reducing the readable font', async () => {
  const { createTypographyTemplate } = require('../../../services/catalogEngine/illustrator/typographyGuide');
  const { expectedTextBlock } = require('../../../services/shared/illustration/textBlock');
  const { resolveTypographyGuideRules } = require('../../../services/shared/illustration/config');
  const text = 'The little fox walked into the forest and listened to the leaves in the trees. A blue bird flew down and landed on a branch. “Hello,” said the fox with a smile. Tiny bells rang softly in the breeze. She looked up. “Where is that music coming from?”';
  const rules = resolveTypographyGuideRules(6, 1.5);
  const block = expectedTextBlock(text, rules);
  const template = await createTypographyTemplate({ childAge: 6, ink: 'light', text, typographyScale: 1.5 });
  expect(template.lines).toEqual(block.lines);
  expect(block.lines.filter(l => l === '')).toHaveLength(5);
  expect(block.heightPercent).toBeLessThan(100 - rules.topPaddingPercent - rules.bottomPaddingPercent);
  expect(template.capHeightPercent).toBe(1.425);
  expect(rules.topPaddingPercent).toBeGreaterThan(6);
  expect(rules.bottomPaddingPercent).toBeGreaterThan(6);
});
