/**
 * PR Z — Anchor Allocation.
 *
 * "Anchors as the spine of the book."
 *
 * The post-PR-Y manuscript shipped 13 interchangeable couplets with anchor
 * tokens sprinkled in. The writer treated emotional anchors (questionnaire
 * answers like "bites mama on the chin", "first time she squealed in the
 * bath", "we call her smushy") as a checklist below the fold rather than
 * the narrative subject of the book.
 *
 * This module promotes the anchors to a structural role:
 *
 *   - It deterministically assigns each signature beat to a specific spread
 *     (opening / peak / closing / etc.) so the LLM can no longer satisfice
 *     by mentioning all anchors on spread 13.
 *
 *   - It extracts the LOAD-BEARING content tokens of each beat (concrete
 *     nouns and verbs) so the writer is told "use 'bites' not 'nibbles'"
 *     and "use 'smushy' verbatim" — closing the dilution gap PR Y left
 *     open (the per-anchor gate happily passed `nibbles` for `bites`,
 *     and `squeals` for the whole `smushy`/`squeals` `anything_else` beat).
 *
 *   - It emits compression guidance: when the anchor count is low, fewer
 *     richer spreads are better than 13 padded couplets. The result rides
 *     downstream as `compressionMode` on the per-spread spec so the writer
 *     reads it directly.
 *
 * The module is framework-free (no LLM, no I/O) and pure: same input →
 * same output. Cheap to unit-test, cheap to call inside the planner.
 */

const {
  extractSignatureBeats,
  signalTokens,
  SIGNATURE_TEXT_KEYS,
} = require('../qa/signatureBeats');

const { TOTAL_SPREADS } = require('../constants');

/**
 * Spread-role allocation map for a 13-spread infant/toddler book.
 *
 * Roles describe WHERE in the book a beat best lives:
 *   - opening      : the very first spread (sets the world)
 *   - establishing : early establishing beats (sp 2-3)
 *   - peak1        : first emotional peak (sp 4-5)
 *   - heart        : the warm-bond core (sp 6-8)
 *   - peak2        : second peak / climax (sp 9-11)
 *   - closing      : the final beat the parent and baby share (sp 12-13)
 *
 * Numbers are inclusive ranges over spread numbers.
 */
const SPREAD_ROLES = Object.freeze({
  opening:      { start: 1,  end: 1  },
  establishing: { start: 2,  end: 3  },
  peak1:        { start: 4,  end: 5  },
  heart:        { start: 6,  end: 8  },
  peak2:        { start: 9,  end: 11 },
  closing:      { start: 12, end: 13 },
});

/**
 * Default questionnaire-key → role mapping.
 *
 * The intent is that the SHAPE of the book follows the questionnaire:
 *
 *   - meaningful_moment      → opening      (this is what the book is about)
 *   - moms_favorite_moment   → heart        (the warm bond core)
 *   - dads_favorite_moment   → heart        (same — co-parent moment)
 *   - funny_thing            → peak1 / peak2 (laughter beats)
 *   - anything_else          → closing      (often a nickname / loving capstone)
 *   - calls_mom / calls_dad  → distributed  (every spread that names a parent)
 *
 * If a beat is missing the slot is left open and the LLM has freedom there.
 */
const DEFAULT_BEAT_ROLE_MAP = Object.freeze({
  meaningful_moment:    'opening',
  moms_favorite_moment: 'heart',
  dads_favorite_moment: 'heart',
  funny_thing:          'peak2',
  anything_else:        'closing',
});

