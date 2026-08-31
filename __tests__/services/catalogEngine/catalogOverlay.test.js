/**
 * Catalog Overlay — the admin plot-editing layer: prose-field allowlist,
 * merge semantics, merged-catalog invariants, and pinned-tag resolution.
 * The base catalog.json stays frozen; overlays may reshape a theme's tone
 * (e.g. Dreams → bedtime, Enchanted Forest → broad magic/fantasy) but can
 * never touch structure.
 */

const {
  validateOverlayShape,
  applyOverlay,
  overlayHash,
  overlayTag,
  overlaySummary,
} = require('../../../services/catalogEngine/catalogOverlay');
const catalog = require('../../../services/catalogEngine/catalog');

const base = catalog.baseCatalog();

const GOOD_OVERLAY = {
  base_version: base.version,
  patches: {
    themes: {
      enchanted_forest: {
        display_name: 'Magic & Fantasy',
        world_name: 'The Shimmerlands',
        companion: { name: 'Lumi', type: 'small glowing spirit of wonder' },
      },
    },
    books: {
      enchanted_2_3_hello_wood: {
        title_template: "{name}'s Magical Day",
        premise: 'A warm first visit to a land where gentle magic lives everywhere.',
        refrain: { text: 'Hello, magic! Glow, glow, glow!', spreads: [2, 5, 8, 11] },
        beats: {
          1: 'Child gets ready to visit the Shimmerlands.',
          12: 'Child says goodbye to Lumi and the Shimmerlands.',
        },
      },
    },
  },
};

describe('overlay shape validation (the allowlist is the contract)', () => {
  test('a prose-only overlay validates clean', () => {
    expect(validateOverlayShape(GOOD_OVERLAY, base)).toEqual([]);
  });

  test('structural edits are rejected wholesale', () => {
    const errors = validateOverlayShape({
      base_version: base.version,
      patches: {
        themes: { enchanted_forest: { theme_id: 'magic', age_bands: {} } },
        books: { enchanted_2_3_hello_wood: { id: 'renamed', archetype: 'new', beats: { 13: 'no' } } },
      },
    }, base);
    expect(errors.join(' ')).toMatch(/theme_id is not an editable/);
    expect(errors.join(' ')).toMatch(/age_bands is not an editable/);
    expect(errors.join(' ')).toMatch(/\bid is not an editable/);
    expect(errors.join(' ')).toMatch(/archetype is not an editable/);
    expect(errors.join(' ')).toMatch(/beats key '13'/);
  });

  test('unknown ids, bad refrains, missing {name}, and control chars are named', () => {
    const errors = validateOverlayShape({
      base_version: base.version,
      patches: {
        themes: { not_a_theme: { display_name: 'X' } },
        books: {
          not_a_book: { premise: 'x' },
          enchanted_2_3_hello_wood: {
            title_template: 'No placeholder here',
            premise: 'badbell',
            refrain: { spreads: [0, 5, 5] },
          },
        },
      },
    }, base);
    expect(errors.join(' ')).toMatch(/unknown theme 'not_a_theme'/);
    expect(errors.join(' ')).toMatch(/unknown book 'not_a_book'/);
    expect(errors.join(' ')).toMatch(/title_template must contain exactly one \{name\}/);
    expect(errors.join(' ')).toMatch(/premise contains control characters/);
    expect(errors.join(' ')).toMatch(/refrain\.spreads/);
  });

  test('a wrong base_version refuses — overlays bind to one deployed catalog', () => {
    expect(validateOverlayShape({ base_version: '9.9', patches: {} }, base).join(' '))
      .toMatch(/base_version '9.9' does not match/);
  });

  test('__proto__/constructor theme keys are unknown themes, never prototype writes', () => {
    // JSON.parse creates OWN '__proto__' keys (an object literal would not),
    // which is exactly how a hostile patch body arrives through Express.
    const evil = JSON.parse(`{"base_version":"${base.version}","patches":{"themes":{`
      + '"__proto__":{"display_name":"polluted"},"constructor":{"display_name":"polluted"}}}}');
    const errors = validateOverlayShape(evil, base);
    expect(errors.join(' ')).toMatch(/unknown theme '__proto__'/);
    expect(errors.join(' ')).toMatch(/unknown theme 'constructor'/);
    // Defense in depth: even fed straight to the merge, nothing may land on
    // the prototype chain.
    applyOverlay(base, evil);
    expect({}.display_name).toBeUndefined();
    expect(Object.prototype.display_name).toBeUndefined();
  });

  test('inherited property names are not editable fields', () => {
    const errors = validateOverlayShape({
      base_version: base.version,
      patches: { themes: { enchanted_forest: { constructor: 'x', hasOwnProperty: 'y' } } },
    }, base);
    expect(errors.join(' ')).toMatch(/constructor is not an editable theme field/);
    expect(errors.join(' ')).toMatch(/hasOwnProperty is not an editable theme field/);
  });

  test('title_template takes exactly one {name} and no other placeholders', () => {
    const check = (title) => validateOverlayShape({
      base_version: base.version,
      patches: { books: { enchanted_2_3_hello_wood: { title_template: title } } },
    }, base).join(' ');
    // Two {name} tokens can render past the runtime title length with a
    // long child name; unknown tokens would print as literal braces.
    expect(check('{name} and {name} Again')).toMatch(/exactly one \{name\}/);
    expect(check('{name} Meets {companion}')).toMatch(/exactly one \{name\}/);
    expect(check("{name}'s Big Day")).toBe('');
  });

  test("a refrain that cannot fit the band's tightest spread refuses", () => {
    // 26 words on a 1-3 book: an age-1 spread holds at most 25 words, so no
    // story containing this refrain could ever validate for that profile.
    const errors = validateOverlayShape({
      base_version: base.version,
      patches: { books: { enchanted_2_3_hello_wood: { refrain: { text: Array(26).fill('la').join(' ') } } } },
    }, base);
    expect(errors.join(' ')).toMatch(/26 words but a band 1-3 spread holds at most 25/);
  });
});

