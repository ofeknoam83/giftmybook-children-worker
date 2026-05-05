/**
 * PR Y — Signature beats unit tests.
 *
 * Covers extraction (which questionnaire fields become beats), the
 * land-or-miss detection, and the opening / peak / closing assignment
 * rotation used to inject repair targets.
 */

const {
  extractSignatureBeats,
  checkSignatureBeatCoverage,
  signalTokens,
  SIGNATURE_TEXT_KEYS,
  SIGNATURE_ADDRESS_KEYS,
} = require('../../../services/bookPipeline/qa/signatureBeats');

describe('signalTokens', () => {
  test('drops stopwords and short tokens', () => {
    const tokens = signalTokens('She is in the bath and she always squeals!');
    expect(tokens.has('squeals')).toBe(true);
    expect(tokens.has('bath')).toBe(true);
    expect(tokens.has('she')).toBe(false); // stopword
    expect(tokens.has('is')).toBe(false);  // stopword
    expect(tokens.has('in')).toBe(false);  // <3 chars
  });

  test('returns empty set on empty / non-string input', () => {
    expect(signalTokens('').size).toBe(0);
    expect(signalTokens(undefined).size).toBe(0);
    expect(signalTokens(null).size).toBe(0);
  });
});

describe('extractSignatureBeats', () => {
  test('pulls every supported text + address field from anecdotes', () => {
    const brief = {
      child: {
        anecdotes: {
          meaningful_moment: 'first time she squealed in the bath',
          moms_favorite_moment: 'morning snuggle in pajamas',
          dads_favorite_moment: 'rooftop sunset',
          funny_thing: 'bites mama on the chin',
          anything_else: 'we call her smushy',
          calls_mom: 'Mama',
          calls_dad: 'Dada',
          // Non-signature fields are ignored.
          favorite_food: 'avocado',
        },
      },
    };
    const beats = extractSignatureBeats(brief);
    const keys = beats.map(b => b.key);
    // Order is deterministic: text keys (priority) then address keys.
    expect(keys).toEqual([
      'meaningful_moment',
      'moms_favorite_moment',
      'dads_favorite_moment',
      'funny_thing',
      'anything_else',
      'calls_mom',
      'calls_dad',
    ]);
    // Sanity-check kinds.
    const moms = beats.find(b => b.key === 'moms_favorite_moment');
    expect(moms.kind).toBe('text');
    const callsMom = beats.find(b => b.key === 'calls_mom');
    expect(callsMom.kind).toBe('address');
    expect(callsMom.keywords.has('mama')).toBe(true);
  });

  test('falls back to customDetails when anecdotes is empty', () => {
    const brief = {
      child: {},
      customDetails: {
        funny_thing: 'snorts when she laughs',
        calls_mom: 'Mommy',
      },
    };
    const beats = extractSignatureBeats(brief);
    expect(beats.map(b => b.key)).toEqual(['funny_thing', 'calls_mom']);
  });

  test('skips empty / whitespace-only fields', () => {
    const brief = {
      child: {
        anecdotes: {
          funny_thing: '   ',
          meaningful_moment: 'a real one',
          calls_mom: '',
        },
      },
    };
    const beats = extractSignatureBeats(brief);
    expect(beats.map(b => b.key)).toEqual(['meaningful_moment']);
  });

  test('skips text fields with no signal tokens (pure stopwords)', () => {
    // "the the the" is all stopwords — no signal — skipped.
    const brief = {
      child: { anecdotes: { funny_thing: 'the the the' } },
    };
    expect(extractSignatureBeats(brief)).toEqual([]);
  });

  test('address-form: only the first word is used as the matcher', () => {
    const brief = {
      child: {
        anecdotes: { calls_mom: 'Mama (most of the time) / Mommy' },
      },
    };
    const beats = extractSignatureBeats(brief);
    expect(beats).toHaveLength(1);
    expect(beats[0].keywords).toEqual(new Set(['mama']));
  });

  test('returns [] on a brief with no anecdotes and no customDetails', () => {
    expect(extractSignatureBeats({ child: {} })).toEqual([]);
    expect(extractSignatureBeats({})).toEqual([]);
    expect(extractSignatureBeats(undefined)).toEqual([]);
  });

  test('SIGNATURE_TEXT_KEYS and SIGNATURE_ADDRESS_KEYS are exported and disjoint', () => {
    const overlap = SIGNATURE_TEXT_KEYS.filter(k => SIGNATURE_ADDRESS_KEYS.includes(k));
    expect(overlap).toEqual([]);
    expect(SIGNATURE_TEXT_KEYS.length).toBeGreaterThan(0);
    expect(SIGNATURE_ADDRESS_KEYS.length).toBeGreaterThan(0);
  });
});

