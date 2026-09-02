/**
 * Character model sheet — the per-anchor FIXED identity reference of the
 * Book Bible (ce-9, ILLUSTRATION_CONSISTENCY_REFACTOR_PLAN §3.1).
 *
 * The approved cover is the wrong KIND of identity image for stateless
 * spread renders: one pose, one angle, legs usually cropped, a scene behind
 * the child. Every render that anchors on it re-invents whatever the cover
 * does not show — and an unspecified garment is per-spread freedom (the
 * ce-8 lesson). This module turns the parent-approved character into ONE
 * wide model sheet — the same child full-body front / three-quarter / back,
 * the SAME complete outfit in all three views, two small head insets, flat
 * light-grey background, no scene, no text — generated ONCE from the cover
 * (one hop, then frozen; never chained from renders) and elected in GCS the
 * way the world plate is, so racing instances adopt one sheet.
 *
 * Best-of-N, judged, elected: N candidates (CATALOG_SHEET_CANDIDATES,
 * default 3) each get one structured vision check (no text, exactly three
 * full-body figures of ONE child, feet visible, outfit identical across the
 * views, anatomy) plus a likeness score against the approved character; the
 * passing candidate with the highest likeness wins. No model free-text ever
 * reaches a prompt: the verdict is a closed schema, every field is
 * type-checked, and every string the caller supplies is sanitized before it
 * is pinned.
 *
 * Failure contract — deliberately NOT the world plate's fail-open: a book
 * that cannot build its sheet must never silently render on the cover
 * alone (that is how drift shipped unnoticed). Any total failure THROWS an
 * Error carrying `failureCode = 'identity_kit_failed'` and `advisories`;
 * the caller decides between `needs_review` (flags.sheetRequired()) and a
 * sheet-less advisory run. A failed anchor sits out a cooldown so a broken
 * cover costs one attempt per window, not N generations per book. The ONLY
 * null result is the kill-switch: CATALOG_CHARACTER_SHEET=0.
 */

const { getNextApiKey, GEMINI_MODEL, fetchWithTimeout, renderStyleBlock } = require('../../../illustrationGenerator');
const { PIXAR_STYLE, GEMINI_QA_MODEL, GEMINI_IMAGE_SAFETY_SETTINGS } = require('../../../shared/illustration/config');
const { downloadBuffer, uploadBuffer, uploadBufferIfAbsent } = require('../../../gcsStorage');
const { STYLE_VERSION } = require('../../versions');
const { fnv1a } = require('../../selection');
const { anchorHash } = require('../outfitLock');
const flags = require('../../flags');

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
/** The vision judge honors the same knob as spread QA (CATALOG_QA_VISION_MODEL). */
const QA_MODEL = () => process.env.CATALOG_QA_VISION_MODEL || GEMINI_QA_MODEL;
const SHEET_TIMEOUT_MS = 180000;
const QA_TIMEOUT_MS = 60000;
const SHEET_ASPECT = '16:9';
const FAILURE_CODE = 'identity_kit_failed';
const STAGE = 'characterSheet';

const CANDIDATES_DEFAULT = 3;
const CANDIDATES_MIN = 1;
const CANDIDATES_MAX = 4;

/** Sanitization caps for caller-supplied strings that get pinned into the prompt. */
const DESCRIPTION_MAX_CHARS = 300;
const NAME_MAX_CHARS = 40;
const AGE_MIN = 1;
const AGE_MAX = 12;

// In-process caches keyed by the anchor's path hash. Each entry holds a
// multi-megabyte base64 image, so the LRU is small and BOUNDED (16 covers
// the anchors a warm instance sees in flight); the in-flight map dedupes
// concurrent first-use generation across parallel renders; failed anchors
// sit out a cooldown so a broken cover costs one attempt per window.
const SHEET_CACHE_MAX = 16;
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const FAILURE_MAX = 32;
const _sheets = new Map();
const _inFlight = new Map();
const _failures = new Map();

/** @param {string} key @returns {boolean} still inside the failure cooldown */
function inFailureCooldown(key) {
  const at = _failures.get(key);
  if (at === undefined) return false;
  if (Date.now() - at < FAILURE_COOLDOWN_MS) return true;
  _failures.delete(key);
  return false;
}

