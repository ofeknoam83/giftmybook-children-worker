'use strict';

/**
 * Banned poetic-register words (2026-07-29 QA review, Liv birthday book).
 * Negative fixtures are the review's own quoted failures.
 */

const { bannedWordsCheck } = require('../../../../services/bookPipelineV3/gate/checks/bannedWords');

const INFANT = { ageBand: 'PB_INFANT' };
const TODDLER = { ageBand: 'PB_TODDLER' };
const PRESCHOOL = { ageBand: 'PB_PRESCHOOL' };
const EARLY_READER = { ageBand: 'PB_EARLY_READER' };

const draft = (text) => ({ spread: 1, text, lines: text.split('\n') });

describe('bannedWordsCheck', () => {
  test('the Liv phrase "moonlight silver rests on sand" hits the phrase list (soft tier)', () => {
    const r = bannedWordsCheck(draft('Moonlight silver rests on sand.'), null, TODDLER, {});
    expect(r.passed).toBe(false);
    expect(r.code).toBe('banned_word_soft');
    expect(r.detail.hits.some((h) => h.category === 'phrases')).toBe(true);
  });

  test('multi-hit hard words ("The child naps on the isle at dusk") fail hard for toddlers', () => {
    const r = bannedWordsCheck(draft('The child naps on the isle at dusk.'), null, TODDLER, {});
    expect(r.passed).toBe(false);
    expect(r.code).toBe('banned_word');
    const bases = r.detail.hits.map((h) => h.base);
    expect(bases).toEqual(expect.arrayContaining(['isle', 'dusk']));
    // Replacements ride the message — the surgical-fix fuel.
    expect(r.message).toContain('"isle" → "island"');
  });

  test('inflections are caught (shimmering → shimmer)', () => {
    const r = bannedWordsCheck(draft('The water keeps shimmering all night.'), null, INFANT, {});
    expect(r.passed).toBe(false);
    expect(r.code).toBe('banned_word');
    expect(r.detail.hits[0].base).toBe('shimmer');
  });

  test('soft-tier words alone stay soft even for infants (dual-use vocabulary)', () => {
    const r = bannedWordsCheck(draft('The bees hum and the leaves drift down.'), null, INFANT, {});
    expect(r.passed).toBe(false);
    expect(r.code).toBe('banned_word_soft');
  });

  test('PRESCHOOL demotes hard-tier hits to soft', () => {
    const r = bannedWordsCheck(draft('They walk amid the trees to the isle.'), null, PRESCHOOL, {});
    expect(r.passed).toBe(false);
    expect(r.code).toBe('banned_word_soft');
  });

  test('EARLY_READER is exempt', () => {
    const r = bannedWordsCheck(draft('They gaze at the radiant isle at dusk.'), null, EARLY_READER, {});
    expect(r.passed).toBe(true);
  });

  test('the child name and proper nouns are exempt', () => {
    // "Hush" as a capitalized name-like token and the protagonist "Isle" must not fire.
    const r = bannedWordsCheck(draft('Isle laughs and hugs Hush the bunny.'), null, TODDLER, { protagonistName: 'Isle' });
    expect(r.passed).toBe(true);
  });

  test('clean warm register passes', () => {
    const r = bannedWordsCheck(
      draft('Liv laughs and splashes in the warm pool.\nMom claps and Liv giggles.'),
      null, TODDLER, { protagonistName: 'Liv' },
    );
    expect(r.passed).toBe(true);
  });
});
