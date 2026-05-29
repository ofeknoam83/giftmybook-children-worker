process.env.GEMINI_API_KEY = 'test-gemini-key';

jest.mock('../../../services/gcsStorage', () => ({
  saveJson: jest.fn().mockResolvedValue(undefined),
  loadJson: jest.fn(),
}));

jest.mock('../../../services/retry', () => ({
  withRetry: jest.fn((fn) => fn()),
}));

const { loadJson } = require('../../../services/gcsStorage');
const { detectFaces } = require('../../../services/comics/detectFaces');

describe('detectFaces', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => Buffer.from('image-bytes'),
        headers: { get: () => 'image/jpeg' },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '[]' }] } }],
        }),
      });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('logs cache lookup failures with the underlying error message', async () => {
    loadJson.mockRejectedValue(new Error('gcs unavailable'));

    await detectFaces('https://example.com/group-photo.jpg');

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Cache lookup failed')
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('gcs unavailable')
    );
  });
});
