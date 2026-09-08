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
 *
 * SECONDARY CHARACTERS (ce-19): a HUMAN companion (Farmer Bea, Builder
 * Sam — the catalog's two adult guides, and any person-typed companion an
 * overlay patches in) gets a sheet too. Before ce-19 `isDrawableCompanion`
 * EXCLUDED every human role (the renderer forbade inventing adult faces),
 * so the two human-guide themes rendered their companion as a bare noun:
 * no pixels, no spec, no `look_match` check, no set gate — a different
 * farmer on every spread. The person path differs from the creature path
 * only where a person's drift lives: the sheet prompt asks for one
 * fictional PERSON full-body in two views (no child, no other people),
 * the content check expects exactly that, and the spec is a CHARACTER
 * spec (apparent age, build, skin tone, hair, face, outfit garment by
 * garment, dominant hex colours, marks) rendered to one inert sentence.
 * Kill-switch: CATALOG_HUMAN_COMPANION_SHEET=0 restores the noun-only
 * behaviour for person-typed companions (creature sheets unaffected).
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
const { VERSION: STORY_OBJECT_VERSION, designText, hash: objectHash } = require('../storyObjects');
const { resolveReferenceContract, referenceRules, pending } = require('../referenceContract');
const { judgeImage } = require('../../../shared/llm/visualJudge');
const { isHumanCompanionType, isChildCompanionType } = require('../../../shared/illustration/companionKind');

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
/** The character spec (ce-19) names more slots than an object's — a wider sentence cap, same trimming rule. */
const CHARACTER_SPEC_TEXT_MAX_CHARS = 420;
const CHARACTER_OUTFIT_MAX = 5;
const CHARACTER_FACE_MAX = 3;
const CHARACTER_MARKS_MAX = 3;

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
/** The character spec's closed vocabularies (ce-19) — the only age/build words that can reach a prompt. */
const CHARACTER_KIND = 'person';
const AGE_VOCAB = ['child', 'teen', 'young-adult', 'adult', 'middle-aged', 'elderly'];
const AGE_DEFAULT = 'adult';
const AGE_WORDS = {
  child: 'a child',
  teen: 'a teenager',
  'young-adult': 'a young adult',
  adult: 'an adult',
  'middle-aged': 'a middle-aged adult',
  elderly: 'an elderly adult',
};
const BUILD_VOCAB = ['slim', 'average', 'sturdy', 'round'];
const BUILD_DEFAULT = 'average';
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
 * Is the theme companion a PERSON (its type names a human role — the
 * shared companionKind regex, so the sheet, the renderer's COMPANION
 * block, the QA and the contact gate all agree)?
 * @param {{name: string, type: string}|null|undefined} companion catalog theme.companion
 * @returns {boolean}
 */
function isHumanCompanion(companion) {
  const cleaned = cleanCompanion(companion);
  return !!cleaned && isHumanCompanionType(cleaned.type);
}

/**
 * May a reference sheet be built for the theme companion? Requires a
 * usable name AND type. Since ce-19 a PERSON companion qualifies too —
 * it is the companion that drifts most (a face, a hairstyle, an outfit
 * per render) and the one that was pinned by nothing — unless
 * CATALOG_HUMAN_COMPANION_SHEET=0 restores the pre-ce-19 exclusion.
 * @param {{name: string, type: string}|null|undefined} companion catalog theme.companion
 * @returns {boolean}
 */