/** Record a failed resolution (evicting oldest past the cap). @param {string} key */
function recordFailure(key) {
  _failures.delete(key);
  _failures.set(key, Date.now());
  while (_failures.size > FAILURE_MAX) _failures.delete(_failures.keys().next().value);
}

/** LRU get: refresh recency on hit. @param {string} key @returns {object|null} */
function cacheGet(key) {
  if (!_sheets.has(key)) return null;
  const sheet = _sheets.get(key);
  _sheets.delete(key);
  _sheets.set(key, sheet);
  return sheet;
}

/** LRU set: insert as most-recent, evict oldest past the cap. @param {string} key @param {object} sheet */
function cacheSet(key, sheet) {
  _sheets.delete(key);
  _sheets.set(key, sheet);
  while (_sheets.size > SHEET_CACHE_MAX) _sheets.delete(_sheets.keys().next().value);
}

/**
 * Candidates rendered per anchor: CATALOG_SHEET_CANDIDATES, clamped 1-4
 * (non-integers / out-of-range ⇒ default 3).
 * @returns {number}
 */
function sheetCandidateCount() {
  const n = Number(process.env.CATALOG_SHEET_CANDIDATES);
  return Number.isInteger(n) && n >= CANDIDATES_MIN && n <= CANDIDATES_MAX ? n : CANDIDATES_DEFAULT;
}

/**
 * Deterministic GCS path for one anchor's elected sheet. Keyed by
 * STYLE_VERSION (a style bump regenerates sheets) and the anchor's PATH hash
 * (a re-signed URL resolves the same object).
 * @param {string} hash anchorHash of the identity anchor URL
 * @returns {string}
 */
function characterSheetPath(hash) {
  return `catalog-assets/character-sheets/${STYLE_VERSION}/${hash}.png`;
}

/**
 * The sheet's JSON sidecar beside the PNG: `{hash, likeness, candidates,
 * derivedAt}` — the judge's numbers for the elected bytes, written by the
 * election winner AFTER the PNG is elected.
 * @param {string} hash anchorHash of the identity anchor URL
 * @returns {string}
 */
function characterSheetSidecarPath(hash) {
  return `catalog-assets/character-sheets/${STYLE_VERSION}/${hash}.json`;
}

/**
 * Sanitize one caller-supplied line into inert pinned prompt data: control
 * chars and newlines collapse (a newline would let a description start a
 * "new instruction" line), quotes/backticks strip, whitespace normalizes,
 * length-capped. Null when nothing usable survives.
 * @param {*} value
 * @param {number} maxChars
 * @returns {string|null}
 */
function cleanLine(value, maxChars) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Sanitize the app-supplied character description (the cover-time
 * `describeChildFromPhoto` sentence) before it is pinned into the sheet
 * prompt. Profile strings are data, never instructions.
 * @param {*} value
 * @returns {string|null}
 */
function cleanDescription(value) {
  return cleanLine(value, DESCRIPTION_MAX_CHARS);
}

/**
 * The child's identity line for the prompt: sanitized name + a bounded
 * integer age. Null when the profile carries neither.
 * @param {{name?: string, age?: number|string}|null|undefined} profile
 * @returns {string|null}
 */
function renderChildLine(profile) {
  const name = cleanLine(profile?.name, NAME_MAX_CHARS);
  const ageNum = Number(profile?.age);
  const age = Number.isInteger(ageNum) && ageNum >= AGE_MIN && ageNum <= AGE_MAX ? ageNum : null;
  if (!name && age === null) return null;
  const parts = [];
  if (name) parts.push(`named ${name}`);
  if (age !== null) parts.push(`${age} years old`);
  return `The child is ${parts.join(', ')}.`;
}

/**
 * The sheet's generation prompt — a FIXED template (style block + layout,
 * outfit, inset, background, anatomy, and no-text rules) with only the
 * sanitized child line and description interpolated. Deterministic for the
 * same inputs.
 * @param {object} params
 * @param {{name?: string, age?: number|string}|null} [params.profile]
 * @param {string|null} [params.characterDescription]
 * @param {boolean} [params.hasChildPhoto] whether REFERENCE 2 rides the call
 * @returns {string}
 */
