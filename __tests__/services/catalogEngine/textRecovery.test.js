jest.mock('../../../services/gcsStorage', () => ({ downloadBuffer: jest.fn(), uploadBuffer: jest.fn() }));
jest.mock('../../../services/illustrationGenerator', () => ({ verifyImageText: jest.fn(), repairImageText: jest.fn() }));
const { downloadBuffer, uploadBuffer } = require('../../../services/gcsStorage');
const { verifyImageText, repairImageText } = require('../../../services/illustrationGenerator');
const { checkSavedText, recoverText } = require('../../../services/catalogEngine/illustrator/textRecovery');
const { verifyManuscript } = require('../../../services/shared/illustration/manuscript');
let objects, mismatch, verified;
const source = Buffer.from('saved chosen artwork');
const fixed = Buffer.from('only lettering corrected');
const args = () => ({ buffer: source, text: 'Silver leaves.', verification: mismatch,
  storageKey: 'children-jobs/book/ce-renders/ce-18/hash/spread-9.wide.png', spread: 9,
  renderBudget: { used: new Map(), limit: 3 } });
beforeEach(async () => {
  jest.resetAllMocks(); objects = new Map();
  mismatch = { ...await verifyManuscript('Silver leaves.', async () => 'Siiver leaves.'), textBox: { x: .6, y: .2, w: .3, h: .4 } };
  verified = await verifyManuscript('Silver leaves.', async () => 'Silver leaves.');
  downloadBuffer.mockImplementation(async key => { if (objects.has(key)) return objects.get(key); throw Object.assign(new Error('missing'), { code: 404 }); });
  uploadBuffer.mockImplementation(async (buffer, key) => { objects.set(key, buffer); });
  repairImageText.mockResolvedValue(fixed);
  verifyImageText.mockResolvedValue(verified);
});

test('a confirmed typo is automatically repaired once and the exact chosen original is backed up', async () => {
  const p = args();
  const result = await recoverText(p);
  expect(result).toMatchObject({ buffer: fixed, repaired: true, verification: { status: 'verified' } });
  expect(repairImageText).toHaveBeenCalledTimes(1);
  expect(p.renderBudget.used.get(9)).toBe(1);
  expect([...objects.entries()].find(([k]) => k.includes('.text-original-'))[1]).toEqual(source);
  expect(objects.has(p.storageKey)).toBe(false); // Only the caller may promote the verified result.
  await recoverText(args());
  expect(repairImageText).toHaveBeenCalledTimes(1); // Retry recovers the paid edit.
});

test('two bad edits keep original pixels and stop within the shared budget', async () => {
  verifyImageText.mockResolvedValue(mismatch);
  const p = args();
  const result = await recoverText(p);
  expect(result).toMatchObject({ buffer: source, repaired: false });
  expect(repairImageText).toHaveBeenCalledTimes(2);
  expect(p.renderBudget.used.get(9)).toBe(2);
  expect([...objects.keys()].some(k => k.includes('original'))).toBe(false);
});

test('an already-exhausted spread never gets extra image attempts', async () => {
  const p = args(); p.renderBudget.used.set(9, 3);
  expect(await recoverText(p)).toMatchObject({ repaired: false });
  expect(repairImageText).not.toHaveBeenCalled();
});

test('an uncertain reading is retried on the same pixels and never treated as a confirmed typo', async () => {
  const unverified = { ...verified, status: 'unverified', valid: false };
  verifyImageText.mockResolvedValueOnce(unverified).mockResolvedValue(verified);
  expect(await checkSavedText(source, 'Silver leaves.')).toMatchObject({ status: 'verified' });
  expect(verifyImageText).toHaveBeenCalledTimes(2);
  expect(await recoverText({ ...args(), verification: unverified })).toMatchObject({ repaired: false, buffer: source });
  expect(repairImageText).not.toHaveBeenCalled();
});

test('an OCR outage after an edit cannot promote that unverified edit or buy another one', async () => {
  verifyImageText.mockResolvedValue({ ...verified, status: 'unverified', valid: false });
  expect(await recoverText(args())).toMatchObject({ repaired: false, buffer: source });
  expect(repairImageText).toHaveBeenCalledTimes(1);
});

test('permission errors are surfaced without attempting to recreate the image', async () => {
  downloadBuffer.mockRejectedValue(Object.assign(new Error('denied'), { code: 403 }));
  await expect(recoverText(args())).rejects.toThrow('denied');
  expect(repairImageText).not.toHaveBeenCalled();
});

test('a false mismatch caused by a scene-wide text box is cleared without an image edit', async () => {
  const p = args(); p.verification = { ...mismatch, textBox: { x: 0, y: 0, w: 1, h: 1 } };
  expect(await recoverText(p)).toMatchObject({ repaired: false, buffer: source, verification: { status: 'verified' } });
  expect(verifyImageText).toHaveBeenCalledTimes(1);
  expect(repairImageText).not.toHaveBeenCalled();
  expect(uploadBuffer).not.toHaveBeenCalled();
  expect(p.renderBudget.used.size).toBe(0);
});

test('a real typo with an old scene-wide box is automatically re-located and repaired', async () => {
  const p = args(); p.verification = { ...mismatch, textBox: { x: 0, y: 0, w: 1, h: 1 } };
  verifyImageText.mockResolvedValueOnce(mismatch).mockResolvedValue(verified);
  expect(await recoverText(p)).toMatchObject({ repaired: true, buffer: fixed });
  expect(repairImageText).toHaveBeenCalledWith(source, p.text, expect.objectContaining({ textBox: mismatch.textBox }));
  expect(p.renderBudget.used.get(9)).toBe(1);
});

test('an unsafe location after re-reading cannot spend an image attempt or overwrite artwork', async () => {
  const p = args(); p.verification = { ...mismatch, textBox: { x: 0, y: 0, w: 1, h: 1 } };
  verifyImageText.mockResolvedValue(p.verification);
  expect(await recoverText(p)).toMatchObject({ repaired: false, buffer: source });
  expect(repairImageText).not.toHaveBeenCalled();
  expect(uploadBuffer).not.toHaveBeenCalled();
  expect(p.renderBudget.used.size).toBe(0);
});
