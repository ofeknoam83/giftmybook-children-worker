/**
 * Cover Generator — Creates Lulu-compliant wrap-around cover PDF
 * (back cover + spine + front cover) with 0.125" bleed.
 *
 * Back cover: Gemini-generated TEXT-FREE illustration matching the front
 * cover style; synopsis, heartfelt note, and branding are TYPESET with
 * pdf-lib on top (never painted — painted text ships garbled words). No
 * barcode is drawn; Lulu applies the real ISBN barcode.
 * Spine: Color-matched to front cover, no text for books under 80 pages.
 */

const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');
const {
  generateIllustration,
  getNextApiKey,
  fetchWithTimeout,
  renderStyleBlock,
  ART_STYLE_CONFIG,
  canonicalBookArtStyle,
} = require('./illustrationGenerator');
const { downloadBuffer } = require('./gcsStorage');
const { TEXT_RULES } = require('./shared/illustration/config');
const sharp = require('sharp');

/** Nano Banana 2 (same as `GEMINI_IMAGE_MODEL` in illustrator/config.js). */
const GEMINI_HARMONIZE_MODEL = 'gemini-3.1-flash-image';
const GEMINI_IMAGE_API = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Gemini generateContent JSON uses camelCase `inlineData` or snake_case `inline_data`;
 * mime may be `mimeType` or `mime_type`.
 *
 * @param {object} part - A single content `parts` entry
 * @returns {{ data: string, mime: string } | null}
 */
function geminiImagePartFromResponsePart(part) {
  if (!part || typeof part !== 'object') return null;
  const id = part.inlineData || part.inline_data;
  if (!id || typeof id.data !== 'string' || !id.data.length) return null;
  const mime = id.mimeType || id.mime_type || '';
  if (mime && !String(mime).startsWith('image/')) return null;
  return { data: id.data, mime: mime || 'image/jpeg' };
}

/**
 * Log Gemini safety / block signals when the image model returns no image parts
 * (finishReason and promptFeedback are often more informative than partCount: 0).
 *
 * @param {object} data - Parsed JSON from generateContent
 * @param {string} label - Log context (e.g. "harmonize" | "back cover attempt 0")
 */
function logGeminiImageResponseDiagnostics(data, label) {
  if (!data || typeof data !== 'object') {
    console.warn(`[CoverGenerator] ${label}: empty/invalid response JSON`);
    return;
  }
  const c0 = data.candidates?.[0];
  const parts = c0?.content?.parts || [];
  const pf = data.promptFeedback;
  console.warn(`[CoverGenerator] ${label}: Gemini response diagnostics`, {
    finishReason: c0?.finishReason || 'n/a',
    partCount: parts.length,
    candidateSafety: c0?.safetyRatings,
    promptBlockReason: pf?.blockReason,
    promptBlockMessage: pf?.blockReasonMessage,
    promptSafety: pf?.safetyRatings,
  });
}

/**
 * Path/style markers that identify a cover source ALREADY rendered in the locked
 * 3D pixar_premium / cinematic_3d language. A cover carrying one of these markers
 * is provably on-brand 3D, so the harmonize-to-3D img2img pass is a redundant
 * no-op and can be safely skipped.
 */
const KNOWN_3D_SOURCE_MARKER = /(pixar[_-]?premium|cinematic[_-]?3d|3d[_-]?harmonized|style-?3d)/i;

/**
 * Decide whether to SKIP the cover "harmonize" img2img pass.
 *
 * IMPORTANT (2026-07-22 always-3D lock): skip ONLY when the source is provably
 * already on-brand 3D (an explicit marker in the path). The previous heuristic
 * skipped ANY admin-upload or upsell cover — but upsell covers could be 2D
 * (watercolor / paper_cutout) and admin uploads are arbitrary art, so those 2D
 * covers shipped un-harmonized on top of 3D interiors (book 497c8b68). The user
 * requirement is that cover + interiors are ALWAYS 3D pixar premium, so when in
 * doubt we FAIL TOWARD harmonizing: any 2D/unknown source returns false here and
 * gets restyled to 3D. Gemini-input-safety on child faces is handled by the
 * harmonize prompt itself (it never re-lights faces photo-realistically).
 *
 * @param {string} [coverSourceUrl] - GCS path, https URL, or signed URL
 * @returns {boolean} true ONLY for a provably-3D source
 */
function shouldSkipCoverStyleHarmonize(coverSourceUrl) {
  if (!coverSourceUrl || typeof coverSourceUrl !== 'string') return false;
  let s = coverSourceUrl;
  try {
    s = decodeURIComponent(coverSourceUrl);
  } catch {
    /* keep raw */
  }
  return KNOWN_3D_SOURCE_MARKER.test(s);
}

/**
 * Copy-extend a trim-fit cover image into its bleed/wrap bands, then BLUR
 * the extended bands so they read as a soft edge fade instead of raw
 * single-row pixel streaks (2026-07-18 print audit: the hardcover wrap
 * band showed crude horizontal smearing). Copy (vs mirror) remains the
 * base strategy — mirror paints a visible symmetric reflection — but the
 * streaks now dissolve into a gradient-like band. The trim area itself is
 * untouched: only the extended bands are composited from the blurred copy.
 *
 * @param {Buffer} trimFitBuffer - image already resized to exact trim size
 * @param {{top: number, bottom: number, left: number, right: number}} bands - band widths in px
 * @returns {Promise<Buffer>} extended image (trim + bands), JPEG
 */
async function extendWithSoftWrap(trimFitBuffer, bands) {
  const extended = await sharp(trimFitBuffer)
    .extend({ ...bands, extendWith: 'copy' })
    .toBuffer();
  const anyBand = bands.top || bands.bottom || bands.left || bands.right;
  if (!anyBand) return extended;
  const meta = await sharp(extended).metadata();
  const blurred = await sharp(extended).blur(15).toBuffer();
  const overlays = [];
  const band = async (extract, left, top) => overlays.push({
    input: await sharp(blurred).extract(extract).toBuffer(), left, top,
  });
  if (bands.top) await band({ left: 0, top: 0, width: meta.width, height: bands.top }, 0, 0);
  if (bands.bottom) await band({ left: 0, top: meta.height - bands.bottom, width: meta.width, height: bands.bottom }, 0, meta.height - bands.bottom);
  if (bands.left) await band({ left: 0, top: 0, width: bands.left, height: meta.height }, 0, 0);
  if (bands.right) await band({ left: meta.width - bands.right, top: 0, width: bands.right, height: meta.height }, meta.width - bands.right, 0);
  return sharp(extended).composite(overlays).toBuffer();
}

/**
 * Extract dominant color from an image buffer using sharp.
 * Returns {r, g, b} normalized to 0-1.
 */
async function extractDominantColor(imageBuffer) {
  try {
    const { dominant } = await sharp(imageBuffer).stats();
    return {
      r: dominant.r / 255,
      g: dominant.g / 255,
      b: dominant.b / 255,
    };
  } catch {
    return { r: 0.95, g: 0.93, b: 0.88 }; // warm cream fallback
  }
}

/**
 * Soften a color toward cream (for background use).
 */
function softenColor(color, amount = 0.5) {
  const cream = { r: 0.95, g: 0.93, b: 0.88 };
  return {
    r: color.r + (cream.r - color.r) * amount,
    g: color.g + (cream.g - color.g) * amount,
    b: color.b + (cream.b - color.b) * amount,
  };
}

/**
 * Build a Lulu-safe-zone instruction for cover AI prompts.
 *
 * Lulu casewrap wraps 0.875" over the boards on hardcover, and paperbacks
 * trim 0.125" with a ~0.25" critical-content safe zone. Since we now embed
 * the AI image to EXACTLY fill the trim area (with copy-extended edges into
 * the bleed/wrap), the AI's own image frame maps to the trim line — so we ask
 * for a generous interior safety buffer against minor trim variance and
 * the extended bleed/wrap band.
 *
 * @param {boolean} isHardcover
 * @returns {string} Multi-line instruction appended to the AI prompt
 */
