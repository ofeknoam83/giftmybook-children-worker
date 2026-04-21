/**
 * WriterEngine — single entry point for all Writer V2 story generation.
 *
 * Orchestrates: theme routing → plan → write → quality gate → revise loop → stamp.
 *
 * Handles legacy payload conversion so existing standalone payloads work
 * without any changes to the standalone.
 */

const { getThemeWriter } = require('./themes');
const { QualityGate } = require('./quality/gate');
const { stampBook } = require('./version');
const { WRITER_CONFIG } = require('./config');

class WriterEngine {
  /**
   * Generate a story for a children's book.
   *
   * @param {object} bookJson - The book payload (new format or legacy flat format)
   * @param {object} opts - { onProgress: fn, maxRetries: number }
   * @returns {{ story: { spreads: [...] }, metadata: { writerVersion, timestamp, model, qualityScore, ... } }}
   */
  static async generate(bookJson, opts = {}) {
    const { onProgress, maxRetries, storySeed } = opts;

    // Pipeline transparency: record stages, context, and LLM calls
    const pipeline = {
      stages: [],
      llmCalls: [],
      themeDetected: null,
      childContext: null,
      bookContext: null,
    };

    // Normalize payload: support both new { child, book } and legacy flat format
    const child = bookJson.child || buildChildFromLegacy(bookJson);
    const book = bookJson.book || buildBookFromLegacy(bookJson);

    // Record what was extracted
    pipeline.childContext = { ...child };
    pipeline.bookContext = { ...book };
    pipeline.themeDetected = book.theme;

    // 1. Get theme-specific writer
    const themeWriter = getThemeWriter(book.theme);
    if (!themeWriter) {
      throw new Error(`Writer V2 does not support theme "${book.theme}" — use legacy pipeline`);
    }

    // Enable pipeline recording on the theme writer
    themeWriter._pipeline = pipeline;

    // 2. Plan the story
    onProgress?.({ step: 'planning', message: 'Planning story beats...' });
    console.log(`[writerV2] Planning story for ${child.name}, age ${child.age}, theme ${book.theme}`);
    const plan = await themeWriter.plan(child, book, { storySeed });
    console.log(`[writerV2] Plan complete: ${plan.beats.length} beats, tier ${plan.ageTier}, target ${plan.wordTargets.total} words`);
    pipeline.stages.push({
      name: 'plan',
      input: { child: child.name, age: child.age, theme: book.theme },
      output: plan,
      timestamp: new Date().toISOString(),
    });

    // 3. Write the story (with catastrophic retry if 0 spreads)
    onProgress?.({ step: 'writing', message: 'Writing story text...' });
    let story = await themeWriter.write(plan, child, book);
    console.log(`[writerV2] First draft: ${story.spreads.length} spreads, model ${story._model}`);
    pipeline.stages.push({
      name: 'write',
      output: { spreads: story.spreads.length, model: story._model },
      rawText: story._rawText || null,
      timestamp: new Date().toISOString(),
    });

    // Catastrophic failure guard: if write() returned 0 spreads, retry up to 2 more times
    const MIN_SPREADS = 5;
    let writeRetries = 0;
    while (story.spreads.length < MIN_SPREADS && writeRetries < 2) {
      writeRetries++;
      console.warn(`[writerV2] CRITICAL: write() returned ${story.spreads.length} spreads (min ${MIN_SPREADS}). Full retry ${writeRetries}/2...`);
      onProgress?.({ step: 'writing', message: `Retrying story (attempt ${writeRetries + 1})...` });
      try {
        story = await themeWriter.write(plan, child, book);
        console.log(`[writerV2] Retry ${writeRetries} produced ${story.spreads.length} spreads, model ${story._model}`);
        pipeline.stages.push({
          name: `write_retry_${writeRetries}`,
          output: { spreads: story.spreads.length, model: story._model },
          timestamp: new Date().toISOString(),
        });
      } catch (retryErr) {
        console.error(`[writerV2] Retry ${writeRetries} failed: ${retryErr.message}`);
      }
    }

    // If still 0 spreads after all retries, throw — do NOT pass empty story downstream
    if (story.spreads.length === 0) {
      throw new Error(`Writer V2 produced 0 spreads after ${writeRetries + 1} attempts — cannot continue. Model: ${story._model || 'unknown'}`);
    }

    // 4. Quality check
    onProgress?.({ step: 'quality', message: 'Running quality checks...' });
    let quality = await QualityGate.check(story, child, book, { plan });
    console.log(`[writerV2] Quality: ${quality.overallScore}/10, pass=${quality.pass}, scores=${JSON.stringify(quality.scores)}`);
    pipeline.stages.push({
      name: 'quality',
      output: { overallScore: quality.overallScore, pass: quality.pass, scores: quality.scores },
      feedback: quality.feedback || null,
      timestamp: new Date().toISOString(),
    });

    // 5. Revise if needed (up to maxRetries)
    let attempts = 0;
    const retryLimit = maxRetries ?? WRITER_CONFIG.retries.maxQualityRetries;
    while (!quality.pass && attempts < retryLimit) {
      onProgress?.({ step: 'revising', message: `Revising story (attempt ${attempts + 1})...` });
      console.log(`[writerV2] Revising (attempt ${attempts + 1}/${retryLimit}): ${quality.feedback.slice(0, 200)}`);
      story = await themeWriter.revise(story, quality.feedback, child, book);
      quality = await QualityGate.check(story, child, book, { plan });
      console.log(`[writerV2] After revision ${attempts + 1}: ${quality.overallScore}/10, pass=${quality.pass}`);
      pipeline.stages.push({
        name: `revision_${attempts + 1}`,
        output: { overallScore: quality.overallScore, pass: quality.pass, scores: quality.scores },
        feedback: quality.feedback || null,
        timestamp: new Date().toISOString(),
      });
      attempts++;
    }

    // 6. Stamp with version + timestamp
    const metadata = stampBook(story, quality, book.theme);
    console.log(`[writerV2] Complete: v${metadata.writerVersion}, ${metadata.totalWords} words, score ${metadata.qualityScore}`);

    onProgress?.({ step: 'complete', message: 'Story generation complete.' });

    return { story, metadata, pipeline, plan };
  }
}

