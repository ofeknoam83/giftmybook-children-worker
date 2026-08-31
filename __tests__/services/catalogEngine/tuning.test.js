/**
 * Writer Tuning Layer: input validation, kill-switch, system-prompt
 * composition, and the versions.writer_tuning echo — the worker-side half of
 * the admin feedback loop (docs/AI_WRITER_FEEDBACK_LOOP_PLAN.md).
 */

const {
  buildStoryRequest,
  buildSystemPrompt,
  buildStyleCheckpoint,
  buildUserPrompt,
  buildPolishPrompt,
  evidenceUnchanged,
  omissionsUnchanged,
  normalizeTuning,
  validateTuningInput,
} = require('../../../services/catalogEngine/writer');
const { getBook } = require('../../../services/catalogEngine/catalog');
const { validateStoryResponse } = require('../../../services/catalogEngine/storyValidation');

const PRONOUNS = { subject: 'she', object: 'her', possessive_adjective: 'her' };
const baseProfile = (extra = {}) => ({ name: 'Emma', age: 2, pronouns: PRONOUNS, ...extra });

const TUNING = {
  versionLabel: 'tune-007',
  hash: '9F31C2AB9F31C2AB',
  text: 'Prefer concrete sensory detail. End at least half the spreads on a stressed syllable.',
};

afterEach(() => {
  delete process.env.CATALOG_TUNING_LAYER;
});

describe('writerTuning input validation', () => {
  test('absent tuning is valid; malformed shapes are named', () => {
    expect(validateTuningInput(undefined)).toBeNull();
    expect(validateTuningInput(null)).toBeNull();
    expect(validateTuningInput('rules')).toMatch(/object/);
    expect(validateTuningInput({ ...TUNING, versionLabel: 'bad label!' })).toMatch(/versionLabel/);
    expect(validateTuningInput({ ...TUNING, hash: 'nothex' })).toMatch(/hash/);
    expect(validateTuningInput({ ...TUNING, text: '   ' })).toMatch(/text/);
    expect(validateTuningInput({ ...TUNING, text: 'x'.repeat(8001) })).toMatch(/8000/);
    expect(validateTuningInput(TUNING)).toBeNull();
  });

  test('text that survives only as control characters is rejected, not silently dropped', () => {
    expect(validateTuningInput({ ...TUNING, text: '\u0001\u0002 \u0007' })).toMatch(/visible characters/);
  });

  test('the size cap counts UTF-8 bytes, not UTF-16 code units', () => {
    // 4100 'é' chars = 8200 UTF-8 bytes but only 4100 code units.
    expect(validateTuningInput({ ...TUNING, text: 'é'.repeat(4100) })).toMatch(/UTF-8 bytes/);
    expect(validateTuningInput({ ...TUNING, text: 'é'.repeat(3900) })).toBeNull();
  });

  test('normalizeTuning strips control chars and builds the label.hash8 tag', () => {
    const t = normalizeTuning({ ...TUNING, text: 'keep\nlines but not bells' });
    expect(t.tag).toBe('tune-007.9f31c2ab');
    expect(t.text).toBe('keep\nlines but not bells');
  });

  test('CATALOG_TUNING_LAYER=0 kill-switch drops the overlay entirely', () => {
    process.env.CATALOG_TUNING_LAYER = '0';
    expect(normalizeTuning(TUNING)).toBeNull();
    const { request } = buildStoryRequest({
      bookId: 'farm_2_3_hello_farm',
      profile: baseProfile(),
      sessionId: 'sess_tuning_1',
      tuning: normalizeTuning(TUNING),
    });
    expect(request.versions.writer_tuning).toBe('none');
  });
});

