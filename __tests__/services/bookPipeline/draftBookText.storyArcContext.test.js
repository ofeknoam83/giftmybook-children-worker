/**
 * AA-CW-5b — `renderStoryArcContext` lifts the load-bearing arc fields from
 * the storyBible into a labeled block at the top of the writer / rewriter
 * prompt. The previous prompt dumped the entire storyBible JSON inline,
 * which buried the arc spine. This block surfaces ONLY the fields that
 * drive arc decisions — narrative spine, beats, motifs, locations — as a
 * contract the writer can refer to from any spread.
 *
 * Also covers the no-op compat stub for `renderInfantContract`: the
 * single source of truth for the infant block now lives in textPolicies,
 * but external imports in rewriteBookText.js etc. should still resolve.
 */
const {
  renderStoryArcContext,
  renderInfantContract,
} = require('../../../services/bookPipeline/writer/draftBookText');
const { AGE_BANDS } = require('../../../services/bookPipeline/constants');

describe('renderStoryArcContext (AA-CW-5b)', () => {
  test('returns "" for null / non-object input', () => {
    expect(renderStoryArcContext(null)).toBe('');
    expect(renderStoryArcContext(undefined)).toBe('');
    expect(renderStoryArcContext('string')).toBe('');
  });

  test('returns "" for empty storyBible (no arc fields populated)', () => {
    expect(renderStoryArcContext({})).toBe('');
    expect(renderStoryArcContext({ unrelatedField: 'x' })).toBe('');
  });

  test('renders the narrative spine and beats as labeled lines', () => {
    const block = renderStoryArcContext({
      title: 'Mama And Me',
      narrativeSpine: 'A baby and Mama trade a single hum across the day.',
      beginningHook: 'A morning hum drifts through the curtains.',
      middleEscalation: 'The hum returns in louder, sillier echoes.',
      endingPayoff: 'The baby hums back, and Mama smiles.',
      emotionalArc: 'wonder → giggle → tender',
      humorStrategy: 'soft sound-jokes, repetition with a twist',
    });
    expect(block).toMatch(/STORY ARC CONTEXT/);
    expect(block).toMatch(/Title:.*Mama And Me/);
    expect(block).toMatch(/Narrative spine: A baby and Mama trade a single hum/);
    expect(block).toMatch(/Beginning hook: A morning hum/);
    expect(block).toMatch(/Middle escalation: The hum returns/);
    expect(block).toMatch(/Ending payoff: The baby hums back/);
    expect(block).toMatch(/Emotional arc: wonder/);
    expect(block).toMatch(/Humor strategy: soft sound-jokes/);
  });

  test('renders array fields (motifs, locations) as bulleted sub-lists', () => {
    const block = renderStoryArcContext({
      narrativeSpine: 'spine',
      cinematicLocations: ['nursery at dawn', 'kitchen with steam', 'garden with light'],
      recurringVisualMotifs: ['yellow blanket', 'hum-shaped breath cloud'],
      personalizationTargets: ['use the favorite-cookie anecdote', 'mention "Mama" by name'],
    });
    expect(block).toMatch(/Cinematic locations:/);
    expect(block).toMatch(/• nursery at dawn/);
    expect(block).toMatch(/• kitchen with steam/);
    expect(block).toMatch(/Recurring visual motifs:/);
    expect(block).toMatch(/• yellow blanket/);
    expect(block).toMatch(/Personalization targets:/);
    expect(block).toMatch(/• use the favorite-cookie anecdote/);
  });

  test('explains how to use arcContext.callbackToSpread in the trailer', () => {
    const block = renderStoryArcContext({
      narrativeSpine: 'a single chord, planted, escalated, resolved',
    });
    // The trailer line teaches the writer how to use callbacks across
    // spreads — this is what makes the rhyme feel like a book, not 12 ads.
    expect(block).toMatch(/callbackToSpread/);
    expect(block).toMatch(/escalate/i);
    expect(block).toMatch(/resolve|callback/i);
  });

  test('skips empty / whitespace-only fields without leaving label-only lines', () => {
    const block = renderStoryArcContext({
      narrativeSpine: 'spine ok',
      beginningHook: '   ',
      middleEscalation: '',
      endingPayoff: null,
      emotionalArc: undefined,
      cinematicLocations: ['', '   ', 'real location'],
    });
    expect(block).toMatch(/Narrative spine: spine ok/);
    expect(block).not.toMatch(/Beginning hook:/);
    expect(block).not.toMatch(/Middle escalation:/);
    expect(block).not.toMatch(/Ending payoff:/);
    expect(block).not.toMatch(/Emotional arc:/);
    // Array filters: keep only the real entry.
    expect(block).toMatch(/• real location/);
    expect(block).not.toMatch(/•\s*$/m);
  });
});

describe('renderInfantContract — AA-CW-5b no-op compat stub', () => {
  test('returns "" for every age band (single source of truth lives in textPolicies)', () => {
    expect(renderInfantContract(AGE_BANDS.PB_INFANT)).toBe('');
    expect(renderInfantContract(AGE_BANDS.PB_TODDLER)).toBe('');
    expect(renderInfantContract(AGE_BANDS.PB_PRESCHOOL)).toBe('');
    expect(renderInfantContract(undefined)).toBe('');
  });
});
