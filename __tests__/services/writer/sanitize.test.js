const { sanitizeMixedScriptString, sanitizeNonLatinChars } = require('../../../services/writer/quality/sanitize');

describe('sanitizeMixedScriptString', () => {
  test('maps common Cyrillic homoglyphs to ASCII', () => {
    // "Test" with Cyrillic е; "cat" with Cyrillic с, а (с → Latin c)
    const mixed = 'T\u0435st \u0441\u0430t';
    expect(sanitizeMixedScriptString(mixed)).toBe('Test cat');
  });

  test('maps fullwidth Latin to ASCII', () => {
    const fw = '\uFF28\uFF45\uFF4C\uFF4C\uFF4F';
    expect(sanitizeMixedScriptString(fw)).toBe('Hello');
  });

  test('leaves plain ASCII unchanged', () => {
    expect(sanitizeMixedScriptString('Savannah hops.')).toBe('Savannah hops.');
  });
});

describe('sanitizeNonLatinChars', () => {
  test('mutates spread text and counts replacements', () => {
    const spreads = [{ spread: 1, text: 'H\u0435llo' }];
    const n = sanitizeNonLatinChars(spreads, 'test-book');
    expect(n).toBeGreaterThan(0);
    expect(spreads[0].text).toBe('Hello');
  });
});
