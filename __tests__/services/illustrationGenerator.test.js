jest.mock('../../services/gcsStorage', () => ({
  uploadFromUrl: jest.fn().mockResolvedValue('https://storage.example.com/illustration.png'),
}));

// The renderer's key pool is built at module load — a key must exist for
// generateIllustration to reach its (mocked) Gemini call at all.
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';

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
    expect(prompt).toContain('cap height about 1.1% of the image height');
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

describe('ce-15: the text block has a FOOTPRINT, a no-panel rule that names the panels, a typography reference, and the last word', () => {
  const { expectedTextBlock } = require('../../services/illustrationGenerator');
  const { TEXT_RULES, resolvePictureBookTextRules } = require('../../services/shared/illustration/config');
  const STORY = 'Aaron checked the ground nearby first. No cracked earth, no steep drop, no thorny patch blocked the way.\n\nShe listened again, wondering how calls could sound so close and yet stay unseen.';
  const build = (over = {}) => buildCharacterPrompt('Aaron stands on a warm rock.', 'pixar_premium', 'Aaron', STORY, 'red t-shirt, blue jeans', 'wavy brown hair', null, null, {
    isSpread: true, spreadIndex: 3, totalSpreads: 12, embedText: true, childAge: 7, textSide: 'left', ...over,
  });

  test('expectedTextBlock: widest row × chars-per-width, rows × pitch (paragraph gaps count), per tier', () => {
    const base = expectedTextBlock(STORY, TEXT_RULES);
    const lines = wrapStoryLines(STORY, 30);
    expect(base.lines).toEqual(lines);
    expect(base.widestChars).toBe(Math.max(...lines.map(l => l.length)));
    expect(base.lineCount).toBe(lines.length);
    expect(base.widthPercent).toBe(Math.round(base.widestChars * TEXT_RULES.charWidthPercent * 10) / 10);
    expect(base.heightPercent).toBe(Math.round(lines.length * TEXT_RULES.linePitchPercent * 10) / 10);
    // ce-16: the spec stepped down — a 30-character row is under a sixth of the width.
    expect(TEXT_RULES.charWidthPercent).toBe(0.45);
    expect(TEXT_RULES.linePitchPercent).toBe(2.1);
    // A 30-character row is well under a quarter of the width at every tier.
    expect(30 * TEXT_RULES.charWidthPercent).toBeLessThan(25);
    const compact = expectedTextBlock(STORY, resolvePictureBookTextRules(5));
    expect(compact.widthPercent).toBeLessThan(base.widthPercent);
    expect(compact.heightPercent).toBeLessThan(base.heightPercent);
    expect(expectedTextBlock('', TEXT_RULES)).toEqual({ lines: [], lineCount: 0, widestChars: 0, widthPercent: 0, heightPercent: 0 });
  });

  test('the FONT SIZE rule is followed by the block FOOTPRINT in the model\'s own terms (its block\'s width and height)', () => {
    const prompt = build();
    const b = expectedTextBlock(STORY, resolvePictureBookTextRules(7));
    expect(prompt).toContain('BLOCK FOOTPRINT (THE SIZE, MADE CONCRETE)');
    expect(prompt).toContain(`widest row (${b.widestChars} characters) spans about ${b.widthPercent}% of the image width`);
    expect(prompt).toContain(`whole ${b.lineCount}-row block stands about ${b.heightPercent}% of the image height tall`);
    expect(prompt).toContain('the type NEVER grows to fill the column');
    expect(prompt).toContain(`wider than ${Math.round(b.widthPercent * 1.3)}% of the image width`);
    // The checklist restates it.
    expect(prompt).toContain(`Block footprint about ${b.widthPercent}% of the width by ${b.heightPercent}% of the height`);
  });

  test('the no-panel rule names the panels the model reaches for, and says the scene is the only backdrop', () => {
    const prompt = build();
    expect(prompt).toContain('The ONLY thing behind the letters is the untouched scene');
    for (const word of ['card', 'plaque', 'sign', 'board', 'parchment', 'scroll', 'banner']) expect(prompt).toContain(word);
    expect(prompt).toContain('a blurred or darkened zone is a soft panel and will be REJECTED');
    expect(prompt).not.toContain('a horizontal text band across the image will be REJECTED');
    // ce-17: the scene under the letters stays sharp — no haze zone, legibility from a thin outline only.
    expect(prompt).toContain('NEVER blur, fog, soften, darken, lighten, desaturate, or empty the area behind or around the text');
    // The generic integration rule permits either book-wide ink; the dark
    // ink specification still requires its pale glyph-tight edge.
    expect(prompt).toContain("Legibility comes ONLY from the letters' own thin, tight contrasting hairline");
    expect(prompt).toContain('never from changing the book-wide ink');
    expect(prompt).toContain('thin, tight PALE hairline');
    expect(prompt).not.toContain('thin, tight dark outline');
    expect(prompt).not.toContain('whisper-soft dark contact shadow');
    expect(prompt).not.toContain('gentle depth haze');
    expect(prompt.slice(prompt.indexOf('TEXT — FINAL CHECK'))).toContain('blur, fog, glow, or darkening');
  });

  test('ce-18: the ONE ink reaches the prompt as a name AND the hex the gate measures against', () => {
    const { TEXT_RULES } = require('../../services/shared/illustration/config');
    const prompt = build();
    expect(prompt).toContain(TEXT_RULES.fontColorHex);
    expect(prompt).toContain('deep warm cocoa-brown, almost black');
    expect(prompt).toContain('NEVER white, ivory, cream, yellow, gold, or any pale fill');
    expect(prompt).toContain('never invert to light text');
    // The old ivory spec is gone from every rule.
    expect(prompt).not.toContain('soft warm ivory');
  });

  test('a typography reference index is cited as TYPE ONLY; without one the line is absent', () => {
    const withRef = build({ typographyRef: 5 });
    expect(withRef).toContain('TYPOGRAPHY REFERENCE (REFERENCE IMAGE 5 — this book’s fixed lettering reference)');
    expect(withRef).toContain('Use it for the TYPE ONLY');
    expect(withRef).toContain('the type matching REFERENCE IMAGE 5'); // checklist + final check
    const without = build();
    expect(without).not.toContain('TYPOGRAPHY REFERENCE');
    expect(without).not.toContain('REFERENCE IMAGE');
  });

  test('TEXT — FINAL CHECK is the last fixed block: after the style reminder, before any tuning, absent on text-free renders', () => {
    const prompt = build();
    const idx = prompt.indexOf('TEXT — FINAL CHECK');
    expect(idx).toBeGreaterThan(prompt.indexOf('FINAL STYLE REMINDER'));
    expect(prompt.slice(idx)).toContain('in the LEFT column');
    expect(prompt.slice(idx)).toContain('Smaller is always safer than larger.');
    const tuned = buildCharacterPrompt('Aaron stands on a warm rock.\nART TUNING art-004.aabbccdd (admin-approved rendering direction — BINDING within its scope): warm rim light.', 'pixar_premium', 'Aaron', STORY, 'red t-shirt', 'wavy brown hair', null, null, {
      isSpread: true, spreadIndex: 3, totalSpreads: 12, embedText: true, childAge: 7, textSide: 'right',
    });
    expect(tuned.indexOf('ART TUNING art-004.aabbccdd')).toBeGreaterThan(tuned.indexOf('TEXT — FINAL CHECK'));
    const textFree = buildCharacterPrompt('scene', 'pixar_premium', 'Aaron', '', 'red t-shirt', null, null, null, { isSpread: true, spreadIndex: 3, totalSpreads: 12, skipTextEmbed: true });
    expect(textFree).not.toContain('TEXT — FINAL CHECK');
    expect(textFree).not.toContain('BLOCK FOOTPRINT');
  });
});

