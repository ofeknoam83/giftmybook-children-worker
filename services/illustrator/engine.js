/**
 * Illustrator V2 — Engine
 *
 * Single entry point: IllustratorEngine.generate(input)
 *
 * Pipeline:
 * 1. Session setup (pick API key, establish character references)
 * 2. Sequential spread generation (13 spreads) with per-spread QA
 * 3. Cross-spread consistency check
 * 4. Selective regeneration for failed spreads
 * 5. Post-processing (strip metadata, upscale)
 * 6. Upload to GCS and return entries with illustration URLs
 */

const { createSession, establishCharacterReferences, generateSpread, sendCorrection } = require('./session');
const { buildSpreadPrompt } = require('./prompts/spread');
const { verifySpreadText } = require('./quality/text');
const { checkAnatomy } = require('./quality/anatomy');
const { checkCrossSpreadConsistency } = require('./quality/consistency');
const { stripMetadata } = require('./postprocess/strip');
const { upscaleForPrint } = require('./postprocess/upscale');
const { uploadBuffer } = require('../gcsStorage');
const { withRetry } = require('../retry');
const { getVersion } = require('./version');
const { PARENT_THEMES, MAX_SPREAD_RETRIES, MAX_REGEN_SPREADS, TOTAL_SPREADS, TEXT_RULES } = require('./config');
const { getTextPlacement } = require('./prompts/text');

