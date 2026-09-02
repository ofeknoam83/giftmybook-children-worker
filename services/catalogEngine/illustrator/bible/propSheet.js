/**
 * Prop sheets + the companion sheet — the Book Bible's FIXED reference
 * images for everything in a render that is not the child or the world
 * (ce-9, plan §3.2).
 *
 * A carried prop ("teddy bear") and the theme companion ("Tavi, a young
 * triceratops") used to ride every stateless render as a noun. A noun is
 * per-spread freedom: twelve renders invent twelve bears. This module turns
 * each into pixels + a schema-validated spec, generated ONCE and frozen:
 *
 *   - one square sheet of the subject ALONE, two views side by side (front +
 *     three-quarter), flat neutral background, in the pinned PIXAR_STYLE and
 *     the theme's world-law palette, no child, no people, no text;
 *   - a content check (vision, strict JSON) that refuses text, people, or a
 *     second subject — one corrective retry, then the prop resolves null;
 *   - ONE vision read of the ELECTED sheet producing the prop spec
 *     ({name, kind, colours, colourHex, material, sizeRelativeToChild,
 *     distinguishingMarks}), sanitized like the outfit lock and rendered
 *     into one inert sentence (`specText`) for the PROPS / COMPANION block.
 *
 * Election mirrors the world plate: profile props cache by
 * (normalizedValue, themeId, STYLE_VERSION) — two children with "teddy
 * bear" in the same theme share one sheet — and the companion per theme by
 * its prompt hash (the prompt folds in overlay-patchable companion naming
 * and the world card, so a Catalog Studio activation resolves a new sheet).
 * `uploadBufferIfAbsent` elects ONE winning image AND one winning spec per
 * key; a loser adopts the winner's bytes and the winner's `.json` — never a
 * locally derived spec for a foreign image.
 *
 * Every prop value and companion name is DATA: it is quoted inertly into
 * the generation prompt (control chars and quotes stripped, length-capped —
 * scenes.js inertPropValue's treatment) and never reaches a prompt as a
 * directive line. No model free text is ever pinned: every spec field is
 * type-checked, enum-checked, sanitized, and capped before it can ride a
 * prompt or a cache key.
 *
 * Fail-open by contract: props are decorative (ce-6) — any failure logs and
 * returns null (the prop renders as a plain noun with a `propSheet`
 * advisory), never fails a book. Kill-switch: CATALOG_PROP_SHEETS=0.
 */

const pLimit = require('p-limit');
const { getNextApiKey, GEMINI_MODEL, fetchWithTimeout, renderStyleBlock } = require('../../../illustrationGenerator');
const { PIXAR_STYLE, GEMINI_QA_MODEL, GEMINI_IMAGE_SAFETY_SETTINGS } = require('../../../shared/illustration/config');
const { jsonQaGenerationConfig, responseText, parseJsonText, unparseableDetail } = require('../../../shared/llm/geminiJson');
const { downloadBuffer, uploadBufferIfAbsent } = require('../../../gcsStorage');
const { renderWorldCardBlock } = require('../../worldCards');
const { STYLE_VERSION } = require('../../versions');
const { fnv1a } = require('../../selection');
const flags = require('../../flags');

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
const VISION_MODEL = () => process.env.CATALOG_QA_VISION_MODEL || GEMINI_QA_MODEL;
const SHEET_TIMEOUT_MS = 180000;
const VISION_TIMEOUT_MS = 60000;
const SHEET_ATTEMPTS = 2; // transport retries per image call (the QA retry is separate)
const PROP_CONCURRENCY = 2;

/** Inert-value cap — scenes.js inertPropValue's limit, shared so a prop is named identically in the sheet prompt and the scene prompt. */
const PROP_VALUE_MAX_CHARS = 80;
const SPEC_TEXT_MAX_CHARS = 300;
const SPEC_FIELD_MAX_CHARS = 60;
const SPEC_MARK_MAX_CHARS = 80;
const SPEC_COLOURS_MAX = 3;
const SPEC_MARKS_MAX = 4;

/** Closed vocabularies — the only spec words that can ever reach a prompt. */
const SIZE_VOCAB = ['tiny', 'handheld', 'large', 'child-sized', 'larger-than-child'];
const SIZE_DEFAULT = 'handheld';
const SIZE_WORDS = {
  tiny: 'tiny',
  handheld: 'small handheld',
  large: 'large',
  'child-sized': 'child-sized',
  'larger-than-child': 'larger-than-the-child',
};
const KIND_VOCAB = ['toy', 'plush', 'food', 'vehicle', 'tool', 'book', 'clothing', 'plant', 'object', 'creature', 'character'];
const KIND_DEFAULT = { prop: 'object', companion: 'character' };
const HEX_RE = /^#[0-9a-f]{6}$/i;
const CONTROL_RE = /[\u0000-\u001F\u007F]+/g;

