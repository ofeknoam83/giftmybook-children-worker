/**
 * Master writing brief for children's bedtime picture books.
 *
 * This brief is prepended to EVERY story-planning and text-generation prompt
 * so the model writes at the level of Sendak, Brown, Willems, Viorst, Klassen —
 * not generic "magical adventure!" filler.
 */

/**
 * Age-calibrated writing rules.
 * Vocabulary, sentence structure, and emotional complexity scale with the child's age.
 */
const AGE_PROFILES = {
  // Ages 1-2: Board book level
  toddler: {
    range: '1-2',
    wordsPerSpread: '4-10',
    totalWords: '32-80',
    vocabulary: 'Only words a 2-year-old hears daily. One-syllable preferred. No abstract concepts.',
    sentenceStyle: 'One short sentence per spread. Maximum 10 words. Rhythm and repetition are everything. Rhyme strongly encouraged.',
    emotionalRange: 'Comfort, surprise, silliness. No conflict. No fear. Pure sensory delight.',
    readAloudNote: 'A parent reads this aloud to a child who may not understand every word. The SOUND matters more than meaning. Plosives, repetition, onomatopoeia.',
    example: '"Ziv found the red ball. Bounce, bounce, bounce."',
  },
  // Ages 3-4: Classic picture book
  preschool: {
    range: '3-4',
    wordsPerSpread: '8-18',
    totalWords: '64-144',
    vocabulary: 'Simple concrete words. One or two new/fancy words per book (the child asks "what does that mean?" and the parent explains — this is a feature, not a bug). No idioms.',
    sentenceStyle: 'One to two sentences. Present tense. Short declarative sentences with occasional compound sentences joined by "and" or "but." Light rhyme or rhythm throughout.',
    emotionalRange: 'Wonder, bravery, silliness, comfort, belonging. Small problems with clear resolutions. The child always wins.',
    readAloudNote: 'Read aloud at bedtime. Sentences must feel good in the mouth. Test every line: would a tired parent enjoy reading this for the 40th time?',
    example: '"Ziv climbed onto the rocking horse. It rocked once, twice — then lifted off the rug."',
  },
  // Ages 5-6: Confident reader listener
  earlyKid: {
    range: '5-6',
    wordsPerSpread: '12-25',
    totalWords: '96-200',
    vocabulary: 'Richer vocabulary. Can handle words like "enormous," "whispered," "glistening." One vivid adjective per scene. Similes welcome ("quiet as a stone").',
    sentenceStyle: 'Two to three sentences. Mix short punchy sentences with one longer flowing sentence. Dialogue encouraged — the child can SPEAK in the story.',
    emotionalRange: 'Courage, curiosity, determination, tenderness, wonder. The child can face a real (small) challenge and overcome it through cleverness or kindness.',
    readAloudNote: 'The child may follow along with the text. Sentences should reward attention — a funny word, an unexpected turn, a satisfying sound.',
    example: '"Ziv whispered the secret word. The door didn\'t move. Ziv said it louder. The hinges groaned, and moonlight poured in like spilled milk."',
  },
  // Ages 7-8: Transitional reader
  olderKid: {
    range: '7-8',
    wordsPerSpread: '20-40',
    totalWords: '160-320',
    vocabulary: 'Full vocabulary for the age. Metaphor, humor, wordplay. The child can appreciate irony and understatement.',
    sentenceStyle: 'Three to four sentences with varied structure. Complex sentences welcome. Interior monologue (what the child thinks/feels) adds depth.',
    emotionalRange: 'Full range — determination, doubt, humor, quiet sadness, triumph, belonging. The story can have genuine tension that resolves satisfyingly.',
    readAloudNote: 'May be read independently or aloud. Text carries more narrative weight since the reader processes it, not just absorbs the rhythm.',
    example: '"Ziv had been walking for what felt like an hour but was probably four minutes. The forest didn\'t care about time. Neither did the fox, who sat on a stump and watched Ziv trip over the same root twice."',
  },
};

function getAgeProfile(age) {
  const a = Number(age) || 5;
  if (a <= 2) return AGE_PROFILES.toddler;
  if (a <= 4) return AGE_PROFILES.preschool;
  if (a <= 6) return AGE_PROFILES.earlyKid;
  return AGE_PROFILES.olderKid;
}

