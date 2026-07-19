/**
 * Book pass (A4) — ONE contact-sheet review of the selected winners:
 * did the planned shot variety actually land, outfit/prop continuity,
 * cover-to-interior consistency, and does the ending land visually.
 *
 * Flags trigger at most BOOK_PASS_REGEN_WAVES targeted regen waves for
 * the named spreads (handled by the caller); residual flags become a
 * needs_review item. Never a hard-fail loop.
 */

const { callVisionRole } = require('../../llm/visionClient');
const { buildNeedsReviewPayload } = require('../../reviewQueue/payload');

function buildContactSheetPrompt({ manuscript, direction, hasPropPlate = false }) {
  return `You are reviewing the COMPLETE set of interior illustrations for the picture book "${manuscript.title}" — one image per spread, in reading order (image 1 = spread 1). ${hasPropPlate
    ? 'The LAST TWO images are references: first the parent-approved COVER, then the PROP PLATE showing the locked design of each recurring prop.'
    : 'The FINAL image is the parent-approved COVER for comparison.'}

Check the BOOK AS A WHOLE (individual image quality was already judged):
1. VARIETY: do compositions/camera angles actually vary across the book (planned: ${[...new Set([...direction.directionBySpread.values()].map((d) => d.shot))].join(', ')})?
2. CONTINUITY: same outfit as the cover everywhere; recurring props consistent (${direction.continuityLocks?.props?.map((p) => p.design ? `${p.name}: ${p.design}` : p.name).join('; ') || 'none listed'})${direction.continuityLocks?.gear?.length ? `; gear state follows its rule on every spread (${direction.continuityLocks.gear.map((g) => `${g.item}: ${g.rule}`).join('; ')}) — flag spreads that break it (advisory)` : ''}.
3. COVER MATCH: interior character reads as the same child, same rendering style, as the cover.
4. CHARACTER DRIFT: the child keeps the SAME apparent age and build on every spread (flag any spread where the child reads clearly younger/chubbier or older/slimmer than the cover), and the SAME facial marks (flag stray moles, beauty marks, or dark facial spots that are not on the cover).
5. ENDING: the final spread lands visually (warmth/resolution, not an arbitrary stop).

THE PARENT TEST — a flag is "critical" ONLY if a parent flipping through the printed book would consider the page BROKEN or WRONG. The complete list of critical classes at book level:
1. the character reads as a DIFFERENT child than the cover (or the wrong apparent age/build)
2. the outfit contradicts the cover
3. readable words or lettering painted in the artwork
4. the child duplicated or a stranger present
5. countably wrong anatomy
6. a jarring style break
7. a RECURRING story prop rendered as a fundamentally DIFFERENT OBJECT on different spreads (e.g. the hero's "lamp" appearing as a bare crystal on one spread, a pendant on another, and a lantern on a third — a child following the story will notice). STRICT SCOPE: applies ONLY to the recurring props listed in CONTINUITY above, ONLY when the object's IDENTITY changes (a different kind of object — not angle, size, level of detail, partial visibility, or color/shade drift, which are ALL minor), and the flag's issue text MUST name the prop. A prop simply absent from a spread is NEVER this class.
EVERYTHING ELSE IS "minor" — including prop-DETAIL continuity (a differently-drawn map, a changed scroll count), composition, lighting, and variety observations. Minor flags are recorded and shipped as advisories — never mark them critical.

Return STRICT JSON:
{
  "pass": true|false,
  "flags": [ { "spread": n, "issue": "specific, actionable — e.g. 'outfit color differs from cover', 'spread 12 breaks style'", "severity": "critical|minor" } ],
  "notes": "one-line overall verdict"
}
Only flag spreads with something genuinely observable — style nitpicks that a parent would never notice do not count.`;
}

/**
 * Deterministic guard for the prop-identity critical class (2026-07-19,
 * book 37907cf4: the class shipped and the very next book needs_review'd
 * with flags the regen wave could not converge). A critical prop flag is
 * only actionable when it NAMES one of the locked recurring props — the
 * regen template needs the prop name to state its locked design. A
 * prop-ish critical flag naming no locked prop downgrades to minor
 * (advisory; fixable post-hoc) instead of blocking the book. Flags in
 * other classes (style break, lettering, wrong child…) pass through
 * untouched. Pure — exported for tests.
 *
 * @param {Array<{spread: number, issue: string, severity: string}>} flags
 * @param {{props?: Array<{name: string}>}|null} continuityLocks
 * @returns {{ flags: Array, downgraded: Array }}
 */
