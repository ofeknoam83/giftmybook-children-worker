/**
 * Illustration Post-Processing Service (Tier 2)
 *
 * Non-regeneration fixes for illustrations that failed QA.
 * Uses Sharp for image manipulation — no Gemini image generation needed.
 *
 * - compositeTextOnIllustration: composite story text onto a text-free illustration using Sharp/SVG
 * - findBestTextPlacement: use Gemini Vision to find optimal text placement area
 * - fixFontOnIllustration: erase embedded text and re-render with consistent font via SVG composite
 * - fixColorPalette: adjust brightness/saturation/hue to match a reference spread
 * - detectFontSpec: use Gemini Vision to analyze font characteristics from the first spread
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { getNextApiKey, fetchWithTimeout } = require('./illustrationGenerator');

const GEMINI_VISION_MODEL = 'gemini-2.5-flash';

// ── Font cache for BubblegumSans (loaded once, reused for all composites) ──
const FONT_PATH = path.join(__dirname, '..', 'fonts', 'BubblegumSans-Regular.ttf');
let _fontBase64Cache = null;
function getFontBase64() {
  if (!_fontBase64Cache) {
    _fontBase64Cache = fs.readFileSync(FONT_PATH).toString('base64');
  }
  return _fontBase64Cache;
}

/**
 * Use Gemini Vision to detect the font specification from an illustration.
 * Analyzes the first spread to extract font characteristics.
 *
 * @param {string} imageBase64 - Base64-encoded image to analyze
 * @returns {Promise<{fontFamily: string, fontSize: number, fontWeight: string, fontColor: string, position: string}|null>}
 */
async function detectFontSpec(imageBase64) {
  const apiKey = getNextApiKey();
  if (!apiKey) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{
      role: 'user',
      parts: [
        {
          text: `Analyze the text rendering in this children's book illustration.
Describe the font characteristics as precisely as possible.

Return ONLY valid JSON:
{
  "fontFamily": "closest common font name (e.g., 'Comic Sans MS', 'Arial Rounded', 'Bubblegum Sans')",
  "fontSize": estimated font size in pixels (number, e.g., 48),
  "fontWeight": "normal" or "bold",
  "fontColor": "hex color code (e.g., '#333333')",
  "position": "top" or "bottom" or "left" or "right",
  "textBounds": {"x": percentage from left, "y": percentage from top, "width": percentage of image width, "height": percentage of image height}
}`
        },
        { inline_data: { mimeType: 'image/jpeg', data: imageBase64 } },
      ],
    }],
    generationConfig: { maxOutputTokens: 512, temperature: 0.1, thinkingConfig: { thinkingBudget: 0 } },
  };

  try {
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 30000);

    if (!resp.ok) return null;
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const cleaned = text.replace(/```json\s*/i, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
  } catch (e) {
    console.warn('[illustrationPostProcess] detectFontSpec error:', e.message);
  }
  return null;
}

/**
 * Use Gemini Vision to identify the text bounding box in an illustration.
 *
 * @param {string} imageBase64
 * @returns {Promise<{x: number, y: number, width: number, height: number}|null>} Bounds as percentages
 */
async function detectTextBounds(imageBase64) {
  const apiKey = getNextApiKey();
  if (!apiKey) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{
      role: 'user',
      parts: [
        {
          text: `Find the text area in this children's book illustration.
Return the bounding box of ALL text as percentage coordinates of the full image dimensions.
Return ONLY valid JSON:
{"x": percentage from left edge, "y": percentage from top edge, "width": percentage of image width, "height": percentage of image height}
Example: {"x": 5, "y": 70, "width": 30, "height": 20} means text starts 5% from left, 70% from top, spans 30% of width and 20% of height.`
        },
        { inline_data: { mimeType: 'image/jpeg', data: imageBase64 } },
      ],
    }],
    generationConfig: { maxOutputTokens: 256, temperature: 0.1, thinkingConfig: { thinkingBudget: 0 } },
  };

  try {
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 30000);

    if (!resp.ok) return null;
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const cleaned = text.replace(/```json\s*/i, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
  } catch (e) {
    console.warn('[illustrationPostProcess] detectTextBounds error:', e.message);
  }
  return null;
}

/**
 * Sample the dominant background color from the edges of a region in the image.
 *
 * @param {Buffer} imageBuffer
 * @param {object} region - {left, top, width, height} in pixels
 * @returns {Promise<{r: number, g: number, b: number}>}
 */
