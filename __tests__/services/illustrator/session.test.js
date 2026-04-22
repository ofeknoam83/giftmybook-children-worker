/**
 * Regression tests for the fixes that prevent the spread-3 failure cascade:
 *   - markSpreadAccepted must snapshot model parts (carrying thoughtSignature)
 *   - seedHistoryFromAccepted must replay those parts verbatim so rebuilds
 *     don't 400 with "Image part is missing a thought_signature"
 *   - pruneLastTurn must remove the last user+model exchange
 */

// Mock illustrationGenerator so session.js's `require('../illustrationGenerator')`
// doesn't pull in the full legacy module (which eagerly reads env).
jest.mock('../../../services/illustrationGenerator', () => ({
  fetchWithTimeout: jest.fn(),
}));

const {
  markSpreadAccepted,
  pruneLastTurn,
  seedHistoryFromAccepted,
} = require('../../../services/illustrator/session');

function makeSession(overrides = {}) {
  return {
    apiKey: 'k',
    model: 'm',
    systemInstruction: '',
    history: [],
    coverBase64: '',
    coverMime: 'image/jpeg',
    acceptedSpreads: [],
    turnsUsed: 0,
    rebuilds: 0,
    abandoned: false,
    abortSignal: null,
    opts: {},
    ...overrides,
  };
}

describe('illustrator/session — thought_signature preservation', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('markSpreadAccepted snapshots modelParts when the last model message contains the image', () => {
    const session = makeSession();
    const imageBase64 = 'abc123';
    session.history = [
      { role: 'user', parts: [{ text: 'prompt' }] },
      {
        role: 'model',
        parts: [
          { text: 'here is the image', thoughtSignature: 'SIG-TEXT' },
          { inlineData: { mimeType: 'image/png', data: imageBase64 }, thoughtSignature: 'SIG-IMG' },
        ],
      },
    ];

    markSpreadAccepted(session, 0, imageBase64);

    expect(session.acceptedSpreads).toHaveLength(1);
    const rec = session.acceptedSpreads[0];
    expect(rec.index).toBe(0);
    expect(rec.imageBase64).toBe(imageBase64);
    expect(Array.isArray(rec.modelParts)).toBe(true);
    // Signatures on both parts must be preserved for replay on rebuild.
    expect(rec.modelParts[0].thoughtSignature).toBe('SIG-TEXT');
    expect(rec.modelParts[1].thoughtSignature).toBe('SIG-IMG');
  });

  test('markSpreadAccepted handles snake_case inline_data too', () => {
    const session = makeSession();
    session.history = [
      { role: 'user', parts: [{ text: 'p' }] },
      {
        role: 'model',
        parts: [{ inline_data: { mimeType: 'image/png', data: 'img' }, thoughtSignature: 'SIG' }],
      },
    ];
    markSpreadAccepted(session, 2, 'img');
    expect(session.acceptedSpreads[0].modelParts[0].thoughtSignature).toBe('SIG');
  });

  test('markSpreadAccepted without matching model image omits modelParts (checkpoint-resume path)', () => {
    const session = makeSession();
    // Empty history simulates a checkpoint-seeded accept.
    markSpreadAccepted(session, 0, 'gcs-image');
    expect(session.acceptedSpreads).toHaveLength(1);
    expect(session.acceptedSpreads[0].modelParts).toBeUndefined();
  });

  test('markSpreadAccepted updates existing record preserving new modelParts', () => {
    const session = makeSession();
    session.acceptedSpreads = [{ index: 0, imageBase64: 'old' }];
    session.history = [
      { role: 'user', parts: [{ text: 'p' }] },
      { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: 'new' }, thoughtSignature: 'SIG' }] },
    ];
    markSpreadAccepted(session, 0, 'new');
    expect(session.acceptedSpreads[0].imageBase64).toBe('new');
    expect(session.acceptedSpreads[0].modelParts[0].thoughtSignature).toBe('SIG');
  });

  test('seedHistoryFromAccepted replays modelParts verbatim (including thoughtSignature)', () => {
    const session = makeSession();
    const modelParts = [
      { inlineData: { mimeType: 'image/png', data: 'img1' }, thoughtSignature: 'SIG1' },
    ];
    seedHistoryFromAccepted(session, [
      { index: 0, imageBase64: 'img1', modelParts },
    ]);

    expect(session.history).toHaveLength(2);
    expect(session.history[0].role).toBe('user');
    const modelMsg = session.history[1];
    expect(modelMsg.role).toBe('model');
    expect(modelMsg.parts).toBe(modelParts);
    expect(modelMsg.parts[0].thoughtSignature).toBe('SIG1');
  });

  test('seedHistoryFromAccepted falls back to text-only when modelParts is missing', () => {
    const session = makeSession();
    // Checkpoint-resume scenario: image was fetched from GCS, no signature.
    seedHistoryFromAccepted(session, [{ index: 4, imageBase64: 'gcs-img' }]);

    expect(session.history).toHaveLength(2);
    const modelMsg = session.history[1];
    expect(modelMsg.role).toBe('model');
    // No inline_data/inlineData — replaying an image without its signature 400s.
    const hasImagePart = modelMsg.parts.some(p => p.inlineData || p.inline_data);
    expect(hasImagePart).toBe(false);
    expect(typeof modelMsg.parts[0].text).toBe('string');
    expect(modelMsg.parts[0].text).toMatch(/spread 5/);
  });

  test('seedHistoryFromAccepted respects sliding window (keeps tail)', () => {
    const session = makeSession();
    const accepted = Array.from({ length: 10 }, (_, i) => ({
      index: i,
      imageBase64: `img${i}`,
      modelParts: [{ inlineData: { mimeType: 'image/png', data: `img${i}` }, thoughtSignature: `SIG${i}` }],
    }));
    seedHistoryFromAccepted(session, accepted);
    // SLIDING_WINDOW_ACCEPTED_SPREADS defaults to 3; whatever it is, we keep only the tail.
    const modelMsgs = session.history.filter(m => m.role === 'model');
    expect(modelMsgs.length).toBeGreaterThan(0);
    expect(modelMsgs.length).toBeLessThan(10);
    // Last seeded spread must be the highest-indexed one.
    const lastModel = modelMsgs[modelMsgs.length - 1];
    const lastSig = lastModel.parts[0].thoughtSignature;
    expect(lastSig).toBe('SIG9');
  });
});

describe('illustrator/session — pruneLastTurn', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('removes the last user+model pair', () => {
    const session = makeSession();
    session.history = [
      { role: 'user', parts: [{ text: 'u1' }] },
      { role: 'model', parts: [{ text: 'm1' }] },
      { role: 'user', parts: [{ text: 'u2' }] },
      { role: 'model', parts: [{ text: 'm2' }] },
    ];
    pruneLastTurn(session);
    expect(session.history).toHaveLength(2);
    expect(session.history[0].parts[0].text).toBe('u1');
    expect(session.history[1].parts[0].text).toBe('m1');
  });

  test('removes an orphan trailing user message', () => {
    const session = makeSession();
    session.history = [
      { role: 'user', parts: [{ text: 'u1' }] },
      { role: 'model', parts: [{ text: 'm1' }] },
      { role: 'user', parts: [{ text: 'u2' }] },
    ];
    pruneLastTurn(session);
    expect(session.history).toHaveLength(2);
  });

  test('is a no-op on empty history', () => {
    const session = makeSession();
    pruneLastTurn(session);
    expect(session.history).toEqual([]);
  });
});
