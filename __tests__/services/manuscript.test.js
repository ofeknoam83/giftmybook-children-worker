const { compareManuscript, verifyManuscript, textVerificationCurrent, applyTextVerification, TEXT_MISMATCH } = require('../../services/shared/illustration/manuscript');

test.each([
  ['Silver leaves whispered softly.', 'Siiver leaves whispered softly.'],
  ['The bird saw the fox and the fox smiled.', 'The bird saw the fox and fox smiled.'],
  ['The fox saw the bird.', 'The bird saw the fox.'],
  ['José and Zoë met Lumi.', 'Jose and Zoe met Lumi.'],
  ['שלום זיו', 'שלום זוב'],
  ["It’s the little fox.", 'Its the little fox.'],
  ['A therapist arrived.', 'A the rapist arrived.'],
  ['The bird flew.', ''],
])('rejects changed, missing or reordered manuscript: %s', (expected, actual) => {
  expect(compareManuscript(expected, actual).valid).toBe(false);
});

test('allows newlines, blank rows, quote style, capitalization and equivalent Unicode', () => {
  expect(compareManuscript('“José’s bird flew.”\n\nThe fox waved!', '"Jose\u0301\'s bird\nflew." THE FOX WAVED.').valid).toBe(true);
});

test('one mistaken OCR reading gets a second check before artwork is rejected', async () => {
  const read = jest.fn().mockResolvedValueOnce('Siiver leaves.').mockResolvedValueOnce('Silver leaves.');
  const v = await verifyManuscript('Silver leaves.', read);
  expect(v).toMatchObject({ status: 'verified', attempts: 2 });
  expect(textVerificationCurrent(v, 'Silver\nleaves.')).toBe(true);
  expect(textVerificationCurrent(v, 'Golden leaves.')).toBe(false);
  expect(textVerificationCurrent({ ...v, version: 'old' }, 'Silver leaves.')).toBe(false);
});

test('two agreeing misspellings are confirmed, without an unbounded retry loop', async () => {
  const read = jest.fn().mockResolvedValue('Siiver leaves.');
  expect(await verifyManuscript('Silver leaves.', read)).toMatchObject({ status: 'mismatch', valid: false, attempts: 2 });
  expect(read).toHaveBeenCalledTimes(2);
});

test('outages and conflicting transcriptions are unverified, never accepted', async () => {
  const offline = jest.fn().mockRejectedValue(new Error('HTTP 503'));
  expect(await verifyManuscript('Silver leaves.', offline)).toMatchObject({ status: 'unverified', valid: false });
  expect(offline).toHaveBeenCalledTimes(2);
  const conflicting = jest.fn().mockResolvedValueOnce('Siiver leaves.').mockResolvedValueOnce('Silver leaf.');
  expect(await verifyManuscript('Silver leaves.', conflicting)).toMatchObject({ status: 'unverified', valid: false });
});

test('blind spelling replaces the general judge’s textual guess but preserves visual findings', () => {
  const qa = { defects: ['embedded story text garbled: guess', 'outfit break: jacket differs'], blocking: ['embedded story text garbled: guess', 'outfit break: jacket differs'], advisory: [] };
  expect(applyTextVerification(qa, { status: 'verified' }).blocking).toEqual(['outfit break: jacket differs']);
  expect(applyTextVerification({ defects: [], blocking: [], advisory: [] }, { status: 'mismatch' }).blocking).toEqual([TEXT_MISMATCH]);
});
