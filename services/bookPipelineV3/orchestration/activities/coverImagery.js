/**
 * Cover Imagery — one vision call describing what the APPROVED cover
 * actually depicts (props, setting, mood), so the writer chain can honor
 * it (P4, audit 2026-07-15).
 *
 * The cover is approved by the parent BEFORE the manuscript exists. Until
 * this activity, the writer chain was cover-blind: a cover showing a
 * compass and a treasure map shipped with a backyard story that never
 * mentioned either. The output feeds the creative brief and the concept
 * room ("the parent approved a cover showing X — honor it"), and is kept
 * on document.v3 for the native art director.
 *
 * Deliberately non-fatal: any failure degrades to null and the writer
 * proceeds cover-blind (the pre-P4 behavior) — a $0.001 vision nicety
 * must never fail a book.
 */

const { callVisionRole } = require('../../llm/visionClient');
const { downloadPhotoAsBase64 } = require('../../../illustrationGenerator');

const PROMPT = `You are describing a children's book COVER so the story writers know what the parent already approved. Look at the image and return STRICT JSON (no markdown fences):

{
  "props": ["<up to 6 distinctive objects/props depicted, e.g. 'compass', 'treasure map', 'soccer ball' — only things a story could reference; omit generic scenery>"],
  "setting": "<one sentence: where the cover scene takes place, e.g. 'a magical twilight forest with glowing plants'>",
  "mood": "<2-5 words: the emotional promise, e.g. 'wondrous quest at dusk'>"
}

Do not describe the child or the title text. Return ONLY the JSON.`;

/**
 * @param {{ coverImageUrl: string|null }} input
 * @param {object} ctx - workflow activity context (log)
 * @returns {Promise<{props: string[], setting: string|null, mood: string|null}|null>}
 */
async function coverImageryActivity(input, ctx) {
  const coverImageUrl = input?.coverImageUrl;
  if (!coverImageUrl) return null;
  try {
    const img = await downloadPhotoAsBase64(coverImageUrl);
    if (!img?.base64) return null;
    const resp = await callVisionRole('QA_VISION', {
      prompt: PROMPT,
      images: [{ base64: img.base64, mimeType: img.mimeType || 'image/jpeg' }],
      label: 'v3.coverImagery',
      expectJson: true,
    });
    const j = resp?.json || {};
    const out = {
      props: Array.isArray(j.props) ? j.props.map((p) => String(p)).filter(Boolean).slice(0, 6) : [],
      setting: j.setting ? String(j.setting).slice(0, 240) : null,
      mood: j.mood ? String(j.mood).slice(0, 120) : null,
    };
    ctx?.log?.('info', `[v3] coverImagery: props=[${out.props.join(', ')}] setting='${out.setting || ''}'`);
    return out;
  } catch (err) {
    ctx?.log?.('warn', `[v3] coverImagery degraded (${err?.message}) — writer proceeds cover-blind`);
    return null;
  }
}

module.exports = { coverImageryActivity, COVER_IMAGERY_PROMPT: PROMPT };
