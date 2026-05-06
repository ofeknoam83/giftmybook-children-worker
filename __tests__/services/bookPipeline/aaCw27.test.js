/**
 * AA-CW-27 — deterministic identity-rhyme safety net.
 *
 * The judge has missed obvious identity rhymes ("trees/trees", "shade/shade",
 * "close/close") on multiple production books despite explicit prompt rules.
 * checkWriterDraft.js now exposes a deterministic last-word comparison
 * that force-flags identity rhymes after the judge returns.
 */

const { detectIdentityRhyme } = require('../../../services/bookPipeline/qa/checkWriterDraft');

describe('AA-CW-27 detectIdentityRhyme', () => {
  test('returns null for clean spread', () => {
    const text = [
      'Mama says, "Smushy," dear.',
      'Scarlett smiles to hear.',
      'Doorway light looks gold.',
      "Her cheek rests in Mama's hold.",
    ].join('\n');
    expect(detectIdentityRhyme(text)).toBeNull();
  });

  test('flags L1/L2 identity rhyme (trees/trees, different phrases)', () => {
    const text = [
      'Scarlett sees green trees.',
      'Mama walks by trees.',
      'Her blanket stays snug.',
      "She rests in Mama's hug.",
    ].join('\n');
    expect(detectIdentityRhyme(text)).toEqual({ couplet: 'L1/L2', word: 'trees' });
  });

  test('flags L3/L4 identity rhyme (shade/shade)', () => {
    const text = [
      'Mama leans in near.',
      'Scarlett squeals to hear.',
      'Sound skips through the shade.',
      'Her wide eyes watch the shade.',
    ].join('\n');
    expect(detectIdentityRhyme(text)).toEqual({ couplet: 'L3/L4', word: 'shade' });
  });

  test('flags L3/L4 identity rhyme even when used as different parts of speech (close/close)', () => {
    const text = [
      'Back in the window nook.',
      'Scarlett gives Mama a look.',
      'The blanket folds up close.',
      'Mama says, "Smushy," close.',
    ].join('\n');
    expect(detectIdentityRhyme(text)).toEqual({ couplet: 'L3/L4', word: 'close' });
  });

  test('strips punctuation when comparing last words', () => {
    const text = [
      'Scarlett laughs out loud!',
      'Mama hums aloud.',
      'L3 line one.',
      'L4 line two.',
    ].join('\n');
    // 'loud' vs 'aloud' is NOT identity (substring, not equality).
    expect(detectIdentityRhyme(text)).toBeNull();
  });

  test('handles trailing punctuation on identity match (trees./trees,)', () => {
    const text = [
      'Sees green trees.',
      'Walks by trees,',
      'Blanket snug.',
      'In her hug.',
    ].join('\n');
    expect(detectIdentityRhyme(text)).toEqual({ couplet: 'L1/L2', word: 'trees' });
  });

  test('case-insensitive', () => {
    const text = [
      'Sees the Sky.',
      'Looks at sky.',
      'Line three.',
      'Line four.',
    ].join('\n');
    expect(detectIdentityRhyme(text)).toEqual({ couplet: 'L1/L2', word: 'sky' });
  });

  test('returns null for short or malformed text (fewer than 4 lines)', () => {
    expect(detectIdentityRhyme('only two lines\nright here')).toBeNull();
    expect(detectIdentityRhyme('')).toBeNull();
    expect(detectIdentityRhyme(null)).toBeNull();
  });

  test('does NOT flag near-rhymes or different words sharing a stem', () => {
    const text = [
      'Sees the trees.',
      'Hears the breeze.',
      'Walks by the wall.',
      'Hears Mama call.',
    ].join('\n');
    expect(detectIdentityRhyme(text)).toBeNull();
  });
});
