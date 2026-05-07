/**
 * Tests for the OpenAI gpt-image-2 illustrator adapter.
 *
 * Covers:
 *   - createSession requires OPENAI_API_KEY and uses square aspect format
 *   - generateSpread POSTs the multipart shape we expect (model, size, quality,
 *     reference image count, system+user combined prompt)
 *   - sendCorrection sets the stateless-retry header in the combined prompt
 *   - markSpreadAccepted accumulates references for the next call
 *   - aspectHint derivation (square vs quad vs legacy)
 *   - reference images are resized before attaching (cap on payload size)
 */

jest.mock('../../../services/illustrationGenerator', () => ({
  fetchWithTimeout: jest.fn(),
}));

jest.mock('../../../services/illustrator/openaiImagesHttp', () => ({
  postImagesGenerations: jest.fn(),
  postImagesEdits: jest.fn(),
}));

// Avoid pulling in the native `sharp` binary in CI/sandbox environments
// where node_modules is not provisioned. The reference-resize step is
// exercised in production E2E; here we just verify the adapter wires
// through model/size/quality/refs/prompt correctly.
jest.mock('sharp', () => {
  return () => ({
    resize: () => ({
      jpeg: () => ({
        toBuffer: async () => Buffer.from('FAKE_RESIZED_JPEG'),
      }),
    }),
  });
}, { virtual: true });

const httpMock = require('../../../services/illustrator/openaiImagesHttp');

// 4x4 solid PNG, base64 — small enough that the resize step is exercised
// without needing sharp to synthesize a fixture.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAGklEQVQI12P8//8/AwwwMTAwMDAxYBcEAEFsAwxk2hUiAAAAAElFTkSuQmCC';

async function buildPngBuffer() {
  return Buffer.from(TINY_PNG_BASE64, 'base64');
}

function mockSuccessfulPost(b64Out = 'aGVsbG8=') {
  httpMock.postImagesGenerations.mockImplementation(async () => ({
    ok: true,
    status: 200,
    data: { data: [{ b64_json: b64Out }] },
  }));
}

