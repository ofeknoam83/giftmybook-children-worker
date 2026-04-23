/**
 * Father's Day ThemeWriter — mirrors Love to mom structure for dads.
 *
 * Based on children's writing craft research:
 * - AABB couplets in iambic tetrameter (ages 2-5), looser rhythm for 0-2
 * - Mandatory refrain using child's word for dad
 * - Emotional arc: specific -> deepening -> test -> climax -> resolution
 * - Anti-AI-flatness: concrete nouns, actions not declarations, no greeting card language
 */

const { BaseThemeWriter } = require('./base');
const { buildSystemPrompt } = require('../prompts/system');
const { checkAndFixPronouns } = require('../quality/pronoun');
const { sanitizeNonLatinChars } = require('../quality/sanitize');
const { selectPlotTemplate, matchTitleToPlot, isPlaceholderTitle, generateAnecdoteDrivenPlot } = require('./plots');
const { buildFavoriteObjectLock } = require('./anecdotes');
const { appendLocationPaletteSection, appendSceneRulesSection, parseWriterOutput } = require('./generic');

class FathersDayWriter extends BaseThemeWriter {
  constructor() {
    super('fathers_day');
  }

  /**
   * Get the child's word for their father.
   * @param {object} child - { anecdotes: { calls_dad }, ... }
   * @param {object} book - { dad_name, ... }
   * @returns {string}
   */
  getParentName(child, book) {
    return child.anecdotes?.calls_dad || book?.dad_name || 'Daddy';
  }

  /**
   * Return father-specific story beats for the planner.
   * @returns {string[]}
   */
  getThemeBeats() {
    return [
      'Shared doing/building together',
      'Physical play (lifting, racing, rough-housing)',
      'Teaching moments (riding bike, tying shoes)',
      "Dad's quiet softness (bedtime stories, carrying sleeping child)",
    ];
  }

