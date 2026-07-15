const { resolveBookPipeline, isV3Available } = require('../../services/pipelineRouter');

describe('pipelineRouter.resolveBookPipeline (v3-only, post-W12)', () => {
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

  test('every picture book resolves to v3', () => {
    expect(resolveBookPipeline({ format: 'picture_book', v3Available: true, log: noopLog }))
      .toMatchObject({ version: 'v3', moduleName: 'bookPipelineV3', source: 'default' });
  });

  test('source provenance: checkpoint beats request beats default', () => {
    expect(resolveBookPipeline({ format: 'picture_book', checkpointVersion: 'v3', requestedVersion: 'v3', v3Available: true, log: noopLog }))
      .toMatchObject({ source: 'checkpoint' });
    expect(resolveBookPipeline({ format: 'picture_book', requestedVersion: 'v3', v3Available: true, log: noopLog }))
      .toMatchObject({ source: 'request' });
  });

  test('a legacy v1/v2 checkpoint restarts on v3 with a loud log', () => {
    for (const legacy of ['v1', 'v2']) {
      const messages = [];
      expect(resolveBookPipeline({ format: 'picture_book', checkpointVersion: legacy, v3Available: true, log: (m) => messages.push(m) }))
        .toMatchObject({ version: 'v3', source: 'default' });
      expect(messages.join(' ')).toContain('restarting this book on v3');
    }
  });

  test('stale kill-switch envs are ignored with a loud log — nothing left to revert to', () => {
    process.env.BOOK_PIPELINE_V3 = 'off';
    const messages = [];
    expect(resolveBookPipeline({ format: 'picture_book', v3Available: true, log: (m) => messages.push(m) }))
      .toMatchObject({ version: 'v3' });
    expect(messages.join(' ')).toContain('kill-switch');
  });

  test('missing v3 module throws PIPELINE_V3_UNAVAILABLE instead of 202-then-brick', () => {
    expect(() => resolveBookPipeline({ format: 'picture_book', v3Available: false, log: noopLog }))
      .toThrow(expect.objectContaining({ code: 'PIPELINE_V3_UNAVAILABLE' }));
  });

  test('retired formats reaching the router still run v3 (defense-in-depth log only)', () => {
    const messages = [];
    expect(resolveBookPipeline({ format: 'early_reader', v3Available: true, log: (m) => messages.push(m) }))
      .toMatchObject({ version: 'v3' });
    expect(messages.join(' ')).toContain('retired format');
  });

  test('modulePath points at the v3 services directory', () => {
    const { modulePath } = resolveBookPipeline({ format: 'picture_book', v3Available: true, log: noopLog });
    expect(modulePath).toMatch(/services[/\\]bookPipelineV3$/);
  });
});

describe('pipelineRouter.isV3Available', () => {
  test('is true — services/bookPipelineV3 is deployed', () => {
    expect(isV3Available()).toBe(true);
  });
});
