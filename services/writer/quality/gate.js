/**
 * QualityGate — **deterministic** checks only (hard rules). An optional
 * small LLM pass may append **advisory** notes for the reviser; it never
 * blocks shipping and does not produce scores.
 *
 * There is **no** numeric score rubric or “location progression” reward —
 * `_collectSceneContinuityIssues` only verifies that each spread’s SCENE
 * prose **names** the palette `location` string locked from the plan (substring
 * / token heuristic) so illustrator prompts stay anchored. **Reusing** the
 * same location across many spreads does not veto a pass by itself.
 *
 * Hard checks: possessive-pronoun regex, identical-word rhyme lint,
 * overlong words (ages 0–3), scene–palette substring continuity when beats
 * carry `location`, and thin-brief bans on mascot personified‑light quest
 * spines (`mothers_day` / `fathers_day`) matched by heuristic when the
 * questionnaire did not invite light‑fantasy language.
 */

const { BaseThemeWriter } = require('../themes/base');
const { findPossessivePronounErrors } = require('../../pronouns');
const { findIdenticalAdjacentEndWordRhymes, findOverlongWordsForYoungReader } = require('./rhymeLint');
const {
  plannerLightMothBriefOptIn,
  detectParentGiftPersonifiedLightMotifInStory,
  plannerOptInDetailBlob,
} = require('../questMotifGuards');

const PARENT_GIFT_LIGHT_MOTIF_THEMES = new Set(['mothers_day', 'fathers_day']);

const _llm = new BaseThemeWriter('_quality_gate');

const ADVISORY_ATTEMPTS = 2;
const ADVISORY_MAX_TOKENS = 2000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * @param {string} raw
 * @returns {string}
 */
function parseAdvisorySuggestions(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const parsed = JSON.parse(s);
  if (!parsed || typeof parsed !== 'object') return '';
  return typeof parsed.suggestions === 'string' ? parsed.suggestions.trim() : '';
}

