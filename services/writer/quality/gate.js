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
 * carry `location`, refrain placement (3x with one in spreads 10–13, not
 * back-to-back), opening-location ban-list (spread 1 must not read as a
 * mundane home/park/playground default), and SCENE block length floor.
 */

const { BaseThemeWriter } = require('../themes/base');
const { findPossessivePronounErrors } = require('../../pronouns');
const { findIdenticalAdjacentEndWordRhymes, findOverlongWordsForYoungReader } = require('./rhymeLint');

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
          refrain: false,
          openingLocation: false,
          sceneLength: false,
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
    const refrainIssues = QualityGate._collectRefrainIssues(spreads, opts?.plan);
    const openingLocationIssues = QualityGate._collectOpeningLocationIssues(spreads, opts?.plan, book);
    const sceneLengthIssues = QualityGate._collectSceneLengthIssues(spreads, opts?.plan);

    for (const sc of sceneContinuityIssues) {
      issues.push({ dimension: 'sceneContinuity', spread: sc.spread, note: sc.note });
    }
    for (const r of refrainIssues) {
      issues.push({ dimension: 'refrain', spread: r.spread ?? null, note: r.note });
    }
    for (const o of openingLocationIssues) {
      issues.push({ dimension: 'openingLocation', spread: o.spread, note: o.note });
    }
    for (const sl of sceneLengthIssues) {
      issues.push({ dimension: 'sceneLength', spread: sl.spread, note: sl.note });
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
    if (refrainIssues.length > 0) {
      const block = QualityGate._refrainFeedbackBlock(refrainIssues);
      feedback = feedback ? `${feedback}\n\n${block}` : block;
    }
    if (openingLocationIssues.length > 0) {
      const block = QualityGate._openingLocationFeedbackBlock(openingLocationIssues);
      feedback = feedback ? `${feedback}\n\n${block}` : block;
    }
    if (sceneLengthIssues.length > 0) {
      const block = QualityGate._sceneLengthFeedbackBlock(sceneLengthIssues);
      feedback = feedback ? `${feedback}\n\n${block}` : block;
    }
    const pass = possessiveErrors.length === 0
      && rhymeLintIssues.length === 0
      && readAloudLongWords.length === 0
      && sceneContinuityIssues.length === 0
      && refrainIssues.length === 0
      && openingLocationIssues.length === 0
      && sceneLengthIssues.length === 0;

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
      refrain: refrainIssues.length > 0,
      openingLocation: openingLocationIssues.length > 0,
      sceneLength: sceneLengthIssues.length > 0,
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

  /**
   * Refrain placement check. The story rules require the refrain to:
   *   - appear at least 3 times across the book,
   *   - never on consecutive spreads,
   *   - include at least one occurrence in spreads 10-13.
   *
   * The writer is free to invent its own refrain wording, so we discover the
   * refrain heuristically: the longest 4+ word phrase (case- and punctuation-
   * normalized) that appears in the most spreads. This catches the actual
   * recurring line even when it diverges from `plan.refrain.suggestions`.
   *
   * Books with fewer than 6 spreads are skipped (not enough signal).
   *
   * @param {Array<object>} spreads
   * @param {object|null} plan
   * @returns {Array<{ spread?: number, note: string }>}
   */
  static _collectRefrainIssues(spreads, plan) {
    if (!Array.isArray(spreads) || spreads.length < 6) return [];
    const lastSpread = Math.max(...spreads.map(s => Number(s.spread) || 0));
    if (!Number.isFinite(lastSpread) || lastSpread < 6) return [];

    const refrain = QualityGate._discoverRefrain(spreads, plan);
    if (!refrain) {
      return [{
        note: 'No refrain detected — the book needs ONE recognizable repeating line (>= 4 words, exact same wording) appearing on at least 3 spreads. Pick one phrase that captures the emotional core of the theme and place it three times across the book (one of those repeats must land in spreads 10–13).',
      }];
    }

    const occurrences = refrain.spreadNumbers.slice().sort((a, b) => a - b);
    const issues = [];

    if (occurrences.length < 3) {
      issues.push({
        note: `Refrain "${refrain.phrase}" appears only ${occurrences.length} time(s) (spreads ${occurrences.join(', ') || 'none'}). Use it on EXACTLY 3 spreads — early, middle, and late — with at least one repeat in spreads 10–13.`,
      });
    }

    const lateHit = occurrences.some(n => n >= Math.max(10, lastSpread - 3));
    if (occurrences.length >= 1 && !lateHit) {
      issues.push({
        note: `Refrain "${refrain.phrase}" never lands in spreads 10–${lastSpread}. The closing third of the book must include the refrain so it pays off the emotional arc; without a late hit it reads as abandoned.`,
      });
    }

    for (let i = 1; i < occurrences.length; i++) {
      if (occurrences[i] === occurrences[i - 1] + 1) {
        issues.push({
          note: `Refrain "${refrain.phrase}" appears on consecutive spreads ${occurrences[i - 1]} and ${occurrences[i]}. Space the repeats — refrain back-to-back drains its meaning. Move one occurrence to a non-adjacent spread.`,
        });
        break;
      }
    }

    if (occurrences.length > 4) {
      issues.push({
        note: `Refrain "${refrain.phrase}" appears ${occurrences.length} times (spreads ${occurrences.join(', ')}). Three is the sweet spot, four is the cap; more makes the book monotonous. Cut one or two occurrences.`,
      });
    }

    return issues;
  }

  /**
   * Discover the most-likely refrain by finding the longest 4+ word phrase
   * shared by the most spreads. Returns null if no phrase repeats across
   * 2+ spreads.
   *
   * @param {Array<object>} spreads
   * @param {object|null} plan
   * @returns {{ phrase: string, spreadNumbers: number[] } | null}
   */
  static _discoverRefrain(spreads, plan) {
    const norm = s => String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9'\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const candidates = new Map();
    const planSuggestions = Array.isArray(plan?.refrain?.suggestions)
      ? plan.refrain.suggestions.map(norm).filter(s => s.split(' ').length >= 3)
      : [];
    for (const sugg of planSuggestions) {
      candidates.set(sugg, []);
    }

    const byNum = spreads
      .map(s => ({ n: Number(s.spread) || 0, t: norm(s.text || '') }))
      .filter(s => s.n > 0 && s.t.length > 0);

    for (const { n, t } of byNum) {
      const tokens = t.split(' ');
      for (let len = Math.min(10, tokens.length); len >= 4; len--) {
        for (let i = 0; i + len <= tokens.length; i++) {
          const phrase = tokens.slice(i, i + len).join(' ');
          if (!candidates.has(phrase)) candidates.set(phrase, []);
          const arr = candidates.get(phrase);
          if (!arr.includes(n)) arr.push(n);
        }
      }
    }

    let best = null;
    for (const [phrase, hits] of candidates.entries()) {
      if (hits.length < 2) continue;
      const score = hits.length * 100 + phrase.split(' ').length;
      if (!best || score > best.score) {
        best = { phrase, spreadNumbers: hits, score };
      }
    }
    if (!best) return null;
    return { phrase: best.phrase, spreadNumbers: best.spreadNumbers };
  }

  static _refrainFeedbackBlock(issues) {
    const lines = issues.map(i => `  - ${i.note}`);
    return [
      'REFRAIN PLACEMENT — children\'s books live or die on the refrain. Pick ONE line of 4+ words and reuse the EXACT same wording 3 times (4 max), spaced apart, with at least one occurrence in the closing third of the book:',
      ...lines,
    ].join('\n');
  }

  /**
   * Opening location check. Spread 1 must not read as the banned mundane
   * defaults (waking in bed, kitchen breakfast, living-room rug, generic
   * playground/park, backyard garden, "at home"). The check inspects both
   * TEXT and SCENE, with theme-aware exceptions: bedtime themes are exempt
   * (a bedroom opener is on-theme), and if the planner pre-assigned a palette
   * location to spread 1, we trust the planner's vetting and only fail on
   * obvious banned phrases in the TEXT.
   *
   * @param {Array<object>} spreads
   * @param {object|null} plan
   * @param {object|null} book
   * @returns {Array<{ spread: number, note: string }>}
   */
  static _collectOpeningLocationIssues(spreads, plan, book) {
    if (!Array.isArray(spreads) || spreads.length === 0) return [];
    const opener = spreads.find(s => Number(s.spread) === 1) || spreads[0];
    if (!opener) return [];

    const theme = (book?.theme || plan?.theme || '').toString().toLowerCase();
    if (theme === 'bedtime') return [];

    const text = String(opener.text || '').toLowerCase();
    const scene = String(opener.scene || '').toLowerCase();
    const combined = `${text}\n${scene}`;

    const bannedPhrases = [
      { rx: /\b(?:in|on|inside)\s+(?:the|her|his)?\s*bed\b/, label: 'opens in bed' },
      { rx: /\b(?:wakes?|woke|waking)\s+up\b/, label: 'opens with waking up' },
      { rx: /\bunder\s+the\s+covers?\b/, label: 'opens under the covers' },
      { rx: /\b(?:the\s+)?kitchen\s+(?:table|counter|sink)\b/, label: 'opens at the kitchen table/counter' },
      { rx: /\b(?:breakfast|cereal)\s+(?:bowl|table|time)\b/, label: 'opens at breakfast' },
      { rx: /\bliving[\s-]room\b/, label: 'opens in the living room' },
      { rx: /\b(?:on|across|in)\s+the\s+rug\b/, label: 'opens on the rug at home' },
      { rx: /\bplayroom\b/, label: 'opens in a playroom' },
      { rx: /\b(?:the\s+)?backyard\b/, label: 'opens in the backyard' },
      { rx: /\bgarden\s+(?:gate|path|patch|bed)\b/, label: 'opens in the home garden' },
      { rx: /\bat\s+home\b/, label: 'opens "at home"' },
      { rx: /\bin\s+(?:the|her|his)\s+(?:own\s+)?(?:room|bedroom)\b/, label: 'opens in the bedroom' },
    ];

    const matched = [];
    for (const { rx, label } of bannedPhrases) {
      if (rx.test(combined)) matched.push(label);
    }
    if (matched.length === 0) return [];

    return [{
      spread: opener.spread,
      note: `Spread 1 ${matched[0]} — that is a banned mundane opener. Rewrite the opener (TEXT and SCENE) to start in a non-home, visually striking location: lighthouse causeway, rope bridge, balloon deck, waterfall ledge, ice-cave mouth, observatory dome, harbor at dawn, marble ruins, treetop walk — or another specific outdoor/landmark setting that earns a "wow" first page. The first page is the cover's promise; do not waste it on a kitchen.`,
    }];
  }

  static _openingLocationFeedbackBlock(issues) {
    const lines = issues.map(i => `  - Spread ${i.spread}: ${i.note}`);
    return [
      'OPENING LOCATION — spread 1 sets the visual stakes for the whole book. Mundane home/park/playground openers are banned:',
      ...lines,
    ].join('\n');
  }

  /**
   * SCENE-length floor. A SCENE block much shorter than 25 words cannot
   * possibly contain location naming + viewpoint + body action + light cue
   * + 2-3 visual anchors that the illustrator depends on. We only run this
   * when the plan supplied palette locations (so we know SCENE is contractually
   * required), and we tolerate the closing spread being a touch shorter.
   *
   * @param {Array<object>} spreads
   * @param {object|null} plan
   * @returns {Array<{ spread: number, note: string }>}
   */
  static _collectSceneLengthIssues(spreads, plan) {
    const beats = plan && Array.isArray(plan.beats) ? plan.beats : [];
    if (beats.length === 0) return [];
    const hasPalette = beats.some(b => b && typeof b.location === 'string' && b.location.trim());
    if (!hasPalette) return [];

    const MIN_WORDS = 25;
    const issues = [];
    for (const s of spreads) {
      const scene = typeof s.scene === 'string' ? s.scene.trim() : '';
      if (!scene) continue;
      const words = scene.split(/\s+/).filter(Boolean).length;
      if (words < MIN_WORDS) {
        issues.push({
          spread: s.spread,
          note: `SCENE block is only ${words} words (target 40–70). Expand it to a full art-direction paragraph: name the palette location, the viewpoint/framing in plain words (wide shot, low angle, over-the-shoulder, closer on hands), the time of day and quality of light, the hero's body action and expression, and 2–3 concrete visual anchors. Short SCENE blocks force the illustrator to invent the picture.`,
        });
      }
    }
    return issues;
  }

  static _sceneLengthFeedbackBlock(issues) {
    const lines = issues.map(i => `  - Spread ${i.spread}: ${i.note}`);
    return [
      'SCENE LENGTH — the illustrator reads the SCENE block verbatim. Stub-length scenes (under 25 words) silently produce generic art:',
      ...lines,
    ].join('\n');
  }
}

module.exports = { QualityGate };
