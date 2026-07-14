/**
 * Shot budget (A1) — the "13 medium shots" problem is fixed structurally:
 * variety is PLANNED by the art director and then VALIDATED (and if
 * necessary repaired) deterministically in code. A model's promise of
 * variety is never trusted — the validator is the contract.
 *
 * Rules (plan §Phase 2):
 *   - ≥ MIN_DISTINCT_SHOTS distinct shot types across the book
 *   - no two ADJACENT spreads share a shot type
 */

const SHOT_TYPES = [
  'wide-establishing',
  'medium',
  'close-up',
  'birds-eye',
  'low-angle',
  'over-shoulder',
  'detail-insert',
];

const MIN_DISTINCT_SHOTS = 4;

/** Normalize a model-emitted shot label onto the enum (loose matching). */
function normalizeShot(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (SHOT_TYPES.includes(s)) return s;
  if (s.includes('establish') || s.includes('wide')) return 'wide-establishing';
  if (s.includes('bird') || s.includes('overhead') || s.includes('top')) return 'birds-eye';
  if (s.includes('low')) return 'low-angle';
  if (s.includes('shoulder') || s.includes('behind')) return 'over-shoulder';
  if (s.includes('close')) return 'close-up';
  if (s.includes('detail') || s.includes('insert') || s.includes('macro')) return 'detail-insert';
  if (s.includes('medium') || s.includes('mid')) return 'medium';
  return null;
}

/**
 * @param {Array<{spread: number, shot: string}>} rows - ordered by spread
 * @returns {{ ok: boolean, violations: string[] }}
 */
function validateShotBudget(rows) {
  const violations = [];
  const shots = rows.map((r) => normalizeShot(r.shot));

  shots.forEach((s, i) => {
    if (!s) violations.push(`spread ${rows[i].spread}: unknown shot '${rows[i].shot}'`);
  });
  const distinct = new Set(shots.filter(Boolean));
  if (distinct.size < MIN_DISTINCT_SHOTS) {
    violations.push(`only ${distinct.size} distinct shot types (need ≥${MIN_DISTINCT_SHOTS}): [${[...distinct].join(', ')}]`);
  }
  for (let i = 1; i < shots.length; i += 1) {
    if (shots[i] && shots[i] === shots[i - 1]) {
      violations.push(`spreads ${rows[i - 1].spread}+${rows[i].spread} share adjacent shot '${shots[i]}'`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Deterministic repair — the guaranteed fallback after the one re-ask.
 * Walks the book: normalizes unknown shots to 'medium', then fixes
 * adjacent repeats and variety by swapping in the least-used shot type
 * that differs from both neighbors. Pure and stable (same input → same
 * output).
 *
 * @param {Array<{spread: number, shot: string}>} rows
 * @returns {Array<{spread: number, shot: string, reassigned?: boolean}>}
 */
function reassignShots(rows) {
  const shots = rows.map((r) => normalizeShot(r.shot) || 'medium');
  const counts = () => shots.reduce((m, s) => { m[s] = (m[s] || 0) + 1; return m; }, {});

  const pickLeastUsed = (exclude) => {
    const c = counts();
    return SHOT_TYPES
      .filter((t) => !exclude.includes(t))
      .sort((a, b) => (c[a] || 0) - (c[b] || 0) || SHOT_TYPES.indexOf(a) - SHOT_TYPES.indexOf(b))[0];
  };

  const reassigned = new Set();

  // 1. adjacent repeats
  for (let i = 1; i < shots.length; i += 1) {
    if (shots[i] === shots[i - 1]) {
      const next = shots[i + 1] || null;
      shots[i] = pickLeastUsed([shots[i - 1], next].filter(Boolean));
      reassigned.add(i);
    }
  }
  // 2. variety floor — replace the most-used shot's later occurrences
  let guard = 0;
  while (new Set(shots).size < Math.min(MIN_DISTINCT_SHOTS, shots.length) && guard < 20) {
    guard += 1;
    const c = counts();
    const mostUsed = Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
    const i = shots.lastIndexOf(mostUsed);
    const prev = shots[i - 1] || null;
    const next = shots[i + 1] || null;
    shots[i] = pickLeastUsed([prev, next, mostUsed].filter(Boolean));
    reassigned.add(i);
  }

  return rows.map((r, i) => ({
    ...r,
    shot: shots[i],
    ...(reassigned.has(i) ? { reassigned: true } : {}),
  }));
}

module.exports = { SHOT_TYPES, MIN_DISTINCT_SHOTS, normalizeShot, validateShotBudget, reassignShots };
