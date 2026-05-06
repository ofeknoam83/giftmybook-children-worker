/**
 * AA-CW-4 — Writer-side QA, rewritten as a single LLM judge.
 * AA-CW-11 — cross-family judge (gemini-2.5-pro) replaces same-family judge
 *            to break shared-blind-spot rhyme failures.
 * AA-CW-20 — reverted to same-family SELF-CRITIQUE (gpt-5.4 judges gpt-5.4)
 *            after production showed the cross-family judge raised
 *            taste-level tags at the 2-5 word infant line budget that
 *            the writer could not satisfy in 5 rewrite waves. Same-model
 *            self-critique converges because the critic only raises
 *            defects the writer can actually fix. Deterministic
 *            identity-rhyme + dropped-article audits run AFTER the
 *            self-critique as belt-and-suspenders insurance against the
 *            shared blind spot. The gemini-2.5-flash shadow stays wired
 *            up but is observability-only — it never gates pass/fail.
 *
 * Authoritative path: ONE call to MODELS.WRITER_JUDGE (gpt-5.4 as of
 * AA-CW-20) that returns the full per-spread + book-level verdict in
 * structured JSON. The 25 deterministic helpers from the original
 * implementation (verb-crutch lemmatization, dropped-article regex,
 * address-name concat, fragment detection, phonetic rhyme tail
 * comparator, nonsense-word lexicon, nonsense-simile keyword list,
 * peer-framing matcher, refrain-crutch counter, infant forbidden-verb
 * regex stack, line-count truncator, etc.) are all DELETED. The judge
 * prompt enumerates every one of those failure modes with concrete
 * BAD/GOOD examples so the LLM carries the entire signal.
 *
 * One side call remains:
 *   - Shadow run — the gemini-2.5-flash literary call still fires in
 *     parallel; its verdict is logged to stdout + appended to
 *     `doc.llmCalls` under stage `writerQa.shadow` for observability
 *     and rollout-window diffing. NEVER authoritative — it cannot
 *     fail the manuscript.
 *
 * AA-CW-9: the per-line `infantLocomotionGate` Flash call was deleted.
 * It cost ~38 sequential Flash calls (~65s wall time) per PB_INFANT
 * book to confirm what the gpt-5.4 judge already reports as
 * `infant_action_verb_in_text`. The judge's verdict is the single
 * source of truth; the writer-rewrite hard gate now relies on the
 * judge's `infant_action_verb_in_text` tag instead of a separate
 * regex/Flash residual sweep.
 *
 * `signatureBeats.checkSignatureBeatCoverage` survives as a cheap
 * deterministic preflight (token-presence over per-anchor keywords)
 * because the questionnaire-anchor coverage signal is structured data,
 * not a literary judgment, and the same module is also consumed by
 * planner/anchorAllocation. It feeds the judge prompt as
 * `signatureBeatsHint` and gates the final pass independently.
 *
 * Returns `{ pass, perSpread, bookLevel, bookLevelTags, repairPlan, updatedDoc }`.
 */

const { callText } = require('../llm/openaiClient');
const { MODELS, AGE_BANDS } = require('../constants');
const { appendLlmCall } = require('../schema/bookDocument');
const { renderThemeDirectiveBlock } = require('../planner/themeDirectives');
const { checkSignatureBeatCoverage, describeBeat } = require('./signatureBeats');

// =============================================================================
// Judge prompt (authoritative)
// =============================================================================

