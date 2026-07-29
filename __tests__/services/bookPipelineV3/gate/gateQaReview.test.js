'use strict';

/**
 * 2026-07-29 QA-review gate wiring: book-check failures merge into
 * perSpread, the new codes count as hard, and BOOK_PIPELINE_V3_QA_HARD=0
 * demotes exactly them (checks still run, notes still flow) — the safe
 * first-deploy posture.
 */

const {
  runManuscriptGate, isHardCode, hardFailures, HARD_GATE_CODES, QA_REVIEW_HARD_CODES,
} = require('../../../../services/bookPipelineV3/gate/runGate');

const TODDLER = {
  ageBand: 'PB_TODDLER',
  narrativeConstraints: {
    wordsPerSpread: { min: 12, max: 28, target: 20 },
    linesPerSpread: { min: 2, max: 4, target: 4 },
  },
};

const contract = {
  setting: 'the pool', characters_present: ['Liv'], hero_action: 'splashes',
  emotion: 'joy', key_objects: ['duck'], time_of_day: 'day', continuity_notes: '',
};

function manuscript(texts) {
  return {
    id: 'A',
    form: 'rhythmic_prose',
    spreads: texts.map((text, i) => ({
      spread: i + 1, text, lines: text.split('\n'), scene_contract: contract, refrain_here: false,
    })),
  };
}

const GOOD = 'Liv splashes in the warm pool with her yellow duck.\nShe kicks and laughs and Mom claps along.';
const NO_NAME = 'The pool glitters in the sun all day long.\nA yellow duck floats along past the steps.';

afterEach(() => {
  delete process.env.BOOK_PIPELINE_V3_QA_HARD;
});

describe('QA-review hard codes', () => {
  test('the four new codes are in HARD_GATE_CODES and hard by default', () => {
    for (const code of ['banned_word', 'midline_punctuation', 'opening_beat_name', 'parent_name_missing']) {
      expect(HARD_GATE_CODES.has(code)).toBe(true);
      expect(QA_REVIEW_HARD_CODES.has(code)).toBe(true);
      expect(isHardCode(code)).toBe(true);
    }
  });

  test('BOOK_PIPELINE_V3_QA_HARD=0 demotes only the new codes', () => {
    process.env.BOOK_PIPELINE_V3_QA_HARD = '0';
    expect(isHardCode('banned_word')).toBe(false);
    expect(isHardCode('opening_beat_name')).toBe(false);
    expect(isHardCode('word_budget')).toBe(true); // legacy hard codes untouched
    expect(isHardCode('banned_word_soft')).toBe(false); // never hard
  });

  test('hardFailures honors the env', () => {
    const failures = [{ code: 'banned_word' }, { code: 'word_budget' }, { code: 'banned_word_soft' }];
    expect(hardFailures(failures).map((f) => f.code)).toEqual(['banned_word', 'word_budget']);
    process.env.BOOK_PIPELINE_V3_QA_HARD = '0';
    expect(hardFailures(failures).map((f) => f.code)).toEqual(['word_budget']);
  });
});

describe('runManuscriptGate book-check merge', () => {
  test('opening_beat_name lands on spread 1 and counts hard', async () => {
    const m = manuscript([NO_NAME, NO_NAME, GOOD]);
    const gate = await runManuscriptGate(m, TODDLER, { protagonistName: 'Liv' });
    const s1 = gate.perSpread.find((e) => e.spread === 1);
    expect(s1.passed).toBe(false);
    expect(s1.failures.some((f) => f.code === 'opening_beat_name')).toBe(true);
    expect(gate.hardFailureCount).toBeGreaterThanOrEqual(1);
  });

  test('with QA_HARD=0 the failure still lands (revision notes) but does not count hard', async () => {
    process.env.BOOK_PIPELINE_V3_QA_HARD = '0';
    const m = manuscript([NO_NAME, NO_NAME, GOOD]);
    const gate = await runManuscriptGate(m, TODDLER, { protagonistName: 'Liv' });
    const s1 = gate.perSpread.find((e) => e.spread === 1);
    expect(s1.failures.some((f) => f.code === 'opening_beat_name')).toBe(true);
    expect(gate.passed).toBe(false);
    expect(gate.hardFailureCount).toBe(0);
  });

  test('parent_name_missing rides ctx.storyRoles onto the last spread', async () => {
    const m = manuscript([GOOD, GOOD, GOOD]);
    const gate = await runManuscriptGate(m, TODDLER, {
      protagonistName: 'Liv',
      storyRoles: { finalScene: { momName: 'Alex', dadName: null, callsMom: null, callsDad: null } },
    });
    const last = gate.perSpread.find((e) => e.spread === 3);
    expect(last.failures.some((f) => f.code === 'parent_name_missing')).toBe(true);
  });

  test('a clean toddler manuscript still passes end-to-end', async () => {
    const m = manuscript([GOOD, 'Liv finds her red ball under the big green towel.\nShe hugs it tight and giggles at Mom.']);
    const gate = await runManuscriptGate(m, TODDLER, { protagonistName: 'Liv' });
    expect(gate.passed).toBe(true);
    expect(gate.hardFailureCount).toBe(0);
  });
});
