const { deliverBookCompletion } = require('../../services/deliverBookCompletion');

let input;
beforeEach(() => {
  input = { callbackUrl: 'https://app.example/callback', progressCallbackUrl: 'https://app.example/progress',
    completion: { bookId: 'book', success: true }, postWithRetry: jest.fn(async () => true), clearCheckpoint: jest.fn(), log: jest.fn() };
});
test('one accepted completion clears the checkpoint without duplicate completion side effects', async () => {
  expect(await deliverBookCompletion(input)).toBe(true);
  expect(input.postWithRetry).toHaveBeenCalledTimes(1);
  expect(input.postWithRetry).toHaveBeenCalledWith(input.callbackUrl, input.completion);
  expect(input.clearCheckpoint).toHaveBeenCalledWith('book');
});
test('retries the completion through progress when the primary endpoint exhausts delivery attempts', async () => {
  input.postWithRetry.mockResolvedValueOnce(false);
  expect(await deliverBookCompletion(input)).toBe(true);
  expect(input.postWithRetry).toHaveBeenLastCalledWith(input.progressCallbackUrl, input.completion);
  expect(input.clearCheckpoint).toHaveBeenCalledTimes(1);
});
test('retains the completed-art checkpoint when every callback fails', async () => {
  input.postWithRetry.mockResolvedValue(false);
  expect(await deliverBookCompletion(input)).toBe(false);
  expect(input.clearCheckpoint).not.toHaveBeenCalled();
  expect(input.log).toHaveBeenCalledWith('warn', expect.stringContaining('preserved'));
});
test('a repeated callback URL is not delivered twice', async () => {
  input.progressCallbackUrl = input.callbackUrl;
  input.postWithRetry.mockResolvedValue(false);
  await deliverBookCompletion(input);
  expect(input.postWithRetry).toHaveBeenCalledTimes(1);
});
