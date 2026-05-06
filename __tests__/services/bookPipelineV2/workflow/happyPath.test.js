/**
 * v2 workflow — happy-path smoke test.
 *
 * Mocks `callText` (every LLM call) and v1's `renderAllSpreadsQuad`
 * (the illustrator). Runs the full workflow end-to-end and asserts:
 *   - every planning stage is persisted to the artifact store
 *   - each spread is written, det-gated, critiqued, and accepted
 *   - the public generateBook returns { document, layout }
 *
 * This is the contract test the CI run protects from regressions.
 */

jest.mock('../../../../services/bookPipeline/llm/openaiClient', () => ({
  callText: jest.fn(),
}));
jest.mock('../../../../services/bookPipeline/illustrator/renderAllSpreadsQuad', () => ({
  renderAllSpreadsQuad: jest.fn(async (doc) => {
    // Simulate the illustrator: stamp every spread with an illustration
    // entry and return the mutated doc (matches v1's behaviour).
    return {
      ...doc,
      spreads: doc.spreads.map((s) => ({
        ...s,
        illustration: {
          imageUrl: `https://example.test/${doc.request?.bookId}/spread-${s.spreadNumber}.jpg`,
          imageStorageKey: `books/${doc.request?.bookId}/spreads/spread-${s.spreadNumber}.jpg`,
          scenePrompt: `mock prompt for spread ${s.spreadNumber}`,
        },
      })),
    };
  }),
}));

const { callText } = require('../../../../services/bookPipeline/llm/openaiClient');
const { generateBook } = require('../../../../services/bookPipelineV2');

function jsonResponse(json, model = 'gpt-5-mock') {
  return { text: JSON.stringify(json), json, usage: {}, model, attempts: 1, label: 'mock', finishReason: 'stop' };
}

function mockBriefResp() {
  return jsonResponse({
    inferred: { emotional_safety_level: 'high' },
    structural_directives: { callback_seeds: ['blanket', 'Mama-hum'], banned_arc_shapes: ['scary peak'] },
  });
}

function mockIntentResp() {
  return jsonResponse({
    logline: 'A baby and Mama settle into a soft evening together at home, ending the day with a familiar hum.',
    theme_delivered_via: ['camera follows protagonist', 'recurring blanket motif'],
    emotional_arc: [
      { phase: 'opening', feeling: 'drowsy_observation' },
      { phase: 'middle', feeling: 'gentle_anticipation' },
      { phase: 'climax', feeling: 'held_relief' },
      { phase: 'closing', feeling: 'soft_return' },
    ],
    callback_motifs: [
      { id: 'blanket', label: 'soft blanket', introduce_spread: 1, callback_spreads: [4, 7] },
      { id: 'mama-hum', label: "Mama's hum", introduce_spread: 2, callback_spreads: [6, 10] },
    ],
    banned_elements: ['antagonist', 'loud_event', 'moralizing_line'],
    climax_payoff_image: 'baby and mama curled together under the soft blanket',
    ending_feeling: 'held_relief',
  });
}

function mockStoryBibleResp() {
  return jsonResponse({
    logline: 'evening at home',
    three_act_shape: { act_1: 'evening begins', act_2: 'small wonders', act_3: 'soft return' },
    midpoint: 'mama hums',
    climax_payoff_image: 'curled together under blanket',
    ending_image: 'lamp glows low',
    theme_motif_table: [{ motif_id: 'blanket', role_in_arc: 'comfort anchor' }],
    protagonist_voice_notes: 'lap baby; sensory only',
  });
}

function mockCharacterBibleResp() {
  return jsonResponse({
    characters: [{
      name: 'Scarlett', role: 'protagonist', age_months: 7, age_band: 'PB_INFANT',
      ethnicity_descriptor: 'warm-toned', skin_tone_family: 'fair',
      hair: { color_family: 'light brown', length: 'wispy', texture: 'soft', volume: 'low', signature_styling: 'crown of curls' },
      eyes: { color: 'hazel', shape: 'round' },
      face: { cheek_quality: 'full', mouth: 'small soft' },
      body: { head_to_body_ratio: '1:3', developmental_stage: 'lap baby', can_stand_independently: false, rendered_teeth: 'none', limb_quality: 'soft rounded' },
      signature_outfit: { top: 'cream onesie', bottom: 'matching pants', accessories: ['headband'] },
      signature_prop: 'soft pink blanket',
      personality: 'curious, calm', speaking_style: 'pre-verbal',
      visual_rules: ['always held or seated'], anti_rules: ['never standing', 'never walking'],
      derived_from_cover_image: null,
    }],
  });
}

function mockWorldBibleResp() {
  return jsonResponse({
    palette: { primaries: ['warm cream', 'soft pink'], accents: ['gold'], lighting: 'golden hour' },
    style_rules: ['premium 3D character-driven', 'one focal action per spread'],
    environment_anchors: [{ id: 'porch', label: 'sunset porch', defining_surfaces: ['wood deck'], defining_props: ['blanket', 'lantern'] }],
    recurring_motifs: [{ id: 'blanket', label: 'soft blanket', where_it_appears: ['porch', 'bedroom'] }],
    recurring_props: [{ id: 'blanket', name: 'soft blanket', locked_description: 'pale pink cotton with cream stitching', appears_in_spreads: [1, 4, 7, 10] }],
    supporting_cast: [{ id: 'mama', role: 'Mama', on_cover: true, partial_presence_lock: { skin_tone: 'fair', hand_or_arm: 'gentle hand', sleeve_or_outfit_fragment: 'cream linen sleeve', signature_item: 'thin gold ring' } }],
    text_placement_policy: { default_side: 'right', never_cross_center: true },
    cover_anchor_rules: ['hero face matches cover'],
    prohibited_visual_drift: ['extra family members', 'wrong outfit'],
  });
}

