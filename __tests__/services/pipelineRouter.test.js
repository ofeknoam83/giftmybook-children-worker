const { resolveBookPipeline, isV3Available } = require('../../services/pipelineRouter');

describe('pipelineRouter.resolveBookPipeline', () => {
  const ENV_KEYS = ['BOOK_PIPELINE_V2', 'BOOK_PIPELINE_V3'];
  const savedEnv = {};
  const noopLog = () => {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  test('defaults: v2 for picture_book, v1 otherwise', () => {
    expect(resolveBookPipeline({ format: 'picture_book', log: noopLog }))
      .toMatchObject({ version: 'v2', moduleName: 'bookPipelineV2', source: 'default' });
    expect(resolveBookPipeline({ format: 'early_reader', log: noopLog }))
      .toMatchObject({ version: 'v1', moduleName: 'bookPipeline', source: 'default' });
  });

  test('BOOK_PIPELINE_V2=off forces v1 and beats any request', () => {
    process.env.BOOK_PIPELINE_V2 = 'off';
    expect(resolveBookPipeline({ format: 'picture_book', requestedVersion: 'v3', v3Available: true, log: noopLog }))
      .toMatchObject({ version: 'v1', source: 'env' });
  });

  test('BOOK_PIPELINE_V3=off routes an explicit v3 request to v2', () => {
    process.env.BOOK_PIPELINE_V3 = 'off';
    const messages = [];
    expect(resolveBookPipeline({ format: 'picture_book', requestedVersion: 'v3', v3Available: true, log: (m) => messages.push(m) }))
      .toMatchObject({ version: 'v2', source: 'env' });
    expect(messages.join(' ')).toContain('BOOK_PIPELINE_V3=off');
  });

  test('BOOK_PIPELINE_V3=off still honors an existing v1 checkpoint', () => {
    process.env.BOOK_PIPELINE_V3 = 'off';
    expect(resolveBookPipeline({ format: 'picture_book', checkpointVersion: 'v1', log: noopLog }))
      .toMatchObject({ version: 'v1', source: 'checkpoint' });
  });

  test('BOOK_PIPELINE_V3=on uses v3 when the module is deployed', () => {
    process.env.BOOK_PIPELINE_V3 = 'on';
    expect(resolveBookPipeline({ format: 'picture_book', v3Available: true, log: noopLog }))
      .toMatchObject({ version: 'v3', moduleName: 'bookPipelineV3', source: 'env' });
  });

  test('BOOK_PIPELINE_V3=on with missing module falls back to v2 with a loud log', () => {
    process.env.BOOK_PIPELINE_V3 = 'on';
    const messages = [];
    expect(resolveBookPipeline({ format: 'picture_book', v3Available: false, log: (m) => messages.push(m) }))
      .toMatchObject({ version: 'v2', source: 'env' });
    expect(messages.join(' ')).toContain('FALLING BACK');
  });

  test('explicit v3 request with missing module throws PIPELINE_V3_UNAVAILABLE', () => {
    expect(() => resolveBookPipeline({ format: 'picture_book', requestedVersion: 'v3', v3Available: false, log: noopLog }))
      .toThrow(expect.objectContaining({ code: 'PIPELINE_V3_UNAVAILABLE' }));
  });

  test('explicit v3 request with deployed module routes to v3', () => {
    expect(resolveBookPipeline({ format: 'picture_book', requestedVersion: 'v3', v3Available: true, log: noopLog }))
      .toMatchObject({ version: 'v3', source: 'request' });
  });

  test('explicit v2 request routes to v2 with request provenance', () => {
    expect(resolveBookPipeline({ format: 'picture_book', requestedVersion: 'v2', log: noopLog }))
      .toMatchObject({ version: 'v2', source: 'request' });
  });

  test('checkpoint version beats the request so resumes stay on the same pipeline', () => {
    expect(resolveBookPipeline({ format: 'picture_book', requestedVersion: 'v2', checkpointVersion: 'v3', v3Available: true, log: noopLog }))
      .toMatchObject({ version: 'v3', source: 'checkpoint' });
    expect(resolveBookPipeline({ format: 'picture_book', requestedVersion: 'v3', checkpointVersion: 'v2', v3Available: true, log: noopLog }))
      .toMatchObject({ version: 'v2', source: 'checkpoint' });
  });

  test('non-picture_book formats ignore version requests', () => {
    const messages = [];
    expect(resolveBookPipeline({ format: 'early_reader', requestedVersion: 'v3', v3Available: true, log: (m) => messages.push(m) }))
      .toMatchObject({ version: 'v1', source: 'default' });
    expect(messages.length).toBeGreaterThan(0);
  });

  test('modulePath points at the services directory', () => {
    const { modulePath } = resolveBookPipeline({ format: 'picture_book', log: noopLog });
    expect(modulePath).toMatch(/services[/\\]bookPipelineV2$/);
  });
});

describe('pipelineRouter.isV3Available', () => {
  test('is true — services/bookPipelineV3 is deployed (milestone 1)', () => {
    // Flipped when bookPipelineV3 shipped: explicit v3 requests no longer
    // 400 at /generate-book; the router resolves them to the real module.
    expect(isV3Available()).toBe(true);
  });
});
