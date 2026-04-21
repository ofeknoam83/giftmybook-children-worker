/**
 * Mother's Day ThemeWriter — first Writer V2 implementation.
 *
 * Based on children's writing craft research:
 * - AABB couplets in iambic tetrameter (ages 2-5), looser rhythm for 0-2
 * - Mandatory refrain using child's word for mom
 * - Emotional arc: specific -> deepening -> test -> climax -> resolution
 * - Anti-AI-flatness: concrete nouns, actions not declarations, no greeting card language
 */

const { BaseThemeWriter } = require('./base');
const { buildSystemPrompt } = require('../prompts/system');
const { checkAndFixPronouns } = require('../quality/pronoun');
const { sanitizeNonLatinChars } = require('../quality/sanitize');
const { selectPlotTemplate, matchTitleToPlot, isPlaceholderTitle, generateAnecdoteDrivenPlot } = require('./plots');
const { buildFavoriteObjectLock } = require('./anecdotes');

class MothersDayWriter extends BaseThemeWriter {
  constructor() {
    super('mothers_day');
  }

  /**
   * Plan the story beats for a Mother's Day book.
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

    // ── Preferred path: anecdote-driven GPT-5.4 plot ──
    // If the child has real anecdotes and no upstream seed forces a shape,
    // build the arc around them instead of picking a random template. Fall
    // back to templates on failure.
    let anecdotePlot = null;
    if (!seedBeats && child.anecdotes && Object.keys(child.anecdotes).length > 0 && !book.plotId) {
      try {
        const isYoung = ageTier === 'young-picture';
        const wt = isYoung ? 16 : 28;
        anecdotePlot = await generateAnecdoteDrivenPlot({
          theme: 'mothers_day',
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
          console.log(`[writerV2] Using anecdote-driven plot "${anecdotePlot.id}" for mothers_day (${anecdotePlot.manifest?.length || 0} anecdote assignments)`);
        }
      } catch (err) {
        console.warn(`[writerV2] Anecdote-driven plot generation failed for mothers_day: ${err.message}`);
      }
    }

    if (!anecdotePlot && !seedBeats && !book.plotId && book.title) {
      try {
        const matchedId = await matchTitleToPlot(book.title, 'mothers_day');
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

    // Only run the generic enrichment pass when we're working with TEMPLATE
    // beats. Anecdote-driven and seed-driven beats were already personalized
    // upstream; re-enriching would just dilute them.
    let enrichedBeats = beats;
    if (!anecdotePlot && !usedSeed && child.anecdotes && Object.keys(child.anecdotes).length > 0) {
      try {
        enrichedBeats = await this._enrichPlanWithLLM(beats, child, book, parentName, ageTier);
      } catch (err) {
        console.warn(`[writerV2] Plan enrichment failed, using template beats: ${err.message}`);
      }
    }

    const plot = this._selectedPlot;
    return {
      beats: enrichedBeats,
      refrain,
      ageTier,
      spreadCount: { min: spreadCount.min, max: spreadCount.max, target: Math.min(spreadCount.max, enrichedBeats.length) },
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
      // (e.g. FAVORITE OBJECT LOCK) can read it. `usedSeed` only indicates
      // whether we adopted the seed's *beats* — the seed's favorite_object
      // and setting are valuable regardless.
      storySeed: storySeed || null,
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
    const systemPrompt = buildSystemPrompt('mothers_day', plan.ageTier, child, book, { role: 'writer' });
    const userPrompt = this._buildWritePrompt(plan, child, book);

    const result = await this.callLLM('writer', systemPrompt, userPrompt, {
      maxTokens: 4000,
    });

    let spreads = this.parseSpreads(result.text);

    // Validate structure and retry if needed
    const validation = this.validateStructure(spreads, child.age);
    if (!validation.valid && spreads.length < plan.spreadCount.min) {
      console.warn(`[writerV2] First write attempt has issues: ${validation.issues.join('; ')}. Retrying...`);
      const retryResult = await this.callLLM('writer', systemPrompt, userPrompt + '\n\nIMPORTANT: You MUST write exactly ' + plan.spreadCount.target + ' spreads.', {
        maxTokens: 4000,
        temperature: 0.9,
      });
      const retrySpreads = this.parseSpreads(retryResult.text);
      if (retrySpreads.length >= plan.spreadCount.min) {
        spreads = retrySpreads;
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
    const systemPrompt = buildSystemPrompt('mothers_day', ageTier, child, book, { role: 'reviser' });

    const currentText = story.spreads.map(s => `---SPREAD ${s.spread}---\n${s.text}`).join('\n\n');

    const userPrompt = `Here is the current story:\n\n${currentText}\n\n## REVISION FEEDBACK\n\n${feedback}\n\nRevise the story to address ALL of the issues above. Keep the same number of spreads (${story.spreads.length}). Preserve the emotional arc and refrain. Fix the specific issues identified.`;

    const result = await this.callLLM('reviser', systemPrompt, userPrompt, {
      maxTokens: 4000,
    });

    let spreads = this.parseSpreads(result.text);

    // If revision parsing failed, keep original
    if (spreads.length < story.spreads.length * 0.7) {
      console.warn(`[writerV2] Revision produced only ${spreads.length} spreads (expected ~${story.spreads.length}), keeping original`);
      return story;
    }

    checkAndFixPronouns(spreads, child.gender);

    // Strip dashes from story text
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
    };
  }

  // ── Private helpers ──

  _buildBeats(ageTier, spreadCount, child, parentName, book = {}) {
    const isYoung = ageTier === 'young-picture';
    const wt = isYoung ? 16 : 28;

    const plotTemplate = selectPlotTemplate('mothers_day', { plotId: book.plotId });
    if (plotTemplate) {
      this._selectedPlot = plotTemplate;
      return plotTemplate.beats({ child, isYoung, wt, parentName: parentName || 'Mama', book, theme: 'mothers_day' });
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
   * Still a full narrative arc — parents should love reading this.
   */
  _buildYoungPictureBeats(child, parentName) {
    return [
      // SCENE A — HOME (spreads 1-3)
      { spread: 1, beat: 'HOME_OPENING', description: `Place ${child.name} and ${parentName} in a specific moment at home — mid-action, not waking up. Establish the warm world AND hint at a plan for the day (going somewhere, making something). Simple, vivid, particular.`, wordTarget: 16 },
      { spread: 2, beat: 'HOME_PREPARING', description: `The plan takes shape — packing a bag, putting on shoes, gathering supplies, or starting a project. A small moment that reveals their bond. Use child's anecdote if available. Same location as spread 1.`, wordTarget: 18 },
      { spread: 3, beat: 'HOME_SECRET', description: `A detail unique to THIS pair — a made-up word, a funny face, a private ritual. Woven into the preparation, not a detour. Same location. ${parentName} and ${child.name} share something nobody else would understand.`, wordTarget: 18 },
      // SCENE B — THE JOURNEY (spreads 4-7)
      { spread: 4, beat: 'JOURNEY_START', description: `They leave home — show the transition. Walking, strolling, riding. The world opens up. Anticipation builds. ${parentName} is visible.`, wordTarget: 18 },
      { spread: 5, beat: 'JOURNEY_IMAGINATION', description: `${child.name} transforms something along the way into something magical — a puddle is an ocean, a stick is a wand, a leaf is a boat. ${parentName} plays along. Connected to the journey.`, wordTarget: 18 },
      { spread: 6, beat: 'JOURNEY_REVERSAL', description: `${child.name} tries to take care of ${parentName} — carries her bag, "helps" navigate, holds her hand to cross. Funny, earnest, tender. Still on the journey.`, wordTarget: 18 },
      { spread: 7, beat: 'JOURNEY_NOTICING', description: `${parentName} sees something specific and delightful about ${child.name} that nobody else notices. A quiet beat — the story breathes before the peak. Still traveling or just arriving.`, wordTarget: 16 },
      // SCENE C — THE DESTINATION (spreads 8-11)
      { spread: 8, beat: 'ARRIVE', description: `They arrive — the park, the shop, the special place. The world opens up. Show where they are. ${child.name} is excited.`, wordTarget: 18 },
      { spread: 9, beat: 'PEAK_JOY', description: `The best moment — spinning, running, splashing, the thing they came here to do. Maximum energy. Physical, joyful, specific. NOT quiet.`, wordTarget: 18 },
      { spread: 10, beat: 'GIFT', description: `${child.name} gives ${parentName} something imperfect and precious — a picked flower, a found pebble, a dandelion. The gesture is small but it lands. At the destination.`, wordTarget: 18 },
      { spread: 11, beat: 'TOGETHER', description: `Side by side, savoring the moment at the destination. Happy, vivid, warm. The emotional high point — deeper than spread 9, not louder.`, wordTarget: 16 },
      // SCENE D — HEADING HOME (spreads 12-13)
      { spread: 12, beat: 'HEADING_HOME', description: `The walk home or the moment of leaving. One warm transitional beat. NOT sleepy, NOT bedtime. Still full of the day's warmth.`, wordTarget: 16 },
      { spread: 13, beat: 'CLOSING', description: `The last line. Joyful echo of the opening. Warm, bright, celebratory. NOT a goodnight, NOT falling asleep. End in daylight with togetherness. Concrete image, not abstract. A parent should want to read it twice.`, wordTarget: 12 },
    ];
  }

