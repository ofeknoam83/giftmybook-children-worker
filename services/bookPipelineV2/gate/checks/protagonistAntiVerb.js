/**
 * Protagonist anti-verb check.
 *
 * Catches the specific class of failure 'Scarlett looks where she is
 * kept.' — verbs that turn the protagonist into an object (kept,
 * stored, placed) AND verbs that are developmentally impossible for
 * the protagonist's age band (a lap baby cannot 'walk' or 'shout').
 *
 * The check is per-band. Lexicon: lexicons/protagonistAntiVerbs.json.
 *
 * Heuristic: we look for `<protagonist|she|he|they> (is|was|gets|got)
 * <banned_verb>` and `<protagonist> <banned_verb>` patterns, allowing
 * an article or short adverb in between. This catches the literal
 * failure and most adjacent variants without trying to parse English
 * grammar.
 */

const ANTI = require('../../lexicons/protagonistAntiVerbs.json');

function escape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildPattern(name, verb) {
  // Subjects that refer to the protagonist.
  const subjects = ['she', 'he', 'they', 'her', 'his', 'them'];
  if (name) subjects.unshift(escape(name.toLowerCase()));
  const sub = `(?:${subjects.join('|')})`;
  // is|was|gets|got + (optional short adverb) + verb
  // OR: subject + (optional short adverb) + verb
  return new RegExp(
    `\\b${sub}\\b(?:\\s+(?:is|was|gets|got|will\\s+be|to\\s+be|being))?(?:\\s+\\w+)?\\s+\\b${escape(verb)}\\b`,
    'i',
  );
}

function protagonistAntiVerbCheck(draft, beat, ageProfile, ctx = {}) {
  const text = String(draft?.text || '');
  const ageBand = ageProfile?.ageBand;
  const lex = ANTI.byBand[ageBand];
  if (!lex) return { passed: true };

  const protagonist = ctx.protagonistName || '';
  const failures = [];

  for (const verb of [...(lex.objectifying || []), ...(lex.developmentallyImpossible || [])]) {
    const re = buildPattern(protagonist, verb);
    if (re.test(text)) {
      const isObj = (lex.objectifying || []).includes(verb);
      failures.push({
        verb,
        kind: isObj ? 'objectifying' : 'developmentally_impossible',
      });
    }
  }

  if (!failures.length) return { passed: true };
  return {
    passed: false,
    code: 'protagonist_anti_verb',
    message: failures.map((f) =>
      f.kind === 'objectifying'
        ? `Verb '${f.verb}' is used on the protagonist — that turns ${protagonist || 'the child'} into an object. The protagonist is a person, not a thing being kept/stored/placed.`
        : `Verb '${f.verb}' is developmentally impossible for ${ageBand} (${ctx.ageLabel || 'this age band'}) — pick an action the protagonist can actually perform.`
    ).join(' '),
    detail: failures,
  };
}

module.exports = { protagonistAntiVerbCheck, buildPattern };