describe('ce-15: generateIllustration forwards the assigned text side and the typography reference into the prompt it SENDS', () => {
  const STORY = 'Aaron checked the ground nearby first. No cracked earth, no steep drop, no thorny patch blocked the way.';

  test.each(['dark', 'light'])('the Gemini request carries pinned %s ink, column, and reference image parts in pack order', async (bookTextInk) => {
    const bodies = [];
    const realFetch = global.fetch;
    global.fetch = jest.fn(async (url, init) => { bodies.push(JSON.parse(init.body)); throw new Error('offline test'); });
    try {
      await expect(generateIllustration('Aaron stands on a warm rock.', 'https://p/x.png', 'pixar_premium', {
        bookId: 'b1', childName: 'Aaron', isSpread: true, spreadIndex: 3, totalSpreads: 12, embedText: true, pageText: STORY, childAge: 7,
        aspectRatio: '16:9', textSide: 'left', typographyRef: 2, bookTextInk,
        childPhotoUrl: 'https://p/x.png', _cachedPhotoBase64: 'YmFzZTY0', _cachedPhotoMime: 'image/jpeg',
        referencePack: [
          { kind: 'cover', label: 'APPROVED COVER (identity only)', base64: 'YQ==', mimeType: 'image/jpeg' },
          { kind: 'typography', label: 'TYPOGRAPHY REFERENCE (page 1 of THIS book)', base64: 'Yg==', mimeType: 'image/png' },
        ],
      })).rejects.toThrow();
    } finally {
      global.fetch = realFetch;
    }
    expect(bodies.length).toBeGreaterThan(0);
    const parts = bodies[0].contents[0].parts;
    const prompt = parts[0].text;
    // ce-13's column reached the builder in tests only — production got "pick a single side".
    expect(prompt).toContain('the LEFT column (x from 8% to 35% of the image width)');
    expect(prompt).not.toContain('pick a single side');
    expect(prompt).toContain('TYPOGRAPHY REFERENCE (REFERENCE IMAGE 2');
    expect(prompt).toContain('TEXT — FINAL CHECK');
    if (bookTextInk === 'light') {
      expect(prompt).toContain('warm ivory (#FFF4DE)');
      expect(prompt).not.toContain('NEVER white, ivory');
      expect(prompt).not.toContain('never invert to light text');
    } else {
      expect(prompt).toContain('deep warm cocoa-brown');
      expect(prompt).toContain('NEVER white, ivory');
    }
    expect(parts.filter(p => p.inline_data)).toHaveLength(2);
    expect(parts.some(p => typeof p.text === 'string' && p.text.startsWith('REFERENCE IMAGE 2 — TYPOGRAPHY REFERENCE'))).toBe(true);
  });
});

