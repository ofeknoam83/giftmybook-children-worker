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

    return { story, metadata, pipeline, plan, child, book, themeWriter };
  }

  /**
   * Run up to `maxAttempts` additional revision passes and re-score. Used by
   * server.js when an out-of-band check (e.g. custom-details usage) flags
   * critical misses after the main loop has finished. Keeps the BEST version
   * seen (including the original) — never regresses.
   *
   * "Best" ordering:
   *   1. `pass=true` beats `pass=false`
   *   2. higher overallScore wins
   *
   * opts:
   *   - missingCritical: string[] — items the external check flagged. Passed
   *     through to the gate so revision feedback can call them out.
   *   - maxAttempts:     number   — default 2. Each attempt reruns reviser +
   *     QualityGate; cheap early-exits on the first `pass=true`.
   *   - onAttempt:       fn({attempt, score, pass}) — optional progress hook.
   */
  static async reviseWithFeedback(writerResult, feedback, opts = {}) {
    const { themeWriter, story, plan, child, book } = writerResult;
    if (!themeWriter || !feedback) return writerResult;
    const missingCritical = Array.isArray(opts.missingCritical) ? opts.missingCritical : [];
    const maxAttempts = Number.isFinite(opts.maxAttempts) && opts.maxAttempts > 0 ? opts.maxAttempts : 2;
    const onAttempt = typeof opts.onAttempt === 'function' ? opts.onAttempt : null;

    // Seed the "best" tracker with the ORIGINAL story. If every revision
    // comes back worse (and none pass), we return this untouched — that is
    // the explicit guard against the previous behavior where a 5.9/10
    // revision replaced a 6.8/10 original.
    const originalScore = typeof writerResult.metadata?.qualityScore === 'number'
      ? writerResult.metadata.qualityScore
      : 0;
    let best = {
      story,
      metadata: writerResult.metadata,
      score: originalScore,
      pass: false, // we're only here because an external check failed
      source: 'original',
    };

    let workingStory = story;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`[writerV2] Post-hoc revision ${attempt}/${maxAttempts}: ${feedback.slice(0, 160)}`);
      let revisedStory;
      try {
        revisedStory = await themeWriter.revise(workingStory, feedback, child, book);
      } catch (err) {
        console.warn(`[writerV2] Post-hoc revision ${attempt} failed: ${err.message}`);
        break;
      }
      if (!revisedStory || !Array.isArray(revisedStory.spreads) || revisedStory.spreads.length === 0) {
        console.warn(`[writerV2] Post-hoc revision ${attempt} produced 0 spreads`);
        break;
      }

      let quality;
      try {
        // Re-score without re-asserting missingCritical — we want to judge
        // the revised story on its own merits. The deterministic anecdote
        // scorer still penalizes misses, so a non-addressed revision won't
        // score higher than the original by accident.
        quality = await QualityGate.check(revisedStory, child, book, { plan });
      } catch (err) {
        console.warn(`[writerV2] Post-hoc QualityGate check failed on attempt ${attempt}: ${err.message}`);
        break;
      }

      const metadata = stampBook(revisedStory, quality, book.theme);
      const score = typeof metadata.qualityScore === 'number' ? metadata.qualityScore : 0;
      console.log(`[writerV2] Revision ${attempt} scored ${score}/10 (pass=${quality.pass})`);
      if (onAttempt) {
        try { onAttempt({ attempt, score, pass: quality.pass }); } catch { /* ignore */ }
      }

      // Strictly "better" if we move from fail→pass, or beat the current
      // best score (tie-break keeps the incumbent so we don't churn).
      const becomesBetter = (quality.pass && !best.pass)
        || (quality.pass && best.pass && score > best.score)
        || (!quality.pass && !best.pass && score > best.score);
      if (becomesBetter) {
        best = { story: revisedStory, metadata, score, pass: quality.pass, source: `revision_${attempt}` };
      }

      if (quality.pass) break; // clean pass → done
      workingStory = revisedStory; // iterate from the most recent attempt
    }

    if (best.source === 'original') {
      console.warn(`[writerV2] All ${maxAttempts} post-hoc revisions scored below original (${originalScore}/10) — keeping original`);
    } else {
      console.log(`[writerV2] Post-hoc revision complete: kept ${best.source} at score ${best.score}/10 (pass=${best.pass})`);
    }

    return {
      story: best.story,
      metadata: best.metadata,
      pipeline: writerResult.pipeline,
      plan,
      child,
      book,
      themeWriter,
    };
  }
}

/**
 * Compute full years elapsed between `dob` and now. Returns null on unparseable
 * input, clamped to 0 (no negative ages for future-dated test payloads).
 * Exported on the module for tests.
 */
function ageFromDOB(dob, now = new Date()) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  let years = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) years--;
  return Math.max(0, years);
}

/**
 * Convert legacy flat payload to child object.
 * Handles the current standalone payload format where everything is flat.
 *
 * Age resolution order:
 *   1. brief.child.age (explicit numeric)
 *   2. payload.childAge (explicit numeric)
 *   3. brief.child.birth_date (derived)
 *   4. null (writer defaults to tier 2 elsewhere, with a console.warn)
 */
function buildChildFromLegacy(payload) {
  const brief = payload.brief && typeof payload.brief === 'object' ? payload.brief : {};
  const bc = brief.child || {};

  const explicitAge = (() => {
    if (bc.age != null && bc.age !== '') {
      const n = Number(bc.age);
      if (Number.isFinite(n)) return n;
    }
    if (payload.childAge != null && payload.childAge !== '') {
      const n = Number(payload.childAge);
      if (Number.isFinite(n)) return n;
    }
    return null;
  })();
  const derivedAge = explicitAge == null ? ageFromDOB(bc.birth_date) : null;
  const finalAge = explicitAge != null ? explicitAge : derivedAge;

  if (explicitAge == null && derivedAge != null) {
    console.warn(`[writerV2] No explicit age supplied — derived age=${derivedAge} from birth_date="${bc.birth_date}" for child "${bc.name || payload.childName || 'unknown'}"`);
  } else if (finalAge == null) {
    console.warn(`[writerV2] No age and no birth_date for child "${bc.name || payload.childName || 'unknown'}" — writer will default to age-tier 2 (ages 3-5). Content may not fit the child.`);
  }

  return {
    name: bc.name || payload.childName,
    age: finalAge,
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
  const brief = payload.brief && typeof payload.brief === 'object' ? payload.brief : {};
  const bc = brief.child || {};
  const anec = payload.childAnecdotes || {};
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
    // Lift the parent's real first name onto the book object so prompt
    // builders that don't walk child.anecdotes still see it. The Mother's
    // Day prompt uses this for the "Optional Personal Touch" block that
    // surfaces the parent's real name exactly once in the story. Sources
    // are tried in order: top-level → flat brief.child → childAnecdotes.
    mom_name: payload.mom_name || bc.mom_name || anec.mom_name || '',
    dad_name: payload.dad_name || bc.dad_name || anec.dad_name || '',
    emotionalCategory: payload.emotionalCategory || null,
    emotionalSituation: payload.emotionalSituation || null,
    emotionalParentGoal: payload.emotionalParentGoal || null,
    copingResourceHint: payload.copingResourceHint || null,
  };
}

module.exports = { WriterEngine, buildChildFromLegacy, buildBookFromLegacy, ageFromDOB };
