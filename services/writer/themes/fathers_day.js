/**
 * Father's Day ThemeWriter — mirrors Mother's Day structure for dads.
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
const { selectPlotTemplate } = require('./plots');

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
   * @returns {object} plan with beats, refrain, ageTier, wordTargets
   */
  async plan(child, book) {
    const ageTier = this.getAgeTier(child.age);
    const spreadCount = this.getSpreadCount(child.age);
    const wordLimits = this.getWordLimits(child.age);
    const parentName = this.getParentName(child, book);
    const pronouns = this.getPronouns(child);

    // Build beat structure based on research
    const beats = this._buildBeats(ageTier, spreadCount, child, parentName);

    // Choose refrain
    const refrain = this._chooseRefrain(child, parentName);

    // Use LLM to refine the plan if we have anecdotes
    let enrichedBeats = beats;
    if (child.anecdotes && Object.keys(child.anecdotes).length > 0) {
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
      spreadCount: { min: spreadCount.min, max: spreadCount.max, target: Math.min(spreadCount.max, beats.length) },
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
    const systemPrompt = buildSystemPrompt('fathers_day', ageTier, child, book, { role: 'reviser' });

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

  _buildBeats(ageTier, spreadCount, child, parentName) {
    const isYoung = ageTier === 'young-picture';
    const wt = isYoung ? 16 : 28;

    const plotTemplate = selectPlotTemplate('fathers_day');
    if (plotTemplate) {
      this._selectedPlot = plotTemplate;
      return plotTemplate.beats({ child, isYoung, wt, parentName: parentName || 'Daddy', book: {}, theme: 'fathers_day' });
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
      // SCENE A — HOME / LAUNCH (spreads 1-3)
      { spread: 1, beat: 'HOME_OPENING', description: `Place ${child.name} and ${parentName} in a specific moment at home — mid-action, not waking up. Establish the bond AND hint at a plan (building something, going somewhere). Simple, vivid, particular.`, wordTarget: 16 },
      { spread: 2, beat: 'HOME_PREPARING', description: `The plan takes shape — gathering tools, putting on shoes, starting the project. A moment that shows how they work together. Use child's anecdote if available. Same location.`, wordTarget: 18 },
      { spread: 3, beat: 'HOME_RITUAL', description: `Something only THIS pair does — a funny handshake, a silly ritual, ${parentName}'s signature move. Woven into the preparation, not a standalone scene.`, wordTarget: 18 },
      // SCENE B — THE ADVENTURE (spreads 4-7)
      { spread: 4, beat: 'ADVENTURE_START', description: `They head out or the project deepens — show the transition. The world opens up. Anticipation and excitement. ${parentName} is visible.`, wordTarget: 18 },
      { spread: 5, beat: 'ADVENTURE_SKILL', description: `${parentName} does something that amazes ${child.name} — a skill, a trick, lifting something heavy, fixing something broken. Connected to the adventure/project.`, wordTarget: 18 },
      { spread: 6, beat: 'ADVENTURE_LAUGHTER', description: `A funny or playful moment within the adventure — physical comedy, a shared joke, something goes slightly sideways in a fun way. Still in the same scene.`, wordTarget: 18 },
      { spread: 7, beat: 'ADVENTURE_QUIET', description: `A quieter beat — working side by side, watching something together, a moment of focus. The story breathes before the peak. Still in the same place.`, wordTarget: 16 },
      // SCENE C — THE PEAK (spreads 8-11)
      { spread: 8, beat: 'BIG_MOMENT', description: `The adventure reaches its destination or the project nears completion. The payoff of what they've been building toward. ${child.name} is excited.`, wordTarget: 18 },
      { spread: 9, beat: 'PEAK_JOY', description: `The best moment — triumphant, exciting. A high-five, a victory dance, the finished thing. Maximum energy. Physical, joyful, specific.`, wordTarget: 18 },
      { spread: 10, beat: 'CHILD_LEADS', description: `${child.name} does something that surprises or impresses ${parentName} — shows what they learned, takes a turn, makes a gift. Warm, funny role reversal.`, wordTarget: 18 },
      { spread: 11, beat: 'PROUD', description: `${parentName} and ${child.name} share a look, a word, a gesture. Admiration flows both ways. The emotional high point — deeper, not louder.`, wordTarget: 16 },
      // SCENE D — HEADING HOME (spreads 12-13)
      { spread: 12, beat: 'HEADING_HOME', description: `The journey home or the finished project admired. One warm transitional beat. NOT sleepy, NOT bedtime. Still full of the day's warmth.`, wordTarget: 16 },
      { spread: 13, beat: 'CLOSING', description: `The last line. Joyful echo of the opening. Beautiful, warm, concrete. NOT a goodnight. A parent should want to read it twice.`, wordTarget: 12 },
    ];
  }

  /**
   * Picture Book (ages 4-6): 13 spreads.
   * Richer vocabulary, compound sentences, more narrative depth.
   */
  _buildPictureBookBeats(child, parentName) {
    return [
      // SCENE A — HOME / LAUNCH (spreads 1-3)
      { spread: 1, beat: 'HOME_OPENING', description: `Place ${child.name} and ${parentName} in a specific moment — mid-action, not waking up. Establish tone AND hint at a plan (building something, going somewhere together). Vivid and particular.`, wordTarget: 30 },
      { spread: 2, beat: 'HOME_PREPARING', description: `The plan takes shape — gathering tools, loading the car, mapping the route, starting the project. A moment showing how they work together. Use child's anecdote. Same location.`, wordTarget: 30 },
      { spread: 3, beat: 'HOME_RITUAL', description: `Something only THIS pair does — a funny handshake, ${parentName}'s signature move, a shared joke from the questionnaire. Woven into the preparation, not a standalone scene.`, wordTarget: 30 },
      // SCENE B — THE ADVENTURE (spreads 4-7)
      { spread: 4, beat: 'ADVENTURE_START', description: `They head out or the project deepens — show the transition clearly. The world opens up. Anticipation and excitement build.`, wordTarget: 28 },
      { spread: 5, beat: 'ADVENTURE_SKILL', description: `${parentName} does something that amazes ${child.name} — a skill, a trick, strength, gentleness. The moment that makes ${parentName} a hero. Connected to the adventure/project.`, wordTarget: 28 },
      { spread: 6, beat: 'ADVENTURE_LAUGHTER', description: `A funny or playful moment within the adventure — physical comedy, stick swords, a shared joke, something goes slightly sideways. Still in the same scene.`, wordTarget: 28 },
      { spread: 7, beat: 'ADVENTURE_QUIET', description: `A quieter beat — working side by side, watching something together, a teaching moment. The story breathes before the peak. Still in the same place.`, wordTarget: 25 },
      // SCENE C — THE PEAK (spreads 8-11)
      { spread: 8, beat: 'BIG_MOMENT', description: `The adventure reaches its destination or the project nears completion. The payoff they've been building toward. Use meaningful_moment from questionnaire.`, wordTarget: 25 },
      { spread: 9, beat: 'PEAK_JOY', description: `The best moment — triumphant, exciting. A high-five, a victory dance, the big reveal. Maximum energy. Physical, joyful, specific.`, wordTarget: 25 },
      { spread: 10, beat: 'CHILD_LEADS', description: `${child.name} does something that surprises or impresses ${parentName} — shows what they learned, takes a turn, makes a gift. A warm role reversal.`, wordTarget: 25 },
      { spread: 11, beat: 'PROUD', description: `${parentName} and ${child.name} share a look, a word, a gesture. Admiration flows both ways. The emotional high point — deeper, not louder.`, wordTarget: 25 },
      // SCENE D — HEADING HOME (spreads 12-13)
      { spread: 12, beat: 'HEADING_HOME', description: `The journey home or the finished project admired. One warm transitional beat. NOT sleepy, NOT bedtime.`, wordTarget: 20 },
      { spread: 13, beat: 'CLOSING', description: `The last line. Joyful echo of the opening. Concrete and specific, not abstract. Beautiful, warm, celebratory. A parent should want to read it twice.`, wordTarget: 15 },
    ];
  }

  _chooseRefrain(child, parentName) {
    // The refrain should use the child's word for dad and be under 8 words
    const callsDad = child.anecdotes?.calls_dad || parentName || 'Daddy';
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

    const systemPrompt = `You are a children's book story planner specializing in Father's Day picture books. Your job is to weave specific, real details about this child into the story beat structure.

NARRATIVE STRUCTURE (CRITICAL):
- The beats are organized into 4 SCENES (Home, Adventure, Peak, Heading Home). Keep this structure intact.
- Consecutive beats within a scene MUST share the same location. Do NOT jump between unrelated places.
- A 3-year-old listener must be able to follow every transition between beats.

RULES:
- Keep every beat's purpose and SCENE grouping intact
- Replace generic placeholders with specific anecdotes from the child's real life
- Use concrete nouns and actions, never abstract claims
- The anecdotes should feel natural in the story, not forced in
- When enriching, keep beats within the same scene connected to each other`;

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
    if (child.anecdotes?.dad_name) sections.push(`Dad's name: ${child.anecdotes.dad_name}`);

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
      sections.push(`Spread ${b.spread} (${b.beat}): ${b.description} [~${b.wordTarget} words]`);
    });

    sections.push(`\n## NARRATIVE COHERENCE (READ THIS FIRST)\n`);
    sections.push(`- The beats are organized into 4 SCENES: Home (1-3), Adventure (4-7), Peak (8-11), Heading Home (12-13).`);
    sections.push(`- Within each scene, the characters stay in the SAME PLACE. Do NOT jump to a new location within a scene.`);
    sections.push(`- Scene transitions (3→4, 7→8, 11→12) must show the characters MOVING. The reader must know WHERE they are.`);
    sections.push(`- This story has ONE through-line: ${child.name} and ${parentName} do something together. Every spread connects to this adventure.`);
    sections.push(`- Do NOT write a slideshow of unrelated activities. Each spread flows from the one before it.`);
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
