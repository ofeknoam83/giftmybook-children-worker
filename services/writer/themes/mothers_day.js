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

class MothersDayWriter extends BaseThemeWriter {
  constructor() {
    super('mothers_day');
  }

  /**
   * Plan the story beats for a Mother's Day book.
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
   * Still a full narrative arc — parents should love reading this.
   */
  _buildYoungPictureBeats(child, parentName) {
    return [
      { spread: 1, beat: 'OPENING', description: `Place ${child.name} and ${parentName} in a specific morning moment. Simple, vivid, particular.`, wordTarget: 20 },
      { spread: 2, beat: 'ACTIVITY_1', description: `First activity together — use child's anecdote if available. Concrete nouns, sensory detail.`, wordTarget: 22 },
      { spread: 3, beat: 'ACTIVITY_2', description: `Second activity — daily routine moment. Show ${parentName}'s character through action, not description.`, wordTarget: 22 },
      { spread: 4, beat: 'IMAGINATION', description: `${child.name} transforms something ordinary into something magical — a puddle is an ocean, a box is a castle, a spoon is a wand. ${parentName} plays along.`, wordTarget: 22 },
      { spread: 5, beat: 'SECRET_LANGUAGE', description: `The private, particular things only ${child.name} and ${parentName} share — a made-up word, a funny face, a sound, an inside joke. Nobody else would understand.`, wordTarget: 22 },
      { spread: 6, beat: 'NOTICING', description: `${parentName} sees something specific and delightful about ${child.name} that nobody else notices — the way they hold a crayon, how they talk to a stuffed animal, a particular dance move.`, wordTarget: 22 },
      { spread: 7, beat: 'REVERSAL', description: `${child.name} tries to take care of ${parentName} — pours pretend tea, covers ${parentName} with a tiny blanket, "reads" a story to her. Warm and funny.`, wordTarget: 22 },
      { spread: 8, beat: 'GIFT', description: `${child.name} gives ${parentName} something imperfect and precious — a picked flower, a scribbled drawing, a rock, a dandelion. The gift is funny and earnest.`, wordTarget: 22 },
      { spread: 9, beat: 'ADVENTURE', description: `They go somewhere together or try something new — a walk, the park, baking, a little exploration. Bright, active, joyful.`, wordTarget: 22 },
      { spread: 10, beat: 'CELEBRATION', description: `Something physical and joyful — spinning, swinging, dancing, jumping. Pure laughter and movement. NOT quiet. NOT winding down.`, wordTarget: 22 },
      { spread: 11, beat: 'TOGETHER', description: `Side by side doing their favorite thing. The ordinary IS the gift. Warm, vivid, full of life and energy.`, wordTarget: 22 },
      { spread: 12, beat: 'CLIMAX', description: `The warmest moment — a big hug, spinning, laughter. WARM and FULL, not quiet. NOT sleepy, NOT bedtime. Full of love and light and energy.`, wordTarget: 20 },
      { spread: 13, beat: 'CLOSING', description: `The last line. Joyful echo of the opening. Warm, bright, celebratory. NOT a goodnight, NOT falling asleep, NOT a dream. End in daylight with togetherness. A parent should want to read it twice.`, wordTarget: 14 },
    ];
  }

