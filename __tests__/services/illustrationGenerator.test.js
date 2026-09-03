jest.mock('../../services/gcsStorage', () => ({
  uploadFromUrl: jest.fn().mockResolvedValue('https://storage.example.com/illustration.png'),
}));

const {
  generateIllustration,
  buildCharacterPrompt,
  ART_STYLE_CONFIG,
  renderStyleBlock,
  wrapStoryLines,
  compareTexts,
} = require('../../services/illustrationGenerator');
const { PIXAR_STYLE } = require('../../services/shared/illustration/config');
const { uploadFromUrl } = require('../../services/gcsStorage');

describe('embedded text is typeset BY PROMPT (ce-13): pre-wrapped lines, a concrete column, small body type', () => {
  const STORY = 'Aaron checked the ground nearby first. No cracked earth, no steep drop, no thorny patch blocked the way.\n\nShe listened again, wondering how calls could sound so close and yet stay unseen.';

  test('wrapStoryLines keeps every word, never exceeds the limit, keeps paragraph gaps, and balances widths', () => {
    const lines = wrapStoryLines(STORY, 30);
    expect(lines.every(l => l.length <= 30)).toBe(true);
    expect(lines.filter(l => l === '')).toHaveLength(1); // one paragraph gap
    expect(lines.filter(Boolean).join(' ')).toBe(STORY.replace(/\s+/g, ' '));
    // Balanced, not one long line and an orphan: no non-final line of a
    // paragraph is shorter than half the limit.
    const para1 = lines.slice(0, lines.indexOf(''));
    for (const l of para1.slice(0, -1)) expect(l.length).toBeGreaterThanOrEqual(15);
    // A word longer than the limit stands alone rather than being dropped.
    expect(wrapStoryLines('a supercalifragilisticexpialidocious day', 10)).toEqual(['a', 'supercalifragilisticexpialidocious', 'day']);
    expect(wrapStoryLines('', 30)).toEqual([]);
  });

  test('the embedded prompt pins the assigned column, the fold wall, the line count, and the wrapped lines verbatim', () => {
    const prompt = buildCharacterPrompt('Aaron stands on a warm rock.', 'pixar_premium', 'Aaron', STORY, 'red t-shirt, blue jeans', 'wavy brown hair', null, null, {
      isSpread: true, spreadIndex: 3, totalSpreads: 12, embedText: true, childAge: 7, textSide: 'left',
    });
    const lines = wrapStoryLines(STORY, 30);
    const n = lines.filter(Boolean).length;
    expect(prompt).toContain('TEXT ZONE (CRITICAL — THE PAGE FOLD)');
    // ages 3–8 tier: edge 8%, active side 35% → the LEFT column box, 15% fold margin.
    expect(prompt).toContain('the LEFT column (x from 8% to 35% of the image width)');
    expect(prompt).toContain('NO letter may come within 15% of the image width of the centerline');
    expect(prompt).toContain(`exactly ${n} short lines`);
    expect(prompt).toContain(lines.join('\n'));
    expect(prompt).toContain('cap height about 1.5% of the image height');
    expect(prompt).toContain('When unsure, go SMALLER, never larger.');
    expect(prompt).toContain(`The whole ${n}-line block below must fit INSIDE the text column box`);
    // The right side and the "pick a side" fallback are distinct wordings.
    const right = buildCharacterPrompt('scene', 'pixar_premium', 'Aaron', STORY, 'red t-shirt', null, null, null, { isSpread: true, spreadIndex: 3, totalSpreads: 12, embedText: true, childAge: 7, textSide: 'right' });
    expect(right).toContain('the RIGHT column (x from 65% to 92% of the image width)');
    const unpinned = buildCharacterPrompt('scene', 'pixar_premium', 'Aaron', STORY, 'red t-shirt', null, null, null, { isSpread: true, spreadIndex: 3, totalSpreads: 12, embedText: true, childAge: 7 });
    expect(unpinned).toContain('pick a single side');
  });

  test('compareTexts flags a block truncated at its first or last word (qa-6) and still passes a faithful transcript', () => {
    expect(compareTexts(STORY, STORY).valid).toBe(true);
    // A mid-word cut ("ron") is also an extra word for the bag check; the
    // edge check is what catches a WHOLE first/last word cut by the frame,
    // which one missing word out of ~35 never trips the 25% threshold on.
    const cutStart = compareTexts(STORY, STORY.replace(/^Aaron/, 'ron'));
    expect(cutStart.valid).toBe(false);
    expect(cutStart.issues).toEqual(expect.arrayContaining([expect.stringContaining('first word "aaron" missing')]));
    const wholeWordCut = compareTexts(STORY, STORY.replace(/^Aaron /, ''));
    expect(wholeWordCut.valid).toBe(false);
    expect(wholeWordCut.issues).toEqual([expect.stringContaining('first word "aaron" missing')]);
    const cutEnd = compareTexts(STORY, STORY.replace(/ unseen\.$/, '.'));
    expect(cutEnd.valid).toBe(false);
    expect(cutEnd.issues).toEqual([expect.stringContaining('last word "unseen" missing')]);
    // Too short to have meaningful edges: only the existing bag rules speak.
    expect(compareTexts('Hi there', 'Hi').issues).not.toEqual(expect.arrayContaining([expect.stringContaining('truncated')]));
  });

  test('compareTexts is glyph-insensitive: curly quotes, accents, dash spacing, and merged edge tokens are not defects', () => {
    const expected = "Mila’s toucan swooped down—fast… “Whose tracks?” asked José.";
    // The OCR transcript with straight quotes, no accents, spaced dashes.
    expect(compareTexts(expected, "Mila's toucan swooped down — fast... \"Whose tracks?\" asked Jose.").valid).toBe(true);
    // The reverse direction too (manuscript straight, OCR curly).
    expect(compareTexts("Mila's day at Maple Harvest Hall.", "Mila’s day at Maple Harvest Hall.").valid).toBe(true);
    // An OCR spacing slip that merges the first two words is not a missing first word.
    expect(compareTexts('Whose tracks are these, she wondered.', 'Whosetracks are these, she wondered.').issues)
      .not.toEqual(expect.arrayContaining([expect.stringContaining('first word')]));
  });
});