function buildSheetPrompt({ profile = null, characterDescription = null, hasChildPhoto = false } = {}) {
  const childLine = renderChildLine(profile);
  const description = cleanDescription(characterDescription);
  const lines = [
    renderStyleBlock(PIXAR_STYLE),
    'CHARACTER MODEL SHEET of this exact child — the parent-approved character in REFERENCE 1. Its face, hair, skin tone, and the colours and materials of its outfit are GROUND TRUTH: reproduce them, never reinterpret them.',
  ];
  if (hasChildPhoto) lines.push('REFERENCE 2 is the child\'s photo for LIKENESS ONLY (facial features); the outfit and rendering style come from REFERENCE 1.');
  if (childLine) lines.push(childLine);
  if (description) lines.push(`Character description: ${description}.`);
  lines.push(
    'LAYOUT (hard rules): three FULL-BODY figures of the SAME child standing side by side in one row — LEFT: front view, MIDDLE: three-quarter view, RIGHT: back view — standing relaxed with arms at the sides, head to toe entirely inside the frame, feet and shoes fully visible on every figure.',
    'OUTFIT: the SAME complete outfit in all three views — every garment, colour, pattern, and length identical from view to view. Where the reference crops a garment (legs, shoes), complete it ONCE and draw that completion identically in every view. Never invent accessories, props, or extra garments the reference does not show.',
    'HEAD INSETS: two small head-and-shoulders insets in the top corner — one happy, one curious — the same child, same hair, same skin tone.',
    'BACKGROUND: a flat light-grey studio background with even, soft lighting. NO scene, NO environment, NO props, NO other people, animals, or creatures.',
    'ANATOMY: exactly two arms and two hands with exactly five clearly separated fingers per hand, two legs, and two feet on every figure — no third arm, no extra or duplicated hand, no stray hand, no fused fingers.',
    'ABSOLUTELY NO text, letters, labels, numbers, captions, arrows, or watermarks anywhere in the image — the sheet is a pure visual reference.',
  );
  return lines.join('\n');
}

/**
 * Build a tagged `identity_kit_failed` error.
 * @param {string} message
 * @param {Array<{stage: string, note: string}>} advisories
 * @returns {Error}
 */
function identityKitError(message, advisories) {
  const err = new Error(message);
  err.failureCode = FAILURE_CODE;
  err.advisories = advisories;
  return err;
}

/** @param {string} note @returns {{stage: string, note: string}} */
function advisory(note) {
  return { stage: STAGE, note };
}

/**
 * One Gemini image call for one sheet candidate: the fixed prompt, the
 * labeled approved-character reference, and (when supplied) the labeled
 * child photo. Kept local instead of reusing generateIllustration: that
 * path wraps scenes in per-spread prompt language a model sheet must not
 * carry.
 * @param {string} prompt
 * @param {{base64: string, mimeType?: string}} refPhoto the approved anchor bytes
 * @param {{base64: string, mimeType?: string}|null} childPhoto
 * @returns {Promise<Buffer>}
 */
async function renderSheetCandidate(prompt, refPhoto, childPhoto) {
  const parts = [
    { text: prompt },
    { text: 'REFERENCE 1 — APPROVED CHARACTER (the parent-approved rendering of the child: face, hair, skin tone, and the outfit\'s colours/materials are ground truth)' },
    { inline_data: { mimeType: refPhoto.mimeType || 'image/png', data: refPhoto.base64 } },
  ];
  if (childPhoto?.base64) {
    parts.push(
      { text: 'REFERENCE 2 — CHILD PHOTO (likeness only: facial features)' },
      { inline_data: { mimeType: childPhoto.mimeType || 'image/jpeg', data: childPhoto.base64 } },
    );
  }
  const apiKey = getNextApiKey();
  const resp = await fetchWithTimeout(
    `${GEMINI_API}/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: SHEET_ASPECT } },
        safetySettings: GEMINI_IMAGE_SAFETY_SETTINGS,
      }),
    },
    SHEET_TIMEOUT_MS,
  );
  if (!resp.ok) throw new Error(`Gemini sheet render HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
  const data = await resp.json();
  const imagePart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!imagePart?.inlineData?.data) throw new Error('no image in Gemini sheet response');
  return Buffer.from(imagePart.inlineData.data, 'base64');
}

