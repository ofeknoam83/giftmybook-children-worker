/**
 * Anecdote-driven plot generator (Writer V2).
 *
 * Replaces random plot-template selection with a TWO-PASS GPT-5.4 flow that
 * builds a bespoke 13-spread arc out of the child's real questionnaire answers.
 *
 *   Pass 1 — MANIFEST: pick 4-6 anecdotes and hard-assign each to a specific
 *            spread with an explicit use-case (central action, imagination
 *            leap, specific meal, background detail, etc.).
 *   Pass 2 — BEATS:    write the 13-spread arc with those assignments as
 *            HARD constraints, not suggestions. Each beat includes a `location`
 *            so downstream QA can score scene variety deterministically.
 *
 * Theme-specific rules baked into the prompt:
 *   - mothers_day / fathers_day: daylight ending (no bedtime), parent+child
 *     together, at least one quiet bonding beat, no cliché "being the parent
 *     for a day" / "planting in the garden" unless the anecdotes demand it.
 *   - birthday / birthday_magic: spreads 12-13 are LOCKED — spread 12 is the
 *     wish + blowing out candles, spread 13 is the first bite of cake (using
 *     favorite_cake_flavor if provided). Spreads 1-11 stay free.
 *   - All themes: 2-4 distinct settings, home is fine as one of them but
 *     must NOT be the default for 8+ spreads.
 *
 * Returns null on failure; callers fall back to template / hardcoded beats.
 *
 * @param {object} args
 * @param {string} args.theme
 * @param {object} args.child       - { name, age, gender, anecdotes, interests }
 * @param {object} args.book        - { title, heartfeltNote, ... }
 * @param {string} [args.parentName]
 * @param {boolean} args.isYoung
 * @param {number}  args.wt         - base word target
 * @param {object}  args.writer     - BaseThemeWriter instance (for callLLM)
 * @returns {Promise<{ id, name, synopsis, beats, manifest, source } | null>}
 */
async function generateAnecdoteDrivenPlot(args) {
  const { theme, child, book = {}, parentName, isYoung, wt, writer } = args;
  if (!writer || typeof writer.callLLM !== 'function') return null;

  const anecdoteItems = _collectAnecdoteItems(child, book);
  if (anecdoteItems.length === 0) return null;

  const themeLabel = _themeLabel(theme);
  const childAge = Number(child.age) || (isYoung ? 3 : 5);
  const pronoun = child.gender === 'female' ? 'she' : child.gender === 'male' ? 'he' : 'they';
  const isCelebration = theme === 'birthday' || theme === 'birthday_magic';
  const isParentTheme = theme === 'mothers_day' || theme === 'fathers_day';

  // ──────────────────────────────────────────
  // PASS 1 — MANIFEST
  // ──────────────────────────────────────────
  let manifest;
  try {
    manifest = await _runManifestPass({
      writer, theme, themeLabel, child, childAge, pronoun, parentName,
      anecdoteItems, isCelebration, isParentTheme, book,
    });
  } catch (err) {
    console.warn(`[anecdoteDrivenPlot] Manifest pass failed: ${err.message}`);
    return null;
  }
  if (!manifest || !Array.isArray(manifest.assignments) || manifest.assignments.length < 3) {
    console.warn(`[anecdoteDrivenPlot] Manifest pass returned insufficient assignments`);
    return null;
  }

  // ──────────────────────────────────────────
  // PASS 2 — BEATS
  // ──────────────────────────────────────────
  let beatsPayload;
  try {
    beatsPayload = await _runBeatsPass({
      writer, theme, themeLabel, child, childAge, pronoun, parentName,
      anecdoteItems, manifest, isCelebration, isParentTheme, isYoung, wt, book,
    });
  } catch (err) {
    console.warn(`[anecdoteDrivenPlot] Beats pass failed: ${err.message}`);
    return null;
  }
  if (!beatsPayload || !Array.isArray(beatsPayload.beats) || beatsPayload.beats.length < 10) {
    console.warn(`[anecdoteDrivenPlot] Beats pass returned insufficient beats`);
    return null;
  }

  const beats = _normalizeBeats(beatsPayload.beats, isYoung, wt, isCelebration);

  const slug = (manifest.working_title || beatsPayload.synopsis || theme)
    .toString().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

  return {
    id: `anecdote_${theme}_${slug || Date.now()}`,
    name: manifest.working_title || book.title || `${themeLabel} — anecdote-driven`,
    synopsis: beatsPayload.synopsis || manifest.working_title || `A personalized ${themeLabel} story`,
    beats,
    manifest: manifest.assignments,
    source: 'anecdote_driven',
  };
}

// ──────────────────────────────────────────
// PASS 1 — MANIFEST
// ──────────────────────────────────────────

