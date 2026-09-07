/**
 * The coloring page verdict (cb-1, docs/COLORING_BOOK_V2_PLAN.md §4.6) —
 * ONE strict-JSON vision check per candidate with the line-art model sheet
 * (and the colour sheet, the companion sheet, the prop sheets) attached
 * BESIDE the page, the outfit spec quoted as data with its colour words
 * gone (colour does not exist on a coloring page), and a schema-shaped
 * answer mapped to FIXED defect strings split by class: BLOCKING (missing
 * or duplicated child, an unexpected person, identity, a visible outfit
 * slot, the companion, a declared prop, painted text, shading, fills,
 * unsafe content) and ADVISORY (carried prop not visible, open shapes, a
 * frame, scene drift, complexity, the metric shades). Strict fields fail
 * open on a malformed verdict; soft fields are unclaimed, never a defect.
 *
 * The same module judges the LINE SHEETS (hero / companion / border) and
 * owns the repair notes — fixed template lines over pinned data only, the
 * spreadQa.js repairNoteV2 discipline: no model free-text ever reaches a
 * render prompt through here.
 */

const { fetchWithTimeout, getNextApiKey } = require('../../illustrationGenerator');
const { jsonQaGenerationConfig, responseText, parseJsonText, unparseableDetail } = require('../../shared/llm/geminiJson');
const { KIND_GUIDE } = require('./moments');

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
const QA_MODEL = () => process.env.CATALOG_QA_VISION_MODEL || 'gemini-2.5-flash';
const QA_TIMEOUT_MS = 90000;
const OUTFIT_SLOTS = ['top', 'bottom', 'footwear', 'outerwear', 'accessories'];
const SLOT_ANSWERS = new Set(['match', 'mismatch', 'not_visible']);
const PRESENCE = new Set(['present', 'absent']);
const COMPLEXITY = new Set(['too_simple', 'ok', 'too_busy']);

/** Defect prefixes that BLOCK selection/shipping; everything else is advisory. */
const COLORING_BLOCKING_PREFIXES = [
  'child missing', 'child duplicated', 'unexpected person', 'identity mismatch', 'outfit mismatch',
  'companion missing', 'companion look mismatch', 'companion duplicated', 'invented character',
  'declared prop missing', 'prop rendered as text', 'painted text',
  'grey shading present', 'solid black fills', 'too dense', 'unsafe content', 'wrong aspect', 'render failed',
];

/**
 * Sanitize pinned data for quoting into a prompt.
 * @param {*} v @param {number} [max] @returns {string}
 */
