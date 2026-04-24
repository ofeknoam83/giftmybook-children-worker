/**
 * Safety-block fallback: after QA requests cover re-anchor, if Gemini blocks
 * the inline cover reference, processOneSpread retries the same attempt
 * without re-anchor before escalating to session rebuild.
 */

jest.mock('../../../services/illustrator/sessionDispatch', () => ({
  createSession: jest.fn(),
  establishCharacterReference: jest.fn(),
  generateSpread: jest.fn(),
  sendCorrection: jest.fn(),
  markSpreadAccepted: jest.fn(),
  pruneLastTurn: jest.fn(),
  rebuildSession: jest.fn(),
  providerName: 'gemini-test',
}));

jest.mock('../../../services/illustrator/postprocess/strip', () => ({
  stripMetadata: jest.fn(async (buf) => buf),
}));

jest.mock('../../../services/illustrator/postprocess/upscale', () => ({
  upscaleForPrint: jest.fn(async (buf) => buf),
}));

jest.mock('../../../services/gcsStorage', () => ({
  uploadBuffer: jest.fn(async () => {}),
  getSignedUrl: jest.fn(async () => 'https://example.com/spread.jpg'),
}));

jest.mock('../../../services/bookPipeline/qa/checkSpread', () => ({
  checkSpread: jest.fn(),
}));

jest.mock('../../../services/bookPipeline/qa/planRepair', () => ({
  planSpreadRepair: jest.fn(() => ({ correctionNote: 'Match cover hero.', retryEntry: { kind: 'test' } })),
}));

jest.mock('../../../services/bookPipeline/illustrator/buildIllustrationSpec', () => ({
  buildIllustrationSpec: jest.fn(() => ({
    spreadIndex: 0,
    spreadNumber: 1,
    text: 'Line one.\nLine two.',
    textSide: 'left',
    textCorner: 'top-left',
    theme: 'mothers_day',
    scene: 'Warm indoor scene with mother and child.',
  })),
}));

const sessionDispatch = require('../../../services/illustrator/sessionDispatch');
const { checkSpread } = require('../../../services/bookPipeline/qa/checkSpread');
const { processOneSpread } = require('../../../services/bookPipeline/illustrator/renderAllSpreads');

function makeDoc() {
  return {
    request: { bookId: 'test-book' },
    visualBible: { hero: { physicalDescription: 'tiny toddler' }, supportingCast: [] },
    spreads: [
      {
        spreadNumber: 1,
        spec: { scene: 'x' },
        qa: { spreadChecks: [], repairHistory: [], writerChecks: [] },
      },
    ],
    retryMemory: [],
    operationalContext: {},
  };
}

describe('renderAllSpreads / processOneSpread — safety after re-anchor', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.clearAllMocks();

    const img = { imageBuffer: Buffer.from('jpeg-bytes'), imageBase64: 'anNvbg==' };
    sessionDispatch.generateSpread.mockResolvedValue(img);

    const reanchorOpts = [];
    sessionDispatch.sendCorrection.mockImplementation(async (_session, _correction, _idx, opts) => {
      reanchorOpts.push(opts?.reanchorCover);
      if (reanchorOpts.length === 1) {
        const err = new Error('Safety-blocked response for spread 1 (finishReason=unknown, blockReason=OTHER)');
        err.isSafetyBlock = true;
        err.isEmptyResponse = true;
        err.blockReason = 'OTHER';
        err.safetyRatings = [{ category: 'OTHER', probability: 'NEGLIGIBLE' }];
        throw err;
      }
      return img;
    });

    let qaCalls = 0;
    checkSpread.mockImplementation(async () => {
      qaCalls += 1;
      if (qaCalls === 1) {
        return {
          pass: false,
          tags: ['hero_mismatch'],
          issues: ['Hero does not match cover.'],
        };
      }
      return { pass: true, tags: [], issues: [] };
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('retries correction without re-anchor when first correction is safety-blocked', async () => {
    const doc = makeDoc();
    const session = { rebuilds: 0 };
    const spread = doc.spreads[0];
    const cover = { base64: 'Y292ZXI=', mime: 'image/jpeg' };

    const result = await processOneSpread({ doc, session, cover, spread, bookId: 'test-book' });

    expect(result.accepted).toBe(true);
    expect(sessionDispatch.rebuildSession).not.toHaveBeenCalled();
    expect(sessionDispatch.sendCorrection).toHaveBeenCalledTimes(2);
    expect(sessionDispatch.sendCorrection.mock.calls[0][3]).toEqual({ reanchorCover: true });
    expect(sessionDispatch.sendCorrection.mock.calls[1][3]).toEqual({ reanchorCover: false });
    expect(sessionDispatch.markSpreadAccepted).toHaveBeenCalled();
  });
});
