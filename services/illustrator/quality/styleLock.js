/**
 * Per-spread QA: enforce the book's chosen art style (from ART_STYLE_CONFIG).
 */

const { GEMINI_QA_MODEL, CHAT_API_BASE, QA_TIMEOUT_MS, QA_HTTP_ATTEMPTS, ART_STYLE_CONFIG } = require('../config');
const { fetchWithTimeout, getNextApiKey } = require('../../illustrationGenerator');
const { extractGeminiResponseText, parseQaJsonFromText } = require('./geminiJson');

/** Styles that must read as premium 3D CGI (matches prompts/system.js LOCKED_3D_STYLES). */
const LOCKED_3D_STYLES = new Set(['pixar_premium', 'cinematic_3d', 'graphic_novel_cinematic']);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Resolve style key; warn and fall back to pixar_premium if unknown.
 * @param {string} [styleKey]
 * @returns {{ key: string, config: { prefix: string, suffix: string } }}
 */
function resolveStyleConfig(styleKey) {
  const key = typeof styleKey === 'string' && styleKey && ART_STYLE_CONFIG[styleKey]
    ? styleKey
    : 'pixar_premium';
  if (styleKey && styleKey !== key) {
    console.warn(`[illustrator/styleLock] Unknown art style "${styleKey}" — falling back to pixar_premium`);
  }
  return { key, config: ART_STYLE_CONFIG[key] };
}

/**
 * Build vision-QA prompt text for the locked style.
 * @param {string} styleKey
 * @returns {string}
 */
function buildArtStyleQaPrompt(styleKey) {
  const { key, config } = resolveStyleConfig(styleKey);
  const fullStyleLine = `${config.prefix} ${config.suffix}`.replace(/\s+/g, ' ').trim();

  if (LOCKED_3D_STYLES.has(key)) {
    return `You are QA for a children's book illustration.

REQUIRED ART STYLE (NON-NEGOTIABLE) — "${key}":
- Premium cinematic 3D CGI in the vein of Disney/Pixar feature animation: soft rounded forms, photorealistic 3D shaded characters and props, subsurface skin scattering, rich materials, volumetric cinematic lighting, depth of field / bokeh in backgrounds, warm saturated color, emotionally readable faces.
- This must read as a high-end 3D RENDER matching: ${fullStyleLine}
- This must NOT read as a flat painting or 2D-only illustration.

Set pass=false (tag "art_style_mismatch") if the image is CLEARLY one of these WRONG styles:
- Flat 2D cartoon with no 3D shading
- Watercolor, gouache, or visible paper texture painting as the PRIMARY look
- Pencil sketch, graphite, crosshatch, or line-art primary look
- Anime / manga / Ghibli 2D look
- Pixel art or retro game aesthetic
- Paper cutout / collage / Eric Carle style
- Scandinavian flat vector / corporate flat illustration
- Photograph of real people (live-action)

ACCEPTABLE: Slight painterly softness is OK as long as the overall read is still 3D CGI / Pixar-like shaded models with dimensional lighting — not a 2D illustration style.

Return ONLY valid JSON:
{"pass": true/false, "issues": [], "tags": ["art_style_mismatch or empty"]}`;
  }

  return `You are QA for a children's book illustration.

REQUIRED ART STYLE (NON-NEGOTIABLE) — "${key}":
The book is NOT using premium 3D CGI for this order. The illustration MUST match this medium and look:
${fullStyleLine}

Set pass=false (tag "art_style_mismatch") if the image CLEARLY reads as a DIFFERENT medium than required, for example:
- Photorealistic 3D CGI / Disney-Pixar-style shaded 3D characters (WRONG when this book requires "${key}")
- A photograph of real people
- Anime / manga / pixel art / obvious wrong genre

Also flag if the image is clearly one of these when they contradict "${key}":
- Pure flat vector corporate illustration with no brush or paper texture (when watercolor, gouache, or painterly look is required)
- Obvious wrong technique (e.g. heavy 3D render when watercolor was required)

ACCEPTABLE: Normal variation within "${key}" (lighting, composition) — only fail on clear medium mismatch.

Return ONLY valid JSON:
{"pass": true/false, "issues": [], "tags": ["art_style_mismatch or empty"]}`;
}