  /**
   * Plan the story beats for a Father's Day book.
   * @param {object} child - { name, age, gender, anecdotes, ... }
   * @param {object} book - { theme, format, ... }
   * @param {object} [opts]
   * @param {object} [opts.storySeed] - Optional pre-computed seed (beats, refrain) from upstream brainstorm.
   * @returns {object} plan with beats, refrain, ageTier, wordTargets
   */
  async plan(child, book, opts = {}) {
    const ageTier = this.getAgeTier(child.age);
    const spreadCount = this.getSpreadCount(child.age);
    const wordLimits = this.getWordLimits(child.age);
    const parentName = this.getParentName(child, book);
    const pronouns = this.getPronouns(child);

    const storySeed = opts.storySeed || null;
    const seedBeats = Array.isArray(storySeed?.beats) && storySeed.beats.length > 0
      ? storySeed.beats
      : null;

    // Anecdote-driven GPT-5.4 plot is preferred when anecdotes exist and no
    // upstream seed is forcing a particular shape.
    let anecdotePlot = null;
    if (!seedBeats && child.anecdotes && Object.keys(child.anecdotes).length > 0 && !book.plotId) {
      try {
        const isYoung = ageTier === 'young-picture';
        const wt = isYoung ? 16 : 28;
        anecdotePlot = await generateAnecdoteDrivenPlot({
          theme: 'fathers_day',
          child,
          book,
          parentName,
          isYoung,
          wt,
          writer: this,
          storySeed,
        });
        if (anecdotePlot) {
          this._selectedPlot = anecdotePlot;
          this._manifest = anecdotePlot.manifest;
          console.log(`[writerV2] Using anecdote-driven plot "${anecdotePlot.id}" for fathers_day (${anecdotePlot.manifest?.length || 0} anecdote assignments)`);
        }
      } catch (err) {
        console.warn(`[writerV2] Anecdote-driven plot generation failed for fathers_day: ${err.message}`);
      }
    }

    if (!anecdotePlot && !seedBeats && !book.plotId && book.title) {
      try {
        const matchedId = await matchTitleToPlot(book.title, 'fathers_day');
        if (matchedId) book = { ...book, plotId: matchedId };
      } catch (err) {
        console.warn(`[writerV2] Title-to-plot matching failed for "${book.title}": ${err.message}`);
      }
    }

    let beats;
    let usedSeed = false;
    if (anecdotePlot) {
      beats = anecdotePlot.beats;
    } else if (seedBeats) {
      beats = seedBeats;
      usedSeed = true;
      this._storySeed = storySeed;
    } else {
      beats = this._buildBeats(ageTier, spreadCount, child, parentName, book);
    }

    const refrain = this._chooseRefrain(child, parentName, usedSeed ? storySeed : null);

    // Skip the generic enrichment pass for anecdote-driven or seed-driven
    // beats — they were already personalized upstream and re-enriching
    // dilutes the work.
    let enrichedBeats = beats;
    if (!anecdotePlot && !usedSeed && child.anecdotes && Object.keys(child.anecdotes).length > 0) {
      try {
        enrichedBeats = await this._enrichPlanWithLLM(beats, child, book, parentName, ageTier);
      } catch (err) {
        console.warn(`[writerV2] Plan enrichment failed, using template beats: ${err.message}`);
      }
    }

    const plot = this._selectedPlot;

    let palette = null;
    try {
      palette = await this.buildLocationPalette({
        child,
        book,
        beats: enrichedBeats,
        storySeed: storySeed || null,
      });
    } catch (err) {
      console.warn(`[writerV2] buildLocationPalette failed for fathers_day: ${err.message}`);
    }
    const beatsWithLocations = palette
      ? this.applyPaletteToBeats(enrichedBeats, palette)
      : enrichedBeats;
    if (palette) {
      const names = palette.palette.map(p => p.name);
      console.log(`[writerV2] Location palette for fathers_day (${names.length}): ${names.join(' | ')}`);
    }

    return {
      beats: beatsWithLocations,
      refrain,
      ageTier,
      spreadCount: { min: spreadCount.min, max: spreadCount.max, target: Math.min(spreadCount.max, beatsWithLocations.length) },
      wordTargets: {
        total: wordLimits.maxWords,
        perSpread: wordLimits.wordsPerSpread,
      },
      parentName,
      pronouns,
      childName: child.name,
      plotId: plot?.id || null,
      plotName: plot?.name || null,
      plotSynopsis: plot?.synopsis || null,
      manifest: anecdotePlot?.manifest || null,
      // Always surface the upstream seed so downstream prompt builders
      // (e.g. FAVORITE OBJECT LOCK) can read it. See mothers_day.js.
      storySeed: storySeed || null,
      locationPalette: palette,
    };
  }

  /**
   * Write the story text based on the plan.
   * @param {object} plan - from plan()
   * @param {object} child
   * @param {object} book
   * @returns {{ spreads: Array<{ spread: number, text: string }>, _model: string, _ageTier: string }}
   */
  async write(plan, child, book) {
    const systemPrompt = buildSystemPrompt('fathers_day', plan.ageTier, child, book, { role: 'writer' });
    const userPrompt = this._buildWritePrompt(plan, child, book);

    const result = await this.callLLM('writer', systemPrompt, userPrompt, {
      maxTokens: 4000,
    });

    let { spreads, outfitLock } = parseWriterOutput(this, result.text);

    // Validate structure and retry if needed
    const validation = this.validateStructure(spreads, child.age);
    if (!validation.valid && spreads.length < plan.spreadCount.min) {
      console.warn(`[writerV2] First write attempt has issues: ${validation.issues.join('; ')}. Retrying...`);
      const retryResult = await this.callLLM('writer', systemPrompt, userPrompt + '\n\nIMPORTANT: You MUST write exactly ' + plan.spreadCount.target + ' spreads.', {
        maxTokens: 4000,
        temperature: 0.9,
      });
      const ret = parseWriterOutput(this, retryResult.text);
      if (ret.spreads.length >= plan.spreadCount.min) {
        spreads = ret.spreads;
        if (ret.outfitLock) outfitLock = ret.outfitLock;
      }
    }

    // Fix pronouns
    checkAndFixPronouns(spreads, child.gender);

    // Strip dashes from story text (em dash, en dash, hyphen between words)
    for (const s of spreads) {
      if (s.text) {
        s.text = s.text
          .replace(/\s*[\u2014\u2013]\s*/g, ', ')   // em/en dash → comma
          .replace(/(?<=[a-zA-Z])\s*-\s*(?=[a-zA-Z])/g, ', ');  // word-dash-word → comma
      }
    }

    sanitizeNonLatinChars(spreads);

    return {
      spreads,
      _model: result.model,
      _ageTier: plan.ageTier,
      _outfitLock: outfitLock || null,
    };
  }

