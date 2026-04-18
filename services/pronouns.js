/**
 * Shared pronoun utility for gender-consistent text generation.
 *
 * Used by prompt builders and post-generation validation to ensure
 * the protagonist's pronouns match their declared gender.
 */

/**
 * Map a gender string to pronoun forms.
 * @param {string} gender - 'female', 'male', or anything else (defaults to they/them)
 * @returns {{ subject: string, object: string, possessive: string, pair: string }}
 */
function getPronounInfo(gender) {
  if (gender === 'female') return { subject: 'she', object: 'her', possessive: 'her', pair: 'she/her' };
  if (gender === 'male') return { subject: 'he', object: 'him', possessive: 'his', pair: 'he/him' };
  return { subject: 'they', object: 'them', possessive: 'their', pair: 'they/them' };
}

/**
 * Get the wrong-gender pronouns for a given gender (used in prompt instructions).
 * @param {string} gender
 * @returns {string}
 */
function getWrongPronouns(gender) {
  if (gender === 'female') return 'he/him/his';
  if (gender === 'male') return 'she/her/hers';
  return '';
}

/**
 * Build a prompt instruction line for pronoun enforcement.
 * @param {string} name - child's name
 * @param {string} gender
 * @returns {string}
 */
function buildPronounInstruction(name, gender) {
  if (!gender || gender === 'neutral' || gender === 'not specified') return '';
  const pronouns = getPronounInfo(gender);
  const wrong = getWrongPronouns(gender);
  return `CRITICAL PRONOUN RULE: ${name} is a ${gender === 'female' ? 'girl' : 'boy'}. ALWAYS use ${pronouns.pair} pronouns for ${name}. NEVER use ${wrong} pronouns. NEVER use they/them/their to refer to ${name} alone — "they" is ONLY acceptable when referring to ${name} AND another person together (plural). When in doubt, use "${name}" instead of a pronoun.`;
}

/**
 * Check generated text for wrong-gender pronouns.
 * Uses word-boundary regex to avoid false positives (e.g., "the" matching "he").
 *
 * @param {string} text
 * @param {string} gender - 'female', 'male', or 'neutral'
 * @returns {{ valid: boolean, issues: Array<{ pronoun: string, position: number, context: string }> }}
 */
function checkPronounConsistency(text, gender) {
  if (!gender || gender === 'neutral' || gender === 'not specified') {
    return { valid: true, issues: [] };
  }

  // Check for opposite-gender pronouns
  const wrongPatterns = {
    female: /\b(he|him|his)\b/gi,
    male: /\b(she|her|hers)\b/gi,
  };

  // Also check for they/them/their when gender IS specified — the child is not non-binary
  const neutralPattern = /\b(they|them|their|themself|themselves)\b/gi;

  const issues = [];

  const pattern = wrongPatterns[gender];
  if (pattern) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      issues.push({
        pronoun: match[0],
        type: 'wrong-gender',
        position: match.index,
        context: text.substring(Math.max(0, match.index - 20), match.index + 20),
      });
    }
  }

  // Check for neutral pronouns used for the child (they/them/their)
  // Exclude cases where "they" clearly refers to a plural subject (e.g., "they both")
  neutralPattern.lastIndex = 0;
  let neutralMatch;
  while ((neutralMatch = neutralPattern.exec(text)) !== null) {
    const beforeContext = text.substring(Math.max(0, neutralMatch.index - 40), neutralMatch.index).toLowerCase();
    // Skip if likely plural usage ("parents they", "dogs they", "together they", etc.)
    const likelyPlural = /\b(parents|dogs|birds|friends|children|kids|people|both|together|everyone|all)\s*$/.test(beforeContext);
    if (!likelyPlural) {
      issues.push({
        pronoun: neutralMatch[0],
        type: 'neutral-for-gendered',
        position: neutralMatch.index,
        context: text.substring(Math.max(0, neutralMatch.index - 20), neutralMatch.index + 20),
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Simple string replacement for protagonist pronouns.
 * Fast and free — used as first-pass correction before LLM fallback.
 *
 * @param {string} text
 * @param {string} gender - target gender ('female' or 'male')
 * @returns {string}
 */
function simpleReplace(text, gender) {
  if (gender === 'female') {
    return text
      .replace(/\bHe\b/g, 'She')
      .replace(/\bhe\b/g, 'she')
      .replace(/\bHim\b/g, 'Her')
      .replace(/\bhim\b/g, 'her')
      .replace(/\bHis\b/g, 'Her')
      .replace(/\bhis\b/g, 'her');
  }
  if (gender === 'male') {
    return text
      .replace(/\bShe\b/g, 'He')
      .replace(/\bshe\b/g, 'he')
      .replace(/\bHer\b/g, 'Him')
      .replace(/\bher\b/g, 'him')
      .replace(/\bHers\b/g, 'His')
      .replace(/\bhers\b/g, 'his');
  }
  return text;
}

module.exports = {
  getPronounInfo,
  getWrongPronouns,
  buildPronounInstruction,
  checkPronounConsistency,
  simpleReplace,
};