function buildCoverSafeZoneInstruction(isHardcover) {
  const topPct = TEXT_RULES.topPaddingPercent ?? TEXT_RULES.cornerVerticalPaddingPercent;
  const bottomPct = TEXT_RULES.bottomPaddingPercent ?? TEXT_RULES.cornerVerticalPaddingPercent;
  const sidePct = isHardcover ? 12 : 8;
  return [
    `COVER PRINT SAFETY (CRITICAL — Lulu ${isHardcover ? 'hardcover casewrap' : 'paperback'}):`,
    `- The outer ~${sidePct}% of every edge of this image will be TRIMMED, BLED, OR WRAPPED around the book during printing. Anything placed there WILL BE CUT OFF or hidden on the inside of the cover.`,
    `- Keep ALL title text, the child's face, logos, subtitles, and any critical element at least ${topPct}% away from the TOP edge, at least ${bottomPct}% away from the BOTTOM edge, and at least ${sidePct}% away from the left and right edges.`,
    `- Place the title with generous top margin — the top of every letter (including tall letters like D, R, W, L, h) must sit well below the top ${topPct}% of the image. If the title is long, make it SMALLER rather than pushing it closer to the top.`,
    `- The background/illustration itself should still extend edge-to-edge (no white borders) — ONLY the critical content needs to stay inside the safe zone.`,
  ].join('\n');
}

/**
 * Re-render a customer-chosen cover (any prior art style) in the same
 * **cinematic 3D Pixar-style CGI** language as the book's interior spreads, while
 * preserving layout, text, and likeness. Used when the PDF is built from
 * `preGeneratedCoverBuffer` (selected cover) instead of a fresh `generateIllustration`
 * call — those assets can be 2D or off-style vs interiors.
 *
 * Uses **Nano Banana 2** (`gemini-3.1-flash-image`) for img2img harmonization.
 * On total failure returns the original buffer.
 *
 * @param {Buffer} frontCoverBuffer
 * @param {object} [opts]
 * @param {string} [opts.bookFormat] - PICTURE_BOOK / EARLY_READER (square) vs portrait chapter
 * @param {object} [opts.costTracker]
 * @param {boolean} [opts.skipCoverStyleHarmonize] - if true, no-op
 * @returns {Promise<Buffer>}
 */
async function harmonizeChosenCoverToInteriorStyle(frontCoverBuffer, opts = {}) {
  if (opts.skipCoverStyleHarmonize) {
    return frontCoverBuffer;
  }
  if (!Buffer.isBuffer(frontCoverBuffer) || frontCoverBuffer.length < 100) {
    return frontCoverBuffer;
  }

  const styleConfig = ART_STYLE_CONFIG.pixar_premium || ART_STYLE_CONFIG.cinematic_3d;
  const styleBlock = renderStyleBlock(styleConfig);

  let jpegRef;
  try {
    jpegRef = await sharp(frontCoverBuffer)
      .rotate() // respect EXIF
      .jpeg({ quality: 93 })
      .toBuffer();
  } catch (e) {
    console.warn('[CoverGenerator] harmonize: could not normalize to JPEG, using raw buffer:', e.message);
    jpegRef = frontCoverBuffer;
  }

  const basePrompt = [
    'INPUT: the attached image is the customer-approved book cover (composition and title may already be final).',
    'TASK: Re-create this cover as a **cinematic 3D Pixar feature-film CGI key-art render** that matches the interior illustrations of the same product — the same 3D language as inside the book, not a separate art style.',
    'PRESERVE: The same overall composition, the child’s placement and pose, the same on-image title and subtitle (character-for-character if visible), the same number of people, and the same story mood. Do not invent a new layout.',
    'TRANSFORM: If the input is 2D, watercolor, painterly, or flat illustrated, restyle it toward true 3D CGI in the same family as the interiors: believable 3D geometry, soft-feature-film character shading, PBR materials, clean volumetric lighting, modeled environment — do NOT increase skin/hair “photorealism” beyond a family-friendly 3D animated film look, and do NOT re-light faces to look like a real photograph.',
    'FORBID: a different book title, extra characters, missing characters, or a new scene. No poster typography that ignores the input text.',
    'WARDROBE SCRUB (2026-07-19 audit: a flag patch on the approved cover propagated onto every interior spread): while re-creating, REMOVE any national flag, real-world brand logo, or lettering from the child\'s clothing — replace with plain fabric or a generic letter-free emblem (a star patch, a simple rocket motif). Everything else about the outfit stays identical.',
    '',
    'STYLE LOCK (match book interiors):',
    styleBlock,
  ].join('\n');

  // --- Nano Banana 2 (gemini-3.1-flash-image), same as interior spreads default ---
  const gKey = getNextApiKey() || process.env.GOOGLE_AI_STUDIO_KEY || process.env.GEMINI_API_KEY;
  if (!gKey) {
    console.warn('[CoverGenerator] No API keys for cover harmonize — using chosen cover as-is');
    return frontCoverBuffer;
  }

  try {
    const refB64 = jpegRef.toString('base64');
    const url = `${GEMINI_IMAGE_API}/${GEMINI_HARMONIZE_MODEL}:generateContent?key=${gKey}`;
    const out = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: basePrompt },
              { inline_data: { mimeType: 'image/jpeg', data: refB64 } },
            ],
          }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            maxOutputTokens: 8192,
          },
        }),
      },
      180000,
    );
    if (!out.ok) {
      const t = await out.text().catch(() => '');
      console.warn('[CoverGenerator] Gemini cover harmonize HTTP', out.status, t.slice(0, 200));
      return frontCoverBuffer;
    }
    const data = await out.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      const img = geminiImagePartFromResponsePart(part);
      if (img) {
        console.log('[CoverGenerator] Chosen cover harmonized to 3D interior style (Gemini / Nano Banana 2)');
        if (opts.costTracker) opts.costTracker.addImageGeneration(GEMINI_HARMONIZE_MODEL, 1);
        return Buffer.from(img.data, 'base64');
      }
    }
    logGeminiImageResponseDiagnostics(data, 'harmonize (no image)');
    console.warn(
      '[CoverGenerator] harmonize: no image in Gemini response — using chosen cover as-is',
    );
  } catch (e) {
    console.warn('[CoverGenerator] Gemini cover harmonize error:', e.message);
  }

  return frontCoverBuffer;
}

/**
 * Build a small style-reference JPEG from a **corner crop** of the front cover
 * (avoids centering a child's face, which often trips Gemini input safety on
 * the image model when the back cover must not show the child).
 *
 * @param {Buffer} frontCoverBuffer
 * @returns {Promise<Buffer|null>}
 */
async function buildBackCoverStyleReferenceBuffer(frontCoverBuffer) {
  if (!Buffer.isBuffer(frontCoverBuffer) || frontCoverBuffer.length < 100) return null;
  const rotated = await sharp(frontCoverBuffer).rotate();
  const meta = await rotated.metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  if (w < 64 || h < 64) return null;

  const frac = 0.35;
  const rw = Math.max(32, Math.round(w * frac));
  const rh = Math.max(32, Math.round(h * frac));
  const regions = [
    { left: Math.max(0, w - rw), top: 0, width: rw, height: rh },
    { left: 0, top: 0, width: rw, height: rh },
    { left: 0, top: Math.max(0, h - rh), width: rw, height: rh },
    { left: Math.max(0, w - rw), top: Math.max(0, h - rh), width: rw, height: rh },
  ];
  for (const ex of regions) {
    try {
      const out = await sharp(frontCoverBuffer)
        .rotate()
        .extract(ex)
        .resize(512, 512, { fit: 'cover' })
        .jpeg({ quality: 80 })
        .toBuffer();
      if (out && out.length > 500) return out;
    } catch {
      /* try next region */
    }
  }
  return null;
}

/**
 * Word-wrap a string to a pixel width for a pdf-lib font.
 *
 * @param {string} text
 * @param {import('pdf-lib').PDFFont} font
 * @param {number} size - font size in points
 * @param {number} maxWidth - available width in points
 * @returns {string[]} wrapped lines
 */