  /**
   * Picture Book (ages 4-6): 13 spreads.
   * Richer vocabulary, compound sentences, more narrative depth.
   */
  _buildPictureBookBeats(child, parentName) {
    return [
      { spread: 1, beat: 'OPENING', description: `Place ${child.name} and ${parentName} in a specific moment. Establish tone. The world is vivid and particular.`, wordTarget: 30 },
      { spread: 2, beat: 'ACTIVITY_1', description: `First activity together — use child's anecdote. Concrete nouns, specific actions.`, wordTarget: 30 },
      { spread: 3, beat: 'ACTIVITY_2', description: `Second activity — daily routine made magical. Show ${parentName}'s character through action, not description.`, wordTarget: 30 },
      { spread: 4, beat: 'IMAGINATION', description: `${child.name} transforms something ordinary into something magical — a stick becomes a wand, a hill becomes a mountain, the backyard becomes a jungle. ${parentName} plays along wholeheartedly.`, wordTarget: 28 },
      { spread: 5, beat: 'SECRET_LANGUAGE', description: `The private, particular things only ${child.name} and ${parentName} share — a made-up word, an inside joke, a secret handshake, a sound only they know the meaning of.`, wordTarget: 28 },
      { spread: 6, beat: 'NOTICING', description: `${parentName} sees something specific and wonderful about ${child.name} that nobody else catches — a particular expression, the way they arrange things, how they whisper to animals. The noticing IS the love.`, wordTarget: 28 },
      { spread: 7, beat: 'REVERSAL', description: `${child.name} tries to take care of ${parentName} — makes her a "meal," reads her a "story," tucks a blanket around her legs. Funny, earnest, tender.`, wordTarget: 25 },
      { spread: 8, beat: 'GIFT', description: `${child.name} gives ${parentName} something imperfect and precious — a dandelion, a lopsided drawing, a rock, a wish blown off a seed. The gift is small but the gesture lands.`, wordTarget: 25 },
      { spread: 9, beat: 'ADVENTURE', description: `They go somewhere together or try something new — exploring, building, baking, a shared quest. Bright, active, joyful.`, wordTarget: 25 },
      { spread: 10, beat: 'CELEBRATION', description: `Something physical and joyful — racing, spinning, dancing, jumping. Pure laughter and movement. NOT quiet. NOT winding down.`, wordTarget: 25 },
      { spread: 11, beat: 'TOGETHER', description: `The best part of the day. Doing what they love most together. Happy, vivid, full of energy and warmth.`, wordTarget: 25 },
      { spread: 12, beat: 'CLIMAX', description: `The warmest moment — FULL, not quiet. A hug, a spin, laughter still ringing. NOT sleepy, NOT bedtime. Full of love and light and energy.`, wordTarget: 20 },
      { spread: 13, beat: 'CLOSING', description: `The last line. Joyful echo of the opening. Warm, bright, celebratory. NOT a goodnight, NOT falling asleep, NOT a dream. End in daylight with togetherness. A parent should want to read it twice.`, wordTarget: 15 },
    ];
  }

  _chooseRefrain(child, parentName) {
    // The refrain should use the child's word for mom and be under 8 words
    const callsMom = child.anecdotes?.calls_mom || parentName || 'Mama';
    // A set of refrain templates — the writer LLM will choose or create one
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

RULES:
- Keep every beat's purpose intact
- Replace generic placeholders with specific anecdotes from the child's real life
- Use concrete nouns and actions, never abstract claims
- The anecdotes should feel natural in the story, not forced in`;

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
    if (child.anecdotes?.mom_name) sections.push(`Mom's name: ${child.anecdotes.mom_name}`);

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
    sections.push(`- This is a CELEBRATION book, not a bedtime book. EVERY spread must be WARM, JOYFUL, and POSITIVE. No anger, crying, tantrums, frustration, tiredness, sleeping, winding down, or negative emotions at any point. The entire book should feel happy and loving from start to finish.`);
    sections.push(`- The ENDING must be warm, bright, and celebratory — NOT a goodnight, NOT falling asleep, NOT tucking in, NOT a dream. End in DAYLIGHT with togetherness, joy, and energy. The last image should be of ${child.name} and ${parentName} together in warmth and light.`);
    sections.push(`- Close on an IMAGE, not a declaration — no "I love you" as the last line`);
    sections.push(`- Every spread needs at least one concrete, specific noun`);
    sections.push(`- NO greeting card language. NO "you are special/wonderful/amazing"`);
    sections.push(`- The refrain must appear at least 3 times, spaced through the story`);
    sections.push(`- The refrain should DEEPEN in meaning each time it appears — same words, but the context around it shifts so it lands differently`);
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
