/**
 * Illustrator V2 — Engine
 *
 * Single entry point: IllustratorEngine.generate(input)
 *
 * Pipeline:
 * 1. Session setup (pick API key, establish character references)
 * 2. Sequential spread generation with per-spread QA, post-process, and GCS upload
 * 3. Book-wide easy consistency gate (one QA pass over all spreads; session rules + thumbnails)
 */

const { createSession, establishCharacterReferences, generateSpread, sendCorrection } = require('./session');
const { buildSpreadPrompt } = require('./prompts/spread');
const { verifySpreadText } = require('./quality/text');
const { checkAnatomy } = require('./quality/anatomy');
const { checkExtraSpreadQa } = require('./quality/extraSpreadQa');
const { checkArtStyleLock, buildStyleCorrectionPrompt, buildFreshGenerationStyleHint } = require('./quality/styleLock');
const { runBookWideConsistencyReview } = require('./quality/bookWideGate');
const { buildStoryBible } = require('./storyBible');
const { stripMetadata } = require('./postprocess/strip');
const { upscaleForPrint } = require('./postprocess/upscale');
const { uploadBuffer } = require('../gcsStorage');
const { withRetry } = require('../retry');
const { getVersion } = require('./version');
const { PARENT_THEMES, MAX_SPREAD_RETRIES, MAX_FRESH_SESSION_RETRIES, TEXT_RULES, MAX_GENERATION_RETRIES, GENERATION_RETRY_BASE_DELAY_MS } = require('./config');
const { getTextPlacement } = require('./prompts/text');

