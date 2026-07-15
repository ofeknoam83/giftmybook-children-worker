/**
 * imageClient model fallback (2026-07-15): a wrong/unprovisioned renderer
 * model id (404 "not found for API version") must degrade LOUDLY to the
 * known-good fallback model instead of bricking every render. Invalid ids
 * are remembered for the process so later calls skip the dead model.
 */

jest.mock('../../../services/illustrationGenerator', () => ({
  getNextApiKey: jest.fn(() => 'test-key'),
  fetchWithTimeout: jest.fn(),
  downloadPhotoAsBase64: jest.fn(),
}));

const { fetchWithTimeout } = require('../../../services/illustrationGenerator');
const { generateImage, FALLBACK_IMAGE_MODEL } = require('../../../services/bookPipelineV3/illustrator/render/imageClient');

const IMG_B64 = Buffer.from('img').toString('base64');

function okImageResponse() {
  return {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: IMG_B64, mimeType: 'image/png' } }] } }] }),
  };
}

function notFoundResponse(model) {
  return {
    ok: false,
    status: 404,
    text: async () => `{"error":{"message":"models/${model} is not found for API version v1beta, or is not supported for generateContent."}}`,
  };
}

const urlOf = (call) => call[0];

beforeEach(() => {
  jest.clearAllMocks();
});

describe('imageClient model fallback', () => {
  test('an invalid model id falls back loudly to the known-good model; result reports the model actually used', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(notFoundResponse('bogus-pro-image-a'))
      .mockResolvedValueOnce(okImageResponse());

    const res = await generateImage({ model: 'bogus-pro-image-a', prompt: 'p', label: 't1' });

    expect(res.model).toBe(FALLBACK_IMAGE_MODEL);
    expect(res.buffer.toString()).toBe('img');
    expect(urlOf(fetchWithTimeout.mock.calls[0])).toContain('/models/bogus-pro-image-a:');
    expect(urlOf(fetchWithTimeout.mock.calls[1])).toContain(`/models/${FALLBACK_IMAGE_MODEL}:`);
  });

  test('a known-invalid id skips straight to the fallback on later calls (no repeated 404s)', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(notFoundResponse('bogus-pro-image-b'))
      .mockResolvedValueOnce(okImageResponse()) // fallback for call 1
      .mockResolvedValueOnce(okImageResponse()); // call 2 goes straight to fallback

    await generateImage({ model: 'bogus-pro-image-b', prompt: 'p', label: 't2' });
    const res2 = await generateImage({ model: 'bogus-pro-image-b', prompt: 'p', label: 't2' });

    expect(res2.model).toBe(FALLBACK_IMAGE_MODEL);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
    expect(urlOf(fetchWithTimeout.mock.calls[2])).toContain(`/models/${FALLBACK_IMAGE_MODEL}:`);
  });

  test('the fallback model failing propagates the error (no infinite chain)', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(notFoundResponse('bogus-pro-image-c'))
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'bad request' });

    await expect(generateImage({ model: 'bogus-pro-image-c', prompt: 'p', label: 't3' }))
      .rejects.toThrow(/HTTP 400/);
  });

  test('a 404 on the fallback model itself does not loop', async () => {
    fetchWithTimeout.mockResolvedValueOnce(notFoundResponse(FALLBACK_IMAGE_MODEL));
    await expect(generateImage({ model: FALLBACK_IMAGE_MODEL, prompt: 'p', label: 't4' }))
      .rejects.toThrow(/not available/);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  test('transient errors keep the existing retry path (no fallback for 503s)', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'UNAVAILABLE' })
      .mockResolvedValueOnce(okImageResponse());

    const res = await generateImage({ model: 'good-model', prompt: 'p', label: 't5' });
    expect(res.model).toBe('good-model');
    expect(urlOf(fetchWithTimeout.mock.calls[1])).toContain('/models/good-model:');
  }, 15000);
});
