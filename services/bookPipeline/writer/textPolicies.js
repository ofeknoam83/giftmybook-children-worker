/**
 * Writer text policies per age band and format.
 *
 * Encodes the non-negotiable style choices from the rewrite plan:
 * musical-but-simple sentences, no large metaphors, low repetition,
 * third-person by default, funny/playful tone, light dialogue, implicit
 * emotional meaning, rhyme by default for picture books.
 */

const { FORMATS, AGE_BANDS, RHYME_POLICY, TEXT_LINE_TARGET, WORDS_PER_LINE_TARGET } = require('../constants');

/**
 * @param {string} ageBand
 * @returns {{ maxSyllableTarget: number, voice: string, vocabulary: string }}
 */
function ageRules(ageBand) {
  switch (ageBand) {
    case AGE_BANDS.PB_INFANT:
      return {
        maxSyllableTarget: 2,
        voice: 'Tiny musical observations — the book is read TO a baby by the parent, so write FOR the parent reading aloud. THE BABY IS THE STILL POINT: the baby is held, carried, or seated; the WORLD moves around them — light shifts, cloth flutters, Mama leans in, a leaf drifts past, music sways through the air. The baby watches, reaches, smiles, snuggles, points; the baby never walks, runs, climbs, dances, jumps, hops, twirls, marches, skips, bounces, or leads anyone anywhere. 2 short, complete sentences per spread, ~2-4 words each. NO conflict, NO plot stakes, NO dialogue — sensory observation only. Cadence: "[Name] sees [thing]. [Mama/Dada] is near." Soft, warm, sing-song.',
        vocabulary: 'Words a baby hears daily: Mama, Dada, hand, light, soft, warm, smile, hug, see, look, up, down, big, little, sky, moon, sun, song, grass, cup. Avoid abstractions, irony, metaphor, dialogue, complex prepositions.',
      };
    case AGE_BANDS.PB_TODDLER:
      return {
        maxSyllableTarget: 2,
        voice: 'Very simple musical sentences. No metaphors. Complete grammar — no baby talk.',
        vocabulary: 'Common toddler words a 2-3 year old hears daily.',
      };
    case AGE_BANDS.PB_PRESCHOOL:
      return {
        maxSyllableTarget: 3,
        voice: 'Musical, flowing, read-aloud first. Short words. No large metaphors. Funny beats okay.',
        vocabulary: 'Familiar preschool vocabulary; occasional natural three-syllable word is fine.',
      };
    case AGE_BANDS.ER_EARLY:
      return {
        maxSyllableTarget: 3,
        voice: 'Musical but slightly longer sentences. Real dialogue-quality narration, still simple.',
        vocabulary: 'Early-reader vocabulary. Natural multi-syllable words fine. Still concrete.',
      };
    default:
      return {
        maxSyllableTarget: 3,
        voice: 'Musical, simple, read-aloud first.',
        vocabulary: 'Common children\'s vocabulary.',
      };
  }
}

/**
 * Resolve rhyme policy, honoring any brief override.
 *
 * @param {string} format
 * @param {object} brief
 * @returns {'default_rhyme'|'prose'}
 */
function resolveRhymePolicy(format, brief) {
  const override = brief?.creativeGoals?.rhymeOverride;
  if (override === true) return 'default_rhyme';
  if (override === false) return 'prose';
  return RHYME_POLICY[format] || 'prose';
}

/**
 * Resolve narration style.
 *
 * @param {object} brief
 * @returns {'third'|'first'}
 */
function resolveNarration(brief) {
  const override = brief?.creativeGoals?.narrationOverride;
  if (override === 'first' || override === 'first_person') return 'first';
  return 'third';
}

/**
 * Render a compact text-policy block for a writer prompt.
 *
 * @param {object} doc
 * @returns {string}
 */
