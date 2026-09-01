/**
 * Light spread QA — ONE vision check per render, one corrective retry,
 * then ship-with-advisory. The closed critical list is intentionally tiny
 * (the parent test): the text check, missing child, duplicated child, or a
 * broken medium (flat 2D / photo look). Everything else ships and is
 * fixable post-hoc; no judge panels, no likeness tribunal.
 *
 * The text check is LAYOUT-AWARE (2026-08-31): a caption-layout render must
 * contain NO painted words (text lives on caption pages); an embedded-layout
 * render must contain the story text painted into the art — the same vision
 * call transcribes it and compareTexts verifies it against the manuscript
 * (missing or garbled painted text is the defect, not its presence).
 *
 * Embedded typography is gated too (ce-4): the painted block must read as
 * typeset text — straight, level, left-aligned lines with even spacing
 * (`text_lines_misaligned`), in ONE font/size/color (`text_style_inconsistent`).
 * Cross-spread sameness is enforced upstream by pinning the identical
 * TEXT_RULES spec on every stateless render; QA checks each render against
 * that same fixed spec, so spreads that each pass also match each other.
 */

const sharp = require('sharp');
const { fetchWithTimeout, getNextApiKey, compareTexts } = require('../../illustrationGenerator');

const QA_MODEL = () => process.env.CATALOG_QA_VISION_MODEL || 'gemini-2.5-flash';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';

const QA_PROMPT = `You are checking one interior illustration of a children's picture book.
The book's ONE child hero must appear exactly once; the art must contain no
readable text; the medium must be premium 3D CGI (like a modern animated
feature film still), never flat 2D, watercolor, or a photograph.

Answer STRICT JSON only:
{
  "readable_text": true|false,   // any readable words, letters, or numbers painted in the image
  "child_absent": true|false,    // no child hero visible at all
  "multiple_children": true|false, // two or more distinct child heroes (ignore background adults/animals; a reflection or photo-within-scene of the same child is fine)
  "flat_or_photo_style": true|false // flat 2D / painterly / watercolor / line art, OR a live-action photograph look
}`;

/**
 * Embedded-layout variant of the QA prompt: the story text is REQUIRED in
 * the art, and the model transcribes what it can read so the caller can
 * verify it against the manuscript. `expectedText` is validated story prose
 * (storyValidation ran before any render), quoted as data.
 * @param {string} expectedText
 * @returns {string}
 */
function embeddedQaPrompt(expectedText) {
  return `You are checking one interior illustration of a children's picture book.
The book's ONE child hero must appear exactly once; the story text below
MUST be painted into the artwork, crisp and readable; the medium must be
premium 3D CGI (like a modern animated feature film still), never flat 2D,
watercolor, or a photograph.

The text must be ONE block on ONE side of the image (left or right),
painted directly over the artwork. Text split into blocks on BOTH the left
and right sides, or text sitting on a blank/solid/lightened band or strip
(letterboxing) instead of over continuous artwork, is a placement defect.

The painted text must also look professionally TYPESET: every line straight,
level, and horizontal; all lines left-aligned to one shared straight left
margin; even line spacing throughout. Tilted, arched, or wavy lines, a
drifting left edge, or visibly uneven line gaps are an alignment defect.
The whole block must use ONE single font family, ONE size, and ONE fill
color — mixed typefaces, mixed sizes/weights, or mixed colors within the
text are a typography defect.

STORY TEXT THAT MUST APPEAR IN THE IMAGE:
"${expectedText}"

Answer STRICT JSON only:
{
  "readable_text": true|false,   // any readable words visible in the image
  "visible_text": "…",           // the exact text you can read in the image, verbatim ("" if none)
  "text_split_both_sides": true|false, // text appears in separate blocks on BOTH the left and right sides of the image
  "text_on_band": true|false,    // text sits on a blank, solid, or lightened band/strip/panel (letterbox) instead of being painted over the artwork
  "text_lines_misaligned": true|false, // any text line is tilted, arched, or wavy; the lines do not share one straight left margin; or the line spacing is visibly uneven
  "text_style_inconsistent": true|false, // the painted text mixes more than one font family, size, weight, or fill color
  "child_absent": true|false,    // no child hero visible at all
  "multiple_children": true|false, // two or more distinct child heroes (ignore background adults/animals; a reflection or photo-within-scene of the same child is fine)
  "flat_or_photo_style": true|false // flat 2D / painterly / watercolor / line art, OR a live-action photograph look
}`;
}

