/**
 * Coloring page keys + the admin pick (cb-1 §4.9): key parsing for this
 * book only, base/repair candidate forms, and the admin-vouched marker.
 */

jest.mock('../../../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(),
  uploadBuffer: jest.fn().mockResolvedValue('https://signed/x'),
}));

const { downloadBuffer, uploadBuffer } = require('../../../../services/gcsStorage');
const { COLORING_VERSION, COLORING_QA_VERSION } = require('../../../../services/catalogEngine/versions');
const { parseColoringCandidateKey, pickColoringCandidate, pageKey, coloringBase, contentHash } = require('../../../../services/catalogEngine/coloring/candidates');

const BASE = `children-jobs/book-1/coloring/${COLORING_VERSION}/abc123`;

describe('keys', () => {
  test('pageKey and coloringBase are the plan namespace', () => {
    expect(coloringBase('book-1', 'abc123')).toBe(BASE);
    expect(pageKey('book-1', 'abc123', 7)).toBe(`${BASE}/page-7.png`);
  });
  test('parses base and repair candidates of THIS book only', () => {
    expect(parseColoringCandidateKey('book-1', `${BASE}/page-7.c2.png`)).toEqual({ page: 7, canonicalKey: `${BASE}/page-7.png`, candidate: 2, pass: 0 });
    expect(parseColoringCandidateKey('book-1', `${BASE}/page-12.r2c1.png`)).toEqual({ page: 12, canonicalKey: `${BASE}/page-12.png`, candidate: 1, pass: 2 });
    expect(parseColoringCandidateKey('book-1', `${BASE}/page-7.png`)).toBeNull();
    expect(parseColoringCandidateKey('other', `${BASE}/page-7.c2.png`)).toBeNull();
    expect(parseColoringCandidateKey('book-1', `children-jobs/book-1/coloring/${COLORING_VERSION}/../x/page-7.c2.png`)).toBeNull();
    expect(parseColoringCandidateKey('book-1', 42)).toBeNull();
  });
});

describe('pickColoringCandidate', () => {
  beforeEach(() => { downloadBuffer.mockReset(); uploadBuffer.mockClear(); });
  test('promotes the bytes to the canonical key with an admin-vouched marker', async () => {
    const buf = Buffer.from('candidate-bytes');
    downloadBuffer.mockResolvedValue(buf);
    const r = await pickColoringCandidate({ bookId: 'book-1', candidateKey: `${BASE}/page-3.r1c2.png` });
    expect(r).toEqual({ page: 3, storageKey: `${BASE}/page-3.png`, renderHash: contentHash(buf) });
    expect(uploadBuffer).toHaveBeenCalledWith(buf, `${BASE}/page-3.png`, 'image/png');
    const marker = JSON.parse(uploadBuffer.mock.calls[1][0].toString());
    expect(uploadBuffer.mock.calls[1][1]).toBe(`${BASE}/page-3.png.qa.json`);
    expect(marker).toMatchObject({ coloringQaVersion: COLORING_QA_VERSION, adminPicked: true, unresolved: false, renderHash: contentHash(buf) });
    expect(marker.advisories[0].note).toMatch(/candidate 2 \(repair 1\) picked by an admin/);
  });
  test('rejects a key that is not a candidate of this book with a 400', async () => {
    await expect(pickColoringCandidate({ bookId: 'book-1', candidateKey: `${BASE}/page-3.png` })).rejects.toMatchObject({ statusCode: 400 });
    expect(downloadBuffer).not.toHaveBeenCalled();
  });
});