// In-process caches (LRU of resolved sheets, in-flight dedupe, failure
// cooldown), keyed by the sheet's cache identity. Each entry holds a
// base64 square image, so the LRU is bounded; a failed key sits out a
// cooldown so a recurrently failing prop costs one attempt per window,
// never two generations + three vision calls per book.
const CACHE_MAX = 32;
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const FAILURE_MAX = 64;
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
  while (_sheets.size > CACHE_MAX) _sheets.delete(_sheets.keys().next().value);
}

/**
 * Own-property read — a parsed model answer is hostile input (`__proto__` /
 * `constructor` keys are data, never prototype walks).
 * @param {*} obj @param {string} key @returns {*}
 */
function own(obj, key) {
  return obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/**
 * Inert prompt form of a prop value / companion name: control chars and
 * newlines collapse, quotes and backticks strip (the value is quoted into
 * the prompt as `"…"`), whitespace normalizes, length-capped. The ORIGINAL
 * wording (case, spelling) is kept — the story text names the prop this
 * way. Same treatment as scenes.js inertPropValue.
 * @param {*} value
 * @returns {string}
 */
function inertValue(value) {
  return String(value ?? '')
    .replace(CONTROL_RE, ' ')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PROP_VALUE_MAX_CHARS);
}

/**
 * Cache IDENTITY of a prop value: NFKD, lowercase, quotes/control stripped,
 * whitespace collapsed, capped — "Teddy Bear" and "teddy  bear" are one
 * sheet. Never shown to a model; only hashed.
 * @param {*} value
 * @returns {string}
 */
function normalizePropValue(value) {
  return inertValue(String(value ?? '').normalize('NFKD')).toLowerCase();
}

/**
 * Sanitize one spec string into inert pinned data (outfitLock.cleanSlotDesc's
 * rule): control chars/newlines collapse, quotes/backticks strip, whitespace
 * normalizes, length-capped. Null when nothing survives.
 * @param {*} value
 * @param {number} [max]
 * @returns {string|null}
 */
function cleanSpecText(value, max = SPEC_FIELD_MAX_CHARS) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(CONTROL_RE, ' ')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return cleaned.length >= 2 ? cleaned : null;
}

/**
 * Sanitize a list of spec strings: each cleaned, deduped, capped at `cap`.
 * @param {*} list @param {number} cap @param {number} max @returns {string[]}
 */
function cleanSpecList(list, cap, max) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const cleaned = cleanSpecText(item, max);
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Companion naming is catalog data (overlay-patchable) — treated as inertly
 * as a profile value.
 * @param {*} companion @returns {{name: string, type: string}|null}
 */
function cleanCompanion(companion) {
  const name = inertValue(own(companion, 'name'));
  const type = inertValue(own(companion, 'type'));
  return name && type ? { name, type } : null;
}

/**
 * Human-role words: a companion whose type carries one is a PERSON, and the
 * renderer forbids inventing adult (or extra child) faces — such companions
 * never get a sheet. Conservative on purpose: a false negative renders the
 * companion as a noun (today's behavior); a false positive would pin an
 * invented human face on every spread.
 */
const HUMAN_TYPE_RE = /\b(adult|adults|grown[- ]?ups?|human|humans|person|people|man|men|woman|women|boy|boys|girl|girls|kid|kids|child|children|baby|babies|guide|teacher|farmer|builder|worker|ranger|keeper|driver|pilot|captain|sailor|chef|baker|doctor|nurse|librarian|coach|neighbou?r|villager|elder|uncle|aunt|grandma|grandpa|grandmother|grandfather|mother|father|mom|mum|dad|parent|parents|wizard|witch|knight|princess|prince|king|queen|astronaut|pirate|elf|elves|fairy|fairies)\b/i;

/**
 * Is the theme companion a drawable creature/character (a sheet may be
 * built) rather than a human? Requires a usable name AND type, and a type
 * that names no human role — humans are excluded because the renderer
 * forbids inventing adult faces.
 * @param {{name: string, type: string}|null|undefined} companion catalog theme.companion
 * @returns {boolean}
 */
function isDrawableCompanion(companion) {
  const cleaned = cleanCompanion(companion);
  if (!cleaned) return false;
  return !HUMAN_TYPE_RE.test(cleaned.type);
}