describe('buildGenericSafePrompt (NSFW last-resort variant keeps identity)', () => {
  const { buildGenericSafePrompt } = require('../../services/illustrationGenerator');

  test('carries the child name, outfit, and appearance anchor', () => {
    const p = buildGenericSafePrompt('pixar_premium', {
      childName: 'Liv',
      characterOutfit: 'yellow raincoat and red boots',
      characterDescription: 'curly brown hair, light-brown skin, freckles',
    });
    expect(p).toContain('named Liv');
    expect(p).toContain('OUTFIT (locked');
    expect(p).toContain('yellow raincoat and red boots');
    expect(p).toContain('CHARACTER (must match the reference photo exactly)');
    expect(p).toContain('curly brown hair');
  });

  test('identity fields pass through the NSFW-word sanitizer', () => {
    const p = buildGenericSafePrompt('pixar_premium', {
      characterDescription: 'a scary monster costume with brown hair',
    });
    expect(p).not.toMatch(/\bscary\b/);
    expect(p).not.toMatch(/\bmonster\b/);
    expect(p).toContain('brown hair');
  });

  test('no identity provided → the original generic prompt shape', () => {
    const p = buildGenericSafePrompt('pixar_premium');
    expect(p).toContain('a happy child in a colorful scene');
    expect(p).not.toContain('OUTFIT (locked');
  });
});

describe('ART TUNING block survives prompt sanitization verbatim', () => {
  test('hair words in a tuning directive are never scrubbed; scene-body accessories still are', () => {
    const scene = 'Emma with a ponytail waves from the tractor.'
      + '\nART TUNING art-004.aabbccdd (admin-approved style refinement — LOWEST priority): refine notes below.'
      + '\n- Keep the braided hair and headband identical on every spread.';
    const prompt = buildCharacterPrompt(scene, 'pixar_premium', 'Emma', '', 'red shirt and jeans', 'curly brown hair', null, null, { skipTextEmbed: true });
    expect(prompt).toContain('braided hair and headband identical');
    expect(prompt).not.toMatch(/with a ponytail/);
  });

  test('water words inside the tuning block do not flip bath/water mode', () => {
    const scene = 'Emma waters the garden with a green can.'
      + '\nART TUNING art-004.aabbccdd (admin-approved style refinement — LOWEST priority): refine notes below.'
      + '\n- AVOID: murky swimming pool blues; keep in the pool scenes bright and clear.';
    const prompt = buildCharacterPrompt(scene, 'pixar_premium', 'Emma', '', 'red shirt and jeans', 'curly brown hair', null, null, { skipTextEmbed: true });
    expect(prompt).toContain('OUTFIT LOCK');
    expect(prompt).not.toContain('BATH / WATER OUTFIT');
  });

  test('the tuning block is the FULL prompt\'s last block (ce-7), never buried mid-prompt', () => {
    const scene = 'Emma waves from the tractor.'
      + '\nART TUNING art-004.aabbccdd (admin-approved rendering direction — BINDING within its scope): warm rim light on every spread.';
    const prompt = buildCharacterPrompt(scene, 'pixar_premium', 'Emma', '', 'red shirt and jeans', 'curly brown hair', null, null, { skipTextEmbed: true });
    const tuningIdx = prompt.indexOf('ART TUNING art-004.aabbccdd');
    expect(tuningIdx).toBeGreaterThan(prompt.indexOf('FINAL STYLE REMINDER'));
    expect(tuningIdx).toBeGreaterThan(prompt.indexOf('SCENE TO ILLUSTRATE'));
    expect(tuningIdx).toBeGreaterThan(prompt.indexOf('MANDATORY PRE-GENERATE CHECKLIST'));
    // The scene itself no longer carries the block — it moved, not doubled.
    expect(prompt.lastIndexOf('ART TUNING art-004.aabbccdd')).toBe(tuningIdx);
  });

  test('without a tuning marker the prompt still ends on the style reminder', () => {
    const prompt = buildCharacterPrompt('Emma waves from the tractor.', 'pixar_premium', 'Emma', '', 'red shirt and jeans', 'curly brown hair', null, null, { skipTextEmbed: true });
    expect(prompt).not.toContain('ART TUNING');
    expect(prompt.trimEnd().endsWith(prompt.match(/FINAL STYLE REMINDER[^\n]*/)[0])).toBe(true);
  });
});
