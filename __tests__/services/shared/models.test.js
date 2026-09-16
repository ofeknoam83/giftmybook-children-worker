/**
 * shared/llm/models: the Gemini model registry (2026-09-16 migration) —
 * every accessor reads its env knob at call time, trims it, and falls back
 * to the pinned default on unset / blank; the secondary review model has
 * NO default (blank disables the reviewed fallback); the thinking level is
 * validated against the four 3.x levels.
 */

const models = require('../../../services/shared/llm/models');

const KNOBS = [
  'CATALOG_QA_VISION_MODEL', 'CATALOG_QA_PRO_MODEL', 'CATALOG_TEXT_FALLBACK_MODEL',
  'CATALOG_AUDIO_STT_MODEL', 'CATALOG_AUDIO_TTS_MODEL', 'CATALOG_QA_SECONDARY_MODEL', 'CATALOG_QA_THINKING_LEVEL',
];
const saved = {};
beforeEach(() => { for (const k of KNOBS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KNOBS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

test('every accessor falls back to its 3.x default when the env is unset', () => {
  expect(models.qaVisionModel()).toBe('gemini-3.5-flash');
  expect(models.proModel()).toBe('gemini-3.1-pro-preview');
  expect(models.textFallbackModel()).toBe('gemini-3.5-flash');
  expect(models.audioModel()).toBe('gemini-3.5-flash');
  expect(models.ttsModel()).toBe('gemini-3.1-flash-tts-preview');
  expect(models.qaThinkingLevel()).toBe('MINIMAL');
  // The defaults are exported so tests and docs never re-type them.
  expect(models.DEFAULT_QA_VISION_MODEL).toBe(models.qaVisionModel());
  expect(models.DEFAULT_PRO_MODEL).toBe(models.proModel());
  expect(models.DEFAULT_TEXT_FALLBACK_MODEL).toBe(models.textFallbackModel());
  expect(models.DEFAULT_AUDIO_MODEL).toBe(models.audioModel());
  expect(models.DEFAULT_TTS_MODEL).toBe(models.ttsModel());
  // No retired 2.5 id anywhere in the defaults.
  for (const fn of ['qaVisionModel', 'proModel', 'textFallbackModel', 'audioModel', 'ttsModel']) expect(models[fn]()).not.toMatch(/gemini-2\.5/);
});

test.each([
  ['CATALOG_QA_VISION_MODEL', 'qaVisionModel'],
  ['CATALOG_QA_PRO_MODEL', 'proModel'],
  ['CATALOG_TEXT_FALLBACK_MODEL', 'textFallbackModel'],
  ['CATALOG_AUDIO_STT_MODEL', 'audioModel'],
  ['CATALOG_AUDIO_TTS_MODEL', 'ttsModel'],
])('%s overrides %s at call time, trimmed; blank means the default', (env, fn) => {
  const fallback = models[fn]();
  process.env[env] = '  gemini-custom-id  ';
  expect(models[fn]()).toBe('gemini-custom-id');
  process.env[env] = '   ';
  expect(models[fn]()).toBe(fallback);
  process.env[env] = '';
  expect(models[fn]()).toBe(fallback);
  delete process.env[env];
  expect(models[fn]()).toBe(fallback);
});

test('the secondary review model has no default: unset or blank disables the reviewed fallback', () => {
  expect(models.secondaryReviewModel()).toBeNull();
  process.env.CATALOG_QA_SECONDARY_MODEL = '   ';
  expect(models.secondaryReviewModel()).toBeNull();
  process.env.CATALOG_QA_SECONDARY_MODEL = ' gemini-3.1-pro-preview ';
  expect(models.secondaryReviewModel()).toBe('gemini-3.1-pro-preview');
});

test('the thinking level is validated against the four 3.x levels (case-insensitive); anything else is the default', () => {
  expect(models.THINKING_LEVELS).toEqual(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);
  for (const level of models.THINKING_LEVELS) {
    process.env.CATALOG_QA_THINKING_LEVEL = level;
    expect(models.qaThinkingLevel()).toBe(level);
    process.env.CATALOG_QA_THINKING_LEVEL = ` ${level.toLowerCase()} `;
    expect(models.qaThinkingLevel()).toBe(level);
  }
  process.env.CATALOG_QA_THINKING_LEVEL = 'ULTRA';
  expect(models.qaThinkingLevel()).toBe('MINIMAL');
  process.env.CATALOG_QA_THINKING_LEVEL = '0';
  expect(models.qaThinkingLevel()).toBe('MINIMAL');
  process.env.CATALOG_QA_THINKING_LEVEL = '';
  expect(models.qaThinkingLevel()).toBe('MINIMAL');
});

test('shared/illustration/config GEMINI_QA_MODEL equals the registry default at load', () => {
  jest.isolateModules(() => {
    const { GEMINI_QA_MODEL } = require('../../../services/shared/illustration/config');
    expect(GEMINI_QA_MODEL).toBe(models.qaVisionModel());
  });
  jest.isolateModules(() => {
    process.env.CATALOG_QA_VISION_MODEL = 'gemini-pinned';
    const { GEMINI_QA_MODEL } = require('../../../services/shared/illustration/config');
    expect(GEMINI_QA_MODEL).toBe('gemini-pinned');
  });
});