/**
 * Run the QA check on one rendered spread.
 * @param {Buffer} imageBuffer
 * @param {{label?: string, expectedText?: string|null}} [opts]
 *   `expectedText` set = embedded layout: the story text must be painted in
 *   the art and is verified against the manuscript; null/absent = caption
 *   layout: any painted text is the defect.
 * @returns {Promise<{pass: boolean, defects: string[], qaUnavailable?: string}>}
 *   pass=true also on QA infra errors (never block on the checker itself),
 *   but such a pass carries `qaUnavailable` so the spread ships with an
 *   explicit unchecked-advisory instead of reporting silently clean.
 */
async function checkSpreadRender(imageBuffer, opts = {}) {
  const label = opts.label || 'spreadQa';
  const expectedText = typeof opts.expectedText === 'string' && opts.expectedText.trim()
    ? opts.expectedText.trim()
    : null;
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
              { text: expectedText ? embeddedQaPrompt(expectedText) : QA_PROMPT },
              { inline_data: { mimeType: 'image/png', data: imageBuffer.toString('base64') } },
            ],
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 512, responseMimeType: 'application/json' },
        }),
      },
      60000,
    );
    if (!resp.ok) {
      console.warn(`[${label}] QA HTTP ${resp.status} — passing without QA`);
      return { pass: true, defects: [], qaUnavailable: `vision QA HTTP ${resp.status}` };
    }
    const data = await resp.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    const json = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
    // A syntactically valid but incomplete verdict (e.g. {}) must not read
    // as a clean pass — every check field has to be an explicit boolean.
    // (`visible_text` is a best-effort string, not a gate: a verdict without
    // it still counts, it just can't be accuracy-checked.)
    const FIELDS = ['readable_text', 'child_absent', 'multiple_children', 'flat_or_photo_style'];
    if (expectedText) FIELDS.push('text_split_both_sides', 'text_on_band', 'text_lines_misaligned', 'text_style_inconsistent');
    if (!json || typeof json !== 'object' || !FIELDS.every(f => typeof json[f] === 'boolean')) {
      console.warn(`[${label}] QA returned a malformed verdict — passing without QA`);
      return { pass: true, defects: [], qaUnavailable: 'vision QA returned a malformed verdict' };
    }
    const defects = [
      json.child_absent && 'child hero missing from the scene',
      json.multiple_children && 'duplicated child hero',
      json.flat_or_photo_style && 'style break: flat/2D or photographic medium',
    ].filter(Boolean);
    if (expectedText) {
      // Embedded layout: the painted text is REQUIRED, must match, and must
      // sit as ONE block on ONE side, over the artwork — never split across
      // both sides or letterboxed onto a blank band — typeset as straight
      // aligned lines in one font, one size, one color (ce-4).
      if (!json.readable_text) {
        defects.push('embedded story text missing from the image');
      } else {
        if (typeof json.visible_text === 'string' && json.visible_text.trim()) {
          const cmp = compareTexts(expectedText, json.visible_text);
          if (!cmp.valid) defects.push(`embedded story text garbled: ${cmp.issues.join('; ')}`);
        }
        if (json.text_split_both_sides) defects.push('embedded story text split across both sides of the image');
        if (json.text_on_band) defects.push('embedded story text sits on a blank band instead of over the artwork');
        if (json.text_lines_misaligned) defects.push('embedded story text lines misaligned (tilted, wavy, no shared left margin, or uneven spacing)');
        if (json.text_style_inconsistent) defects.push('embedded story text mixes fonts, sizes, or colors');
      }
    } else if (json.readable_text) {
      defects.push('painted text in the illustration');
    }
    return { pass: defects.length === 0, defects };
  } catch (err) {
    console.warn(`[${label}] QA failed to run (passing without QA): ${err.message}`);
    return { pass: true, defects: [], qaUnavailable: `vision QA errored: ${err.message}` };
  }
}

// ── Book-level world-consistency gate (Layer 3 of the world design) ────────
// One multi-image call over ALL of a run's renders together: the per-spread
// check above cannot see cross-spread drift (each render passes alone while
// the set disagrees on palette, era, lighting, or physics). Same advisory
// conventions as checkSpreadRender: an infra failure passes with
// `qaUnavailable`, never blocks a book on the checker itself.

