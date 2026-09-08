const { selectFilmReferenceSheets } = require('../../../../services/catalogEngine/video/filmReferences');

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

test('exactly seven essential references fit even when the full kit exceeds the budget', () => {
  const props = Array.from({ length: 5 }, (_, i) => prop(`key-${i}`));
  const bible = { sheet: sheet('child'), companion: sheet('companion'),
    props: [...props, prop('decoration', { storyObjectId: undefined }), prop('off-screen', { sheet: null })],
    storyObjects: { objects: props.map(p => ({ id: p.storyObjectId, critical: true })) } };
  expect(selectFilmReferenceSheets(bible).sheets).toHaveLength(7);
  bible.props.push(prop('unknown-essential'));
  expect(() => selectFilmReferenceSheets(bible)).toThrow(/still needs 8.*excluding 1 noncritical/);
  try { selectFilmReferenceSheets(bible); } catch (err) { expect(err.failureCode).toBe('film_reference_budget'); }
});
