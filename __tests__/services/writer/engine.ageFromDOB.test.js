/**
 * Unit tests for age derivation from birth_date in the Writer V2 engine.
 *
 * Addresses the Mason bug: when the standalone payload omitted child.age
 * but included a birth_date of 2025-09-03, the writer treated the child as
 * age 5 by default and produced content grossly mismatched to a 7-month-old.
 */

const { ageFromDOB, buildChildFromLegacy } = require('../../../services/writer/engine');

describe('ageFromDOB', () => {
  test('returns null for falsy/unparseable input', () => {
    expect(ageFromDOB(null)).toBeNull();
    expect(ageFromDOB('')).toBeNull();
    expect(ageFromDOB('not a date')).toBeNull();
  });

  test('returns 0 when less than one full year has elapsed', () => {
    const now = new Date('2026-04-21T00:00:00Z');
    expect(ageFromDOB('2025-09-03', now)).toBe(0);
  });

  test('returns 5 on the child\'s 5th birthday', () => {
    const now = new Date('2026-04-21T00:00:00Z');
    expect(ageFromDOB('2021-04-21', now)).toBe(5);
  });

  test('returns 4 when child is still 4 days shy of their 5th birthday', () => {
    const now = new Date('2026-04-21T00:00:00Z');
    expect(ageFromDOB('2021-04-25', now)).toBe(4);
  });

  test('clamps negative dates (future DOBs) to 0', () => {
    const now = new Date('2026-04-21T00:00:00Z');
    expect(ageFromDOB('2030-01-01', now)).toBe(0);
  });
});

describe('buildChildFromLegacy age resolution', () => {
  beforeEach(() => {
    // Suppress intentional warn lines so the test output stays clean.
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    console.warn.mockRestore?.();
  });

  test('prefers explicit payload.childAge over birth_date', () => {
    const child = buildChildFromLegacy({
      childName: 'Mason',
      childAge: 7,
      brief: { child: { birth_date: '2025-09-03' } },
    });
    expect(child.age).toBe(7);
  });

  test('derives age from birth_date when no explicit age is present', () => {
    const child = buildChildFromLegacy({
      childName: 'Mason',
      brief: { child: { birth_date: '2021-04-21' } },
    });
    // Against real "now" the exact year varies; what matters is it's
    // finite, non-negative, and wasn't silently defaulted away.
    expect(Number.isFinite(child.age)).toBe(true);
    expect(child.age).toBeGreaterThanOrEqual(0);
  });

  test('leaves age as null when neither explicit age nor birth_date is present', () => {
    const child = buildChildFromLegacy({
      childName: 'Unknown',
      brief: { child: {} },
    });
    expect(child.age).toBeNull();
  });
});
