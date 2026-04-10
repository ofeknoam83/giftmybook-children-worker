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

  test('renders thought, shout and whisper balloon types without throwing', async () => {
    const panelBuf = await makePanelBuffer({ r: 180, g: 210, b: 240 });

    const pages = [
      {
        pageNumber: 1,
        sceneNumber: 1,
        sceneTitle: 'Balloon Types',
        pagePurpose: 'Test all balloon variants',
        pageTurnIntent: 'question',
        dominantBeat: 'Testing',
        layoutTemplate: 'threeEqual',
        panelCount: 3,
        textDensity: 'medium',
        colorScript: {},
        panels: [
          {
            panelNumber: 1,
            panelType: 'dialogue',
            action: 'Character thinks.',
            caption: '',
            dialogue: 'I wonder what happens next...',
            balloons: [{ text: 'I wonder what happens next...', order: 1, anchor: 'left', type: 'thought' }],
            captions: [],
            imageBuffer: panelBuf,
            safeTextZones: ['top-right'],
            textFreeZone: 'top-right',
          },
          {
            panelNumber: 2,
            panelType: 'action',
            action: 'Character shouts.',
            caption: '',
            dialogue: 'Watch out!',
            balloons: [{ text: 'Watch out!', order: 1, anchor: 'right', type: 'shout' }],
            captions: [],
            imageBuffer: panelBuf,
            safeTextZones: ['top-left'],
            textFreeZone: 'top-left',
          },
          {
            panelNumber: 3,
            panelType: 'dialogue',
            action: 'Character whispers.',
            caption: '',
            dialogue: 'Can you keep a secret?',
            balloons: [{ text: 'Can you keep a secret?', order: 1, anchor: 'left', type: 'whisper' }],
            captions: [],
            imageBuffer: panelBuf,
            safeTextZones: ['top-right'],
            textFreeZone: 'top-right',
          },
        ],
      },
    ];

    const pdfBuffer = await buildGraphicNovelPdf([], {
      title: 'Balloon Type Test',
      childName: 'Tester',
      tagline: '',
      pages,
      scenes: [{ number: 1, sceneTitle: 'Balloon Types', panels: pages[0].panels }],
    });

    expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
    expect(pdfBuffer.length).toBeGreaterThan(1000);

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    expect(pdfDoc.getPageCount()).toBeGreaterThanOrEqual(4);
  });
});