function wrapTextToWidth(text, font, size, maxWidth) {
  const lines = [];
  let current = '';
  for (const word of String(text || '').split(/\s+/).filter(Boolean)) {
    const attempt = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(attempt, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = attempt;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Typeset the back-cover text (synopsis, heartfelt note, branding) with
 * pdf-lib, on top of whatever background is already drawn (Gemini art or
 * the plain-color fallback). This is the ONLY way text reaches the back
 * cover — the image model paints artwork only (audit 2026-07-15: painted
 * synopses shipped garbled words on a printed book).
 *
 * Legibility over arbitrary art: each line is drawn 4× in a dark ink at
 * sub-point offsets (a poor man's outline) and then once in warm cream on
 * top. All text stays inside the trim safe area; the bottom-left barcode
 * region is left clear (Lulu applies the real ISBN barcode — we no longer
 * paint a fake one).
 *
 * @param {import('pdf-lib').PDFPage} page
 * @param {object} geom - { edgeBleed, trimWidth, totalHeight }
 * @param {object} fonts - { font, boldFont, italicFont }
 * @param {object} content - { synopsis, heartfeltNote, bookFrom, childName }
 */
function drawBackCoverTypeset(page, geom, fonts, content) {
  const { edgeBleed, trimWidth, totalHeight } = geom;
  const { font, boldFont, italicFont } = fonts;
  const { synopsis, heartfeltNote, bookFrom, childName } = content;

  const SAFE = 45; // 0.625" inside trim — comfortably clear of Lulu trim variance
  const contentWidth = trimWidth - SAFE * 2;
  const centerX = edgeBleed + trimWidth / 2;
  const cream = rgb(0.98, 0.95, 0.86);
  const ink = rgb(0.13, 0.11, 0.09);

  const drawOutlined = (text, x, y, size, f) => {
    for (const [dx, dy] of [[-0.7, 0], [0.7, 0], [0, -0.7], [0, 0.7]]) {
      page.drawText(text, { x: x + dx, y: y + dy, size, font: f, color: ink });
    }
    page.drawText(text, { x, y, size, font: f, color: cream });
  };

  let y = totalHeight - edgeBleed - SAFE - 60;

  if (synopsis) {
    const size = 13;
    const lineGap = 21;
    for (const line of wrapTextToWidth(synopsis, boldFont, size, contentWidth)) {
      const lw = boldFont.widthOfTextAtSize(line, size);
      drawOutlined(line, centerX - lw / 2, y, size, boldFont);
      y -= lineGap;
    }
    y -= 18;
  }

  if (heartfeltNote) {
    const size = 11;
    const lineGap = 18;
    const noteText = bookFrom ? `${heartfeltNote} — ${bookFrom}` : heartfeltNote;
    for (const line of wrapTextToWidth(noteText, italicFont, size, contentWidth)) {
      const lw = italicFont.widthOfTextAtSize(line, size);
      drawOutlined(line, centerX - lw / 2, y, size, italicFont);
      y -= lineGap;
    }
  }

  // Branding near the bottom center, above the barcode strip Lulu reserves.
  const madeFor = `Made with love for ${childName || 'you'}`;
  const madeForW = boldFont.widthOfTextAtSize(madeFor, 12);
  drawOutlined(madeFor, centerX - madeForW / 2, edgeBleed + SAFE + 42, 12, boldFont);
  const brand = 'GiftMyBook.com';
  const brandW = boldFont.widthOfTextAtSize(brand, 12);
  drawOutlined(brand, centerX - brandW / 2, edgeBleed + SAFE + 24, 12, boldFont);
}

/**
 * QA gate for generated back-cover art (2026-07-18 print audit: a customer
 * book shipped with a 3D BOOK MOCKUP — book on a table, drop shadow, page
 * edges — printed as its back cover). One cheap Gemini vision call verifies
 * the image is flat, full-bleed scene artwork. Closed check list — this is
 * a mockup/photo detector, not an art critic.
 *
 * Best-effort: infrastructure failures PASS (a QA outage must not kill
 * covers); only an explicit "this is a mockup/photo/framed object" verdict
 * rejects, sending the caller to its next attempt or the typeset fallback
 * panel.
 *
 * @param {Buffer} imageBuffer
 * @param {string} apiKey
 * @returns {Promise<{pass: boolean, reason: string|null}>}
 */
async function qaBackCoverArtwork(imageBuffer, apiKey) {
  const prompt = `You are checking artwork that will be printed as the BACK COVER of a children's book. The image must be FLAT, full-bleed scene artwork.

Answer STRICT JSON only:
{
  "book_mockup": true|false,   // does the image DEPICT a physical book/product (a book lying on a surface, a 3D book mockup with visible pages/spine/cover shadow)?
  "framed_object": true|false, // is the artwork shown as an object ON a background (frame, border, tabletop, wall, room) instead of filling the whole image edge to edge?
  "photo_surface": true|false, // does it contain photographic/real-world surfaces (a real table, real paper texture, a photographed room) rather than artwork?
  "readable_text": true|false  // any readable words, letters, or numbers painted in the image?
}`;
  try {
    const resp = await fetch(
      `${GEMINI_IMAGE_API}/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: prompt },
              { inline_data: { mimeType: 'image/jpeg', data: imageBuffer.toString('base64') } },
            ],
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 512, responseMimeType: 'application/json' },
        }),
      }
    );
    if (!resp.ok) {
      console.warn(`[CoverGenerator] back-cover QA HTTP ${resp.status} — passing without QA`);
      return { pass: true, reason: null };
    }
    const data = await resp.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    const json = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
    const failures = [
      json.book_mockup && 'depicts a book/product mockup',
      json.framed_object && 'artwork framed as an object instead of full-bleed',
      json.photo_surface && 'photographic real-world surface',
      json.readable_text && 'readable text painted in the artwork',
    ].filter(Boolean);
    if (failures.length > 0) return { pass: false, reason: failures.join('; ') };
    return { pass: true, reason: null };
  } catch (err) {
    console.warn(`[CoverGenerator] back-cover QA failed to run (passing without QA): ${err.message}`);
    return { pass: true, reason: null };
  }
}

/**
 * Wardrobe QA for a freshly generated FRONT cover (2026-07-19 audit: a
 * US-flag patch on the cover suit propagated onto every interior spread —
 * the cover is the book's outfit ground truth, so a wardrobe violation
 * here multiplies 13×). Checks ONLY the child's clothing: national flags,
 * real-world brand logos, readable garment lettering. The cover's title
 * typography is expected and never flagged. Best-effort: infrastructure
 * failures PASS.
 *
 * @param {Buffer} imageBuffer
 * @returns {Promise<{pass: boolean, reason: string|null}>}
 */
async function qaCoverWardrobe(imageBuffer) {
  const apiKey = getNextApiKey() || process.env.GOOGLE_AI_STUDIO_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) return { pass: true, reason: null };
  const prompt = `You are checking a children's book cover. Inspect ONLY the child's CLOTHING/outfit (ignore the book title, background, and any signage).

Answer STRICT JSON only:
{
  "flag_on_clothing": true|false,   // any national flag (any country) on the outfit — patch, print, or badge
  "logo_on_clothing": true|false,   // any real-world brand/agency logo (e.g. NASA) on the outfit
  "lettering_on_clothing": true|false  // any readable letters/words/numbers printed on the outfit
}`;
  try {
    const resp = await fetchWithTimeout(
      `${GEMINI_IMAGE_API}/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: prompt },
              { inline_data: { mimeType: 'image/jpeg', data: imageBuffer.toString('base64') } },
            ],
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 256, responseMimeType: 'application/json' },
        }),
      },
      30000,
    );
    if (!resp.ok) return { pass: true, reason: null };
    const data = await resp.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    const json = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
    const failures = [
      json.flag_on_clothing && 'a national flag',
      json.logo_on_clothing && 'a brand logo',
      json.lettering_on_clothing && 'readable lettering',
    ].filter(Boolean);
    return failures.length > 0 ? { pass: false, reason: failures.join(' + ') } : { pass: true, reason: null };
  } catch (err) {
    console.warn(`[CoverGenerator] wardrobe QA failed to run (passing without QA): ${err.message}`);
    return { pass: true, reason: null };
  }
}

