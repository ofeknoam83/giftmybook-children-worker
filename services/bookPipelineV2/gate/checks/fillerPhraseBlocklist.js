/**
 * Filler-phrase blocklist.
 *
 * Catches AA-CW-26's regression class: lines that end with phrases
 * existing only to fill meter, not meaning. 'Mama holds her at rest',
 * 'something something in light', 'all is bright by night'. The list
 * is in lexicons/fillerPhrases.json and is small — false positives are
 * worse than misses since the LLM critic also runs.
 */

const FILLER = require('../../lexicons/fillerPhrases.json');

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function endsWithAny(line, phrases) {
  const norm = normalize(line);
  return phrases.find((p) => norm === normalize(p) || norm.endsWith(' ' + normalize(p)));
}

function lineContainsAny(line, phrases) {
  const norm = ' ' + normalize(line) + ' ';
  return phrases.find((p) => norm.includes(' ' + normalize(p) + ' '));
}

function fillerPhraseBlocklistCheck(draft) {
  const text = draft?.text || '';
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const failures = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const endHit = endsWithAny(line, FILLER.endingPhrases);
    if (endHit) failures.push({ line: i + 1, kind: 'ending', phrase: endHit, text: line });
    const lineHit = lineContainsAny(line, FILLER.lineLevelFillers);
    if (lineHit) failures.push({ line: i + 1, kind: 'line', phrase: lineHit, text: line });
  }

  if (!failures.length) return { passed: true };
  return {
    passed: false,
    code: 'filler_phrase',
    message: failures.map((f) =>
      `L${f.line} ends with banned filler phrase '${f.phrase}': "${f.text}". Rewrite the line so the last words carry meaning, not meter.`
    ).join(' '),
    detail: failures,
  };
}

module.exports = { fillerPhraseBlocklistCheck };
