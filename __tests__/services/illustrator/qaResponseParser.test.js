/**
 * Unit tests for the shared QA response parser.
 *
 * Covers the bug we hit in production: consistencyQa responses being
 * truncated mid-JSON because gemini-2.5-flash with thinkingBudget=0 has an
 * implicit output cap that doesn't fit the full schema. The parser's old
 * greedy {[\s\S]*} regex couldn't recover (it requires a closing brace),
 * which caused infinite QA fail-open loops. The new parser repairs partial
 * payloads by closing dangling strings and balancing braces/brackets.
 */

const {
  extractGeminiResponseText,
  extractFinishReason,
  parseJsonBlock,
  repairTruncatedJson,
} = require('../../../services/illustrator/qaResponseParser');

describe('extractGeminiResponseText', () => {
  test('joins visible parts and ignores thought parts', () => {
    const data = {
      candidates: [{
        content: {
          parts: [
            { text: 'thought sidecar', thought: true },
            { text: '{"a":1}' },
            { text: ' trailing' },
          ],
        },
      }],
    };
    expect(extractGeminiResponseText(data)).toBe('{"a":1}\n trailing');
  });

  test('returns empty string for missing candidates', () => {
    expect(extractGeminiResponseText({})).toBe('');
    expect(extractGeminiResponseText({ candidates: [] })).toBe('');
    expect(extractGeminiResponseText(null)).toBe('');
  });
});

describe('extractFinishReason', () => {
  test('returns finishReason when present', () => {
    expect(extractFinishReason({ candidates: [{ finishReason: 'MAX_TOKENS' }] }))
      .toBe('MAX_TOKENS');
    expect(extractFinishReason({ candidates: [{ finishReason: 'STOP' }] }))
      .toBe('STOP');
  });

  test('returns null when missing', () => {
    expect(extractFinishReason({})).toBeNull();
    expect(extractFinishReason({ candidates: [{}] })).toBeNull();
    expect(extractFinishReason({ candidates: [{ finishReason: '' }] })).toBeNull();
  });
});

describe('parseJsonBlock — clean cases', () => {
  test('parses a clean JSON object', () => {
    const r = parseJsonBlock('{"a":1,"b":"hello"}');
    expect(r.parsed).toEqual({ a: 1, b: 'hello' });
    expect(r.repaired).toBe(false);
  });

  test('strips ```json fences', () => {
    const r = parseJsonBlock('```json\n{"a":1}\n```');
    expect(r.parsed).toEqual({ a: 1 });
    expect(r.repaired).toBe(false);
  });

  test('strips bare ``` fences', () => {
    const r = parseJsonBlock('```\n{"a":1}\n```');
    expect(r.parsed).toEqual({ a: 1 });
  });

  test('returns null parsed for empty / non-string input', () => {
    expect(parseJsonBlock('').parsed).toBeNull();
    expect(parseJsonBlock(null).parsed).toBeNull();
    expect(parseJsonBlock(undefined).parsed).toBeNull();
  });

  test('returns null parsed when no { is present', () => {
    expect(parseJsonBlock('totally not json').parsed).toBeNull();
  });
});

