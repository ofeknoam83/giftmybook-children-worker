/**
 * v2 gate — identityRhyme port (AA-CW-29).
 *
 * Same semantics as v1's detectIdentityRhyme (AA-CW-27): flag L1/L2 or
 * L3/L4 last-word equality (case-insensitive, punctuation-stripped).
 */

const { identityRhymeCheck } = require('../../../../services/bookPipelineV2/gate/checks/identityRhyme');

function draftFromLines(lines) { return { text: lines.join('\n'), lines }; }
const beat = {};
const ageProfile = {};

describe('v2 identityRhyme gate', () => {
  test('passes a clean rhyming spread', () => {
    const d = draftFromLines([
      'Mama says, "Smushy," dear.',
      'Scarlett smiles to hear.',
      'Doorway light looks gold.',
      "Her cheek rests in Mama's hold.",
    ]);
    expect(identityRhymeCheck(d, beat, ageProfile).passed).toBe(true);
  });

  test('flags L1/L2 identity rhyme on bare repetition', () => {
    const d = draftFromLines([
      'Scarlett sees green trees.',
      'Mama hums beneath the trees.',
      'Light is gold.',
      "Mama's hold.",
    ]);
    const r = identityRhymeCheck(d, beat, ageProfile);
    expect(r.passed).toBe(false);
    expect(r.detail || r.message).toBeTruthy();
  });

  test('flags L3/L4 identity rhyme', () => {
    const d = draftFromLines([
      'A is here.',
      'B is near.',
      'Mama hums to the breeze.',
      'Scarlett rests with the breeze.',
    ]);
    expect(identityRhymeCheck(d, beat, ageProfile).passed).toBe(false);
  });

  test('case-insensitive: "Mama" vs "mama" still flagged', () => {
    const d = draftFromLines([
      'Smush goes Mama.',
      'Smile says mama.',
      'Light is gold.',
      "Cheek to hold.",
    ]);
    expect(identityRhymeCheck(d, beat, ageProfile).passed).toBe(false);
  });

  test('strips trailing punctuation when comparing last words', () => {
    const d = draftFromLines([
      'See the trees.',
      'Sun in the trees!',
      'Light is gold.',
      "Cheek to hold.",
    ]);
    expect(identityRhymeCheck(d, beat, ageProfile).passed).toBe(false);
  });

  test('does not flag a real perfect rhyme (gold/hold)', () => {
    const d = draftFromLines([
      'Soft is the breeze.',
      'Quiet through the trees.',
      'Lamps glow gold.',
      "Hands gentle to hold.",
    ]);
    expect(identityRhymeCheck(d, beat, ageProfile).passed).toBe(true);
  });
});