async function _runManifestPass(ctx) {
  const {
    writer, theme, themeLabel, child, childAge, pronoun, parentName,
    anecdoteItems, isCelebration, isParentTheme, book,
  } = ctx;

  const systemPrompt = `You are a personal-story architect for children's picture books. Your job is NOT to write a generic story — it is to turn THIS child's specific real details into the backbone of a bespoke 13-spread picture book.

You will be given a list of personal anecdotes (favorite activities, foods, funny things they do, meaningful moments, what they call their parents, favorite toys, etc.).

Pick 4 to 6 of those anecdotes and HARD-ASSIGN each one to a specific spread (1-13) with a specific ROLE in that beat. Do NOT pick more than 6. Do NOT pick fewer than 4 if 4 good options exist.

ASSIGNMENT RULES:
- Prefer anecdotes that create vivid, visual moments (a specific food, toy, activity, place, funny habit) over abstract ones.
- Each assignment's "use" must be concrete: "the specific meal on the plate", "the central action of the beat", "the imagination leap", "the ritual they share", "the background detail in the room".
- Spread assignments must make narrative sense — an opening anecdote (favorite ritual, morning habit) belongs early; a meaningful shared moment belongs around the emotional peak (spread 9-11); a funny thing can go anywhere.
- Do NOT double-book the same anecdote to two different spreads.
- Do NOT assign more than ONE anecdote to the same spread unless they naturally co-occur (food + activity at the table is fine).

THEME CONSTRAINTS:
${_themeConstraintsForManifest(theme, isCelebration, isParentTheme, parentName, child)}

OUTPUT STRICT JSON:
{
  "working_title": "a short, concrete working title that captures this specific story",
  "assignments": [
    { "spread": <1-13>, "anecdote_key": "<one of the provided keys>", "anecdote_value": "<the specific value, verbatim>", "use": "<how it shows up in this beat>" },
    ...
  ]
}

Return 4-6 assignments total.`;

  const anecdoteBlock = anecdoteItems.map(a => `- ${a.key}: ${a.value}`).join('\n');
  const userPrompt = `Child: ${child.name}, age ${childAge}, pronouns ${pronoun}/${pronoun === 'she' ? 'her' : pronoun === 'he' ? 'him' : 'them'}
Theme: ${themeLabel}${parentName ? `\nParent they address as: ${parentName}` : ''}${book.title ? `\nCover title (if already approved): "${book.title}"` : ''}${book.heartfeltNote ? `\nHeartfelt note from the person ordering the book: "${book.heartfeltNote}"` : ''}

REAL ANECDOTES ABOUT THIS CHILD:
${anecdoteBlock}

Pick 4-6 of these anecdotes and hard-assign each to a specific spread with a specific use. Return JSON only.`;

  const result = await writer.callLLM('planner', systemPrompt, userPrompt, {
    jsonMode: true,
    maxTokens: 1500,
    temperature: 0.6,
  });

  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch (err) {
    throw new Error(`Manifest JSON parse failed: ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.assignments)) {
    throw new Error('Manifest missing assignments array');
  }

  // Normalize + validate
  const seenSpreads = new Set();
  const assignments = [];
  for (const a of parsed.assignments) {
    const spread = Number(a.spread);
    if (!Number.isFinite(spread) || spread < 1 || spread > 13) continue;
    const key = String(a.anecdote_key || '').trim();
    const value = String(a.anecdote_value || '').trim();
    const use = String(a.use || '').trim();
    if (!key || !value || !use) continue;
    // Allow up to 2 assignments on the same spread (food + activity), no more
    const duplicates = assignments.filter(x => x.spread === spread).length;
    if (duplicates >= 2) continue;
    assignments.push({ spread, anecdote_key: key, anecdote_value: value, use });
    seenSpreads.add(spread);
  }
  return {
    working_title: (parsed.working_title || '').toString().trim(),
    assignments,
  };
}

// ──────────────────────────────────────────
// PASS 2 — BEATS
// ──────────────────────────────────────────

async function _runBeatsPass(ctx) {
  const {
    writer, theme, themeLabel, child, childAge, pronoun, parentName,
    anecdoteItems, manifest, isCelebration, isParentTheme, isYoung, wt, book,
  } = ctx;

  const manifestBlock = manifest.assignments
    .sort((a, b) => a.spread - b.spread)
    .map(a => `- Spread ${a.spread}: MUST include "${a.anecdote_value}" (${a.anecdote_key}) — role: ${a.use}`)
    .join('\n');

  const systemPrompt = `You are a children's picture-book story architect. You are designing a bespoke 13-spread story arc for THIS specific child, NOT a generic ${themeLabel} book.

STRUCTURE:
- Exactly 13 spreads.
- Each beat has: spread (1-13), beat (a short uppercase label), description (1-2 sentences describing what happens in the illustration and prose), location (the physical setting — e.g. "kitchen", "park by the oak tree", "backyard", "bakery", "ocean"), wordTarget (integer).
- Use 2-4 DISTINCT locations across the 13 spreads. Home is allowed as ONE location but must NOT account for 8+ spreads. Prefer locations that come from the anecdotes (the park they always go to, the kitchen when food is mentioned, the bakery if favorite_cake_flavor, etc.).
- Keep consecutive beats in the same scene sharing the same location. When you change location, make the transition visible in the description.
- Spread 9 is the quiet-wonder beat with the fewest words.
- Spread 13 is the closing line — echo spread 1.

HARD ANECDOTE CONSTRAINTS (these override everything else):
${manifestBlock}
Each of these spreads MUST concretely depict the assigned anecdote in the description. Do not paper over them with generic language.

THEME CONSTRAINTS:
${_themeConstraintsForBeats(theme, isCelebration, isParentTheme, parentName, child)}

OUTPUT STRICT JSON:
{
  "synopsis": "one-sentence plot summary",
  "beats": [
    { "spread": 1, "beat": "HOOK", "description": "...", "location": "...", "wordTarget": 28 },
    ...
    { "spread": 13, "beat": "CLOSING", "description": "...", "location": "...", "wordTarget": 15 }
  ]
}`;

  const anecdoteBlock = anecdoteItems.map(a => `- ${a.key}: ${a.value}`).join('\n');
  const userPrompt = `Child: ${child.name}, age ${childAge}, pronouns ${pronoun}/${pronoun === 'she' ? 'her' : pronoun === 'he' ? 'him' : 'them'}
Theme: ${themeLabel}${parentName ? `\nParent: ${parentName}` : ''}${book.title ? `\nApproved cover title: "${book.title}"` : ''}
Age tier: ${isYoung ? 'young-picture (ages 0-3) — simpler vocabulary, shorter beats' : 'picture-book (ages 4-6)'}
Word target per spread: ~${wt} (reduce to ~${isYoung ? 12 : 15} for spreads 9 and 13)

ALL ANECDOTES (for context; the manifest above is what MUST land):
${anecdoteBlock}

Now write the 13 beats as JSON. Every beat MUST have a location field. The manifest assignments above are non-negotiable — those specific anecdotes must be concretely present in those specific spreads.`;

  const result = await writer.callLLM('planner', systemPrompt, userPrompt, {
    jsonMode: true,
    maxTokens: 3000,
    temperature: 0.7,
  });

  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch (err) {
    throw new Error(`Beats JSON parse failed: ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.beats)) {
    throw new Error('Beats payload missing beats array');
  }
  return {
    synopsis: (parsed.synopsis || '').toString().trim(),
    beats: parsed.beats,
  };
}

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