/**
 * Agent2 correction prompt when QA tagged art_style_mismatch (style-only fix).
 * @param {string} styleKey
 * @param {string} spreadPrompt - full spread prompt from buildSpreadPrompt
 * @param {object} [opts]
 * @param {number} [opts.spreadNumber] - 1-based spread label for full-book pipeline
 * @returns {string}
 */
function buildStyleCorrectionPrompt(styleKey, spreadPrompt, opts = {}) {
  const { key, config } = resolveStyleConfig(styleKey);
  const fullStyleLine = `${config.prefix} ${config.suffix}`.replace(/\s+/g, ' ').trim();
  const header = typeof opts.spreadNumber === 'number'
    ? `REGENERATE spread ${opts.spreadNumber} with the SAME scene, characters, and layout.\n\n`
    : `REGENERATE with the SAME scene, characters, and layout.\n\n`;

  if (LOCKED_3D_STYLES.has(key)) {
    return `${header}CRITICAL — ART STYLE (NON-NEGOTIABLE): The book uses premium cinematic 3D Pixar-like CGI only — photorealistic shaded 3D characters, volumetric soft lighting, subsurface skin, depth-of-field backgrounds, Disney/Pixar production quality. The previous render looked like the WRONG medium (e.g. flat 2D, watercolor, sketch, anime, or pixel art). Fix ONLY by switching to correct 3D CGI — do not change the story moment.

${spreadPrompt}`;
  }

  return `${header}CRITICAL — ART STYLE (NON-NEGOTIABLE): This book's locked style is "${key}": ${fullStyleLine}
The previous render used the WRONG medium. Fix ONLY by matching this exact style — do NOT render as premium 3D CGI unless "${key}" is a 3D style. Do not change the story moment.

${spreadPrompt}`;
}

/**
 * Verify the illustration matches the book's configured art style.
 *
 * @param {string} imageBase64
 * @param {object} [opts]
 * @param {string} [opts.style] - Art style key (e.g. pixar_premium, watercolor)
 * @param {object} [opts.costTracker]
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{pass: boolean, issues: string[], tags: string[], infra?: boolean}>}
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
  const prompt = buildArtStyleQaPrompt(opts.style);

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
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }, QA_TIMEOUT_MS, opts.abortSignal);

      if (opts.costTracker) opts.costTracker.addTextUsage(GEMINI_QA_MODEL, 500, 100);

      if (!resp.ok) {
        lastErr = `HTTP ${resp.status}`;
        if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
        continue;
      }

      const data = await resp.json();
      const text = extractGeminiResponseText(data);
      const result = parseQaJsonFromText(text);
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
    pass: true,
    issues: [],
    tags: ['qa_infra_error'],
    infra: true,
  };
}

/**
 * Short line for in-session "fresh generation" retry prompts.
 * @param {string} styleKey
 * @returns {string}
 */
function buildFreshGenerationStyleHint(styleKey) {
  const { key, config } = resolveStyleConfig(styleKey);
  const fullStyleLine = `${config.prefix} ${config.suffix}`.replace(/\s+/g, ' ').trim();
  if (LOCKED_3D_STYLES.has(key)) {
    return 'ART STYLE — premium cinematic 3D Pixar-like CGI only (photorealistic shaded 3D, volumetric lighting). NOT flat 2D, watercolor, or sketch as the primary look.';
  }
  return `ART STYLE — match this book's locked style "${key}": ${fullStyleLine}`;
}

module.exports = {
  checkArtStyleLock,
  buildStyleCorrectionPrompt,
  buildArtStyleQaPrompt,
  buildFreshGenerationStyleHint,
  resolveStyleConfig,
};
