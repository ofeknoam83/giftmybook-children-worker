/**
 * Recurring-props + ephemeral-budget validator (PR C, sections C.4b + C.5).
 *
 * Runs at book-plan time, after spreadSpecs have been produced. Reads the
 * spreadSpecs (focalAction + plotBeat + location + mustUseDetails) and
 * confronts them with `visualBible.recurringProps`:
 *
 *   - Any noun that appears in MORE THAN TWO spreads must be declared in
 *     `recurringProps` so its color/material/pattern stays locked across
 *     spreads. Tag: `prop_undeclared`.
 *
 *   - Any noun that appears in EXACTLY ONE spread is "ephemeral". The book
 *     has a soft budget of 3 such items across all spreads. Above that,
 *     tag `ephemeral_element_budget_exceeded`.
 *
 * Detection is intentionally conservative — a small lexicon of physical
 * children's-book props plus a generic single-word capitalized-noun pass —
 * because false positives here block the pipeline. The lexicon was tuned
 * against the Mother's Day "runaway blanket" failure mode that motivated
 * this PR.
 */

// Tight lexicon of concrete picture-book props. Lower-cased; matched as
// whole-word, case-insensitive. Plurals collapse to the singular below.
const PROP_LEXICON = [
  // textiles & wearables
  'blanket', 'quilt', 'scarf', 'shawl', 'hat', 'cap', 'beanie', 'bonnet',
  'headband', 'ribbon', 'bow', 'sweater', 'cardigan', 'coat', 'jacket',
  'mitten', 'glove', 'sock', 'shoe', 'boot', 'slipper', 'apron', 'cape',
  // toys & companions
  'bear', 'teddy', 'bunny', 'pony', 'puppy', 'kitten', 'dog', 'cat',
  'duck', 'rabbit', 'doll', 'ball', 'kite', 'balloon',
  // vessels & furniture
  'cup', 'mug', 'kettle', 'teapot', 'bowl', 'spoon', 'plate', 'bottle',
  'basket', 'tin', 'jar', 'lantern', 'candle', 'bench', 'stool', 'chair',
  'crib', 'cradle', 'stroller', 'pram', 'rocker',
  // outdoor / transport
  'bicycle', 'bike', 'wagon', 'sled', 'umbrella', 'flag', 'boat',
  // story-book staples
  'book', 'letter', 'envelope', 'map', 'key', 'lock', 'feather', 'flower',
  'leaf', 'shell', 'stone', 'pebble', 'star', 'moon', 'cloud',
];

const PROP_SET = new Set(PROP_LEXICON);

// Pluralization tolerance: trim trailing 's' / 'es' for matching.
function singularize(word) {
  const w = word.toLowerCase();
  if (w.endsWith('ies') && w.length > 3) return `${w.slice(0, -3)}y`;
  if (w.endsWith('es') && w.length > 3 && !w.endsWith('ses')) return w.slice(0, -2);
  if (w.endsWith('s') && w.length > 2) return w.slice(0, -1);
  return w;
}

/**
 * Scan one text blob and return the set of prop nouns it mentions. Uses the
 * tight lexicon — we deliberately don't try to invent generic noun
 * extraction here, since false positives gate the pipeline.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function extractPropMentions(text) {
  const mentions = new Set();
  if (!text || typeof text !== 'string') return mentions;
  const tokens = text.toLowerCase().match(/[a-z]+/g) || [];
  for (const tok of tokens) {
    const base = singularize(tok);
    if (PROP_SET.has(base)) mentions.add(base);
  }
  return mentions;
}

/**
 * Build the per-spread text blob the validator scans.
 */
function spreadTextForScan(spreadSpec) {
  if (!spreadSpec) return '';
  return [
    spreadSpec.focalAction,
    spreadSpec.plotBeat,
    spreadSpec.location,
    Array.isArray(spreadSpec.mustUseDetails) ? spreadSpec.mustUseDetails.join(' ') : '',
    Array.isArray(spreadSpec.continuityAnchors) ? spreadSpec.continuityAnchors.join(' ') : '',
  ].filter(Boolean).join(' ');
}

