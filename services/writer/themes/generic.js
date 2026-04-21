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
const { sanitizeNonLatinChars } = require('../quality/sanitize');
const { selectPlotTemplate, matchTitleToPlot, generateCustomPlot, generateAnecdoteDrivenPlot, isPlaceholderTitle } = require('./plots');

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

  async plan(child, book, opts = {}) {
    const ageTier = this.getAgeTier(child.age);
    const spreadCount = this.getSpreadCount(child.age);
    const wordLimits = this.getWordLimits(child.age);
    const parentName = this.getParentName(child, book);
    const pronouns = this.getPronouns(child);

    // ── Seed backbone path ──
    // If the caller (server.js) handed us a validated brainstormStorySeed with 13 beats,
    // use those as the beat backbone instead of selecting a random plot template.
    // This keeps the creative seed work (narrative_spine, beats, favorite_object, etc.)
    // from being discarded. Falls back to template flow if seed is missing/invalid.
    const seedBeats = this._normalizeSeedBeats(opts.storySeed?.beats, ageTier);
    let beats;
    let usedSeed = false;
    let anecdotePlot = null;
    const anecdoteDrivenCategories = new Set(['celebration', 'parent']);

    if (seedBeats && this.category !== 'emotional') {
      this._selectedPlot = null;
      this._storySeed = opts.storySeed;
      beats = seedBeats;
      usedSeed = true;
    } else if (
      anecdoteDrivenCategories.has(this.category)
      && !book.plotId
      && child.anecdotes
      && Object.keys(child.anecdotes).length > 0
    ) {
      try {
        const isYoung = ageTier === 'young-picture';
        const wt = isYoung ? 16 : 28;
        anecdotePlot = await generateAnecdoteDrivenPlot({
          theme: this.themeName,
          child,
          book,
          parentName,
          isYoung,
          wt,
          writer: this,
        });
      } catch (err) {
        console.warn(`[writerV2] Anecdote-driven plot generation failed for ${this.themeName}: ${err.message}`);
      }

      if (anecdotePlot) {
        this._selectedPlot = anecdotePlot;
        this._manifest = anecdotePlot.manifest;
        beats = anecdotePlot.beats;
        console.log(`[writerV2] Using anecdote-driven plot "${anecdotePlot.id}" for ${this.themeName} (${anecdotePlot.manifest?.length || 0} anecdote assignments)`);
      } else {
        // Fall back to template flow
        let titleMatchFailed = false;
        if (book.title) {
          try {
            const matchedId = await matchTitleToPlot(book.title, this.themeName);
            if (matchedId) book = { ...book, plotId: matchedId };
            else titleMatchFailed = true;
          } catch (err) {
            console.warn(`[writerV2] Title-to-plot matching failed for "${book.title}": ${err.message}`);
            titleMatchFailed = true;
          }
        }
        beats = titleMatchFailed
          ? await this._buildBeatsWithCustomFallback(ageTier, child, parentName, book)
          : this._buildBeats(ageTier, child, parentName, book);
      }
    } else {
      let titleMatchFailed = false;
      if (!book.plotId && book.title && this.category !== 'emotional') {
        try {
          const matchedId = await matchTitleToPlot(book.title, this.themeName);
          if (matchedId) {
            book = { ...book, plotId: matchedId };
          } else {
            titleMatchFailed = true;
          }
        } catch (err) {
          console.warn(`[writerV2] Title-to-plot matching failed for "${book.title}": ${err.message}`);
          titleMatchFailed = true;
        }
      }

      beats = titleMatchFailed
        ? await this._buildBeatsWithCustomFallback(ageTier, child, parentName, book)
        : this._buildBeats(ageTier, child, parentName, book);
    }

    const refrain = this._chooseRefrain(child, parentName, opts.storySeed);

    // Only run the generic enrichment pass when we're NOT using the anecdote-driven
    // plot. That plot's two-pass flow already hard-assigns anecdotes to beats —
    // re-enriching would dilute the specificity.
    let enrichedBeats = beats;
    if (!anecdotePlot && child.anecdotes && Object.keys(child.anecdotes).length > 0) {
      try {
        enrichedBeats = await this._enrichPlanWithLLM(beats, child, book, parentName, ageTier);
      } catch (err) {
        console.warn(`[writerV2] Plan enrichment failed, using template beats: ${err.message}`);
      }
    }

    const plot = this._selectedPlot;
    const seed = usedSeed ? opts.storySeed : null;
    return {
      beats: enrichedBeats,
      refrain,
      ageTier,
      spreadCount: { min: spreadCount.min, max: spreadCount.max, target: Math.min(spreadCount.max, enrichedBeats.length) },
      wordTargets: { total: wordLimits.maxWords, perSpread: wordLimits.wordsPerSpread },
      parentName,
      pronouns,
      childName: child.name,
      theme: this.themeName,
      category: this.category,
      plotId: plot?.id || null,
      plotName: plot?.name || null,
      plotSynopsis: plot?.synopsis || (seed?.narrative_spine || null),
      storySeed: seed,
      usedSeed,
      manifest: anecdotePlot?.manifest || null,
    };
  }

  /**
   * Convert the brainstormed `beats` (array of 13 one-line strings) into the
   * Writer V2 beat-object shape: { spread, beat, description, wordTarget }.
   * Returns null if the seed beats aren't usable (missing, too few, wrong shape).
   */
  _normalizeSeedBeats(rawBeats, ageTier) {
    if (!Array.isArray(rawBeats) || rawBeats.length < 10) return null;
    const isYoung = ageTier === 'young-picture';
    const wt = isYoung ? 16 : 28;
    // Canonical beat labels for a 13-spread arc (fallback when seed lacks them)
    const DEFAULT_LABELS = [
      'HOOK', 'DISCOVERY', 'RISING_1', 'RISING_2', 'DEEP_EXPLORE',
      'CHALLENGE', 'CLEVERNESS', 'TRIUMPH', 'WONDER', 'GIFT',
      'HOMECOMING', 'REFLECTION', 'CLOSING',
    ];
    const normalized = rawBeats.slice(0, 13).map((b, i) => {
      const spread = i + 1;
      const label = DEFAULT_LABELS[i] || `SPREAD_${spread}`;
      let description = '';
      if (typeof b === 'string') {
        description = b.trim();
      } else if (b && typeof b === 'object') {
        description = (b.description || b.text || b.beat || '').toString().trim();
      }
      if (!description) return null;
      // Strip a leading "Spread N:" / "Spread N -" / "Spread N (LABEL):" prefix if present
      description = description
        .replace(/^\s*spread\s*\d+\s*[:\-\u2014]\s*/i, '')
        .replace(/^\s*spread\s*\d+\s*\([^)]*\)\s*[:\-\u2014]?\s*/i, '')
        .trim();
      // Pick a slightly smaller word target for the quiet/wish/closing beats
      const quietBeats = new Set(['WONDER', 'CLOSING']);
      const wordTarget = quietBeats.has(label) ? (isYoung ? 12 : 15) : wt;
      return { spread, beat: label, description, wordTarget };
    }).filter(Boolean);
    // Require at least 10 valid beats; pad to 13 from canonical adventure fallback if short
    if (normalized.length < 10) return null;
    return normalized;
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

    // ── Title-coherence check: ensure at least one of the title's keywords appears in the text ──
    // If none of the meaningful title words show up anywhere, the book is disconnected from its cover.
    // One retry with stronger title-anchoring instructions is cheap insurance.
    if (book.title && !isPlaceholderTitle(book.title)) {
      const titleKeywords = this._extractTitleKeywords(book.title, child.name);
      if (titleKeywords.length > 0) {
        const combined = spreads.map(s => (s.text || '')).join(' ').toLowerCase();
        const matches = titleKeywords.filter(k => combined.includes(k));
        if (matches.length === 0) {
          console.warn(`[writerV2] Title-coherence check FAILED for "${book.title}" — none of [${titleKeywords.join(', ')}] in story text. Retrying with stronger anchoring.`);
          const anchorAddendum = `\n\nCRITICAL TITLE ANCHOR — READ BEFORE REWRITING:\nThe book's cover title is "${book.title}". The previous draft did NOT include the title's core concept. In this rewrite, at least TWO of these title keywords MUST appear literally in the story text: ${titleKeywords.map(k => `"${k}"`).join(', ')}. The title's subject MUST be concretely present in spread 1 or 2, at the climax around spread 7, and in the final spread. Do NOT write a generic theme story — the text must clearly belong under this cover.`;
          try {
            const retryResult = await this.callLLM('writer', systemPrompt, userPrompt + anchorAddendum, { maxTokens: 4000, temperature: 0.85 });
            const retrySpreads = this.parseSpreads(retryResult.text);
            if (retrySpreads.length >= plan.spreadCount.min) {
              const retryCombined = retrySpreads.map(s => (s.text || '')).join(' ').toLowerCase();
              const retryMatches = titleKeywords.filter(k => retryCombined.includes(k));
              // Prefer the retry if it improves keyword coverage OR ties; otherwise keep original.
              if (retryMatches.length >= matches.length) {
                spreads = retrySpreads;
                console.log(`[writerV2] Title-coherence retry succeeded: ${retryMatches.length}/${titleKeywords.length} title keywords present.`);
              }
            }
          } catch (err) {
            console.warn(`[writerV2] Title-coherence retry failed: ${err.message}`);
          }
        }
      }
    }

    // ── Cake-coherence check for birthday themes ──
    // Spreads 12-13 MUST depict the cake climax: spread 12 is the
    // wish + blowing out candles, spread 13 is the first bite of cake.
    // If neither spread mentions cake/candles/wish imagery, retry with a
    // stronger cake anchor. Mirrors the title-coherence retry above.
    if (this.category === 'celebration' && spreads.length >= 12) {
      const cakeTerms = /\b(cake|candle|candles|frosting|icing|wish|blow|blew|bite)\b/i;
      const spread12 = spreads.find(s => s.spread === 12) || spreads[11];
      const spread13 = spreads.find(s => s.spread === 13) || spreads[12];
      const text12 = (spread12?.text || '');
      const text13 = (spread13?.text || '');
      const has12 = cakeTerms.test(text12);
      const has13 = cakeTerms.test(text13);
      if (!has12 || !has13) {
        const flavor = child.anecdotes?.favorite_cake_flavor
          ? ` (${child.anecdotes.favorite_cake_flavor})`
          : '';
        console.warn(`[writerV2] Cake-coherence check FAILED — spreads 12-13 missing cake imagery. Retrying with stronger anchoring.`);
        const cakeAddendum = `\n\nCRITICAL CAKE CLIMAX — READ BEFORE REWRITING:\nThis is a BIRTHDAY book for ${child.name}. The previous draft did NOT land the cake climax.\n- Spread 12 MUST be the wish-and-blow moment: the cake${flavor} with lit candles in front of ${child.name}, eyes closing for a wish, candles blown out. Name the cake and the candles in the text.\n- Spread 13 MUST be the first-bite joy: ${child.name} taking the first bite of cake${flavor}, pure happiness on their face. Name the cake in the text.\n- The ending must be JOYFUL and in DAYLIGHT — never a bedtime / sleep / goodnight ending.\nKeep spreads 1-11 substantially the same. Only rewrite the final two spreads to deliver the cake climax.`;
        try {
          const retryResult = await this.callLLM('writer', systemPrompt, userPrompt + cakeAddendum, { maxTokens: 4000, temperature: 0.85 });
          const retrySpreads = this.parseSpreads(retryResult.text);
          if (retrySpreads.length >= plan.spreadCount.min) {
            const retry12 = retrySpreads.find(s => s.spread === 12) || retrySpreads[11];
            const retry13 = retrySpreads.find(s => s.spread === 13) || retrySpreads[12];
            const retryHas12 = cakeTerms.test(retry12?.text || '');
            const retryHas13 = cakeTerms.test(retry13?.text || '');
            if ((retryHas12 ? 1 : 0) + (retryHas13 ? 1 : 0) > (has12 ? 1 : 0) + (has13 ? 1 : 0)) {
              spreads = retrySpreads;
              console.log(`[writerV2] Cake-coherence retry succeeded: spread12=${retryHas12}, spread13=${retryHas13}`);
            }
          }
        } catch (err) {
          console.warn(`[writerV2] Cake-coherence retry failed: ${err.message}`);
        }
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

    sanitizeNonLatinChars(spreads);

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

    sanitizeNonLatinChars(spreads);

    return { spreads, _model: result.model, _ageTier: ageTier };
  }

  // ──────────────────────────────────────────
  // Beat structures by theme category
  // ──────────────────────────────────────────

  _buildBeats(ageTier, child, parentName, book) {
    const isYoung = ageTier === 'young-picture';
    const wt = isYoung ? 16 : 28;

    // Try plot templates for non-emotional themes
    if (this.category !== 'emotional') {
      const plotTemplate = selectPlotTemplate(this.themeName, { plotId: book?.plotId });
      if (plotTemplate) {
        this._selectedPlot = plotTemplate;
        return plotTemplate.beats({ child, isYoung, wt, parentName, book, theme: this.themeName });
      }
    }

    // Fallback to hardcoded beats (emotional themes + unknown themes without templates)
    this._selectedPlot = null;
    switch (this.category) {
      case 'parent':     return this._parentBeats(isYoung, child, parentName);
      case 'celebration': return this._celebrationBeats(isYoung, child);
      case 'adventure':  return this._adventureBeats(isYoung, child);
      case 'daily_life': return this._dailyLifeBeats(isYoung, child);
      case 'emotional':  return this._emotionalBeats(isYoung, child, book);
      default:           return this._adventureBeats(isYoung, child);
    }
  }

  /**
   * Async wrapper for _buildBeats that supports custom plot generation.
   * Called from plan() instead of _buildBeats when a title exists but no plot matched.
   */
  async _buildBeatsWithCustomFallback(ageTier, child, parentName, book) {
    const isYoung = ageTier === 'young-picture';
    const wt = isYoung ? 16 : 28;

    if (this.category !== 'emotional' && book?.title && !isPlaceholderTitle(book.title) && !book.plotId) {
      try {
        const customPlot = await generateCustomPlot(book.title, this.themeName, { child, isYoung, wt });
        if (customPlot) {
          this._selectedPlot = customPlot;
          return customPlot.beats;
        }
      } catch (err) {
        console.warn(`[writerV2] Custom plot generation failed, using template: ${err.message}`);
      }
    }

    return this._buildBeats(ageTier, child, parentName, book);
  }

  // ── Parent themes (fathers_day) ──

  _parentBeats(isYoung, child, parentName) {
    const p = parentName || 'Daddy';
    const wt = isYoung ? 16 : 28;
    return [
      // SCENE A — HOME / LAUNCH (spreads 1-3)
      { spread: 1,  beat: 'HOME_OPENING',   description: `Place ${child.name} and ${p} in a specific moment at home — mid-action, not waking up. Establish the bond AND hint at a plan (building something, going somewhere). Vivid, particular.`, wordTarget: wt },
      { spread: 2,  beat: 'HOME_PREPARING',  description: `The plan takes shape — gathering tools, putting on shoes, starting the project. A moment showing how they work together. Use child's anecdote. Same location.`, wordTarget: wt + 2 },
      { spread: 3,  beat: 'HOME_RITUAL',     description: `Something only THIS pair does — a funny handshake, ${p}'s signature move, a shared joke. Woven into the preparation, not a standalone scene.`, wordTarget: wt + 2 },
      // SCENE B — THE ADVENTURE (spreads 4-7)
      { spread: 4,  beat: 'ADVENTURE_START', description: `They head out or the project deepens — show the transition. The world opens up. Anticipation and excitement.`, wordTarget: wt + 2 },
      { spread: 5,  beat: 'ADVENTURE_SKILL', description: `${p} does something that amazes ${child.name} — a skill, a trick, lifting something heavy, fixing something. Connected to the adventure/project.`, wordTarget: wt + 2 },
      { spread: 6,  beat: 'ADVENTURE_PLAY',  description: `A funny or playful moment within the adventure — physical comedy, stick swords, a shared joke. Still in the same scene.`, wordTarget: wt + 2 },
      { spread: 7,  beat: 'ADVENTURE_QUIET', description: `A quieter beat — working side by side, watching something together. The story breathes before the peak. Still in the same place.`, wordTarget: wt },
      // SCENE C — THE PEAK (spreads 8-11)
      { spread: 8,  beat: 'BIG_MOMENT',     description: `The adventure reaches its destination or the project nears completion. The payoff they've been building toward.`, wordTarget: wt + 2 },
      { spread: 9,  beat: 'PEAK_JOY',       description: `The best moment — triumphant, exciting. A high-five, a victory dance, the finished thing. Maximum energy. Physical, joyful, specific.`, wordTarget: wt + 2 },
      { spread: 10, beat: 'CHILD_LEADS',    description: `${child.name} does something that surprises or impresses ${p} — shows what they learned, takes a turn, makes a gift. Warm role reversal.`, wordTarget: wt + 2 },
      { spread: 11, beat: 'PROUD',          description: `${p} and ${child.name} share a look, a word, a gesture. Admiration flows both ways. The emotional high point — deeper, not louder.`, wordTarget: wt },
      // SCENE D — HEADING HOME (spreads 12-13)
      { spread: 12, beat: 'HEADING_HOME',   description: `The journey home or the finished project admired. One warm transitional beat. NOT sleepy, NOT bedtime.`, wordTarget: wt },
      { spread: 13, beat: 'CLOSING',        description: `The last line. Joyful echo of the opening. Concrete, specific, beautiful. A parent should want to read it twice.`, wordTarget: isYoung ? 12 : 15 },
    ];
  }

  // ── Celebration themes (birthday, birthday_magic) ──

  _celebrationBeats(isYoung, child) {
    const wt = isYoung ? 16 : 28;
    return [
      // SCENE A — MORNING / PREPARATION (spreads 1-3, at home)
      { spread: 1,  beat: 'MORNING',       description: `${child.name} wakes on a special day. Morning light, birthday excitement, a sensory detail. At home.`, wordTarget: wt },
      { spread: 2,  beat: 'ANTICIPATION',  description: `Something is coming — preparations happening around ${child.name}. Build excitement through concrete images. Still at home.`, wordTarget: wt + 2 },
      { spread: 3,  beat: 'PREPARATION',   description: `Getting ready: decorations, outfit, maybe baking. Use favorite_cake_flavor if available. Still at home, same scene as spreads 1-2.`, wordTarget: wt + 2 },
      // SCENE B — THE PARTY (spreads 4-6, at the party location)
      { spread: 4,  beat: 'PARTY_BEGINS',  description: `The celebration starts. Friends or family arrive. Noise, color, action. Show where the party is.`, wordTarget: wt + 2 },
      { spread: 5,  beat: 'ACTIVITIES',    description: `Party games, play, laughter. Use favorite_toys or interests if available. Same party location.`, wordTarget: wt + 2 },
      { spread: 6,  beat: 'CONNECTION',    description: `A quiet moment amid the fun. ${child.name} notices something, feels something deeper. Still at the party.`, wordTarget: wt + 2 },
      // SCENE C — THE CAKE / WISH (spreads 7-10, the emotional peak at the party)
      { spread: 7,  beat: 'CAKE_CANDLES',  description: `The cake arrives. Candles lit. Faces glow in warm light. Build to the wish. Same party location.`, wordTarget: wt },
      { spread: 8,  beat: 'WISH_MOMENT',   description: `Eyes closed, a wish forming. The quietest, most magical spread. Fewest words.`, wordTarget: isYoung ? 12 : 15 },
      { spread: 9,  beat: 'BLOW',          description: `The breath, the candles out, cheering erupts. Joy and release. Still at the party.`, wordTarget: wt + 2 },
      { spread: 10, beat: 'WARMTH',        description: `Surrounded by love. The feeling of being celebrated just for being you. The emotional high point.`, wordTarget: wt + 2 },
      // SCENE D — AFTER THE PARTY (spreads 11-13, back at home, warm and happy)
      { spread: 11, beat: 'WINDING_DOWN',  description: `The party ends, transition home. Quiet settles. Echoes of laughter, crumbs on the table.`, wordTarget: wt },
      { spread: 12, beat: 'GLOW',          description: `${child.name} at home, still buzzing from the day. A favorite gift examined, a balloon still floating, frosting on a finger. NOT bedtime, NOT sleepy.`, wordTarget: wt },
      { spread: 13, beat: 'CLOSING',       description: `The last line. A wish fulfilled, or a secret smile. Echo the morning. Warm, bright, joyful. NOT a goodnight, NOT asleep.`, wordTarget: isYoung ? 12 : 15 },
    ];
  }

  // ── Adventure themes (adventure, fantasy, space, underwater, nature) ──

  _adventureBeats(isYoung, child) {
    const wt = isYoung ? 16 : 28;
    const setting = {
      adventure: 'a path beyond the garden gate',
      fantasy: 'a world that shimmers just past the wardrobe',
      space: 'the stars above the rooftop',
      underwater: 'the waves that lap the shore',
      nature: 'the wild woods past the meadow',
    }[this.themeName] || 'somewhere just past the familiar';
    return [
      // SCENE A — THE CALL (spreads 1-3, home / the threshold)
      { spread: 1,  beat: 'HOOK',            description: `${child.name} discovers something that calls them toward ${setting}. Vivid, sensory, immediate. At home or a familiar place.`, wordTarget: wt },
      { spread: 2,  beat: 'DISCOVERY',       description: `The new world opens up. Colors, sounds, textures. Wonder fills the scene. The threshold crossing.`, wordTarget: wt + 2 },
      { spread: 3,  beat: 'RISING_1',        description: `${child.name} ventures deeper. A companion or guide may appear. Use child's interests. Same new world.`, wordTarget: wt + 2 },
      // SCENE B — DEEP EXPLORATION (spreads 4-7, the adventure world)
      { spread: 4,  beat: 'RISING_2',        description: `A second discovery, stranger and more wonderful. The world reveals its rules. Same adventure world.`, wordTarget: wt + 2 },
      { spread: 5,  beat: 'DEEP_EXPLORE',    description: `The heart of the adventure world. ${child.name} is fully immersed, confident, curious. Same location.`, wordTarget: wt + 2 },
      { spread: 6,  beat: 'CHALLENGE',       description: `Something goes wrong or gets tricky. A puzzle, a blockage, a moment of doubt. Same adventure world.`, wordTarget: wt + 2 },
      { spread: 7,  beat: 'CLEVERNESS',      description: `${child.name} uses something they know, something from home, to solve it. Resourcefulness. Same location as the challenge.`, wordTarget: wt + 2 },
      // SCENE C — TRIUMPH & WONDER (spreads 8-10, the peak of the adventure)
      { spread: 8,  beat: 'TRIUMPH',         description: `The problem is solved. Joy, relief, pride. The world responds, celebrates. Same adventure world.`, wordTarget: wt },
      { spread: 9,  beat: 'WONDER',          description: `A quiet beat of pure wonder. The most beautiful image in the book. Fewest words. Still in the adventure world.`, wordTarget: isYoung ? 12 : 15 },
      { spread: 10, beat: 'GIFT',            description: `The world gives ${child.name} something to carry home — a token, a memory, a new understanding. The farewell.`, wordTarget: wt + 2 },
      // SCENE D — HOMECOMING (spreads 11-13, returning home)
      { spread: 11, beat: 'HOMECOMING',      description: `Returning home. Show the journey back. The familiar world looks a little different now.`, wordTarget: wt },
      { spread: 12, beat: 'REFLECTION',      description: `Safe at home, but changed. The adventure lives inside. Echo of the opening. Same home as spread 1.`, wordTarget: wt },
      { spread: 13, beat: 'CLOSING',         description: `The last line. A whisper of the adventure still waiting. Echo the opening image. The most beautiful sentence.`, wordTarget: isYoung ? 12 : 15 },
    ];
  }

  // ── Daily life themes (bedtime, school, friendship, holiday) ──

  _dailyLifeBeats(isYoung, child) {
    const wt = isYoung ? 16 : 28;
    const settingWord = { bedtime: 'evening', school: 'morning', friendship: 'afternoon', holiday: 'day' }[this.themeName] || 'day';
    return [
      // SCENE A — THE FAMILIAR (spreads 1-3, the known routine)
      { spread: 1,  beat: 'SETTING',        description: `The ${settingWord} begins for ${child.name}. A specific, familiar place. Sensory grounding.`, wordTarget: wt },
      { spread: 2,  beat: 'ROUTINE',        description: `A comforting routine unfolds. The rhythm of the ordinary. Concrete details. Same place as spread 1.`, wordTarget: wt + 2 },
      { spread: 3,  beat: 'DISRUPTION',     description: `Something new or unexpected enters the scene. A change in the pattern. Still in the same familiar place.`, wordTarget: wt + 2 },
      // SCENE B — THE NEW THING (spreads 4-7, exploring the disruption)
      { spread: 4,  beat: 'CURIOSITY',      description: `${child.name} responds to the new thing with curiosity. Exploration of the change. The disruption draws them forward.`, wordTarget: wt + 2 },
      { spread: 5,  beat: 'DEEPENING',      description: `The new thing leads somewhere unexpected. Richer than first thought. Same emotional territory as spread 4.`, wordTarget: wt + 2 },
      { spread: 6,  beat: 'EMOTIONAL_CORE', description: `The heart of the story. What this really means to ${child.name}. A feeling, not a lesson. Connected to the disruption.`, wordTarget: wt + 2 },
      { spread: 7,  beat: 'QUIET_MOMENT',   description: `A pause. Fewest words. ${child.name} sits with the feeling. Near wordless.`, wordTarget: isYoung ? 12 : 15 },
      // SCENE C — CONNECTION & RESOLUTION (spreads 8-10, someone joins, understanding arrives)
      { spread: 8,  beat: 'CONNECTION',     description: `Someone else shares the moment. A friend, a parent, a sibling. Togetherness. The feeling is no longer alone.`, wordTarget: wt + 2 },
      { spread: 9,  beat: 'RESOLUTION',     description: `The disruption resolves. Not fixed, but understood. Comfort returns. Same place as the connection.`, wordTarget: wt + 2 },
      { spread: 10, beat: 'RETURN',         description: `Back to the routine, but it feels a little different now. Show the familiar place again.`, wordTarget: wt },
      // SCENE D — SETTLING (spreads 11-13, back to the known world, changed)
      { spread: 11, beat: 'COMFORT',        description: `The safety of the familiar. Physical warmth, soft light, gentle sounds. Same place as the opening.`, wordTarget: wt },
      { spread: 12, beat: 'ECHO',           description: `The refrain lands one final time. Close on an image, not a declaration. Same place.`, wordTarget: wt },
      { spread: 13, beat: 'CLOSING',        description: `The last line. Echo the opening. The world is the same, but ${child.name} is a little more.`, wordTarget: isYoung ? 12 : 15 },
    ];
  }

  // ── Emotional themes (anxiety, anger, fear, grief, loneliness, etc.) ──

  _emotionalBeats(isYoung, child, book) {
    const wt = isYoung ? 16 : 28;
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
      // SCENE A — THE ORDINARY (spreads 1-3, the feeling arrives in a familiar place)
      { spread: 1,  beat: 'NORMAL_DAY',     description: `A regular moment for ${child.name}. Everything seems fine on the surface.${situationNote}`, wordTarget: wt },
      { spread: 2,  beat: 'FEELING_ARRIVES', description: `${feeling} appears. Small at first. A physical sensation, not a label. Same place as spread 1.`, wordTarget: wt + 2 },
      { spread: 3,  beat: 'FEELING_GROWS',   description: `The feeling gets bigger. It shows up in the body, in the world around ${child.name}. Same place, but it looks different now.`, wordTarget: wt + 2 },
      // SCENE B — THE STRUGGLE (spreads 4-7, the feeling takes over)
      { spread: 4,  beat: 'TRIES_TO_COPE',   description: `${child.name} tries to handle it alone. Maybe hides, maybe pushes back. It does not work yet. Connected to the situation.`, wordTarget: wt + 2 },
      { spread: 5,  beat: 'OVERWHELM',       description: `The feeling fills everything. The hardest spread. Honest, not scary. The low point of the story.`, wordTarget: wt },
      { spread: 6,  beat: 'TURNING_POINT',   description: `Someone notices. A gentle adult or friend reaches toward ${child.name}. No lecture, just presence. Same place.`, wordTarget: wt + 2 },
      { spread: 7,  beat: 'NAMING',          description: `The feeling gets a name. Spoken aloud, it shrinks a little. "You feel..." Fewest words.`, wordTarget: isYoung ? 12 : 15 },
      // SCENE C — LEARNING (spreads 8-10, understanding and practice)
      { spread: 8,  beat: 'UNDERSTANDING',   description: `${child.name} learns the feeling is allowed. Everyone has it sometimes. Comfort. Still with the person from spread 6.`, wordTarget: wt + 2 },
      { spread: 9,  beat: 'PRACTICE',        description: `A small tool or action to try when the feeling comes back. Concrete, not abstract. They practice together.`, wordTarget: wt + 2 },
      { spread: 10, beat: 'TRYING_AGAIN',    description: `${child.name} goes back to the thing that was hard. The feeling is still there, but smaller. Connected to spreads 1-3.`, wordTarget: wt + 2 },
      // SCENE D — HOPE (spreads 11-13, resolution and safety)
      { spread: 11, beat: 'SMALL_WIN',       description: `A moment of bravery, or calm, or acceptance. Not perfection, just enough. Back in the familiar place from spread 1.`, wordTarget: wt },
      { spread: 12, beat: 'SAFETY',          description: `The refrain lands one final time. ${child.name} is held, safe, understood. Same place.`, wordTarget: wt },
      { spread: 13, beat: 'CLOSING',         description: `The last line. The feeling may come back, but ${child.name} knows what to do. Hope, not cure. Echo the opening.`, wordTarget: isYoung ? 12 : 15 },
    ];
  }

  // ──────────────────────────────────────────
  // Refrain
  // ──────────────────────────────────────────

  _chooseRefrain(child, parentName, storySeed) {
    // If the brainstormed seed provided a concrete repeated_phrase, prefer it.
    if (storySeed?.repeated_phrase && typeof storySeed.repeated_phrase === 'string') {
      const phrase = storySeed.repeated_phrase.trim();
      if (phrase && phrase.length < 60) {
        return {
          parentWord: parentName || null,
          suggestions: [phrase],
          fromSeed: true,
        };
      }
    }

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

NARRATIVE STRUCTURE (CRITICAL):
- The beats are organized into 4 SCENES. Keep this structure intact.
- Consecutive beats within a scene MUST share the same location or emotional space. Do NOT jump between unrelated places.
- A 3-year-old listener must be able to follow every transition between beats.

RULES:
- Keep every beat's purpose and SCENE grouping intact
- Replace generic placeholders with specific anecdotes from the child's real life
- Use concrete nouns and actions, never abstract claims
- The anecdotes should feel natural in the story, not forced in
- When enriching, keep beats within the same scene connected to each other`;

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

    if (this.category !== 'parent') {
      sections.push(`\n## ILLUSTRATION CONSTRAINT — NO FAMILY MEMBERS IN IMAGES (CRITICAL)\n`);
      sections.push(`We only have the CHILD's photo. Family members (parents, grandparents, siblings, aunts, uncles) must NEVER appear as visible characters in the story.`);
      sections.push(`- The story text must NOT describe a family member as physically present in a scene. Do NOT write lines like "Grandpa stood there" or "Mom waved hello" — these cause the illustrator to draw them, and without a reference photo they look different on every page.`);
      sections.push(`- Instead, show family presence through TRACES and EFFECTS: a packed lunch from Grandpa, a note in Mom's handwriting, a jacket that smells like Dad, a garden that Grandma planted.`);
      sections.push(`- The child is the ONLY human character visible in every spread. Animals, fantasy creatures, and environmental characters (fairies, talking animals, shopkeepers) are fine.`);
      sections.push(`- "Book from: ${book.bookFrom || 'family'}" tells you who ordered the book — honor their relationship through the story's emotional core, NOT by drawing them into scenes.`);
    }

    if (book.title && !isPlaceholderTitle(book.title)) {
      const titleKeywords = this._extractTitleKeywords(book.title, child.name);
      sections.push(`\n## BOOK TITLE — TITLE COHERENCE IS MANDATORY\n`);
      sections.push(`The approved cover title is: "${book.title}"`);
      sections.push(`The title's core concept MUST be concretely present in AT LEAST three spreads:`);
      sections.push(`- Spread 1 or 2 (the HOOK): introduce the title's subject or setting so a reader opening the book immediately sees why it's called "${book.title}".`);
      sections.push(`- Around spread 7 (the climax/peak): the title's concept pays off — this is the moment the cover is promising.`);
      sections.push(`- Spread 12 or 13 (the ending): echo the title one last time so the closing image clearly belongs under "${book.title}".`);
      if (titleKeywords.length > 0) {
        sections.push(`Keywords from the title that must appear (or be clearly represented) somewhere in the text: ${titleKeywords.map(k => `"${k}"`).join(', ')}.`);
      }
      sections.push('Do NOT write a generic theme story that happens to sit under this cover. The story must feel commissioned FOR this title.');
    }

    if (plan.plotSynopsis) {
      sections.push(`\n## PLOT CONCEPT\n`);
      sections.push(plan.plotSynopsis);
      sections.push('\nFollow this specific story arc. The beat structure below gives you the scene-by-scene breakdown — lean into THIS plot, not a generic version of the theme.');
    }

    // ── Mandatory personalization checklist ──
    // Enumerate every non-empty personalization field and require each to appear concretely.
    const personalizationItems = this._buildPersonalizationChecklist(child, book, plan);
    if (personalizationItems.length > 0) {
      sections.push(`\n## MANDATORY PERSONALIZATION CHECKLIST\n`);
      sections.push(`The following real details were provided by the parent. EACH item must appear concretely in AT LEAST ONE spread — as a named object, action, place, food, or person. Do NOT generalize them away. Do NOT list them all in one spread. Spread them across the 13 beats so the book feels personally woven for this child:`);
      personalizationItems.forEach(item => sections.push(`- ${item}`));
      sections.push(`After writing, silently verify: every checklist item above is concretely present somewhere in the final story text. If any item is missing, rewrite the affected spread to include it naturally.`);
    }

    sections.push(`\n## STORY PLAN\n`);
    sections.push(`Theme: ${this.themeName.replace(/_/g, ' ')}`);
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

    // Find the climax/quiet beat
    const climaxBeat = plan.beats.find(b =>
      b.beat === 'CLIMAX' || b.beat === 'WISH_MOMENT' || b.beat === 'WONDER' ||
      b.beat === 'QUIET_MOMENT' || b.beat === 'NAMING'
    );

    sections.push(`\n## NARRATIVE COHERENCE (READ THIS FIRST)\n`);
    sections.push(`- The beats are organized into 4 SCENES. Beats within a scene share the same location or emotional space.`);
    sections.push(`- Within each scene, the characters stay in the SAME PLACE. Do NOT jump to a new location within a scene.`);
    sections.push(`- Scene transitions must be clear — the reader must always know WHERE the characters are and WHY they moved.`);
    sections.push(`- Do NOT write a slideshow of unrelated activities. Each spread flows from the one before it.`);
    sections.push(`- CLARITY: Every image and metaphor must be literal enough for a 3-year-old to picture. If you mix imagination and reality, signal the shift clearly.`);

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
    if (this.themeName !== 'bedtime') {
      sections.push(`- NO BEDTIME ENDING: Unless the theme is bedtime, the story must NOT end with the child falling asleep, going to bed, tucking in, closing eyes to sleep, dreaming, or any nighttime/goodnight imagery. End with warmth, togetherness, and energy — in DAYLIGHT or at least awake.`);
    }
    sections.push(`- Format each spread as: ---SPREAD N--- followed by the text`);

    return sections.join('\n');
  }

  // ──────────────────────────────────────────
  // Anecdote formatting
  // ──────────────────────────────────────────

  /**
   * Extract meaningful nouns/keywords from the title (excluding the child's name
   * and common filler words) so we can enforce title coherence in prose + checks.
   */
  _extractTitleKeywords(title, childName) {
    if (!title) return [];
    const stop = new Set([
      'the', 'a', 'an', 'and', 'of', 'in', 'on', 'to', 'for', 'with', 'at',
      'is', 'it', 'its', 'his', 'her', 'their', 'my', 'our', 'your',
      's', 'i', 'me', 'we', 'they', 'he', 'she',
      'story', 'book', 'tale', 'adventures', 'adventure',
    ]);
    const nameLower = (childName || '').toLowerCase();
    const tokens = title
      .toLowerCase()
      .replace(/[^a-z0-9'\- ]/g, ' ')
      .split(/\s+/)
      .map(t => t.replace(/^'+|'+$/g, '').replace(/'s$/, ''))
      .filter(Boolean);
    const out = [];
    for (const tok of tokens) {
      if (tok.length < 3) continue;
      if (stop.has(tok)) continue;
      if (nameLower && tok === nameLower) continue;
      if (!out.includes(tok)) out.push(tok);
    }
    return out.slice(0, 6);
  }

  /**
   * Build a flat list of specific personalization items that MUST appear in the story.
   * Pulls from anecdotes (all non-empty fields), interests, and the seed's favorite_object.
   */
  _buildPersonalizationChecklist(child, book, plan) {
    const items = [];
    const a = child.anecdotes || {};
    if (a.favorite_activities) items.push(`Favorite activities: ${a.favorite_activities}`);
    if (a.funny_thing) items.push(`A funny thing they do: ${a.funny_thing}`);
    if (a.meaningful_moment) items.push(`Meaningful moment: ${a.meaningful_moment}`);
    if (a.moms_favorite_moment) items.push(`Mom's favorite moment: ${a.moms_favorite_moment}`);
    if (a.favorite_food) items.push(`Favorite food: ${a.favorite_food}`);
    if (a.favorite_cake_flavor) items.push(`Favorite cake flavor: ${a.favorite_cake_flavor}`);
    if (a.favorite_toys) items.push(`Favorite toys: ${a.favorite_toys}`);
    if (a.other_detail) items.push(`Other detail: ${a.other_detail}`);
    if (a.anything_else) items.push(`Additional detail: ${a.anything_else}`);
    if (Array.isArray(child.interests) && child.interests.length) {
      items.push(`Interests to weave in: ${child.interests.join(', ')}`);
    }
    const seed = plan?.storySeed || this._storySeed;
    if (seed?.favorite_object && typeof seed.favorite_object === 'string' && seed.favorite_object.trim()) {
      items.push(`Story object/companion: ${seed.favorite_object}`);
    }
    if (seed?.setting && typeof seed.setting === 'string' && seed.setting.trim()) {
      items.push(`World/setting: ${seed.setting}`);
    }
    if (book.customDetails && typeof book.customDetails === 'string' && book.customDetails.trim()) {
      items.push(`Parent-written custom details (every specific noun/person/place here must land somewhere concrete): ${book.customDetails.trim()}`);
    }
    return items;
  }

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