const SHEET_QA_PROMPT = `You are checking a CHARACTER MODEL SHEET for a children's picture book. Image 1 is the sheet. Image 2 is the APPROVED CHARACTER reference the sheet must reproduce.

A correct sheet shows exactly THREE full-body (head to toe) figures of the SAME single child standing side by side — front view, three-quarter view, back view — wearing the SAME complete outfit in all three, with feet and shoes fully visible, plus two small head insets in a corner (the insets are NOT full-body figures — do not count them), on a flat plain background, with NO text of any kind.

Answer STRICT JSON only:
{
  "readable_text": true|false,   // any readable text, letters, labels, numbers, captions, or watermarks anywhere in image 1
  "figure_count": <integer>,     // number of FULL-BODY (head to toe) figures in image 1; head insets do not count
  "one_child": true|false,       // every figure depicts the SAME single child (no second child, adult, or creature)
  "feet_visible": true|false,    // every full-body figure shows its feet/shoes fully inside the frame
  "outfit_consistent_across_views": true|false, // the same complete outfit (garments, colours, patterns, lengths) in every view
  "anatomy_ok": true|false,      // every figure has exactly two arms, two hands with five separated fingers, two legs; no extra, fused, or duplicated limbs
  "likeness": <number 0.0-1.0>   // how well the figures match the approved character in image 2: face, hair, skin tone, and outfit colours (1.0 = the same character)
}
Only report what you can clearly see; do not guess.`;

const VERDICT_BOOLEANS = ['readable_text', 'one_child', 'feet_visible', 'outfit_consistent_across_views', 'anatomy_ok'];

/**
 * Validate the judge's parsed JSON into a closed verdict: every required
 * field type-checked (booleans, an integer figure count, a finite likeness
 * clamped to 0-1). Null when malformed — the caller treats the candidate as
 * unverifiable, never as passed. Only own properties are read; hostile keys
 * (`__proto__`, `constructor`) are ignored data, never prototype writes.
 * @param {*} json
 * @returns {{pass: boolean, defects: string[], likeness: number}|null}
 */
function parseSheetVerdict(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const own = k => (Object.prototype.hasOwnProperty.call(json, k) ? json[k] : undefined);
  if (!VERDICT_BOOLEANS.every(f => typeof own(f) === 'boolean')) return null;
  const figureCount = own('figure_count');
  if (!Number.isInteger(figureCount)) return null;
  const likenessRaw = own('likeness');
  if (typeof likenessRaw !== 'number' || !Number.isFinite(likenessRaw)) return null;
  const likeness = Math.min(1, Math.max(0, likenessRaw));
  const defects = [
    own('readable_text') && 'readable text on the sheet',
    figureCount !== 3 && `${figureCount} full-body figures (expected 3)`,
    !own('one_child') && 'figures do not all depict the same single child',
    !own('feet_visible') && 'feet/shoes not fully visible on every figure',
    !own('outfit_consistent_across_views') && 'outfit differs between views',
    !own('anatomy_ok') && 'anatomy error (limbs/hands/fingers)',
  ].filter(Boolean);
  return { pass: defects.length === 0, defects, likeness };
}

/**
 * One vision call judging a sheet candidate against the approved character.
 * Fail-open per candidate: transport/HTTP/malformed verdicts resolve
 * `{unverifiable: <reason>}` — the caller never passes such a candidate
 * silently.
 * @param {Buffer} sheetBuffer the candidate bytes
 * @param {{base64: string, mimeType?: string}} refPhoto the approved anchor bytes
 * @returns {Promise<{pass: boolean, defects: string[], likeness: number}|{unverifiable: string}>}
 */
