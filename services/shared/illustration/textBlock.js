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
function wrapStoryLines(text, maxChars = 30) {
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
  const lines = wrapStoryLines(text, r.maxCharsPerLine || 30);
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

module.exports = { wrapStoryLines, expectedTextBlock };
