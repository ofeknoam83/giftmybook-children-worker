/**
 * Phase 2 — the writer's user prompt now surfaces voiceCard + refrain +
 * opening/closing image ABOVE the rule wall. This locks the structure so
 * a future edit can't silently bury the voice block under the rhyme banner
 * (the failure mode that motivated AA-CW-23 for the rhyme contract).
 */

const {
  renderVoiceAndRefrain,
} = require('../../../services/bookPipeline/writer/draftBookText');

describe('renderVoiceAndRefrain (Phase 2)', () => {
  test('returns empty string when bible has no voice/refrain/bookend fields', () => {
    expect(renderVoiceAndRefrain(null)).toBe('');
    expect(renderVoiceAndRefrain({})).toBe('');
    expect(renderVoiceAndRefrain({ narrativeSpine: 'whatever' })).toBe('');
  });

  test('emits the VOICE / REFRAIN / BOOKENDS sections when fields are present', () => {
    const out = renderVoiceAndRefrain({
      voiceCard: {
        narratorPOV: 'third-person warm',
        tonalRegister: 'gentle, slightly wry, never cute',
        signatureMove: 'a sound-word at the start of each new room',
        refrainSeed: 'the warm light finds us',
      },
      refrain: {
        text: 'the warm light finds us here',
        plant: 2,
        deepen: 7,
        transform: 12,
      },
      openingImage: 'a sun-shaped beam on the kitchen wall, slowly moving',
      closingCallback: 'the same beam, now on the porch ceiling, has reached us at last',
    });
    expect(out).toContain('### VOICE');
    expect(out).toContain('Narrator POV: third-person warm');
    expect(out).toContain('Signature move');
    expect(out).toContain('### REFRAIN');
    expect(out).toContain('"the warm light finds us here"');
    expect(out).toContain('Plant on spread 2');
    expect(out).toContain('Deepen on spread 7');
    expect(out).toContain('Transform on spread 12');
    expect(out).toContain('### BOOKENDS');
    expect(out).toContain('Spread 1 opens on this concrete, drawable image');
    expect(out).toContain('Spread 13 closes by transforming that image');
  });

  test('partial voiceCard renders only the populated fields (tolerant)', () => {
    const out = renderVoiceAndRefrain({
      voiceCard: {
        narratorPOV: 'second-person intimate',
        tonalRegister: '',
        signatureMove: '',
        refrainSeed: '',
      },
    });
    expect(out).toContain('### VOICE');
    expect(out).toContain('Narrator POV: second-person intimate');
    expect(out).not.toContain('Tonal register');
    expect(out).not.toContain('Signature move');
  });

  test('refrain block is omitted if refrain.text is empty', () => {
    const out = renderVoiceAndRefrain({
      voiceCard: { narratorPOV: 'third-person warm', tonalRegister: '', signatureMove: '', refrainSeed: '' },
      refrain: { text: '', plant: 2, deepen: 7, transform: 12 },
    });
    expect(out).not.toContain('### REFRAIN');
  });
});
