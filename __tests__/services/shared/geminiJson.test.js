/**
 * shared/llm/geminiJson: the one generationConfig for strict-JSON judge
 * calls (thinking OFF where the model allows it, a token floor) and the
 * tolerant parse + diagnosis of the answer.
 */

const { QA_MIN_OUTPUT_TOKENS, supportsZeroThinking, jsonQaGenerationConfig, responseText, finishReasonOf, parseJsonText, unparseableDetail } = require('../../../services/shared/llm/geminiJson');

test('jsonQaGenerationConfig never caps below the floor and switches thinking off only on the 2.5 flash family', () => {
  expect(QA_MIN_OUTPUT_TOKENS).toBe(2048);
  expect(jsonQaGenerationConfig(256)).toEqual({ temperature: 0, maxOutputTokens: 2048, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } });
  expect(jsonQaGenerationConfig(4096, 'gemini-2.5-flash-lite').maxOutputTokens).toBe(4096);
  expect(jsonQaGenerationConfig(undefined).maxOutputTokens).toBe(2048);
  // 2.5 Pro cannot take a zero budget; older models reject the field.
  expect(jsonQaGenerationConfig(512, 'gemini-2.5-pro')).toEqual({ temperature: 0, maxOutputTokens: 2048, responseMimeType: 'application/json' });
  expect(jsonQaGenerationConfig(512, 'gemini-2.0-flash').thinkingConfig).toBeUndefined();
  expect(supportsZeroThinking('gemini-2.5-flash')).toBe(true);
  expect(supportsZeroThinking('gemini-2.5-pro')).toBe(false);
  expect(supportsZeroThinking('')).toBe(false);
});

test('parseJsonText drops fences and prose around the one object, and rejects a clipped answer', () => {
  expect(parseJsonText('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  expect(parseJsonText('Sure, here it is:\n{"a": {"b": [1, 2]}} — done.')).toEqual({ a: { b: [1, 2] } });
  expect(parseJsonText(' {"a":1} ')).toEqual({ a: 1 });
  expect(() => parseJsonText('{"readable_text": fal')).toThrow();
  expect(() => parseJsonText('')).toThrow();
  expect(() => parseJsonText('no braces here')).toThrow();
});

test('responseText / finishReasonOf / unparseableDetail read the response shape defensively', () => {
  const data = { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"a"' }, { inlineData: {} }, { text: ': 1' }] } }] };
  expect(responseText(data)).toBe('{"a": 1');
  expect(responseText({})).toBe('');
  expect(finishReasonOf(data)).toBe('MAX_TOKENS');
  expect(finishReasonOf({ candidates: [{ finishReason: 'STOP' }] })).toBeNull();
  expect(finishReasonOf({ promptFeedback: { blockReason: 'SAFETY' } })).toBe('blocked: SAFETY');
  expect(unparseableDetail(data, responseText(data))).toBe(' (finishReason: MAX_TOKENS, 7 chars)');
  expect(unparseableDetail({ candidates: [{ finishReason: 'STOP', content: { parts: [] } }] }, '')).toBe(' (empty response)');
  expect(unparseableDetail({ candidates: [{ content: { parts: [{ text: 'garbage' }] } }] }, 'garbage')).toBe('');
});
