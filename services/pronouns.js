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
  return `CRITICAL: ${name} is a ${gender === 'female' ? 'girl' : 'boy'}. Always use ${pronouns.pair} pronouns for ${name}. Never use ${wrong} pronouns when referring to ${name}.`;
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

  const wrongPatterns = {
    female: /\b(he|him|his)\b/gi,
    male: /\b(she|her|hers)\b/gi,
  };

  const pattern = wrongPatterns[gender];
  if (!pattern) return { valid: true, issues: [] };

  // Reset lastIndex for the global regex
  pattern.lastIndex = 0;

  const issues = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    issues.push({
      pronoun: match[0],
      position: match.index,
      context: text.substring(Math.max(0, match.index - 20), match.index + 20),
    });
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
