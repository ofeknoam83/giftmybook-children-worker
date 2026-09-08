const { createCheckpointWriter } = require('../../../../services/catalogEngine/video/filmCheckpoint');

function writer(save, extra = {}) {
  let clock = 0;
  const wait = jest.fn(async ms => { clock += ms; });
  return { write: createCheckpointWriter({ save, now: () => clock, wait, ...extra }), wait };
}
test('rapid cached narration checkpoints are serialized and paced below the object write limit', async () => {
  const saved = [], save = jest.fn(async data => { saved.push(data.passage); });
  const { write, wait } = writer(save);
  await Promise.all([1, 2, 3].map(passage => write({ passage }, 'resume.json')));
  expect(saved).toEqual([1, 2, 3]);
  expect(wait.mock.calls).toEqual([[1100], [1100]]);
});
test('rate limits and service interruptions retry the identical checkpoint with bounded backoff', async () => {
  const save = jest.fn().mockRejectedValueOnce(Object.assign(new Error('throttled'), { code: 429 }))
    .mockRejectedValueOnce(Object.assign(new Error('unavailable'), { code: 503 })).mockResolvedValue('saved');
  const { write, wait } = writer(save);
  await expect(write({ passage: 27 }, 'resume.json')).resolves.toBe('saved');
  expect(save).toHaveBeenCalledTimes(3);
  expect(save.mock.calls.every(([data, key]) => data.passage === 27 && key === 'resume.json')).toBe(true);
  expect(wait.mock.calls).toEqual([[1100], [2200]]);
});
test('persistent transient errors stop after four attempts; permission failures are never retried', async () => {
  const save = jest.fn().mockRejectedValue(Object.assign(new Error('throttled'), { code: 429 }));
  await expect(writer(save).write({}, 'resume')).rejects.toMatchObject({ code: 429 });
  expect(save).toHaveBeenCalledTimes(4);
  const denied = jest.fn().mockRejectedValue(Object.assign(new Error('denied'), { code: 403 }));
  await expect(writer(denied).write({}, 'resume')).rejects.toMatchObject({ code: 403 });
  expect(denied).toHaveBeenCalledTimes(1);
});
test('cancellation prevents a queued checkpoint from writing', async () => {
  const controller = new AbortController(), save = jest.fn();
  const { write } = writer(save, { signal: controller.signal });
  controller.abort();
  await expect(write({}, 'resume')).rejects.toThrow();
  expect(save).not.toHaveBeenCalled();
});