const JUDGE_SYSTEM = `You are running a SELF-CRITIQUE pass on a children's-book manuscript that you (the same model family) just wrote. Your job is to catch FIXABLE structural defects — the things the writer can actually correct in a 1-2 wave rewrite — before this manuscript ships to a real family. You are not a literary awards panel. You are not optimising for taste. You are checking that the rules below are satisfied. If a rule is broken, fail it. If a rule is satisfied, pass it. No hedging. No aesthetic disqualifications outside the named tags.

The goal is convergence: every issue you raise must be something the writer can definitely fix in the next wave. If you cannot describe a concrete one-line edit that would clear an issue, do NOT raise it.

You receive: format, ageBand, theme, brief (child name, pronouns, anecdotes, interests, parents), storyBible, the full per-spread manuscript (text + side + spec), an optional theme-directive block listing banned clichés, and an optional signatureBeatsHint listing questionnaire anchors that look unlanded.

You return ONE JSON object with the schema given at the bottom. No prose, no markdown.

== Universal expectations ==
- Story coherence and emotional payoff across the 13 spreads (act-1 setup, act-2 stakes, act-3 resolution).
- Read-aloud musicality. Clear pulse. No tongue-twisters.
- Age-fit: vocabulary, action, sensory range, attention budget all match the declared age band.
- Real personalization: hero name, pronouns, parents' address forms (Mama/Daddy/etc.), interests, anecdotes from the questionnaire all appear and feel native — not tacked on.
- No preachy moralizing ("always remember", "the lesson is", "never forget", "you should always", "the moral is", "we all must").
- Pronoun discipline: ONE pronoun set for the hero, declared in brief.pronouns. Never alternate, never swap, never use a different set anywhere in the book. When ambiguous, prefer the hero's name.

== Picture-book hard rules (format == "picture_book") — apply to ALL bands ==
- LINE COUNT: EXACTLY 4 lines per spread for ALL picture-book age bands (PB_INFANT 0-1, PB_TODDLER 0-3, PB_PRESCHOOL 3-6). NEVER accept 2-line spreads. Lines separated by "\\n".
- RHYME SCHEME (band-conditional, AA-CW-17):
  * PB_TODDLER and PB_PRESCHOOL: full AABB — lines 1+2 MUST rhyme; lines 3+4 MUST rhyme. Real end-rhymes or near-rhymes only. A failed rhyme on either couplet is \`rhyme_fail\`.
  * PB_INFANT (0-1): RELAXED. Lines 1+2 MUST rhyme (real end-rhyme; identity/slant/stem/suffix-only/r-controlled-mismatch are all \`rhyme_fail\`). Lines 3+4 MAY rhyme OR MAY be free-verse with strong rhythmic parallel. Do NOT raise \`rhyme_fail\` on lines 3+4 of an infant spread purely because they don't rhyme. Only raise \`rhyme_fail\` on lines 3+4 of an infant spread when the writer ATTEMPTED to rhyme them and the attempt is identity/slant/stem/suffix-only/non-rhyme. Free-verse lines 3+4 with parallel rhythm are ACCEPTABLE on infant books — the goal is natural read-aloud, not forced couplets at 3-word line budget.
  * Universal: identity rhymes (same word as both rhyme ends) are ALWAYS \`rhyme_fail\`, on every couplet that is rhymed at all, in every band.
  * Universal: a couplet that is rhymed (the writer chose to rhyme it) must be a real rhyme; if it isn't, that's \`rhyme_fail\`. Half-attempted rhymes do not get a pass.
- Per-line word budget:
  * PB_INFANT (0-1): 2-5 words/line, hardMax 6.
  * PB_TODDLER (0-3): 3-7 words/line, hardMax 8.
  * PB_PRESCHOOL (3-6): 6-12 words/line, hardMax 14.
- Consistent musical pulse within each couplet.

== Failure modes — tag exactly as named ==
Each issue must carry one of these tags. Multiple tags allowed per spread.

1. "rhyme_fail" — couplet does not really rhyme. THIS IS THE MOST FAILED RULE. Be ruthless.

   IDENTITY RHYMES — same word repeated as both rhyme ends. ALWAYS FAIL. NO EXCEPTIONS.
     BAD: "cheek/cheek", "Mama/Mama", "town/town", "squeals/squeals", "light/light", "name/name".
     A couplet that ends both lines on the SAME WORD (even with different intervening words) is identity rhyme. Repeating the hero's name or a parent name as the rhyme is identity rhyme. Repeating any noun as both rhyme positions is identity rhyme.

   SLANT RHYMES — vowel or final-consonant mismatches. ALWAYS FAIL.
     BAD: "outside/glide" (different stressed vowels), "wide/beside" (different stressed-syllable sounds), "along/song" (different vowel quality), "stays/always" (different stress + suffix-only), "pride/outside" (slant), "nose/froes" (one is a fake word, see nonsense_word too), "sing/plan", "sigh/Deana", "sniff/off", "high/cuddle".

   STEM RHYMES — one word contains the other. ALWAYS FAIL.
     BAD: "town/hometown", "light/spotlight", "day/today", "side/outside".

   SUFFIX-ONLY RHYMES — only the grammatical ending matches. ALWAYS FAIL.
     BAD: "running/jumping", "sadly/badly", "quickly/slowly", "playing/staying".

   R-CONTROLLED VOWEL MISMATCH — pairs whose post-vowel consonant matches but the stressed vowel differs. ALWAYS FAIL. Phonetic principle: in American English, the vowel before /r/ carries the rhyme, not the /r/ itself. If the vowels diverge, the pair only LOOKS like a rhyme on paper.
     BAD families (each pair is the canonical example of its family): "arm/warm" (/ɑrm/ vs /wɔrm/), "heart/short" (/ɑrt/ vs /ɔrt/), "born/turn" (/ɔrn/ vs /ɜrn/), "care/fear" (/ɛr/ vs /ɪr/), "hard/word" (/ɑrd/ vs /ɜrd/).
     The test: say both words out loud. If the stressed vowel differs, fail it regardless of how the spelling looks.

   INTERJECTION / EXCLAMATION AS RHYME — the rhyme word on at least one side is an interjection, onomatopoeia, or stage-direction sound used to force a match with a content word. ALWAYS FAIL — interjections are theatrical, not lexical, and pairing them with real words breaks the read-aloud.
     BAD examples (one per family): "Mama/Ta-da", "flow/Whoa", "day/Yay", "cheer/Hooray", "glow/Oh", "high/Aha", "go/Uh-oh", "bang/Bam", "creep/Boo", "top/Pop".
     Onomatopoeia is fine WITHIN a line for sound effect, but never as the rhyme word itself. Excludes nothing — even "Ta-da" repeated across multiple spreads as a refrain does not earn it status as a rhyme word.

   GOOD pairs (real rhymes): "town/down", "light/bright", "day/play", "high/sky", "ball/tall", "chin/grin", "tight/right", "snug/hug", "flies/sighs", "by/high", "there/air", "slow/blow", "cheer/near", "heart/part".

   In the issue text, name the offending pair AND which sub-mode (identity / slant / stem / suffix-only / r-controlled / interjection / non-rhyming). When in doubt about a slant pair, FAIL it — the writer can find a real rhyme.

2. "dropped_article" — a preposition is followed by a bare singular countable noun with no determiner. BAD: "down street", "by feet", "on bench", "in room", "drift above land" (should be "above the land"), "go past" used as object ("baskets go past" is fine, but "baskets past store" is broken). GOOD: "down THE street", "by HER feet", "on a bench", "in HIS room", "drift above THE land". This is broken phrasing, never a stylistic choice.

3. "address_name_concat" — a parental address term jammed against the parent's proper first name. BAD: "Mama Courtney", "Daddy John", "Mommy Sarah", "Papa Tom". GOOD: pick one — "Mama" OR "Courtney", never both back-to-back.

4. "verb_crutch" — ONE content-verb LEMMA dominates the manuscript. Book-level. Mandatory counting procedure:
     a. Walk every line of every spread.
     b. For each finite verb whose subject is the hero or a parent, normalise to its lemma (squeals/squealed/squealing → squeal; holds/held/holding → hold; smiles/smiled → smile). Skip auxiliaries (is, are, was, has, does), copulas (be, seem, look), and the bare verb "say" used as a speech tag.
     c. Count distinct spreads each lemma appears in (a lemma used twice in the same spread counts once).
     d. If any lemma appears in MORE THAN 25% of spreads (≥4 of 13 for a standard picture book), fail.
   Report format: "verb_crutch: 'squeal' appears in 6 of 13 spreads (46%) — spreads 5, 7, 8, 11, 12, 13. Diversify the hero's actions." Do NOT eyeball this — count.

5. "refrain_crutch" — ONE non-verb content WORD (noun, adjective, onomatopoeia, exclamation) dominates the manuscript. Book-level. Distinct from verb_crutch. Mandatory counting procedure (same as rule 4):
     a. Walk every line of every spread; lemmatise to the singular form (toes → toe, leaves → leaf).
     b. Exclude: the hero's first name, declared parent address words (Mama/Daddy/etc.), articles, prepositions, pronouns, conjunctions.
     c. Count distinct spreads each lemma appears in.
     d. If any non-excluded lemma appears in MORE THAN 25% of spreads (≥4 of 13; ≥3 of 13 for PB_INFANT because their vocabulary is tighter), fail.
   NOTE: a load-bearing motif (a single named prop the book is about — e.g. the blanket in a snuggle book) can legitimately appear often. The judgment call: if removing the word would damage the through-line, it's a motif, not a crutch. When the word adds nothing on a given spread except line-filling, it's a crutch.
   Report format: "refrain_crutch: 'blanket' appears in 5 of 13 spreads — spreads 1, 2, 4, 6, 8. Reads as line-filler on spreads 4 and 8."

6. "low_personalization_saturation" — substantive personalization items from the brief (interests, anecdotes, address forms, custom details) appear in fewer than ~60% of relevant spreads. Book-level. Name the missing items.

7. "signature_beat_missing" — a questionnaire anchor (funny_thing, meaningful_moment, moms_favorite_moment, dads_favorite_moment, anything_else, calls_mom, calls_dad) does NOT surface in any spread. Book-level. Use the signatureBeatsHint input as a pre-screen but make your own call from the manuscript text.

8. "age_mismatch_action" — action attributed to the child is implausible for the declared age band. Per-spread.

9. "infant_action_verb_in_text" — for PB_INFANT (0-1) ONLY, the manuscript uses a locomotion VERB the baby physically cannot do. This rule is about VERBS. Bare nouns are NEVER triggers. Saying "feet", "legs", "toes", "arms", "hands" by themselves is fine.

   Banned verb roots (any inflection — base, -s, -ed, -ing) when the BABY is the subject: jump, run, race, spin, twirl, hop, walk, climb, leap, dance, chase, skip, gallop, stomp, march, crawl, step, stand/stood, cartwheel, tumble.

   Body-part-as-agent constructions trigger ONLY when a body-part noun is paired with a locomotion verb that implies the whole baby moving through space: "feet flash across", "feet pound the floor", "feet step out", "legs march", "feet gallop". A body part used with non-locomotion verbs is FINE.

   Explicitly age-appropriate (DO NOT FLAG):
     • "tiny feet kick" / "feet kick the air" / "feet wiggle" — lap-baby kicking is normal infant motor activity.
     • "hands reach" / "fingers grab" / "toes curl" / "arms wave" — fine motor, fine.
     • "happy feet" / "two little feet" / "warm feet" — nominal mention.
     • "bounce" when the baby is being bounced ON A LAP / IN ARMS (passive). Only flag "bounce" when the baby is propelling themselves on their feet.
     • "hop" / "jump" used about a non-baby agent (a bunny, a dad, a frog) — fine.
   Use sit/lie/look/reach/giggle/coo/hold/snuggle/nuzzle/wiggle/wave/peek as positive verbs. Per-spread. List the offending VERB (not a noun) in the issue text. If you cannot name a specific verb, do NOT raise this tag.

10. "nonsense_word" — the manuscript invents a fake word to force a rhyme, OR pluralizes/inflects an invariable phrase to force one. BAD: "farf" rhymed with "scarf", "blurp" rhymed with "burp", "shloop" rhymed with "scoop", "froes" (the phrase "to and fro" is invariable; "froes" is not a word). If the surface form is not in standard English dictionaries and is not a proper name or accepted onomatopoeia (boop, pop, shh, shhh, mmm, oof), it's a nonsense word. Name the invented word in the issue.

11. "nonsense_simile" — a simile ("X as Y", "X like Y") whose comparand is implausible for a baby/preschooler. BAD: "light as code", "soft as math", "like an algorithm", "loud as a server". GOOD: "soft as fluff", "warm as toast", "loud as thunder". Per-spread.

12. "parent_theme_relationship_framing" — for Mother's Day / Father's Day / Grandparents' Day themes, the manuscript casts child + parent as PEERS. Banned framings: "best friends", "best buds", "best mates", "buddies", "besties", "BFF", "we're a team" framed as equals. CORRECT framing: parent as loving caregiver / hero / the one who tucks me in. Per-spread.

13. "fragment_line" — a manuscript line has no finite verb and reads as a noun-phrase fragment. BAD: "Mama, soft glow." / "Stars and a yawn." / "Two warm hands." GOOD: "Mama gives a soft glow." / "Stars hang above the yawn." / "Two warm hands hold tight." Per-spread.

   AA-CW-20 BAND POLICY: ADVISORY at PB_INFANT (0-1). The 2-5 word line budget makes finite-verb-on-every-line a constant fight; lap-baby books frequently use a noun-phrase line for percussive rhythm ("Two warm hands.") and that is acceptable. Only raise this tag at PB_INFANT when EVERY line of the spread is a fragment (no spread should be 100% fragments). ALWAYS FAIL at PB_TODDLER and PB_PRESCHOOL.

14. "identity_pronoun_swap" — the hero is referred to with a pronoun set inconsistent with brief.pronouns (e.g. brief says she/her but a spread uses "he"/"him"/"his"/"they"). Per-spread. Quote the offending sentence.

15. "theme_cliche" — the manuscript uses a phrase listed as a BANNED CLICHÉ in the theme-directive block. Per-spread.

16. "line_count_violation" — the spread does not have EXACTLY 4 lines (for picture books). Per-spread.

17. "line_length_violation" — a line exceeds the per-band hardMax word count. Per-spread. Name the line and word count.

18. "unrenderable_action" — a line describes an action whose object cannot be drawn as a concrete physical thing. The illustrator is a literal image model: it can only render concrete nouns and physically possible interactions. If a line tells the artist to draw the child interacting with an abstraction (a sound, an emotion, a facial expression), the renderer either freezes or invents a wrong prop and burns the entire illustration retry budget. ALWAYS FAIL these.

   BAD examples (and why):
     • "Mama holds her purr." — a purr is a sound, not a holdable object.
     • "Scarlett bites her grin." — a grin is a facial expression, not bitable.
     • "He catches her smile." — a smile is not catchable as a physical thing.
     • "She drinks the song." — a song is not a liquid.
     • "Mama hugs her giggle." — a giggle is a sound, not huggable.
     • "He grabs the quiet." — quiet is an absence, not a graspable object.

   GOOD substitutions: pick a concrete physical object the illustrator can draw — a blanket, a hand, a cheek, a toy, the lap, the chin, the nose. "Mama holds her tight." / "Scarlett bites Mama's chin." / "He catches her hand." all render fine.

   The test: can a four-year-old reading this line point at a real, drawable thing the verb is acting on? If no, fail it. Per-spread. Quote the offending line in the issue.

19. "writer_invented_prop" — the manuscript text names a physical prop the hero or parent INTERACTS WITH that is NOT in the spread's \`proseProps\` whitelist (and not a character / body part / location). The illustrator follows the spec, not the text, so writer-invented props guarantee an action_mismatch loop. ALWAYS FAIL.

   AA-CW-16 — the spread spec now carries an explicit \`proseProps\` array: an exhaustive whitelist of concrete physical objects the writer is allowed to name. Use it as your authority.

   Example: \`proseProps\` = ["blanket", "lap", "cheek", "stroller", "strawberry-print", "hand"] but the manuscript line says "Scarlett pats one string." — "string" is not in the whitelist, so it is invented. The renderer will draw the spec, the line will not match the image, and the spread fails downstream.

   The test: every concrete physical noun that the hero or parent INTERACTS WITH (object of a transitive verb the child performs, possessive target, prepositional anchor of a touch/hold/pat/lift/grip) must satisfy ONE of:
     (a) it names the child or parent ("Mama", "Scarlett", "baby")
     (b) it names a body part (cheek, hand, finger, toe, lap, knee, chin, nose, hair)
     (c) it appears in the spread's \`location\` (case-insensitive substring)
     (d) it appears in the spread's \`proseProps\` array (case-insensitive substring — "blanket" matches "the blanket" or "strawberry-print blanket")
   Falling outside all four = \`writer_invented_prop\`. Background scenery the hero only LOOKS AT (sky, trees, clouds) is exempt unless the hero touches it. If \`proseProps\` is missing or empty on a spread, fall back to the legacy substring check against \`spec.focalAction\` + \`spec.plotBeat\` + \`spec.mustUseDetails\`. Per-spread. Quote the offending line and name the invented prop.

20. "semantic_filler" — a line is grammatically complete but adds no image, no action, and no new sensory or emotional information beyond what an adjacent line already carried, OR uses a vague phrase to complete a rhyme. Per-spread.

   AA-CW-20 BAND POLICY: ADVISORY at PB_INFANT (0-1) — the 2-5 word line budget makes "every line introduces a new sensory beat" routinely impossible to satisfy when lines 1-2 are already establishing a moment and lines 3-4 are repeating the felt sense (a legitimate read-aloud device for lap-baby books). At PB_INFANT, only raise this tag when a line is OBVIOUSLY a rhyme-completer with a wrong subject or a vague temporal filler (see test (c) below). Do NOT raise it just because a line restates the spread's mood. ALWAYS FAIL at PB_TODDLER and PB_PRESCHOOL.

   Three independent tests — failing ANY one is enough:
     (a) Image test: does this line introduce a new sensory detail (sight, sound, touch, motion, smell, taste)? If no, fail.
     (b) Cut test: if you delete this line, does the spread lose anything a reader can picture or feel? If no, fail.
     (c) Rhyme-completer test: is the line a vague phrase that exists primarily to land the rhyme word, not to advance the moment? Symptoms: a verb whose subject is unclear ("she knows" — knows what?), a verb attached to an inanimate subject that cannot perform it ("Blanket folds away" — a blanket cannot fold itself), a phrase that is geometrically or physically odd ("Mama rocks her seat" — the seat is not the thing being rocked), a generic temporal filler ("all day", "so sweet", "stays awhile") that adds no image.

   BAD generic examples:
     • "Mama stays close, she knows." — knows what? Dangling subordinate.
     • "Blanket folds away." — blankets don't fold themselves.
     • "Mama rocks her seat." — Mama rocks the chair OR the baby; "her seat" is geometrically wrong.
     • "Snuggles stay so sweet." — abstract, no new image.
     • "Mama stays all day." — generic temporal filler.
     • "Brings her play." — "brings her playtime" parses; "brings her play" does not.

   GOOD substitutions follow the rule "every line earns its place": replace with a concrete sensory beat (a sound, a touch, a movement, a glance) that wasn't already in the spread.

21. "forced_rhyme_meaning_drift" — the manuscript ends a line on a rhyme word that creates a wrong, implausible, or emotionally mismatched meaning. Per-spread.

   AA-CW-20 BAND POLICY: ADVISORY at PB_INFANT (0-1). Only raise it when the meaning drift is OBVIOUS — a wrong emotional valence ("laughs at her wail") or a physically impossible verb ("kicks the song"). Do NOT raise it on borderline cases at PB_INFANT. ALWAYS FAIL at PB_TODDLER and PB_PRESCHOOL.

   Two tests — failing EITHER is enough:
     (a) Emotional valence: does the action match the emotional context of the spread and the book? A baby's wail is distress, not delight — laughing AT a wail is the wrong emotional valence. A snuggle scene's verbs should be tender, not abrupt.
     (b) Physical plausibility: is the verb's object physically possible? Can Mama rock a seat? Can a blanket fold itself? Can a child catch a smile? If the noun is grammatically valid but physically nonsensical, fail (note: distinct from rule 18 unrenderable_action, which fires on abstractions like "holds her purr"; rule 21 fires on grammatical-but-wrong-meaning constructions like "laughs at her wail").

   BAD generic examples:
     • "Mama laughs at that wail." — wrong emotional valence; you don't laugh at a baby's distress.
     • "Mama rocks her seat." — geometrically odd; Mama rocks a chair or rocks a baby, not a seat.
     • "He kicks the song." — physical impossibility forced by rhyme.

   The test: say the line out loud as a parent reading to a child. Does anything snag? If yes, the rhyme drove the meaning instead of the meaning driving the rhyme.

== Repair directive ==
For each failing spread, produce \`suggestedRewrite\` as a SHORT actionable directive (1-2 sentences) telling the writer what to fix and what to preserve. Do NOT produce the rewrite itself — that's the writer's job in the next wave. Examples:
  - "Replace 'Mama Courtney' with just 'Mama' on line 3; keep the snuggle imagery; line 3 must still rhyme with line 4."
  - "Lines 1-2 don't rhyme ('sing'/'plan'). Re-end line 2 with a real rhyme for 'sing' (ring/wing/king/swing). Keep the bedtime imagery."
  - "Spread 4 uses 'twirls' (forbidden infant locomotion). Recast as 'wiggles' or 'reaches' and adjust the couplet's rhyme accordingly."
  - "Spread 9 line 4 says 'Mama holds her purr' — a purr is a sound, not holdable. Rewrite the line so 'holds' takes a concrete physical object (her, the blanket, her hand), and keep the rhyme with line 3."
  - "Spread 7 line 2 says 'Scarlett pats one string' but spec.focalAction is about patting the blanket. Replace 'string' with 'blanket' or whatever concrete prop the spec already names; preserve the AABB rhyme."
  - "Spread 5 line 4 'Mama laughs at that wail' has wrong emotional valence (a wail is distress, not delight). Re-end line 4 with a real rhyme for line 3's end-word that names a tender or playful action; preserve the porch-swing imagery."
  - "Verb 'squeal' appears in 6 of 13 spreads. On spreads 7, 11, 12 (the redundant ones), replace the squeal with a different sensory beat — a giggle, a coo, a wave, a reach — and adjust the rhyme accordingly."

== Pass criteria (AA-CW-20 self-critique) ==
\`pass: true\` ONLY when ALL of the following STRUCTURAL rules hold. Taste-level tags (semantic_filler / forced_rhyme_meaning_drift / fragment_line) are advisory at PB_INFANT and do NOT block pass at that band even when raised. They DO block pass at PB_TODDLER and PB_PRESCHOOL.

  STRUCTURAL (all bands):
  - All rhymed couplets are real rhymes (no identity/stem/suffix-only/r-controlled-mismatch/interjection). For PB_INFANT, lines 3+4 may be free-verse instead of rhymed — free-verse with parallel rhythm passes; only attempted-but-broken rhymes fail.
  - All picture-book spreads have exactly 4 lines and respect the per-band word budget.
  - No dropped_article hits.
  - No address_name_concat hits.
  - No infant_action_verb_in_text hits in any infant spread.
  - No unrenderable_action hits in any spread.
  - No writer_invented_prop hits in any spread.
  - No nonsense_word / nonsense_simile hits.
  - No identity_pronoun_swap hits.
  - No theme_cliche hits.
  - No line_count_violation / line_length_violation hits.
  - No parent_theme_relationship_framing hits.
  - No verb_crutch at book level.
  - No refrain_crutch at book level.
  - All questionnaire signature beats land somewhere in the manuscript.

  TASTE (band-conditional):
  - PB_TODDLER / PB_PRESCHOOL: no semantic_filler, no forced_rhyme_meaning_drift, no fragment_line.
  - PB_INFANT: these three tags are ADVISORY — raise them when you see them (operators read the logs) but DO NOT set pass=false purely because of them.

Anything less → \`pass: false\`. When the only failures at PB_INFANT are advisory taste tags, set \`pass: true\`.

== Output schema (return EXACTLY this shape) ==
{
  "pass": true|false,
  "bookLevelIssues": ["<plain-text issue>", ...],
  "bookLevelTags": ["<tag>", ...],
  "perSpread": [
    {
      "spreadNumber": 1,
      "issues": ["<plain-text issue>", ...],
      "tags": ["<tag>", ...],
      "suggestedRewrite": "<short actionable directive>" | null
    },
    ...one entry per spread (1..13)...
  ],
  "infantLocomotionHits": [
    { "spreadNumber": 4, "verbs": ["twirls", "spins"] },
    ...
  ]
}

Return ONLY the JSON object. No prose. No markdown fences.`;

