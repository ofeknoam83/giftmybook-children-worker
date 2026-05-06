/**
 * Stage 11 — Revision Engine
 *
 * Surgical fix-the-listed-failures pass on a SpreadDraft. Routes to the
 * WRITER role (same family as the original writer) but with a tighter
 * temperature and a different system prompt that prohibits introducing
 * new defects.
 *
 * The "failures" payload is uniform whether it came from the
 * deterministic gate (codes like `identityRhyme`, `imperfectRhyme`) or
 * the spread critic (suggested_fixes with line targets). Both shapes
 * pass through here unchanged so the revision LLM sees them as a
 * single list.
 */

const fs = require('fs');
const path = require('path');
const { callWithRole } = require('../../llm/modelRouter');

const SYSTEM = fs.readFileSync(
  path.join(__dirname, '../../llm/prompts/revisionEngine.system.md'),
  'utf8',
);

function normalizeFailures(failures) {
  if (!Array.isArray(failures)) return [];
  return failures.map((f) => ({
    code: f.code || f.check || 'unknown',
    message: f.message || f.note || '',
    line: f.line || null,
    detail: f.detail || null,
  }));
}

async function revisionEngineActivity(input, ctx) {
  const {
    draft, beat, ageProfile, characterBible, worldBible, recentSummaries = [],
    failures, mode,
  } = input;

  const userPrompt = JSON.stringify({
    instructions: 'Revise the SpreadDraft. Fix exactly the failures listed. Do not introduce new defects. Output a SpreadDraft in the same shape.',
    mode,
    draft,
    beat,
    ageProfileSummary: {
      band: ageProfile?.ageBand || ageProfile?.band,
      linesPerSpread: ageProfile?.narrativeConstraints?.linesPerSpread,
      syllablesPerLine: ageProfile?.narrativeConstraints?.syllablesPerLine,
      rhymeScheme: ageProfile?.narrativeConstraints?.rhymeScheme,
    },
    characterBible,
    worldBible: {
      style_rules: worldBible?.style_rules,
      cover_anchor_rules: worldBible?.cover_anchor_rules,
    },
    recentSummaries,
    failures: normalizeFailures(failures),
  });

  const resp = await callWithRole('WRITER', {
    systemPrompt: SYSTEM,
    userPrompt,
    jsonMode: true,
    temperature: 0.45,
    maxTokens: 1800,
    label: `v2.revision.${mode || 'unknown'}`,
  });

  const out = resp.json;
  if (!out || typeof out !== 'object') throw new Error('revisionEngine: empty/invalid JSON');
  out.spread = draft?.spread;
  out.lines = Array.isArray(out.lines) ? out.lines.map(String) : [];
  if (!out.text && out.lines.length) out.text = out.lines.join('\n');
  if (!out.lines.length && typeof out.text === 'string') {
    out.lines = out.text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  }
  out.version = '1.0';
  out.generated_at = new Date().toISOString();
  out.model = resp.model;
  out.revision_mode = mode || null;
  ctx.log('info', `[v2] revisionEngine spread=${out.spread} mode=${mode} fixed=${(failures || []).length} failure(s)`);
  return out;
}

module.exports = { revisionEngineActivity };