const WORLD_QA_MAX_IMAGES = 12;
// World judging reads low-frequency features (palette, lighting, era,
// materials), so the gate sends downscaled JPEG thumbnails: twelve
// full-size base64 PNGs can blow the API's inline-request limit and fail
// the gate open exactly on the biggest books.
const WORLD_QA_THUMB_WIDTH = 768;

/**
 * Downscale one render for the multi-image gate call. Falls back to the
 * original bytes if the resize fails — the gate itself stays fail-open.
 * @param {Buffer} buffer
 * @returns {Promise<{data: string, mimeType: string}>}
 */
async function qaThumbnail(buffer) {
  try {
    const thumb = await sharp(buffer)
      .resize({ width: WORLD_QA_THUMB_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();
    return { data: thumb.toString('base64'), mimeType: 'image/jpeg' };
  } catch {
    return { data: buffer.toString('base64'), mimeType: 'image/png' };
  }
}

/**
 * @param {number[]} spreads the spread numbers attached, in order
 * @returns {string}
 */
function worldQaPrompt(spreads) {
  return `You are checking WORLD CONSISTENCY across ${spreads.length} interior illustrations of ONE children's picture book (spreads ${spreads.join(', ')}, each labeled before its image).

All spreads take place in the SAME fixed world. Judge ONLY whether they read
as one world: the same palette family and lighting character, the same era
and technology level, the same materials and environment logic, and the same
physical or magical laws applied to every interaction between characters,
objects, and the environment.

DO NOT flag differences in scene, action, location within the world, camera
angle, composition, pose, or time of day that the story moment explains —
those are supposed to differ. Flag a spread only when it clearly BREAKS the
shared world: a different palette/lighting family, an era or technology that
contradicts the others, materials or physics behaving differently, or magic
appearing/behaving unlike the rest of the book.

Answer STRICT JSON only:
{
  "consistent": true|false,        // the set reads as ONE world
  "flagged": [                      // ONLY spreads that clearly break the world ([] if consistent)
    {
      "spread": <number>,
      "defect": "palette_lighting"|"era_technology"|"materials_physics"|"magic_behavior"|"other",
      "note": "ONE specific sentence: what breaks and what the other spreads establish"
    }
  ]
}`;
}

/** Closed vocabulary of world-break classes the gate can act on. */
const WORLD_DEFECTS = new Set(['palette_lighting', 'era_technology', 'materials_physics', 'magic_behavior', 'other']);

/**
 * Run the book-level world-consistency check across one run's renders.
 * @param {Array<{spread: number, buffer: Buffer}>} entries
 * @param {{label?: string}} [opts]
 * @returns {Promise<{pass: boolean, flagged: Array<{spread: number, note: string}>, qaUnavailable?: string}|null>}
 *   null when fewer than 2 entries (consistency needs a comparison — a
 *   single-spread probe correctly skips the gate). Infra errors pass with
 *   `qaUnavailable`, matching checkSpreadRender.
 */
async function checkWorldConsistency(entries, opts = {}) {
  const label = opts.label || 'worldQa';
  if (!Array.isArray(entries) || entries.length < 2) return null;
  const subset = entries.slice(0, WORLD_QA_MAX_IMAGES);
  try {
    const parts = [{ text: worldQaPrompt(subset.map(e => e.spread)) }];
    for (const e of subset) {
      const thumb = await qaThumbnail(e.buffer);
      parts.push({ text: `SPREAD ${e.spread}:` });
      parts.push({ inline_data: { mimeType: thumb.mimeType, data: thumb.data } });
    }
    const apiKey = getNextApiKey();
    const resp = await fetchWithTimeout(
      `${GEMINI_API}/${QA_MODEL()}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0, maxOutputTokens: 1024, responseMimeType: 'application/json' },
        }),
      },
      90000,
    );
    if (!resp.ok) {
      console.warn(`[${label}] world QA HTTP ${resp.status} — passing without world QA`);
      return { pass: true, flagged: [], qaUnavailable: `world QA HTTP ${resp.status}` };
    }
    const data = await resp.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    const json = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
    if (!json || typeof json !== 'object' || typeof json.consistent !== 'boolean' || !Array.isArray(json.flagged)) {
      console.warn(`[${label}] world QA returned a malformed verdict — passing without world QA`);
      return { pass: true, flagged: [], qaUnavailable: 'world QA returned a malformed verdict' };
    }
    // Only spreads actually in this check can be flagged; a hallucinated
    // spread number is dropped, never acted on, and duplicates collapse to
    // the first entry — one correction per flagged spread, never a budget
    // spent re-rendering the same spread twice. The defect is validated
    // against the CLOSED vocabulary (out-of-set values become 'other'):
    // only the enum drives the repair prompt, while `note` stays free-form
    // DIAGNOSTIC data (advisories/callbacks) that never reaches a prompt.
    const known = new Set(subset.map(e => e.spread));
    const seen = new Set();
    const flagged = json.flagged
      .filter((f) => {
        if (!f || !known.has(f.spread) || seen.has(f.spread)) return false;
        seen.add(f.spread);
        return true;
      })
      .map(f => ({
        spread: f.spread,
        defect: WORLD_DEFECTS.has(f.defect) ? f.defect : 'other',
        note: typeof f.note === 'string' ? f.note.slice(0, 300) : 'breaks the shared world',
      }));
    return { pass: json.consistent && flagged.length === 0, flagged };
  } catch (err) {
    console.warn(`[${label}] world QA failed to run (passing without it): ${err.message}`);
    return { pass: true, flagged: [], qaUnavailable: `world QA errored: ${err.message}` };
  }
}

/**
 * FIXED corrective instructions per world-defect class. The generation
 * prompt only ever carries one of these pinned sentences — the vision
 * model's free-form `note` (which can echo painted profile/manuscript
 * text from the analyzed image) stays diagnostics-only and never reaches
 * a prompt: delimiters do not make instructions inert, a closed enum does.
 */
const WORLD_REPAIR_INSTRUCTIONS = {
  palette_lighting: 'Match the book\'s established palette family and lighting character exactly — the same hues, warmth, and light quality as the other spreads.',
  era_technology: 'Match the book\'s established era and technology level exactly — no objects, materials, or structures from a different period than the other spreads.',
  materials_physics: 'Match the book\'s established materials and physical laws exactly — surfaces, weights, and every interaction behave as they do on the other spreads.',
  magic_behavior: 'Match the book\'s established magical behavior exactly — magic appears and behaves only as it does on the other spreads.',
  other: 'Match the fixed world established by the other spreads exactly.',
};

/**
 * Corrective prompt suffix for a world-consistency gate re-render, built
 * ONLY from the closed defect vocabulary (unknown values map to 'other').
 * @param {string} defect one of WORLD_DEFECTS
 * @returns {string}
 */
function worldRepairNote(defect) {
  const fix = WORLD_REPAIR_INSTRUCTIONS[defect] || WORLD_REPAIR_INSTRUCTIONS.other;
  return `WORLD CONSISTENCY REPAIR — compared with the book's other spreads, this render broke the fixed world. ${fix} Re-render the SAME scene and action, obeying the WORLD LAWS above and the world reference. Fix ONLY the world/style break; keep the action, characters, and composition otherwise identical.`;
}

// ── World-plate content validation (Layer 2's invariant, enforced) ─────────
// The plate is a book-wide reference: a person, character, creature subject,
// or readable text that slips into it despite the prompt would contaminate
// EVERY spread anchored on it, so a generated plate must pass this check
// before it is uploaded or cached.

const PLATE_QA_PROMPT = `You are checking a WORLD REFERENCE PLATE for a children's picture book — pure environment key art used only as a palette/lighting/era style reference.

It must contain NO people or human figures, NO characters of any kind, NO
animals or creatures as subjects (tiny incidental background wildlife far
from focus is acceptable), and NO readable text, letters, numbers, or
signage anywhere.

Answer STRICT JSON only:
{
  "people_or_characters": true|false, // any person, human figure, or character present
  "subject_creatures": true|false,    // an animal or creature as a clear subject of the image
  "readable_text": true|false         // any readable words, letters, or numbers painted in the image
}`;

/**
 * Validate one generated world plate against the environment-only invariant.
 * Same conventions as checkSpreadRender: an infra failure passes with
 * `qaUnavailable` (the plate is still better than no plate); only a
 * confirmed violation rejects.
 * @param {Buffer} imageBuffer
 * @param {{label?: string}} [opts]
 * @returns {Promise<{pass: boolean, defects: string[], qaUnavailable?: string}>}
 */
async function checkWorldPlate(imageBuffer, opts = {}) {
  const label = opts.label || 'worldPlateQa';
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
              { text: PLATE_QA_PROMPT },
              { inline_data: { mimeType: 'image/png', data: imageBuffer.toString('base64') } },
            ],
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 256, responseMimeType: 'application/json' },
        }),
      },
      60000,
    );
    if (!resp.ok) {
      console.warn(`[${label}] plate QA HTTP ${resp.status} — accepting plate unchecked`);
      return { pass: true, defects: [], qaUnavailable: `plate QA HTTP ${resp.status}` };
    }
    const data = await resp.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    const json = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
    const FIELDS = ['people_or_characters', 'subject_creatures', 'readable_text'];
    if (!json || typeof json !== 'object' || !FIELDS.every(f => typeof json[f] === 'boolean')) {
      console.warn(`[${label}] plate QA returned a malformed verdict — accepting plate unchecked`);
      return { pass: true, defects: [], qaUnavailable: 'plate QA returned a malformed verdict' };
    }
    const defects = [
      json.people_or_characters && 'people or characters in the plate',
      json.subject_creatures && 'a creature as the plate subject',
      json.readable_text && 'readable text in the plate',
    ].filter(Boolean);
    return { pass: defects.length === 0, defects };
  } catch (err) {
    console.warn(`[${label}] plate QA failed to run (accepting plate unchecked): ${err.message}`);
    return { pass: true, defects: [], qaUnavailable: `plate QA errored: ${err.message}` };
  }
}