async function sampleBackgroundColor(imageBuffer, region) {
  try {
    // Extract the region and get stats
    const regionBuffer = await sharp(imageBuffer)
      .extract(region)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = regionBuffer;
    const { width, height, channels } = info;

    // Sample pixels from the edges of the region (top/bottom rows, left/right cols)
    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    const sampleRow = (y) => {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * channels;
        rSum += data[idx];
        gSum += data[idx + 1];
        bSum += data[idx + 2];
        count++;
      }
    };
    // Top and bottom rows
    sampleRow(0);
    sampleRow(Math.max(0, height - 1));
    // Left and right columns
    for (let y = 0; y < height; y++) {
      const leftIdx = (y * width) * channels;
      rSum += data[leftIdx]; gSum += data[leftIdx + 1]; bSum += data[leftIdx + 2];
      const rightIdx = (y * width + (width - 1)) * channels;
      rSum += data[rightIdx]; gSum += data[rightIdx + 1]; bSum += data[rightIdx + 2];
      count += 2;
    }

    return {
      r: Math.round(rSum / count),
      g: Math.round(gSum / count),
      b: Math.round(bSum / count),
    };
  } catch (e) {
    console.warn('[illustrationPostProcess] sampleBackgroundColor error:', e.message);
    return { r: 255, g: 255, b: 255 }; // fallback to white
  }
}

/**
 * Fix font consistency on an illustration by erasing the existing text and
 * re-rendering it with a consistent font via Sharp SVG composite.
 *
 * @param {string} imageBase64 - Base64-encoded illustration
 * @param {string} pageText - The correct text to render
 * @param {object} fontSpec - Font specification from detectFontSpec()
 * @param {string} [referenceSpreadBase64] - Reference spread for style matching
 * @returns {Promise<{fixed: boolean, imageBase64?: string}>}
 */
async function fixFontOnIllustration(imageBase64, pageText, fontSpec, referenceSpreadBase64) {
  if (!imageBase64 || !pageText || !fontSpec) {
    return { fixed: false };
  }

  try {
    const imgBuffer = Buffer.from(imageBase64, 'base64');
    const metadata = await sharp(imgBuffer).metadata();
    const imgWidth = metadata.width;
    const imgHeight = metadata.height;

    // Detect text bounds using Gemini Vision
    const bounds = await detectTextBounds(imageBase64);
    if (!bounds || !bounds.x || !bounds.width) {
      console.warn('[illustrationPostProcess] Could not detect text bounds — skipping font fix');
      return { fixed: false };
    }

    // Convert percentage bounds to pixel coordinates
    const textRegion = {
      left: Math.round((bounds.x / 100) * imgWidth),
      top: Math.round((bounds.y / 100) * imgHeight),
      width: Math.round((bounds.width / 100) * imgWidth),
      height: Math.round((bounds.height / 100) * imgHeight),
    };

    // Clamp to image dimensions
    textRegion.left = Math.max(0, Math.min(textRegion.left, imgWidth - 1));
    textRegion.top = Math.max(0, Math.min(textRegion.top, imgHeight - 1));
    textRegion.width = Math.min(textRegion.width, imgWidth - textRegion.left);
    textRegion.height = Math.min(textRegion.height, imgHeight - textRegion.top);

    if (textRegion.width < 10 || textRegion.height < 10) {
      return { fixed: false };
    }

    // Add padding around the text region for cleaner erasure
    const pad = Math.round(Math.min(textRegion.width, textRegion.height) * 0.1);
    const eraseRegion = {
      left: Math.max(0, textRegion.left - pad),
      top: Math.max(0, textRegion.top - pad),
      width: Math.min(textRegion.width + pad * 2, imgWidth - Math.max(0, textRegion.left - pad)),
      height: Math.min(textRegion.height + pad * 2, imgHeight - Math.max(0, textRegion.top - pad)),
    };

    // Sample background color from the text region edges
    const bgColor = await sampleBackgroundColor(imgBuffer, eraseRegion);

    // Create a colored rectangle to erase the text area
    const eraseOverlay = await sharp({
      create: {
        width: eraseRegion.width,
        height: eraseRegion.height,
        channels: 3,
        background: bgColor,
      },
    }).png().toBuffer();

    // Composite the erase overlay onto the image
    let result = sharp(imgBuffer).composite([{
      input: eraseOverlay,
      left: eraseRegion.left,
      top: eraseRegion.top,
    }]);

    // Render the new text via SVG
    const fontSize = fontSpec.fontSize || 48;
    const fontColor = fontSpec.fontColor || '#333333';
    const fontWeight = fontSpec.fontWeight || 'bold';
    const fontFamily = fontSpec.fontFamily || 'sans-serif';

    // Calculate text layout within the text region
    // Ensure text width stays within 30% of image width
    const maxTextWidth = Math.min(textRegion.width, Math.round(imgWidth * 0.30));

    // Wrap text into lines that fit the maxTextWidth
    const lines = wrapText(pageText, maxTextWidth, fontSize);

    const lineHeight = Math.round(fontSize * 1.3);
    const svgHeight = lines.length * lineHeight + Math.round(fontSize * 0.5);
    const svgWidth = maxTextWidth + Math.round(fontSize * 0.5);

    // Escape XML entities
    const escapeXml = (str) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const textLines = lines.map((line, i) => {
      const y = Math.round(fontSize + i * lineHeight);
      return `<text x="${Math.round(fontSize * 0.25)}" y="${y}" font-family="${escapeXml(fontFamily)}, sans-serif" font-size="${fontSize}" font-weight="${fontWeight}" fill="${fontColor}">${escapeXml(line)}</text>`;
    }).join('\n');

    const svg = `<svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">
${textLines}
</svg>`;

    const svgBuffer = Buffer.from(svg);

    // Position the SVG text at the text region location
    const textLeft = textRegion.left;
    const textTop = textRegion.top;

    const finalBuffer = await result
      .composite([{
        input: svgBuffer,
        left: textLeft,
        top: textTop,
      }])
      .png()
      .toBuffer();

    return {
      fixed: true,
      imageBase64: finalBuffer.toString('base64'),
    };
  } catch (e) {
    console.warn('[illustrationPostProcess] fixFontOnIllustration error:', e.message);
    return { fixed: false };
  }
}

