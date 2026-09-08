const { createVideoDelivery } = require('../services/videoDelivery');

const setup = () => {
  const send = jest.fn(async () => true);
  const stable = { bookId: 'any-child-book', dispatchId: 'gv_current', mode: 'full-story' };
  const delivery = createVideoDelivery({ stable, send, costTracker: { getSummary: () => ({ totalCost: 12 }) } });
  return { delivery, send, stable };
};

test('shutdown immediately delivers a correlated resumable interruption within the grace budget', async () => {
  const { delivery, send, stable } = setup();
  let finishSend;
  send.mockImplementation(() => new Promise(resolve => { finishSend = resolve; }));
  const pending = delivery.interrupt();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toMatchObject({ ...stable, success: false, video: null,
    failureCode: 'worker_interrupted', costs: { totalCost: 12 },
    recovery: { reason: 'worker_interrupted', stage: 'video_generation', retryable: true } });
  const options = send.mock.calls[0][1];
  expect(options.attempts * options.timeoutMs + options.retryDelayMs).toBeLessThan(10000);
  expect(await delivery.complete({ success: false, error: 'Scene 10: aborted' })).toBe(false);
  expect(await delivery.interrupt()).toBe(false);
  finishSend(true);
  await pending;
  expect(send).toHaveBeenCalledTimes(1);
});

test('a completed film cannot later be overwritten by shutdown', async () => {
  const { delivery, send } = setup();
  const payload = { success: true, video: { storageKey: 'saved-film.mp4' } };
  expect(await delivery.complete(payload)).toBe(true);
  expect(await delivery.interrupt()).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toBe(payload);
});

test('ordinary failures retain their exact classification and do not gain automatic recovery', async () => {
  const { delivery, send } = setup();
  const payload = { success: false, failureCode: 'video_provider_input_rejected', error: 'Provider refused input' };
  await delivery.complete(payload);
  await delivery.interrupt();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toBe(payload);
  expect(send.mock.calls[0][0].recovery).toBeUndefined();
});
