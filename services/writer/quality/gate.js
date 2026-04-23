/**
 * QualityGate — an LLM editor is the arbiter of story quality, with one
 * narrow deterministic veto on top.
 *
 * Most judgement is delegated to a children's-book-editor LLM prompt.
 * Deterministic substring / keyword checks were avoided for nuanced
 * dimensions (e.g. anecdote presence, where euphemisms like "Pffft" land
 * "fart") because they caused false positives and sent the writer into
 * pointless revision loops.
 *
 * BUT — object-for-possessive pronoun errors ("him hair", "him arm",
 * "he toes") are a documented ship-blocker with ZERO false-positive risk
 * (every noun on the whitelist only takes a possessive in that position).
 * PRE-SCAN B in the critic prompt is supposed to catch these, but the
 * LLM critic has repeatedly missed them. So after the LLM scores the book
 * we run a narrow regex over every spread and, if ANY possessive error is
 * found, we hard-override the ship decision, clamp the pronouns score, and
 * inject explicit per-spread feedback so the reviser knows exactly which
 * lines to fix. This is the ONLY deterministic check in the gate.
 *
 * The critic returns:
 *   { pass, scores: { ...dimensions }, overallScore, issues: [{ ... }], feedback }
 *
 * Dimensions scored 1-10 (see the system prompt for exact rubric):
 *   rhyme, meter, ageAppropriateness, readAloud, emotionalArc,
 *   specificity, creativity, variety, narrativeCoherence, anecdoteUsage,
 *   settingVariety, pronouns, endingAppropriateness, parentNameDiscipline,
 *   wordCount.
 *
 * The critic proposes `ship` / `pass`, but **JavaScript enforces numeric
 * floors** (`passScore`, `minDimensionScore`, `creativityFloor` from
 * WRITER_CONFIG) so an inconsistent critic cannot return ship=true with a 6.x
 * average. When numeric checks fail, `pass` is false and targeted feedback
 * (including a creativity brief when relevant) is prepended for the reviser.
 *
 * Deterministic vetoes on top of that: possessive-pronoun errors and (when
 * scored) scene continuity caps.
 */

const { WRITER_CONFIG } = require('../config');
const { BaseThemeWriter } = require('../themes/base');
const { findPossessivePronounErrors } = require('../../pronouns');
const { findIdenticalAdjacentEndWordRhymes, findOverlongWordsForYoungReader } = require('./rhymeLint');

const _llm = new BaseThemeWriter('_quality_gate');

const CRITIC_ATTEMPTS = 3;
/** Critic emits scores + issues + often long per-spread feedback — must not truncate mid-JSON (was 1800 → parse errors ~6–8k chars). */
const CRITIC_MAX_OUTPUT_TOKENS = 8192;

/** Must match the critic JSON schema in _buildSystemPrompt — used for deterministic numeric shipping gate. */
const CRITIC_DIMENSION_KEYS = [
  'rhyme', 'meter', 'ageAppropriateness', 'readAloud', 'emotionalArc',
  'specificity', 'creativity', 'variety', 'narrativeCoherence', 'anecdoteUsage',
  'settingVariety', 'pronouns', 'endingAppropriateness', 'parentNameDiscipline',
  'wordCount', 'seedArcFulfillment',
];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Normalize model output: trim, strip markdown fences, then JSON.parse.
 * @param {string} raw
 * @returns {object}
 */
function parseCriticResponse(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new Error('empty critic response');
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const parsed = JSON.parse(s);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('critic JSON was not an object');
  }
  return parsed;
}

class QualityGate {
  /**
   * Run the critic on a story.
   * @param {object} story - { spreads: [{ spread, text }] }
   * @param {object} child - { name, age, gender, anecdotes }
   * @param {object} book  - { theme, mom_name, dad_name, heartfeltNote, customDetails, ... }
   * @param {object} [opts] - { plan, missingCritical }
   * @returns {Promise<{pass, overallScore, scores, feedback, issues, criticFailed?: boolean}>}
   */
  static async check(story, child, book, opts = {}) {
    const spreads = Array.isArray(story?.spreads) ? story.spreads : [];
    if (spreads.length === 0) {
      return {
        pass: false,
        overallScore: 0,
        scores: {},
        issues: [{ dimension: 'catastrophic', note: 'Story has 0 spreads.' }],
        feedback: 'CATASTROPHIC: Story has 0 spreads. The writer produced no output.',
        criticFailed: false,
      };
    }

    const system = QualityGate._buildSystemPrompt(child, book, opts);
    const user = QualityGate._buildUserPrompt(story, child, book, opts);

    let parsed = null;
    let lastErr = null;
    for (let attempt = 0; attempt < CRITIC_ATTEMPTS; attempt++) {
      try {
        const result = await _llm.callLLM('critic', system, user, {
          jsonMode: true,
          maxTokens: CRITIC_MAX_OUTPUT_TOKENS,
        });
        const fr = String(result.finishReason || '');
        if (/MAX_TOKEN|LENGTH|length/i.test(fr)) {
          console.warn(`[writerV2] QualityGate critic hit output limit (finishReason=${result.finishReason}) — JSON may be incomplete; will retry if parse fails`);
        }
        parsed = parseCriticResponse(result.text);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`[writerV2] QualityGate critic attempt ${attempt + 1}/${CRITIC_ATTEMPTS} failed: ${err.message}`);
        if (attempt < CRITIC_ATTEMPTS - 1) {
          await sleep(400 * (attempt + 1));
        }
      }
    }