describe('checkSignatureBeatCoverage', () => {
  function makeSpread(spreadNumber, text) {
    return { spreadNumber, manuscript: { text } };
  }

  test('zero beats = trivial pass (no anecdotes provided)', () => {
    const out = checkSignatureBeatCoverage({ child: {} }, [makeSpread(1, 'hello')]);
    expect(out.beats).toEqual([]);
    expect(out.missing).toEqual([]);
    expect(out.assignments).toEqual([]);
  });

  test('all beats land in some spread = empty missing', () => {
    const brief = {
      child: {
        anecdotes: {
          funny_thing: 'bites mama on the chin',
          calls_mom: 'Mama',
        },
      },
    };
    const spreads = [
      makeSpread(1, 'Mama hums softly to her baby.'),
      makeSpread(2, 'Tiny teeth find the chin and Mama laughs.'),
    ];
    const out = checkSignatureBeatCoverage(brief, spreads);
    expect(out.missing).toEqual([]);
    expect(out.landed.map(b => b.key).sort()).toEqual(['calls_mom', 'funny_thing']);
  });

  test('missing beats are detected and assigned to opening / peak / closing', () => {
    // funny_thing's only content tokens (after stopword strip) are
    // "chin" and "bites" — "mama" appears in the answer but is also a
    // very common book word, so we use "Mommy" as the address form to
    // keep funny_thing's signal disjoint from the landed token. With
    // calls_mom = 'Mommy', the address signal is "mommy".
    const brief = {
      child: {
        anecdotes: {
          funny_thing: 'chin bite at storytime',     // missing
          meaningful_moment: 'first squeal in the bath', // missing
          calls_mom: 'Mommy',                         // landed
        },
      },
    };
    // 13 spreads of filler that mentions only "mommy" — nothing else
    // overlaps with the missing beats.
    const spreads = [];
    for (let i = 1; i <= 13; i++) {
      spreads.push(makeSpread(i, `Page ${i}: Mommy hums to her sweet little one.`));
    }
    const out = checkSignatureBeatCoverage(brief, spreads);
    const missingKeys = out.missing.map(b => b.key).sort();
    expect(missingKeys).toEqual(['funny_thing', 'meaningful_moment']);
    expect(out.landed.map(b => b.key)).toEqual(['calls_mom']);
    // Two missing beats → opening (1) and peak (~7) by rotation.
    expect(out.assignments).toHaveLength(2);
    expect(out.assignments[0]).toBe(1);          // opening
    expect(out.assignments[1]).toBe(spreads[Math.floor(spreads.length / 2)].spreadNumber); // peak
  });

  test('three missing beats fill opening / peak / closing', () => {
    const brief = {
      child: {
        anecdotes: {
          funny_thing: 'aaaa', // 4-char nonsense token, won't match
          meaningful_moment: 'bbbb',
          moms_favorite_moment: 'cccc',
        },
      },
    };
    const spreads = [];
    for (let i = 1; i <= 13; i++) spreads.push(makeSpread(i, 'nothing matches here'));
    const out = checkSignatureBeatCoverage(brief, spreads);
    expect(out.missing).toHaveLength(3);
    // opening=1, peak=spreads[6].spreadNumber=7, closing=13.
    expect(out.assignments).toEqual([1, 7, 13]);
  });

  test('more missing beats than rotation slots: rotation repeats', () => {
    const brief = {
      child: {
        anecdotes: {
          funny_thing: 'aaaa',
          meaningful_moment: 'bbbb',
          moms_favorite_moment: 'cccc',
          dads_favorite_moment: 'dddd',
          anything_else: 'eeee',
        },
      },
    };
    const spreads = [];
    for (let i = 1; i <= 13; i++) spreads.push(makeSpread(i, 'nothing'));
    const out = checkSignatureBeatCoverage(brief, spreads);
    expect(out.missing).toHaveLength(5);
    // 5 beats over a 3-slot rotation: 1, 7, 13, 1, 7.
    expect(out.assignments).toEqual([1, 7, 13, 1, 7]);
  });

  test('empty spreads array: missing beats but no assignments', () => {
    const brief = {
      child: { anecdotes: { funny_thing: 'bites chin' } },
    };
    const out = checkSignatureBeatCoverage(brief, []);
    expect(out.missing).toHaveLength(1);
    expect(out.assignments).toEqual([]);
  });

  test('Scarlett fixture: every emotional anchor is missing from a stock manuscript', () => {
    // Reproduces the Scarlett failure mode: the writer's draft is full of
    // stock imagery ("driver beeps", "red jars gleam") and the questionnaire
    // anchors have been silently dropped.
    const brief = {
      child: {
        name: 'Scarlett',
        anecdotes: {
          funny_thing: 'bites mama on the chin',
          meaningful_moment: 'first time she squealed in the bath',
          moms_favorite_moment: 'morning snuggle in pajamas',
          calls_mom: 'Mama',
          anything_else: 'we call her smushy',
        },
      },
    };
    // Filler scrubbed of any tokens that could match a Scarlett anchor:
    // no "chin", "squeal*", "bath*", "snuggle", "pajamas", "morning",
    // "smushy", "mama". Every spread is unique imagery so a stock
    // manuscript (post-bug, pre-fix) could plausibly produce it.
    const stockSpreads = [
      makeSpread(1, 'Scarlett peeks at noon light.'),
      makeSpread(2, 'A driver beeps along the lane.'),
      makeSpread(3, 'Red jars gleam bright on a shelf.'),
      makeSpread(4, 'Scarlett claps at a passing kite.'),
      makeSpread(5, 'A bell hums in the breeze.'),
      makeSpread(6, 'Petals drift past a quiet hedge.'),
      makeSpread(7, 'Scarlett yawns at a teacup.'),
      makeSpread(8, 'A robin paints the sky.'),
      makeSpread(9, 'A puppy sniffs the dew.'),
      makeSpread(10, 'Pillows hold a quiet dream.'),
      makeSpread(11, 'A scarf lifts on the air.'),
      makeSpread(12, 'A boat hums on the river.'),
      makeSpread(13, 'Scarlett rests in her bed.'),
    ];
    const out = checkSignatureBeatCoverage(brief, stockSpreads);
    expect(out.landed).toEqual([]);
    expect(out.missing.map(b => b.key)).toEqual([
      'meaningful_moment',
      'moms_favorite_moment',
      'funny_thing',
      'anything_else',
      'calls_mom',
    ]);
    // Five missing beats over the 1/7/13 rotation: 1,7,13,1,7.
    expect(out.assignments).toEqual([1, 7, 13, 1, 7]);
  });
});
