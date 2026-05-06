/**
 * v2 gate — headline-noun repeat (the AA-CW-25 'Mama'+'Mama' L4 trap).
 */

const { headlineNounRepeatCheck } = require('../../../../services/bookPipelineV2/gate/checks/headlineNounRepeat');

function draft(lines) { return { text: lines.join('\n'), lines }; }
const beat = {};
const ageProfile = {};

describe('v2 headlineNounRepeat gate', () => {
  test('passes when headline noun != L4 last word', () => {
    const d = draft([
      'Mama comes by the step.',
      'Scarlett looks where stars are kept.',
      'Light is gold.',
      'Hands to hold.',
    ]);
    expect(headlineNounRepeatCheck(d, beat, ageProfile).passed).toBe(true);
  });

  test('flags Mama-headline + Mama-L4-tail', () => {
    const d = draft([
      'Mama comes by the step.',
      'Scarlett looks where she is kept.',
      'Light glows gold.',
      'Soft holds Mama.',
    ]);
    expect(headlineNounRepeatCheck(d, beat, ageProfile).passed).toBe(false);
  });

  test('flags protagonist-headline + protagonist-L4-tail', () => {
    const d = draft([
      'Scarlett finds a quiet spot.',
      'Light is bright and hot.',
      'Wind sings low.',
      "It calls Scarlett.",
    ]);
    expect(headlineNounRepeatCheck(d, beat, ageProfile).passed).toBe(false);
  });

  test('does not flag common sentence starters (The, A, This)', () => {
    const d = draft([
      'The garden is bright today.',
      'Birds chirp in their way.',
      'Light is gold.',
      'Hands to hold.',
    ]);
    expect(headlineNounRepeatCheck(d, beat, ageProfile).passed).toBe(true);
  });

  test('case-insensitive comparison', () => {
    const d = draft([
      'Mama comes by the step.',
      'Light is bright.',
      'Stars take flight.',
      'soft holds mama.',
    ]);
    expect(headlineNounRepeatCheck(d, beat, ageProfile).passed).toBe(false);
  });
});