/**
 * Corrective prompt suffix for the single repair render.
 * @param {string[]} defects
 * @param {string|null} [expectedText] embedded layout: the exact story text
 *   the repair must paint into the art
 * @returns {string}
 */
function repairNote(defects, expectedText = null) {
  const notes = [];
  for (const d of defects) {
    if (d.includes('painted text')) notes.push('ABSOLUTELY NO text, letters, numbers, signage, or lettering anywhere in the image.');
    if (d.includes('story text missing') || d.includes('story text garbled')) {
      notes.push(`The story text MUST be painted into the artwork EXACTLY as written — crisp, small, legible, never in the middle 30% of the image${expectedText ? `: "${expectedText}"` : ''}. Fix ONLY the text; keep the scene otherwise identical.`);
    }
    if (d.includes('split across both sides')) {
      notes.push('Render the story text as EXACTLY ONE block on ONE side of the image — entirely within the left 35% or the right 35%, never divided between both sides. Fix ONLY the text placement; keep the scene otherwise identical.');
    }
    if (d.includes('blank band')) {
      notes.push('Paint the story text directly OVER the artwork on a calm area of the scene — NO blank, solid, or lightened band/strip/panel behind it; the illustration must fill the entire canvas edge to edge. Fix ONLY the text placement; keep the scene otherwise identical.');
    }
    if (d.includes('lines misaligned')) {
      notes.push('Re-render the text as professionally TYPESET lines: every line perfectly straight, level, and horizontal (never tilted, arched, or wavy), all lines LEFT-ALIGNED to one shared straight left margin, with identical line spacing throughout. Fix ONLY the text; keep the scene otherwise identical.');
    }
    if (d.includes('mixes fonts')) {
      notes.push('Render ALL the text in ONE single font family, ONE size, ONE weight, and ONE fill color — the book\'s fixed plain serif spec — with zero per-line or per-word variation. Fix ONLY the text; keep the scene otherwise identical.');
    }
    if (d.includes('missing from the scene')) notes.push('The child hero MUST be clearly visible and central to the action.');
    if (d.includes('duplicated')) notes.push('Exactly ONE instance of the child hero — no twins, no second child.');
    if (d.includes('style break')) notes.push('Premium 3D CGI feature-film render only — never flat 2D, watercolor, line art, or a photograph.');
  }
  return `CRITICAL REPAIR — the previous render failed QA (${defects.join('; ')}). ${notes.join(' ')}`;
}

module.exports = { checkSpreadRender, repairNote, checkWorldConsistency, worldRepairNote, checkWorldPlate };