describe('overlay merge + invariants + identity', () => {
  test('applyOverlay patches prose, keeps structure, never mutates the base', () => {
    const merged = applyOverlay(base, GOOD_OVERLAY);
    const theme = merged.themes.enchanted_forest;
    expect(theme.display_name).toBe('Magic & Fantasy');
    expect(theme.world_name).toBe('The Shimmerlands');
    expect(base.themes.enchanted_forest.display_name).toBe('Enchanted Forest'); // untouched

    const book = theme.age_bands['1-3'].find(b => b.id === 'enchanted_2_3_hello_wood');
    expect(book.title_template).toBe("{name}'s Magical Day");
    expect(book.refrain.text).toBe('Hello, magic! Glow, glow, glow!');
    expect(book.beats[0].beat).toBe('Child gets ready to visit the Shimmerlands.');
    expect(book.beats[11].beat).toBe('Child says goodbye to Lumi and the Shimmerlands.');
    expect(book.beats[1].beat).toBe(base.themes.enchanted_forest.age_bands['1-3'][0].beats[1].beat); // unpatched beat kept

    // The merged catalog still satisfies every boot invariant.
    expect(catalog.validateCatalog(merged)).toEqual([]);
  });

  test('hash/tag identify the overlay content; summary counts the touch surface', () => {
    const h = overlayHash(GOOD_OVERLAY);
    expect(h).toBe(overlayHash(JSON.parse(JSON.stringify(GOOD_OVERLAY))));
    expect(overlayTag(base.version, h)).toBe(`${base.version}+${h.slice(0, 8)}`);
    expect(overlaySummary(GOOD_OVERLAY)).toEqual({ themes: 1, books: 1, beats: 2, retired: 0 });
  });
});

