const { lineStarterRepeatCheck } = require('../../../../services/bookPipelineV2/gate/checks/lineStarterRepeat');

describe('lineStarterRepeatCheck', () => {
  test('passes empty draft', () => {
    expect(lineStarterRepeatCheck({ text: '' }).passed).toBe(true);
  });

  test('passes when starters vary', () => {
    const r = lineStarterRepeatCheck({
      text: 'Mama hums softly.\nThe lamp glows low.\nScarlett blinks slow.\nA breeze drifts in.'
    });
    expect(r.passed).toBe(true);
  });

  test('passes when only 2 of 4 lines share a starter', () => {
    const r = lineStarterRepeatCheck({
      text: 'Mama sways gently.\nMama hums low.\nScarlett blinks.\nA breeze drifts.'
    });
    expect(r.passed).toBe(true);
  });

  test('flags 3 of 4 starting with the same word', () => {
    const r = lineStarterRepeatCheck({
      text: 'Mama sways gently.\nMama hums low.\nMama holds her tight.\nScarlett blinks.'
    });
    expect(r.passed).toBe(false);
    expect(r.code).toBe('line_starter_repeat');
    expect(r.detail.word).toBe('mama');
    expect(r.detail.count).toBe(3);
  });

  test('flags 4 of 4 starting with the same word', () => {
    const r = lineStarterRepeatCheck({
      text: 'The lamp glows.\nThe rug is soft.\nThe blanket warms.\nThe room hums.'
    });
    expect(r.passed).toBe(false);
    expect(r.detail.count).toBe(4);
  });

  test('case-insensitive', () => {
    const r = lineStarterRepeatCheck({
      text: 'mama sways.\nMama hums.\nMAMA holds.\nScarlett blinks.'
    });
    expect(r.passed).toBe(false);
  });
});