describe('system prompt composition', () => {
  test('no tuning → the bare locked engine prompt', () => {
    const bare = buildSystemPrompt(null);
    expect(bare).not.toContain('STYLE TUNING LAYER');
  });

  test('tuning appends AFTER the engine, scope-subordinate but importance-binding', () => {
    const bare = buildSystemPrompt(null);
    const composed = buildSystemPrompt(normalizeTuning(TUNING));
    expect(composed.startsWith(bare)).toBe(true);
    const overlay = composed.slice(bare.length);
    expect(overlay).toContain('# STYLE TUNING LAYER tune-007.9f31c2ab');
    expect(overlay).toContain('binding editorial requirements');
    // The scope carve-out survives: prose only, hard constraints always win…
    expect(overlay).toContain('PROSE STYLE ONLY');
    expect(overlay).toContain('the rules above win');
    // …but the layer is no longer talked down as ignorable garnish.
    expect(overlay).not.toContain('lowest priority');
    expect(overlay).not.toContain('stylistic polish');
    expect(overlay).toContain(TUNING.text);
  });
});

describe('style checkpoint (end-of-prompt restatement)', () => {
  const CRITICAL_TUNING = {
    ...TUNING,
    text: '- Prefer concrete sensory detail.\n- NON-NEGOTIABLE — End at least half the spreads on a stressed syllable.\n- IMPORTANT — One adjective per noun.',
  };

  test('no tuning → no checkpoint section', () => {
    expect(buildStyleCheckpoint(null)).toBeNull();
  });

  test('restates NON-NEGOTIABLE lines verbatim; plain overlays still get the pointer', () => {
    const critical = buildStyleCheckpoint(normalizeTuning(CRITICAL_TUNING));
    expect(critical).toContain('## STYLE CHECKPOINT');
    expect(critical).toContain('STYLE TUNING LAYER tune-007.9f31c2ab');
    expect(critical).toContain('- NON-NEGOTIABLE — End at least half the spreads on a stressed syllable.');
    expect(critical).not.toContain('One adjective per noun'); // IMPORTANT tier is not restated

    const plain = buildStyleCheckpoint(normalizeTuning(TUNING));
    expect(plain).toContain('## STYLE CHECKPOINT');
    expect(plain).not.toContain('violated in past drafts');
  });

  test('the checkpoint lands at the END of the user prompt, before retry errors only', () => {
    const tuning = normalizeTuning(CRITICAL_TUNING);
    const { request, book, ageBand, map } = buildStoryRequest({
      bookId: 'farm_2_3_hello_farm', profile: baseProfile(), sessionId: 'sess_cp_1', tuning,
    });
    const theme = getBook(request.book_id).theme;

    const prompt = buildUserPrompt({ request, book, theme, ageBand, map, tuning });
    expect(prompt.indexOf('## STYLE CHECKPOINT')).toBeGreaterThan(prompt.indexOf('## OUTPUT'));

    const retry = buildUserPrompt({ request, book, theme, ageBand, map, tuning, validationErrors: ['spread 3: too long'] });
    expect(retry.indexOf('## STYLE CHECKPOINT')).toBeLessThan(retry.indexOf('## PREVIOUS ATTEMPT FAILED VALIDATION'));

    const bare = buildUserPrompt({ request, book, theme, ageBand, map });
    expect(bare).not.toContain('STYLE CHECKPOINT');
  });
});

