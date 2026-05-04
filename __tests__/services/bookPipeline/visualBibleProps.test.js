/**
 * Unit tests for validateRecurringProps (PR C, sections C.4b + C.5).
 *
 * Exercises the "blanket appears in 11 spreads, undeclared" failure mode
 * that motivated this validator — plus the ephemeral budget overflow.
 */

const {
  validateRecurringProps,
  extractPropMentions,
  buildDeclaredPropTokens,
} = require('../../../services/bookPipeline/qa/validateRecurringProps');

function spec(spreadNumber, focalAction, plotBeat = '', location = '') {
  return { spreadNumber, focalAction, plotBeat, location, mustUseDetails: [], continuityAnchors: [] };
}

describe('extractPropMentions', () => {
  test('detects lexicon nouns case-insensitively', () => {
    const m = extractPropMentions('A soft yellow Blanket on the picnic basket.');
    expect(m.has('blanket')).toBe(true);
    expect(m.has('basket')).toBe(true);
  });

  test('handles plurals (ducks → duck, blankets → blanket)', () => {
    const m = extractPropMentions('Three little ducks chase the blankets.');
    expect(m.has('duck')).toBe(true);
    expect(m.has('blanket')).toBe(true);
  });

  test('ignores non-prop nouns', () => {
    const m = extractPropMentions('Mama smiles at Scarlett under a sunny sky.');
    expect(m.size).toBe(0);
  });
});

describe('buildDeclaredPropTokens', () => {
  test('extracts singular tokens from declared prop names', () => {
    const declared = buildDeclaredPropTokens({
      recurringProps: [
        { name: 'soft yellow cable-knit blanket', description: 'x' },
        { name: 'Scarlett\'s headband', description: 'x' },
      ],
    });
    expect(declared.has('blanket')).toBe(true);
    expect(declared.has('headband')).toBe(true);
  });

  test('handles missing recurringProps gracefully', () => {
    expect(buildDeclaredPropTokens({}).size).toBe(0);
    expect(buildDeclaredPropTokens(null).size).toBe(0);
  });
});

describe('validateRecurringProps', () => {
  test('blanket in 11 spreads, undeclared → prop_undeclared', () => {
    const spreadSpecs = [];
    for (let i = 1; i <= 11; i += 1) {
      spreadSpecs.push(spec(i, `Scarlett chases the runaway blanket on spread ${i}.`));
    }
    const result = validateRecurringProps({
      spreadSpecs,
      visualBible: { recurringProps: [] },
    });
    expect(result.pass).toBe(false);
    expect(result.tags).toContain('prop_undeclared');
    const blanketIssue = result.issues.find(i => i.prop === 'blanket');
    expect(blanketIssue).toBeDefined();
    expect(blanketIssue.spreads.length).toBe(11);
  });

  test('blanket in 11 spreads, declared → pass on prop check', () => {
    const spreadSpecs = [];
    for (let i = 1; i <= 11; i += 1) {
      spreadSpecs.push(spec(i, `Scarlett chases the runaway blanket on spread ${i}.`));
    }
    const result = validateRecurringProps({
      spreadSpecs,
      visualBible: {
        recurringProps: [
          { name: 'soft yellow cable-knit blanket', description: 'a soft yellow blanket' },
        ],
      },
    });
    expect(result.tags).not.toContain('prop_undeclared');
  });

  test('prop in exactly 2 spreads is NOT required to be declared', () => {
    const spreadSpecs = [
      spec(1, 'Scarlett picks up a hat.'),
      spec(2, 'Scarlett wears the hat.'),
    ];
    const result = validateRecurringProps({
      spreadSpecs,
      visualBible: { recurringProps: [] },
    });
    expect(result.tags).not.toContain('prop_undeclared');
  });

  test('ephemeral budget exceeded when >3 single-spread props', () => {
    const spreadSpecs = [
      spec(1, 'A duck waddles by.'),
      spec(2, 'A kite flies overhead.'),
      spec(3, 'A teddy waves hello.'),
      spec(4, 'A balloon drifts past.'),
      spec(5, 'A soft moment.'),
    ];
    const result = validateRecurringProps({
      spreadSpecs,
      visualBible: { recurringProps: [] },
    });
    expect(result.tags).toContain('ephemeral_element_budget_exceeded');
    expect(result.ephemeralCount).toBe(4);
  });

  test('ephemeral budget respected with exactly 3 single-spread props', () => {
    const spreadSpecs = [
      spec(1, 'A duck waddles by.'),
      spec(2, 'A kite flies overhead.'),
      spec(3, 'A teddy waves hello.'),
    ];
    const result = validateRecurringProps({
      spreadSpecs,
      visualBible: { recurringProps: [] },
    });
    expect(result.tags).not.toContain('ephemeral_element_budget_exceeded');
    expect(result.ephemeralCount).toBe(3);
  });

  test('empty spreadSpecs returns pass:true', () => {
    const result = validateRecurringProps({
      spreadSpecs: [],
      visualBible: { recurringProps: [] },
    });
    expect(result.pass).toBe(true);
    expect(result.tags).toEqual([]);
  });

  test('configurable ephemeralBudget', () => {
    const spreadSpecs = [
      spec(1, 'A duck waddles.'),
      spec(2, 'A kite flies.'),
      spec(3, 'A teddy waves.'),
      spec(4, 'A balloon drifts.'),
      spec(5, 'A bicycle rolls.'),
    ];
    const result = validateRecurringProps({
      spreadSpecs,
      visualBible: { recurringProps: [] },
      ephemeralBudget: 5,
    });
    expect(result.tags).not.toContain('ephemeral_element_budget_exceeded');
  });
});
