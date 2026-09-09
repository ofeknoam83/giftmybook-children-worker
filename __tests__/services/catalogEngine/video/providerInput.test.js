/**
 * The vendor input contract (2026-09-09): our internal tier vocabulary is
 * mapped onto the model's own enum before it is ever submitted, and a 422
 * that still names a field corrects the request instead of failing a film.
 */

const { MODELS, modelProfile, klingMode, costModelFor } = require('../../../../services/catalogEngine/video/providers/models');
const { parseInputIssues, repairInput, applyRepairs, describeRepairs, matchAllowed } = require('../../../../services/catalogEngine/video/providers/inputRepair');
const { qualityBought } = require('../../../../services/catalogEngine/video/generate');

const job = (quality) => ({
  brief: { prompt: 'a child walks through the meadow', negativePrompt: 'text', params: { cfgScale: 0.5 }, referenceLines: [] },
  startFrameUrl: 'https://x/start.jpg', endFrameUrl: null, referenceUrls: [], seconds: 5, aspect: '16:9', seed: null, quality,
});

describe('Kling tier mapping', () => {
  test("the Omni film's std tier is submitted as Kling's own 'standard'", () => {
    const input = MODELS['kwaivgi/kling-v3-omni-video'].input(job('std'), { elements: false });
    expect(input.mode).toBe('standard');
  });

  test('pro and 4k stay themselves; an unknown tier is left to the model default', () => {
    expect(MODELS['kwaivgi/kling-v3-omni-video'].input(job('pro'), { elements: false }).mode).toBe('pro');
    expect(klingMode('4k')).toEqual({ mode: '4k' });
    expect(klingMode('turbo')).toEqual({});
    expect(klingMode(null)).toEqual({});
  });

  test('the trailer model names a cheaper tier and leaves the default path untouched', () => {
    const profile = MODELS['kwaivgi/kling-v3-video'];
    expect(profile.input(job('std'), { elements: false }).mode).toBe('standard');
    expect(profile.input(job('pro'), { elements: false })).not.toHaveProperty('mode');
    expect(profile.input(job(null), { elements: false })).not.toHaveProperty('mode');
  });

  test('every tier a request may name resolves to a value the vendor lists', () => {
    for (const quality of ['std', 'pro']) {
      const input = modelProfile('kwaivgi/kling-v3-omni-video').input(job(quality), { elements: false });
      expect(['standard', 'pro', '4k']).toContain(input.mode);
    }
  });
});

describe('vendor 422 repair', () => {
  const message = 'Replicate refused the prediction (HTTP 422): - input.mode: mode must be one of the following: "standard", "pro", "4k"';

  test("the vendor's enum is read off the 422 and our value mapped onto it", () => {
    const issues = parseInputIssues(message);
    expect(issues).toEqual([expect.objectContaining({ field: 'mode', allowed: ['standard', 'pro', '4k'], unknown: false })]);
    const fixed = repairInput({ prompt: 'p', start_image: 'u', mode: 'std' }, issues);
    expect(fixed.input).toEqual({ prompt: 'p', start_image: 'u', mode: 'standard' });
    expect(describeRepairs(fixed.repairs)).toContain('"standard"');
  });

  test('a field the model does not accept is dropped, not guessed', () => {
    const issues = parseInputIssues('- input.end_image: Additional properties are not allowed');
    const fixed = repairInput({ prompt: 'p', start_image: 'u', end_image: 'e' }, issues);
    expect(fixed.input).toEqual({ prompt: 'p', start_image: 'u' });
    expect(fixed.repairs[0].to).toBeNull();
  });

  test('an enum with no match for our value drops the field so the model applies its default', () => {
    const issues = parseInputIssues('- input.aspect_ratio: aspect_ratio must be one of the following: "16:9", "9:16"');
    expect(repairInput({ prompt: 'p', aspect_ratio: '4:3' }, issues).input).toEqual({ prompt: 'p' });
  });

  test('the commissioning fields are never dropped — that stays a real failure', () => {
    expect(repairInput({ prompt: 'p', start_image: 'u' }, parseInputIssues('- input.prompt: prompt is required'))).toBeNull();
    expect(repairInput({ prompt: 'p', start_image: 'u' }, parseInputIssues('- input.start_image: not allowed'))).toBeNull();
  });

  test('a message about a field we did not send, or no field at all, repairs nothing', () => {
    expect(repairInput({ prompt: 'p' }, parseInputIssues('- input.duration: duration must be one of the following: 5, 10'))).toBeNull();
    expect(repairInput({ prompt: 'p' }, parseInputIssues('the account is out of credit'))).toBeNull();
  });

  test('mapping prefers exact, then case, then a unique prefix or abbreviation', () => {
    expect(matchAllowed('pro', ['standard', 'pro'])).toBe('pro');
    expect(matchAllowed('PRO', ['standard', 'pro'])).toBe('pro');
    expect(matchAllowed('stand', ['standard', 'pro'])).toBe('standard');
    expect(matchAllowed('std', ['standard', 'pro'])).toBe('standard');
    expect(matchAllowed('s', ['standard', 'super'])).toBeNull();
  });

  test('several issues on ONE line are read separately, and prose after "one of" is never a vocabulary', () => {
    const issues = parseInputIssues('Replicate refused the prediction (HTTP 422): - input.mode: mode must be one of the following: "standard", "pro" - input.end_image: Additional properties are not allowed');
    expect(issues).toEqual([
      expect.objectContaining({ field: 'mode', allowed: ['standard', 'pro'], unknown: false }),
      expect.objectContaining({ field: 'end_image', allowed: [], unknown: true }),
    ]);
    expect(parseInputIssues('- input.duration: 12 is not one of [5, 10]')[0].allowed).toEqual(['5', '10']);
    expect(parseInputIssues('- input.mode: must be one of the allowed values')[0].allowed).toEqual([]);
  });

  test('a known field the vendor rejects without listing values is left alone (no guessing)', () => {
    const issues = parseInputIssues('- input.cfg_scale: must be <= 1');
    expect(repairInput({ prompt: 'p', cfg_scale: 3 }, issues)).toEqual({ input: { prompt: 'p' }, repairs: [expect.objectContaining({ field: 'cfg_scale', to: null })] });
    // …but the billed length is protected: a wrong duration is a profile bug, never dropped.
    expect(repairInput({ prompt: 'p', duration: 12 }, parseInputIssues('- input.duration: 12 is not one of [5, 10]'))).toBeNull();
  });

  test('earlier repairs survive a rebuilt input (the end-frame fallback)', () => {
    const rebuilt = { prompt: 'p', start_image: 'u', mode: 'std', extra: 1 };
    expect(applyRepairs(rebuilt, [{ field: 'mode', to: 'standard' }, { field: 'extra', to: null }, { field: 'absent', to: null }]))
      .toEqual({ prompt: 'p', start_image: 'u', mode: 'standard' });
  });

  test('a tier re-spelled for the vendor is still billed as asked; a DROPPED tier bills the default', () => {
    expect(qualityBought('std', [{ field: 'mode', to: 'standard' }])).toBe('std');
    expect(qualityBought('std', [{ field: 'mode', to: null }])).toBeNull();
    expect(qualityBought('std', [])).toBe('std');
    expect(qualityBought(null, [])).toBeNull();
    expect(costModelFor('kwaivgi/kling-v3-omni-video', 'std')).toBe('kwaivgi/kling-v3-omni-video:std');
    expect(costModelFor('kwaivgi/kling-v3-omni-video', null)).toBe('kwaivgi/kling-v3-omni-video');
  });
});
