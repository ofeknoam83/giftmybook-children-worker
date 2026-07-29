'use strict';

/**
 * A throwing runBookChecks implementation must FAIL the gate loudly
 * (Copilot review, PR #255): silently skipping book-level hard checks
 * would let a manuscript pass despite a broken check. Mirrors the
 * per-spread `${name}_threw` contract — fails `passed`, feeds revision
 * notes, does not count as a hard code.
 */

jest.mock('../../../../services/bookPipelineV3/gate/checks/bookChecks', () => ({
  runBookChecks: jest.fn(() => { throw new Error('boom'); }),
  containsName: jest.requireActual('../../../../services/bookPipelineV3/gate/checks/bookChecks').containsName,
}));

const { runManuscriptGate } = require('../../../../services/bookPipelineV3/gate/runGate');

const TODDLER = {
  ageBand: 'PB_TODDLER',
  narrativeConstraints: {
    wordsPerSpread: { min: 12, max: 28, target: 20 },
    linesPerSpread: { min: 2, max: 4, target: 4 },
  },
};

const GOOD = 'Liv splashes in the warm pool with her yellow duck.\nShe kicks and laughs and Mom claps along.';

test('a throwing runBookChecks becomes a book_checks_threw failure on the first spread', async () => {
  const m = {
    id: 'A',
    form: 'rhythmic_prose',
    spreads: [{ spread: 1, text: GOOD, lines: GOOD.split('\n'), refrain_here: false }],
  };
  const gate = await runManuscriptGate(m, TODDLER, { protagonistName: 'Liv' });
  expect(gate.passed).toBe(false);
  const s1 = gate.perSpread.find((e) => e.spread === 1);
  const threw = s1.failures.find((f) => f.code === 'book_checks_threw');
  expect(threw).toBeTruthy();
  expect(threw.message).toContain('boom');
  // Same contract as per-spread `${name}_threw`: loud, but not a hard code.
  expect(gate.hardFailureCount).toBe(0);
});