function _normalizeBeats(rawBeats, isYoung, wt, isCelebration) {
  const beats = rawBeats
    .map((b, i) => {
      const spread = Number(b.spread) || (i + 1);
      const beatLabel = (b.beat || `SPREAD_${spread}`).toString().trim().toUpperCase().replace(/\s+/g, '_');
      const description = (b.description || '').toString().trim();
      const location = (b.location || '').toString().trim();
      if (!description) return null;
      const quietBeat = spread === 9 || spread === 13;
      let wordTarget = Number(b.wordTarget);
      if (!Number.isFinite(wordTarget) || wordTarget <= 0) {
        wordTarget = quietBeat ? (isYoung ? 12 : 15) : wt;
      }
      return { spread, beat: beatLabel, description, location, wordTarget };
    })
    .filter(Boolean)
    .slice(0, 13)
    .sort((a, b) => a.spread - b.spread);

  if (isCelebration && beats.length === 13) {
    const cakeTerms = /(cake|candle|candles|wish|blow|blew|frosting|icing|bite)/i;
    const twelfth = beats[11];
    const thirteenth = beats[12];
    if (twelfth && !cakeTerms.test(twelfth.description)) {
      const sep = twelfth.description.endsWith('.') ? ' ' : '. ';
      twelfth.description = `${twelfth.description}${sep}The cake with lit candles is in front of them — they lean in, make a wish, and blow out the candles as everyone cheers.`;
      if (!twelfth.beat || twelfth.beat === 'SPREAD_12') twelfth.beat = 'WISH_AND_BLOW';
    }
    if (thirteenth && !cakeTerms.test(thirteenth.description)) {
      const sep = thirteenth.description.endsWith('.') ? ' ' : '. ';
      thirteenth.description = `${thirteenth.description}${sep}The first bite of cake, pure joy on their face.`;
      if (!thirteenth.beat || thirteenth.beat === 'SPREAD_13') thirteenth.beat = 'FIRST_BITE_JOY';
    }
  }

  return beats;
}

function _themeLabel(theme) {
  return (theme || 'story').replace(/_/g, ' ');
}

