const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const { buildGraphicNovelPdf } = require('../../services/layoutEngine');

async function makePanelBuffer(color) {
  return sharp({
    create: {
      width: 300,
      height: 300,
      channels: 3,
      background: color,
    },
  }).png().toBuffer();
}

describe('buildGraphicNovelPdf', () => {
  test('renders a premium page-aware graphic novel PDF', async () => {
    const panelA = await makePanelBuffer({ r: 220, g: 140, b: 120 });
    const panelB = await makePanelBuffer({ r: 120, g: 150, b: 220 });

    const pages = [
      {
        pageNumber: 1,
        sceneNumber: 1,
        sceneTitle: 'Launch',
        pagePurpose: 'Establish the world',
        pageTurnIntent: 'wonder',
        dominantBeat: 'A huge reveal',
        layoutTemplate: 'twoTierEqual',
        panelCount: 2,
        textDensity: 'light',
        colorScript: { paletteId: 'sunrise', dominantHue: 'gold', contrastMode: 'brightFacesDarkGround' },
        panels: [
          {
            panelNumber: 1,
            panelType: 'establishing',
            action: 'The sky port glows.',
            caption: 'Morning lifts over the sky port.',
            captions: [{ text: 'Morning lifts over the sky port.', placement: 'top-band', type: 'narration' }],
            balloons: [],
            dialogue: '',
            imageBuffer: panelA,
            safeTextZones: ['upper-band'],
            textFreeZone: 'upper-band',
          },
          {
            panelNumber: 2,
            panelType: 'dialogue',
            action: 'Noam looks up in awe.',
            caption: '',
            dialogue: 'Whoa. This place is real.',
            balloons: [{ text: 'Whoa. This place is real.', order: 1, anchor: 'left', type: 'speech' }],
            captions: [],
            imageBuffer: panelB,
            safeTextZones: ['top-right'],
            textFreeZone: 'top-right',
          },
        ],
      },
    ];

    const pdfBuffer = await buildGraphicNovelPdf([], {
      title: 'Noam and the Sky Port',
      childName: 'Noam',
      tagline: 'A city above the clouds changes everything.',
      pages,
      scenes: [{ number: 1, sceneTitle: 'Launch', panels: pages[0].panels }],
    });

    expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
    expect(pdfBuffer.length).toBeGreaterThan(1000);

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    expect(pdfDoc.getPageCount()).toBeGreaterThanOrEqual(4);
    expect(pdfDoc.getPageCount() % 2).toBe(0);
  });
});
