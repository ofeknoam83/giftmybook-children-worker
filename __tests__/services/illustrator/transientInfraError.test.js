/**
 * @jest-environment node
 */

const { isTransientIllustrationInfraError } = require('../../../services/illustrator/transientInfraError');

describe('isTransientIllustrationInfraError', () => {
  it('is true for flagged session errors', () => {
    const e = new Error('x');
    e.isTransientInfrastructure = true;
    expect(isTransientIllustrationInfraError(e)).toBe(true);
  });

  it('detects 503 session message', () => {
    expect(
      isTransientIllustrationInfraError(
        new Error('Session API error 503: {"error":{"message":"Deadline expired'),
      ),
    ).toBe(true);
  });

  it('detects client timeout message', () => {
    expect(
      isTransientIllustrationInfraError(new Error('Gemini image API timed out after 300s')),
    ).toBe(true);
  });

  it('is false for unrelated errors', () => {
    expect(isTransientIllustrationInfraError(new Error('parse failed'))).toBe(false);
  });
});