function mockBeatSheetResp(spreadCount) {
  return jsonResponse({
    spreads: Array.from({ length: spreadCount }, (_, i) => ({
      spread: i + 1,
      phase: i < spreadCount / 4 ? 'opening' : i < spreadCount / 2 ? 'middle' : i < (3 * spreadCount) / 4 ? 'climax' : 'closing',
      purpose: `establish moment ${i + 1}`,
      target_emotion: 'drowsy_observation',
      success_criteria: ['the porch is established', 'the blanket is shown without explanation'],
      prohibited: i === 4 ? ['rest'] : [],
      page_turn_hook: 'a small movement at the edge of the frame',
      callbacks_introduced: i === 0 ? ['blanket'] : [],
      callbacks_used: i === 3 ? ['blanket'] : [],
      implied_caregiver: 'Mama_arms_only',
      location_hint: 'sunset porch',
      on_screen_characters: ['Scarlett'],
    })),
  });
}

function mockWriterResp(spread) {
  // PB_INFANT band: 4 lines, ~6 syllables, 8–16 words total. Tested
  // separately to ensure it passes the deterministic gate.
  const lines = [
    'Pink blanket glows soft.',
    'Mama hums aloft.',
    'Scarlett blinks slow.',
    'Lamps glow low.',
  ];
  return jsonResponse({ spread, lines, text: lines.join('\n') });
}

function mockCriticAccept(spread) {
  return jsonResponse({
    spread,
    scores: { arc_advancement: 5, beat_fidelity: 5, emotional_clarity: 5, read_aloud_rhythm: 5, page_turn_strength: 5, illustration_potential: 5 },
    meaning_sanity: { passed: true, violations: [] },
    prohibited_respected: { passed: true, violations: [] },
    callback_fidelity: { passed: true, notes: [] },
    bible_consistency: { passed: true, notes: [] },
    suggested_fixes: [],
    accept_recommendation: true,
  });
}

function mockBookWideAccept() {
  return jsonResponse({
    scores: { arc_coherence: 5, callback_payoff: 5, theme_delivered_structurally: 5, abandoned_threads: 5, whole_book_repetition: 5, ending_lands: 5, reads_as_a_book_not_episodes: 5 },
    meaning_sanity_book_wide: { passed: true },
    bible_consistency_book_wide: { passed: true },
    prohibited_respected_book_wide: { passed: true },
    accept_recommendation: true,
    targeted_revisions: [],
  });
}

function mockSummarizerResp(spread) {
  return jsonResponse({
    spread,
    what_happened: 'porch beat established',
    emotional_state: 'drowsy_observation',
    callbacks_used: [],
    callbacks_pending: [],
    open_threads: [],
    last_image_cue: 'soft pink blanket',
  });
}

function wireMocks(spreadCount) {
  callText.mockReset();
  callText.mockImplementation(async (params) => {
    const label = params.label || '';
    if (label === 'v2.interpreter') return mockBriefResp();
    if (label === 'v2.intent') return mockIntentResp();
    if (label === 'v2.storyPlanner') return mockStoryBibleResp();
    if (label === 'v2.characterBible') return mockCharacterBibleResp();
    if (label === 'v2.worldBible') return mockWorldBibleResp();
    if (label === 'v2.beatSheet') return mockBeatSheetResp(spreadCount);
    if (label === 'v2.spreadCritic') {
      let spread = 1;
      try { spread = JSON.parse(params.userPrompt).draft?.spread || 1; } catch {}
      return mockCriticAccept(spread);
    }
    if (label === 'v2.bookWideCritic') return mockBookWideAccept();
    if (label === 'v2.summarizer') {
      let spread = 1;
      try { spread = JSON.parse(params.userPrompt).spread || 1; } catch {}
      return mockSummarizerResp(spread);
    }
    if (label.startsWith('v2.writer')) {
      let spread = 1;
      try { spread = JSON.parse(params.userPrompt).beat?.spread || 1; } catch {}
      return mockWriterResp(spread);
    }
    if (label.startsWith('v2.revision')) {
      let spread = 1;
      try { spread = JSON.parse(params.userPrompt).draft?.spread || 1; } catch {}
      return mockWriterResp(spread);
    }
    // Unrecognized label — return neutral OK shape (helps catch missing wiring quickly)
    return jsonResponse({});
  });
}

const rawRequest = {
  bookId: 'happy_test_book',
  format: 'picture_book',
  theme: 'mothers_day',
  child: { name: 'Scarlett', ageMonths: 7, gender: 'girl' },
  customDetails: { interests: ['music', 'lights'] },
  cover: { title: "Scarlett's Soft Evening", imageUrl: 'https://example.test/cover.jpg' },
};

describe('v2 workflow happy path', () => {
  test('end-to-end: planning stages → per-spread loop → illustrator adapter → return shape', async () => {
    wireMocks(10); // PB_INFANT spreadCount = 10
    const { document, layout } = await generateBook(rawRequest, { bookId: 'happy_test_book' });
    expect(document).toBeDefined();
    expect(Array.isArray(document.spreads)).toBe(true);
    expect(document.spreads.length).toBe(10);
    // every spread should carry a manuscript text (from writer) and an illustration (from mocked renderer)
    for (const s of document.spreads) {
      expect(typeof s.manuscript?.text).toBe('string');
      expect(s.manuscript.text.length).toBeGreaterThan(0);
      expect(s.illustration?.imageUrl).toBeDefined();
    }
    expect(layout).toBeDefined();
    expect(document.writerQa?.pass).toBe(true);
    expect(document.bookWideQa?.pass).toBe(true);
  }, 30000);
});
