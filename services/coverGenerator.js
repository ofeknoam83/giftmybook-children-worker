/**
 * Cover Generator — Creates Lulu-compliant wrap-around cover PDF
 * (back cover + spine + front cover) with 0.125" bleed.
 *
 * Back cover: Gemini-generated illustration matching front cover style,
 * with synopsis, heartfelt note, branding, and fake barcode integrated.
 * Spine: Color-matched to front cover, no text for books under 80 pages.
 */

const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');
const {
  generateIllustration,
  getNextApiKey,
  fetchWithTimeout,
  renderStyleBlock,
  ART_STYLE_CONFIG,
} = require('./illustrationGenerator');
const { downloadBuffer } = require('./gcsStorage');
const { OPENAI_IMAGES_EDIT_URL } = require('./illustrator/config');
const { postImagesEdits } = require('./illustrator/openaiImagesHttp');
const sharp = require('sharp');

const OPENAI_COVER_HARMONIZE_MODEL = 'gpt-image-2';
const GEMINI_HARMONIZE_MODEL = 'gemini-3.1-flash-image-preview';
const GEMINI_IMAGE_API = 'https://generativelanguage.googleapis.com/v1beta/models';

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
 * the AI image to EXACTLY fill the trim area (with mirrored edges into the
 * bleed/wrap), the AI's own image frame maps to the trim line — so we ask
 * for a generous interior safety buffer against minor trim variance and
 * the mirrored edge extension.
 *
 * @param {boolean} isHardcover
 * @returns {string} Multi-line instruction appended to the AI prompt
 */
function buildCoverSafeZoneInstruction(isHardcover) {
  const edgePct = isHardcover ? 12 : 8;
  const topPct = isHardcover ? 15 : 10;
  return [
    `COVER PRINT SAFETY (CRITICAL — Lulu ${isHardcover ? 'hardcover casewrap' : 'paperback'}):`,
    `- The outer ~${edgePct}% of every edge of this image will be TRIMMED, BLED, OR WRAPPED around the book during printing. Anything placed there WILL BE CUT OFF or hidden on the inside of the cover.`,
    `- Keep ALL title text, the child's face, logos, subtitles, and any critical element at least ${topPct}% away from the TOP edge and at least ${edgePct}% away from the bottom, left, and right edges.`,
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
 * OpenAI `gpt-image-2` edits first (matches book-pipeline gpt-image-2 when configured);
 * falls back to Gemini image if OpenAI is unavailable or fails. On total failure
 * returns the original buffer.
 *
 * @param {Buffer} frontCoverBuffer
 * @param {object} [opts]
 * @param {string} [opts.bookFormat] - PICTURE_BOOK (square) vs portrait early reader
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

  const isPictureBook = (opts.bookFormat || '').toLowerCase() === 'picture_book';
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
    'TRANSFORM: If the input is 2D, watercolor, painterly, or flat illustrated, re-render it as true 3D CGI: photoreal subsurface skin, strand hair, PBR materials, ray-traced volumetric lighting, real optical bokeh, fully modeled environment — NOT a soft storybook painting.',
    'FORBID: a different book title, extra characters, missing characters, or a new scene. No poster typography that ignores the input text.',
    '',
    'STYLE LOCK (match book interiors):',
    styleBlock,
  ].join('\n');

  const size = isPictureBook ? '2048x2048' : '1024x1536';
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    try {
      const result = await postImagesEdits({
        apiKey,
        url: OPENAI_IMAGES_EDIT_URL,
        model: OPENAI_COVER_HARMONIZE_MODEL,
        prompt: basePrompt,
        size,
        imageFiles: [{ buffer: jpegRef, filename: 'chosen-cover.jpg', mimeType: 'image/jpeg' }],
        timeoutMs: 180000,
      });
      if (result.ok) {
        const b64 = result.data?.data?.[0]?.b64_json;
        if (b64) {
          console.log('[CoverGenerator] Chosen cover harmonized to 3D interior style (OpenAI gpt-image-2)');
          if (opts.costTracker) opts.costTracker.addImageGeneration(OPENAI_COVER_HARMONIZE_MODEL, 1);
          return Buffer.from(b64, 'base64');
        }
      } else {
        console.warn('[CoverGenerator] OpenAI cover harmonize failed:', result.status, (result.text || '').slice(0, 300));
      }
    } catch (e) {
      console.warn('[CoverGenerator] OpenAI cover harmonize error:', e.message);
    }
  }

  // --- Gemini image fallback (same model family as back cover) ---
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
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
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
      if (part.inlineData?.mimeType?.startsWith('image/') && part.inlineData?.data) {
        console.log('[CoverGenerator] Chosen cover harmonized to 3D interior style (Gemini fallback)');
        if (opts.costTracker) opts.costTracker.addImageGeneration(GEMINI_HARMONIZE_MODEL, 1);
        return Buffer.from(part.inlineData.data, 'base64');
      }
    }
  } catch (e) {
    console.warn('[CoverGenerator] Gemini cover harmonize error:', e.message);
  }

  return frontCoverBuffer;
}

