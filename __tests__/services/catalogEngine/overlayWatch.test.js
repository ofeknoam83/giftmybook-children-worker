/**
 * Multi-instance convergence: Cloud Run runs many warm instances but only
 * the one that serves /v13/catalog-overlay/activate hot-swaps immediately.
 * Every instance runs the pointer watch, whose single reconciliation pass
 * (syncCatalogOverlayFromPointer) is exercised here against an in-memory
 * GCS: converge to a foreign activation, converge back to base on a
 * foreign deactivation, and keep serving the current catalog when the
 * pointed-at blob is unavailable.
 */

jest.mock('../../../services/gcsStorage', () => {
  const store = new Map();
  return {
    __store: store,
    saveJson: jest.fn(async (obj, path) => { store.set(path, JSON.parse(JSON.stringify(obj))); }),
    loadJson: jest.fn(async (path) => {
      if (!store.has(path)) throw new Error(`not found: ${path}`);
      return store.get(path);
    }),
  };
});

const gcs = require('../../../services/gcsStorage');
const catalogEngine = require('../../../services/catalogEngine');
const catalog = require('../../../services/catalogEngine/catalog');

const base = catalog.baseCatalog();
const OVERLAY = {
  base_version: base.version,
  patches: { themes: { enchanted_forest: { display_name: 'Magic & Fantasy' } } },
};

afterEach(() => {
  catalog.resetCatalogOverlay();
  gcs.__store.clear();
});

test('converges to an overlay activated on another instance', async () => {
  const hash8 = await catalogEngine.catalogOverlay.saveOverlayBlob(OVERLAY);
  await catalogEngine.catalogOverlay.setActivePointer(hash8);
  // This instance still serves the base until a pass runs…
  expect(catalog.catalogVersion()).toBe(String(base.version));
  const pass = await catalogEngine.syncCatalogOverlayFromPointer();
  expect(pass.changed).toBe(true);
  expect(catalog.catalogVersion()).toBe(`${base.version}+${hash8}`);
  expect(catalog.loadCatalog().themes.enchanted_forest.display_name).toBe('Magic & Fantasy');
  // …and once converged, the next pass is a no-op.
  expect((await catalogEngine.syncCatalogOverlayFromPointer()).changed).toBe(false);
});

test('converges back to base when the pointer clears on another instance', async () => {
  const hash8 = await catalogEngine.catalogOverlay.saveOverlayBlob(OVERLAY);
  catalog.applyCatalogOverlay(OVERLAY, hash8); // this instance activated it
  await catalogEngine.catalogOverlay.setActivePointer(null); // deactivated elsewhere
  const pass = await catalogEngine.syncCatalogOverlayFromPointer();
  expect(pass.changed).toBe(true);
  expect(catalog.catalogVersion()).toBe(String(base.version));
});

test('a vanished blob fails the pass loudly and keeps the current catalog', async () => {
  await catalogEngine.catalogOverlay.setActivePointer('deadbee1');
  await expect(catalogEngine.syncCatalogOverlayFromPointer()).rejects.toThrow(/missing from GCS/);
  expect(catalog.catalogVersion()).toBe(String(base.version));
});

test('no pointer file at all is a quiet no-op', async () => {
  expect((await catalogEngine.syncCatalogOverlayFromPointer()).changed).toBe(false);
  expect(catalog.catalogVersion()).toBe(String(base.version));
});