    if (!parsed) {
      return {
        pass: false,
        overallScore: 0,
        scores: {},
        issues: [{ dimension: 'critic_error', note: lastErr?.message || 'unknown' }],
        feedback: 'Quality check could not be completed after multiple attempts. Please try again shortly.',
        criticFailed: true,
      };
    }

    const scores = QualityGate._clampScores(parsed.scores || {});
    const issues = Array.isArray(parsed.issues) ? parsed.issues : [];

    // Deterministic veto: object-for-possessive pronoun errors ("him hair",
    // "him arm", "he toes", etc.). PRE-SCAN B in the critic prompt is
    // supposed to catch these, but the LLM critic has repeatedly let them
    // ship — and they are a documented ship-blocker with zero false-positive
    // risk (every whitelisted noun only takes a possessive in that position).
    // We re-introduce a narrow regex check here as a hard override so the
    // book CANNOT ship with "him hair" in it, and we inject explicit
    // per-spread feedback so the reviser knows exactly which lines to fix.
    const possessiveErrors = [];
    for (const s of spreads) {
      const errs = findPossessivePronounErrors(s?.text || '');
      for (const e of errs) possessiveErrors.push({ spread: s.spread, ...e });
    }

    const rhymeLintIssues = findIdenticalAdjacentEndWordRhymes(spreads);
    const childAge = Number(child?.age);
    const readAloudLongWords = Number.isFinite(childAge) && childAge <= 3
      ? findOverlongWordsForYoungReader(spreads, child?.name)
      : [];

    // Deterministic scene_continuity check. When the plan assigned each beat
    // a palette location, the writer's SCENE block MUST name that location
    // (the illustrator uses the SCENE verbatim as its prompt — if it doesn't
    // name the palette location, cross-spread continuity breaks). Missing
    // SCENE blocks also count as failures because they force the illustrator
    // to fall back to the raw beat description, which is what this whole
    // system was designed to replace.
    const sceneContinuityIssues = QualityGate._collectSceneContinuityIssues(spreads, opts?.plan);
    if (sceneContinuityIssues.length > 0) {
      scores.sceneContinuity = Math.min(scores.sceneContinuity || 4, 4);
      for (const sc of sceneContinuityIssues) {
        issues.push({
          dimension: 'sceneContinuity',
          spread: sc.spread,
          note: sc.note,
        });
      }
    }
    let vetoFeedback = '';
    if (possessiveErrors.length > 0) {
      scores.pronouns = Math.min(scores.pronouns || 3, 3);
      for (const e of possessiveErrors) {
        issues.push({
          dimension: 'pronouns',
          spread: e.spread,
          note: `Object pronoun used as possessive: "${e.match}" — write "his ${e.noun}" (possessive), not "${e.pronoun} ${e.noun}".`,
        });
      }
      const errorLines = possessiveErrors
        .map(e => `  - Spread ${e.spread}: "${e.match}" → use "his ${e.noun}" (…${e.context.trim()}…)`)
        .join('\n');
      vetoFeedback =
        'HARD FAIL — object pronoun used in possessive position (ship-blocker per PRE-SCAN B). '
        + 'Fix EVERY instance below before re-submitting:\n'
        + errorLines;
    }

    if (rhymeLintIssues.length > 0) {
      scores.rhyme = Math.min(scores.rhyme || 3, 3);
      const rhymeLines = rhymeLintIssues
        .map(r => `  - Spread ${r.spread}: ${r.note}`)
        .join('\n');
      for (const r of rhymeLintIssues) {
        issues.push({ dimension: 'rhyme', spread: r.spread, note: r.note });
      }
      const rhymeBlock =
        'HARD FAIL — identical-word rhyme (adjacent lines end on the same word). '
        + 'Rewrite so couplets use different final words:\n'
        + rhymeLines;
      vetoFeedback = vetoFeedback ? `${vetoFeedback}\n\n${rhymeBlock}` : rhymeBlock;
    }

    if (readAloudLongWords.length > 0) {
      scores.readAloud = Math.min(scores.readAloud || 5, 5);
      const rwLines = readAloudLongWords
        .map(r => `  - Spread ${r.spread}: ${r.note}`)
        .join('\n');
      for (const r of readAloudLongWords) {
        issues.push({ dimension: 'readAloud', spread: r.spread, note: r.note });
      }
      const rwBlock = `HARD FAIL (ages 0–3) — overlong words hurt read-aloud rhythm:\n${rwLines}`;
      vetoFeedback = vetoFeedback ? `${vetoFeedback}\n\n${rwBlock}` : rwBlock;
    }

    const values = Object.values(scores);
    const overallScore = values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : 0;
    const overallRounded = Math.round(overallScore * 10) / 10;

    const llmPass = parsed.ship === true || parsed.pass === true;
    const numericEval = QualityGate._evaluateNumericGate(scores, overallRounded);
    const numericPass = numericEval.pass;

    const pass = llmPass && numericPass && possessiveErrors.length === 0 && rhymeLintIssues.length === 0
      && readAloudLongWords.length === 0;

    let feedback = typeof parsed.feedback === 'string' && parsed.feedback.trim()
      ? parsed.feedback.trim()
      : QualityGate._synthesizeFeedback(issues);

    // Critic sometimes returns ship=true while numeric averages / floors are not met.
    // Deterministic gate overrides that so the revise loop runs.
    if (llmPass && !numericPass) {
      const numBlock = QualityGate._buildNumericGateFeedback(numericEval);
      feedback = feedback ? `${numBlock}\n\n${feedback}` : numBlock;
    }