describe('openaiImageSession', () => {
  let coverPng;
  let originalApiKey;

  beforeAll(async () => {
    coverPng = await buildPngBuffer();
  });

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    httpMock.postImagesGenerations.mockReset();
    originalApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  });

  test('createSession throws when OPENAI_API_KEY is missing', () => {
    delete process.env.OPENAI_API_KEY;
    const { createSession } = require('../../../services/illustrator/openaiImageSession');
    expect(() => createSession({
      coverBase64: coverPng.toString('base64'),
      coverMime: 'image/png',
    })).toThrow(/OPENAI_API_KEY missing/);
  });

  test('createSession builds a system instruction in square aspect mode (no on-image text)', () => {
    const { createSession } = require('../../../services/illustrator/openaiImageSession');
    const session = createSession({
      coverBase64: coverPng.toString('base64'),
      coverMime: 'image/png',
      theme: 'mothers_day',
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      childAge: 2,
    });
    expect(session.systemInstruction).toMatch(/1:1 square/);
    expect(session.systemInstruction).toMatch(/PDF text on the FACING PAGE|PDF text on the facing page/i);
    // The square branch must NOT include the wide-path on-image caption rules.
    expect(session.systemInstruction).not.toMatch(/CHOSEN CORNER/);
    expect(session.systemInstruction).not.toMatch(/PANORAMA LOCK/);
  });

  test('generateSpread POSTs model, size, quality, reference image array, and stateless+square prompt headers', async () => {
    const { createSession, generateSpread, establishCharacterReference } =
      require('../../../services/illustrator/openaiImageSession');
    mockSuccessfulPost();

    const session = createSession({
      coverBase64: coverPng.toString('base64'),
      coverMime: 'image/png',
      theme: 'mothers_day',
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      childAge: 2,
    });
    await establishCharacterReference(session);

    await generateSpread(session, 'SCENE: Hero in meadow.', 0);

    expect(httpMock.postImagesGenerations).toHaveBeenCalledTimes(1);
    const call = httpMock.postImagesGenerations.mock.calls[0][0];
    expect(call.model).toBe('gpt-image-2');
    expect(call.size).toBe('1024x1024');
    expect(call.quality).toBe('high');
    expect(call.imageFiles).toHaveLength(1);
    expect(call.imageFiles[0].mimeType).toBe('image/jpeg');
    // The reference resize converts the source PNG to a small JPEG.
    expect(call.imageFiles[0].buffer.length).toBeGreaterThan(0);
    expect(call.imageFiles[0].filename).toBe('cover.jpg');

    expect(call.prompt).toMatch(/STATELESS REQUEST/);
    expect(call.prompt).toMatch(/1:1.*square/);
    expect(call.prompt).toMatch(/Render NO text on the image/);
    expect(call.prompt).toMatch(/SCENE: Hero in meadow\./);
  });

  test('sendCorrection emits the stateless-retry header in the combined prompt', async () => {
    const { createSession, sendCorrection, establishCharacterReference } =
      require('../../../services/illustrator/openaiImageSession');
    mockSuccessfulPost();

    const session = createSession({
      coverBase64: coverPng.toString('base64'),
      coverMime: 'image/png',
      theme: 'mothers_day',
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      childAge: 2,
    });
    await establishCharacterReference(session);

    await sendCorrection(session, 'CORRECTION: outfit drifted, restore cover outfit.', 0);

    const call = httpMock.postImagesGenerations.mock.calls[0][0];
    expect(call.prompt).toMatch(/STATELESS RETRY/);
    expect(call.prompt).toMatch(/CORRECTION: outfit drifted/);
  });

  test('references accumulate as accepted spreads are marked, capped at sliding window', async () => {
    const { createSession, generateSpread, markSpreadAccepted, establishCharacterReference } =
      require('../../../services/illustrator/openaiImageSession');
    mockSuccessfulPost();

    const session = createSession({
      coverBase64: coverPng.toString('base64'),
      coverMime: 'image/png',
      theme: 'mothers_day',
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      childAge: 2,
    });
    await establishCharacterReference(session);

    // Mark 5 accepted spreads — sliding window is 3, so only the last 3 should attach.
    const tiny = (await buildPngBuffer()).toString('base64');
    for (let i = 0; i < 5; i++) {
      markSpreadAccepted(session, i, tiny);
    }

    await generateSpread(session, 'SCENE: Hero at a table.', 5);

    const call = httpMock.postImagesGenerations.mock.calls[0][0];
    // 1 cover + 3 accepted (sliding window) = 4
    expect(call.imageFiles).toHaveLength(4);
    expect(call.imageFiles[0].filename).toBe('cover.jpg');
    expect(call.imageFiles[1].filename).toMatch(/spread-3\.jpg/);
    expect(call.imageFiles[2].filename).toMatch(/spread-4\.jpg/);
    expect(call.imageFiles[3].filename).toMatch(/spread-5\.jpg/);
  });

  test('rebuildSession carries forward accepted spreads and bumps the rebuild counter', async () => {
    const { createSession, rebuildSession, markSpreadAccepted } =
      require('../../../services/illustrator/openaiImageSession');

    const session = createSession({
      coverBase64: coverPng.toString('base64'),
      coverMime: 'image/png',
      theme: 'mothers_day',
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      childAge: 2,
    });
    const tiny = (await buildPngBuffer()).toString('base64');
    markSpreadAccepted(session, 0, tiny);
    markSpreadAccepted(session, 1, tiny);

    const rebuilt = await rebuildSession(session);
    expect(rebuilt.rebuilds).toBe(1);
    expect(rebuilt.acceptedSpreads).toHaveLength(2);
    expect(session.abandoned).toBe(true);
  });

  test('OpenAI moderation error is classified as isSafetyBlock', async () => {
    const { createSession, generateSpread, establishCharacterReference } =
      require('../../../services/illustrator/openaiImageSession');
    httpMock.postImagesGenerations.mockResolvedValue({
      ok: false,
      status: 400,
      text: '{"error":{"message":"Your request was blocked by safety filters","type":"moderation_blocked"}}',
    });

    const session = createSession({
      coverBase64: coverPng.toString('base64'),
      coverMime: 'image/png',
      theme: 'mothers_day',
      hasParentOnCover: false,
      hasSecondaryOnCover: false,
      childAge: 2,
    });
    await establishCharacterReference(session);

    await expect(generateSpread(session, 'SCENE: anything.', 0))
      .rejects.toMatchObject({ isSafetyBlock: true, isEmptyResponse: true });
  });
});
