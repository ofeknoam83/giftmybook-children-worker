/**
 * Headline-noun repeat check.
 *
 * AA-CW-25 banned 'Mama' as the headline word AND last word of L4 in
 * the same spread. The rule was prompt-only; the writer ignored it
 * (the literal AA-CW failure: title 'Mama comes by the step.' / L4
 * 'Mama holds her at rest.'). This is the deterministic version.
 *
 * The 'headline noun' is the first capitalized noun of the spread —
 * usually the subject of L1. If it appears as the last word of L4
 * (case-insensitive), fail.
 *
 * We also catch the protagonist's name appearing as both an early
 * subject AND the last word of L4 — the same pattern, just with the
 * child's name instead of 'Mama'.
 */

const { lastWord } = require('./identityRhyme');

function firstSubjectWord(line) {
  if (typeof line !== 'string') return null;
  // First capitalized word that isn't the line's first word being
  // capitalized for sentence case. Heuristic: the first word, if it
  // is a proper noun (capitalized AND not a common sentence-starter),
  // is the subject. We just take the first word and let the caller
  // reason about whether it matches L4's last word.
  const m = line.trim().match(/^([A-Z][a-zA-Z']+)/);
  return m ? m[1].toLowerCase() : null;
}

function headlineNounRepeatCheck(draft, beat, ageProfile, ctx = {}) {
  const text = draft?.text || '';
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 4) return { passed: true };

  const headline = firstSubjectWord(lines[0]);
  const tail = lastWord(lines[3]);
  if (!headline || !tail) return { passed: true };

  // Common sentence-starter words that aren't really 'headline nouns'.
  const SKIP = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'her', 'his', 'its', 'their', 'our', 'my', 'soft', 'when', 'where', 'and', 'but', 'so']);
  if (SKIP.has(headline)) return { passed: true };

  if (headline === tail) {
    return {
      passed: false,
      code: 'headline_noun_repeat',
      message: `Headline noun '${headline}' is also the last word of L4. Pick a different end-word — the spread reads as ${headline}-bookended.`,
      detail: { headline, tail },
    };
  }

  // Also flag the protagonist name in both positions.
  const protagonist = (ctx.protagonistName || '').toLowerCase();
  if (protagonist && headline === protagonist && tail === protagonist) {
    return {
      passed: false,
      code: 'headline_noun_repeat',
      message: `Protagonist name '${protagonist}' is both the headline subject and the last word of L4.`,
      detail: { headline, tail, protagonist },
    };
  }

  return { passed: true };
}

module.exports = { headlineNounRepeatCheck, firstSubjectWord };