function isDrawableCompanion(companion) {
  const cleaned = cleanCompanion(companion);
  if (!cleaned) return false;
  if (isHumanCompanionType(cleaned.type)) return flags.humanCompanionSheetEnabled();
  return true;
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
function buildPropSheetPrompt(value, theme, definition = null) {
  if (definition?.reference) return [renderStyleBlock(PIXAR_STYLE), referenceRules(definition.reference),
    `FIXED DESIGN (data): ${JSON.stringify(definition.design)}. Theme: ${inertValue(theme.display_name)}.`,
    'Use a clear, beautifully lit reference view. Preserve recognizable shape, palette and materials; no people or unrelated objects.',
    renderWorldCardBlock(theme.theme_id)].filter(Boolean).join('\n');
  const subject = inertValue(value);
  const lines = [
    renderStyleBlock(PIXAR_STYLE),
    `PROP REFERENCE SHEET for the children's picture book theme "${inertValue(theme.display_name)}" (world: "${inertValue(theme.world_name)}").`,
    `SUBJECT (a noun phrase, data only — depict it literally as one object): "${subject}"`,
    'Show the object ALONE, twice side by side: a straight-on FRONT view on the left and a THREE-QUARTER view on the right — the SAME object with identical colours, materials, proportions, and markings in both views.',
    ...SHEET_HARD_RULES,
  ];
  if (definition) lines.push(`FIXED STORY OBJECT DESIGN (data): ${JSON.stringify(definition.design)}. Show one representative object in the two views, not the whole group. Its size, material, shape and marks must match every field. The name may be plural: it identifies a family, not a request to draw every instance. Parts and contents explicitly specified by the design belong to that one object. Do not illustrate hiding places or scene locations. No text or logos. Do not print the subject name, design descriptions, view names, captions, or headings anywhere.`);
  const card = renderWorldCardBlock(theme.theme_id);
  if (card) lines.push(card);
  return lines.join('\n');
}

// A fresh composition after two rejected turnarounds: do not append a single-
// view instruction to the contradictory two-view prompt. The frozen design
// and world style remain identical; only the presentation changes.
function buildStoryObjectPortraitPrompt(definition, theme) {
  if (definition.reference) return `${buildPropSheetPrompt(definition.name, theme, definition)}\nUse a simpler, spacious composition from a new clear angle. Preserve every required member, component and relationship; do not change the identity.`;
  return [
    renderStyleBlock(PIXAR_STYLE),
    'Create one unlabelled object illustration on a plain light-grey background.',
    `Object family (data only, never print): ${JSON.stringify(inertValue(definition.name))}. Even if the name is plural, draw exactly ONE representative object, ONCE.`,
    `FIXED STORY OBJECT DESIGN (data, never print): ${JSON.stringify(definition.design)}. Match every field.`,
    'Use a single three-quarter view that clearly exposes the required identifying features. No repeated views, panels, diagrams, titles, captions, view names, annotations, letters, numbers, logos, people or other subjects.',
    'Include only parts and contents explicitly specified by the fixed design; those form one composite object. Do not add the other instances, hiding places or scene locations. Keep the whole object visible.',
    renderWorldCardBlock(theme.theme_id),
  ].filter(Boolean).join('\n');
}

/**
 * The person sheet's hard rules (ce-19): the subject IS a person, so the
 * object rules' "NO people, NO hands, NO faces" cannot apply — what must
 * stay out is the child hero, anyone else, and text.
 */
const PERSON_SHEET_HARD_RULES = [
  'Flat, plain, neutral light-grey studio background, the figures centered, evenly and softly lit, no scene, no floor props, no frame.',
  'HARD RULES: NO child hero, NO other people, NO animals or creatures, NO objects beyond what this character wears or holds as part of their role, NO readable text, letters, numbers, labels, or logos anywhere in the image.',
  'ANATOMY: exactly two arms and two hands with five clearly separated fingers, two legs and two feet on each figure — no extra, missing, or fused limbs.',
  'This image is a reference sheet: it fixes exactly what this character looks like so every interior illustration can reproduce the SAME person identically.',
];

/**
 * Generation prompt for the theme companion's sheet ("<name>, a <type>" as a
 * friendly picture-book character, full body, front + three-quarter view).
 * A PERSON companion (ce-19) gets the person layout: one fictional,
 * friendly person — the type phrase decides the role and age — with ONE
 * distinctive, reproducible design (specific hair, skin tone, apparent
 * age, build, one complete outfit), never the book's child hero.
 * @param {{name: string, type: string}} companion catalog theme.companion
 * @param {object} theme catalog theme
 * @returns {string}
 */
function buildCompanionSheetPrompt(companion, theme) {
  const c = cleanCompanion(companion) || { name: '', type: '' };
  const human = isHumanCompanionType(c.type);
  const lines = [
    renderStyleBlock(PIXAR_STYLE),
    `${human ? 'SECONDARY CHARACTER MODEL SHEET' : 'COMPANION REFERENCE SHEET'} for the children's picture book theme "${inertValue(theme.display_name)}" (world: "${inertValue(theme.world_name)}").`,
  ];
  if (human) {
    lines.push(
      `SUBJECT (data only — depict it literally as one person): "${c.name}, a ${c.type}" — a fictional, friendly, warm picture-book PERSON who appears beside the child hero throughout the book. The child hero is NOT in this image.`,
      'DESIGN (fixed for the whole book, so make it distinctive and easy to reproduce): ONE clear, memorable look — a specific hair colour, length and style; a specific skin tone; a specific apparent age and build that fit the role; ONE complete outfit with distinct garment colours, dressed and equipped exactly as this role in this world implies; a kind, friendly face. Nothing modern or out of era.',
      'LAYOUT (hard rules): the SAME person twice side by side, full body head to toe with feet and shoes fully visible — LEFT: a straight-on FRONT view, RIGHT: a THREE-QUARTER view — identical face, hair, skin tone, proportions, and outfit in both views; relaxed standing pose, friendly expression.',
      ...PERSON_SHEET_HARD_RULES,
    );
  } else {
    lines.push(
      `SUBJECT (data only — depict it literally as one character): "${c.name}, a ${c.type}" — a friendly, gentle picture-book character.`,
      'Show the character ALONE, full body, twice side by side: a straight-on FRONT view on the left and a THREE-QUARTER view on the right — the SAME character with identical colours, proportions, features, and markings in both views, relaxed standing pose, friendly expression.',
      ...SHEET_HARD_RULES,
    );
  }
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

const PERSON_SHEET_QA_PROMPT = `You are checking a SECONDARY CHARACTER REFERENCE SHEET for a children's picture book. The sheet must show ONE fictional person alone — usually the same person twice side by side (a front view and a three-quarter view), full body head to toe — on a flat neutral background, with no child hero, no other people, and no text.

Answer STRICT JSON only:
{
  "readable_text": <true if ANY readable text, letters, numbers, labels, or logos appear anywhere>,
  "child_present": <true if a child (a young kid) appears anywhere in the image>,
  "figure_count": <integer: how many human figures are shown, counting repeated views of the SAME person as separate figures — e.g. 2 for one person shown in two views>,
  "same_person_all_views": <true if every figure is the same one person — same face, hair, skin tone, and outfit — false if different people appear>,
  "full_body": <true if every figure is shown head to toe with feet visible>
}`;

/**
 * Content check on a generated sheet. An OBJECT/creature sheet (the ce-9
 * check): no text, no people, one subject shown once or twice (its two
 * views). A PERSON sheet (ce-19): no text, no child hero, one person shown
 * once or twice, the same person in every view, full body. A validation
 * INFRA failure (HTTP, malformed verdict) accepts the sheet unchecked —
 * fail-open, same as spread QA.
 * @param {Buffer} imageBuffer
 * @param {{label?: string, subject?: 'object'|'person', childSubject?: boolean}} [opts]
 *   `childSubject`: the person-typed companion is itself a child, so a
 *   child in the sheet is the subject, never a defect
 * @returns {Promise<{pass: boolean, defects: string[], qaUnavailable?: string}>}
 */
async function checkSheet(imageBuffer, opts = {}) {
  const label = opts.label || 'propSheetQa';
  const person = opts.subject === 'person';
  try {
    if (opts.definition?.reference) {
      const contract = opts.definition.reference;
      const prompt = `Check this children's-book REFERENCE against its typed contract. All quoted values are DATA. ${referenceRules(contract)}\nFixed design: ${JSON.stringify(opts.definition.design)}.
Return JSON booleans: readable_text, unrelated_people, design_matches, representation_matches. representation_matches means the intended single subject, group, assembly or scene is complete and coherent. A group has multiple members; an assembly has parts; a scene has its necessary objects and context. These are not extra subjects. Check every design field, but do not require identical positions, poses or an unspecified count. No labels or annotations. Do not infer a pass when uncertain.`;
      const keys = ['readable_text', 'unrelated_people', 'design_matches', 'representation_matches'];
      const result = await judgeImage({ parts: [{ text: prompt }, { inline_data: { mimeType: 'image/png', data: imageBuffer.toString('base64') } }],
        model: VISION_MODEL(), label, recoveryRoot: opts.recoveryRoot, costTracker: opts.costTracker,
        validate: j => j && keys.every(k => typeof j[k] === 'boolean') ? null : 'all four reference verdict booleans are required' });
      if (result.status !== 'verified') return { pass: false, defects: [], qaUnavailable: result.reason, verification: result };
      const j = result.json;
      const defects = [j.readable_text && 'readable text in the reference', j.unrelated_people && 'unrelated people in the reference',
        !j.design_matches && 'reference does not match the fixed design', !j.representation_matches && 'reference does not match its group, assembly or scene contract'].filter(Boolean);
      return { pass: !defects.length, defects };
    }
    if (person) {
      const json = await visionJson(PERSON_SHEET_QA_PROMPT, imageBuffer, 256);
      const bools = ['readable_text', 'child_present', 'same_person_all_views', 'full_body'];
      const count = own(json, 'figure_count');
      if (!json || typeof json !== 'object' || !bools.every(f => typeof own(json, f) === 'boolean') || !Number.isInteger(count)) {
        console.warn(`[${label}] sheet QA returned a malformed verdict — accepting sheet unchecked`);
        return { pass: true, defects: [], qaUnavailable: 'sheet QA returned a malformed verdict' };
      }
      // Fixed defect strings only — they are joined into the retry prompt.
      const defects = [
        own(json, 'readable_text') && 'readable text in the sheet',
        own(json, 'child_present') && !opts.childSubject && 'a child in the sheet',
        count < 1 && 'no person in the sheet',
        count > 2 && 'more than one person in the sheet',
        !own(json, 'same_person_all_views') && 'different people instead of one person in two views',
        !own(json, 'full_body') && 'the person is not shown full body head to toe',
      ].filter(Boolean);
      return { pass: defects.length === 0, defects };
    }
    const designCheck = opts.definition ? `\nAlso return a boolean design_matches: true ONLY when EVERY shown view matches ALL fields of this fixed design (data): ${JSON.stringify(opts.definition.design)}. Check shape, material, colours, relative proportions and distinctive marks. A single clear view is allowed. Count complete representative objects, not their constituent parts or contents explicitly specified by the design (for example, straw strands in a nest). Multiple separate nests or other family instances still count separately. A plural family name does not authorize a group. Text, labels and annotations remain forbidden.` : '';
    const json = await visionJson(SHEET_QA_PROMPT + designCheck, imageBuffer, 512);
    const bools = ['readable_text', 'people_present', 'single_subject_type'];
    if (opts.definition) bools.push('design_matches');
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
      count > (opts.singleView ? 1 : 2) && 'more than one subject in the sheet',
      !own(json, 'single_subject_type') && 'different objects instead of one subject in two views',
      opts.definition && !own(json, 'design_matches') && 'object does not match its fixed design',
    ].filter(Boolean);
    return { pass: defects.length === 0, defects };
  } catch (err) {
    console.warn(`[${label}] sheet QA failed to run (accepting sheet unchecked): ${err.message}`);
    return { pass: true, defects: [], qaUnavailable: `sheet QA errored: ${err.message}` };
  }
}

/** The corrective retry line after a failed content check, per subject kind. */
const SHEET_RETRY_NOTE = {
  object: 'Show ONLY the one subject (front view and three-quarter view), NO people, NO other objects, and NO readable text of any kind.',
  person: 'Show ONLY this one person (front view and three-quarter view, full body head to toe with feet visible), NO child, NO other people, NO animals, and NO readable text of any kind.',
};

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

const CHARACTER_SPEC_PROMPT = `You are extracting the CHARACTER SPEC for a children's picture book from its reference sheet (one person, shown in one or two views). The spec pins EXACTLY what this character looks like so an illustrator can reproduce the SAME person identically on every page. Describe ONLY what is visible; never describe the background.

Answer STRICT JSON only:
{
  "apparentAge": one of ${JSON.stringify(AGE_VOCAB)},
  "build": one of ${JSON.stringify(BUILD_VOCAB)},
  "skinTone": "<one short phrase, e.g. warm medium-brown>",
  "hair": "<one short phrase: colour, length, and style, e.g. long grey hair in two braids>",
  "face": ["<up to ${CHARACTER_FACE_MAX} short phrases for fixed facial features: glasses, beard, moustache, freckles, wrinkles, rosy cheeks, …>"],
  "outfit": ["<up to ${CHARACTER_OUTFIT_MAX} short garment phrases, colour first, head to toe, e.g. cream linen shirt, blue denim overalls, brown leather boots, straw hat>"],
  "colourHex": ["<up to ${SPEC_COLOURS_MAX} #rrggbb hex values for the most dominant outfit colours, most dominant first>"],
  "distinguishingMarks": ["<up to ${CHARACTER_MARKS_MAX} short phrases: a badge, a tool belt, a red bandana, a walking stick, …>"]
}`;

/**
 * Validate + sanitize a model (or stored) CHARACTER spec answer (ce-19)
 * into the closed, inert shape — sanitizePropSpec's rules applied to a
 * person's slots: every string cleaned and capped, every list deduped and
 * capped, both enums defaulted, hex values validated, fixed keys only.
 * `name` is never taken from the model. Null when nothing usable survives
 * (a spec with neither hair nor a garment pins nothing).
 * @param {*} json the parsed answer
 * @param {{name: string}} identity
 * @returns {{name: string, kind: 'person', apparentAge: string, build: string, skinTone: string,
 *   hair: string, face: string[], outfit: string[], colourHex: string[], distinguishingMarks: string[]}|null}
 */
function sanitizeCharacterSpec(json, identity) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const name = inertValue(identity?.name);
  if (!name) return null;
  const ageRaw = cleanSpecText(own(json, 'apparentAge'), 20);
  const apparentAge = ageRaw && AGE_VOCAB.includes(ageRaw.toLowerCase()) ? ageRaw.toLowerCase() : AGE_DEFAULT;
  const buildRaw = cleanSpecText(own(json, 'build'), 20);
  const build = buildRaw && BUILD_VOCAB.includes(buildRaw.toLowerCase()) ? buildRaw.toLowerCase() : BUILD_DEFAULT;
  const skinTone = cleanSpecText(own(json, 'skinTone')) || '';
  const hair = cleanSpecText(own(json, 'hair'), SPEC_MARK_MAX_CHARS) || '';
  const face = cleanSpecList(own(json, 'face'), CHARACTER_FACE_MAX, SPEC_FIELD_MAX_CHARS);
  const outfit = cleanSpecList(own(json, 'outfit'), CHARACTER_OUTFIT_MAX, SPEC_FIELD_MAX_CHARS);
  if (!hair && outfit.length === 0) return null;
  const hexRaw = own(json, 'colourHex');
  const colourHex = [];
  for (const h of Array.isArray(hexRaw) ? hexRaw : []) {
    if (typeof h !== 'string') continue;
    const v = h.trim().toLowerCase();
    if (HEX_RE.test(v) && !colourHex.includes(v)) colourHex.push(v);
    if (colourHex.length >= SPEC_COLOURS_MAX) break;
  }
  const distinguishingMarks = cleanSpecList(own(json, 'distinguishingMarks'), CHARACTER_MARKS_MAX, SPEC_MARK_MAX_CHARS);
  return { name, kind: CHARACTER_KIND, apparentAge, build, skinTone, hair, face, outfit, colourHex, distinguishingMarks };
}