/** @param {*} themeId @returns {string|null} a path-safe theme id, else null */
function safeThemeId(themeId) {
  return typeof themeId === 'string' && /^[a-z0-9_-]{1,64}$/i.test(themeId) ? themeId : null;
}

/**
 * Deterministic GCS path for one profile prop's sheet (`.png`; the spec
 * sits beside it as `.json`).
 * @param {string} themeId @param {string} valueHash fnv1a-base36 of the normalized value
 * @returns {string}
 */
function propSheetPath(themeId, valueHash) {
  return `catalog-assets/prop-sheets/${STYLE_VERSION}/${themeId}-${valueHash}.png`;
}

/**
 * Deterministic GCS path for one theme's companion sheet, keyed by the
 * prompt hash (companion naming is overlay-patchable).
 * @param {string} themeId @param {string} promptHash fnv1a-base36 of the prompt
 * @returns {string}
 */
function companionSheetPath(themeId, promptHash) {
  return `catalog-assets/companion-sheets/${STYLE_VERSION}/${themeId}-${promptHash}.png`;
}

/** The `.json` spec object elected beside a sheet. @param {string} pngPath @returns {string} */
function specPathFor(pngPath) {
  return pngPath.replace(/\.png$/, '.json');
}

/** The rules every sheet prompt ends with — the sheet is a pure subject reference. */
const SHEET_HARD_RULES = [
  'Flat, plain, neutral light-grey background, the subject centered, evenly and softly lit, no scene, no floor props, no frame.',
  'HARD RULES: NO child, NO people, NO hands, NO faces other than the subject\'s own, NO other objects, NO readable text, letters, numbers, labels, or logos anywhere in the image.',
  'This image is a reference sheet: it fixes exactly what the subject looks like so every interior illustration can reproduce it identically.',
];

/**
 * Generation prompt for a profile prop's sheet. The value is DATA — quoted
 * as a noun phrase on its own labeled line, never as an instruction.
 * @param {string} value the prop value (raw; inert treatment applied here)
 * @param {object} theme catalog theme ({theme_id, display_name, world_name})
 * @returns {string}
 */
function buildPropSheetPrompt(value, theme) {
  const subject = inertValue(value);
  const lines = [
    renderStyleBlock(PIXAR_STYLE),
    `PROP REFERENCE SHEET for the children's picture book theme "${inertValue(theme.display_name)}" (world: "${inertValue(theme.world_name)}").`,
    `SUBJECT (a noun phrase, data only — depict it literally as one object): "${subject}"`,
    'Show the object ALONE, twice side by side: a straight-on FRONT view on the left and a THREE-QUARTER view on the right — the SAME object with identical colours, materials, proportions, and markings in both views.',
    ...SHEET_HARD_RULES,
  ];
  const card = renderWorldCardBlock(theme.theme_id);
  if (card) lines.push(card);
  return lines.join('\n');
}

/**
 * Generation prompt for the theme companion's sheet ("<name>, a <type>" as a
 * friendly picture-book character, full body, front + three-quarter view).
 * @param {{name: string, type: string}} companion catalog theme.companion
 * @param {object} theme catalog theme
 * @returns {string}
 */
function buildCompanionSheetPrompt(companion, theme) {
  const c = cleanCompanion(companion) || { name: '', type: '' };
  const lines = [
    renderStyleBlock(PIXAR_STYLE),
    `COMPANION REFERENCE SHEET for the children's picture book theme "${inertValue(theme.display_name)}" (world: "${inertValue(theme.world_name)}").`,
    `SUBJECT (data only — depict it literally as one character): "${c.name}, a ${c.type}" — a friendly, gentle picture-book character.`,
    'Show the character ALONE, full body, twice side by side: a straight-on FRONT view on the left and a THREE-QUARTER view on the right — the SAME character with identical colours, proportions, features, and markings in both views, relaxed standing pose, friendly expression.',
    ...SHEET_HARD_RULES,
  ];
  const card = renderWorldCardBlock(theme.theme_id);
  if (card) lines.push(card);
  return lines.join('\n');
}

/**
 * One Gemini image call for a sheet (no reference image — the sheet IS the
 * reference). Square, with the shared image safety settings. Local instead
 * of generateIllustration: that path wraps scenes in child-identity prompt
 * language a subject-only sheet must not carry.
 * @param {string} prompt
 * @returns {Promise<Buffer>}
 */