  /**
   * Revise the story based on quality feedback.
   * @param {object} story - { spreads, _model, _ageTier }
   * @param {string} feedback - specific revision instructions
   * @param {object} child
   * @param {object} book
   * @returns {{ spreads: Array<{ spread: number, text: string }>, _model: string, _ageTier: string }}
   */
  async revise(story, feedback, child, book) {
    const ageTier = story._ageTier || this.getAgeTier(child.age);
    const systemPrompt = buildSystemPrompt('fathers_day', ageTier, child, book, { role: 'reviser' });

    const currentText = story.spreads.map(s => {
      const lines = [`---SPREAD ${s.spread}---`, 'TEXT:', s.text || ''];
      if (s.scene) lines.push('SCENE:', s.scene);
      return lines.join('\n');
    }).join('\n\n');

    const userPrompt = `Here is the current story with its scene descriptions:\n\n${currentText}\n\n## REVISION FEEDBACK\n\n${feedback}\n\nRevise the story to address ALL of the issues above. Keep the same number of spreads (${story.spreads.length}). Preserve the emotional arc and refrain. Fix the specific issues identified.\n\nOUTPUT FORMAT — EVERY spread MUST still include BOTH a TEXT: block and a SCENE: block:\n\n---SPREAD 1---\nTEXT:\n<story lines>\nSCENE:\n<single-paragraph scene description — ~40-70 words — that matches the TEXT you just revised and locks the assigned palette location>\n\nRewrite the SCENE when you change the TEXT so the two stay aligned. Never omit either block.`;

    const result = await this.callLLM('reviser', systemPrompt, userPrompt, {
      maxTokens: 4000,
    });

    const parsed = parseWriterOutput(this, result.text);
    let spreads = parsed.spreads;
    const newOutfit = parsed.outfitLock || story._outfitLock || null;

    // If revision parsing failed, keep original
    if (spreads.length < story.spreads.length * 0.7) {
      console.warn(`[writerV2] Revision produced only ${spreads.length} spreads (expected ~${story.spreads.length}), keeping original`);
      return story;
    }

    const priorBySpread = new Map();
    for (const s of story.spreads) priorBySpread.set(s.spread, s.scene || '');
    for (const s of spreads) {
      if (!s.scene) s.scene = priorBySpread.get(s.spread) || '';
    }

    checkAndFixPronouns(spreads, child.gender);

    // Strip dashes from story TEXT only — leave the SCENE field untouched.
    for (const s of spreads) {
      if (s.text) {
        s.text = s.text
          .replace(/\s*[\u2014\u2013]\s*/g, ', ')
          .replace(/(?<=[a-zA-Z])\s*-\s*(?=[a-zA-Z])/g, ', ');
      }
    }

    sanitizeNonLatinChars(spreads);

    return {
      spreads,
      _model: result.model,
      _ageTier: ageTier,
      _outfitLock: newOutfit,
    };
  }

  // ── Private helpers ──

  _buildBeats(ageTier, spreadCount, child, parentName, book = {}) {
    const isYoung = ageTier === 'young-picture';
    const wt = isYoung ? 16 : 28;

    const plotTemplate = selectPlotTemplate('fathers_day', { plotId: book.plotId });
    if (plotTemplate) {
      this._selectedPlot = plotTemplate;
      return plotTemplate.beats({ child, isYoung, wt, parentName: parentName || 'Daddy', book, theme: 'fathers_day' });
    }

    this._selectedPlot = null;
    if (isYoung) {
      return this._buildYoungPictureBeats(child, parentName);
    }
    return this._buildPictureBookBeats(child, parentName);
  }

