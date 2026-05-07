/**
 * Tests for the OpenAI gpt-image-2 illustrator adapter.
 *
 * Covers:
 *   - createSession requires OPENAI_API_KEY and uses square aspect format
 *   - generateSpread POSTs the JSON shape we expect (model/size/quality/prompt)
 *     with NO inline reference images (the /v1/images/generations endpoint
 *     does not accept them; see services/illustrator/openaiImagesHttp.js docs)
 *   - sendCorrection sets the stateless-retry header in the combined prompt
 *   - markSpreadAccepted still accumulates accepted spreads on the session
 *     (so a future Responses-API migration can restore image references
 *     without changing the orchestrator)
 *   - rebuildSession carries forward accepted spreads
 *   - moderation errors classify as isSafetyBlock
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

  test('generateSpread POSTs model/size/quality/prompt JSON with NO inline image references', async () => {
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
    // /v1/images/generations is JSON-only and does NOT accept reference
    // images. The session adapter passes an empty imageFiles array; the HTTP
    // layer would also drop any references with a warning if present.
    expect(call.imageFiles).toEqual([]);

    expect(call.prompt).toMatch(/STATELESS REQUEST/);
    expect(call.prompt).toMatch(/NO INLINE REFERENCES/);
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

  test('markSpreadAccepted still tracks accepted spreads on the session (preserved for future Responses-API migration)', async () => {
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

    const tiny = (await buildPngBuffer()).toString('base64');
    for (let i = 0; i < 5; i++) {
      markSpreadAccepted(session, i, tiny);
    }
    expect(session.acceptedSpreads).toHaveLength(5);

    await generateSpread(session, 'SCENE: Hero at a table.', 5);

    // HTTP call still has no inline references — the accepted-spread tracking
    // is purely for future use (Responses API), not for this endpoint.
    const call = httpMock.postImagesGenerations.mock.calls[0][0];
    expect(call.imageFiles).toEqual([]);
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
