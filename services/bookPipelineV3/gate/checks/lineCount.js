/**
 * Line-count check. Spreads must hit `linesPerSpread.target` exactly
 * (with `min`/`max` as a fallback tolerance for bands that allow
 * variation). Most picture-book bands lock to 4 lines.
 */

function lineCountCheck(draft, beat, ageProfile) {
  const text = String(draft?.text || '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cfg = ageProfile?.narrativeConstraints?.linesPerSpread;
  if (!cfg) return { passed: true };

  if (lines.length < cfg.min || lines.length > cfg.max) {
    return {
      passed: false,
      code: 'line_count',
      message: `Spread has ${lines.length} lines; band requires ${cfg.min}-${cfg.max} (target ${cfg.target}).`,
      detail: { observed: lines.length, target: cfg.target, min: cfg.min, max: cfg.max },
    };
  }
  return { passed: true };
}

module.exports = { lineCountCheck };
