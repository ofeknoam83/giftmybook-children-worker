jest.mock('../../services/gcsStorage', () => ({
  uploadFromUrl: jest.fn().mockResolvedValue('https://storage.example.com/illustration.png'),
}));

const {
  generateIllustration,
  buildCharacterPrompt,
  ART_STYLE_CONFIG,
  renderStyleBlock,
} = require('../../services/illustrationGenerator');
const { PIXAR_STYLE } = require('../../services/shared/illustration/config');
const { uploadFromUrl } = require('../../services/gcsStorage');

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
