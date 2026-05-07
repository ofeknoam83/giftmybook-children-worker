/**
 * Stage 9 — Manuscript Gate (deterministic, all spreads at once)
 *
 * Runs every synchronous deterministic gate check (identity rhyme,
 * filler phrases, headline-noun repeat, moralising, protagonist anti
 * verb, line length window, line count, beat prohibited, dialogue
 * ban, past tense, line-starter repeat) against EVERY spread in the
 * manuscript, and makes ONE combined acoustic rhyme-judge LLM call
 * for all couplets at once.
 *
 * Replaces the per-spread `deterministicGate` activity that used to
 * run 12× sequentially with 12× rhyme-judge LLM calls. Now: ~12×
 * cheap sync checks (microseconds total) + 1 LLM call (~3 seconds).
 *
 * Returns:
 *   {
 *     passed: boolean,                       // overall: true iff every spread passes
 *     perSpread: [
 *       { spread, passed, failures: [...] }
 *     ],
 *   }
 */

const fs = require('fs');
const path = require('path');
const { callWithRole } = require('../../llm/modelRouter');

// Reuse the existing per-spread sync checks from gate/checks.
const { identityRhymeCheck } = require('../../gate/checks/identityRhyme');
const { fillerPhraseBlocklistCheck } = require('../../gate/checks/fillerPhraseBlocklist');
const { headlineNounRepeatCheck } = require('../../gate/checks/headlineNounRepeat');
const { moralisingPhrasesCheck } = require('../../gate/checks/moralisingPhrases');
const { protagonistAntiVerbCheck } = require('../../gate/checks/protagonistAntiVerb');
const { lineLengthWindowCheck } = require('../../gate/checks/lineLengthWindow');
const { lineCountCheck } = require('../../gate/checks/lineCount');
const { beatProhibitedCheck } = require('../../gate/checks/beatProhibited');
const { dialogueBanCheck } = require('../../gate/checks/dialogueBan');
const { pastTenseCheck } = require('../../gate/checks/pastTense');
const { lineStarterRepeatCheck } = require('../../gate/checks/lineStarterRepeat');
const { couplets } = require('../../gate/checks/imperfectRhyme');

const SYNC_CHECKS = [
  { name: 'lineCount',              fn: lineCountCheck },
  { name: 'identityRhyme',          fn: identityRhymeCheck },
  { name: 'fillerPhraseBlocklist',  fn: fillerPhraseBlocklistCheck },
  { name: 'headlineNounRepeat',     fn: headlineNounRepeatCheck },
  { name: 'lineStarterRepeat',     fn: lineStarterRepeatCheck },
  { name: 'moralisingPhrases',      fn: moralisingPhrasesCheck },
  { name: 'protagonistAntiVerb',    fn: protagonistAntiVerbCheck },
  { name: 'lineLengthWindow',       fn: lineLengthWindowCheck },
  { name: 'beatProhibited',         fn: beatProhibitedCheck },
  { name: 'dialogueBan',            fn: dialogueBanCheck },
  { name: 'pastTense',              fn: pastTenseCheck },
];

const MANUSCRIPT_RHYME_SYSTEM = fs.readFileSync(
  path.join(__dirname, '../../llm/prompts/manuscriptRhymeJudge.system.md'),
  'utf8',
);

async function runSyncChecks(draft, beat, ageProfile, ctx) {
  const failures = [];
  for (const { name, fn } of SYNC_CHECKS) {
    let r;
    try {
      // Most sync checks are not declared async, but some may be — await uniformly.
      r = await fn(draft, beat, ageProfile, ctx);
    } catch (err) {
      r = { passed: false, code: `${name}_threw`, message: `Gate check '${name}' threw: ${err.message}` };
    }
    if (r && r.passed === false) failures.push({ check: name, ...r });
  }
  return failures;
}

/**
 * Build the combined rhyme-judge input across all spreads.
 * Returns: { spreads: [{ spread, L1L2?, L3L4? }, ...] } or null if no couplets.
 */
function buildRhymePayload(drafts, ageProfile) {
  const strict = ageProfile?.narrativeConstraints?.rhymeStrictness;
  if (!strict || strict === 'free' || strict === 'none') return null;
  const scheme = ageProfile?.narrativeConstraints?.rhymeScheme;
  if (scheme && /^free/i.test(scheme)) return null;

  const spreads = [];
  for (const d of drafts) {
    const pairs = couplets(d?.text || (Array.isArray(d?.lines) ? d.lines.join('\n') : ''));
    if (!pairs) continue;
    spreads.push({ spread: d.spread, ...pairs });
  }
  if (!spreads.length) return null;
  return { spreads };
}