function _themeConstraintsForManifest(theme, isCelebration, isParentTheme, parentName, child) {
  const lines = [];
  if (isParentTheme) {
    const who = theme === 'mothers_day' ? 'mother' : 'father';
    lines.push(`- This is a ${who.toUpperCase()} book. The ${who} (${parentName || who}) is a co-protagonist. Pick at least one anecdote that shows the ${who}-child bond directly (favorite_activities, meaningful_moment, moms_favorite_moment, calls_mom/calls_dad).`);
    lines.push(`- Avoid clichés: do NOT default to "being mom/dad for a day" or "planting in the garden" unless the anecdotes specifically call for it. The story must feel like THIS pair, not a generic parent book.`);
  }
  if (isCelebration) {
    lines.push(`- This is a BIRTHDAY book. The final beats will depict the cake + candles + wish (spread 12) and the first bite of cake (spread 13). Do NOT assign anecdotes to spreads 12-13 unless it's favorite_cake_flavor. Favorite_cake_flavor (if present) MUST be assigned to spread 12 or 13.`);
    lines.push(`- Spreads 1-11 should feel like a real celebration for THIS child, shaped by their favorite activities, toys, foods, friends, and quirks — not a generic "party then cake" sequence.`);
  }
  if (!isCelebration && !isParentTheme) {
    lines.push(`- Pick anecdotes that create a distinctive through-line for this specific child.`);
  }
  lines.push(`- The child is ${child.age ? `${child.age} years old` : 'young'}. Prefer anecdotes a child this age would recognize as "that's me".`);
  return lines.join('\n');
}

function _themeConstraintsForBeats(theme, isCelebration, isParentTheme, parentName, child) {
  const lines = [];
  if (isParentTheme) {
    const who = theme === 'mothers_day' ? 'mother' : 'father';
    lines.push(`- This is a ${who.toUpperCase()} book. ${parentName || who} is a co-protagonist and should appear in most spreads.`);
    lines.push(`- Ending: DAYLIGHT and WARM. Never a bedtime / sleep / tucking-in / goodnight ending. The last image shows ${child.name} and ${parentName || 'the ' + who} together, awake, joyful.`);
    lines.push(`- At least one beat must be a quiet bonding moment (cuddling, reading together, eating together, noticing something specific) — pull from the anecdotes when possible.`);
    lines.push(`- At least one beat should be a gentle role-reversal where ${child.name} takes care of ${parentName || 'the ' + who}.`);
    lines.push(`- At least 3 beats must literally reference a concrete anecdote detail (named food, named place, named toy, named activity).`);
  }
  if (isCelebration) {
    lines.push(`- Spread 12 MUST be the wish-and-blow: cake in front of ${child.name}, candles lit, eyes closing for a wish, candles blown out. Use beat label "WISH_AND_BLOW".`);
    lines.push(`- Spread 13 MUST be the first-bite joy: ${child.name} taking the first bite of cake${child.anecdotes && child.anecdotes.favorite_cake_flavor ? ` (${child.anecdotes.favorite_cake_flavor})` : ''}, pure happiness. Use beat label "FIRST_BITE_JOY".`);
    lines.push(`- Spreads 1-11 are free — build the personalized arc from the anecdotes. Do NOT front-load all party prep at home; use 2-4 distinct settings so it doesn't feel like a generic cake countdown.`);
    lines.push(`- Ending: DAYLIGHT / awake / joyful — never a bedtime or sleep ending.`);
  }
  if (!isCelebration && !isParentTheme) {
    lines.push(`- Build the arc around the manifest anecdotes. Let them shape the settings and actions; don't treat them as cosmetic details.`);
  }
  return lines.join('\n');
}

function _collectAnecdoteItems(child, book) {
  const items = [];
  const a = child?.anecdotes || {};
  const push = (k, v) => {
    if (!v) return;
    const val = typeof v === 'string' ? v.trim() : String(v).trim();
    if (val) items.push({ key: k, value: val });
  };
  push('favorite_activities', a.favorite_activities);
  push('funny_thing', a.funny_thing);
  push('meaningful_moment', a.meaningful_moment);
  push('moms_favorite_moment', a.moms_favorite_moment);
  push('favorite_food', a.favorite_food);
  push('favorite_cake_flavor', a.favorite_cake_flavor);
  push('favorite_toys', a.favorite_toys);
  push('calls_mom', a.calls_mom);
  push('calls_dad', a.calls_dad);
  push('other_detail', a.other_detail);
  push('anything_else', a.anything_else);
  if (Array.isArray(child?.interests) && child.interests.length) {
    push('interests', child.interests.join(', '));
  }
  if (book?.customDetails && typeof book.customDetails === 'string') {
    push('custom_details', book.customDetails);
  }
  return items;
}

module.exports = { generateAnecdoteDrivenPlot };
