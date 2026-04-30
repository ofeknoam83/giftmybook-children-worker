/**
 * GenericThemeWriter — single Writer V2 implementation for all themes.
 *
 * Theme-aware behavior via category:
 * - Parent themes (mothers_day, fathers_day): parent-child bond arc
 * - Celebration themes (birthday, birthday_magic): party/wish arc
 * - Adventure themes (adventure, fantasy, space, underwater, nature): exploration arc
 * - Daily life themes (bedtime, school, friendship, holiday): everyday arc
 * - Emotional themes (anxiety, anger, fear, grief, loneliness, new_beginnings,
 *   self_worth, family_change): feelings arc with coping/hope resolution
 */

const { BaseThemeWriter, stripOutfitLockFromRaw } = require('./base');
const { buildSystemPrompt } = require('../prompts/system');
const { checkAndFixPronouns } = require('../quality/pronoun');
const { sanitizeNonLatinChars } = require('../quality/sanitize');
const { isPlaceholderTitle } = require('./plots');
const { buildFavoriteObjectLock } = require('./anecdotes');
const { getParentRefrainSuggestions } = require('./parentRefrainSuggestions');
const { buildParentBeatEnrichmentSystem } = require('./parentPlanEnrichment');

/**
 * @param {{ parseSpreads: (raw: string) => Array<{ spread: number, text: string, scene: string }> }} writer
 * @param {string} rawText
 */
function parseWriterOutput(writer, rawText) {
  const { text, outfitLock } = stripOutfitLockFromRaw(rawText);
  return { spreads: writer.parseSpreads(text), outfitLock };
}

// ── Theme category membership ──

