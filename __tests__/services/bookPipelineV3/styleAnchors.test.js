/**
 * P3 (2026-07-23 audit): intra-interior render consistency. PIXAR_STYLE gained
 * explicit negative anchors (flat vector / photoreal live-action) and the
 * style bible version bumped so cached identity kits regenerate once.
 */

const { PIXAR_STYLE } = require('../../../services/shared/illustration/config');
const { STYLE_VERSION, STYLE_BIBLE } = require('../../../services/bookPipelineV3/illustrator/styleBible');

describe('PIXAR_STYLE negative anchors', () => {
  test('antiStyle rejects flat vector / hard cel outlines', () => {
    expect(PIXAR_STYLE.antiStyle).toMatch(/flat vector illustration with hard cel outlines or uniform flat color fills/i);
  });
  test('antiStyle rejects photoreal live-action while keeping stylized depth-of-field legal', () => {
    expect(PIXAR_STYLE.antiStyle).toMatch(/photorealistic live-action render/i);
    expect(PIXAR_STYLE.antiStyle).toMatch(/depth-of-field must stay inside the stylized 3D animated-film look/i);
  });
});

describe('style bible versioning', () => {
  test('STYLE_VERSION is the sb-3 audit bump', () => {
    expect(STYLE_VERSION).toBe('sb-3-pixar-premium-3d-stylized');
  });
  test('the bible embeds the anti-style so cached kits track the anchors', () => {
    expect(STYLE_BIBLE).toContain(PIXAR_STYLE.antiStyle);
  });
});
