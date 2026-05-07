/**
 * Line-length window check (syllables + word count).
 *
 * Reads the band's `narrativeConstraints.syllablesPerLine` and
 * `wordsPerSpread` and enforces both. Syllable estimation is the
 * cheap-and-good-enough heuristic from v1 (vowel-cluster count with
 * silent-e adjustment). Off-by-one is fine; off-by-three is not.
 */

function estimateSyllables(word) {
  if (!word) return 0;
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  // Trailing silent e
  w = w.replace(/e$/, '');
  if (!w) return 1;
  const matches = w.match(/[aeiouy]+/g);
  return matches ? matches.length : 1;
}

function syllablesIn(line) {
  return line.split(/\s+/).filter(Boolean).reduce((s, w) => s + estimateSyllables(w), 0);
}

function wordsIn(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function lineLengthWindowCheck(draft, beat, ageProfile) {
  const text = String(draft?.text || '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const syl = ageProfile?.narrativeConstraints?.syllablesPerLine;
  const wps = ageProfile?.narrativeConstraints?.wordsPerSpread;
  const failures = [];

  if (syl) {
    for (let i = 0; i < lines.length; i += 1) {
      const s = syllablesIn(lines[i]);
      // Allow +/- 1 from min/max — syllable estimation is not perfect.
      if (s < (syl.min - 1) || s > (syl.max + 1)) {
        failures.push({ kind: 'syllables', line: i + 1, observed: s, window: [syl.min, syl.max], text: lines[i] });
      }
    }
  }

  if (wps) {
    const total = wordsIn(text);
    // Allow +/- 1 from min/max — matches the syllable-check tolerance and
    // keeps the revision loop from grinding on off-by-one overruns.
    if (total < (wps.min - 1) || total > (wps.max + 1)) {
      failures.push({ kind: 'words', observed: total, window: [wps.min, wps.max] });
    }
  }

  if (!failures.length) return { passed: true };
  return {
    passed: false,
    code: 'line_length_window',
    message: failures.map((f) =>
      f.kind === 'syllables'
        ? `L${f.line} has ~${f.observed} syllables; band target is ${f.window[0]}-${f.window[1]}. ${f.observed > f.window[1] ? 'Tighten' : 'Expand'}: "${f.text}"`
        : `Spread has ${f.observed} words; band target is ${f.window[0]}-${f.window[1]}.`
    ).join(' '),
    detail: failures,
  };
}

module.exports = { lineLengthWindowCheck, estimateSyllables, syllablesIn };
