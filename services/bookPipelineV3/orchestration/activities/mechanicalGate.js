/**
 * W4 — Mechanical Gate (activity wrapper).
 *
 * Pure synchronous checks (no LLM) via gate/runGate. Wrapped as an
 * activity so the result is persisted as an artifact per manuscript per
 * round — "what did the gate see" stays answerable.
 */

const { runManuscriptGate } = require('../../gate/runGate');

/**
 * @param {{ manuscript: object, ageProfile: object, brief: object }} input
 */
async function mechanicalGateActivity(input, ctx) {
  const { manuscript, ageProfile, brief } = input;
  const gate = await runManuscriptGate(manuscript, ageProfile, {
    protagonistName: brief?.child?.name,
    pronouns: brief?.constraints?.pronouns,
    bannedElements: brief?.constraints?.banned_elements,
    storyRoles: brief?.storyRoles,
    interests: brief?.interests,
  });
  const failedSpreads = gate.perSpread.filter((e) => !e.passed);
  ctx.log(
    gate.passed ? 'info' : 'warn',
    `[v3] gate(${manuscript.id}): ${gate.passed ? 'PASS' : `FAIL spreads=[${failedSpreads.map((e) => e.spread).join(',')}] hard=${gate.hardFailureCount}`}`,
  );
  if (gate.softLints?.length) {
    ctx.log('info', `[v3] gate(${manuscript.id}): ${gate.softLints.length} soft lint(s) — ${gate.softLints.map((l) => l.code).join(', ')}`);
  }
  return { manuscriptId: manuscript.id, ...gate };
}

module.exports = { mechanicalGateActivity };
