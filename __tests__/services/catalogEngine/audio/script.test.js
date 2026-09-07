/**
 * The audio script (ab-1 §4.1): sentence splitting with verbatim masks (a
 * two-sentence refrain stays one line, "Jo Jo" never splits, quotes stay
 * beside their attribution), line shapes, dialogue attribution (companion
 * only when named outside the quotes, never on a child-name collision,
 * never under band 1-3), the refrain's pinned delivery, the fixed intro /
 * dedication / outro lines, expected timings, the closed direction words,
 * the schema, the hash — and the whole catalog with a synthetic story.
 */

const script = require('../../../../services/catalogEngine/audio/script');
const { validateMusicPlan } = require('../../../../services/catalogEngine/audio/music/plan');
const { validateSfxPlan } = require('../../../../services/catalogEngine/audio/sfx/plan');
const { buildEmotionPlan, EMOTIONS, INTENSITIES } = require('../../../../services/catalogEngine/illustrator/emotionPlan');
const { resolveCast } = require('../../../../services/catalogEngine/audio/cast');
const catalog = require('../../../../services/catalogEngine/catalog');
const { AUDIO_VERSION } = require('../../../../services/catalogEngine/versions');

const raw = catalog.baseCatalog();
const farm = raw.themes.farm;
const farmBook = farm.age_bands['4-5'][0];
const profile = { name: 'Emma', age: 5 };
const syntheticStory = (book, theme, name = 'Emma') => ({
  title: book.title_template.replace('{name}', name),
  spreads: book.beats.map(b => ({
    spread: b.spread,
    text: `${book.refrain && book.refrain.spreads.includes(b.spread) ? `${book.refrain.text} ` : ''}${name} looked around. ${b.beat.replace(/^Child/, name)} "Hello there!" said ${theme.companion.name}. The cow said moo and the birds sang.`,
  })),
  personalization_evidence: [{ source_field: 'object', source_value: 'rubber duck', moment_type: 'object_presence', spread: 5, slot_id: 's', visual_required: true }],
});
const build = (book, theme, band, extra = {}) => {
  const story = syntheticStory(book, theme);
  const emotionPlan = buildEmotionPlan({ book, story, ageBand: band });
  const cast = resolveCast({ provider: 'elevenlabs', theme, ageBand: band, seedBasis: book.id });
  return script.buildAudioScript({ story, book, theme, profile, ageBand: band, emotionPlan, cast, seedBasis: book.id, ...extra });
};

describe('splitLines', () => {
  const masks = ['Emma', 'Farmer Bea', 'Sunnybrook Farm', 'Farm', 'Hello, farm! Here we are!'];
  test('a two-sentence refrain is one line; quotes stay with their attribution; abbreviations hold', () => {
    const lines = script.splitLines('Hello, farm! Here we are! Emma looked around. "Hello there!" said Farmer Bea. Farmer Bea laughed, "Come and see the cow." Emma ran. Mr. Fox waved… Then what?', masks);
    expect(lines).toEqual([
      'Hello, farm! Here we are!',
      'Emma looked around.',
      '"Hello there!" said Farmer Bea.',
      'Farmer Bea laughed, "Come and see the cow."',
      'Emma ran.',
      'Mr. Fox waved…',
      'Then what?',
    ]);
  });
  test('"Jo Jo" and "choo choo train" never split; a quote with inner sentences is one atom', () => {
    expect(script.splitLines('Jo Jo hopped. Choo choo train! Bea said, "One. Two. Three!" The end.', ['Jo Jo', 'choo choo train', 'Bea']))
      .toEqual(['Jo Jo hopped.', 'Choo choo train!', 'Bea said, "One. Two. Three!"', 'The end.']);
  });
  test('line breaks split verse; empties are dropped', () => {
    expect(script.splitLines('Line one\nLine two!\n\nLine three?', [])).toEqual(['Line one', 'Line two!', 'Line three?']);
    expect(script.splitLines('   ', [])).toEqual([]);
  });
  test('shapes', () => {
    expect(script.lineShape('Hello!')).toBe('exclaim');
    expect(script.lineShape('Really?')).toBe('question');
    expect(script.lineShape('And then…')).toBe('trail');
    expect(script.lineShape('"Wait..."')).toBe('trail');
    expect(script.lineShape('Fine.')).toBe('statement');
  });
});

