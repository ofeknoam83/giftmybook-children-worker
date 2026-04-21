/**
 * Unit tests for QualityGate anecdote scoring + keyword extraction.
 *
 * Covers the Mother's-Day-book fixes:
 *  - mom_name/dad_name/calls_mom/calls_dad are first-class anecdote fields.
 *  - Majority-of-keywords rule: a single incidental token is not enough.
 *  - Child/parent name tokens are dropped from anecdote keywords so the
 *    story's unavoidable use of "Mason" or "Mama" doesn't falsely satisfy
 *    an anecdote whose value happens to contain those names.
 */

const { QualityGate } = require('../../../services/writer/quality/gate');

describe('QualityGate._extractKeywords', () => {
  test('drops excluded tokens (child/parent names)', () => {
    const kws = QualityGate._extractKeywords('Mason sprawls out and farts on her', new Set(['mason']));
    expect(kws).not.toContain('mason');
    expect(kws.some(k => /sprawl/.test(k))).toBe(true);
  });

  test('stems plurals and -ing forms', () => {
    const kws = QualityGate._extractKeywords('chasing pancakes in bubbles');
    // The stemmer strips -ing (chasing → chas), -es (pancakes → pancak),
    // and -s (bubbles → bubble). The important property is that each
    // stem is a stable substring the matcher can find in story text.
    expect(kws).toContain('chas');
    expect(kws).toContain('pancak');
    expect(kws).toContain('bubbl');
  });
});

describe('QualityGate._majorityLanded', () => {
  test('single keyword must match', () => {
    expect(QualityGate._majorityLanded(['bunny'], 'the blue bunny ran home')).toBe(true);
    expect(QualityGate._majorityLanded(['bunny'], 'the duck ran home')).toBe(false);
  });

  test('2 keywords need both to match (ceil(2/2)=1 — wait, ceil(2/2)=1? no, it is 1)', () => {
    // ceil(2/2) = 1 — at least one of two tokens must match
    expect(QualityGate._majorityLanded(['moon', 'star'], 'the moon was bright')).toBe(true);
  });

  test('3 keywords need a majority (2 of 3) to land', () => {
    expect(QualityGate._majorityLanded(['blue', 'floppy', 'bunny'], 'the bunny was brown')).toBe(false);
    expect(QualityGate._majorityLanded(['blue', 'floppy', 'bunny'], 'the floppy blue bunny')).toBe(true);
  });
});

describe('QualityGate._scoreAnecdoteUsage', () => {
  const spreadsFromText = (text) => text.split(/\n{2,}/).map((t, i) => ({ spread: i + 1, text: t }));

  test('story that uses only Mama + child name with no anecdote keywords scores <= 5', () => {
    const spreads = [
      { spread: 1, text: 'Mason and Mama walk to the park.' },
      { spread: 2, text: 'Mama smiles. Mason giggles at a bird.' },
      { spread: 3, text: 'Mama waves. Mason waves back.' },
    ];
    const child = {
      name: 'Mason',
      anecdotes: {
        funny_thing: 'sprawls out and farts on her',
        meaningful_moment: 'always wants to be held by mom to get a good nights sleep',
        moms_favorite_moment: 'nighttime cuddles',
        mom_name: 'Alexis',
        calls_mom: 'Mama',
      },
    };
    const res = QualityGate._scoreAnecdoteUsage(spreads, null, child);
    expect(res.score).toBeLessThanOrEqual(5);
    expect(res.source).toBe('anecdotes');
    // mom_name should be evaluated (and missed)
    const alexisItem = (res.requiredItems || []).find(i => i.key === 'mom_name');
    expect(alexisItem).toBeDefined();
    expect(alexisItem.landed).toBe(false);
  });

  test('story that explicitly names Alexis lands mom_name', () => {
    const spreads = [
      { spread: 1, text: 'When grown-ups call her Alexis, to you she is just Mama.' },
      { spread: 2, text: 'Mason sprawls out and toots — Mama laughs.' },
      { spread: 3, text: 'Nighttime cuddles by the lamp.' },
    ];
    const child = {
      name: 'Mason',
      anecdotes: {
        funny_thing: 'sprawls out and farts on her',
        moms_favorite_moment: 'nighttime cuddles',
        mom_name: 'Alexis',
        calls_mom: 'Mama',
      },
    };
    const res = QualityGate._scoreAnecdoteUsage(spreads, null, child);
    const alexisItem = (res.requiredItems || []).find(i => i.key === 'mom_name');
    expect(alexisItem).toBeDefined();
    expect(alexisItem.landed).toBe(true);
  });
});

describe('QualityGate._funnyThingMissed', () => {
  test('returns the value when funny_thing was scored but not landed', () => {
    const anecdoteUsage = {
      requiredItems: [
        { kind: 'anecdote', key: 'funny_thing', value: 'sprawls out and farts', landed: false },
      ],
    };
    const child = { anecdotes: { funny_thing: 'sprawls out and farts' } };
    expect(QualityGate._funnyThingMissed(child, anecdoteUsage)).toBe('sprawls out and farts');
  });

  test('returns null when funny_thing landed', () => {
    const anecdoteUsage = {
      requiredItems: [
        { kind: 'anecdote', key: 'funny_thing', value: 'sprawls out and farts', landed: true },
      ],
    };
    const child = { anecdotes: { funny_thing: 'sprawls out and farts' } };
    expect(QualityGate._funnyThingMissed(child, anecdoteUsage)).toBeNull();
  });

  test('returns null when no funny_thing was provided', () => {
    expect(QualityGate._funnyThingMissed({ anecdotes: {} }, { requiredItems: [] })).toBeNull();
  });
});
