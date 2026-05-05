/**
 * Writer-input shape tests.
 *
 * Originally PR J.1 \u2014 these tests pinned the regex-based writer-side
 * sanitizers (sanitizeForbiddenMistakesForInfant, sanitizeSpecViewForInfant)
 * to a contract that scrubbed banned-verb literals from the writer's prompt
 * before it ran.
 *
 * AA-CW-2 deletes those sanitizers entirely. The new contract is:
 *
 *   - The infant ban appears in exactly ONE place in the writer's prompt:
 *     the INFANT BOOK CONTRACT block at the top, in plain English with no
 *     enumerated trigger words. (Negative-priming guard: the model never
 *     sees the literal banned tokens echoed across 13 forbiddenMistakes
 *     entries.)
 *
 *   - The semantic check on focalAction/plotBeat is moved upstream to the
 *     Planner Guard (services/bookPipeline/planner/plannerGuard.js), which
 *     gates the planner stage. A guard hit triggers a planner retry rather
 *     than a silent rewrite at the writer boundary.
 *
 * These tests pin the new contract.
 */

const path = require('path');
const fs = require('fs');
const { renderInfantContract } = require('../../../services/bookPipeline/writer/draftBookText');
const { AGE_BANDS } = require('../../../services/bookPipeline/constants');

// Verb literals that must NOT appear in the writer's prompt as enumerated
// triggers. We hand-roll this list inside the test (NOT imported from the
// deleted production sanitizer) because the production code intentionally
// no longer ships such a list \u2014 the no-priming guarantee is verified
// directly here against the contract block's text.
const NEGATIVE_PRIMING_TOKENS = [
  'jump', 'jumps', 'jumped', 'jumping',
  'run', 'runs', 'running', 'ran',
  'race', 'races', 'racing',
  'spin', 'spins', 'spinning',
  'twirl', 'twirls', 'twirling', 'twirled',
  'hop', 'hops', 'hopping',
  'walk', 'walks', 'walking',
  'climb', 'climbs', 'climbing',
  'leap', 'leaps', 'leaping',
  'dance', 'dances', 'dancing',
  'chase', 'chases', 'chasing',
  'gallop', 'gallops',
  'stomp', 'stomps',
  'march', 'marches',
  'crawl', 'crawls',
  'cartwheel',
  'tumble', 'tumbles',
  'bounce', 'bounces',
];

function findNegativePrimingHits(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return [];
  const hits = new Set();
  for (const v of NEGATIVE_PRIMING_TOKENS) {
    const rx = new RegExp(`\\b${v}\\b`, 'i');
    if (rx.test(t)) hits.add(v);
  }
  return Array.from(hits);
}

describe('renderInfantContract \u2014 the single source of truth for the infant rule', () => {
  test('emits empty string for non-infant bands', () => {
    expect(renderInfantContract(AGE_BANDS.PB_TODDLER)).toBe('');
    expect(renderInfantContract(AGE_BANDS.PB_PRESCHOOL)).toBe('');
  });

  test('emits a contract block for the infant band', () => {
    const block = renderInfantContract(AGE_BANDS.PB_INFANT);
    expect(block).toMatch(/INFANT BOOK CONTRACT/);
    expect(block.length).toBeGreaterThan(500);
  });

  test('contract block contains ZERO banned-verb literals (no negative priming)', () => {
    const block = renderInfantContract(AGE_BANDS.PB_INFANT);
    expect(findNegativePrimingHits(block)).toEqual([]);
  });

  test('contract block describes failure modes abstractly, not by enumerating banned verbs', () => {
    const block = renderInfantContract(AGE_BANDS.PB_INFANT);
    // The block must still tell the writer there are constraints \u2014 it must
    // name "still point", "no dialogue", and "self-locomotion" without
    // listing the actual trigger words.
    expect(block).toMatch(/STILL POINT/);
    expect(block).toMatch(/NO DIALOGUE/);
    expect(block).toMatch(/self-locomotion/i);
  });

  test('contract block does NOT contain a "BAD EXAMPLE" that would seed banned tokens', () => {
    const block = renderInfantContract(AGE_BANDS.PB_INFANT);
    expect(block).not.toMatch(/BAD EXAMPLE/);
    // Multiple GOOD examples take its place to give the model concrete patterns.
    const goodCount = (block.match(/GOOD EXAMPLE [A-Z]/g) || []).length;
    expect(goodCount).toBeGreaterThanOrEqual(3);
  });

  test('contract block names the safe-action whitelist for the baby', () => {
    const block = renderInfantContract(AGE_BANDS.PB_INFANT);
    for (const verb of ['look', 'reach', 'hold', 'snuggle', 'giggle', 'point']) {
      expect(block.toLowerCase()).toContain(verb);
    }
  });
});

describe('AA-CW-2: writer no longer ships a regex sanitizer', () => {
  // The two sanitizers (sanitizeForbiddenMistakesForInfant,
  // sanitizeSpecViewForInfant) were deleted. The writer module must not
  // re-export them, must not import them from createSpreadSpecs, and must
  // not declare them locally.
  const draftBookText = require('../../../services/bookPipeline/writer/draftBookText');

  test('draftBookText does NOT export __testInternals (sanitizers removed)', () => {
    expect(draftBookText.__testInternals).toBeUndefined();
  });

  test('draftBookText source contains no reference to deleted sanitizer names', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'services', 'bookPipeline', 'writer', 'draftBookText.js'),
      'utf8',
    );
    // Allow comments referencing the names, but prohibit any function call
    // / declaration / import. Strip line and block comments first to avoid
    // matching the AA-CW-2 changelog comment that documents the deletion.
    const noLineComments = src.replace(/^\s*\/\/.*$/gm, '');
    const noComments = noLineComments.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(noComments).not.toMatch(/\bsanitizeInfantSpec\b/);
    expect(noComments).not.toMatch(/\bsanitizeInfantText\b/);
    expect(noComments).not.toMatch(/\bsanitizeForbiddenMistakesForInfant\b/);
    expect(noComments).not.toMatch(/\bsanitizeSpecViewForInfant\b/);
    expect(noComments).not.toMatch(/\bfindInfantPlannerVerbs\b/);
    expect(noComments).not.toMatch(/\bINFANT_VERB_SUBSTITUTIONS\b/);
  });
});
