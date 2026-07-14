/**
 * Lightweight in-process workflow engine modeled after Temporal.
 *
 * Why not just call functions in sequence? Three reasons:
 *
 *   1. Every activity output is persisted to the artifact store before
 *      the next activity sees it. Replays from any stage are free, and
 *      "what did stage 7 see when it ran" is always answerable.
 *   2. Retries with bounded attempts and per-activity backoff are wired
 *      uniformly — no one off retry loops scattered across modules.
 *   3. The interface is deliberately Temporal-shaped: when we move to
 *      Temporal proper, the swap is mechanical (execute → activities
 *      proxy, runWorkflow → workflow definition, ctx.put → context
 *      memo + heartbeat).
 *
 * Public contract:
 *   const ctx = createWorkflowContext({ bookId, store, signals, log });
 *   await ctx.execute('stage_3_intent', activities.storyIntent, input, {
 *     retries: 2, timeoutMs: 30000,
 *   });
 *   ctx.checkAbort();        // throws if upstream cancelled
 *   ctx.heartbeat('intent'); // touches activity-watchdog
 */

class WorkflowAbortError extends Error {
  constructor(message) {
    super(message || 'workflow aborted');
    this.name = 'WorkflowAbortError';
    this.isAbort = true;
  }
}

class ActivityFailedError extends Error {
  constructor(activityName, cause, attempts) {
    super(
      `activity '${activityName}' failed after ${attempts} attempt${attempts > 1 ? 's' : ''}: ${cause?.message || cause}`,
    );
    this.name = 'ActivityFailedError';
    this.activityName = activityName;
    this.cause = cause;
    this.attempts = attempts;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {{
 *   bookId: string,
 *   store: object,                 // artifact store
 *   signals?: { abortSignal?: AbortSignal, touchActivity?: () => void, onProgress?: (event) => void },
 *   log?: (level, msg, meta?) => void,
 * }} opts
 */
function createWorkflowContext({ bookId, store, signals = {}, log }) {
  if (!bookId) throw new Error('createWorkflowContext: bookId is required');
  if (!store) throw new Error('createWorkflowContext: store is required');

  const safeLog = typeof log === 'function' ? log : () => {};

  function checkAbort() {
    if (signals.abortSignal?.aborted) throw new WorkflowAbortError('upstream aborted');
  }

  function heartbeat(_label) {
    try { signals.touchActivity?.(); } catch { /* ignore */ }
  }

  function reportProgress(event) {
    try { signals.onProgress?.(event); } catch (err) {
      safeLog('warn', `progress callback threw: ${err.message}`);
    }
  }

  /**
   * Run an activity with bounded retries, abort checks, persistence.
   * @param {string} stageKey   — the artifact key the result is stored under
   * @param {function} activity — async function (input, ctx) => output
   * @param {*} input
   * @param {{ retries?: number, baseDelayMs?: number, parent?: string, isRetryable?: (err) => boolean }} opts
   */
  async function execute(stageKey, activity, input, opts = {}) {
    const retries = Math.max(0, opts.retries ?? 1);
    const baseDelayMs = opts.baseDelayMs ?? 800;
    const parent = opts.parent ?? null;
    const isRetryable = opts.isRetryable ?? ((err) => Boolean(err?.isTransient));

    // Idempotent skip: if this stage already has a stored artifact, reuse it.
    if (await store.has(stageKey)) {
      const existing = await store.get(stageKey);
      safeLog('info', `[v2] activity '${stageKey}' SKIPPED (artifact exists)`);
      return existing;
    }

    let lastErr = null;
    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      checkAbort();
      heartbeat(stageKey);
      const t0 = Date.now();
      // Periodic heartbeat while the activity runs. The per-book watchdog
      // aborts after 15 min of inactivity, but a single LLM-heavy activity
      // (det gate with rhyme judge, page writer with retries, etc.) can
      // exceed several minutes. Tick every 30s so a stuck activity still
      // surfaces as the activity's own timeout, not as a watchdog kill.
      const heartbeatTimer = setInterval(() => {
        try { heartbeat(stageKey); } catch { /* swallow */ }
      }, 30000);
      let result;
      try {
        result = await activity(input, {
          bookId,
          stageKey,
          attempt,
          checkAbort,
          heartbeat,
          reportProgress,
          log: safeLog,
          store,
        });
      } catch (err) {
        clearInterval(heartbeatTimer);
        lastErr = err;
        const dt = Date.now() - t0;
        const retryable = isRetryable(err);
        safeLog(
          retryable && attempt <= retries ? 'warn' : 'error',
          `[v2] activity '${stageKey}' FAILED in ${dt}ms (attempt ${attempt}/${retries + 1}): ${err.message}`,
        );
        if (attempt > retries || !retryable) break;
        await delay(baseDelayMs * 2 ** (attempt - 1));
        continue;
      }
      clearInterval(heartbeatTimer);
      await store.put(stageKey, result, { parent, attempt });
      const dt = Date.now() - t0;
      safeLog('info', `[v2] activity '${stageKey}' OK in ${dt}ms (attempt ${attempt}/${retries + 1})`);
      reportProgress({ step: stageKey, message: `Stage ${stageKey} complete`, attempt });
      return result;
    }
    throw new ActivityFailedError(stageKey, lastErr, retries + 1);
  }

  return {
    bookId,
    store,
    execute,
    checkAbort,
    heartbeat,
    reportProgress,
    log: safeLog,
  };
}

module.exports = {
  createWorkflowContext,
  WorkflowAbortError,
  ActivityFailedError,
};
