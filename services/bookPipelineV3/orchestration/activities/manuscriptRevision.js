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

/** Stable fingerprint of the contract fields the art director stages from. */
function contractFingerprint(sceneContract) {
  const sc = sceneContract || {};
  return [sc.setting, sc.hero_action, ...(Array.isArray(sc.key_objects) ? sc.key_objects : [])]
    .map((v) => String(v ?? '').trim().toLowerCase())
    .join('|');
}

/**
 * @param {{
 *   brief: object, ageProfile: object, manuscript: object,
 *   targets: Array<{spread:number, notes:string[], requireContractChange?:boolean}>,
 * }} input
 */
async function manuscriptRevisionActivity(input, ctx) {
  const { brief, ageProfile, manuscript, targets } = input;
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('manuscriptRevision: no targets');
  }

  const buildUserPrompt = (revisionTargets) => JSON.stringify({
    brief: {
      gift_intent: brief?.gift_intent,
      child_as_character: brief?.child_as_character,
      constraints: brief?.constraints,
      child: brief?.child,
      interests: brief?.interests || [],
      story_world: brief?.story_world || null,
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
    targeted_revisions: revisionTargets,
  });

  const targetSet = new Set(targets.map((t) => t.spread));
  const collectPatches = (out) => {
    const patches = new Map();
    for (const s of out.spreads) {
      if (typeof s.spread !== 'number' || !targetSet.has(s.spread)) continue; // ignore off-target rewrites
      patches.set(s.spread, s);
    }
    return patches;
  };

  const resp = await callWithRole('WRITER', {
    systemPrompt: SYSTEM,
    userPrompt: buildUserPrompt(targets),
    jsonMode: true,
    maxTokens: 4000,
    label: 'v3.revision',
  });

  const out = resp.json;
  if (!out || !Array.isArray(out.spreads) || out.spreads.length === 0) {
    throw new Error('manuscriptRevision: expected { spreads: [...] } with rewritten spreads');
  }

  const patches = collectPatches(out);
  if (patches.size === 0) {
    throw new Error(`manuscriptRevision: none of the returned spreads matched targets [${Array.from(targetSet).join(',')}]`);
  }

  // Scene-level targets (art-director bounces set requireContractChange)
  // are only fixed when the CONTRACT changed — the art director stages from
  // scene_contract, never the prose, so a lines-only rewrite loops forever.
  // One harder re-ask for stale contracts; if still stale, continue loudly
  // (the next art-direction pass produces an actionable needs_review).
  const originalBySpread = new Map(manuscript.spreads.map((s) => [s.spread, s]));
  const staleContract = (t) => {
    if (!t.requireContractChange) return false;
    const patch = patches.get(t.spread);
    if (!patch) return false;
    return contractFingerprint(patch.scene_contract) === contractFingerprint(originalBySpread.get(t.spread)?.scene_contract);
  };
  let stale = targets.filter(staleContract);
  if (stale.length > 0) {
    ctx.log('warn', `[v3] revision returned an UNCHANGED scene_contract for spread(s) [${stale.map((t) => t.spread).join(',')}] — one harder re-ask (the illustrator stages from the contract)`);
    const reaskTargets = stale.map((t) => ({
      ...t,
      notes: [
        ...(t.notes || []),
        'YOUR PREVIOUS REVISION FAILED: it changed the lines but returned the scene_contract UNCHANGED. The illustrator stages from the contract. Rewrite so scene_contract.setting / hero_action / key_objects no longer describe the flagged problem.',
      ],
    }));
    const reask = await callWithRole('WRITER', {
      systemPrompt: SYSTEM,
      userPrompt: buildUserPrompt(reaskTargets),
      jsonMode: true,
      maxTokens: 4000,
      label: 'v3.revision.contractfix',
    });
    if (reask.json && Array.isArray(reask.json.spreads)) {
      for (const [spread, patch] of collectPatches(reask.json)) patches.set(spread, patch);
    }
    stale = targets.filter(staleContract);
    if (stale.length > 0) {
      ctx.log('warn', `[v3] scene_contract STILL unchanged for spread(s) [${stale.map((t) => t.spread).join(',')}] after re-ask — continuing; the art director will re-evaluate`);
    }
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
