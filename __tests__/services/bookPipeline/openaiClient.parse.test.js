const { parseJsonLoose, LlmParseError } = require('../../../services/bookPipeline/llm/openaiClient');

describe('parseJsonLoose', () => {
  test('parses raw JSON', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  test('parses raw JSON array', () => {
    expect(parseJsonLoose('[1,2,3]')).toEqual([1, 2, 3]);
  });

  test('parses JSON inside fenced json block', () => {
    const raw = '```json\n{"hello":"world"}\n```';
    expect(parseJsonLoose(raw)).toEqual({ hello: 'world' });
  });

  test('parses JSON inside fenced block with no lang tag', () => {
    const raw = '```\n{"ok":true}\n```';
    expect(parseJsonLoose(raw)).toEqual({ ok: true });
  });

  test('parses JSON after leading prose', () => {
    const raw = 'Here is the JSON you requested:\n{"title":"hi"}';
    expect(parseJsonLoose(raw)).toEqual({ title: 'hi' });
  });

  test('picks first JSON block when multiple fences are present', () => {
    const raw = 'Reasoning...\n```json\n{"pick":"me"}\n```\nand also:\n```json\n{"ignored":true}\n```';
    expect(parseJsonLoose(raw)).toEqual({ pick: 'me' });
  });

  test('skips malformed fenced block, falls back to next', () => {
    const raw = '```json\nnot actually json here\n```\n```json\n{"ok":1}\n```';
    expect(parseJsonLoose(raw)).toEqual({ ok: 1 });
  });

  test('last-resort brace match inside surrounding prose', () => {
    const raw = 'Prefix text {"nested":{"a":[1,2]}} trailing text';
    expect(parseJsonLoose(raw)).toEqual({ nested: { a: [1, 2] } });
  });

  test('throws LlmParseError on empty input', () => {
    expect(() => parseJsonLoose('')).toThrow(LlmParseError);
  });

  test('throws LlmParseError when nothing parses', () => {
    expect(() => parseJsonLoose('not json at all, truly just prose')).toThrow(LlmParseError);
  });
});