  /**
   * Picture Book (ages 4-6): 13 spreads.
   * Richer vocabulary, compound sentences, more narrative depth.
   */
  _buildPictureBookBeats(child, parentName) {
    return [
      // SCENE A — HOME (spreads 1-3)
      { spread: 1, beat: 'HOME_OPENING', description: `Place ${child.name} and ${parentName} in a specific moment at home — mid-action, not waking up. Establish tone AND hint at a plan for the day (going somewhere, making something together). Vivid and particular.`, wordTarget: 30 },
      { spread: 2, beat: 'HOME_PREPARING', description: `The plan takes shape — getting ready to go, starting a project, gathering supplies. A moment that reveals their bond. Use child's anecdote. Same location as spread 1.`, wordTarget: 30 },
      { spread: 3, beat: 'HOME_SECRET', description: `A detail unique to THIS pair — a made-up word, an inside joke, a secret handshake. Woven into the preparation, not a standalone scene. ${parentName}'s character through action.`, wordTarget: 30 },
      // SCENE B — THE JOURNEY (spreads 4-7)
      { spread: 4, beat: 'JOURNEY_START', description: `They leave home — show the transition clearly. Walking, strolling, riding. The world opens up. Anticipation builds.`, wordTarget: 28 },
      { spread: 5, beat: 'JOURNEY_IMAGINATION', description: `${child.name} transforms something along the way into something magical — a stick becomes a wand, a puddle becomes an ocean. ${parentName} plays along wholeheartedly. Connected to the journey.`, wordTarget: 28 },
      { spread: 6, beat: 'JOURNEY_REVERSAL', description: `${child.name} tries to take care of ${parentName} — carries her bag, "reads" a sign for her, holds her hand protectively. Funny, earnest, tender. Still on the journey.`, wordTarget: 28 },
      { spread: 7, beat: 'JOURNEY_NOTICING', description: `${parentName} sees something specific and wonderful about ${child.name} that nobody else catches. A quiet beat — the story breathes here before the peak. The noticing IS the love.`, wordTarget: 25 },
      // SCENE C — THE DESTINATION (spreads 8-11)
      { spread: 8, beat: 'ARRIVE', description: `They arrive at the destination — the park, the bakery, the garden. The world opens up. Show where they are concretely. ${child.name} is excited.`, wordTarget: 25 },
      { spread: 9, beat: 'PEAK_JOY', description: `The best moment of the day — racing, spinning, splashing, building, the thing they came here to do. Maximum energy. Physical, joyful, specific. NOT quiet.`, wordTarget: 25 },
      { spread: 10, beat: 'GIFT', description: `${child.name} gives ${parentName} something imperfect and precious — a dandelion, a lopsided drawing, a found pebble. The gift is small but the gesture lands. At the destination.`, wordTarget: 25 },
      { spread: 11, beat: 'TOGETHER', description: `Side by side, savoring the moment at the destination. The best part of the day. Happy, vivid, warm. The emotional high point — deeper than spread 9, not louder.`, wordTarget: 25 },
      // SCENE D — HEADING HOME (spreads 12-13)
      { spread: 12, beat: 'HEADING_HOME', description: `The walk home or the moment of leaving. One warm transitional beat. NOT sleepy, NOT bedtime. Still full of the day's warmth.`, wordTarget: 20 },
      { spread: 13, beat: 'CLOSING', description: `The last line. Joyful echo of the opening. Warm, bright, celebratory. NOT a goodnight, NOT falling asleep. End in daylight with togetherness. Concrete image, not abstract. A parent should want to read it twice.`, wordTarget: 15 },
    ];
  }

