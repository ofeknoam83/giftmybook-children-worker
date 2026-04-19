/**
 * GenericThemeWriter — handles ALL themes except mothers_day.
 *
 * Theme-aware beat structures for 13 spreads across five categories:
 * - Parent themes (fathers_day): parent-child bond arc
 * - Celebration themes (birthday, birthday_magic): party/wish arc
 * - Adventure themes (adventure, fantasy, space, underwater, nature): exploration arc
 * - Daily life themes (bedtime, school, friendship, holiday): everyday arc
 * - Emotional themes (anxiety, anger, fear, grief, loneliness, new_beginnings,
 *   self_worth, family_change): feelings arc with coping/hope resolution
 *
 * Follows the same plan → write → revise pipeline as MothersDayWriter.
 */

const { BaseThemeWriter } = require('./base');
const { buildSystemPrompt } = require('../prompts/system');
const { checkAndFixPronouns } = require('../quality/pronoun');

// ── Theme category membership ──

const PARENT_THEMES = ['fathers_day'];
const CELEBRATION_THEMES = ['birthday', 'birthday_magic'];
const ADVENTURE_THEMES = ['adventure', 'fantasy', 'space', 'underwater', 'nature'];
const DAILY_LIFE_THEMES = ['bedtime', 'school', 'friendship', 'holiday'];
const EMOTIONAL_THEMES = [
  'anxiety', 'anger', 'fear', 'grief', 'loneliness',
  'new_beginnings', 'self_worth', 'family_change',
];

function getThemeCategory(theme) {
  if (PARENT_THEMES.includes(theme)) return 'parent';
  if (CELEBRATION_THEMES.includes(theme)) return 'celebration';
  if (ADVENTURE_THEMES.includes(theme)) return 'adventure';
  if (DAILY_LIFE_THEMES.includes(theme)) return 'daily_life';
  if (EMOTIONAL_THEMES.includes(theme)) return 'emotional';
  return 'adventure'; // default fallback
}

class GenericThemeWriter extends BaseThemeWriter {
  constructor(themeName) {
    super(themeName);
    this.category = getThemeCategory(themeName);
  }

  // ──────────────────────────────────────────
  // plan()
  // ──────────────────────────────────────────