  /**
   * Young Picture Book (ages 0-3): 13 spreads.
   * Simpler vocabulary, more repetition, shorter per-spread text.
   */
  _buildYoungPictureBeats(child, parentName) {
    return [
      { spread: 1, beat: 'OPENING', description: `Open OUT IN THE WORLD — NOT at home. Place ${child.name} and ${parentName} in a specific non-home location (park, splash pad, garden gate, workshop doorway, backyard, park path, meadow). Mid-action, sensory, concrete.`, wordTarget: 16 },
      { spread: 2, beat: 'TOGETHERNESS', description: `Soft hint: a small moment showing how they work together. Use child's anecdote if available.`, wordTarget: 18 },
      { spread: 3, beat: 'RITUAL', description: `Soft hint: something only THIS pair does — a funny handshake, ${parentName}'s signature move, a shared joke.`, wordTarget: 18 },
      { spread: 4, beat: 'RISING', description: `Soft hint: the activity deepens or a new place opens up. Anticipation and excitement.`, wordTarget: 18 },
      { spread: 5, beat: 'PARENT_SHINES', description: `Soft hint: ${parentName} does something that amazes ${child.name} — a skill, a trick, strength, gentleness.`, wordTarget: 18 },
      { spread: 6, beat: 'LAUGHTER', description: `Soft hint: a funny or playful beat — physical comedy, a shared joke, something sideways.`, wordTarget: 18 },
      { spread: 7, beat: 'BREATH', description: `Soft hint: a quieter beat — side-by-side, watching, focusing together. The story breathes before the peak.`, wordTarget: 16 },
      { spread: 8, beat: 'BIG_MOMENT', description: `Soft hint: the payoff they've been building toward — a destination reached or a project nearly finished.`, wordTarget: 18 },
      { spread: 9, beat: 'PEAK_JOY', description: `Soft hint: triumph. High-five, victory dance, the finished thing. Maximum energy. Physical, specific.`, wordTarget: 18 },
      { spread: 10, beat: 'CHILD_LEADS', description: `Soft hint: ${child.name} surprises ${parentName} — shows what they learned, takes a turn, makes a gift. Warm role reversal.`, wordTarget: 18 },
      { spread: 11, beat: 'BOND', description: `Soft hint: a shared look, a word, a gesture. Emotional high — deeper, not louder.`, wordTarget: 16 },
      { spread: 12, beat: 'RESOLUTION_1', description: `Invent this beat. NOT a generic "journey home" / "heading home" / "walking home" shot (banned formula). A still moment at wherever they are, the finished project admired in place, a shared look, a kept token.`, wordTarget: 16 },
      { spread: 13, beat: 'CLOSING', description: `The last line. Invent a concrete, specific closing image for THIS story. Beautiful, warm, awake. NO "heading home" formula. NOT a goodnight.`, wordTarget: 12 },
    ];
  }