/**
 * Simple text wrapping based on estimated character width.
 */
function wrapText(text, maxWidth, fontSize) {
  const charWidth = fontSize * 0.55; // approximate character width
  const maxCharsPerLine = Math.max(5, Math.floor(maxWidth / charWidth));

  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (testLine.length > maxCharsPerLine && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines;
}

/**
 * Fix color palette by adjusting an illustration's brightness/saturation/hue
 * to better match a reference spread.
 *
 * Uses Sharp's modulate() for hue/saturation and normalize() for brightness.
 *
 * @param {string} imageBase64 - Base64-encoded illustration to fix
 * @param {string} referenceBase64 - Base64-encoded reference illustration
 * @returns {Promise<{fixed: boolean, imageBase64?: string}>}
 */
async function fixColorPalette(imageBase64, referenceBase64) {
  if (!imageBase64 || !referenceBase64) {
    return { fixed: false };
  }

  try {
    const imgBuffer = Buffer.from(imageBase64, 'base64');
    const refBuffer = Buffer.from(referenceBase64, 'base64');

    // Get color statistics from both images
    const [imgStats, refStats] = await Promise.all([
      sharp(imgBuffer).stats(),
      sharp(refBuffer).stats(),
    ]);

    // Compare brightness (mean of all channels)
    const imgBrightness = (imgStats.channels[0].mean + imgStats.channels[1].mean + imgStats.channels[2].mean) / 3;
    const refBrightness = (refStats.channels[0].mean + refStats.channels[1].mean + refStats.channels[2].mean) / 3;

    // Compare saturation using channel spread (rough proxy)
    const channelSpread = (stats) => {
      const means = stats.channels.map(c => c.mean);
      return Math.max(...means) - Math.min(...means);
    };
    const imgSatSpread = channelSpread(imgStats);
    const refSatSpread = channelSpread(refStats);

    // Only adjust if there's a meaningful difference
    const brightnessDiff = refBrightness - imgBrightness;
    const satDiff = refSatSpread - imgSatSpread;

    if (Math.abs(brightnessDiff) < 10 && Math.abs(satDiff) < 15) {
      // Images are close enough — no fix needed
      return { fixed: false };
    }

    // Calculate modulation values
    const brightnessMultiplier = refBrightness > 0 ? Math.min(1.3, Math.max(0.7, refBrightness / imgBrightness)) : 1.0;
    const saturationMultiplier = imgSatSpread > 0 ? Math.min(1.5, Math.max(0.5, refSatSpread / imgSatSpread)) : 1.0;

    const adjustedBuffer = await sharp(imgBuffer)
      .modulate({
        brightness: brightnessMultiplier,
        saturation: saturationMultiplier,
      })
      .png()
      .toBuffer();

    console.log(`[illustrationPostProcess] Color palette adjusted: brightness=${brightnessMultiplier.toFixed(2)}, saturation=${saturationMultiplier.toFixed(2)}`);

    return {
      fixed: true,
      imageBase64: adjustedBuffer.toString('base64'),
    };
  } catch (e) {
    console.warn('[illustrationPostProcess] fixColorPalette error:', e.message);
    return { fixed: false };
  }
}

// ── Text Compositing (Hybrid Approach) ──────────────────────────────────────

/**
 * Use Gemini Vision to find the best area for text placement on one side of a spread.
 * Returns percentage coordinates of the "quietest" area where text won't obscure important elements.
 *
 * @param {string} imageBase64 - Base64-encoded spread illustration
 * @param {'left'|'right'} side - Which half of the spread to place text
 * @param {'bottom'|'top'} zone - Preferred vertical zone
 * @returns {Promise<{x: number, y: number, width: number, height: number}>} Percentages (0-100)
 */
async function findBestTextPlacement(imageBase64, side, zone) {
  const defaults = {
    left:  { bottom: { x: 3, y: 70, width: 42, height: 25 }, top: { x: 3, y: 5, width: 42, height: 25 } },
    right: { bottom: { x: 53, y: 70, width: 42, height: 25 }, top: { x: 53, y: 5, width: 42, height: 25 } },
  };
  const fallback = defaults[side]?.[zone] || defaults.left.bottom;

  const apiKey = getNextApiKey();
  if (!apiKey) return fallback;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${apiKey}`;

  const sideDesc = side === 'left' ? 'left half (0%–50% from left edge)' : 'right half (50%–100% from left edge)';
  const zoneDesc = zone === 'top' ? 'top 40%' : 'bottom 40%';

  const body = {
    contents: [{
      role: 'user',
      parts: [
        {
          text: `This wide children's book illustration will be split into two pages at the exact horizontal center (50% mark).
Find the best area to place story text in the ${zoneDesc} of the ${sideDesc}.

Choose an area where:
- There is the LEAST visual detail or importance (sky, ground, water, simple background)
- The main character's face, hands, and key objects are NOT covered
- The area is within the ${sideDesc} and does NOT cross the 50% center line

Return ONLY valid JSON with percentage coordinates (0-100):
{"x": percentage from left edge, "y": percentage from top edge, "width": percentage of image width, "height": percentage of image height}
The x + width must stay within the ${side} half (${side === 'left' ? 'x + width < 48' : 'x > 52'}).`
        },
        { inline_data: { mimeType: 'image/jpeg', data: imageBase64 } },
      ],
    }],
    generationConfig: { maxOutputTokens: 256, temperature: 0.1, thinkingConfig: { thinkingBudget: 0 } },
  };

  try {
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 30000);

    if (!resp.ok) return fallback;
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const cleaned = text.replace(/```json\s*/i, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      const result = JSON.parse(match[0]);
      // Validate the result is reasonable
      if (result.x >= 0 && result.y >= 0 && result.width > 5 && result.height > 5) {
        // Enforce side boundaries
        if (side === 'left' && result.x + result.width > 48) {
          result.width = 48 - result.x;
        }
        if (side === 'right' && result.x < 52) {
          result.x = 52;
        }
        return result;
      }
    }
  } catch (e) {
    console.warn('[illustrationPostProcess] findBestTextPlacement error:', e.message);
  }
  return fallback;
}