function buildJudgeUserPrompt(doc, signatureHint) {
  const spreads = doc.spreads.map(s => ({
    spreadNumber: s.spreadNumber,
    spec: s.spec,
    text: s.manuscript?.text,
    side: s.manuscript?.side,
  }));
  const themeBlock = renderThemeDirectiveBlock(doc.request.theme);
  const pronouns = doc?.brief?.pronouns || null;
  const heroName = doc?.brief?.child?.name || 'the hero';
  const pronounBlock = pronouns
    ? `HERO PRONOUNS — the manuscript MUST use ONLY these for ${heroName} everywhere: subject=${pronouns.subject}, object=${pronouns.object}, possessive=${pronouns.possessive}, reflexive=${pronouns.reflexive}. Any other pronoun referring to ${heroName} is identity_pronoun_swap.`
    : '';

  return [
    `Format: ${doc.request.format}. Age band: ${doc.request.ageBand}. Theme: ${doc.request.theme}.`,
    pronounBlock,
    themeBlock,
    themeBlock ? 'If the manuscript uses any BANNED CLICHÉS from the theme directive, tag those spreads with "theme_cliche" and fail.' : '',
    `Brief (subset):\n${JSON.stringify({
      child: doc?.brief?.child || null,
      parents: doc?.brief?.parents || null,
      pronouns,
      interests: doc?.brief?.interests || doc?.brief?.child?.interests || null,
      anecdotes: doc?.brief?.child?.anecdotes || null,
      customDetails: doc?.brief?.customDetails || null,
    }, null, 2)}`,
    `Story bible:\n${JSON.stringify(doc.storyBible, null, 2)}`,
    `Spreads:\n${JSON.stringify(spreads, null, 2)}`,
    signatureHint ? `signatureBeatsHint (deterministic preflight — verify against the manuscript yourself):\n${JSON.stringify(signatureHint, null, 2)}` : '',
    '',
    'Emit the JSON verdict now.',
  ].filter(Boolean).join('\n');
}