/**
 * Render a sanitized CHARACTER spec into ONE inert sentence for the
 * COMPANION block and the QA prompt, e.g. `Farmer Bea: an elderly adult of
 * sturdy build, warm medium-brown skin, long grey hair in two braids;
 * face: kind wrinkles, rosy cheeks; outfit: cream linen shirt, blue denim
 * overalls, brown leather boots (#e8dcc0, #4a6a9a); red bandana.`
 * Deterministic. Fits CHARACTER_SPEC_TEXT_MAX_CHARS whole: trailing marks,
 * then face notes, then hex values, then trailing outfit items are dropped
 * until it fits, and a final hard cap guards the rest.
 * @param {object} spec a sanitizeCharacterSpec result
 * @returns {string} '' when the spec carries no usable name
 */
function renderCharacterSpecText(spec) {
  const name = inertValue(spec?.name);
  if (!name) return '';
  const age = AGE_WORDS[spec.apparentAge] || AGE_WORDS[AGE_DEFAULT];
  const build = BUILD_VOCAB.includes(spec.build) ? spec.build : BUILD_DEFAULT;
  const skinTone = cleanSpecText(spec.skinTone);
  const hair = cleanSpecText(spec.hair, SPEC_MARK_MAX_CHARS);
  const faceAll = cleanSpecList(spec.face, CHARACTER_FACE_MAX, SPEC_FIELD_MAX_CHARS);
  const outfitAll = cleanSpecList(spec.outfit, CHARACTER_OUTFIT_MAX, SPEC_FIELD_MAX_CHARS);
  const hexAll = (Array.isArray(spec.colourHex) ? spec.colourHex : [])
    .filter(h => typeof h === 'string' && HEX_RE.test(h))
    .map(h => h.toLowerCase())
    .slice(0, SPEC_COLOURS_MAX);
  const marksAll = cleanSpecList(spec.distinguishingMarks, CHARACTER_MARKS_MAX, SPEC_MARK_MAX_CHARS);
  const render = (outfit, hex, face, marks) => {
    const head = [`${name}: ${age} of ${build} build`];
    if (skinTone) head.push(`${skinTone} skin`);
    if (hair) head.push(hair);
    const clauses = [head.join(', ')];
    if (face.length > 0) clauses.push(`face: ${face.join(', ')}`);
    if (outfit.length > 0) clauses.push(`outfit: ${outfit.join(', ')}${hex.length > 0 ? ` (${hex.join(', ')})` : ''}`);
    if (marks.length > 0) clauses.push(marks.join(', '));
    return `${clauses.join('; ')}.`;
  };
  // Drop order: marks (decoration) → face notes → hex → trailing garments;
  // the head (age, build, skin, hair) and the first garments are the
  // identity and always stay.
  for (let keepOutfit = outfitAll.length; keepOutfit >= Math.min(1, outfitAll.length); keepOutfit -= 1) {
    for (const hex of [hexAll, []]) {
      for (let keepFace = faceAll.length; keepFace >= 0; keepFace -= 1) {
        for (let keepMarks = marksAll.length; keepMarks >= 0; keepMarks -= 1) {
          const text = render(outfitAll.slice(0, keepOutfit), hex, faceAll.slice(0, keepFace), marksAll.slice(0, keepMarks));
          if (text.length <= CHARACTER_SPEC_TEXT_MAX_CHARS) return text;
        }
      }
    }
    if (outfitAll.length === 0) break;
  }
  return render([], [], [], []).slice(0, CHARACTER_SPEC_TEXT_MAX_CHARS);
}

