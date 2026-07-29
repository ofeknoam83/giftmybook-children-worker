'use strict';

/**
 * Book-level HARD checks (2026-07-29 QA review): opening_beat_name +
 * parent_name_missing. The Liv book never introduced Liv and never used
 * Alex or Daniel.
 */

const { runBookChecks, containsName } = require('../../../../services/bookPipelineV3/gate/checks/bookChecks');

const TODDLER = { ageBand: 'PB_TODDLER' };

const ms = (texts) => ({ spreads: texts.map((text, i) => ({ spread: i + 1, text })) });

const thirteen = (overrides = {}) => {
  const texts = Array.from({ length: 13 }, (_, i) => `Liv splashes on spread ${i + 1}.`);
  for (const [idx, text] of Object.entries(overrides)) texts[idx] = text;
  return ms(texts);
};

describe('containsName', () => {
  test('whole-word, case-insensitive, accepts possessive', () => {
    expect(containsName('That is Liv’s boat.', 'Liv')).toBe(true);
    expect(containsName('she lives here', 'Liv')).toBe(false);
    expect(containsName('LIV laughs.', 'liv')).toBe(true);
  });
});

describe('opening_beat_name', () => {
  test('fails when the child is never named in spreads 1-2, attributed to spread 1', () => {
    const m = thirteen({ 0: 'A lagoon glitters at night.', 1: 'A balloon floats by.' });
    const failures = runBookChecks(m, TODDLER, { protagonistName: 'Liv' });
    const f = failures.find((x) => x.code === 'opening_beat_name');
    expect(f).toBeTruthy();
    expect(f.spread).toBe(1);
    expect(f.message).toContain('Liv');
  });

  test('passes when the name appears on spread 2', () => {
    const m = thirteen({ 0: 'A lagoon glitters at night.' });
    expect(runBookChecks(m, TODDLER, { protagonistName: 'Liv' })
      .some((x) => x.code === 'opening_beat_name')).toBe(false);
  });

  test('self-disables without a protagonist name', () => {
    const m = thirteen({ 0: 'A lagoon.', 1: 'A balloon.' });
    expect(runBookChecks(m, TODDLER, {}).some((x) => x.code === 'opening_beat_name')).toBe(false);
  });
});

describe('parent_name_missing', () => {
  const roles = {
    finalScene: { momName: 'Alex', dadName: 'Daniel', callsMom: 'Mama', callsDad: null },
  };

  test('fails per missing parent, attributed to the last spread', () => {
    const m = thirteen();
    const failures = runBookChecks(m, TODDLER, { protagonistName: 'Liv', storyRoles: roles });
    const parents = failures.filter((x) => x.code === 'parent_name_missing');
    expect(parents).toHaveLength(2);
    expect(parents.every((f) => f.spread === 13)).toBe(true);
    expect(parents.map((f) => f.detail.parentName).sort()).toEqual(['Alex', 'Daniel']);
  });

  test('the real name in the last 3 spreads satisfies the check', () => {
    const m = thirteen({ 12: 'Liv runs to Alex and Daniel for a big hug.' });
    expect(runBookChecks(m, TODDLER, { protagonistName: 'Liv', storyRoles: roles })
      .some((x) => x.code === 'parent_name_missing')).toBe(false);
  });

  test('the call-name is the false-positive guard ("Mama" counts for mom)', () => {
    const m = thirteen({ 11: 'Mama scoops Liv up and Daniel laughs.' });
    expect(runBookChecks(m, TODDLER, { protagonistName: 'Liv', storyRoles: roles })
      .some((x) => x.code === 'parent_name_missing')).toBe(false);
  });

  test('a parent named only mid-book still fails (the ending must return to them)', () => {
    const m = thirteen({ 4: 'Alex and Daniel wave from the shore.' });
    const parents = runBookChecks(m, TODDLER, { protagonistName: 'Liv', storyRoles: roles })
      .filter((x) => x.code === 'parent_name_missing');
    expect(parents).toHaveLength(2);
  });

  test('self-disables without storyRoles (legacy replays)', () => {
    const m = thirteen();
    expect(runBookChecks(m, TODDLER, { protagonistName: 'Liv' })
      .some((x) => x.code === 'parent_name_missing')).toBe(false);
  });
});