// =============================================================================
// Shadow run — old gemini-2.5-flash literary call, non-authoritative
// =============================================================================

const SHADOW_SYSTEM = `You are a senior children's-book editor running in SHADOW mode. Your verdict is logged but not authoritative. Apply the same picture-book rules: 4 lines per spread, real rhymes only on rhymed couplets, no infant locomotion verbs, no dropped articles, no parent-name concat with address words, no fragment lines, no nonsense words/similes, no peer framing for parent themes, consistent hero pronouns. Rhyme scheme is band-conditional (AA-CW-17): PB_TODDLER and PB_PRESCHOOL use full AABB; PB_INFANT requires lines 1+2 to rhyme but allows lines 3+4 to be free-verse with parallel rhythm — do NOT raise rhyme_fail on infant lines 3+4 purely for being unrhymed. Return JSON: {"pass": bool, "bookLevelIssues": [...], "perSpread": [{"spreadNumber": N, "issues": [...], "tags": [...]}]}. JSON only.`;

function buildShadowUserPrompt(doc) {
  const spreads = doc.spreads.map(s => ({
    spreadNumber: s.spreadNumber,
    text: s.manuscript?.text,
    side: s.manuscript?.side,
  }));
  return [
    `ageBand=${doc.request.ageBand}, theme=${doc.request.theme}, format=${doc.request.format}.`,
    `Spreads:\n${JSON.stringify(spreads, null, 2)}`,
    'Return JSON.',
  ].join('\n');
}

