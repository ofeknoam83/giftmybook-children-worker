/**
 * Candidate promotion (ce-9): an admin-picked candidate is copied to the
 * spread's canonical key with an admin-vouched marker under the current
 * QA_VERSION; keys outside the book's render namespace are refused.
 */

jest.mock('../../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(),
  uploadBuffer: jest.fn().mockResolvedValue(undefined),
}));

const { downloadBuffer, uploadBuffer } = require('../../../services/gcsStorage');
const { pickCandidate, parseCandidateKey } = require('../../../services/catalogEngine/illustrator/candidates');
const { QA_VERSION } = require('../../../services/catalogEngine/versions');
const { fnv1a } = require('../../../services/catalogEngine/selection');

const KEY = 'children-jobs/book-1/ce-renders/ce-9/abc-b123/spread-7.wide.c2.png';

beforeEach(() => { downloadBuffer.mockReset(); uploadBuffer.mockClear(); });

test('parseCandidateKey accepts only this book\'s candidate keys', () => {
  expect(parseCandidateKey('book-1', KEY)).toEqual({ spread: 7, canonicalKey: 'children-jobs/book-1/ce-renders/ce-9/abc-b123/spread-7.wide.png' });
  expect(parseCandidateKey('book-2', KEY)).toBeNull();
  expect(parseCandidateKey('book-1', 'children-jobs/book-1/ce-renders/ce-9/abc/spread-7.wide.png')).toBeNull();
  expect(parseCandidateKey('book-1', '../../etc/passwd')).toBeNull();
});

test('pickCandidate promotes the bytes and writes an admin-vouched marker', async () => {
  const bytes = Buffer.from('winner');
  downloadBuffer.mockResolvedValue(bytes);
  const r = await pickCandidate({ bookId: 'book-1', candidateKey: KEY });
  expect(r).toEqual({ spread: 7, storageKey: 'children-jobs/book-1/ce-renders/ce-9/abc-b123/spread-7.wide.png', renderHash: fnv1a(bytes.toString('base64')).toString(36) });
  expect(uploadBuffer).toHaveBeenNthCalledWith(1, bytes, r.storageKey, 'image/png');
  const marker = JSON.parse(uploadBuffer.mock.calls[1][0].toString('utf8'));
  expect(uploadBuffer.mock.calls[1][1]).toBe(`${r.storageKey}.qa.json`);
  expect(marker).toMatchObject({ qaVersion: QA_VERSION, adminPicked: true, renderHash: r.renderHash });
  expect(marker.advisories[0].note).toContain('candidate 2 picked by an admin');
});

test('a foreign key is refused with a 400-class error before any storage access', async () => {
  await expect(pickCandidate({ bookId: 'book-1', candidateKey: 'children-jobs/other/ce-renders/x/spread-1.wide.c1.png' })).rejects.toMatchObject({ statusCode: 400 });
  expect(downloadBuffer).not.toHaveBeenCalled();
});
