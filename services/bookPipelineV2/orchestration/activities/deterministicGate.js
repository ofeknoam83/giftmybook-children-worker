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
 *
 * Async because `imperfectRhyme` performs a single LLM call (acoustic
 * rhyme judge). Other checks are synchronous; runGate awaits them
 * uniformly.
 */

const { runGate } = require('../../gate/runGate');

async function deterministicGateActivity(input, ctx) {
  const { draft, beat, ageProfile, protagonistName } = input;
  const result = await runGate(draft, beat, ageProfile, { protagonistName, log: ctx && ctx.log });
  if (!result.passed) {
    ctx.log('warn', `[v2] det gate FAIL spread=${draft?.spread} count=${result.failures.length} codes=${result.failures.map((f) => f.check).join(',')}`);
  } else {
    ctx.log('info', `[v2] det gate PASS spread=${draft?.spread}`);
  }
  return result;
}

module.exports = { deterministicGateActivity };
