const { selectFilmReferenceSheets, shotReferenceSheets, keepWithinBudget } = require('../../../../services/catalogEngine/video/filmReferences');

const sheet = hash => ({ hash, base64: Buffer.from(hash).toString('base64') });
const prop = (id, extra = {}) => ({ value: id, storyObjectId: id, sheet: sheet(id), ...extra });

test('keeps character identities and critical props while removing decorative reference images only', () => {
  const bible = { sheet: sheet('child'), companion: sheet('companion'),
    props: [prop('flowers'), prop('key'), prop('teddy', { storyObjectId: undefined })],
    storyObjects: { objects: [{ id: 'flowers', critical: false }, { id: 'key', critical: true }] } };
  const before = JSON.stringify(bible);
  const selected = selectFilmReferenceSheets(bible);
  expect(selected.sheets.map(r => [r.kind, r.sheet.hash])).toEqual([
    ['character', 'child'], ['companion', 'companion'], ['prop', 'key'],
  ]);
  expect(selected.omittedProps).toEqual(['flowers', 'teddy']);
  expect(JSON.stringify(bible)).toBe(before);
});

test('unknown story-object criticality is preserved, including a missing plan', () => {
  for (const storyObjects of [undefined, { objects: [{ id: 'unknown' }] }, { objects: [] }]) {
    expect(selectFilmReferenceSheets({ sheet: sheet('child'), props: [prop('unknown')], storyObjects })
      .sheets.map(r => r.sheet.hash)).toEqual(['child', 'unknown']);
  }
});

test('an essential set beyond one request never fails selection — each shot takes its own within the budget', () => {
  const props = Array.from({ length: 7 }, (_, i) => prop(`key-${i}`));
  const bible = { sheet: sheet('child'), companion: sheet('companion'),
    props: [...props, prop('decoration', { storyObjectId: undefined }), prop('off-screen', { sheet: null })],
    storyObjects: { objects: props.map((p, i) => ({ id: p.storyObjectId, critical: true, occurrences: [
      ...(i === 5 ? [{ spread: 3, required: true }] : []), ...(i === 6 ? [{ spread: 3, required: false }] : []), ...(i === 1 ? [{ spread: 9, required: true }] : []),
    ] })) } };
  const { sheets, omittedProps } = selectFilmReferenceSheets(bible);
  expect(sheets).toHaveLength(9);
  expect(omittedProps).toEqual(['decoration']);
  // Kling: seven pictures with the start frame ⇒ six references per shot.
  const s3 = shotReferenceSheets(sheets, { spread: 3, budget: 6, storyObjects: bible.storyObjects });
  // identities first, the staged prop, the mentioned prop, then kit order — emitted in kit order
  expect(s3.sheets.map(r => r.sheet.hash)).toEqual(['child', 'companion', 'key-0', 'key-1', 'key-5', 'key-6']);
  expect(s3.omitted).toEqual(['key-2', 'key-3', 'key-4']);
  const s9 = shotReferenceSheets(sheets, { spread: 9, budget: 6, storyObjects: bible.storyObjects });
  expect(s9.sheets.map(r => r.sheet.hash)).toEqual(['child', 'companion', 'key-0', 'key-1', 'key-2', 'key-3']);
  expect(s9.omitted).toEqual(['key-4', 'key-5', 'key-6']);
  // a shot that fits is the unbudgeted list, byte for byte (its cache keys hold)
  expect(shotReferenceSheets(sheets, { spread: 3, budget: 9, storyObjects: bible.storyObjects })).toEqual({ sheets, omitted: [] });
  expect(shotReferenceSheets(sheets, { spread: 3, budget: Infinity, storyObjects: null }).sheets).toEqual(sheets);
  // a plan without occurrences (or none at all) still keeps the child and companion first
  expect(shotReferenceSheets(sheets, { spread: 1, budget: 2, storyObjects: { objects: [{ id: 'p0', critical: true }] } }).sheets.map(r => r.kind)).toEqual(['character', 'companion']);
  expect(shotReferenceSheets(sheets, { spread: 1, budget: 1, storyObjects: undefined }).sheets.map(r => r.kind)).toEqual(['character']);
});

test('keepWithinBudget keeps the lowest ranks, ties in list order, and returns the kept entries in list order', () => {
  const list = ['a', 'b', 'c', 'd', 'e'];
  const rank = x => ({ a: 0, b: 3, c: 1, d: 3, e: 1 })[x];
  expect(keepWithinBudget(list, 3, rank)).toEqual({ kept: ['a', 'c', 'e'], omitted: ['b', 'd'] });
  expect(keepWithinBudget(list, 4, rank)).toEqual({ kept: ['a', 'b', 'c', 'e'], omitted: ['d'] });
  expect(keepWithinBudget(list, 5, rank)).toEqual({ kept: list, omitted: [] });
  expect(keepWithinBudget(list, 0, rank)).toEqual({ kept: [], omitted: list });
  expect(keepWithinBudget([], 0, rank)).toEqual({ kept: [], omitted: [] });
});