/**
 * Sanitize a spec answer by the identity's spec kind: the CHARACTER shape
 * for a person (ce-19), the object shape for everything else.
 * @param {*} json @param {{name: string, kind: string, specKind?: 'object'|'character'}} identity
 * @returns {object|null}
 */
function sanitizeSpecFor(json, identity) {
  return identity?.specKind === 'character' ? sanitizeCharacterSpec(json, identity) : sanitizePropSpec(json, identity);
}

/**
 * Render a sanitized spec (either shape) into its inert sentence.
 * @param {object} spec
 * @returns {string}
 */
function renderSpecText(spec) {
  return spec && spec.kind === CHARACTER_KIND ? renderCharacterSpecText(spec) : renderPropSpecText(spec);
}

/**
 * One vision read of the ELECTED sheet → sanitized spec. Throws when the
 * answer is unusable (the caller fails open with a cooldown).
 * @param {Buffer} sheetBuffer
 * @param {{name: string, kind: 'prop'|'companion', specKind?: 'object'|'character'}} identity
 * @returns {Promise<object>}
 */
async function deriveSpec(sheetBuffer, identity) {
  const character = identity?.specKind === 'character';
  const json = await visionJson(character ? CHARACTER_SPEC_PROMPT : SPEC_PROMPT, sheetBuffer, 512);
  const spec = sanitizeSpecFor(json, identity);
  if (!spec) throw new Error('spec vision returned no usable spec');
  return spec;
}

