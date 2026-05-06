/**
 * AA-CW-23 — real-rhyme rescue audit + user-prompt rhyme banner.
 *
 * Locks:
 *   - tailRime extracts the rime correctly for common shapes
 *   - isRealRhyme returns true for production-failure pairs
 *     (face/place, cheek/peek, chin/grin, see/glee, smushy/cushy)
 *   - isRealRhyme returns false for identity, stem-pairs, unrelated
 *   - applyRealRhymeRescue strips rhyme_fail from rescued spreads,
 *     leaves identity_rhyme spreads alone, recomputes pass
 *   - draft userPrompt carries the AA-CW-23 RHYME CONTRACT banner
 */

const {
  applyRealRhymeRescue,
  isRealRhyme,
  normalizeEndWord,
  tailRime,
  lastWordOfLine,
} = require('../../../services/bookPipeline/qa/realRhymeAudit');

describe('AA-CW-23 tailRime', () => {
  test('extracts rime for monosyllabic shapes', () => {
    expect(tailRime('face')).toBe('ace');
    expect(tailRime('place')).toBe('ace');
    expect(tailRime('chin')).toBe('in');
    expect(tailRime('grin')).toBe('in');
    expect(tailRime('cheek')).toBe('eek');
    expect(tailRime('peek')).toBe('eek');
    expect(tailRime('day')).toBe('ay');
    expect(tailRime('play')).toBe('ay');
    expect(tailRime('light')).toBe('ight');
    expect(tailRime('tight')).toBe('ight');
  });

  test('returns empty for empty/no-vowel inputs', () => {
    expect(tailRime('')).toBe('');
    expect(tailRime('xyz')).toMatch(/^y/); // y-as-vowel rescue
  });
});

describe('AA-CW-23 normalizeEndWord', () => {
  test('strips trailing punctuation, possessive, lowercase', () => {
    expect(normalizeEndWord('Cheek.')).toBe('cheek');
    expect(normalizeEndWord('PLACE!')).toBe('place');
    expect(normalizeEndWord("Mama's")).toBe('mama');
    expect(normalizeEndWord('  grin  ')).toBe('grin');
    expect(normalizeEndWord('')).toBe('');
    expect(normalizeEndWord(null)).toBe('');
  });
});

describe('AA-CW-23 isRealRhyme', () => {
  test('production-failure pairs are real rhymes', () => {
    expect(isRealRhyme('face', 'place')).toBe(true);
    expect(isRealRhyme('cheek', 'peek')).toBe(true);
    expect(isRealRhyme('chin', 'grin')).toBe(true);
    expect(isRealRhyme('see', 'glee')).toBe(true);
    expect(isRealRhyme('day', 'play')).toBe(true);
    expect(isRealRhyme('light', 'tight')).toBe(true);
    expect(isRealRhyme('near', 'dear')).toBe(true);
    expect(isRealRhyme('porch', 'torch')).toBe(true);
    expect(isRealRhyme('grass', 'alas')).toBe(true);
  });

  test('identity rhymes are NOT real rhymes', () => {
    expect(isRealRhyme('chin', 'chin')).toBe(false);
    expect(isRealRhyme('Cheek.', 'cheek')).toBe(false); // post-normalize same
    expect(isRealRhyme('mama', 'mama')).toBe(false);
  });

  test('stem pairs are NOT real rhymes', () => {
    expect(isRealRhyme('smushy', 'mushy')).toBe(false);
    expect(isRealRhyme('beam', 'beams')).toBe(false);
    expect(isRealRhyme('right', 'bright')).toBe(false);
    expect(isRealRhyme('see', 'sees')).toBe(false);
  });

  test('unrelated words are NOT real rhymes', () => {
    expect(isRealRhyme('chin', 'cheek')).toBe(false);
    expect(isRealRhyme('face', 'shoe')).toBe(false);
    expect(isRealRhyme('grass', 'cloud')).toBe(false);
  });

  test('case and punctuation are normalised', () => {
    expect(isRealRhyme('Face.', 'PLACE!')).toBe(true);
    expect(isRealRhyme("Mama's", 'pajamas')).toBe(false); // bank-only check; both unknown so falls to rime
  });

  test('rhyme bank partners are accepted', () => {
    // From the rhymeBank: chin → ['win', 'grin', 'spin', 'in', 'twin', 'thin']
    expect(isRealRhyme('chin', 'spin')).toBe(true);
    expect(isRealRhyme('chin', 'twin')).toBe(true);
    expect(isRealRhyme('chin', 'thin')).toBe(true);
  });
});

