// Mock fetch globally before requiring the module
const mockFetch = jest.fn().mockResolvedValue({ ok: true });
global.fetch = mockFetch;

const mockCommits = [
  { sha: 'abc1234def', shortSha: 'abc1234', subject: 'fix: illustration split panel', author: 'dev', authorDate: '2026-04-20T00:00:00Z' },
  { sha: 'def5678abc', shortSha: 'def5678', subject: 'feat: hero duplication check', author: 'dev', authorDate: '2026-04-19T00:00:00Z' },
];
jest.mock('../../services/workerCommits', () => ({
  getWorkerCommits: jest.fn(() => mockCommits),
}));

const { reportProgress, reportComplete, reportError } = require('../../services/progressReporter');
const { getWorkerCommits } = require('../../services/workerCommits');

describe('progressReporter', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  test('reportProgress does nothing without callbackUrl', async () => {
    await reportProgress(null, { bookId: 'test' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('reportProgress sends progress data', async () => {
    // Use a unique bookId to avoid throttle from other tests
    const bookId = `test-progress-${Date.now()}`;
    await reportProgress('https://example.com/callback', {
      bookId,
      stage: 'test',
      progress: 0.5,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/callback',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      })
    );
  });

  test('reportProgress throttles rapid calls', async () => {
    const bookId = `test-throttle-${Date.now()}`;
    await reportProgress('https://example.com/callback', { bookId, progress: 0.1 });
    await reportProgress('https://example.com/callback', { bookId, progress: 0.2 });
    await reportProgress('https://example.com/callback', { bookId, progress: 0.3 });
    // Only first call should go through (throttled at 10s)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('reportComplete sends completion data', async () => {
    await reportComplete('https://example.com/callback', {
      bookId: 'test-complete',
      interiorPdfUrl: 'https://example.com/pdf',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.success).toBe(true);
    expect(body.bookId).toBe('test-complete');
  });

  test('reportComplete does nothing without callbackUrl', async () => {
    await reportComplete(null, { bookId: 'test' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('reportError sends error data', async () => {
    await reportError('https://example.com/callback', {
      bookId: 'test-error',
      error: 'Something went wrong',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Something went wrong');
  });

  test('reportProgress handles fetch errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'));
    const bookId = `test-error-handling-${Date.now()}`;
    // Should not throw
    await reportProgress('https://example.com/callback', { bookId, progress: 0.5 });
  });

  test('reportProgress attaches workerCommits to the callback body', async () => {
    const bookId = `test-commits-progress-${Date.now()}`;
    await reportProgress('https://example.com/callback', { bookId, stage: 'test', progress: 0.1 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.workerCommits).toEqual(mockCommits);
  });

  test('reportComplete attaches workerCommits to the callback body', async () => {
    await reportComplete('https://example.com/callback', {
      bookId: `test-commits-complete-${Date.now()}`,
      interiorPdfUrl: 'https://example.com/pdf',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.workerCommits).toEqual(mockCommits);
    expect(body.success).toBe(true);
  });

  test('reportError attaches workerCommits to the callback body', async () => {
    await reportError('https://example.com/callback', {
      bookId: `test-commits-error-${Date.now()}`,
      error: 'boom',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.workerCommits).toEqual(mockCommits);
    expect(body.success).toBe(false);
  });

  test('omits workerCommits when commits are unavailable', async () => {
    getWorkerCommits.mockReturnValueOnce([]);
    await reportComplete('https://example.com/callback', {
      bookId: `test-no-commits-${Date.now()}`,
      interiorPdfUrl: 'https://example.com/pdf',
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.workerCommits).toBeUndefined();
  });
});