describe('plot retirement (soft delete — gone from selection, kept for stored stories)', () => {
  afterEach(() => catalog.resetCatalogOverlay());

  it('a retired book vanishes from eligibility and theme counts, but still resolves by id', () => {
    const overlay = {
      base_version: base.version,
      patches: { books: { enchanted_2_3_hello_wood: { retired: true } } },
    };
    expect(validateOverlayShape(overlay, base)).toEqual([]);
    const hash8 = overlayHash(overlay).slice(0, 8);
    catalog.applyCatalogOverlay(overlay, hash8);

    const eligible = catalog.eligibleBooks('enchanted_forest', '1-3').map(b => b.id);
    expect(eligible).not.toContain('enchanted_2_3_hello_wood');
    expect(eligible.length).toBe(3); // 4 in the band minus the retired one

    const counts = catalog.listThemes().find(t => t.themeId === 'enchanted_forest').bandCounts;
    expect(counts['1-3']).toBe(3);

    // The definition survives: stored stories keep validating and printing.
    expect(catalog.getBook('enchanted_2_3_hello_wood')).not.toBeNull();
    expect(overlaySummary(overlay).retired).toBe(1);
  });

  it('retirement may never drop a band below one full selection slate', () => {
    const band = base.themes.enchanted_forest.age_bands['1-3'].map(b => b.id);
    const overlay = {
      base_version: base.version,
      patches: { books: Object.fromEntries(band.slice(0, 2).map(id => [id, { retired: true }])) },
    };
    // 4 books minus 2 = 2 active < 3 → the merged-catalog gate refuses.
    expect(() => catalog.applyCatalogOverlay(overlay, 'deadbee1'))
      .toThrow(/only 2 active book\(s\)/);
    expect(catalog.eligibleBooks('enchanted_forest', '1-3').length).toBe(4); // untouched
  });

  it('a retired book refuses FRESH generation even when addressed by id', () => {
    const overlay = {
      base_version: base.version,
      patches: { books: { enchanted_2_3_hello_wood: { retired: true } } },
    };
    catalog.applyCatalogOverlay(overlay, overlayHash(overlay).slice(0, 8));
    // Eligibility filtering covers selection; this covers the direct paths
    // (/v13/generate-stories bookIds, fresh /generate-book) that pass ids
    // straight to the writer. Stored stories never build a fresh request.
    const { buildStoryRequest } = require('../../../services/catalogEngine/writer');
    expect(() => buildStoryRequest({
      bookId: 'enchanted_2_3_hello_wood',
      profile: { name: 'Emma', age: 2, pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' } },
      sessionId: 'sess_retired',
    })).toThrow(/retired/);
  });

  it('retired must be boolean; retired: false restores', () => {
    expect(validateOverlayShape({
      base_version: base.version,
      patches: { books: { enchanted_2_3_hello_wood: { retired: 'yes' } } },
    }, base).join(' ')).toMatch(/retired must be true or false/);

    const merged = applyOverlay(base, {
      base_version: base.version,
      patches: { books: { enchanted_2_3_hello_wood: { retired: false } } },
    });
    const book = merged.themes.enchanted_forest.age_bands['1-3'].find(b => b.id === 'enchanted_2_3_hello_wood');
    expect(book.retired).toBeUndefined();
  });
});

describe('live swap + pinned-tag resolution', () => {
  afterEach(() => catalog.resetCatalogOverlay());

  test('applyCatalogOverlay hot-swaps the merged view and the version tag', async () => {
    const hash8 = overlayHash(GOOD_OVERLAY).slice(0, 8);
    const tag = catalog.applyCatalogOverlay(GOOD_OVERLAY, hash8);
    expect(tag).toBe(`${base.version}+${hash8}`);
    expect(catalog.catalogVersion()).toBe(tag);
    expect(catalog.getBook('enchanted_2_3_hello_wood').theme.display_name).toBe('Magic & Fantasy');

    // Pinned resolution: the ACTIVE tag resolves from cache; the bare base
    // tag resolves the frozen definitions.
    const pinned = await catalog.getBookForTag('enchanted_2_3_hello_wood', tag);
    expect(pinned.book.title_template).toBe("{name}'s Magical Day");
    const baseHit = await catalog.getBookForTag('enchanted_2_3_hello_wood', String(base.version));
    expect(baseHit.book.title_template).toBe("{name}'s Enchanted Forest Day");

    catalog.resetCatalogOverlay();
    expect(catalog.catalogVersion()).toBe(String(base.version));
    expect(catalog.getBook('enchanted_2_3_hello_wood').theme.display_name).toBe('Enchanted Forest');
    // The deactivated overlay's tag STILL resolves (pinned cache) — stored
    // stories keep their provenance.
    const stillPinned = await catalog.getBookForTag('enchanted_2_3_hello_wood', tag);
    expect(stillPinned.book.title_template).toBe("{name}'s Magical Day");
  });

  test('an unknown pinned tag returns null instead of guessing', async () => {
    expect(await catalog.getBookForTag('enchanted_2_3_hello_wood', '9.9+deadbeef')).toBeNull();
  });

  test('a merged catalog that breaks invariants refuses to activate', () => {
    // Sneak a structural break past shape validation by hand-crafting the
    // merge input: an overlay function is the only caller, so simulate a
    // future bug by patching title_template to lose {name}.
    const bad = JSON.parse(JSON.stringify(GOOD_OVERLAY));
    bad.patches.books.enchanted_2_3_hello_wood.title_template = 'No placeholder';
    expect(() => catalog.applyCatalogOverlay(bad, 'deadbeef')).toThrow(/boot invariants/);
    expect(catalog.catalogVersion()).toBe(String(base.version)); // live view untouched
  });

  test('a story generated under the overlay validates against ITS definitions', async () => {
    const { buildStoryRequest } = require('../../../services/catalogEngine/writer');
    const { validateStoryResponse } = require('../../../services/catalogEngine/storyValidation');
    const hash8 = overlayHash(GOOD_OVERLAY).slice(0, 8);
    catalog.applyCatalogOverlay(GOOD_OVERLAY, hash8);

    const PRONOUNS = { subject: 'she', object: 'her', possessive_adjective: 'her' };
    const { request } = buildStoryRequest({
      bookId: 'enchanted_2_3_hello_wood',
      profile: { name: 'Emma', age: 2, pronouns: PRONOUNS },
      sessionId: 'sess_overlay', requestId: 'req_overlay_1',
    });
    // The request pins the overlay tag and renders the PATCHED title.
    expect(request.versions.catalog).toBe(`${base.version}+${hash8}`);
    expect(request.rendered_title).toBe("Emma's Magical Day");

    // A response carrying the PATCHED refrain validates under the pinned
    // definition (resolved via getBookForTag), not the frozen base one.
    const hit = await catalog.getBookForTag('enchanted_2_3_hello_wood', request.versions.catalog);
    const filler = 'Emma smiles in the Shimmerlands as gentle magic hums around her softly';
    const spreads = Array.from({ length: 12 }, (_, i) => {
      const n = i + 1;
      let text = `${filler} today.`;
      if ([2, 5, 8, 11].includes(n)) text += ' Hello, magic! Glow, glow, glow!';
      return { spread: n, text };
    });
    const response = {
      request_id: request.request_id, book_id: request.book_id,
      title: request.rendered_title, versions: { ...request.versions },
      spreads, personalization_evidence: [], omitted_profile_fields: [],
    };
    const v = validateStoryResponse({ response, request, book: hit.book, ageBand: hit.ageBand, map: null });
    expect(v.errors).toEqual([]);
  });
});
