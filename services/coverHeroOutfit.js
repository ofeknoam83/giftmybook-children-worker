/**
 * Snapshot hero outfit from the approved cover image (vision) so illustration
 * QA outfit lock matches what is actually rendered on the cover.
 */

const { fetchWithTimeout, getNextApiKey } = require('./illustrationGenerator');

const MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = 25000;

/**
 * @param {string} coverBase64 - JPEG base64
 * @param {object} [opts]
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<string|null>} Concise outfit description, or null on failure
 */
async function describeHeroOutfitFromCover(coverBase64, opts = {}) {
  if (!coverBase64 || typeof coverBase64 !== 'string' || coverBase64.length < 100) return null;
  const apiKey = getNextApiKey() || process.env.GOOGLE_AI_STUDIO_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const url = `${API_BASE}/${MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      role: 'user',
      parts: [
        {
          text: `Look at this children's book COVER. The main child hero is the personalized protagonist.

Return STRICT JSON only:
{"outfit":"<one concise sentence listing visible garments, main colors, and accessories — exactly what the child is wearing on THIS cover image>"}

Rules:
- Describe ONLY the hero child's clothing/body wear (shirt, pants, dress, shoes, hat, etc.).
- If unclear, infer the dominant visible outfit; do not invent text from the title.
- No markdown, no extra keys.`,
        },
        { inline_data: { mime_type: 'image/jpeg', data: coverBase64 } },
      ],
    }],
    generationConfig: { maxOutputTokens: 200, temperature: 0.1 },
  };

  try {
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, TIMEOUT_MS, opts.abortSignal);
    if (!resp.ok) return null;
    const data = await resp.json();
    const txt = data?.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';
    const m = String(txt).match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const o = typeof parsed.outfit === 'string' ? parsed.outfit.trim() : '';
    return o.length > 5 ? o : null;
  } catch (e) {
    console.warn(`[coverHeroOutfit] Vision outfit snapshot failed: ${e.message}`);
    return null;
  }
}

module.exports = { describeHeroOutfitFromCover };
