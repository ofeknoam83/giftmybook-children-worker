/**
 * A saved take verdict that blocked on the duration window alone, with a
 * transcript that carried every word, replays as a pace advisory instead
 * of being recorded again (the 2026-09-09 film failure: 1.66 s against a
 * 1.73 s estimate on a fully verified passage).
 */
const { reclassifyPaceMarker } = require('../../../../services/catalogEngine/audio/narrate');
const { DEFECTS } = require('../../../../services/catalogEngine/audio/takeQa');

const marker = (over = {}) => ({
  transcript: 'The cow said moo.', qa: { blocking: [`${DEFECTS.DURATION_OFF}: 1.66s for an expected 1.73–6.6s`], advisory: [], qaUnavailable: null },
  compare: { wordMatch: 1 }, durationRatio: 0.4, unresolved: true, adminPicked: false, ...over,
});

test('duration-only blocking on a verified transcript becomes a pace advisory', () => {
  const m = reclassifyPaceMarker(marker(), 'The cow said moo.');
  expect(m.qa.blocking).toEqual([]);
  expect(m.qa.advisory).toEqual([`${DEFECTS.PACE_OFF}: 1.66s for an expected 1.73–6.6s`]);
  expect(m.unresolved).toBe(false);
  expect(m.reclassified).toBe('pace');
  expect(typeof m.score).toBe('number');
});

test('any other blocking finding, a differing transcript, or an admin pick leaves the marker alone', () => {
  const other = marker({ qa: { blocking: [`${DEFECTS.DURATION_OFF}: x`, DEFECTS.CLIPPED], advisory: [] } });
  expect(reclassifyPaceMarker(other, 'The cow said moo.')).toBe(other);
  const differs = marker({ transcript: 'The cow said.' });
  expect(reclassifyPaceMarker(differs, 'The cow said moo.')).toBe(differs);
  const picked = marker({ adminPicked: true });
  expect(reclassifyPaceMarker(picked, 'The cow said moo.')).toBe(picked);
  const clean = marker({ qa: { blocking: [], advisory: [] }, unresolved: false });
  expect(reclassifyPaceMarker(clean, 'The cow said moo.')).toBe(clean);
  expect(reclassifyPaceMarker(null, 'x')).toBeNull();
});
