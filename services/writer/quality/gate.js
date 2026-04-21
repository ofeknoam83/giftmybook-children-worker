/**
 * QualityGate — unified quality scoring for Writer V2.
 *
 * Replaces masterCritic + combinedCritic + polishStory with a single,
 * structured quality check that returns pass/fail, scores, and feedback.
 *
 * Dimensions scored 1-10:
 *   - rhyme: Do couplets actually rhyme? Is meter consistent?
 *   - ageAppropriateness: Word count within limits? Vocabulary appropriate?
 *   - pronouns: Correct pronouns used? (deterministic)
 *   - readAloud: Would this sound good read aloud? Rhythm variation?
 *   - emotionalArc: Does it follow the beat structure? Emotional progression?
 *   - specificity: Concrete nouns? Actions over declarations? No greeting card language?
 *   - variety: Do spreads cover distinct activities/settings, or repeat the same scene?
 *   - settingVariety: Are there 2+ distinct physical locations across the 13 spreads? (deterministic)
 *   - anecdoteUsage: Do the child's real questionnaire details actually land in the text? (deterministic)
 *   - wordCount: Total and per-spread within limits? (deterministic)
 */

const { WRITER_CONFIG } = require('../config');
const { scorePronounCorrectness } = require('./pronoun');

// Reuse the LLM call infrastructure from base theme writer
const { BaseThemeWriter } = require('../themes/base');
const _llmCaller = new BaseThemeWriter('_quality_gate');

class QualityGate {
  /**
   * Run all quality checks on a story.
   * @param {object} story - { spreads: [{ spread, text }], _model, _ageTier }
   * @param {object} child - { name, age, gender, ... }
   * @param {object} book - { theme, ... }
   * @param {object} [opts] - { plan, missingCritical } — the writer's plan (used for
   *   manifest + beat locations) plus any anecdotes the external custom-details check
   *   flagged as missing; these are appended to the feedback so the revision loop can
   *   address them alongside the gate's own findings.
   * @returns {{ pass: boolean, overallScore: number, scores: object, feedback: string }}
   */
  static async check(story, child, book, opts = {}) {
    const spreads = story.spreads || [];
    const plan = opts.plan || null;
    const missingCritical = Array.isArray(opts.missingCritical) ? opts.missingCritical : [];
    const scores = {};
    const meta = {}; // extra context for feedback builder

    // Hard-fail: if there are 0 spreads, don't bother scoring
    if (spreads.length === 0) {
      return {
        pass: false,
        overallScore: 0,
        scores: { pronouns: 0, wordCount: 0, rhymeVariety: 0, endingAppropriateness: 0, rhyme: 0, ageAppropriateness: 0, readAloud: 0, emotionalArc: 0, specificity: 0, creativity: 0, variety: 0, narrativeCoherence: 0, settingVariety: 0, anecdoteUsage: 0 },
        feedback: 'CATASTROPHIC: Story has 0 spreads. The writer produced no output.',
      };
    }

    // Deterministic checks (fast, no LLM needed)
    scores.pronouns = scorePronounCorrectness(spreads, child.gender);
    scores.wordCount = QualityGate._scoreWordCount(spreads, child.age, story._ageTier);
    scores.rhymeVariety = QualityGate._scoreRhymeVariety(spreads);
    scores.endingAppropriateness = QualityGate._scoreEndingAppropriateness(spreads, book.theme);

    const settingVariety = QualityGate._scoreSettingVariety(spreads, plan);
    scores.settingVariety = settingVariety.score;
    meta.settingVariety = settingVariety;

    const anecdoteUsage = QualityGate._scoreAnecdoteUsage(spreads, plan, child);
    scores.anecdoteUsage = anecdoteUsage.score;
    meta.anecdoteUsage = anecdoteUsage;

    // Parent real name discipline: if the book provides mom_name or dad_name
    // and it differs from the address word the child uses, the story must
    // mention the real name AT MOST once. Overuse breaks the picture-book
    // voice (kids read books that say "Mama"/"Dad" as the reference, with
    // the real name reserved for a single dedication-style beat).
    const nameDiscipline = QualityGate._scoreNameDiscipline(spreads, book, child);
    scores.nameDiscipline = nameDiscipline.score;
    meta.nameDiscipline = nameDiscipline;

    // LLM-based checks (slower, subjective)
    try {
      const llmScores = await QualityGate._runLLMChecks(spreads, child, book);
      scores.rhyme = llmScores.rhyme || 7;
      scores.ageAppropriateness = llmScores.ageAppropriateness || 7;
      scores.readAloud = llmScores.readAloud || 7;
      scores.emotionalArc = llmScores.emotionalArc || 7;
      scores.specificity = llmScores.specificity || 7;
      scores.creativity = llmScores.creativity || 7;
      scores.variety = llmScores.variety || 7;
      scores.narrativeCoherence = llmScores.narrativeCoherence || 7;
    } catch (err) {
      console.warn(`[writerV2] LLM quality checks failed, using defaults: ${err.message}`);
      scores.rhyme = 7;
      scores.ageAppropriateness = 7;
      scores.readAloud = 7;
      scores.emotionalArc = 7;
      scores.specificity = 7;
      scores.creativity = 7;
      scores.variety = 7;
      scores.narrativeCoherence = 7;
    }

    const scoreValues = Object.values(scores);
    const overallScore = scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length;
    const minScore = Math.min(...scoreValues);

    // Funny-thing hard rule: if the questionnaire provided a `funny_thing`
    // and the anecdote scorer says it did not land, force a fail regardless
    // of the weighted overall score. This is called out in product review
    // as non-negotiable for personalization.
    const funnyThingMiss = QualityGate._funnyThingMissed(child, meta.anecdoteUsage);

    // Custom-details (external check) miss — same story: if a caller
    // already detected that a critical anecdote did not reach the prose,
    // we refuse to pass so the revision loop runs at least once more.
    const hasMissingCritical = missingCritical.length > 0;

    // Critical-dimension floors: some dimensions (anecdoteUsage, pronouns,
    // wordCount, endingAppropriateness) are so important that a low score
    // alone must trigger a revision, even if the weighted overall average
    // is high. Collect every failure so the revision feedback can be
    // specific about which dimensions need the most work.
    const critThresholds = WRITER_CONFIG.qualityThresholds.criticalDimensions || {};
    const criticalFailures = [];
    for (const [dim, floor] of Object.entries(critThresholds)) {
      const v = scores[dim];
      if (typeof v === 'number' && v < floor) {
        criticalFailures.push({ dimension: dim, score: v, floor });
      }
    }

    const pass = !funnyThingMiss
              && !hasMissingCritical
              && criticalFailures.length === 0
              && overallScore >= WRITER_CONFIG.qualityThresholds.passScore
              && minScore >= WRITER_CONFIG.qualityThresholds.minDimensionScore;

    const feedback = pass ? '' : QualityGate._buildFeedback(scores, spreads, meta, {
      funnyThingMiss,
      missingCritical,
      criticalFailures,
      overallScore,
      child,
    });

    return { pass, overallScore: Math.round(overallScore * 10) / 10, scores, feedback };
  }