  /**
   * Picture Book (ages 4-6): 13 spreads.
   * Richer vocabulary, compound sentences, more narrative depth.
   */
  _buildPictureBookBeats(child, parentName) {
    return [
      { spread: 1, beat: 'OPENING', description: `Open OUT IN THE WORLD — NOT at home. Place ${child.name} and ${parentName} in a specific non-home location (park, workshop doorway, garden gate, path to a favorite spot, stream, backyard mid-project). Mid-action, vivid, particular.`, wordTarget: 30 },
      { spread: 2, beat: 'TOGETHERNESS', description: `Soft hint: a moment showing how they work together. Use child's anecdote.`, wordTarget: 30 },
      { spread: 3, beat: 'RITUAL', description: `Soft hint: something only THIS pair does — a funny handshake, ${parentName}'s signature move, a shared joke from the questionnaire.`, wordTarget: 30 },
      { spread: 4, beat: 'RISING', description: `Soft hint: the activity deepens or a new place opens up. Anticipation and excitement build.`, wordTarget: 28 },
      { spread: 5, beat: 'PARENT_SHINES', description: `Soft hint: ${parentName} does something that amazes ${child.name} — a skill, strength, gentleness. The hero beat.`, wordTarget: 28 },
      { spread: 6, beat: 'LAUGHTER', description: `Soft hint: a funny or playful beat — physical comedy, stick swords, something sideways.`, wordTarget: 28 },
      { spread: 7, beat: 'BREATH', description: `Soft hint: a quieter beat — side-by-side, watching, a teaching moment.`, wordTarget: 25 },
      { spread: 8, beat: 'BIG_MOMENT', description: `Soft hint: the payoff — a destination reached or project nearly finished. Use meaningful_moment from questionnaire.`, wordTarget: 25 },
      { spread: 9, beat: 'PEAK_JOY', description: `Soft hint: triumph. High-five, victory dance, the big reveal. Maximum energy. Physical, specific.`, wordTarget: 25 },
      { spread: 10, beat: 'CHILD_LEADS', description: `Soft hint: ${child.name} surprises or impresses ${parentName} — shows what they learned, takes a turn, makes a gift. Warm role reversal.`, wordTarget: 25 },
      { spread: 11, beat: 'BOND', description: `Soft hint: a shared look, a word, a gesture. Emotional high point — deeper, not louder.`, wordTarget: 25 },
      { spread: 12, beat: 'RESOLUTION_1', description: `Invent this beat. NOT a generic "journey home" / "heading home" / "walking home" shot (banned formula). A still moment at wherever they are, the finished project admired in place, a shared look, a kept token.`, wordTarget: 20 },
      { spread: 13, beat: 'CLOSING', description: `The last line. Invent a concrete, specific closing image for THIS story. Beautiful, warm, awake. NO "heading home" formula.`, wordTarget: 15 },
    ];
  }

  _chooseRefrain(child, parentName, storySeed) {
    const callsDad = child.anecdotes?.calls_dad || parentName || 'Daddy';
    if (storySeed?.repeated_phrase && typeof storySeed.repeated_phrase === 'string') {
      const phrase = storySeed.repeated_phrase.trim();
      if (phrase) {
        return {
          parentWord: callsDad,
          suggestions: [phrase],
        };
      }
    }
    return {
      parentWord: callsDad,
      suggestions: [
        `${callsDad} is here.`,
        `${callsDad} always knows.`,
        `That's what ${callsDad} does.`,
        `Because ${callsDad} loves you.`,
      ],
    };
  }

  async _enrichPlanWithLLM(beats, child, book, parentName, ageTier) {
    const anecdoteText = this._formatAnecdotes(child.anecdotes);
    if (!anecdoteText) return beats;

    const systemPrompt = `You are a children's book story planner specializing in Father's Day picture books. Your job is to weave specific, real details about this child into the story beats.

NARRATIVE SHAPE:
- The beats below are SOFT INSPIRATION, not a rigid scene template. The writer will be told to invent the arc.
- There is NO prescribed Scene A / Scene B / Scene C / Scene D. Do NOT add scene labels or force a "home → adventure → peak → heading home" shape.
- The story must NOT open at home. The closing must NOT default to a "walking home" / "heading home" / "back at home" formula.
- A 3-year-old listener must still be able to follow every transition between beats.

RULES:
- Keep the overall beat count. You may adjust any beat's description freely.
- Replace generic placeholders with specific anecdotes from the child's real life
- Use concrete nouns and actions, never abstract claims
- The anecdotes should feel natural in the story, not forced in`;

    const userPrompt = `Here are the story beats for a ${ageTier} Father's Day book about ${child.name} (age ${child.age}) and ${parentName}:

${beats.map(b => `Spread ${b.spread} (${b.beat}): ${b.description}`).join('\n')}

Here are real details about this child and their dad:
${anecdoteText}

Refine each beat description to incorporate specific details from the anecdotes. Keep the same number of beats and their purposes. Return a JSON array of beats with the same structure:
[{ "spread": 1, "beat": "OPENING", "description": "refined description", "wordTarget": 30 }, ...]`;

    const result = await this.callLLM('planner', systemPrompt, userPrompt, {
      jsonMode: true,
      maxTokens: 2000,
    });

    try {
      let parsed = JSON.parse(result.text);
      if (parsed.beats) parsed = parsed.beats;
      if (Array.isArray(parsed) && parsed.length >= beats.length * 0.7) {
        return parsed;
      }
    } catch (err) {
      console.warn(`[writerV2] Could not parse enriched beats: ${err.message}`);
    }
    return beats;
  }

