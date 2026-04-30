'use strict';

const {
  classifyCorrectionMode,
  renderCorrectionNote,
  planSpreadRepair,
} = require('../../../services/bookPipeline/qa/planRepair');

describe('planRepair tiered correction', () => {
  test('attempt 1 + text + soft identity → text_priority (no restyle hero paragraph)', () => {
    const tags = ['text_in_center_band', 'hero_mismatch'];
    expect(classifyCorrectionMode(tags, 1)).toBe('text_priority');
    const note = renderCorrectionNote(['Wrong place'], tags, { mode: 'text_priority' });
    expect(note).toContain('Place ALL caption text');
    expect(note).not.toContain('Match the approved cover for hero face');
    expect(note).toContain('PRESERVE: keep the hero child');
  });

  test('attempt 1 + text + style_drift → full (hard non-text)', () => {
    expect(classifyCorrectionMode(['text_in_center_band', 'style_drift'], 1)).toBe('full');
    const note = renderCorrectionNote(['A', 'B'], ['text_in_center_band', 'style_drift'], { mode: 'full' });
    expect(note).toContain('Match the BOOK COVER');
  });

  test('attempt 2 + text + hero_mismatch → full', () => {
    expect(classifyCorrectionMode(['spelling_mismatch', 'hero_mismatch'], 2)).toBe('full');
    const note = renderCorrectionNote(['X'], ['spelling_mismatch', 'hero_mismatch'], { mode: 'full' });
    expect(note).toContain('Match the approved cover for hero face');
  });

  test('attempt 1 + text only → text_only', () => {
    expect(classifyCorrectionMode(['missing_word'], 1)).toBe('text_only');
  });

  test('planSpreadRepair returns correctionMode text_priority', () => {
    const plan = planSpreadRepair({
      spreadNumber: 11,
      attemptNumber: 1,
      issues: ['Caption wrong'],
      tags: ['text_in_center_band', 'outfit_mismatch'],
    });
    expect(plan.correctionMode).toBe('text_priority');
    expect(plan.retryEntry.mustPreserve[0]).toMatch(/exactly as in this frame/i);
  });
});
