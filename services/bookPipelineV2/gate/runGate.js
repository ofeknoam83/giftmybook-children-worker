/**
 * Deterministic gate runner.
 *
 * Runs every check against a draft + beat + ageProfile. Returns
 * `{ passed, failures }` with `failures` being an array of structured
 * results so the revision engine can address them surgically.
 *
 * Order matters: cheap, narrow checks first; broad checks last. Most
 * spreads either fail nothing or fail one thing; running everything is
 * cheap.
 */

const { identityRhymeCheck } = require('./checks/identityRhyme');
const { imperfectRhymeCheck } = require('./checks/imperfectRhyme');
const { fillerPhraseBlocklistCheck } = require('./checks/fillerPhraseBlocklist');
const { headlineNounRepeatCheck } = require('./checks/headlineNounRepeat');
const { moralisingPhrasesCheck } = require('./checks/moralisingPhrases');
const { protagonistAntiVerbCheck } = require('./checks/protagonistAntiVerb');
const { lineLengthWindowCheck } = require('./checks/lineLengthWindow');
const { lineCountCheck } = require('./checks/lineCount');
const { beatProhibitedCheck } = require('./checks/beatProhibited');
const { dialogueBanCheck } = require('./checks/dialogueBan');
const { pastTenseCheck } = require('./checks/pastTense');
const { lineStarterRepeatCheck } = require('./checks/lineStarterRepeat');

const CHECKS = [
  { name: 'lineCount',              fn: lineCountCheck },
  { name: 'identityRhyme',          fn: identityRhymeCheck },
  { name: 'imperfectRhyme',         fn: imperfectRhymeCheck },
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

/**
 * @param {object} draft        - SpreadDraft.json
 * @param {object} beat         - BeatSheet entry
 * @param {object} ageProfile   - AgeProfile.json
 * @param {object} ctx          - { protagonistName, ageLabel, ... }
 */
function runGate(draft, beat, ageProfile, ctx = {}) {
  const failures = [];
  for (const { name, fn } of CHECKS) {
    let r;
    try {
      r = fn(draft, beat, ageProfile, ctx);
    } catch (err) {
      r = { passed: false, code: `${name}_threw`, message: `Gate check '${name}' threw: ${err.message}` };
    }
    if (!r.passed) failures.push({ check: name, ...r });
  }
  return { passed: failures.length === 0, failures };
}

module.exports = { runGate, CHECKS };