/**
 * Convert legacy flat payload to child object.
 * Handles the current standalone payload format where everything is flat.
 */
function buildChildFromLegacy(payload) {
  const brief = payload.brief && typeof payload.brief === 'object' ? payload.brief : {};
  const bc = brief.child || {};
  return {
    name: bc.name || payload.childName,
    age: bc.age != null ? Number(bc.age) : payload.childAge,
    gender: bc.gender || payload.childGender,
    appearance: payload.childAppearance || '',
    interests: payload.childInterests || (bc.favorite_activities ? [bc.favorite_activities] : []),
    photoUrls: payload.childPhotoUrls || [],
    anecdotes: {
      favorite_activities: bc.favorite_activities || '',
      funny_thing: bc.funny_thing || '',
      favorite_food: bc.favorite_food || '',
      other_detail: bc.other_detail || '',
      calls_mom: bc.calls_mom || '',
      mom_name: bc.mom_name || '',
      calls_dad: bc.calls_dad || '',
      dad_name: bc.dad_name || '',
      meaningful_moment: bc.meaningful_moment || '',
      moms_favorite_moment: bc.moms_favorite_moment || '',
      favorite_cake_flavor: bc.favorite_cake_flavor || '',
      favorite_toys: bc.favorite_toys || '',
      birth_date: bc.birth_date || '',
      anything_else: bc.anything_else || '',
      ...(payload.childAnecdotes || {}),
    },
  };
}

/**
 * Convert legacy flat payload to book object.
 */
function buildBookFromLegacy(payload) {
  return {
    format: payload.bookFormat || 'PICTURE_BOOK',
    theme: payload.theme || payload.occasionTheme || (payload.brief?.child?.theme) || 'adventure',
    artStyle: payload.artStyle || 'watercolor',
    bindingType: payload.bindingType || '',
    title: payload.approvedTitle || null,
    customDetails: payload.customDetails || '',
    heartfeltNote: payload.heartfeltNote || null,
    bookFrom: payload.bookFrom || null,
    coverUrl: payload.approvedCoverUrl || null,
    emotionalCategory: payload.emotionalCategory || null,
    emotionalSituation: payload.emotionalSituation || null,
    emotionalParentGoal: payload.emotionalParentGoal || null,
    copingResourceHint: payload.copingResourceHint || null,
  };
}

module.exports = { WriterEngine, buildChildFromLegacy, buildBookFromLegacy };