class QualityGate {
  /**
   * Run deterministic checks; optionally fetch advisory notes for the reviser.
   *
   * @param {object} story - { spreads: [{ spread, text, scene? }] }
   * @param {object} child
   * @param {object} book
   * @param {object} [opts] - { plan, bookId }
   * @returns {Promise<{pass, overallScore, scores, feedback, issues, criticFailed, llmPass, numericPass, deterministicVetoes, advisoryNotes?}>}
   */
  static async check(story, child, book, opts = {}) {
    const spreads = Array.isArray(story?.spreads) ? story.spreads : [];
    if (spreads.length === 0) {
      return {
        pass: false,
        overallScore: null,
        scores: {},
        issues: [{ dimension: 'catastrophic', note: 'Story has 0 spreads.' }],
        feedback: 'CATASTROPHIC: Story has 0 spreads. The writer produced no output.',
        criticFailed: false,
        llmPass: true,
        numericPass: true,
        advisoryNotes: '',
        deterministicVetoes: {
          possessive: false,
          rhymeLint: false,
          longWords: false,
          sceneContinuity: false,
          questMotifPersonifiedLight: false,
        },
      };
    }

    const issues = [];
    const possessiveErrors = [];
    for (const s of spreads) {
      const errs = findPossessivePronounErrors(s?.text || '');
      for (const e of errs) possessiveErrors.push({ spread: s.spread, ...e });
    }

    const rhymeLintIssues = findIdenticalAdjacentEndWordRhymes(spreads);
    const childAge = Number(child?.age);
    const readAloudLongWords = Number.isFinite(childAge) && childAge <= 3
      ? findOverlongWordsForYoungReader(spreads, child?.name)
      : [];

    const sceneContinuityIssues = QualityGate._collectSceneContinuityIssues(spreads, opts?.plan);

    const themeKey = String(book?.theme || '').toLowerCase();
    const customBlob = plannerOptInDetailBlob(book || {});
    const lightMotifOptIn = plannerLightMothBriefOptIn(child || {}, customBlob);
    let personifiedLightMotifIssues = [];
    if (PARENT_GIFT_LIGHT_MOTIF_THEMES.has(themeKey) && !lightMotifOptIn) {
      const storyBlob = spreads.map(s => [s?.text || '', s?.scene || ''].join('\n')).join('\n');
      if (detectParentGiftPersonifiedLightMotifInStory(storyBlob)) {
        personifiedLightMotifIssues.push({
          spread: spreads[0]?.spread ?? 1,
          note:
            'Default personified-light / mascot gleam spine detected (e.g. Mr/Mrs Light, gleam that blinks awake, token wake-the-beam climax) — questionnaire/custom text did NOT invite light fantasy. Rewrite TEXT (and aligned SCENE) so the spine is earthbound — hobbies, errands, tactile objects, quirky sports or food stakes — or drop anthropomorphic Glow/Light names entirely.',
        });
      }
    }

    for (const p of personifiedLightMotifIssues) {
      issues.push({ dimension: 'questMotif', spread: p.spread, note: p.note });
    }

    for (const sc of sceneContinuityIssues) {
      issues.push({ dimension: 'sceneContinuity', spread: sc.spread, note: sc.note });
    }
    for (const e of possessiveErrors) {
      issues.push({
        dimension: 'pronouns',
        spread: e.spread,
        note: `Object pronoun used as possessive: "${e.match}" — write "his ${e.noun}" (possessive), not "${e.pronoun} ${e.noun}".`,
      });
    }
    for (const r of rhymeLintIssues) {
      issues.push({ dimension: 'rhyme', spread: r.spread, note: r.note });
    }
    for (const r of readAloudLongWords) {
      issues.push({ dimension: 'readAloud', spread: r.spread, note: r.note });
    }

    let feedback = '';
    if (possessiveErrors.length > 0) {
      const errorLines = possessiveErrors
        .map(e => `  - Spread ${e.spread}: "${e.match}" → use "his ${e.noun}" (…${e.context.trim()}…)`)
        .join('\n');
      feedback =
        'Fix object pronoun used in possessive position:\n' + errorLines;
    }
    if (rhymeLintIssues.length > 0) {
      const rhymeLines = rhymeLintIssues.map(r => `  - Spread ${r.spread}: ${r.note}`).join('\n');
      const block = 'Identical final word in an adjacent couplet (not a real rhyme). Rewrite so couplets use different final words:\n' + rhymeLines;
      feedback = feedback ? `${feedback}\n\n${block}` : block;
    }
    if (readAloudLongWords.length > 0) {
      const rwLines = readAloudLongWords.map(r => `  - Spread ${r.spread}: ${r.note}`).join('\n');
      const rwBlock = 'Overlong word(s) for ages 0–3 (read-aloud rhythm):\n' + rwLines;
      feedback = feedback ? `${feedback}\n\n${rwBlock}` : rwBlock;
    }
    if (sceneContinuityIssues.length > 0) {
      feedback = feedback
        ? `${feedback}\n\n${QualityGate._sceneContinuityFeedbackBlock(sceneContinuityIssues)}`
        : QualityGate._sceneContinuityFeedbackBlock(sceneContinuityIssues);
    }
    if (personifiedLightMotifIssues.length > 0) {
      const motifBlock =
        `Personified-light / mascot gleam cliché detected on a parent‑gift theme — rewrite spreads to strip Mr/Mrs Light–style mascots or beam‑that‑wakens spines unless the questionnaire invited light fantasy:\n${personifiedLightMotifIssues.map(p => `  - Spread ${p.spread}: ${p.note}`).join('\n')}`;
      feedback = feedback ? `${feedback}\n\n${motifBlock}` : motifBlock;
    }

    const pass = possessiveErrors.length === 0
      && rhymeLintIssues.length === 0
      && readAloudLongWords.length === 0
      && sceneContinuityIssues.length === 0
      && personifiedLightMotifIssues.length === 0;

    let advisoryNotes = '';
    if (!pass) {
      advisoryNotes = await QualityGate._tryAdvisoryNotes(story, child, book, opts);
      if (advisoryNotes) {
        feedback = feedback
          ? `${feedback}\n\n---\nOptional editor ideas (non-blocking; apply only if helpful):\n${advisoryNotes}`
          : `Optional editor ideas (non-blocking):\n${advisoryNotes}`;
      }
    }

    const deterministicVetoes = {
      possessive: possessiveErrors.length > 0,
      rhymeLint: rhymeLintIssues.length > 0,
      longWords: readAloudLongWords.length > 0,
      sceneContinuity: sceneContinuityIssues.length > 0,
      questMotifPersonifiedLight: personifiedLightMotifIssues.length > 0,
    };

    console.log(`[writerV2] qualityGate:`, {
      bookId: opts.bookId || 'n/a',
      pass,
      deterministicVetoes,
      advisoryLen: (advisoryNotes || '').length,
    });

    return {
      pass,
      overallScore: null,
      scores: {},
      issues,
      feedback: pass ? '' : feedback,
      criticFailed: false,
      llmPass: true,
      numericPass: true,
      advisoryNotes,
      deterministicVetoes,
    };
  }

  /**
   * Short advisory JSON — never used for gating.
   * @param {object} story
   * @param {object} child
   * @param {object} book
   * @param {object} opts
   * @returns {Promise<string>}
   */
  static async _tryAdvisoryNotes(story, child, book, opts) {
    const system = [
      'You are a children\'s picture-book editor. Return ONLY a JSON object: {"suggestions":"<string>"}.',
      'suggestions: 2–5 sentences of optional polish (imagery, rhythm, illustration potential).',
      'Do not assign scores. Do not use words like "pass", "fail", "ship", or "grade".',
      'These notes are non-blocking suggestions for a reviser; they are not requirements.',
    ].join(' ');

    const user = QualityGate._buildAdvisoryUserBody(story, child, book, opts);
    for (let attempt = 0; attempt < ADVISORY_ATTEMPTS; attempt++) {
      try {
        const result = await _llm.callLLM('critic', system, user, {
          jsonMode: true,
          maxTokens: ADVISORY_MAX_TOKENS,
        });
        return parseAdvisorySuggestions(result.text);
      } catch (err) {
        console.warn(`[writerV2] advisory notes attempt ${attempt + 1}/${ADVISORY_ATTEMPTS} failed: ${err.message}`);
        if (attempt < ADVISORY_ATTEMPTS - 1) await sleep(300 * (attempt + 1));
      }
    }
    return '';
  }

