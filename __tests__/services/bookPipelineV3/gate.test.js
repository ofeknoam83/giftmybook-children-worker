const { wordBudgetCheck } = require('../../../services/bookPipelineV3/gate/checks/wordBudget');
const { bannedContentCheck } = require('../../../services/bookPipelineV3/gate/checks/bannedContent');
const { nameLockCheck } = require('../../../services/bookPipelineV3/gate/checks/nameLock');
const { runManuscriptGate, buildChecks, HARD_GATE_CODES } = require('../../../services/bookPipelineV3/gate/runGate');

const PRESCHOOL = {
  ageBand: 'PB_PRESCHOOL',
  band: 'PB_PRESCHOOL',
  narrativeConstraints: {
    wordsPerSpread: { min: 20, max: 50, target: 32 },
    linesPerSpread: { min: 2, max: 4, target: 4 },
  },
};

function draft(text) {
  const lines = text.split('\n');
  return { spread: 1, text, lines };
}

const contract = {
  setting: 'the shore', characters_present: ['Zoe'], hero_action: 'builds a sandcastle',
  emotion: 'wonder', key_objects: ['red bucket'], time_of_day: 'morning', continuity_notes: '',
};

function manuscript(text, form = 'rhythmic_prose') {
  return {
    id: 'A',
    form,
    spreads: [{ spread: 1, text, lines: text.split('\n'), scene_contract: contract, refrain_here: false }],
  };
}

const GOOD_TEXT = 'Zoe carries her red bucket down to the quiet shore.\nShe scoops the cool wet sand and pats it into a tower.\nA small wave tickles her toes and she laughs out loud.';

describe('wordBudget', () => {
  test('passes inside the band window', () => {
    expect(wordBudgetCheck(draft(GOOD_TEXT), null, PRESCHOOL).passed).toBe(true);
  });
  test('fails over budget with the typesetting message', () => {
    const over = draft(Array(60).fill('sand').join(' '));
    const r = wordBudgetCheck(over, null, PRESCHOOL);
    expect(r.passed).toBe(false);
    expect(r.code).toBe('word_budget');
    expect(r.message).toContain('typesetting');
  });
  test('fails under budget', () => {
    expect(wordBudgetCheck(draft('Zoe smiles.'), null, PRESCHOOL).passed).toBe(false);
  });
});

describe('bannedContent', () => {
  test('flags brief-supplied banned elements', () => {
    const r = bannedContentCheck(draft('A big scary dog runs by.'), null, PRESCHOOL, { bannedElements: ['scary dog'] });
    expect(r.passed).toBe(false);
    expect(r.code).toBe('banned_element');
  });
  test('flags moralising phrases via the shared v2 lexicon', () => {
    const r = bannedContentCheck(draft('Always remember to believe in yourself every day.'), null, PRESCHOOL, {});
    expect(r.passed).toBe(false);
    expect(r.code).toBe('moralising_phrase');
  });
  test('passes clean text', () => {
    expect(bannedContentCheck(draft(GOOD_TEXT), null, PRESCHOOL, { bannedElements: ['snake'] }).passed).toBe(true);
  });
});

describe('nameLock', () => {
  test('flags a near-miss capitalized spelling of the name', () => {
    const r = nameLockCheck(draft('Zoey carries her bucket to the shore.'), null, PRESCHOOL, { protagonistName: 'Zoe' });
    expect(r.passed).toBe(false);
    expect(r.code).toBe('name_misspelled');
  });
  test('does not flag the correct name or common words', () => {
    expect(nameLockCheck(draft(GOOD_TEXT), null, PRESCHOOL, { protagonistName: 'Zoe' }).passed).toBe(true);
  });
  test('flags wrong-set pronouns for a she/her book', () => {
    const r = nameLockCheck(draft('Zoe lifts his bucket high.'), null, PRESCHOOL, {
      protagonistName: 'Zoe',
      pronouns: { subject: 'she', object: 'her' },
    });
    expect(r.passed).toBe(false);
    expect(r.code).toBe('pronoun_lock');
  });
  test('skips pronoun check for they/them books', () => {
    const r = nameLockCheck(draft('Zoe lifts his hat and her scarf.'), null, PRESCHOOL, {
      protagonistName: 'Zoe',
      pronouns: { subject: 'they', object: 'them' },
    });
    expect(r.passed).toBe(true);
  });
});

describe('runManuscriptGate', () => {
  test('identityRhyme runs ONLY for rhymed_verse', () => {
    const rhymedChecks = buildChecks('rhymed_verse').map((c) => c.name);
    const proseChecks = buildChecks('rhythmic_prose').map((c) => c.name);
    expect(rhymedChecks).toContain('identityRhyme');
    expect(proseChecks).not.toContain('identityRhyme');
  });

  test('identity rhyme fails a rhymed manuscript', async () => {
    const bad = 'Zoe waves at the tall green trees.\nShe hums a song to the tall green trees.\nThe wind writes circles on the pond.\nA little duck paddles just beyond.';
    const result = await runManuscriptGate(manuscript(bad, 'rhymed_verse'), PRESCHOOL, { protagonistName: 'Zoe' });
    expect(result.passed).toBe(false);
    expect(result.perSpread[0].failures.some((f) => f.code === 'identity_rhyme')).toBe(true);
    expect(result.hardFailureCount).toBeGreaterThan(0);
  });

  test('the same text passes as rhythmic_prose (no rhyme contract)', async () => {
    const sameWords = 'Zoe waves at the tall green trees.\nShe hums a song to the tall green trees.\nThe wind writes circles on the pond.\nA little duck paddles just beyond.';
    const result = await runManuscriptGate(manuscript(sameWords, 'rhythmic_prose'), PRESCHOOL, { protagonistName: 'Zoe' });
    expect(result.perSpread[0].failures.some((f) => f.code === 'identity_rhyme')).toBe(false);
  });

  test('clean manuscript passes and hard codes are wired', async () => {
    const result = await runManuscriptGate(manuscript(GOOD_TEXT), PRESCHOOL, {
      protagonistName: 'Zoe',
      pronouns: { subject: 'she', object: 'her' },
      bannedElements: [],
    });
    expect(result.passed).toBe(true);
    expect(result.hardFailureCount).toBe(0);
    expect(HARD_GATE_CODES.has('word_budget')).toBe(true);
    expect(HARD_GATE_CODES.has('identity_rhyme')).toBe(true);
  });
});
