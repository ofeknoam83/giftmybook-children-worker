/**
 * Name-spelling + pronoun lock.
 *
 * The child's name is the one string the buying parent will proof-read on
 * every page. Any near-miss spelling of it (case-insensitive Levenshtein
 * distance 1-2 on a token of similar length) is a hard failure. Wrong-set
 * pronouns (he/him in a she/her book) are the other mid-book identity break
 * parents catch instantly — checked against the brief's canonical pronoun
 * set (ctx.pronouns), skipped for they/them books because singular they
 * coexists with other pronouns in dialogue-free prose too rarely to risk
 * false positives.
 *
 * CAST JUSTIFICATION (2026-07-28): the lock previously hard-failed ANY
 * opposite-set pronoun — "Daddy lifts his hat" in a she/her book bounced
 * the manuscript, and the suggested fix ("name them instead") degrades
 * prose on every family spread. The spread's own scene contract already
 * says who is visibly present, so when `characters_present` names a
 * character whose gendered role explains the pronouns (Dad/Grandpa/brother
 * for he/him; Mom/Grandma/sister for she/her), the pronouns are legitimate
 * and the check passes. No such character → hard-fail exactly as before.
 */

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

const PRONOUN_SETS = {
  she: ['she', 'her', 'hers', 'herself'],
  he: ['he', 'him', 'his', 'himself'],
};

/**
 * Gendered-role cast members that justify opposite-set pronouns on a spread.
 * Matched against scene_contract.characters_present entries (the writer's
 * roster of who is VISIBLE — rule 7 keeps it honest). Same vocabulary family
 * as CAREGIVER_RE in orchestration/activities/illustrationDirector.js, plus
 * siblings/extended kin.
 */
const MALE_CAST_RE = /\b(dad|daddy|dada|father|papa|grandpa|granddad|grandfather|saba|aba|abuelo|brother|uncle|king|prince|boy|man)\b/i;
const FEMALE_CAST_RE = /\b(mom|mommy|mama|mother|grandma|granny|nana|grandmother|savta|ima|abuela|sister|aunt|auntie|queen|princess|girl|woman)\b/i;

function nameLockCheck(draft, beat, ageProfile, ctx = {}) {
  const name = String(ctx.protagonistName || '').trim();
  const text = String(draft?.text || '');
  const tokens = text.split(/[^A-Za-z']+/).filter(Boolean);

  if (name.length >= 3) {
    const lower = name.toLowerCase();
    for (const tok of tokens) {
      const t = tok.toLowerCase();
      if (t === lower) continue;
      // Same first letter + edit distance 1-2 on a similar-length token =
      // near-miss spelling (Zoey/Zoe is a miss; "zone" for "Zoe" is not —
      // require length ≥ 4 for distance 2 to keep precision high).
      if (t[0] !== lower[0]) continue;
      const d = levenshtein(t, lower);
      const nearMiss = (d === 1 && lower.length >= 3 && tok[0] === name[0])
        || (d === 2 && lower.length >= 5);
      // Only flag capitalized tokens — a proper-noun-looking near miss.
      if (nearMiss && /^[A-Z]/.test(tok)) {
        return {
          passed: false,
          code: 'name_misspelled',
          message: `Spread contains '${tok}' which looks like a misspelling of the child's name '${name}'.`,
          detail: { observed: tok, expected: name },
        };
      }
    }
  }

  const subject = String(ctx.pronouns?.subject || '').toLowerCase();
  if (subject === 'she' || subject === 'he') {
    const wrongSet = PRONOUN_SETS[subject === 'she' ? 'he' : 'she'];
    const lowerTokens = tokens.map((t) => t.toLowerCase());
    const hits = wrongSet.filter((p) => lowerTokens.includes(p));
    if (hits.length) {
      // Cast justification: a visible character whose gendered role explains
      // the pronouns makes them legitimate ("Daddy lifts his hat").
      const cast = Array.isArray(draft?.scene_contract?.characters_present)
        ? draft.scene_contract.characters_present : [];
      const justifier = subject === 'she' ? MALE_CAST_RE : FEMALE_CAST_RE;
      const justified = cast.some((c) => justifier.test(String(c)));
      if (!justified) {
        return {
          passed: false,
          code: 'pronoun_lock',
          message: `Spread uses pronoun(s) ${hits.map((h) => `'${h}'`).join(', ')} but the book's canonical set is ${subject}/${ctx.pronouns.object || ''} and no character in characters_present explains them. If a second character needs these pronouns, list them in the scene contract or name them.`,
          detail: { hits, expectedSubject: subject },
        };
      }
    }
  }

  return { passed: true };
}

module.exports = { nameLockCheck, levenshtein };