/**
 * Generate back cover illustration using Gemini, matching the front cover style.
 * ARTWORK ONLY — all back-cover text is typeset by drawBackCoverTypeset.
 *
 * @param {Buffer} frontCoverBuffer - Front cover image
 * @param {object} opts - { title, childName, synopsis, heartfeltNote, bookFrom, bookFormat }
 * @returns {Promise<Buffer|null>} Back cover image buffer, or null on failure
 */
async function generateBackCoverImage(frontCoverBuffer, opts = {}) {
  const { costTracker, bookFormat, isHardcover } = opts;
  const fmt = (bookFormat || '').toLowerCase();
  const isSquare = fmt === 'picture_book' || fmt === 'early_reader';

  const refFromCorner = await buildBackCoverStyleReferenceBuffer(frontCoverBuffer);

  // The back cover carries the most-read text on the book (the synopsis).
  // It is TYPESET with pdf-lib after generation — the image model paints
  // ARTWORK ONLY. Painted text shipped garbled words on a real customer
  // book (audit 2026-07-15: "stofor", "swoown"), and image models cannot
  // be trusted with letterforms. The prompt therefore reserves a calm
  // upper region for the typeset text instead of asking for any text.
  const layoutBlock = `LAYOUT REQUIREMENTS:
- This is artwork FOR the back cover — paint the SCENE itself, edge to edge
- Background: Use a softer, calmer version of the front cover's scene/colors — like a continuation of the world
- The main character should NOT appear on the back cover
- Include gentle, decorative elements from the story world (stars, clouds, or thematic elements from the front cover)
- The UPPER TWO-THIRDS must be calm, dark-leaning, and low-detail (open sky, soft gradient, distant scenery) — book text will be printed over it later, so no busy shapes, no high-contrast highlights there
- Keep richer scenery detail in the lower third only

FLAT PRINT ART ONLY — NEVER A MOCKUP: this image IS the printed surface. Do NOT paint a book, a book cover, or any physical product: no book lying on a table, no 3D book mockup with pages/spine/shadow, no frame or border around the artwork, no tabletop, no wall, no room. The scene fills the ENTIRE image edge to edge as flat artwork (a real customer book shipped with a picture of a book-on-a-table printed as its back cover — audit 2026-07-18).

ABSOLUTELY NO TEXT: do not render any words, letters, numbers, captions, titles, logos, or barcodes anywhere in the image. ALSO no blank labels, plaques, empty rectangles, frames, or barcode-shaped patches (audit: the model painted an empty white barcode-shaped box). The image must be 100% text-free, plaque-free artwork.

FORMAT: ${isSquare ? 'Square image, 1:1 aspect ratio' : 'Portrait image, 2:3 aspect ratio (width:height). The image must be taller than it is wide'}.

${buildCoverSafeZoneInstruction(!!isHardcover)}`;

  const withRefBlock = `Create full-bleed back-cover ARTWORK (a scene, not a picture of a book), rendered as a cinematic 3D Pixar-style CGI frame (NOT a 2D illustration, NOT a flat painting, NOT a soft storybook illustration).

STYLE REFERENCE: A small CROP from the front cover (corner/background) is attached ONLY to match color palette, lighting, and 3D rendering look. Do NOT copy or depict any person, child, or face from the reference. The main story character must NOT appear on the back cover.

${layoutBlock}`;

  const noRefBlock = `Create full-bleed back-cover ARTWORK (a scene, not a picture of a book), rendered as a cinematic 3D Pixar-style CGI frame (NOT a 2D illustration, NOT a flat painting, NOT a soft storybook illustration).

STYLE: No reference image is attached. Use a warm, premium 3D animated storybook look: cohesive palette, soft lighting, gentle decorative motifs — it should read as a calm companion to a personalized children’s book back cover. No characters in the image.

${layoutBlock}`;

  const apiKey = getNextApiKey() || process.env.GOOGLE_AI_STUDIO_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[CoverGenerator] No Gemini API key available for back cover generation');
    return null;
  }

  console.log('[CoverGenerator] Generating back cover illustration with Gemini...', {
    styleRef: refFromCorner ? 'corner-crop' : 'none (text-only)',
  });
  const startTime = Date.now();
  const model = 'gemini-3.1-flash-image';
  const maxAttempts = refFromCorner ? 2 : 1;

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const useImage = refFromCorner && attempt === 0;
      const prompt = useImage ? withRefBlock : noRefBlock;
      const userParts = [{ text: prompt }];
      if (useImage) {
        userParts.push({ inline_data: { mimeType: 'image/jpeg', data: refFromCorner.toString('base64') } });
      }

      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: userParts }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'], maxOutputTokens: 8192 },
          }),
        }
      );

      if (!resp.ok) {
        const err = await resp.text();
        if (attempt < maxAttempts - 1) {
          console.warn(`[CoverGenerator] Back cover attempt ${attempt + 1} HTTP error — retry:`, resp.status, err.slice(0, 200));
          continue;
        }
        throw new Error(`Gemini API error ${resp.status}: ${err.slice(0, 200)}`);
      }

      const data = await resp.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      let gotImage = false;
      for (const part of parts) {
        const img = geminiImagePartFromResponsePart(part);
        if (img) {
          gotImage = true;
          const buffer = Buffer.from(img.data, 'base64');
          if (costTracker) {
            costTracker.addImageGeneration('gemini-3.1-flash-image', 1);
          }
          // QA gate: a generated "back cover" that depicts a book mockup or
          // framed/photographic object must never reach print — reject and
          // fall through to the next attempt (or the typeset fallback panel).
          const qa = await qaBackCoverArtwork(buffer, apiKey);
          if (!qa.pass) {
            console.warn(`[CoverGenerator] Back cover attempt ${attempt + 1} REJECTED by QA: ${qa.reason}`);
            break;
          }
          const ms = Date.now() - startTime;
          console.log(`[CoverGenerator] Back cover generated in ${ms}ms (attempt ${attempt + 1})`);
          return buffer;
        }
      }
      if (!gotImage) logGeminiImageResponseDiagnostics(data, `back cover attempt ${attempt + 1} (no image)`);
      if (refFromCorner && attempt === 0) {
        console.warn('[CoverGenerator] Back cover: no image with corner-crop ref — retrying text-only');
      }
    }
    throw new Error('No image in Gemini response');
  } catch (err) {
    console.error(`[CoverGenerator] Back cover generation failed: ${err.message}`);
    return null;
  }
}

/**
 * Generate a Lulu-compliant wrap-around cover PDF.
 *
 * Layout (left → right): bleed | back cover | spine | front cover | bleed
 *
 * @param {string} title
 * @param {object} childDetails - { childName, childAge, childAppearance }
 * @param {string} characterRefUrl
 * @param {string} bookFormat - picture_book | early_reader (8.5×8.5) | GRAPHIC_NOVEL | chapter portrait (6×9 else branch)
 * @param {object} opts
 * @param {Buffer} [opts.preGeneratedCoverBuffer] - Customer-chosen cover; is re-rendered through
 *   {@link harmonizeChosenCoverToInteriorStyle} so the wrap PDF matches 3D interior art unless
 *   the source is provably already 3D.
 * @param {boolean} [opts.skipCoverStyleHarmonize] - Honored (skip restyle) ONLY when the source is
 *   provably already 3D (marker path / `coverSourceStyle` / `coverSourceIs3D`); otherwise ignored and
 *   the cover IS harmonized to 3D. Pass `false` to force harmonize.
 * @param {string} [opts.coverSourceStyle] - Known style of the source cover; 'pixar_premium'/'cinematic_3d' skip harmonize.
 * @param {boolean} [opts.coverSourceIs3D] - Explicit "source is already 3D" flag; allows skipping harmonize.
 * @returns {Promise<{coverPdfBuffer: Buffer, frontCoverImageUrl: string}>}
 */
