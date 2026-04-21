/**
 * QualityGate — a single LLM call is the sole arbiter of story quality.
 *
 * Everything is delegated to a children's-book-editor LLM prompt. No
 * deterministic substring matching, keyword counting, or regex — those
 * produced false positives (euphemism "Pffft" vs. literal "fart") and
 * false negatives that sent the writer into pointless revision loops.
 *
 * The critic returns:
 *   { pass, scores: { ...dimensions }, overallScore, issues: [{ ... }], feedback }
 *
 * Dimensions scored 1-10 (see the system prompt for exact rubric):
 *   rhyme, meter, ageAppropriateness, readAloud, emotionalArc,
 *   specificity, creativity, variety, narrativeCoherence, anecdoteUsage,
 *   settingVariety, pronouns, endingAppropriateness, parentNameDiscipline,
 *   wordCount.
 *
 * The critic — not a separate threshold computation — decides `pass`. It
 * applies the shipping rubric directly: the book ships iff every anecdote
 * that was provided lands, pronouns are correct, parent-name discipline
 * holds, the ending matches the theme, and no single dimension is below
 * the per-dimension floor. When it fails, the `feedback` field is a
 * concrete, actionable rewrite brief for the reviser.
 */

const { WRITER_CONFIG } = require('../config');
const { BaseThemeWriter } = require('../themes/base');

const _llm = new BaseThemeWriter('_quality_gate');

class QualityGate {
  /**
   * Run the critic on a story.
   * @param {object} story - { spreads: [{ spread, text }] }
   * @param {object} child - { name, age, gender, anecdotes }
   * @param {object} book  - { theme, mom_name, dad_name, heartfeltNote, customDetails, ... }
   * @param {object} [opts] - { plan, missingCritical }
   * @returns {Promise<{pass, overallScore, scores, feedback, issues}>}
   */
  static async check(story, child, book, opts = {}) {
    const spreads = Array.isArray(story?.spreads) ? story.spreads : [];
    if (spreads.length === 0) {
      return {
        pass: false,
        overallScore: 0,
        scores: {},
        issues: [{ dimension: 'catastrophic', note: 'Story has 0 spreads.' }],
        feedback: 'CATASTROPHIC: Story has 0 spreads. The writer produced no output.',
      };
    }

    const system = QualityGate._buildSystemPrompt(child, book, opts);
    const user = QualityGate._buildUserPrompt(story, child, book, opts);

    let parsed;
    try {
      const result = await _llm.callLLM('critic', system, user, {
        jsonMode: true,
        maxTokens: 1800,
      });
      parsed = JSON.parse(String(result.text || '').trim());
    } catch (err) {
      // A critic failure must not silently ship a bad book. Fail the gate,
      // emit a generic "rewrite with care" feedback, and let the outer
      // retry loop try again.
      console.warn(`[writerV2] QualityGate LLM call failed: ${err.message}`);
      return {
        pass: false,
        overallScore: 0,
        scores: {},
        issues: [{ dimension: 'critic_error', note: err.message }],
        feedback: 'Quality check could not be completed. Rewrite the story with extra care: land every anecdote, keep pronouns correct for the child, ensure the ending matches the theme, and use the parent\'s real first name AT MOST once.',
      };
    }

    const scores = QualityGate._clampScores(parsed.scores || {});
    const values = Object.values(scores);
    const overallScore = values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : 0;

    const pass = parsed.ship === true || parsed.pass === true;
    const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    const feedback = typeof parsed.feedback === 'string' && parsed.feedback.trim()
      ? parsed.feedback.trim()
      : QualityGate._synthesizeFeedback(issues);

    return {
      pass,
      overallScore: Math.round(overallScore * 10) / 10,
      scores,
      issues,
      feedback: pass ? '' : feedback,
    };
  }

  // ── Prompt construction ──────────────────────────────────────────────

