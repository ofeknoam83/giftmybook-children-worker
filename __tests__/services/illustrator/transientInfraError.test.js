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

  // PR T: 500 "Internal error encountered" was killing full books mid-illustration
  // because it wasn't in the transient regex. Real production message that fired
  // during the spread 11/12 quad pair on book e3f4e0c0-08f2-4274-9971-d9eec50cf7bf.
  describe('PR T: Gemini 500 / INTERNAL is now treated as transient', () => {
    it('detects Session API error 500 with the exact production payload', () => {
      const productionMsg =
        'Session API error 500: {\n  "error": {\n    "code": 500,\n    "message": "Internal error encountered.",\n    "status": "INTERNAL"\n  }\n}';
      expect(
        isTransientIllustrationInfraError(new Error(productionMsg)),
      ).toBe(true);
    });

    it('detects bare "Session API error 500"', () => {
      expect(
        isTransientIllustrationInfraError(new Error('Session API error 500: oops')),
      ).toBe(true);
    });

    it('detects Session API error 502 (bad gateway)', () => {
      expect(
        isTransientIllustrationInfraError(new Error('Session API error 502: bad gateway')),
      ).toBe(true);
    });

    it('detects 504 session message', () => {
      expect(
        isTransientIllustrationInfraError(new Error('Session API error 504: gateway timeout')),
      ).toBe(true);
    });

    it('detects 429 rate-limit', () => {
      expect(
        isTransientIllustrationInfraError(new Error('Session API error 429: too many requests')),
      ).toBe(true);
    });

    it('detects bare INTERNAL status string from a gemini error body', () => {
      expect(
        isTransientIllustrationInfraError(new Error('upstream returned status: INTERNAL')),
      ).toBe(true);
    });

    it('does NOT classify 4xx auth/validation errors as transient', () => {
      expect(
        isTransientIllustrationInfraError(new Error('Session API error 400: invalid argument')),
      ).toBe(false);
      expect(
        isTransientIllustrationInfraError(new Error('Session API error 401: unauthenticated')),
      ).toBe(false);
      expect(
        isTransientIllustrationInfraError(new Error('Session API error 403: permission denied')),
      ).toBe(false);
    });

    it('does NOT classify safety blocks as transient (those have their own retry path)', () => {
      const e = new Error('safety: prohibited content');
      e.isSafetyBlock = true;
      expect(isTransientIllustrationInfraError(e)).toBe(false);
    });
  });
});
