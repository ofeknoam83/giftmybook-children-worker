/**
 * Still selection (gift video, gv-2 — docs/GIFT_VIDEO_PLAN.md, revision 4):
 * "pick the best illustrations FIRST, then animate once".
 *
 * Before anything is animated, every shipped render the app named is judged
 * ONCE by a strict-JSON vision call for what a film frame needs — a COMPLETE
 * picture: no painted text or overlay, no side reserved for a text panel
 * (the half layout pushes the child into the right half and leaves the left
 * as calm filler), no letterbox band or panel, the child fully in frame —
 * plus a coarse quality grade. A deterministic ranking then picks the best
 * `count` stills in story order (the film shows the child advancing through
 * them in one take), preferring spreads spaced across the book so the
 * moments read as a beginning, a middle and an end. The verdicts are data;
 * only this module's fixed vocabulary ever reaches a prompt or a callback.
 * Fail-open per still: an unjudged still ranks below every judged one and
 * is still selectable when nothing judged exists (renders are text-free by
 * contract).
 */

const { fetchWithTimeout, getNextApiKey } = require('../../illustrationGenerator');
const { jsonQaGenerationConfig, responseText, parseJsonText } = require('../../shared/llm/geminiJson');

const QA_MODEL = () => process.env.CATALOG_QA_VISION_MODEL || 'gemini-2.5-flash';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
const CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u001f\\u007f]+', 'g');

/** Closed reserved-side vocabulary the judge answers with. */
const SIDES = ['none', 'left', 'right'];

/** Scoring weights (documented in the plan; a change is a VIDEO_VERSION bump). */
const WEIGHTS = {
  complete: 40,
  quality: 10,
  reservedSide: -25,
  childCutOff: -15,
  /** Adjacent picks at least two spreads apart. */
  spacing: 6,
  /** The first pick opens the book (≤ 4) / the last pick closes it (≥ 9). */
  bookend: 4,
  /** Tie-breakers, deliberately below one quality point: per spread of
   *  span between the first and last pick, and per spread of imbalance
   *  between the gaps (so equal stills pick an evenly spaced arc). */
  span: 0.5,
  imbalance: -0.25,
};

/**
 * The still judge: ONE strict-JSON vision call — does this render read as a
 * complete, text-free film frame?
 * @param {Buffer} buffer PNG/JPEG bytes
 * @param {{label?: string, costTracker?: object}} [opts]
 * @returns {Promise<{verdict: {textPresent: boolean, transcript: string|null, childVisible: boolean, childCutOff: boolean, reservedSide: string, bandOrPanel: boolean, completePicture: boolean, quality: number}|null, unavailable?: string}>}
 */
