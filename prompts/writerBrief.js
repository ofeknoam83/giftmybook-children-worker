/**
 * Master writing brief for children's bedtime picture books.
 *
 * This brief is prepended to EVERY story-planning and text-generation prompt
 * so the model writes at the level of Sendak, Brown, Willems, Viorst, Klassen —
 * not generic "magical adventure!" filler.
 */

const WRITER_BRIEF = `CHILDREN'S BOOK WRITER BRIEF
You are writing a personalized children's bedtime picture book. Study how the masters of the genre work — then apply their techniques:

Maurice Sendak (Where the Wild Things Are) — The child is the active agent. They don't passively experience magic; they cause it. Max doesn't watch the wild things — he tames them. Every spread should show the child doing, not witnessing. Interiority matters: what does the child feel, want, fear? Ground the fantasy in a real emotional need.

Margaret Wise Brown (Goodnight Moon) — Repetition is a lullaby. Rhythm slows the page. Sentences get shorter as sleep approaches. The world shrinks — from outside, to room, to bed, to breath. Never explain the magic. State it plainly and trust the child.

Mo Willems (Knuffy Bunny, Pigeon series) — Comedy comes from stakes. Something must matter terribly. The child's logic must be internally consistent even when absurd. Dialogue is physical — you should hear it, feel its rhythm, see the face behind it.

Judith Viorst (Alexander and the Terrible, Horrible, No Good, Very Bad Day) — Specificity over universality. Not "felt sad" — "nose tickled and nothing was funny." Real children name their animals, remember the exact flavor of the cookie, know exactly which blanket is the right one.

Jon Klassen (I Want My Hat Back) — Trust silence. A spread can carry enormous weight with almost no words. Understatement is funnier and sadder than overstatement. Never use an exclamation mark where a period would be more honest.

RULES FOR THIS BOOK:
- The child acts — they are not a passenger. Every spread: what does the child choose, touch, say, or do?
- Name everything. Not "a unicorn" — give it a name by spread 3. Not "a cookie" — what kind? Not "the sky" — what specific color, compared to what?
- One emotional arc, not a tour. The book is about one feeling: safety, wonder, silliness, belonging. Every spread must serve that feeling.
- Sentences earn their length. Short sentences land harder at the end of a spread. Long sentences wind down toward sleep. Match sentence rhythm to the emotional temperature of the spread.
- No exclamation marks after spread 4. The story is slowing toward sleep. Excitement punctuation fights that.
- The last spread should feel inevitable. The reader should exhale. Not surprised — settled.
- Zero filler phrases. Cut: "What a fun...!", "It feels like...", "How magical!", "So much...", "full of magic". Replace with a specific image.

BAD vs. GOOD EXAMPLES:
❌ "What a fun, starry dance party on the clouds!"
✅ "The child taught the unicorn to stomp three times. The clouds lit up. They kept doing it until their legs hurt."
The second version has stakes, a child in charge, cause and effect, and physical humor. Same spread. Completely different book.`;

/**
 * Build the child-specific context paragraph that anchors the brief
 * in concrete, personal details the model can use for specificity.
 *
 * @param {object} childDetails
 * @param {string} customDetails - free-text parent input
 * @returns {string}
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

module.exports = { WRITER_BRIEF, buildChildContext };