/**
 * Generate back cover illustration using Gemini, matching the front cover style.
 *
 * @param {Buffer} frontCoverBuffer - Front cover image
 * @param {object} opts - { title, childName, synopsis, heartfeltNote, bookFrom, bookFormat }
 * @returns {Promise<Buffer|null>} Back cover image buffer, or null on failure
 */
async function generateBackCoverImage(frontCoverBuffer, opts = {}) {
  const { title, childName, synopsis, heartfeltNote, bookFrom, costTracker, bookFormat, isHardcover } = opts;
  const isSquare = (bookFormat || '').toLowerCase() === 'picture_book';

  // Resize front cover to use as style reference
  const refBuffer = await sharp(frontCoverBuffer)
    .resize(512, 512, { fit: 'cover' })
    .jpeg({ quality: 80 })
    .toBuffer();
  const refBase64 = refBuffer.toString('base64');

  // Build the text elements for the back cover
  const textElements = [];
  if (synopsis) {
    textElements.push(`At the top center, in Bubblegum Sans font (rounded, bubbly, matching the interior pages):\n"${synopsis}"`);
  }
  if (heartfeltNote) {
    const noteText = bookFrom
      ? `${heartfeltNote}\n— ${bookFrom}`
      : heartfeltNote;
    textElements.push(`Below a small decorative separator:\n${noteText}`);
  }
  textElements.push(`Near the bottom center:\n"Made with love for ${childName || 'you'}"\n"GiftMyBook.com"`);

  const prompt = `Create the back cover image for a book, rendered as a cinematic 3D Pixar-style CGI frame (NOT a 2D illustration, NOT a flat painting, NOT a soft storybook illustration).

STYLE REFERENCE: Match the EXACT same art style, color palette, lighting, textures, and visual mood as the reference image (the front cover). If the front cover is a 3D CGI render, this back cover must also be a 3D CGI render — same rendering technique, same 3D geometry, same photoreal materials.

LAYOUT REQUIREMENTS:
- This is the BACK COVER of the book — it should feel like a companion to the front cover
- Background: Use a softer, calmer version of the front cover's scene/colors — like a continuation of the world
- The main character should NOT appear on the back cover
- Include gentle, decorative elements from the story world (stars, clouds, or thematic elements from the front cover)

TEXT TO INCLUDE (render beautifully integrated into the illustration):

${textElements.join('\n\n')}

BARCODE: Include a realistic-looking fake barcode in the bottom-left corner (standard book barcode size, approximately 2" x 1.25"). It should look like a real ISBN barcode with vertical lines and numbers underneath, but the numbers can be fictional.

TEXT RULES:
- ALL text must be perfectly legible and correctly spelled
- FONT: Use Bubblegum Sans — rounded, bubbly, matching the interior pages exactly
- Use warm, soft colors that match the front cover palette
- Text should feel integrated into the illustration, not overlaid
- The overall feel should be warm, cozy, and premium

FORMAT: ${isSquare ? 'Square image, 1:1 aspect ratio' : 'Portrait image, 2:3 aspect ratio (width:height). The image must be taller than it is wide'}.

${buildCoverSafeZoneInstruction(!!isHardcover)}`;

  const apiKey = getNextApiKey() || process.env.GOOGLE_AI_STUDIO_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[CoverGenerator] No Gemini API key available for back cover generation');
    return null;
  }

  console.log('[CoverGenerator] Generating back cover illustration with Gemini...');
  const startTime = Date.now();

  try {
    const model = 'gemini-3.1-flash-image-preview';
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { text: prompt },
            { inline_data: { mimeType: 'image/jpeg', data: refBase64 } },
          ]}],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        }),
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Gemini API error ${resp.status}: ${err.slice(0, 200)}`);
    }

    const data = await resp.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData?.mimeType?.startsWith('image/')) {
        const ms = Date.now() - startTime;
        console.log(`[CoverGenerator] Back cover generated in ${ms}ms`);
        if (costTracker) {
          costTracker.addImageGeneration('gemini-3.1-flash-image-preview', 1);
        }
        return Buffer.from(part.inlineData.data, 'base64');
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
 * @param {string} bookFormat - PICTURE_BOOK or EARLY_READER
 * @param {object} opts
 * @param {Buffer} [opts.preGeneratedCoverBuffer] - Customer-chosen cover; is re-rendered through
 *   {@link harmonizeChosenCoverToInteriorStyle} so the wrap PDF matches 3D interior art unless
 *   `skipCoverStyleHarmonize` is set.
 * @param {boolean} [opts.skipCoverStyleHarmonize] - If true, embed the chosen cover buffer as-is (no restyle pass).
 * @returns {Promise<{coverPdfBuffer: Buffer, frontCoverImageUrl: string}>}
 */
async function generateCover(title, childDetails, characterRefUrl, bookFormat, opts = {}) {
  const isPictureBook = (bookFormat || '').toLowerCase() === 'picture_book';
  const isGraphicNovel = (bookFormat || '').toUpperCase() === 'GRAPHIC_NOVEL';
  let trimWidth, trimHeight;
  if (isPictureBook) {
    trimWidth = 612;  // 8.5"
    trimHeight = 612; // 8.5"
  } else if (isGraphicNovel) {
    trimWidth = 477;  // 6.625" × 72
    trimHeight = 738; // 10.25" × 72
  } else {
    trimWidth = 432;  // 6" (early reader, chapter book)
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

  // ── Obtain front cover image ──
  let frontCoverImageUrl = null;
  let frontCoverBuffer = null;

  if (opts.preGeneratedCoverBuffer) {
    console.log('[CoverGenerator] Using pre-generated cover buffer — harmonizing to interior 3D illustration style');
    const raw = opts.preGeneratedCoverBuffer;
    frontCoverBuffer = await harmonizeChosenCoverToInteriorStyle(raw, {
      bookFormat,
      costTracker: opts.costTracker,
      skipCoverStyleHarmonize: opts.skipCoverStyleHarmonize,
    });
  } else {
    const artStyle = opts.artStyle || 'pixar_premium';
    const aspectHint = isPictureBook
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
    // Same trim-fit + mirrored-extend strategy as the front cover, but
    // mirrored horizontally: the spine side is the RIGHT edge of the back
    // cover, so bleed/wrap goes on the LEFT (outer) side instead.
    try {
      const trimWpx = Math.round(trimWidth / 72 * 300);
      const trimHpx = Math.round(trimHeight / 72 * 300);
      const bleedPx = Math.round(edgeBleed / 72 * 300);
      const resized = await sharp(backCoverBuffer)
        .resize(trimWpx, trimHpx, { fit: 'cover', position: 'center' })
        .extend({
          top: bleedPx,
          bottom: bleedPx,
          left: bleedPx,
          right: 0,
          extendWith: 'mirror',
        })
        .toColorspace('srgb')
        .jpeg({ quality: 95 })
        .toBuffer();
      const img = await pdfDoc.embedJpg(resized);
      page.drawImage(img, { x: 0, y: 0, width: backWidth, height: totalHeight });
      console.log('[CoverGenerator] Back cover illustration embedded');
    } catch (err) {
      console.error('[CoverGenerator] Failed to embed back cover illustration:', err.message);
      // Fall through to plain text fallback
      backCoverBuffer = null;
    }
  }

  if (!backCoverBuffer) {
    // Fallback: plain colored back cover with text
    const backBgColor = softenColor(coverColor, 0.6);
    const textColor = { r: 0.2, g: 0.18, b: 0.15 };
    page.drawRectangle({
      x: 0, y: 0,
      width: backWidth, height: totalHeight,
      color: rgb(backBgColor.r, backBgColor.g, backBgColor.b),
    });

    const centerX = bleed + trimWidth / 2;
    const contentWidth = trimWidth - 72;

    // Synopsis
    if (synopsis) {
      const words = synopsis.split(/\s+/);
      const lines = [];
      let cl = '';
      for (const w of words) {
        const tl = cl ? `${cl} ${w}` : w;
        if (font.widthOfTextAtSize(tl, 12) > contentWidth && cl) { lines.push(cl); cl = w; } else { cl = tl; }
      }
      if (cl) lines.push(cl);
      let y = totalHeight - bleed - 100;
      for (const line of lines) {
        const lw = font.widthOfTextAtSize(line, 12);
        page.drawText(line, { x: centerX - lw / 2, y, size: 12, font, color: rgb(textColor.r, textColor.g, textColor.b) });
        y -= 20;
      }
    }

    // Brand
    const brand = 'GiftMyBook.com';
    const bw = font.widthOfTextAtSize(brand, 8);
    page.drawText(brand, { x: centerX - bw / 2, y: bleed + 25, size: 8, font, color: rgb(0.5, 0.5, 0.5) });
  }

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
  // mirror-extend the pixels outward to fill the bleed (paperback) or wrap
  // (hardcover casewrap) area. This guarantees the AI's composition —
  // especially the title baked into the image — lives entirely inside the
  // visible trimmed face of the book, and the mirrored pixels fill the
  // wrap/bleed zone without introducing white bars or distorted content.
  //
  // Front cover bleed layout: spine-side (left) flush, outer (right), top,
  // bottom all need bleed/wrap.
  if (frontCoverBuffer) {
    try {
      const trimWpx = Math.round(trimWidth / 72 * 300);
      const trimHpx = Math.round(trimHeight / 72 * 300);
      const bleedPx = Math.round(edgeBleed / 72 * 300);
      const resized = await sharp(frontCoverBuffer)
        .resize(trimWpx, trimHpx, { fit: 'cover', position: 'center' })
        .extend({
          top: bleedPx,
          bottom: bleedPx,
          left: 0,
          right: bleedPx,
          extendWith: 'mirror',
        })
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

const UPSELL_STYLES = ['paper_cutout', 'watercolor', 'cinematic_3d', 'scandinavian_minimal'];

const UPSELL_STYLE_LABELS = {
  paper_cutout: 'Paper Cutout',
  watercolor: 'Watercolor',
  cinematic_3d: 'Cinematic 3D',
  scandinavian_minimal: 'Scandinavian Minimal',
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
  const { ART_STYLE_CONFIG, renderStyleBlock } = require('./illustrationGenerator');
  const styleConfig = ART_STYLE_CONFIG?.[artStyle] || {};
  const styleBlock = renderStyleBlock(styleConfig);

  const genderWord = childGender === 'male' ? 'boy' : childGender === 'female' ? 'girl' : 'young child';

  const parts = [];

  parts.push(`REFERENCE IMAGE RULES: The attached image is ONLY a character-likeness reference for ${childName}. Use it ONLY to match ${childName}'s face, hair, skin tone, and build. Do NOT copy the composition, background, props, color palette, title treatment, typography, framing, or overall visual style of the reference image. The output must be a completely NEW illustration.`);

  if (identity.theme === 'mothers_day') {
    parts.push(`GENDER (AUTHORITATIVE): ${childName} is a ${genderWord}. ${childGender === 'male' ? 'Depict a boy.' : childGender === 'female' ? 'Depict a girl.' : 'Depict a young child without inventing gendered cues not present in the reference.'}`);
    const momDesc = identity.momDescription || 'a warm, loving woman with a gentle smile';
    const momRefNote = identity.momDescription ? ' Mom must look consistent with the reference photo.' : ' No secondary character was detected in the uploaded photo, so use a warm, generic appearance for Mom.';
    parts.push(`LOVE TO MOM COVER: This is a Love to mom book. The cover MUST show BOTH ${childName} AND Mom together. Mom's appearance: ${momDesc}. Show a warm, loving moment between child and mother — holding hands, hugging, or side by side.${momRefNote}`);
  } else {
    parts.push(`GENDER (AUTHORITATIVE): ${childName} is a ${genderWord}. ${childGender === 'male' ? 'Depict a boy.' : childGender === 'female' ? 'Depict a girl.' : 'Depict a young child without inventing gendered cues not present in the reference.'} If the reference image shows multiple people, ONLY depict ${childName} — the main child matching this stated gender. Do NOT include siblings or secondary figures from the reference.`);
  }

  if (identity.characterDescription) {
    parts.push(`CHARACTER APPEARANCE LOCK: ${identity.characterDescription}`);
  }
  if (identity.characterAnchor) {
    parts.push(`PHYSICAL IDENTITY LOCK: ${identity.characterAnchor}`);
  }

  parts.push(`Book cover for a book titled "${title}". The main character is ${childName}, a ${childAge}-year-old ${genderWord}. Show ${childName} in a warm, magical scene that feels full of possibility and wonder. Premium, inviting, irresistibly cute. Large bold title at top. "By GiftMyBook" at bottom.\n\nART STYLE: ${styleBlock}`);

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

  const model = 'gemini-3.1-flash-image-preview';
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
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }),
  }, 3 * 60 * 1000); // 3-min timeout

  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${await resp.text().then(t => t.slice(0, 100))}`);

  const data = await resp.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData?.mimeType?.startsWith('image/')) {
      return Buffer.from(part.inlineData.data, 'base64');
    }
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

module.exports = { generateCover, generateUpsellCovers, buildUpsellCoverPrompt, UPSELL_STYLES, UPSELL_STYLE_LABELS };
