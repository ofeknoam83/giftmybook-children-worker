/**
 * Shot plan — a deterministic per-spread COMPOSITION spec, pinned like every
 * other cross-spread invariant in this illustrator.
 *
 * Why: a stateless render can only be held to FIXED inputs. Consistency
 * already works that way (world card, world plate, outfit lock, TEXT_RULES);
 * VARIETY had nothing — no composition direction at all, plus an
 * aspirational "be visibly distinct from every other spread" line that a
 * render which never sees the other spreads cannot obey. The result is the
 * model's one favorite template twelve times over. This module replaces the
 * aspiration with an assignment: each spread gets a concrete shot type,
 * staging, and placement, rotated deterministically from CLOSED vocabularies
 * (no free text, no LLM, no per-book creative pass — the deleted art
 * director stays deleted).
 *
 * Determinism: the plan is a pure function of the story fingerprint (the
 * same identity the render cache keys on) — every retry, repair, world-gate
 * re-render, and probe of the same story sees the same plan; different
 * stories rotate to different plans.
 *
 * Kill-switch: CATALOG_SHOT_PLAN=0 (applied by the caller — this module is
 * pure). Disabling changes scene prompts, so the caller folds `-sp0` into
 * the render cache key (the prop-continuity pattern).
 */

const { fnv1a } = require('../selection');

/** Closed shot-type vocabulary — must stay in lockstep with the renderer's
 * `opts.shotType` enforcement block (illustrationGenerator.js). */
const SHOT_TYPES = ['wide', 'medium', 'close-up', 'overhead', 'low-angle'];

/** Band 1-3 menu: board-book compositions stay simple (the renderer's
 * BOARD BOOK rule for age ≤2 additionally outranks the plan). */
const SHOT_TYPES_YOUNG = ['wide', 'medium', 'close-up'];

/**
 * One-line QA descriptions per shot type — what a checker should expect the
 * render to read as. Kept beside the vocabulary so the prompt-side
 * enforcement (illustrationGenerator) and the QA-side verification
 * (spreadQa) never drift apart.
 */
const SHOT_TYPE_QA_DESCRIPTIONS = {
  wide: 'a WIDE shot: the full scene, the child visible head-to-toe and relatively small in the environment',
  medium: 'a MEDIUM shot: the child from approximately the waist up, engaged in the action',
  'close-up': 'a CLOSE-UP: the child\'s face, hands, or the key detail fills most of the frame',
  overhead: 'an OVERHEAD / bird\'s-eye view: the scene viewed from above, looking down',
  'low-angle': 'a LOW-ANGLE shot: the camera low to the ground looking slightly up at the child, the environment towering around them',
};

/** Closed staging vocabulary, per shot type — framings compatible with ANY
 * beat action. Every entry describes CAMERA position, subject ORIENTATION,
 * or FRAMING only — never motion, posture, or interaction: the beat's
 * ACTION line owns what the child is doing, and a staging that prescribed
 * movement (e.g. "walking mid-stride") would contradict a stationary beat
 * and alter the frozen plot. */
const STAGING_BY_SHOT = {
  wide: [
    'small within the vast environment, the scenery dominating the frame',
    // ce-10: the pre-ce-10 'seen from behind' staging hid the face entirely —
    // an identity the QA cannot verify and an emotion the reader cannot read.
    // Every staging keeps at least the profile of the face in view.
    'seen from a three-quarter back angle, the camera looking past them into the scene, head turned so the profile of their face stays visible',
    'placed off-center against sweeping depth — foreground, middle ground, and distant background all visible',
    'framed through natural foreground scenery (foliage, rocks, an opening) with depth between camera and child',
  ],
  medium: [
    'seen in profile, the point of interest beside them in frame',
    'seen from the front, the camera facing them',
    'seen from a three-quarter back angle, the point of interest beyond them, head turned so their face stays visible',
    'seen from a slight side angle, the point of interest in the near foreground',
  ],
  'close-up': [
    'face and hands filling the frame, the point of interest in view',
    'the key object of the action large in the foreground, the child\'s expressive face just behind it',
    'tight on the child\'s expression, the background softly out of focus',
  ],
  overhead: [
    'seen from directly above, the child and the point of interest forming a clear graphic pattern on the ground',
  ],
  'low-angle': [
    'the camera at ground level looking up, the towering environment rising behind them',
    'the camera low beside the focal point of the action on the ground, the child framed above and beyond it',
  ],
};

/**
 * Deterministic sub-seed for one spread of one story.
 * @param {number} seed base seed
 * @param {number} spread
 * @returns {number}
 */
function spreadSeed(seed, spread) {
  return fnv1a(`${seed}|${spread}`);
}

