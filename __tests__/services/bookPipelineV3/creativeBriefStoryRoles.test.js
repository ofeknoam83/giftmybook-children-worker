'use strict';

/**
 * creativeBrief attaches storyRoles code-side (2026-07-29 QA review):
 * even when the LLM ignores the anecdotes entirely, the casting sheet
 * rides the brief — same pattern as brief.themes and the interests
 * backstop.
 */

jest.mock('../../../services/bookPipelineV3/llm/modelRouter', () => ({
  callWithRole: jest.fn(),
  modelFor: jest.fn(() => ({ family: 'openai', model: 'gpt-5.4' })),
  JUDGE_ROLES: ['JUDGE_A', 'JUDGE_B', 'JUDGE_C'],
}));

const { callWithRole } = require('../../../services/bookPipelineV3/llm/modelRouter');
const { creativeBriefActivity } = require('../../../services/bookPipelineV3/orchestration/activities/creativeBrief');
const { PRESCHOOL_PROFILE } = require('./helpers/fixtures');

const ctx = { log: jest.fn(), bookId: 'b1' };

const briefJson = () => ({
  child_as_character: [
    { detail: 'loves splashing', story_potential: 'water games', load_bearing: true },
  ],
  gift_intent: 'A first-birthday love letter.',
  constraints: { banned_elements: [], safety_notes: [], pronouns: { subject: 'she', object: 'her', possessive: 'her' } },
});

beforeEach(() => {
  callWithRole.mockReset();
  ctx.log.mockClear();
});

describe('creativeBrief storyRoles attachment', () => {
  const rawRequest = {
    childName: 'Liv',
    childAge: 1,
    childGender: 'female',
    childInterests: ['swimming'],
    childAnecdotes: {
      favorite_activities: 'playing and swimming',
      funny_thing: '',
      calls_mom: 'calls everything mama',
      favorite_food: 'strawberries and bananas',
      mom_name: 'Alex',
      dad_name: 'Daniel',
    },
  };

  test('storyRoles are attached deterministically even when the LLM ignores anecdotes', async () => {
    callWithRole.mockResolvedValueOnce({ json: briefJson(), usage: {}, model: 'm' });
    const brief = await creativeBriefActivity({ rawRequest, ageProfile: PRESCHOOL_PROFILE }, ctx);
    expect(brief.storyRoles).toBeTruthy();
    expect(brief.storyRoles.tool.value).toBe('playing and swimming');
    expect(brief.storyRoles.turningPoint.source).toBe('calls_mom');
    expect(brief.storyRoles.finalScene.momName).toBe('Alex');
    expect(brief.storyRoles.finalScene.dadName).toBe('Daniel');
    // The structured anecdotes also reach the brief model's prompt.
    const prompt = JSON.parse(callWithRole.mock.calls[0][1].userPrompt);
    expect(prompt.order.childAnecdotes.favorite_food).toBe('strawberries and bananas');
    // The mama role never surfaced in child_as_character → loud warning.
    expect(ctx.log.mock.calls.some(([level, msg]) => level === 'warn' && msg.includes('turningPoint'))).toBe(true);
  });

  test('no anecdotes → storyRoles falls back to interests-only tool casting', async () => {
    callWithRole.mockResolvedValueOnce({ json: briefJson(), usage: {}, model: 'm' });
    const brief = await creativeBriefActivity(
      { rawRequest: { childName: 'Liv', childInterests: ['swimming'] }, ageProfile: PRESCHOOL_PROFILE },
      ctx,
    );
    expect(brief.storyRoles.tool.value).toBe('swimming');
    expect(brief.storyRoles.finalScene).toBeNull();
  });
});
