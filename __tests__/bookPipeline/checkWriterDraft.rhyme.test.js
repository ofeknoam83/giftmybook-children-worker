const {
  deterministicCheck,
  rhymeLazyStemEcho,
} = require('../../services/bookPipeline/qa/checkWriterDraft');
const { FORMATS, AGE_BANDS } = require('../../services/bookPipeline/constants');

const pbDoc = {
  request: { format: FORMATS.PICTURE_BOOK, ageBand: AGE_BANDS.PB_PRESCHOOL },
};

function spreadWithText(text) {
  return {
    spreadNumber: 1,
    manuscript: { text, side: 'right' },
    spec: { textSide: 'right' },
  };
}

describe('checkWriterDraft deterministic rhyme quality', () => {
  test('rhymeLazyStemEcho detects glow/glows', () => {
    expect(rhymeLazyStemEcho('glow', 'glows')).toBe(true);
    expect(rhymeLazyStemEcho('sky', 'high')).toBe(false);
    expect(rhymeLazyStemEcho('heart', 'heart')).toBe(false);
  });

  test('identical end words in couplet 3–4', () => {
    const text = [
      'By pennants, Roman beams',
      'Flour dust shines in sunbeams',
      "Mama's hand helps shape the heart",
      'Stars and circles make the heart',
    ].join('\n');
    const r = deterministicCheck(spreadWithText(text), pbDoc);
    expect(r.tags).toContain('identical_rhyme');
    expect(r.issues.some((i) => /same ending word/i.test(i))).toBe(true);
  });

  test('lazy stem echo in couplet 1–2 (glow/glows)', () => {
    const text = [
      'The oven starts to glow',
      'Then every cookie glows',
      'He lifts one high with cheer',
      'A happy taste draws near',
    ].join('\n');
    const r = deterministicCheck(spreadWithText(text), pbDoc);
    expect(r.tags).toContain('lazy_rhyme_echo');
    expect(r.tags).not.toContain('identical_rhyme');
  });

  test('valid near-rhyme pair passes without identical_rhyme', () => {
    const text = [
      'Gold glass roofs shine bright',
      'Roman grabs the rail tight',
      'The recipe card swoops down',
      "Mama's smile removes his frown",
    ].join('\n');
    const r = deterministicCheck(spreadWithText(text), pbDoc);
    expect(r.tags).not.toContain('identical_rhyme');
    expect(r.tags).not.toContain('lazy_rhyme_echo');
  });
});
