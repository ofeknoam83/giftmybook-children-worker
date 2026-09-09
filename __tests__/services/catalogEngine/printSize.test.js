'use strict';

// pq-1 (docs/PRINT_QUALITY_PLAN.md Phase 1): the text-free layouts get a
// print tier, folded into the render key, with the un-folded key kept as a
// replay fallback so a book rendered before the tier never re-renders.

const ENV_KEYS = ['CATALOG_PRINT_IMAGE_SIZE', 'CATALOG_PRINT_IMAGE_SIZE_WIDE', 'CATALOG_PRINT_IMAGE_SIZE_SQUARE',
  'CATALOG_MIN_PRINT_RENDER_HEIGHT', 'CATALOG_COVER_IMAGE_SIZE', 'CATALOG_PRINT_PPI_FLOOR', 'CATALOG_EMBEDDED_IMAGE_SIZE',
  'CATALOG_COVER_OUTPAINT', 'CATALOG_COVER_OUTPAINT_SIZE', 'CATALOG_FOLD_SAFETY', 'CATALOG_PRINT_PREVIEWS'];
const saved = {};
beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const flags = require('../../../services/catalogEngine/flags');

describe('print tier flags', () => {
  test('defaults: wide (half) renders ask for 4K, square (caption) for 2K, the cover for 2K', () => {
    expect(flags.printImageSizeEnabled()).toBe(true);
    expect(flags.printImageSize('wide')).toBe('4K');
    expect(flags.printImageSize('square')).toBe('2K');
    expect(flags.coverImageSize()).toBe('2K');
    expect(flags.printPpiFloor()).toBe(0);
  });

  test('the resolution guard follows the tier, an explicit height pins it, 0 disables it', () => {
    expect(flags.minPrintRenderHeight('4K')).toBe(2000);
    expect(flags.minPrintRenderHeight('2K')).toBe(1000);
    expect(flags.minPrintRenderHeight('1K')).toBe(500);
    process.env.CATALOG_MIN_PRINT_RENDER_HEIGHT = '1500';
    expect(flags.minPrintRenderHeight('4K')).toBe(1500);
    process.env.CATALOG_MIN_PRINT_RENDER_HEIGHT = '0';
    expect(flags.minPrintRenderHeight('4K')).toBe(0);
  });

  test('overrides and kill-switches', () => {
    process.env.CATALOG_PRINT_IMAGE_SIZE_WIDE = '2k';
    process.env.CATALOG_PRINT_IMAGE_SIZE_SQUARE = '4K';
    expect(flags.printImageSize('wide')).toBe('2K');
    expect(flags.printImageSize('square')).toBe('4K');
    process.env.CATALOG_PRINT_IMAGE_SIZE_SQUARE = 'huge';
    expect(flags.printImageSize('square')).toBe('2K');
    process.env.CATALOG_PRINT_IMAGE_SIZE = '0';
    expect(flags.printImageSizeEnabled()).toBe(false);
    process.env.CATALOG_COVER_IMAGE_SIZE = '0';
    expect(flags.coverImageSize()).toBeNull();
    process.env.CATALOG_COVER_IMAGE_SIZE = '4K';
    expect(flags.coverImageSize()).toBe('4K');
    process.env.CATALOG_PRINT_PPI_FLOOR = '150';
    expect(flags.printPpiFloor()).toBe(150);
  });
});

describe('render-key fold and legacy continuity', () => {
  const { printSizeFoldFor, foldSafetyFoldFor, renderCachePath } = require('../../../services/catalogEngine/illustrator');

  test('the fold names the tier for text-free layouts and is empty for embedded (its own env fold) and when off', () => {
    expect(printSizeFoldFor({ textLayout: 'half', aspect: 'wide' })).toBe('-is4k');
    expect(printSizeFoldFor({ textLayout: 'caption', aspect: 'square' })).toBe('-is2k');
    expect(printSizeFoldFor({ textLayout: 'embedded', aspect: 'wide' })).toBe('');
    process.env.CATALOG_PRINT_IMAGE_SIZE = '0';
    expect(printSizeFoldFor({ textLayout: 'half', aspect: 'wide' })).toBe('');
  });

  test('stripping the fold from a folded key yields exactly the pre-pq-1 key (what an older book holds its pixels at)', () => {
    const fold = printSizeFoldFor({ textLayout: 'caption', aspect: 'square' });
    const legacyHash = 'abc123-c9zq-bdeadbeef';
    const folded = renderCachePath('book-1', `abc123-c9zq${fold}-bdeadbeef`, 4, 'square', 'none');
    expect(folded).toContain('-is2k-');
    expect(folded.replace(fold, '')).toBe(renderCachePath('book-1', legacyHash, 4, 'square', 'none'));
  });

  test('fold-safety-on renders get their own cache namespace while off keeps the pre-pq legacy key', () => {
    expect(foldSafetyFoldFor()).toBe('-fs1');
    process.env.CATALOG_FOLD_SAFETY = '0';
    expect(foldSafetyFoldFor()).toBe('');
  });
});

describe('pq-1 Phase 3 — the cover wrap outpaint geometry', () => {
  const { planOutpaint } = require('../../../services/coverGenerator');

  test('the wrap canvas is padded to a square and the trim pixels keep their offset', () => {
    // A casewrap front panel: 8.5 in trim at 300 dpi, 0.875 in on top, bottom and the outer (right) edge.
    const plan = planOutpaint({ width: 2550, height: 2550 }, { top: 263, bottom: 263, left: 0, right: 263 });
    expect(plan.canvas).toEqual({ width: 2813, height: 3076 });
    expect(plan.square).toBe(3076);
    expect(plan.pad).toEqual({ left: 131, top: 0 });
    expect(plan.trimOffset).toEqual({ left: 0, top: 263 });
    // A back panel wraps on the LEFT instead.
    const back = planOutpaint({ width: 2550, height: 2550 }, { top: 263, bottom: 263, left: 263, right: 0 });
    expect(back.trimOffset).toEqual({ left: 263, top: 263 });
  });

  test('the outpaint runs for casewraps by default, everywhere with `all`, nowhere with `0`', () => {
    expect(flags.coverOutpaint()).toBe('casewrap');
    expect(flags.coverOutpaintSize()).toBe('2K');
    process.env.CATALOG_COVER_OUTPAINT = 'all';
    expect(flags.coverOutpaint()).toBe('all');
    process.env.CATALOG_COVER_OUTPAINT = '0';
    expect(flags.coverOutpaint()).toBe('off');
    process.env.CATALOG_COVER_OUTPAINT_SIZE = '4k';
    expect(flags.coverOutpaintSize()).toBe('4K');
  });
});