async function generateCover(title, childDetails, characterRefUrl, bookFormat, opts = {}) {
  const fmt = (bookFormat || '').toLowerCase();
  const isPictureBook = fmt === 'picture_book';
  const isEarlyReader = fmt === 'early_reader';
  const isSquareTrim = isPictureBook || isEarlyReader;
  const isGraphicNovel = (bookFormat || '').toUpperCase() === 'GRAPHIC_NOVEL';
  let trimWidth, trimHeight;
  if (isSquareTrim) {
    trimWidth = 612;  // 8.5"
    trimHeight = 612; // 8.5"
  } else if (isGraphicNovel) {
    trimWidth = 477;  // 6.625" × 72
    trimHeight = 738; // 10.25" × 72
  } else {
    trimWidth = 432;  // 6" (chapter book and other portrait formats)
    trimHeight = 648; // 9"
  }
  const bleed = 9; // 0.125" Lulu standard

  const pageCount = opts.pageCount || 32;
  const isHardcover = (opts.bindingType || '').toUpperCase().includes('HARDCOVER');

  let totalWidth, totalHeight, spineWidth, hinge, edgeBleed;

  if (isHardcover) {
    // ── Lulu Hardcover Casewrap spec ──────────────────────────────────────────
    // Source: https://help.lulu.com/en/support/solutions/articles/64000308572
    // Canvas = wrap(0.875") + back + spine + front + wrap(0.875")
    // Height = wrap(0.875") + trim + wrap(0.875")
    // Required by Lulu for 8.5x8.5: 19.0" x 10.25" total canvas
    // Spine (Lulu hardcover table, mm → pt):
    //   24–84 pages: 6mm=17pt  |  85–168: 12mm=34pt  |  169–252: 18mm=51pt
    const wrap = 63; // 0.875" × 72 = 63pt (verified against Lulu error for 8.5x8.5)
    const spineTable = [[84,17],[168,34],[252,51],[336,69],[420,86],[504,103],[Infinity,120]];
    spineWidth = (spineTable.find(([max]) => pageCount <= max) || spineTable[spineTable.length-1])[1];
    hinge = 0;      // Hinge is part of the wrap area — no separate gap in PDF layout
    edgeBleed = wrap; // outer edge = wrap (includes bleed)
    totalWidth  = wrap + trimWidth + spineWidth + trimWidth + wrap;
    totalHeight = wrap + trimHeight + wrap;
  } else {
    // ── Lulu Paperback Perfect Bound spec ────────────────────────────────────
    const spineInches = pageCount * 0.002252 + 0.06;
    spineWidth  = Math.max(spineInches * 72, 6);
    hinge       = 0;
    edgeBleed   = bleed; // 0.125" standard bleed
    totalWidth  = bleed + trimWidth + spineWidth + trimWidth + bleed;
    totalHeight = trimHeight + bleed * 2;
  }

  console.log(`[CoverGenerator] Cover canvas: ${(totalWidth/72).toFixed(3)}"x${(totalHeight/72).toFixed(3)}", spine=${(spineWidth/72).toFixed(3)}", edge=${(edgeBleed/72).toFixed(3)}" (${pageCount}pp, ${isHardcover ? 'hardcover' : 'paperback'})`);

  const coverSourceUrl = opts.coverSourceUrl || '';
  // A source is "known 3D" only when it is provably already on-brand: an
  // explicit 3D marker in the path, or a caller-supplied style/flag.
  const sourceIsKnown3D = shouldSkipCoverStyleHarmonize(coverSourceUrl)
    || opts.coverSourceStyle === 'pixar_premium'
    || opts.coverSourceStyle === 'cinematic_3d'
    || opts.coverSourceIs3D === true;
  // Honor an explicit `skipCoverStyleHarmonize: true` ONLY when the source is
  // provably 3D; otherwise IGNORE the skip and harmonize (always-3D requirement).
  // An explicit `false` always forces harmonize.
  const skipCoverStyleHarmonize = opts.skipCoverStyleHarmonize === false
    ? false
    : sourceIsKnown3D;

  // ── Obtain front cover image ──
  let frontCoverImageUrl = null;
  let frontCoverBuffer = null;

  if (opts.preGeneratedCoverBuffer) {
    if (skipCoverStyleHarmonize) {
      console.log('[CoverGenerator] Using pre-generated cover buffer — skip harmonize (on-style or admin/upsell source or explicit flag)');
    } else {
      console.log('[CoverGenerator] Using pre-generated cover buffer — harmonizing to interior 3D illustration style');
    }
    const raw = opts.preGeneratedCoverBuffer;
    frontCoverBuffer = await harmonizeChosenCoverToInteriorStyle(raw, {
      bookFormat,
      costTracker: opts.costTracker,
      skipCoverStyleHarmonize,
    });
  } else {
    const artStyle = canonicalBookArtStyle(opts.artStyle);
    const aspectHint = isSquareTrim
      ? 'Square image, 1:1 aspect ratio.'
      : 'Portrait image, 2:3 aspect ratio (width:height). The image must be taller than it is wide.';
    const childAge = childDetails.childAge || childDetails.age || 5;
    const childName = childDetails.childName || childDetails.name;
    const safeZoneInstruction = buildCoverSafeZoneInstruction(isHardcover);
    // IMPORTANT: the cover is the style anchor for every interior spread.
    // Gemini weighs the reference image more than any interior prompt, so the
    // scene string below deliberately avoids phrases that prime the model
    // toward 2D painterly output ("children's book illustration", "whimsical
    // painting", "storybook cover"). Instead it frames the cover as a 3D CGI
    // Pixar feature-film key art shot. The concrete 3D rendering techniques
    // come from ART_STYLE_CONFIG[pixar_premium] inside generateIllustration.
    const coverScene = isGraphicNovel
      ? `A dramatic graphic novel cover illustration in a cinematic ${artStyle} style. `
        + `The main character is a ${childAge}-year-old child named ${childName}. `
        + `The scene should feel dynamic and action-oriented — suggesting an epic adventure. `
        + `The child should be prominently featured in a heroic or dramatic pose. `
        + `Background should be thematic with bold, graphic elements and dramatic lighting. `
        + `Portrait image, 2:3 aspect ratio (width:height). The image must be taller than it is wide. `
        + `Style: graphic novel / comic book cover aesthetic with strong composition.\n\n`
        + safeZoneInstruction
      : `A cinematic 3D Pixar feature-film key art cover — a single high-resolution frame that could be the opening poster of a modern Pixar movie. `
        + `The main character is a ${childAge}-year-old child named ${childName}, rendered as a believable 3D CGI character (real three-dimensional geometry, photoreal subsurface skin scattering, strand-by-strand hair, physically based materials — NOT a flat painting, NOT a watercolor, NOT a soft storybook illustration). `
        + `The scene should feel inviting, wondrous, and cinematic — promising a real adventure from the very first frame. `
        + `The child is the clear focal point, confident and emotionally expressive, with a strong silhouette and Pixar-quality facial acting. `
        + `Background is a thematic 3D environment with ray-traced volumetric lighting, real depth, and genuine optical bokeh — fully modeled, not painted. `
        + `WARDROBE RULE: the child's clothing must be completely letter-free — no name tags, no letter badges, no printed words on garments, no real-world brand logos (e.g. NASA), no national flags. Use plain fabric or generic letter-free emblems (a star patch, a simple rocket motif). The cover anchors every interior spread, and tiny repainted clothing text garbles into misspellings in print. `
        + aspectHint + '\n\n'
        + safeZoneInstruction;

    try {
      const imageUrl = await generateIllustration(
        coverScene, characterRefUrl, artStyle, {
          costTracker: opts.costTracker,
          bookId: opts.bookId,
          childAppearance: childDetails.appearance || childDetails.childAppearance,
          childName: childDetails.name || childDetails.childName,
          childPhotoUrl: opts.childPhotoUrl,
          _cachedPhotoBase64: opts._cachedPhotoBase64,
          _cachedPhotoMime: opts._cachedPhotoMime,
        },
      );
      frontCoverImageUrl = imageUrl;
      if (imageUrl) {
        frontCoverBuffer = await downloadBuffer(imageUrl);
      }
    } catch (err) {
      console.error('[CoverGenerator] Failed to generate cover illustration:', err.message);
    }

    // Wardrobe QA (2026-07-19 audit: a US-flag patch survived the prompt
    // rule and, as the outfit ground truth, propagated onto every interior
    // spread). One vision check + one hardened retry; if the retry still
    // fails, keep the first cover and warn — never block cover delivery.
    if (frontCoverBuffer) {
      const wq = await qaCoverWardrobe(frontCoverBuffer);
      if (!wq.pass) {
        console.warn(`[CoverGenerator] front cover wardrobe QA failed (${wq.reason}) — one hardened retry`);
        try {
          const retryScene = `${coverScene}\n\nCRITICAL WARDROBE REPAIR: the previous render put ${wq.reason} on the child's clothing. The outfit must carry NO flags, NO logos, NO letters — plain fabric or a generic star/rocket emblem only.`;
          const retryUrl = await generateIllustration(
            retryScene, characterRefUrl, artStyle, {
              costTracker: opts.costTracker,
              bookId: opts.bookId,
              childAppearance: childDetails.appearance || childDetails.childAppearance,
              childName: childDetails.name || childDetails.childName,
              childPhotoUrl: opts.childPhotoUrl,
              _cachedPhotoBase64: opts._cachedPhotoBase64,
              _cachedPhotoMime: opts._cachedPhotoMime,
            },
          );
          if (retryUrl) {
            const retryBuffer = await downloadBuffer(retryUrl);
            const wq2 = await qaCoverWardrobe(retryBuffer);
            if (wq2.pass) {
              frontCoverImageUrl = retryUrl;
              frontCoverBuffer = retryBuffer;
              console.log('[CoverGenerator] wardrobe retry cover accepted');
            } else {
              console.warn(`[CoverGenerator] wardrobe retry still fails (${wq2.reason}) — keeping first cover`);
            }
          }
        } catch (retryErr) {
          console.warn(`[CoverGenerator] wardrobe retry failed (keeping first cover): ${retryErr.message}`);
        }
      }
    }
  }

  // ── Extract dominant color from front cover for spine ──
  const coverColor = frontCoverBuffer
    ? await extractDominantColor(frontCoverBuffer)
    : { r: 0.95, g: 0.93, b: 0.88 };
  const spineBgColor = softenColor(coverColor, 0.3);

  // ── Generate back cover illustration with Gemini ──
  const childName = childDetails.childName || childDetails.name || '';
  const synopsis = opts.synopsis || '';
  const heartfeltNote = opts.heartfeltNote || '';
  const bookFrom = opts.bookFrom || '';

  let backCoverBuffer = null;
  if (frontCoverBuffer) {
    backCoverBuffer = await generateBackCoverImage(frontCoverBuffer, {
      title,
      childName,
      synopsis,
      heartfeltNote,
      bookFrom,
      costTracker: opts.costTracker,
      bookFormat,
      isHardcover,
    });
  }

  // ── Build wrap-around PDF ──
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`${title || 'My Story'} - Cover`);
  pdfDoc.setAuthor('GiftMyBook.com');
  const page = pdfDoc.addPage([totalWidth, totalHeight]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italicFont = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const backWidth = edgeBleed + trimWidth;
  const spineX = backWidth;

  // ═══════════════════════════════════════
  // SPINE BACKGROUND (drawn first as underlay)
  // ═══════════════════════════════════════
  // Extend spine color 0.5" (36pt) onto both covers for trimming variance (Lulu recommendation).
  // Drawn before cover images so it acts as a safety underlay — if trimming is slightly off,
  // the spine color shows through instead of a white gap.
  const spineColorOverlap = 36; // 0.5 inches = 36 points
  page.drawRectangle({
    x: spineX - spineColorOverlap, y: 0,
    width: spineWidth + (2 * spineColorOverlap), height: totalHeight,
    color: rgb(spineBgColor.r, spineBgColor.g, spineBgColor.b),
  });

  // ═══════════════════════════════════════
  // BACK COVER (left side)
  // ═══════════════════════════════════════

  if (backCoverBuffer) {
    // Use Gemini-generated back cover illustration.
    //
    // Same trim-fit + edge-copy extend strategy as the front cover: the spine
    // side is the RIGHT edge of the back cover, so bleed/wrap goes on the LEFT
    // (outer) side instead.
    try {
      const trimWpx = Math.round(trimWidth / 72 * 300);
      const trimHpx = Math.round(trimHeight / 72 * 300);
      const bleedPx = Math.round(edgeBleed / 72 * 300);
      const trimFit = await sharp(backCoverBuffer)
        .resize(trimWpx, trimHpx, { fit: 'cover', position: 'center' })
        .toBuffer();
      const resized = await sharp(await extendWithSoftWrap(trimFit, {
        top: bleedPx,
        bottom: bleedPx,
        left: bleedPx,
        right: 0,
      }))
        .toColorspace('srgb')
        .jpeg({ quality: 95 })
        .toBuffer();
      const img = await pdfDoc.embedJpg(resized);
      page.drawImage(img, { x: 0, y: 0, width: backWidth, height: totalHeight });
      console.log('[CoverGenerator] Back cover illustration embedded (textless art)');
    } catch (err) {
      console.error('[CoverGenerator] Failed to embed back cover illustration:', err.message);
      // Fall through to plain-color background
      backCoverBuffer = null;
    }
  }

  if (!backCoverBuffer) {
    // Fallback background: plain colored back cover
    const backBgColor = softenColor(coverColor, 0.6);
    page.drawRectangle({
      x: 0, y: 0,
      width: backWidth, height: totalHeight,
      color: rgb(backBgColor.r, backBgColor.g, backBgColor.b),
    });
  }

  // Typeset ALL back-cover text with pdf-lib — on art or fallback alike.
  // Never painted by the image model (see drawBackCoverTypeset).
  drawBackCoverTypeset(
    page,
    { edgeBleed, trimWidth, totalHeight },
    { font, boldFont, italicFont },
    { synopsis, heartfeltNote, bookFrom, childName },
  );

  // ═══════════════════════════════════════
  // SPINE TEXT (drawn after covers so text is on top)
  // ═══════════════════════════════════════
  // Lulu recommends: no spine text for books under 80 pages
  // Lower spineWidth threshold to 14pt — at 80 pages paperback spine is ~17pt
  if (pageCount >= 80 && spineWidth >= 14 && title) {
    // Font size with Lulu safety margins (0.125" = 9pt from each edge)
    const safetyMargin = 9; // 0.125" in points (Lulu recommendation)
    const availableWidth = spineWidth - (2 * safetyMargin);
    const spineFontSize = Math.min(8, Math.max(5, availableWidth * 0.7));

    // Only render text if there's enough room for a readable font
    if (availableWidth > 4) {
      // Truncate title to 42 chars max (Lulu hardcover limit)
      const spineTitle = title.length > 42 ? title.substring(0, 39) + '...' : title;
      const spineTextWidth = boldFont.widthOfTextAtSize(spineTitle, spineFontSize);
      // Center text horizontally within the spine
      const textX = spineX + spineWidth / 2 + spineFontSize * 0.35;
      // Center text vertically — account for text width since it's rotated -90°
      const textY = totalHeight / 2 + spineTextWidth / 2;
      page.drawText(spineTitle, {
        x: textX,
        y: textY,
        size: spineFontSize,
        font: boldFont,
        color: rgb(0.2, 0.18, 0.15),
        rotate: degrees(-90),
      });
    }
  }

  // ═══════════════════════════════════════
  // FRONT COVER (right side)
  // ═══════════════════════════════════════
  const frontX = backWidth + spineWidth;
  const frontWidth = trimWidth + edgeBleed;

  // Background fallback
  const backBgColor = softenColor(coverColor, 0.6);
  page.drawRectangle({
    x: frontX, y: 0,
    width: frontWidth, height: totalHeight,
    color: rgb(backBgColor.r, backBgColor.g, backBgColor.b),
  });

  // Embed front cover illustration at 300 DPI.
  //
  // Print safety: we resize the AI image to EXACTLY fill the trim area, then
  // extend the edges outward to fill the bleed (paperback) or wrap (hardcover
  // casewrap) area via extendWithSoftWrap — copy-extend with the band blurred
  // into a soft fade (copy avoids mirror's symmetric reflection; the blur
  // removes copy's raw pixel streaks).
  //
  // Front cover bleed layout: spine-side (left) flush, outer (right), top,
  // bottom all need bleed/wrap.
  if (frontCoverBuffer) {
    try {
      const trimWpx = Math.round(trimWidth / 72 * 300);
      const trimHpx = Math.round(trimHeight / 72 * 300);
      const bleedPx = Math.round(edgeBleed / 72 * 300);
      const trimFit = await sharp(frontCoverBuffer)
        .resize(trimWpx, trimHpx, { fit: 'cover', position: 'center' })
        .toBuffer();
      const resized = await sharp(await extendWithSoftWrap(trimFit, {
        top: bleedPx,
        bottom: bleedPx,
        left: 0,
        right: bleedPx,
      }))
        .toColorspace('srgb')
        .jpeg({ quality: 95 })
        .toBuffer();
      const img = await pdfDoc.embedJpg(resized);
      page.drawImage(img, {
        x: frontX, y: 0,
        width: frontWidth,
        height: totalHeight,
      });
    } catch (err) {
      console.error('[CoverGenerator] Failed to embed cover image:', err.message);
    }
  }

  const pdfBytes = await pdfDoc.save();
  // ── Upload back cover image to GCS so it can be used in the interior flipbook ──
  let backCoverImageUrl = null;
  if (backCoverBuffer) {
    try {
      const { uploadBuffer: _upload, getSignedUrl: _sign } = require('./gcsStorage');
      const backGcsPath = `children-jobs/${opts.bookId || 'unknown'}/back-cover.jpg`;
      const backJpeg = await sharp(backCoverBuffer)
        .resize(800, 800, { fit: 'cover' })
        .toColorspace('srgb')
        .jpeg({ quality: 90 })
        .toBuffer();
      await _upload(backJpeg, backGcsPath, 'image/jpeg');
      backCoverImageUrl = await _sign(backGcsPath, 30 * 24 * 60 * 60 * 1000);
      console.log('[CoverGenerator] Back cover image uploaded to GCS');
    } catch (err) {
      console.warn('[CoverGenerator] Back cover GCS upload failed (non-fatal):', err.message);
    }
  }

  return {
    coverPdfBuffer: Buffer.from(pdfBytes),
    frontCoverImageUrl,
    backCoverImageUrl,
  };
}