function boundPropFlags(flags, continuityLocks) {
  const lockedNames = (continuityLocks?.props || [])
    .map((p) => String(p.name || '').toLowerCase())
    .filter(Boolean);
  const downgraded = [];
  const out = flags.map((f) => {
    if (f.severity !== 'critical') return f;
    const issue = f.issue.toLowerCase();
    const propish = /\bprops?\b|different object|rendered as|inconsistent object|changed into/.test(issue);
    if (!propish) return f;
    if (lockedNames.some((n) => issue.includes(n))) return f;
    downgraded.push(f);
    return { ...f, severity: 'minor' };
  });
  return { flags: out, downgraded };
}

/**
 * @param {object} opts
 * @param {object} opts.manuscript
 * @param {object} opts.direction - runArtDirection result
 * @param {Array<{spread: number, base64: string, mimeType?: string}>} opts.winners - in reading order
 * @param {{base64: string, mimeType?: string}|null} [opts.cover]
 * @param {{base64: string, mimeType?: string, props?: string[]}|null} [opts.propPlate] -
 *   the locked-design prop plate; attached after the cover so the reviewer
 *   judges props against their GROUND TRUTH instead of spread-vs-spread
 * @param {AbortSignal} [opts.abortSignal]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ pass: boolean, flags: Array<{spread: number, issue: string, severity: string}>,
 *   criticalFlags: Array<{spread: number, issue: string}>, minorFlags: Array<{spread: number, issue: string}>, notes: string }>}
 *   `pass` is computed from CRITICAL flags only (closed-gate architecture,
 *   2026-07-16) — minor flags ship as advisories, they never block or regen.
 */
async function runBookPass({ manuscript, direction, winners, cover = null, propPlate = null, abortSignal, log = () => {} }) {
  const images = winners.map((w) => ({ base64: w.base64, mimeType: w.mimeType || 'image/png' }));
  const hasPropPlate = Boolean(cover && propPlate); // plate rides only beside the cover — the prompt's image indexing depends on it
  if (cover) images.push({ base64: cover.base64, mimeType: cover.mimeType || 'image/jpeg' });
  if (hasPropPlate) images.push({ base64: propPlate.base64, mimeType: propPlate.mimeType || 'image/png' });

  const { json } = await callVisionRole('ART_DIRECTOR', {
    prompt: buildContactSheetPrompt({ manuscript, direction, hasPropPlate }),
    images,
    label: 'v3.bookpass',
    expectJson: true,
    abortSignal,
  });

  const rawFlags = Array.isArray(json.flags)
    ? json.flags
      .map((f) => ({
        spread: Number(f.spread),
        issue: String(f.issue || 'flagged'),
        // Tolerate a missing severity (legacy shape) as minor — the spread-level
        // gates already hard-block every critical class per candidate.
        severity: f.severity === 'critical' ? 'critical' : 'minor',
      }))
      .filter((f) => Number.isFinite(f.spread))
    : [];
  const { flags, downgraded } = boundPropFlags(rawFlags, direction?.continuityLocks);
  if (downgraded.length) {
    log(`book pass: ${downgraded.length} prop flag(s) downgraded to minor (no locked prop named): ${downgraded.map((f) => `${f.spread}: ${f.issue}`).join('; ')}`);
  }
  const criticalFlags = flags.filter((f) => f.severity === 'critical');
  const minorFlags = flags.filter((f) => f.severity === 'minor');

  return {
    pass: criticalFlags.length === 0,
    flags,
    criticalFlags,
    minorFlags,
    notes: json.notes || '',
  };
}

/**
 * @param {Array<{spread: number, issue: string}>} residualFlags
 * @param {string[]} candidateUrls
 * @returns {object} needs_review payload
 */
function buildBookPassNeedsReview(residualFlags, candidateUrls = []) {
  return buildNeedsReviewPayload({
    stage: 'bookPass',
    reason: 'book_pass_exhausted',
    spread: residualFlags[0]?.spread ?? null,
    defects: residualFlags.map((f) => `spread ${f.spread}: ${f.issue}`),
    candidateUrls,
  });
}

module.exports = { runBookPass, buildContactSheetPrompt, buildBookPassNeedsReview, boundPropFlags };