  static _buildSystemPrompt(child, book, opts) {
    const theme = book?.theme || 'general';
    const isBedtime = theme === 'bedtime';
    const isCelebration = ['mothers_day', 'fathers_day', 'birthday', 'birthday_magic'].includes(theme);
    const { passScore, minDimensionScore } = WRITER_CONFIG.qualityThresholds;

    const parentWord = theme === 'fathers_day' ? 'Dad' : theme === 'mothers_day' ? 'Mom' : 'the parent';
    const momReal = (book?.mom_name || child?.anecdotes?.mom_name || '').toString().trim();
    const dadReal = (book?.dad_name || child?.anecdotes?.dad_name || '').toString().trim();

    const endingRule = isBedtime
      ? 'The ending MUST feel cozy, settling, and sleepy — soft imagery, calm pacing. A bedtime close is required.'
      : 'The ending MUST NOT use bedtime/sleep/dream/goodnight imagery. The final spreads should be warm, awake, and full of connection. Celebrations end joyful and bright.';

    const celebrationRule = isCelebration
      ? 'Celebration themes (Mother\'s Day, Father\'s Day, birthday) build toward a warm, connected, joyful climax — never quiet, never sleepy. Tantrums, crying, anger, or bedtime imagery on the last 3 spreads are a HARD FAIL.'
      : '';

    const parentNameRule = (momReal || dadReal)
      ? `The parent\'s real first name is "${momReal || dadReal}". Picture-book voice addresses the parent by relationship (${parentWord}, Mama, Papa, etc.) everywhere. The real first name may appear AT MOST ONCE across the entire book (typically in a single dedication-style beat) — OR may be omitted entirely if it doesn\'t fit gracefully. Two or more uses of the real first name is a HARD FAIL.`
      : 'No parent real name was provided. The story should address the parent by relationship only.';

    return `You are the final editor of a personalized children\'s picture book. You decide whether the book is ready to ship to a paying customer. Be strict. The standard is "a book a parent would buy in a bookstore and read to their child every night for a month."

You rate the book across 15 dimensions, each 1-10. You also decide a single boolean "ship" flag and (when ship is false) write a specific, actionable rewrite brief for the reviser.

## RATING DIMENSIONS

1. rhyme — Do couplets actually rhyme, and are the rhymes *good*? This dimension has HARD RULES:
     HARD FAIL (score ≤ 3) if ANY of the following appear anywhere in the book:
       - Identical-word rhyme: the two lines of a couplet end on the SAME word ("nose / nose", "tree / tree", "slide / slide", "splash / splash"). A word rhyming with itself is NOT a rhyme.
       - Repetition-as-rhyme: the same word or phrase repeated in rhyme position to fake a rhyme ("splash goes Mason, splash goes tub").
       - "X to X" echo rhymes in rhyme position ("nose to nose", "cheek to nose", "hand in hand") — these sound like rhymes but do not rhyme.
     WEAK (score 4-6) if more than 2 couplets rely on stale AI-common pairs (day/way, heart/start, love/above, you/true, night/light, play/day), forced inversions for meter, or noticeable slant rhymes that a parent would feel.
     STRONG (score 8-10) requires clean end-rhymes on *different* words, mostly full rhymes, and at least 2-3 fresh / multi-syllable pairs across the book (e.g. "splatter / chatter", "wobble / bobble").
2. meter — Is meter consistent (iambic tetrameter for ages 3+)? Does the rhythm feel musical? Also HARD FAIL (score ≤ 4) if any spread has an odd number of lines (3, 5, 7) — every spread must be 2 or 4 lines forming clean AABB couplets.
3. ageAppropriateness — Vocabulary and sentence length appropriate for the child\'s age. For ages 0-3: simple daily words only; penalize multi-syllable abstractions heavily.
4. readAloud — Would a parent read this aloud without stumbling? Does it sound like Dr. Seuss / Julia Donaldson?
5. emotionalArc — Does the story build, climax, and resolve with real emotional beats — not a flat list of activities?
6. specificity — Concrete actions, specific nouns. No greeting-card abstractions. No "she loved him very much" declarations.
7. creativity — At least one imaginative leap or transformation of the ordinary. Refrain deepens rather than just repeating. Fresh rhyme pairs.
8. variety — Each spread covers a DISTINCT activity or moment. Penalize repeated activities (food-sharing 3 times, etc.).
9. narrativeCoherence — One clear through-line. The reader always knows WHERE the characters are. Transitions are visible.
10. anecdoteUsage — Every anecdote the questionnaire provided must land concretely somewhere in the story. Euphemisms and natural picture-book phrasing count (a "toot" or "Pffft" lands a "farts"). But the ACTION / PERSON / OBJECT / MOMENT must be recognizably present. Score by ratio landed:
     ratio=1.0 → 10, >=0.8 → 9, >=0.6 → 7, >=0.4 → 5, <0.4 → 3.
11. settingVariety — Across the 13 spreads, 2-4 distinct physical locations. If 8+ spreads read as "at home" / "in the living room" that is a FAIL (score 1-3).
12. pronouns — Pronouns for the child match the child\'s stated gender in every reference. Any mismatch → score ≤ 4.
13. endingAppropriateness — ${endingRule}
14. parentNameDiscipline — ${parentNameRule} Score 10 for 0-1 uses; 6 for 2; 3 for 3; 1 for 4+.
15. wordCount — Word count per spread and total are within the age-tier limits (the writer was given these). Penalize oversized spreads proportionally.

${celebrationRule}

## SHIP CRITERIA (the "ship" boolean)

Set ship=true iff ALL of the following hold:
  - Overall average across all 15 dimensions ≥ ${passScore}/10
  - No single dimension scores below ${minDimensionScore}/10
  - rhyme ≥ 7 (cheap rhymes are a ship-blocker — a parent reading aloud should never feel the rhyme is lazy)
  - meter ≥ 7
  - anecdoteUsage ≥ 7
  - pronouns ≥ 9
  - endingAppropriateness ≥ 7
  - parentNameDiscipline ≥ 6
  - wordCount ≥ 7
  - No HARD FAIL condition above triggered

Otherwise set ship=false and write a concrete revision brief in "feedback". The brief must:
  - Name each failing dimension and its score
  - Quote or describe the specific lines that are wrong
  - Tell the reviser exactly what to change, spread by spread where relevant
  - Preserve everything that IS working; do not ask for a full rewrite if only 2-3 spreads are weak

## OUTPUT FORMAT (JSON only, no prose outside)

{
  "ship": true | false,
  "scores": {
    "rhyme": <1-10>, "meter": <1-10>, "ageAppropriateness": <1-10>,
    "readAloud": <1-10>, "emotionalArc": <1-10>, "specificity": <1-10>,
    "creativity": <1-10>, "variety": <1-10>, "narrativeCoherence": <1-10>,
    "anecdoteUsage": <1-10>, "settingVariety": <1-10>, "pronouns": <1-10>,
    "endingAppropriateness": <1-10>, "parentNameDiscipline": <1-10>,
    "wordCount": <1-10>
  },
  "issues": [
    { "dimension": "<name>", "spread": <int|null>, "note": "<short description>" }
  ],
  "feedback": "<revision brief as a single string, empty if ship=true>"
}`;
  }