function renderTextPolicyBlock(doc) {
  const rules = ageRules(doc.request.ageBand);
  const rhyme = resolveRhymePolicy(doc.request.format, doc.brief);
  const narration = resolveNarration(doc.brief);
  const lineTarget = TEXT_LINE_TARGET[doc.request.ageBand] || { min: 3, max: 4 };
  const isPictureBook = doc.request.format === FORMATS.PICTURE_BOOK;

  const lines = [
    `Age band: ${doc.request.ageBand}. Format: ${doc.request.format}.`,
    `Voice: ${rules.voice}`,
    `Vocabulary: ${rules.vocabulary}`,
    `Narration: ${narration === 'third' ? 'third-person' : 'first-person (child)'}.`,
  ];

  if (isPictureBook) {
    const wordBudget = WORDS_PER_LINE_TARGET[doc.request.ageBand] || WORDS_PER_LINE_TARGET[AGE_BANDS.PB_PRESCHOOL];
    const isInfant = doc.request.ageBand === AGE_BANDS.PB_INFANT;
    const isToddler = doc.request.ageBand === AGE_BANDS.PB_TODDLER;

    if (isInfant) {
      // Infant band shares the 4-line picture-book shape with the
      // toddler/preschool bands, but with tiny vocabulary, the
      // "baby-is-the-still-point" action whitelist, sensory observation only,
      // and a tighter per-line word budget. Same page shape, gentler voice.
      //
      // AA-CW-17 Part B — RHYME SCHEME RELAXATION FOR PB_INFANT.
      // At infant line budget (2-5 words/line, hardMax 6) with two AABB
      // couplets per spread, the writer's search space for the SECOND
      // rhyme word of each couplet collapses against the proseProps
      // whitelist + banned locomotion verbs + no identity rhymes + fresh
      // verb / fresh refrain rules. The writer was forced into identity
      // rhymes (Mama/Mama, snug/snug), forced meaning drift ("in the
      // yard past" to rhyme "grass"), or invented impossible actions
      // ("blanket folds in peek") to land lines 3+4. Production runs on
      // book e3f4e0c0 hit the writer-fatal hard gate after 5 rewrite
      // waves with this exact pattern.
      //
      // The fix: lines 1+2 MUST rhyme (it's the heart of board-book
      // sing-song). Lines 3+4 MAY rhyme OR MAY be free-verse with
      // strong rhythmic parallel — whichever yields more natural
      // language. Toddler/preschool keep strict AABB; their longer line
      // budgets give the writer enough room to land both couplets
      // without collapsing.
      //
      // The block is organized around ONE central principle — "the baby is
      // the still point" — to prevent the writer from reaching for action
      // verbs (dance, twirl, march, climb, run, hop, jump, skip, bounce) that
      // a 0-1 year old cannot physically perform. Every other rule below is a
      // consequence of that principle.
      lines.push(
        '',
        '### CORE PRINCIPLE (READ FIRST — every infant spread must obey this):',
        'THE BABY IS THE STILL POINT. The baby (the hero) is HELD, CARRIED, or SEATED throughout the entire book. The baby never moves themselves through space — not walking, not running, not climbing, not dancing, not jumping, not hopping, not twirling, not marching, not skipping, not bouncing, not leading.',
        'Energy and motion come from THE WORLD AROUND THE BABY: light shifts, cloth flutters, music sways through the air, leaves drift past, Mama leans in, a cat slips by, the breeze plays peekaboo. The baby watches, reaches, smiles, snuggles, points, claps, gasps, giggles — always from a held or seated position.',
        'If you find yourself writing the baby DOING an action verb, stop and rewrite the sentence so the WORLD does the moving and the baby OBSERVES or REACTS. This is the single most important rule in the entire book.',
        '',
        '### REFRAME PATTERNS (when an action verb tries to attach to the baby, use the world-moves-instead version):',
        '- Instead of "baby dances/twirls/spins" → "music sways through her", "the room spins past her", "Mama sways with her in her arms".',
        '- Instead of "baby runs/marches/walks/leads" → "Mama carries her toward", "the path slides past", "she rides on Mama\'s hip".',
        '- Instead of "baby climbs/jumps/hops/bounces" → "she looks up at", "Mama lifts her high", "she is bounced gently on Mama\'s knee".',
        '- Instead of "baby skips/darts/races" → "a sunbeam darts past", "a butterfly races by", "she watches it go".',
        '',
        '### BAD vs GOOD (a real example from a previous draft, rewritten the right way):',
        '- BAD : "Everleigh skipped with glee."  (baby cannot skip)',
        '- GOOD: "A sunbeam skipped with glee."  (the world moves; baby watches)',
        '- BAD : "She danced up the hill."       (baby cannot dance, cannot climb)',
        '- GOOD: "Mama walked up the hill."      (Mama moves; baby is carried)',
        '- BAD : "Everleigh gave one spin."      (baby cannot spin)',
        '- GOOD: "The whole world gave a spin."  (the world moves; baby observes)',
        '',
        '### IDENTITY-RHYME BAN (very common infant-board-book failure mode):',
        'A rhyme means two DIFFERENT end-words that share a sound. Repeating the SAME word at the end of both lines is NOT a rhyme. It is a failure. Same goes for one word containing the other (sky/skies, gold/golden, beam/beams).',
        'Past drafts of this exact band have shipped with these identity rhymes — do NOT repeat them:',
        '- BAD : "Sun pours golden beams. / Mama pours golden beams."  (beams/beams = same word)',
        '- GOOD: "Sun pours golden beams. / Mama leans by sunny streams."  (beams/streams = real rhyme)',
        '- BAD : "Cloth lifts high, sky. / Still eyes spy, sky."  (sky/sky = same word)',
        '- GOOD: "Cloth lifts to the sky. / Still eyes follow high."  (sky/high = real rhyme)',
        '- BAD : "Emily\'s bracelet gleams. / Everleigh watches gleams."  (gleams/gleams = same word)',
        '- GOOD: "Emily\'s bracelet gleams. / Everleigh quiet as dreams."  (gleams/dreams = real rhyme)',
        '- BAD : "Everleigh sees gold. / Soft cloth held, gold."  (gold/gold = same word)',
        '- GOOD: "Everleigh sees gold. / Soft cloth held to hold."  (gold/hold = real rhyme)',
        'When you find yourself reusing a word as the rhyme, REWRITE the second line with a different end-word that genuinely rhymes. If you cannot find one, change BOTH end-words and re-rhyme the couplet. Never ship an identity rhyme.',
        '',
        '### VOCABULARY DIVERSITY (infant book is 13 spreads × 4 lines = 52 lines total):',
        'Across the entire book, no single content word should appear in more than 2 spreads. "sun" in 4 spreads, "toes" in 3 spreads, "peekaboo" in 3+ spreads is a tell-tale sign the writer is reaching for a familiar word instead of a fresh image. Variety of sensory detail is what makes a tiny board book feel like a real book and not a list.',
        'High-risk repeating words to watch for (treat each WHOLE FAMILY as one word — "glow", "glows", "glowing", "aglow" all count as the same crutch):',
        '- sun-family: sun, sunshine, sunlight, sunlit, sunny',
        '- light-family: light, bright, glow, glows, glowing, aglow, gleam, gleams, gleaming, beam, beams, beaming, shine, shines, shining',
        '- texture-family: soft, softly, warm, warmly, gentle, gently',
        '- play-family: play, plays, playing, peek, peeks, peeking, peekaboo, smile, smiles, smiling, laugh, laughs, laughing, giggle, giggles, giggling, clap, claps, clapping',
        '- body-family: hand, hands, toes, foot, feet, eye, eyes',
        'If you used a word from any of these families on the previous spread, pick a different sensory anchor for this one. "Mama laughs" on spread 7 + "Mama laughs" on spread 11 + "Everleigh giggles" on spread 1 is the same crutch three times.',
        '',
        '### COMPLETE-SENTENCE RULE (read-aloud must sound like prose, not a label list):',
        'Every line of every couplet must be a complete sentence with BOTH a subject AND a verb. Fragment lines like "Mama, soft glow" or "Sunlit joy below" or "Leaves, soft show" make the read-aloud collapse into a list of nouns instead of a singing rhythm. They also dodge the still-point rule by hiding the verb the writer cannot find.',
        '- BAD : "Mama, soft glow"           (no verb — fragment)',
        '- GOOD: "Mama wears a soft glow."   (verb "wears" carries the line)',
        '- BAD : "Leaves, soft show"         (no verb — fragment)',
        '- GOOD: "Leaves drift in soft show." (verb "drift" carries the line)',
        '- BAD : "Sunlit joy below"          (no verb — fragment)',
        '- GOOD: "Sunlit joy spills below."  (verb "spills" carries the line)',
        '- BAD : "Mama eyes aglow"           (no verb — "eyes" is a noun here)',
        '- GOOD: "Mama\'s eyes shine aglow." (verb "shine" carries the line)',
        'Subject + verb every line. The verb may be small (is, sits, holds, sees) but it must be present.',
        '',
        '### NO YODA-INVERSIONS FOR FORCED RHYMES:',
        'When you cannot find a rhyme partner, do NOT invert subject and object to game the meter. "Mama laughs, sees she" is broken English; "Breezes lift leaves by" leaves "by" dangling. Either find a real rhyme or rewrite both end-words.',
        '- BAD : "Mama laughs, sees she."    (object before subject — forced for she/glee rhyme)',
        '- GOOD: "Mama laughs back at me."   (natural English; me/glee real rhyme)',
        '- BAD : "Breezes lift leaves by."   ("by" dangling for by/high rhyme)',
        '- GOOD: "Breezes lift the leaves on high."  (natural prepositional phrase)',
        '',
        '### STRUCTURE (NON-NEGOTIABLE for infant board books — every single spread):',
        '- EXACTLY 4 lines of text per spread. Not 2. Not 3. Always 4. Lines separated by single "\\n" characters.',
        '- RHYME SCHEME (AA-CW-17 — RELAXED FOR INFANT BOARD BOOKS): Lines 1+2 MUST rhyme — a real end-rhyme, no identity rhyme, no slant. Lines 3+4 MAY rhyme OR MAY be free-verse with a strong rhythmic parallel — whichever yields more NATURAL LANGUAGE. Lines 2 and 4 do NOT need to rhyme with each other. PRINCIPLE: never force a rhyme on lines 3+4 if it would (a) drag the meaning out of frame, (b) require an identity rhyme, (c) require an invented prop, or (d) require an unrenderable action. When a real rhyme cannot be found, use unrhymed lines 3+4 with parallel rhythm and SAY SO in `writerNotes` (e.g. "lines 3+4 unrhymed for natural cadence"). Real end-rhymes are still preferred when they land naturally.',
        `- LINE LENGTH (ages 0-1 — the shortest): each of the 4 lines is ~${wordBudget.min}-${wordBudget.max} words, never more than ${wordBudget.hardMax}. Tight, sing-song, lap-baby cadence — board-book brevity inside a 4-line shape.`,
        '- TONE: tiny, warm, musical. Sensory observation only — NO conflict, NO plot stakes, NO dialogue, NO chase, NO grabbing of moving objects, NO independent locomotion.',
        '- VOCABULARY: words a baby hears daily — Mama, Dada, hand, light, soft, warm, smile, hug, see, look, up, down, big, little, sky, moon, sun, song, grass, cup.',
        '- ACTIONS (whitelist — these are the ONLY verbs that may attach to the baby): sees, hears, smiles, reaches, claps, holds, snuggles, points, looks, touches, gasps, giggles, watches, waves, blinks. Forbidden because the baby cannot physically do them: walks, runs, climbs, dances, twirls, spins, jumps, hops, marches, skips, bounces, darts, races, leads, grabs runaway objects.',
        '- DESCRIPTIVE WORDS: avoid using the same descriptor (e.g. "bright") on more than 2-3 spreads across the whole book. If you find yourself reaching for the same adjective again, swap it for a different sensory detail.',
        '- EXAMPLE CADENCE A for ages 0-1 — fully rhymed AABB (do not copy these words — copy the shape):',
        '    "Little hand sees the light.',
        '     Mama holds her tight.',
        '     Soft moon hums above.',
        '     Baby blinks at love."',
        '- EXAMPLE CADENCE B for ages 0-1 — lines 1+2 rhymed, lines 3+4 unrhymed but rhythmic (also acceptable for infant when forcing the second rhyme would drift meaning):',
        '    "Little hand sees the light.',
        '     Mama holds her tight.',
        '     Soft moon hums above.',
        '     Baby watches the slow stars."',
        '',
      );
    } else {
      const lineLengthRule = isToddler
        ? `- LINE LENGTH (ages 0-3 are the shortest): each of the 4 lines is VERY short — about ${wordBudget.min} to ${wordBudget.max} words, never more than ${wordBudget.hardMax}. Tight, sing-song, board-book cadence. No run-ons, no sub-clauses, no "and... and... and..." chaining.`
        : `- LINE LENGTH: each of the 4 lines is short — about ${wordBudget.min} to ${wordBudget.max} words, never more than ${wordBudget.hardMax}. No run-ons.`;
      const voiceRule = isToddler
        ? '- TONE (ages 0-3 specific): simple, musical, concrete. Tiny actions and feelings, named things a toddler knows (hand, moon, song, sky, hug). Big, punchy end-rhymes. Never abstract, never preachy.'
        : null;
      const toddlerStructureExample = isToddler
        ? [
            '- EXAMPLE CADENCE for ages 0-3 (do not copy these words — copy the shape):',
            '    "Little hand reached high.',
            '     Stars danced in the sky.',
            '     Mommy hummed a tune.',
            '     Up floated the moon."',
          ]
        : [];
      lines.push(
        '',
        '### STRUCTURE (NON-NEGOTIABLE for picture books — every single spread):',
        '- EXACTLY 4 lines of text per spread. Not 3. Not 5. Always 4. Each line separated by a single "\\n".',
        '- RHYME SCHEME: AABB (two rhyming couplets per spread). Line 1 rhymes with line 2. Line 3 rhymes with line 4. Lines 2 and 4 do NOT have to rhyme with each other.',
        '- Rhymes must be real end-rhymes — the FINAL word of line 1 rhymes with the FINAL word of line 2 (and 3 with 4). Near-rhymes (e.g. "high/sky", "wide/side", "tune/moon") are fine. Slant rhymes and identity rhymes (same word twice) are NOT acceptable. Forced or dictionary-stretching rhymes are NOT acceptable.',
        '- METER: a consistent musical pulse across each couplet — not strict iambic, but roughly the same number of stressed beats in line 1 as line 2, and line 3 as line 4. Read every couplet aloud in your head and confirm both lines sing at the same pace.',
        lineLengthRule,
        ...(voiceRule ? [voiceRule] : []),
        '- LINE BREAKS: the 4 lines are natural phrase units. Never break mid-phrase just to force a rhyme.',
        '- SOUND: musical and read-aloud first. If a couplet does not actually rhyme, rewrite the couplet — do not ship it.',
        ...toddlerStructureExample,
        '',
      );
    }
  } else {
    lines.push(
      `Target rendered lines per spread: ${lineTarget.min}-${lineTarget.max}.`,
      `Rhyme policy: ${rhyme === 'default_rhyme' ? 'use rhyming couplets by default; near-rhymes are fine' : 'prose by default; do not force rhyme'}.`,
    );
  }

  lines.push(
    'Tone: funny/playful with character-based humor. Never preachy.',
    'Dialogue: light. Most spreads are narration; dialogue when it earns its place.',
    'Repetition: low. Repetition only when it clearly improves rhythm.',
    'Metaphors: avoid large metaphors. Concrete images over abstractions.',
    'Ending: story-specific. Do not force a bedtime/quiet-close ending.',
    'Personalization: use custom details concretely and recognizably.',
    'Child\'s name: used sometimes, not constantly.',
  );

  return lines.join('\n');
}

module.exports = {
  ageRules,
  resolveRhymePolicy,
  resolveNarration,
  renderTextPolicyBlock,
};