async function judgeStill(buffer, opts = {}) {
  const label = opts.label || 'videoStillJudge';
  const prompt = 'You are choosing illustrations from a children\'s picture book to build a short animated film. '
    + 'Judge THIS ONE image as a film frame. Answer with strict JSON only, exactly these fields: '
    + '{"text_present": boolean — ANY legible letters, words, digits, captions, signs or logos anywhere in the image EXCEPT lettering that is part of a character\'s own clothing — a logo, patch, badge, name or number on a garment is clothing, not text (pictograms, scribbles and non-letter shapes do not count either); '
    + '"transcript": string — the exact legible text, or "" when there is none; '
    + '"child_visible": boolean — a child character is clearly visible; '
    + '"child_cut_off": boolean — the child\'s head or body is cropped by the frame edge, or the child is mostly hidden behind something; '
    + '"reserved_side": "none" | "left" | "right" — a large column (roughly a third of the width or more) that is deliberately empty or calm filler (sky, water, a plain wall, soft foliage) with no subject and no action, as if space were left there for text; "none" when the whole frame is composed as one picture; '
    + '"band_or_panel": boolean — a blank or solid band, strip, panel, card, plaque, border, frame or letterbox anywhere in the image; '
    + '"complete_picture": boolean — the image reads as ONE complete, balanced illustration that fills the whole frame edge to edge, the child and the scene\'s action composed together (not pushed into one half); '
    + '"quality": integer 1-5 — overall polish: 5 = crisp, well drawn, clean anatomy, appealing; 3 = fine; 1 = broken or ugly}';
  try {
    const apiKey = getNextApiKey();
    const resp = await fetchWithTimeout(
      `${GEMINI_API}/${QA_MODEL()}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mimeType: 'image/png', data: buffer.toString('base64') } }] }],
          generationConfig: jsonQaGenerationConfig(512, QA_MODEL()),
        }),
      },
      60000,
    );
    if (!resp.ok) return { verdict: null, unavailable: `still judge HTTP ${resp.status}` };
    const data = await resp.json();
    if (opts.costTracker) opts.costTracker.addTextUsage(QA_MODEL(), 700, 60);
    const json = parseJsonText(responseText(data));
    const bools = ['text_present', 'child_visible', 'child_cut_off', 'band_or_panel', 'complete_picture'];
    if (!json || !bools.every(k => typeof json[k] === 'boolean')) return { verdict: null, unavailable: 'still judge returned a malformed verdict' };
    const transcript = typeof json.transcript === 'string' ? json.transcript.replace(CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    const side = typeof json.reserved_side === 'string' && SIDES.includes(json.reserved_side.toLowerCase()) ? json.reserved_side.toLowerCase() : 'none';
    const q = Number(json.quality);
    const quality = Number.isInteger(q) && q >= 1 && q <= 5 ? q : 3;
    return {
      verdict: {
        textPresent: json.text_present,
        transcript: transcript || null,
        childVisible: json.child_visible,
        childCutOff: json.child_cut_off,
        reservedSide: side,
        bandOrPanel: json.band_or_panel,
        completePicture: json.complete_picture,
        quality,
      },
    };
  } catch (err) {
    console.warn(`[${label}] still judge failed to run: ${err.message}`);
    return { verdict: null, unavailable: `still judge errored: ${err.message}` };
  }
}

/**
 * Score one judged still (pure). A disqualified still can never be picked;
 * an unjudged one scores 0 and is marked `unchecked`.
 * @param {object|null} verdict from judgeStill
 * @param {{unavailable?: string|null}} [opts]
 * @returns {{score: number, reasons: string[], disqualified: boolean, unchecked: boolean}}
 */
function scoreStill(verdict, opts = {}) {
  if (!verdict) {
    return { score: 0, reasons: [`not judged (${opts.unavailable || 'no verdict'})`], disqualified: false, unchecked: true };
  }
  const reasons = [];
  let disqualified = false;
  if (verdict.textPresent) { disqualified = true; reasons.push(`painted text${verdict.transcript ? ` ("${verdict.transcript}")` : ''}`); }
  if (!verdict.childVisible) { disqualified = true; reasons.push('child not visible'); }
  if (verdict.bandOrPanel) { disqualified = true; reasons.push('band or panel in the frame'); }
  let score = 0;
  if (verdict.completePicture) score += WEIGHTS.complete; else reasons.push('not a complete picture');
  score += WEIGHTS.quality * verdict.quality;
  if (verdict.reservedSide !== 'none') { score += WEIGHTS.reservedSide; reasons.push(`${verdict.reservedSide} side reserved for text`); }
  if (verdict.childCutOff) { score += WEIGHTS.childCutOff; reasons.push('child cut off by the frame'); }
  return { score: disqualified ? -100 : score, reasons, disqualified, unchecked: false };
}

/**
 * Every k-combination of `items` in their given order.
 * @template T
 * @param {T[]} items
 * @param {number} k
 * @returns {T[][]}
 */
function combinations(items, k) {
  const out = [];
  const walk = (start, acc) => {
    if (acc.length === k) { out.push(acc.slice()); return; }
    for (let i = start; i <= items.length - (k - acc.length); i++) {
      acc.push(items[i]);
      walk(i + 1, acc);
      acc.pop();
    }
  };
  if (k > 0 && k <= items.length) walk(0, []);
  return out;
}

/**
 * Pick the best `count` stills in story order (pure, deterministic).
 *
 * Every eligible combination is valued as the sum of its scores plus a
 * spacing bonus (adjacent picks ≥ 2 spreads apart), a bookend bonus (the
 * first pick opens the book, the last closes it) and two small tie-breakers
 * (a wide, evenly spaced arc); remaining ties go to the earlier spreads.
 * Fewer eligible stills than `count` picks what exists.
 * @param {Array<{spread: number, verdict: object|null, unavailable?: string|null}>} stills one entry per judged render
 * @param {{count?: number}} [opts]
 * @returns {{picked: number[], report: Array<{spread: number, score: number, quality: number|null, reasons: string[], disqualified: boolean, unchecked: boolean, picked: boolean}>}}
 */
function rankStills(stills, opts = {}) {
  const count = Math.max(1, Math.min(4, Number.isInteger(opts.count) ? opts.count : 3));
  const report = (stills || [])
    .filter(s => s && Number.isInteger(s.spread))
    .map(s => ({ spread: s.spread, quality: s.verdict ? s.verdict.quality : null, ...scoreStill(s.verdict, { unavailable: s.unavailable }), picked: false }))
    .sort((a, b) => a.spread - b.spread);
  const eligible = report.filter(r => !r.disqualified);
  const k = Math.min(count, eligible.length);
  let best = null;
  for (const combo of combinations(eligible, k)) {
    let value = combo.reduce((a, r) => a + r.score, 0);
    for (let i = 1; i < combo.length; i++) if (combo[i].spread - combo[i - 1].spread >= 2) value += WEIGHTS.spacing;
    if (combo.length >= 2) {
      if (combo[0].spread <= 4) value += WEIGHTS.bookend;
      if (combo[combo.length - 1].spread >= 9) value += WEIGHTS.bookend;
      value += WEIGHTS.span * (combo[combo.length - 1].spread - combo[0].spread);
      const gaps = combo.slice(1).map((r, i) => r.spread - combo[i].spread);
      value += WEIGHTS.imbalance * (Math.max(...gaps) - Math.min(...gaps));
    }
    value = Math.round(value * 1000) / 1000;
    if (!best || value > best.value) best = { value, combo };
  }
  const picked = best ? best.combo.map(r => r.spread) : [];
  for (const r of report) r.picked = picked.includes(r.spread);
  return { picked, report };
}

module.exports = { judgeStill, scoreStill, rankStills, combinations, WEIGHTS, SIDES };
