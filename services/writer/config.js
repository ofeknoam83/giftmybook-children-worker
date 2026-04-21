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
    // Quality is judged entirely by an LLM critic; the writer retries
    // until the critic says ship=true. This budget is the safety cap —
    // worst case we pay ~1 min per retry (revise + critic), so 6 means
    // the generator can spend ~6 extra minutes fighting for a pass
    // before we ship best-of-N.
    maxQualityRetries: 6,
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
    // The LLM critic applies these thresholds directly inside its prompt
    // when deciding ship=true/false. They are included here so the values
    // stay tunable in one place; the critic prompt interpolates them.
    passScore: 8.5,
    minDimensionScore: 6,
  },
};

module.exports = { WRITER_CONFIG };
