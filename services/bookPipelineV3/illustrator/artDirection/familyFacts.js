/**
 * Family cast facts (2026-08-02 customer feedback: a book's MOTHER and
 * FATHER — mom_name "…", dad_name "Daniel" — rendered as two men, one Black
 * and one white).
 *
 * Root cause: the art director invents every supporting character's design
 * (hair, skin tone, outfit) from nothing but the name strings in
 * characters_present. Parent names are customer data with a declared role
 * (the questionnaire asks for MOM's name and DAD's name separately), but
 * that role never reached the illustrator — so the vision model guessed
 * gender from the names and invented skin tones per character instead of
 * per family.
 *
 * This module makes the parents' roles deterministic facts:
 *   - buildFamilyFacts   — mom/dad names + call-names from the brief's
 *                          storyRoles (sanitized) or raw childAnecdotes
 *   - buildFamilyFactsNote — the FAMILY CAST FACTS block for the art
 *                          director prompt (always emitted: generic
 *                          "Mom"/"Dad" casts get the rule even when no
 *                          names were provided)
 *   - applyFamilyFacts   — deterministic post-pass over the returned cast
 *                          locks: every lock matching a parent gets the
 *                          role stated first (model promises are never the
 *                          contract), and a parent present in the
 *                          manuscript with NO lock gets one synthesized —
 *                          a parent appearing on a single spread earned no
 *                          continuity lock before, so the renderer got
 *                          zero facts about them.
 *
 * Genders come ONLY from the declared role (mom_name → woman, dad_name →
 * man) — never inferred from the name itself (that inference is exactly
 * the bug). Skin tone is anchored to the hero: parents must read as the
 * child's close biological family, harmonized with the model sheet/cover.
 */

/** Generic role words a manuscript may use instead of (or beside) names. */
const MOTHER_ALIASES = ['mom', 'mommy', 'mama', 'momma', 'mum', 'mummy', 'mother', 'ima'];
const FATHER_ALIASES = ['dad', 'daddy', 'papa', 'dada', 'pa', 'pop', 'father', 'abba'];

/**
 * Non-empty trimmed string or null. Newlines collapse and length caps at 60
 * chars — the raw-anecdote fallback path may not have passed sanitizeAnecdotes,
 * and a name field is garbage beyond that anyway.
 */
