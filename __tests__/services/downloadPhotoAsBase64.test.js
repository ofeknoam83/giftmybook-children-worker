/**
 * The identity anchor download (2026-09-16): the app stores the approved
 * cover as a CANONICAL GCS URL (no signature) and a stored/expired URL made
 * the worker's plain fetch a 403 — every book failed
 * `missing_identity_reference` before a single spread rendered. A GCS
 * object the HTTP fetch refuses is now read with the worker's own
 * credentials; anything else keeps the HTTP verdict.
 */
const mockDownload = jest.fn();
const mockGetMetadata = jest.fn();
const mockFile = jest.fn(() => ({ download: mockDownload, getMetadata: mockGetMetadata }));
const mockBucket = jest.fn(() => ({ file: mockFile }));
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: mockBucket })),
}));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 2)]);

function httpResponse({ ok, status = 200, statusText = 'OK', body = PNG, contentType = 'image/png' }) {
  return {
    ok, status, statusText,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

const CANONICAL = 'https://storage.googleapis.com/giftmybook-files/children-covers/book-1/approved%20cover.png';
const SIGNED = `${CANONICAL}?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=deadbeef`;

describe('gcsStorage.parseGcsObjectUrl', () => {
  const { parseGcsObjectUrl } = require('../../services/gcsStorage');

  it('names the object of a path-style URL, signature dropped and path decoded once', () => {
    expect(parseGcsObjectUrl(SIGNED)).toEqual({ bucket: 'giftmybook-files', objectPath: 'children-covers/book-1/approved cover.png' });
    expect(parseGcsObjectUrl(CANONICAL)).toEqual(parseGcsObjectUrl(SIGNED));
  });

  it('names the object of a virtual-hosted URL', () => {
    expect(parseGcsObjectUrl('https://giftmybook-bucket.storage.googleapis.com/children-jobs/b/cover.png?x=1'))
      .toEqual({ bucket: 'giftmybook-bucket', objectPath: 'children-jobs/b/cover.png' });
  });

  it('is null for anything that is not a GCS object URL', () => {
    expect(parseGcsObjectUrl('https://cdn.example/cover.png')).toBeNull();
    expect(parseGcsObjectUrl('gs://giftmybook-files/children-covers/b/cover.png')).toBeNull();
    expect(parseGcsObjectUrl('https://storage.googleapis.com/only-a-bucket')).toBeNull();
    expect(parseGcsObjectUrl('children-covers/b/cover.png')).toBeNull();
    expect(parseGcsObjectUrl(null)).toBeNull();
  });
});

describe('illustrationGenerator.downloadPhotoAsBase64', () => {
  let downloadPhotoAsBase64;
  const originalFetch = global.fetch;

  beforeAll(() => {
    ({ downloadPhotoAsBase64 } = require('../../services/illustrationGenerator'));
  });
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });
  afterAll(() => { global.fetch = originalFetch; });

  it('a URL the HTTP fetch serves is used as before — no credentialed read', async () => {
    global.fetch.mockResolvedValue(httpResponse({ ok: true, body: JPEG, contentType: 'image/jpeg' }));
    const out = await downloadPhotoAsBase64(SIGNED);
    expect(out).toEqual({ base64: JPEG.toString('base64'), mimeType: 'image/jpeg' });
    expect(mockBucket).not.toHaveBeenCalled();
  });

  it('a GCS object the fetch refuses (the stored canonical cover, 403) is read with the worker credentials', async () => {
    global.fetch.mockResolvedValue(httpResponse({ ok: false, status: 403, statusText: 'Forbidden' }));
    mockDownload.mockResolvedValue([PNG]);
    mockGetMetadata.mockResolvedValue([{ contentType: 'image/png' }]);
    const out = await downloadPhotoAsBase64(CANONICAL);
    expect(out).toEqual({ base64: PNG.toString('base64'), mimeType: 'image/png' });
    expect(mockBucket).toHaveBeenCalledWith('giftmybook-files');
    expect(mockFile).toHaveBeenCalledWith('children-covers/book-1/approved cover.png');
  });

  it('an expired signature falls back the same way and sniffs the type when the object carries none', async () => {
    global.fetch.mockResolvedValue(httpResponse({ ok: false, status: 400, statusText: 'Bad Request' }));
    mockDownload.mockResolvedValue([JPEG]);
    mockGetMetadata.mockRejectedValue(new Error('no metadata permission'));
    const out = await downloadPhotoAsBase64(SIGNED);
    expect(out).toEqual({ base64: JPEG.toString('base64'), mimeType: 'image/jpeg' });
  });

  it('a refused URL that is not a GCS object keeps the HTTP verdict', async () => {
    global.fetch.mockResolvedValue(httpResponse({ ok: false, status: 403, statusText: 'Forbidden' }));
    await expect(downloadPhotoAsBase64('https://cdn.example/cover.png')).rejects.toThrow('Failed to download photo: 403 Forbidden');
    expect(mockBucket).not.toHaveBeenCalled();
  });

  it('an object the credentials cannot read either fails naming both refusals', async () => {
    global.fetch.mockResolvedValue(httpResponse({ ok: false, status: 403, statusText: 'Forbidden' }));
    mockDownload.mockRejectedValue(new Error('caller does not have storage.objects.get access'));
    await expect(downloadPhotoAsBase64(CANONICAL)).rejects.toThrow(
      /Failed to download photo: 403 Forbidden; reading gs:\/\/giftmybook-files\/children-covers\/book-1\/approved cover\.png with the worker's own credentials failed too: caller does not have storage\.objects\.get access/,
    );
  });
});