  _buildWritePrompt(plan, child, book) {
    const parentName = plan.parentName;
    const pronouns = plan.pronouns;
    const anecdoteText = this._formatAnecdotes(child.anecdotes);

    const sections = [];

    sections.push(`## THE CHILD\n`);
    sections.push(`Name: ${child.name}`);
    sections.push(`Age: ${child.age}`);
    sections.push(`Gender: ${child.gender || 'not specified'} (pronouns: ${pronouns.pair})`);
    if (child.appearance) sections.push(`Appearance: ${child.appearance}`);
    if (child.interests?.length) sections.push(`Interests: ${child.interests.join(', ')}`);

    sections.push(`\n## THE FATHER\n`);
    sections.push(`The child calls him: ${parentName}`);
    const dadRealName = (book.dad_name || child.anecdotes?.dad_name || '').toString().trim();
    if (dadRealName && dadRealName.toLowerCase() !== parentName.toLowerCase()) {
      sections.push(`\n## PARENT NAME RULE — SHIP-BLOCKER\n`);
      sections.push(`The father's real first name is "${dadRealName}" but the child calls him "${parentName}".`);
      sections.push(`In this book he is "${parentName}" EVERYWHERE. You MAY use "${dadRealName}" exactly ONCE — and only if it lands naturally in a single dedication-style beat (e.g. "When grown-ups call him ${dadRealName}, to you he's just ${parentName}."). If you can't fit it gracefully, omit it entirely.`);
      sections.push(`Hard rule: "${dadRealName}" appears at most ONE TIME across all 13 spreads and the dedication combined. Using it more than once — even twice — is a ship-blocker; the book will fail QA and be rewritten. Do NOT rhyme on "${dadRealName}". Do NOT let "${dadRealName}" replace "${parentName}" in any refrain. Do NOT alternate between the two names.`);
    } else if (dadRealName) {
      sections.push(`Dad's name: ${dadRealName}`);
    }

    if (anecdoteText) {
      sections.push(`\n## REAL DETAILS ABOUT THIS CHILD AND THEIR DAD\n`);
      sections.push(anecdoteText);
      sections.push('\nWeave these real details naturally into the story. They make the book feel personal and specific.');
    }

    if (book.heartfeltNote) {
      sections.push(`\n## HEARTFELT NOTE FROM THE PERSON ORDERING THIS BOOK\n`);
      sections.push(`"${book.heartfeltNote}"`);
      sections.push('Use the emotion and intent of this note to guide the story\'s tone.');
    }

    if (book.title && !isPlaceholderTitle(book.title)) {
      sections.push(`\n## BOOK TITLE\n`);
      sections.push(`The approved cover title is: "${book.title}"`);
      sections.push('The story text must feel like it belongs under this title. Do not contradict the title\'s premise.');
    }

    if (plan.plotSynopsis) {
      sections.push(`\n## PLOT CONCEPT\n`);
      sections.push(plan.plotSynopsis);
      sections.push('\nUse this as the creative seed of the story — lean into THIS plot. The spread-by-spread shape is yours to invent (see INVENTED ARC below).');
    }

    sections.push(`\n## STORY PLAN\n`);
    sections.push(`Age tier: ${plan.ageTier}`);
    sections.push(`Target spread count: ${plan.spreadCount.target}`);
    sections.push(`Total word target: ${plan.wordTargets.total} words maximum`);
    sections.push(`Words per spread: ${plan.wordTargets.perSpread.min}-${plan.wordTargets.perSpread.max}`);

    if (plan.ageTier === 'young-picture') {
      sections.push(`\n## SIMPLICITY (THIS CHILD IS UNDER 4)\n`);
      sections.push(`- Maximum 2 syllables per word (except names). Use "big", "soft", "warm", "red" — not "solemn", "beneath", "shimmer".`);
      sections.push(`- Maximum 4 lines per spread. 2 lines is great.`);
      sections.push(`- Every line must make a picture a toddler can see. No abstractions, no similes, no metaphors.`);
      sections.push(`- Simple sentence structure. One idea per line.`);
      sections.push(`- Be clever and fun, not literary. Think silly, bouncy, playful — the kind of line that makes a toddler giggle.`);
      sections.push(`- If in doubt, simpler is better. This book will be read to a child who still points at dogs and says "woof".`);
    } else {
      sections.push(`\n## KEEP IT SIMPLE AND FUN\n`);
      sections.push(`- Write like Dr. Seuss or Julia Donaldson — clever, playful, easy to follow. NOT like adult poetry.`);
      sections.push(`- A parent should read every line smoothly on the first try. No tricky words, no awkward phrasing.`);
      sections.push(`- Prefer short, punchy sentences. Maximum 6 lines per spread. 4 is ideal.`);
      sections.push(`- Use everyday words. "ran" not "crept", "big" not "vast", "fell" not "tumbled".`);
      sections.push(`- Humor and wordplay are welcome. Literary flourishes are not.`);
    }

    sections.push(`\n## REFRAIN\n`);
    sections.push(`The story MUST have a refrain — a short phrase that recurs exactly 3 times (spreads 4, 9, and 13 are good anchor points).`);
    sections.push(`It should use "${plan.refrain.parentWord}" and be under 8 words.`);
    sections.push(`Suggested refrains (you may create your own):`);
    plan.refrain.suggestions.forEach(s => sections.push(`- "${s}"`));

    appendLocationPaletteSection(sections, plan);

    sections.push(`\n## INVENTED ARC (spread-by-spread beat sketches — SOFT HINTS, not a rigid template)\n`);
    sections.push(`Write exactly ${plan.spreadCount.target} spreads. The beat sketches below are STARTING INSPIRATION only — you are expected to shape the arc yourself so it serves THIS child, THIS father, THESE anecdotes. Keep what helps, replace what doesn't. The only HARD constraints on shape are:`);
    sections.push(`- Spread 1 must open OUT IN THE WORLD, in a specific non-home setting.`);
    sections.push(`- The final spreads must land a warm, concrete image YOU invent — not a formulaic "walking home", "heading home", or "back at home" shot.`);
    sections.push(`- There is NO prescribed Scene A / Scene B / Scene C / Scene D. Decide where tension builds, where the peak sits, and how the story resolves.`);
    sections.push(`- Each beat below is LOCKED to the palette location shown next to it. The TEXT and SCENE you write for that spread must both take place in that location.`);
    sections.push(`- Anecdote-assignment rules (if any) below are the only per-spread mandates.\n`);
    sections.push(`Sketches:`);
    plan.beats.forEach(b => {
      const locationTag = b.location ? ` {location: ${b.location}}` : '';
      const desc = this._sanitizeBeatDescription(b.description);
      sections.push(`Spread ${b.spread} (${b.beat})${locationTag}: ${desc} [~${b.wordTarget} words]`);
    });

    appendSceneRulesSection(sections, { parentGiftTheme: true });

    if (plan.manifest && plan.manifest.length > 0) {
      sections.push(`\n## HARD ANECDOTE ASSIGNMENTS (NON-NEGOTIABLE)\n`);
      sections.push(`Each of these real details MUST be concretely named in the exact spread listed — as a named object, action, place, food, or person. Do NOT paraphrase them away. Do NOT pile them all into one spread.`);
      plan.manifest.forEach(m => {
        sections.push(`- Spread ${m.spread}: "${m.anecdote_value}" (${m.anecdote_key}) — ${m.use}`);
      });
    }

    const favoriteObjectLock = buildFavoriteObjectLock(plan);
    if (favoriteObjectLock) {
      sections.push(`\n${favoriteObjectLock}`);
    }

    sections.push(`\n## NARRATIVE COHERENCE (READ THIS FIRST)\n`);
    sections.push(`- Whatever arc you invent, each spread must connect to the one before it. No slideshow of unrelated activities.`);
    sections.push(`- Group spreads that share a location or emotional space. Do NOT jump to a new location without narrating the transition.`);
    sections.push(`- This story has ONE through-line: ${child.name} and ${parentName} together. Every spread connects to that bond.`);
    sections.push(`- **Setting variety (important):** Use **at least 4 distinct, visually different physical places** as the day unfolds. Do **not** make the book “mostly the same two rooms + one short trip outside + back inside” — that reads as a dull loop. Clear transitions; keep the day moving through interesting, concrete locations.`);
    sections.push(`- CLARITY: Every image and metaphor must be literal enough for a 3-year-old to picture. If you mix imagination and reality, signal the shift clearly.`);

    sections.push(`\n## CRITICAL REMINDERS\n`);
    sections.push(`- AABB couplets throughout — every line pair must rhyme`);
    sections.push(`- This is a CELEBRATION book, not a bedtime book. EVERY spread must be WARM, JOYFUL, and POSITIVE. No anger, crying, tantrums, frustration, tiredness, sleeping, winding down, or negative emotions at any point. The entire book should feel happy and loving from start to finish.`);
    sections.push(`- Close on an IMAGE, not a declaration — no "I love you" as the last line`);
    sections.push(`- Every spread needs at least one concrete, specific noun`);
    sections.push(`- NO greeting card language. NO "you are special/wonderful/amazing"`);
    sections.push(`- The refrain must appear exactly 3 times, evenly spaced (not in consecutive spreads). More than 4 appearances makes the story feel monotonous.`);
    sections.push(`- RHYME VARIETY: Do NOT let one rhyme sound dominate the story. If the refrain ends with a particular word (e.g., "here"), you must NOT rhyme other non-refrain spreads with that same sound. Each spread should find its own fresh end-rhyme pair. Avoid rhyming more than 3 spreads with the same sound.`);
    sections.push(`- Use ONLY the parent name "${parentName}" — do NOT invent any other name for the father. No nicknames, no full names, no pet names unless provided in the input.`);
    sections.push(`- NEVER use they/them/their pronouns for ${child.name}. ${child.gender === 'female' ? 'She is a girl — use she/her.' : child.gender === 'male' ? 'He is a boy — use he/him.' : ''} Use the child's name or correct pronouns. "They" is only for plural subjects (e.g., ${child.name} and ${parentName} together).`);
    sections.push(`- NEVER use dashes, hyphens, or em dashes (\u2014, \u2013, -) in the story text. Use commas, periods, or line breaks instead.`);
    sections.push(`- Maximum 6 words per line.`);
    sections.push(`- Format each spread as: ---SPREAD N--- followed by the text`);

    sections.push(`\n## BOOK-WIDE VISUAL SHOWRUNNER\n`);
    sections.push(`- Mentally storyboard all ${plan.spreadCount.target} spreads: no two spreads may reuse the **same dominant tableau** (pose + place) without a new SCENE focal beat and different camera.`);
    sections.push(`- When a location **reappears** after other beats, the SCENE must not echo an earlier still from that place.`);

    sections.push(`\n## OUTFIT_LOCK (MANDATORY — hero ${child.name}, after final spread)\n`);
    sections.push(`After the last \`---SPREAD ${plan.spreadCount.target}---\` block, output one line: OUTFIT_LOCK: <one sentence describing ${child.name}'s day clothes for every dry-land spread — same garments in every SCENE unless bath/pool per rules.>`);

    return sections.join('\n');
  }

  _formatAnecdotes(anecdotes) {
    if (!anecdotes) return '';
    const parts = [];
    if (anecdotes.favorite_activities) parts.push(`Favorite activities: ${anecdotes.favorite_activities}`);
    if (anecdotes.funny_thing) parts.push(`Funny thing they do: ${anecdotes.funny_thing}`);
    if (anecdotes.meaningful_moment) parts.push(`Meaningful moment: ${anecdotes.meaningful_moment}`);
    if (anecdotes.dads_favorite_moment) parts.push(`Dad's favorite moment: ${anecdotes.dads_favorite_moment}`);
    if (anecdotes.favorite_food) parts.push(`Favorite food: ${anecdotes.favorite_food}`);
    if (anecdotes.other_detail) parts.push(`Other detail: ${anecdotes.other_detail}`);
    if (anecdotes.anything_else) parts.push(`Additional: ${anecdotes.anything_else}`);
    return parts.join('\n');
  }
}

module.exports = { FathersDayWriter };