describe('attributeLine', () => {
  const companion = { name: 'Farmer Bea', type: 'friendly adult farm guide' };
  const ctx = { childName: 'Emma', theme: farm, enabled: true };
  test('the quote goes to the companion, the attribution stays with the narrator, in order', () => {
    expect(script.attributeLine('"Hello there!" said Farmer Bea.', companion, ctx)).toEqual([
      { text: '"Hello there!"', speaker: 'companion' }, { text: 'said Farmer Bea.', speaker: 'narrator' },
    ]);
    expect(script.attributeLine('Farmer Bea laughed, "Come and see."', companion, ctx)).toEqual([
      { text: 'Farmer Bea laughed,', speaker: 'narrator' }, { text: '"Come and see."', speaker: 'companion' },
    ]);
  });
  test('the child\'s lines, unattributed quotes, a name collision, or disabled → narrator', () => {
    expect(script.attributeLine('"I did it!" Emma cheered.', companion, ctx)).toEqual([{ text: '"I did it!" Emma cheered.', speaker: 'narrator' }]);
    expect(script.attributeLine('"Hello!" someone said.', companion, ctx)).toHaveLength(1);
    expect(script.attributeLine('"Hi!" said Farmer Bea to Emma.', companion, ctx)[0].speaker).toBe('narrator');
    expect(script.attributeLine('"Hi!" said Bea.', { name: 'Bea' }, { childName: 'Bea', enabled: true })[0].speaker).toBe('narrator');
    expect(script.attributeLine('"Hi!" said Farmer Bea.', companion, { ...ctx, enabled: false })[0].speaker).toBe('narrator');
  });
  test('the world name never summons the companion ("Farm" inside "Farmer Bea" is handled by the whole-word mask)', () => {
    expect(script.attributeLine('"Moo!" said the cow of Sunnybrook Farm.', companion, ctx)[0].speaker).toBe('narrator');
  });
});