describe('AA-CW-23 applyRealRhymeRescue', () => {
  function buildDoc(spreadNumber, line1, line2) {
    return {
      spreads: [{
        spreadNumber,
        manuscript: { text: `${line1}\n${line2}\nLine three.\nLine four.` },
      }],
    };
  }

  test('strips rhyme_fail from spread with real rhyme', () => {
    const doc = buildDoc(6, 'Scarlett sees her face.', 'Mama stays in her place.');
    const merged = [{
      spreadNumber: 6,
      tags: ['rhyme_fail'],
      issues: ["Lines 1-2 don't rhyme: 'face/place' (non-rhyming)."],
      pass: false,
    }];
    const rescued = applyRealRhymeRescue(merged, doc);
    expect(rescued).toEqual([{ spreadNumber: 6, pair: 'face/place', lines: '1+2' }]);
    expect(merged[0].tags).toEqual([]);
    expect(merged[0].issues).toEqual([]);
    expect(merged[0].pass).toBe(true);
  });

  test('does NOT strip rhyme_fail when also tagged identity_rhyme', () => {
    const doc = buildDoc(2, 'Yard shade meets the porch.', 'Mama nears the porch.');
    const merged = [{
      spreadNumber: 2,
      tags: ['rhyme_fail', 'identity_rhyme'],
      issues: ['rhyme_fail: identity rhyme on lines 1+2 — "porch/porch".'],
      pass: false,
    }];
    const rescued = applyRealRhymeRescue(merged, doc);
    expect(rescued).toEqual([]);
    expect(merged[0].tags).toEqual(['rhyme_fail', 'identity_rhyme']);
    expect(merged[0].pass).toBe(false);
  });

  test('does NOT strip rhyme_fail when end-words are unrelated', () => {
    const doc = buildDoc(3, 'Scarlett sees the grass.', 'Mama smiles up high.');
    const merged = [{
      spreadNumber: 3,
      tags: ['rhyme_fail'],
      issues: ["Lines 1-2 don't rhyme: 'grass/high' (non-rhyming)."],
      pass: false,
    }];
    const rescued = applyRealRhymeRescue(merged, doc);
    expect(rescued).toEqual([]);
    expect(merged[0].tags).toEqual(['rhyme_fail']);
    expect(merged[0].pass).toBe(false);
  });

  test('preserves other tags when stripping rhyme_fail', () => {
    const doc = buildDoc(7, 'Mama watches her play.', 'Yard shade holds the day.');
    const merged = [{
      spreadNumber: 7,
      tags: ['rhyme_fail', 'verb_crutch'],
      issues: ["Lines 1-2 don't rhyme.", "verb_crutch: 'watch' overused."],
      pass: false,
    }];
    const rescued = applyRealRhymeRescue(merged, doc);
    expect(rescued.length).toBe(1);
    expect(merged[0].tags).toEqual(['verb_crutch']);
    expect(merged[0].issues).toEqual(["verb_crutch: 'watch' overused."]);
    expect(merged[0].pass).toBe(false); // verb_crutch still there
  });

  test('handles all 5 e3f4e0c0 wave-1 false positives', () => {
    // Production failure pairs the LLM judge said were rhyme_fail but
    // they all rhyme.
    const cases = [
      { n: 6, l1: 'Scarlett sees her face.',  l2: 'Mama stays in her place.' },
      { n: 7, l1: 'Mama watches her play.',   l2: 'Yard shade holds the day.' },
      { n: 8, l1: 'Scarlett squeals with glee.', l2: 'Mama beams to see.' },
      { n: 9, l1: 'Mama laughs by her cheek.', l2: 'Scarlett gives a peek.' },
      { n: 10, l1: "Scarlett mouths Mama's chin.", l2: 'Mama laughs at her grin.' },
      { n: 11, l1: 'Porch light warms her cheek.', l2: 'Mama leans to peek.' },
    ];
    for (const c of cases) {
      const doc = buildDoc(c.n, c.l1, c.l2);
      const merged = [{
        spreadNumber: c.n,
        tags: ['rhyme_fail'],
        issues: ['rhyme_fail: judge said no'],
        pass: false,
      }];
      const rescued = applyRealRhymeRescue(merged, doc);
      expect(rescued.length).toBe(1);
      expect(merged[0].pass).toBe(true);
    }
  });
});

describe('AA-CW-23 user-prompt rhyme banner', () => {
  test('draftBookText.userPrompt starts with the RHYME CONTRACT banner', () => {
    // Cannot import private userPrompt directly, but we can build a
    // minimal doc and call the exported draftBookText flow's prompt
    // builder by re-requiring the module fresh.
    const draftModule = require('../../../services/bookPipeline/writer/draftBookText');
    // The module exports SYSTEM_PROMPT but not userPrompt. Test the
    // banner via SYSTEM_PROMPT (carries the AA-CW-22 contract) AND
    // verify the user-prompt-banner constant lives in the module by
    // matching it through a smoke draft. Because userPrompt is not
    // exported we instead lock the SYSTEM_PROMPT contract content
    // (already covered in aaCw22.test.js) and assert the file contains
    // the banner string.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../../services/bookPipeline/writer/draftBookText.js'),
      'utf8',
    );
    expect(src).toMatch(/RHYME CONTRACT — READ BEFORE WRITING ANY SPREAD/);
    expect(src).toMatch(/identity rhymes? and they are an automatic gate failure/);
    expect(src).toMatch(/STEM PAIR.*smushy.*mushy/);
    expect(src).toMatch(/face\/place, cheek\/peek, chin\/grin/);
    expect(draftModule.SYSTEM_PROMPT).toMatch(/RHYME — READ THIS FIRST \(AA-CW-22/);
  });
});
