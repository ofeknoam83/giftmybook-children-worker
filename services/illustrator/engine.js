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
const { PARENT_THEMES, MAX_SPREAD_RETRIES, MAX_REGEN_SPREADS, TOTAL_SPREADS } = require('./config');

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
        // Build prompt
        const prompt = buildSpreadPrompt({
          spreadIndex: i,
          totalSpreads: spreadEntries.length,
          scenePrompt: spreadPrompt,
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
        const qaOpts = { costTracker };

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

          // Build correction prompt
          const correctionPrompt = `The previous illustration for spread ${i + 1} had issues. Please regenerate with these corrections:
${issues.map(iss => `- FIX: ${iss}`).join('\n')}

Generate the corrected illustration for spread ${i + 1} with the same scene, but fix the issues listed above.

${prompt}`;

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
            break;
          }
        }

        // If anatomy still fails after correction retries, attempt one fresh generation
        if (!anatomyCheck.pass && qaRetries >= MAX_SPREAD_RETRIES) {
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
          throw new Error(`Spread ${i + 1} failed QA after ${qaRetries} retries + fresh attempt: ${remaining.join('; ')}`);
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
}

module.exports = { IllustratorEngine };
