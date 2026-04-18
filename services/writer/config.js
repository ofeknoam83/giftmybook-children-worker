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
    maxQualityRetries: 2,
  },

  timeouts: {
    defaultLLM: 120_000,   // 2 minutes
    longGeneration: 240_000, // 4 minutes for large books
  },

  /**
   * Age tiers define word counts, spread counts, and per-spread limits
   * for each developmental stage.
   *
   * Ages at tier boundaries:
   *   - age 2 falls in board-book (writing for a 2-year-old is still board-book territory)
   *   - age 3 falls in early-picture (research: "2-3: 8-15 words per spread")
   *   - age 3-5 also eligible for picture-book depending on theme
   */
  ageTiers: {
    'board-book': {
      label: 'Board Book',
      ages: [0, 1, 2],
      maxWords: 100,
      spreads: { min: 6, max: 10 },
      wordsPerSpread: { min: 3, max: 12 },
      meter: 'bouncy/sing-song',
      rhyme: 'AABB couplets (loose)',
    },
    'early-picture': {
      label: 'Early Picture Book',
      ages: [2, 3],
      maxWords: 250,
      spreads: { min: 10, max: 13 },
      wordsPerSpread: { min: 8, max: 20 },
      meter: 'iambic tetrameter',
      rhyme: 'AABB couplets',
    },
    'picture-book': {
      label: 'Picture Book',
      ages: [3, 4, 5],
      maxWords: 500,
      spreads: { min: 12, max: 14 },
      wordsPerSpread: { min: 15, max: 35 },
      meter: 'iambic tetrameter',
      rhyme: 'AABB couplets',
    },
  },

  qualityThresholds: {
    passScore: 7.0,
    minDimensionScore: 5,
  },
};

module.exports = { WRITER_CONFIG };