const PARENT_THEMES = ['mothers_day', 'fathers_day'];
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

    this._selectedPlot = null;
    this._manifest = null;
    this._storySeed = opts.storySeed || null;

    const seed = opts.storySeed || null;
    const rawSeedBeats = Array.isArray(seed?.beats) ? seed.beats : null;
    let beats;
    let usedStorySeedBeats = false;

    if (rawSeedBeats && rawSeedBeats.length >= 10) {
      beats = this._normalizeUpstreamSeedBeats(rawSeedBeats, ageTier, child);
      usedStorySeedBeats = true;
      console.log(`[writerV2] plan: using upstream storySeed.beats`, { theme: this.themeName, count: beats.length });
    } else {
      console.log(`[writerV2] plan: _generateCreativeBeats`, { theme: this.themeName });
      beats = await this._generateCreativeBeats(child, book, {
        storySeed: seed,
        parentName,
        ageTier,
      });
    }

    const refrain = this._chooseRefrain(child, parentName, seed);

    let enrichedBeats = beats;
    if (
      child.anecdotes &&
      Object.keys(child.anecdotes).length > 0 &&
      !usedStorySeedBeats
    ) {
      try {
        enrichedBeats = await this._enrichPlanWithLLM(beats, child, book, parentName, ageTier);
      } catch (err) {
        console.warn(`[writerV2] Plan enrichment failed, using unenriched beats: ${err.message}`);
      }
    }

    const plot = this._selectedPlot;

    // Location palette: always attempted, even on the template path. Every
    // spread will get a .location and .visual_anchors that the writer must
    // honor in its SCENE block, and that the illustrator reuses for
    // cross-spread continuity.
    let palette = null;
    try {
      palette = await this.buildLocationPalette({
        child,
        book,
        beats: enrichedBeats,
        storySeed: seed,
      });
    } catch (err) {
      console.warn(`[writerV2] buildLocationPalette failed for ${this.themeName}: ${err.message}`);
    }
    const beatsWithLocations = palette
      ? this.applyPaletteToBeats(enrichedBeats, palette)
      : enrichedBeats;
    if (palette) {
      const names = palette.palette.map(p => p.name);
      console.log(`[writerV2] Location palette for ${this.themeName} (${names.length}): ${names.join(' | ')}`);
    }

    return {
      beats: beatsWithLocations,
      refrain,
      ageTier,
      spreadCount: { min: spreadCount.min, max: spreadCount.max, target: Math.min(spreadCount.max, beatsWithLocations.length) },
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
      usedSeed: false,
      usedStorySeedBeats,
      manifest: null,
      locationPalette: palette,
    };
  }

  /**
   * Normalize upstream brainstorm beats into the Writer V2 beat shape (13 spreads).
   * @param {Array<string|object>} raw
   * @param {string} ageTier
   * @param {{ name?: string }} child
   * @returns {Array<{ spread: number, beat: string, description: string, wordTarget: number }>}
   */
  _normalizeUpstreamSeedBeats(raw, ageTier, child) {
    const isYoung = ageTier === 'young-picture';
    const wt = isYoung ? 16 : 28;
    const name = (child && child.name) ? String(child.name) : 'the hero';
    const slice = raw.slice(0, 13);
    const out = [];
    for (let i = 0; i < slice.length; i++) {
      const spread = i + 1;
      const b = slice[i];
      let beat = `SPREAD_${spread}`;
      let desc = '';
      let wordTarget = spread >= 12 ? (isYoung ? 12 : 15) : wt;
      if (typeof b === 'string') {
        desc = b.trim();
        beat = 'BEAT';
      } else if (b && typeof b === 'object') {
        beat = (b.beat || b.label || beat).toString().trim().replace(/\s+/g, '_').toUpperCase() || 'BEAT';
        desc = (b.description || b.text || '').toString().trim();
        const w = Number(b.wordTarget);
        if (Number.isFinite(w) && w > 0) wordTarget = Math.round(w);
      }
      if (!desc) continue;
      out.push({
        spread,
        beat,
        description: this._sanitizeBeatDescription(desc),
        wordTarget,
      });
    }
    while (out.length < 13) {
      const n = out.length + 1;
      out.push({
        spread: n,
        beat: `LATE_${n}`,
        description: this._sanitizeBeatDescription(
          `A concrete beat that pays off the story — invent a specific action and place for ${name}.`,
        ),
        wordTarget: n >= 12 ? (isYoung ? 12 : 15) : wt,
      });
    }
    return out.slice(0, 13);
  }

  /**
   * Invent a full 13-spread beat list with one LLM call — no canned plot templates.
   *
   * @param {object} child
   * @param {object} book
   * @param {{ storySeed?: object, parentName?: string, ageTier: string }} params
   * @returns {Promise<Array<{ spread: number, beat: string, description: string, wordTarget: number }>>}
   */
  async _generateCreativeBeats(child, book, params) {
    const { storySeed, parentName, ageTier } = params;
    const isYoung = ageTier === 'young-picture';
    const wt = isYoung ? 16 : 28;
    const themeLabel = this.themeName.replace(/_/g, ' ');
    const seed = storySeed || {};
    const seedBlock = [
      `favorite_object (concrete prop): ${(seed.favorite_object || '').toString().trim() || '(invent one that fits age and theme)'}`,
      `emotional friction / fear: ${(seed.fear || '').toString().trim() || '(invent, age-safe, theme-true)'}`,
      `world / setting: ${(seed.setting || '').toString().trim() || '(one vivid sentence — specific, photogenic)'}`,
      `inner journey (one line): ${(seed.storySeed || '').toString().trim() || '(optional)'}`,
      `plot spine (what happens): ${(seed.narrative_spine || '').toString().trim() || '(optional)'}`,
    ].join('\n');

    const systemPrompt = [
      `You are a senior children's picture-book story architect for a ${themeLabel} book (category: ${this.category}).`,
      'Invent ONE original through-line — not a fill-in-the-blank template.',
      'Each beat is a single vivid line: concrete WHERE + concrete ACTION that causes the next beat.',
      'Prioritize **breathtaking, paintable** moments: light, material, scale, weather, a clear focal action.',
      '**Locations — avoid the boring default spine:** do NOT build the book around a generic neighborhood park, a plain backyard, a private garden, a chain of "rooms at home" (kitchen, living room, bedroom on repeat), or a tame "playground" unless the parent questionnaire explicitly demands that shape.',
      '**Instead:** use at least **five** distinct, memorable, visually rich places. Invent a place or use specific epic or quirky venues (e.g. lighthouse causeway, indoor market atrium, treetop walk, science museum after dark, zipline platform, cavern mouth, train station mezzanine, river ferry, community parade route). Vary the world so each spread is a new *canvas*, not a sofa loop.',
      '**Spread 1** must start somewhere **striking and specific** — not "at home in the garden" or "at the park" as the go-to open unless the brief requires it.',
      'Return JSON only: { "beats": [ { "spread":1, "beat":"HOOK", "description":"one line", "wordTarget":16 }, ... ] } with exactly 13 items, spreads 1..13.',
      `wordTarget: use ${wt} for most spreads; use ${isYoung ? 12 : 15} for the quietest emotional beat and the last spread if appropriate.`,
    ].join('\n');

    const refBeats = this._formatBrainstormBeatsForCreativePlan(seed);
    const userPrompt = [
      `Child: ${child.name}, age ${child.age ?? 5}, gender: ${child.gender || 'unspecified'}.`,
      book.title ? `Working title: ${book.title}` : null,
      (this.category === 'parent' || this.category === 'celebration') && parentName
        ? `Parent figure (relationship language): ${parentName}`
        : null,
      '--- Seed / brief ---',
      seedBlock,
      refBeats,
      '---',
      'Questionnaire and custom details (weave in where specific; if a named real place is boring, reframe the beat in a more vivid invented or public venue while keeping the emotional beat):',
      this._formatAnecdotesForCreativePlan(child, book),
      'Emit the JSON "beats" array now.',
    ].filter(Boolean).join('\n\n');

    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await this.callLLM('planner', systemPrompt, userPrompt, {
          jsonMode: true,
          maxTokens: 4500,
          temperature: 0.95,
        });
        const raw = String(result.text || '').trim();
        const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim());
        const arr = Array.isArray(parsed?.beats) ? parsed.beats : (Array.isArray(parsed) ? parsed : null);
        if (!arr || arr.length < 10) throw new Error('missing beats array');
        const out = arr.slice(0, 13).map((b, i) => {
          const spread = i + 1;
          const beat = (b && (b.beat || b.label) || `SPREAD_${spread}`).toString().trim().replace(/\s+/g, '_').toUpperCase() || 'BEAT';
          const desc = (b && (b.description || b.text) || '').toString().trim();
          const w = Number(b && b.wordTarget);
          const wordTarget = Number.isFinite(w) && w > 0 ? Math.round(w) : (spread >= 12 ? (isYoung ? 12 : 15) : wt);
          if (!desc) return null;
          return { spread, beat, description: this._sanitizeBeatDescription(desc), wordTarget };
        }).filter(Boolean);
        if (out.length >= 10) {
          while (out.length < 13) {
            const n = out.length + 1;
            out.push({
              spread: n,
              beat: `LATE_${n}`,
              description: this._sanitizeBeatDescription(`A concrete beat that pays off the story — invent a specific action and place for ${child.name}.`),
              wordTarget: n >= 12 ? (isYoung ? 12 : 15) : wt,
            });
          }
          return out;
        }
      } catch (err) {
        lastErr = err;
        console.warn(`[writerV2] _generateCreativeBeats attempt ${attempt} failed: ${err.message}`);
      }
    }
    throw new Error(`Writer V2: could not generate creative beats from LLM${lastErr ? ` (${lastErr.message})` : ''}`);
  }

  /**
   * One line per spread from brainstormer — the creative LLM may rewrite; output JSON is canonical.
   * @param {object} storySeed
   * @returns {string}
   */
  _formatBrainstormBeatsForCreativePlan(storySeed) {
    const raw = storySeed?.beats;
    if (!Array.isArray(raw) || raw.length === 0) return '';
    const lines = raw.slice(0, 13).map((b, i) => {
      const t = typeof b === 'string' ? b : (b && (b.description || b.text || b.beat)) || '';
      const s = String(t).trim();
      if (!s) return null;
      return `  ${i + 1}. ${s}`;
    }).filter(Boolean);
    if (lines.length === 0) return '';
    return [
      'Brainstormed arc (optional reference — improve or replace freely; your JSON output is the book plan):',
      ...lines,
    ].join('\n');
  }

  /**
   * @param {object} child
   * @param {object} book
   * @returns {string}
   */
  _formatAnecdotesForCreativePlan(child, book) {
    const fromAn = child.anecdotes && typeof child.anecdotes === 'object' ? child.anecdotes : {};
    const lines = Object.entries(fromAn)
      .filter(([, v]) => typeof v === 'string' && v.trim())
      .map(([k, v]) => `- ${k}: ${v.trim()}`);
    if (book.customDetails && String(book.customDetails).trim()) {
      lines.push(`- customDetails: ${String(book.customDetails).trim()}`);
    }
    if (book.emotionalSituation && String(book.emotionalSituation).trim()) {
      lines.push(`- emotionalSituation: ${String(book.emotionalSituation).trim()}`);
    }
    return lines.length ? lines.join('\n') : '(none provided)';
  }

  // ──────────────────────────────────────────
  // write()
  // ──────────────────────────────────────────

  async write(plan, child, book) {
    const systemPrompt = buildSystemPrompt(this.themeName, plan.ageTier, child, book, { role: 'writer' });
    const userPrompt = this._buildWritePrompt(plan, child, book);

    const result = await this.callLLM('writer', systemPrompt, userPrompt, { maxTokens: 4000 });

    let { spreads, outfitLock } = parseWriterOutput(this, result.text);

    const validation = this.validateStructure(spreads, child.age);
    if (!validation.valid && spreads.length < plan.spreadCount.min) {
      console.warn(`[writerV2] write: structure validation failed, retrying full write`, { theme: this.themeName, issues: validation.issues, spreadCount: spreads.length, min: plan.spreadCount.min });
      const retryResult = await this.callLLM('writer', systemPrompt,
        userPrompt + '\n\nIMPORTANT: You MUST write exactly ' + plan.spreadCount.target + ' spreads.',
        { maxTokens: 4000, temperature: 0.9 });
      const ret = parseWriterOutput(this, retryResult.text);
      if (ret.spreads.length >= plan.spreadCount.min) {
        spreads = ret.spreads;
        if (ret.outfitLock) outfitLock = ret.outfitLock;
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
          console.warn(`[writerV2] titleCoherence: FAILED — no title keywords in text; retrying`, { title: book.title, keywords: titleKeywords });
          const anchorAddendum = `\n\nCRITICAL TITLE ANCHOR — READ BEFORE REWRITING:\nThe book's cover title is "${book.title}". The previous draft did NOT include the title's core concept. In this rewrite, at least TWO of these title keywords MUST appear literally in the story text: ${titleKeywords.map(k => `"${k}"`).join(', ')}. The title's subject MUST be concretely present in spread 1 or 2, at the climax around spread 7, and in the final spread. Do NOT write a generic theme story — the text must clearly belong under this cover.`;
          try {
            const retryResult = await this.callLLM('writer', systemPrompt, userPrompt + anchorAddendum, { maxTokens: 4000, temperature: 0.85 });
            const ret = parseWriterOutput(this, retryResult.text);
            if (ret.spreads.length >= plan.spreadCount.min) {
              const retryCombined = ret.spreads.map(s => (s.text || '')).join(' ').toLowerCase();
              const retryMatches = titleKeywords.filter(k => retryCombined.includes(k));
              // Prefer the retry if it improves keyword coverage OR ties; otherwise keep original.
              if (retryMatches.length >= matches.length) {
                spreads = ret.spreads;
                if (ret.outfitLock) outfitLock = ret.outfitLock;
                console.log(`[writerV2] titleCoherence: retry succeeded`, { matched: retryMatches.length, of: titleKeywords.length });
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
        console.warn(`[writerV2] cakeCoherence: FAILED — spreads 12–13 missing cake/candles/wish/bite; retrying`, { has12, has13, theme: this.themeName });
        const cakeAddendum = `\n\nCRITICAL CAKE CLIMAX — READ BEFORE REWRITING:\nThis is a BIRTHDAY book for ${child.name}. The previous draft did NOT land the cake climax.\n- Spread 12 MUST be the wish-and-blow moment: the cake${flavor} with lit candles in front of ${child.name}, eyes closing for a wish, candles blown out. Name the cake and the candles in the text.\n- Spread 13 MUST be the first-bite joy: ${child.name} taking the first bite of cake${flavor}, pure happiness on their face. Name the cake in the text.\n- The ending must be JOYFUL and in DAYLIGHT — never a bedtime / sleep / goodnight ending.\nKeep spreads 1-11 substantially the same. Only rewrite the final two spreads to deliver the cake climax.`;
        try {
          const retryResult = await this.callLLM('writer', systemPrompt, userPrompt + cakeAddendum, { maxTokens: 4000, temperature: 0.85 });
          const ret = parseWriterOutput(this, retryResult.text);
          if (ret.spreads.length >= plan.spreadCount.min) {
            const retry12 = ret.spreads.find(s => s.spread === 12) || ret.spreads[11];
            const retry13 = ret.spreads.find(s => s.spread === 13) || ret.spreads[12];
            const retryHas12 = cakeTerms.test(retry12?.text || '');
            const retryHas13 = cakeTerms.test(retry13?.text || '');
            if ((retryHas12 ? 1 : 0) + (retryHas13 ? 1 : 0) > (has12 ? 1 : 0) + (has13 ? 1 : 0)) {
              spreads = ret.spreads;
              if (ret.outfitLock) outfitLock = ret.outfitLock;
              console.log(`[writerV2] cakeCoherence: retry succeeded`, { spread12: retryHas12, spread13: retryHas13 });
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

    return { spreads, _model: result.model, _ageTier: plan.ageTier, _outfitLock: outfitLock || null };
  }

  // ──────────────────────────────────────────
  // revise()
  // ──────────────────────────────────────────

  async revise(story, feedback, child, book) {
    const ageTier = story._ageTier || this.getAgeTier(child.age);
    const systemPrompt = buildSystemPrompt(this.themeName, ageTier, child, book, { role: 'reviser' });

    const currentText = story.spreads.map(s => {
      const lines = [`---SPREAD ${s.spread}---`, 'TEXT:', s.text || ''];
      if (s.scene) lines.push('SCENE:', s.scene);
      return lines.join('\n');
    }).join('\n\n');

    const userPrompt = `Here is the current story with its scene descriptions:\n\n${currentText}\n\n## REVISION FEEDBACK\n\n${feedback}\n\nRevise the story to address ALL of the issues above. Keep the same number of spreads (${story.spreads.length}). Preserve the emotional arc and refrain. Fix the specific issues identified.\n\nOUTPUT FORMAT — EVERY spread MUST still include BOTH a TEXT: block and a SCENE: block:\n\n---SPREAD 1---\nTEXT:\n<story lines>\nSCENE:\n<single-paragraph scene description — ~40-70 words — that matches the TEXT you just revised and locks the assigned palette location>\n\nRewrite the SCENE when you change the TEXT so the two stay aligned. Never omit either block.`;

    const result = await this.callLLM('reviser', systemPrompt, userPrompt, { maxTokens: 4000 });

    const parsed = parseWriterOutput(this, result.text);
    let spreads = parsed.spreads;
    const newOutfit = parsed.outfitLock || story._outfitLock || null;

    if (spreads.length < story.spreads.length * 0.7) {
      console.warn(`[writerV2] Revision produced only ${spreads.length} spreads (expected ~${story.spreads.length}), keeping original`);
      return story;
    }

    // If the reviser dropped the SCENE block on some spreads, inherit the
    // pre-revision scene for those spreads rather than leaving them blank —
    // it still reflects a scene that matched an earlier version of the text
    // and is strictly better than nothing for the illustrator.
    const priorBySpread = new Map();
    for (const s of story.spreads) priorBySpread.set(s.spread, s.scene || '');
    for (const s of spreads) {
      if (!s.scene) s.scene = priorBySpread.get(s.spread) || '';
    }

    checkAndFixPronouns(spreads, child.gender);

    // Strip dashes from story text ONLY — do NOT touch the SCENE field;
    // scenes are free-form art direction, not read-aloud copy.
    for (const s of spreads) {
      if (s.text) {
        s.text = s.text
          .replace(/\s*[\u2014\u2013]\s*/g, ', ')
          .replace(/(?<=[a-zA-Z])\s*-\s*(?=[a-zA-Z])/g, ', ');
      }
    }

    sanitizeNonLatinChars(spreads);

    return { spreads, _model: result.model, _ageTier: ageTier, _outfitLock: newOutfit };
  }

  // ──────────────────────────────────────────
  // Refrain
  // ──────────────────────────────────────────

  _chooseRefrain(child, parentName, storySeed) {
    // If the brainstormed seed provided a concrete repeated_phrase, prefer it.
    if (storySeed?.repeated_phrase && typeof storySeed.repeated_phrase === 'string') {
      const phrase = storySeed.repeated_phrase.trim();
      if (phrase && phrase.length < 60) {
        const pw = this.category === 'parent'
          ? (this.themeName === 'fathers_day'
            ? (child.anecdotes?.calls_dad || parentName || 'Daddy')
            : (child.anecdotes?.calls_mom || parentName || 'Mama'))
          : parentName || null;
        return {
          parentWord: pw,
          suggestions: [phrase],
          fromSeed: true,
        };
      }
    }

    if (this.category === 'parent') {
      const word = this.themeName === 'fathers_day'
        ? (child.anecdotes?.calls_dad || parentName || 'Daddy')
        : (child.anecdotes?.calls_mom || parentName || 'Mama');
      return {
        parentWord: word,
        suggestions: getParentRefrainSuggestions(this.themeName, null, word),
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

    if (this.category === 'parent') {
      const recipient = this.themeName === 'fathers_day' ? 'dad' : 'mom';
      const systemPrompt = buildParentBeatEnrichmentSystem(recipient);
      const occasion = this.themeName === 'fathers_day' ? "Father's Day" : 'Love to mom';
      const parentKin = this.themeName === 'fathers_day' ? 'dad' : 'mom';
      const userPrompt = `Here are the story beats for a ${ageTier} ${occasion} book about ${child.name} (age ${child.age}) and ${parentName}:

${beats.map(b => `Spread ${b.spread} (${b.beat}): ${b.description}`).join('\n')}

Here are real details about this child and their ${parentKin}:
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

    const themeLabel = this.themeName.replace(/_/g, ' ');
    const parentNote = parentName ? ` about ${child.name} and ${parentName}` : ` about ${child.name}`;

    const systemPrompt = `You are a children's book story planner specializing in ${themeLabel} picture books. Your job is to weave specific, real details about this child into the story beats.

NARRATIVE SHAPE:
- The beats below are SOFT INSPIRATION, not a rigid scene template. The writer will be told to invent the arc.
- There is NO prescribed Scene A / Scene B / Scene C / Scene D. Do NOT add scene labels or force a "home → journey → peak → heading home" shape.
- The story must NOT open at home. The closing must NOT default to a "walking home" / "heading home" / "back at home" formula — strip those phrases if you see them in the incoming beats.
- A 3-year-old listener must still be able to follow every transition between beats.

RULES:
- Keep the overall beat count. You may adjust any beat's description freely.
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

  /**
   * Write prompt for mothers_day / fathers_day — parent on cover rules, celebration tone,
   * bond through-line (no motif-guardrail blocks).
   *
   * @param {object} plan
   * @param {object} child
   * @param {object} book
   * @returns {string}
   */
  _buildParentGiftWritePrompt(plan, child, book) {
    const pronouns = plan.pronouns;
    const parentName = plan.parentName;
    const anecdoteText = this._formatAnecdotes(child.anecdotes);
    const isFather = this.themeName === 'fathers_day';
    const parentHeading = isFather ? 'THE FATHER' : 'THE MOTHER';
    const themedWord = isFather ? 'father' : 'mother';
    const parentRefPhrase = isFather ? 'THIS father' : 'THIS mother';
    const coverParentPresent = book.coverParentPresent === true || book.cover_parent_present === true;
    const parentCoverSnippet = (
      book.additionalCoverCharacters ||
      book.additional_cover_characters ||
      ''
    ).toString().trim();

    const sections = [];

    sections.push(`## THE CHILD\n`);
    sections.push(`Name: ${child.name}`);
    sections.push(`Age: ${child.age}`);
    sections.push(`Gender: ${child.gender || 'not specified'} (pronouns: ${pronouns.pair})`);
    if (child.appearance) sections.push(`Appearance: ${child.appearance}`);
    if (child.interests?.length) sections.push(`Interests: ${child.interests.join(', ')}`);

    sections.push(`\n## ${parentHeading}\n`);
    sections.push(isFather ? `The child calls him: ${parentName}` : `The child calls her: ${parentName}`);

    if (coverParentPresent) {
      if (isFather) {
        sections.push(`\n## DAD ON APPROVED COVER (VISUAL LOCK FOR TEXT + SCENE)\n`);
        sections.push(
          'The father appears on the **printed book cover** reference. Interior illustrations will match him to that cover. Your SCENE blocks must describe him with **the same recognizable look** every time he appears (hair, skin tone, face when visible, build, age range) — never a different man or a generic stock-Dad reinterpretation.',
        );
      } else {
        sections.push(`\n## MOM ON APPROVED COVER (VISUAL LOCK FOR TEXT + SCENE)\n`);
        sections.push(
          'The mother appears on the **printed book cover** reference. Interior illustrations will match her to that cover. Your SCENE blocks must describe her with **the same recognizable look** every time she appears (hair, skin tone, face when visible, build, age range) — never a different woman or a generic "movie mom" reinterpretation.',
        );
      }
      if (parentCoverSnippet) {
        sections.push(
          isFather
            ? `Cover character notes (echo these concrete cues in SCENE when Dad is visible — do not contradict): ${parentCoverSnippet}`
            : `Cover character notes (echo these concrete cues in SCENE when Mom is visible — do not contradict): ${parentCoverSnippet}`,
        );
      } else {
        sections.push(
          isFather
            ? 'No separate cover description string was provided — still **keep Dad visually consistent** spread to spread; echo any hair/outfit/skin cues you establish on first full appearance.'
            : 'No separate cover description string was provided — still **keep Mom visually consistent** spread to spread; echo any hair/outfit/skin cues you establish on first full appearance.',
        );
      }
    }

    const dadRealName = (book.dad_name || child.anecdotes?.dad_name || '').toString().trim();
    const momRealName = (book.mom_name || child.anecdotes?.mom_name || '').toString().trim();
    const realName = isFather ? dadRealName : momRealName;
    const legalLabel = isFather ? 'father' : 'mother';
    if (realName && realName.toLowerCase() !== parentName.toLowerCase()) {
      sections.push(`\n## PARENT NAME RULE — SHIP-BLOCKER\n`);
      sections.push(`The ${legalLabel}'s real first name is "${realName}" but the child calls ${isFather ? 'him' : 'her'} "${parentName}".`);
      if (isFather) {
        sections.push(`In this book he is "${parentName}" EVERYWHERE. You MAY use "${realName}" exactly ONCE — and only if it lands naturally in a single dedication-style beat (e.g. "When grown-ups call him ${realName}, to you he's just ${parentName}."). If you can't fit it gracefully, omit it entirely.`);
      } else {
        sections.push(`In this book she is "${parentName}" EVERYWHERE. You MAY use "${realName}" exactly ONCE — and only if it lands naturally in a single dedication-style beat (e.g. "When grown-ups call her ${realName}, to you she's just ${parentName}."). If you can't fit it gracefully, omit it entirely.`);
      }
      sections.push(`Hard rule: "${realName}" appears at most ONE TIME across all 13 spreads and the dedication combined. Using it more than once — even twice — is a ship-blocker; the book will fail QA and be rewritten. Do NOT rhyme on "${realName}". Do NOT let "${realName}" replace "${parentName}" in any refrain. Do NOT alternate between the two names.`);
    } else if (isFather && dadRealName) {
      sections.push(`Dad's name: ${dadRealName}`);
    } else if (!isFather && momRealName) {
      sections.push(`Mom's name: ${momRealName}`);
    }

    if (anecdoteText) {
      sections.push(
        isFather
          ? `\n## REAL DETAILS ABOUT THIS CHILD AND THEIR DAD\n`
          : `\n## REAL DETAILS ABOUT THIS CHILD AND THEIR MOM\n`,
      );
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

    if (book.title && !isPlaceholderTitle(book.title)) {
      const titleKeywords = this._extractTitleKeywords(book.title, child.name);
      sections.push(`\n## BOOK TITLE — TITLE COHERENCE IS MANDATORY\n`);
      sections.push(`The approved cover title is: "${book.title}"`);
      sections.push(`The title's core concept MUST be concretely present in AT LEAST three spreads across the book:`);
      sections.push(`- Introduced early (one of the first few spreads) so a reader opening the book immediately sees why it's called "${book.title}".`);
      sections.push(`- Paid off at whatever spread you make the climax/peak — the title's concept is the promise the cover makes.`);
      sections.push(`- Echoed in the closing so the final image clearly belongs under "${book.title}".`);
      if (titleKeywords.length > 0) {
        sections.push(`Keywords from the title that must appear (or be clearly represented) somewhere in the text: ${titleKeywords.map(k => `"${k}"`).join(', ')}.`);
      }
      sections.push('Do NOT write a generic theme story that happens to sit under this cover. The story must feel commissioned FOR this title.');
    }

    if (plan.plotSynopsis) {
      sections.push(`\n## PLOT CONCEPT\n`);
      sections.push(plan.plotSynopsis);
      sections.push('\nUse this as the creative seed of the story — lean into THIS plot. The spread-by-spread shape is yours to invent (see INVENTED ARC below).');
    }

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

    sections.push(`\n## REFRAIN (SHIP-BLOCKER — matches automated QA)\n`);
    sections.push(`Pick ONE refrain wording before you write spread 1 and use the **exact same words** every time it appears (minimum 3 times, not back-to-back spreads).`);
    sections.push(`**Closure rule:** At least one occurrence MUST appear on spread 10, 11, 12, or 13. A refrain that only appears in spreads 1–8 will fail QA.`);
    sections.push(`Space repeats across early, middle, and late — the last repeat should land when the emotional arc resolves.`);
    if (plan.refrain.parentWord) {
      sections.push(`It should use "${plan.refrain.parentWord}" and be under 8 words.`);
    }
    sections.push(`Suggested refrains (you may create your own):`);
    plan.refrain.suggestions.forEach(s => sections.push(`- "${s}"`));

    appendLocationPaletteSection(sections, plan);

    sections.push(`\n## PLOT ↔ ILLUSTRATION (paintable beats)\n`);
    sections.push(`Every spread's TEXT must describe a **concrete story moment** — a specific action, interaction, discovery, or turn that belongs in that spread's assigned palette location.`);
    sections.push(`The emotional arc must **progress** so spreads are not interchangeable stanzas. Each SCENE must differ from the prior spread in action and camera when locations repeat.`);
    sections.push(`The illustrator only has your words: concrete beats produce specific art.`);

    sections.push(`\n## INVENTED ARC (spread-by-spread beat sketches — SOFT HINTS, not a rigid template)\n`);
    sections.push(`Write exactly ${plan.spreadCount.target} spreads. The beat sketches below are STARTING INSPIRATION only — shape the arc for THIS child, ${parentRefPhrase}, THESE anecdotes. The only HARD constraints on shape are:`);
    sections.push(`- Spread 1 must open OUT IN THE WORLD, in a specific non-home setting.`);
    sections.push(`- The final spreads must land a warm, concrete image YOU invent — not a formulaic "walking home", "heading home", or "back at home" shot.`);
    sections.push(`- There is NO prescribed Scene A / B / C / D. Decide where tension builds and how the story resolves.`);
    sections.push(`- Each beat below is LOCKED to the palette location shown next to it.`);
    sections.push(`- Anecdote-assignment rules (if any) below are the only per-spread mandates.\n`);
    sections.push(`Sketches:`);
    plan.beats.forEach(b => {
      const locationTag = b.location ? ` {location: ${b.location}}` : '';
      const desc = this._sanitizeBeatDescription(b.description);
      sections.push(`Spread ${b.spread} (${b.beat})${locationTag}: ${desc} [~${b.wordTarget} words]`);
    });

    appendSceneRulesSection(sections, {
      parentGiftTheme: true,
      parentOnCoverFullFaceAllowed: coverParentPresent,
      themedParentWord: themedWord,
    });

    if (plan.manifest && plan.manifest.length > 0) {
      sections.push(`\n## HARD ANECDOTE ASSIGNMENTS (NON-NEGOTIABLE)\n`);
      sections.push(`Each of these real details MUST be concretely named in the exact spread listed. Do NOT paraphrase them away.`);
      plan.manifest.forEach(m => {
        sections.push(`- Spread ${m.spread}: "${m.anecdote_value}" (${m.anecdote_key}) — ${m.use}`);
      });
    }

    const favoriteObjectLock = buildFavoriteObjectLock(plan);
    if (favoriteObjectLock) {
      sections.push(`\n${favoriteObjectLock}`);
    }

    const climaxBeat = plan.beats.find(b =>
      b.beat === 'CLIMAX' || b.beat === 'WISH_MOMENT' || b.beat === 'WONDER' ||
      b.beat === 'QUIET_MOMENT' || b.beat === 'NAMING',
    );

    sections.push(`\n## NARRATIVE COHERENCE (READ THIS FIRST)\n`);
    sections.push(`- Whatever arc you invent, each spread must connect to the one before it. No slideshow of unrelated activities.`);
    sections.push(`- Group spreads that share a location or emotional space; narrate transitions when places change.`);
    sections.push(`- This story has ONE through-line: ${child.name} and ${parentName} together. Every spread connects to that bond.`);
    sections.push(`- **Setting variety:** Use **at least 4 distinct, visually different physical places** as the day unfolds. Avoid "mostly two rooms + one outing + back inside" unless the anecdotes demand it.`);
    sections.push(`- CLARITY: Images and metaphors must be literal enough for a young listener.`);

    sections.push(`\n## CRITICAL REMINDERS\n`);
    sections.push(`- AABB couplets throughout — every line pair must rhyme`);
    if (climaxBeat) {
      sections.push(`- The climax/quiet spread (${climaxBeat.spread}) should have the FEWEST words`);
    }
    sections.push(`- This is a CELEBRATION book, not a bedtime book. EVERY spread must be WARM, JOYFUL, and POSITIVE — no anger, crying, tantrums, tiredness, sleep, tuck-in, dreams, or goodnight as the dominant beat.`);
    sections.push(`- The ending must be warm, bright, and celebratory in DAYLIGHT (or awake evening light). Do NOT default to "walking home" / "heading home" / "back at home".`);
    sections.push(`- Close on an IMAGE, not a declaration — no "I love you" as the last line`);
    sections.push(`- Every spread needs at least one concrete, specific noun`);
    sections.push(`- NO greeting card language. NO "you are special/wonderful/amazing"`);
    sections.push(`- The refrain must appear exactly 3 times (4 only if needed for closure), evenly spaced — **at least one on spread 10–13**. The refrain should **deepen** in meaning each time (same words, shifting context).`);
    sections.push(`- RHYME VARIETY: Avoid letting one rhyme sound dominate (including overlap with refrain end-rhymes).`);
    sections.push(isFather
      ? `- Use ONLY the parent name "${parentName}" — do NOT invent any other name for the father beyond the dedication rule above.`
      : `- Use ONLY the parent name "${parentName}" — do NOT invent any other name for the mother beyond the dedication rule above.`);
    sections.push(`- NEVER use they/them/their pronouns for ${child.name}. ${child.gender === 'female' ? 'She is a girl — use she/her.' : child.gender === 'male' ? 'He is a boy — use he/him.' : ''} "They" is only for plural subjects (${child.name} and ${parentName} together).`);
    sections.push(`- NEVER use dashes, hyphens, or em dashes in read-aloud TEXT. Use commas, periods, or line breaks instead.`);
    sections.push(`- At least 2 spreads use imagination — magical play where ${parentName} joins in. Include at least one beat where ${child.name} lovingly "takes care of" ${parentName}.`);

    sections.push(`\n## BOOK-WIDE VISUAL SHOWRUNNER\n`);
    sections.push(`- Storyboard mentally: no duplicate dominant tableau unless the TEXT demands it; vary viewpoint, scale, light, micro-zone.`);
    sections.push(`- Returning locations later need new "still" moments, not stock repeats.`);

    sections.push(`\n## OUTFIT_LOCK (MANDATORY — hero ${child.name}, after final spread)\n`);
    sections.push(`After \`---SPREAD ${plan.spreadCount.target}---\`, output exactly one line: OUTFIT_LOCK: <one sentence: ${child.name}'s day clothes — colors, top, bottom, shoes, one accessory. Same wording in dry-land scenes unless bath/pool per rules.>`);

    sections.push(`\n## OUTPUT FORMAT\n`);
    sections.push(`Each spread: ---SPREAD N---, then TEXT: and SCENE: as required by SCENE RULES above.`);

    return sections.join('\n');
  }

  _buildWritePrompt(plan, child, book) {
    if (this.category === 'parent') {
      return this._buildParentGiftWritePrompt(plan, child, book);
    }

    const pronouns = plan.pronouns;
    const anecdoteText = this._formatAnecdotes(child.anecdotes);
    const sections = [];

    sections.push(`## THE CHILD\n`);
    sections.push(`Name: ${child.name}`);
    sections.push(`Age: ${child.age}`);
    sections.push(`Gender: ${child.gender || 'not specified'} (pronouns: ${pronouns.pair})`);
    if (child.appearance) sections.push(`Appearance: ${child.appearance}`);
    if (child.interests?.length) sections.push(`Interests: ${child.interests.join(', ')}`);

    // Theme-specific context
    if (this.category === 'celebration') {
      sections.push(`\n## CELEBRATION DETAILS\n`);
      if (child.anecdotes?.favorite_cake_flavor) sections.push(`Favorite cake flavor: ${child.anecdotes.favorite_cake_flavor}`);
      if (child.anecdotes?.favorite_toys) sections.push(`Favorite toys: ${child.anecdotes.favorite_toys}`);
      if (child.anecdotes?.birth_date) sections.push(`Birth date: ${child.anecdotes.birth_date}`);
    }

    if (this.category === 'celebration' && (this.themeName === 'birthday' || this.themeName === 'birthday_magic')) {
      sections.push(`\n## BIRTHDAY CAKE ARC (NON-NEGOTIABLE)\n`);
      sections.push(`This is a **birthday** book. The story must **coherently lead** to a birthday-cake ending — not a random set of activities with cake tacked on at the end.`);
      sections.push(`- **Build-up:** Spreads 1 through ~9 should read as one day moving toward the party climax (anticipation, games, songs, small obstacles or excitement — specifics are up to you). Each spread should be a **new visible beat**, not a duplicate tableau.`);
      sections.push(`- **Climax:** Spread **12** = wish + **lit candles** + blow (name cake/candles in TEXT). Spread **13** = **first bite** of cake and pure joy (name the cake; use favorite flavor if provided).`);
      sections.push(`- **No alternative ending** — the book closes on cake joy, in **daylight / warm party light**, not bedtime, not "heading home" as the main beat.`);
      sections.push(`- **Coherence for QA:** Mid-book party or yard settings are FINE if transitions are clear and the reader feels **forward motion to the table**. Do not teleport from unrelated errands straight to spread 12 without set-up.`);
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
      sections.push(`\n## ILLUSTRATION CONSTRAINT — CHILD-ONLY HUMAN (CRITICAL — QA WILL REJECT THE BOOK)\n`);
      sections.push(`We only have the CHILD's reference for interior art. The printed cover may show the hero alone. Every interior spread must be drawable with **only the hero** as a full, recognizable person.`);
      sections.push(`- The TEXT and SCENE must NOT require two adults, a couple, "mom and dad", or any pair of full grown-ups in the frame. Lines like "parents strolled", "Mama and Daddy push the pram", or "they walked beside the stroller" **will fail automated illustration QA** (unexpected people).`);
      sections.push(`- Strollers, wagons, sand, and outings: show **${child.name}** in the seat or beside the object. Caregivers may appear only as **implied** presence: a single hand on a pushbar entering from the edge, a shoulder or sleeve cropped so **no face** shows, a distant indistinct silhouette, OR skip adults entirely.`);
      sections.push(`- The story text must NOT name a family member as standing next to the child in a way that forces two full bodies. Do NOT write "Grandpa stood there" or "Mom waved" as visible beats. Use traces instead: a packed lunch, a note, footsteps in sand, a kite string rising toward someone off-panel.`);
      sections.push(`- The child is the ONLY human with a face in every spread. Animals, fantasy creatures, and nature are fine — do not add named walk-on adults the illustrator must render in full.`);
      sections.push(`- "Book from: ${book.bookFrom || 'family'}" is emotional context, not a license to add visible relatives.`);
    }

    if (book.title && !isPlaceholderTitle(book.title)) {
      const titleKeywords = this._extractTitleKeywords(book.title, child.name);
      sections.push(`\n## BOOK TITLE — TITLE COHERENCE IS MANDATORY\n`);
      sections.push(`The approved cover title is: "${book.title}"`);
      sections.push(`The title's core concept MUST be concretely present in AT LEAST three spreads across the book:`);
      sections.push(`- Introduced early (one of the first few spreads) so a reader opening the book immediately sees why it's called "${book.title}".`);
      sections.push(`- Paid off at whatever spread you make the climax/peak — the title's concept is the promise the cover makes.`);
      sections.push(`- Echoed in the closing so the final image clearly belongs under "${book.title}".`);
      if (titleKeywords.length > 0) {
        sections.push(`Keywords from the title that must appear (or be clearly represented) somewhere in the text: ${titleKeywords.map(k => `"${k}"`).join(', ')}.`);
      }
      sections.push('Do NOT write a generic theme story that happens to sit under this cover. The story must feel commissioned FOR this title.');
    }

    if (plan.plotSynopsis) {
      sections.push(`\n## PLOT CONCEPT\n`);
      sections.push(plan.plotSynopsis);
      sections.push('\nUse this as the creative seed of the story — lean into THIS plot, not a generic version of the theme. The spread-by-spread shape, however, is yours to invent (see INVENTED ARC below).');
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

    sections.push(`\n## REFRAIN (SHIP-BLOCKER — matches automated QA)\n`);
    sections.push(`Pick ONE refrain wording before you write spread 1 and use the **exact same words** every time it appears (minimum 3 times, not back-to-back spreads).`);
    sections.push(`**Closure rule:** At least one occurrence MUST appear on spread 10, 11, 12, or 13. A refrain that only appears in spreads 1–8 will fail QA.`);
    sections.push(`Space repeats across early, middle, and late — the last repeat should land when the emotional arc resolves.`);
    if (plan.refrain.parentWord) {
      sections.push(`It should use "${plan.refrain.parentWord}" and be under 8 words.`);
    } else {
      sections.push(`The refrain should be under 8 words and capture the emotional core of the theme.`);
    }
    sections.push(`Suggested refrains (you may create your own):`);
    plan.refrain.suggestions.forEach(s => sections.push(`- "${s}"`));

    appendLocationPaletteSection(sections, plan);

    sections.push(`\n## PLOT ↔ ILLUSTRATION (paintable beats)\n`);
    sections.push(`Every spread's TEXT must describe a **concrete story moment** — a specific action, interaction, discovery, or turn that naturally belongs in that spread's assigned palette location. Avoid vague mood-only lines that could swap between spreads without changing the story.`);
    sections.push(`The emotional arc should **progress**: new situations, time or weather shifts, props introduced or paid off, relationship beats that land — so spreads are not interchangeable "nice day" stanzas. If a spread does not advance something the reader can **see**, rewrite it.`);
    sections.push(`Each SCENE block must describe a **different visible moment** from the prior spread — not the same pose and framing with new rhyme text. When two **consecutive** spreads share a palette location, the SCENE must still change sub-area, action, and **camera viewpoint** so the art does not look like a duplicate spread.`);
    sections.push(`When a location **reappears later** in the book (not only back-to-back spreads), treat it as a new "still" — different action, time-of-day cue, or micro-zone; do not echo an earlier spread's composition from the same place.`);
    sections.push(`The illustrator only has your words: concrete beats produce beautiful, specific art; abstraction produces generic stock scenes.`);

    sections.push(`\n## INVENTED ARC (spread-by-spread beat sketches — SOFT HINTS, not a rigid template)\n`);
    sections.push(`Write exactly ${plan.spreadCount.target} spreads. The beat sketches below are STARTING INSPIRATION only — you are expected to shape the arc yourself so it serves THIS child, THIS theme, THESE anecdotes. Keep what helps, replace what doesn't. The only HARD constraints on shape are:`);
    sections.push(`- Spread 1 must open OUT IN THE WORLD, in a specific non-home setting.`);
    sections.push(`- The final spreads must land a warm, concrete image YOU invent — not a formulaic "heading home", "walking home", or "back at home" shot.`);
    sections.push(`- There is NO prescribed Scene A / Scene B / Scene C / Scene D. Decide where tension builds, where the peak sits, and how the story resolves.`);
    sections.push(`- Each beat below is LOCKED to the palette location shown next to it. The TEXT and SCENE you write for that spread must both take place in that location.`);
    sections.push(`- Anecdote-assignment rules (if any) below are the only per-spread mandates.\n`);
    sections.push(`Sketches:`);
    plan.beats.forEach(b => {
      const locationTag = b.location ? ` {location: ${b.location}}` : '';
      const desc = this._sanitizeBeatDescription(b.description);
      sections.push(`Spread ${b.spread} (${b.beat})${locationTag}: ${desc} [~${b.wordTarget} words]`);
    });

    appendSceneRulesSection(sections, { parentGiftTheme: false });

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

    // Find the climax/quiet beat
    const climaxBeat = plan.beats.find(b =>
      b.beat === 'CLIMAX' || b.beat === 'WISH_MOMENT' || b.beat === 'WONDER' ||
      b.beat === 'QUIET_MOMENT' || b.beat === 'NAMING'
    );

    sections.push(`\n## NARRATIVE COHERENCE (READ THIS FIRST)\n`);
    sections.push(`- Whatever arc you invent, each spread must connect to the one before it. No slideshow of unrelated activities.`);
    sections.push(`- Group spreads that share a location or emotional space. Do NOT jump to a new location within a group of spreads without narrating the transition.`);
    sections.push(`- Location transitions must be clear — the reader must always know WHERE the characters are and WHY they moved.`);
    sections.push(`- **Setting variety:** Prefer **at least 4 distinct physical settings** with clear movement between them. Avoid the “home → brief outing → home for the rest” sandwich unless the theme truly requires a homebound story — that pattern often feels repetitive in illustrations.`);
    sections.push(`- If the story seed’s **intended setting** is a backyard or yard “adventure course,” treat sub-zones (tall-grass jungle, sand pit, splash patch, climb zone) as **different photographable places** with explicit transitions so QA does not read the book as one static lawn.`);
    sections.push(`- CLARITY: Every image and metaphor must be literal enough for a 3-year-old to picture. If you mix imagination and reality, signal the shift clearly.`);

    sections.push(`\n## CRITICAL REMINDERS\n`);
    sections.push(`- AABB couplets throughout, every line pair must rhyme`);
    if (climaxBeat) {
      sections.push(`- The climax/quiet spread (${climaxBeat.spread}) should have the FEWEST words`);
    }
    sections.push(`- Close on an IMAGE, not a declaration, no "I love you" as the last line`);
    sections.push(`- Every spread needs at least one concrete, specific noun`);
    sections.push(`- NO greeting card language. NO "you are special/wonderful/amazing"`);
    sections.push(`- The refrain must appear exactly 3 times (4 only if required for the closing couplet), evenly spaced (not in consecutive spreads), with **at least one hit on spread 10–13**. More than 4 appearances makes the story monotonous.`);
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

    sections.push(`\n## BOOK-WIDE VISUAL SHOWRUNNER (before you finish, mentally storyboard all spreads)\n`);
    sections.push(`- No two spreads may land on the **same dominant tableau** (same emotional pose + same backdrop) unless the TEXT truly demands a callback — and even then, change **viewpoint, scale, time-of-day, or micro-zone** in the SCENE so the "photograph" is obviously different.`);
    sections.push(`- If two spreads (even **non-consecutive** ones) use the same palette location, they must not look like the same stock image: reread your SCENES and ensure different focal actions, camera distance, and foreground.`);
    sections.push(`- Keep **light and time** coherent across a single day: do not default every outdoor beat to the same golden-hour orange unless the story is stuck at one moment; let morning, mid-day, and late-day read differently in the SCENE.`);

    sections.push(`\n## OUTFIT_LOCK (MANDATORY — one line after spread ${plan.spreadCount.target})\n`);
    sections.push(`Interior art is checked against a **pre-rendered cover**. After \`---SPREAD ${plan.spreadCount.target}---\` (TEXT + SCENE), output a **single** final line on its own, not inside any spread block:`);
    sections.push(`OUTFIT_LOCK: <one sentence: ${child.name}'s **day** clothes in plain words — colors, top, bottom, shoes, and any one accessory. This exact outfit must appear in every **dry-land** SCENE; only bath/pool/sleep per system rules may swap it.>`);
    sections.push(`Every SCENE paragraph must **repeat the same garment words** (not "sometimes a dress, sometimes shorts") unless you are in a permitted situational mode.`);

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
    if (this.themeName === 'fathers_day' && a.dads_favorite_moment) items.push(`Dad's favorite moment: ${a.dads_favorite_moment}`);
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
    if (this.themeName === 'fathers_day' && anecdotes.dads_favorite_moment) {
      parts.push(`Dad's favorite moment: ${anecdotes.dads_favorite_moment}`);
    }
    if (anecdotes.favorite_food) parts.push(`Favorite food: ${anecdotes.favorite_food}`);
    if (anecdotes.favorite_cake_flavor) parts.push(`Favorite cake flavor: ${anecdotes.favorite_cake_flavor}`);
    if (anecdotes.favorite_toys) parts.push(`Favorite toys: ${anecdotes.favorite_toys}`);
    if (anecdotes.other_detail) parts.push(`Other detail: ${anecdotes.other_detail}`);
    if (anecdotes.anything_else) parts.push(`Additional: ${anecdotes.anything_else}`);
    return parts.join('\n');
  }
}

// ── Shared prompt helpers used by GenericThemeWriter ────────────────────────

/**
 * Inject the LOCATION PALETTE section into a prompt builder's `sections` list.
 * No-op if the plan has no palette (we quietly skip so the prompt still reads
 * coherently when the LLM palette call failed).
 */
function appendLocationPaletteSection(sections, plan) {
  const palette = plan && plan.locationPalette;
  if (!palette || !Array.isArray(palette.palette) || palette.palette.length === 0) return;
  sections.push(`\n## LOCATION PALETTE (the book happens in THESE named places — nowhere else)\n`);
  sections.push(`A scout built this palette for your book. Every spread you write is LOCKED to one of these locations. This palette exists so the illustrator can render each place with visual continuity AND so the book feels designed, not dropped into generic rooms.`);
  sections.push(``);
  palette.palette.forEach(entry => {
    const anchors = Array.isArray(entry.visual_anchors) && entry.visual_anchors.length
      ? ` — visual anchors: ${entry.visual_anchors.join('; ')}`
      : '';
    sections.push(`- ${entry.name}${anchors}`);
  });
  sections.push(``);
  sections.push(`Rules for using the palette:`);
  sections.push(`- When a beat below lists a {location: ...}, BOTH the TEXT and SCENE for that spread must take place there. No drift.`);
  sections.push(`- Continuity means **same place and same locked anchors** — not the same illustration twice. Consecutive spreads that share a location should feel continuous in story time (light, weather, sound may carry over), but each SCENE must show a **different slice** of the moment: different action, micro-zone of the space, or prop beat — and a **different viewpoint** (see SCENE RULES). Never reuse the same composition as the prior spread.`);
  sections.push(`- When the location changes between adjacent spreads, the TEXT must narrate the transition in a single line so the reader never loses the thread.`);
  sections.push(`- Never invent a new location outside the palette. Never use a generic "home" / "house" / "living room" / "supermarket" as a setting for a spread that has a palette location assigned.`);
}

/**
 * Append the SCENE RULES block — this is the contract for the SCENE field that
 * the writer emits alongside each spread's TEXT. The illustrator uses the
 * SCENE verbatim as its scene prompt, so this text has to describe what to
 * draw, not what the parent reads aloud.
 *
 * @param {string[]} sections
 * @param {{ parentGiftTheme?: boolean, parentOnCoverFullFaceAllowed?: boolean, themedParentWord?: string }} [options]
 *   themedParentWord: "mother" | "father" — used only when parentOnCoverFullFaceAllowed.
 */
function appendSceneRulesSection(sections, options = {}) {
  const parentGiftTheme = options.parentGiftTheme === true;
  const parentOnCover = options.parentOnCoverFullFaceAllowed === true;
  const themedParentWord = typeof options.themedParentWord === 'string' && options.themedParentWord.trim()
    ? options.themedParentWord.trim().toLowerCase()
    : 'parent';
  sections.push(`\n## SCENE RULES (these govern the SCENE: block you write under every spread)\n`);
  sections.push(`For every spread you write a TEXT block (the read-aloud poem) AND a SCENE block (art direction for the illustrator). The illustrator reads the SCENE word-for-word, so it must match the TEXT and describe the image we want.`);
  sections.push(``);
  sections.push(`Each SCENE block is a single paragraph of 40-70 words that includes, at minimum:`);
  sections.push(`- The palette LOCATION NAME (written exactly as it appears in the palette above). Non-negotiable.`);
  sections.push(`- The time of day and the quality of light (dawn gold, midday glare, overcast hush, lantern light, dusk blue).`);
  sections.push(`- What the hero child is DOING in the moment — concrete body action that matches the TEXT (reaching up, crouching over something, running, holding, tasting).`);
  sections.push(`- The emotion on the hero's face in one or two words ("eyes wide with delight", "nose scrunched").`);
  sections.push(`- Two or three tangible visual anchors you borrow from the palette entry's anchor list or invent for continuity.`);
  sections.push(`- A **VIEWPOINT / FRAMING** clause every spread — plain language only (e.g. wide shot of the whole plaza, medium on the hero at the fountain, low angle toward the clock tower, over-the-shoulder toward the gate, closer framing on hands and object). This is how we avoid 13 near-identical compositions.`);
  sections.push(`- Any objects, animals, or recurring props that appear in the TEXT (so the illustrator can plant them in the right place).`);
  sections.push(`- The **same plot beat** as the TEXT: same cause-and-effect, same actions and props — in visually specific language (who, what, where, light). The SCENE earns the illustration; it must not read like a generic stock photo when the TEXT already implies something more specific.`);
  sections.push(``);
  sections.push(`SCENE rules (strict):`);
  sections.push(`- The SCENE must describe THE SAME moment the TEXT describes — not a paraphrase, not "a later moment". If the TEXT says the child is peeking at a fish, the SCENE shows the child peeking at a fish.`);
  if (parentGiftTheme && parentOnCover) {
    sections.push(`- **BOOK COVER — THEMED ${themedParentWord.toUpperCase()} VISIBLE:** The ${themedParentWord} is on the printed cover reference. Whenever the ${themedParentWord} appears with a visible face or full figure (when the TEXT calls for it), the SCENE must **match that cover depiction** — reuse the same distinctive hair length, texture, color, skin tone / undertones, eyes if visible, face shape cues, approximate age, and outfit family as rendered on the cover. Do NOT invent a different ethnicity, hairstyle, skin color, or "new actor" interpretation; treat the cover as the ${themedParentWord}'s locked character model across spreads (same facial identity — expressions and poses may vary).`);
    sections.push(`- **Other humans:** Do not introduce extra anonymous full-face adults unrelated to named characters unless the TEXT demands a named crowd slice; generic background extras should stay blurred, distant, or backs turned.`);
  } else {
    sections.push(`- Do NOT describe parent or other family faces — they appear only via hands/shoulders/silhouettes (the illustrator enforces this). You may say "mother's hand adjusting a scarf" or "dad's silhouette at the gate"; never "mother smiles warmly".`);
  }
  sections.push(`- **No readable business or storefront copy in the SCENE.** Do not invent shop names, bakery or bookstore lettering, or phrases like "a sign reading …". The illustrator must not paint words in the environment. Describe retail streets generically: warm window glow, striped awnings, blurred distant shapes, baskets of goods without legible labels.`);
  sections.push(`- Never describe on-image manuscript captions (the illustrator places the read-aloud TEXT separately). Do not instruct painted signage, posters, chalkboards, or labels with words — those invite OCR failures.`);
  sections.push(`- **One continuous panorama:** The SCENE must read as a **single** wide outdoor/indoor space flowing across the spread — not "on the left page X, on the right page Y" as two separate compositions. Describe one unified moment (path, gate, garden) so the illustrator paints **one** image later split for printing, not two pictures side-by-side.`);
  sections.push(`- **Same location as the previous spread?** If the beat list shows the same {location: ...} on this spread and the one before, you MUST change **at least two** of: distance to the hero (wide vs closer), camera height (eye level vs low vs high), viewing direction / which landmark faces camera, or dominant foreground vs midground — while keeping palette anchors consistent. Do not paste the prior SCENE with one word changed.`);
  sections.push(`- Never describe art style ("Pixar-style", "3D render") or aspect ratio. Viewpoint words (wide, closer, low angle, over-the-shoulder) are required; they describe the moment, not technical metadata.`);
  sections.push(`- No contradictions with the TEXT. If the TEXT says the child is laughing, don't say they're crying. If the TEXT is outdoors, the SCENE is outdoors.`);
  sections.push(`- **Bathtub / bath time:** If the child is in the tub, do NOT describe them wearing their usual day outfit (overalls, jeans, dress) in the water. Describe **thick bubble-bath foam** piled high so it is clearly bath time while shoulders, arms, and face stay visible — modest, age-appropriate, no nudity, no bare-chest detail. You may instead describe stepping in/out with a **towel wrapped** around the torso. Never use words like naked or nude.`);
  if (parentGiftTheme && parentOnCover) {
    sections.push(`- **Parent-gift theme — parent ON approved cover:** The ${themedParentWord} may appear with face and/or full figure when the moment needs it — still avoid dense anonymous crowds beside the protagonists (keep street noise as blurry depth if needed). Every time the ${themedParentWord}'s appearance is rendered, reconnect to the BOOK COVER look (hair, skin, proportions, recognizable outfit lineage).`);
  } else if (parentGiftTheme) {
    sections.push(`- **Parent-gift theme (Mother's/Father's Day):** Avoid busy sidewalks crowded with implied pedestrians. If the beat needs shops or a main street, keep **no extra full humans** in frame besides the hero (and any on-cover companion the palette allows). The parent is **implied presence only** when not on the cover — hands, stroller push bar, shoulder edge, silhouette — never a named crowd or "people walking by".`);
  } else {
    sections.push(`- **Non-parent / adventure-etc. themes (child-only cover path):** The SCENE must **not** stage two full adults, a man-and-woman couple, "parents beside the pram", or any beat that would force the illustrator to paint two full caregivers. The hero is the only full human. Use implied hands, one cropped adult edge, off-panel voice, or empty stroller path — or non-human companions. If the TEXT mentions love/family, show it with objects, weather, and gesture — not extra full-size adults in frame.`);
  }
  sections.push(`- **SCENE = composition contract:** The illustrator will follow your SCENE as the main shot; every SCENE should specify a different focal "still" from other spreads, especially when the palette location repeats.`);
  sections.push(`- Keep it concrete and particular. Avoid "magical", "beautiful", "amazing" as standalone adjectives — name the thing that makes it magical.`);
  sections.push(``);
  sections.push(`OUTPUT FORMAT for every spread (exact):`);
  sections.push(`---SPREAD N---`);
  sections.push(`TEXT:`);
  sections.push(`<the 2-line or 4-line poem, exactly as the parent will read it aloud>`);
  sections.push(`SCENE:`);
  sections.push(`<40-70 word single-paragraph art direction for the illustrator, following every rule above>`);
  sections.push(``);
  sections.push(`Omitting the SCENE block on ANY spread, or letting it drift from the TEXT, is a ship-blocker.`);
}

module.exports = { GenericThemeWriter, appendLocationPaletteSection, appendSceneRulesSection, parseWriterOutput };
