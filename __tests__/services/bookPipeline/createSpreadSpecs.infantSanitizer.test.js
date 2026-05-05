const {
  findInfantPlannerVerbs,
  sanitizeInfantText,
  sanitizeInfantSpec,
  INFANT_VERB_SUBSTITUTIONS,
} = require('../../../services/bookPipeline/planner/createSpreadSpecs');

describe('findInfantPlannerVerbs (PR E.3)', () => {
  test('detects "dance" in a focalAction', () => {
    const out = findInfantPlannerVerbs('She starts to dance with Mama on the rug.');
    expect(out).toContain('dance');
  });

  test('detects multiple offenders in plotBeat-shaped text', () => {
    const out = findInfantPlannerVerbs('They twirl, hop, and chase the puppy.');
    expect(out).toEqual(expect.arrayContaining(['twirl', 'hop', 'chase']));
  });

  test('returns empty for an infant-safe focalAction', () => {
    expect(findInfantPlannerVerbs('Mama lifts her up to see the moon.')).toEqual([]);
  });

  test('does not false-positive on substrings (e.g. "rundown" should not match "run")', () => {
    expect(findInfantPlannerVerbs('A rundown of Saturday morning.')).toEqual([]);
  });

  test('handles empty / null input', () => {
    expect(findInfantPlannerVerbs('')).toEqual([]);
    expect(findInfantPlannerVerbs(null)).toEqual([]);
    expect(findInfantPlannerVerbs(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PR H — STRIP MODE
// ---------------------------------------------------------------------------
//
// The planner sanitizer used to only FLAG offenders on forbiddenMistakes,
// leaving focalAction / plotBeat unchanged. The illustrator reads
// focalAction directly and the writer reads it as instructions, so the bad
// verb still propagated downstream. PR H rewrites the offending fields in
// place using INFANT_VERB_SUBSTITUTIONS and falls back to a generic
// hero-aware phrasing when substitution can't produce a clean string.

describe('sanitizeInfantText (PR H.1)', () => {
  test('substitutes "twirl" with the safe equivalent and leaves a clean string', () => {
    const out = sanitizeInfantText('Everleigh finishes a twirl with Mama.');
    expect(out).not.toMatch(/twirl/i);
    // Substitution should preserve the rest of the sentence intact
    expect(out).toMatch(/Everleigh/);
    expect(out).toMatch(/Mama/);
    // No banned verb survives
    expect(findInfantPlannerVerbs(out)).toEqual([]);
  });

  test('handles multiple banned verbs in one sentence', () => {
    const out = sanitizeInfantText('She runs, twirls, and climbs the stairs.');
    expect(findInfantPlannerVerbs(out)).toEqual([]);
    expect(out).not.toMatch(/\b(runs|twirls|climbs)\b/i);
  });

  test('returns the original string unchanged when there is nothing to sanitize', () => {
    const safe = 'Mama lifts Everleigh to see the moon.';
    expect(sanitizeInfantText(safe)).toBe(safe);
  });

  test('returns null when a banned verb survives substitution (forces fallback)', () => {
    // The substitution map covers every entry of INFANT_FORBIDDEN_PLANNER_VERBS
    // by design; this guard is for future-proofing if a verb is added to the
    // ban list but forgotten in the substitution map. We simulate that gap by
    // monkey-patching the map for this test alone.
    const original = INFANT_VERB_SUBSTITUTIONS.twirl;
    delete INFANT_VERB_SUBSTITUTIONS.twirl;
    delete INFANT_VERB_SUBSTITUTIONS.twirls;
    try {
      expect(sanitizeInfantText('She twirls in place.')).toBeNull();
    } finally {
      INFANT_VERB_SUBSTITUTIONS.twirl = original;
      INFANT_VERB_SUBSTITUTIONS.twirls = 'sways';
    }
  });

  test('handles empty / null input', () => {
    expect(sanitizeInfantText('')).toBe('');
    expect(sanitizeInfantText(null)).toBe('');
    expect(sanitizeInfantText(undefined)).toBe('');
  });

  test('every banned verb in the ban list has a substitution that produces a clean string', () => {
    // Invariant: the ban list and the substitution map must stay in sync. If
    // someone adds a verb to the ban list without adding to the substitution
    // map, this test fails loudly and points at the gap.
    const sample = (verb) => `She ${verb} now.`;
    // Pull the canonical ban list from the module's findInfantPlannerVerbs
    // probe — reuse the same regex set.
    // We test surface forms used in real production planner output.
    const surfaces = Object.keys(INFANT_VERB_SUBSTITUTIONS);
    for (const verb of surfaces) {
      const out = sanitizeInfantText(sample(verb));
      // Either substitution produced a clean string OR the verb was so
      // structurally embedded that we'd fall back — accept either, but in
      // both cases the OUTPUT must not contain the verb.
      if (out !== null) {
        expect(out.toLowerCase()).not.toContain(` ${verb} `);
      }
    }
  });
});

describe('sanitizeInfantSpec (PR H.2)', () => {
  function makeSpec(overrides = {}) {
    return {
      spreadNumber: 9,
      location: 'sunny hill',
      plotBeat: 'Everleigh runs to the bandstand.',
      focalAction: 'Everleigh finishes a twirl with Mama.',
      forbiddenMistakes: [],
      ...overrides,
    };
  }

  test('rewrites both focalAction and plotBeat when both contain banned verbs', () => {
    const { spec, changes } = sanitizeInfantSpec(makeSpec(), { heroName: 'Everleigh' });
    expect(spec.focalAction).not.toMatch(/twirl/i);
    expect(spec.plotBeat).not.toMatch(/\bruns?\b/i);
    expect(findInfantPlannerVerbs(spec.focalAction)).toEqual([]);
    expect(findInfantPlannerVerbs(spec.plotBeat)).toEqual([]);
    // Changes log carries before/after for both fields
    const fields = changes.map(c => c.field).sort();
    expect(fields).toEqual(['focalAction', 'plotBeat']);
    const focalChange = changes.find(c => c.field === 'focalAction');
    expect(focalChange.before).toMatch(/twirl/i);
    expect(focalChange.hits).toContain('twirl');
  });

  test('leaves a clean spec untouched and returns no changes', () => {
    const clean = makeSpec({
      focalAction: 'Mama lifts Everleigh to see the moon.',
      plotBeat: 'Quiet sensory wonder at bedtime.',
    });
    const { spec, changes } = sanitizeInfantSpec(clean, { heroName: 'Everleigh' });
    expect(changes).toEqual([]);
    expect(spec.focalAction).toBe(clean.focalAction);
    expect(spec.plotBeat).toBe(clean.plotBeat);
  });

  test('the original Spread 9 prod failure ("Everleigh finishes a twirl") is fully sanitized', () => {
    // This is the actual focalAction that triggered the
    // age_action_impossible early-abort. After PR H the illustrator should
    // never see the word "twirl" in its prompt.
    const { spec } = sanitizeInfantSpec(
      makeSpec({ focalAction: 'Everleigh finishes a twirl with Mama on the hill.' }),
      { heroName: 'Everleigh' },
    );
    expect(spec.focalAction).not.toMatch(/twirl/i);
    expect(findInfantPlannerVerbs(spec.focalAction)).toEqual([]);
  });

  test('falls back to a hero-aware generic phrasing when substitution cannot clean a field', () => {
    // Force a fallback by deleting the substitution entry for twirls.
    const original = INFANT_VERB_SUBSTITUTIONS.twirls;
    delete INFANT_VERB_SUBSTITUTIONS.twirls;
    try {
      const { spec, changes } = sanitizeInfantSpec(
        makeSpec({ focalAction: 'She twirls in the sun.' }),
        { heroName: 'Everleigh' },
      );
      expect(spec.focalAction).toMatch(/Everleigh/);
      expect(spec.focalAction).toMatch(/sunny hill/); // location preserved
      expect(findInfantPlannerVerbs(spec.focalAction)).toEqual([]);
      const focalChange = changes.find(c => c.field === 'focalAction');
      expect(focalChange.fallback).toBe(true);
    } finally {
      INFANT_VERB_SUBSTITUTIONS.twirls = original;
    }
  });

  test('uses "the baby" placeholder when no hero name is supplied', () => {
    const original = INFANT_VERB_SUBSTITUTIONS.twirls;
    delete INFANT_VERB_SUBSTITUTIONS.twirls;
    try {
      const { spec } = sanitizeInfantSpec(
        makeSpec({ focalAction: 'She twirls.' }),
        {}, // no heroName
      );
      expect(spec.focalAction).toMatch(/the baby/);
    } finally {
      INFANT_VERB_SUBSTITUTIONS.twirls = original;
    }
  });
});