  /**
   * Return the questionnaire value of `funny_thing` when it exists but
   * did not land in the story (per `meta.anecdoteUsage.requiredItems`).
   * Falls back to scanning the story text for the anecdote's keywords if
   * the scorer's manifest path hid the result.
   */
  static _funnyThingMissed(child, anecdoteUsage) {
    const funnyVal = child?.anecdotes?.funny_thing;
    if (!funnyVal || typeof funnyVal !== 'string' || !funnyVal.trim()) return null;
    if (!anecdoteUsage || !Array.isArray(anecdoteUsage.requiredItems)) return null;
    const match = anecdoteUsage.requiredItems.find(x => {
      if (x.kind === 'anecdote' && x.key === 'funny_thing') return true;
      if (x.kind === 'manifest' && x.key === 'funny_thing') return true;
      return false;
    });
    if (!match) return funnyVal.trim(); // not even scored → treat as missed
    return match.landed ? null : funnyVal.trim();
  }

  /**
   * Score setting variety deterministically.
   * Counts distinct physical locations across spreads. Prefers the plan's
   * beat.location when present, otherwise extracts a location hint from the
   * first sentence of each spread text.
   *
   * Flags two problems:
   *   - All 13 spreads at a single location (score 1-3, with "everything at home" as the canonical failure).
   *   - Only one distinct location overall (score 1-2).
   */
  static _scoreSettingVariety(spreads, plan) {
    const HOME_WORDS = ['home', 'house', 'bedroom', 'kitchen', 'living room', 'couch', 'bed', 'backyard', 'sofa'];

    // 1. Pull locations from the plan if available.
    const planLocations = [];
    if (plan && Array.isArray(plan.beats)) {
      for (const b of plan.beats) {
        if (b && typeof b.location === 'string' && b.location.trim()) {
          planLocations.push(b.location.trim().toLowerCase());
        }
      }
    }

    // 2. Otherwise, sniff locations from the spread text itself.
    const textLocations = spreads.map(s => (s.text || '').toLowerCase());

    const locationsPerSpread = planLocations.length >= spreads.length * 0.7
      ? planLocations.slice(0, spreads.length)
      : textLocations.map(txt => QualityGate._sniffLocation(txt));

    const filtered = locationsPerSpread.filter(Boolean);
    const distinct = new Set(filtered.map(l => QualityGate._canonicalLocation(l)));
    const distinctCount = distinct.size;

    // Count how many spreads are "at home" (using plan first, else text sniff)
    let atHome = 0;
    for (let i = 0; i < spreads.length; i++) {
      const loc = (locationsPerSpread[i] || '').toLowerCase();
      const text = (spreads[i].text || '').toLowerCase();
      const looksHome = HOME_WORDS.some(w => loc.includes(w)) || (!loc && HOME_WORDS.some(w => text.includes(w)));
      if (looksHome) atHome++;
    }

    let score = 10;
    if (distinctCount < 2) score = 2;
    else if (distinctCount === 2 && atHome >= 10) score = 4;
    else if (atHome >= 10) score = 3;
    else if (atHome >= 8) score = 5;
    else if (distinctCount === 2) score = 7;
    else if (distinctCount === 3) score = 9;
    else score = 10;

    return {
      score: Math.max(1, Math.min(10, score)),
      distinctCount,
      atHome,
      sampleLocations: Array.from(distinct).slice(0, 5),
    };
  }