async function judgeSheetCandidate(sheetBuffer, refPhoto) {
  try {
    const apiKey = getNextApiKey();
    const resp = await fetchWithTimeout(
      `${GEMINI_API}/${QA_MODEL()}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: SHEET_QA_PROMPT },
              { inline_data: { mimeType: 'image/png', data: sheetBuffer.toString('base64') } },
              { inline_data: { mimeType: refPhoto.mimeType || 'image/png', data: refPhoto.base64 } },
            ],
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 256, responseMimeType: 'application/json' },
        }),
      },
      QA_TIMEOUT_MS,
    );
    if (!resp.ok) return { unverifiable: `sheet QA HTTP ${resp.status}` };
    const data = await resp.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    let json;
    try {
      json = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
    } catch (parseErr) {
      return { unverifiable: 'sheet QA returned unparseable JSON' };
    }
    const verdict = parseSheetVerdict(json);
    if (!verdict) return { unverifiable: 'sheet QA returned a malformed verdict' };
    return verdict;
  } catch (err) {
    return { unverifiable: `sheet QA errored: ${err.message}` };
  }
}

/**
 * Render + judge one candidate. Never throws: a generation failure is a
 * candidate with `error`, a judge failure one with `unverifiable`.
 * @param {number} index 0-based candidate index
 * @param {string} prompt
 * @param {{base64: string, mimeType?: string}} refPhoto
 * @param {{base64: string, mimeType?: string}|null} childPhoto
 * @param {object|undefined} costTracker
 * @returns {Promise<{index: number, buffer?: Buffer, verdict?: object, unverifiable?: string, error?: string}>}
 */
async function produceCandidate(index, prompt, refPhoto, childPhoto, costTracker) {
  let buffer;
  try {
    buffer = await renderSheetCandidate(prompt, refPhoto, childPhoto);
  } catch (err) {
    return { index, error: err.message };
  }
  if (costTracker) costTracker.addImageGeneration(GEMINI_MODEL, 1);
  const judged = await judgeSheetCandidate(buffer, refPhoto);
  if (judged.unverifiable) return { index, buffer, unverifiable: judged.unverifiable };
  return { index, buffer, verdict: judged };
}

/**
 * Elect the winning candidate from the judged set: the PASSING candidate
 * with the highest likeness (ties ⇒ lowest index, deterministic). When no
 * candidate passes: if EVERY generated candidate is unverifiable (judge
 * infrastructure down) the first generated one ships UNCHECKED with an
 * advisory (mirroring the world plate); otherwise the set is a total
 * failure and the returned `error` carries every candidate's verdict.
 * @param {Array<object>} results from produceCandidate, in index order
 * @param {(level: string, msg: string) => void} log
 * @returns {{winner: object|null, likeness: number|null, advisories: Array<{stage: string, note: string}>, error?: Error}}
 */
function electCandidate(results, log) {
  const advisories = [];
  for (const r of results) {
    const n = r.index + 1;
    if (r.error) {
      log('warn', `character sheet candidate ${n}: generation failed (${r.error})`);
      advisories.push(advisory(`candidate ${n} generation failed: ${r.error}`));
    } else if (r.unverifiable) {
      log('warn', `character sheet candidate ${n}: UNVERIFIABLE (${r.unverifiable})`);
      advisories.push(advisory(`candidate ${n} unverifiable: ${r.unverifiable}`));
    } else if (!r.verdict.pass) {
      log('info', `character sheet candidate ${n}: REJECTED (${r.verdict.defects.join('; ')}; likeness ${r.verdict.likeness.toFixed(2)})`);
      advisories.push(advisory(`candidate ${n} rejected: ${r.verdict.defects.join('; ')}`));
    } else {
      log('info', `character sheet candidate ${n}: PASS (likeness ${r.verdict.likeness.toFixed(2)})`);
    }
  }
  const passing = results.filter(r => r.verdict?.pass);
  if (passing.length > 0) {
    const winner = passing.reduce((best, r) => (r.verdict.likeness > best.verdict.likeness ? r : best), passing[0]);
    return { winner, likeness: winner.verdict.likeness, advisories };
  }
  const generated = results.filter(r => r.buffer);
  if (generated.length > 0 && generated.every(r => r.unverifiable)) {
    const first = generated[0];
    log('warn', `character sheet: every candidate was unverifiable — candidate ${first.index + 1} shipped UNCHECKED`);
    advisories.push(advisory(`sheet shipped UNCHECKED: the judge was unavailable for every candidate (${first.unverifiable})`));
    return { winner: first, likeness: null, advisories };
  }
  const summary = advisories.map(a => a.note).join(' | ');
  return {
    winner: null,
    likeness: null,
    advisories,
    error: identityKitError(`character sheet failed: no candidate passed QA (${summary})`, advisories),
  };
}

/**
 * Parse a stored sidecar (our own write, still treated as data): likeness
 * as a finite 0-1 number or null, candidates as a positive integer or null.
 * @param {Buffer|null|undefined} raw
 * @returns {{likeness: number|null, candidates: number|null}}
 */
function parseSidecar(raw) {
  const out = { likeness: null, candidates: null };
  if (!raw) return out;
  try {
    const json = JSON.parse(raw.toString('utf8'));
    if (!json || typeof json !== 'object') return out;
    const own = k => (Object.prototype.hasOwnProperty.call(json, k) ? json[k] : undefined);
    const likeness = own('likeness');
    if (typeof likeness === 'number' && Number.isFinite(likeness)) out.likeness = Math.min(1, Math.max(0, likeness));
    const candidates = own('candidates');
    if (Number.isInteger(candidates) && candidates > 0) out.candidates = candidates;
  } catch (err) {
    // A corrupt sidecar only loses the judge's numbers, never the sheet.
  }
  return out;
}

/**
 * Package elected bytes into the result shape.
 * @param {Buffer} buffer
 * @param {string} storageKey
 * @param {number|null} likeness
 * @param {number|null} candidates
 * @param {Array<{stage: string, note: string}>} advisories
 * @returns {{base64: string, mimeType: string, hash: string, storageKey: string, likeness: number|null, candidates: number, advisories: Array<{stage: string, note: string}>}}
 */
function toSheet(buffer, storageKey, likeness, candidates, advisories) {
  const base64 = buffer.toString('base64');
  return {
    base64,
    mimeType: 'image/png',
    hash: fnv1a(base64).toString(36),
    storageKey,
    likeness,
    candidates: candidates ?? 0,
    advisories,
  };
}

/** Shallow copy so a cached entry is never mutated through a caller's result. @param {object} sheet */
function copySheet(sheet) {
  return { ...sheet, advisories: sheet.advisories.map(a => ({ ...a })) };
}

/**
 * Resolve (or lazily build) the character model sheet for one identity
 * anchor.
 * @param {object} params
 * @param {string} params.anchorUrl the identity reference URL (approved
 *   cover, or the raw-photo fallback for coverless test books)
 * @param {{base64: string, mimeType?: string}} params.refPhoto the anchor
 *   bytes the caller already downloaded for the renders
 * @param {{base64: string, mimeType?: string}|null} [params.childPhoto]
 *   the child's photo as a secondary likeness-only reference
 * @param {{name?: string, age?: number|string}|null} [params.profile]
 * @param {string|null} [params.characterDescription] the app's cover-time
 *   description sentence (sanitized before it is pinned)
 * @param {object} [params.costTracker]
 * @param {(level: string, msg: string) => void} [params.log]
 * @returns {Promise<{base64: string, mimeType: string, hash: string, storageKey: string, likeness: number|null, candidates: number, advisories: Array<{stage: string, note: string}>}|null>}
 *   null ONLY when the kill-switch is off.
 * @throws {Error} `failureCode = 'identity_kit_failed'` (+ `advisories`) on
 *   any total failure — bad input, no passing candidate, transport or
 *   election failure, or an anchor inside its failure cooldown.
 */
async function getCharacterSheet({ anchorUrl, refPhoto, childPhoto = null, profile = null, characterDescription = null, costTracker, log = () => {} }) {
  if (!flags.characterSheetEnabled()) return null;
  if (!anchorUrl || !refPhoto?.base64) {
    throw identityKitError('character sheet: an identity anchor URL and its bytes are required', [advisory('no identity anchor supplied')]);
  }
  const key = anchorHash(anchorUrl);
  const hit = cacheGet(key);
  if (hit) return copySheet(hit);
  if (inFailureCooldown(key)) {
    throw identityKitError(`character sheet for anchor ${key} failed recently — inside the failure cooldown`, [advisory('anchor inside the character-sheet failure cooldown')]);
  }
  if (_inFlight.has(key)) return _inFlight.get(key).then(copySheet);

  const resolve = (async () => {
    const path = characterSheetPath(key);
    const sidecarPath = characterSheetSidecarPath(key);
    try {
      const cached = await downloadBuffer(path).catch(() => null);
      if (cached) {
        const meta = parseSidecar(await downloadBuffer(sidecarPath).catch(() => null));
        const sheet = toSheet(cached, path, meta.likeness, meta.candidates, []);
        cacheSet(key, sheet);
        return sheet;
      }
      const count = sheetCandidateCount();
      log('info', `character sheet for anchor ${key} not cached — generating ${count} candidate(s) (${path})`);
      const prompt = buildSheetPrompt({ profile, characterDescription, hasChildPhoto: Boolean(childPhoto?.base64) });
      const results = await Promise.all(
        Array.from({ length: count }, (_, i) => produceCandidate(i, prompt, refPhoto, childPhoto?.base64 ? childPhoto : null, costTracker)),
      );
      const election = electCandidate(results, log);
      if (!election.winner) {
        recordFailure(key);
        throw election.error;
      }
      // Create-if-absent: concurrent cold instances race to create the same
      // deterministic object and exactly one write wins — every loser ADOPTS
      // the winning bytes, so all instances anchor on ONE sheet.
      let sheetBuffer = election.winner.buffer;
      let likeness = election.likeness;
      let candidates = count;
      const advisories = election.advisories;
      let created;
      try {
        ({ created } = await uploadBufferIfAbsent(sheetBuffer, path, 'image/png'));
      } catch (err) {
        // Never globally elected — using it would fork the fixed reference
        // during a GCS outage. Total failure with the cooldown.
        recordFailure(key);
        throw identityKitError(`character sheet upload failed for anchor ${key}: ${err.message}`, [...advisories, advisory(`sheet upload failed: ${err.message}`)]);
      }
      if (created) {
        // The sidecar is best-effort diagnostics beside an already-elected
        // PNG: a failed write never loses the sheet.
        const body = Buffer.from(JSON.stringify({
          hash: fnv1a(sheetBuffer.toString('base64')).toString(36),
          likeness,
          candidates,
          derivedAt: new Date().toISOString(),
        }));
        await uploadBuffer(body, sidecarPath, 'application/json').catch((err) => {
          log('warn', `character sheet sidecar write failed for anchor ${key} (${err.message})`);
        });
      } else {
        // A KNOWN winner exists: local bytes are never acceptable. Failing
        // to fetch the winner is a total failure WITHOUT a cooldown — the
        // winner exists, and the next cache check fetches it.
        log('info', `character sheet for anchor ${key} was created concurrently — adopting the winning object`);
        try {
          sheetBuffer = await downloadBuffer(path);
        } catch (winErr) {
          throw identityKitError(`character sheet for anchor ${key}: lost the creation race and could not fetch the winning sheet (${winErr.message})`, [...advisories, advisory(`could not fetch the elected sheet: ${winErr.message}`)]);
        }
        const meta = parseSidecar(await downloadBuffer(sidecarPath).catch(() => null));
        likeness = meta.likeness;
        candidates = meta.candidates;
        advisories.push(advisory('adopted the concurrently elected sheet'));
      }
      const sheet = toSheet(sheetBuffer, path, likeness, candidates, advisories);
      cacheSet(key, sheet);
      return sheet;
    } catch (err) {
      if (err.failureCode === FAILURE_CODE) throw err;
      // Anything else (transport shape we did not anticipate) is still a
      // total failure under the same code, with the cooldown.
      log('warn', `character sheet unavailable for anchor ${key} (${err.message})`);
      recordFailure(key);
      throw identityKitError(`character sheet failed for anchor ${key}: ${err.message}`, [advisory(`sheet build failed: ${err.message}`)]);
    } finally {
      _inFlight.delete(key);
    }
  })();
  _inFlight.set(key, resolve);
  return resolve.then(copySheet);
}

module.exports = {
  getCharacterSheet,
  characterSheetPath,
  characterSheetSidecarPath,
  buildSheetPrompt,
  cleanDescription,
  parseSheetVerdict,
  sheetCandidateCount,
  anchorHash,
  FAILURE_CODE,
};