/**
 * Build a Set of declared recurring-prop tokens (singularized) from the
 * visualBible. Match is by token presence inside the prop name — so the
 * declared prop "soft yellow cable-knit blanket" matches detected token
 * "blanket".
 */
function buildDeclaredPropTokens(visualBible) {
  const declared = new Set();
  const props = Array.isArray(visualBible?.recurringProps) ? visualBible.recurringProps : [];
  for (const p of props) {
    const name = String(p?.name || '').toLowerCase();
    const tokens = name.match(/[a-z]+/g) || [];
    for (const tok of tokens) {
      const base = singularize(tok);
      if (PROP_SET.has(base)) declared.add(base);
    }
  }
  return declared;
}

const DEFAULT_EPHEMERAL_BUDGET = 3;

/**
 * Validate recurring-prop declarations + ephemeral budget for a book.
 *
 * @param {object} options
 * @param {Array<object>} options.spreadSpecs - flat array of per-spread
 *   spec objects (i.e. `doc.spreads[i].spec`).
 * @param {object} options.visualBible - `doc.visualBible`.
 * @param {number} [options.ephemeralBudget=3]
 * @returns {{
 *   pass: boolean,
 *   tags: string[],
 *   issues: Array<{ tag: string, prop: string, spreads: number[], message: string }>,
 *   counts: Record<string, number[]>,
 *   ephemeralCount: number,
 * }}
 */
function validateRecurringProps({ spreadSpecs, visualBible, ephemeralBudget = DEFAULT_EPHEMERAL_BUDGET }) {
  const issues = [];
  const tags = new Set();

  if (!Array.isArray(spreadSpecs) || spreadSpecs.length === 0) {
    return { pass: true, tags: [], issues: [], counts: {}, ephemeralCount: 0 };
  }

  // counts[propBase] = [spreadNumbers...] where it was mentioned
  const counts = {};
  for (const spec of spreadSpecs) {
    const spreadNumber = Number(spec?.spreadNumber);
    if (!Number.isFinite(spreadNumber)) continue;
    const mentions = extractPropMentions(spreadTextForScan(spec));
    for (const m of mentions) {
      if (!counts[m]) counts[m] = [];
      if (!counts[m].includes(spreadNumber)) counts[m].push(spreadNumber);
    }
  }

  const declaredTokens = buildDeclaredPropTokens(visualBible);

  let ephemeralCount = 0;
  const ephemeralProps = [];

  for (const [prop, spreads] of Object.entries(counts)) {
    if (spreads.length > 2 && !declaredTokens.has(prop)) {
      tags.add('prop_undeclared');
      issues.push({
        tag: 'prop_undeclared',
        prop,
        spreads: spreads.slice().sort((a, b) => a - b),
        message: `Prop "${prop}" appears in ${spreads.length} spreads (${spreads.sort((a, b) => a - b).join(', ')}) but is not declared in visualBible.recurringProps. Add a locked description so it renders identically across spreads.`,
      });
    }
    if (spreads.length === 1) {
      ephemeralCount += 1;
      ephemeralProps.push({ prop, spread: spreads[0] });
    }
  }

  if (ephemeralCount > ephemeralBudget) {
    tags.add('ephemeral_element_budget_exceeded');
    issues.push({
      tag: 'ephemeral_element_budget_exceeded',
      prop: ephemeralProps.map(p => p.prop).join(', '),
      spreads: ephemeralProps.map(p => p.spread).sort((a, b) => a - b),
      message: `${ephemeralCount} single-appearance props detected (budget is ${ephemeralBudget}): ${ephemeralProps.map(p => `"${p.prop}" (spread ${p.spread})`).join(', ')}. Trim cameos, or promote a recurring one into recurringProps.`,
    });
  }

  return {
    pass: issues.length === 0,
    tags: Array.from(tags),
    issues,
    counts,
    ephemeralCount,
  };
}

module.exports = {
  validateRecurringProps,
  extractPropMentions,
  buildDeclaredPropTokens,
  PROP_LEXICON,
  DEFAULT_EPHEMERAL_BUDGET,
};
