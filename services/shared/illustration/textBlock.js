/**
 * Embedded-text geometry shared by the renderer (the prompt) and the
 * illustrator's QA (the ruler): the pre-wrapped lines and the FOOTPRINT of
 * the block at the book's fixed size. Pure — no model, no I/O.
 */

'use strict';

const { TEXT_RULES } = require('./config');

/**
 * Pre-wrap a spread's manuscript into short painted lines (ce-13).
 *
 * Left to itself the image model breaks lines at 7–9 words in a caption-size
 * face — exactly how a text block grew to 55% of the width and across the
 * page fold. Handing it the breaks makes the narrow column achievable: at
 * the pinned small body size ~30 characters span about a fifth of a 16:9
 * canvas. Paragraph breaks are kept as an empty line; each paragraph is
 * wrapped greedily and then re-flowed to balanced widths (a typeset block,
 * not one long line and one orphan word); a word longer than the limit
 * stands alone. Pure — exported for tests.
 * @param {string} text the spread's manuscript text
 * @param {number} [maxChars] characters per line including spaces
 * @returns {string[]} lines ('' marks a paragraph gap)
 */
function wrapStoryLines(text, maxChars = 30, options = {}) {
  if (options.sentenceStartsNewLine) return wrapSentenceLines(text, maxChars, options);
  const limit = Math.max(8, Number(maxChars) || 30);
  const greedy = (words, width) => {
    const out = [];
    let current = '';
    for (const word of words) {
      if (!current) { current = word; continue; }
      if (current.length + 1 + word.length <= width) current = `${current} ${word}`;
      else { out.push(current); current = word; }
    }
    if (current) out.push(current);
    return out;
  };
  const paragraphs = String(text || '').replace(/\r/g, '').trim().split(/\n\s*\n|\n/).map(p => p.trim()).filter(Boolean);
  const lines = [];
  paragraphs.forEach((para, i) => {
    if (i > 0) lines.push('');
    const words = para.split(/\s+/);
    const first = greedy(words, limit);
    if (first.length <= 1) { lines.push(...first); return; }
    // Balance: aim every line at the paragraph's average width, never above
    // the limit and never below the longest word — then keep whichever pass
    // gives the fewer lines (balancing must not add rows).
    const longest = Math.max(...words.map(w => w.length));
    const target = Math.min(limit, Math.max(longest, Math.ceil(para.length / first.length)));
    const balanced = greedy(words, target);
    lines.push(...(balanced.length <= first.length ? balanced : first));
  });
  return lines;
}

/**
 * Sentence-led read-aloud lines. Target 5–7 words without joining sentences
 * or changing their text. Short sentences/endings and width-limited lines
 * may be shorter. The character limit keeps the fixed type inside its column.
 */
function wrapSentenceLines(text, maxChars = 47, options = {}) {
  const maxWords = Math.max(1, Math.min(7, Number(options.maxWordsPerLine) || 7));
  const minWords = Math.min(maxWords, Number(options.minWordsPerLine) || 5);
  const width = Math.max(8, Number(maxChars) || 47);
  const paragraphs = String(text || '').replace(/\r/g, '').trim().split(/\n\s*\n|\n/).map(p => p.trim()).filter(Boolean);
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const lines = [];
  paragraphs.forEach((paragraph, paragraphIndex) => {
    if (paragraphIndex) lines.push('');
    const sentences = [];
    for (const { segment } of segmenter.segment(paragraph)) {
      const previous = sentences[sentences.length - 1];
      // A title/initial's period is not the end of a sentence. Decimal
      // points and closing quotation marks are handled by Intl.Segmenter.
      if (previous && /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr)|\b[A-Z])\.$/i.test(previous)) {
        sentences[sentences.length - 1] += ' ' + segment.trim();
      } else sentences.push(segment.trim());
    }
    for (const sentence of sentences) {
      if (options.blankLineBetweenSentences && lines.length && lines.at(-1) !== '') lines.push('');
      const words = sentence.split(/\s+/);
      const best = Array(words.length + 1);
      best[words.length] = { cost: 0, lines: [] };
      for (let i = words.length - 1; i >= 0; i--) {
        let line = '';
        for (let count = 1; count <= maxWords && i + count <= words.length; count++) {
          line += (count === 1 ? '' : ' ') + words[i + count - 1];
          // An overlong word stays intact on its own line.
          if (count > 1 && line.length > width) break;
          const end = i + count === words.length;
          const shortage = Math.max(0, minWords - count);
          const cost = 1 + (count - 6) ** 2 + shortage ** 2 * (end ? 4 : 100) + best[i + count].cost;
          if (!best[i] || cost < best[i].cost) best[i] = { cost, lines: [line, ...best[i + count].lines] };
        }
      }
      lines.push(...best[0].lines);
    }
  });
  return lines;
}

/**
 * ce-15: the FOOTPRINT of a spread's text block at the book's fixed size —
 * the numbers the prompt states ("this block is about X% of the image
 * width wide and Y% of its height tall") and the QA ruler holds the
 * painted block to. A percentage of the image height is not something an
 * image model perceives; the width of ITS OWN block is, and for a known
 * character count the width pins the size. Paragraph gaps count as one
 * row of pitch. Pure — exported for tests.
 * @param {string} text the spread's manuscript text
 * @param {object} [rules] TEXT_RULES or a tier from resolvePictureBookTextRules
 * @returns {{lines: string[], lineCount: number, widestChars: number, widthPercent: number, heightPercent: number}}
 */
function expectedTextBlock(text, rules = TEXT_RULES) {
  const r = rules || TEXT_RULES;
  const lines = wrapStoryLines(text, r.maxCharsPerLine || 30, r);
  const widestChars = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const lineCount = lines.length;
  const charW = Number.isFinite(r.charWidthPercent) ? r.charWidthPercent : TEXT_RULES.charWidthPercent;
  const pitch = Number.isFinite(r.linePitchPercent) ? r.linePitchPercent : TEXT_RULES.linePitchPercent;
  return {
    lines,
    lineCount,
    widestChars,
    widthPercent: Math.round(widestChars * charW * 10) / 10,
    heightPercent: Math.round(lineCount * pitch * 10) / 10,
  };
}

module.exports = { wrapStoryLines, wrapSentenceLines, expectedTextBlock };
