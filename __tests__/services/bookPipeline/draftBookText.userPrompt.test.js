/**
 * PR J.1 \u2014 writer-input sanitization tests.
 *
 * The writer LLM was reproducing banned-verb tokens (twirl, dance, bounce,
 * peekaboo) and dialogue patterns ("Mama, come dance!") that DRIVES OUT
 * OF its own input prompt. Two upstream sources were leaking these:
 *
 *   1. spec.forbiddenMistakes contained literal banned-verb tokens
 *      (planner-injected anti-priming reminders).
 *   2. The renderInfantContract() block contained a BAD EXAMPLE that
 *      itself put dialogue and banned verbs in the model's working set.
 *
 * These tests pin the fix in place: the assembled writer prompt for an
 * infant book must not contain any banned-verb literal anywhere, and the
 * "BAD EXAMPLE" demonstration is gone, replaced with abstract failure-mode
 * descriptions.
 */

const { renderInfantContract } = require('../../../services/bookPipeline/writer/draftBookText');
const {
  findInfantPlannerVerbs,
} = require('../../../services/bookPipeline/planner/createSpreadSpecs');
const { AGE_BANDS } = require('../../../services/bookPipeline/constants');

describe('PR J.1: renderInfantContract', () => {
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
    const hits = findInfantPlannerVerbs(block);
    expect(hits).toEqual([]);
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
    // At least the core whitelist should appear so the writer has positive
    // verbs to use.
    for (const verb of ['look', 'reach', 'hold', 'snuggle', 'giggle', 'point']) {
      expect(block.toLowerCase()).toContain(verb);
    }
  });
});

describe('PR J.1: writer userPrompt assembly', () => {
  // We test the helpers directly via require because constructing a full
  // bookDocument is heavy. Internal helpers are not exported, so we
  // re-require the module with __test__ access via re-export trick.
  const {
    sanitizeForbiddenMistakesForInfant,
    sanitizeSpecViewForInfant,
  } = require('../../../services/bookPipeline/writer/draftBookText').__testInternals;

  test('sanitizeForbiddenMistakesForInfant strips entries that contain banned verbs', () => {
    const input = [
      'INFANT BAND: manuscript text must not contain locomotion verbs (jump/run/race/spin/twirl/hop/walk/climb/leap/dance/chase/skip/gallop/stomp/march/crawl/step/stand/stood/bounce).',
      'INFANT BAND: planner sanitized banned verb(s) twirl, dance from spec; do NOT reintroduce them in the manuscript text.',
      'unmotivated location change',
    ];
    const out = sanitizeForbiddenMistakesForInfant(input);
    // Spread-specific entries that don't echo banned verbs are preserved.
    expect(out).toContain('unmotivated location change');
    // Both planner anti-priming reminders are replaced by ONE neutral string
    // (deduped) and contain zero banned-verb literals.
    const allText = out.join(' ');
    expect(findInfantPlannerVerbs(allText)).toEqual([]);
  });

  test('sanitizeForbiddenMistakesForInfant dedupes the neutral reminder', () => {
    const input = [
      'INFANT BAND: jump, run, race banned',
      'INFANT BAND: dance, twirl banned',
      'INFANT BAND: bounce, hop banned',
    ];
    const out = sanitizeForbiddenMistakesForInfant(input);
    // Three banned-verb entries collapse to one neutral entry.
    expect(out.length).toBe(1);
    expect(findInfantPlannerVerbs(out.join(' '))).toEqual([]);
  });

  test('sanitizeForbiddenMistakesForInfant accepts non-arrays defensively', () => {
    expect(sanitizeForbiddenMistakesForInfant(null)).toEqual([]);
    expect(sanitizeForbiddenMistakesForInfant(undefined)).toEqual([]);
    expect(sanitizeForbiddenMistakesForInfant('not an array')).toEqual([]);
  });

  test('sanitizeSpecViewForInfant rewrites focalAction/plotBeat that contain banned verbs', () => {
    const poisoned = {
      purpose: 'discovery',
      focalAction: 'Everleigh twirls toward the sun',
      plotBeat: 'She dances across the floor',
      location: 'kitchen',
      forbiddenMistakes: [],
    };
    const cleaned = sanitizeSpecViewForInfant(poisoned, 'Everleigh');
    expect(findInfantPlannerVerbs(cleaned.focalAction)).toEqual([]);
    expect(findInfantPlannerVerbs(cleaned.plotBeat)).toEqual([]);
    // Other fields are passed through unchanged.
    expect(cleaned.location).toBe('kitchen');
    expect(cleaned.purpose).toBe('discovery');
  });

  test('sanitizeSpecViewForInfant leaves a clean spec untouched', () => {
    const clean = {
      focalAction: 'Mama holds Everleigh near the window',
      plotBeat: 'Soft light spills onto the rug',
      location: 'living room',
    };
    const out = sanitizeSpecViewForInfant(clean, 'Everleigh');
    expect(out.focalAction).toBe(clean.focalAction);
    expect(out.plotBeat).toBe(clean.plotBeat);
  });
});