class IllustratorEngine {
  /**
   * Generate all illustrations for a children's book.
   *
   * @param {object} input - See Engine Input Interface in spec
   * @returns {Promise<Array<object>>} entries with spreadIllustrationUrl attached
   */
  async generate(input) {
    const {
      entries,
      storyPlan,
      childDetails,
      style,
      coverBase64,
      coverMime,
      childPhotoBase64,
      childPhotoMime,
      bookId,
      bookContext,
      theme,
      additionalCoverCharacters,
      costTracker,
    } = input;

    const version = getVersion();
    const log = bookContext?.log || ((level, msg) => console.log(`[illustrator/engine] [${level}] ${msg}`));

    log('info', `Illustrator V2 (${version.illustratorVersion}) starting for book ${bookId}`);
    const pipelineStart = Date.now();

    // Determine parent visibility
    const hasParentOnCover = !!(additionalCoverCharacters);
    const isParentTheme = theme && PARENT_THEMES.has(theme);
    const parentOutfit = storyPlan?.parentOutfit || null;

    // ── Step 1: Session Setup ──
    log('info', 'Step 1: Creating chat session and establishing character');

    let session;
    try {
      session = createSession({
        style,
        coverBase64,
        coverMime: coverMime || 'image/jpeg',
        childPhotoBase64,
        childPhotoMime: childPhotoMime || 'image/jpeg',
        hasParentOnCover,
        additionalCoverCharacters,
        theme,
        parentOutfit,
      });

      await establishCharacterReferences(session);
      log('info', 'Character references established successfully');
    } catch (err) {
      log('error', `Failed to establish session: ${err.message}`);
      throw new Error(`Illustrator V2 session failed: ${err.message}`);
    }

    // ── Step 2: Sequential Spread Generation ──
    log('info', 'Step 2: Generating spreads sequentially');

    // Identify illustratable spreads
    const spreadEntries = entries.map((entry, idx) => {
      if (entry.type !== 'spread') return null;
      const spreadText = [entry.left?.text, entry.right?.text].filter(Boolean).join(' ');
      const spreadPrompt = entry.spread_image_prompt
        || entry.left?.image_prompt
        || entry.right?.image_prompt
        || null;
      if (!spreadPrompt) return null;
      return { idx, entry, spreadPrompt, spreadText, leftText: entry.left?.text, rightText: entry.right?.text };
    }).filter(Boolean);

    log('info', `Found ${spreadEntries.length} spreads to generate`);

    // Results array — shallow copy of all entries
    const results = entries.map(e => ({ ...e }));

    // Track generated images for cross-spread QA
    const generatedImages = []; // [{index, imageBase64, pageText}]

    for (let i = 0; i < spreadEntries.length; i++) {
      const { idx, entry, spreadPrompt, spreadText, leftText, rightText } = spreadEntries[i];

      // Check abort
      if (bookContext?.abortController?.signal?.aborted) {
        log('info', `Aborting at spread ${i + 1} — generation cancelled`);
        break;
      }

      log('info', `Generating spread ${i + 1}/${spreadEntries.length} (entry ${idx})`);
      bookContext?.touchActivity?.();
      const spreadStart = Date.now();

      try {
        let safeScenePrompt = spreadPrompt;

        if (!hasParentOnCover && isParentTheme) {
          // Parent themes without parent on cover: inject face-hidden reminder
          const isMother = theme === 'mothers_day';
          const parentWord = isMother ? 'mother|mom|mama|mommy|mum' : 'father|dad|daddy|papa';
          const parentRegex = new RegExp(parentWord, 'i');
          if (parentRegex.test(spreadPrompt)) {
            const parentLabel = isMother ? 'Mom' : 'Dad';
            safeScenePrompt += `\n\n⚠️ FACE RULE: ${parentLabel} appears in this scene but ${parentLabel}'s face must be COMPLETELY HIDDEN — show only hands, arms, back view, or side view with face cropped out of frame. NEVER draw ${parentLabel}'s face, eyes, or facial features.`;
          }
        } else if (!hasParentOnCover && !isParentTheme) {
          // Non-parent themes without secondary cover characters: strip family references
          const familyRegex = /\b(grandpa|grandma|grandfather|grandmother|granny|nana|papa|nanny|uncle|aunt|auntie|daddy|dad|mommy|mom|mum|mama|father|mother|brother|sister|sibling|parent)\b/i;
          if (familyRegex.test(spreadPrompt)) {
            safeScenePrompt += `\n\n⚠️ FAMILY MEMBER RULE: The scene text mentions a family member, but we have NO reference image for them. Do NOT draw any family member. The child is the ONLY human character in this illustration. Show the family member's PRESENCE through traces only: their belongings, a hand reaching from off-screen, a shadow, or evidence they were there (a packed lunch, a note, a warm jacket). NEVER draw a family member's face or full body.`;
          }
        }

        // Build prompt
        const prompt = buildSpreadPrompt({
          spreadIndex: i,
          totalSpreads: spreadEntries.length,
          scenePrompt: safeScenePrompt,
          leftText,
          rightText,
          hasParentOnCover,
          additionalCoverCharacters,
          theme,
          style,
          parentOutfit,
        });

        // Generate within session (retry up to 2 times on failure)
        const MAX_GENERATION_RETRIES = 2;
        let result = null;
        let imageBase64 = null;
        let imageBuffer = null;
        for (let genRetry = 0; genRetry <= MAX_GENERATION_RETRIES; genRetry++) {
          try {
            result = await generateSpread(session, prompt, i);
            imageBase64 = result.imageBase64;
            imageBuffer = result.imageBuffer;
            break;
          } catch (genErr) {
            if (genRetry < MAX_GENERATION_RETRIES) {
              log('warn', `Spread ${i + 1} generation attempt ${genRetry + 1} failed: ${genErr.message} — retrying in 2s`);
              await new Promise(r => setTimeout(r, 2000));
            } else {
              throw genErr; // Final attempt failed — outer catch handles it
            }
          }
        }

        // ── Per-spread QA ──
        const qaOpts = { costTracker, spreadText };

        // Run text and anatomy checks in parallel
        const [textCheck, anatomyCheck] = await Promise.all([
          verifySpreadText(imageBase64, spreadText, qaOpts),
          checkAnatomy(imageBase64, qaOpts),
        ]);

        let qaRetries = 0;
        while (qaRetries < MAX_SPREAD_RETRIES && (!textCheck.pass || !anatomyCheck.pass)) {
          qaRetries++;
          const issues = [
            ...(textCheck.pass ? [] : textCheck.issues.map(i => `[text] ${i}`)),
            ...(anatomyCheck.pass ? [] : anatomyCheck.issues.map(i => `[anatomy] ${i}`)),
          ];
          log('warn', `Spread ${i + 1} QA failed (retry ${qaRetries}/${MAX_SPREAD_RETRIES}): ${issues.join('; ')}`);

          // Build correction prompt — use focused language for text issues
          const hasTextIssues = issues.some(iss => iss.startsWith('[text]'));
          const hasAnatomyIssues = issues.some(iss => iss.startsWith('[anatomy]'));
          const hasSplitPanel = issues.some(iss => iss.toLowerCase().includes('split panel'));
          const hasDuplication = issues.some(iss => iss.toLowerCase().includes('duplicat'));
          const hasCenterViolation = issues.some(iss => iss.toLowerCase().includes('center'));
          const hasEdgeViolation = issues.some(iss => iss.toLowerCase().includes('edge'));

          let correctionPrompt;

          if (hasSplitPanel) {
            correctionPrompt = `REGENERATE spread ${i + 1} COMPLETELY. The previous image was SPLIT INTO TWO SEPARATE PANELS — this is WRONG.

CRITICAL: This must be ONE SINGLE SEAMLESS PAINTING — like a wide movie still or panoramic photograph. ONE continuous background, ONE unified lighting, ONE seamless composition from left edge to right edge. NO divider, NO seam, NO panel split, NO two separate scenes side by side.

${prompt}`;
          } else if (hasTextIssues && !hasAnatomyIssues) {
            const placement = getTextPlacement(i);
            const safePct = 50 - TEXT_RULES.centerExclusionPercent;
            const textFixes = [];
            if (hasDuplication) textFixes.push('The text appeared MORE THAN ONCE. Render it EXACTLY ONE TIME in ONE location.');
            if (hasCenterViolation) textFixes.push(`Text was too close to the center. Move ALL text to the ${placement.side.toUpperCase()} side — within the ${placement.side} ${safePct}% of the image.`);
            if (hasEdgeViolation) textFixes.push(`Text was too close to the edge. Keep at least ${TEXT_RULES.edgePaddingPercent}% from sides/top and ${TEXT_RULES.bottomPaddingPercent}% from the bottom.`);
            if (textFixes.length === 0) textFixes.push(...issues.map(iss => iss.replace(/^\[text\]\s*/, '')));

            correctionPrompt = `REGENERATE spread ${i + 1} with the SAME scene. Fix ONLY the text:
${textFixes.map(f => `- ${f}`).join('\n')}

Place the story text in the ${placement.anchor} of the image. Same scene, same character, same style — just fix the text placement.`;
          } else {
            correctionPrompt = `The previous illustration for spread ${i + 1} had issues. Please regenerate with these corrections:
${issues.map(iss => `- FIX: ${iss}`).join('\n')}

Generate the corrected illustration for spread ${i + 1} with the same scene, but fix the issues listed above.

${prompt}`;
          }

          try {
            result = await sendCorrection(session, correctionPrompt, i);
            imageBase64 = result.imageBase64;
            imageBuffer = result.imageBuffer;

            // Re-check
            const [reTextCheck, reAnatomyCheck] = await Promise.all([
              verifySpreadText(imageBase64, spreadText, qaOpts),
              checkAnatomy(imageBase64, qaOpts),
            ]);

            // Update checks for loop evaluation
            Object.assign(textCheck, reTextCheck);
            Object.assign(anatomyCheck, reAnatomyCheck);
          } catch (retryErr) {
            log('warn', `Spread ${i + 1} correction retry ${qaRetries} failed: ${retryErr.message}`);
            // Transient errors (503, timeout, network) — wait and continue retrying
            // instead of breaking out of the loop
            const isTransient = retryErr.message && (
              retryErr.message.includes('503') ||
              retryErr.message.includes('429') ||
              retryErr.message.includes('timeout') ||
              retryErr.message.includes('UNAVAILABLE') ||
              retryErr.message.includes('Deadline') ||
              retryErr.message.includes('ECONNRESET') ||
              retryErr.message.includes('fetch failed')
            );
            if (isTransient && qaRetries < MAX_SPREAD_RETRIES) {
              const backoffMs = 3000 * qaRetries;
              log('info', `Spread ${i + 1} transient error — waiting ${backoffMs}ms before retry ${qaRetries + 1}`);
              await new Promise(r => setTimeout(r, backoffMs));
              continue;
            }
            break;
          }
        }

        // If anatomy still fails after correction retries, attempt one fresh generation
        if (!anatomyCheck.pass && qaRetries > 0) {
          log('warn', `Spread ${i + 1} anatomy still failing after ${qaRetries} corrections — attempting fresh generation`);
          try {
            const freshPrompt = `Please generate a completely fresh illustration for spread ${i + 1}. Disregard previous attempts — start fresh with the original scene. Pay special attention to anatomy: every person must have exactly 2 arms and 2 hands visible.\n\n${prompt}`;
            const freshResult = await sendCorrection(session, freshPrompt, i);
            const freshImageBase64 = freshResult.imageBase64;
            const freshImageBuffer = freshResult.imageBuffer;

            const [freshTextCheck, freshAnatomyCheck] = await Promise.all([
              verifySpreadText(freshImageBase64, spreadText, qaOpts),
              checkAnatomy(freshImageBase64, qaOpts),
            ]);

            const freshTextNotWorse = freshTextCheck.pass || !textCheck.pass;
            if (freshAnatomyCheck.pass && freshTextNotWorse) {
              log('info', `Spread ${i + 1} fresh generation improved QA without regressing text`);
              imageBase64 = freshImageBase64;
              imageBuffer = freshImageBuffer;
              Object.assign(textCheck, freshTextCheck);
              Object.assign(anatomyCheck, freshAnatomyCheck);
            } else if (freshAnatomyCheck.pass) {
              log('warn', `Spread ${i + 1} fresh generation passed anatomy but regressed text QA — keeping best attempt`);
            } else {
              log('warn', `Spread ${i + 1} fresh generation also failed anatomy — keeping best attempt`);
            }
          } catch (freshErr) {
            log('warn', `Spread ${i + 1} fresh generation failed: ${freshErr.message} — keeping best attempt`);
          }
        }

        if (!textCheck.pass || !anatomyCheck.pass) {
          const remaining = [
            ...(textCheck.pass ? [] : textCheck.issues.map(iss => `[text] ${iss}`)),
            ...(anatomyCheck.pass ? [] : anatomyCheck.issues.map(iss => `[anatomy] ${iss}`)),
          ];
          if (imageBase64 && imageBuffer) {
            log('warn', `Spread ${i + 1} accepting best attempt despite QA issues (${remaining.length} remaining): ${remaining.join('; ')}`);
          } else {
            throw new Error(`Spread ${i + 1} failed QA after ${qaRetries} retries with no usable image: ${remaining.join('; ')}`);
          }
        } else {
          log('info', `Spread ${i + 1} QA passed`);
        }

        // ── Post-processing ──
        imageBuffer = await stripMetadata(imageBuffer);
        imageBuffer = await upscaleForPrint(imageBuffer);

        // ── Upload to GCS ──
        const gcsPath = `children-jobs/${bookId}/spreads/spread-${entry.spread || i + 1}.jpg`;
        const gcsUrl = await withRetry(
          () => uploadBuffer(imageBuffer, gcsPath, 'image/png'),
          { maxRetries: 3, baseDelayMs: 1000, label: `upload-spread-${i + 1}` },
        );

        results[idx].spreadIllustrationUrl = gcsUrl;

        // Store for cross-spread QA
        generatedImages.push({
          index: i,
          entryIdx: idx,
          imageBase64,
          pageText: spreadText,
        });

        const spreadMs = Date.now() - spreadStart;
        log('info', `Spread ${i + 1} complete (${spreadMs}ms)`);
        bookContext?.touchActivity?.();

      } catch (spreadErr) {
        log('error', `Spread ${i + 1} generation failed: ${spreadErr.message}`);
        // Don't abort the whole pipeline — continue with other spreads
        if (spreadErr.isNsfw) {
          log('warn', `Spread ${i + 1} NSFW blocked — skipping`);
        }
      }
    }

    // ── Step 3: Cross-Spread Consistency QA ──
    log('info', 'Step 3: Running cross-spread consistency checks');

    let consistencyResult = { overallScore: 1.0, failedSpreads: [] };
    try {
      if (generatedImages.length >= 2) {
        consistencyResult = await checkCrossSpreadConsistency(generatedImages, { costTracker });
        log('info', `Cross-spread QA: score=${(consistencyResult.overallScore * 100).toFixed(0)}%, failed=${consistencyResult.failedSpreads.length}`);
      }
    } catch (qaErr) {
      log('warn', `Cross-spread QA error: ${qaErr.message} — proceeding`);
    }

    // ── Step 4: Selective Regeneration ──
    if (consistencyResult.failedSpreads.length > 0 && !session.abandoned) {
      const spreadsToRegen = consistencyResult.failedSpreads.slice(0, MAX_REGEN_SPREADS);
      log('info', `Step 4: Regenerating ${spreadsToRegen.length} spreads for consistency`);

      for (const failed of spreadsToRegen) {
        if (bookContext?.abortController?.signal?.aborted) break;

        const spreadEntry = spreadEntries[failed.index];
        if (!spreadEntry) continue;

        try {
          const correctionPrompt = `CONSISTENCY CORRECTION for spread ${failed.index + 1}:
The following issues were found when comparing this spread against other illustrations in the book:
${failed.issues.map(i => `- ${i}`).join('\n')}

Please regenerate this spread, fixing the issues above while maintaining the same scene content.
The character's appearance, outfit, art style, and font must be IDENTICAL to all other spreads.

${buildSpreadPrompt({
  spreadIndex: failed.index,
  totalSpreads: spreadEntries.length,
  scenePrompt: spreadEntry.spreadPrompt,
  leftText: spreadEntry.leftText,
  rightText: spreadEntry.rightText,
  hasParentOnCover,
  additionalCoverCharacters,
  theme,
  style,
  parentOutfit,
})}`;

          const result = await sendCorrection(session, correctionPrompt, failed.index);
          let imageBuffer = Buffer.from(result.imageBase64, 'base64');
          imageBuffer = await stripMetadata(imageBuffer);
          imageBuffer = await upscaleForPrint(imageBuffer);

          const gcsPath = `children-jobs/${bookId}/spreads/spread-${spreadEntry.entry.spread || failed.index + 1}.jpg`;
          const gcsUrl = await withRetry(
            () => uploadBuffer(imageBuffer, gcsPath, 'image/png'),
            { maxRetries: 3, baseDelayMs: 1000, label: `upload-regen-spread-${failed.index + 1}` },
          );

          results[spreadEntry.idx].spreadIllustrationUrl = gcsUrl;
          log('info', `Regenerated spread ${failed.index + 1} for consistency`);

        } catch (regenErr) {
          log('warn', `Regeneration failed for spread ${failed.index + 1}: ${regenErr.message} — keeping original`);
        }
      }
    }

    // ── Done ──
    const totalMs = Date.now() - pipelineStart;
    const generatedCount = generatedImages.length;
    log('info', `Illustrator V2 complete: ${generatedCount} spreads in ${totalMs}ms (avg ${generatedCount ? Math.round(totalMs / generatedCount) : 0}ms/spread)`);

    return results;
  }

