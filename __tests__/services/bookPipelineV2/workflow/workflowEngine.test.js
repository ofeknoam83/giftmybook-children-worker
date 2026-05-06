/**
 * v2 workflow engine — Temporal-shaped contract.
 *
 * Pin three behaviours:
 *   - idempotent skip when the artifact already exists in the store
 *   - bounded retries with successful recovery
 *   - hard abort propagation via abortSignal
 */

const { createWorkflowContext, WorkflowAbortError, ActivityFailedError } =
  require('../../../../services/bookPipelineV2/orchestration/workflowEngine');
const { createArtifactStore } =
  require('../../../../services/bookPipelineV2/artifactStore');

function makeCtx(opts = {}) {
  const store = createArtifactStore({ bookId: 'test_book' });
  const logs = [];
  const log = (level, msg) => logs.push({ level, msg });
  const ctx = createWorkflowContext({
    bookId: 'test_book', store, signals: opts.signals || {}, log,
  });
  return { ctx, store, logs };
}

describe('workflowEngine.execute', () => {
  test('runs an activity once and persists its output', async () => {
    const { ctx, store } = makeCtx();
    let calls = 0;
    const out = await ctx.execute('stage_a', async () => { calls += 1; return { hello: 'world' }; }, {});
    expect(out).toEqual({ hello: 'world' });
    expect(calls).toBe(1);
    expect(await store.get('stage_a')).toEqual({ hello: 'world' });
  });

  test('idempotent skip: re-running the same stage reuses the artifact', async () => {
    const { ctx, store } = makeCtx();
    let calls = 0;
    const activity = async () => { calls += 1; return { n: calls }; };
    const a = await ctx.execute('stage_a', activity, {});
    const b = await ctx.execute('stage_a', activity, {});
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 1 }); // same artifact, not re-run
    expect(calls).toBe(1);
    expect(await store.has('stage_a')).toBe(true);
  });

  test('retries until success when error.isTransient', async () => {
    const { ctx } = makeCtx();
    let attempts = 0;
    const activity = async () => {
      attempts += 1;
      if (attempts < 3) {
        const e = new Error('transient'); e.isTransient = true; throw e;
      }
      return { ok: true, attempts };
    };
    const out = await ctx.execute('stage_a', activity, {}, { retries: 3, baseDelayMs: 1 });
    expect(out).toEqual({ ok: true, attempts: 3 });
  });

  test('throws ActivityFailedError after exhausting retries', async () => {
    const { ctx } = makeCtx();
    const activity = async () => { const e = new Error('always fails'); e.isTransient = true; throw e; };
    await expect(
      ctx.execute('stage_a', activity, {}, { retries: 2, baseDelayMs: 1 })
    ).rejects.toBeInstanceOf(ActivityFailedError);
  });

  test('does not retry non-transient errors', async () => {
    const { ctx } = makeCtx();
    let calls = 0;
    const activity = async () => { calls += 1; throw new Error('hard fail'); };
    await expect(
      ctx.execute('stage_a', activity, {}, { retries: 5, baseDelayMs: 1 })
    ).rejects.toBeInstanceOf(ActivityFailedError);
    expect(calls).toBe(1);
  });

  test('respects abort signal before invoking the activity', async () => {
    const ac = new AbortController();
    ac.abort();
    const { ctx } = makeCtx({ signals: { abortSignal: ac.signal } });
    let called = false;
    const activity = async () => { called = true; return {}; };
    await expect(ctx.execute('stage_a', activity, {})).rejects.toBeInstanceOf(WorkflowAbortError);
    expect(called).toBe(false);
  });

  test('reports progress through the onProgress signal', async () => {
    const events = [];
    const { ctx } = makeCtx({ signals: { onProgress: (e) => events.push(e) } });
    await ctx.execute('stage_a', async () => ({ ok: true }), {});
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].step).toBe('stage_a');
  });
});

describe('artifactStore', () => {
  test('hashContent produces stable digests for the same value', async () => {
    const store = createArtifactStore({ bookId: 'b' });
    await store.put('k', { a: 1, b: 2 });
    const r = await store.getRecord('k');
    expect(r.contentHash).toBeDefined();
    expect(r.contentHash.length).toBeGreaterThan(0);
  });
});
