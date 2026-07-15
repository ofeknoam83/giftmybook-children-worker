/**
 * The fail-open (ACCEPT_WITH_NOTE) whitelist must stay minimal.
 *
 * Audit 2026-07-15: a shipped book's hero flipped between blue jeans and
 * brown pants mid-book — `outfit_continuity_drift` was whitelisted, so at
 * ≥75% of the repair budget the pair shipped with the flip. Outfit
 * continuity is a customer-visible identity signal; it must hard-fail.
 * These tests pin the whitelist so a tag can't quietly ride back in.
 */
const { QA_SOFT_FAIL_TAGS } = require('../../../services/bookPipeline/illustrator/renderAllSpreadsQuad');

describe('QA_SOFT_FAIL_TAGS whitelist', () => {
  test('outfit_continuity_drift is NOT fail-open (shipped a jeans/pants flip)', () => {
    expect(QA_SOFT_FAIL_TAGS.has('outfit_continuity_drift')).toBe(false);
  });

  test('customer-visible identity/layout tags are never fail-open', () => {
    for (const tag of [
      'hero_mismatch', 'duplicated_hero', 'hero_in_gutter', 'split_panel',
      'text_crosses_midline', 'text_trim_clipped', 'action_mismatch',
      'spelling_mismatch', 'outfit_mismatch', 'style_drift',
    ]) {
      expect(QA_SOFT_FAIL_TAGS.has(tag)).toBe(false);
    }
  });

  test('the whitelist stays limited to the two known-borderline drift tags', () => {
    expect([...QA_SOFT_FAIL_TAGS].sort()).toEqual([
      'hair_continuity_drift',
      'implied_parent_outfit_drift',
    ]);
  });
});