  async plan(child, book) {
    const ageTier = this.getAgeTier(child.age);
    const spreadCount = this.getSpreadCount(child.age);
    const wordLimits = this.getWordLimits(child.age);
    const parentName = this.getParentName(child, book);
    const pronouns = this.getPronouns(child);

    const beats = this._buildBeats(ageTier, child, parentName, book);
    const refrain = this._chooseRefrain(child, parentName);

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
      wordTargets: { total: wordLimits.maxWords, perSpread: wordLimits.wordsPerSpread },
      parentName,
      pronouns,
      childName: child.name,
      theme: this.themeName,
      category: this.category,
    };
  }

  // ──────────────────────────────────────────
  // write()
  // ──────────────────────────────────────────

  async write(plan, child, book) {
    const systemPrompt = buildSystemPrompt(this.themeName, plan.ageTier, child, book, { role: 'writer' });
    const userPrompt = this._buildWritePrompt(plan, child, book);

    const result = await this.callLLM('writer', systemPrompt, userPrompt, { maxTokens: 4000 });

    let spreads = this.parseSpreads(result.text);

    const validation = this.validateStructure(spreads, child.age);
    if (!validation.valid && spreads.length < plan.spreadCount.min) {
      console.warn(`[writerV2] First write attempt has issues: ${validation.issues.join('; ')}. Retrying...`);
      const retryResult = await this.callLLM('writer', systemPrompt,
        userPrompt + '\n\nIMPORTANT: You MUST write exactly ' + plan.spreadCount.target + ' spreads.',
        { maxTokens: 4000, temperature: 0.9 });
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
          .replace(/\s*[\u2014\u2013]\s*/g, ', ')
          .replace(/(?<=[a-zA-Z])\s*-\s*(?=[a-zA-Z])/g, ', ');
      }
    }

    return { spreads, _model: result.model, _ageTier: plan.ageTier };
  }

  // ──────────────────────────────────────────
  // revise()
  // ──────────────────────────────────────────

  async revise(story, feedback, child, book) {
    const ageTier = story._ageTier || this.getAgeTier(child.age);
    const systemPrompt = buildSystemPrompt(this.themeName, ageTier, child, book, { role: 'reviser' });

    const currentText = story.spreads.map(s => `---SPREAD ${s.spread}---\n${s.text}`).join('\n\n');

    const userPrompt = `Here is the current story:\n\n${currentText}\n\n## REVISION FEEDBACK\n\n${feedback}\n\nRevise the story to address ALL of the issues above. Keep the same number of spreads (${story.spreads.length}). Preserve the emotional arc and refrain. Fix the specific issues identified.`;

    const result = await this.callLLM('reviser', systemPrompt, userPrompt, { maxTokens: 4000 });

    let spreads = this.parseSpreads(result.text);

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

    return { spreads, _model: result.model, _ageTier: ageTier };
  }

  // ──────────────────────────────────────────
  // Beat structures by theme category
  // ──────────────────────────────────────────

  _buildBeats(ageTier, child, parentName, book) {
    const isYoung = ageTier === 'young-picture';
    switch (this.category) {
      case 'parent':     return this._parentBeats(isYoung, child, parentName);
      case 'celebration': return this._celebrationBeats(isYoung, child);
      case 'adventure':  return this._adventureBeats(isYoung, child);
      case 'daily_life': return this._dailyLifeBeats(isYoung, child);
      case 'emotional':  return this._emotionalBeats(isYoung, child, book);
      default:           return this._adventureBeats(isYoung, child);
    }
  }

  // ── Parent themes (fathers_day) ──

  _parentBeats(isYoung, child, parentName) {
    const p = parentName || 'Daddy';
    const wt = isYoung ? 20 : 28;
    return [
      { spread: 1,  beat: 'OPENING',      description: `Place ${child.name} and ${p} in a specific morning moment. Simple, vivid, particular.`, wordTarget: wt },
      { spread: 2,  beat: 'ACTIVITY_1',   description: `First activity together, use child's anecdote if available. Concrete nouns, sensory detail.`, wordTarget: wt + 2 },
      { spread: 3,  beat: 'ACTIVITY_2',   description: `Second activity, daily routine moment. Show ${p}'s character through action.`, wordTarget: wt + 2 },
      { spread: 4,  beat: 'ACTIVITY_3',   description: `Third activity, playful, fun. Use child's interests if available.`, wordTarget: wt + 2 },
      { spread: 5,  beat: 'DEEPENING_1',  description: `${p} noticing something specific about ${child.name}. The shift from activities to connection.`, wordTarget: wt + 2 },
      { spread: 6,  beat: 'DEEPENING_2',  description: `${p} knows something nobody else knows, a specific gesture, habit, or look.`, wordTarget: wt + 2 },
      { spread: 7,  beat: 'DEEPENING_3',  description: `The noticing IS the love. ${p} saw something specific; that seeing is the love.`, wordTarget: wt },
      { spread: 8,  beat: 'EVEN_WHEN',    description: `Love holds when things are hard, child is tired, fussy, or overwhelmed.`, wordTarget: wt + 2 },
      { spread: 9,  beat: 'COMFORT',      description: `${p} gathers ${child.name} close. Physical comfort. The quiet after difficulty.`, wordTarget: wt + 2 },
      { spread: 10, beat: 'CLIMAX',       description: `Fewest words in the whole book. Physical closeness. Near wordless.`, wordTarget: isYoung ? 12 : 15 },
      { spread: 11, beat: 'RESOLUTION_1', description: `The world settles. Echo of the opening. Return to the specific place or image from spread 1.`, wordTarget: wt + 2 },
      { spread: 12, beat: 'RESOLUTION_2', description: `The refrain lands one final time. Close on an image, not a declaration.`, wordTarget: wt },
      { spread: 13, beat: 'CLOSING',      description: `The last line. Echo the opening. The most beautiful sentence in the book.`, wordTarget: isYoung ? 14 : 15 },
    ];
  }

  // ── Celebration themes (birthday, birthday_magic) ──

  _celebrationBeats(isYoung, child) {
    const wt = isYoung ? 20 : 28;
    return [
      { spread: 1,  beat: 'MORNING',       description: `${child.name} wakes on a special day. Morning light, birthday excitement, a sensory detail.`, wordTarget: wt },
      { spread: 2,  beat: 'ANTICIPATION',  description: `Something is coming, preparations happening around ${child.name}. Build excitement through concrete images.`, wordTarget: wt + 2 },
      { spread: 3,  beat: 'PREPARATION',   description: `Getting ready: decorations, outfit, maybe baking. Use favorite_cake_flavor if available.`, wordTarget: wt + 2 },
      { spread: 4,  beat: 'PARTY_BEGINS',  description: `The celebration starts. Friends or family arrive. Noise, color, action.`, wordTarget: wt + 2 },
      { spread: 5,  beat: 'ACTIVITIES',    description: `Party games, play, laughter. Use favorite_toys or interests if available.`, wordTarget: wt + 2 },
      { spread: 6,  beat: 'CONNECTION',    description: `A quiet moment amid the fun. ${child.name} notices something, feels something deeper.`, wordTarget: wt + 2 },
      { spread: 7,  beat: 'CAKE_CANDLES',  description: `The cake arrives. Candles lit. Faces glow in warm light. Build to the wish.`, wordTarget: wt },
      { spread: 8,  beat: 'WISH_MOMENT',   description: `Eyes closed, a wish forming. The quietest, most magical spread. Fewest words.`, wordTarget: isYoung ? 12 : 15 },
      { spread: 9,  beat: 'BLOW',          description: `The breath, the candles out, cheering erupts. Joy and release.`, wordTarget: wt + 2 },
      { spread: 10, beat: 'WARMTH',        description: `Surrounded by love. The feeling of being celebrated just for being you.`, wordTarget: wt + 2 },
      { spread: 11, beat: 'WINDING_DOWN',  description: `The party ends. Quiet settles. Echoes of laughter, crumbs on the table.`, wordTarget: wt },
      { spread: 12, beat: 'BEDTIME',       description: `${child.name} in bed, replaying the day. A favorite gift or memory glows in mind.`, wordTarget: wt },
      { spread: 13, beat: 'CLOSING',       description: `The last line. A wish fulfilled, or a secret smile. Echo the morning.`, wordTarget: isYoung ? 14 : 15 },
    ];
  }

  // ── Adventure themes (adventure, fantasy, space, underwater, nature) ──

  _adventureBeats(isYoung, child) {
    const wt = isYoung ? 20 : 28;
    const setting = {
      adventure: 'a path beyond the garden gate',
      fantasy: 'a world that shimmers just past the wardrobe',
      space: 'the stars above the rooftop',
      underwater: 'the waves that lap the shore',
      nature: 'the wild woods past the meadow',
    }[this.themeName] || 'somewhere just past the familiar';
    return [
      { spread: 1,  beat: 'HOOK',            description: `${child.name} discovers something that calls them toward ${setting}. Vivid, sensory, immediate.`, wordTarget: wt },
      { spread: 2,  beat: 'DISCOVERY',       description: `The new world opens up. Colors, sounds, textures. Wonder fills the scene.`, wordTarget: wt + 2 },
      { spread: 3,  beat: 'RISING_1',        description: `${child.name} ventures deeper. A companion or guide may appear. Use child's interests.`, wordTarget: wt + 2 },
      { spread: 4,  beat: 'RISING_2',        description: `A second discovery, stranger and more wonderful. The world reveals its rules.`, wordTarget: wt + 2 },
      { spread: 5,  beat: 'DEEP_EXPLORE',    description: `The heart of the adventure world. ${child.name} is fully immersed, confident, curious.`, wordTarget: wt + 2 },
      { spread: 6,  beat: 'CHALLENGE',       description: `Something goes wrong or gets tricky. A puzzle, a blockage, a moment of doubt.`, wordTarget: wt + 2 },
      { spread: 7,  beat: 'CLEVERNESS',      description: `${child.name} uses something they know, something from home, to solve it. Resourcefulness.`, wordTarget: wt + 2 },
      { spread: 8,  beat: 'TRIUMPH',         description: `The problem is solved. Joy, relief, pride. The world responds, celebrates.`, wordTarget: wt },
      { spread: 9,  beat: 'WONDER',          description: `A quiet beat of pure wonder. The most beautiful image in the book. Fewest words.`, wordTarget: isYoung ? 12 : 15 },
      { spread: 10, beat: 'GIFT',            description: `The world gives ${child.name} something to carry home, a token, a memory, a new understanding.`, wordTarget: wt + 2 },
      { spread: 11, beat: 'HOMECOMING',      description: `Returning home. The familiar world looks a little different now.`, wordTarget: wt },
      { spread: 12, beat: 'REFLECTION',      description: `Safe at home, but changed. The adventure lives inside. Echo of the opening.`, wordTarget: wt },
      { spread: 13, beat: 'CLOSING',         description: `The last line. A whisper of the adventure still waiting. The most beautiful sentence.`, wordTarget: isYoung ? 14 : 15 },
    ];
  }

  // ── Daily life themes (bedtime, school, friendship, holiday) ──

  _dailyLifeBeats(isYoung, child) {
    const wt = isYoung ? 20 : 28;
    const settingWord = { bedtime: 'evening', school: 'morning', friendship: 'afternoon', holiday: 'day' }[this.themeName] || 'day';
    return [
      { spread: 1,  beat: 'SETTING',        description: `The ${settingWord} begins for ${child.name}. A specific, familiar place. Sensory grounding.`, wordTarget: wt },
      { spread: 2,  beat: 'ROUTINE',        description: `A comforting routine unfolds. The rhythm of the ordinary. Concrete details.`, wordTarget: wt + 2 },
      { spread: 3,  beat: 'DISRUPTION',     description: `Something new or unexpected enters the scene. A change in the pattern.`, wordTarget: wt + 2 },
      { spread: 4,  beat: 'CURIOSITY',      description: `${child.name} responds to the new thing with curiosity. Exploration of the change.`, wordTarget: wt + 2 },
      { spread: 5,  beat: 'DEEPENING',      description: `The new thing leads somewhere unexpected. Richer than first thought.`, wordTarget: wt + 2 },
      { spread: 6,  beat: 'EMOTIONAL_CORE', description: `The heart of the story. What this really means to ${child.name}. A feeling, not a lesson.`, wordTarget: wt + 2 },
      { spread: 7,  beat: 'QUIET_MOMENT',   description: `A pause. Fewest words. ${child.name} sits with the feeling. Near wordless.`, wordTarget: isYoung ? 12 : 15 },
      { spread: 8,  beat: 'CONNECTION',     description: `Someone else shares the moment. A friend, a parent, a sibling. Togetherness.`, wordTarget: wt + 2 },
      { spread: 9,  beat: 'RESOLUTION',     description: `The disruption resolves. Not fixed, but understood. Comfort returns.`, wordTarget: wt + 2 },
      { spread: 10, beat: 'RETURN',         description: `Back to the routine, but it feels a little different now.`, wordTarget: wt },
      { spread: 11, beat: 'COMFORT',        description: `The safety of the familiar. Physical warmth, soft light, gentle sounds.`, wordTarget: wt },
      { spread: 12, beat: 'ECHO',           description: `The refrain lands one final time. Close on an image, not a declaration.`, wordTarget: wt },
      { spread: 13, beat: 'CLOSING',        description: `The last line. Echo the opening. The world is the same, but ${child.name} is a little more.`, wordTarget: isYoung ? 14 : 15 },
    ];
  }

  // ── Emotional themes (anxiety, anger, fear, grief, loneliness, etc.) ──

  _emotionalBeats(isYoung, child, book) {
    const wt = isYoung ? 20 : 28;
    const feeling = {
      anxiety: 'a worry that buzzes',
      anger: 'a hot feeling that rises',
      fear: 'a shadow that follows',
      grief: 'a missing that aches',
      loneliness: 'a quiet that spreads',
      new_beginnings: 'a strange new feeling',
      self_worth: 'a whisper that says "not enough"',
      family_change: 'a shift in the air at home',
    }[this.themeName] || 'a feeling that grows';
    const situation = book.emotionalSituation || '';
    const situationNote = situation ? ` Situation context: ${situation}.` : '';
    return [
      { spread: 1,  beat: 'NORMAL_DAY',    description: `A regular moment for ${child.name}. Everything seems fine on the surface.${situationNote}`, wordTarget: wt },
      { spread: 2,  beat: 'FEELING_ARRIVES', description: `${feeling} appears. Small at first. A physical sensation, not a label.`, wordTarget: wt + 2 },
      { spread: 3,  beat: 'FEELING_GROWS',  description: `The feeling gets bigger. It shows up in the body, in the world around ${child.name}.`, wordTarget: wt + 2 },
      { spread: 4,  beat: 'TRIES_TO_COPE',  description: `${child.name} tries to handle it alone. Maybe hides, maybe pushes back. It does not work yet.`, wordTarget: wt + 2 },
      { spread: 5,  beat: 'OVERWHELM',      description: `The feeling fills everything. The hardest spread. Honest, not scary.`, wordTarget: wt },
      { spread: 6,  beat: 'TURNING_POINT',  description: `Someone notices. A gentle adult or friend reaches toward ${child.name}. No lecture, just presence.`, wordTarget: wt + 2 },
      { spread: 7,  beat: 'NAMING',         description: `The feeling gets a name. Spoken aloud, it shrinks a little. "You feel..." Fewest words.`, wordTarget: isYoung ? 12 : 15 },
      { spread: 8,  beat: 'UNDERSTANDING',  description: `${child.name} learns the feeling is allowed. Everyone has it sometimes. Comfort.`, wordTarget: wt + 2 },
      { spread: 9,  beat: 'PRACTICE',       description: `A small tool or action to try when the feeling comes back. Concrete, not abstract.`, wordTarget: wt + 2 },
      { spread: 10, beat: 'TRYING_AGAIN',   description: `${child.name} goes back to the thing that was hard. The feeling is still there, but smaller.`, wordTarget: wt + 2 },
      { spread: 11, beat: 'SMALL_WIN',      description: `A moment of bravery, or calm, or acceptance. Not perfection, just enough.`, wordTarget: wt },
      { spread: 12, beat: 'SAFETY',         description: `The refrain lands one final time. ${child.name} is held, safe, understood.`, wordTarget: wt },
      { spread: 13, beat: 'CLOSING',        description: `The last line. The feeling may come back, but ${child.name} knows what to do. Hope, not cure.`, wordTarget: isYoung ? 14 : 15 },
    ];
  }

  // ──────────────────────────────────────────
  // Refrain
  // ──────────────────────────────────────────

  _chooseRefrain(child, parentName) {
    if (this.category === 'parent') {
      const word = parentName || 'Daddy';
      return {
        parentWord: word,
        suggestions: [
          `${word} is here.`,
          `${word} always knows.`,
          `That's what ${word} does.`,
          `Because ${word} loves you.`,
        ],
      };
    }

    // For non-parent themes, let the LLM choose a theme-appropriate refrain
    const themeRefrainHints = {
      birthday:        ['The best day yet.', 'A wish, a breath, a glow.', 'Today is yours.'],
      birthday_magic:  ['The magic knows your name.', 'One more candle, one more year.', 'A wish, a breath, a glow.'],
      adventure:       ['What waits around the bend.', 'One more step to go.', 'The bravest thing you know.'],
      fantasy:         ['The door is always there.', 'Where wonders wait for you.', 'The magic knows your name.'],
      space:           ['The stars know who you are.', 'Beyond the sky you grew.', 'One small step, one giant heart.'],
      underwater:      ['The waves will bring you home.', 'Deeper, braver, free.', 'The sea remembers you.'],
      nature:          ['The wild knows who you are.', 'The woods remember you.', 'Where roots run deep.'],
      bedtime:         ['The night is soft and true.', 'Sleep is coming soon.', 'The dark is just a hug.'],
      school:          ['You belong right here.', 'Brave enough to try.', 'A little more each day.'],
      friendship:      ['A friend who understands.', 'Side by side, just right.', 'That is what friends do.'],
      holiday:         ['The best time of the year.', 'Together, warm, and bright.', 'This is how we shine.'],
      anxiety:         ['The worry will not win.', 'Brave and scared at once.', 'Breathe, and start again.'],
      anger:           ['The fire fades to warm.', 'Big feelings, bigger heart.', 'It is safe to feel.'],
      fear:            ['The dark is not so tall.', 'Brave looks just like you.', 'One step, then one more.'],
      grief:           ['Love does not go away.', 'I carry them with me.', 'The missing means you loved.'],
      loneliness:      ['You are not alone.', 'Someone sees you there.', 'A hand will find yours soon.'],
      new_beginnings:  ['New can be good too.', 'One door opens wide.', 'The first step is the start.'],
      self_worth:      ['You are just enough.', 'The world is glad you came.', 'There is only one of you.'],
      family_change:   ['Love does not move out.', 'Home is where you are.', 'We are still a we.'],
    };

    return {
      parentWord: null,
      suggestions: themeRefrainHints[this.themeName] || ['And so the story goes.', 'Just like only you can.', 'That is how it is.'],
    };
  }

  // ──────────────────────────────────────────
  // LLM plan enrichment
  // ──────────────────────────────────────────

  async _enrichPlanWithLLM(beats, child, book, parentName, ageTier) {
    const anecdoteText = this._formatAnecdotes(child.anecdotes);
    if (!anecdoteText) return beats;

    const themeLabel = this.themeName.replace(/_/g, ' ');
    const parentNote = parentName ? ` about ${child.name} and ${parentName}` : ` about ${child.name}`;

    const systemPrompt = `You are a children's book story planner specializing in ${themeLabel} picture books. Your job is to weave specific, real details about this child into the story beat structure.

RULES:
- Keep every beat's purpose intact
- Replace generic placeholders with specific anecdotes from the child's real life
- Use concrete nouns and actions, never abstract claims
- The anecdotes should feel natural in the story, not forced in`;

    const userPrompt = `Here are the story beats for a ${ageTier} ${themeLabel} book${parentNote}:

${beats.map(b => `Spread ${b.spread} (${b.beat}): ${b.description}`).join('\n')}

Here are real details about this child:
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

  // ──────────────────────────────────────────
  // Write prompt builder
  // ──────────────────────────────────────────

  _buildWritePrompt(plan, child, book) {
    const pronouns = plan.pronouns;
    const anecdoteText = this._formatAnecdotes(child.anecdotes);
    const sections = [];

    sections.push(`## THE CHILD\n`);
    sections.push(`Name: ${child.name}`);
    sections.push(`Age: ${child.age}`);
    sections.push(`Gender: ${child.gender || 'not specified'} (pronouns: ${pronouns.pair})`);
    if (child.appearance) sections.push(`Appearance: ${child.appearance}`);
    if (child.interests?.length) sections.push(`Interests: ${child.interests.join(', ')}`);

    // Parent context for parent themes
    if (this.category === 'parent' && plan.parentName) {
      const parentLabel = this.themeName === 'fathers_day' ? 'THE FATHER' : 'THE PARENT';
      sections.push(`\n## ${parentLabel}\n`);
      sections.push(`The child calls them: ${plan.parentName}`);
      if (child.anecdotes?.dad_name) sections.push(`Dad's name: ${child.anecdotes.dad_name}`);
      if (child.anecdotes?.mom_name) sections.push(`Mom's name: ${child.anecdotes.mom_name}`);
    }

    // Theme-specific context
    if (this.category === 'celebration') {
      sections.push(`\n## CELEBRATION DETAILS\n`);
      if (child.anecdotes?.favorite_cake_flavor) sections.push(`Favorite cake flavor: ${child.anecdotes.favorite_cake_flavor}`);
      if (child.anecdotes?.favorite_toys) sections.push(`Favorite toys: ${child.anecdotes.favorite_toys}`);
      if (child.anecdotes?.birth_date) sections.push(`Birth date: ${child.anecdotes.birth_date}`);
    }

    if (this.category === 'emotional') {
      sections.push(`\n## EMOTIONAL CONTEXT\n`);
      sections.push(`Theme: ${this.themeName.replace(/_/g, ' ')}`);
      if (book.emotionalCategory) sections.push(`Category: ${book.emotionalCategory}`);
      if (book.emotionalSituation) sections.push(`Situation: ${book.emotionalSituation}`);
      if (book.emotionalParentGoal) sections.push(`Parent's goal: ${book.emotionalParentGoal}`);
      if (book.copingResourceHint) sections.push(`Coping resource: ${book.copingResourceHint}`);
      sections.push('\nThis story should validate the child\'s feelings, never dismiss them. Show feelings in the body (tight chest, hot cheeks, shaky hands) rather than labeling them. The resolution is understanding and tools, not a cure.');
    }

    if (anecdoteText) {
      sections.push(`\n## REAL DETAILS ABOUT THIS CHILD\n`);
      sections.push(anecdoteText);
      sections.push('\nWeave these real details naturally into the story. They make the book feel personal and specific.');
    }

    if (book.heartfeltNote) {
      sections.push(`\n## HEARTFELT NOTE FROM THE PERSON ORDERING THIS BOOK\n`);
      sections.push(`"${book.heartfeltNote}"`);
      sections.push('Use the emotion and intent of this note to guide the story\'s tone.');
    }

    if (book.bookFrom) {
      sections.push(`\n## BOOK FROM\n`);
      sections.push(`This book is from: ${book.bookFrom}`);
    }

    sections.push(`\n## STORY PLAN\n`);
    sections.push(`Theme: ${this.themeName.replace(/_/g, ' ')}`);
    sections.push(`Age tier: ${plan.ageTier}`);
    sections.push(`Target spread count: ${plan.spreadCount.target}`);
    sections.push(`Total word target: ${plan.wordTargets.total} words maximum`);
    sections.push(`Words per spread: ${plan.wordTargets.perSpread.min}-${plan.wordTargets.perSpread.max}`);

    sections.push(`\n## REFRAIN\n`);
    sections.push(`The story MUST have a refrain, a short phrase that recurs exactly 3 times (evenly spaced, not in consecutive spreads).`);
    if (plan.refrain.parentWord) {
      sections.push(`It should use "${plan.refrain.parentWord}" and be under 8 words.`);
    } else {
      sections.push(`The refrain should be under 8 words and capture the emotional core of the theme.`);
    }
    sections.push(`Suggested refrains (you may create your own):`);
    plan.refrain.suggestions.forEach(s => sections.push(`- "${s}"`));

    sections.push(`\n## BEAT STRUCTURE\n`);
    sections.push(`Write exactly ${plan.spreadCount.target} spreads following this structure:\n`);
    plan.beats.forEach(b => {
      sections.push(`Spread ${b.spread} (${b.beat}): ${b.description} [~${b.wordTarget} words]`);
    });

    // Find the climax/quiet beat
    const climaxBeat = plan.beats.find(b =>
      b.beat === 'CLIMAX' || b.beat === 'WISH_MOMENT' || b.beat === 'WONDER' ||
      b.beat === 'QUIET_MOMENT' || b.beat === 'NAMING'
    );

    sections.push(`\n## CRITICAL REMINDERS\n`);
    sections.push(`- AABB couplets throughout, every line pair must rhyme`);
    if (climaxBeat) {
      sections.push(`- The climax/quiet spread (${climaxBeat.spread}) should have the FEWEST words`);
    }
    sections.push(`- Close on an IMAGE, not a declaration, no "I love you" as the last line`);
    sections.push(`- Every spread needs at least one concrete, specific noun`);
    sections.push(`- NO greeting card language. NO "you are special/wonderful/amazing"`);
    sections.push(`- The refrain must appear exactly 3 times, evenly spaced (not in consecutive spreads). More than 4 appearances makes the story monotonous.`);
    sections.push(`- RHYME VARIETY: Do NOT let one rhyme sound dominate. If the refrain ends with a word like "here," other spreads must use different end-rhyme sounds. Each spread should find its own fresh rhyme pair.`);
    if (plan.parentName) {
      sections.push(`- Use ONLY the parent name "${plan.parentName}", do NOT invent any other name for the parent`);
    }
    sections.push(`- Do NOT invent names not provided in the input. Only use "${child.name}" and any names given above.`);
    sections.push(`- NEVER use they/them/their pronouns for ${child.name}. ${child.gender === 'female' ? 'She is a girl, use she/her.' : child.gender === 'male' ? 'He is a boy, use he/him.' : ''} Use the child's name or correct pronouns. "They" is only for plural subjects.`);
    sections.push(`- NEVER use dashes, hyphens, or em dashes in the story text. Use commas, periods, or line breaks instead.`);
    sections.push(`- Format each spread as: ---SPREAD N--- followed by the text`);

    return sections.join('\n');
  }

  // ──────────────────────────────────────────
  // Anecdote formatting
  // ──────────────────────────────────────────

  _formatAnecdotes(anecdotes) {
    if (!anecdotes) return '';
    const parts = [];
    if (anecdotes.favorite_activities) parts.push(`Favorite activities: ${anecdotes.favorite_activities}`);
    if (anecdotes.funny_thing) parts.push(`Funny thing they do: ${anecdotes.funny_thing}`);
    if (anecdotes.meaningful_moment) parts.push(`Meaningful moment: ${anecdotes.meaningful_moment}`);
    if (anecdotes.moms_favorite_moment) parts.push(`Mom's favorite moment: ${anecdotes.moms_favorite_moment}`);
    if (anecdotes.favorite_food) parts.push(`Favorite food: ${anecdotes.favorite_food}`);
    if (anecdotes.favorite_cake_flavor) parts.push(`Favorite cake flavor: ${anecdotes.favorite_cake_flavor}`);
    if (anecdotes.favorite_toys) parts.push(`Favorite toys: ${anecdotes.favorite_toys}`);
    if (anecdotes.other_detail) parts.push(`Other detail: ${anecdotes.other_detail}`);
    if (anecdotes.anything_else) parts.push(`Additional: ${anecdotes.anything_else}`);
    return parts.join('\n');
  }
}

module.exports = { GenericThemeWriter };
