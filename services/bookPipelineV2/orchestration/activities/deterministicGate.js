/**
 * Stage 9 — Deterministic Gate (thin wrapper)
 *
 * Runs every check in `gate/runGate.js` against the draft + beat +
 * ageProfile and returns `{ passed, failures }`. Failures are
 * structured so the revision engine can address them surgically.
 *
 * Why this is its own activity (not inlined in the workflow): the
 * artifact store records every gate result, so we can audit "what did
 * the gate flag on attempt 2 of spread 7" forever.
 */

const { runGate } = require('../../gate/runGate');

function deterministicGateActivity(input, ctx) {
  const { draft, beat, ageProfile, protagonistName } = input;
  const result = runGate(draft, beat, ageProfile, { protagonistName });
  if (!result.passed) {
    ctx.log('warn', `[v2] det gate FAIL spread=${draft?.spread} count=${result.failures.length} codes=${result.failures.map((f) => f.check).join(',')}`);
  } else {
    ctx.log('info', `[v2] det gate PASS spread=${draft?.spread}`);
  }
  return result;
}

module.exports = { deterministicGateActivity };
