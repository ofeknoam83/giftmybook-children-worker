const { manuscriptUnits, validateDirection } = require('../../../../services/catalogEngine/video/filmScript');
const { speechShots, shotCommand, finishCommand } = require('../../../../services/catalogEngine/video/filmMedia');
const { encodeWav, parseWav } = require('../../../../services/catalogEngine/audio/wav');
const { modelProfile } = require('../../../../services/catalogEngine/video/providers/models');
const { filmBrief, validateFullStoryInput } = require('../../../../services/catalogEngine/video/fullStory');

const story = { spreads: Array.from({ length: 12 }, (_, i) => ({ spread: i + 1, text: `Jo saw a tree. “Hello!” said Jo. Patch answered, “Welcome!”` })) };
const cast = [{ id: 'narrator', name: 'Narrator', voiceKey: 'storyteller_warm_f' }, { id: 'child', name: 'Jo', voiceKey: 'storyteller_bright' }, { id: 'companion', name: 'Patch', voiceKey: 'creature_small' }];
const direction = units => ({ cast, assignments: units.map(u => ({ id: u.id, speaker: u.text.includes('Hello') ? 'child' : u.text.includes('Welcome') ? 'companion' : 'narrator', certain: true, emotion: 'wonder' })) });

test('covers all 12 spreads byte for byte, preserving quotes, whitespace and attribution', () => {
  const units = manuscriptUnits(story);
  for (const spread of story.spreads) expect(units.filter(u => u.spread === spread.spread).map(u => u.text).join('')).toBe(spread.text);
  const script = validateDirection(direction(units), units, 'elevenlabs', '1-3');
  expect(script.turns.filter(t => t.speaker === 'child')).toHaveLength(12);
  expect(script.turns.filter(t => t.speaker === 'companion')).toHaveLength(12);
  expect(script.turns.filter(t => /said Jo/.test(t.text)).every(t => t.speaker === 'narrator')).toBe(true);
  expect(script.cast.child.voice.voiceId).not.toBe(script.cast.narrator.voice.voiceId);
});

test('rejects missing scenes, reordered assignments, unknown speakers, uncertain speakers and duplicate voices', () => {
  expect(() => manuscriptUnits({ spreads: story.spreads.slice(1) })).toThrow(/12/);
  const units = manuscriptUnits(story);
  const bad = direction(units); bad.assignments.reverse();
  expect(() => validateDirection(bad, units, 'elevenlabs', '4-5')).toThrow(/assignment/i);
  for (const change of [{ speaker: 'invented' }, { certain: false }]) {
    const raw = direction(units); raw.assignments[1] = { ...raw.assignments[1], ...change };
    expect(() => validateDirection(raw, units, 'elevenlabs', '4-5')).toThrow();
  }
  const shared = direction(units); shared.cast = cast.map(c => ({ ...c, voiceKey: 'storyteller_warm_f' }));
  expect(() => validateDirection(shared, units, 'elevenlabs', '4-5')).toThrow(/distinct/);
});

test('measured long speech is partitioned exactly once, with no lost source samples or oversized shots', () => {
  const rate = 24000; const samples = Float32Array.from({ length: rate * 41 }, (_, i) => 0.15 * Math.sin(i * 0.071));
  const wav = encodeWav(samples, rate); const decoded = parseWav(wav).samples;
  const parts = speechShots(wav, { start: 0.2, end: 40.8 });
  expect(parts.length).toBeGreaterThan(2);
  let cursor = Math.floor(0.2 * rate);
  for (const part of parts) {
    expect(part.seconds).toBeGreaterThanOrEqual(3);
    expect(part.seconds).toBeLessThanOrEqual(14);
    expect(part.seconds * 30).toBeCloseTo(Math.round(part.seconds * 30), 8);
    expect(Math.round(part.sourceStart * rate)).toBe(cursor);
    const end = Math.round(part.sourceEnd * rate);
    const actual = parseWav(part.buffer).samples;
    const head = Math.round(part.speechStart * rate);
    for (let i = cursor; i < end; i += 997) expect(actual[head + i - cursor]).toBeCloseTo(decoded[i], 4);
    cursor = end;
  }
  expect(cursor).toBe(Math.ceil(40.8 * rate));
});

test('very short dialogue keeps its audio and gets breathing space without exceeding model limits', () => {
  const p = speechShots(encodeWav(new Float32Array(2400).fill(0.1), 24000));
  expect(p).toHaveLength(1); expect(p[0].seconds).toBe(3);
  expect(p[0].speechEnd - p[0].speechStart).toBeCloseTo(0.1);
});

test('the Omni request uses the verified schema, actual references and no generated speech', () => {
  const model = modelProfile('kwaivgi/kling-v3-omni-video');
  const input = model.input({ brief: { prompt: 'Keep [REF1] consistent' }, startFrameUrl: 'https://s/frame.jpg', referenceUrls: [{ urls: ['https://s/sheet.png'] }], seconds: 14, aspect: '16:9' });
  expect(input).toEqual({ prompt: 'Keep <<<image_1>>> consistent', start_image: 'https://s/frame.jpg', reference_images: ['https://s/sheet.png'], duration: 14, aspect_ratio: '16:9', mode: 'pro', generate_audio: false });
  expect(() => model.input({ brief: { prompt: 'x'.repeat(2501) }, referenceUrls: [] })).toThrow(/2500/);
});

test('speech replaces vendor audio; final assembly has no time-stealing overlaps or speedups', () => {
  const argv = shotCommand({ video: 'v.mp4', audio: 'a.wav', output: 'o.mkv', seconds: 6.4, width: 1920, height: 1080 });
  expect(argv.join(' ')).toContain('-map 0:v:0 -map 1:a:0');
  expect(argv.join(' ')).not.toMatch(/atempo|tpad|shortest/);
  const finish = finishCommand({ list: 'shots.txt', soundtrack: 'soundtrack.wav', output: 'film.mp4', seconds: 400 });
  expect(finish.join(' ')).toContain('-map 0:v:0 -map 1:a:0');
  expect(finish.join(' ')).not.toMatch(/xfade|atempo|shortest/);
});

test('dialogue brief requests acting by the correct character and narration does not move mouths', () => {
  const units = manuscriptUnits(story); const script = validateDirection(direction(units), units, 'elevenlabs', '4-5');
  const ctx = { story, profile: { name: 'Jo' }, bookDef: { book: { beats: [{ spread: 1, beat: 'Jo meets Patch.' }] } }, script, references: [{ kind: 'character' }] };
  const shot = { index: 0, spread: 1, speaker: 'child', speechStart: 0.2, speechEnd: 5.2, emotion: 'wonder', text: 'Hello!', audio: Buffer.from('audio') };
  const dialogue = filmBrief(shot, ctx);
  expect(dialogue.prompt).toContain('Only "Jo" speaks');
  expect(dialogue.prompt.length).toBeLessThan(2400);
  expect(filmBrief({ ...shot, speaker: 'narrator' }, ctx).prompt).toContain('every visible character keeps their mouth closed');
});

test('preflight rejects a partial film before accepting it or generating voices', () => {
  expect(() => validateFullStoryInput({ bookId: 'b', story, renders: [] })).toThrow(/12 shipped/);
});
