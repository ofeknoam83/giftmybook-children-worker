/**
 * The cast (ab-1 §4.2): the file validates, every narrator / companion voice
 * is pinned for every provider, the default narrator is deterministic per
 * (theme, band), band 1-3 never gets a companion voice, the companion kind
 * follows the shared PERSON/creature rule with the theme overrides, a
 * request override is honoured and an unknown key is a 400, and the cast
 * hash changes with the voices.
 */

const cast = require('../../../../services/catalogEngine/audio/cast');
const catalog = require('../../../../services/catalogEngine/catalog');

const theme = id => catalog.baseCatalog().themes[id];

describe('cast file', () => {
  test('loads, and every voice is pinned for elevenlabs, gemini and openai', () => {
    const c = cast.loadCast();
    for (const [key, v] of Object.entries(c.voices)) {
      for (const p of ['elevenlabs', 'gemini', 'openai']) expect(v.providers[p]).toBeTruthy();
      expect(['narrator', 'companion']).toContain(v.kind);
      expect(key).toMatch(/^[a-z][a-z0-9_]+$/);
    }
    expect(cast.narratorOptions().length).toBeGreaterThanOrEqual(3);
    expect(cast.companionOptions().length).toBeGreaterThanOrEqual(4);
    expect(cast.castFileHash()).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('companionCastKey', () => {
  test('a PERSON-typed companion is an adult guide; theme overrides win', () => {
    expect(cast.companionCastKey(theme('farm'))).toBe('guide_adult_f');
    expect(cast.companionCastKey(theme('construction'))).toBe('guide_adult_m');
  });
  test('small creatures and large creatures', () => {
    expect(cast.companionCastKey(theme('safari'))).toBe('creature_small'); // young meerkat
    expect(cast.companionCastKey({ theme_id: 'x', companion: { name: 'Rex', type: 'big friendly dragon' } })).toBe('creature_large');
    expect(cast.companionCastKey(theme('dream'))).toBe('magical');
  });
  test('no named companion → null', () => {
    expect(cast.companionCastKey({ theme_id: 'x', companion: null })).toBeNull();
  });
});

describe('resolveCast', () => {
  test('is deterministic per theme + band and pins the provider entry', () => {
    const a = cast.resolveCast({ provider: 'elevenlabs', theme: theme('farm'), ageBand: '4-5', seedBasis: 'fp' });
    const b = cast.resolveCast({ provider: 'elevenlabs', theme: theme('farm'), ageBand: '4-5', seedBasis: 'fp' });
    expect(a.narrator.key).toBe(b.narrator.key);
    expect(a.narrator.voiceId).toMatch(/^[A-Za-z0-9]{10,}$/);
    expect(a.narrator.model).toBe('eleven_v3');
    expect(a.companion.key).toBe('guide_adult_f');
    expect(a.hash).toBe(b.hash);
  });
  test('band 1-3 is narrator-only; request "none" drops the companion; a request override is honoured', () => {
    expect(cast.resolveCast({ provider: 'gemini', theme: theme('farm'), ageBand: '1-3' }).companion).toBeNull();
    expect(cast.resolveCast({ provider: 'gemini', theme: theme('farm'), ageBand: '6-7', request: { companion: 'none' } }).companion).toBeNull();
    const r = cast.resolveCast({ provider: 'openai', theme: theme('farm'), ageBand: '6-7', request: { narrator: 'storyteller_bright', companion: 'creature_small' } });
    expect(r.narrator.key).toBe('storyteller_bright');
    expect(r.narrator.voice).toBe('shimmer');
    expect(r.companion.key).toBe('creature_small');
  });
  test('character voices off → no companion; the hash differs from the voiced cast', () => {
    const on = cast.resolveCast({ provider: 'elevenlabs', theme: theme('farm'), ageBand: '6-7' });
    const off = cast.resolveCast({ provider: 'elevenlabs', theme: theme('farm'), ageBand: '6-7', characterVoices: false });
    expect(off.companion).toBeNull();
    expect(off.hash).not.toBe(on.hash);
  });
  test('an unknown voice key or an unpinned provider is a 400', () => {
    expect(() => cast.resolveCast({ provider: 'elevenlabs', theme: theme('farm'), ageBand: '6-7', request: { narrator: 'robot_voice' } })).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => cast.resolveCast({ provider: 'nope', theme: theme('farm'), ageBand: '6-7' })).toThrow(/not pinned/);
  });
  test('the default narrator covers every theme', () => {
    for (const t of Object.values(catalog.baseCatalog().themes)) {
      expect(cast.narratorOptions().map(o => o.key)).toContain(cast.defaultNarratorKey({ themeId: t.theme_id, ageBand: '6-7' }));
    }
  });
});
