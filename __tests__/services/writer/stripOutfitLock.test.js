const { stripOutfitLockFromRaw } = require('../../../services/writer/themes/base');

describe('stripOutfitLockFromRaw', () => {
  test('strips trailing OUTFIT_LOCK line', () => {
    const raw = `---SPREAD 1---
TEXT:
Hello
SCENE:
A park.

OUTFIT_LOCK: navy tee, gray shorts, white sneakers`;
    const { text, outfitLock } = stripOutfitLockFromRaw(raw);
    expect(outfitLock).toBe('navy tee, gray shorts, white sneakers');
    expect(text).not.toMatch(/OUTFIT_LOCK/i);
    expect(text).toMatch(/A park/);
  });

  test('returns null outfit when absent', () => {
    const { text, outfitLock } = stripOutfitLockFromRaw('---SPREAD 1---\nTEXT:\nHi\n');
    expect(outfitLock).toBeNull();
    expect(text).toContain('Hi');
  });
});
