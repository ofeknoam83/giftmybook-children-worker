'use strict';
// Synthetic lettering only. No customer book reads/writes or image generation.
const fs = require('fs'), crypto = require('crypto'), sharp = require('sharp');
const fontkit = require('@pdf-lib/fontkit');
const records = [];
for (const name of ['log', 'warn', 'error', 'info']) console[name] = (...args) => records.push(args.map(String).join(' '));
const { verifyImageText } = require('../../services/illustrationGenerator');
const font = fontkit.create(fs.readFileSync(__dirname + '/../../fonts/PlayfairDisplay.ttf'));
const files = {};
async function imageFor(text) {
  const height = 1200, width = 2100, fontScale = (1200 * 0.01425) / (font.glyphForCodePoint(72).bbox.maxY - font.glyphForCodePoint(72).bbox.minY);
  const paths = [];
  for (const [i, line] of [text, 'The fox listened to the little bird.', 'Then they walked home together.'].entries()) {
    let x = 1250;
    const run = font.layout(line);
    run.glyphs.forEach((glyph, j) => {
      const p = run.positions[j];
      paths.push(`<path d="${glyph.path.toSVG()}" transform="translate(${x + p.xOffset * fontScale} ${280 + i * 90 - p.yOffset * fontScale}) scale(${fontScale} ${-fontScale})" fill="#FFF4DE"/>`);
      x += p.xAdvance * fontScale;
    });
  }
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="bg"><stop stop-color="#193b39"/><stop offset="1" stop-color="#263231"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#bg)"/>${paths.join('')}</svg>`)).png().toBuffer();
}
async function main() {
  const tail = ' The fox listened to the little bird. Then they walked home together.';
  const samples = [
    { key: 'correct', painted: 'Silver leaves whispered softly.', expected: 'Silver leaves whispered softly.', want: 'verified' },
    { key: 'one-wrong-letter', painted: 'Siiver leaves whispered softly.', expected: 'Silver leaves whispered softly.', want: 'mismatch' },
    { key: 'missing-word', painted: 'Silver whispered softly.', expected: 'Silver leaves whispered softly.', want: 'mismatch' },
    { key: 'reordered-words', painted: 'Leaves silver whispered softly.', expected: 'Silver leaves whispered softly.', want: 'mismatch' },
  ];
  const results = [];
  for (const s of samples) {
    const bytes = await imageFor(s.painted);
    files[s.key + '.png'] = bytes.toString('base64');
    const result = await verifyImageText(bytes, s.expected + tail);
    results.push({ sample: s.key, want: s.want, result });
  }
  files['results.json'] = Buffer.from(JSON.stringify(results, null, 2)).toString('base64');
  if (results.some(r => r.result.status !== r.want)) process.exitCode = 1;
}
main().catch(e => { files['error.txt'] = Buffer.from(e.stack).toString('base64'); process.exitCode = 1; }).finally(() => {
  files['logs.txt'] = Buffer.from(records.join('\n')).toString('base64');
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(files)), cipher.final()]);
  const encryptedKey = crypto.publicEncrypt({ key: fs.readFileSync(__dirname + '/public.pem'), oaepHash: 'sha256' }, key);
  fs.mkdirSync('spelling-probe-output', { recursive: true });
  fs.writeFileSync('spelling-probe-output/encrypted.json', JSON.stringify({ key: encryptedKey.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
  process.stdout.write('Synthetic spelling checks finished; encrypted report saved.\n');
});
