/**
 * sanitize.js — deterministic text cleanup for Writer V2 output.
 *
 * Catches non-Latin characters that LLMs occasionally mix into English text,
 * producing broken strings (e.g. "полосhed" instead of "polished").
 *
 * Two-pass approach:
 *  1. Replace visual homoglyphs (Cyrillic/Greek chars that look like Latin)
 *  2. Transliterate any remaining Cyrillic chars by phonetic mapping
 */

// Cyrillic → Latin: visual homoglyphs (look identical to Latin letters)
const CYRILLIC_HOMOGLYPHS = {
  '\u0410': 'A', '\u0430': 'a', // А/а
  '\u0412': 'B',                 // В (uppercase looks like B)
  '\u0421': 'C', '\u0441': 'c', // С/с
  '\u0415': 'E', '\u0435': 'e', // Е/е
  '\u041D': 'H', '\u043D': 'h', // Н/н
  '\u041A': 'K', '\u043A': 'k', // К/к
  '\u041C': 'M', '\u043C': 'm', // М/м
  '\u041E': 'O', '\u043E': 'o', // О/о
  '\u0420': 'P', '\u0440': 'p', // Р/р
  '\u0422': 'T', '\u0442': 't', // Т/т
  '\u0423': 'Y', '\u0443': 'y', // У/у
  '\u0425': 'X', '\u0445': 'x', // Х/х
  '\u0406': 'I', '\u0456': 'i', // І/і (Ukrainian)
  '\u0408': 'J', '\u0458': 'j', // Ј/ј (Serbian)
  '\u0405': 'S', '\u0455': 's', // Ѕ/ѕ (Macedonian)
  '\u04BB': 'h',                 // һ (Bashkir)
};

// Cyrillic → Latin: phonetic transliteration for non-homoglyph characters.
// Used as fallback when Cyrillic chars remain after homoglyph replacement.
const CYRILLIC_TRANSLITERATE = {
  '\u0411': 'B',  '\u0431': 'b',  // Б/б
  '\u0432': 'v',                    // в (lowercase of В)
  '\u0413': 'G',  '\u0433': 'g',  // Г/г
  '\u0414': 'D',  '\u0434': 'd',  // Д/д
  '\u0416': 'Zh', '\u0436': 'zh', // Ж/ж
  '\u0417': 'Z',  '\u0437': 'z',  // З/з
  '\u0418': 'I',  '\u0438': 'i',  // И/и
  '\u0419': 'Y',  '\u0439': 'y',  // Й/й
  '\u041B': 'L',  '\u043B': 'l',  // Л/л
  '\u041F': 'P',  '\u043F': 'p',  // П/п
  '\u0424': 'F',  '\u0444': 'f',  // Ф/ф
  '\u0426': 'Ts', '\u0446': 'ts', // Ц/ц
  '\u0427': 'Ch', '\u0447': 'ch', // Ч/ч
  '\u0428': 'Sh', '\u0448': 'sh', // Ш/ш
  '\u0429': 'Sh', '\u0449': 'sh', // Щ/щ
  '\u042A': '',   '\u044A': '',    // Ъ/ъ (hard sign — silent)
  '\u042B': 'Y',  '\u044B': 'y',  // Ы/ы
  '\u042C': '',   '\u044C': '',    // Ь/ь (soft sign — silent)
  '\u042D': 'E',  '\u044D': 'e',  // Э/э
  '\u042E': 'Yu', '\u044E': 'yu', // Ю/ю
  '\u042F': 'Ya', '\u044F': 'ya', // Я/я
  '\u0401': 'Yo', '\u0451': 'yo', // Ё/ё
};

// Greek → Latin: visual homoglyphs
const GREEK_HOMOGLYPHS = {
  '\u0391': 'A', '\u03B1': 'a', // Α/α
  '\u0392': 'B', '\u03B2': 'b', // Β/β
  '\u0395': 'E', '\u03B5': 'e', // Ε/ε
  '\u0397': 'H', '\u03B7': 'n', // Η/η
  '\u0399': 'I', '\u03B9': 'i', // Ι/ι
  '\u039A': 'K', '\u03BA': 'k', // Κ/κ
  '\u039C': 'M',                  // Μ
  '\u039D': 'N',                  // Ν
  '\u039F': 'O', '\u03BF': 'o', // Ο/ο
  '\u03A1': 'P', '\u03C1': 'p', // Ρ/ρ
  '\u03A4': 'T', '\u03C4': 't', // Τ/τ
  '\u03A5': 'Y', '\u03C5': 'y', // Υ/υ
  '\u03A7': 'X', '\u03C7': 'x', // Χ/χ
  '\u03A9': 'O',                  // Ω
};

const FULL_MAP = {
  ...CYRILLIC_HOMOGLYPHS,
  ...CYRILLIC_TRANSLITERATE,
  ...GREEK_HOMOGLYPHS,
};

const REPLACE_REGEX = new RegExp(
  '[' + Object.keys(FULL_MAP).join('') + ']',
  'g',
);

/**
 * Replace non-Latin characters with their ASCII equivalents.
 * Designed for English children's book text where any Cyrillic/Greek
 * character is almost certainly an LLM generation artifact.
 *
 * @param {Array<{ spread: number, text: string }>} spreads
 * @param {string} [bookId] - optional, for log context
 * @returns {number} count of characters replaced
 */
function sanitizeNonLatinChars(spreads, bookId) {
  let totalReplaced = 0;

  for (const s of spreads) {
    if (!s.text) continue;
    const before = s.text;
    let replaced = 0;
    s.text = s.text.replace(REPLACE_REGEX, (ch) => {
      replaced++;
      return FULL_MAP[ch] || ch;
    });
    if (replaced > 0) {
      totalReplaced += replaced;
      console.warn(
        `[writerV2/sanitize] Spread ${s.spread}: replaced ${replaced} non-Latin char(s)` +
        (bookId ? ` (book ${bookId})` : '') +
        ` | "${before.replace(/\n/g, ' ').substring(0, 120)}" → "${s.text.replace(/\n/g, ' ').substring(0, 120)}"`,
      );
    }
  }

  if (totalReplaced > 0) {
    console.warn(
      `[writerV2/sanitize] Total: ${totalReplaced} non-Latin character(s) replaced across ${spreads.length} spreads`,
    );
  }

  return totalReplaced;
}

module.exports = { sanitizeNonLatinChars };
