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

    return {
      spreads,
      _model: result.model,
      _ageTier: ageTier,
    };
  }

  // ── Private helpers ──

  _buildBeats(ageTier, spreadCount, child, parentName) {
    if (ageTier === 'young-picture') {
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
      { spread: 1, beat: 'OPENING', description: `Place ${child.name} and ${parentName} in a specific morning moment. Simple, vivid, particular.`, wordTarget: 20 },
      { spread: 2, beat: 'ACTIVITY_1', description: `First activity together — building, fixing, or making something side by side. Concrete nouns, sensory detail.`, wordTarget: 22 },
      { spread: 3, beat: 'ACTIVITY_2', description: `Physical play — ${parentName} lifting ${child.name} high, racing, or rough-housing. Show ${parentName}'s strength and gentleness.`, wordTarget: 22 },
      { spread: 4, beat: 'ACTIVITY_3', description: `A teaching moment — riding a bike, tying shoes, or learning something new. Use child's interests if available.`, wordTarget: 22 },
      { spread: 5, beat: 'DEEPENING_1', description: `${parentName} noticing something specific about ${child.name}. The shift from activities to connection.`, wordTarget: 22 },
      { spread: 6, beat: 'DEEPENING_2', description: `${parentName} knows something nobody else knows — a specific gesture, habit, or look that ${child.name} has.`, wordTarget: 22 },
      { spread: 7, beat: 'DEEPENING_3', description: `The noticing IS the love. ${parentName}'s quiet softness — the way he watches when ${child.name} isn't looking.`, wordTarget: 20 },
      { spread: 8, beat: 'EVEN_WHEN', description: `Love holds when things are hard — child is tired, fussy, or overwhelmed. ${parentName} stays steady.`, wordTarget: 22 },
      { spread: 9, beat: 'COMFORT', description: `${parentName}'s quiet softness — bedtime stories, carrying sleeping ${child.name}, a whispered goodnight.`, wordTarget: 22 },
      { spread: 10, beat: 'CLIMAX', description: `Fewest words in the whole book. Physical closeness. Near-wordless.`, wordTarget: 12 },
      { spread: 11, beat: 'RESOLUTION_1', description: `The world settles. Echo of the opening. Return to the specific place or image from spread 1.`, wordTarget: 22 },
      { spread: 12, beat: 'RESOLUTION_2', description: `The refrain lands one final time. Close on an image, not a declaration.`, wordTarget: 20 },
      { spread: 13, beat: 'CLOSING', description: `The last line. Echo the opening. The most beautiful sentence in the book. A parent should want to read it twice.`, wordTarget: 14 },
    ];
  }

  /**
   * Picture Book (ages 4-6): 13 spreads.
   * Richer vocabulary, compound sentences, more narrative depth.
   */
  _buildPictureBookBeats(child, parentName) {
    return [
      { spread: 1, beat: 'OPENING', description: `Place ${child.name} and ${parentName} in a specific moment. Establish tone. The world is vivid and particular.`, wordTarget: 30 },
      { spread: 2, beat: 'ACTIVITY_1', description: `First activity together — building something, a shared project. Concrete nouns, specific actions.`, wordTarget: 30 },
      { spread: 3, beat: 'ACTIVITY_2', description: `Physical play — backyard adventures, stick swords, racing. Show ${parentName}'s playful side.`, wordTarget: 30 },
      { spread: 4, beat: 'ACTIVITY_3', description: `A teaching moment — the big bike ride, the letting-go moment when ${parentName} releases the seat. Use child's interests if available.`, wordTarget: 28 },
      { spread: 5, beat: 'DEEPENING_1', description: `${parentName} begins noticing specific things about ${child.name}. The shift from activities to emotional connection.`, wordTarget: 28 },
      { spread: 6, beat: 'DEEPENING_2', description: `${parentName} knows something nobody else knows — the specific laugh, the particular habit, the invented game.`, wordTarget: 28 },
      { spread: 7, beat: 'DEEPENING_3', description: `The noticing IS the love. ${parentName}'s perspective feels earned — he saw something specific; that seeing is the love.`, wordTarget: 25 },
      { spread: 8, beat: 'EVEN_WHEN_1', description: `The "even when" test begins — love holds when things are hard. Child is tired/cranky/scared.`, wordTarget: 25 },
      { spread: 9, beat: 'EVEN_WHEN_2', description: `Honest emotion — ${parentName} might feel tired too — but love holds. More convincing than perfect patience.`, wordTarget: 25 },
      { spread: 10, beat: 'CLIMAX', description: `Fewest words in the whole book. Physical closeness. A quiet moment. Near-wordless spread signals "stop and take this in."`, wordTarget: 15 },
      { spread: 11, beat: 'RESOLUTION_1', description: `The world settles. Two shadows in lamplight. Echo of the opening. Return to the specific place or image from spread 1.`, wordTarget: 25 },
      { spread: 12, beat: 'RESOLUTION_2', description: `The refrain lands one final time. Close on an image, not a declaration.`, wordTarget: 20 },
      { spread: 13, beat: 'CLOSING', description: `The last line. Echo the opening. The most beautiful sentence in the book. A parent should want to read it twice.`, wordTarget: 15 },
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

RULES:
- Keep every beat's purpose intact
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

    sections.push(`\n## STORY PLAN\n`);
    sections.push(`Age tier: ${plan.ageTier}`);
    sections.push(`Target spread count: ${plan.spreadCount.target}`);
    sections.push(`Total word target: ${plan.wordTargets.total} words maximum`);
    sections.push(`Words per spread: ${plan.wordTargets.perSpread.min}-${plan.wordTargets.perSpread.max}`);

    sections.push(`\n## REFRAIN\n`);
    sections.push(`The story MUST have a refrain — a short phrase that recurs at least 3 times.`);
    sections.push(`It should use "${plan.refrain.parentWord}" and be under 8 words.`);
    sections.push(`Suggested refrains (you may create your own):`);
    plan.refrain.suggestions.forEach(s => sections.push(`- "${s}"`));

    sections.push(`\n## BEAT STRUCTURE\n`);
    sections.push(`Write exactly ${plan.spreadCount.target} spreads following this structure:\n`);
    plan.beats.forEach(b => {
      sections.push(`Spread ${b.spread} (${b.beat}): ${b.description} [~${b.wordTarget} words]`);
    });

    sections.push(`\n## CRITICAL REMINDERS\n`);
    sections.push(`- AABB couplets throughout — every line pair must rhyme`);
    sections.push(`- The climax spread (${plan.beats.find(b => b.beat === 'CLIMAX')?.spread || 10}) should have the FEWEST words`);
    sections.push(`- Close on an IMAGE, not a declaration — no "I love you" as the last line`);
    sections.push(`- Every spread needs at least one concrete, specific noun`);
    sections.push(`- NO greeting card language. NO "you are special/wonderful/amazing"`);
    sections.push(`- The refrain must appear at least 3 times, spaced through the story`);
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
