/**
 * W6 — Manuscript Revision.
 *
 * Surgical rewrite of ONLY the flagged spreads (merged judge flags + gate
 * failures), one call. Returns the full manuscript with rewritten spreads
 * merged in and re-validated.
 */

const fs = require('fs');
const path = require('path');
const { callWithRole } = require('../../llm/modelRouter');
const { normalizeManuscript } = require('../../schema/document');

const SYSTEM = fs.readFileSync(
  path.join(__dirname, '../../llm/prompts/manuscriptRevision.system.md'),
  'utf8',
);

/**
 * Merge judge flagged_spreads + gate perSpread failures into one
 * targeted-revision list.
 *
 * @param {Array<{spread:number, dimension?:string, issue?:string, suggestion?:string, judge?:string}>} judgeFlags
 * @param {Array<{spread:number, passed:boolean, failures:Array}>} gatePerSpread
 */
function mergeTargets(judgeFlags = [], gatePerSpread = []) {
  const bySpread = new Map();
  const entry = (spread) => {
    if (!bySpread.has(spread)) bySpread.set(spread, { spread, notes: [] });
    return bySpread.get(spread);
  };
  for (const f of judgeFlags) {
    entry(f.spread).notes.push(`[judge ${f.judge || ''} / ${f.dimension || 'craft'}] ${f.issue}${f.suggestion ? ` — FIX: ${f.suggestion}` : ''}`);
  }
  for (const g of gatePerSpread) {
    if (g.passed) continue;
    for (const fail of g.failures || []) {
      entry(g.spread).notes.push(`[gate ${fail.code || fail.check}] ${fail.message}`);
    }
  }
  return Array.from(bySpread.values()).sort((a, b) => a.spread - b.spread);
}

/**
 * @param {{
 *   brief: object, ageProfile: object, manuscript: object,
 *   targets: Array<{spread:number, notes:string[]}>,
 * }} input
 */
async function manuscriptRevisionActivity(input, ctx) {
  const { brief, ageProfile, manuscript, targets } = input;
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('manuscriptRevision: no targets');
  }

  const userPrompt = JSON.stringify({
    brief: {
      gift_intent: brief?.gift_intent,
      child_as_character: brief?.child_as_character,
      constraints: brief?.constraints,
      child: brief?.child,
    },
    ageProfile: {
      band: ageProfile?.ageBand || ageProfile?.band,
      narrativeConstraints: ageProfile?.narrativeConstraints,
    },
    manuscript: {
      title: manuscript.title,
      form: manuscript.form,
      refrain: manuscript.refrain,
      spreads: manuscript.spreads.map((s) => ({
        spread: s.spread,
        lines: s.lines,
        refrain_here: s.refrain_here,
        scene_contract: s.scene_contract,
      })),
    },
    targeted_revisions: targets,
  });

  const resp = await callWithRole('WRITER', {
    systemPrompt: SYSTEM,
    userPrompt,
    jsonMode: true,
    maxTokens: 4000,
    label: 'v3.revision',
  });

  const out = resp.json;
  if (!out || !Array.isArray(out.spreads) || out.spreads.length === 0) {
    throw new Error('manuscriptRevision: expected { spreads: [...] } with rewritten spreads');
  }

  const targetSet = new Set(targets.map((t) => t.spread));
  const patches = new Map();
  for (const s of out.spreads) {
    if (typeof s.spread !== 'number' || !targetSet.has(s.spread)) continue; // ignore off-target rewrites
    patches.set(s.spread, s);
  }
  if (patches.size === 0) {
    throw new Error(`manuscriptRevision: none of the returned spreads matched targets [${Array.from(targetSet).join(',')}]`);
  }

  const mergedRaw = {
    title: manuscript.title,
    form: manuscript.form,
    refrain: manuscript.refrain,
    spreads: manuscript.spreads.map((s) => patches.get(s.spread) || s),
  };
  const revised = normalizeManuscript(mergedRaw, {
    id: manuscript.id,
    expectedSpreads: manuscript.spreads.length,
    model: resp.model,
  });
  revised.concept_id = manuscript.concept_id;
  revised._usage = resp.usage;

  ctx.log('info', `[v3] revision(${manuscript.id}): rewrote spreads [${Array.from(patches.keys()).sort((a, b) => a - b).join(',')}] of targets [${Array.from(targetSet).join(',')}]`);
  return revised;
}

module.exports = { manuscriptRevisionActivity, mergeTargets };