function val(x) {
  const s = String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return s.length ? s : null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word, case-insensitive containment (same rule as renderSpread's lock matching). */
function wordMatch(needle, haystack) {
  if (!needle || !haystack) return false;
  return new RegExp(`\\b${escapeRe(needle)}\\b`, 'i').test(String(haystack));
}

/**
 * Build the parent facts. storyRoles.finalScene (sanitized at validation)
 * wins; raw childAnecdotes back-fill anything it lacks (finalScene is null
 * when no parent NAME was provided, but a call-name alone still identifies
 * the parent's role).
 *
 * @param {{ storyRoles?: object|null, childAnecdotes?: object|null }} input
 * @returns {Array<{ role: 'mother'|'father', noun: 'woman'|'man', name: string|null, callName: string|null }>}
 */
function buildFamilyFacts({ storyRoles, childAnecdotes } = {}) {
  const fs = storyRoles?.finalScene || {};
  const a = childAnecdotes || {};
  const momName = val(fs.momName) || val(a.mom_name);
  const dadName = val(fs.dadName) || val(a.dad_name);
  const callsMom = val(fs.callsMom) || val(a.calls_mom);
  const callsDad = val(fs.callsDad) || val(a.calls_dad);

  const facts = [];
  if (momName || callsMom) {
    facts.push({ role: 'mother', noun: 'woman', name: momName, callName: callsMom });
  }
  if (dadName || callsDad) {
    facts.push({ role: 'father', noun: 'man', name: dadName, callName: callsDad });
  }
  return facts;
}

/**
 * Resolve a character string (a cast-lock name or a characters_present
 * entry) to a parent fact. Declared names/call-names win; the generic
 * role aliases catch manuscripts that cast "Mom"/"Daddy" without names.
 *
 * @param {string} character
 * @param {Array} facts - buildFamilyFacts output
 * @returns {{ role: string, noun: string, name: string|null, callName: string|null }|null}
 */
function matchFamilyRole(character, facts = []) {
  const c = val(character);
  if (!c) return null;
  for (const f of facts) {
    if ((f.name && wordMatch(f.name, c)) || (f.callName && wordMatch(f.callName, c))) return f;
  }
  const lower = ` ${c.toLowerCase()} `;
  const aliasHit = (aliases) => aliases.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(lower));
  if (aliasHit(MOTHER_ALIASES)) {
    return facts.find((f) => f.role === 'mother') || { role: 'mother', noun: 'woman', name: null, callName: null };
  }
  if (aliasHit(FATHER_ALIASES)) {
    return facts.find((f) => f.role === 'father') || { role: 'father', noun: 'man', name: null, callName: null };
  }
  return null;
}

/** One sentence pinning a parent's role, gender, and family look. */
function roleDesignPrefix(fact) {
  const pron = fact.role === 'mother' ? 'her' : 'his';
  return `the child's ${fact.role} — an adult ${fact.noun}; ${pron} skin tone and facial features read as the hero's close biological family (harmonized with the child on the model sheet and cover)`;
}

/**
 * FAMILY CAST FACTS block for the art director prompt. Always returns a
 * rule (generic Mom/Dad casts need it too); provided names are listed as
 * customer data.
 *
 * @param {Array} facts - buildFamilyFacts output
 * @returns {string}
 */
function buildFamilyFactsNote(facts = []) {
  const lines = facts.map((f) => {
    const who = f.name ? `"${f.name}"` : `the character the child calls "${f.callName}"`;
    const call = f.name && f.callName ? ` (the child calls ${f.role === 'mother' ? 'her' : 'him'} "${f.callName}")` : '';
    return `${who} is the child's ${f.role.toUpperCase()} — an adult ${f.noun}${call}.`;
  });
  return [
    'These are CUSTOMER DATA, never creative choices:',
    ...lines,
    'Any character reading as a parent ("Mom", "Mama", "Dad", "Papa", or a parent name above) MUST be designed so the stated role and gender are unmistakable — a mother is an adult woman, a father is an adult man.',
    'Parents\' skin tones and facial features must read as the hero\'s close biological family: harmonize them with the child on the model sheet and approved cover. Never invent a contrasting ethnicity for a parent, and never change which parents exist (a mother and a father stay a mother and a father; never re-cast them as any other pairing).',
  ].join('\n  ');
}

/**
 * Deterministic post-pass over the art director's cast locks:
 *
 *   1. PATCH — every returned lock matching a parent gets the role/gender/
 *      family-look sentence prepended to its design, so render prompts and
 *      the book pass carry the facts even when the model's design text was
 *      ambiguous.
 *   2. SYNTHESIZE — a parent listed in some spread's characters_present
 *      with no matching lock (cast locks only cover 2+-spread characters)
 *      gets a generic lock so single-scene parents stop reaching the
 *      renderer as bare name strings.
 *
 * @param {object} opts
 * @param {Array|null} opts.castLocks - direction.continuityLocks.cast
 * @param {Array} opts.facts - buildFamilyFacts output
 * @param {{ spreads?: Array }} [opts.manuscript]
 * @returns {{ castLocks: Array|null, patched: string[], synthesized: string[] }}
 */
function applyFamilyFacts({ castLocks, facts = [], manuscript = null } = {}) {
  const locks = Array.isArray(castLocks) ? castLocks.map((l) => ({ ...l })) : [];
  const patched = [];
  const synthesized = [];

  for (const lock of locks) {
    const fact = matchFamilyRole(lock?.name, facts);
    if (!fact || !lock?.design) continue;
    const prefix = roleDesignPrefix(fact);
    if (!new RegExp(`child'?s ${fact.role}`, 'i').test(lock.design)) {
      lock.design = `${prefix} — ${lock.design}`;
      patched.push(String(lock.name));
    }
  }

  // Parents present in the manuscript but absent from the locks.
  const lockMatches = (name, member) => name.toLowerCase() === member.toLowerCase()
    || wordMatch(name, member) || wordMatch(member, name);
  const bySpread = new Map();
  for (const s of manuscript?.spreads || []) {
    for (const member of s.scene_contract?.characters_present || []) {
      const fact = matchFamilyRole(member, facts);
      if (!fact) continue;
      if (locks.some((l) => l?.name && lockMatches(String(l.name), String(member)))) continue;
      const key = String(member);
      if (!bySpread.has(key)) bySpread.set(key, { fact, spreads: [] });
      bySpread.get(key).spreads.push(Number(s.spread));
    }
  }
  for (const [member, { fact, spreads }] of bySpread) {
    locks.push({
      name: member,
      spreads,
      design: `${roleDesignPrefix(fact)}; one simple, consistent, letter-free casual outfit every time they appear`,
    });
    synthesized.push(member);
  }

  return { castLocks: locks.length ? locks : null, patched, synthesized };
}

module.exports = {
  buildFamilyFacts,
  buildFamilyFactsNote,
  matchFamilyRole,
  applyFamilyFacts,
  MOTHER_ALIASES,
  FATHER_ALIASES,
};
