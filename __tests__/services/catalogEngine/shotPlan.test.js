/**
 * Shot plan — the deterministic per-spread composition spec (ce-8). The
 * invariants here ARE the variety contract: same story ⇒ same plan on every
 * retry/repair/probe; wide bookends; no adjacent shot-type repeats; full
 * menu coverage per book; alternating placement; layout- and band-aware
 * restrictions; template-only directive text.
 */

const {
  buildShotPlan,
  renderShotDirective,
  SHOT_TYPES,
  SHOT_TYPES_YOUNG,
  SHOT_TYPE_QA_DESCRIPTIONS,
  STAGING_BY_SHOT,
} = require('../../../services/catalogEngine/illustrator/shotPlan');

const ALL_SPREADS = Array.from({ length: 12 }, (_, i) => i + 1);
const plan12 = (over = {}) => buildShotPlan({
  seedBasis: over.seedBasis || 'story-hash-1',
  spreads: ALL_SPREADS,
  ageBand: over.ageBand || '6-7',
  textLayout: over.textLayout || 'caption',
});

test('deterministic: the same story fingerprint always yields the identical plan', () => {
  expect(plan12()).toEqual(plan12());
  expect(plan12({ textLayout: 'embedded' })).toEqual(plan12({ textLayout: 'embedded' }));
});

test('different story fingerprints rotate to different plans', () => {
  const a = plan12({ seedBasis: 'story-hash-1' });
  const b = plan12({ seedBasis: 'story-hash-2' });
  expect(ALL_SPREADS.map(s => a[s].shotType).join('|'))
    .not.toBe(ALL_SPREADS.map(s => b[s].shotType).join('|'));
});

test('wide bookends, no adjacent repeats, full menu coverage, no type over 4', () => {
  for (const seedBasis of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) {
    const plan = plan12({ seedBasis });
    const shots = ALL_SPREADS.map(s => plan[s].shotType);
    expect(shots[0]).toBe('wide');
    expect(shots[11]).toBe('wide');
    for (let i = 1; i < shots.length; i += 1) expect(shots[i]).not.toBe(shots[i - 1]);
    for (const type of SHOT_TYPES) expect(shots).toContain(type);
    const counts = shots.reduce((m, t) => ({ ...m, [t]: (m[t] || 0) + 1 }), {});
    for (const n of Object.values(counts)) expect(n).toBeLessThanOrEqual(4);
  }
});

test('band 1-3 restricts the menu to board-book shot types (bookends stay wide)', () => {
  const plan = plan12({ ageBand: '1-3' });
  const shots = ALL_SPREADS.map(s => plan[s].shotType);
  for (const t of shots) expect(SHOT_TYPES_YOUNG).toContain(t);
  expect(shots[0]).toBe('wide');
  expect(shots[11]).toBe('wide');
  for (let i = 1; i < shots.length; i += 1) expect(shots[i]).not.toBe(shots[i - 1]);
});

test('placement strictly alternates thirds; staging comes from the shot type\'s closed list', () => {
  const plan = plan12();
  const placements = ALL_SPREADS.map(s => plan[s].placement);
  for (let i = 1; i < placements.length; i += 1) expect(placements[i]).not.toBe(placements[i - 1]);
  for (const s of ALL_SPREADS) {
    expect(['left-third', 'right-third']).toContain(plan[s].placement);
    expect(STAGING_BY_SHOT[plan[s].shotType]).toContain(plan[s].staging);
  }
});

test('half layout emits NO placement (the half-layout print hint owns it) and no text side', () => {
  const plan = plan12({ textLayout: 'half' });
  for (const s of ALL_SPREADS) {
    expect(plan[s].placement).toBeNull();
    expect(plan[s].textSide).toBeNull();
  }
});

test('embedded layout pins the text side OPPOSITE the child\'s third', () => {
  const plan = plan12({ textLayout: 'embedded' });
  for (const s of ALL_SPREADS) {
    expect(plan[s].textSide).toBe(plan[s].placement === 'left-third' ? 'right' : 'left');
  }
  // Non-embedded layouts carry no text side at all.
  const caption = plan12();
  for (const s of ALL_SPREADS) expect(caption[s].textSide).toBeNull();
});

test('a probe subset sees the SAME assignments as the full book (the plan is never subset-relative)', () => {
  // The caller always builds the plan over ALL beats and looks up the
  // subset — this asserts the lookup identity a probe depends on.
  const full = plan12();
  const again = plan12();
  for (const s of [4, 7, 11]) expect(again[s]).toEqual(full[s]);
});

describe('renderShotDirective', () => {
  test('renders the fixed template block from the entry', () => {
    const plan = plan12({ textLayout: 'embedded' });
    const text = renderShotDirective(plan[5]);
    expect(text).toContain('COMPOSITION (ASSIGNED FOR THIS SPREAD');
    expect(text).toContain(`SHOT TYPE: ${plan[5].shotType.toUpperCase()}`);
    expect(text).toContain(SHOT_TYPE_QA_DESCRIPTIONS[plan[5].shotType]);
    expect(text).toContain(plan[5].staging);
    expect(text).toContain(plan[5].placement === 'left-third' ? 'LEFT third' : 'RIGHT third');
    expect(text).toContain(`TEXT SIDE: paint the story text block on the ${plan[5].textSide.toUpperCase()}`);
  });

  test('omits placement/text-side lines when the entry has none; empty for no entry', () => {
    const half = plan12({ textLayout: 'half' });
    const text = renderShotDirective(half[5]);
    expect(text).not.toContain('PLACEMENT');
    expect(text).not.toContain('TEXT SIDE');
    expect(renderShotDirective(null)).toBe('');
    expect(renderShotDirective(undefined)).toBe('');
  });

  test('never leaks the ART TUNING marker (the prompt builder splits on it)', () => {
    const plan = plan12();
    for (const s of ALL_SPREADS) {
      expect(renderShotDirective(plan[s])).not.toContain('ART TUNING ');
    }
  });
});
