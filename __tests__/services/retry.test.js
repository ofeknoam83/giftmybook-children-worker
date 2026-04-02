const { withRetry } = require('../../services/retry');

describe('withRetry', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns result on first success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on failure and succeeds', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('throws after all retries exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('persistent failure'));

    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 1 }))
      .rejects.toThrow('persistent failure');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('respects shouldRetry predicate', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('no retry'));

    await expect(withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 1,
      shouldRetry: () => false,
    })).rejects.toThrow('no retry');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('logs with label when provided', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    await withRetry(fn, { maxRetries: 2, baseDelayMs: 1, label: 'test-op' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('test-op'));
  });

  test('does not log without label', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    await withRetry(fn, { maxRetries: 2, baseDelayMs: 1 });
    expect(console.warn).not.toHaveBeenCalled();
  });
});