/**
 * Pull a small set of LOAD-BEARING tokens from a beat — the words the writer
 * MUST keep verbatim if the anchor is to land. We use signalTokens (already
 * stopword-filtered) and additionally drop very short tokens, common filler,
 * and the parent's address-words (those are tracked separately).
 *
 * The output is a stable, order-preserving array (deterministic) so prompt
 * snapshots and tests stay sharp.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractLoadBearingTokens(text) {
  const raw = String(text || '');
  if (!raw.trim()) return [];

  // Re-tokenize preserving original order (signalTokens returns a Set which
  // discards order). We mirror its filtering rules.
  const tokens = raw.toLowerCase().match(/[a-z']+/g) || [];
  const stop = signalTokens(''); // stopword set surface — empty Set, keep API stable

  // Reuse the source-of-truth stopword list by tokenizing a known corpus
  // and inverting: any token that signalTokens filters out is a stopword
  // for our purposes. Cheaper and DRYer than copying STOPWORDS here.
  const acceptable = signalTokens(raw);

  // Additionally drop the parent address words — they're tracked as their
  // own (calls_mom / calls_dad) signature beats and shouldn't double-count
  // as load-bearing nouns of OTHER beats.
  const addressWords = new Set(['mama', 'mommy', 'mom', 'mum', 'mother', 'ima',
                                'dada', 'daddy', 'dad', 'father', 'abba',
                                'papa', 'pop', 'pops']);

  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    if (!acceptable.has(t)) continue;
    if (addressWords.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    // Cap at ~6 load-bearing tokens per beat so the prompt doesn't bloat.
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * For each beat, choose its ASSIGNED spread number using the role map.
 *
 * If the role's range has multiple slots, pick the middle slot deterministically
 * (so allocation is stable across reruns of the same brief).
 *
 * Ties between beats wanting the same role are broken by SIGNATURE_TEXT_KEYS
 * priority order (which is the order extractSignatureBeats returns).
 *
 * @param {Array<{key:string,kind:string,text:string}>} beats
 * @param {object} [opts]
 * @param {number} [opts.totalSpreads=TOTAL_SPREADS]
 * @param {Record<string,string>} [opts.beatRoleMap]
 * @returns {Array<{
 *   key:string,
 *   role:string,
 *   spreadNumber:number,
 *   text:string,
 *   loadBearingTokens:string[],
 *   isAddress:boolean,
 * }>}
 */
function allocateBeatsToSpreads(beats, opts = {}) {
  const totalSpreads = opts.totalSpreads || TOTAL_SPREADS;
  const beatRoleMap = opts.beatRoleMap || DEFAULT_BEAT_ROLE_MAP;

  // Roles only apply to TEXT beats. Address beats (calls_mom/calls_dad) are
  // distributed across every spread that names a parent — handled separately
  // by the spread-spec userPrompt block.
  const textBeats = (beats || []).filter(b => b.kind === 'text');
  const addressBeats = (beats || []).filter(b => b.kind === 'address');

  // Sort text beats by SIGNATURE_TEXT_KEYS priority (deterministic order).
  const priority = new Map(SIGNATURE_TEXT_KEYS.map((k, i) => [k, i]));
  const sorted = [...textBeats].sort((a, b) => {
    const pa = priority.has(a.key) ? priority.get(a.key) : 999;
    const pb = priority.has(b.key) ? priority.get(b.key) : 999;
    return pa - pb;
  });

  const usedSpreads = new Set();
  const allocations = [];

  // First pass: try the preferred role for each beat.
  for (const beat of sorted) {
    const role = beatRoleMap[beat.key] || 'heart';
    const range = SPREAD_ROLES[role] || SPREAD_ROLES.heart;
    const spreadNumber = pickSlotInRange(range, usedSpreads, totalSpreads);
    if (spreadNumber == null) {
      allocations.push({ beat, role, spreadNumber: null });
      continue;
    }
    usedSpreads.add(spreadNumber);
    allocations.push({ beat, role, spreadNumber });
  }

  // Second pass: any beat that didn't land in its preferred role gets the
  // next free slot anywhere in the book (so we never silently drop a beat).
  for (const a of allocations) {
    if (a.spreadNumber != null) continue;
    for (let n = 1; n <= totalSpreads; n++) {
      if (!usedSpreads.has(n)) {
        a.spreadNumber = n;
        usedSpreads.add(n);
        break;
      }
    }
  }

  // Build the output rows.
  const out = allocations
    .filter(a => a.spreadNumber != null)
    .map(a => ({
      key: a.beat.key,
      role: a.role,
      spreadNumber: a.spreadNumber,
      text: a.beat.text,
      loadBearingTokens: extractLoadBearingTokens(a.beat.text),
      isAddress: false,
    }));

  // Address beats: not pinned to a slot, but we surface them to the prompt
  // as "use this word every time you name the parent on any spread".
  for (const ab of addressBeats) {
    out.push({
      key: ab.key,
      role: 'distributed',
      spreadNumber: null,
      text: ab.text,
      loadBearingTokens: Array.from(ab.keywords),
      isAddress: true,
    });
  }

  return out;
}

/**
 * Pick a deterministic slot inside a role range, skipping already-used
 * spread numbers. Returns null if every slot in the range is taken.
 */
