/**
 * v2 gate — filler phrase blocklist (the AA-CW-26 'at rest' / 'in light' regression class).
 */

const { fillerPhraseBlocklistCheck } = require('../../../../services/bookPipelineV2/gate/checks/fillerPhraseBlocklist');

function draft(lines) { return { text: lines.join('\n'), lines }; }

describe('v2 fillerPhraseBlocklist gate', () => {
  test('clean spread passes', () => {
    const d = draft([
      "Mama's hum is the soft refrain.",
      "Scarlett blinks at the gentle rain.",
      'Light glows gold.',
      'Hands to hold.',
    ]);
    expect(fillerPhraseBlocklistCheck(d).passed).toBe(true);
  });

  test('flags "at rest" as filler ending', () => {
    const d = draft([
      'Mama hums a soft refrain.',
      'Scarlett blinks at the rain.',
      'Light glows gold.',
      'Mama holds her at rest.',
    ]);
    expect(fillerPhraseBlocklistCheck(d).passed).toBe(false);
  });

  test('flags "in light" as filler ending', () => {
    const d = draft([
      'Mama hums and stars take flight.',
      'Scarlett rests in light.',
      'Light glows gold.',
      'Hands to hold.',
    ]);
    expect(fillerPhraseBlocklistCheck(d).passed).toBe(false);
  });

  test('flags "by night" as filler ending', () => {
    const d = draft([
      'Mama hums and stars take flight.',
      'All is calm by night.',
      'Light glows gold.',
      'Hands to hold.',
    ]);
    expect(fillerPhraseBlocklistCheck(d).passed).toBe(false);
  });
});
