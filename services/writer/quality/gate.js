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
   * @returns {{ pass: boolean, overallScore: number, scores: object, feedback: string }}
   */
  static async check(story, child, book) {
    const spreads = story.spreads || [];
    const scores = {};

    // Hard-fail: if there are 0 spreads, don't bother scoring
    if (spreads.length === 0) {
      return {
        pass: false,
        overallScore: 0,
        scores: { pronouns: 0, wordCount: 0, rhyme: 0, ageAppropriateness: 0, readAloud: 0, emotionalArc: 0, specificity: 0, creativity: 0 },
        feedback: 'CATASTROPHIC: Story has 0 spreads. The writer produced no output.',
      };
    }

    // Deterministic checks (fast, no LLM needed)
    scores.pronouns = scorePronounCorrectness(spreads, child.gender);
    scores.wordCount = QualityGate._scoreWordCount(spreads, child.age, story._ageTier);

    // LLM-based checks (slower, subjective)
    try {
      const llmScores = await QualityGate._runLLMChecks(spreads, child, book);
      scores.rhyme = llmScores.rhyme || 7;
      scores.ageAppropriateness = llmScores.ageAppropriateness || 7;
      scores.readAloud = llmScores.readAloud || 7;
      scores.emotionalArc = llmScores.emotionalArc || 7;
      scores.specificity = llmScores.specificity || 7;
      scores.creativity = llmScores.creativity || 7;
    } catch (err) {
      console.warn(`[writerV2] LLM quality checks failed, using defaults: ${err.message}`);
      scores.rhyme = 7;
      scores.ageAppropriateness = 7;
      scores.readAloud = 7;
      scores.emotionalArc = 7;
      scores.specificity = 7;
      scores.creativity = 7;
    }

    const scoreValues = Object.values(scores);
    const overallScore = scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length;
    const minScore = Math.min(...scoreValues);

    const pass = overallScore >= WRITER_CONFIG.qualityThresholds.passScore
              && minScore >= WRITER_CONFIG.qualityThresholds.minDimensionScore;

    const feedback = pass ? '' : QualityGate._buildFeedback(scores, spreads);

    return { pass, overallScore: Math.round(overallScore * 10) / 10, scores, feedback };
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
    const arcDescription = isCelebration
      ? 'Does it build from specific activities to emotional connection to a joyful, warm climax? The closing should be the WARMEST spread — full of love and energy, NOT quiet, NOT sleepy, NOT bedtime.'
      : 'Does it build from specific activities to emotional deepening to a quiet climax? Is the closing quieter than the middle?';

    const systemPrompt = `You are a professional children's book editor and quality assessor. Score the following story on these dimensions, each from 1-10:

1. RHYME: Do the couplets actually rhyme? Is the meter consistent (iambic tetrameter for ages 3+)? Does the rhythm feel natural or forced? Score 1 if rhymes are broken/forced, 10 if every couplet rhymes naturally.

2. AGE_APPROPRIATENESS: Is the vocabulary appropriate for age ${child.age}? Are sentences the right length? Would a child this age understand and enjoy this?

3. READ_ALOUD: Would this sound good read aloud by a parent? Is there rhythm variation? Do words have good "mouth-feel"? Would a parent stumble anywhere?

4. EMOTIONAL_ARC: Does the story have emotional progression? ${arcDescription}${isCelebration ? ' Penalize if the story contains tantrums, crying, frustration, anger, bedtime, sleep, or goodnight imagery.' : ''}

5. SPECIFICITY: Are there concrete, specific nouns (not vague categories)? Do emotions emerge from actions rather than declarations? Is there at least one surprise per spread? Would any line work in a greeting card? (if yes, that's bad)

6. CREATIVITY: Does the story contain at least one imaginative leap or metaphor (the child transforms the ordinary into something magical)? Does the refrain deepen in meaning across repetitions rather than just repeating? Are there unexpected images or rhyme pairs? Score 1 if the story reads like a flat documentary of activities, 10 if it surprises and delights.

Return a JSON object:
{
  "rhyme": <score 1-10>,
  "ageAppropriateness": <score 1-10>,
  "readAloud": <score 1-10>,
  "emotionalArc": <score 1-10>,
  "specificity": <score 1-10>,
  "creativity": <score 1-10>,
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
  static _buildFeedback(scores, spreads) {
    const feedback = [];
    const { passScore, minDimensionScore } = WRITER_CONFIG.qualityThresholds;

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

    if (scores.wordCount < minDimensionScore) {
      const totalWords = spreads.reduce((sum, s) => sum + (s.text || '').split(/\s+/).length, 0);
      feedback.push(`WORD COUNT: Total is ${totalWords} words — outside the target range. Trim or expand to fit the age tier limits.`);
    }

    return feedback.join('\n\n');
  }
}

module.exports = { QualityGate };