  _chooseRefrain(child, parentName, storySeed) {
    const callsMom = child.anecdotes?.calls_mom || parentName || 'Mama';
    if (storySeed?.repeated_phrase && typeof storySeed.repeated_phrase === 'string') {
      const phrase = storySeed.repeated_phrase.trim();
      if (phrase) {
        return {
          parentWord: callsMom,
          suggestions: [phrase],
        };
      }
    }
    return {
      parentWord: callsMom,
      suggestions: [
        `${callsMom} is here.`,
        `${callsMom} always knows.`,
        `That's what ${callsMom} does.`,
        `Because ${callsMom} loves you.`,
      ],
    };
  }

  async _enrichPlanWithLLM(beats, child, book, parentName, ageTier) {
    const anecdoteText = this._formatAnecdotes(child.anecdotes);
    if (!anecdoteText) return beats;

    const systemPrompt = `You are a children's book story planner specializing in Mother's Day picture books. Your job is to weave specific, real details about this child into the story beat structure.

NARRATIVE STRUCTURE (CRITICAL):
- The beats are organized into 4 SCENES (Home, Journey, Destination, Heading Home). Keep this structure intact.
- Consecutive beats within a scene MUST share the same location. Do NOT jump between unrelated places.
- A 3-year-old listener must be able to follow every transition between beats.

RULES:
- Keep every beat's purpose and SCENE grouping intact
- Replace generic placeholders with specific anecdotes from the child's real life
- Use concrete nouns and actions, never abstract claims
- The anecdotes should feel natural in the story, not forced in
- When enriching, keep beats within the same scene connected to each other`;

    const userPrompt = `Here are the story beats for a ${ageTier} Mother's Day book about ${child.name} (age ${child.age}) and ${parentName}:

${beats.map(b => `Spread ${b.spread} (${b.beat}): ${b.description}`).join('\n')}

Here are real details about this child and their mom:
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

    sections.push(`\n## THE MOTHER\n`);
    sections.push(`The child calls her: ${parentName}`);
    const momRealName = (book.mom_name || child.anecdotes?.mom_name || '').toString().trim();
    if (momRealName && momRealName.toLowerCase() !== parentName.toLowerCase()) {
      sections.push(`\n## PARENT NAME RULE — SHIP-BLOCKER\n`);
      sections.push(`The mother's real first name is "${momRealName}" but the child calls her "${parentName}".`);
      sections.push(`In this book she is "${parentName}" EVERYWHERE. You MAY use "${momRealName}" exactly ONCE — and only if it lands naturally in a single dedication-style beat (e.g. "When grown-ups call her ${momRealName}, to you she's just ${parentName}."). If you can't fit it gracefully, omit it entirely.`);
      sections.push(`Hard rule: "${momRealName}" appears at most ONE TIME across all 13 spreads and the dedication combined. Using it more than once — even twice — is a ship-blocker; the book will fail QA and be rewritten. Do NOT rhyme on "${momRealName}". Do NOT let "${momRealName}" replace "${parentName}" in any refrain. Do NOT alternate between the two names.`);
    } else if (momRealName) {
      sections.push(`Mom's name: ${momRealName}`);
    }

    if (anecdoteText) {
      sections.push(`\n## REAL DETAILS ABOUT THIS CHILD AND THEIR MOM\n`);
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
      sections.push('\nFollow this specific story arc. The beat structure below gives you the scene-by-scene breakdown — lean into THIS plot, not a generic version of the theme.');
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

    sections.push(`\n## BEAT STRUCTURE\n`);
    sections.push(`Write exactly ${plan.spreadCount.target} spreads following this structure:\n`);
    plan.beats.forEach(b => {
      const locationTag = b.location ? ` {location: ${b.location}}` : '';
      sections.push(`Spread ${b.spread} (${b.beat})${locationTag}: ${b.description} [~${b.wordTarget} words]`);
    });

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
    sections.push(`- The beats are organized into 4 SCENES: Home (1-3), Journey (4-7), Destination (8-11), Heading Home (12-13).`);
    sections.push(`- Within each scene, the characters stay in the SAME PLACE. Do NOT jump to a new location within a scene.`);
    sections.push(`- Scene transitions (3→4, 7→8, 11→12) must show the characters MOVING. The reader must know WHERE they are.`);
    sections.push(`- This story has ONE through-line: ${child.name} and ${parentName} go somewhere together. Every spread connects to this journey.`);
    sections.push(`- Do NOT write a slideshow of unrelated activities. Each spread flows from the one before it.`);
    sections.push(`- CLARITY: Every image and metaphor must be literal enough for a 3-year-old to picture. If you mix imagination and reality, signal the shift clearly ("The puddle BECAME an ocean").`);

    sections.push(`\n## CRITICAL REMINDERS\n`);
    sections.push(`- AABB couplets throughout — every line pair must rhyme`);
    sections.push(`- This is a CELEBRATION book, not a bedtime book. EVERY spread must be WARM, JOYFUL, and POSITIVE. No anger, crying, tantrums, frustration, tiredness, sleeping, winding down, or negative emotions at any point. The entire book should feel happy and loving from start to finish.`);
    sections.push(`- The ENDING must be warm, bright, and celebratory — NOT a goodnight, NOT falling asleep, NOT tucking in, NOT a dream. End in DAYLIGHT with togetherness, joy, and energy. The last image should be of ${child.name} and ${parentName} together in warmth and light.`);
    sections.push(`- Close on an IMAGE, not a declaration — no "I love you" as the last line`);
    sections.push(`- Every spread needs at least one concrete, specific noun`);
    sections.push(`- NO greeting card language. NO "you are special/wonderful/amazing"`);
    sections.push(`- The refrain must appear exactly 3 times, evenly spaced (not in consecutive spreads). More than 4 appearances makes the story feel monotonous.`);
    sections.push(`- The refrain should DEEPEN in meaning each time it appears — same words, but the context around it shifts so it lands differently`);
    sections.push(`- RHYME VARIETY: Do NOT let one rhyme sound dominate the story. If the refrain ends with a particular word (e.g., "here"), you must NOT rhyme other non-refrain spreads with that same sound. Each spread should find its own fresh end-rhyme pair. Avoid rhyming more than 3 spreads with the same sound.`);
    sections.push(`- Use ONLY the parent name "${parentName}" — do NOT invent any other name for the mother. No nicknames, no full names, no pet names unless provided in the input.`);
    sections.push(`- NEVER use they/them/their pronouns for ${child.name}. ${child.gender === 'female' ? 'She is a girl — use she/her.' : child.gender === 'male' ? 'He is a boy — use he/him.' : ''} Use the child's name or correct pronouns. "They" is only for plural subjects (e.g., ${child.name} and ${parentName} together).`);
    sections.push(`- NEVER use dashes, hyphens, or em dashes (\u2014, \u2013, -) in the story text. Use commas, periods, or line breaks instead.`);
    sections.push(`- Format each spread as: ---SPREAD N--- followed by the text`);

    sections.push(`\n## CREATIVITY RULES (CRITICAL)\n`);
    sections.push(`- At least 2 spreads must use the child's IMAGINATION — transform an ordinary moment into something magical or whimsical (a puddle is a sea, a stick is a sword, the kitchen is a restaurant). ${parentName} plays along.`);
    sections.push(`- Avoid documentary narration ("they did this, then they did that"). Each spread should SURPRISE the reader with an unexpected image, action, or perspective.`);
    sections.push(`- Include at least one REVERSAL where ${child.name} takes care of ${parentName} — pours pretend tea, "reads" a story, covers her with a blanket. This is funny and tender.`);
    sections.push(`- At least one spread should contain an image so SPECIFIC it could only belong to THIS child — use the anecdotes and real details provided.`);
    sections.push(`- Avoid AI-common rhyme pairs: day/way, heart/start, love/above, you/true, night/light, play/day. Find fresher, more surprising rhymes.`);
    sections.push(`- Sensory details should go beyond sight — include sounds (crunch, hum, splash), textures (sticky, fuzzy, warm), smells (toast, rain, grass).`);

    return sections.join('\n');
  }

  _formatAnecdotes(anecdotes) {
    if (!anecdotes) return '';
    const parts = [];
    if (anecdotes.favorite_activities) parts.push(`Favorite activities: ${anecdotes.favorite_activities}`);
    if (anecdotes.funny_thing) parts.push(`Funny thing they do: ${anecdotes.funny_thing}`);
    if (anecdotes.meaningful_moment) parts.push(`Meaningful moment: ${anecdotes.meaningful_moment}`);
    if (anecdotes.moms_favorite_moment) parts.push(`Mom's favorite moment: ${anecdotes.moms_favorite_moment}`);
    if (anecdotes.favorite_food) parts.push(`Favorite food: ${anecdotes.favorite_food}`);
    if (anecdotes.other_detail) parts.push(`Other detail: ${anecdotes.other_detail}`);
    if (anecdotes.anything_else) parts.push(`Additional: ${anecdotes.anything_else}`);
    return parts.join('\n');
  }
}

module.exports = { MothersDayWriter };
