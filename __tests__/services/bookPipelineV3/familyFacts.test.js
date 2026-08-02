const {
  buildFamilyFacts, buildFamilyFactsNote, matchFamilyRole, applyFamilyFacts,
} = require('../../../services/bookPipelineV3/illustrator/artDirection/familyFacts');
const { buildDirectorPrompt } = require('../../../services/bookPipelineV3/illustrator/artDirection/artDirector');

// The feedback case: a mother with an ambiguous name + a father — the
// gender comes from WHICH questionnaire field the name arrived in, never
// from the name string itself.
const anecdotes = { mom_name: 'Noam', dad_name: 'Daniel', calls_mom: 'Mama', calls_dad: '' };

describe('buildFamilyFacts', () => {
  test('roles come from the declared mom/dad fields, not the names', () => {
    const facts = buildFamilyFacts({ childAnecdotes: anecdotes });
    expect(facts).toEqual([
      { role: 'mother', noun: 'woman', name: 'Noam', callName: 'Mama' },
      { role: 'father', noun: 'man', name: 'Daniel', callName: null },
    ]);
  });

  test('storyRoles.finalScene (sanitized) wins over raw anecdotes', () => {
    const facts = buildFamilyFacts({
      storyRoles: { finalScene: { momName: 'Maya', dadName: null, callsMom: null, callsDad: 'Aba' } },
      childAnecdotes: { mom_name: 'ignored' },
    });
    expect(facts.find((f) => f.role === 'mother').name).toBe('Maya');
    expect(facts.find((f) => f.role === 'father').callName).toBe('Aba');
  });

  test('no parent inputs → no facts', () => {
    expect(buildFamilyFacts({ childAnecdotes: {} })).toEqual([]);
  });
});

describe('matchFamilyRole', () => {
  const facts = buildFamilyFacts({ childAnecdotes: anecdotes });

  test('matches declared names, call-names, and generic aliases', () => {
    expect(matchFamilyRole('Daniel', facts).role).toBe('father');
    expect(matchFamilyRole('Mama', facts).role).toBe('mother');
    expect(matchFamilyRole('Dad', facts).role).toBe('father');
    expect(matchFamilyRole('Mom, holding a jar', facts).role).toBe('mother');
  });

  test('generic aliases resolve even with no declared facts', () => {
    expect(matchFamilyRole('Mommy', []).noun).toBe('woman');
    expect(matchFamilyRole('Papa', []).noun).toBe('man');
  });

  test('non-family characters do not match ("Al" vs "small aliens" convention)', () => {
    expect(matchFamilyRole('the robot', facts)).toBeNull();
    expect(matchFamilyRole('Grandma Ruth', facts)).toBeNull();
  });
});

describe('applyFamilyFacts', () => {
  const facts = buildFamilyFacts({ childAnecdotes: anecdotes });
  const manuscript = {
    spreads: [
      { spread: 12, scene_contract: { characters_present: ['Liv', 'Noam', 'Daniel'] } },
      { spread: 13, scene_contract: { characters_present: ['Liv', 'Daniel'] } },
    ],
  };

  test('patches returned parent locks with role, gender, and family look stated first', () => {
    const { castLocks, patched } = applyFamilyFacts({
      castLocks: [{ name: 'Daniel', spreads: [12, 13], design: 'short dark hair, green jacket' }],
      facts,
      manuscript,
    });
    const daniel = castLocks.find((l) => l.name === 'Daniel');
    expect(daniel.design).toMatch(/^the child's father — an adult man/);
    expect(daniel.design).toContain('close biological family');
    expect(daniel.design).toContain('green jacket');
    expect(patched).toEqual(['Daniel']);
  });

  test('synthesizes a lock for a parent present in the manuscript without one', () => {
    const { castLocks, synthesized } = applyFamilyFacts({ castLocks: null, facts, manuscript });
    expect(synthesized.sort()).toEqual(['Daniel', 'Noam']);
    const noam = castLocks.find((l) => l.name === 'Noam');
    expect(noam.design).toMatch(/^the child's mother — an adult woman/);
    expect(noam.spreads).toEqual([12]);
    expect(castLocks.find((l) => l.name === 'Daniel').spreads).toEqual([12, 13]);
  });

  test('does not touch non-family locks and never double-prefixes', () => {
    const already = `the child's father — an adult man; his skin tone matches. Also a green jacket`;
    const { castLocks, patched } = applyFamilyFacts({
      castLocks: [
        { name: 'the robot', spreads: [3, 4], design: 'round silver bot with two antennas' },
        { name: 'Daniel', spreads: [12, 13], design: already },
      ],
      facts,
      manuscript,
    });
    expect(castLocks.find((l) => l.name === 'the robot').design).toBe('round silver bot with two antennas');
    expect(castLocks.find((l) => l.name === 'Daniel').design).toBe(already);
    expect(patched).toEqual([]);
  });
});

describe('director prompt family facts', () => {
  test('the FAMILY CAST FACTS rule rides the art director prompt', () => {
    const note = buildFamilyFactsNote(buildFamilyFacts({ childAnecdotes: anecdotes }));
    expect(note).toContain('"Noam" is the child\'s MOTHER — an adult woman');
    expect(note).toContain('"Daniel" is the child\'s FATHER — an adult man');
    expect(note).toContain('Never invent a contrasting ethnicity');
    const prompt = buildDirectorPrompt({
      manuscript: { title: 'T', spreads: [{ spread: 1, scene_contract: {}, text: 'x' }] },
      ageBand: 'PB_PRESCHOOL',
      familyFactsNote: note,
    });
    expect(prompt).toContain('FAMILY CAST FACTS');
    expect(prompt).toContain('"Daniel" is the child\'s FATHER');
  });

  test('a call-name-only parent still gets the rule', () => {
    const note = buildFamilyFactsNote(buildFamilyFacts({ childAnecdotes: { calls_dad: 'Aba' } }));
    expect(note).toContain('the character the child calls "Aba" is the child\'s FATHER — an adult man');
  });
});
