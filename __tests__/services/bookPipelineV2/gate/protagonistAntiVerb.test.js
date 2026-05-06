/**
 * v2 gate — protagonist anti-verb (the literal AA-CW failure
 * 'Scarlett looks where she is kept').
 */

const { protagonistAntiVerbCheck } = require('../../../../services/bookPipelineV2/gate/checks/protagonistAntiVerb');

function draft(lines) { return { text: lines.join('\n'), lines }; }
const beat = {};
const PB_INFANT = { ageBand: 'PB_INFANT' };
const PB_PRESCHOOL = { ageBand: 'PB_PRESCHOOL' };

describe('v2 protagonistAntiVerb gate', () => {
  test('flags "she is kept" on PB_INFANT', () => {
    const d = draft([
      'Mama comes by the step.',
      'Scarlett looks where she is kept.',
      'Light is gold.',
      'Hands to hold.',
    ]);
    expect(protagonistAntiVerbCheck(d, beat, PB_INFANT, { protagonistName: 'Scarlett' }).passed).toBe(false);
  });

  test('flags developmentally impossible verb (walks) on PB_INFANT', () => {
    const d = draft([
      'Scarlett walks through the door.',
      'Mama smiles, "you are sure".',
      'Light is gold.',
      'Hands to hold.',
    ]);
    expect(protagonistAntiVerbCheck(d, beat, PB_INFANT, { protagonistName: 'Scarlett' }).passed).toBe(false);
  });

  test('flags "she is placed" / "he was set"', () => {
    const d = draft([
      'Mama hums by the gate.',
      'She is placed on the slate.',
      'Stars take flight.',
      'Sleep is light.',
    ]);
    expect(protagonistAntiVerbCheck(d, beat, PB_INFANT, { protagonistName: 'Scarlett' }).passed).toBe(false);
  });

  test('clean spread passes on PB_INFANT', () => {
    const d = draft([
      'Mama hums by the door.',
      'Scarlett snuggles, safe and warm.',
      'Light is gold.',
      'Hands to hold.',
    ]);
    expect(protagonistAntiVerbCheck(d, beat, PB_INFANT, { protagonistName: 'Scarlett' }).passed).toBe(true);
  });

  test('"walks" is fine on PB_PRESCHOOL', () => {
    const d = draft([
      'Lila walks through the door.',
      'Bella greets her on the floor.',
      'Light is gold.',
      'Hands to hold.',
    ]);
    expect(protagonistAntiVerbCheck(d, beat, PB_PRESCHOOL, { protagonistName: 'Lila' }).passed).toBe(true);
  });

  test('"she is stored" still flagged on PB_PRESCHOOL (objectifying)', () => {
    const d = draft([
      'A box on the shelf is wide.',
      'She is stored deep inside.',
      'Light glows gold.',
      'Hands to hold.',
    ]);
    expect(protagonistAntiVerbCheck(d, beat, PB_PRESCHOOL, { protagonistName: 'Lila' }).passed).toBe(false);
  });
});
