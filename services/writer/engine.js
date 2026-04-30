/**
 * WriterEngine — single entry point for all Writer V2 story generation.
 *
 * Orchestrates: theme routing → plan → write → quality gate → revise loop → stamp.
 *
 * Handles legacy payload conversion so existing standalone payloads work
 * without any changes to the standalone.
 */

const crypto = require('crypto');
const { getThemeWriter } = require('./themes');
const { QualityGate } = require('./quality/gate');
const { stampBook } = require('./version');
const { WRITER_CONFIG } = require('./config');
const { fixPossessivePronounErrors } = require('../pronouns');

/** Short hash of reviser/critic feedback for logs (not reversible). */
function v2FeedbackDigest(s) {
  if (!s) return '';
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 12);
}

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
   * @param {object} opts - { onProgress, maxRetries, storySeed, bookId (for [writerV2] logs) }
   * @returns {{ story: { spreads: [...] }, metadata: { writerVersion, timestamp, model, qualityScore, ... } }}
   */
  static async generate(bookJson, opts = {}) {
    const { onProgress, maxRetries, storySeed, bookId: bookIdOpt } = opts;
    const bookId = bookIdOpt || 'n/a';

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
    let book = bookJson.book || buildBookFromLegacy(bookJson);
    if (bookJson.book && typeof bookJson.book === 'object') {
      const lb = buildBookFromLegacy(bookJson);
      book = {
        ...lb,
        ...bookJson.book,
        coverParentPresent: bookJson.book.coverParentPresent === true
          || bookJson.book.cover_parent_present === true
          || lb.coverParentPresent === true,
        additionalCoverCharacters: (() => {
          const merged = (
            bookJson.book.additionalCoverCharacters ||
            bookJson.book.additional_cover_characters ||
            lb.additionalCoverCharacters ||
            ''
          ).toString().trim();
          return merged || null;
        })(),
      };
    }

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
    console.log(`[writerV2] Planning story for ${child.name}, age ${child.age}, theme ${book.theme}`, { bookId });
    const plan = await themeWriter.plan(child, book, { storySeed });
    const refrainHint = (plan.refrain && Array.isArray(plan.refrain.suggestions) && plan.refrain.suggestions[0])
      ? String(plan.refrain.suggestions[0]).slice(0, 80)
      : (plan.refrain?.toString?.() || '').slice(0, 80);
    console.log(`[writerV2] plan complete`, {
      bookId,
      beats: plan.beats?.length,
      usedStorySeedBeats: plan.usedStorySeedBeats === true,
      ageTier: plan.ageTier,
      wordTarget: plan.wordTargets?.total,
      refrainHint: refrainHint || null,
    });
    pipeline.stages.push({
      name: 'plan',
      input: { child: child.name, age: child.age, theme: book.theme },
      output: plan,
      timestamp: new Date().toISOString(),
    });

    // 3. Write the story (with catastrophic retry if 0 spreads)
    onProgress?.({ step: 'writing', message: 'Writing story text...' });
    let story = await themeWriter.write(plan, child, book);
    console.log(`[writerV2] first draft`, { bookId, spreads: story.spreads.length, model: story._model });
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

    // 4. Quality gate — deterministic rules only; optional LLM notes never block.
    // Loop: check → revise with machine-check feedback → re-check.
    const retryLimit = maxRetries ?? WRITER_CONFIG.retries.maxQualityRetries;
    console.log(`[writerV2] quality config`, { bookId, maxQualityRetries: retryLimit, theme: book.theme, age: child.age });

    onProgress?.({ step: 'quality', message: 'Running quality checks...' });
    const qWaveStart = Date.now();
    let quality = await QualityGate.check(story, child, book, { plan, bookId });
    console.log(`[writerV2] quality: checkpoint`, {
      bookId,
      ms: Date.now() - qWaveStart,
      pass: quality.pass,
      vetoes: quality.deterministicVetoes,
      feedbackLen: (quality.feedback || '').length,
      feedbackDigest: v2FeedbackDigest(quality.feedback),
    });
    pipeline.stages.push({
      name: 'quality',
      output: { pass: quality.pass, scores: quality.scores },
      feedback: quality.feedback || null,
      timestamp: new Date().toISOString(),
    });

    let best = { story, quality };
    let attempts = 0;
    while (!quality.pass && attempts < retryLimit) {
      attempts++;
      onProgress?.({ step: 'revising', message: `Revising story (attempt ${attempts}/${retryLimit})...` });
      const revStart = Date.now();
      console.log(`[writerV2] revise: start ${attempts}/${retryLimit}`, {
        bookId,
        feedbackLen: (quality.feedback || '').length,
        feedbackDigest: v2FeedbackDigest(quality.feedback),
      });
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

      quality = await QualityGate.check(story, child, book, { plan, bookId });
      console.log(`[writerV2] revise: done attempt ${attempts}`, {
        bookId,
        ms: Date.now() - revStart,
        pass: quality.pass,
        feedbackLen: (quality.feedback || '').length,
        feedbackDigest: v2FeedbackDigest(quality.feedback),
      });
      pipeline.stages.push({
        name: `revision_${attempts}`,
        output: { pass: quality.pass, scores: quality.scores },
        feedback: quality.feedback || null,
        timestamp: new Date().toISOString(),
      });

      best = { story, quality };
      if (quality.pass) break;
    }

    const finalStory = best.story;
    const finalQuality = best.quality;
    if (!finalQuality.pass) {
      const head = (finalQuality.feedback || '').slice(0, 500);
      console.error(`[writerV2] deterministic quality gate did not pass after ${attempts} revision(s)`, {
        bookId,
        vetoes: finalQuality.deterministicVetoes,
        feedbackHead: head,
      });
      throw new WriterQualityGateError(
        `Story did not pass machine checks (pronouns, rhyme, read-aloud, or SCENE/palette) after ${retryLimit} attempts. ${head}`,
        finalQuality.feedback || '',
        finalQuality.overallScore ?? 0,
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
    console.log(`[writerV2] complete`, { bookId, version: metadata.writerVersion, words: metadata.totalWords, qualityScore: metadata.qualityScore });

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
    coverParentPresent: payload.coverParentPresent === true || payload.cover_parent_present === true,
    additionalCoverCharacters: (
      payload.additionalCoverCharacters ||
      payload.additional_cover_characters ||
      brief.additionalCoverCharacters ||
      brief.additional_cover_characters ||
      ''
    ).toString().trim() || null,
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
