/**
 * Cover Generator — Creates Lulu-compliant wrap-around cover PDF
 * (back cover + spine + front cover) with 0.125" bleed.
 *
 * Back cover: Gemini-generated illustration matching front cover style,
 * with synopsis, heartfelt note, branding, and fake barcode integrated.
 * Spine: Color-matched to front cover, no text for books under 80 pages.
 */

const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');
const { generateIllustration, getNextApiKey } = require('./illustrationGenerator');
const { downloadBuffer } = require('./gcsStorage');
const sharp = require('sharp');

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
 * Generate back cover illustration using Gemini, matching the front cover style.
 *
 * @param {Buffer} frontCoverBuffer - Front cover image
 * @param {object} opts - { title, childName, synopsis, heartfeltNote, bookFrom }
 * @returns {Promise<Buffer|null>} Back cover image buffer, or null on failure
 */
async function generateBackCoverImage(frontCoverBuffer, opts = {}) {
  const { title, childName, synopsis, heartfeltNote, bookFrom, costTracker } = opts;

  // Resize front cover to use as style reference
  const refBuffer = await sharp(frontCoverBuffer)
    .resize(512, 512, { fit: 'cover' })
    .jpeg({ quality: 80 })
    .toBuffer();
  const refBase64 = refBuffer.toString('base64');

  // Build the text elements for the back cover
  const textElements = [];
  if (synopsis) {
    textElements.push(`At the top center, in a rounded bubbly sans-serif font (like Fredoka One / Baloo / Nunito — matching the interior pages):\n"${synopsis}"`);
  }
  if (heartfeltNote) {
    const noteText = bookFrom
      ? `${heartfeltNote}\n— ${bookFrom}`
      : heartfeltNote;
    textElements.push(`Below a small decorative separator:\n${noteText}`);
  }
  textElements.push(`Near the bottom center:\n"Made with love for ${childName || 'you'}"\n"GiftMyBook.com"`);

  const prompt = `Create a back cover illustration for a children's picture book.

STYLE REFERENCE: Match the EXACT same art style, color palette, and visual mood as the reference image (the front cover). Use the same lighting, texture, and illustration technique.

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
- FONT: Use a rounded, bubbly sans-serif font (like Fredoka One / Baloo / Nunito) — the same font style used on the interior pages
- Use warm, soft colors that match the front cover palette
- Text should feel integrated into the illustration, not overlaid
- The overall feel should be warm, cozy, and premium

FORMAT: Square image, 1:1 aspect ratio.`;

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
 * @returns {Promise<{coverPdfBuffer: Buffer, frontCoverImageUrl: string}>}
 */
async function generateCover(title, childDetails, characterRefUrl, bookFormat, opts = {}) {
  const isPictureBook = (bookFormat || '').toLowerCase() === 'picture_book';
  const trimWidth = isPictureBook ? 612 : 432;
  const trimHeight = isPictureBook ? 612 : 648;
  const bleed = 9; // 0.125" Lulu standard

  // Spine width: (pages / 444) + 0.06 inches (Lulu paperback formula)
  const pageCount = opts.pageCount || 32;
  const spineInches = (pageCount / 444) + 0.06;
  const spineWidth = Math.max(spineInches * 72, 6);

  const totalWidth = bleed + trimWidth + spineWidth + trimWidth + bleed;
  const totalHeight = trimHeight + bleed * 2;

  console.log(`[CoverGenerator] Wrap-around cover: ${totalWidth.toFixed(1)}x${totalHeight.toFixed(1)}pts, spine=${spineWidth.toFixed(1)}pts (${pageCount} pages)`);

  // ── Obtain front cover image ──
  let frontCoverImageUrl = null;
  let frontCoverBuffer = null;

  if (opts.preGeneratedCoverBuffer) {
    console.log('[CoverGenerator] Using pre-generated cover buffer');
    frontCoverBuffer = opts.preGeneratedCoverBuffer;
  } else {
    const artStyle = opts.artStyle || 'pixar_premium';
    const coverScene = `A beautiful ${artStyle} children's book cover illustration. `
      + `The main character is a ${childDetails.childAge || childDetails.age || 5}-year-old child named ${childDetails.childName || childDetails.name}. `
      + `The scene should be inviting, colorful, and magical — suggesting the start of an adventure. `
      + `The child should be centered, looking happy and confident. `
      + `Background should be thematic and whimsical.`;

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
    });
  }

  // ── Build wrap-around PDF ──
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`${title || 'My Story'} - Cover`);
  pdfDoc.setAuthor('GiftMyBook.com');
  const page = pdfDoc.addPage([totalWidth, totalHeight]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // ═══════════════════════════════════════
  // BACK COVER (left side)
  // ═══════════════════════════════════════
  const backWidth = bleed + trimWidth;

  if (backCoverBuffer) {
    // Use Gemini-generated back cover illustration
    try {
      const targetPx = Math.round(backWidth / 72 * 300);
      const targetHPx = Math.round(totalHeight / 72 * 300);
      const resized = await sharp(backCoverBuffer)
        .resize(targetPx, targetHPx, { fit: 'cover' })
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
  // SPINE
  // ═══════════════════════════════════════
  const spineX = backWidth;

  page.drawRectangle({
    x: spineX, y: 0,
    width: spineWidth, height: totalHeight,
    color: rgb(spineBgColor.r, spineBgColor.g, spineBgColor.b),
  });

  // Lulu recommends: no spine text for books under 80 pages
  if (pageCount >= 80 && spineWidth >= 18 && title) {
    const spineFontSize = Math.min(8, spineWidth * 0.55);
    const spineTextWidth = boldFont.widthOfTextAtSize(title, spineFontSize);
    const textX = spineX + spineWidth / 2 + spineFontSize * 0.35;
    const textY = totalHeight / 2 + spineTextWidth / 2;
    page.drawText(title, {
      x: textX,
      y: textY,
      size: spineFontSize,
      font: boldFont,
      color: rgb(0.2, 0.18, 0.15),
      rotate: degrees(-90),
    });
  }

  // ═══════════════════════════════════════
  // FRONT COVER (right side)
  // ═══════════════════════════════════════
  const frontX = backWidth + spineWidth;
  const frontWidth = trimWidth + bleed;

  // Background fallback
  const backBgColor = softenColor(coverColor, 0.6);
  page.drawRectangle({
    x: frontX, y: 0,
    width: frontWidth, height: totalHeight,
    color: rgb(backBgColor.r, backBgColor.g, backBgColor.b),
  });

  // Embed front cover illustration at 300 DPI
  if (frontCoverBuffer) {
    try {
      const targetWidthPx = Math.round(frontWidth / 72 * 300);
      const targetHeightPx = Math.round(totalHeight / 72 * 300);
      const resized = await sharp(frontCoverBuffer)
        .resize(targetWidthPx, targetHeightPx, { fit: 'cover' })
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
  return {
    coverPdfBuffer: Buffer.from(pdfBytes),
    frontCoverImageUrl,
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
async function generateUpsellTitles(childName, childAge, approvedTitle, openaiApiKey, costTracker) {
  const key = openaiApiKey || process.env.OPENAI_API_KEY;
  if (!key) return null;

  const system = `You are a children's book title writer. Generate 4 short, irresistible book titles for a personalized children's book.
Each title must feel like a brand-new adventure for the same child.
Titles should be warm, specific, and emotionally evocative.
Do NOT use the word "adventure". Do NOT copy the original title.
Return JSON: { "titles": ["Title 1", "Title 2", "Title 3", "Title 4"] }`;

  const user = `Child: ${childName}, age ${childAge}. Original book title: "${approvedTitle}". Generate 4 completely different titles for their next book.`;

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
 * Generate a single upsell cover image for a given style and title.
 */
async function generateUpsellCoverImage(title, childName, childAge, childGender, artStyle, frontCoverBuffer) {
  const ART_STYLE_CONFIG = require('./illustrationGenerator').ART_STYLE_CONFIG;
  const styleConfig = ART_STYLE_CONFIG?.[artStyle] || {};
  const prefix = styleConfig.prefix || '';
  const suffix = styleConfig.suffix || '';

  const genderWord = childGender === 'male' ? 'boy' : childGender === 'female' ? 'girl' : 'child';
  const prompt = `${prefix} Children's picture book front cover for a book titled "${title}". The main character is ${childName}, a ${childAge}-year-old ${genderWord}. Show ${childName} in a warm, magical scene that feels full of possibility and wonder. The cover should feel premium, inviting, and irresistibly cute. Large bold title "${title}" at the top in a beautiful font. "By GiftMyBook" in small text at the bottom. ${suffix}`;

  // Use the Gemini proxy — same endpoint that illustrationGenerator uses successfully
  const PROXY_URL = process.env.GEMINI_PROXY_URL || '';
  const PROXY_API_KEY = process.env.GEMINI_PROXY_API_KEY || '';

  if (!PROXY_URL) throw new Error('GEMINI_PROXY_URL not set — cannot generate upsell cover');

  // Resize cover reference to 256px for the prompt context
  const ref = await sharp(frontCoverBuffer)
    .resize(256, 256, { fit: 'cover' })
    .jpeg({ quality: 80 })
    .toBuffer();
  const refBase64 = ref.toString('base64');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3 * 60 * 1000); // 3-min timeout per cover

  try {
    const resp = await fetch(`${PROXY_URL}/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': PROXY_API_KEY },
      body: JSON.stringify({
        prompt,
        model: 'gemini-3.1-flash-image-preview',
        referenceImageBase64: refBase64,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!resp.ok) throw new Error(`Proxy ${resp.status}: ${await resp.text().then(t => t.slice(0, 100))}`);

    const data = await resp.json();
    if (!data.imageBase64) throw new Error('No imageBase64 in proxy response');
    return Buffer.from(data.imageBase64, 'base64');
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/**
 * Generate 4 upsell covers in parallel and upload to GCS.
 * Returns array of { title, artStyle, styleLabel, gcsPath, coverUrl }
 *
 * @param {string} bookId
 * @param {object} childDetails - { name/childName, age/childAge, gender/childGender }
 * @param {Buffer} frontCoverBuffer - approved front cover
 * @param {string} approvedTitle
 * @param {object} opts - { openaiApiKey, apiKeys, costTracker, uploadBuffer, getSignedUrl }
 */
async function generateUpsellCovers(bookId, childDetails, frontCoverBuffer, approvedTitle, opts = {}) {
  const pLimit = require('p-limit');
  const { uploadBuffer, getSignedUrl } = require('./gcsStorage');

  const childName = childDetails.childName || childDetails.name || 'the child';
  const childAge = childDetails.childAge || childDetails.age || 5;
  const childGender = childDetails.childGender || childDetails.gender || 'neutral';
  const openaiApiKey = opts.openaiApiKey || opts.apiKeys?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  console.log(`[coverGenerator] Generating upsell covers for ${childName}...`);

  // Step 1: Generate 4 unique titles
  let titles = await generateUpsellTitles(childName, childAge, approvedTitle, openaiApiKey, opts.costTracker);
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
            title, childName, childAge, childGender, style, frontCoverBuffer
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

module.exports = { generateCover, generateUpsellCovers, UPSELL_STYLES, UPSELL_STYLE_LABELS };
