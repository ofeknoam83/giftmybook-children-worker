/**
 * PR N.2 — runStage bounded retry on gate failures.
 *
 * Background:
 *   Before PR N.2, runStage had zero retry. A single LLM sample that
 *   failed the validator (e.g. a PB_INFANT bible with 3 cinematicLocations)
 *   killed the entire generation. retryMemory was wired up everywhere
 *   downstream but no one was actually populating it.
 *
 *   PR N.2 adds bounded gate-retry: when the validator returns issues,
 *   push a structured retryMemory entry naming the issues and re-run the
 *   stage up to N times. Every planner prompt already injects
 *   selectRetryMemory(...) → renderRetryMemoryForPrompt(...) so the next
 *   attempt sees the validator's complaints.
 *
 *   These tests pin the retry contract so a future refactor can't
 *   silently revert it.
 */

const { __testables } = require('../../../services/bookPipeline');
const { runStage, PLAN_GATE_RETRIES } = __testables;
const { createBookDocument } = require('../../../services/bookPipeline/schema/bookDocument');
const { FAILURE_CODES, AGE_BANDS, FORMATS } = require('../../../services/bookPipeline/constants');

function buildDoc() {
  return createBookDocument({
    request: { ageBand: AGE_BANDS.PB_INFANT, format: FORMATS.PICTURE_BOOK, theme: 'mothers_day' },
    brief: {
      child: { name: 'Everleigh', age: 0.7, gender: 'female' },
      customDetails: {},
    },
    cover: { title: 'Everleigh and Mama' },
    operationalContext: { bookId: 'test-book' },
  });
}

