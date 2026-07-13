/**
 * Shared fixtures for bookPipelineV3 tests — factories for LLM-shaped JSON
 * outputs and request/profile objects.
 */

const PRESCHOOL_PROFILE = {
  ageBand: 'PB_PRESCHOOL',
  band: 'PB_PRESCHOOL',
  narrativeConstraints: {
    wordsPerSpread: { min: 20, max: 50, target: 32 },
    linesPerSpread: { min: 2, max: 4, target: 4 },
    dialogueDensity: 'low',
  },
  vocabularyConstraints: {},
};

const BRIEF = {
  child_as_character: [
    { detail: 'loves her red bucket', story_potential: 'can be lost and found', load_bearing: true },
    { detail: 'afraid of big waves', story_potential: 'the obstacle', load_bearing: true },
  ],
  gift_intent: 'Show Zoe that curiosity is stronger than fear.',
  constraints: {
    banned_elements: [],
    safety_notes: [],
    pronouns: { subject: 'she', object: 'her', possessive: 'her' },
  },
  child: { name: 'Zoe', age: 4 },
};

function makeConceptJson(id) {
  return {
    id,
    angle: id,
    logline: `Zoe and the ${id} adventure by the sea.`,
    external_plot: 'Zoe builds a sandcastle, loses her bucket to a wave, and follows it down the shore.',
    internal_arc: 'Zoe learns her curiosity is bigger than her fear of waves.',
    form_choice: 'rhythmic_prose',
    form_justification: 'Prose cadence suits a quiet shore story for age 4.',
    refrain: { text: 'down by the singing sea', evolution: [{ phase: 'climax', variant: 'up sings the sea!' }] },
    climax_image: 'Zoe knee-deep in foam, laughing, bucket held high.',
    final_page_note: 'Safe, salty, sleepy pride.',
    sample_lines: ['Zoe pats the cool wet sand.', 'The sea hums low.', 'A wave leans in to listen.'],
    load_bearing_details: ['red bucket drives the plot', 'wave fear is the obstacle'],
  };
}

function makeSpread(n) {
  return {
    spread: n,
    lines: [
      `Zoe carries her red bucket down the quiet shore near stone number ${n}.`,
      'She scoops the cool wet sand and pats it into a little tower.',
      'A small wave slides up close and tickles her bare toes.',
    ],
    refrain_here: n === 1,
    scene_contract: {
      setting: `the shore by stone ${n}`,
      characters_present: ['Zoe'],
      hero_action: 'pats wet sand into a tower',
      emotion: 'wonder',
      key_objects: ['red bucket'],
      time_of_day: 'morning',
      continuity_notes: 'red bucket carried from previous spread',
    },
  };
}

function makeManuscriptJson(spreadCount = 13) {
  return {
    title: 'Zoe and the Singing Sea',
    form: 'rhythmic_prose',
    refrain: { text: 'down by the singing sea', evolution: [] },
    spreads: Array.from({ length: spreadCount }, (_, i) => makeSpread(i + 1)),
  };
}

function makeJudgeReportJson(labels, { score = 4, meaningSanityFail = false, flagged = [] } = {}) {
  const dims = [
    'read_aloud_musicality', 'emotional_truth', 'page_turn_pull',
    'concrete_specificity', 'personalization_depth', 'age_fit', 'meaning_sanity',
  ];
  return {
    manuscripts: labels.map((label) => ({
      label,
      scores: Object.fromEntries(dims.map((d) => [d, { score, evidence: [] }])),
      meaning_sanity_fail: meaningSanityFail,
      flagged_spreads: flagged,
      one_line_verdict: 'test verdict',
    })),
  };
}

const RAW_REQUEST = {
  bookId: 'test-book-1',
  format: 'picture_book',
  theme: 'adventure',
  child: { name: 'Zoe', age: 4, gender: 'female', interests: ['the beach'], appearance: 'curly brown hair' },
  customDetails: 'Loves her red bucket.',
  cover: { title: 'Zoe and the Singing Sea', imageUrl: 'https://cdn.example/cover.png' },
};

module.exports = {
  PRESCHOOL_PROFILE,
  BRIEF,
  RAW_REQUEST,
  makeConceptJson,
  makeManuscriptJson,
  makeSpread,
  makeJudgeReportJson,
};