describe('buildAudioScript', () => {
  test('segments: intro, spreads in order, outro; refrain lines pinned; companion lines voiced; validates; hashes', () => {
    const { script: s, music, sfx } = build(farmBook, farm, '4-5', { dedication: { text: 'We love you to the moon and back. Always.', from: 'Mom and Dad' } });
    expect(s.version).toBe(AUDIO_VERSION);
    expect(s.segments[0].kind).toBe('intro');
    expect(s.segments[0].lines[0].text).toBe(`${farmBook.title_template.replace('{name}', 'Emma')}.`);
    expect(s.segments[0].lines[1].text).toBe('A story for Emma.');
    expect(s.segments[1].kind).toBe('dedication');
    expect(s.segments[1].lines[0].text).toBe('A note from Mom and Dad.');
    expect(s.segments[1].lines[1].direction.emotion).toBe('tenderness');
    const spreads = s.segments.filter(x => x.kind === 'spread');
    expect(spreads.map(x => x.spread)).toEqual(farmBook.beats.map(b => b.spread));
    expect(s.segments[s.segments.length - 1].kind).toBe('outro');
    expect(s.segments[s.segments.length - 1].lines.map(l => l.text)).toEqual(['The end.', 'Thank you for listening.']);
    for (const r of farmBook.refrain.spreads) {
      const seg = spreads.find(x => x.spread === r);
      const refrainLine = seg.lines.find(l => l.isRefrain);
      expect(refrainLine).toBeTruthy();
      expect(refrainLine.text).toBe(farmBook.refrain.text);
      expect(refrainLine.pauseAfterMs === 900 || refrainLine.pauseAfterMs === 0).toBe(true);
      expect(seg.music.motif).toBe(true);
    }
    expect(spreads.some(x => x.lines.some(l => l.speaker === 'companion' && l.text === '"Hello there!"'))).toBe(true);
    for (const seg of s.segments) {
      expect(seg.lines[seg.lines.length - 1].pauseAfterMs).toBe(0);
      expect(seg.expectedSeconds.min).toBeLessThan(seg.expectedSeconds.max);
      for (const l of seg.lines) {
        expect(EMOTIONS).toContain(l.direction.emotion);
        expect(INTENSITIES).toContain(l.direction.intensity);
      }
    }
    expect(s.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(script.validateAudioScript(s).ok).toBe(true);
    expect(validateMusicPlan(s.segments, '4-5').ok).toBe(true);
    expect(validateSfxPlan(s.segments, '4-5').ok).toBe(true);
    expect(music.spans.length).toBeGreaterThan(1);
    expect(sfx.placed.some(p => p.cueId === 'duck_quack' && p.spread === 5 && p.source === 'evidence')).toBe(true);
    expect(s.pageTurn.cueId).toBe('transition_page');
  });
  test('band 1-3: narrator only, slow pace, longer pauses, wonder intro', () => {
    const book = farm.age_bands['1-3'][0];
    const { script: s } = build(book, farm, '1-3');
    expect(s.segments.every(seg => seg.lines.every(l => l.speaker === 'narrator'))).toBe(true);
    expect(s.segments[0].lines[0].direction).toMatchObject({ emotion: 'wonder', intensity: 'soft', pace: 'slow' });
    const spread = s.segments.find(x => x.kind === 'spread');
    expect(spread.lines[0].pauseAfterMs).toBe(650);
  });
  test('the same inputs hash the same; a different cast, language or dedication hashes differently', () => {
    const a = build(farmBook, farm, '4-5').script;
    const b = build(farmBook, farm, '4-5').script;
    expect(a.hash).toBe(b.hash);
    expect(build(farmBook, farm, '4-5', { language: 'es' }).script.hash).not.toBe(a.hash);
    expect(build(farmBook, farm, '4-5', { dedication: { text: 'Hi.' } }).script.hash).not.toBe(a.hash);
    const es = build(farmBook, farm, '4-5', { language: 'es' }).script;
    expect(es.segments[0].lines[1].text).toBe('Un cuento para Emma.');
    expect(es.segments[es.segments.length - 1].lines[0].text).toBe('Fin.');
  });
  test('options: music / sfx off leave the segments unannotated', () => {
    const { script: s } = build(farmBook, farm, '4-5', { options: { music: false, sfx: false } });
    expect(s.segments.every(seg => seg.music === null && seg.sfx.length === 0 && seg.ambience === null)).toBe(true);
    expect(s.pageTurn).toBeNull();
  });
  test('a long dedication is cut at 80 words with an advisory; a missing spread text is an advisory', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i + 1} is here.`).join(' ');
    const { script: s } = build(farmBook, farm, '4-5', { dedication: { text } });
    expect(s.advisories.some(a => /dedication cut/.test(a))).toBe(true);
    const ded = s.segments.find(x => x.kind === 'dedication');
    expect(ded.expectedWords).toBeLessThanOrEqual(script.MAX_DEDICATION_WORDS + 5);
  });
  test('direction words come from the closed table; control words are lower-case tokens', () => {
    expect(script.directionWords({ emotion: 'joy', intensity: 'big', shape: 'exclaim' })).toBe('bursting with joy, energetic, with a bright lift');
    expect(script.directionWords({ emotion: 'x', intensity: 'y', shape: 'statement' })).toBe('calm and even');
    expect(script.directionWords({}, { refrain: true })).toMatch(/refrain/);
    const words = script.controlWords();
    expect(words).toContain('whispers');
    expect(words.every(w => w === w.toLowerCase() && w.length >= 4)).toBe(true);
  });
});

describe('every catalog book × its band', () => {
  test('builds a valid script whose refrain spreads carry a refrain line, music and cue invariants hold', () => {
    let books = 0;
    let companionLines = 0;
    for (const theme of Object.values(raw.themes)) {
      for (const [band, list] of Object.entries(theme.age_bands)) {
        for (const book of list) {
          const { script: s } = build(book, theme, band);
          expect(s.advisories.filter(a => /refrain is not/.test(a))).toEqual([]);
          expect(validateMusicPlan(s.segments, band).errors).toEqual([]);
          expect(validateSfxPlan(s.segments, band).errors).toEqual([]);
          companionLines += s.segments.reduce((n, seg) => n + seg.lines.filter(l => l.speaker === 'companion').length, 0);
          books += 1;
        }
      }
    }
    expect(books).toBe(228);
    expect(companionLines).toBeGreaterThan(1000);
  });
});
