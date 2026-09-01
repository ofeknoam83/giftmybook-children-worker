/**
 * World-consistency layers (docs: cross-spread world design):
 *  1. world-law cards — per-theme fixed invariants on every scene prompt;
 *  2. world plate — fixed per-theme reference image, cache-keyed;
 *  3. world gate — fresh-only, budget-capped corrective re-renders.
 */

const { getWorldCard, renderWorldCardBlock, WORLD_CARD_MAX_BYTES } = require('../../../services/catalogEngine/worldCards');
const { listThemes, getBook } = require('../../../services/catalogEngine/catalog');
const { buildScenePrompt } = require('../../../services/catalogEngine/illustrator/scenes');
const { normalizeProfile } = require('../../../services/catalogEngine/profile');
const { platePath, buildPlatePrompt } = require('../../../services/catalogEngine/illustrator/worldPlate');
const { planWorldRepairs } = require('../../../services/catalogEngine/illustrator');
const { STYLE_VERSION } = require('../../../services/catalogEngine/versions');
const rawCards = require('../../../services/catalogEngine/data/worldCards.json');

const PROFILE = { name: 'Emma', age: 2, pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' } };

describe('world-law cards (Layer 1)', () => {
  test('every catalog theme has a card and every card fits the byte cap', () => {
    for (const t of listThemes()) {
      const card = getWorldCard(t.themeId);
      expect(card).not.toBeNull();
      expect(card.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(card.join('\n'), 'utf8')).toBeLessThanOrEqual(WORLD_CARD_MAX_BYTES);
    }
    // No orphan cards either — the loader must have rejected them at boot.
    for (const id of Object.keys(rawCards.cards)) {
      expect(listThemes().some(t => t.themeId === id)).toBe(true);
    }
  });

  test('the card block is framed and an unknown theme renders empty (never throws)', () => {
    const block = renderWorldCardBlock('farm');
    expect(block).toContain('WORLD LAWS');
    expect(block).toContain('every spread obeys the SAME laws');
    expect(renderWorldCardBlock('no_such_theme')).toBe('');
  });

  test('every scene prompt carries the theme world-law card verbatim', () => {
    const { book, theme } = getBook('farm_2_3_hello_farm');
    const profile = normalizeProfile(PROFILE);
    const prompt = buildScenePrompt({ book, theme, spread: 3, spreadText: 'Emma meets Farmer Bea.', profile, evidence: [] });
    expect(prompt).toContain('WORLD LAWS');
    for (const line of getWorldCard('farm')) expect(prompt).toContain(line);
    // The pre-existing consistency line survives — the card extends it.
    expect(prompt).toContain('stay consistent with the fixed world');
  });

  test('the same card rides every spread of the same book (subset-safe by construction)', () => {
    const { book, theme } = getBook('farm_2_3_hello_farm');
    const profile = normalizeProfile(PROFILE);
    const cardBlock = renderWorldCardBlock('farm');
    for (const spread of [1, 5, 12]) {
      const prompt = buildScenePrompt({ book, theme, spread, spreadText: 'text', profile, evidence: [] });
      expect(prompt).toContain(cardBlock);
    }
  });
});

describe('world plate (Layer 2)', () => {
  test('plate path is keyed by STYLE_VERSION and the plate-prompt hash', () => {
    expect(platePath('farm', 'abc123')).toBe(`catalog-assets/world-plates/${STYLE_VERSION}/farm-abc123.png`);
  });

  test('plate prompt is environment-only, text-free, and carries the world card', () => {
    const { theme } = getBook('enchanted_2_3_hello_wood');
    const prompt = buildPlatePrompt(theme);
    expect(prompt).toContain(theme.world_name);
    expect(prompt).toContain('NO people, NO children, NO characters');
    expect(prompt).toContain('NO readable text');
    for (const line of getWorldCard('enchanted_forest')) expect(prompt).toContain(line);
  });

  test('CATALOG_WORLD_PLATE=0 kill-switch resolves no plate', async () => {
    process.env.CATALOG_WORLD_PLATE = '0';
    try {
      jest.resetModules();
      const { getWorldPlate } = require('../../../services/catalogEngine/illustrator/worldPlate');
      const { theme } = require('../../../services/catalogEngine/catalog').getBook('farm_2_3_hello_farm');
      await expect(getWorldPlate({ theme })).resolves.toBeNull();
    } finally {
      delete process.env.CATALOG_WORLD_PLATE;
      jest.resetModules();
    }
  });
});

describe('world gate repair planning (Layer 3)', () => {
  const results = [
    { spread: 1, buffer: Buffer.from('a'), fresh: true },
    { spread: 2, buffer: Buffer.from('b'), fresh: false }, // replayed from cache
    { spread: 3, buffer: null, fresh: false }, // failed render
    { spread: 4, buffer: Buffer.from('d'), fresh: true },
  ];

  test('only FRESH flagged spreads are eligible — replays and failures never re-render', () => {
    const plan = planWorldRepairs(results, [
      { spread: 1, note: 'x' }, { spread: 2, note: 'y' }, { spread: 3, note: 'z' },
    ], 3);
    expect(plan.find(p => p.spread === 1).skipReason).toBeNull();
    expect(plan.find(p => p.spread === 2).skipReason).toMatch(/replayed cached render/);
    expect(plan.find(p => p.spread === 3).skipReason).toBe('no render');
  });

  test('the re-render budget caps eligible spreads, never the advisories', () => {
    const plan = planWorldRepairs(results, [
      { spread: 1, note: 'x' }, { spread: 4, note: 'w' },
    ], 1);
    expect(plan.find(p => p.spread === 1).skipReason).toBeNull();
    expect(plan.find(p => p.spread === 4).skipReason).toMatch(/budget exhausted/);
    // Every flagged spread stays in the plan (it still gets its advisory).
    expect(plan).toHaveLength(2);
  });

  test('the budget is spent lowest spread first regardless of the model flag order', () => {
    const plan = planWorldRepairs(results, [
      { spread: 4, note: 'w' }, { spread: 1, note: 'x' },
    ], 1);
    expect(plan.map(p => p.spread)).toEqual([1, 4]);
    expect(plan.find(p => p.spread === 1).skipReason).toBeNull();
    expect(plan.find(p => p.spread === 4).skipReason).toMatch(/budget exhausted/);
  });
});

describe('probe cache key composition (identityKeyed + world plate)', () => {
  test('identityKeyed probes keep the world-plate fingerprint in the render cache key', async () => {
    // Regression: the identity fingerprint must APPEND to the plate-folded
    // key, never rebuild from the bare story hash — otherwise a probe could
    // replay pixels rendered with a different (or missing) world plate.
    process.env.CATALOG_WORLD_PLATE = '0'; // deterministic: no plate IO
    try {
      jest.resetModules();
      // Spy BEFORE the illustrator module destructures the export.
      const illustrationGenerator = require('../../../services/illustrationGenerator');
      jest.spyOn(illustrationGenerator, 'downloadPhotoAsBase64').mockResolvedValue({ base64: 'aGk=', mimeType: 'image/png' });
      const { renderStorySpreads, storyFingerprint } = require('../../../services/catalogEngine/illustrator');
      const story = { book_id: 'farm_2_3_hello_farm', spreads: [] };
      const { storyHash } = await renderStorySpreads({
        bookId: 'b_key',
        story,
        bookDef: { book: { beats: [] }, theme: { theme_id: 'farm', world_name: 'Sunnybrook Farm' } },
        profile: { name: 'Emma', age: 2 },
        approvedCoverUrl: 'https://example.com/cover.png?sig=1',
        identityKeyed: true,
        log: () => {},
      });
      // With no plate the key is base + identity; the identity segment must
      // extend the running key (base prefix intact), so a plate fold — when
      // present — survives in exactly the same composition.
      expect(storyHash.startsWith(`${storyFingerprint(story)}-i`)).toBe(true);
    } finally {
      delete process.env.CATALOG_WORLD_PLATE;
      jest.restoreAllMocks();
      jest.resetModules();
    }
  });
});
