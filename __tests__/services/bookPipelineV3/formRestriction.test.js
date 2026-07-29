'use strict';

/**
 * Band form restriction (2026-07-29 QA review): sparse_lyric — the Liv
 * book's fragment/mood failure style — is not available for INFANT/TODDLER.
 * Concept stage coerces loudly; writer stage throws (retry regenerates).
 */

jest.mock('../../../services/bookPipelineV3/llm/modelRouter', () => ({
  callWithRole: jest.fn(),
  modelFor: jest.fn(() => ({ family: 'openai', model: 'gpt-5.4' })),
  JUDGE_ROLES: ['JUDGE_A', 'JUDGE_B', 'JUDGE_C'],
}));

const { callWithRole } = require('../../../services/bookPipelineV3/llm/modelRouter');
const { conceptRoomActivity, CONCEPT_ANGLES } = require('../../../services/bookPipelineV3/orchestration/activities/conceptRoom');
const { manuscriptWriterActivity } = require('../../../services/bookPipelineV3/orchestration/activities/manuscriptWriter');
const { getAgeProfile } = require('../../../services/bookPipelineV3/ageProfiles');
const {
  PRESCHOOL_PROFILE, BRIEF, makeConceptJson, makeManuscriptJson,
} = require('./helpers/fixtures');

const ctx = { log: jest.fn(), bookId: 'b1' };
const resp = (json) => ({ json, usage: { inputTokens: 1, outputTokens: 1 }, model: 'test-model' });
const angle = CONCEPT_ANGLES[0];

beforeEach(() => {
  callWithRole.mockReset();
  ctx.log.mockClear();
});

describe('age profiles declare allowedForms', () => {
  test('sparse_lyric is unavailable below preschool', () => {
    expect(getAgeProfile('PB_INFANT').narrativeConstraints.allowedForms).toEqual(['rhymed_verse', 'rhythmic_prose']);
    expect(getAgeProfile('PB_TODDLER').narrativeConstraints.allowedForms).toEqual(['rhymed_verse', 'rhythmic_prose']);
    expect(getAgeProfile('PB_PRESCHOOL').narrativeConstraints.allowedForms).toContain('sparse_lyric');
    expect(getAgeProfile('PB_EARLY_READER').narrativeConstraints.allowedForms).toContain('sparse_lyric');
  });
});

describe('conceptRoom form coercion', () => {
  const toddler = getAgeProfile('PB_TODDLER');

  test('a sparse_lyric concept for a toddler is coerced to rhythmic_prose, loudly', async () => {
    callWithRole.mockResolvedValueOnce(resp({ ...makeConceptJson(angle.id), form_choice: 'sparse_lyric' }));
    const concept = await conceptRoomActivity(
      { brief: BRIEF, ageProfile: toddler, theme: 'adventure', spreadCount: 13, angle }, ctx,
    );
    expect(concept.form_choice).toBe('rhythmic_prose');
    expect(ctx.log.mock.calls.some(([lvl, msg]) => lvl === 'warn' && msg.includes('coercing'))).toBe(true);
    // The prompt told the model which forms were available.
    const prompt = JSON.parse(callWithRole.mock.calls[0][1].userPrompt);
    expect(prompt.allowed_forms).toEqual(['rhymed_verse', 'rhythmic_prose']);
  });

  test('sparse_lyric survives for preschool (no allowedForms restriction hit)', async () => {
    callWithRole.mockResolvedValueOnce(resp({ ...makeConceptJson(angle.id), form_choice: 'sparse_lyric' }));
    const concept = await conceptRoomActivity(
      { brief: BRIEF, ageProfile: getAgeProfile('PB_PRESCHOOL'), theme: 'adventure', spreadCount: 13, angle }, ctx,
    );
    expect(concept.form_choice).toBe('sparse_lyric');
  });

  test('profiles without allowedForms (legacy fixtures) accept every form', async () => {
    callWithRole.mockResolvedValueOnce(resp({ ...makeConceptJson(angle.id), form_choice: 'sparse_lyric' }));
    const concept = await conceptRoomActivity(
      { brief: BRIEF, ageProfile: PRESCHOOL_PROFILE, theme: 'adventure', spreadCount: 13, angle }, ctx,
    );
    expect(concept.form_choice).toBe('sparse_lyric');
  });
});

describe('manuscriptWriter form assertion', () => {
  const toddlerProfile = () => {
    const p = getAgeProfile('PB_TODDLER');
    // Keep fixture spreads inside the band window irrelevant — the writer
    // activity does not gate; only the form assertion is under test.
    return p;
  };

  test('a writer that drifted into sparse_lyric for a toddler throws (retry regenerates)', async () => {
    callWithRole.mockResolvedValueOnce(resp({ ...makeManuscriptJson(13), form: 'sparse_lyric' }));
    await expect(manuscriptWriterActivity({
      brief: BRIEF, ageProfile: toddlerProfile(), concept: makeConceptJson(angle.id), spreadCount: 13, variant: 'A',
    }, ctx)).rejects.toThrow(/not allowed for band PB_TODDLER/);
  });

  test('an allowed form passes through', async () => {
    callWithRole.mockResolvedValueOnce(resp(makeManuscriptJson(13)));
    const m = await manuscriptWriterActivity({
      brief: BRIEF, ageProfile: toddlerProfile(), concept: makeConceptJson(angle.id), spreadCount: 13, variant: 'A',
    }, ctx);
    expect(m.form).toBe('rhythmic_prose');
  });
});