    if (vetoFeedback) {
      feedback = feedback
        ? `${vetoFeedback}\n\nAdditional editor notes:\n${feedback}`
        : vetoFeedback;
    }

    if (sceneContinuityIssues.length > 0) {
      const block = QualityGate._sceneContinuityFeedbackBlock(sceneContinuityIssues);
      feedback = feedback ? `${feedback}\n\n${block}` : block;
    }

    return {
      pass,
      overallScore: overallRounded,
      scores,
      issues,
      feedback: pass ? '' : feedback,
      criticFailed: false,
    };
  }

  // ── Prompt construction ──────────────────────────────────────────────

  static _buildSystemPrompt(child, book, opts) {
    const theme = book?.theme || 'general';
    const isBedtime = theme === 'bedtime';
    const isCelebration = ['mothers_day', 'fathers_day', 'birthday', 'birthday_magic'].includes(theme);
    const { passScore, minDimensionScore } = WRITER_CONFIG.qualityThresholds;

    const parentWord = theme === 'fathers_day' ? 'Dad' : theme === 'mothers_day' ? 'Mom' : 'the parent';
    const momReal = (book?.mom_name || child?.anecdotes?.mom_name || '').toString().trim();
    const dadReal = (book?.dad_name || child?.anecdotes?.dad_name || '').toString().trim();

    const endingRule = isBedtime
      ? 'The ending MUST feel cozy, settling, and sleepy — soft imagery, calm pacing. A bedtime close is required.'
      : 'The ending MUST NOT use bedtime/sleep/dream/goodnight imagery. The final spreads should be warm, awake, and full of connection. Celebrations end joyful and bright.';

    const celebrationRule = isCelebration
      ? 'Celebration themes (Mother\'s Day, Father\'s Day, birthday) build toward a warm, connected, joyful climax — never quiet, never sleepy. Tantrums, crying, anger, or bedtime imagery on the last 3 spreads are a HARD FAIL.'
      : '';

    const parentNameRule = (momReal || dadReal)
      ? `The parent\'s real first name is "${momReal || dadReal}". Picture-book voice addresses the parent by relationship (${parentWord}, Mama, Papa, etc.) everywhere. The real first name may appear AT MOST ONCE across the entire book (typically in a single dedication-style beat) — OR may be omitted entirely if it doesn\'t fit gracefully. Two or more uses of the real first name is a HARD FAIL.`
      : 'No parent real name was provided. The story should address the parent by relationship only.';

    return `You are the final editor of a personalized children\'s picture book. You decide whether the book is ready to ship to a paying customer. Be strict. The standard is "a book a parent would buy in a bookstore and read to their child every night for a month."

You rate the book across 16 dimensions, each 1-10. You also decide a single boolean "ship" flag and (when ship is false) write a specific, actionable rewrite brief for the reviser.

## MANDATORY PRE-SCAN (do this FIRST, before scoring anything)

Work through the story spread by spread and collect every occurrence of the following. Do NOT skip this step — previous books have shipped with these errors because the editor glossed over them.

PRE-SCAN A — Identical-word rhyme
  For each spread, identify the final non-punctuation word of each line. If any TWO adjacent lines within a spread end on the SAME word (case-insensitive, ignoring punctuation and apostrophes), that is identical-word rhyme.
  Common trap: when the refrain ends with "Mama" / "Daddy" / "Papa" / "Mom" / "Dad", the OTHER line in that couplet often also ends on the same refrain word. Count that as identical-word rhyme.
  → For EVERY occurrence you find, add an entry to "issues" with dimension="rhyme" and the spread number, and force the rhyme score to ≤ 3.

PRE-SCAN B — Object-pronoun used as possessive
  Search every line for the substrings (case-insensitive, at word boundaries): "him hair", "him arm", "him lap", "him hand", "him foot", "him leg", "him face", "him head", "him toy", "him toys", "him book", "him cup", "him back", "him chin", "him nose", "him cheek", "him shoe", "him shoes", "him room", "him bed", "him snack", "him cape", "him bunny", "him duck" — and any other "him <noun>" that means "his <noun>". Same for "he <noun>" in possessive position.
  → For EVERY occurrence you find, add an entry to "issues" with dimension="pronouns" and the spread number and the exact phrase, and force the pronouns score to ≤ 3.

PRE-SCAN C — "X to X" echo phrases in rhyme position
  For each line, look for patterns like "cheek to cheek", "nose to nose", "hand in hand", "cheek to Mama", "cheek to nose" — an echo phrase where a body part or person is repeated across a tiny preposition, especially when it sits at the end of a rhyming line.
  → For EVERY occurrence, add an entry to "issues" with dimension="rhyme" and force the rhyme score to ≤ 4.

PRE-SCAN D — Odd line counts
  Count the lines in every spread. A spread with 1, 3, 5, or 7 lines cannot form clean AABB couplets.
  → For EVERY offending spread, add an entry to "issues" with dimension="meter" and force the meter score to ≤ 4.

PRE-SCAN E — Line-count uniformity across the book
  Every spread in the book MUST use the SAME line count — either all 2-line couplets OR all 4-line quatrains. Mixing (e.g. spreads 1-3 as couplets and 4-13 as quatrains) is a HARD FAIL.
  Procedure: count lines per spread; compute the most common count ("modal count"); list every spread whose count differs.
  → If ANY spread differs from the modal count, add an entry to "issues" with dimension="meter", list every offending spread, and force the meter score to ≤ 3. The feedback MUST tell the reviser to pick one line count and rewrite the outliers.

PRE-SCAN F — Grammatical / logical sanity per line
  For each line, ask: does it parse as standard English and describe a concrete, sensible image? Flag any of:
    - Ungrammatical prepositions or pronoun phrases ("hold me close to me", "close to him self").
    - Invented compound nouns that only exist to rhyme ("hall rug seat", "bath shop", "swim play spot" — unless established by an earlier spread).
    - Abstract closings that are not an image the illustrator can draw ("grin for more", "love that's true", "feels so right").
    - Filler syllables that carry no meaning ("tok tok, rock clock", "zoom zoom zoom" — one is fine; a compound that reads as padding is not).
  → For EVERY offending line, add an entry to "issues" with dimension="readAloud", quote the line, and force the readAloud score to ≤ 5.

PRE-SCAN G — Setting coherence (targets rhyme-bait locations, NOT every single-use place)
  Adventure / journey stories legitimately pass through many one-off places (meadow, stream, bridge) — those are FINE when they are ordinary nouns the reader understands immediately. This scan looks ONLY for three narrower problems:
    (a) An invented or unusual compound-noun location that reads as a rhyme crutch ("bath shop", "swim play spot", "hall rug seat", "bake flop stop"). Real locations the child would recognize (park, kitchen, river) are NOT flagged.
    (b) A logical contradiction across adjacent spreads: spread N says the characters are in one place (a shop) and spread N+1 places them somewhere that does not follow (a tub in a pool). If the reader cannot tell WHERE they are, that is a fail.
    (c) A location mentioned once and then abandoned without narration of the exit — only when the location itself was surprising enough to need narration (e.g. a castle, a jungle). Mundane places don't need exit narration.
  → For EVERY offending location, add an entry to "issues" with dimension="narrativeCoherence", name the location and the spread(s), and force the narrativeCoherence score to ≤ 4. Do NOT flag ordinary single-use nouns in a journey.

PRE-SCAN H — Seed-arc fulfillment (only when a storySeed is provided in the user prompt)
  The user prompt will include the storySeed's fear and narrative_spine. The book MUST dramatize this fear and resolve it:
    - The fear should surface as concrete unease somewhere in spreads 5-9 (a worry moment, a hesitation, a doubt — not just generic activity).
    - The fear should resolve in spreads 10-13 through a concrete action (a gift given, a hug received, a shared moment that closes the worry).
    - The final spread must close the arc on an image, not a restart.
  → If the fear is never dramatized OR never resolved, add an entry with dimension="seedArcFulfillment" and force that score to ≤ 4. If the seed is absent from the user prompt, do not score this dimension.

PRE-SCAN I — Refrain coverage
  If the user prompt lists a refrain (planner's repeated_phrase) OR the story obviously uses one, the refrain MUST appear at least twice and at least once in spreads 10-13 (to anchor the closing). A refrain that appears only in the middle of the book and never at the close is a FAIL.
  → If the refrain is missing from spreads 10-13, add an entry with dimension="creativity" and force the creativity score to ≤ 5.

PRE-SCAN J — Ending rhyme & final-line image
  Inspect the FINAL spread (all 2 or 4 lines):
    - Collect every end-of-line word in the final spread. NO word may appear twice in that set, even if the repetition is not on adjacent lines. "door / more / floor / more" has "more" in two rhyme positions — that is a HARD FAIL, even though the immediately adjacent pairs differ.
    - The FINAL line must be a concrete image the illustrator can draw (a hug, a spin, toast on the table, a child tucked into bed for bedtime themes), not an abstract or vague phrase ("grin for more", "love so true", "feels so right").
  → On violation add an entry with dimension="endingAppropriateness" and force that score to ≤ 4.

PRE-SCAN K — Opening location (no home / no mundane park-garden default)
  Inspect SPREAD 1. FAIL if the action is AT HOME: waking in bed; bedroom; kitchen table / living-room rug / sofa / playroom; breakfast routine; laundry, crib, pajamas start-of-day.
  ALSO FAIL spread 1 if the primary setting is a **mundane default**: generic neighborhood park or playground, backyard or private garden / flower garden / picnic garden, front yard sidewalk-only, or "the park" with no epic differentiator (lighthouse district, cliff overlook, etc.).
  Strong openings feel **epic or striking**: lighthouse rock, rope bridge, balloon deck, waterfall ledge, canyon overlook, ice cave mouth, castle approach, tide cave, observatory terrace, floating market pier, desert ridge, causeway ruins — or another invented place with similar scale (still age-safe).
  → On violation add an entry with dimension="narrativeCoherence", spread=1, note="Spread 1 opens in a banned mundane setting (home, generic park, or backyard garden). Rewrite to a vivid, epic-feeling non-domestic location and adjust the next 1-2 spreads for continuity", and force narrativeCoherence score to ≤ 4.

PRE-SCAN L — Closing must not default to "heading home"
  Inspect the FINAL 2 spreads. A closing that is literally a journey-home shot ("they head home", "walking home", "back at home", "the long walk back") is a banned formula. The closing should be a specific image invented for THIS story — a moment at wherever the story ended up, a quiet shared gesture, a final found detail, etc. A return to home IS allowed if the story organically lives there, but the narration must not reduce the closing to a generic "heading home" transition beat.
  → If the final spreads are dominated by a "heading home" / "walking home" / "back at home" formula, add an entry with dimension="endingAppropriateness", note="Closing defaults to a formulaic 'heading home' shot — invent a specific, concrete final image rooted in this story's own setting", and force endingAppropriateness to ≤ 4.

PRE-SCAN M — "Home sandwich" / dead setting loop (boring for illustrations)
  Scan spreads 1-13: tag each spread as **clearly at home (same house: kitchen, playroom, bath, bed, etc.)** vs **clearly away (park, shop, path, bus, field, public building, etc.)**. Count distinct **photographable** settings (a new park vs a new trail = two).
  **FAIL this pre-scan (book CANNOT ship, settingVariety ≤ 3, narrativeCoherence may also need work)** if BOTH are true:
    (a) **6+ spreads** read as the same home / indoor domestic space (not counting a clearly different "away" place), AND
    (b) the only "away" beats are **2 or fewer consecutive spreads** surrounded by long home blocks (the classic "mostly home, one outing, back home" loop).
  **Also FAIL** if the book has **fewer than 3 distinct non-home** physical settings in spreads 1-12 and the rest are a single home interior (weak variety even if not a perfect sandwich).
  **PASS examples:** at least 4 different **memorable / epic-feeling** places with clear transitions. **FAIL examples:** 8 spreads in living room + kitchen, or half the book in generic park + backyard garden + home, unless a theme (e.g. staycation/sick day) is explicit in the prompt.
  → On violation, add an entry with dimension="settingVariety" (and optionally "narrativeCoherence"), name the spread numbers, and force settingVariety ≤ 3. Feedback must tell the reviser to add **2+ more distinct, thrilling, non-domestic locations** in the mid-book (not another generic park beat), or redistribute beats so the story is not a home / garden / local-park sandwich.

PRE-SCAN N — Thrill vs. flat mundane spine
  Count spreads 1-12 whose dominant setting is one of: at home (any room), generic neighborhood park/playground, backyard/private garden, or a tame "walk around the block" with no larger destination.
  If **7 or more** of 12 spreads fall in that bucket (unless the user prompt explicitly demands a homebound or sick-day story), the book reads as **flat**, not thrilling.
  Also scan for emotional arc: if there is **no** clear mid-book rise (wonder, stakes, near-miss, discovery, height, race-against-time — age appropriate) and the text reads as interchangeable cozy activities, that is a weak arc.
  → On violation add entries: dimension="settingVariety" AND dimension="emotionalArc", force settingVariety ≤ 3 and emotionalArc ≤ 5. Feedback must tell the reviser to **rewrite at least half the middle spreads** into more epic, specific locations and to add one clear thrilling beat before the resolution.

If any of A, B, C, D, E, F, G, H, I, J, K, L, M, or N find ANYTHING, the book CANNOT ship — set ship=false and the feedback MUST quote every offending line and tell the reviser exactly what to change. (Exception: follow each pre-scan’s own "→" line for which dimensions to cap.)

## RATING DIMENSIONS

1. rhyme — Do couplets actually rhyme, and are the rhymes *good*? This dimension has HARD RULES:
     HARD FAIL (score ≤ 3) if ANY of the following appear anywhere in the book:
       - Identical-word rhyme: the two lines of a couplet end on the SAME word ("nose / nose", "tree / tree", "slide / slide", "splash / splash"). A word rhyming with itself is NOT a rhyme.
       - Repetition-as-rhyme: the same word or phrase repeated in rhyme position to fake a rhyme ("splash goes Mason, splash goes tub").
       - "X to X" echo rhymes in rhyme position ("nose to nose", "cheek to nose", "hand in hand") — these sound like rhymes but do not rhyme.
     WEAK (score 4-6) if more than 2 couplets rely on stale AI-common pairs (day/way, heart/start, love/above, you/true, night/light, play/day), forced inversions for meter, or noticeable slant rhymes that a parent would feel.
     STRONG (score 8-10) requires clean end-rhymes on *different* words, mostly full rhymes, and at least 2-3 fresh / multi-syllable pairs across the book (e.g. "splatter / chatter", "wobble / bobble").
2. meter — Is meter consistent (iambic tetrameter for ages 3+)? Does the rhythm feel musical? Also HARD FAIL (score ≤ 4) if any spread has an odd number of lines (3, 5, 7) — every spread must be 2 or 4 lines forming clean AABB couplets.
3. ageAppropriateness — Vocabulary and sentence length appropriate for the child\'s age. For ages 0-3: simple daily words only; penalize multi-syllable abstractions heavily.
4. readAloud — Would a parent read this aloud without stumbling? Does it sound like Dr. Seuss / Julia Donaldson?
5. emotionalArc — Does the story **build and thrill** — a hook, a rising mid-book beat (wonder, stakes, discovery — age-safe), and a satisfying resolution? Penalize hard if it reads as a flat checklist of cozy domestic or park/garden activities with no escalation.
6. specificity — Concrete actions, specific nouns. No greeting-card abstractions. No "she loved him very much" declarations.
7. creativity — At least one imaginative leap or transformation of the ordinary. Refrain deepens rather than just repeating. Fresh rhyme pairs.
8. variety — Each spread covers a DISTINCT activity or moment. Penalize repeated activities (food-sharing 3 times, etc.).
9. narrativeCoherence — One clear through-line. The reader always knows WHERE the characters are. Transitions are visible.
10. anecdoteUsage — Every anecdote the questionnaire provided must land concretely somewhere in the story. Euphemisms and natural picture-book phrasing count (a "toot" or "Pffft" lands a "farts"). But the ACTION / PERSON / OBJECT / MOMENT must be recognizably present. Score by ratio landed:
     ratio=1.0 → 10, >=0.8 → 9, >=0.6 → 7, >=0.4 → 5, <0.4 → 3.
11. settingVariety — **Strong** books: **at least 4** distinct, **memorable or epic-feeling** physical settings (not the same generic park + garden + kitchen on repeat) with narrated movement. **Fail (score 1-3):** dominance of home, backyard garden, and neighborhood park per PRE-SCAN N; or the "home sandwich" in PRE-SCAN M unless the user prompt is explicitly homebound. **Aim 7+** when the story travels through thrilling, varied places; **3-4** when settings feel mundane or repetitive.
12. pronouns — Two rules, both enforced:
     (a) Pronouns for the child match the child\'s stated gender in every reference. Any mismatch → score ≤ 4.
     (b) Object vs. possessive grammar is correct: "his hair", "his arm", "her hand", "their toys" — NEVER "him hair", "him arm", "he hand", "them toys". Object pronouns used in possessive position are a HARD FAIL → score ≤ 3. This rule applies even when the error fits the meter.
13. endingAppropriateness — ${endingRule}
14. parentNameDiscipline — ${parentNameRule} Score 10 for 0-1 uses; 6 for 2; 3 for 3; 1 for 4+.
15. wordCount — Word count per spread and total are within the age-tier limits (the writer was given these). Penalize oversized spreads proportionally.
16. seedArcFulfillment — (Only scored when a storySeed is provided.) Did the book dramatize the seed's FEAR in the middle act (spreads 5-9) and RESOLVE it in the final act (spreads 10-13)? A flat list of activities that never touches the seed's emotional question is a FAIL. A clean plant → peak → resolve arc is a STRONG. If no storySeed is provided in the user prompt, score this 10 (N/A pass-through) and do not gate on it.

${celebrationRule}

## SHIP CRITERIA (the "ship" boolean)

Set ship=true iff ALL of the following hold:
  - Overall average across all 16 dimensions ≥ ${passScore}/10
  - No single dimension scores below ${minDimensionScore}/10
  - rhyme ≥ 7 (cheap rhymes are a ship-blocker — a parent reading aloud should never feel the rhyme is lazy)
  - meter ≥ 7 (a mix of 2-line and 4-line spreads is an automatic meter HARD FAIL — see PRE-SCAN E)
  - anecdoteUsage ≥ 7
  - pronouns ≥ 9
  - narrativeCoherence ≥ 6 (setting must hang together — see PRE-SCAN G)
  - endingAppropriateness ≥ 7 (no repeated end-word in the final couplet, final line must be an image — see PRE-SCAN J)
  - parentNameDiscipline ≥ 6
  - wordCount ≥ 7
  - seedArcFulfillment ≥ 6 when a storySeed is provided (seed's fear must be dramatized and resolved — see PRE-SCAN H)
  - No HARD FAIL condition above triggered

Otherwise set ship=false and write a concrete revision brief in "feedback". The brief must:
  - Name each failing dimension and its score
  - Quote or describe the specific lines that are wrong
  - Tell the reviser exactly what to change, spread by spread where relevant
  - Preserve everything that IS working; do not ask for a full rewrite if only 2-3 spreads are weak

## OUTPUT FORMAT (JSON only, no prose outside)

{
  "ship": true | false,
  "scores": {
    "rhyme": <1-10>, "meter": <1-10>, "ageAppropriateness": <1-10>,
    "readAloud": <1-10>, "emotionalArc": <1-10>, "specificity": <1-10>,
    "creativity": <1-10>, "variety": <1-10>, "narrativeCoherence": <1-10>,
    "anecdoteUsage": <1-10>, "settingVariety": <1-10>, "pronouns": <1-10>,
    "endingAppropriateness": <1-10>, "parentNameDiscipline": <1-10>,
    "wordCount": <1-10>, "seedArcFulfillment": <1-10>
  },
  "issues": [
    { "dimension": "<name>", "spread": <int|null>, "note": "<short description>" }
  ],
  "feedback": "<revision brief as a single string, empty if ship=true>"
}`;
  }

  static _buildUserPrompt(story, child, book, opts) {
    const spreads = story.spreads || [];
    const plan = opts?.plan || null;
    const storySeed = plan?.storySeed || null;

    const anecdotesBlock = QualityGate._formatAnecdotes(child?.anecdotes || {});
    const manifestBlock = (plan && Array.isArray(plan.manifest) && plan.manifest.length > 0)
      ? plan.manifest.map(m => `  - Spread ${m.spread}: ${m.anecdote_key} → "${m.anecdote_value}"`).join('\n')
      : '';
    const customDetails = (book?.customDetails || '').toString().trim();
    const momReal = (book?.mom_name || child?.anecdotes?.mom_name || '').toString().trim();
    const dadReal = (book?.dad_name || child?.anecdotes?.dad_name || '').toString().trim();

    const parts = [];
    parts.push('## BOOK UNDER REVIEW');
    parts.push('');
    parts.push(`Theme: ${book?.theme || 'general'}`);
    parts.push(`Child: ${child?.name || '(unknown)'} (age ${child?.age ?? 'unspecified'}, gender ${child?.gender || 'unspecified'})`);
    if (momReal) parts.push(`Mom\'s real first name: ${momReal}`);
    if (dadReal) parts.push(`Dad\'s real first name: ${dadReal}`);
    if (anecdotesBlock) {
      parts.push('');
      parts.push('### Questionnaire anecdotes (each must land in the story)');
      parts.push(anecdotesBlock);
    }
    if (customDetails) {
      parts.push('');
      parts.push('### Parent-written custom details (every specific noun/person/place must land)');
      parts.push(customDetails);
    }

    // Surface the storySeed so PRE-SCAN H (seed-arc fulfillment) and
    // PRE-SCAN I (refrain coverage) have something to score against.
    // The critic should treat these as the emotional contract the book
    // promised to deliver.
    if (storySeed && typeof storySeed === 'object') {
      const fear = (storySeed.fear || '').toString().trim();
      const spine = (storySeed.narrative_spine || storySeed.storySeed || '').toString().trim();
      const setting = (storySeed.setting || '').toString().trim();
      const favObject = (storySeed.favorite_object || '').toString().trim();
      const refrain = (plan?.refrain || storySeed.repeated_phrase || '').toString().trim();
      const seedLines = [];
      if (fear) seedLines.push(`- Fear (must be dramatized in spreads 5-9 and RESOLVED in spreads 10-13): ${fear}`);
      if (spine) seedLines.push(`- Narrative spine (the emotional arc the book promised): ${spine}`);
      if (setting) seedLines.push(`- Intended setting: ${setting}`);
      if (favObject) seedLines.push(`- Favorite object (must land concretely in the story): ${favObject}`);
      if (refrain) seedLines.push(`- Refrain (must appear ≥ 2 times, at least once in spreads 10-13): "${refrain}"`);
      if (seedLines.length > 0) {
        parts.push('');
        parts.push('### Story seed (the emotional contract the book is judged against)');
        parts.push(seedLines.join('\n'));
      }
    }

    if (manifestBlock) {
      parts.push('');
      parts.push('### Planner manifest (anecdote → spread assignments the writer was given)');
      parts.push(manifestBlock);
    }

    parts.push('');
    parts.push('### Story');
    for (const s of spreads) {
      parts.push(`Spread ${s.spread}: ${s.text || ''}`);
    }

    return parts.join('\n');
  }

  static _formatAnecdotes(a) {
    const LABELS = {
      favorite_activities:  'Favorite activities',
      funny_thing:          'Funny thing they do',
      meaningful_moment:    'Meaningful moment',
      moms_favorite_moment: "Mom\'s favorite moment",
      dads_favorite_moment: "Dad\'s favorite moment",
      favorite_food:        'Favorite food',
      favorite_cake_flavor: 'Favorite cake flavor',
      favorite_toys:        'Favorite toys',
      mom_name:             "Mom\'s name",
      dad_name:             "Dad\'s name",
      calls_mom:            'What the child calls mom',
      calls_dad:            'What the child calls dad',
      other_detail:         'Other detail',
      anything_else:        'Additional',
    };
    const lines = [];
    for (const [key, label] of Object.entries(LABELS)) {
      const v = a[key];
      if (typeof v === 'string' && v.trim()) lines.push(`- ${label}: ${v.trim()}`);
    }
    return lines.join('\n');
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Enforce the same floors as the critic rubric in JS so `ship=true` cannot
   * bypass revision when scores are still weak.
   *
   * @param {Record<string, number>} scores
   * @param {number} overallRounded — mean of all numeric values in `scores`, 1dp
   * @returns {{ pass: boolean, failures: Array<{kind:string, key?:string, detail:string}> }}
   */
  static _evaluateNumericGate(scores, overallRounded) {
    const { passScore, minDimensionScore, creativityFloor } = WRITER_CONFIG.qualityThresholds;
    const failures = [];

    if (overallRounded < passScore) {
      failures.push({
        kind: 'overall',
        detail: `Overall average is ${overallRounded}/10; shipping requires ≥ ${passScore}/10.`,
      });
    }

    for (const key of CRITIC_DIMENSION_KEYS) {
      const v = scores[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        failures.push({
          kind: 'dimension',
          key,
          detail: `Missing or invalid score for "${key}" (every dimension must be scored 1–10).`,
        });
        continue;
      }
      if (v < minDimensionScore) {
        failures.push({
          kind: 'dimension',
          key,
          detail: `"${key}" is ${v}/10; minimum for shipping is ${minDimensionScore}/10.`,
        });
      }
    }

    const cr = scores.creativity;
    const creativityDimFailed = failures.some(f => f.kind === 'dimension' && f.key === 'creativity');
    if (!creativityDimFailed && (typeof cr !== 'number' || !Number.isFinite(cr) || cr < creativityFloor)) {
      const shown = typeof cr === 'number' && Number.isFinite(cr) ? `${cr}` : 'unscored';
      failures.push({
        kind: 'creativity_floor',
        key: 'creativity',
        detail: `creativity is ${shown}/10; shipping requires ≥ ${creativityFloor}/10 (imaginative leaps, fresh imagery, refrain that deepens — not a flat list of errands).`,
      });
    }

    if (typeof scores.sceneContinuity === 'number' && scores.sceneContinuity < minDimensionScore) {
      failures.push({
        kind: 'dimension',
        key: 'sceneContinuity',
        detail: `sceneContinuity is ${scores.sceneContinuity}/10; minimum for shipping is ${minDimensionScore}/10.`,
      });
    }

    return { pass: failures.length === 0, failures };
  }

  /**
   * @param {{ failures: Array<{kind:string, key?:string, detail:string}> }} evalResult
   * @returns {string}
   */
  static _buildNumericGateFeedback(evalResult) {
    const lines = evalResult.failures.map(f => `  - ${f.detail}`);
    const creativityFail = evalResult.failures.some(f => f.kind === 'creativity_floor'
      || (f.kind === 'dimension' && f.key === 'creativity'));

    const creativityBrief = creativityFail
      ? `\n\nCREATIVITY (actionable): Introduce more novel, specific imagery — distinctive verbs, surprising sensory details, and settings that are not generic domestic routines unless the brief demands it. Give at least one clear imaginative turn (metaphor, playful scale, or transformation) and make each spread feel like a new beat, not a checklist. Deepen the refrain so it lands with new emotional weight on repeats.`
      : '';

    return [
      'NUMERIC GATE — the automated editor scores do not meet shipping floors (this overrides ship=true from the critic until fixed):',
      ...lines,
      creativityBrief,
    ].join('\n');
  }

  static _clampScores(raw) {
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      out[k] = Math.max(1, Math.min(10, Math.round(n)));
    }
    return out;
  }

  /**
   * Deterministic scene-continuity check.
   *
   * Inputs:
   *   - spreads: [{ spread, text, scene }]  (scene may be '' for old-path stories)
   *   - plan:    { beats: [{ spread, location }] } (locations come from the palette)
   *
   * Rules:
   *   - If the plan locked a palette location to a spread, the spread's SCENE
   *     MUST mention that location name (or at least 2 meaningful tokens from
   *     the name — e.g. "harbor fish market at dawn" passes if the scene says
   *     "harbor market" or "fish market"). Missing SCENE is a fail.
   *   - If the plan has no palette (LLM call failed), we don't penalize — we
   *     can't score against a contract that doesn't exist.
   *
   * Intentionally narrow: this is a continuity check, not a full coherence
   * check. The LLM critic handles the rest.
   *
   * @param {Array} spreads
   * @param {object|null} plan
   * @returns {Array<{spread:number, note:string}>}
   */
  static _collectSceneContinuityIssues(spreads, plan) {
    const beats = plan && Array.isArray(plan.beats) ? plan.beats : [];
    if (beats.length === 0) return [];

    const locByBeat = new Map();
    for (const b of beats) {
      if (b && typeof b.location === 'string' && b.location.trim()) {
        locByBeat.set(Number(b.spread), b.location.trim());
      }
    }
    if (locByBeat.size === 0) return [];

    const issues = [];
    for (const s of spreads) {
      const location = locByBeat.get(Number(s?.spread));
      if (!location) continue;
      const scene = typeof s.scene === 'string' ? s.scene : '';
      if (!scene.trim()) {
        issues.push({
          spread: s.spread,
          note: `SCENE block is missing — the illustrator needs a SCENE paragraph that names "${location}" and matches the TEXT.`,
        });
        continue;
      }
      if (!QualityGate._sceneNamesLocation(scene, location)) {
        issues.push({
          spread: s.spread,
          note: `SCENE does not name the assigned palette location "${location}". Rewrite the SCENE so it explicitly takes place at "${location}" (the illustrator reuses this paragraph verbatim — if it does not name the place, continuity breaks).`,
        });
      }
    }
    return issues;
  }

  /**
   * Does `scene` name `location`? Tolerant match that allows the writer to
   * describe the place in slightly different words as long as the core
   * content words are present.
   *
   * Algorithm: take all content tokens (≥4 chars, not in a small stoplist)
   * from `location`. The scene must contain either (a) the full location
   * string (case-insensitive substring) or (b) at least 2 of those content
   * tokens. For single-word locations we require the one token.
   */
  static _sceneNamesLocation(scene, location) {
    const sLower = scene.toLowerCase();
    const locLower = location.toLowerCase();
    if (sLower.includes(locLower)) return true;

    const stop = new Set([
      'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'over', 'under',
      'near', 'behind', 'where', 'when', 'that', 'this', 'there',
      'a', 'an', 'of', 'in', 'on', 'at', 'to', 'by',
    ]);
    const tokens = locLower
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 4 && !stop.has(t));
    if (tokens.length === 0) return false;
    const matched = tokens.filter(t => sLower.includes(t));
    if (tokens.length === 1) return matched.length === 1;
    return matched.length >= 2;
  }

  static _sceneContinuityFeedbackBlock(issues) {
    const lines = issues.map(i => `  - Spread ${i.spread}: ${i.note}`);
    return [
      'SCENE CONTINUITY — rewrite the SCENE blocks below so each one names the assigned palette location and matches its TEXT. The illustrator uses the SCENE verbatim as its prompt; when the SCENE does not name the locked location, every downstream spread drifts visually.',
      ...lines,
    ].join('\n');
  }

  /**
   * Last-ditch feedback when the LLM returned ship=false but an empty
   * feedback string. Build a short brief from the issues list so the
   * reviser always has something concrete to act on.
   */
  static _synthesizeFeedback(issues) {
    if (!Array.isArray(issues) || issues.length === 0) {
      return 'Revise: fix every dimension that scored below 7. Preserve what works.';
    }
    const lines = issues.slice(0, 10).map(i => {
      const loc = (i.spread != null) ? ` (spread ${i.spread})` : '';
      return `- ${i.dimension || 'issue'}${loc}: ${i.note || ''}`.trim();
    });
    return `Revise to address:\n${lines.join('\n')}`;
  }
}

module.exports = { QualityGate };