function qaData(v, max = 300) {
  return String(v ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/["'`“”‘’]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Split fixed defect strings by class.
 * @param {string[]} defects
 * @returns {{blocking: string[], advisory: string[]}}
 */
function classifyColoringDefects(defects) {
  const blocking = [];
  const advisory = [];
  for (const d of defects || []) (COLORING_BLOCKING_PREFIXES.some(p => String(d).startsWith(p)) ? blocking : advisory).push(d);
  return { blocking, advisory };
}

/**
 * Normalize the model's bbox (fractions, clamped) or null.
 * @param {*} b
 * @returns {{x: number, y: number, w: number, h: number}|null}
 */
function cleanBbox(b) {
  if (!b || typeof b !== 'object') return null;
  const n = k => (typeof b[k] === 'number' && Number.isFinite(b[k]) ? Math.min(1, Math.max(0, b[k])) : null);
  const x = n('x'); const y = n('y'); const w = n('w'); const h = n('h');
  if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return null;
  const r4 = v => Math.round(v * 10000) / 10000;
  const cw = r4(Math.min(w, 1 - x));
  const ch = r4(Math.min(h, 1 - y));
  if (cw <= 0 || ch <= 0) return null;
  return { x: r4(x), y: r4(y), w: cw, h: ch };
}

/**
 * One strict-JSON judge call. Fail-open: transport, HTTP, and parse
 * failures resolve `{unavailable}`; the caller decides what that means.
 * @param {Array<object>} parts Gemini parts (prompt first, images after)
 * @param {{label?: string, maxTokens?: number, costTracker?: object}} [opts]
 * @returns {Promise<{json: object}|{unavailable: string}>}
 */
async function judgeJson(parts, opts = {}) {
  const model = QA_MODEL();
  try {
    const resp = await fetchWithTimeout(`${GEMINI_API}/${model}:generateContent?key=${getNextApiKey()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: jsonQaGenerationConfig(opts.maxTokens || 2048, model) }),
    }, QA_TIMEOUT_MS);
    if (!resp.ok) return { unavailable: `vision QA HTTP ${resp.status}` };
    const data = await resp.json();
    if (opts.costTracker && data && data.usageMetadata) opts.costTracker.addTextUsage(model, data.usageMetadata.promptTokenCount || 0, data.usageMetadata.candidatesTokenCount || 0);
    const text = responseText(data);
    let json;
    try { json = parseJsonText(text); } catch (err) { return { unavailable: `vision QA returned unparseable JSON${unparseableDetail(data, text)}` }; }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { unavailable: 'vision QA returned a malformed verdict' };
    return { json };
  } catch (err) {
    return { unavailable: `vision QA errored: ${err.message}` };
  }
}

const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const isBool = v => typeof v === 'boolean';

/**
 * Build the page-judge prompt. Sections appear only for pinned inputs;
 * reference images are numbered in the order the caller attaches them.
 * @param {object} o normalized options (see checkColoringPage)
 * @returns {{prompt: string, required: string[]}}
 */
function buildPageQaPrompt(o) {
  const lines = [];
  const fields = [];
  const required = ['child_present', 'child_count', 'painted_text', 'shading_present', 'solid_fills', 'extra_people'];
  let img = 1;
  const refs = [];
  if (o.heroLineSheet) refs.push(`Image ${++img} is the LINE-ART MODEL SHEET of the book's child hero (front, three-quarter, back) — the identity ground truth.`);
  if (o.colourSheet) refs.push(`Image ${++img} is the COLOUR model sheet of the same child (a second identity aid; colours are irrelevant here).`);
  if (o.companion && o.companion.sheet) refs.push(`Image ${++img} is the reference sheet of the companion "${qaData(o.companion.name, 60)}" (a ${qaData(o.companion.type || 'companion', 60)}).`);
  for (const p of o.props) if (p.sheet) refs.push(`Image ${++img} is the reference sheet of the object "${qaData(p.name, 80)}".`);
  lines.push('You are checking ONE page of a children\'s COLORING BOOK — black line art on white paper. Image 1 is the page.');
  lines.push(...refs);
  lines.push(`The page was drawn for this moment: "${qaData(o.moment, 400)}" (page kind: ${qaData(KIND_GUIDE[o.kind] || o.kind, 200)}).`);
  lines.push(o.expectsChild
    ? 'The book\'s ONE child hero must appear exactly once on this page.'
    : 'This page contains NO PEOPLE — no child, no adult.');
  fields.push('"child_present": true|false,   // any child hero drawn on the page');
  fields.push('"child_count": <integer>,      // how many separate children are drawn (0 when none)');
  fields.push('"extra_people": <integer>,     // people OTHER than the child hero and the named companion (adults, other children, crowds)');
  if (o.expectsChild && o.heroLineSheet) {
    lines.push('Judge the child\'s IDENTITY against the line-art model sheet: the same face, the same hair shape and length, the same proportions and apparent age. Flag a mismatch ONLY on a clear break.');
    fields.push('"identity_match": true|false,  // the child reads as the same character as the model sheet');
    fields.push('"identity_notes": "…",         // one short phrase on any difference ("" if none)');
    required.push('identity_match');
  }
  if (o.expectsChild && o.outfitSpecText) {
    lines.push(`The child's outfit is FIXED for the whole book to this spec (colours removed — judge cut, length, pattern and the presence of each garment only): "${qaData(o.outfitSpecText, 600)}". Judge only garments actually VISIBLE in this framing; a cropped garment is not missing.`);
    fields.push(`"outfit": { ${OUTFIT_SLOTS.map(s => `"${s}": "match"|"mismatch"|"not_visible"`).join(', ')} },`);
    required.push('outfit');
  }
  if (o.companion) {
    lines.push(o.expectsCompanion
      ? `The companion "${qaData(o.companion.name, 60)}" must appear exactly once${o.companion.sheet ? ', drawn as its reference sheet' : ''}${o.companion.specText ? ` (fixed look: ${qaData(o.companion.specText, 300)})` : ''}.`
      : `The companion "${qaData(o.companion.name, 60)}" is NOT part of this page.`);
    fields.push('"companion": { "present": true|false, "look_match": true|false, "count": <integer>, "bbox": {"x":0-1,"y":0-1,"w":0-1,"h":0-1}|null },');
    required.push('companion');
  }
  if (o.props.length > 0) {
    lines.push(`Objects expected on the page, in this order: ${o.props.map((p, i) => `${i + 1}. "${qaData(p.name, 80)}" (${p.expected === 'required' ? 'must be visible' : 'usually visible, small'})`).join('; ')}.`);
    fields.push('"props": [ { "presence": "present"|"absent", "as_text": true|false }, … ],  // one entry per expected object, in order');
    required.push('props');
  }
  lines.push('Line-art rules the page must obey: pure black lines on white; no grey, shading, hatching, washes or gradients; no solid black areas beyond tiny accents; every outline closed; no drawn frame; NO text, letters, numbers, signs or logos anywhere.');
  fields.push('"painted_text": true|false,    // any readable or pseudo letters, words, numbers, logos');
  fields.push('"visible_text": "…",           // what you can read ("" if none)');
  fields.push('"shading_present": true|false, // grey tones, hatching, washes, gradients, soft shadows');
  fields.push('"solid_fills": true|false,     // solid black areas larger than a small accent (a black hair mass, a filled shadow)');
  fields.push('"open_shapes": true|false,     // outlines with visible gaps that would let colour leak');
  fields.push('"frame_drawn": true|false,     // a border or frame drawn around the picture');
  fields.push('"scene_match": true|false,     // the page shows the described moment (subject, setting, activity)');
  fields.push('"complexity_fit": "too_simple"|"ok"|"too_busy", // for a child of the book\'s age band');
  fields.push('"scary_or_unsafe": true|false, // anything frightening, unsafe, or not wholesome');
  fields.push('"child_bbox": {"x":0-1,"y":0-1,"w":0-1,"h":0-1}|null  // the child hero\'s box as fractions of the page, null when absent');
  lines.push('');
  lines.push('Answer STRICT JSON only:');
  lines.push(`{\n  ${fields.join('\n  ')}\n}`);
  return { prompt: lines.join('\n'), required };
}

/**
 * Type-check the strict fields of a verdict (soft fields are tolerated).
 * @param {object} json
 * @param {string[]} required
 * @returns {boolean}
 */
function validPageVerdict(json, required) {
  if (!json || typeof json !== 'object') return false;
  for (const k of required) {
    const v = own(json, k);
    if (k === 'child_count' || k === 'extra_people') { if (!Number.isInteger(v) || v < 0) return false; continue; }
    if (k === 'outfit') {
      if (!v || typeof v !== 'object') return false;
      for (const s of OUTFIT_SLOTS) if (!SLOT_ANSWERS.has(own(v, s))) return false;
      continue;
    }
    if (k === 'companion') {
      if (!v || typeof v !== 'object' || !isBool(own(v, 'present'))) return false;
      continue;
    }
    if (k === 'props') { if (!Array.isArray(v)) return false; continue; }
    if (!isBool(v)) return false;
  }
  return true;
}

/**
 * Run the page check on one candidate.
 * @param {Buffer} imageBuffer the (cleaned) page
 * @param {object} opts
 * @param {string} opts.kind plan kind
 * @param {string} opts.moment the page's moment line
 * @param {boolean} opts.expectsChild
 * @param {boolean} opts.expectsCompanion
 * @param {{base64: string, mimeType?: string}|null} [opts.heroLineSheet]
 * @param {{base64: string, mimeType?: string}|null} [opts.colourSheet]
 * @param {string|null} [opts.outfitSpecText] colour-stripped spec
 * @param {{name: string, type?: string, specText?: string|null, sheet?: {base64: string, mimeType?: string}|null}|null} [opts.companion]
 * @param {Array<{name: string, sheet?: object|null, expected: 'required'|'carried'}>} [opts.props]
 * @param {string} [opts.label]
 * @param {object} [opts.costTracker]
 * @returns {Promise<{pass: boolean, defects: string[], blocking: string[], advisory: string[], verdict: object|null, childBbox: object|null, companionBbox: object|null, qaUnavailable?: string}>}
 */
async function checkColoringPage(imageBuffer, opts = {}) {
  const label = opts.label || 'coloringQa';
  const o = {
    kind: opts.kind || 'between',
    moment: opts.moment || '',
    expectsChild: !!opts.expectsChild,
    expectsCompanion: !!opts.expectsCompanion,
    heroLineSheet: opts.heroLineSheet && opts.heroLineSheet.base64 ? opts.heroLineSheet : null,
    colourSheet: opts.colourSheet && opts.colourSheet.base64 ? opts.colourSheet : null,
    outfitSpecText: typeof opts.outfitSpecText === 'string' && opts.outfitSpecText.trim() ? opts.outfitSpecText.trim() : null,
    companion: opts.companion && opts.companion.name ? { ...opts.companion, sheet: opts.companion.sheet && opts.companion.sheet.base64 ? opts.companion.sheet : null } : null,
    props: (Array.isArray(opts.props) ? opts.props : []).filter(p => p && p.name).map(p => ({ name: String(p.name), sheet: p.sheet && p.sheet.base64 ? p.sheet : null, expected: p.expected === 'carried' ? 'carried' : 'required' })),
  };
  const unavailable = reason => ({ pass: true, defects: [], blocking: [], advisory: [], verdict: null, childBbox: null, companionBbox: null, qaUnavailable: reason });
  const { prompt, required } = buildPageQaPrompt(o);
  const parts = [{ text: prompt }, { inline_data: { mimeType: 'image/png', data: imageBuffer.toString('base64') } }];
  for (const r of [o.heroLineSheet, o.colourSheet, o.companion && o.companion.sheet, ...o.props.map(p => p.sheet)]) {
    if (r) parts.push({ inline_data: { mimeType: r.mimeType || 'image/png', data: r.base64 } });
  }
  const answer = await judgeJson(parts, { label, costTracker: opts.costTracker });
  if (answer.unavailable) { console.warn(`[${label}] ${answer.unavailable} — passing without QA`); return unavailable(answer.unavailable); }
  const json = answer.json;
  if (!validPageVerdict(json, required)) { console.warn(`[${label}] malformed verdict — passing without QA`); return unavailable('vision QA returned a malformed verdict'); }

  const defects = [];
  const childCount = json.child_count;
  if (o.expectsChild) {
    if (!json.child_present || childCount === 0) defects.push('child missing from the page');
    else if (childCount > 1) defects.push(`child duplicated (${childCount} drawn)`);
    if (json.extra_people > 0) defects.push(`invented character: ${json.extra_people} extra ${json.extra_people === 1 ? 'person' : 'people'} in the scene`);
  } else {
    if (json.child_present || childCount > 0) defects.push('unexpected person: a child was drawn on a page without the hero');
    if (json.extra_people > 0) defects.push(`unexpected person: ${json.extra_people} ${json.extra_people === 1 ? 'person' : 'people'} on a page with no people`);
  }
  if (o.expectsChild && o.heroLineSheet && json.child_present && json.identity_match === false) {
    defects.push(`identity mismatch: the child does not read as the model sheet${typeof json.identity_notes === 'string' && json.identity_notes.trim() ? ` (${qaData(json.identity_notes, 120)})` : ''}`);
  }
  if (o.expectsChild && o.outfitSpecText && json.child_present && json.outfit) {
    for (const slot of OUTFIT_SLOTS) if (json.outfit[slot] === 'mismatch') defects.push(`outfit mismatch: ${slot} differs from the line-art model sheet`);
  }
  if (o.companion && json.companion) {
    const c = json.companion;
    if (o.expectsCompanion) {
      if (!c.present) defects.push(`companion missing: "${qaData(o.companion.name, 60)}"`);
      else {
        if (o.companion.sheet && c.look_match === false) defects.push(`companion look mismatch: "${qaData(o.companion.name, 60)}"`);
        if (Number.isInteger(c.count) && c.count > 1) defects.push(`companion duplicated: "${qaData(o.companion.name, 60)}"`);
      }
    } else if (c.present) {
      defects.push(`unexpected companion in the scene: "${qaData(o.companion.name, 60)}"`);
    }
  }
  o.props.forEach((p, i) => {
    const v = Array.isArray(json.props) ? json.props[i] : null;
    if (!v || typeof v !== 'object' || !PRESENCE.has(own(v, 'presence'))) return;
    if (v.presence === 'absent') defects.push(p.expected === 'required' ? `declared prop missing: "${qaData(p.name, 80)}"` : `carried prop not visible: "${qaData(p.name, 80)}"`);
    else if (v.as_text === true) defects.push(`prop rendered as text: "${qaData(p.name, 80)}"`);
  });
  if (json.painted_text) defects.push(`painted text: "${qaData(json.visible_text, 80)}"`);
  if (json.shading_present) defects.push('grey shading present (judged)');
  if (json.solid_fills) defects.push('solid black fills (judged)');
  if (json.open_shapes === true) defects.push('open shapes: outlines with gaps');
  if (json.frame_drawn === true) defects.push('frame drawn around the page');
  if (json.scene_match === false) defects.push('scene drift: the page does not show the planned moment');
  if (COMPLEXITY.has(json.complexity_fit) && json.complexity_fit !== 'ok') defects.push(json.complexity_fit === 'too_simple' ? 'too simple for the band' : 'too busy for the band');
  if (json.scary_or_unsafe === true) defects.push('unsafe content: frightening or not wholesome');
  const { blocking, advisory } = classifyColoringDefects(defects);
  return {
    pass: defects.length === 0, defects, blocking, advisory, verdict: json,
    childBbox: json.child_present ? cleanBbox(json.child_bbox) : null,
    companionBbox: o.companion && json.companion && json.companion.present ? cleanBbox(json.companion.bbox) : null,
  };
}

/**
 * The repair suffix for a re-render — fixed template lines over pinned
 * data for every defect class present.
 * @param {string[]} defects
 * @param {{name?: string, moment?: string, outfitSpecText?: string|null, heroRef?: number|null, companion?: {name: string, ref?: number|null, specText?: string|null}|null, props?: Array<{name: string, ref?: number|null}>, rules?: {primaryStrokePercent: number}}} [ctx]
 * @returns {string}
 */
function repairNote(defects, ctx = {}) {
  const d = defects || [];
  const has = prefix => d.some(x => String(x).startsWith(prefix));
  const notes = [];
  const name = qaData(ctx.name || 'the child', 40);
  const heroRef = Number.isInteger(ctx.heroRef) ? `REFERENCE ${ctx.heroRef}` : 'the LINE-ART MODEL SHEET';
  if (has('child missing')) notes.push(`CHILD REPAIR: ${name} MUST be in the picture, exactly once, drawn as ${heroRef}. Keep the scene otherwise identical.`);
  if (has('child duplicated')) notes.push(`COUNT REPAIR: exactly ONE ${name} — remove every second child or look-alike figure.`);
  if (has('unexpected person')) notes.push('NO PEOPLE REPAIR: this page has NO people at all — remove every child and adult; keep the setting and objects.');
  if (has('invented character')) notes.push(`CAST REPAIR: remove every person who is not ${name}${ctx.companion ? ` or ${qaData(ctx.companion.name, 40)}` : ''} — no families, no strangers, no crowds.`);
  if (has('identity mismatch')) notes.push(`IDENTITY REPAIR: draw EXACTLY the child of ${heroRef} — the same face, hair shape and length, proportions and apparent age. Fix ONLY the child's likeness; keep the scene otherwise identical.`);
  const slots = [...new Set(d.filter(x => String(x).startsWith('outfit mismatch: ')).map(x => String(x).replace('outfit mismatch: ', '').split(' ')[0]))];
  if (slots.length > 0) notes.push(`OUTFIT REPAIR (${slots.join(', ')}): the child wears EXACTLY the outfit of ${heroRef}, garment by garment — cut, length and pattern${ctx.outfitSpecText ? `: "${qaData(ctx.outfitSpecText, 500)}"` : ''}. Fix ONLY the clothing.`);
  if (ctx.companion && (has('companion missing') || has('companion look mismatch') || has('companion duplicated'))) {
    const dup = has('companion duplicated') ? ' Exactly ONE of them — remove every second instance.' : '';
    notes.push(`COMPANION REPAIR: "${qaData(ctx.companion.name, 40)}" must appear exactly once, drawn EXACTLY ${Number.isInteger(ctx.companion.ref) ? `as REFERENCE ${ctx.companion.ref}` : 'as the book\'s companion design'}${ctx.companion.specText ? ` (fixed look: ${qaData(ctx.companion.specText, 300)})` : ''}, friendly and secondary to the child.${dup} Keep the scene otherwise identical.`);
  }
  if (has('unexpected companion')) notes.push(`COMPANION REPAIR: ${ctx.companion ? `"${qaData(ctx.companion.name, 40)}"` : 'the companion'} is NOT on this page — remove it; keep the scene otherwise identical.`);
  for (const p of Array.isArray(ctx.props) ? ctx.props : []) {
    const pn = qaData(p.name, 80);
    if (d.some(x => x === `declared prop missing: "${pn}"` || x === `carried prop not visible: "${pn}"`)) notes.push(`PROP REPAIR: "${pn}" must be VISIBLE — small, held by or right beside the child${Number.isInteger(p.ref) ? `, drawn exactly as REFERENCE ${p.ref}` : ''}; a drawing of the object, never letters. Keep the scene otherwise identical.`);
    else if (d.some(x => x === `prop rendered as text: "${pn}"`)) notes.push(`PROP REPAIR: draw "${pn}" as the OBJECT it is${Number.isInteger(p.ref) ? ` (REFERENCE ${p.ref})` : ''}, never as a word or label.`);
  }
  if (has('painted text')) notes.push('TEXT REPAIR: remove ALL letters, words, numbers, logos and letter-like marks — every sign, book, banner or screen in the scene is BLANK. Keep the scene otherwise identical.');
  if (has('grey shading present') || has('solid black fills') || has('too dense') || has('light grey traces') || has('ink density above the band')) {
    notes.push('LINE ART REPAIR: remove ALL grey, shading, hatching, washes and gradients; every dark area (hair, clothing, shadows, night sky) becomes an OUTLINED shape left WHITE inside; pure black lines on pure white only. Keep the drawing otherwise identical.');
  }
  if (has('open shapes')) notes.push('OUTLINE REPAIR: close every outline — no gaps anywhere a colour could leak.');
  if (has('frame drawn')) notes.push('FRAME REPAIR: remove the border/frame around the picture; the drawing sits on open white paper.');
  if (has('scene drift') && ctx.moment) notes.push(`SCENE REPAIR: draw EXACTLY this moment and nothing else: "${qaData(ctx.moment, 400)}".`);
  if (has('too simple')) notes.push('DETAIL REPAIR: add a little more to colour — a fuller setting and a few more simple shapes — without any shading.');
  if (has('too busy')) notes.push('SIMPLICITY REPAIR: simplify — fewer, larger shapes, less background detail, more open white space.');
  if (has('stroke weight off spec') && ctx.rules) notes.push(`STROKE REPAIR: draw every main outline at about ${ctx.rules.primaryStrokePercent}% of the image width, even and confident — not hairlines, not heavy marker.`);
  if (has('too sparse')) notes.push('COMPOSITION REPAIR: fill the page with the subject — larger, nearer, with a simple setting around it.');
  if (has('ink inside the edge margin')) notes.push('MARGIN REPAIR: keep a clear band inside every edge; nothing touches the border of the image.');
  if (has('unsafe content')) notes.push('SAFETY REPAIR: make the scene gentle, wholesome and calm — nothing frightening.');
  return notes.join(' ');
}

/**
 * Judge a line-art SHEET candidate (hero / companion / border).
 * @param {Buffer} buffer the candidate (cleaned) PNG
 * @param {object} o
 * @param {'hero'|'companion'|'border'} o.kind
 * @param {{base64: string, mimeType?: string}|null} [o.reference] the colour sheet the candidate must reproduce (hero/companion)
 * @param {string|null} [o.outfitSpecText]
 * @param {{name: string, type?: string, specText?: string|null}|null} [o.companion]
 * @param {string} [o.label]
 * @param {object} [o.costTracker]
 * @returns {Promise<{pass: boolean, defects: string[], likeness: number}|{unverifiable: string}>}
 */
async function checkLineSheet(buffer, o = {}) {
  const label = o.label || `coloringSheetQa:${o.kind}`;
  const fields = ['"readable_text": true|false,   // any readable text, letters, labels, numbers, or watermarks', '"shading_present": true|false, // grey tones, hatching, washes, gradients', '"solid_fills": true|false,     // solid black areas beyond tiny accents', '"open_shapes": true|false,     // outlines with visible gaps'];
  const lines = ['You are checking a LINE-ART reference sheet for a children\'s coloring book: black outlines on pure white paper, no grey, no fills. Image 1 is the candidate.'];
  if (o.kind === 'hero') {
    lines.push('Image 2 is the COLOUR character model sheet the candidate must reproduce: the SAME single child, THREE full-body figures (front, three-quarter, back) in the same order, the same hair shape and length, the same face and proportions, and the same complete outfit garment by garment (cut, length, pattern — colours do not exist in line art), plus two small head insets. Flat white background, no scene.');
    if (o.outfitSpecText) lines.push(`Outfit spec (colours removed): "${qaData(o.outfitSpecText, 500)}".`);
    fields.push('"figure_count": <integer>,     // FULL-BODY figures (head insets do not count)', '"one_child": true|false,       // every figure is the SAME single child', '"same_child": true|false,      // the child matches image 2 (face, hair, proportions)', '"outfit_match": true|false,    // the outfit matches image 2 garment by garment in every view', '"likeness": <number 0.0-1.0>   // how well the figures match image 2\'s child');
  } else if (o.kind === 'companion') {
    lines.push(`Image 2 is the COLOUR reference sheet of the companion "${qaData(o.companion && o.companion.name, 60)}" (a ${qaData(o.companion && o.companion.type, 60)}) the candidate must reproduce: the same design, proportions and views${o.companion && o.companion.specText ? ` (fixed look: ${qaData(o.companion.specText, 300)})` : ''}. Flat white background, no scene, no child.`);
    fields.push('"same_subject": true|false,    // the candidate depicts the SAME companion design as image 2', '"child_present": true|false,   // a child hero appears (it must not)', '"likeness": <number 0.0-1.0>   // how well the candidate matches image 2');
  } else {
    lines.push('The candidate is a decorative BORDER FRAME made of a story world\'s motifs running around all four edges, with the CENTRE completely empty white, no people, no text.');
    fields.push('"frame_complete": true|false,  // motifs run along all four edges', '"centre_empty": true|false,    // the middle of the page is clear white', '"people_present": true|false,  // any person or child drawn', '"likeness": <number 0.0-1.0>   // how usable it is as a coloring-book border (1.0 = excellent)');
  }
  lines.push('', 'Answer STRICT JSON only:', `{\n  ${fields.join('\n  ')}\n}`);
  const parts = [{ text: lines.join('\n') }, { inline_data: { mimeType: 'image/png', data: buffer.toString('base64') } }];
  if (o.reference && o.reference.base64) parts.push({ inline_data: { mimeType: o.reference.mimeType || 'image/png', data: o.reference.base64 } });
  const answer = await judgeJson(parts, { label, maxTokens: 1024, costTracker: o.costTracker });
  if (answer.unavailable) return { unverifiable: answer.unavailable };
  const j = answer.json;
  const bools = ['readable_text', 'shading_present', 'solid_fills', 'open_shapes'];
  if (o.kind === 'hero') bools.push('one_child', 'same_child', 'outfit_match');
  if (o.kind === 'companion') bools.push('same_subject', 'child_present');
  if (o.kind === 'border') bools.push('frame_complete', 'centre_empty', 'people_present');
  if (!bools.every(f => isBool(own(j, f)))) return { unverifiable: 'sheet QA returned a malformed verdict' };
  const likenessRaw = own(j, 'likeness');
  if (typeof likenessRaw !== 'number' || !Number.isFinite(likenessRaw)) return { unverifiable: 'sheet QA returned a malformed verdict' };
  const defects = [
    j.readable_text && 'readable text on the sheet',
    j.shading_present && 'grey shading on the sheet',
    j.solid_fills && 'solid black fills on the sheet',
    j.open_shapes && 'open shapes on the sheet',
  ];
  if (o.kind === 'hero') {
    defects.push(!Number.isInteger(own(j, 'figure_count')) || j.figure_count !== 3 ? `${own(j, 'figure_count')} full-body figures (expected 3)` : null, !j.one_child && 'figures do not all depict the same single child', !j.same_child && 'the child does not match the colour model sheet', !j.outfit_match && 'the outfit differs from the colour model sheet');
  }
  if (o.kind === 'companion') defects.push(!j.same_subject && 'the companion design differs from its reference sheet', j.child_present && 'a child is drawn on the companion sheet');
  if (o.kind === 'border') defects.push(!j.frame_complete && 'the frame does not run along all four edges', !j.centre_empty && 'the centre is not empty', j.people_present && 'people drawn on the border');
  const list = defects.filter(Boolean);
  return { pass: list.length === 0, defects: list, likeness: Math.min(1, Math.max(0, likenessRaw)) };
}

module.exports = {
  OUTFIT_SLOTS,
  COLORING_BLOCKING_PREFIXES,
  qaData,
  classifyColoringDefects,
  cleanBbox,
  judgeJson,
  buildPageQaPrompt,
  validPageVerdict,
  checkColoringPage,
  repairNote,
  checkLineSheet,
};