  /**
   * Generate a single spread illustration using the V2 pipeline.
   * Used by admin single-spread regeneration. Creates a mini chat session,
   * establishes character from cover/photo, generates one spread with QA.
   *
   * @param {object} input
   * @param {string} input.scenePrompt - Illustration scene description
   * @param {string} input.spreadText - Full story text for this spread
   * @param {string} [input.leftText] - Left page text
   * @param {string} [input.rightText] - Right page text
   * @param {string} input.style - Art style key
   * @param {string} [input.coverBase64] - Approved cover as base64
   * @param {string} [input.childPhotoBase64] - Child photo as base64
   * @param {string} [input.theme]
   * @param {string} [input.additionalCoverCharacters]
   * @param {string} [input.parentOutfit]
   * @param {number} [input.spreadIndex] - 0-based spread index
   * @param {number} [input.totalSpreads] - Total spreads in the book
   * @param {object} [input.costTracker]
   * @returns {Promise<{ imageBuffer: Buffer, imageBase64: string }>}
   */
  async generateSingleSpread(input) {
    const {
      scenePrompt,
      spreadText,
      leftText,
      rightText,
      style = 'pixar_premium',
      coverBase64,
      childPhotoBase64,
      childPhotoMime = 'image/jpeg',
      theme,
      additionalCoverCharacters,
      parentOutfit,
      spreadIndex = 0,
      totalSpreads = 13,
      costTracker,
    } = input;

    const log = (level, msg) => console.log(`[illustrator/singleSpread] [${level}] ${msg}`);
    const hasParentOnCover = !!(additionalCoverCharacters);
    const isParentTheme = theme && PARENT_THEMES.has(theme);

    // 1. Create session
    const session = createSession({
      style,
      coverBase64: coverBase64 || null,
      coverMime: 'image/jpeg',
      childPhotoBase64: childPhotoBase64 || null,
      childPhotoMime,
      hasParentOnCover,
      additionalCoverCharacters,
      theme,
      parentOutfit,
    });

    // 2. Establish character references
    if (childPhotoBase64 || coverBase64) {
      await establishCharacterReferences(session);
      log('info', 'Character references established');
    }

    // 3. Apply safeScenePrompt filters (same as full pipeline)
    let safeScenePrompt = scenePrompt;
    if (!hasParentOnCover && isParentTheme) {
      const isMother = theme === 'mothers_day';
      const parentWord = isMother ? 'mother|mom|mama|mommy|mum' : 'father|dad|daddy|papa';
      if (new RegExp(parentWord, 'i').test(scenePrompt)) {
        const parentLabel = isMother ? 'Mom' : 'Dad';
        safeScenePrompt += `\n\n⚠️ FACE RULE: ${parentLabel} appears in this scene but ${parentLabel}'s face must be COMPLETELY HIDDEN — show only hands, arms, back view, or side view with face cropped out of frame. NEVER draw ${parentLabel}'s face, eyes, or facial features.`;
      }
    } else if (!hasParentOnCover && !isParentTheme) {
      const familyRegex = /\b(grandpa|grandma|grandfather|grandmother|granny|nana|papa|nanny|uncle|aunt|auntie|daddy|dad|mommy|mom|mum|mama|father|mother|brother|sister|sibling|parent)\b/i;
      if (familyRegex.test(scenePrompt)) {
        safeScenePrompt += `\n\n⚠️ FAMILY MEMBER RULE: The scene mentions a family member but we have NO reference image. Do NOT draw any family member. The child is the ONLY human character. Show family presence through traces only.`;
      }
    }

    // 4. Build prompt
    const prompt = buildSpreadPrompt({
      spreadIndex,
      totalSpreads,
      scenePrompt: safeScenePrompt,
      leftText: leftText || spreadText,
      rightText: rightText || null,
      hasParentOnCover,
      additionalCoverCharacters,
      theme,
      style,
      parentOutfit,
    });

    // 5. Generate with retries
    const MAX_GEN_RETRIES = 2;
    let result = null;
    for (let attempt = 0; attempt <= MAX_GEN_RETRIES; attempt++) {
      try {
        result = await generateSpread(session, prompt, spreadIndex);
        break;
      } catch (err) {
        if (attempt < MAX_GEN_RETRIES) {
          log('warn', `Generation attempt ${attempt + 1} failed: ${err.message} — retrying`);
          await new Promise(r => setTimeout(r, 2000));
        } else {
          throw err;
        }
      }
    }

    let { imageBase64, imageBuffer } = result;

    // 6. QA with retry loop
    const qaOpts = { costTracker, spreadText };
    let [textCheck, anatomyCheck] = await Promise.all([
      verifySpreadText(imageBase64, spreadText || '', qaOpts),
      checkAnatomy(imageBase64, qaOpts),
    ]);

    let qaRetries = 0;
    while (qaRetries < MAX_SPREAD_RETRIES && (!textCheck.pass || !anatomyCheck.pass)) {
      qaRetries++;
      const issues = [
        ...(textCheck.pass ? [] : textCheck.issues.map(i => `[text] ${i}`)),
        ...(anatomyCheck.pass ? [] : anatomyCheck.issues.map(i => `[anatomy] ${i}`)),
      ];
      log('warn', `QA failed (retry ${qaRetries}/${MAX_SPREAD_RETRIES}): ${issues.join('; ')}`);

      const correctionPrompt = `Fix these issues:\n${issues.join('\n')}\n\nRegenerate the spread with the same scene but fixing all listed problems.\n\n${prompt}`;

      try {
        const retryResult = await sendCorrection(session, correctionPrompt, spreadIndex);
        imageBase64 = retryResult.imageBase64;
        imageBuffer = retryResult.imageBuffer;

        const [reText, reAnatomy] = await Promise.all([
          verifySpreadText(imageBase64, spreadText || '', qaOpts),
          checkAnatomy(imageBase64, qaOpts),
        ]);
        Object.assign(textCheck, reText);
        Object.assign(anatomyCheck, reAnatomy);
      } catch (retryErr) {
        log('warn', `Correction retry ${qaRetries} failed: ${retryErr.message}`);
      }
    }

    if (!textCheck.pass || !anatomyCheck.pass) {
      const remaining = [
        ...(textCheck.pass ? [] : textCheck.issues.map(i => `[text] ${i}`)),
        ...(anatomyCheck.pass ? [] : anatomyCheck.issues.map(i => `[anatomy] ${i}`)),
      ];
      log('warn', `QA still failing after ${qaRetries} retries: ${remaining.join('; ')}`);
    }

    // 7. Post-process
    imageBuffer = Buffer.from(imageBase64, 'base64');
    imageBuffer = await stripMetadata(imageBuffer);
    imageBuffer = await upscaleForPrint(imageBuffer);

    return { imageBuffer, imageBase64: imageBuffer.toString('base64') };
  }
}

module.exports = { IllustratorEngine };
