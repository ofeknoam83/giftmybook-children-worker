/**
 * Writer V2 configuration — all model choices, temperatures, age tiers,
 * and quality thresholds in one place.
 */

const WRITER_CONFIG = {
  models: {
    planner:  { primary: 'gpt-5.4', fallback: 'gemini-2.5-pro',  temperature: 0.9  },
    writer:   { primary: 'gpt-5.4', fallback: 'gemini-2.5-pro',  temperature: 0.85 },
    critic:   { primary: 'gpt-5.4', fallback: 'gemini-2.5-flash', temperature: 0.3  },
    reviser:  { primary: 'gpt-5.4', fallback: 'gemini-2.5-pro',  temperature: 0.8  },
  },

  retries: {
    maxWriteAttempts: 3,
    // Bumped from 2 → 3 so the gate has budget to actually recover after
    // the raised passScore. Revision is ~30s with GPT-5.4 so worst-case
    // this adds ~2 minutes to a book that genuinely needs three passes.
    maxQualityRetries: 3,
  },

  timeouts: {
    defaultLLM: 120_000,   // 2 minutes
    longGeneration: 240_000, // 4 minutes for large books
  },

  /**
   * Age tiers — two tiers, both produce 13-spread picture books.
   * The tier changes vocabulary and sentence complexity, NOT structure.
   * Parents are the readers, so writing quality must be high for both tiers.
   *
   * Tier 1 (ages 0-3): Simpler vocabulary, shorter sentences, more repetition.
   *   Still beautifully written — parents should enjoy reading it aloud.
   * Tier 2 (ages 4-6): Richer vocabulary, compound sentences, more narrative depth.
   */
  ageTiers: {
    'young-picture': {
      label: 'Young Picture Book (ages 0-3)',
      ages: [0, 1, 2, 3],
      maxWords: 250,
      spreads: { min: 13, max: 13 },
      wordsPerSpread: { min: 8, max: 22 },
      meter: 'iambic tetrameter',
      rhyme: 'AABB couplets',
    },
    'picture-book': {
      label: 'Picture Book (ages 4-6)',
      ages: [4, 5, 6],
      maxWords: 500,
      spreads: { min: 13, max: 13 },
      wordsPerSpread: { min: 15, max: 40 },
      meter: 'iambic tetrameter',
      rhyme: 'AABB couplets',
    },
  },

  qualityThresholds: {
    // Raised from 7.5 → 8.5. Books scoring in the high 7s were clearing
    // the old gate despite real personalization misses (age mismatch,
    // dropped anecdotes, overridden favorite object). 8.5 is high enough
    // to trigger at least one revision on most first drafts while still
    // being achievable on a genuinely good story.
    passScore: 8.5,
    // Raised from 5 → 6. At 5 a dimension with "half of checks missed"
    // still cleared the floor; 6 requires at least "mostly correct".
    minDimensionScore: 6,
    // Dimensions that must score at least this high regardless of the
    // weighted average. These are the ones where a low score indicates
    // a book you would NOT want to ship no matter how creative it is:
    //   - anecdoteUsage: fails → the questionnaire answers were ignored
    //   - pronouns:      fails → the child is referred to as the wrong gender
    //   - wordCount:     fails → too long/short to read aloud at age
    //   - endingAppropriateness: fails → celebration ends with bedtime
    //   - nameDiscipline: fails → parent's real name used more than once
    //     (should appear at most once for a dedication-style beat)
    // All other dimensions fall under the generic minDimensionScore floor.
    criticalDimensions: {
      anecdoteUsage: 7,
      pronouns: 9,
      wordCount: 7,
      endingAppropriateness: 7,
      nameDiscipline: 6,
    },
  },
};

module.exports = { WRITER_CONFIG };
