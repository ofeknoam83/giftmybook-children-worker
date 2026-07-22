/**
 * P2 (2026-07-23 audit): cover↔interior 3D parity. The book pass flags a
 * cover style break (spread 0, or a critical flag naming the cover) so the
 * pipeline can force a cover re-harmonize.
 */

const { detectCoverStyleBreak } = require('../../../services/bookPipelineV3/illustrator/bookPass/contactSheet');

describe('detectCoverStyleBreak', () => {
  test('a spread-0 flag naming a style term breaks parity', () => {
    const r = detectCoverStyleBreak([{ spread: 0, severity: 'minor', issue: 'the cover reads flat 2D vs the 3D interiors' }]);
    expect(r.broke).toBe(true);
    expect(r.reason).toMatch(/flat 2D/);
  });

  test('any critical spread-0 flag breaks parity', () => {
    expect(detectCoverStyleBreak([{ spread: 0, severity: 'critical', issue: 'anything' }]).broke).toBe(true);
  });

  test('a critical flag on another spread that explicitly blames the cover breaks parity', () => {
    const r = detectCoverStyleBreak([{ spread: 5, severity: 'critical', issue: 'the cover is painterly while this spread is 3D' }]);
    expect(r.broke).toBe(true);
  });

  test('interior-only style flags do NOT break cover parity', () => {
    expect(detectCoverStyleBreak([{ spread: 4, severity: 'critical', issue: 'this spread is flat vector' }]).broke).toBe(false);
  });

  test('no flags → no break', () => {
    expect(detectCoverStyleBreak([]).broke).toBe(false);
    expect(detectCoverStyleBreak(undefined).broke).toBe(false);
  });
});
