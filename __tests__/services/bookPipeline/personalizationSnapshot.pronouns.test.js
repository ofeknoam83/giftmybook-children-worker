/**
 * AA-CW-5b — personalization snapshot must surface the canonical pronoun
 * set at the top of the snapshot for both planner LLMs (createStoryBible
 * and createSpreadSpecs). This guarantees the storyBible / spread specs
 * never drift from the pronoun set the writer / rewriter use.
 *
 * The PRONOUNS line must:
 *  - Appear FIRST when present, before INTERESTS / APPEARANCE / questionnaire.
 *  - Be omitted entirely if pronouns is not provided (back-compat).
 *  - Be omitted if any of subject/object/possessive/reflexive is missing.
 */
const {
  renderPersonalizationSnapshotForPlanner,
} = require('../../../services/bookPipeline/planner/personalizationSnapshot');

describe('renderPersonalizationSnapshotForPlanner — pronouns line (AA-CW-5b)', () => {
  test('renders PRONOUNS line first when full set is provided', () => {
    const snap = renderPersonalizationSnapshotForPlanner(
      { interests: ['dinosaurs', 'rockets'], appearance: 'curly hair' },
      {},
      { subject: 'she', object: 'her', possessive: 'her', reflexive: 'herself' },
    );
    const lines = snap.split('\n');
    // Header is line 0; PRONOUNS must be the FIRST content line.
    expect(lines[0]).toMatch(/PERSONALIZATION SNAPSHOT/);
    expect(lines[1]).toMatch(/^PRONOUNS/);
    expect(lines[1]).toContain('subject=she');
    expect(lines[1]).toContain('object=her');
    expect(lines[1]).toContain('possessive=her');
    expect(lines[1]).toContain('reflexive=herself');
    // INTERESTS still rendered, AFTER pronouns.
    expect(snap).toMatch(/INTERESTS .*dinosaurs/);
    const pronounIdx = snap.indexOf('PRONOUNS');
    const interestsIdx = snap.indexOf('INTERESTS');
    expect(pronounIdx).toBeLessThan(interestsIdx);
  });

  test('renders pronouns as the only personalization line when child is sparse', () => {
    const snap = renderPersonalizationSnapshotForPlanner(
      {},
      {},
      { subject: 'they', object: 'them', possessive: 'their', reflexive: 'themself' },
    );
    expect(snap).toMatch(/PRONOUNS/);
    expect(snap).toContain('subject=they');
    expect(snap).toContain('reflexive=themself');
    // Still includes the snapshot header.
    expect(snap).toMatch(/PERSONALIZATION SNAPSHOT/);
  });

  test('omits PRONOUNS line entirely when pronouns argument is null/undefined (back-compat)', () => {
    const snap = renderPersonalizationSnapshotForPlanner(
      { interests: ['cats'] },
      {},
      null,
    );
    expect(snap).not.toMatch(/PRONOUNS/);
    expect(snap).toMatch(/INTERESTS .*cats/);
    // Calling with two args (legacy) must also work.
    const snap2 = renderPersonalizationSnapshotForPlanner({ interests: ['cats'] }, {});
    expect(snap2).not.toMatch(/PRONOUNS/);
  });

  test('omits PRONOUNS line if any of the four pronoun fields is missing', () => {
    const snap = renderPersonalizationSnapshotForPlanner(
      { interests: ['dogs'] },
      {},
      // Missing reflexive — incomplete set, do not surface a half-formed line.
      { subject: 'he', object: 'him', possessive: 'his' },
    );
    expect(snap).not.toMatch(/PRONOUNS/);
    expect(snap).toMatch(/INTERESTS .*dogs/);
  });

  test('warns the writer to never swap or alternate pronouns', () => {
    // The line must explicitly carry the "use ONLY these, never swap, never
    // alternate" warning so the planner LLM treats it as a hard contract,
    // not a hint. This wording mirrors the writer pronounBlock so both
    // surfaces of the pipeline reinforce the same instruction.
    const snap = renderPersonalizationSnapshotForPlanner(
      {},
      {},
      { subject: 'she', object: 'her', possessive: 'her', reflexive: 'herself' },
    );
    expect(snap).toMatch(/never swap/i);
    expect(snap).toMatch(/never alternate/i);
  });
});