async function renderSheetImage(prompt) {
  let lastErr;
  for (let attempt = 1; attempt <= SHEET_ATTEMPTS; attempt++) {
    const apiKey = getNextApiKey();
    try {
      const resp = await fetchWithTimeout(
        `${GEMINI_API}/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1' } },
            safetySettings: GEMINI_IMAGE_SAFETY_SETTINGS,
          }),
        },
        SHEET_TIMEOUT_MS,
      );
      if (!resp.ok) throw new Error(`Gemini sheet render HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
      const data = await resp.json();
      const imagePart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (!imagePart) throw new Error('no image in Gemini sheet response');
      return Buffer.from(imagePart.inlineData.data, 'base64');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * One vision call returning strict JSON. Transport/parse failures throw —
 * each caller decides its own fail-open shape.
 * @param {string} prompt
 * @param {Buffer} imageBuffer
 * @param {number} maxOutputTokens
 * @returns {Promise<*>} the parsed JSON
 */
async function visionJson(prompt, imageBuffer, maxOutputTokens) {
  const apiKey = getNextApiKey();
  const resp = await fetchWithTimeout(
    `${GEMINI_API}/${VISION_MODEL()}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inline_data: { mimeType: 'image/png', data: imageBuffer.toString('base64') } },
          ],
        }],
        // Thinking OFF + a ≥2048-token ceiling (shared/llm/geminiJson).
        generationConfig: jsonQaGenerationConfig(maxOutputTokens, VISION_MODEL()),
      }),
    },
    VISION_TIMEOUT_MS,
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const text = responseText(data);
  try {
    return parseJsonText(text);
  } catch (err) {
    throw new Error(`unparseable JSON${unparseableDetail(data, text)}: ${err.message}`);
  }
}

const SHEET_QA_PROMPT = `You are checking a REFERENCE SHEET image for a children's picture book. The sheet must show ONE subject (an object or a friendly creature/character) alone — usually the same subject twice side by side (a front view and a three-quarter view) — on a flat neutral background.

Answer STRICT JSON only:
{
  "readable_text": <true if ANY readable text, letters, numbers, labels, or logos appear anywhere>,
  "people_present": <true if any human person, human child, or human face appears>,
  "subject_count": <integer: how many items are shown, counting repeated views of the SAME subject as separate items — e.g. 2 for one object shown in two views>,
  "single_subject_type": <true if everything shown is the same one subject (repeated views of it), false if different objects or creatures appear>
}`;

/**
 * Content check on a generated sheet: no text, no people, one subject shown
 * once or twice (its two views). A validation INFRA failure (HTTP, malformed
 * verdict) accepts the sheet unchecked — fail-open, same as spread QA.
 * @param {Buffer} imageBuffer
 * @param {{label?: string}} [opts]
 * @returns {Promise<{pass: boolean, defects: string[], qaUnavailable?: string}>}
 */
async function checkSheet(imageBuffer, opts = {}) {
  const label = opts.label || 'propSheetQa';
  try {
    const json = await visionJson(SHEET_QA_PROMPT, imageBuffer, 256);
    const bools = ['readable_text', 'people_present', 'single_subject_type'];
    const count = own(json, 'subject_count');
    if (!json || typeof json !== 'object' || !bools.every(f => typeof own(json, f) === 'boolean') || !Number.isInteger(count)) {
      console.warn(`[${label}] sheet QA returned a malformed verdict — accepting sheet unchecked`);
      return { pass: true, defects: [], qaUnavailable: 'sheet QA returned a malformed verdict' };
    }
    // Fixed defect strings only — they are joined into the retry prompt.
    const defects = [
      own(json, 'readable_text') && 'readable text in the sheet',
      own(json, 'people_present') && 'a person in the sheet',
      count < 1 && 'no subject in the sheet',
      count > 2 && 'more than one subject in the sheet',
      !own(json, 'single_subject_type') && 'different objects instead of one subject in two views',
    ].filter(Boolean);
    return { pass: defects.length === 0, defects };
  } catch (err) {
    console.warn(`[${label}] sheet QA failed to run (accepting sheet unchecked): ${err.message}`);
    return { pass: true, defects: [], qaUnavailable: `sheet QA errored: ${err.message}` };
  }
}

const SPEC_PROMPT = `You are extracting the PROP SPEC for a children's picture book from its reference sheet (one subject, shown in one or two views). The spec pins EXACTLY what the subject looks like so an illustrator can reproduce it identically on every page. Describe ONLY what is visible; never describe the background.

Answer STRICT JSON only:
{
  "kind": one of ${JSON.stringify(KIND_VOCAB)},
  "colours": ["<up to ${SPEC_COLOURS_MAX} plain colour words, most dominant first, e.g. honey-brown>"],
  "colourHex": ["<up to ${SPEC_COLOURS_MAX} #rrggbb hex values, one per colour above, same order>"],
  "material": "<one short phrase for the main material or surface, e.g. soft plush fur>",
  "sizeRelativeToChild": one of ${JSON.stringify(SIZE_VOCAB)},
  "distinguishingMarks": ["<up to ${SPEC_MARKS_MAX} short phrases: patterns, badges, ribbons, stitching, wear marks, features>"]
}`;

/**
 * Validate + sanitize a model (or stored) spec answer into the closed,
 * inert spec shape. Every string is cleaned like outfitLock.cleanSlotDesc,
 * every list is deduped and capped, every enum falls back to its default,
 * hex values must match #rrggbb, and the object is rebuilt with fixed keys
 * (hostile keys such as `__proto__` never propagate). `name` is NEVER taken
 * from the model: the pinned name is the prop's own wording so the PROPS
 * block and the story text agree. Null when nothing usable survives (a
 * spec with no colour pins nothing).
 * @param {*} json the parsed answer
 * @param {{name: string, kind: 'prop'|'companion'}} identity
 * @returns {{name: string, kind: string, colours: string[], colourHex: string[],
 *   material: string, sizeRelativeToChild: string, distinguishingMarks: string[]}|null}
 */
function sanitizePropSpec(json, identity) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const name = inertValue(identity?.name);
  if (!name) return null;
  const kindRaw = cleanSpecText(own(json, 'kind'), 20);
  const kind = kindRaw && KIND_VOCAB.includes(kindRaw.toLowerCase()) ? kindRaw.toLowerCase() : KIND_DEFAULT[identity.kind] || 'object';
  const colours = cleanSpecList(own(json, 'colours'), SPEC_COLOURS_MAX, SPEC_FIELD_MAX_CHARS);
  if (colours.length === 0) return null;
  const hexRaw = own(json, 'colourHex');
  const colourHex = [];
  for (const h of Array.isArray(hexRaw) ? hexRaw : []) {
    if (typeof h !== 'string') continue;
    const v = h.trim().toLowerCase();
    if (HEX_RE.test(v) && !colourHex.includes(v)) colourHex.push(v);
    if (colourHex.length >= SPEC_COLOURS_MAX) break;
  }
  const material = cleanSpecText(own(json, 'material')) || '';
  const sizeRaw = cleanSpecText(own(json, 'sizeRelativeToChild'), 24);
  const sizeRelativeToChild = sizeRaw && SIZE_VOCAB.includes(sizeRaw.toLowerCase()) ? sizeRaw.toLowerCase() : SIZE_DEFAULT;
  const distinguishingMarks = cleanSpecList(own(json, 'distinguishingMarks'), SPEC_MARKS_MAX, SPEC_MARK_MAX_CHARS);
  return { name, kind, colours, colourHex, material, sizeRelativeToChild, distinguishingMarks };
}

/**
 * Render a sanitized spec into ONE inert sentence for the prompt, e.g.
 * `teddy bear: a small handheld plush, made of soft plush fur, honey-brown
 * (#c68e4a), one red ribbon at the neck.` Deterministic (pure function of
 * the spec). Fits SPEC_TEXT_MAX_CHARS whole: trailing marks, then hex
 * values, are dropped until it fits, and a final hard cap guards the rest.
 * @param {object} spec a sanitizePropSpec result
 * @returns {string} '' when the spec carries no usable name
 */
function renderPropSpecText(spec) {
  const name = inertValue(spec?.name);
  if (!name) return '';
  const size = SIZE_WORDS[spec.sizeRelativeToChild] || SIZE_WORDS[SIZE_DEFAULT];
  const kind = KIND_VOCAB.includes(spec.kind) ? spec.kind : 'object';
  const colours = cleanSpecList(spec.colours, SPEC_COLOURS_MAX, SPEC_FIELD_MAX_CHARS);
  const hexAll = (Array.isArray(spec.colourHex) ? spec.colourHex : [])
    .filter(h => typeof h === 'string' && HEX_RE.test(h))
    .map(h => h.toLowerCase())
    .slice(0, SPEC_COLOURS_MAX);
  const material = cleanSpecText(spec.material);
  const marksAll = cleanSpecList(spec.distinguishingMarks, SPEC_MARKS_MAX, SPEC_MARK_MAX_CHARS);
  const render = (hex, marks) => {
    const parts = [`${name}: a ${size} ${kind}`];
    if (material) parts.push(`made of ${material}`);
    if (colours.length > 0) parts.push(`${colours.join(' and ')}${hex.length > 0 ? ` (${hex.join(', ')})` : ''}`);
    parts.push(...marks);
    return `${parts.join(', ')}.`;
  };
  // Marks are decoration; the hex values are the machine-readable colour
  // truth (metrics compare against them) — so every mark goes before any hex.
  for (const hex of [hexAll, []]) {
    for (let keepMarks = marksAll.length; keepMarks >= 0; keepMarks -= 1) {
      const text = render(hex, marksAll.slice(0, keepMarks));
      if (text.length <= SPEC_TEXT_MAX_CHARS) return text;
    }
  }
  return render([], []).slice(0, SPEC_TEXT_MAX_CHARS);
}

/**
 * One vision read of the ELECTED sheet → sanitized spec. Throws when the
 * answer is unusable (the caller fails open with a cooldown).
 * @param {Buffer} sheetBuffer
 * @param {{name: string, kind: 'prop'|'companion'}} identity
 * @returns {Promise<object>}
 */
async function deriveSpec(sheetBuffer, identity) {
  const json = await visionJson(SPEC_PROMPT, sheetBuffer, 512);
  const spec = sanitizePropSpec(json, identity);
  if (!spec) throw new Error('spec vision returned no usable spec');
  return spec;
}

/**
 * Parse a stored `.json` spec blob (data — re-sanitized through the same
 * validator).
 * @param {Buffer} buffer @param {{name: string, kind: string}} identity
 * @returns {object|null}
 */
function parseStoredSpec(buffer, identity) {
  try {
    const blob = JSON.parse(buffer.toString('utf8'));
    return sanitizePropSpec(own(blob, 'spec'), identity);
  } catch {
    return null;
  }
}

/**
 * Assemble the resolved sheet record from elected bytes + elected spec.
 * @param {{key: string, kind: string, buffer: Buffer, storageKey: string, spec: object}} p
 * @returns {object}
 */
function toSheet({ key, kind, buffer, storageKey, spec }) {
  const base64 = buffer.toString('base64');
  const specText = renderPropSpecText(spec);
  return {
    key,
    kind,
    base64,
    mimeType: 'image/png',
    hash: fnv1a(base64).toString(36),
    storageKey,
    spec,
    specText,
    specHash: fnv1a(specText).toString(36),
  };
}

/**
 * Elect the `.json` spec beside an ELECTED sheet image: a stored winner is
 * adopted as-is; otherwise ONE vision read of the elected bytes is uploaded
 * create-if-absent, and a loser adopts the winner's blob. The spec is never
 * derived from bytes that are not the elected image.
 * @param {Buffer} electedBuffer the elected sheet bytes
 * @param {string} specPath
 * @param {{name: string, kind: 'prop'|'companion'}} identity
 * @param {string} imageHash content hash of the elected bytes (diagnostics in the blob)
 * @param {(level: string, msg: string) => void} log
 * @returns {Promise<object|null>} null when no usable spec could be elected
 */
async function electSpec(electedBuffer, specPath, identity, imageHash, log) {
  const stored = await downloadBuffer(specPath).catch(() => null);
  if (stored) {
    const spec = parseStoredSpec(stored, identity);
    if (spec) return spec;
    log('warn', `stored prop spec at ${specPath} is unusable — re-deriving`);
  }
  const derived = await deriveSpec(electedBuffer, identity);
  const body = Buffer.from(JSON.stringify({ spec: derived, hash: imageHash, derivedAt: new Date().toISOString() }));
  const { created } = await uploadBufferIfAbsent(body, specPath, 'application/json');
  if (created) return derived;
  log('info', `prop spec at ${specPath} was created concurrently — adopting the winning spec`);
  const winner = await downloadBuffer(specPath);
  return parseStoredSpec(winner, identity);
}

/**
 * Resolve (or lazily create + elect) one sheet.
 * @param {object} p
 * @param {string} p.cacheKey in-process cache identity
 * @param {'prop'|'companion'} p.kind
 * @param {string} p.key the record key (normalized value / companion name)
 * @param {string} p.pngPath elected image object
 * @param {string} p.prompt generation prompt
 * @param {{name: string, kind: string}} p.identity spec identity
 * @param {object} [p.costTracker]
 * @param {(level: string, msg: string) => void} p.log
 * @returns {Promise<object|null>}
 */
function resolveSheet({ cacheKey, kind, key, pngPath, prompt, identity, costTracker, log }) {
  const hit = cacheGet(cacheKey);
  if (hit) return Promise.resolve(hit);
  if (inFailureCooldown(cacheKey)) return Promise.resolve(null);
  if (_inFlight.has(cacheKey)) return _inFlight.get(cacheKey);
  const label = `${kind} sheet '${key}'`;
  const specPath = specPathFor(pngPath);

  const resolve = (async () => {
    try {
      let elected = await downloadBuffer(pngPath).catch(() => null);
      if (!elected) {
        log('info', `${label} not cached — generating (${pngPath})`);
        let buffer = await renderSheetImage(prompt);
        if (costTracker) costTracker.addImageGeneration(GEMINI_MODEL, 1);
        // Enforce the subject-only invariant BEFORE the sheet can be elected
        // or cached: text, a person, or a second object in the sheet would
        // contaminate every spread that references it. One corrective retry.
        let verdict = await checkSheet(buffer, { label: `propSheetQa:${key}` });
        if (!verdict.pass) {
          log('warn', `${label} failed the content check (${verdict.defects.join('; ')}) — one corrective retry`);
          buffer = await renderSheetImage(`${prompt}\nPREVIOUS ATTEMPT REJECTED — it contained: ${verdict.defects.join('; ')}. Show ONLY the one subject (front view and three-quarter view), NO people, NO other objects, and NO readable text of any kind.`);
          if (costTracker) costTracker.addImageGeneration(GEMINI_MODEL, 1);
          verdict = await checkSheet(buffer, { label: `propSheetQa:${key}:retry` });
          if (!verdict.pass) {
            log('warn', `${label} still fails the content check (${verdict.defects.join('; ')}) — rendering without a sheet`);
            recordFailure(cacheKey);
            return null;
          }
        }
        if (verdict.qaUnavailable) log('warn', `${label} elected UNCHECKED — ${verdict.qaUnavailable}`);
        // Create-if-absent: exactly one write wins; every loser ADOPTS the
        // winning bytes so all instances reference ONE sheet. Once a winner
        // is known, local bytes are never acceptable — a failed winner
        // download resolves null (no cooldown: the next check fetches it).
        elected = buffer;
        try {
          const { created } = await uploadBufferIfAbsent(buffer, pngPath, 'image/png');
          if (!created) {
            log('info', `${label} was created concurrently — adopting the winning object`);
            try {
              elected = await downloadBuffer(pngPath);
            } catch (winErr) {
              log('warn', `${label}: lost the creation race and could not fetch the winner (${winErr.message}) — rendering without a sheet`);
              return null;
            }
          }
        } catch (err) {
          // Never globally elected — using it would fork the fixed
          // reference across instances during a GCS outage.
          log('warn', `${label} upload failed (${err.message}) — rendering without a sheet`);
          recordFailure(cacheKey);
          return null;
        }
      }
      const imageHash = fnv1a(elected.toString('base64')).toString(36);
      const spec = await electSpec(elected, specPath, identity, imageHash, log);
      if (!spec) {
        log('warn', `${label}: no usable spec could be elected — rendering without a sheet`);
        recordFailure(cacheKey);
        return null;
      }
      const sheet = toSheet({ key, kind, buffer: elected, storageKey: pngPath, spec });
      cacheSet(cacheKey, sheet);
      return sheet;
    } catch (err) {
      log('warn', `${label} unavailable (${err.message}) — rendering without it`);
      recordFailure(cacheKey);
      return null;
    } finally {
      _inFlight.delete(cacheKey);
    }
  })();
  _inFlight.set(cacheKey, resolve);
  return resolve;
}

/**
 * Resolve (or lazily create) ONE reference sheet: a profile prop
 * (`{kind: 'prop', value}`) or the theme companion
 * (`{kind: 'companion', companion: {name, type}}`).
 * @param {object} params
 * @param {'prop'|'companion'} params.kind
 * @param {string} [params.value] the prop's evidence source_value (kind 'prop')
 * @param {{name: string, type: string}} [params.companion] catalog theme.companion (kind 'companion')
 * @param {object} params.theme catalog theme ({theme_id, display_name, world_name})
 * @param {object} [params.costTracker]
 * @param {(level: string, msg: string) => void} [params.log]
 * @returns {Promise<{key: string, kind: string, base64: string, mimeType: string,
 *   hash: string, storageKey: string, spec: object, specText: string, specHash: string}|null>}
 *   null when disabled or on ANY failure — the caller renders the prop as a noun.
 */
async function getPropSheet({ kind, value, companion, theme, costTracker, log = () => {} }) {
  try {
    if (!flags.propSheetsEnabled()) return null;
    const themeId = safeThemeId(theme?.theme_id);
    if (!themeId || !theme.world_name) return null;
    if (kind === 'prop') {
      const inert = inertValue(value);
      const normalized = normalizePropValue(value);
      if (!inert || !normalized) return null;
      const valueHash = fnv1a(normalized).toString(36);
      return resolveSheet({
        cacheKey: `prop:${themeId}:${valueHash}`,
        kind,
        key: normalized,
        pngPath: propSheetPath(themeId, valueHash),
        prompt: buildPropSheetPrompt(value, theme),
        identity: { name: inert, kind },
        costTracker,
        log,
      });
    }
    if (kind === 'companion') {
      if (!isDrawableCompanion(companion)) return null;
      const c = cleanCompanion(companion);
      const prompt = buildCompanionSheetPrompt(c, theme);
      const promptHash = fnv1a(prompt).toString(36);
      return resolveSheet({
        cacheKey: `companion:${themeId}:${promptHash}`,
        kind,
        key: c.name,
        pngPath: companionSheetPath(themeId, promptHash),
        prompt,
        identity: { name: c.name, kind },
        costTracker,
        log,
      });
    }
    return null;
  } catch (err) {
    log('warn', `${kind || 'prop'} sheet unavailable (${err.message}) — rendering without it`);
    return null;
  }
}

/**
 * Distinct visual_required prop values in order of first appearance —
 * identity by normalizePropValue, wording from the first occurrence.
 * @param {Array<object>} evidence personalization_evidence records
 * @returns {Array<{value: string, normalized: string}>}
 */
function distinctVisualProps(evidence) {
  const seen = new Set();
  const out = [];
  for (const ev of Array.isArray(evidence) ? evidence : []) {
    if (!ev || ev.visual_required !== true) continue;
    const value = inertValue(ev.source_value);
    const normalized = normalizePropValue(ev.source_value);
    if (!value || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ value, normalized });
  }
  return out;
}

/**
 * Build the Bible's prop set for one book: one sheet per DISTINCT
 * visual_required evidence value (parallel, bounded) plus the theme
 * companion's sheet when the companion is drawable. Never throws: every
 * unavailable sheet becomes a `propSheet` advisory (only while the switch
 * is ON — a disabled layer is a deliberate choice, not a defect).
 * @param {object} params
 * @param {Array<object>} params.evidence personalization_evidence records
 * @param {object} params.theme catalog theme ({theme_id, display_name, world_name, companion})
 * @param {object} [params.costTracker]
 * @param {(level: string, msg: string) => void} [params.log]
 * @returns {Promise<{props: Array<{value: string, sheet: object|null}>, companion: object|null,
 *   advisories: Array<{stage: 'propSheet', note: string}>}>}
 */
async function getBibleProps({ evidence, theme, costTracker, log = () => {} }) {
  const advisories = [];
  try {
    if (!flags.propSheetsEnabled()) return { props: [], companion: null, advisories };
    const limit = pLimit(PROP_CONCURRENCY);
    const distinct = distinctVisualProps(evidence);
    const propTasks = distinct.map(({ value }) => limit(async () => ({
      value,
      sheet: await getPropSheet({ kind: 'prop', value, theme, costTracker, log }),
    })));
    const drawable = isDrawableCompanion(theme?.companion);
    const companionTask = drawable
      ? limit(() => getPropSheet({ kind: 'companion', companion: theme.companion, theme, costTracker, log }))
      : Promise.resolve(null);
    const [props, companion] = await Promise.all([Promise.all(propTasks), companionTask]);
    for (const p of props) {
      if (!p.sheet) advisories.push({ stage: 'propSheet', note: `prop sheet unavailable for "${p.value}" — the prop renders as a plain noun` });
    }
    if (drawable && !companion) {
      advisories.push({ stage: 'propSheet', note: `companion sheet unavailable for "${cleanCompanion(theme.companion).name}" — the companion renders as a plain noun` });
    }
    return { props, companion, advisories };
  } catch (err) {
    log('warn', `bible props unavailable (${err.message}) — rendering without prop sheets`);
    advisories.push({ stage: 'propSheet', note: `prop sheets unavailable (${err.message}) — props render as plain nouns` });
    return { props: [], companion: null, advisories };
  }
}

module.exports = {
  getPropSheet,
  getBibleProps,
  isDrawableCompanion,
  renderPropSpecText,
  sanitizePropSpec,
  buildPropSheetPrompt,
  buildCompanionSheetPrompt,
  normalizePropValue,
  propSheetPath,
  companionSheetPath,
};
