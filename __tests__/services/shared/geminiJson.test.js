/**
 * shared/llm/geminiJson: the one generationConfig for strict-JSON judge
 * calls (thinking held to the model's minimum — a MINIMAL level on the 3.x
 * family, budget 0 on 2.5 flash, nothing elsewhere — and a token floor),
 * the thinking-field retry helpers, and the tolerant parse + diagnosis of
 * the answer.
 */

const {
  QA_MIN_OUTPUT_TOKENS, supportsZeroThinking, thinkingConfigFor, jsonQaGenerationConfig, isThinkingFieldError, stripThinking,
  responseText, finishReasonOf, parseJsonText, unparseableDetail,
} = require('../../../services/shared/llm/geminiJson');
const { qaVisionModel, DEFAULT_QA_VISION_MODEL } = require('../../../services/shared/llm/models');

const savedEnv = {};
beforeEach(() => {
  for (const k of ['CATALOG_QA_VISION_MODEL', 'CATALOG_QA_THINKING_LEVEL']) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ['CATALOG_QA_VISION_MODEL', 'CATALOG_QA_THINKING_LEVEL']) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

test('jsonQaGenerationConfig never caps below the floor and defaults to the registry model at thinking level MINIMAL', () => {
  expect(QA_MIN_OUTPUT_TOKENS).toBe(2048);
  expect(DEFAULT_QA_VISION_MODEL).toBe('gemini-3.5-flash');
  expect(jsonQaGenerationConfig(256)).toEqual({ temperature: 0, maxOutputTokens: 2048, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'MINIMAL' } });
  expect(jsonQaGenerationConfig(256)).toEqual(jsonQaGenerationConfig(256, qaVisionModel()));
  expect(jsonQaGenerationConfig(undefined).maxOutputTokens).toBe(2048);
  expect(jsonQaGenerationConfig(4096, 'gemini-3.5-flash').maxOutputTokens).toBe(4096);
  // The 3.x Pro tier takes a level too.
  expect(jsonQaGenerationConfig(512, 'gemini-3.1-pro-preview').thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
});

test('the legacy 2.5 flash family keeps a zero BUDGET; 2.5 Pro and older models get no thinkingConfig at all', () => {
  expect(jsonQaGenerationConfig(4096, 'gemini-2.5-flash')).toEqual({ temperature: 0, maxOutputTokens: 4096, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } });
  expect(jsonQaGenerationConfig(4096, 'gemini-2.5-flash-lite').thinkingConfig).toEqual({ thinkingBudget: 0 });
  // 2.5 Pro cannot take a zero budget; older models reject the field.
  expect(jsonQaGenerationConfig(512, 'gemini-2.5-pro')).toEqual({ temperature: 0, maxOutputTokens: 2048, responseMimeType: 'application/json' });
  expect(jsonQaGenerationConfig(512, 'gemini-2.0-flash').thinkingConfig).toBeUndefined();
  expect(jsonQaGenerationConfig(512, 'gemini-test-text').thinkingConfig).toBeUndefined();
  expect(supportsZeroThinking('gemini-2.5-flash')).toBe(true);
  expect(supportsZeroThinking('gemini-2.5-pro')).toBe(false);
  expect(supportsZeroThinking('gemini-3.5-flash')).toBe(false);
  expect(supportsZeroThinking('')).toBe(false);
});

test('thinkingConfigFor never carries BOTH a budget and a level (the pair is a 400 on 3.x)', () => {
  for (const model of ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-2.0-flash', '', undefined]) {
    const config = thinkingConfigFor(model);
    if (config) expect(Object.keys(config)).toHaveLength(1);
    const generation = jsonQaGenerationConfig(2048, model);
    if (generation.thinkingConfig) expect(Object.keys(generation.thinkingConfig)).toHaveLength(1);
  }
  expect(thinkingConfigFor('gemini-3.5-flash')).toEqual({ thinkingLevel: 'MINIMAL' });
  expect(thinkingConfigFor('gemini-2.5-flash')).toEqual({ thinkingBudget: 0 });
  expect(thinkingConfigFor('gemini-2.5-pro')).toBeNull();
});

test('the 3.x level follows CATALOG_QA_THINKING_LEVEL, and opts.thinkingLevel overrides it per call', () => {
  process.env.CATALOG_QA_THINKING_LEVEL = 'low';
  expect(thinkingConfigFor('gemini-3.5-flash')).toEqual({ thinkingLevel: 'LOW' });
  expect(jsonQaGenerationConfig(2048, 'gemini-3.5-flash').thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
  expect(jsonQaGenerationConfig(2048, 'gemini-3.5-flash', { thinkingLevel: 'HIGH' }).thinkingConfig).toEqual({ thinkingLevel: 'HIGH' });
  expect(thinkingConfigFor('gemini-3.5-flash', 'MEDIUM')).toEqual({ thinkingLevel: 'MEDIUM' });
  // The override never reaches a budget model.
  expect(jsonQaGenerationConfig(2048, 'gemini-2.5-flash', { thinkingLevel: 'HIGH' }).thinkingConfig).toEqual({ thinkingBudget: 0 });
  process.env.CATALOG_QA_THINKING_LEVEL = 'bogus';
  expect(thinkingConfigFor('gemini-3.5-flash')).toEqual({ thinkingLevel: 'MINIMAL' });
});

test('isThinkingFieldError names only a 400 whose body mentions the thinking field; stripThinking drops it without mutating', () => {
  expect(isThinkingFieldError(400, 'Invalid JSON payload received. Unknown name "thinking_level" at generation_config.thinking_config')).toBe(true);
  expect(isThinkingFieldError(400, 'thinkingBudget is not supported for this model')).toBe(true);
  expect(isThinkingFieldError('400', 'Unknown field thinkingConfig')).toBe(true);
  expect(isThinkingFieldError(400, 'Unknown name "image_size"')).toBe(false);
  expect(isThinkingFieldError(500, 'thinking')).toBe(false);
  expect(isThinkingFieldError(429, 'thinkingLevel')).toBe(false);
  expect(isThinkingFieldError(400, '')).toBe(false);
  expect(isThinkingFieldError(400, null)).toBe(false);
  const config = jsonQaGenerationConfig(4096, 'gemini-3.5-flash');
  const stripped = stripThinking(config);
  expect(stripped).toEqual({ temperature: 0, maxOutputTokens: 4096, responseMimeType: 'application/json' });
  expect(config.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
  expect(stripThinking({ responseSchema: { type: 'object' }, thinkingConfig: { thinkingBudget: 0 } })).toEqual({ responseSchema: { type: 'object' } });
  expect(stripThinking(undefined)).toEqual({});
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