  static _buildUserPrompt(story, child, book, opts) {
    const spreads = story.spreads || [];
    const plan = opts?.plan || null;

    const anecdotesBlock = QualityGate._formatAnecdotes(child?.anecdotes || {});
    const manifestBlock = (plan && Array.isArray(plan.manifest) && plan.manifest.length > 0)
      ? plan.manifest.map(m => `  - Spread ${m.spread}: ${m.anecdote_key} → "${m.anecdote_value}"`).join('\n')
      : '';
    const customDetails = (book?.customDetails || '').toString().trim();
    const momReal = (book?.mom_name || child?.anecdotes?.mom_name || '').toString().trim();
    const dadReal = (book?.dad_name || child?.anecdotes?.dad_name || '').toString().trim();

    const parts = [];
    parts.push('## BOOK UNDER REVIEW');
    parts.push('');
    parts.push(`Theme: ${book?.theme || 'general'}`);
    parts.push(`Child: ${child?.name || '(unknown)'} (age ${child?.age ?? 'unspecified'}, gender ${child?.gender || 'unspecified'})`);
    if (momReal) parts.push(`Mom\'s real first name: ${momReal}`);
    if (dadReal) parts.push(`Dad\'s real first name: ${dadReal}`);
    if (anecdotesBlock) {
      parts.push('');
      parts.push('### Questionnaire anecdotes (each must land in the story)');
      parts.push(anecdotesBlock);
    }
    if (customDetails) {
      parts.push('');
      parts.push('### Parent-written custom details (every specific noun/person/place must land)');
      parts.push(customDetails);
    }
    if (manifestBlock) {
      parts.push('');
      parts.push('### Planner manifest (anecdote → spread assignments the writer was given)');
      parts.push(manifestBlock);
    }

    parts.push('');
    parts.push('### Story');
    for (const s of spreads) {
      parts.push(`Spread ${s.spread}: ${s.text || ''}`);
    }

    return parts.join('\n');
  }

  static _formatAnecdotes(a) {
    const LABELS = {
      favorite_activities:  'Favorite activities',
      funny_thing:          'Funny thing they do',
      meaningful_moment:    'Meaningful moment',
      moms_favorite_moment: "Mom\'s favorite moment",
      dads_favorite_moment: "Dad\'s favorite moment",
      favorite_food:        'Favorite food',
      favorite_cake_flavor: 'Favorite cake flavor',
      favorite_toys:        'Favorite toys',
      mom_name:             "Mom\'s name",
      dad_name:             "Dad\'s name",
      calls_mom:            'What the child calls mom',
      calls_dad:            'What the child calls dad',
      other_detail:         'Other detail',
      anything_else:        'Additional',
    };
    const lines = [];
    for (const [key, label] of Object.entries(LABELS)) {
      const v = a[key];
      if (typeof v === 'string' && v.trim()) lines.push(`- ${label}: ${v.trim()}`);
    }
    return lines.join('\n');
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  static _clampScores(raw) {
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      out[k] = Math.max(1, Math.min(10, Math.round(n)));
    }
    return out;
  }

  /**
   * Last-ditch feedback when the LLM returned ship=false but an empty
   * feedback string. Build a short brief from the issues list so the
   * reviser always has something concrete to act on.
   */
  static _synthesizeFeedback(issues) {
    if (!Array.isArray(issues) || issues.length === 0) {
      return 'Revise: fix every dimension that scored below 7. Preserve what works.';
    }
    const lines = issues.slice(0, 10).map(i => {
      const loc = (i.spread != null) ? ` (spread ${i.spread})` : '';
      return `- ${i.dimension || 'issue'}${loc}: ${i.note || ''}`.trim();
    });
    return `Revise to address:\n${lines.join('\n')}`;
  }
}

module.exports = { QualityGate };
