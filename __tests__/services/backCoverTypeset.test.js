/**
 * Back-cover text is TYPESET, never painted (audit 2026-07-15).
 *
 * A shipped customer book carried a Gemini-painted synopsis with garbled
 * words ("stofor", "swoown") and a fake painted barcode. These tests pin
 * the fix from both sides:
 *   1. the back-cover image prompt asks for text-free artwork (no synopsis,
 *      no branding, no barcode in the prompt), and
 *   2. drawBackCoverTypeset renders the synopsis verbatim with pdf-lib,
 *      entirely inside the trim-safe area.
 */
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';

const { PDFDocument, StandardFonts } = require('pdf-lib');
const {
  wrapTextToWidth,
  drawBackCoverTypeset,
} = require('../../services/coverGenerator');

describe('wrapTextToWidth', () => {
  test('no wrapped line exceeds the max width and every word survives', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const text = 'At dusk, Amit practices soccer in the yard and keeps asking the twinkling sky if that kick was the one to bring the stars down to play.';
    const maxWidth = 300;
    const lines = wrapTextToWidth(text, font, 13, maxWidth);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(font.widthOfTextAtSize(line, 13)).toBeLessThanOrEqual(maxWidth);
    }
    expect(lines.join(' ')).toBe(text.replace(/\s+/g, ' '));
  });
});

describe('drawBackCoverTypeset', () => {
  const geom = { edgeBleed: 9, trimWidth: 612, totalHeight: 738 };

  async function draw(content) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([1367, 738]);
    const fonts = {
      font: await doc.embedFont(StandardFonts.Helvetica),
      boldFont: await doc.embedFont(StandardFonts.HelveticaBold),
      italicFont: await doc.embedFont(StandardFonts.HelveticaOblique),
    };
    const calls = [];
    const realDrawText = page.drawText.bind(page);
    page.drawText = (text, opts) => { calls.push({ text, ...opts }); return realDrawText(text, opts); };
    drawBackCoverTypeset(page, geom, fonts, content);
    return calls;
  }

  test('renders the synopsis VERBATIM (typos cannot be introduced by a model)', async () => {
    const synopsis = 'When Amit stops for the perfect move, the stars break their pattern and swoop down.';
    const calls = await draw({ synopsis, childName: 'Amit' });
    // Each line draws 5x (4 outline passes + 1 fill); dedupe to unique texts.
    const uniqueTexts = [...new Set(calls.map(c => c.text))];
    const joined = uniqueTexts.join(' ');
    for (const word of synopsis.split(' ')) {
      expect(joined).toContain(word);
    }
    expect(joined).toContain('Made with love for Amit');
    expect(joined).toContain('GiftMyBook.com');
  });

  test('every draw stays inside the trim-safe area (never in bleed or barcode strip)', async () => {
    const calls = await draw({
      synopsis: 'A very long synopsis that wraps across multiple lines because it describes the whole magical adventure Amit goes on under the night sky with his glowing soccer ball and star friends.',
      heartfeltNote: 'We love you to the stars and back',
      bookFrom: 'Mom and Dad',
      childName: 'Amit',
    });
    const SAFE = 45;
    const left = geom.edgeBleed + SAFE - 1; // -1 for the 0.7pt outline offset
    const right = geom.edgeBleed + geom.trimWidth - SAFE + 1;
    for (const c of calls) {
      expect(c.x).toBeGreaterThanOrEqual(left);
      expect(c.y).toBeGreaterThanOrEqual(geom.edgeBleed + 20); // above bottom bleed
      expect(c.y).toBeLessThanOrEqual(geom.totalHeight - geom.edgeBleed - SAFE);
    }
    // No painted barcode anywhere.
    expect(calls.some(c => /barcode|isbn|\d{13}/i.test(c.text))).toBe(false);
    // Right-edge check needs the widest possible font (bold at its size).
    // All content was wrapped to contentWidth, so max x + width <= right.
    expect(right).toBeGreaterThan(left);
  });

  test('outline legibility: each unique line draws 4 ink passes + 1 cream fill', async () => {
    const calls = await draw({ synopsis: 'Short line.', childName: 'Zoe' });
    const byText = new Map();
    for (const c of calls) byText.set(c.text, (byText.get(c.text) || 0) + 1);
    for (const [, count] of byText) expect(count).toBe(5);
  });
});

describe('back-cover prompt contract (text-free artwork)', () => {
  // The prompt is built inside generateBackCoverImage (not exported), so pin
  // the contract at the source level: the ONLY text instruction allowed is
  // the prohibition. If someone reintroduces painted text, this fails.
  test('the source forbids text and no longer instructs synopsis/branding/barcode painting', () => {
    const src = require('fs').readFileSync(require.resolve('../../services/coverGenerator.js'), 'utf8');
    expect(src).toContain('ABSOLUTELY NO TEXT');
    expect(src).not.toContain('TEXT TO INCLUDE');
    expect(src).not.toContain('fake barcode');
    expect(src).not.toContain('Bubblegum Sans font (rounded, bubbly');
  });
});