describe('style polish pass helpers', () => {
  test('buildPolishPrompt carries the draft, echo orders, and constraint precedence', () => {
    const request = { request_id: 'r1', book_id: 'farm_2_3_hello_farm', versions: { writer_tuning: 'tune-007.9f31c2ab' } };
    const response = { title: 'T', spreads: [{ spread: 1, text: 'Hello.' }], personalization_evidence: [] };
    const prompt = buildPolishPrompt({ request, response });
    expect(prompt).toContain('# STYLE POLISH TASK');
    expect(prompt).toContain('"book_id":"farm_2_3_hello_farm"');
    expect(prompt).toContain('echo both VERBATIM');
    expect(prompt).toContain('the constraint stands');
    expect(prompt).toContain('Hello.');
  });

  test('evidenceUnchanged accepts identical evidence and rejects any drift', () => {
    const ev = [{ source_field: 'food', source_value: 'pasta', moment_type: 'sensory', spread: 4, slot_id: 's04', visual_required: false }];
    expect(evidenceUnchanged(ev, [{ ...ev[0] }])).toBe(true);
    expect(evidenceUnchanged(ev, [])).toBe(false);
    expect(evidenceUnchanged(ev, [{ ...ev[0], source_value: 'pizza' }])).toBe(false);
    expect(evidenceUnchanged(ev, [{ ...ev[0], spread: 5 }])).toBe(false);
    expect(evidenceUnchanged(ev, [{ ...ev[0], slot_id: 's05' }])).toBe(false);
    // Visual drift counts too: an optional-visual slot validates either way,
    // so polish flipping a text-only detail into an illustration prop (or
    // moving its visual slot) must be rejected here.
    expect(evidenceUnchanged(ev, [{ ...ev[0], visual_required: true, visual_slot_id: 'v04' }])).toBe(false);
    const vis = [{ ...ev[0], visual_required: true, visual_slot_id: 'v04' }];
    expect(evidenceUnchanged(vis, [{ ...vis[0] }])).toBe(true);
    expect(evidenceUnchanged(vis, [{ ...vis[0], visual_slot_id: 'v05' }])).toBe(false);
    // Absent and explicitly-false visual_required are the same choice.
    expect(evidenceUnchanged([{ ...ev[0] }], [{ ...ev[0], visual_required: undefined }])).toBe(true);
    expect(evidenceUnchanged([], [])).toBe(true);
  });

  test('omissionsUnchanged protects the omission audit from silent polish edits', () => {
    const om = [{ source_field: 'food', reason: 'weak_fit' }];
    expect(omissionsUnchanged(om, [{ ...om[0] }])).toBe(true);
    expect(omissionsUnchanged(om, [])).toBe(false);
    expect(omissionsUnchanged(om, [{ ...om[0], reason: 'editorial_omission' }])).toBe(false);
    expect(omissionsUnchanged([], [])).toBe(true);
  });
});

describe('versions.writer_tuning echo', () => {
  function makeStory(tuningRaw) {
    const { request, book, ageBand, map } = buildStoryRequest({
      bookId: 'farm_2_3_hello_farm',
      profile: baseProfile(),
      sessionId: 'sess_tuning_2',
      tuning: normalizeTuning(tuningRaw),
    });
    // farm_2_3_hello_farm: refrain "Hello, farm! Here we are!" on 2,5,8,11.
    const FILLER = 'Emma walks along the sunny path and smiles at the friendly animals nearby';
    const spreads = Array.from({ length: 12 }, (_, i) => {
      const n = i + 1;
      const withRefrain = [2, 5, 8, 11].includes(n);
      return { spread: n, text: withRefrain ? `${FILLER}. Hello, farm! Here we are!` : `${FILLER} today.` };
    });
    const response = {
      request_id: request.request_id,
      book_id: request.book_id,
      title: request.rendered_title,
      versions: { ...request.versions },
      spreads,
      personalization_evidence: [],
      omitted_profile_fields: [],
    };
    return { request, book, ageBand, map, response };
  }

  test('the tag is pinned on the request and a matching echo passes all 10 steps', () => {
    const f = makeStory(TUNING);
    expect(f.request.versions.writer_tuning).toBe('tune-007.9f31c2ab');
    const v = validateStoryResponse({ ...f });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  test('a response that drops or rewrites the tuning tag fails the echo step', () => {
    const f = makeStory(TUNING);
    f.response.versions.writer_tuning = 'none';
    const v = validateStoryResponse({ ...f });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/writer_tuning/);
  });

  test('no tuning pins writer_tuning: none and still validates', () => {
    const f = makeStory(null);
    expect(f.request.versions.writer_tuning).toBe('none');
    expect(validateStoryResponse({ ...f }).ok).toBe(true);
  });
});
