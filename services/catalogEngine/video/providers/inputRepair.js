/**
 * Vendor input repair (2026-09-09).
 *
 * A hosted model's input SCHEMA is a verify-at-deploy fact: the field
 * names and their allowed values live at the vendor, not in this repo, and
 * a mismatch comes back as one 422 that used to fail a whole film after
 * every still, sheet and voice take had already been paid for (Kling Omni
 * rejected our `mode: 'std'` — its enum is `standard` | `pro` | `4k`).
 *
 * The vendor's own 422 names the offending field and, for an enum, the
 * values it will take. That is enough to correct the request ONCE and
 * resubmit instead of failing the run: `parseInputIssues` reads the
 * message, `repairInput` maps our value onto the vendor's vocabulary
 * (case-insensitive, then prefix — `std` → `standard`) and, when nothing
 * matches or the field is simply unknown, DROPS it so the model applies
 * its own default. Every repair is reported (never silent), and the fields
 * that carry the actual commission — the prompt and the start frame — are
 * never dropped: a vendor that rejects those is a real configuration
 * failure and still fails the run.
 */

/**
 * Input fields whose loss would change what we are buying — the commission
 * itself and the billed length: never dropped. A vendor rejecting one of
 * these is a profile bug to fix in models.js, not a request to guess at.
 */
const PROTECTED_FIELDS = new Set(['prompt', 'start_image', 'image', 'input_image', 'duration']);

/**
 * Read a vendor's 422 body into per-field issues.
 *
 * Replicate reports one line per rejected field, e.g.
 *   `- input.mode: mode must be one of the following: "standard", "pro", "4k"`
 *   `- input.foo: Additional properties are not allowed`
 *   `- input.duration: 12 is not one of [5, 10]`
 * @param {string} message the vendor's detail/error text
 * @returns {Array<{field: string, allowed: string[], unknown: boolean, detail: string}>}
 */
function parseInputIssues(message) {
  const text = typeof message === 'string' ? message : '';
  const issues = [];
  // One segment per field. Replicate joins them on ONE line (`… (HTTP 422):
  // - input.mode: … - input.foo: …`), so a segment ends at the next
  // `- input.` marker or the line end, never at the next newline alone.
  const segment = /input\.([A-Za-z0-9_]+)\s*:\s*([^\n]*?)(?=\s+-\s+input\.[A-Za-z0-9_]+\s*:|\n|$)/g;
  let m;
  while ((m = segment.exec(text)) !== null) {
    const field = m[1];
    const detail = m[2].trim();
    const unknown = /additional propert|not allowed|unexpected|unknown|unrecogni[sz]ed/i.test(detail);
    if (issues.some(i => i.field === field)) continue;
    issues.push({ field, allowed: parseAllowed(detail), unknown, detail });
  }
  return issues;
}

/**
 * The values a "must be one of" complaint lists. Quoted values are the
 * list; without quotes only a bracketed list counts (`[5, 10]`) — bare
 * prose after "one of" ("the allowed values") is never a vocabulary.
 * @param {string} detail
 * @returns {string[]}
 */
function parseAllowed(detail) {
  const list = /one of(?: the following)?:?\s*(.+)$/i.exec(detail);
  if (!list) return [];
  const quoted = [];
  const q = /"([^"]+)"|'([^']+)'/g;
  let v;
  while ((v = q.exec(list[1])) !== null) quoted.push(v[1] || v[2]);
  if (quoted.length) return quoted;
  const bracketed = /\[([^\]]*)\]/.exec(list[1]);
  if (!bracketed) return [];
  return bracketed[1].split(',').map(x => x.trim()).filter(Boolean);
}

/**
 * Is `abbr` an abbreviation of `word` — its letters in order (`std` of
 * `standard`, `hd` of `high_definition`)? Only ever consulted when the
 * match is UNIQUE among the vendor's values.
 * @param {string} abbr
 * @param {string} word
 * @returns {boolean}
 */
function isAbbreviation(abbr, word) {
  if (!abbr || abbr.length >= word.length || abbr[0] !== word[0]) return false;
  let i = 0;
  for (const ch of word) if (ch === abbr[i] && ++i === abbr.length) return true;
  return false;
}

/**
 * Map one value onto the vendor's vocabulary: exact, then case-insensitive,
 * then a unique prefix, then a unique abbreviation (`std` → `standard`).
 * @param {*} value
 * @param {string[]} allowed
 * @returns {string|null}
 */
function matchAllowed(value, allowed) {
  if (value === undefined || value === null || !allowed.length) return null;
  const v = String(value).trim();
  if (!v) return null;
  const exact = allowed.find(a => a === v);
  if (exact) return exact;
  const lower = v.toLowerCase();
  const ci = allowed.find(a => a.toLowerCase() === lower);
  if (ci) return ci;
  const prefixed = allowed.filter(a => a.toLowerCase().startsWith(lower) || lower.startsWith(a.toLowerCase()));
  if (prefixed.length === 1) return prefixed[0];
  const abbreviated = allowed.filter(a => isAbbreviation(lower, a.toLowerCase()));
  return abbreviated.length === 1 ? abbreviated[0] : null;
}

/**
 * Correct a rejected input against the vendor's own complaint.
 * @param {object} input the input object we submitted
 * @param {Array<{field: string, allowed: string[], unknown: boolean, detail: string}>} issues
 * @returns {{input: object, repairs: Array<{field: string, from: *, to: string|null, detail: string}>}|null}
 *   null when nothing in the message is safely repairable
 */
function repairInput(input, issues) {
  if (!input || typeof input !== 'object' || !Array.isArray(issues) || !issues.length) return null;
  const out = { ...input };
  const repairs = [];
  for (const issue of issues) {
    if (!Object.prototype.hasOwnProperty.call(out, issue.field)) continue;
    if (PROTECTED_FIELDS.has(issue.field)) continue;
    const from = out[issue.field];
    const to = issue.unknown ? null : matchAllowed(from, issue.allowed);
    if (to === null) delete out[issue.field];
    else if (to === from) continue; // the vendor rejected a value it lists: nothing to change
    else out[issue.field] = to;
    repairs.push({ field: issue.field, from, to, detail: issue.detail });
  }
  return repairs.length ? { input: out, repairs } : null;
}

/**
 * Re-apply earlier repairs to a freshly built input (the end-frame fallback
 * rebuilds from the profile, which would otherwise restore the very value
 * the vendor already rejected).
 * @param {object} input
 * @param {Array<{field: string, to: string|null}>} repairs
 * @returns {object}
 */
function applyRepairs(input, repairs) {
  const out = { ...input };
  for (const r of repairs || []) {
    if (!Object.prototype.hasOwnProperty.call(out, r.field)) continue;
    if (r.to === null) delete out[r.field];
    else out[r.field] = r.to;
  }
  return out;
}

/**
 * One human line per repair, for logs and advisories.
 * @param {Array<{field: string, from: *, to: string|null}>} repairs
 * @returns {string}
 */
function describeRepairs(repairs) {
  return (repairs || []).map(r => (r.to === null
    ? `dropped '${r.field}' (the model does not accept ${JSON.stringify(r.from)})`
    : `sent '${r.field}' as ${JSON.stringify(r.to)} instead of ${JSON.stringify(r.from)}`)).join('; ');
}

module.exports = { parseInputIssues, parseAllowed, repairInput, applyRepairs, describeRepairs, matchAllowed, isAbbreviation, PROTECTED_FIELDS };
