/**
 * AA-CW-22 — rhyme bank + tightened first-draft rhyme contract.
 *
 * Locks the changes that came out of the e3f4e0c0 production failure
 * post-AA-CW-21:
 *   - lookupRhymes() returns hand-curated partners for common end-words
 *     (chin → grin/win/spin/...).
 *   - lastWord() strips trailing punctuation and possessive 's.
 *   - rewriteUserPrompt injects rhymeBank + rhymeBankWord onto items
 *     whose killing tags include rhyme_fail or identity_rhyme.
 *   - rewriter SYSTEM_PROMPT carries the AA-CW-22 RHYME contract,
 *     including the rhymeBank instruction.
 *   - draft SYSTEM_PROMPT carries the AA-CW-22 RHYME contract.
 */

const { lookupRhymes, lastWord, RHYME_BANK } = require('../../../services/bookPipeline/writer/rhymeBank');
const rewriteModule = require('../../../services/bookPipeline/writer/rewriteBookText');
const draftModule = require('../../../services/bookPipeline/writer/draftBookText');

describe('AA-CW-22 rhyme bank', () => {
  test('lookupRhymes returns curated partners for common infant end-words', () => {
    const chinPartners = lookupRhymes('chin');
    expect(chinPartners.length).toBeGreaterThanOrEqual(4);
    expect(chinPartners).toEqual(expect.arrayContaining(['grin', 'spin']));
    // The bank must NOT include the same word back (no identity).
    expect(chinPartners).not.toContain('chin');
  });

  test('lookupRhymes is case-insensitive and strips punctuation/possessive', () => {
    expect(lookupRhymes('Chin.').length).toBeGreaterThan(0);
    expect(lookupRhymes('CHIN!').length).toBeGreaterThan(0);
    expect(lookupRhymes('  leaf, ').length).toBeGreaterThan(0);
    expect(lookupRhymes("Mama's").length).toBe(0); // unknown
  });

  test('lookupRhymes returns [] for unknown words', () => {
    expect(lookupRhymes('xyzzy')).toEqual([]);
    expect(lookupRhymes('')).toEqual([]);
    expect(lookupRhymes(null)).toEqual([]);
    expect(lookupRhymes(undefined)).toEqual([]);
  });

  test('lookupRhymes never returns identity rhymes', () => {
    for (const key of Object.keys(RHYME_BANK)) {
      const partners = lookupRhymes(key);
      expect(partners).not.toContain(key);
    }
  });

  test('lastWord extracts the final alpha word, stripping punctuation', () => {
    expect(lastWord('Scarlett sees a leaf.')).toBe('leaf');
    expect(lastWord('Mama holds her tight!')).toBe('tight');
    expect(lastWord('  trailing space  ')).toBe('space');
    expect(lastWord('')).toBe('');
    expect(lastWord(null)).toBe('');
  });

  test('rhymeBank covers all the end-words from the e3f4e0c0 failure', () => {
    // Production failure had identity rhymes on these words. The bank
    // must give the rewriter real partners to choose from.
    for (const word of ['chin', 'leaf', 'lap', 'face', 'gate', 'wrap']) {
      const partners = lookupRhymes(word);
      expect(partners.length).toBeGreaterThan(0);
    }
  });
});

describe('AA-CW-22 rewriter prompt wires rhymeBank into items', () => {
  function buildDoc({ tags, line1 }) {
    return {
      brief: { child: { name: 'Scarlett' }, pronouns: { subject: 'she', object: 'her', possessive: 'her', reflexive: 'herself' } },
      request: { ageBand: '0-1', format: 'picture_book' },
      storyBible: {},
      spreads: [
        {
          spreadNumber: 3,
          spec: { proseProps: [], arcContext: {} },
          manuscript: {
            text: `${line1}\nMama holds her brief.\nAir stirs the wrap.\nScarlett hears the porch.`,
            side: 'left',
            lineBreakHints: [],
            personalizationUsed: [],
            writerNotes: null,
          },
        },
      ],
      writerRewriteMemory: {},
      writerRewriteRejectionCount: {},
    };
  }

  test('items carry rhymeBank + rhymeBankWord when tags include rhyme_fail', () => {
    const doc = buildDoc({ tags: ['rhyme_fail'], line1: 'Scarlett sees a leaf.' });
    const targets = [{ spreadNumber: 3, issues: ['rhyme_fail'], tags: ['rhyme_fail'], suggestedRewrite: null }];
    const prompt = rewriteModule.rewriteUserPrompt(doc, targets);
    expect(prompt).toContain('"rhymeBankWord": "leaf"');
    expect(prompt).toMatch(/"rhymeBank":\s*\[/);
    // bank should include real partners for leaf
    expect(prompt).toMatch(/"tree"/);
  });

  test('items carry rhymeBank when tags include identity_rhyme', () => {
    const doc = buildDoc({ tags: ['identity_rhyme'], line1: 'Scarlett mouths Mama\'s chin.' });
    const targets = [{ spreadNumber: 3, issues: ['identity_rhyme'], tags: ['identity_rhyme'], suggestedRewrite: null }];
    const prompt = rewriteModule.rewriteUserPrompt(doc, targets);
    expect(prompt).toContain('"rhymeBankWord": "chin"');
    expect(prompt).toMatch(/"grin"/);
  });

  test('items DO NOT carry rhymeBank when tags do not include rhyme tags', () => {
    const doc = buildDoc({ tags: ['dropped_article'], line1: 'Scarlett rests in lap.' });
    const targets = [{ spreadNumber: 3, issues: ['dropped_article'], tags: ['dropped_article'], suggestedRewrite: null }];
    const prompt = rewriteModule.rewriteUserPrompt(doc, targets);
    expect(prompt).not.toContain('"rhymeBank"');
    expect(prompt).not.toContain('"rhymeBankWord"');
  });

  test('items omit rhymeBank when end-word is unknown to the bank', () => {
    const doc = buildDoc({ tags: ['rhyme_fail'], line1: 'Scarlett sees a xyzzy.' });
    const targets = [{ spreadNumber: 3, issues: ['rhyme_fail'], tags: ['rhyme_fail'], suggestedRewrite: null }];
    const prompt = rewriteModule.rewriteUserPrompt(doc, targets);
    expect(prompt).not.toContain('"rhymeBank"');
  });
});

describe('AA-CW-22 system prompts carry the new rhyme contract', () => {
  test('rewriter SYSTEM_PROMPT carries the AA-CW-22 RHYME block', () => {
    const sp = rewriteModule.SYSTEM_PROMPT;
    expect(sp).toMatch(/RHYME — READ THIS FIRST \(AA-CW-22/);
    expect(sp).toMatch(/identity rhyme/);
    expect(sp).toMatch(/rhymeBank/);
    expect(sp).toMatch(/DROPPED ARTICLES/);
  });

  test('draft SYSTEM_PROMPT carries the AA-CW-22 RHYME block', () => {
    const sp = draftModule.SYSTEM_PROMPT;
    expect(sp).toMatch(/RHYME — READ THIS FIRST \(AA-CW-22/);
    expect(sp).toMatch(/identity rhyme/);
    expect(sp).toMatch(/DROPPED ARTICLES/);
    expect(sp).toMatch(/read lines 1\+2 aloud/);
  });
});
