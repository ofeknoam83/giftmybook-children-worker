/**
 * v2 gate — imperfect rhyme (catches the AA-CW (this session) failure
 * 'step / kept' shipped as a rhyme).
 */

const { imperfectRhymeCheck } = require('../../../../services/bookPipelineV2/gate/checks/imperfectRhyme');

function draftFromLines(lines) { return { text: lines.join('\n'), lines }; }
const beat = {};
const ageProfile = { narrativeConstraints: { rhymeScheme: 'AABB', rhymeStrictness: 'perfect_rhyme_required_imperfect_eye_rhymes_banned' } };

describe('v2 imperfectRhyme gate', () => {
  test('passes a clean perfect rhyme couplet (gold/hold)', () => {
    const d = draftFromLines([
      'Lamps glow gold.',
      'Hands to hold.',
      'Trees bend low.',
      'Wind sings slow.',
    ]);
    expect(imperfectRhymeCheck(d, beat, ageProfile).passed).toBe(true);
  });

  test('flags step/kept as imperfect (different codas)', () => {
    const d = draftFromLines([
      'Mama comes by the step.',
      'Scarlett looks where she is kept.',
      'Lamps glow gold.',
      'Hands to hold.',
    ]);
    expect(imperfectRhymeCheck(d, beat, ageProfile).passed).toBe(false);
  });

  test('flags eye-rhyme light/like across the L1/L2 couplet', () => {
    const d = draftFromLines([
      'Sun pours soft light.',
      'Mama loves what she likes.',
      'Lamps glow gold.',
      'Hands to hold.',
    ]);
    expect(imperfectRhymeCheck(d, beat, ageProfile).passed).toBe(false);
  });

  test('does not run when ageProfile says perfect rhyme is not required', () => {
    const profile = { narrativeConstraints: { rhymeScheme: 'free', rhymeStrictness: 'free' } };
    const d = draftFromLines([
      'A b c step.',
      'D e f kept.',
      'G h i gold.',
      'J k l hold.',
    ]);
    // free verse: imperfect rhyme should not be enforced
    const r = imperfectRhymeCheck(d, beat, profile);
    expect(r.passed).toBe(true);
  });
});
