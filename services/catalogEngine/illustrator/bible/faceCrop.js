/**
 * Likeness references for the character model sheet (2026-09-07).
 *
 * The child's photo used to ride the sheet render as one whole frame — a
 * full-body holiday snapshot at arm's length puts the face in a few
 * hundred pixels, and an EXIF-rotated phone photo arrived sideways. This
 * module turns the raw photo into the two references likeness needs:
 *
 *  - the UPRIGHT photo (EXIF orientation applied, re-encoded as JPEG, the
 *    long edge capped so the request stays small without losing the face);
 *  - a tight FACE CROP: one strict-JSON vision read locates the main child's
 *    face (fractions of the upright frame), sharp crops it with headroom
 *    for hair, ears and chin, and the crop rides the render as its own
 *    labelled reference — the face at a size the image model can actually
 *    read — and the judge as the likeness ground truth.
 *
 * Fail-open by contract: a photo sharp cannot decode, a judge outage, a
 * malformed or implausible box (no face, a sliver, a box off the frame)
 * all yield NO crop and the original photo — the sheet still builds the
 * way it did before this module existed. Nothing here ever fails a book.
 * No model free text reaches a prompt: the verdict is four numbers and a
 * boolean, each range-checked.
 */

const sharp = require('sharp');
const { getNextApiKey, fetchWithTimeout } = require('../../../illustrationGenerator');
const { GEMINI_QA_MODEL } = require('../../../shared/illustration/config');
const { jsonQaGenerationConfig, responseText, parseJsonText } = require('../../../shared/llm/geminiJson');

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
/** The locator honours the same knob as spread QA (CATALOG_QA_VISION_MODEL). */
const QA_MODEL = () => process.env.CATALOG_QA_VISION_MODEL || GEMINI_QA_MODEL;
const LOCATE_TIMEOUT_MS = 30000;

/** Long edge of the upright photo sent to the model (px). */
const PHOTO_MAX_EDGE = 1536;
/** Long edge of the face crop (px) — the face fills most of it. */
const CROP_MAX_EDGE = 768;
/** Headroom around the judged face box, as a share of the box's longer side (hair, ears, chin, neck). */
const CROP_PAD = 0.55;
/** A judged box covering less than this share of the frame is a misread, never a face worth cropping. */
const MIN_FACE_AREA = 0.004;
/** A judged box covering more than this share of the frame is the whole frame, not a face. */
const MAX_FACE_AREA = 0.9;
const JPEG_QUALITY = 92;

const LOCATE_PROMPT = `Locate the face of the main CHILD in this photo — the child the photo is about. If several people are visible, choose the child (never an adult); if several children, the most prominent one.

Answer STRICT JSON only:
{
  "found": true|false,           // a child's face is clearly visible
  "face_bbox": {"x": <0-1>, "y": <0-1>, "w": <0-1>, "h": <0-1>} | null  // a TIGHT box around that face from hairline to chin and ear to ear, as fractions of the image width/height (x,y = top-left corner)
}
Only report what you can clearly see; do not guess.`;

/**
 * Validate a judged box into plain numbers: own properties, finite, inside
 * the unit square, a plausible area. Anything else is null (no crop).
 * @param {*} raw
 * @returns {{x: number, y: number, w: number, h: number}|null}
 */
function normalizeFaceBox(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const own = k => (Object.prototype.hasOwnProperty.call(raw, k) ? raw[k] : undefined);
  const nums = ['x', 'y', 'w', 'h'].map(k => own(k));
  if (!nums.every(n => typeof n === 'number' && Number.isFinite(n))) return null;
  let [x, y, w, h] = nums;
  // Tolerate a percent-scaled answer (0-100) — the analyze-photo prompt in
  // the app speaks percent, and a model that has seen both formats drifts.
  if (x > 1 || y > 1 || w > 1 || h > 1) {
    if ([x, y, w, h].every(n => n >= 0 && n <= 100)) { x /= 100; y /= 100; w /= 100; h /= 100; } else return null;
  }
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x >= 1 || y >= 1) return null;
  w = Math.min(w, 1 - x);
  h = Math.min(h, 1 - y);
  const area = w * h;
  if (area < MIN_FACE_AREA || area > MAX_FACE_AREA) return null;
  return { x, y, w, h };
}

/**
 * Pixel crop rectangle for a face box: padded on every side by CROP_PAD ×
 * the box's longer side, squared up around the box centre, clamped to the
 * frame. Deterministic.
 * @param {{x: number, y: number, w: number, h: number}} box fractions
 * @param {number} width image px
 * @param {number} height image px
 * @returns {{left: number, top: number, width: number, height: number}}
 */
