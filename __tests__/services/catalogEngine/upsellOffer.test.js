process.env.GEMINI_API_KEY = 'test-key';
jest.mock('../../../services/gcsStorage', () => ({ downloadBuffer: jest.fn(), uploadBuffer: jest.fn() }));
jest.mock('../../../services/shared/llm/openaiClient', () => ({ callText: jest.fn(), LlmParseError: class extends Error {} }));
const sharp = require('sharp');
const Ajv = require('ajv/dist/2020');
const storage = require('../../../services/gcsStorage');
const { prepareOfferDefinition, loadOfferDefinition, offerMap } = require('../../../services/catalogEngine/upsellOffer');
const { buildStoryRequest, buildUserPrompt, generateStory } = require('../../../services/catalogEngine/writer');
const { callText } = require('../../../services/shared/llm/openaiClient');
const { resolveStory } = require('../../../services/catalogEngine/pipeline');
const { getBookForTag, catalogVersion } = require('../../../services/catalogEngine/catalog');
const sourceId = '0041ba89-5e7b-46b1-8586-a040296f3d17';
const coverPath = `children-jobs/${sourceId}/upsell/0/cover.png`;
const profile = { name: 'Ziv', age: 6, pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' }, object: 'teddy', trait: 'curious' };
let files;
let fetchSpy;
let outline;
beforeEach(async () => {
  jest.clearAllMocks();
  files = new Map([[coverPath, await sharp({ create: { width: 100, height: 100, channels: 3, background: '#789abc' } }).png().toBuffer()]]);
  storage.downloadBuffer.mockImplementation(async key => { if (!files.has(key)) throw new Error('not found'); return files.get(key); });
  storage.uploadBuffer.mockImplementation(async (bytes, key) => { files.set(key, bytes); });
  outline = { title: 'Ziv and Her Moonlit Treasure Map', premise: 'A moonlit map leads the child to a gentle discovery.', worldName: 'Moonlit Grove', companion: { name: 'Pip', type: 'firefly' },
    beats: Array.from({ length: 12 }, (_, i) => ({ spread: i + 1, beat: `Child follows the map with Pip through Moonlit Grove, step ${i + 1}.` })) };
  fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(outline) }] } }] }) }));
});
afterEach(() => fetchSpy.mockRestore());
const args = () => ({ sourceBookId: sourceId, coverIndex: 0, coverPath, profile, themeId: 'dream' });

test('an old printed cover gets its own pinned title, plot and world, without changing the fixed catalog', async () => {
  const priorTag = catalogVersion();
  const { hit, tag } = await prepareOfferDefinition(args());
  const built = buildStoryRequest({ bookId: hit.book.id, profile, sessionId: 'new-order', definition: hit, definitionTag: tag });
  expect(built.request.rendered_title).toBe(outline.title);
  expect(built.request.versions.catalog).toBe(tag);
  expect(built.request.profile.trait).toBe('curious');
  expect(built.map.book_id).toBe(hit.book.id);
  expect(await getBookForTag(hit.book.id, tag)).toEqual(hit);
  expect(catalogVersion()).toBe(priorTag);
  const prompt = buildUserPrompt({ ...built, theme: hit.theme });
  expect(prompt).toContain('Moonlit Grove');
  expect(prompt).not.toContain('Missing Star Marker');
  expect(hit.theme.theme_id).toBe('printed_upsell');
});

test('the exact offer definition is reused on retries without another model call', async () => {
  const first = await prepareOfferDefinition(args());
  const second = await prepareOfferDefinition(args());
  expect(second).toEqual(first);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test('a changed or missing snapshot cannot substitute a different story at print time', async () => {
  const { hit, tag } = await prepareOfferDefinition(args());
  expect(await loadOfferDefinition('another_book', tag)).toBeNull();
  const key = `children-upsell-definitions/${tag.slice('upsell-v1-'.length)}.json`;
  files.set(key, Buffer.from(JSON.stringify({ ...hit, book: { ...hit.book, premise: 'Changed' } })));
  expect(await getBookForTag(hit.book.id, tag)).toBeNull();
});

test('invalid outlines and changed advertised titles are rejected before writing a definition', async () => {
  outline.beats.pop();
  await expect(prepareOfferDefinition(args())).rejects.toThrow('valid story outline');
  expect(storage.uploadBuffer).not.toHaveBeenCalled();
  await expect(prepareOfferDefinition({ ...args(), title: 'The locked printed title' })).rejects.toThrow('changed the advertised title');
});

test.each(['https://attacker.example/photo.png', `children-jobs/${sourceId}/upsell/../photo.png`, 'children-jobs/other-child/upsell/0/cover.png'])('rejects arbitrary or cross-book image input: %s', async path => {
  await expect(prepareOfferDefinition({ ...args(), coverPath: path })).rejects.toThrow('Invalid printed cover reference');
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('the offer map obeys the existing personalization schema and the request retains age bounds', async () => {
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(require('../../../services/catalogEngine/data/schemas/personalization-map.schema.json'));
  expect(validate(offerMap(`upsell_${'a'.repeat(32)}`))).toBe(true);
  const { hit, tag } = await prepareOfferDefinition(args());
  expect(() => buildStoryRequest({ bookId: hit.book.id, profile: { ...profile, age: 3 }, definition: hit, definitionTag: tag })).toThrow('age band');
});

test('the normal writer validates the new story and the PDF pipeline replays that same pinned offer', async () => {
  const p = { name: profile.name, age: profile.age, pronouns: profile.pronouns };
  const { hit, tag } = await prepareOfferDefinition({ ...args(), profile: p });
  const params = { bookId: hit.book.id, profile: p, sessionId: 'upsell-session', requestId: 'req_offer_test', definition: hit, definitionTag: tag };
  const { request } = buildStoryRequest(params);
  const text = 'Ziv opened her moonlit map beside Pip in Moonlit Grove. A silver trail curved between the quiet trees. She checked the little marks, took one careful step, and smiled happily when the next gentle light appeared beside a smooth stone.';
  const response = { request_id: request.request_id, book_id: request.book_id, title: request.rendered_title, versions: request.versions,
    spreads: Array.from({ length: 12 }, (_, i) => ({ spread: i + 1, text })), personalization_evidence: [], omitted_profile_fields: [] };
  callText.mockResolvedValue({ json: response, usage: { inputTokens: 1, outputTokens: 1 } });
  const result = await generateStory(params);
  expect(result.response).toEqual(response);
  const replayed = await resolveStory({ storyPair: result, bookDefinitionId: hit.book.id, profile: p, log: jest.fn() });
  expect(replayed.response).toEqual(response);
  expect(replayed.generated).toBe(false);
  expect(callText).toHaveBeenCalledTimes(1);
});
