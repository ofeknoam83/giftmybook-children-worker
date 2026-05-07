/**
 * v2 gate — imperfect rhyme (LLM acoustic judge).
 *
 * The deterministic orthographic implementation was replaced after it
 * looped revisions on book e3f4e0c0 (Scarlett, mothers_day): perfectly
 * fine rhymes like 'tree' / 'me' and 'low' / 'go' kept failing. Now
 * the check asks an LLM via the RHYME_JUDGE role; we mock it here.
 *
 * Tests cover:
 *   - true rhyme passes (judge says ok)
 *   - bad rhyme like 'step'/'kept' fails with reason from the judge
 *   - free-verse skips the judge entirely
 *   - judge error → fail-open (book is never blocked on transient LLM)
 */

jest.mock('../../../../services/bookPipelineV2/llm/modelRouter', () => ({
  callWithRole: jest.fn(),
}));

const { callWithRole } = require('../../../../services/bookPipelineV2/llm/modelRouter');
const { imperfectRhymeCheck } = require('../../../../services/bookPipelineV2/gate/checks/imperfectRhyme');

function draftFromLines(lines) { return { text: lines.join('\n'), lines }; }
const beat = {};
const ageProfile = { narrativeConstraints: { rhymeScheme: 'AABB', rhymeStrictness: 'perfect_rhyme_required_imperfect_eye_rhymes_banned' } };

beforeEach(() => {
  callWithRole.mockReset();
});

describe('v2 imperfectRhyme gate (LLM judge)', () => {
  test('passes when judge says both couplets ok (gold/hold + low/slow)', async () => {
    callWithRole.mockResolvedValue({
      json: {
        L1L2: { ok: true, reason: 'both end in /oʊld/' },
        L3L4: { ok: true, reason: 'both end in /oʊ/' },
      },
      model: 'mock',
    });
    const d = draftFromLines([
      'Lamps glow gold.',
      'Hands to hold.',
      'Trees bend low.',
      'Wind sings slow.',
    ]);
    const r = await imperfectRhymeCheck(d, beat, ageProfile);
    expect(r.passed).toBe(true);
    expect(callWithRole).toHaveBeenCalledTimes(1);
  });

  test('passes orthographically-different but acoustically-perfect rhymes (tree/me)', async () => {
    // This is the regression case: the old orthographic check would FAIL
    // tree/me because the rimes 'ee' vs 'e' differ. The judge knows better.
    callWithRole.mockResolvedValue({
      json: {
        L1L2: { ok: true, reason: 'both end in /iː/' },
        L3L4: { ok: true, reason: 'both end in /oʊ/' },
      },
      model: 'mock',
    });
    const d = draftFromLines([
      'A bird in the tree.',
      'Sings down to me.',
      'Lights are low.',
      'Off we go.',
    ]);
    const r = await imperfectRhymeCheck(d, beat, ageProfile);
    expect(r.passed).toBe(true);
  });

  test('flags step/kept when judge says not ok; surfaces reason in message', async () => {
    callWithRole.mockResolvedValue({
      json: {
        L1L2: { ok: false, reason: "ends in /pt/ vs /p/, codas differ" },
        L3L4: { ok: true, reason: 'both end in /oʊld/' },
      },
      model: 'mock',
    });
    const d = draftFromLines([
      'Mama comes by the step.',
      'Scarlett looks where she is kept.',
      'Lamps glow gold.',
      'Hands to hold.',
    ]);
    const r = await imperfectRhymeCheck(d, beat, ageProfile);
    expect(r.passed).toBe(false);
    expect(r.code).toBe('imperfect_rhyme');
    expect(r.message).toMatch(/L1L2/);
    expect(r.message).toMatch(/codas differ/);
    expect(r.detail).toHaveLength(1);
    expect(r.detail[0].words).toEqual(['step', 'kept']);
  });

  test('does not call judge when ageProfile says rhyme is not required', async () => {
    const profile = { narrativeConstraints: { rhymeScheme: 'free', rhymeStrictness: 'free' } };
    const d = draftFromLines([
      'A b c step.',
      'D e f kept.',
      'G h i gold.',
      'J k l hold.',
    ]);
    const r = await imperfectRhymeCheck(d, beat, profile);
    expect(r.passed).toBe(true);
    expect(callWithRole).not.toHaveBeenCalled();
  });

  test('fail-open when judge throws (transient LLM error)', async () => {
    callWithRole.mockRejectedValue(new Error('upstream 503'));
    const d = draftFromLines([
      'Mama comes by the step.',
      'Scarlett looks where she is kept.',
      'Lamps glow gold.',
      'Hands to hold.',
    ]);
    const r = await imperfectRhymeCheck(d, beat, ageProfile, { log: () => {} });
    expect(r.passed).toBe(true);
    // retried once, then fail-open → 2 calls
    expect(callWithRole).toHaveBeenCalledTimes(2);
  });

  test('fail-open when judge returns invalid JSON', async () => {
    callWithRole.mockResolvedValue({ json: null, model: 'mock' });
    const d = draftFromLines([
      'Mama comes by the step.',
      'Scarlett looks where she is kept.',
    ]);
    const r = await imperfectRhymeCheck(d, beat, ageProfile, { log: () => {} });
    expect(r.passed).toBe(true);
    expect(callWithRole).toHaveBeenCalledTimes(2); // retry then fail-open
  });
});