// ── Upsell Cover Generation ──

// Consumer-facing "vibe" ids used to vary the 4 upsell covers' titles/labels.
// NOTE: the actual RENDER style is NOT taken from these — buildUpsellCoverPrompt
// forces every upsell cover to 3D pixar_premium via canonicalBookArtStyle, so a
// selected upsell cover always matches the 3D interiors (always-3D lock).
const UPSELL_STYLES = ['paper_cutout', 'watercolor', 'cinematic_3d', 'scandinavian_minimal'];

// Consumer-facing art-style names — these print INSIDE the gift book on the
// "choose the next adventure" pages (2026-07-18 print audit: the old values
// read as internal taxonomy — "PAPER CUTOUT", "SCANDINAVIAN MINIMAL" — on a
// child's keepsake). Keys are the internal style ids and must not change.
const UPSELL_STYLE_LABELS = {
  paper_cutout: 'Paper Magic',
  watercolor: 'Soft Watercolor',
  cinematic_3d: 'Movie Magic',
  scandinavian_minimal: 'Cozy Classic',
};

/**
 * Generate 4 upsell cover titles using GPT 5.4.
 */
async function generateUpsellTitles(childName, childAge, approvedTitle, openaiApiKey, costTracker, childGender) {
  const key = openaiApiKey || process.env.OPENAI_API_KEY;
  if (!key) return null;

  const system = `You are a children's book title writer. Generate 4 short, irresistible book titles for a personalized children's book.
Each title must feel like a brand-new adventure for the same child.
Titles should be warm, specific, and emotionally evocative.
Do NOT use the word "adventure". Do NOT copy the original title.
Return JSON: { "titles": ["Title 1", "Title 2", "Title 3", "Title 4"] }`;

  const genderNote = childGender === 'male'
    ? ' The child is a boy — any pronouns or gendered words in the title must be masculine (him/his, prince, brother, etc.).'
    : childGender === 'female'
      ? ' The child is a girl — any pronouns or gendered words in the title must be feminine (her/hers, princess, sister, etc.).'
      : '';
  const user = `Child: ${childName}, age ${childAge}.${genderNote} Original book title: "${approvedTitle}". Generate 4 completely different titles for their next book.`;

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_completion_tokens: 300,
        temperature: 1.0,
        response_format: { type: 'json_object' },
      }),
    });
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content);
    return parsed.titles || null;
  } catch (err) {
    console.warn(`[coverGenerator] Upsell title generation failed: ${err.message}`);
    return null;
  }
}