async function callManuscriptRhymeJudge(payload, ctx) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (ctx && typeof ctx.heartbeat === 'function') {
      try { ctx.heartbeat('manuscriptRhymeJudge'); } catch { /* swallow */ }
    }
    try {
      const resp = await callWithRole('RHYME_JUDGE', {
        systemPrompt: MANUSCRIPT_RHYME_SYSTEM,
        userPrompt: JSON.stringify(payload),
        jsonMode: true,
        temperature: 0.1,
        // 13 spreads × ~2 couplets × small JSON each → still well under 1500.
        maxTokens: 1500,
        label: 'v2.manuscriptRhymeJudge',
      });
      const verdict = resp && resp.json;
      if (verdict && typeof verdict === 'object' && Array.isArray(verdict.spreads)) {
        return verdict;
      }
      lastErr = new Error('manuscriptRhymeJudge: empty/invalid JSON');
    } catch (err) {
      lastErr = err;
    }
  }
  if (ctx && typeof ctx.log === 'function') {
    ctx.log('warn', `[v2] manuscriptRhymeJudge failed-open after retry: ${lastErr && lastErr.message}`);
  }
  return null;
}

async function manuscriptGateActivity(input, ctx) {
  const { drafts, beatSheet, ageProfile, protagonistName } = input;
  const beatBySpread = new Map((beatSheet?.spreads || []).map((b) => [b.spread, b]));

  const perSpread = [];

  // 1) Run sync checks across every spread.
  for (const d of drafts) {
    const beat = beatBySpread.get(d.spread) || null;
    const failures = await runSyncChecks(d, beat, ageProfile, { protagonistName, log: ctx.log });
    perSpread.push({ spread: d.spread, failures });
  }

  // 2) ONE combined rhyme-judge call for the whole manuscript.
  const rhymePayload = buildRhymePayload(drafts, ageProfile);
  let rhymeVerdict = null;
  if (rhymePayload) {
    rhymeVerdict = await callManuscriptRhymeJudge(rhymePayload, ctx);
  }
  if (rhymeVerdict && Array.isArray(rhymeVerdict.spreads)) {
    const draftBySpread = new Map();
    for (const d of drafts) draftBySpread.set(d.spread, d);
    const payloadBySpread = new Map();
    for (const p of rhymePayload.spreads) payloadBySpread.set(p.spread, p);

    for (const verdict of rhymeVerdict.spreads) {
      const sp = verdict?.spread;
      if (typeof sp !== 'number') continue;
      const entry = perSpread.find((e) => e.spread === sp);
      if (!entry) continue;
      const inputPairs = payloadBySpread.get(sp) || {};
      const violations = [];
      for (const couplet of ['L1L2', 'L3L4']) {
        const v = verdict[couplet];
        if (!v || v.ok !== false) continue;
        const words = inputPairs[couplet] || [];
        violations.push({ couplet, words, reason: typeof v.reason === 'string' ? v.reason : 'does not rhyme' });
      }
      if (violations.length > 0) {
        entry.failures.push({
          check: 'imperfectRhyme',
          passed: false,
          code: 'imperfect_rhyme',
          message: violations.map((f) =>
            `Imperfect rhyme on ${f.couplet}: '${f.words[0]}' / '${f.words[1]}' — ${f.reason}`,
          ).join(' '),
          detail: violations,
        });
      }
    }
  }

  // 3) Compute overall passed.
  for (const entry of perSpread) entry.passed = entry.failures.length === 0;
  const passed = perSpread.every((e) => e.passed);

  if (!passed) {
    const failingSpreads = perSpread.filter((e) => !e.passed)
      .map((e) => `${e.spread}:[${e.failures.map((f) => f.code || f.check).join(',')}]`).join(' ');
    ctx.log('warn', `[v2] manuscriptGate FAIL spreads=${failingSpreads}`);
  } else {
    ctx.log('info', `[v2] manuscriptGate PASS all=${perSpread.length}`);
  }

  return { passed, perSpread };
}

module.exports = { manuscriptGateActivity };
