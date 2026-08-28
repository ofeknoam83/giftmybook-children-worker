/**
 * Light spread QA — ONE vision check per render, one corrective retry,
 * then ship-with-advisory. The closed critical list is intentionally tiny
 * (the parent test): painted words, missing child, duplicated child, or a
 * broken medium (flat 2D / photo look). Everything else ships and is
 * fixable post-hoc; no judge panels, no likeness tribunal.
 */

const { fetchWithTimeout, getNextApiKey } = require('../../illustrationGenerator');

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
 * Run the QA check on one rendered spread.
 * @param {Buffer} imageBuffer
 * @param {{label?: string}} [opts]
 * @returns {Promise<{pass: boolean, defects: string[]}>} pass=true also on QA infra errors (never block on the checker itself)
 */
async function checkSpreadRender(imageBuffer, opts = {}) {
  const label = opts.label || 'spreadQa';
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
              { text: QA_PROMPT },
              { inline_data: { mimeType: 'image/png', data: imageBuffer.toString('base64') } },
            ],
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 256, responseMimeType: 'application/json' },
        }),
      },
      60000,
    );
    if (!resp.ok) {
      console.warn(`[${label}] QA HTTP ${resp.status} — passing without QA`);
      return { pass: true, defects: [] };
    }
    const data = await resp.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    const json = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
    const defects = [
      json.readable_text && 'painted text in the illustration',
      json.child_absent && 'child hero missing from the scene',
      json.multiple_children && 'duplicated child hero',
      json.flat_or_photo_style && 'style break: flat/2D or photographic medium',
    ].filter(Boolean);
    return { pass: defects.length === 0, defects };
  } catch (err) {
    console.warn(`[${label}] QA failed to run (passing without QA): ${err.message}`);
    return { pass: true, defects: [] };
  }
}

/**
 * Corrective prompt suffix for the single repair render.
 * @param {string[]} defects
 * @returns {string}
 */
function repairNote(defects) {
  const notes = [];
  for (const d of defects) {
    if (d.includes('painted text')) notes.push('ABSOLUTELY NO text, letters, numbers, signage, or lettering anywhere in the image.');
    if (d.includes('missing')) notes.push('The child hero MUST be clearly visible and central to the action.');
    if (d.includes('duplicated')) notes.push('Exactly ONE instance of the child hero — no twins, no second child.');
    if (d.includes('style break')) notes.push('Premium 3D CGI feature-film render only — never flat 2D, watercolor, line art, or a photograph.');
  }
  return `CRITICAL REPAIR — the previous render failed QA (${defects.join('; ')}). ${notes.join(' ')}`;
}

module.exports = { checkSpreadRender, repairNote };
