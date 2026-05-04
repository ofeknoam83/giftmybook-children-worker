const {
  ageRules,
  renderTextPolicyBlock,
} = require('../../../services/bookPipeline/writer/textPolicies');
const { AGE_BANDS, FORMATS } = require('../../../services/bookPipeline/constants');

describe('textPolicies ageRules', () => {
  test('returns infant-specific guidance for PB_INFANT', () => {
    const r = ageRules(AGE_BANDS.PB_INFANT);
    expect(r).toBeDefined();
    // Hard guarantees the lap-baby band relies on:
    // - sensory observation only, no plot, no dialogue
    // - the book is read TO the baby BY the parent
    // - tiny vocabulary
    expect(r.voice).toMatch(/baby/i);
    expect(r.voice).toMatch(/sensory|observation/i);
    expect(r.voice).toMatch(/no\s+(conflict|plot|dialogue)/i);
    expect(r.vocabulary).toMatch(/Mama|Dada/);
  });

  test('toddler band still returns toddler-shaped guidance (no regression)', () => {
    const r = ageRules(AGE_BANDS.PB_TODDLER);
    expect(r).toBeDefined();
    expect(r.voice).toBeTruthy();
  });

  test('preschool and early-reader bands unchanged', () => {
    expect(ageRules(AGE_BANDS.PB_PRESCHOOL)).toBeDefined();
    expect(ageRules(AGE_BANDS.ER_EARLY)).toBeDefined();
  });
});

describe('textPolicies renderTextPolicyBlock — infant structure', () => {
  function buildDoc(ageBand) {
    return {
      request: { ageBand, format: FORMATS.PICTURE_BOOK, theme: 'mothers_day' },
      brief: { child: { name: 'Scarlett', age: 0.58 }, customDetails: {} },
    };
  }

  test('infant block prescribes EXACTLY 2 lines per spread (AA couplet)', () => {
    const block = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_INFANT));
    expect(block).toMatch(/EXACTLY 2 lines/);
    expect(block).toMatch(/AA/);
    // Must NOT silently inherit the 4-line picture-book rule.
    expect(block).not.toMatch(/EXACTLY 4 lines/);
    expect(block).not.toMatch(/AABB/);
  });

  test('infant block forbids locomotion verbs in the writer prompt', () => {
    const block = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_INFANT));
    // Whitelist appears
    expect(block).toMatch(/sees|smiles|reaches|snuggles/);
    // Forbidden verbs are explicitly named
    expect(block).toMatch(/walks|runs|climbs/);
  });

  test('toddler band keeps the 4-line AABB rule (no regression from infant change)', () => {
    const block = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_TODDLER));
    expect(block).toMatch(/EXACTLY 4 lines/);
    expect(block).toMatch(/AABB/);
  });

  test('preschool band keeps the 4-line AABB rule', () => {
    const block = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_PRESCHOOL));
    expect(block).toMatch(/EXACTLY 4 lines/);
    expect(block).toMatch(/AABB/);
  });
});
