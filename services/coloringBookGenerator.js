'use strict';

const { getNextApiKey, downloadPhotoAsBase64, fetchWithTimeout } = require('./illustrationGenerator');

const COLORING_PROMPT = `This is a children's book illustration. Convert it into a COLORING BOOK PAGE:
- Keep EVERY character, object, and scene element exactly as they appear — nothing removed or simplified
- Replace ALL colors with CLEAN BLACK OUTLINES ONLY on a pure white background
- Lines must be THICK and BOLD (suitable for a child to color with crayons or markers)
- NO fill colors, NO gray tones, NO shading, NO watercolor washes, NO color gradients
- The character faces, hair, clothing details, and all scene objects must all have clear outlines
- Style: classic children's coloring book — like a Dover coloring book page
- Maintain the EXACT SAME composition, proportions, characters and layout as the original
- This is a wide landscape illustration — maintain the 16:9 wide format`;

/**
 * Convert a single illustration to a coloring book page via Gemini.
 * @param {string} base64 - base64-encoded source image
 * @param {string} mimeType - image mime type
 * @returns {Promise<Buffer>} - coloring page image buffer
 */
async function convertToColoringPage(base64, mimeType) {
  const MAX_ATTEMPTS = 3;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const apiKey = getNextApiKey();
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${apiKey}`;

      const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { text: COLORING_PROMPT },
            { inline_data: { mime_type: mimeType || 'image/jpeg', data: base64 } },
          ]}],
          generationConfig: {
            responseModalities: ['IMAGE'],
            imageConfig: { aspectRatio: '16:9' },
          },
        }),
      }, 120000);

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Gemini ${resp.status}: ${errText.slice(0, 200)}`);
      }

      const data = await resp.json();
      const imgPart = data?.candidates?.[0]?.content?.parts?.find(p => p.inline_data?.data);
      if (!imgPart) throw new Error('No image returned from Gemini');

      return Buffer.from(imgPart.inline_data.data, 'base64');
    } catch (err) {
      lastError = err;
      console.warn(`[coloringBookGenerator] Attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  throw lastError;
}

/**
 * Convert all spread illustrations to coloring pages sequentially.
 * @param {string[]} illustrationUrls
 * @returns {Promise<Array<{index: number, buffer: Buffer|null, success: boolean}>>}
 */
async function generateColoringPages(illustrationUrls) {
  const results = [];

  for (let i = 0; i < illustrationUrls.length; i++) {
    const url = illustrationUrls[i];
    console.log(`[coloringBookGenerator] Converting spread ${i + 1}/${illustrationUrls.length}`);
    try {
      const photo = await downloadPhotoAsBase64(url);
      const buffer = await convertToColoringPage(photo.base64, photo.mimeType);
      results.push({ index: i, buffer, success: true });
      console.log(`[coloringBookGenerator] Spread ${i + 1} done (${Math.round(buffer.length / 1024)}KB)`);
    } catch (err) {
      console.error(`[coloringBookGenerator] Spread ${i + 1} failed: ${err.message}`);
      results.push({ index: i, buffer: null, success: false, error: err.message });
    }
  }

  return results;
}

module.exports = { generateColoringPages, convertToColoringPage };
