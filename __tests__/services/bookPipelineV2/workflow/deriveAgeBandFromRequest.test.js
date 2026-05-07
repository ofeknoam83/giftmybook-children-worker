'use strict';

const {
  deriveAgeBandFromRequest,
} = require('../../../../services/bookPipelineV2/orchestration/workflows/createBook.workflow');

describe('deriveAgeBandFromRequest', () => {
  test('age=0 (lap baby) resolves to PB_INFANT, not PB_PRESCHOOL', () => {
    // Regression for production book e3f4e0c0 (mothers_day, birthDate-derived
    // age=0). The old `child.age || child.ageYears || null` chain treated 0
    // as falsy and routed a newborn to PB_PRESCHOOL.
    expect(deriveAgeBandFromRequest({ child: { age: 0 } })).toBe('PB_INFANT');
  });

  test('ageMonths=0 resolves to PB_INFANT', () => {
    expect(deriveAgeBandFromRequest({ child: { ageMonths: 0 } })).toBe('PB_INFANT');
  });

  test('ageMonths=8 resolves to PB_INFANT', () => {
    expect(deriveAgeBandFromRequest({ child: { ageMonths: 8 } })).toBe('PB_INFANT');
  });

  test('age=1 resolves to PB_INFANT (12 months)', () => {
    expect(deriveAgeBandFromRequest({ child: { age: 1 } })).toBe('PB_INFANT');
  });

  test('age=2 resolves to PB_TODDLER (24 months)', () => {
    expect(deriveAgeBandFromRequest({ child: { age: 2 } })).toBe('PB_TODDLER');
  });

  test('age=4 resolves to PB_PRESCHOOL', () => {
    expect(deriveAgeBandFromRequest({ child: { age: 4 } })).toBe('PB_PRESCHOOL');
  });

  test('age=7 resolves to PB_EARLY_READER', () => {
    expect(deriveAgeBandFromRequest({ child: { age: 7 } })).toBe('PB_EARLY_READER');
  });

  test('ageMonths preferred over age (years) when both present', () => {
    // ageMonths=10 (PB_INFANT) wins over age=4 (PB_PRESCHOOL)
    expect(deriveAgeBandFromRequest({ child: { ageMonths: 10, age: 4 } })).toBe('PB_INFANT');
  });

  test('snake_case age_months also accepted', () => {
    expect(deriveAgeBandFromRequest({ child: { age_months: 0 } })).toBe('PB_INFANT');
    expect(deriveAgeBandFromRequest({ child: { age_months: 24 } })).toBe('PB_TODDLER');
  });

  test('non-numeric age strings are ignored, falls through to PRESCHOOL default', () => {
    expect(deriveAgeBandFromRequest({ child: { age: '4' } })).toBe('PB_PRESCHOOL');
  });

  test('NaN age is ignored, falls through to PRESCHOOL default', () => {
    expect(deriveAgeBandFromRequest({ child: { age: NaN } })).toBe('PB_PRESCHOOL');
  });

  test('missing child object falls back to PRESCHOOL', () => {
    expect(deriveAgeBandFromRequest({})).toBe('PB_PRESCHOOL');
    expect(deriveAgeBandFromRequest(null)).toBe('PB_PRESCHOOL');
    expect(deriveAgeBandFromRequest(undefined)).toBe('PB_PRESCHOOL');
  });

  test('ageYears alias accepted', () => {
    expect(deriveAgeBandFromRequest({ child: { ageYears: 0 } })).toBe('PB_INFANT');
    expect(deriveAgeBandFromRequest({ child: { ageYears: 5 } })).toBe('PB_PRESCHOOL');
  });
});
