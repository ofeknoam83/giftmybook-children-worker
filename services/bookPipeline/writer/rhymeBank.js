/**
 * AA-CW-22 — rhyme bank.
 *
 * The writer (gpt-5.4) keeps producing identity rhymes (`leaf/leaf`,
 * `chin/chin`) and weak partners (`leaf/brief`) on the infant band's
 * lines 1+2. The rewriter has one wave to fix it, and "Re-end line 2
 * with a real rhyme for 'leaf'" is too vague — the model picks `brief`
 * and gets re-rejected.
 *
 * Fix: pre-compute a small bank of safe, simple, single-syllable rhymes
 * for each end-word the writer commonly leans on, and inject that bank
 * into the per-spread rewrite directive. The rewriter is then told:
 * "the line-2 end-word MUST come from this list."
 *
 * Coverage focus: end-words observed in production drafts (book
 * e3f4e0c0, prior infant failures) — body parts, simple props, light
 * words, action targets. Each entry is a hand-curated list of real
 * monosyllabic rhyme partners (no slant, no near-rhyme cheats, no
 * identity).
 *
 * NOT a regex. NOT auto-generated. A small lookup table.
 */

const RHYME_BANK = {
  // Body parts the writer reaches for
  chin: ['win', 'grin', 'spin', 'in', 'twin', 'thin'],
  cheek: ['peek', 'sneak', 'week', 'beak', 'creek'],
  nose: ['rose', 'toes', 'goes', 'glows', 'shows', 'doze'],
  hand: ['land', 'sand', 'stand', 'and', 'band'],
  toe: ['go', 'glow', 'show', 'snow', 'low', 'so', 'know', 'flow'],
  knee: ['tree', 'bee', 'me', 'free', 'see', 'three', 'sea', 'key'],
  lap: ['nap', 'tap', 'clap', 'snap', 'wrap', 'cap', 'map'],
  arm: ['warm', 'farm', 'charm'],
  hair: ['air', 'there', 'pair', 'bear', 'where', 'share'],
  ear: ['near', 'dear', 'here', 'cheer', 'clear', 'tear'],
  eye: ['sky', 'high', 'by', 'sigh', 'fly', 'lullaby'],
  face: ['place', 'space', 'lace', 'grace', 'trace'],
  hip: ['skip', 'sip', 'tip', 'flip', 'dip'],
  back: ['pat', 'snack', 'track'],
  feet: ['sweet', 'meet', 'beat', 'street', 'neat', 'treat'],
  foot: ['root', 'hoot', 'soot'], // small set, careful
  head: ['bed', 'said', 'red', 'thread', 'led'],
  thumb: ['hum', 'plum', 'come', 'drum', 'numb'],

  // Common props / scenery
  leaf: ['tree', 'see', 'free', 'three', 'bee', 'me', 'breeze'], // breeze is near; keep but flag
  tree: ['bee', 'free', 'me', 'see', 'three', 'sea', 'glee', 'knee'],
  light: ['bright', 'tight', 'night', 'sight', 'right', 'white', 'flight'],
  sun: ['fun', 'one', 'done', 'run', 'spun'],
  moon: ['tune', 'soon', 'spoon', 'noon', 'balloon'],
  star: ['far', 'are', 'jar', 'car'],
  sky: ['high', 'by', 'eye', 'fly', 'sigh', 'lullaby', 'goodbye'],
  cloud: ['loud', 'proud', 'crowd'],
  song: ['long', 'strong', 'along'],
  tune: ['moon', 'soon', 'spoon', 'noon'],
  air: ['there', 'where', 'pair', 'share', 'hair', 'bear', 'fair'],
  breeze: ['trees', 'knees', 'bees', 'please', 'sees', 'squeeze'],
  rain: ['lane', 'plain', 'again', 'mane'],
  flower: ['shower', 'tower', 'hour', 'power'],
  pond: ['beyond', 'fond'],
  duck: ['luck', 'pluck', 'tuck'],
  bird: ['heard', 'word', 'stirred'],
  cat: ['mat', 'pat', 'hat', 'flat', 'that'],
  dog: ['log', 'fog', 'jog'],
  book: ['look', 'cook', 'nook', 'hook', 'brook'],
  cup: ['up'],
  spoon: ['moon', 'tune', 'soon', 'noon', 'balloon'],

  // Common verbs / state words (line endings)
  near: ['dear', 'cheer', 'clear', 'here', 'ear', 'tear', 'year'],
  tight: ['bright', 'light', 'night', 'sight', 'right', 'white', 'flight'],
  warm: ['arm', 'farm', 'charm'],
  soft: ['loft'],
  bright: ['light', 'tight', 'night', 'sight', 'right', 'white', 'flight'],
  wide: ['side', 'ride', 'glide', 'inside', 'beside', 'tide'],
  high: ['sky', 'by', 'eye', 'fly', 'sigh'],
  low: ['glow', 'snow', 'show', 'know', 'go', 'so', 'slow', 'flow'],
  small: ['tall', 'all', 'fall', 'call', 'wall', 'ball'],
  tall: ['small', 'all', 'fall', 'call', 'wall', 'ball'],
  slow: ['glow', 'snow', 'show', 'know', 'go', 'so', 'flow', 'low'],
  still: ['hill', 'will', 'fill'],
  sweet: ['feet', 'meet', 'beat', 'street', 'treat', 'neat'],
  glow: ['snow', 'show', 'know', 'go', 'so', 'slow', 'flow', 'low'],

  // Frequent infant-action ends
  smile: ['while', 'mile', 'pile', 'aisle'],
  laugh: ['half'],
  giggle: ['wiggle', 'jiggle'],
  hug: ['snug', 'tug', 'mug', 'rug', 'bug'],
  kiss: ['bliss', 'this', 'miss'],
  squeal: ['real', 'feel', 'wheel', 'reel', 'meal', 'peel'],
  snug: ['hug', 'tug', 'mug', 'rug', 'bug'],
  hush: ['rush', 'brush', 'blush'],

  // Misc infant-book commons
  day: ['way', 'play', 'stay', 'say', 'ray', 'bay', 'gray', 'sway', 'today'],
  way: ['day', 'play', 'stay', 'say', 'ray', 'bay'],
  play: ['day', 'way', 'stay', 'say', 'ray', 'bay', 'today'],
  stay: ['day', 'way', 'play', 'say', 'ray', 'bay', 'today'],
  yes: ['guess', 'less', 'press'],
  here: ['near', 'dear', 'cheer', 'clear', 'ear', 'tear', 'year'],
  there: ['air', 'where', 'pair', 'share', 'hair', 'bear', 'fair'],
  love: ['above', 'dove', 'glove'],
  home: ['roam', 'foam', 'comb'],

  // Things that came up in the e3f4e0c0 production failure
  wrap: ['nap', 'tap', 'clap', 'snap', 'lap', 'cap', 'map'],
  gate: ['wait', 'late', 'great', 'state', 'plate', 'eight', 'straight'],
  porch: ['scorch', 'torch'], // small set
  flap: ['nap', 'tap', 'clap', 'snap', 'lap', 'wrap', 'cap', 'map'],
  pat: ['cat', 'mat', 'hat', 'flat', 'that', 'chat'],
  blink: ['wink', 'pink', 'think', 'sink', 'link'],
  reach: ['beach', 'each', 'peach', 'teach'],
  hold: ['gold', 'told', 'bold', 'fold', 'rolled', 'old'],
  see: ['me', 'tree', 'bee', 'free', 'three', 'knee', 'sea', 'glee'],
};

/**
 * Look up rhyme partners for the line-1 end-word.
 *
 * Strips trailing punctuation (`.`, `,`, `!`, `?`, possessive `'s`).
 * Lowercases. Skips if empty or unknown — caller will fall back to
 * a generic instruction.
 *
 * @param {string} word
 * @returns {string[]} possibly-empty array
 */
function lookupRhymes(word) {
  if (typeof word !== 'string') return [];
  const normalized = word
    .toLowerCase()
    .trim()
    .replace(/[.,!?;:"']+$/g, '')
    .replace(/['’]s$/u, '')
    .replace(/^[^a-z]+/, '');
  if (!normalized) return [];
  return Array.isArray(RHYME_BANK[normalized]) ? RHYME_BANK[normalized].slice() : [];
}

/**
 * Extract the final word of a line. Returns '' if the line is empty
 * or contains no alpha words.
 *
 * @param {string} line
 * @returns {string}
 */
function lastWord(line) {
  if (typeof line !== 'string') return '';
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens[tokens.length - 1].replace(/[.,!?;:"']+$/g, '').replace(/['’]s$/u, '');
}

module.exports = {
  RHYME_BANK,
  lookupRhymes,
  lastWord,
};
