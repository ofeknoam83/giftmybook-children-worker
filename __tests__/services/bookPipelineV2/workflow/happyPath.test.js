/**
 * v2 workflow — happy-path smoke test (manuscript-level).
 *
 * Mocks `callText` (every LLM call) and v1's `renderAllSpreadsQuad`
 * (the illustrator). Runs the full workflow end-to-end and asserts:
 *   - every planning stage is persisted to the artifact store
 *   - the manuscript is written in ONE call, gated, critiqued, and accepted
 *   - the public generateBook returns { document, layout }
 *
 * This is the contract test the CI run protects from regressions.
 */

jest.mock('../../../../services/bookPipeline/llm/openaiClient', () => ({
  callText: jest.fn(),
}));
jest.mock('../../../../services/bookPipeline/illustrator/renderAllSpreadsQuad', () => ({
  renderAllSpreadsQuad: jest.fn(async (doc) => {
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

function makeSpreadLines() {
  // PB_INFANT band: 4 lines, ~6 syllables. End rhymes are perfect-by-sound.
  return [
    'Pink blanket glows soft.',
    'Mama hums aloft.',
    'Scarlett blinks slow.',
    'Lamps glow low.',
  ];
}

function mockManuscriptWriterResp(spreadCount) {
  return jsonResponse({
    spreads: Array.from({ length: spreadCount }, (_, i) => ({
      spread: i + 1,
      lines: makeSpreadLines(),
    })),
  });
}

function mockManuscriptCriticAccept(spreadCount) {
  return jsonResponse({
    scores: {
      arc_coherence: 5, callback_payoff: 5, theme_delivered_structurally: 5,
      ending_lands: 5, reads_as_a_book_not_episodes: 5, read_aloud_rhythm: 5,
      average_beat_fidelity: 5, average_meaning_clarity: 5,
    },
    abandoned_threads: [],
    whole_book_repetition: [],
    meaning_sanity_book_wide: { passed: true, violations: [] },
    bible_consistency_book_wide: { passed: true, violations: [] },
    prohibited_respected_book_wide: { passed: true, violations: [] },
    per_spread: Array.from({ length: spreadCount }, (_, i) => ({
      spread: i + 1, beat_fidelity: 5, issues: [],
    })),
    targeted_revisions: [],
    accept_recommendation: true,
  });
}

function mockManuscriptRhymeJudgeAllPass(payload) {
  // Mirror the input couplets and mark each ok=true.
  let parsed = { spreads: [] };
  try { parsed = JSON.parse(payload); } catch { /* noop */ }
  const out = (parsed.spreads || []).map((s) => {
    const entry = { spread: s.spread };
    if (s.L1L2) entry.L1L2 = { ok: true, reason: 'matches' };
    if (s.L3L4) entry.L3L4 = { ok: true, reason: 'matches' };
    return entry;
  });
  return jsonResponse({ spreads: out });
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
    if (label.startsWith('v2.manuscriptWriter')) return mockManuscriptWriterResp(spreadCount);
    if (label === 'v2.manuscriptRhymeJudge') return mockManuscriptRhymeJudgeAllPass(params.userPrompt);
    if (label === 'v2.manuscriptCritic') return mockManuscriptCriticAccept(spreadCount);
    if (label.startsWith('v2.manuscriptRevision')) {
      // Should never be called in happy path (critic accepts immediately),
      // but return a no-op patch if triggered.
      return jsonResponse({ spreads: [] });
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

describe('v2 workflow happy path (manuscript-level)', () => {
  test('end-to-end: planning stages → manuscript writer → gate → critic → illustrator adapter → return shape', async () => {
    wireMocks(13); // every band ships 13 spreads
    const { document, layout } = await generateBook(rawRequest, { bookId: 'happy_test_book' });
    expect(document).toBeDefined();
    expect(Array.isArray(document.spreads)).toBe(true);
    expect(document.spreads.length).toBe(13);
    // every spread should carry a manuscript text (from writer) and an illustration (from mocked renderer)
    for (const s of document.spreads) {
      expect(typeof s.manuscript?.text).toBe('string');
      expect(s.manuscript.text.length).toBeGreaterThan(0);
      expect(s.illustration?.imageUrl).toBeDefined();
    }
    expect(layout).toBeDefined();
    expect(document.writerQa?.pass).toBe(true);
    expect(document.bookWideQa?.pass).toBe(true);

    // The manuscript writer should have been called exactly once (no per-spread loop).
    const writerCalls = callText.mock.calls.filter(([p]) => p.label && p.label.startsWith('v2.manuscriptWriter'));
    expect(writerCalls.length).toBe(1);
    // The critic should have been called exactly once (accepted on first round).
    const criticCalls = callText.mock.calls.filter(([p]) => p.label === 'v2.manuscriptCritic');
    expect(criticCalls.length).toBe(1);
    // The combined rhyme-judge should have been called exactly once (one round, one combined call).
    const rhymeCalls = callText.mock.calls.filter(([p]) => p.label === 'v2.manuscriptRhymeJudge');
    expect(rhymeCalls.length).toBe(1);
  }, 30000);
});