function buildWriterBrief(age) {
  const profile = getAgeProfile(age);

  return `CHILDREN'S BOOK WRITER BRIEF
You are writing a personalized children's bedtime picture book for a child aged ${age}. Study how the masters of the genre work — then apply their techniques:

Maurice Sendak (Where the Wild Things Are) — The child is the active agent. They don't passively experience magic; they cause it. Max doesn't watch the wild things — he tames them. Every spread should show the child doing, not witnessing. Interiority matters: what does the child feel, want, fear? Ground the fantasy in a real emotional need.

Margaret Wise Brown (Goodnight Moon) — Repetition is a lullaby. Rhythm slows the page. Sentences get shorter as sleep approaches. The world shrinks — from outside, to room, to bed, to breath. Never explain the magic. State it plainly and trust the child.

Mo Willems (Knuffle Bunny, Pigeon series) — Comedy comes from stakes. Something must matter terribly. The child's logic must be internally consistent even when absurd. Dialogue is physical — you should hear it, feel its rhythm, see the face behind it.

Judith Viorst (Alexander and the Terrible, Horrible, No Good, Very Bad Day) — Specificity over universality. Not "felt sad" — "nose tickled and nothing was funny." Real children name their animals, remember the exact flavor of the cookie, know exactly which blanket is the right one.

Jon Klassen (I Want My Hat Back) — Trust silence. A spread can carry enormous weight with almost no words. Understatement is funnier and sadder than overstatement. Never use an exclamation mark where a period would be more honest.

AGE-CALIBRATED RULES (this child is ${age} years old, age group ${profile.range}):
- VOCABULARY: ${profile.vocabulary}
- SENTENCE STYLE: ${profile.sentenceStyle}
- EMOTIONAL RANGE: ${profile.emotionalRange}
- READ-ALOUD NOTE: ${profile.readAloudNote}
- WORDS PER SPREAD: ${profile.wordsPerSpread}
- TOTAL WORDS (all spreads combined): ${profile.totalWords}
- EXAMPLE of the right level: ${profile.example}

RULES FOR THIS BOOK:
- The child acts — they are not a passenger. But don't start every sentence with the child's name. Vary openings: setting, sound, sensation, dialogue, an object. Use the name only 3-4 times across all spreads.
- Go deeper than action. Show what the child FEELS, NOTICES, WANTS. Sensory details: temperature, texture, smell, sound. "The saddle leather was cold against bare knees" is better than "Ziv sat on the saddle."
- Name everything. Not "a unicorn" — give it a name by spread 2. Not "a cookie" — what kind? Not "the sky" — what specific color, compared to what?
- One emotional arc, not a tour. The book is about one feeling: safety, wonder, silliness, belonging. Every spread must serve that feeling.
- Include at least one moment of dialogue — the child speaks, whispers, or asks a question. A companion can answer.
- Every spread needs ONE specific, surprising detail. Not "the trees were tall" — "the bark felt like cold toast under their fingers."
- Sentences earn their length. Short sentences land harder at the end of a spread. Long sentences wind down toward sleep.
- No exclamation marks after spread 4. The story is slowing toward sleep.
- The last spread should feel inevitable. The reader should exhale. Not surprised — settled. Not a summary — a single quiet image.
- Zero filler phrases. Cut: "What a fun...!", "It feels like...", "How magical!", "So much...", "full of magic", "special adventure".

BAD vs. GOOD EXAMPLES:
❌ "Ziv rode the horse. Ziv felt happy. Ziv saw the stars."
✅ "The saddle creaked. Cold air tasted like pine needles. 'Are we close?' Ziv whispered. Spark flicked one ear back — which meant yes."
The second version has sensory detail, dialogue, character, and varied sentence openings. Same scene. Completely different quality.`;
}

// Keep the static WRITER_BRIEF for backward compat (defaults to age 5)
const WRITER_BRIEF = buildWriterBrief(5);

/**
 * Build the child-specific context paragraph that anchors the brief
 * in concrete, personal details the model can use for specificity.
 */
function buildChildContext(childDetails, customDetails) {
  const name = childDetails.childName || childDetails.name || 'the child';
  const age = childDetails.childAge || childDetails.age || 5;
  const gender = childDetails.childGender || childDetails.gender || 'child';
  const interests = (childDetails.childInterests || []).filter(Boolean);

  const parts = [`${name}, age ${age}`];
  if (gender && gender !== 'neutral' && gender !== 'not specified') {
    parts.push(gender === 'male' ? 'boy' : gender === 'female' ? 'girl' : gender);
  }
  if (interests.length) parts.push(`loves ${interests.join(', ')}`);
  if (customDetails) parts.push(customDetails);

  return `CHILD DETAILS (use these for the specificity rules): ${parts.join('. ')}.`;
}

module.exports = { WRITER_BRIEF, buildWriterBrief, buildChildContext, getAgeProfile, AGE_PROFILES };
