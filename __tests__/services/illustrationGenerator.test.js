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
