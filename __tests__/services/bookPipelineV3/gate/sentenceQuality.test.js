'use strict';

/**
 * Mid-sentence dash/semicolon check (2026-07-29 QA review: "No dashes or
 * semicolons mid-sentence. They break reading rhythm.").
 */

const { midlinePunctuationCheck } = require('../../../../services/bookPipelineV3/gate/checks/sentenceQuality');

const INFANT = { ageBand: 'PB_INFANT' };
const TODDLER = { ageBand: 'PB_TODDLER' };
const PRESCHOOL = { ageBand: 'PB_PRESCHOOL' };
const EARLY_READER = { ageBand: 'PB_EARLY_READER' };

const draft = (text) => ({ spread: 1, text, lines: text.split('\n') });

describe('midlinePunctuationCheck', () => {
  test('em dash mid-sentence fails hard for toddlers', () => {
    const r = midlinePunctuationCheck(draft('Swish, swish—Liv paddles to the steps.'), null, TODDLER);
    expect(r.passed).toBe(false);
    expect(r.code).toBe('midline_punctuation');
  });

  test('en dash and double hyphen also fail', () => {
    expect(midlinePunctuationCheck(draft('The boat – small and red – floats by.'), null, INFANT).passed).toBe(false);
    expect(midlinePunctuationCheck(draft('The boat -- small and red -- floats by.'), null, INFANT).passed).toBe(false);
  });

  test('semicolon mid-sentence fails', () => {
    const r = midlinePunctuationCheck(draft('Liv claps; the ducks quack back.'), null, TODDLER);
    expect(r.passed).toBe(false);
    expect(r.message).toContain('split');
  });

  test('a sentence-final cliff dash passes (not mid-sentence)', () => {
    expect(midlinePunctuationCheck(draft('Liv leans closer, and then—\nSplash!'), null, TODDLER).passed).toBe(true);
  });

  test('word-internal hyphens are compounds, not dashes', () => {
    expect(midlinePunctuationCheck(draft('Liv rides the merry-go-round with her teddy-bear.'), null, INFANT).passed).toBe(true);
  });

  test('PRESCHOOL demotes to soft', () => {
    const r = midlinePunctuationCheck(draft('The kite dips — then climbs again.'), null, PRESCHOOL);
    expect(r.passed).toBe(false);
    expect(r.code).toBe('midline_punctuation_soft');
  });

  test('EARLY_READER is exempt (em-dash asides are legitimate at 6+)', () => {
    expect(midlinePunctuationCheck(draft('The map — old and torn — showed the way.'), null, EARLY_READER).passed).toBe(true);
  });
});