/**
 * Build the deterministic shot plan for a whole story (always ALL of its
 * spreads — a probe subset must see the same assignments as the full book,
 * so the plan is never subset-relative).
 *
 * Invariants (unit-tested):
 *  - the first and last spread are `wide` (arrival / farewell bookends —
 *    every catalog book opens and closes on them);
 *  - no shot type repeats on adjacent spreads;
 *  - every menu type appears at least once across a 12-spread book;
 *  - placement strictly alternates thirds (never the same third twice
 *    running); `half` layout carries NO placement (the half-layout
 *    composition hint owns placement and must keep winning);
 *  - `embedded` layout pins the text side OPPOSITE the child's third.
 *
 * @param {object} params
 * @param {string} params.seedBasis the story fingerprint (renderStorySpreads'
 *   baseHash) — NOT the folded cache key: an anchor/plate/outfit change must
 *   not reshuffle the book's cinematography
 * @param {number[]} params.spreads ordered spread numbers (the book's beats)
 * @param {string} [params.ageBand] catalog band key ('1-3' restricts the menu)
 * @param {string} [params.textLayout] 'caption' | 'half' | 'embedded'
 * @returns {Object<number, {shotType: string, staging: string, placement: string|null, textSide: string|null}>}
 */
function buildShotPlan({ seedBasis, spreads, ageBand, textLayout = 'caption' }) {
  const ordered = [...spreads].sort((a, b) => a - b);
  if (ordered.length === 0) return {};
  const menu = ageBand === '1-3' ? SHOT_TYPES_YOUNG : SHOT_TYPES;
  const seed = fnv1a(String(seedBasis));

  // Shot types: fixed wide bookends; inner slots cycle the menu with a
  // seed-picked coprime step (consecutive picks always differ), then one
  // deterministic fix-up pass repairs the two boundary adjacencies.
  const len = menu.length;
  const steps = len === 5 ? [1, 2, 3, 4] : [1, 2];
  const step = steps[seed % steps.length];
  const offset = (seed >>> 3) % len;
  const shots = ordered.map((spread, i) => {
    if (i === 0 || i === ordered.length - 1) return 'wide';
    return menu[(offset + step * i) % len];
  });
  // Fix-up pass: only INNER slots ever mutate (the bookends are fixed).
  // Coprime cycling keeps consecutive inner picks distinct, so the only
  // possible violations are against the two fixed `wide` bookends; a
  // repaired slot is chosen to differ from BOTH its neighbors, so the pass
  // never introduces a new adjacency.
  for (let i = 1; i < shots.length - 1; i += 1) {
    if (shots[i] !== shots[i - 1] && shots[i] !== shots[i + 1]) continue;
    // First menu value differing from both neighbors — menu length ≥3
    // guarantees one exists; scanning from a seeded start keeps variety.
    for (let k = 0; k < len; k += 1) {
      const candidate = menu[(offset + i + k) % len];
      if (candidate !== shots[i - 1] && candidate !== shots[i + 1]) {
        shots[i] = candidate;
        break;
      }
    }
  }

  // Placement: strict left/right alternation (phase seeded per story). The
  // half layout emits none — its print constraint owns where the child goes.
  const phase = (seed >>> 7) % 2;
  const plan = {};
  ordered.forEach((spread, i) => {
    const shotType = shots[i];
    const stagings = STAGING_BY_SHOT[shotType];
    const staging = stagings[spreadSeed(seed, spread) % stagings.length];
    const placement = textLayout === 'half'
      ? null
      : ((i + phase) % 2 === 0 ? 'left-third' : 'right-third');
    const textSide = textLayout === 'embedded' && placement
      ? (placement === 'left-third' ? 'right' : 'left')
      : null;
    plan[spread] = { shotType, staging, placement, textSide };
  });
  return plan;
}

/**
 * Render one spread's assigned composition as the fixed prompt block. Every
 * line is template text over the closed vocabularies — nothing free-form
 * ever enters here. Appended to the scene BEFORE the half-layout hint, any
 * world-gate repair note, and the Art Tuning block, so all of those still
 * outrank it; also folded into safeFallbackSuffix by the caller so the
 * generic-safe NSFW fallback does not render off-plan.
 * @param {{shotType: string, staging: string, placement: string|null, textSide: string|null}|null} entry
 * @returns {string} '' when there is no entry (plan disabled or unknown spread)
 */
function renderShotDirective(entry) {
  if (!entry) return '';
  const lines = [
    'COMPOSITION (ASSIGNED FOR THIS SPREAD — each spread of this book is assigned a DIFFERENT '
      + 'composition; obey this one exactly):',
    `- SHOT TYPE: ${entry.shotType.toUpperCase()} — the image must read as ${SHOT_TYPE_QA_DESCRIPTIONS[entry.shotType]}.`,
    `- STAGING: the child is ${entry.staging} — performing exactly the ACTION described above.`,
    // ce-10: fixed on every assignment — a picture-book reader (and the
    // identity/emotion QA) needs the face; a staging must never be executed
    // as a full back view.
    '- FACE: the child\'s face stays clearly visible (front, three-quarter, or profile view) — never render the child fully from behind with the face hidden.',
  ];
  if (entry.placement) {
    lines.push(`- PLACEMENT: position the child in the ${entry.placement === 'left-third' ? 'LEFT' : 'RIGHT'} third of the frame.`);
  }
  if (entry.textSide) {
    lines.push(`- TEXT SIDE: paint the story text block on the ${entry.textSide.toUpperCase()} side of the image (the side away from the child).`);
  }
  return lines.join('\n');
}

module.exports = {
  buildShotPlan,
  renderShotDirective,
  SHOT_TYPES,
  SHOT_TYPES_YOUNG,
  SHOT_TYPE_QA_DESCRIPTIONS,
  STAGING_BY_SHOT,
};
