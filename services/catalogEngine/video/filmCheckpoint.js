const { setTimeout: delay } = require('node:timers/promises');

// GCS limits replacements of a single object to one per second. Cached
// narration can replay much faster than that; checkpoints must pace writes.
// https://cloud.google.com/storage/quotas#objects
function createCheckpointWriter({ save, signal, now = Date.now, wait = ms => delay(ms, undefined, { signal }), log = () => {} }) {
  let lastWrite = -Infinity;
  let queue = Promise.resolve();
  return (data, key) => {
    const write = async () => {
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        const pause = Math.max(0, 1100 - (now() - lastWrite));
        if (pause) await wait(pause);
        signal?.throwIfAborted();
        lastWrite = now();
        try { return await save(data, key); }
        catch (err) {
          const code = err.code || err.statusCode || err.response?.status;
          const transient = [408, 429, 500, 502, 503, 504].includes(Number(code))
            || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'].includes(code);
          if (!transient || attempt >= 3) throw err;
          log('warn', `Film checkpoint write temporarily unavailable (${code}); retry ${attempt + 1}/3 with saved media retained`);
          await wait(1100 * 2 ** attempt);
        }
      }
    };
    const result = queue.then(write);
    queue = result.catch(() => {});
    return result;
  };
}
module.exports = { createCheckpointWriter };