function pickSlotInRange(range, usedSpreads, totalSpreads) {
  const start = Math.max(1, range.start);
  const end = Math.min(totalSpreads, range.end);
  // Prefer the middle slot first, then walk outward.
  const mid = Math.floor((start + end) / 2);
  const order = [mid];
  for (let off = 1; off <= end - start; off++) {
    if (mid - off >= start) order.push(mid - off);
    if (mid + off <= end) order.push(mid + off);
  }
  for (const n of order) {
    if (!usedSpreads.has(n)) return n;
  }
  return null;
}

/**
 * Compute compression guidance from the beat count.
 *
 * The product question PR Z answers: when there are very few signature
 * beats (e.g. 2 anecdotes for a 13-spread book), should the writer pad to
 * 13 or compress?
 *
 *   - heavy (≥4 strong text beats)  → "anchors-as-spine" mode, no compression
 *   - light (2-3 text beats)        → compress to richer beats; let some
 *                                     spreads be quiet sensory bridges
 *   - sparse (<2 text beats)        → fall back to bible-driven imagery
 *
 * @param {Array<{kind:string}>} beats
 * @returns {{ mode:'heavy'|'light'|'sparse', textBeatCount:number, message:string }}
 */
function compressionGuidance(beats) {
  const textBeatCount = (beats || []).filter(b => b.kind === 'text').length;
  if (textBeatCount >= 4) {
    return {
      mode: 'heavy',
      textBeatCount,
      message: 'ANCHOR DENSITY: rich. Build the book around the questionnaire moments — every spread should pull from the snapshot or extend a signature beat. Do NOT pad with stock board-book imagery.',
    };
  }
  if (textBeatCount >= 2) {
    return {
      mode: 'light',
      textBeatCount,
      message: 'ANCHOR DENSITY: moderate. Let the signature beats anchor the strongest spreads (opening, peak, closing) and let the in-between spreads BREATHE — quiet sensory bridges that grow OUT of the anchor moments. Do NOT manufacture extra plot to fill all 13 spreads.',
    };
  }
  return {
    mode: 'sparse',
    textBeatCount,
    message: 'ANCHOR DENSITY: sparse. Without strong questionnaire moments, fall back to the storyBible imagery and the PERSONALIZATION SNAPSHOT details. Quality over quantity — better to have 13 quiet, consistent sensory beats than 13 manufactured ones.',
  };
}

/**
 * Top-level entry point.
 *
 * Build the book-level anchor allocation from a brief. Returns:
 *   - beats: the raw signature beats (for diagnostics)
 *   - allocations: per-beat assignment (spread number, role, load-bearing tokens)
 *   - compression: { mode, message } for the writer / spec prompt
 *   - perSpread: Map<number, { mustUseDetails: string[], anchorRole: string|null }>
 *                — the deterministic chunk the spread-specs planner folds
 *                into each spec's mustUseDetails.
 *
 * @param {{ child?: object, customDetails?: object }} brief
 * @param {object} [opts]
 * @returns {{
 *   beats:Array,
 *   allocations:Array,
 *   compression:{ mode:string, textBeatCount:number, message:string },
 *   perSpread:Map<number,{ mustUseDetails:string[], anchorRole:string|null, verbatimTokens:string[] }>,
 * }}
 */