  static _buildAdvisoryUserBody(story, child, book, opts) {
    const spreads = story.spreads || [];
    const plan = opts?.plan || null;
    const storySeed = plan?.storySeed || null;
    const anecdotesBlock = QualityGate._formatAnecdotes(child?.anecdotes || {});
    const customDetails = (book?.customDetails || '').toString().trim();
    const parts = [];
    parts.push(`Theme: ${book?.theme || 'general'}`);
    parts.push(`Child: ${child?.name || '(unknown)'} (age ${child?.age ?? 'unspecified'})`);
    if (anecdotesBlock) {
      parts.push('Questionnaire notes:\n' + anecdotesBlock);
    }
    if (customDetails) parts.push('Custom details: ' + customDetails);
    if (storySeed && typeof storySeed === 'object') {
      const spine = (storySeed.narrative_spine || storySeed.storySeed || '').toString().trim();
      if (spine) parts.push('Story spine: ' + spine);
    }
    parts.push('Story text:');
    for (const s of spreads) {
      parts.push(`Spread ${s.spread}: ${(s.text || '').trim()}`);
    }
    return parts.join('\n');
  }

  static _formatAnecdotes(a) {
    const LABELS = {
      favorite_activities: 'Favorite activities',
      funny_thing: 'Funny thing they do',
      meaningful_moment: 'Meaningful moment',
      favorite_food: 'Favorite food',
      favorite_toys: 'Favorite toys',
      other_detail: 'Other detail',
      anything_else: 'Additional',
    };
    const lines = [];
    for (const [key, label] of Object.entries(LABELS)) {
      const v = a[key];
      if (typeof v === 'string' && v.trim()) lines.push(`- ${label}: ${v.trim()}`);
    }
    return lines.join('\n');
  }

  /**
   * SCENE paragraphs must visibly reference each spread’s planner-assigned
   * palette `location` label — **not** a judgment on narrative variety or
   * how often locations repeat.
   * @param {Array<object>} spreads
   * @param {object|null} plan
   * @returns {Array<{ spread: number, note: string }>}
   */
  static _collectSceneContinuityIssues(spreads, plan) {
    const beats = plan && Array.isArray(plan.beats) ? plan.beats : [];
    if (beats.length === 0) return [];
    const locByBeat = new Map();
    for (const b of beats) {
      if (b && typeof b.location === 'string' && b.location.trim()) {
        locByBeat.set(Number(b.spread), b.location.trim());
      }
    }
    if (locByBeat.size === 0) return [];
    const issues = [];
    for (const s of spreads) {
      const location = locByBeat.get(Number(s?.spread));
      if (!location) continue;
      const scene = typeof s.scene === 'string' ? s.scene : '';
      if (!scene.trim()) {
        issues.push({
          spread: s.spread,
          note: `SCENE block is missing — the illustrator needs a SCENE paragraph that names "${location}" and matches the TEXT.`,
        });
        continue;
      }
      if (!QualityGate._sceneNamesLocation(scene, location)) {
        issues.push({
          spread: s.spread,
          note: `SCENE does not name the assigned palette location "${location}". Rewrite the SCENE so it explicitly takes place at "${location}" (the illustrator reuses this paragraph verbatim — if it does not name the place, continuity breaks).`,
        });
      }
    }
    return issues;
  }

  static _sceneNamesLocation(scene, location) {
    const sLower = scene.toLowerCase();
    const locLower = location.toLowerCase();
    if (sLower.includes(locLower)) return true;
    const stop = new Set([
      'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'over', 'under',
      'near', 'behind', 'where', 'when', 'that', 'this', 'there',
      'a', 'an', 'of', 'in', 'on', 'at', 'to', 'by',
    ]);
    const tokens = locLower
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 4 && !stop.has(t));
    if (tokens.length === 0) return false;
    const matched = tokens.filter(t => sLower.includes(t));
    if (tokens.length === 1) return matched.length === 1;
    return matched.length >= 2;
  }

  static _sceneContinuityFeedbackBlock(issues) {
    const lines = issues.map(i => `  - Spread ${i.spread}: ${i.note}`);
    return [
      'SCENE CONTINUITY — rewrite the SCENE blocks below so each one names the assigned palette location and matches its TEXT. The illustrator uses the SCENE verbatim as its prompt; when the SCENE does not name the locked location, every downstream spread drifts visually.',
      ...lines,
    ].join('\n');
  }
}

module.exports = { QualityGate };