/**
 * Escape XML entities for SVG text content.
 */
function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Build an SVG overlay with text rendered in BubblegumSans font with a drop shadow.
 *
 * @param {string} text - Story text to render
 * @param {number} svgWidth - SVG canvas width in pixels
 * @param {number} svgHeight - SVG canvas height in pixels
 * @param {object} opts - { fontSize, fontColor, maxTextWidth }
 * @returns {Buffer} SVG as a Buffer
 */
function buildTextSvg(text, svgWidth, svgHeight, opts = {}) {
  const fontSize = opts.fontSize || 48;
  const fontColor = opts.fontColor || '#FFFFFF';
  const maxTextWidth = opts.maxTextWidth || svgWidth;
  const fontBase64 = getFontBase64();

  const lines = wrapText(text, maxTextWidth, fontSize);
  const lineHeight = Math.round(fontSize * 1.4);
  const totalTextHeight = lines.length * lineHeight;

  // Center text vertically within the SVG area
  const startY = Math.max(fontSize, Math.round((svgHeight - totalTextHeight) / 2) + fontSize);

  const tspans = lines.map((line, i) => {
    const y = startY + i * lineHeight;
    return `    <tspan x="${Math.round(fontSize * 0.3)}" y="${y}">${escapeXml(line)}</tspan>`;
  }).join('\n');

  const svg = `<svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      @font-face {
        font-family: 'BubblegumSans';
        src: url('data:font/truetype;base64,${fontBase64}') format('truetype');
      }
    </style>
    <filter id="textShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="2" dy="2" stdDeviation="3" flood-color="rgba(0,0,0,0.7)"/>
    </filter>
  </defs>
  <text font-family="BubblegumSans, sans-serif" font-size="${fontSize}" fill="${fontColor}" filter="url(#textShadow)">
${tspans}
  </text>
</svg>`;

  return Buffer.from(svg);
}