/**
 * Build the text prompt for a single upsell cover.
 * Exported for testability.
 *
 * @param {string} title
 * @param {string} childName
 * @param {number} childAge
 * @param {string} childGender - 'male' | 'female' | 'neutral'
 * @param {string} artStyle - one of UPSELL_STYLES
 * @param {object} [identity] - { characterDescription, characterAnchor }
 * @returns {string}
 */
function buildUpsellCoverPrompt(title, childName, childAge, childGender, artStyle, identity = {}) {
  // ALWAYS-3D LOCK: an upsell cover can be SELECTED as a book's real cover, and
  // interiors are hard-locked to 3D pixar_premium. So the incoming `artStyle`
  // (paper_cutout / watercolor / scandinavian_minimal — the UPSELL_STYLES labels
  // are consumer vibes only) is routed through canonicalBookArtStyle, which
  // ignores it and always returns pixar_premium. A 2D upsell cover can never
  // become the shipped cover style on a 3D book.
  const resolvedStyle = canonicalBookArtStyle(artStyle);
  const styleConfig = ART_STYLE_CONFIG?.[resolvedStyle] || {};
  const styleBlock = renderStyleBlock(styleConfig);

  const genderWord = childGender === 'male' ? 'boy' : childGender === 'female' ? 'girl' : 'young child';

  const parts = [];

  parts.push(`REFERENCE IMAGE RULES: The attached image is ONLY a character-likeness reference for ${childName}. Use it ONLY to match ${childName}'s face, hair, skin tone, and build. Do NOT copy the composition, background, props, color palette, title treatment, typography, framing, or overall visual style of the reference image. The output must be a completely NEW illustration.`);

  if (identity.theme === 'mothers_day') {
    parts.push(`GENDER (AUTHORITATIVE): ${childName} is a ${genderWord}. ${childGender === 'male' ? 'Depict a boy.' : childGender === 'female' ? 'Depict a girl.' : 'Depict a young child without inventing gendered cues not present in the reference.'}`);
    const momDesc = identity.momDescription || 'a warm, loving woman with a gentle smile';
    const momRefNote = identity.momDescription ? ' Mom must look consistent with the reference photo.' : ' No secondary character was detected in the uploaded photo, so use a warm, generic appearance for Mom.';
    parts.push(`LOVE TO MOM COVER: This is a Love to mom book. The cover MUST show BOTH ${childName} AND Mom together. Mom's appearance: ${momDesc}. Show a warm, loving moment between child and mother — holding hands, hugging, or side by side.${momRefNote}`);
    parts.push(`CRITICAL — same-family rendering: ${childName} and Mom MUST read as the same family. Mom's skin tone, undertone, and ethnicity must plausibly match ${childName}'s. If any reference describes Mom with a different skin tone than ${childName}, render Mom with ${childName}'s skin tone and undertone — do NOT reproduce a mismatched skin tone from the reference. The book's interior spreads will lock to this cover, so any cover-level skin mismatch propagates throughout the book.`);
  } else {
    parts.push(`GENDER (AUTHORITATIVE): ${childName} is a ${genderWord}. ${childGender === 'male' ? 'Depict a boy.' : childGender === 'female' ? 'Depict a girl.' : 'Depict a young child without inventing gendered cues not present in the reference.'} If the reference image shows multiple people, ONLY depict ${childName} — the main child matching this stated gender. Do NOT include siblings or secondary figures from the reference.`);
  }

  if (identity.characterDescription) {
    parts.push(`CHARACTER APPEARANCE LOCK: ${identity.characterDescription}`);
  }
  if (identity.characterAnchor) {
    parts.push(`PHYSICAL IDENTITY LOCK: ${identity.characterAnchor}`);
  }

  parts.push(`Book cover for a book titled "${title}". The main character is ${childName}, a ${childAge}-year-old ${genderWord}. Show ${childName} in a warm, magical scene that feels full of possibility and wonder. Premium, inviting, irresistibly cute. Large bold title at top. "By GiftMyBook" at bottom.\n\nWARDROBE RULE: ${childName}'s clothing must be completely letter-free — no name tags, no letter badges, no printed words on garments, no real-world brand logos, no national flags. Plain fabric or generic letter-free emblems only.\n\nART STYLE: ${styleBlock}`);

  return parts.join('\n\n');
}