/**
 * Parse a stored `.json` spec blob (data — re-sanitized through the same
 * validator).
 * @param {Buffer} buffer @param {{name: string, kind: string, specKind?: string}} identity
 * @returns {object|null}
 */
function parseStoredSpec(buffer, identity) {
  try {
    const blob = JSON.parse(buffer.toString('utf8'));
    return sanitizeSpecFor(own(blob, 'spec'), identity);
  } catch {
    return null;
  }
}

/**
 * Assemble the resolved sheet record from elected bytes + elected spec.
 * A companion record also carries its catalog `type` and `human` (ce-19)
 * so the prompt blocks, the QA and the contact gate phrase a person as a
 * person without re-deriving it.
 * @param {{key: string, kind: string, buffer: Buffer, storageKey: string, spec: object, type?: string|null, human?: boolean}} p
 * @returns {object}
 */
function toSheet({ key, kind, buffer, storageKey, spec, type = null, human = false }) {
  const base64 = buffer.toString('base64');
  const specText = renderSpecText(spec);
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
    ...(kind === 'companion' ? { type, human: !!human } : {}),
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
 * @param {{name: string, kind: string, specKind?: 'object'|'character'}} p.identity spec identity
 * @param {'object'|'person'} [p.subject] what the content check expects (default object)
 * @param {boolean} [p.childSubject] the person subject is itself a child
 * @param {{type: string|null, human: boolean}} [p.companionMeta] carried onto a companion record
 * @param {object} [p.costTracker]
 * @param {(level: string, msg: string) => void} p.log
 * @returns {Promise<object|null>}
 */
function resolveSheet({ cacheKey, kind, key, pngPath, prompt, identity, definition = null, fallbackPrompt = null, subject = 'object', childSubject = false, companionMeta = null, costTracker, log }) {
  const hit = cacheGet(cacheKey);
  if (hit) return Promise.resolve(hit);
  if (inFailureCooldown(cacheKey)) return Promise.resolve(null);
  if (_inFlight.has(cacheKey)) return _inFlight.get(cacheKey);
  const label = `${kind} sheet '${key}'`;
  const specPath = specPathFor(pngPath);
  const retryNote = SHEET_RETRY_NOTE[subject] || SHEET_RETRY_NOTE.object;
  const verify = async (buffer, suffix = '', singleView = false) => {
    const opts = { label: `propSheetQa:${key}${suffix}`, subject, childSubject, definition, singleView,
      recoveryRoot: definition?.reference ? `${pngPath}.verification` : null, costTracker };
    let verdict = await checkSheet(buffer, opts);
    if (definition?.reference && verdict.qaUnavailable) throw pending(`Reference verification needs attention for ${definition.name}; saved images retained.`, verdict.verification);
    if (definition && verdict.qaUnavailable) {
      log('warn', `${label} could not be verified (${verdict.qaUnavailable}) — retrying QA on the same image`);
      verdict = await checkSheet(buffer, opts);
      if (verdict.qaUnavailable) {
        log('warn', `${label} verification unavailable after retry (${verdict.qaUnavailable})`);
        recordFailure(cacheKey);
      }
    }
    return verdict;
  };

  const resolve = (async () => {
    try {
      let elected = await downloadBuffer(pngPath).catch(err => {
        if (!definition?.reference || err.code === 404 || /not found|No such object/i.test(err.message)) return null;
        throw err;
      });
      if (!elected) {
        log('info', `${label} not cached — generating (${pngPath})`);
        const generate = async (text, attempt) => {
          if (!definition?.reference) return renderSheetImage(text);
          const candidateKey = `${pngPath}.candidates/${attempt}.png`;
          const prior = await downloadBuffer(candidateKey).catch(err => {
            if (err.code === 404 || /not found|No such object/i.test(err.message)) return null;
            throw err;
          });
          if (prior) { costTracker?.recordReuse?.('reference', candidateKey); return prior; }
          const claim = await uploadBufferIfAbsent(Buffer.from(JSON.stringify({ at: new Date().toISOString() })), `${candidateKey}.claim.json`, 'application/json');
          if (!claim.created) {
            const saved = JSON.parse((await downloadBuffer(`${candidateKey}.claim.json`)).toString());
            const expired = !Number.isFinite(Date.parse(saved.at)) || Date.now() - Date.parse(saved.at) > 15 * 60000;
            throw pending(`Reference generation already reserved for ${definition.name}; saved work retained.`, { status: 'transient', reason: expired ? 'Reference attempt interrupted; review saved candidates' : 'Reference candidate pending', exhausted: expired, evidenceKey: `${pngPath}.candidates/` });
          }
          const made = await renderSheetImage(text);
          costTracker?.addImageGeneration(GEMINI_MODEL, 1);
          await uploadBufferIfAbsent(made, candidateKey, 'image/png');
          return made;
        };
        let buffer = await generate(prompt, 0);
        if (costTracker && !definition?.reference) costTracker.addImageGeneration(GEMINI_MODEL, 1);
        // Enforce the subject-only invariant BEFORE the sheet can be elected
        // or cached: text, a person, or a second object in the sheet would
        // contaminate every spread that references it. One corrective retry.
        let verdict = await verify(buffer);
        if (definition && verdict.qaUnavailable) return null;
        if (!verdict.pass) {
          log('warn', `${label} failed the content check (${verdict.defects.join('; ')}) — one corrective retry`);
          buffer = await generate(`${prompt}\nPREVIOUS ATTEMPT REJECTED — it contained: ${verdict.defects.join('; ')}. ${definition?.reference ? referenceRules(definition.reference) : retryNote}`, 1);
          if (costTracker && !definition?.reference) costTracker.addImageGeneration(GEMINI_MODEL, 1);
          verdict = await verify(buffer, ':retry');
          if (definition && verdict.qaUnavailable) return null;
          if (!verdict.pass && fallbackPrompt) {
            log('warn', `${label} still fails the content check (${verdict.defects.join('; ')}) — trying one unlabelled single-view reference`);
            buffer = await generate(fallbackPrompt, 2);
            if (costTracker && !definition?.reference) costTracker.addImageGeneration(GEMINI_MODEL, 1);
            verdict = await verify(buffer, ':portrait', true);
            if (verdict.qaUnavailable) return null;
          }
          if (!verdict.pass) {
            if (definition?.reference) throw pending(`Reference design needs review for ${definition.name}; three candidates are saved.`, { status: 'confirmed_defect', reason: verdict.defects.join('; '), exhausted: true, evidenceKey: `${pngPath}.candidates/` });
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
      if (definition?.reference) {
        const verdict = await verify(elected);
        if (!verdict.pass) throw pending(`Saved reference needs review for ${definition.name}.`, { status: 'confirmed_defect', reason: verdict.defects.join('; '), exhausted: true, evidenceKey: pngPath });
      }
      const spec = definition?.reference ? { specText: designText(definition), specHash: objectHash(definition.design) } : await electSpec(elected, specPath, identity, imageHash, log);
      if (!spec) {
        log('warn', `${label}: no usable spec could be elected — rendering without a sheet`);
        recordFailure(cacheKey);
        return null;
      }
      const sheet = toSheet({ key, kind, buffer: elected, storageKey: pngPath, spec, ...(companionMeta || {}) });
      // The authored/elected design remains authoritative; a vision summary
      // must never silently replace the story's stripe, size or shape.
      if (definition) {
        sheet.specText = designText(definition);
        sheet.specHash = objectHash(definition.design);
        sheet.reference = definition.reference || null;
      }
      cacheSet(cacheKey, sheet);
      return sheet;
    } catch (err) {
      if (err.recovery) throw err;
      if (definition?.reference) throw pending(`Reference recovery needs attention for ${definition.name}; saved work retained.`, { status: 'configuration', reason: 'Reference storage or generation unavailable' });
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
async function getPropSheet({ kind, value, companion, theme, definition = null, costTracker, log = () => {} }) {
  try {
    if (!flags.propSheetsEnabled()) return null;
    const themeId = safeThemeId(theme?.theme_id);
    if (!themeId || !theme.world_name) return null;
    if (kind === 'prop') {
      const inert = inertValue(value);
      const normalized = normalizePropValue(value);
      if (!inert || !normalized) return null;
      let valueHash = definition ? objectHash({ version: STORY_OBJECT_VERSION, name: normalized, design: definition.design }) : fnv1a(normalized).toString(36);
      if (definition) {
        // Existing elected references keep their identity. New or previously
        // failed references get an explicit representation before image spend.
        const existing = await downloadBuffer(propSheetPath(themeId, valueHash)).catch(err => {
          if (err.code === 404 || /not found|No such object/i.test(err.message)) return null;
          throw err;
        });
        if (!existing || definition.reference) {
          const reference = await resolveReferenceContract(definition, costTracker);
          definition = { ...definition, reference };
          if (!existing || reference.kind !== 'single') valueHash = objectHash({ base: valueHash, reference, v: 1 });
        }
      }
      return resolveSheet({
        cacheKey: `prop:${themeId}:${valueHash}`,
        kind,
        key: normalized,
        pngPath: propSheetPath(themeId, valueHash),
        prompt: buildPropSheetPrompt(definition ? definition.name : value, theme, definition),
        fallbackPrompt: definition ? buildStoryObjectPortraitPrompt(definition, theme) : null,
        definition,
        identity: { name: inert, kind },
        costTracker,
        log,
      });
    }
    if (kind === 'companion') {
      if (!isDrawableCompanion(companion)) return null;
      const c = cleanCompanion(companion);
      const human = isHumanCompanionType(c.type);
      const prompt = buildCompanionSheetPrompt(c, theme);
      const promptHash = fnv1a(prompt).toString(36);
      return resolveSheet({
        cacheKey: `companion:${themeId}:${promptHash}`,
        kind,
        key: c.name,
        pngPath: companionSheetPath(themeId, promptHash),
        prompt,
        // A person gets the CHARACTER spec (age, build, skin, hair, face,
        // outfit) — the words a person drifts in; a creature keeps the
        // object spec (colours, material, size, markings).
        identity: { name: c.name, kind, specKind: human ? 'character' : 'object' },
        subject: human ? 'person' : 'object',
        childSubject: human && isChildCompanionType(c.type),
        companionMeta: { type: c.type, human },
        costTracker,
        log,
      });
    }
    return null;
  } catch (err) {
    if (err.recovery) throw err;
    if (definition) throw pending(`Reference recovery needs attention for ${definition.name}; saved story retained.`, { status: 'configuration', reason: 'Reference planning or storage unavailable' });
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
  isHumanCompanion,
  renderPropSpecText,
  sanitizePropSpec,
  sanitizeCharacterSpec,
  renderCharacterSpecText,
  buildPropSheetPrompt,
  buildCompanionSheetPrompt,
  normalizePropValue,
  propSheetPath,
  companionSheetPath,
};
