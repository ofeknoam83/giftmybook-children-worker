/**
 * Book-level HARD gate checks (2026-07-29 QA review, Liv birthday book).
 *
 * Unlike the soft lints in bookLints.js, these are structural breaks the
 * machine refuses to ship — but they live at book scope, so runManuscriptGate
 * merges each failure into the named spread's perSpread entry, after which
 * hardFailureCount / mergeTargets / the surgical gatefix all work unchanged.
 *
 *   opening_beat_name   — review rule 1 (the checkable half): every story
 *                         must open by telling you who the child is. The Liv
 *                         book never introduced her — "the parent gets no
 *                         moment of 'that's my kid'". The child's name must
 *                         appear in spreads 1-2; the fix is attributed to
 *                         spread 1.
 *   parent_name_missing — review rule 4: parent names are mandatory when
 *                         provided, and the ending returns the child to
 *                         them ("Alex and Daniel were collected and never
 *                         used"). For each provided parent, their name — or
 *                         the child's call-name for them (calls_mom /
 *                         calls_dad, the false-positive guard) — must appear
 *                         in the last 3 spreads. Attributed to the last
 *                         spread. Self-disables when ctx.storyRoles is
 *                         absent (pre-storyRoles callers, legacy replays).
 */

const { sortedSpreads } = require('./textUtils');

/** Case-insensitive whole-word presence (accepts possessive "Liv's"). */
function containsName(text, name) {
  const n = String(name || '').trim();
  if (!n) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}(?:[’']s)?\\b`, 'i').test(String(text || ''));
}

/**
 * @param {object} manuscript
 * @param {object} ageProfile
 * @param {{ protagonistName?: string, storyRoles?: object }} ctx
 * @returns {Array<{spread: number, check: string, code: string, message: string, detail?: object}>}
 */
function runBookChecks(manuscript, ageProfile, ctx = {}) {
  const failures = [];
  const spreads = sortedSpreads(manuscript);
  if (spreads.length === 0) return failures;
  const textOf = (s) => String(s.text || (s.lines || []).join('\n'));

  // opening_beat_name — child named in spreads 1-2.
  const name = String(ctx.protagonistName || '').trim();
  if (name) {
    const opening = spreads.slice(0, 2);
    if (!opening.some((s) => containsName(textOf(s), name))) {
      failures.push({
        spread: spreads[0].spread,
        check: 'bookChecks',
        code: 'opening_beat_name',
        message: `the story never names ${name} in the opening spreads — the first spread must introduce the child by name, in her own world, doing a thing she loves (the parent's "that's my kid" moment)`,
        detail: { name, checkedSpreads: opening.map((s) => s.spread) },
      });
    }
  }

  // parent_name_missing — each provided parent present in the last 3 spreads.
  const finalScene = ctx.storyRoles?.finalScene;
  if (finalScene) {
    const ending = spreads.slice(-3);
    const endingText = ending.map(textOf).join('\n');
    const lastSpread = spreads[spreads.length - 1].spread;
    for (const [who, parentName, callName] of [
      ['mom', finalScene.momName, finalScene.callsMom],
      ['dad', finalScene.dadName, finalScene.callsDad],
    ]) {
      if (!parentName) continue;
      if (containsName(endingText, parentName)) continue;
      if (callName && containsName(endingText, callName)) continue;
      failures.push({
        spread: lastSpread,
        check: 'bookChecks',
        code: 'parent_name_missing',
        message: `${who === 'mom' ? 'Mom' : 'Dad'} ${parentName} was provided but never appears in the final spreads (${ending.map((s) => s.spread).join(', ')}) — the ending must return the child to the named parent(s)${callName ? ` (using "${parentName}" or "${callName}")` : ''}; add the parent to the closing scene, do not restructure the story`,
        detail: { who, parentName, callName: callName || null, checkedSpreads: ending.map((s) => s.spread) },
      });
    }
  }

  return failures;
}

module.exports = { runBookChecks, containsName };
