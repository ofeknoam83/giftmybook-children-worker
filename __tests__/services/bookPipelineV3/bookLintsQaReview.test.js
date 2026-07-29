'use strict';

/**
 * 2026-07-29 QA-review book lints (Liv birthday book, "AI Writer Feedback
 * & Word List"): fragments, staccato style, sentence length, concept
 * overload, name scarcity. Negative fixtures come straight from the review.
 */

const {
  verblessSentenceLint,
  staccatoStyleLint,
  sentenceLengthLint,
  conceptOverloadLint,
  nameScarcityLint,
  roleUnusedLint,
  foodRoleMisplacedLint,
  openingBeatLovesLint,
  runBookLints,
} = require('../../../services/bookPipelineV3/gate/checks/bookLints');
const { buildStoryRoles } = require('../../../services/bookPipelineV3/storyRoles');

const ms = (spreads, extra = {}) => ({
  title: 'T',
  refrain: null,
  spreads: spreads.map((text, i) => ({ spread: i + 1, text })),
  ...extra,
});

describe('verblessSentenceLint', () => {
  test('flags the review fixture "Moonlight silver on sand."', () => {
    const m = ms(['Liv plays by the pool.', 'Moonlight silver on sand. The water is warm.']);
    const lints = verblessSentenceLint(m);
    expect(lints).toHaveLength(1);
    expect(lints[0].code).toBe('verbless_sentence');
    expect(lints[0].message).toContain('Moonlight silver on sand.');
    expect(lints[0].targetSpreads).toEqual([2]);
  });

  test('exclamations, dialogue, short lines, and interjection openers are exempt', () => {
    const m = ms([
      'What a happy day at the pool!',
      '"More bubbles, more bubbles," says Liv.',
      'Splash!',
      'Oh, the big blue sky.',
      'Pat, pat.',
    ]);
    expect(verblessSentenceLint(m)).toEqual([]);
  });

  test('the declared refrain is exempt', () => {
    const m = ms(['One more splash for Liv.', 'One more splash for Liv.'], {
      refrain: { text: 'One more splash for Liv.', evolution: [] },
    });
    expect(verblessSentenceLint(m)).toEqual([]);
  });

  test('verb-carrying contractions are not fragments', () => {
    const m = ms(['It’s a warm bath night.']);
    expect(verblessSentenceLint(m)).toEqual([]);
  });
});

describe('staccatoStyleLint', () => {
  test('flags the review fixture style: "Balloons bop. Confetti skips."', () => {
    const staccato = 'Balloons bop. Confetti skips. A map flaps.';
    const m = ms(Array.from({ length: 13 }, () => staccato));
    const lints = staccatoStyleLint(m);
    expect(lints).toHaveLength(1);
    expect(lints[0].code).toBe('staccato_style');
    expect(lints[0].message).toContain('connective');
    expect(lints[0].targetSpreads.length).toBeGreaterThanOrEqual(2);
  });

  test('flowing connected prose does not fire', () => {
    const flowing = 'The balloons bobbed up and down, and the confetti fluttered down around her. Liv laughed and reached out to catch a piece before it landed.';
    const m = ms(Array.from({ length: 13 }, () => flowing));
    expect(staccatoStyleLint(m)).toEqual([]);
  });

  test('small samples never fire (needs 15+ sentences)', () => {
    const m = ms(['Balloons bop.', 'Confetti skips.', 'A map flaps.']);
    expect(staccatoStyleLint(m)).toEqual([]);
  });
});

describe('sentenceLengthLint', () => {
  const profile = (maxAvg) => ({ vocabularyConstraints: { maxAvgSentenceWords: maxAvg } });

  test('fires when the book average exceeds the band cap', () => {
    const long = 'Liv wandered slowly down the winding garden path while the evening light spilled gently over every single flower bed she passed on her way home.';
    const m = ms(Array.from({ length: 4 }, () => long));
    const lints = sentenceLengthLint(m, { ageProfile: profile(9) });
    expect(lints).toHaveLength(1);
    expect(lints[0].code).toBe('sentence_length');
    expect(lints[0].targetSpreads.length).toBeGreaterThan(0);
  });

  test('short plain sentences pass', () => {
    const m = ms(['Liv hugs her duck. They splash together.', 'Mom claps twice. Liv giggles.']);
    expect(sentenceLengthLint(m, { ageProfile: profile(9) })).toEqual([]);
  });

  test('self-disables when the profile lacks the field', () => {
    const long = Array(30).fill('word').join(' ') + '.';
    const m = ms([long]);
    expect(sentenceLengthLint(m, { ageProfile: {} })).toEqual([]);
  });
});

describe('conceptOverloadLint', () => {
  const withObjects = (objectsBySpread) => ({
    spreads: objectsBySpread.map((key_objects, i) => ({
      spread: i + 1,
      text: 'Liv plays.',
      scene_contract: { key_objects },
    })),
  });

  test('flags the review case: a chest and a map and confetti arriving at once', () => {
    const m = withObjects([
      ['red ball'],
      ['red ball'],
      ['wooden chest', 'old map', 'gold confetti'],
      ['old map'],
    ]);
    const lints = conceptOverloadLint(m);
    expect(lints).toHaveLength(1);
    expect(lints[0].code).toBe('concept_overload');
    expect(lints[0].spreads).toEqual([3]);
  });

  test('spreads 1-2 are exempt (world setup)', () => {
    const m = withObjects([
      ['wooden chest', 'old map', 'gold confetti', 'red ball'],
      ['balloon', 'cake', 'candle'],
      ['balloon'],
    ]);
    expect(conceptOverloadLint(m)).toEqual([]);
  });

  test('reused objects do not count as new (naming drift folds on the head noun)', () => {
    const m = withObjects([
      ['red bucket', 'map'],
      ['bucket', 'maps'],
      ['the red bucket', 'old map', 'spade'],
    ]);
    expect(conceptOverloadLint(m)).toEqual([]);
  });
});

