jest.mock('../../../../services/catalogEngine/audio/geminiAudio', () => ({ judgeAudio: jest.fn() }));
const { judgeAudio } = require('../../../../services/catalogEngine/audio/geminiAudio');
const { verifySpellingAmbiguity, hasVerifiedExactSpeech } = require('../../../../services/catalogEngine/audio/exactSpeech');
const { encodeWav, sine } = require('../../../../services/catalogEngine/audio/wav');
const input = () => ({ expectedText: 'Bright route markers curved toward the watering hole.',
  transcript: 'Bright root markers curved toward the watering hole.', language: 'en',
  wav: encodeWav(sine({ hz: 440, seconds: 2, amp: 0.2, sampleRate: 24000 }), 24000) });
const approval = () => ({ json: { complete_recording: true, decisions: [{ index: 1, same_pronunciation: true }] } });
beforeEach(() => judgeAudio.mockReset());

test('same-sounding spelling requires an audio verdict, bound to the original transcript and recording', async () => {
  const p = input();
  expect(hasVerifiedExactSpeech(p)).toBe(false);
  judgeAudio.mockResolvedValue(approval());
  const textVerification = await verifySpellingAmbiguity(p);
  expect(textVerification.differences).toEqual([{ index: 1, expected: 'route', heard: 'root' }]);
  expect(hasVerifiedExactSpeech({ ...p, textVerification })).toBe(true);
  expect(judgeAudio.mock.calls[0][0].audio[0].mimeType).toBe('audio/wav');
  for (const change of [{ expectedText: 'Bright red markers curved toward the watering hole.' },
    { transcript: 'Bright rude markers curved toward the watering hole.' }, { language: 'es' },
    { wav: Buffer.from('another take') }, { textVerification: { ...textVerification, version: 'old' } }]) {
    expect(hasVerifiedExactSpeech({ ...p, textVerification, ...change })).toBe(false);
  }
});

test.each([
  'Bright markers curved toward the watering hole.',
  'Bright root markers curved toward the watering hole again.',
  'Route bright markers curved toward the watering hole.',
  'All these words were replaced with other speech.',
])('omissions, additions, reorderings and broad rewrites never use spelling approval: %s', async transcript => {
  judgeAudio.mockResolvedValue(approval());
  expect(await verifySpellingAmbiguity({ ...input(), transcript })).toBeNull();
  expect(judgeAudio).not.toHaveBeenCalled();
});

test.each([
  { complete_recording: false, decisions: [{ index: 1, same_pronunciation: true }] },
  { complete_recording: true, decisions: [{ index: 1, same_pronunciation: false }] },
  { complete_recording: true, decisions: [{ index: 2, same_pronunciation: true }] },
  { complete_recording: true, decisions: [] },
  { complete_recording: true, decisions: [{ index: 1, same_pronunciation: true }, { index: 1, same_pronunciation: true }] },
])('failed or malformed audio verdicts cannot authorize a spelling difference', async json => {
  judgeAudio.mockResolvedValue({ json });
  expect(await verifySpellingAmbiguity(input())).toBeNull();
});

test('unavailable spelling verification stays unapproved', async () => {
  judgeAudio.mockRejectedValue(new Error('HTTP 503'));
  expect(await verifySpellingAmbiguity(input())).toBeNull();
});
