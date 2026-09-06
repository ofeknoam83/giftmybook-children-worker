jest.mock('../../../services/gcsStorage', () => ({ downloadBuffer: jest.fn(), uploadBuffer: jest.fn() }));
const storage = require('../../../services/gcsStorage');
const { createBackCoverSynopsis, shortExcerpt } = require('../../../services/catalogEngine/backCoverSynopsis');
const story = { title: 'Amit and the Moonflower Festival', spreads: [
  { text: 'Amit stepped into Whispering Wood as Lumi zipped close. Three jobs waited ahead: hang ribbons, place glow markers, and open the flower shades.' },
  { text: 'He looked from one job to the next. Which should he start first?' },
  { text: 'Amit began with the ribbons. Soon the flower shades blocked the ribbon hooks.' },
  { text: 'ENDING SECRET: the festival succeeds.' },
] };
const blurb = 'In Whispering Wood, Amit and Lumi have a moonlit festival to prepare. But when one task gets in the way of another, Amit must find a better order. Can he untangle the jobs before the celebration begins?';
const opts = { bookId: 'book', childName: 'Amit', log: jest.fn(), callText: jest.fn() };
beforeEach(() => {
  jest.clearAllMocks();
  storage.downloadBuffer.mockRejectedValue(new Error('missing'));
  storage.uploadBuffer.mockResolvedValue(undefined);
  opts.callText.mockResolvedValue({ json: { synopsis: blurb }, model: 'gemini-2.5-flash', usage: {} });
});
test('replaces a known opening excerpt with one bounded blurb call, without exposing the ending', async () => {
  expect(await createBackCoverSynopsis(story, { ...opts, cached: shortExcerpt(story) })).toBe(blurb);
  expect(opts.callText).toHaveBeenCalledTimes(1);
  expect(opts.callText.mock.calls[0][0]).toMatchObject({ maxAttempts: 1, timeoutMs: 20000, allowGeminiFallback: false });
  expect(opts.callText.mock.calls[0][0].userPrompt).not.toContain('ENDING SECRET');
  expect(storage.uploadBuffer).toHaveBeenCalledTimes(1);
});
test('cached and editor-approved blurbs avoid additional text calls', async () => {
  expect(await createBackCoverSynopsis(story, { ...opts, cached: 'An approved blurb.' })).toBe('An approved blurb.');
  expect(opts.callText).not.toHaveBeenCalled();
  storage.downloadBuffer.mockResolvedValue(Buffer.from(JSON.stringify({ synopsis: blurb })));
  expect(await createBackCoverSynopsis(story, opts)).toBe(blurb);
  expect(opts.callText).not.toHaveBeenCalled();
});
test.each(['Too short.', 'bestseller '.repeat(30), 'unexpected '.repeat(80)])('invalid generated copy uses the saved text and does not cache the failure', async bad => {
  opts.callText.mockResolvedValue({ json: { synopsis: bad } });
  expect(await createBackCoverSynopsis(story, opts)).toBe(shortExcerpt(story));
  expect(storage.uploadBuffer).not.toHaveBeenCalled();
});
test('a text-service outage does not fail book completion', async () => {
  opts.callText.mockRejectedValue(new Error('unavailable'));
  expect(await createBackCoverSynopsis(story, opts)).toBe(shortExcerpt(story));
  expect(opts.callText).toHaveBeenCalledTimes(1);
  expect(opts.log).toHaveBeenCalledWith('warn', expect.stringContaining('unavailable'));
});
