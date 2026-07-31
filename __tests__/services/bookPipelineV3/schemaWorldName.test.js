/**
 * normalizeConcept: the coined world_name (AI Writer Guidelines Step 3)
 * is optional, trimmed, and capped — absent/blank stays null.
 */

const { normalizeConcept } = require('../../../services/bookPipelineV3/schema/document');

const baseConcept = () => ({
  id: 'quest_transformation',
  logline: 'A quest.',
  form_choice: 'rhythmic_prose',
  sample_lines: ['One line.'],
});

describe('normalizeConcept world_name', () => {
  test('accepts and trims a coined world name', () => {
    const c = normalizeConcept({ ...baseConcept(), world_name: '  Giggleopolis  ' });
    expect(c.world_name).toBe('Giggleopolis');
  });

  test('caps at 40 chars', () => {
    const c = normalizeConcept({ ...baseConcept(), world_name: 'x'.repeat(60) });
    expect(c.world_name).toHaveLength(40);
  });

  test('absent, blank, or non-string → null', () => {
    expect(normalizeConcept(baseConcept()).world_name).toBeNull();
    expect(normalizeConcept({ ...baseConcept(), world_name: '   ' }).world_name).toBeNull();
    expect(normalizeConcept({ ...baseConcept(), world_name: 42 }).world_name).toBeNull();
  });
});
