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
const { fixPossessivePronounErrors } = require('../pronouns');

/** Thrown when the critic never passed and the best score is below the illustration floor. */
class WriterQualityGateError extends Error {
  /**
   * @param {string} message
   * @param {string} [feedback]
   * @param {number} [overallScore]
   */
  constructor(message, feedback, overallScore) {
    super(message);
    this.name = 'WriterQualityGateError';
    this.feedback = feedback || '';
    this.overallScore = overallScore;
  }
}

/** Critic LLM/JSON failed after internal retries — do not illustrate; user can retry the job. */
class WriterQualityCheckUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'WriterQualityCheckUnavailableError';
    this.cause = cause || '';
    this.isTransient = true;
  }
}

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

    // 4. Quality gate loop — check → revise → check until the critic says
    // ship=true, with a best-of-N tracker so we never regress. All quality
    // judgement lives in the LLM critic; there is no deterministic pass.
    onProgress?.({ step: 'quality', message: 'Running quality checks...' });
    let quality = await QualityGate.check(story, child, book, { plan });
    console.log(`[writerV2] First-draft quality: ${quality.overallScore}/10, pass=${quality.pass}, scores=${JSON.stringify(quality.scores)}`);
    pipeline.stages.push({
      name: 'quality',
      output: { overallScore: quality.overallScore, pass: quality.pass, scores: quality.scores },
      feedback: quality.feedback || null,
      timestamp: new Date().toISOString(),
    });

    // Track the best-seen (story, quality). If we exhaust retries without
    // a clean pass we ship the best candidate — never a regression.
    let best = { story, quality };

    const retryLimit = maxRetries ?? WRITER_CONFIG.retries.maxQualityRetries;
    let attempts = 0;
    while (!quality.pass && attempts < retryLimit) {
      // Never revise on critic infra failure — generic feedback makes the model "fix" a fine story.
      if (quality.criticFailed) {
        console.warn('[writerV2] Critic did not complete — skipping revision loop (no actionable feedback).');
        break;
      }
      attempts++;
      onProgress?.({ step: 'revising', message: `Revising story (attempt ${attempts}/${retryLimit})...` });
      console.log(`[writerV2] Revise ${attempts}/${retryLimit}: ${quality.feedback.slice(0, 240)}`);
      try {
        story = await themeWriter.revise(story, quality.feedback, child, book);
      } catch (err) {
        console.warn(`[writerV2] Revise attempt ${attempts} failed: ${err.message} — keeping best-so-far`);
        break;
      }
      if (!story || !Array.isArray(story.spreads) || story.spreads.length === 0) {
        console.warn(`[writerV2] Revise attempt ${attempts} produced 0 spreads — keeping best-so-far`);
        break;
      }

      quality = await QualityGate.check(story, child, book, { plan });
      console.log(`[writerV2] After revision ${attempts}: ${quality.overallScore}/10, pass=${quality.pass}`);
      pipeline.stages.push({
        name: `revision_${attempts}`,
        output: { overallScore: quality.overallScore, pass: quality.pass, scores: quality.scores },
        feedback: quality.feedback || null,
        timestamp: new Date().toISOString(),
      });

      if (quality.criticFailed) {
        console.warn('[writerV2] Critic failed after revise — reverting to last best story and scores.');
        story = best.story;
        quality = best.quality;
        break;
      }

      const isBetter = (quality.pass && !best.quality.pass)
        || (quality.pass && best.quality.pass && quality.overallScore > best.quality.overallScore)
        || (!quality.pass && !best.quality.pass && quality.overallScore > best.quality.overallScore);
      if (isBetter) best = { story, quality };

      if (quality.pass) break;
    }

    // Resolve to the best version we saw. If the final loop state is a
    // clean pass we already have it in `best`; otherwise we ship the
    // highest-scoring attempt.
    const finalStory = best.story;
    const finalQuality = best.quality;
    if (!finalQuality.pass) {
      console.warn(`[writerV2] Exhausted ${retryLimit} retries without a clean pass — best seen at ${finalQuality.overallScore}/10`);
    }

    // Critic never returned scores — do not illustrate (avoids shipping unrated / damaged drafts).
    if (finalQuality.criticFailed) {
      const cause = finalQuality.issues?.find(i => i.dimension === 'critic_error')?.note || '';
      throw new WriterQualityCheckUnavailableError(
        'Automated story review did not complete after multiple attempts. Please try again shortly.',
        cause,
      );
    }

    // Block illustration when the critic ran and scored the story too low.
    if (!finalQuality.pass && typeof finalQuality.overallScore === 'number' && finalQuality.overallScore < 4) {
      throw new WriterQualityGateError(
        `Story quality too low for illustration (score ${finalQuality.overallScore}/10). ${(finalQuality.feedback || '').slice(0, 500)}`,
        finalQuality.feedback || '',
        finalQuality.overallScore,
      );
    }

    // Final safety net: auto-repair object-for-possessive pronoun errors
    // ("him hair" → "his hair"). These are a documented ship-blocker with
    // zero false-positive risk on the narrow whitelist (body parts only).
    // The quality gate already vetoes on them and the revise loop should
    // have fixed them — but if we exhausted retries with the error still
    // present, auto-repair here so the customer never receives "him hair"
    // in their book. Silent mechanical fix; logs for audit.
    let autoFixCount = 0;
    for (const s of finalStory.spreads || []) {
      if (!s.text) continue;
      const fixed = fixPossessivePronounErrors(s.text);
      if (fixed !== s.text) {
        console.warn(`[writerV2] Auto-repaired possessive pronoun on spread ${s.spread}: "${s.text}" → "${fixed}"`);
        s.text = fixed;
        autoFixCount++;
      }
    }
    if (autoFixCount > 0) {
      console.warn(`[writerV2] Auto-repaired ${autoFixCount} possessive pronoun error(s) on the way out.`);
    }

    // 5. Stamp with version + timestamp
    const metadata = stampBook(finalStory, finalQuality, book.theme);
    console.log(`[writerV2] Complete: v${metadata.writerVersion}, ${metadata.totalWords} words, score ${metadata.qualityScore}`);

    onProgress?.({ step: 'complete', message: 'Story generation complete.' });

    return { story: finalStory, metadata, pipeline, plan, child, book, themeWriter };
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

module.exports = {
  WriterEngine,
  WriterQualityGateError,
  WriterQualityCheckUnavailableError,
  buildChildFromLegacy,
  buildBookFromLegacy,
  ageFromDOB,
};