/** Throws if the standalone client requested cancellation. */
function abortGuard(bookContext) {
  if (bookContext?.abortController?.signal?.aborted) {
    const err = new Error('Illustration generation aborted');
    err.name = 'AbortError';
    throw err;
  }
}

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
      coverParentPresent,
      costTracker,
    } = input;

    const version = getVersion();
    const log = bookContext?.log || ((level, msg) => console.log(`[illustrator/engine] [${level}] ${msg}`));
    const abortSignal = bookContext?.abortController?.signal;
    const artStyleQaOpts = () => ({ style, costTracker, abortSignal });

    log('info', `Illustrator V2 (${version.illustratorVersion}) starting for book ${bookId}`);
    const pipelineStart = Date.now();
    if (bookContext != null && typeof bookContext.qaInfraErrors !== 'number') {
      bookContext.qaInfraErrors = 0;
    }

    const isParentTheme = theme && PARENT_THEMES.has(theme);
    // Whether the themed parent is actually depicted on the chosen cover.
    // For parent themes (mother's/father's day), we require the cover vision
    // step to have detected a person of the parent's gender — a sibling or
    // grandparent on a mother's-day cover does NOT count as "mom on cover".
    // For non-parent themes, any secondary on the cover counts (legacy behavior).
    const hasParentOnCover = isParentTheme
      ? coverParentPresent === true
      : !!additionalCoverCharacters;
    const hasSecondaryOnCover = !!additionalCoverCharacters;
    const parentOutfit = storyPlan?.parentOutfit || null;
    const celebrationAge = childDetails?.celebrationAge ?? childDetails?.age ?? childDetails?.childAge;

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
        hasSecondaryOnCover,
        additionalCoverCharacters,
        theme,
        parentOutfit,
        abortSignal,
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

    // Build story bible once (named secondary characters + locations + objects)
    // so continuity descriptions can be injected into every spread prompt.
    // Graceful fallback: if the bible call fails, we continue with an empty bible.
    let storyBible = { characters: [], locations: [], objects: [] };
    try {
      const bibleStart = Date.now();
      storyBible = await buildStoryBible({
        spreadEntries,
        childName: childDetails?.name || childDetails?.childName,
        theme,
        costTracker,
      });
      const bibleMs = Date.now() - bibleStart;
      const charCount = storyBible.characters.length;
      const locCount = storyBible.locations.length;
      const objCount = storyBible.objects.length;
      log('info', `Story bible built in ${bibleMs}ms: ${charCount} characters, ${locCount} locations, ${objCount} objects`);
    } catch (bibleErr) {
      log('warn', `Story bible build failed: ${bibleErr.message} — continuing without bible`);
    }

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
          hasSecondaryOnCover,
          additionalCoverCharacters,
          theme,
          style,
          parentOutfit,
          storyBible,
        });

        // Generate within session — retry with exponential backoff up to MAX_GENERATION_RETRIES
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
              const delayMs = Math.min(GENERATION_RETRY_BASE_DELAY_MS * Math.pow(2, genRetry), 30000);
              log('warn', `Spread ${i + 1} generation attempt ${genRetry + 1} failed: ${genErr.message} — retrying in ${delayMs}ms`);
              await new Promise(r => setTimeout(r, delayMs));
            } else {
              throw genErr; // Final attempt failed — outer catch handles it
            }
          }
        }

        // ── Per-spread QA ──
        const qaOpts = { costTracker, spreadText, abortSignal };
        const extraOpts = {
          spreadPrompt: safeScenePrompt,
          spreadText,
          theme: theme || '',
          celebrationAge,
          coverBase64: coverBase64 || null,
          additionalCoverCharacters,
          hasSecondaryOnCover,
          hasParentOnCover,
          spreadIndex: i,
          totalSpreads: spreadEntries.length,
          costTracker,
          abortSignal,
        };

        let textCheck = { pass: true, issues: [], tags: [] };
        let anatomyCheck = { pass: true, issues: [], tags: [] };
        let extraCheck = { pass: true, issues: [], tags: [] };
        let artStyleCheck = { pass: true, issues: [], tags: [] };
        let qaRetries = 0;

        // Per-spread QA: Agent 1 (text + anatomy), then Agent 2 (extra + style). Both must pass; any correction re-runs from Agent 1.
        while (true) {
          abortGuard(bookContext);
          [textCheck, anatomyCheck] = await Promise.all([
            verifySpreadText(imageBase64, spreadText, qaOpts),
            checkAnatomy(imageBase64, qaOpts),
          ]);

          if (textCheck.infra || anatomyCheck.infra) {
            if (textCheck.infra) {
              if (bookContext) bookContext.qaInfraErrors = (bookContext.qaInfraErrors || 0) + 1;
              log('warn', `Spread ${i + 1} Text QA infra fallback (model unparseable or API error) — accepting image`);
            }
            if (anatomyCheck.infra) {
              if (bookContext) bookContext.qaInfraErrors = (bookContext.qaInfraErrors || 0) + 1;
              log('warn', `Spread ${i + 1} Anatomy QA infra fallback (model unparseable or API error) — accepting image`);
            }
          }

          if (!textCheck.pass || !anatomyCheck.pass) {
            qaRetries++;
            if (qaRetries > MAX_SPREAD_RETRIES) break;

            const issues = [
              ...(textCheck.pass ? [] : textCheck.issues.map(iss => `[text] ${iss}`)),
              ...(anatomyCheck.pass ? [] : anatomyCheck.issues.map(iss => `[anatomy] ${iss}`)),
            ];
            log('warn', `Spread ${i + 1} QA Agent1 text/anatomy failed (retry ${qaRetries}/${MAX_SPREAD_RETRIES}): ${issues.join('; ')}`);

            const qaTags = new Set([
              ...(Array.isArray(textCheck.tags) ? textCheck.tags : []),
              ...(Array.isArray(anatomyCheck.tags) ? anatomyCheck.tags : []),
            ]);
            const hasTextIssues = issues.some(iss => iss.startsWith('[text]'));
            const hasAnatomyIssues = issues.some(iss => iss.startsWith('[anatomy]'));
            const hasSplitPanel = qaTags.has('split_panel')
              || issues.some(iss => iss.toLowerCase().includes('split panel'));

            if (hasSplitPanel) {
              log('warn', `Spread ${i + 1} split_panel detected — aborting in-session retries, escalating to fresh session`);
              extraCheck = { pass: true, issues: [], tags: [] };
              artStyleCheck = { pass: true, issues: [], tags: [] };
              break;
            }

            const hasDuplicatedHero = qaTags.has('duplicated_hero')
              || issues.some(iss => /duplicated?\s+hero|hero\s+duplicat|same\s+child\s+appear/i.test(iss));
            const hasHeadCropped = qaTags.has('head_cropped')
              || issues.some(iss => /head\s+(is\s+)?crop|face\s+(is\s+)?crop|head\s+cut\s+off/i.test(iss));
            const hasMissingLimb = qaTags.has('missing_limb')
              || issues.some(iss => /missing\s+(limb|arm|hand|leg|finger)|amputat|stump|ends?\s+at\s+(the\s+)?(wrist|shoulder|elbow)/i.test(iss));
            const hasTextOverFace = qaTags.has('text_over_face')
              || issues.some(iss => /text\s+over\s+(the\s+)?(face|head|hero)|text\s+on\s+(the\s+)?(face|head)/i.test(iss));
            const hasTextTopEdge = qaTags.has('text_top_edge')
              || issues.some(iss => iss.toLowerCase().includes('top edge') || iss.toLowerCase().includes('top of'));
            const hasTextDuplication = issues.some(iss => iss.toLowerCase().includes('duplicat') && iss.startsWith('[text]'));
            const hasCenterViolation = qaTags.has('text_center') || qaTags.has('text_bridges_sides')
              || issues.some(iss => /\bcenter\b|bridges|left.*right|right.*left/i.test(iss));
            const hasEdgeViolation = issues.some(iss => iss.toLowerCase().includes('edge'));

            let correctionPrompt;

            if (hasDuplicatedHero) {
              correctionPrompt = `REGENERATE spread ${i + 1} COMPLETELY. The previous image drew the main child MORE THAN ONCE — this is WRONG.

CRITICAL: The hero (the main child this book is about) must appear EXACTLY ONCE in the image.
- No twin sibling, no second identical child standing next to the hero.
- No before/after pose of the same child.
- No mirror reflection or framed-photo copy of the child (unless a physical mirror or picture frame is clearly drawn).
- If a parent, friend, or other character is in the scene, they must look clearly different from the hero — never a second copy of the hero.

Keep the same scene content and style, but draw the hero exactly once.

${prompt}`;
            } else if (hasHeadCropped) {
              correctionPrompt = `REGENERATE spread ${i + 1} with the SAME scene. The previous image CROPPED THE HERO'S HEAD at the edge of the frame — this is WRONG.

CRITICAL: The main child's head and full face MUST be fully inside the frame. Leave at least 8% of image height ABOVE the top of the child's head. Never crop the hero's head at the top, bottom, left, or right edge. Frame the hero so the entire head is comfortably inside the middle 80% of the image.

${prompt}`;
            } else if (hasMissingLimb) {
              correctionPrompt = `REGENERATE spread ${i + 1} with the SAME scene. The previous image had a MISSING LIMB — a character's arm, hand, or leg was cut off at the shoulder/wrist/thigh with no frame crop and no covering to hide it. This is WRONG.

CRITICAL anatomy rules:
- Every visible person must have 2 complete arms ending in 2 complete hands, and 2 complete legs.
- If an arm is visible at all, it MUST end in a hand with 5 fingers — no stumps, no wrists ending in thin air.
- If a limb is not shown, it must be because it is CLEARLY hidden (behind the body, behind an object, outside the frame edge). Never show a limb that just ENDS.
- No "half arms". No amputated look. No missing hands.

Keep the same scene content, composition, and style — just draw every character with complete, anatomically whole limbs.

${prompt}`;
            } else if (hasTextIssues && !hasAnatomyIssues) {
              const placement = getTextPlacement(i);
              const safePct = 50 - TEXT_RULES.centerExclusionPercent;
              const textFixes = [];
              if (hasTextDuplication) textFixes.push('The text appeared MORE THAN ONCE. Render it EXACTLY ONE TIME in ONE location.');
              if (hasCenterViolation) textFixes.push(`Text was too close to the center. Move ALL text to the ${placement.side.toUpperCase()} side — within the ${placement.side} ${safePct}% of the image.`);
              if (hasTextOverFace) textFixes.push('Text was placed OVER the hero\'s face/head. Move the text so it does NOT overlap the hero\'s head, face, hair, or eyes. Place it in an empty area of the scene.');
              if (hasTextTopEdge) textFixes.push(`Text was TOO CLOSE to the top edge and will be cut off by print cropping. Move the text down so it sits at least ${TEXT_RULES.topPaddingPercent}% below the top edge.`);
              if (hasEdgeViolation) textFixes.push(`Text was too close to the edge. Keep at least ${TEXT_RULES.edgePaddingPercent}% from the left/right sides, at least ${TEXT_RULES.topPaddingPercent}% from the top, and at least ${TEXT_RULES.bottomPaddingPercent}% from the bottom.`);
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
            } catch (retryErr) {
              log('warn', `Spread ${i + 1} Agent1 correction retry ${qaRetries} failed: ${retryErr.message}`);
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
              }
            }
            continue;
          }

          abortGuard(bookContext);
          [extraCheck, artStyleCheck] = await Promise.all([
            checkExtraSpreadQa(imageBase64, extraOpts),
            checkArtStyleLock(imageBase64, artStyleQaOpts()),
          ]);

          if (extraCheck.infra || artStyleCheck.infra) {
            if (extraCheck.infra) {
              if (bookContext) bookContext.qaInfraErrors = (bookContext.qaInfraErrors || 0) + 1;
              log('warn', `Spread ${i + 1} Extra spread QA infra fallback — accepting image`);
            }
            if (artStyleCheck.infra) {
              if (bookContext) bookContext.qaInfraErrors = (bookContext.qaInfraErrors || 0) + 1;
              log('warn', `Spread ${i + 1} Art style QA infra fallback — accepting image`);
            }
          }

          if (!extraCheck.pass || !artStyleCheck.pass) {
            qaRetries++;
            if (qaRetries > MAX_SPREAD_RETRIES) break;

            const issues = [
              ...(extraCheck.pass ? [] : extraCheck.issues.map(iss => `[extra] ${iss}`)),
              ...(artStyleCheck.pass ? [] : artStyleCheck.issues.map(iss => `[style] ${iss}`)),
            ];
            log('warn', `Spread ${i + 1} QA Agent2 extra/style failed (retry ${qaRetries}/${MAX_SPREAD_RETRIES}): ${issues.join('; ')}`);

            const qaTags = new Set([
              ...(Array.isArray(extraCheck.tags) ? extraCheck.tags : []),
              ...(Array.isArray(artStyleCheck.tags) ? artStyleCheck.tags : []),
            ]);
            const hasSplitPanel = qaTags.has('split_panel')
              || issues.some(iss => iss.toLowerCase().includes('split panel'));
            if (hasSplitPanel) {
              log('warn', `Spread ${i + 1} split_panel (Agent2) — aborting in-session retries, escalating to fresh session`);
              break;
            }

            let correctionPrompt;
            if (qaTags.has('art_style_mismatch') && extraCheck.pass) {
              correctionPrompt = buildStyleCorrectionPrompt(style, prompt, { spreadNumber: i + 1 });
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
            } catch (retryErr) {
              log('warn', `Spread ${i + 1} Agent2 correction retry ${qaRetries} failed: ${retryErr.message}`);
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
              }
            }
            continue;
          }

          break;
        }

        // If QA still fails after correction retries, attempt one fresh in-session generation
        if ((!textCheck.pass || !anatomyCheck.pass || !extraCheck.pass || !artStyleCheck.pass) && qaRetries > 0) {
          abortGuard(bookContext);
          log('warn', `Spread ${i + 1} QA still failing after ${qaRetries} corrections — attempting fresh generation`);
          try {
            const freshPrompt = `Please generate a completely fresh illustration for spread ${i + 1}. Disregard previous attempts — start fresh with the original scene. Pay special attention to: (1) anatomy — every person must have exactly 2 arms and 2 hands visible; (2) ${buildFreshGenerationStyleHint(style)}\n\n${prompt}`;
            const freshResult = await sendCorrection(session, freshPrompt, i);
            const freshImageBase64 = freshResult.imageBase64;
            const freshImageBuffer = freshResult.imageBuffer;

            const [freshTextCheck, freshAnatomyCheck] = await Promise.all([
              verifySpreadText(freshImageBase64, spreadText, qaOpts),
              checkAnatomy(freshImageBase64, qaOpts),
            ]);
            let freshExtraCheck = { pass: true, issues: [], tags: [] };
            let freshArtStyleCheck = { pass: true, issues: [], tags: [] };
            if (freshTextCheck.pass && freshAnatomyCheck.pass) {
              [freshExtraCheck, freshArtStyleCheck] = await Promise.all([
                checkExtraSpreadQa(freshImageBase64, extraOpts),
                checkArtStyleLock(freshImageBase64, artStyleQaOpts()),
              ]);
            }

            const freshTextNotWorse = freshTextCheck.pass || !textCheck.pass;
            const freshAllPass = freshTextCheck.pass && freshAnatomyCheck.pass && freshExtraCheck.pass && freshArtStyleCheck.pass;
            if (freshAllPass && freshTextNotWorse) {
              log('info', `Spread ${i + 1} fresh generation improved QA without regressing text`);
              imageBase64 = freshImageBase64;
              imageBuffer = freshImageBuffer;
              Object.assign(textCheck, freshTextCheck);
              Object.assign(anatomyCheck, freshAnatomyCheck);
              Object.assign(extraCheck, freshExtraCheck);
              Object.assign(artStyleCheck, freshArtStyleCheck);
            } else if (freshAllPass) {
              log('warn', `Spread ${i + 1} fresh generation passed all QA but regressed text vs prior — keeping best attempt`);
            } else {
              log('warn', `Spread ${i + 1} fresh generation did not clear all QA — keeping best attempt`);
            }
          } catch (freshErr) {
            log('warn', `Spread ${i + 1} fresh generation failed: ${freshErr.message} — keeping best attempt`);
          }
        }

        if (!textCheck.pass || !anatomyCheck.pass || !extraCheck.pass || !artStyleCheck.pass) {
          const remaining = [
            ...(textCheck.pass ? [] : textCheck.issues.map(iss => `[text] ${iss}`)),
            ...(anatomyCheck.pass ? [] : anatomyCheck.issues.map(iss => `[anatomy] ${iss}`)),
            ...(extraCheck.pass ? [] : extraCheck.issues.map(iss => `[extra] ${iss}`)),
            ...(artStyleCheck.pass ? [] : artStyleCheck.issues.map(iss => `[style] ${iss}`)),
          ];
          log('warn', `Spread ${i + 1} still failing after in-session retries (${remaining.join('; ')}) — trying fresh sessions`);

          let freshSessionPassed = false;
          for (let freshAttempt = 1; freshAttempt <= MAX_FRESH_SESSION_RETRIES; freshAttempt++) {
            abortGuard(bookContext);
            log('info', `Spread ${i + 1} fresh-session attempt ${freshAttempt}/${MAX_FRESH_SESSION_RETRIES}`);
            try {
              const freshResult = await this.generateSingleSpread({
                scenePrompt: spreadPrompt,
                spreadText,
                leftText,
                rightText,
                style,
                coverBase64,
                childPhotoBase64,
                childPhotoMime: childPhotoMime || 'image/jpeg',
                theme,
                additionalCoverCharacters,
                coverParentPresent,
                parentOutfit,
                spreadIndex: i,
                totalSpreads: spreadEntries.length,
                costTracker,
                celebrationAge,
                abortSignal,
              });
              imageBase64 = freshResult.imageBase64;
              imageBuffer = freshResult.imageBuffer;

              const [freshTextCheck, freshAnatomyCheck] = await Promise.all([
                verifySpreadText(imageBase64, spreadText, { costTracker, spreadText }),
                checkAnatomy(imageBase64, { costTracker, spreadText }),
              ]);
              let freshExtraCheck = { pass: true, issues: [], tags: [] };
              let freshArtStyleCheck = { pass: true, issues: [], tags: [] };
              if (freshTextCheck.pass && freshAnatomyCheck.pass) {
                [freshExtraCheck, freshArtStyleCheck] = await Promise.all([
                  checkExtraSpreadQa(imageBase64, extraOpts),
                  checkArtStyleLock(imageBase64, artStyleQaOpts()),
                ]);
              }

              if (freshTextCheck.pass && freshAnatomyCheck.pass && freshExtraCheck.pass && freshArtStyleCheck.pass) {
                log('info', `Spread ${i + 1} fresh-session attempt ${freshAttempt} passed QA`);
                Object.assign(textCheck, freshTextCheck);
                Object.assign(anatomyCheck, freshAnatomyCheck);
                Object.assign(extraCheck, freshExtraCheck);
                Object.assign(artStyleCheck, freshArtStyleCheck);
                freshSessionPassed = true;
                break;
              }

              const freshIssues = [
                ...(freshTextCheck.pass ? [] : freshTextCheck.issues.map(iss => `[text] ${iss}`)),
                ...(freshAnatomyCheck.pass ? [] : freshAnatomyCheck.issues.map(iss => `[anatomy] ${iss}`)),
                ...(freshExtraCheck.pass ? [] : freshExtraCheck.issues.map(iss => `[extra] ${iss}`)),
                ...(freshArtStyleCheck.pass ? [] : freshArtStyleCheck.issues.map(iss => `[style] ${iss}`)),
              ];
              log('warn', `Spread ${i + 1} fresh-session attempt ${freshAttempt} still failing: ${freshIssues.join('; ')}`);
            } catch (freshErr) {
              log('warn', `Spread ${i + 1} fresh-session attempt ${freshAttempt} errored: ${freshErr.message}`);
            }
          }

          if (!freshSessionPassed) {
            throw new Error(`Spread ${i + 1} failed QA after all retries and ${MAX_FRESH_SESSION_RETRIES} fresh sessions — refusing to accept defective image`);
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
        if (spreadErr.name === 'AbortError') throw spreadErr;
        log('error', `Spread ${i + 1} generation failed: ${spreadErr.message}`);
        throw spreadErr;
      }
    }

    const missingAfterGen = spreadEntries.filter(se => !results[se.idx]?.spreadIllustrationUrl);
    if (missingAfterGen.length > 0) {
      throw new Error(`Illustration pipeline incomplete: ${missingAfterGen.length} spread(s) missing URLs (expected ${spreadEntries.length})`);
    }

    const consistencyOpts = {
      costTracker,
      storyBible,
      theme,
      additionalCoverCharacters,
      hasSecondaryOnCover,
      hasParentOnCover,
      abortSignal,
      session,
    };

    // ── Step 3: Book-wide easy consistency (single multimodal QA, session rules + all spreads) ──
    if (generatedImages.length >= 2) {
      abortGuard(bookContext);
      log('info', 'Step 3: Book-wide consistency (easy gate)');
      const bookWide = await runBookWideConsistencyReview(session, generatedImages, consistencyOpts);
      if (bookWide.infra) {
        log('warn', 'Book-wide consistency gate used infra fallback (unparseable/HTTP) — treating as pass');
      }
      if (!bookWide.pass) {
        const detail = bookWide.issues.length ? bookWide.issues.join('; ') : 'obvious consistency issues';
        const spreadHint = bookWide.suspectSpreads.length
          ? ` Suspect spread(s): ${bookWide.suspectSpreads.join(', ')}.`
          : '';
        throw new Error(`Book-wide consistency failed: ${detail}.${spreadHint}`);
      }
      log('info', 'Book-wide consistency gate passed');
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
      coverParentPresent,
      parentOutfit,
      spreadIndex = 0,
      totalSpreads = 13,
      costTracker,
      freshAttempts = 0,
      celebrationAge: inputCelebrationAge,
      abortSignal: inputAbortSignal,
      storyBible: inputStoryBible,
      consistencyCorrectionNote,
    } = input;

    const log = (level, msg) => console.log(`[illustrator/singleSpread] [${level}] ${msg}`);
    const isParentTheme = theme && PARENT_THEMES.has(theme);
    // For parent themes, "parent on cover" requires a person of the parent's
    // gender (set by the cover vision step in server.js). A sibling or
    // grandparent on the cover does NOT count as the parent being present.
    // For non-parent themes, any secondary on the cover counts (legacy behavior).
    const hasParentOnCover = isParentTheme
      ? coverParentPresent === true
      : !!additionalCoverCharacters;
    const hasSecondaryOnCover = !!additionalCoverCharacters;
    const celebrationAge = inputCelebrationAge ?? null;

    // 1. Create session
    const session = createSession({
      style,
      coverBase64: coverBase64 || null,
      coverMime: 'image/jpeg',
      childPhotoBase64: childPhotoBase64 || null,
      childPhotoMime,
      hasParentOnCover,
      hasSecondaryOnCover,
      additionalCoverCharacters,
      theme,
      parentOutfit,
      abortSignal: inputAbortSignal,
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

    if (consistencyCorrectionNote) {
      safeScenePrompt = `${consistencyCorrectionNote}\n\n${safeScenePrompt}`;
    }

    // 4. Build prompt
    const prompt = buildSpreadPrompt({
      spreadIndex,
      totalSpreads,
      scenePrompt: safeScenePrompt,
      leftText: leftText || spreadText,
      rightText: rightText || null,
      hasParentOnCover,
      hasSecondaryOnCover,
      additionalCoverCharacters,
      theme,
      style,
      parentOutfit,
      storyBible: inputStoryBible || { characters: [], locations: [], objects: [] },
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

    const extraOpts = {
      spreadPrompt: safeScenePrompt,
      spreadText: spreadText || '',
      theme: theme || '',
      celebrationAge,
      coverBase64: coverBase64 || null,
      additionalCoverCharacters,
      hasSecondaryOnCover,
      hasParentOnCover,
      spreadIndex,
      totalSpreads,
      costTracker,
      abortSignal: inputAbortSignal,
    };

    const qaOpts = { costTracker, spreadText, abortSignal: inputAbortSignal };
    let textCheck = { pass: true, issues: [], tags: [] };
    let anatomyCheck = { pass: true, issues: [], tags: [] };
    let extraCheck = { pass: true, issues: [], tags: [] };
    let artStyleCheck = { pass: true, issues: [], tags: [] };
    let qaRetries = 0;

    while (true) {
      if (inputAbortSignal?.aborted) {
        const err = new Error('Illustration generation aborted');
        err.name = 'AbortError';
        throw err;
      }
      [textCheck, anatomyCheck] = await Promise.all([
        verifySpreadText(imageBase64, spreadText || '', qaOpts),
        checkAnatomy(imageBase64, qaOpts),
      ]);

      if (!textCheck.pass || !anatomyCheck.pass) {
        qaRetries++;
        if (qaRetries > MAX_SPREAD_RETRIES) break;

        const issues = [
          ...(textCheck.pass ? [] : textCheck.issues.map(i => `[text] ${i}`)),
          ...(anatomyCheck.pass ? [] : anatomyCheck.issues.map(i => `[anatomy] ${i}`)),
        ];
        log('warn', `QA Agent1 failed (retry ${qaRetries}/${MAX_SPREAD_RETRIES}): ${issues.join('; ')}`);

        const qaTags = new Set([
          ...(Array.isArray(textCheck.tags) ? textCheck.tags : []),
          ...(Array.isArray(anatomyCheck.tags) ? anatomyCheck.tags : []),
        ]);
        const hasSplitPanel = qaTags.has('split_panel')
          || issues.some(iss => iss.toLowerCase().includes('split panel'));

        if (hasSplitPanel) {
          if (freshAttempts < MAX_FRESH_SESSION_RETRIES) {
            log('warn', `Single-spread split_panel detected — retrying with fresh session (attempt ${freshAttempts + 1}/${MAX_FRESH_SESSION_RETRIES})`);
            return this.generateSingleSpread({ ...input, freshAttempts: freshAttempts + 1 });
          }
          throw new Error(`Single-spread QA: split_panel persisted after ${MAX_FRESH_SESSION_RETRIES} fresh sessions`);
        }

        const hasDuplicatedHero = qaTags.has('duplicated_hero')
          || issues.some(iss => /duplicated?\s+hero|hero\s+duplicat|same\s+child\s+appear/i.test(iss));
        const hasHeadCropped = qaTags.has('head_cropped')
          || issues.some(iss => /head\s+(is\s+)?crop|face\s+(is\s+)?crop|head\s+cut\s+off/i.test(iss));
        const hasMissingLimb = qaTags.has('missing_limb')
          || issues.some(iss => /missing\s+(limb|arm|hand|leg|finger)|amputat|stump|ends?\s+at\s+(the\s+)?(wrist|shoulder|elbow)/i.test(iss));

        let correctionPrompt;
        if (hasDuplicatedHero) {
          correctionPrompt = `REGENERATE this spread COMPLETELY. The previous image drew the main child MORE THAN ONCE — this is WRONG.

CRITICAL: The hero must appear EXACTLY ONCE. No twin sibling, no before/after pose of the same child, no mirror/photo copy.
If a parent or other character is in the scene, they must look clearly different from the hero.

${prompt}`;
        } else if (hasHeadCropped) {
          correctionPrompt = `REGENERATE this spread with the SAME scene. The previous image CROPPED THE HERO'S HEAD at the edge of the frame — this is WRONG.

CRITICAL: The main child's head and full face MUST be fully inside the frame. Leave at least 8% of image height ABOVE the top of the child's head. Never crop the hero's head at any edge.

${prompt}`;
        } else if (hasMissingLimb) {
          correctionPrompt = `REGENERATE this spread with the SAME scene. The previous image had a MISSING LIMB — an arm, hand, or leg that ended with no crop and no covering. This is WRONG.

CRITICAL: Every visible character must have anatomically complete limbs. Every visible arm must end in a hand with 5 fingers. No stumps, no amputated look, no limbs ending mid-air. If a limb is not shown, it MUST be clearly hidden behind the body, behind an object, or cropped by the image edge.

${prompt}`;
        } else {
          correctionPrompt = `Fix these issues:\n${issues.join('\n')}\n\nRegenerate the spread with the same scene but fixing all listed problems.\n\n${prompt}`;
        }

        try {
          const retryResult = await sendCorrection(session, correctionPrompt, spreadIndex);
          imageBase64 = retryResult.imageBase64;
          imageBuffer = retryResult.imageBuffer;
        } catch (retryErr) {
          log('warn', `Agent1 correction retry ${qaRetries} failed: ${retryErr.message}`);
        }
        continue;
      }

      [extraCheck, artStyleCheck] = await Promise.all([
        checkExtraSpreadQa(imageBase64, extraOpts),
        checkArtStyleLock(imageBase64, { style, costTracker, abortSignal: input.abortSignal }),
      ]);

      if (!extraCheck.pass || !artStyleCheck.pass) {
        qaRetries++;
        if (qaRetries > MAX_SPREAD_RETRIES) break;

        const issues = [
          ...(extraCheck.pass ? [] : extraCheck.issues.map(i => `[extra] ${i}`)),
          ...(artStyleCheck.pass ? [] : artStyleCheck.issues.map(i => `[style] ${i}`)),
        ];
        log('warn', `QA Agent2 failed (retry ${qaRetries}/${MAX_SPREAD_RETRIES}): ${issues.join('; ')}`);

        const qaTags = new Set([
          ...(Array.isArray(extraCheck.tags) ? extraCheck.tags : []),
          ...(Array.isArray(artStyleCheck.tags) ? artStyleCheck.tags : []),
        ]);
        const hasSplitPanel = qaTags.has('split_panel')
          || issues.some(iss => iss.toLowerCase().includes('split panel'));
        if (hasSplitPanel) {
          if (freshAttempts < MAX_FRESH_SESSION_RETRIES) {
            log('warn', `Single-spread split_panel (Agent2) — fresh session (attempt ${freshAttempts + 1}/${MAX_FRESH_SESSION_RETRIES})`);
            return this.generateSingleSpread({ ...input, freshAttempts: freshAttempts + 1 });
          }
          throw new Error(`Single-spread QA: split_panel persisted after ${MAX_FRESH_SESSION_RETRIES} fresh sessions`);
        }

        let correctionPrompt;
        if (qaTags.has('art_style_mismatch') && extraCheck.pass) {
          correctionPrompt = buildStyleCorrectionPrompt(style, prompt);
        } else {
          correctionPrompt = `Fix these issues:\n${issues.join('\n')}\n\nRegenerate the spread with the same scene but fixing all listed problems.\n\n${prompt}`;
        }

        try {
          const retryResult = await sendCorrection(session, correctionPrompt, spreadIndex);
          imageBase64 = retryResult.imageBase64;
          imageBuffer = retryResult.imageBuffer;
        } catch (retryErr) {
          log('warn', `Agent2 correction retry ${qaRetries} failed: ${retryErr.message}`);
        }
        continue;
      }

      break;
    }

    if (!textCheck.pass || !anatomyCheck.pass || !extraCheck.pass || !artStyleCheck.pass) {
      const remaining = [
        ...(textCheck.pass ? [] : textCheck.issues.map(i => `[text] ${i}`)),
        ...(anatomyCheck.pass ? [] : anatomyCheck.issues.map(i => `[anatomy] ${i}`)),
        ...(extraCheck.pass ? [] : extraCheck.issues.map(i => `[extra] ${i}`)),
        ...(artStyleCheck.pass ? [] : artStyleCheck.issues.map(i => `[style] ${i}`)),
      ];
      throw new Error(`Single-spread QA failed after ${qaRetries} retries: ${remaining.join('; ')}`);
    }

    // 7. Post-process
    imageBuffer = Buffer.from(imageBase64, 'base64');
    imageBuffer = await stripMetadata(imageBuffer);
    imageBuffer = await upscaleForPrint(imageBuffer);

    return { imageBuffer, imageBase64: imageBuffer.toString('base64') };
  }
}

module.exports = { IllustratorEngine };
