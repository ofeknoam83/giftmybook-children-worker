'use strict';
// Bounded diagnostic: three new images, read-only access to the saved book.
// Encrypt all output before artifact upload: this repository is public.
const fs = require('fs');
const crypto = require('crypto');
const files = {};
const logs = [];
for (const name of ['log', 'warn', 'error', 'info']) console[name] = (...args) => logs.push(args.map(String).join(' '));
const { downloadBuffer } = require('../../services/gcsStorage');
const { createTypographyTemplate, chooseBookTextInk } = require('../../services/catalogEngine/illustrator/typographyGuide');
const { buildReferencePack, buildPromptBible } = require('../../services/catalogEngine/illustrator/bible');
const { buildScenePrompt, companionOnSpread } = require('../../services/catalogEngine/illustrator/scenes');
const { buildShotPlan, renderShotDirective } = require('../../services/catalogEngine/illustrator/shotPlan');
const { storyFingerprint } = require('../../services/catalogEngine/illustrator');
const { getBookForTag } = require('../../services/catalogEngine');
const { buildCharacterPrompt, buildReferenceParts, getNextApiKey, GEMINI_MODEL } = require('../../services/illustrationGenerator');
const { GEMINI_IMAGE_SAFETY_SETTINGS } = require('../../services/shared/illustration/config');
const save = (name, bytes) => { files[name] = Buffer.from(bytes).toString('base64'); };
async function main() {
  const bookId = process.env.PROBE_BOOK_ID;
  const imageModel = process.env.PROBE_IMAGE_MODEL || GEMINI_MODEL;
  if (!/^[a-f0-9-]{36}$/.test(bookId || '')) throw new Error('A source book UUID is required');
  const fixture = JSON.parse(process.env.PROBE_FIXTURE || '{}');
  const manifest = JSON.parse(await downloadBuffer(`children-jobs/${bookId}/reviewed-art.json`));
  const story = fixture.story;
  const profile = fixture.profile;
  const { book, theme, ageBand } = await getBookForTag(story.book_id, story.versions.catalog);
  const image = async url => ({ base64: (await downloadBuffer(url)).toString('base64'), mimeType: /\.jpe?g(?:\?|$)/i.test(url) ? 'image/jpeg' : 'image/png' });
  const refPhoto = await image(manifest.context.identity);
  const stored = manifest.bookBible;
  const bible = { theme, props: [], sheet: await image(stored.characterSheet.url), outfit: { outfit: stored.outfitSpec.text }, companion: { ...(await image(stored.companion.url)), key: stored.companion.name } };
  const shotPlan = buildShotPlan({ seedBasis: manifest.context.story, spreads: book.beats.map(b => b.spread), ageBand, textLayout: 'embedded' });
  const ink = await chooseBookTextInk(refPhoto);
  const results = [];
  for (const spread of [1, 5, 6]) {
    const text = story.spreads.find(s => s.spread === spread).text;
    const shot = shotPlan[spread];
    const template = await createTypographyTemplate({ childAge: profile.age, ink, text, side: shot.textSide });
    const companionPresent = companionOnSpread(book.beats.find(b => b.spread === spread), text, theme.companion, { theme, childName: profile.name });
    const { pack, refs } = buildReferencePack(bible, { refPhoto, propValues: [], companionOnSpread: companionPresent, typographyAnchor: template });
    const promptBible = buildPromptBible(bible, refs, { spread, declaredProps: [], carriedProps: [], companionOnSpread: companionPresent, characterDescription: manifest.context.characterDescription });
    const scene = buildScenePrompt({ book, theme, spread, spreadText: text, profile, evidence: story.personalization_evidence, embedText: true }) + '\n' + renderShotDirective(shot);
    const prompt = buildCharacterPrompt(scene, 'pixar_premium', profile.name, text, stored.outfitSpec.text, manifest.context.characterDescription, null, null, {
      embedText: true, isSpread: true, childAge: profile.age, spreadIndex: spread - 1, totalSpreads: 12,
      bookTextInk: ink, typographyTemplate: true, typographyRef: refs.typographyRef,
      textSide: shot.textSide, shotType: shot.shotType, bible: promptBible,
    });
    save(`spread-${spread}-template.png`, Buffer.from(template.base64, 'base64'));
    save(`spread-${spread}-prompt.txt`, prompt);
    save(`spread-${spread}-before.png`, await downloadBuffer(manifest.renderKeys[spread]));
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${imageModel}:generateContent?key=${getNextApiKey()}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(240000),
      body: JSON.stringify({ contents: [{ role: 'user', parts: buildReferenceParts(prompt, pack) }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '4K' } }, safetySettings: GEMINI_IMAGE_SAFETY_SETTINGS }),
    });
    if (!response.ok) throw new Error(`Gemini returned HTTP ${response.status}: ${await response.text()}`);
    const data = await response.json();
    const generated = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData;
    if (!generated) throw new Error(`No image returned for spread ${spread}: ${JSON.stringify(data)}`);
    save(`spread-${spread}-after.png`, Buffer.from(generated.data, 'base64'));
    results.push({ spread, model: imageModel, side: shot.textSide, templateCapHeight: template.capHeightPercent, ink, lines: template.lines, usage: data.usageMetadata });
  }
  save('results.json', JSON.stringify(results, null, 2));
}
main().catch(error => { save('error.txt', error.stack); process.exitCode = 1; }).finally(() => {
  save('log.txt', logs.join('\n'));
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(files)), cipher.final()]);
  const encryptedKey = crypto.publicEncrypt({ key: fs.readFileSync(__dirname + '/public.pem'), oaepHash: 'sha256' }, key);
  fs.mkdirSync('probe-output', { recursive: true });
  fs.writeFileSync('probe-output/encrypted.json', JSON.stringify({ key: encryptedKey.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
  process.stdout.write(process.exitCode ? 'Probe failed; encrypted diagnostic saved.\n' : 'Three renders completed; encrypted results saved.\n');
});
