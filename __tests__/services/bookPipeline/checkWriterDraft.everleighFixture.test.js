/**
 * PR D / D.9 \u2014 Everleigh draft fixture.
 *
 * Re-creates the 13-spread infant Mother's Day book that motivated PR D.
 * Each spread reproduces a SPECIFIC failure mode the previous QA layer
 * missed; this test asserts every PR D detector trips against the
 * relevant spread(s).
 *
 * If a future regression silently disables one of the detectors, this
 * fixture will catch it: the `expectations` table below pins each tag to
 * the spread it should fire on.
 */

const {
  findInfantForbiddenActionVerbs,
  findNonsenseWords,
  findNonsenseSimiles,
  findParentThemePeerFraming,
  findRefrainCrutches,
} = require('../../../services/bookPipeline/qa/checkWriterDraft');
const { AGE_BANDS } = require('../../../services/bookPipeline/constants');

// Reconstructed from the user-pasted draft. Each spread is a 4-line couplet
// block (the writer's incorrect output \u2014 PR D enforces 2 lines instead).
// Marked-up problems are intentional and serve as test inputs.
const EVERLEIGH_SPREADS = [
  // 1: \"best friends\" peer framing on a Mother's Day book
  { spreadNumber: 1, manuscript: { text: 'Mama and me, best friends today.\nPeekaboo through the morning light.\nGiggle-soft, the room turns bright.\nWe smile and start to play.' } },
  // 2: clean(ish) \u2014 control spread with no PR D violations
  { spreadNumber: 2, manuscript: { text: 'Mama hums a quiet little tune.\nA scarf flutters past the moon.\nShe coos and Mama coos right back.\nThe morning settles, soft and slack.' } },
  // 3: clean control
  { spreadNumber: 3, manuscript: { text: 'Mama lifts the scarf up high.\nIt floats just like a cloud goes by.\nShe blinks. She looks. She holds her thumb.\nThe blanket warms and Mama hums.' } },
  // 4: jumps \u2014 infant_action_verb_in_text
  { spreadNumber: 4, manuscript: { text: 'Up jumps Everleigh, soft and small.\nMama catches before the fall.\nPeekaboo behind the chair.\nGiggle-flutter through the air.' } },
  // 5: race + nonsense_simile (\"light as code\")
  { spreadNumber: 5, manuscript: { text: 'They race in golden light, so wide.\nBlanket light as code, no road.\nMama leans, she leans in close.\nA tiny giggle, soft and slow.' } },
  // 6: clean control
  { spreadNumber: 6, manuscript: { text: 'Mama tucks her in the swing.\nA sleepy hum, a quiet thing.\nThe scarf drifts down across her knee.\nA peekaboo for Mama and me.' } },
  // 7: feet flash + best friends
  { spreadNumber: 7, manuscript: { text: 'Her feet flash past the morning bench.\nMama and me, best friends, content.\nPeekaboo, the scarf goes round.\nA tiny giggle, the only sound.' } },
  // 8: spin
  { spreadNumber: 8, manuscript: { text: 'Pop up, then spin around the rug.\nMama lifts her in a hug.\nThe scarf goes high, the scarf comes down.\nWe smile, we share the sleepy frown.' } },
  // 9: twirl + nonsense_word \"farf\"
  { spreadNumber: 9, manuscript: { text: 'They twirl in grin, the room a song.\nNot farf, the scarf comes along.\nMama coos, she coos again.\nA tiny smile, a tiny grin.' } },
  // 10: walk + best friends
  { spreadNumber: 10, manuscript: { text: 'They walk the sunny morning track.\nMama and me, best friends, no lack.\nThe scarf goes up, the scarf comes back.\nPeekaboo, a tiny clack.' } },
  // 11: hop
  { spreadNumber: 11, manuscript: { text: 'Best friends hop into chance and gleam.\nMama and me, a daytime dream.\nThe scarf flutters, the morning glows.\nA tiny smile, a tiny doze.' } },
  // 12: clean control
  { spreadNumber: 12, manuscript: { text: "Mama holds her, calm and near.\nThe scarf is bright, the day is clear.\nShe coos, she sighs, she settles in.\nThe morning ends with Mama's grin." } },
  // 13: best friends final repeat \u2014 closing the refrain
  { spreadNumber: 13, manuscript: { text: 'Best friends forever, Mama and me.\nThe scarf, the rug, the sleepy sea.\nA peekaboo, a final hum.\nA tiny smile, a tiny thumb.' } },
];

describe('Everleigh fixture (PR D / D.9) \u2014 every flagged failure must trip', () => {
  const brief = {
    child: { name: 'Everleigh' },
    customDetails: { mom_name: 'Courtney' },
  };
  const ageBand = AGE_BANDS.PB_INFANT;
  const theme = 'mothers_day';

  test('D.2 infant_action_verb_in_text fires on spreads 4, 5, 7, 8, 9, 10, 11', () => {
    const expected = new Set([4, 5, 7, 8, 9, 10, 11]);
    const trippedOn = new Set();
    for (const s of EVERLEIGH_SPREADS) {
      const verbs = findInfantForbiddenActionVerbs(s.manuscript.text, ageBand);
      if (verbs.length > 0) trippedOn.add(s.spreadNumber);
    }
    for (const n of expected) {
      expect(trippedOn).toContain(n);
    }
  });

  test('D.3 nonsense_word fires on spread 9 (\"farf\")', () => {
    const s = EVERLEIGH_SPREADS.find(x => x.spreadNumber === 9);
    const out = findNonsenseWords(s.manuscript.text, brief);
    expect(out.map(w => w.toLowerCase())).toContain('farf');
  });

  test('D.4 nonsense_simile fires on spread 5 (\"light as code\")', () => {
    const s = EVERLEIGH_SPREADS.find(x => x.spreadNumber === 5);
    const out = findNonsenseSimiles(s.manuscript.text);
    expect(out.length).toBeGreaterThan(0);
    expect(out.join(' ').toLowerCase()).toContain('light as code');
  });

  test('D.5 parent_theme_relationship_framing fires on spreads 1, 7, 10, 11, 13', () => {
    const expected = new Set([1, 7, 10, 11, 13]);
    const trippedOn = new Set();
    for (const s of EVERLEIGH_SPREADS) {
      const out = findParentThemePeerFraming(s.manuscript.text, theme);
      if (out.length > 0) trippedOn.add(s.spreadNumber);
    }
    for (const n of expected) {
      expect(trippedOn).toContain(n);
    }
  });

  test('D.6 refrain_crutch fires for \"peekaboo\" \u2014 5+ spreads (\u226525%)', () => {
    const out = findRefrainCrutches(EVERLEIGH_SPREADS);
    const peekaboo = out.find(o => o.word === 'peekaboo');
    expect(peekaboo).toBeDefined();
    expect(peekaboo.spreadCount).toBeGreaterThanOrEqual(5);
    expect(peekaboo.ratio).toBeGreaterThan(0.25);
  });

  test('D.5 does NOT fire when the same text is paired with a non-parent theme', () => {
    // Sanity: the peer-framing detector is theme-conditional.
    const s = EVERLEIGH_SPREADS.find(x => x.spreadNumber === 1);
    const out = findParentThemePeerFraming(s.manuscript.text, 'birthday');
    expect(out).toEqual([]);
  });

  test('D.3 does NOT fire on the declared child name across all spreads', () => {
    for (const s of EVERLEIGH_SPREADS) {
      const out = findNonsenseWords(s.manuscript.text, brief);
      expect(out.map(w => w.toLowerCase())).not.toContain('everleigh');
    }
  });
});
