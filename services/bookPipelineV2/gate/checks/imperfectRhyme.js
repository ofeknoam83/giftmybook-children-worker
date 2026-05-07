/**
 * Imperfect-rhyme detector — LLM acoustic judge.
 *
 * Why LLM, not orthography: English spelling lies. The previous
 * deterministic implementation took raw "last vowel + everything after"
 * and required equality, which:
 *   - correctly flagged 'step' / 'kept' (the AA-CW failure that started
 *     this whole effort), but
 *   - also flagged perfectly fine rhymes like 'tree' / 'me', 'low' /
 *     'go', 'nest' / 'breast', 'bee' / 'see' — orthographic differences
 *     where the sounds match.
 * The revisor would loop forever because every fresh rewrite that
 * actually rhymed was rejected by the orthographic rule.
 *
 * The fix: ask a model. Rhyme is acoustic — let an LLM judge by SOUND.
 * A separate role (`RHYME_JUDGE`) defaults to Gemini-mid (cross-family
 * vs WRITER, cheap, ~80 output tokens per call).
 *
 * Failure shape is identical to before (`code: 'imperfect_rhyme'`, list
 * of failed couplets) so the revision engine and HARD_GATE_CODES logic
 * don't change. Still soft (penalty=1) — the LLM critic remains the
 * second pair of eyes.
 *
 * Fail-open: if the judge throws or returns garbage, log and pass.
 * Matches the locked principle "don't fail, just pass what we have".
 */

const fs = require('fs');
const path = require('path');
const { lastWord } = require('./identityRhyme');
const { callWithRole } = require('../../llm/modelRouter');

const SYSTEM = fs.readFileSync(
  path.join(__dirname, '../../llm/prompts/rhymeJudge.system.md'),
  'utf8',
);

function normalizeEndWord(word) {
  if (!word) return null;
  // strip trailing punctuation, lowercase
  return String(word).toLowerCase().replace(/[^a-z']+$/, '') || null;
}

/**
 * Pulls the L1/L2 and L3/L4 last-word couplets from a draft text.
 * Returns null if there's nothing to judge (e.g. <2 lines, identical
 * words on both ends — identity is caught by a separate hard check).
 */
function couplets(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const out = {};
  if (lines.length >= 2) {
    const a = normalizeEndWord(lastWord(lines[0]));
    const b = normalizeEndWord(lastWord(lines[1]));
    if (a && b && a !== b) out.L1L2 = [a, b];
  }
  if (lines.length >= 4) {
    const a = normalizeEndWord(lastWord(lines[2]));
    const b = normalizeEndWord(lastWord(lines[3]));
    if (a && b && a !== b) out.L3L4 = [a, b];
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Calls the rhyme judge. One retry, then fail-open. Returns a
 * `{ L1L2?: {ok, reason}, L3L4?: {ok, reason} }` object — or `null`
 * on unrecoverable error so the caller knows to pass.
 */
async function judgeRhymes(pairs, ctx) {
  const userPrompt = JSON.stringify(pairs);
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const resp = await callWithRole('RHYME_JUDGE', {
        systemPrompt: SYSTEM,
        userPrompt,
        jsonMode: true,
        temperature: 0.1,
        maxTokens: 200,
        label: 'v2.rhymeJudge',
      }, { mustDifferFrom: 'WRITER' });
      const verdict = resp && resp.json;
      if (verdict && typeof verdict === 'object') return verdict;
      lastErr = new Error('rhymeJudge: empty/invalid JSON');
    } catch (err) {
      lastErr = err;
    }
  }
  if (ctx && typeof ctx.log === 'function') {
    ctx.log('warn', `[v2] rhymeJudge failed-open after retry: ${lastErr && lastErr.message}`);
  }
  return null;
}

/**
 * Async gate check. Skips for free verse / non-strict bands. Calls the
 * LLM rhyme judge for the L1/L2 and L3/L4 couplets. Fail-open on
 * judge errors.
 */
async function imperfectRhymeCheck(draft, beat, ageProfile, ctx = {}) {
  const strict = ageProfile?.narrativeConstraints?.rhymeStrictness;
  if (!strict || strict === 'free' || strict === 'none') return { passed: true };

  const scheme = ageProfile?.narrativeConstraints?.rhymeScheme;
  if (scheme && /^free/i.test(scheme)) return { passed: true };

  const pairs = couplets(draft?.text || '');
  if (!pairs) return { passed: true };

  const verdict = await judgeRhymes(pairs, ctx);
  if (!verdict) return { passed: true }; // fail-open

  const failures = [];
  for (const couplet of ['L1L2', 'L3L4']) {
    const v = verdict[couplet];
    if (!v) continue;
    if (v.ok === false) {
      failures.push({
        couplet,
        words: pairs[couplet],
        reason: typeof v.reason === 'string' ? v.reason : 'does not rhyme',
      });
    }
  }
  if (!failures.length) return { passed: true };

  return {
    passed: false,
    code: 'imperfect_rhyme',
    message: failures.map((f) =>
      `Imperfect rhyme on ${f.couplet}: '${f.words[0]}' / '${f.words[1]}' — ${f.reason}`
    ).join(' '),
    detail: failures,
  };
}

module.exports = { imperfectRhymeCheck, couplets, judgeRhymes };