describe('parseJsonBlock — truncation repair (production regression)', () => {
  test('recovers a JSON cut off mid-string', () => {
    // Simulates Gemini hitting MAX_TOKENS halfway through a `Notes` field.
    const truncated = '{"heroChildMatches":true,"heroChildDifferences":"the candidate child has slightly different hair col';
    const r = parseJsonBlock(truncated);
    expect(r.parsed).not.toBeNull();
    expect(r.repaired).toBe(true);
    expect(r.parsed.heroChildMatches).toBe(true);
    expect(typeof r.parsed.heroChildDifferences).toBe('string');
  });

  test('recovers a JSON cut off mid-key', () => {
    // The value side never started, so the partial key/value pair is dropped.
    const truncated = '{"heroChildMatches":true,"heroChildDiff';
    const r = parseJsonBlock(truncated);
    expect(r.parsed).not.toBeNull();
    expect(r.repaired).toBe(true);
    expect(r.parsed.heroChildMatches).toBe(true);
  });

  test('recovers a JSON cut off after a comma', () => {
    const truncated = '{"a":1,"b":2,';
    const r = parseJsonBlock(truncated);
    expect(r.parsed).toEqual({ a: 1, b: 2 });
    expect(r.repaired).toBe(true);
  });

  test('recovers a JSON with unclosed nested arrays/objects', () => {
    const truncated = '{"a":1,"nested":{"x":[1,2,3';
    const r = parseJsonBlock(truncated);
    expect(r.parsed).not.toBeNull();
    expect(r.repaired).toBe(true);
    expect(r.parsed.a).toBe(1);
    expect(r.parsed.nested.x).toEqual([1, 2, 3]);
  });

  test('preserves all completed fields from a long truncated consistency-QA response', () => {
    // Realistic shape: many bool fields complete, one Notes string clipped.
    const truncated = [
      '{',
      '"heroChildMatches": true,',
      '"heroChildDifferences": "",',
      '"outfitMatches": true,',
      '"artStyleMatchesCover": true,',
      '"artStyleNotes": "",',
      '"heroCount": 1,',
      '"heroBodyConnected": true,',
      '"heroBodyConnectedNotes": "",',
      '"splitPanel": false,',
      '"explicitStranger": false,',
      '"strangerDescription": "",',
      '"recurringItemConcerns": "",',
      '"heroSkinToneMatchesCover": false,',
      '"heroSkinToneNotes": "cover child reads as fair / very pale, but the candidate spread shows a noticeably warmer medium-tan skin family with',
    ].join('\n');
    const r = parseJsonBlock(truncated);
    expect(r.parsed).not.toBeNull();
    expect(r.repaired).toBe(true);
    expect(r.parsed.heroChildMatches).toBe(true);
    expect(r.parsed.outfitMatches).toBe(true);
    expect(r.parsed.heroSkinToneMatchesCover).toBe(false);
    // Notes string should be present and non-empty even though it was clipped.
    expect(typeof r.parsed.heroSkinToneNotes).toBe('string');
    expect(r.parsed.heroSkinToneNotes.length).toBeGreaterThan(0);
  });

  test('does not mark a clean parse as repaired', () => {
    const r = parseJsonBlock('{"a":1,"b":[1,2,3]}');
    expect(r.repaired).toBe(false);
    expect(r.parsed).toEqual({ a: 1, b: [1, 2, 3] });
  });
});

describe('repairTruncatedJson', () => {
  test('returns null for input not starting with {', () => {
    expect(repairTruncatedJson('not an object')).toBeNull();
    expect(repairTruncatedJson('[1,2,3')).toBeNull();
    expect(repairTruncatedJson('')).toBeNull();
  });

  test('closes a single dangling string', () => {
    expect(repairTruncatedJson('{"a":"hello')).toBe('{"a":"hello"}');
  });

  test('strips trailing comma and closes', () => {
    expect(repairTruncatedJson('{"a":1,')).toBe('{"a":1}');
  });

  test('balances nested braces and brackets', () => {
    expect(repairTruncatedJson('{"a":{"b":[1,2'))
      .toBe('{"a":{"b":[1,2]}}');
  });

  test('handles escaped quotes inside strings', () => {
    // The closing `"` is part of a value that contains an escaped quote.
    const repaired = repairTruncatedJson('{"a":"he said \\"hi\\" then');
    expect(repaired).toBe('{"a":"he said \\"hi\\" then"}');
    expect(JSON.parse(repaired)).toEqual({ a: 'he said "hi" then' });
  });

  test('drops a dangling backslash before closing quote', () => {
    // A trailing single backslash would turn our `"` into an escape.
    const repaired = repairTruncatedJson('{"a":"foo\\');
    expect(repaired).toBe('{"a":"foo"}');
    expect(JSON.parse(repaired)).toEqual({ a: 'foo' });
  });
});
