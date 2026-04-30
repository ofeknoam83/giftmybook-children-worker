/**
 * @jest-environment node
 */

const sharp = require('sharp');
const { sliceQuadToTwoSpreadStrips } = require('../../../services/bookPipeline/illustrator/sliceQuadToTwoSpreadStrips');
const { getIllustrationRenderer } = require('../../../services/bookPipeline/constants');
const { buildDualSpreadTurn } = require('../../../services/illustrator/promptQuad');

describe('sliceQuadToTwoSpreadStrips', () => {
  it('splits 800x200 into two 400x200 buffers', async () => {
    const buf = await sharp({
      create: { width: 800, height: 200, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const { leftStrip, rightStrip, width, height, halfWidth } = await sliceQuadToTwoSpreadStrips(buf);
    expect(width).toBe(800);
    expect(height).toBe(200);
    expect(halfWidth).toBe(400);
    const mL = await sharp(leftStrip).metadata();
    const mR = await sharp(rightStrip).metadata();
    expect(mL.width).toBe(400);
    expect(mR.width).toBe(400);
    expect(mL.height).toBe(200);
    expect(mR.height).toBe(200);
  });
});

describe('getIllustrationRenderer', () => {
  const prev = process.env.GIFTMYBOOK_QUAD_SPREAD_ILLUSTRATOR;

  afterEach(() => {
    if (prev === undefined) delete process.env.GIFTMYBOOK_QUAD_SPREAD_ILLUSTRATOR;
    else process.env.GIFTMYBOOK_QUAD_SPREAD_ILLUSTRATOR = prev;
  });

  it('defaults to quad', () => {
    delete process.env.GIFTMYBOOK_QUAD_SPREAD_ILLUSTRATOR;
    expect(getIllustrationRenderer({ request: {} })).toEqual({ renderer: 'quad', source: 'default' });
  });

  it('forces legacy from env=0', () => {
    process.env.GIFTMYBOOK_QUAD_SPREAD_ILLUSTRATOR = '0';
    expect(getIllustrationRenderer({ request: {} })).toEqual({ renderer: 'legacy', source: 'env' });
  });

  it('enables quad from env=1', () => {
    process.env.GIFTMYBOOK_QUAD_SPREAD_ILLUSTRATOR = '1';
    expect(getIllustrationRenderer({ request: {} })).toEqual({ renderer: 'quad', source: 'env' });
  });

  it('enables quad from request flag', () => {
    delete process.env.GIFTMYBOOK_QUAD_SPREAD_ILLUSTRATOR;
    expect(getIllustrationRenderer({ request: { useQuadSpreadIllustrator: true } })).toEqual({
      renderer: 'quad',
      source: 'request',
    });
  });

  it('forces legacy from request false', () => {
    delete process.env.GIFTMYBOOK_QUAD_SPREAD_ILLUSTRATOR;
    expect(getIllustrationRenderer({ request: { useQuadSpreadIllustrator: false } })).toEqual({
      renderer: 'legacy',
      source: 'request',
    });
  });
});

describe('buildDualSpreadTurn', () => {
  it('includes both spread numbers and QUAD BATCH', () => {
    const t = buildDualSpreadTurn({
      spreadIndexA: 0,
      spreadIndexB: 1,
      sceneA: 'Scene one',
      sceneB: 'Scene two',
      textA: 'Caption A',
      textB: 'Caption B',
      textSideA: 'left',
      textSideB: 'right',
      theme: 'birthday',
      childAge: 4,
      quadBatchIndex: 0,
    });
    expect(t).toMatch(/QUAD BATCH 1/);
    expect(t).toMatch(/SPREAD 1/);
    expect(t).toMatch(/SPREAD 2/);
    expect(t).toMatch(/LEFT HALF/);
    expect(t).toMatch(/RIGHT HALF/);
  });
});