function buildAnchorAllocation(brief, opts = {}) {
  const totalSpreads = opts.totalSpreads || TOTAL_SPREADS;
  const beats = extractSignatureBeats(brief);
  const allocations = allocateBeatsToSpreads(beats, { totalSpreads });
  const compression = compressionGuidance(beats);

  // Build per-spread payload deterministically.
  const perSpread = new Map();
  for (let n = 1; n <= totalSpreads; n++) {
    perSpread.set(n, { mustUseDetails: [], anchorRole: null, verbatimTokens: [] });
  }

  for (const a of allocations) {
    if (a.isAddress) continue; // address beats handled below
    const slot = perSpread.get(a.spreadNumber);
    if (!slot) continue;
    // mustUseDetails entries are READABLE strings the writer / illustrator
    // see directly. We bake the questionnaire key, the original answer, and
    // editor-style transformation guidance into one string so it's immediately
    // actionable. We do NOT instruct the LLM to copy load-bearing tokens
    // verbatim — that produced literal-copy regressions (e.g. shipping
    // the questionnaire answer as the line itself). Instead the LLM is
    // asked to TRANSFORM the moment into the story's voice while preserving
    // its emotional truth and concrete specifics.
    slot.mustUseDetails.push(
      `ANCHOR (${a.key}) — Spread ${a.spreadNumber} must transform this moment into the page's couplet(s):\n  "${a.text}"\nPreserve the emotional truth of this moment — the specific people, the specific action, the specific feeling. Do NOT copy the answer literally onto the page. Do NOT erase the specificity into something generic. The reader should read this couplet and feel that this exact moment, between these exact people, is on the page.`
    );
    slot.anchorRole = a.role;
    // verbatimTokens kept for back-compat on consumers (signatureBeats coverage
    // pre-flight still uses them as a presence-check hint, NOT as a copy directive).
    slot.verbatimTokens = [...slot.verbatimTokens, ...a.loadBearingTokens];
  }

  // Address beats: append a single line to spread 1's mustUseDetails so the
  // writer is told once, prominently, what to call each parent across the
  // book. Address words are different from anchors — they're naming choices,
  // not moments — so the verbatim-use directive is correct here.
  const addressLines = allocations
    .filter(a => a.isAddress)
    .map(a => `ADDRESS (${a.key}): when this parent appears anywhere in the book, the verse must use the word "${a.text.trim()}" verbatim — never a synonym.`);
  if (addressLines.length) {
    const slot1 = perSpread.get(1);
    if (slot1) slot1.mustUseDetails.unshift(...addressLines);
  }

  return { beats, allocations, compression, perSpread };
}

/**
 * Render a compact, human-readable allocation summary for the spread-specs
 * userPrompt. Listed beat-by-beat so the LLM sees the plan as a TABLE, not
 * prose buried in instructions.
 *
 * @param {ReturnType<typeof buildAnchorAllocation>} allocation
 * @returns {string} multi-line block, or '' when there are no anchors.
 */
function renderAllocationBlockForPlanner(allocation) {
  if (!allocation || !allocation.beats || allocation.beats.length === 0) return '';
  const lines = [];
  lines.push('## ANCHOR ALLOCATION (load-bearing — read first)');
  lines.push('These questionnaire moments are THE SUBJECT of this book — the spine, not the decoration.');
  lines.push('Each beat is pinned to a specific spread role. The named moment MUST land on the named spread, transformed into the story\'s voice. Do NOT copy the answer literally; do NOT erase its specificity into a generic stand-in. The writer\'s job is to render the emotional truth and concrete details (people, action, place, feeling) of each moment as a couplet that reads naturally aloud.');
  lines.push('');
  for (const a of allocation.allocations) {
    if (a.isAddress) {
      lines.push(`- ADDRESS · ${a.key} → use "${a.text.trim()}" verbatim every time this parent appears.`);
      continue;
    }
    lines.push(
      `- spread ${a.spreadNumber} (${a.role}) · ${a.key}: "${a.text}"`
    );
  }
  lines.push('');
  lines.push(allocation.compression.message);
  return lines.join('\n');
}

/**
 * Render a SHORTER allocation reminder for the story-bible userPrompt. The
 * bible doesn't need per-spread numbers; it needs to know the BOOK SUBJECT.
 *
 * @param {ReturnType<typeof buildAnchorAllocation>} allocation
 * @returns {string}
 */
function renderAllocationBlockForStoryBible(allocation) {
  if (!allocation || !allocation.beats || allocation.beats.length === 0) return '';
  const lines = [];
  lines.push('## BOOK SUBJECT — these specific questionnaire moments ARE the book');
  lines.push('Build narrativeSpine, beginningHook, middleEscalation, endingPayoff, emotionalArc, and personalizationTargets AROUND these moments. Do not treat them as a checklist below the fold — they are the spine.');
  for (const beat of allocation.beats) {
    if (beat.kind === 'text') {
      lines.push(`- ${beat.key}: "${beat.text}"`);
    } else {
      lines.push(`- ${beat.key} (address word, must appear verbatim): "${beat.text}"`);
    }
  }
  lines.push('');
  lines.push(allocation.compression.message);
  return lines.join('\n');
}

module.exports = {
  buildAnchorAllocation,
  allocateBeatsToSpreads,
  extractLoadBearingTokens,
  compressionGuidance,
  renderAllocationBlockForPlanner,
  renderAllocationBlockForStoryBible,
  SPREAD_ROLES,
  DEFAULT_BEAT_ROLE_MAP,
};
