/**
 * Per-spread QA: enforce locked art style — premium 3D Pixar-like CGI (product standard).
 */

const { GEMINI_QA_MODEL, CHAT_API_BASE, QA_TIMEOUT_MS, QA_HTTP_ATTEMPTS } = require('../config');
const { fetchWithTimeout, getNextApiKey } = require('../../illustrationGenerator');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parseJsonResponse(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*/i, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { return null; }
  }
  return null;
}

/**
 * Verify the illustration matches premium 3D Pixar-like CGI (not 2D, watercolor, anime, etc.).
 *
 * @param {string} imageBase64
 * @param {object} [opts]
 * @param {object} [opts.costTracker]
 * @returns {Promise<{pass: boolean, issues: string[], tags: string[]}>}
 */
async function checkArtStyleLock(imageBase64, opts = {}) {
  const apiKey = getNextApiKey();
  if (!apiKey) {
    return {
      pass: false,
      issues: ['Art style QA unavailable: no Gemini API key configured'],
      tags: ['qa_unavailable'],
    };
  }

  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;

  const prompt = `You are QA for a children's book illustration.

REQUIRED ART STYLE (NON-NEGOTIABLE):
- Premium cinematic 3D CGI in the vein of Disney/Pixar feature animation: soft rounded forms, photorealistic 3D shaded characters and props, subsurface skin scattering, rich materials, volumetric cinematic lighting, depth of field / bokeh in backgrounds, warm saturated color, emotionally readable faces.
- This must read as a high-end 3D RENDER, not a flat drawing.

Set pass=false (tag "art_style_mismatch") if the image is CLEARLY one of these WRONG styles:
- Flat 2D cartoon with no 3D shading
- Watercolor, gouache, or visible paper texture painting
- Pencil sketch, graphite, crosshatch, or line-art primary look
- Anime / manga / Ghibli 2D look
- Pixel art or retro game aesthetic
- Paper cutout / collage / Eric Carle style
- Scandinavian flat vector / corporate flat illustration
- Photograph of real people (live-action)

ACCEPTABLE: Slight painterly softness is OK as long as the overall read is still 3D CGI / Pixar-like shaded models with dimensional lighting — not a 2D illustration style.

Return ONLY valid JSON:
{"pass": true/false, "issues": [], "tags": ["art_style_mismatch or empty"]}`;

  let lastErr = 'unknown error';
  for (let attempt = 0; attempt < QA_HTTP_ATTEMPTS; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { inline_data: { mimeType: 'image/png', data: imageBase64 } },
              { text: prompt },
            ],
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 384,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }, QA_TIMEOUT_MS);

      if (opts.costTracker) opts.costTracker.addTextUsage(GEMINI_QA_MODEL, 500, 100);

      if (!resp.ok) {
        lastErr = `HTTP ${resp.status}`;
        if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
        continue;
      }

      const data = await resp.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      const result = parseJsonResponse(text);
      if (!result) {
        lastErr = 'unparseable response';
        if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
        continue;
      }

      const rawTags = Array.isArray(result.tags) ? result.tags : [];
      const tags = rawTags
        .filter(t => typeof t === 'string')
        .map(t => t.toLowerCase().trim())
        .filter(Boolean);

      return {
        pass: !!result.pass,
        issues: Array.isArray(result.issues) ? result.issues : [],
        tags,
      };
    } catch (e) {
      lastErr = e.message || String(e);
      if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
    }
  }

  return {
    pass: false,
    issues: [`Art style QA failed after ${QA_HTTP_ATTEMPTS} attempts: ${lastErr}`],
    tags: ['qa_api_error'],
  };
}

module.exports = { checkArtStyleLock };
