/**
 * Beat `prohibited` enforcement.
 *
 * Each beat in the BeatSheet can declare per-spread prohibitions
 * ('do not name Mama in this spread', 'no line ending in "rest"').
 * This check enforces them as substring/regex matches. The richness
 * of what can be prohibited is intentionally permissive — beats are
 * authored by the LLM planner and the planner needs latitude to
 * declare things this generic gate can't anticipate.
 */

function beatProhibitedCheck(draft, beat) {
  const text = String(draft?.text || '');
  const lc = text.toLowerCase();
  const prohibited = Array.isArray(beat?.prohibited) ? beat.prohibited : [];
  const failures = [];

  for (const p of prohibited) {
    if (typeof p !== 'string') continue;
    const item = p.trim();
    if (!item) continue;
    // If wrapped in slashes, treat as regex; else as case-insensitive substring.
    const m = item.match(/^\/(.+)\/([a-z]*)$/);
    if (m) {
      try {
        const re = new RegExp(m[1], m[2] || 'i');
        if (re.test(text)) failures.push({ rule: item, kind: 'regex' });
      } catch { /* malformed regex — ignore */ }
    } else if (lc.includes(item.toLowerCase())) {
      failures.push({ rule: item, kind: 'substring' });
    }
  }

  if (!failures.length) return { passed: true };
  return {
    passed: false,
    code: 'beat_prohibited',
    message: failures.map((f) =>
      `Spread violates beat-level prohibition: ${f.rule}`
    ).join(' '),
    detail: failures,
  };
}

module.exports = { beatProhibitedCheck };