async function runShadowJudge(doc) {
  try {
    const result = await callText({
      model: MODELS.WRITER_QA,
      systemPrompt: SHADOW_SYSTEM,
      userPrompt: buildShadowUserPrompt(doc),
      jsonMode: true,
      temperature: 0.3,
      maxTokens: 7000,
      label: 'writerQa.shadow',
      abortSignal: doc.operationalContext?.abortSignal,
    });
    return { ok: true, json: result.json || {}, model: result.model, attempts: result.attempts, usage: result.usage };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function diffJudgeVerdicts(authoritative, shadow) {
  if (!shadow || !shadow.ok) return { shadowFailed: true };
  const auPass = authoritative.pass === true;
  const shPass = shadow.json?.pass === true;
  const auTags = new Set();
  for (const s of authoritative.perSpread || []) for (const t of s.tags || []) auTags.add(t);
  for (const t of authoritative.bookLevelTags || []) auTags.add(t);
  const shTags = new Set();
  for (const s of shadow.json?.perSpread || []) for (const t of s.tags || []) shTags.add(t);
  for (const t of shadow.json?.bookLevelIssues || []) shTags.add(`book:${String(t).slice(0, 40)}`);
  const onlyAuthoritative = [...auTags].filter(t => !shTags.has(t));
  const onlyShadow = [...shTags].filter(t => !auTags.has(t));
  return {
    shadowFailed: false,
    passAgreement: auPass === shPass,
    authoritativePass: auPass,
    shadowPass: shPass,
    onlyAuthoritative,
    onlyShadow,
  };
}

// =============================================================================
// Orchestrator
// =============================================================================

/**
 * @param {object} doc
 * @returns {Promise<{ pass: boolean, perSpread: object[], bookLevel: string[], bookLevelTags: string[], repairPlan: object[], updatedDoc: object }>}
 */
async function checkWriterDraft(doc) {
  // Deterministic preflight — signatureBeats is the only deterministic
  // signal that survives. It's structured questionnaire-anchor coverage,
  // not literary judgment. Feed it to the judge as a hint and also use it
  // as an independent book-level gate.
  const signature = checkSignatureBeatCoverage(doc.brief, doc.spreads);
  const signatureHint = signature.beats.length > 0
    ? {
        landed: signature.landed.map(describeBeat),
        missing: signature.missing.map(describeBeat),
        coverageRatio: signature.beats.length === 0 ? 1 : signature.landed.length / signature.beats.length,
      }
    : null;

  // Authoritative judge + shadow run, in parallel.
  const [judgeResult, shadowResult] = await Promise.all([
    callText({
      model: MODELS.WRITER_JUDGE,
      systemPrompt: JUDGE_SYSTEM,
      userPrompt: buildJudgeUserPrompt(doc, signatureHint),
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 12000,
      label: 'writerQa.judge',
      abortSignal: doc.operationalContext?.abortSignal,
    }),
    runShadowJudge(doc),
  ]);

  const judge = judgeResult.json || {};
  const perSpreadJudge = Array.isArray(judge.perSpread) ? judge.perSpread : [];
  const bookLevel = Array.isArray(judge.bookLevelIssues) ? judge.bookLevelIssues.map(String) : [];
  const bookLevelTags = Array.isArray(judge.bookLevelTags) ? judge.bookLevelTags.map(String) : [];
  const infantLocomotionHits = Array.isArray(judge.infantLocomotionHits) ? judge.infantLocomotionHits : [];

  // Independent signature-beat gate. The judge is asked to verify against
  // the manuscript, but if it disagrees with the deterministic preflight
  // we trust the preflight (token-presence is unambiguous).
  let signatureGateFail = false;
  if (signature.missing.length > 0) {
    const beatList = signature.missing.map(describeBeat).join('; ');
    const issue = `signature beats missing: ${signature.missing.length} of ${signature.beats.length} questionnaire anchors did not appear in any spread — ${beatList}`;
    if (!bookLevel.includes(issue)) bookLevel.push(issue);
    if (!bookLevelTags.includes('signature_beat_missing')) bookLevelTags.push('signature_beat_missing');
    signatureGateFail = true;
  }

  // Inject infant locomotion hits as per-spread tags so the rewrite loop
  // has actionable targets even if the judge missed them.
  const infantHitsBySpread = new Map();
  for (const hit of infantLocomotionHits) {
    const n = Number(hit?.spreadNumber);
    if (!Number.isFinite(n)) continue;
    const verbs = Array.isArray(hit?.verbs) ? hit.verbs.map(String) : [];
    if (verbs.length === 0) continue;
    infantHitsBySpread.set(n, verbs);
  }

  // Inject signature_beat_missing per-spread directives into the rotation
  // assignment so the rewrite loop has concrete spreads to target.
  const sigInjections = new Map(); // spreadNumber -> { issues:[], tags:[] }
  if (signature.missing.length > 0) {
    for (let i = 0; i < signature.missing.length; i++) {
      const beat = signature.missing[i];
      const sn = signature.assignments[i];
      if (!Number.isFinite(sn)) continue;
      const phrasing = (beat.key === 'calls_mom' || beat.key === 'calls_dad')
        ? `${beat.key} parent address word "${beat.text}"`
        : `questionnaire anchor ${describeBeat(beat)}`;
      const entry = sigInjections.get(sn) || { issues: [], tags: [] };
      entry.issues.push(`signature_beat_missing: surface the ${phrasing} in this spread — it is a load-bearing personalization detail from the questionnaire and the manuscript must not ship without it.`);
      if (!entry.tags.includes('signature_beat_missing')) entry.tags.push('signature_beat_missing');
      sigInjections.set(sn, entry);
    }
  }

  const bookId = doc?.operationalContext?.bookId || doc?.request?.bookId || 'n/a';

  // Merge per-spread verdicts onto the canonical spread list (1..N).
  const merged = doc.spreads.map(s => {
    const j = perSpreadJudge.find(p => Number(p?.spreadNumber) === s.spreadNumber) || {};
    const issues = Array.isArray(j.issues) ? j.issues.map(String) : [];
    const tags = Array.isArray(j.tags) ? j.tags.map(String) : [];

    const infantVerbs = infantHitsBySpread.get(s.spreadNumber);
    if (infantVerbs && infantVerbs.length > 0) {
      const issue = `infant_action_verb_in_text: locomotion verbs forbidden for PB_INFANT — ${infantVerbs.join(', ')}`;
      if (!issues.some(x => x.startsWith('infant_action_verb_in_text'))) issues.push(issue);
      if (!tags.includes('infant_action_verb_in_text')) tags.push('infant_action_verb_in_text');
    }

    const sig = sigInjections.get(s.spreadNumber);
    if (sig) {
      for (const i of sig.issues) if (!issues.includes(i)) issues.push(i);
      for (const t of sig.tags) if (!tags.includes(t)) tags.push(t);
    }

    return {
      spreadNumber: s.spreadNumber,
      pass: issues.length === 0,
      issues,
      tags,
      suggestedRewrite: j.suggestedRewrite ? String(j.suggestedRewrite) : null,
    };
  });

  // AA-CW-11: deterministic identity-rhyme audit. The LLM judge has
  // historically passed couplets ending on the same word ("cheek/cheek",
  // "Mama/Mama", "squeals/squeals") even when the prompt forbids them.
  // This pure check runs after the LLM verdict, extracts the last word
  // of each line, normalises (lowercase, strip punctuation), and forces
  // a `rhyme_fail` tag with sub-mode "identity" if either couplet ends
  // on the same surface form. The writer's rewrite loop already consumes
  // `tags` and `issues`, so no plumbing changes are needed downstream.
  const identityRhymeOffenders = [];
  for (const entry of merged) {
    const spread = doc.spreads.find(s => s.spreadNumber === entry.spreadNumber);
    const text = spread?.manuscript?.text;
    const lines = String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (lines.length < 4) continue;
    const lastWord = (line) => {
      const m = String(line).toLowerCase().match(/([a-z\u00c0-\u024f']+)[^a-z\u00c0-\u024f']*$/i);
      return m ? m[1] : '';
    };
    const w = [lastWord(lines[0]), lastWord(lines[1]), lastWord(lines[2]), lastWord(lines[3])];
    const flags = [];
    if (w[0] && w[0] === w[1]) flags.push({ pair: `${w[0]}/${w[1]}`, lines: '1+2' });
    if (w[2] && w[2] === w[3]) flags.push({ pair: `${w[2]}/${w[3]}`, lines: '3+4' });
    if (flags.length === 0) continue;
    for (const f of flags) {
      const issue = `rhyme_fail: identity rhyme on lines ${f.lines} — "${f.pair}". Both lines end on the same word; pick a real rhyme partner.`;
      if (!entry.issues.includes(issue)) entry.issues.push(issue);
    }
    if (!entry.tags.includes('rhyme_fail')) entry.tags.push('rhyme_fail');
    if (!entry.tags.includes('identity_rhyme')) entry.tags.push('identity_rhyme');
    entry.pass = false;
    identityRhymeOffenders.push({ spreadNumber: entry.spreadNumber, flags });
  }
  if (identityRhymeOffenders.length > 0) {
    console.warn(
      `[writerQa.identityRhymeAudit:${bookId}] forced rhyme_fail on ${identityRhymeOffenders.length} spread(s): ${JSON.stringify(identityRhymeOffenders)}`,
    );
  }

  // AA-CW-18 Part C: deterministic dropped-article audit. Forensics from
  // book e3f4e0c0 showed the LLM judge missing trivial determiner-drops
  // ("at sky", "by hand", "on lap", "for chin") and burning entire rewrite
  // waves on cosmetic fixes. This pure regex check forces the
  // `dropped_article` tag when a preposition is followed by a bare
  // singular countable noun with no determiner. The check is conservative
  // — it only flags an explicit short whitelist of common bare-noun
  // collocations seen in production failures, so false-positives stay rare.
  const droppedArticleOffenders = [];
  const BARE_NOUN_AFTER_PREP = new RegExp(
    // preposition followed by a singular content noun with NO determiner.
    // Restricted to a curated safe-list of bare nouns seen in production
    // fails. Add to this list deliberately — every entry must be a
    // singular countable noun that is broken without a determiner in
    // child-book voice.
    String.raw`\b(at|in|on|by|for|to|onto|into|under|over|past|with|near|inside|outside|across)\s+(sky|hand|lap|chin|cheek|sleeve|arm|leaf|blanket|seat|stall|awning|door|path|lane|street|room|bench|porch|floor|table|chair|window|cup|book|house|yard|tree|flower|cloud|moon|sun|star|cat|dog|bird|face|head|foot|knee|nose|ear|eye|mouth|toy|ball|cloth)\b(?!\s*(?:'s|s\b))`,
    'gi',
  );
  for (const entry of merged) {
    const spread = doc.spreads.find(s => s.spreadNumber === entry.spreadNumber);
    const text = spread?.manuscript?.text;
    if (!text) continue;
    const lines = String(text).split(/\n+/).map(s => s.trim()).filter(Boolean);
    const hits = [];
    for (let li = 0; li < lines.length; li += 1) {
      const line = lines[li];
      // Reset lastIndex on each line because the regex is global.
      BARE_NOUN_AFTER_PREP.lastIndex = 0;
      let m;
      while ((m = BARE_NOUN_AFTER_PREP.exec(line)) !== null) {
        hits.push({ line: li + 1, prep: m[1], noun: m[2], match: m[0] });
      }
    }
    if (hits.length === 0) continue;
    for (const h of hits) {
      const issue = `dropped_article: line ${h.line} "${h.match}" is missing a determiner. Use "${h.prep} the ${h.noun}", "${h.prep} a ${h.noun}", or "${h.prep} her/his ${h.noun}".`;
      if (!entry.issues.includes(issue)) entry.issues.push(issue);
    }
    if (!entry.tags.includes('dropped_article')) entry.tags.push('dropped_article');
    entry.pass = false;
    droppedArticleOffenders.push({ spreadNumber: entry.spreadNumber, hits });
  }
  if (droppedArticleOffenders.length > 0) {
    console.warn(
      `[writerQa.droppedArticleAudit:${bookId}] forced dropped_article on ${droppedArticleOffenders.length} spread(s): ${JSON.stringify(droppedArticleOffenders)}`,
    );
  }

  // AA-CW-20: band-conditional taste-tag demotion. At PB_INFANT, the
  // three taste tags (semantic_filler, forced_rhyme_meaning_drift,
  // fragment_line) are ADVISORY — they remain on the per-spread output
  // for observability but do NOT count toward repairPlan or pass=false.
  // The judge prompt also instructs the LLM to apply this rule; this
  // post-processing is defensive insurance in case the LLM raises pass=false
  // on advisory-only tags. Structural tags (rhyme_fail, dropped_article,
  // identity_rhyme, unrenderable_action, writer_invented_prop, etc.)
  // remain fully fatal at every band.
  // ageBand is the VALUE ('0-1' for PB_INFANT), not the key. Compare
  // against AGE_BANDS.PB_INFANT.
  const ageBand = doc?.request?.ageBand;
  const TASTE_TAGS_ADVISORY_AT_INFANT = new Set([
    'semantic_filler',
    'forced_rhyme_meaning_drift',
    'fragment_line',
  ]);
  const isAdvisoryOnly = (entry) => {
    if (ageBand !== AGE_BANDS.PB_INFANT) return false;
    if (!Array.isArray(entry.tags) || entry.tags.length === 0) return false;
    return entry.tags.every(t => TASTE_TAGS_ADVISORY_AT_INFANT.has(t));
  };
  // Effective per-spread pass = the entry has no STRUCTURAL issues.
  // Advisory-only entries flip pass back to true even if the LLM said false.
  for (const entry of merged) {
    if (!entry.pass && isAdvisoryOnly(entry)) {
      entry.pass = true;
      entry.advisoryOnly = true;
    }
  }

  const repairPlan = merged.filter(m => !m.pass);
  const judgeSaysPass = judge.pass === true;
  // AA-CW-20: at PB_INFANT, ignore judgeSaysPass=false when the only
  // failures are advisory taste tags AND no structural defects survive.
  const structuralPassOk = repairPlan.length === 0
    && bookLevel.length === 0
    && !signatureGateFail;
  const advisoryOnlyAtInfant = ageBand === AGE_BANDS.PB_INFANT
    && structuralPassOk
    && merged.some(m => m.advisoryOnly === true);
  const pass = (judgeSaysPass || advisoryOnlyAtInfant) && structuralPassOk;

  if (advisoryOnlyAtInfant) {
    const advisoryCounts = merged
      .filter(m => m.advisoryOnly)
      .map(m => ({ spreadNumber: m.spreadNumber, tags: m.tags }));
    console.log(
      `[writerQa.advisoryOnly:${bookId}] PB_INFANT manuscript passing with advisory-only taste tags on ${advisoryCounts.length} spread(s): ${JSON.stringify(advisoryCounts)}`,
    );
  }

  // Shadow diff — log to stdout so we can grep it during the rollout
  // window. Also recorded structurally on the doc via appendLlmCall.
  const shadowDiff = diffJudgeVerdicts({ pass, perSpread: merged, bookLevel, bookLevelTags }, shadowResult);
  console.log(
    `[writerQa.shadowDiff:${bookId}] authoritativePass=${shadowDiff.authoritativePass} shadowPass=${shadowDiff.shadowPass} agreement=${shadowDiff.passAgreement} onlyAuthoritative=${JSON.stringify(shadowDiff.onlyAuthoritative)} onlyShadow=${JSON.stringify(shadowDiff.onlyShadow)} shadowFailed=${shadowDiff.shadowFailed === true}`,
  );

  // Persist both calls onto the doc.
  let updatedDoc = appendLlmCall(doc, {
    stage: 'writerQa.judge',
    model: judgeResult.model,
    attempts: judgeResult.attempts,
    usage: judgeResult.usage,
  });
  if (shadowResult && shadowResult.ok) {
    updatedDoc = appendLlmCall(updatedDoc, {
      stage: 'writerQa.shadow',
      model: shadowResult.model,
      attempts: shadowResult.attempts,
      usage: shadowResult.usage,
    });
  }

  return {
    pass,
    perSpread: merged,
    bookLevel,
    bookLevelTags,
    repairPlan,
    updatedDoc,
  };
}

module.exports = {
  checkWriterDraft,
  // exported for unit tests
  JUDGE_SYSTEM,
};