describe('ce-16: an opt-in output size rides the Gemini image call and falls back once when the model rejects it', () => {
  const STORY = 'Aaron checked the ground nearby first.';
  const renderOpts = (over = {}) => ({
    bookId: 'b1', childName: 'Aaron', isSpread: true, spreadIndex: 3, totalSpreads: 12, embedText: true, pageText: STORY, childAge: 7,
    aspectRatio: '16:9', textSide: 'left', childPhotoUrl: 'https://p/x.png', _cachedPhotoBase64: 'YmFzZTY0', _cachedPhotoMime: 'image/jpeg',
    ...over,
  });

  test('imageSize is sent inside imageConfig beside the aspect ratio, and omitted when not set', async () => {
    const bodies = [];
    const realFetch = global.fetch;
    global.fetch = jest.fn(async (url, init) => { bodies.push(JSON.parse(init.body)); throw new Error('offline test'); });
    try {
      await expect(generateIllustration('scene', 'https://p/x.png', 'pixar_premium', renderOpts({ imageSize: '2K' }))).rejects.toThrow();
      expect(bodies[0].generationConfig.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '2K' });
      bodies.length = 0;
      await expect(generateIllustration('scene', 'https://p/x.png', 'pixar_premium', renderOpts())).rejects.toThrow();
      expect(bodies[0].generationConfig.imageConfig).toEqual({ aspectRatio: '16:9' });
    } finally {
      global.fetch = realFetch;
    }
  });

  test('a 400 naming the field retries once without it (the seed pattern) — the model\'s default size, never a failed render', async () => {
    const bodies = [];
    const realFetch = global.fetch;
    global.fetch = jest.fn(async (url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return { ok: false, status: 400, text: async () => 'Invalid JSON payload: unknown field "image_size"' };
      throw new Error('offline test');
    });
    try {
      await expect(generateIllustration('scene', 'https://p/x.png', 'pixar_premium', renderOpts({ imageSize: '2K' }))).rejects.toThrow();
    } finally {
      global.fetch = realFetch;
    }
    expect(bodies[0].generationConfig.imageConfig.imageSize).toBe('2K');
    expect(bodies[1].generationConfig.imageConfig).toEqual({ aspectRatio: '16:9' });
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