/**
 * Generate a single upsell cover image for a given style and title.
 *
 * @param {string} title
 * @param {string} childName
 * @param {number} childAge
 * @param {string} childGender
 * @param {string} artStyle
 * @param {Buffer} frontCoverBuffer
 * @param {object} [identity] - { characterDescription, characterAnchor }
 */
async function generateUpsellCoverImage(title, childName, childAge, childGender, artStyle, frontCoverBuffer, identity = {}) {
  const { getNextApiKey, fetchWithTimeout } = require('./illustrationGenerator');

  const prompt = buildUpsellCoverPrompt(title, childName, childAge, childGender, artStyle, identity);

  const apiKey = getNextApiKey();
  if (!apiKey) throw new Error('No Gemini API key available for upsell cover generation');

  // Resize cover reference to 256px
  const ref = await sharp(frontCoverBuffer)
    .resize(256, 256, { fit: 'cover' })
    .jpeg({ quality: 80 })
    .toBuffer();
  const refBase64 = ref.toString('base64');

  const model = 'gemini-3.1-flash-image';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // Use fetchWithTimeout (same as illustrationGenerator) — 3 min per cover
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [
        { text: prompt },
        { inline_data: { mimeType: 'image/jpeg', data: refBase64 } },
      ]}],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], maxOutputTokens: 8192 },
    }),
  }, 3 * 60 * 1000); // 3-min timeout

  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${await resp.text().then(t => t.slice(0, 100))}`);

  const data = await resp.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const img = geminiImagePartFromResponsePart(part);
    if (img) return Buffer.from(img.data, 'base64');
  }
  // Fallback: try proxy if direct call returned no image
  const PROXY_URL = process.env.GEMINI_PROXY_URL || '';
  const PROXY_API_KEY = process.env.GEMINI_PROXY_API_KEY || '';
  if (PROXY_URL) {
    console.log('[coverGenerator] Direct Gemini returned no image — trying proxy fallback');
    const proxyResp = await fetchWithTimeout(`${PROXY_URL}/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': PROXY_API_KEY },
      body: JSON.stringify({ prompt, model }),
    }, 3 * 60 * 1000);
    if (!proxyResp.ok) throw new Error(`Proxy fallback ${proxyResp.status}`);
    const proxyData = await proxyResp.json();
    if (proxyData.imageBase64) return Buffer.from(proxyData.imageBase64, 'base64');
  }
  throw new Error('No image in Gemini response (direct + proxy both failed)');
}

/**
 * Generate 4 upsell covers in parallel and upload to GCS.
 * Returns array of { title, artStyle, styleLabel, gcsPath, coverUrl }
 *
 * @param {string} bookId
 * @param {object} childDetails - { name/childName, age/childAge, gender/childGender }
 * @param {Buffer} frontCoverBuffer - approved front cover
 * @param {string} approvedTitle
 * @param {object} opts - { openaiApiKey, apiKeys, costTracker, characterDescription, characterAnchor }
 */
async function generateUpsellCovers(bookId, childDetails, frontCoverBuffer, approvedTitle, opts = {}) {
  const pLimit = require('p-limit');
  const { uploadBuffer, getSignedUrl } = require('./gcsStorage');

  const childName = childDetails.childName || childDetails.name || 'the child';
  const childAge = childDetails.childAge || childDetails.age || 5;
  const rawGender = childDetails.childGender || childDetails.gender || 'neutral';
  // Normalise 'boy'→'male', 'girl'→'female' so DB values work correctly
  const normGender = rawGender === 'boy' ? 'male' : rawGender === 'girl' ? 'female' : rawGender;
  const childGender = ['male', 'female', 'neutral'].includes(normGender) ? normGender : 'neutral';
  const openaiApiKey = opts.openaiApiKey || opts.apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  const identity = {
    characterDescription: opts.characterDescription || null,
    characterAnchor: opts.characterAnchor || null,
    theme: opts.theme || null,
    momDescription: opts.momDescription || null,
  };

  console.log(`[coverGenerator] Generating upsell covers for ${childName} (age=${childAge}, gender=${childGender})...`);

  // Step 1: Generate 4 unique titles
  let titles = await generateUpsellTitles(childName, childAge, approvedTitle, openaiApiKey, opts.costTracker, childGender);
  if (!titles || titles.length < 4) {
    // Fallback titles
    titles = [
      `${childName} and the Whispering Moon`,
      `The Day ${childName} Found the Rainbow Door`,
      `${childName}'s Secret Garden of Stars`,
      `Where Does ${childName} Dream Tonight?`,
    ];
    console.warn('[coverGenerator] Using fallback upsell titles');
  }

  // Step 2: Generate 4 covers in parallel (one per style)
  const limit = pLimit(4); // all 4 in parallel — they use different API keys anyway
  const results = await Promise.allSettled(
    UPSELL_STYLES.map((style, index) =>
      limit(async () => {
        const title = titles[index];

        console.log(`[coverGenerator] Generating upsell cover ${index + 1}/4: "${title}" (${style})...`);
        const startMs = Date.now();

        try {
          const imgBuffer = await generateUpsellCoverImage(
            title, childName, childAge, childGender, style, frontCoverBuffer, identity
          );

          const gcsPath = `children-jobs/${bookId}/upsell/${index}/cover.png`;
          await uploadBuffer(imgBuffer, gcsPath, 'image/png');
          const coverUrl = await getSignedUrl(gcsPath, 90 * 24 * 60 * 60 * 1000); // 90-day URL

          console.log(`[coverGenerator] Upsell cover ${index + 1} ready in ${Date.now() - startMs}ms`);
          return { index, title, artStyle: style, styleLabel: UPSELL_STYLE_LABELS[style], gcsPath, coverUrl };
        } catch (err) {
          console.error(`[coverGenerator] Upsell cover ${index + 1} failed: ${err.message}`);
          return null;
        }
      })
    )
  );

  const covers = results
    .map(r => r.status === 'fulfilled' ? r.value : null)
    .filter(Boolean);

  console.log(`[coverGenerator] ${covers.length}/4 upsell covers generated`);
  return covers;
}

module.exports = {
  generateCover,
  generateUpsellCovers,
  buildUpsellCoverPrompt,
  UPSELL_STYLES,
  UPSELL_STYLE_LABELS,
  geminiImagePartFromResponsePart,
  shouldSkipCoverStyleHarmonize,
  wrapTextToWidth,
  drawBackCoverTypeset,
  qaBackCoverArtwork,
  qaCoverWardrobe,
  extendWithSoftWrap,
};