describe('nameScarcityLint', () => {
  test('fires when the name anchors under 40% of spreads, targeting the longest nameless run', () => {
    const texts = Array.from({ length: 13 }, () => 'She splashes in the pool.');
    texts[0] = 'Liv splashes in the pool.';
    texts[12] = 'Liv sleeps, warm and happy.';
    const lints = nameScarcityLint(ms(texts), { protagonistName: 'Liv' });
    expect(lints).toHaveLength(1);
    expect(lints[0].code).toBe('name_scarcity');
    // The nameless run is spreads 2-12; targets sit inside it.
    for (const t of lints[0].targetSpreads) {
      expect(t).toBeGreaterThanOrEqual(2);
      expect(t).toBeLessThanOrEqual(12);
    }
  });

  test('a well-anchored book passes', () => {
    const texts = Array.from({ length: 13 }, (_, i) => (i % 2 === 0 ? 'Liv laughs and claps.' : 'She twirls around.'));
    expect(nameScarcityLint(ms(texts), { protagonistName: 'Liv' })).toEqual([]);
  });

  test('self-disables without a name or on short books', () => {
    expect(nameScarcityLint(ms(['a', 'b', 'c']), { protagonistName: 'Liv' })).toEqual([]);
    expect(nameScarcityLint(ms(Array(13).fill('text')), {})).toEqual([]);
  });
});

describe('role-usage lints', () => {
  const roles = buildStoryRoles({
    childAnecdotes: {
      favorite_activities: 'swimming',
      calls_mom: 'calls everything mama',
      favorite_food: 'strawberries and bananas',
      mom_name: 'Alex',
      dad_name: 'Daniel',
    },
    childName: 'Liv',
  });
  const thirteen = (overrides = {}) => {
    const texts = Array.from({ length: 13 }, () => 'The lagoon glitters at night.');
    for (const [idx, text] of Object.entries(overrides)) texts[idx] = text;
    return ms(texts);
  };

  describe('roleUnusedLint', () => {
    test('the Liv failure: every cast role absent → one lint per role at its home beat', () => {
      const lints = roleUnusedLint(thirteen(), { storyRoles: roles });
      expect(lints).toHaveLength(3);
      const byMsg = (frag) => lints.find((l) => l.message.includes(frag));
      expect(byMsg('tool').targetSpreads).toEqual([5]);
      expect(byMsg('turningPoint').targetSpreads).toEqual([8, 9]);
      expect(byMsg('worldObject').targetSpreads).toEqual([6]);
    });

    test('a role whose tokens appear anywhere is satisfied', () => {
      const m = thirteen({
        4: 'Liv goes swimming to reach the toy.',
        8: 'Liv points at the boat and says mama, and the boat lights up.',
        5: 'A banana boat floats by and Liv climbs on.',
      });
      expect(roleUnusedLint(m, { storyRoles: roles })).toEqual([]);
    });

    test('self-disables without storyRoles', () => {
      expect(roleUnusedLint(thirteen(), {})).toEqual([]);
    });
  });

  describe('foodRoleMisplacedLint', () => {
    test('food only in the opening/ending is scenery — targets the mid-story beat', () => {
      const m = thirteen({ 0: 'A plate of strawberries sits by the pool.', 12: 'Bananas for a snack at last.' });
      const lints = foodRoleMisplacedLint(m, { storyRoles: roles });
      expect(lints).toHaveLength(1);
      expect(lints[0].code).toBe('food_role_misplaced');
      expect(lints[0].targetSpreads).toEqual([6]);
    });

    test('food appearing mid-story passes', () => {
      const m = thirteen({ 5: 'Liv paddles her banana boat across the pool.' });
      expect(foodRoleMisplacedLint(m, { storyRoles: roles })).toEqual([]);
    });

    test('fully absent food belongs to roleUnusedLint, not this lint', () => {
      expect(foodRoleMisplacedLint(thirteen(), { storyRoles: roles })).toEqual([]);
    });
  });

  describe('openingBeatLovesLint', () => {
    test('an opening with no loved thing fires, targeting spread 1', () => {
      const lints = openingBeatLovesLint(thirteen(), { storyRoles: roles, interests: ['swimming'] });
      expect(lints).toHaveLength(1);
      expect(lints[0].code).toBe('opening_beat_loves');
      expect(lints[0].targetSpreads).toEqual([1]);
    });

    test('a loved thing on spread 1-2 satisfies it', () => {
      const m = thirteen({ 1: 'Liv loves swimming with her yellow duck.' });
      expect(openingBeatLovesLint(m, { storyRoles: roles, interests: ['swimming'] })).toEqual([]);
    });

    test('self-disables with nothing to look for', () => {
      expect(openingBeatLovesLint(thirteen(), {})).toEqual([]);
    });
  });
});

describe('runBookLints integration', () => {
  test('the new lints ride runBookLints alongside the originals', () => {
    const staccato = 'Balloons bop. Confetti skips. A map flaps.';
    const m = ms(Array.from({ length: 13 }, () => staccato));
    const codes = runBookLints(m, { protagonistName: 'Liv' }).map((l) => l.code);
    expect(codes).toContain('staccato_style');
    expect(codes).toContain('name_scarcity');
  });
});