  /**
   * Extract a rough location noun from a spread's text.
   * Not perfect — we're looking for the first setting-like noun near "in/at/on the".
   */
  static _sniffLocation(text) {
    if (!text) return '';
    const match = text.match(/\b(?:in|at|on|through|across|under|into|inside|outside)\s+(?:the|a|an|her|his|their|mama'?s|mommy'?s|daddy'?s)?\s*([a-z][a-z\s'-]{2,30}?)\b/i);
    if (match && match[1]) {
      return match[1].trim().toLowerCase().split(/\s+/).slice(0, 3).join(' ');
    }
    const firstSentence = text.split(/[.!?]/)[0] || '';
    const quick = firstSentence.match(/\b([a-z]+(?:\s+[a-z]+)?)\s+(?:room|house|garden|park|kitchen|beach|forest|street|bakery|shop|cafe|library|school|ocean|sea|river|lake|sky|cloud|sidewalk|driveway|yard)\b/i);
    if (quick) return quick[0].toLowerCase();
    return '';
  }

  /**
   * Canonicalize a location string to avoid counting "the kitchen" and "kitchen"
   * as distinct.
   */
  static _canonicalLocation(loc) {
    if (!loc) return '';
    return loc
      .replace(/^(the|a|an|her|his|their)\s+/i, '')
      .replace(/^(mama'?s|mommy'?s|daddy'?s|dad'?s|mom'?s)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Score anecdote usage deterministically.
   * If the plan has a manifest (from the anecdote-driven plot), scan the spreads
   * for each assignment's keywords and count how many landed. Otherwise fall back
   * to scanning child.anecdotes values directly.
   */
  static _scoreAnecdoteUsage(spreads, plan, child) {
    const manifest = plan && Array.isArray(plan.manifest) ? plan.manifest : null;
    const combinedText = spreads.map(s => (s.text || '')).join(' \n ').toLowerCase();

    // Anecdotes the product explicitly tags MUST-LAND. For these the scorer
    // requires ALL extracted keywords to land (not just a majority), so a
    // multi-word anecdote can't be satisfied by a single incidental match.
    // Semantic equivalence (e.g. euphemisms a picture book might use) is
    // handled by the LLM-based checkCustomDetailsUsage check — we keep this
    // scorer strictly literal so it stays deterministic and general.
    const MUST_LAND_KEYS = new Set([
      'funny_thing',
      'meaningful_moment',
      'moms_favorite_moment',
      'dads_favorite_moment',
      'favorite_object',
    ]);

    // The child's own name — and the parent's common labels — appear in
    // almost every spread of every book. If those tokens are allowed to
    // count as "anecdote keywords" they'll incidentally satisfy any
    // anecdote whose value happens to include the child's or parent's name
    // (the child's name would match on its own, regardless of whether the
    // anecdote actually landed). We drop them up front.
    const excludeTokens = new Set();
    const childName = (child?.name || '').toLowerCase().trim();
    if (childName && childName.length >= 3) excludeTokens.add(childName);
    const momCalls = (child?.anecdotes?.calls_mom || '').toLowerCase().trim();
    const dadCalls = (child?.anecdotes?.calls_dad || '').toLowerCase().trim();
    for (const t of [momCalls, dadCalls, 'mama', 'mommy', 'mom', 'mum', 'mommy', 'daddy', 'dad', 'papa']) {
      if (t && t.length >= 3) excludeTokens.add(t);
    }

    let requiredItems = [];
    let hits = [];
    let misses = [];

    if (manifest && manifest.length > 0) {
      for (const m of manifest) {
        const value = String(m.anecdote_value || '').trim();
        if (!value) continue;
        const keywords = QualityGate._extractKeywords(value, excludeTokens);
        if (keywords.length === 0) continue;
        const strict = MUST_LAND_KEYS.has(m.anecdote_key);
        const landed = strict
          ? QualityGate._allLanded(keywords, combinedText)
          : QualityGate._majorityLanded(keywords, combinedText);
        requiredItems.push({ kind: 'manifest', spread: m.spread, key: m.anecdote_key, value, landed, keywords, strict });
        if (landed) hits.push(`spread ${m.spread}: "${value}"`);
        else misses.push(`spread ${m.spread}: "${value}"`);
      }
    } else {
      // Fall back to anecdotes directly
      const a = child?.anecdotes || {};
      // Full list kept in sync with services/writer/themes/anecdotes.js
      // ANECDOTE_FIELDS. Explicitly includes mom_name/dad_name/calls_mom/
      // calls_dad — these used to be silently excluded so the gate would
      // score 10/10 even when the parent's real name never appeared in
      // the book.
      const anecFields = [
        'favorite_activities', 'funny_thing', 'meaningful_moment',
        'moms_favorite_moment', 'dads_favorite_moment',
        'favorite_food', 'favorite_cake_flavor', 'favorite_toys',
        'mom_name', 'dad_name', 'calls_mom', 'calls_dad',
        'other_detail', 'anything_else',
      ];
      for (const key of anecFields) {
        const val = a[key];
        if (!val || typeof val !== 'string' || !val.trim()) continue;
        // For *name* fields the value IS the keyword (the name itself).
        // Bypass the exclude-list for those — otherwise calls_mom="Mama"
        // would immediately get dropped and the field would always score
        // neutral. The parent-label exclude-list only protects anecdote
        // VALUES that happen to contain a parent label.
        const isNameField = key === 'mom_name' || key === 'dad_name' || key === 'calls_mom' || key === 'calls_dad';
        const keywords = isNameField
          ? QualityGate._extractKeywords(val, new Set())
          : QualityGate._extractKeywords(val, excludeTokens);
        if (keywords.length === 0) continue;
        const strict = MUST_LAND_KEYS.has(key);
        const landed = strict
          ? QualityGate._allLanded(keywords, combinedText)
          : QualityGate._majorityLanded(keywords, combinedText);
        requiredItems.push({ kind: 'anecdote', key, value: val, landed, keywords, strict });
        if (landed) hits.push(`${key}: "${val}"`);
        else misses.push(`${key}: "${val}"`);
      }
    }

    if (requiredItems.length === 0) {
      // Nothing to score against — neutral.
      return { score: 8, hits: [], misses: [], source: 'none' };
    }

    const ratio = hits.length / requiredItems.length;
    let score = 10;
    if (ratio < 0.3) score = 3;
    else if (ratio < 0.5) score = 5;
    else if (ratio < 0.7) score = 7;
    else if (ratio < 0.9) score = 9;
    else score = 10;

    return {
      score,
      hits,
      misses,
      total: requiredItems.length,
      requiredItems,
      source: manifest ? 'manifest' : 'anecdotes',
    };
  }

  /**
   * A keyword list "lands" when a majority of its tokens appear as
   * substrings of the combined story text. For a 1-keyword list the only
   * token must match; for 2+ keywords at least ceil(n/2) must. This is
   * stricter than the previous `some()` predicate which let a single
   * incidental match paper over a missing anecdote.
   */
  static _majorityLanded(keywords, combinedText) {
    if (!Array.isArray(keywords) || keywords.length === 0) return false;
    const need = keywords.length === 1 ? 1 : Math.ceil(keywords.length / 2);
    let matches = 0;
    for (const k of keywords) {
      if (combinedText.includes(k)) matches++;
      if (matches >= need) return true;
    }
    return false;
  }

  /**
   * Stricter variant for MUST-LAND anecdotes: EVERY keyword stem must appear
   * as a substring of the combined story text. Used for funny_thing /
   * meaningful_moment / moms_favorite_moment / dads_favorite_moment /
   * favorite_object where a single keyword match is not enough to say the
   * anecdote actually made it into the story. Euphemism / synonym handling
   * is left to the LLM-based checkCustomDetailsUsage check; this stays
   * strictly literal so it is both deterministic and content-agnostic.
   */
  static _allLanded(keywords, combinedText) {
    if (!Array.isArray(keywords) || keywords.length === 0) return false;
    for (const k of keywords) {
      if (!combinedText.includes(k)) return false;
    }
    return true;
  }

  /**
   * Deterministic check for overuse of the parent's real first name.
   *
   * Picture books address the parent by relationship ("Mama", "Dad") almost
   * everywhere. The questionnaire's mom_name/dad_name is meant to surface
   * AT MOST ONCE — typically at the dedication beat. When the writer sprays
   * the real name across 5+ spreads it makes the book feel like a draft
   * memo, not a children's book, so we penalize heavily.
   *
   * Score map (per name, then combined as min):
   *   0 or 1 mention:  10  (correct restraint)
   *   2 mentions:       6  (soft failure)
   *   3 mentions:       3  (hard failure — forces revision)
   *   4+ mentions:      1
   *
   * Skipped entirely when:
   *   - neither mom_name nor dad_name is supplied
   *   - the real name happens to equal the child's address word (the
   *     family uses the first name as the address word — don't double-count)
   */
  static _scoreNameDiscipline(spreads, book, child) {
    const combinedText = spreads.map(s => (s.text || '')).join(' \n ').toLowerCase();
    const names = [];
    const momName = (book?.mom_name || child?.anecdotes?.mom_name || '').toString().trim();
    const dadName = (book?.dad_name || child?.anecdotes?.dad_name || '').toString().trim();
    const momAddress = (child?.anecdotes?.calls_mom || '').toString().trim().toLowerCase();
    const dadAddress = (child?.anecdotes?.calls_dad || '').toString().trim().toLowerCase();
    if (momName && momName.toLowerCase() !== momAddress) names.push({ role: 'mom', name: momName });
    if (dadName && dadName.toLowerCase() !== dadAddress) names.push({ role: 'dad', name: dadName });

    if (names.length === 0) return { score: 10, details: [], skipped: true };

    const details = [];
    let worstScore = 10;
    for (const { role, name } of names) {
      const first = name.split(/\s+/)[0];
      if (!first || first.length < 2) continue;
      const pattern = new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      const matches = combinedText.match(pattern) || [];
      const count = matches.length;
      let nameScore;
      if (count <= 1) nameScore = 10;
      else if (count === 2) nameScore = 6;
      else if (count === 3) nameScore = 3;
      else nameScore = 1;
      if (nameScore < worstScore) worstScore = nameScore;
      details.push({ role, name: first, count, score: nameScore });
    }
    return { score: worstScore, details };
  }

  /**
   * Pull 1-3 meaningful keywords from an anecdote value for substring matching.
   * "pancakes with blueberries" -> ["pancake", "blueberr"]
   * "sings to the cat" -> ["sing", "cat"]
   */
  static _extractKeywords(value, excludeTokens = new Set()) {
    const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'is', 'are', 'was', 'be', 'her', 'his', 'their', 'my', 'our', 'your', 'me', 'we', 'they', 'he', 'she', 'it', 'that', 'this', 'these', 'those', 'when', 'where', 'how', 'what', 'why', 'very', 'really', 'loves', 'love', 'like', 'likes', 'always', 'every', 'just', 'from', 'about', 'into', 'over', 'under', 'has', 'have', 'had', 'so', 'then']);
    const tokens = value
      .toLowerCase()
      .replace(/[^a-z0-9'\- ]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    const out = [];
    for (const t of tokens) {
      if (t.length < 4) continue;
      if (STOP.has(t)) continue;
      if (excludeTokens && excludeTokens.has(t)) continue;
      // Trim plural + common endings so "pancakes" matches "pancake"
      let stem = t;
      if (stem.endsWith('ies') && stem.length > 4) stem = stem.slice(0, -3) + 'i';
      else if (stem.endsWith('es') && stem.length > 4) stem = stem.slice(0, -2);
      else if (stem.endsWith('s') && stem.length > 4) stem = stem.slice(0, -1);
      else if (stem.endsWith('ing') && stem.length > 5) stem = stem.slice(0, -3);
      if (excludeTokens && excludeTokens.has(stem)) continue;
      if (!out.includes(stem)) out.push(stem);
      if (out.length >= 3) break;
    }
    return out;
  }

  /**
   * Score whether the ending is appropriate for the theme.
   * Penalizes bedtime/sleep endings on non-bedtime themes.
   */
  static _scoreEndingAppropriateness(spreads, theme) {
    if (theme === 'bedtime') return 10;

    const BEDTIME_PATTERNS = /\b(sleep|asleep|slept|sleeping|dream|dreaming|dreamt|goodnight|good\s*night|nighttime|tucked?\s*in|closed?\s*(her|his|their)\s*eyes?\s*(to\s*sleep)?|drifted?\s*off|pillow|pajama|blanket\s*(pulled|tucked)|yawn|drowsy|slumber|lullaby|moonlight|starlight|moon\s*(rose|shone|glowed))\b/i;

    const lastSpreads = spreads.slice(-3);
    let hits = 0;
    for (const s of lastSpreads) {
      const text = s.text || '';
      const matches = text.match(new RegExp(BEDTIME_PATTERNS.source, 'gi'));
      if (matches) hits += matches.length;
    }

    if (hits >= 3) return 2;
    if (hits === 2) return 4;
    if (hits === 1) return 6;
    return 10;
  }

  /**
   * Score rhyme-word variety deterministically.
   * Penalizes stories where one end-rhyme sound dominates too many spreads.
   */
  static _scoreRhymeVariety(spreads) {
    const endWords = [];
    for (const s of spreads) {
      const text = (s.text || '').trim();
      if (!text) continue;
      const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const words = line.replace(/[.,!?;:"']+$/g, '').split(/\s+/);
        if (words.length > 0) endWords.push(words[words.length - 1].toLowerCase());
      }
    }
    if (endWords.length === 0) return 7;

    // Group by approximate rhyme sound (last 3 chars as simple heuristic)
    const rhymeBuckets = {};
    for (const w of endWords) {
      const suffix = w.length >= 3 ? w.slice(-3) : w;
      rhymeBuckets[suffix] = (rhymeBuckets[suffix] || 0) + 1;
    }

    const maxRepeats = Math.max(...Object.values(rhymeBuckets));
    const totalLines = endWords.length;
    const ratio = maxRepeats / totalLines;

    // If one rhyme sound appears in >30% of all lines, that's a problem
    if (ratio > 0.4) return 3;
    if (ratio > 0.3) return 5;
    if (ratio > 0.25) return 6;
    if (ratio > 0.2) return 7;
    return 9;
  }

  /**
   * Score word count compliance deterministically.
   */
  static _scoreWordCount(spreads, age, ageTier) {
    const tierName = ageTier || 'picture-book';
    const tier = WRITER_CONFIG.ageTiers[tierName];
    if (!tier) return 7;

    const totalWords = spreads.reduce((sum, s) => sum + (s.text || '').split(/\s+/).length, 0);

    // Total word count check
    let score = 10;
    if (totalWords > tier.maxWords * 1.3) score -= 4;
    else if (totalWords > tier.maxWords * 1.1) score -= 2;
    else if (totalWords > tier.maxWords) score -= 1;

    // Too few words is also a problem
    if (totalWords === 0) score = 1;
    else if (totalWords < tier.maxWords * 0.15) score -= 5;
    else if (totalWords < tier.maxWords * 0.3) score -= 3;

    // Per-spread check
    let oversizedSpreads = 0;
    for (const s of spreads) {
      const words = (s.text || '').split(/\s+/).length;
      if (words > tier.wordsPerSpread.max * 1.5) oversizedSpreads++;
    }
    score -= oversizedSpreads;

    return Math.max(1, Math.min(10, score));
  }

  /**
   * Run LLM-based quality checks in a single call for efficiency.
   */
  static async _runLLMChecks(spreads, child, book) {
    const storyText = spreads.map(s => `Spread ${s.spread}: ${s.text}`).join('\n\n');

    const isCelebration = ['mothers_day', 'fathers_day', 'birthday', 'birthday_magic'].includes(book.theme);
    const isBedtime = book.theme === 'bedtime';
    const arcDescription = isCelebration
      ? 'Does it build from specific activities to emotional connection to a joyful, warm climax? The closing should be the WARMEST spread — full of love and energy, NOT quiet, NOT sleepy, NOT bedtime.'
      : isBedtime
        ? 'Does it build toward a gentle, cozy bedtime? The arc should feel soothing and safe.'
        : 'Does it build from specific activities to emotional deepening to a satisfying climax? Is the closing warm and connected?';
    const bedtimePenalty = isBedtime ? '' : ' IMPORTANT: Unless the theme is "bedtime," the story must NOT end with the child going to sleep, falling asleep, being tucked in, dreaming, or any goodnight/nighttime imagery. Penalize heavily (score 1-4) if the last 2-3 spreads drift into bedtime/sleep when the theme is not bedtime.';

    const systemPrompt = `You are a professional children's book editor and quality assessor. Score the following story on these dimensions, each from 1-10:

1. RHYME: Do the couplets actually rhyme? Is the meter consistent (iambic tetrameter for ages 3+)? Does the rhythm feel natural or forced? Score 1 if rhymes are broken/forced, 10 if every couplet rhymes naturally.

2. AGE_APPROPRIATENESS: Is the vocabulary appropriate for age ${child.age}? Are sentences the right length? Would a child this age understand and enjoy this?${child.age <= 3 ? ' FOR AGES 0-3: Penalize heavily (score 1-4) if ANY spread contains words over 2 syllables (except proper names), abstract imagery, metaphors requiring interpretation, or more than 4 lines. Every word should be one a toddler hears daily. If the text feels like it was written for a 5-year-old, score 1-3.' : ''}

3. READ_ALOUD: Would this sound good read aloud by a parent? Is it easy and fun to read on the first try? Would a parent stumble on any word or phrasing? Penalize heavily (score 1-4) if the writing feels literary, overly poetic, or uses vocabulary that would make a parent pause to think about pronunciation or meaning. The writing should feel like Dr. Seuss or Julia Donaldson — clever and simple, not like adult poetry.

4. EMOTIONAL_ARC: Does the story have emotional progression? ${arcDescription}${isCelebration ? ' Penalize if the story contains tantrums, crying, frustration, anger, bedtime, sleep, or goodnight imagery.' : ''}${bedtimePenalty}

5. SPECIFICITY: Are there concrete, specific nouns (not vague categories)? Do emotions emerge from actions rather than declarations? Is there at least one surprise per spread? Would any line work in a greeting card? (if yes, that's bad)

6. CREATIVITY: Does the story contain at least one imaginative leap or metaphor (the child transforms the ordinary into something magical)? Does the refrain deepen in meaning across repetitions rather than just repeating? Are there unexpected images or rhyme pairs? Score 1-4 if multiple spreads describe essentially the same activity (e.g., sharing food 3 times, or multiple "snack" scenes). Score 1 if the story reads like a flat documentary of activities, 10 if it surprises and delights.

7. VARIETY: Count how many DISTINCT activities, settings, or scenes appear across all spreads. Each spread should feel like a different moment — reading, cooking, playing outside, bath time, drawing, etc. Score 1-3 if more than 3 spreads describe the same core activity (e.g., giving food to someone repeatedly). Score 4-5 if 3 spreads repeat an activity. Score 6-7 if there is moderate variety but some repetition. Score 8-10 if every spread covers a genuinely different scene or activity.

8. NARRATIVE_COHERENCE: Does the story have a clear through-line that connects all spreads? Can a 3-year-old follow the sequence? The story must follow a single clear arc with 2-4 distinct settings across the 13 spreads. Home is fine as ONE of those settings but NOT as the default for 8+ spreads. Score 1-3 if it reads as a random slideshow of unrelated activities with no connecting thread, OR if 8+ spreads sit in the same location (e.g., everything at home / at the kitchen table) so the book feels monotonous. Score 4-5 if there are some transitions but spreads still feel disconnected (sudden jumps between unrelated places). Score 6-7 if the narrative mostly flows but has 1-2 jarring jumps OR the settings are less varied than the theme allows. Score 8-10 if every spread connects naturally to the next, the reader always knows WHERE the characters are, and the book uses 2-4 distinct settings that serve the story.

Return a JSON object:
{
  "rhyme": <score 1-10>,
  "ageAppropriateness": <score 1-10>,
  "readAloud": <score 1-10>,
  "emotionalArc": <score 1-10>,
  "specificity": <score 1-10>,
  "creativity": <score 1-10>,
  "variety": <score 1-10>,
  "narrativeCoherence": <score 1-10>,
  "notes": "brief notes on the biggest issues"
}`;

    const userPrompt = `Story for ${child.name} (age ${child.age}, ${child.gender || 'not specified'}), theme: ${book.theme}\n\n${storyText}`;

    const result = await _llmCaller.callLLM('critic', systemPrompt, userPrompt, {
      jsonMode: true,
      maxTokens: 1000,
    });

    try {
      const parsed = JSON.parse(result.text);
      return {
        rhyme: Math.max(1, Math.min(10, parsed.rhyme || 7)),
        ageAppropriateness: Math.max(1, Math.min(10, parsed.ageAppropriateness || 7)),
        readAloud: Math.max(1, Math.min(10, parsed.readAloud || 7)),
        emotionalArc: Math.max(1, Math.min(10, parsed.emotionalArc || 7)),
        specificity: Math.max(1, Math.min(10, parsed.specificity || 7)),
        creativity: Math.max(1, Math.min(10, parsed.creativity || 7)),
        variety: Math.max(1, Math.min(10, parsed.variety || 7)),
        narrativeCoherence: Math.max(1, Math.min(10, parsed.narrativeCoherence || 7)),
        _notes: parsed.notes || '',
      };
    } catch (err) {
      console.warn(`[writerV2] Could not parse LLM quality scores: ${err.message}`);
      return {};
    }
  }

  /**
   * Build specific revision feedback from scores.
   */
  static _buildFeedback(scores, spreads, meta = {}, hardRules = {}) {
    const feedback = [];
    const { passScore, minDimensionScore } = WRITER_CONFIG.qualityThresholds;

    // Hard rules come first so the revision loop can't miss them even if
    // the model ignores later bullets.
    if (hardRules.funnyThingMiss) {
      feedback.push(`FUNNY_THING: The questionnaire's "funny thing" ("${hardRules.funnyThingMiss}") must appear somewhere in spreads 3-11, translated into picture-book prose (concrete action, not an abstract reference). Never put it in spread 13 — the ending must be warm, not a punchline. This is non-negotiable for personalization.`);
    }
    if (Array.isArray(hardRules.missingCritical) && hardRules.missingCritical.length > 0) {
      feedback.push(`CUSTOM DETAILS MISSING (critical): ${hardRules.missingCritical.join(', ')}. Rewrite the affected spreads to name these details naturally. Do NOT replace them with generic stand-ins, and do NOT invent new details that contradict the questionnaire answers.`);
    }
    if (Array.isArray(hardRules.criticalFailures) && hardRules.criticalFailures.length > 0) {
      const lines = hardRules.criticalFailures
        .map(f => `  - ${f.dimension} scored ${f.score}/10 (required: ${f.floor}+)`)
        .join('\n');
      feedback.push(`CRITICAL DIMENSIONS BELOW FLOOR — these are must-pass for shipping, low scores alone force a revision:\n${lines}\nRewrite aggressively to bring each one over its floor. The specific feedback for each dimension follows below.`);
    }
    if (typeof hardRules.overallScore === 'number' && hardRules.overallScore < passScore) {
      feedback.push(`OVERALL QUALITY: Weighted score is ${Math.round(hardRules.overallScore * 10) / 10}/10 — below the ${passScore} pass threshold. The book is "okay" but not shippable. Treat this revision as a full polish pass: sharpen imagery, tighten rhymes, fix any spread that feels like a placeholder or a paraphrase of the questionnaire rather than a real beat in a real story.`);
    }

    if (scores.rhyme < minDimensionScore) {
      feedback.push('RHYME: Several couplets do not rhyme or have broken meter. Rewrite lines where rhymes are forced, near-rhymes are presented as true rhymes, or the stress pattern is inconsistent. Every line pair must have a natural, satisfying end-rhyme.');
    } else if (scores.rhyme < 7) {
      feedback.push('RHYME: Some rhymes feel forced or the meter breaks in places. Smooth out the rhythm — every line should scan naturally in iambic tetrameter.');
    }

    if (scores.ageAppropriateness < minDimensionScore) {
      feedback.push('AGE: Vocabulary or sentence complexity is wrong for this age. Simplify language, shorten sentences, and use words a child this age hears daily.');
    }

    if (scores.pronouns < minDimensionScore) {
      feedback.push('PRONOUNS: Wrong pronouns detected. Check every pronoun reference to the child and fix any gender mismatches.');
    }

    if (scores.readAloud < minDimensionScore) {
      feedback.push('READ-ALOUD: The text would cause a parent to stumble when reading aloud. Fix awkward phrasing, inverted word order, and tongue-twister constructions.');
    } else if (scores.readAloud < 7) {
      feedback.push('READ-ALOUD: Some lines feel flat or monotonous. Add rhythm variation — mix short punchy lines with flowing ones.');
    }

    if (scores.emotionalArc < minDimensionScore) {
      feedback.push('EMOTIONAL ARC: The story lacks emotional progression. It should build from specific activities to emotional connection and wonder, reach a warm climax, then close with a joyful echo of the opening. For celebration themes, the ending should be warm and full of energy — NOT quiet, NOT sleepy.');
    }

    if (scores.specificity < minDimensionScore) {
      feedback.push('SPECIFICITY: Too many abstract declarations and not enough concrete actions. Replace "she loved you" with specific actions. Replace generic nouns with specific ones. Remove any line that could appear in a greeting card.');
    } else if (scores.specificity < 7) {
      feedback.push('SPECIFICITY: Some spreads rely on declarations rather than actions. Add more concrete, specific nouns and show love through what the mother DOES, not what she FEELS.');
    }

    if (scores.creativity < minDimensionScore) {
      feedback.push('CREATIVITY: The story reads as a flat list of activities without imaginative surprise. Add at least one moment where the child transforms something ordinary into something magical. The refrain should deepen in meaning, not just repeat. Find fresher rhyme pairs and unexpected images.');
    } else if (scores.creativity < 7) {
      feedback.push('CREATIVITY: The story could use more imaginative leaps. Add a moment of whimsy — the child\'s imagination transforming the ordinary. Vary the refrain\'s context so it lands differently each time.');
    }

    if (scores.variety < minDimensionScore) {
      feedback.push('VARIETY: Multiple spreads describe the same activity or scene. Each spread must cover a DISTINCT moment — different action, different setting, or different emotional beat. Replace repeated scenes (e.g., sharing food multiple times) with varied activities like reading, playing outside, cooking, drawing, bath time, dancing, exploring, building, etc.');
    } else if (scores.variety < 7) {
      feedback.push('VARIETY: Some spreads feel repetitive — they describe similar activities or settings. Diversify the scenes so each spread feels like a fresh, distinct moment in the story.');
    }

    if (scores.endingAppropriateness < minDimensionScore) {
      feedback.push('ENDING: The story ends with bedtime/sleep imagery (sleeping, dreaming, goodnight, tucking in, etc.) but this is NOT a bedtime-themed book. The ending MUST show the characters awake, warm, and together. Rewrite the last 2-3 spreads to end in daylight or at least fully awake — with togetherness, joy, and energy. No sleeping, no dreaming, no goodnights.');
    } else if (scores.endingAppropriateness < 7) {
      feedback.push('ENDING: The story drifts toward sleep/bedtime imagery at the end. Unless this is a bedtime book, keep the ending awake and warm. Remove references to sleep, dreams, or nighttime.');
    }

    if (scores.rhymeVariety < minDimensionScore) {
      feedback.push('RHYME VARIETY: One rhyme sound dominates too many spreads (e.g., "here/clear/cheer/near" appearing in 5+ spreads). Each spread MUST use a different end-rhyme pair. The refrain should appear exactly 3 times. All other spreads need their own fresh rhyme sounds. Rewrite non-refrain spreads to end with completely different rhyme pairs.');
    } else if (scores.rhymeVariety < 7) {
      feedback.push('RHYME VARIETY: Some rhyme sounds repeat across too many spreads. Diversify your end-rhymes — if the refrain uses one sound, make sure other spreads explore different rhyme pairs.');
    }

    if (scores.narrativeCoherence < minDimensionScore) {
      feedback.push('NARRATIVE COHERENCE: The story reads as a disconnected slideshow of activities OR 8+ spreads sit in the same location. It MUST follow ONE clear through-line across 2-4 distinct settings. Home is allowed as ONE setting but NOT as the default for every spread. When the characters change location, show the transition so the reader always knows WHERE they are. Consecutive spreads within the same scene should share the same location; scene changes should be visible in the text.');
    } else if (scores.narrativeCoherence < 7) {
      feedback.push('NARRATIVE COHERENCE: Some spreads feel disconnected from the narrative flow. Make sure every transition is clear — the reader should never wonder "wait, where are we now?" or "how did we get here?" Strengthen the scene-to-scene transitions.');
    }

    if (scores.settingVariety < minDimensionScore) {
      const mv = meta.settingVariety || {};
      const homeLine = mv.atHome >= 8 ? ` Roughly ${mv.atHome}/${spreads.length} spreads read as "at home" — that's too many.` : '';
      feedback.push(`SETTING VARIETY: The book feels like it stays in one place the whole time.${homeLine} Rewrite so that the 13 spreads span 2-4 distinct physical settings (at least one should not be the home/kitchen/bedroom). Use the theme and the child's real activities to pick locations (e.g. the park, the bakery, the beach, the grandparents' garden, the local cafe). Every spread's text should make the setting visible.`);
    } else if (scores.settingVariety < 7) {
      feedback.push('SETTING VARIETY: Too many spreads live at home. Add at least one more distinct location so the book does not feel monotonous. Make the change of place clear in the spread text.');
    }

    if (scores.anecdoteUsage < minDimensionScore) {
      const au = meta.anecdoteUsage || {};
      const missStr = (au.misses || []).slice(0, 6).map(m => `- ${m}`).join('\n');
      feedback.push(`ANECDOTE USAGE: The book is not using the real questionnaire details that make this child unique. These specific details MUST appear concretely (as a named object, action, place, food, or person) somewhere in the story:\n${missStr}\nRewrite affected spreads to name these details naturally — do NOT replace them with generic stand-ins.`);
    } else if (scores.anecdoteUsage < 7) {
      const au = meta.anecdoteUsage || {};
      const missStr = (au.misses || []).slice(0, 4).map(m => `- ${m}`).join('\n');
      if (missStr) {
        feedback.push(`ANECDOTE USAGE: A few anecdotes from the questionnaire did not make it into the story:\n${missStr}\nFold them into the relevant spreads so the book feels personally woven for this child.`);
      }
    }

    if (scores.wordCount < minDimensionScore) {
      const totalWords = spreads.reduce((sum, s) => sum + (s.text || '').split(/\s+/).length, 0);
      feedback.push(`WORD COUNT: Total is ${totalWords} words — outside the target range. Trim or expand to fit the age tier limits.`);
    }

    if (typeof scores.nameDiscipline === 'number' && scores.nameDiscipline < 10) {
      const nd = meta.nameDiscipline || {};
      const overuses = (nd.details || []).filter(d => d.count >= 2);
      if (overuses.length > 0) {
        const lines = overuses
          .map(d => `  - ${d.name} appears ${d.count} times (allowed: 0-1)`)
          .join('\n');
        feedback.push(`PARENT NAME DISCIPLINE: The parent's real first name is used too many times. Picture-book voice calls the parent by their relationship ("Mama", "Mom", "Dad") everywhere; the real name should appear AT MOST ONCE — typically in a warm dedication-style beat.\n${lines}\nRewrite so every other mention uses the address word (Mama/Dad). Keep one meaningful use, or remove the name entirely if it never fit naturally.`);
      }
    }

    return feedback.join('\n\n');
  }
}

module.exports = { QualityGate };