describe('PR N.2: runStage retry-with-memory plumbing', () => {
  test('PLAN_GATE_RETRIES is a sane positive integer (caps tail latency)', () => {
    // Hard contract: planner stages get retries, but not unbounded retries.
    // Anything > 3 risks burning credits on a stuck model.
    expect(Number.isInteger(PLAN_GATE_RETRIES)).toBe(true);
    expect(PLAN_GATE_RETRIES).toBeGreaterThanOrEqual(1);
    expect(PLAN_GATE_RETRIES).toBeLessThanOrEqual(3);
  });

  test('happy path: gate passes on first attempt, run is called exactly once', async () => {
    const doc = buildDoc();
    const run = jest.fn(async d => ({ ...d, storyBible: { ok: true } }));
    const gate = jest.fn(() => []);

    const result = await runStage(doc, 'storyBible', run, gate, FAILURE_CODES.PLAN_UNRESOLVABLE, { gateRetries: 2 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(result.storyBible).toEqual({ ok: true });
  });

  test('gate fails once, then passes: run is called twice and result is the second attempt', async () => {
    const doc = buildDoc();
    let attemptCount = 0;
    const run = jest.fn(async d => {
      attemptCount++;
      return { ...d, storyBible: { attempt: attemptCount } };
    });
    // Gate fails first call, passes second.
    const gate = jest.fn()
      .mockReturnValueOnce(['cinematicLocations must have at most 2 connected micro-settings for infant board books'])
      .mockReturnValueOnce([]);

    const result = await runStage(doc, 'storyBible', run, gate, FAILURE_CODES.PLAN_UNRESOLVABLE, { gateRetries: 2 });

    expect(run).toHaveBeenCalledTimes(2);
    expect(gate).toHaveBeenCalledTimes(2);
    expect(result.storyBible).toEqual({ attempt: 2 });
  });

  test('retryMemory is populated with the validator complaint between attempts', async () => {
    const doc = buildDoc();
    const validatorIssue = 'storyBible.cinematicLocations must have at most 2 connected micro-settings for infant board books (lap-baby scope)';
    const seenRetryMemoryByAttempt = [];
    const run = jest.fn(async d => {
      // Snapshot the retryMemory the run() function actually sees.
      // This is what the LLM prompt would render via renderRetryMemoryForPrompt.
      seenRetryMemoryByAttempt.push((d.retryMemory || []).map(e => ({
        stage: e.stage,
        failedAttemptNumber: e.failedAttemptNumber,
        mustChange: e.mustChange,
      })));
      return { ...d, storyBible: { ok: true } };
    });
    const gate = jest.fn()
      .mockReturnValueOnce([validatorIssue])
      .mockReturnValueOnce([]);

    await runStage(doc, 'storyBible', run, gate, FAILURE_CODES.PLAN_UNRESOLVABLE, { gateRetries: 2 });

    // First attempt sees no retryMemory; second attempt sees one entry naming the validator issue.
    expect(seenRetryMemoryByAttempt[0]).toEqual([]);
    expect(seenRetryMemoryByAttempt[1]).toHaveLength(1);
    expect(seenRetryMemoryByAttempt[1][0]).toMatchObject({
      stage: 'storyBible',
      failedAttemptNumber: 1,
      mustChange: [validatorIssue],
    });
  });

  test('retryMemory accumulates across multiple failed attempts (so later prompts see full history)', async () => {
    const doc = buildDoc();
    const seenRetryMemoryByAttempt = [];
    const run = jest.fn(async d => {
      seenRetryMemoryByAttempt.push((d.retryMemory || []).map(e => e.failedAttemptNumber));
      return { ...d, storyBible: { ok: true } };
    });
    const gate = jest.fn()
      .mockReturnValueOnce(['issue 1'])
      .mockReturnValueOnce(['issue 2'])
      .mockReturnValueOnce([]); // succeeds on third try

    await runStage(doc, 'storyBible', run, gate, FAILURE_CODES.PLAN_UNRESOLVABLE, { gateRetries: 2 });

    expect(run).toHaveBeenCalledTimes(3);
    // Attempt 1: no memory. Attempt 2: one entry. Attempt 3: two entries.
    expect(seenRetryMemoryByAttempt[0]).toEqual([]);
    expect(seenRetryMemoryByAttempt[1]).toEqual([1]);
    expect(seenRetryMemoryByAttempt[2]).toEqual([1, 2]);
  });

  test('exhausted retries throw PipelineError with PLAN_UNRESOLVABLE and the last validator issues', async () => {
    const doc = buildDoc();
    const run = jest.fn(async d => ({ ...d, storyBible: { ok: false } }));
    const gate = jest.fn(() => ['stuck issue']);

    await expect(
      runStage(doc, 'storyBible', run, gate, FAILURE_CODES.PLAN_UNRESOLVABLE, { gateRetries: 2 }),
    ).rejects.toMatchObject({
      name: 'PipelineError',
      stage: 'storyBible',
      failureCode: FAILURE_CODES.PLAN_UNRESOLVABLE,
      issues: ['stuck issue'],
    });
    // Total attempts = 1 + gateRetries
    expect(run).toHaveBeenCalledTimes(3);
  });

  test('thrown errors (LLM/network) bypass the retry budget — surface immediately', async () => {
    // Gate-recoverable failures are validator issues. An exception thrown
    // by the run() callback is an LLM/network error and should surface
    // immediately so we don't burn credits on infrastructure problems.
    const doc = buildDoc();
    const run = jest.fn(async () => {
      const err = new Error('OpenAI 500');
      throw err;
    });
    const gate = jest.fn(() => []);

    await expect(
      runStage(doc, 'storyBible', run, gate, FAILURE_CODES.PLAN_UNRESOLVABLE, { gateRetries: 2 }),
    ).rejects.toMatchObject({
      name: 'PipelineError',
      stage: 'storyBible',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('default gateRetries=0 preserves legacy single-attempt behavior for stages that do not opt in', async () => {
    // The illustration / writer stages still call runStage WITHOUT a
    // gateRetries opt — they have their own internal repair systems and
    // must not silently gain a fresh retry layer.
    const doc = buildDoc();
    const run = jest.fn(async d => ({ ...d, illustration: { ok: false } }));
    const gate = jest.fn(() => ['something']);

    await expect(
      runStage(doc, 'illustration', run, gate, FAILURE_CODES.SPREAD_UNRESOLVABLE),
    ).rejects.toMatchObject({ name: 'PipelineError' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('no gate: runStage runs exactly once and returns the result (no retries possible)', async () => {
    const doc = buildDoc();
    const run = jest.fn(async d => ({ ...d, coverComposition: { ok: true } }));

    const result = await runStage(doc, 'coverComposition', run, null, FAILURE_CODES.PLAN_UNRESOLVABLE, { gateRetries: 5 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.coverComposition).toEqual({ ok: true });
  });

  test('appends a stage trace on success (one trace per successful run, regardless of retries)', async () => {
    const doc = buildDoc();
    const run = jest.fn(async d => ({ ...d, storyBible: { ok: true } }));
    const gate = jest.fn()
      .mockReturnValueOnce(['retry me'])
      .mockReturnValueOnce([]);

    const result = await runStage(doc, 'storyBible', run, gate, FAILURE_CODES.PLAN_UNRESOLVABLE, { gateRetries: 2 });
    const storyBibleTraces = (result.trace.stages || []).filter(t => t.name === 'storyBible');
    expect(storyBibleTraces).toHaveLength(1);
  });
});