function faceCropRect(box, width, height) {
  const bw = box.w * width;
  const bh = box.h * height;
  const cx = (box.x + box.w / 2) * width;
  const cy = (box.y + box.h / 2) * height;
  // The square's side, clamped to the frame FIRST so a face larger than
  // the short edge still yields a crop centred on the face, not on a corner.
  const size = Math.min(Math.round(Math.max(bw, bh) * (1 + 2 * CROP_PAD)), width, height);
  const left = Math.max(0, Math.min(Math.round(cx - size / 2), width - size));
  const top = Math.max(0, Math.min(Math.round(cy - size / 2), height - size));
  return { left, top, width: size, height: size };
}

/**
 * One vision read: where is the main child's face? Null on any failure
 * (fail-open) — never a throw.
 * @param {{base64: string, mimeType?: string}} photo the UPRIGHT photo
 * @param {{log?: Function}} [opts]
 * @returns {Promise<{x: number, y: number, w: number, h: number}|null>}
 */
async function locateFace(photo, { log = () => {} } = {}) {
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
              { text: LOCATE_PROMPT },
              { inline_data: { mimeType: photo.mimeType || 'image/jpeg', data: photo.base64 } },
            ],
          }],
          generationConfig: jsonQaGenerationConfig(512, QA_MODEL()),
        }),
      },
      LOCATE_TIMEOUT_MS,
    );
    if (!resp.ok) {
      log('warn', `face locate: HTTP ${resp.status} — no face crop`);
      return null;
    }
    const data = await resp.json();
    const json = parseJsonText(responseText(data));
    if (!json || typeof json !== 'object' || json.found !== true) {
      log('info', 'face locate: no child face reported — no face crop');
      return null;
    }
    const box = normalizeFaceBox(json.face_bbox);
    if (!box) log('warn', 'face locate: implausible box — no face crop');
    return box;
  } catch (err) {
    log('warn', `face locate failed (${err.message}) — no face crop`);
    return null;
  }
}

/**
 * Build the likeness references from the raw child photo: the upright
 * photo and, when a face is found, its crop. Never throws; the worst case
 * returns the original photo untouched with `face: null`.
 *
 * @param {{base64: string, mimeType?: string}} photo raw photo bytes
 * @param {{log?: Function}} [opts]
 * @returns {Promise<{photo: {base64: string, mimeType: string}, face: {base64: string, mimeType: string}|null, box: {x: number, y: number, w: number, h: number}|null}>}
 */
async function prepareLikenessReferences(photo, { log = () => {} } = {}) {
  const passthrough = { photo: { base64: photo.base64, mimeType: photo.mimeType || 'image/jpeg' }, face: null, box: null };
  if (!photo || typeof photo.base64 !== 'string' || !photo.base64) return passthrough;
  let uprightBuffer;
  let width;
  let height;
  try {
    // EXIF orientation applied FIRST so the judged box and the crop share
    // one pixel grid; the long edge capped so the reference stays small.
    uprightBuffer = await sharp(Buffer.from(photo.base64, 'base64'))
      .rotate()
      .resize(PHOTO_MAX_EDGE, PHOTO_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    ({ width, height } = await sharp(uprightBuffer).metadata());
    if (!width || !height) throw new Error('no dimensions');
  } catch (err) {
    log('warn', `child photo could not be normalized (${err.message}) — using it as supplied, no face crop`);
    return passthrough;
  }
  const upright = { base64: uprightBuffer.toString('base64'), mimeType: 'image/jpeg' };
  const box = await locateFace(upright, { log });
  if (!box) return { photo: upright, face: null, box: null };
  try {
    const rect = faceCropRect(box, width, height);
    const cropBuffer = await sharp(uprightBuffer)
      .extract(rect)
      .resize(CROP_MAX_EDGE, CROP_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    log('info', `face crop derived (${rect.width}×${rect.height} px at ${rect.left},${rect.top} of ${width}×${height})`);
    return { photo: upright, face: { base64: cropBuffer.toString('base64'), mimeType: 'image/jpeg' }, box };
  } catch (err) {
    log('warn', `face crop failed (${err.message}) — photo only`);
    return { photo: upright, face: null, box };
  }
}

module.exports = {
  prepareLikenessReferences,
  locateFace,
  normalizeFaceBox,
  faceCropRect,
  LOCATE_PROMPT,
  PHOTO_MAX_EDGE,
  CROP_MAX_EDGE,
  CROP_PAD,
};
