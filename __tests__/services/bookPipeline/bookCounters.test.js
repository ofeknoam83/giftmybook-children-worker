/**
 * Phase 0.3 — operational counters live on the book document and survive a
 * standard withStageResult shallow-merge so each stage can increment them.
 * This is unit-level coverage for the helpers; full-pipeline wiring is
 * exercised by the existing rewrite/render tests.
 */

const {
  createBookDocument,
  withStageResult,
  incrementCounter,
  formatCountersLogLine,
} = require('../../../services/bookPipeline/schema/bookDocument');

function newDoc() {
  return createBookDocument({
    request: { bookId: 'b-001' },
    brief: {},
    cover: {},
    operationalContext: { bookId: 'b-001' },
  });
}

describe('bookDocument counters (Phase 0.3)', () => {
  test('createBookDocument seeds the three counters at zero', () => {
    const doc = newDoc();
    expect(doc.counters).toEqual({
      writer: { reviseLoopsUsed: 0 },
      illustrator: { softFailsShipped: 0 },
      proseRevisionRequests: 0,
    });
  });

  test('incrementCounter mutates the doc in place for known paths', () => {
    const doc = newDoc();
    incrementCounter(doc, 'writer.reviseLoopsUsed');
    incrementCounter(doc, 'writer.reviseLoopsUsed', 2);
    incrementCounter(doc, 'illustrator.softFailsShipped');
    incrementCounter(doc, 'proseRevisionRequests', 4);
    expect(doc.counters.writer.reviseLoopsUsed).toBe(3);
    expect(doc.counters.illustrator.softFailsShipped).toBe(1);
    expect(doc.counters.proseRevisionRequests).toBe(4);
  });

  test('counters survive withStageResult shallow-merge so stages share state', () => {
    const doc = newDoc();
    incrementCounter(doc, 'writer.reviseLoopsUsed');
    const next = withStageResult(doc, { storyBible: { ok: true } });
    incrementCounter(next, 'writer.reviseLoopsUsed');
    // Both refs see the same counters object — that's the contract that lets
    // illustrator/writer stages mutate without threading the counter through
    // every return value.
    expect(doc.counters.writer.reviseLoopsUsed).toBe(2);
    expect(next.counters.writer.reviseLoopsUsed).toBe(2);
  });

  test('unknown paths warn but never throw (typo safety)', () => {
    const doc = newDoc();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => incrementCounter(doc, 'writer.nonsense')).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('formatCountersLogLine emits the grep-friendly BOOK_COUNTERS line', () => {
    const doc = newDoc();
    incrementCounter(doc, 'writer.reviseLoopsUsed', 2);
    incrementCounter(doc, 'illustrator.softFailsShipped');
    incrementCounter(doc, 'proseRevisionRequests', 3);
    expect(formatCountersLogLine(doc)).toBe(
      '[BOOK_COUNTERS] bookId=b-001 writer.reviseLoopsUsed=2 illustrator.softFailsShipped=1 proseRevisionRequests=3',
    );
  });
});
