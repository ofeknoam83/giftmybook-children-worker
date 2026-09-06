const { wrapSentenceLines, wrapStoryLines } = require('../../../services/shared/illustration/textBlock');

test('sentence boundaries survive quotes, decimals, titles, and existing paragraphs', () => {
  const text = 'Dr. Fox found 3.5 little bells. “Can we ring them now?” The bird nodded!\n\nThen the friends went back home.';
  const lines = wrapSentenceLines(text);
  expect(lines.filter(Boolean).join(' ')).toBe(text.replace(/\s+/g, ' '));
  expect(lines.some(l => l.startsWith('Dr. Fox'))).toBe(true);
  expect(lines).not.toContain('Dr.');
  expect(lines).toContain('“Can we ring them now?”');
  expect(lines).toContain('The bird nodded!');
  expect(lines).toContain('');
  expect(lines.at(-1)).toBe('Then the friends went back home.');
});

test.each([5, 6, 7, 10, 11, 12, 13, 14, 15, 18, 20, 21])('a %i-word sentence uses 5–7 word rows when they fit', count => {
  const text = Array.from({ length: count }, (_, i) => 'w' + i).join(' ') + '.';
  const lines = wrapSentenceLines(text);
  expect(lines.every(l => l.split(' ').length >= 5 && l.split(' ').length <= 7)).toBe(true);
  expect(lines.join(' ')).toBe(text);
});

test('short endings stay separate and long words never disappear or cross the word limit', () => {
  expect(wrapSentenceLines('One two three four five six seven eight. The end.')).toEqual([
    'One two three four five', 'six seven eight.', 'The end.',
  ]);
  const text = 'A supercalifragilisticexpialidocious friend wandered very far away.';
  const lines = wrapSentenceLines(text, 20);
  expect(lines.join(' ')).toBe(text);
  expect(lines).toContain('supercalifragilisticexpialidocious');
  expect(lines.every(l => l.length <= 20 || !l.includes(' '))).toBe(true);
  expect(wrapSentenceLines('')).toEqual([]);
});

test('ordinary wrapping is unchanged unless the sentence layout is explicitly requested', () => {
  const text = 'The fox ran. The bird flew.';
  expect(wrapStoryLines(text, 47)).toEqual([text]);
  expect(wrapStoryLines(text, 47, { sentenceStartsNewLine: true })).toEqual(['The fox ran.', 'The bird flew.']);
});