/**
 * Composite story text onto an illustration using Sharp/SVG with BubblegumSans font.
 * Text is placed over the illustration artwork with a drop shadow for legibility.
 *
 * For spread images (16:9), left and right text are placed on their respective halves,
 * guaranteed to never cross the center split line and stay within 35% of page width.
 *
 * @param {Buffer} imageBuffer - Raw illustration image (no text)
 * @param {string|null} leftText - Text for the left page (null to skip)
 * @param {string|null} rightText - Text for the right page (null to skip)
 * @param {object} opts - { fontSize, fontColor, maxWidthPct, isSpread }
 * @returns {Promise<{imageBuffer: Buffer, imageBase64: string}>}
 */
async function compositeTextOnIllustration(imageBuffer, leftText, rightText, opts = {}) {
  const fontSize = opts.fontSize || 48;
  const fontColor = opts.fontColor || '#FFFFFF';
  const maxWidthPct = Math.min(opts.maxWidthPct || 0.35, 0.35);
  const isSpread = opts.isSpread !== false;

  const metadata = await sharp(imageBuffer).metadata();
  const imgWidth = metadata.width;
  const imgHeight = metadata.height;
  const centerX = Math.round(imgWidth / 2);
  const centerMargin = Math.round(imgWidth * 0.02); // 2% margin from center

  // Page width is half the spread for spreads, full width for single pages
  const pageWidth = isSpread ? centerX : imgWidth;
  const maxTextWidth = Math.round(pageWidth * maxWidthPct);

  const imageBase64 = imageBuffer.toString('base64');
  const composites = [];

  // Helper to process one side's text
  async function processText(text, side) {
    if (!text || !text.trim()) return;

    const zone = side === 'left' ? 'bottom' : 'bottom'; // Both default to bottom; could alternate
    const placement = isSpread
      ? await findBestTextPlacement(imageBase64, side, zone)
      : { x: 5, y: 70, width: 90, height: 25 }; // Single page: bottom area

    // Convert percentage bounds to pixels
    let textLeft = Math.round((placement.x / 100) * imgWidth);
    const textTop = Math.round((placement.y / 100) * imgHeight);
    const areaWidth = Math.round((placement.width / 100) * imgWidth);
    const areaHeight = Math.round((placement.height / 100) * imgHeight);

    // Enforce center-crossing guard for spreads
    if (isSpread) {
      if (side === 'left') {
        const maxRight = centerX - centerMargin;
        if (textLeft + maxTextWidth > maxRight) {
          textLeft = Math.max(0, maxRight - maxTextWidth);
        }
      } else {
        const minLeft = centerX + centerMargin;
        if (textLeft < minLeft) {
          textLeft = minLeft;
        }
      }
    }

    // Build SVG with the constrained width
    const svgWidth = Math.min(maxTextWidth, areaWidth);
    const svgHeight = Math.min(areaHeight, Math.round(imgHeight * 0.30));
    const svgBuffer = buildTextSvg(text, svgWidth, svgHeight, {
      fontSize,
      fontColor,
      maxTextWidth: svgWidth,
    });

    // Clamp position to image bounds
    const finalLeft = Math.max(0, Math.min(textLeft, imgWidth - svgWidth));
    const finalTop = Math.max(0, Math.min(textTop, imgHeight - svgHeight));

    composites.push({
      input: svgBuffer,
      left: finalLeft,
      top: finalTop,
    });
  }

  // Process left and right text (can run Gemini calls in parallel)
  if (isSpread) {
    await Promise.all([
      processText(leftText, 'left'),
      processText(rightText, 'right'),
    ]);
  } else {
    // Single page — combine all text
    const combinedText = [leftText, rightText].filter(Boolean).join(' ');
    await processText(combinedText, 'left');
  }

  if (composites.length === 0) {
    return { imageBuffer, imageBase64 };
  }

  const resultBuffer = await sharp(imageBuffer)
    .composite(composites)
    .png()
    .toBuffer();

  return {
    imageBuffer: resultBuffer,
    imageBase64: resultBuffer.toString('base64'),
  };
}

module.exports = {
  detectFontSpec,
  fixFontOnIllustration,
  fixColorPalette,
  compositeTextOnIllustration,
  findBestTextPlacement,
};
