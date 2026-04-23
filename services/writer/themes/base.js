/**
 * BaseThemeWriter — shared logic for all theme-specific writers.
 *
 * Provides: age tier detection, LLM calling (GPT-5.4 primary, Gemini fallback),
 * spread parsing, structure validation, pronoun helpers, parent name resolution.
 *
 * Subclasses implement: plan(), write(), revise()
 */

const { WRITER_CONFIG } = require('../config');
const { getPronounInfo, buildPronounInstruction, checkAndFixPronouns } = require('../quality/pronoun');
const { sanitizeForGemini } = require('../../promptSanitizer');

// LLM infrastructure — reuse the same HTTP + timeout helpers from storyPlanner
const DEFAULT_LLM_TIMEOUT_MS = WRITER_CONFIG.timeouts.defaultLLM;
const GEMINI_MODEL = 'gemini-2.5-pro';
const GEMINI_FLASH_MODEL = 'gemini-2.5-flash';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// ── HTTP helpers ──

async function fetchWithTimeout(url, init, timeoutMs, requestLabel) {
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (didTimeout) throw new Error(`${requestLabel || 'LLM request'} timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAI(systemPrompt, userPrompt, opts = {}) {
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error('OpenAI API key not available');

  const useStream = (opts.maxTokens || 4000) > 8000;
  const resp = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-5.4',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: opts.temperature || 0.8,
      max_completion_tokens: opts.maxTokens || 4000,
      response_format: opts.jsonMode ? { type: 'json_object' } : undefined,
      stream: useStream || undefined,
      ...(useStream ? { stream_options: { include_usage: true } } : {}),
    }),
  }, opts.timeoutMs || DEFAULT_LLM_TIMEOUT_MS, opts.requestLabel || 'OpenAI request');

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${err.slice(0, 200)}`);
  }

  if (useStream) {
    const rawText = await resp.text();
    if (rawText.trimStart().startsWith('data:')) {
      const lines = rawText.split('\n');
      let content = '';
      let finishReason = 'stop';
      let inputTokens = 0;
      let outputTokens = 0;
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') break;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) content += delta.content;
          const reason = chunk.choices?.[0]?.finish_reason;
          if (reason) finishReason = reason;
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens || inputTokens;
            outputTokens = chunk.usage.completion_tokens || outputTokens;
          }
        } catch (_) { /* skip malformed SSE lines */ }
      }
      finishReason = finishReason === 'length' ? 'MAX_TOKENS' : (finishReason || 'stop');
      return { text: content, inputTokens, outputTokens, finishReason };
    }
    const data = JSON.parse(rawText);
    const choice = data.choices?.[0];
    return {
      text: choice?.message?.content || '',
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
      finishReason: choice?.finish_reason === 'length' ? 'MAX_TOKENS' : (choice?.finish_reason || 'stop'),
    };
  }

  const data = await resp.json();
  const choice = data.choices?.[0];
  let content = choice?.message?.content || '';
  if (Array.isArray(content)) {
    content = content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  return {
    text: typeof content === 'string' ? content : '',
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
    finishReason: choice?.finish_reason === 'length' ? 'MAX_TOKENS' : (choice?.finish_reason || 'stop'),
  };
}

async function callGeminiText(systemPrompt, userPrompt, genConfig) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const { timeoutMs, requestLabel, model, ...geminiGenConfig } = genConfig || {};
  const geminiModel = model || GEMINI_MODEL;

  // Wire-layer sanitization: scrub invisibles, homoglyphs, and role-injection
  // patterns that can reach this point after being interpolated from user
  // input into system prompts / user prompts. See services/promptSanitizer.js.
  const safeSystem = sanitizeForGemini(systemPrompt);
  const safeUser = sanitizeForGemini(userPrompt);

  const body = {
    systemInstruction: { parts: [{ text: safeSystem }] },
    contents: [{ role: 'user', parts: [{ text: safeUser }] }],
    generationConfig: geminiGenConfig,
  };

  let resp;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      resp = await fetchWithTimeout(
        `${GEMINI_BASE_URL}/${geminiModel}:generateContent?key=${apiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        timeoutMs || DEFAULT_LLM_TIMEOUT_MS,
        requestLabel || `Gemini request attempt ${attempt}`,
      );
      break;
    } catch (fetchErr) {
      console.warn(`[writerV2] Gemini fetch attempt ${attempt}/3 failed: ${fetchErr.message}`);
      if (attempt === 3) throw fetchErr;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const result = await resp.json();
  const candidate = result.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text || '';
  const finishReason = candidate?.finishReason || 'unknown';

  // Detect safety blocks and other non-STOP finish reasons with no content
  if (!text && finishReason !== 'STOP') {
    const blockReason = result.promptFeedback?.blockReason || candidate?.finishReason || 'unknown';
    console.error(`[writerV2] Gemini returned empty content. finishReason=${finishReason}, blockReason=${blockReason}`);
    throw new Error(`Gemini returned no content (finishReason=${finishReason}, blockReason=${blockReason})`);
  }

  return {
    text,
    inputTokens: result.usageMetadata?.promptTokenCount || 0,
    outputTokens: result.usageMetadata?.candidatesTokenCount || 0,
    finishReason,
  };
}

// ── BaseThemeWriter class ──

class BaseThemeWriter {
  constructor(themeName) {
    this.themeName = themeName;
  }

  /**
   * Strip banned "heading home" / "walking home" formulas out of a beat
   * description before it is rendered into the writer prompt. Legacy plot
   * templates were built around a "Scene D = walk home" ending — we now
   * let the LLM invent the final beat, so these phrases would leak through
   * as an explicit instruction if we didn't scrub them.
   *
   * Keeps the rest of the description intact. If the description collapses
   * to nothing meaningful, returns a generic "invent this beat" placeholder.
   *
   * @param {string} desc
   * @returns {string}
   */
  _sanitizeBeatDescription(desc) {
    if (!desc || typeof desc !== 'string') return desc;

    // Patterns that make an entire sentence "heading-home formula". If any one
    // of these matches a sentence, that whole sentence is dropped.
    const bannedSentencePatterns = [
      /\bheading home\b/i,
      /\bwalking home\b/i,
      /\bwalk home\b/i,
      /\bwalks? home\b/i,
      /\bwalked home\b/i,
      /\bstroll(?:s|ed|ing)? home\b/i,
      /\btrudg(?:e|es|ed|ing) home\b/i,
      /\bsquelch(?:es|ed|ing) home\b/i,
      /\bsprint(?:s|ed|ing) home\b/i,
      /\bhurry(?:ing)? home\b/i,
      /\bcarr(?:y|ies|ied|ying)\b[^.!?;]*?\bhome\b/i,
      /\bback (?:at|to|toward|towards) home\b/i,
      /\bback home\b/i,
      /\bnear home\b/i,
      /\bhomeward\b/i,
      /\breturning home\b/i,
      /\bthe (?:journey|walk|path|road|way) home\b/i,
      /\bpoints? back home\b/i,
      /\bturns? (?:back )?toward(?:s)? home\b/i,
    ];

    // Split on sentence terminators while keeping them attached.
    const sentences = desc.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) || [desc];
    const kept = sentences.filter(s => {
      const trimmed = s.trim();
      if (!trimmed) return false;
      return !bannedSentencePatterns.some(rx => rx.test(trimmed));
    });

    let out = kept.join(' ').replace(/\s{2,}/g, ' ').replace(/\s+([.,;!?])/g, '$1').trim();

    // If nothing meaningful survived, fall back to a neutral "invent it" note.
    if (!out || out.length < 12) {
      return `Invent this beat — let the arc you're building dictate what happens. NOT a "heading home" / "walking home" shot.`;
    }
    return out;
  }

  /**
   * Build a book-wide "location palette" of 3-5 thrilling, distinct, photogenic
   * settings and assign every beat to one of them. The palette becomes the
   * ground truth for WHERE each spread happens, and drives both the writer
   * (SCENE block per spread) and the illustrator (named locations continuity).
   *
   * Design notes:
   *  - The system prompt steers on ABSTRACT quality criteria only (thrilling,
   *    specific, photogenic, distinct, plausibly-reachable). It does NOT list
   *    example locations — that would bias the LLM to repeat them.
   *  - The ONLY concrete location concepts injected into the prompt are what
   *    the parent supplied (storySeed.setting, book.customDetails, anecdotes).
   *  - If beats already have `location` (e.g. from anecdoteDrivenPlot), those
   *    are preserved and the palette is built around them.
   *  - On failure we never fabricate example defaults; we either fall back to
   *    parent-anecdote-derived locations or leave beats unlabelled and let the
   *    writer revert to soft-hint behavior.
   *
   * @param {object} params
   * @param {object} params.child
   * @param {object} params.book
   * @param {Array<{spread:number, beat:string, description:string, location?:string}>} params.beats
   * @param {object} [params.storySeed]
   * @returns {Promise<{
   *   palette: Array<{id: string, name: string, visual_anchors: string[]}>,
   *   beatAssignments: Array<{spread: number, location_id: string}>,
   * } | null>}
   */
  async buildLocationPalette({ child, book, beats, storySeed }) {
    if (!Array.isArray(beats) || beats.length === 0) return null;

    // Preserve any locations already assigned by upstream planners.
    const preassigned = beats
      .filter(b => typeof b?.location === 'string' && b.location.trim())
      .map(b => ({ spread: b.spread, location: b.location.trim() }));

    const theme = this.themeName || book?.theme || 'adventure';
    const ambition = pickAmbition(theme);
    const parentVisible = theme === 'mothers_day' || theme === 'fathers_day';

    // Collect ONLY parent-provided concrete inputs — no hardcoded exemplars.
    const seedSetting = (storySeed?.setting || '').toString().trim();
    const seedSpine = (storySeed?.narrative_spine || storySeed?.storySeed || '').toString().trim();
    const customDetails = (book?.customDetails || '').toString().trim();
    const anecdoteBlock = this._parentProvidedLocationHints(child, book);

    const systemPrompt = [
      `You are a master scout for a children's picture book. Your job is to choose the set of physical PLACES this ${theme.replace(/_/g, ' ')} book happens in — the locations that will make readers turn the page just to see what's next.`,
      '',
      'QUALITY BAR (each palette entry must satisfy ALL of these):',
      '- THRILLING. The kind of place that makes a parent say "I want to go there" and a child say "whoa". Never ordinary. Never a default.',
      '- PHOTOGENIC AND SPECIFIC. Has at least three concrete visual anchors a painter could reproduce on every spread set there (distinctive structure, signature texture/color/material, light source, weather, time of day). Prefer anchors that allow **micro-zones** within the same place (e.g. entrance arch vs fountain vs far terrace) so multiple spreads there can show different areas without breaking continuity. Never abstract ("a magical place", "somewhere special").',
      '- NAMED. Proper-noun-feeling short name with a qualifier. Avoid bare nouns. "the harbor at first light" is fine; "the harbor" alone is not.',
      '- DISTINCT. No two palette entries share their dominant mood, time-of-day, OR dominant material. If two entries could be the same suburban house or yard in different lighting, collapse them into one.',
      '- PLAUSIBLY REACHABLE. Two consecutive spreads in different palette locations must be connectable by a single sentence of narration inside a picture book.',
      '',
      `AMBITION — ${ambition.label}. ${ambition.guidance} Do not narrow the palette by mimicking any canonical list; invent.`,
      '',
      'HARD BAN-LIST (never emit these as palette entries, even if they feel cozy):',
      '- "the supermarket", "the grocery store", "the store", "the market" without a specific named character to it',
      '- "the living room", "the hallway", "the stairs", "the kitchen" as a dominant palette location',
      '- "the bedroom" (unless the book theme is bedtime)',
      '- "at home", "the house", "the apartment" as an unqualified location',
      '- "a magical place", "somewhere special", "a faraway land" — these are abstractions, not places',
      '- Generic **neighborhood park**, **playground**, swing set, or "the park" as a palette entry — UNLESS paired with a spectacular differentiator in `name` and `visual_anchors` (e.g. cliff-edge park, ancient-tree amphitheater, lighthouse district green). Default suburban park/playground is a ship-blocker.',
      '- **Backyard garden**, flower garden, vegetable patch, picnic lawn, or private **garden** as a dominant palette entry — UNLESS the user prompt explicitly names that exact place. Prefer epic outdoor stages: lighthouse rock, rope bridge, waterfall terrace, canyon trail, balloon deck, ice cave, castle rampart, tide cave, observatory ridge, floating market pier, desert dune line, marble ruins — or invented equivalents with the same wow factor.',
      '- Undifferentiated generic backyard patio, deck, "outdoor play area", sandbox yard, OR generic living room / playroom / nursery / "family room" as a dominant palette entry — UNLESS the user prompt (parent anecdotes, customDetails, or pre-assigned beat) explicitly names that exact place. If home-adjacent is required, every such entry MUST include a cinematic differentiator in visual_anchors (e.g. golden-hour storm light, one impossible-looking natural moment, unusual architecture, regional specificity, a signature prop) — never catalog-stock suburban default.',
      `${parentVisible ? '- Any palette entry that depends on a visible family-member face being drawn (the other parent, grandparent, sibling). This book only has the child\'s reference photo — the themed parent is shown through hands and hidden-face poses only.' : '- Any palette entry that depends on drawing family members who are not the hero child. Only the hero appears with full face.'}`,
      '',
      'STRUCTURAL RULES:',
      '- Emit between 3 and 5 palette entries. No duplicates. Each entry is used by 1 or more consecutive spreads.',
      `- You must assign all ${beats.length} spreads. Consecutive spreads may share a location — 2–4 spreads per location is fine — but **each spread at a given location must imply a different visible beat**: different activity, micro-zone of the space, time-of-day or weather shift, or prop/story turn. The writer must never be tempted to reuse the same tableau; plan distinct visibility per spread even when location_id repeats.`,
      `- Transitions between locations should align with natural story turns (rising action, peak, resolution) so the book's images track the plot — not one static place unless the beats truly require it.`,
      `- Spread 1 must NOT be an at-home opener. Spread ${beats.length} may be outdoors or indoors but must match a palette entry — not a generic "back home" shot.`,
      '- Preserve any location that a previous planning step already locked to a specific spread (listed in the user prompt).',
      '- Respect any parent-provided concrete place concepts (listed in the user prompt) — if the parent named a place they love, it MUST appear as a palette entry.',
      '',
      'OUTPUT (JSON object, no prose outside):',
      '{',
      '  "palette": [',
      '    {',
      '      "id": "<short_snake_case_id>",',
      '      "name": "<unique, specific, named place including a qualifier — never a bare noun>",',
      '      "visual_anchors": ["<anchor 1>", "<anchor 2>", "<anchor 3>"]',
      '    }',
      '  ],',
      '  "beatAssignments": [',
      '    { "spread": <int>, "location_id": "<id from palette>" }',
      '  ]',
      '}',
    ].join('\n');

    const userLines = [];
    userLines.push(`Theme: ${theme}`);
    userLines.push(`Child: ${child?.name || 'unnamed'}${child?.age != null ? `, age ${child.age}` : ''}`);
    if (seedSpine) userLines.push(`Story spine: ${seedSpine}`);
    if (seedSetting) userLines.push(`Parent-supplied setting concept (must be honored as a palette entry OR directly inspire one): ${seedSetting}`);
    if (customDetails) userLines.push(`Parent-written custom details (every concrete place mentioned here MUST become a palette entry): ${customDetails}`);
    if (anecdoteBlock) {
      userLines.push('');
      userLines.push('Parent-supplied anecdotes that hint at places the child knows (convert only the ones that name or imply a concrete location):');
      userLines.push(anecdoteBlock);
    }

    if (preassigned.length > 0) {
      userLines.push('');
      userLines.push('Pre-assigned locations (these MUST appear in the palette exactly as written, and keep their spread assignments):');
      preassigned.forEach(p => userLines.push(`- Spread ${p.spread}: ${p.location}`));
    }

    userLines.push('');
    userLines.push(`Beats to assign (${beats.length}):`);
    beats.forEach(b => {
      const desc = this._sanitizeBeatDescription(b.description || '');
      const line = `- Spread ${b.spread} (${b.beat || 'BEAT'})${b.location ? ` [locked to: ${b.location}]` : ''}: ${desc.slice(0, 160)}`;
      userLines.push(line);
    });

    userLines.push('');
    userLines.push('Now emit the JSON palette and beat assignments.');

    const userPrompt = userLines.join('\n');

    let parsed = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await this.callLLM('planner', systemPrompt, userPrompt, {
          jsonMode: true,
          maxTokens: 1800,
          temperature: 0.95,
          timeoutMs: 90_000,
        });
        const normalized = normalizePaletteResponse(result.text, beats);
        if (normalized) {
          parsed = normalized;
          break;
        }
        console.warn(`[writerV2] Location palette attempt ${attempt}: response did not validate, retrying`);
      } catch (err) {
        console.warn(`[writerV2] Location palette attempt ${attempt} failed: ${err.message}`);
      }
    }

    if (!parsed) {
      // Parent-anecdote-derived fallback only. We never seed generic defaults —
      // that would bias subsequent runs and undercut the whole point of this
      // step. If we can't find anything parent-provided, we return null and
      // the writer reverts to soft-hint behavior.
      return this._buildPaletteFallback({ beats, storySeed, book, preassigned });
    }

    // Preserve pre-assigned beat locations even if the LLM reshuffled them.
    if (preassigned.length > 0) {
      for (const pa of preassigned) {
        const matchEntry = parsed.palette.find(p => p.name.trim().toLowerCase() === pa.location.toLowerCase());
        if (!matchEntry) {
          // LLM dropped a locked location — inject it.
          const id = slugify(pa.location);
          parsed.palette.push({ id, name: pa.location, visual_anchors: [] });
          parsed.beatAssignments = parsed.beatAssignments.filter(a => a.spread !== pa.spread);
          parsed.beatAssignments.push({ spread: pa.spread, location_id: id });
          continue;
        }
        const existing = parsed.beatAssignments.find(a => a.spread === pa.spread);
        if (!existing || existing.location_id !== matchEntry.id) {
          parsed.beatAssignments = parsed.beatAssignments.filter(a => a.spread !== pa.spread);
          parsed.beatAssignments.push({ spread: pa.spread, location_id: matchEntry.id });
        }
      }
    }

    return parsed;
  }

  /**
   * Apply a palette's assignments back onto a beats array. Each beat gets
   * `location` (the palette entry's full name) and `visual_anchors` (array of
   * 0..N strings). Beats whose spread has no assignment are left untouched.
   *
   * @param {Array} beats
   * @param {{palette: Array, beatAssignments: Array}} palette
   * @returns {Array} new beats array
   */
  applyPaletteToBeats(beats, palette) {
    if (!palette || !Array.isArray(palette.palette) || !Array.isArray(palette.beatAssignments)) {
      return beats;
    }
    const entriesById = new Map();
    palette.palette.forEach(p => entriesById.set(p.id, p));
    const assignmentsBySpread = new Map();
    palette.beatAssignments.forEach(a => assignmentsBySpread.set(Number(a.spread), a.location_id));
    return beats.map(b => {
      const id = assignmentsBySpread.get(Number(b.spread));
      const entry = id ? entriesById.get(id) : null;
      if (!entry) return b;
      return {
        ...b,
        location: entry.name,
        visual_anchors: Array.isArray(entry.visual_anchors) ? entry.visual_anchors.slice(0, 6) : [],
      };
    });
  }

  /**
   * Pull parent-provided hints that imply concrete places from anecdotes.
   * Used only as a prompt input to the palette builder so the LLM sees what
   * the family has already named (their park, their favorite bakery, a pet,
   * a favorite food that implies a kitchen, etc.). Never a location palette
   * on its own.
   */
  _parentProvidedLocationHints(child, book) {
    const a = (child && child.anecdotes) || {};
    const lines = [];
    if (a.favorite_activities) lines.push(`- favorite activities: ${a.favorite_activities}`);
    if (a.meaningful_moment) lines.push(`- meaningful moment: ${a.meaningful_moment}`);
    if (a.funny_thing) lines.push(`- funny thing they do: ${a.funny_thing}`);
    if (a.favorite_food) lines.push(`- favorite food: ${a.favorite_food}`);
    if (a.favorite_toys) lines.push(`- favorite toys: ${a.favorite_toys}`);
    if (a.other_detail) lines.push(`- other detail: ${a.other_detail}`);
    if (a.anything_else) lines.push(`- additional: ${a.anything_else}`);
    if (Array.isArray(child?.interests) && child.interests.length) {
      lines.push(`- interests: ${child.interests.join(', ')}`);
    }
    return lines.join('\n');
  }

  /**
   * Anecdote-only fallback palette. Returns null if nothing concrete can be
   * extracted — we DO NOT invent placeholder palette entries.
   */
  _buildPaletteFallback({ beats, storySeed, book, preassigned }) {
    const entries = [];
    const seen = new Set();
    const pushEntry = (name, anchors = []) => {
      const clean = typeof name === 'string' ? name.trim() : '';
      if (!clean) return;
      const key = clean.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ id: slugify(clean), name: clean, visual_anchors: anchors });
    };

    for (const p of preassigned) pushEntry(p.location);

    const seedSetting = (storySeed?.setting || '').toString().trim();
    if (seedSetting && seedSetting.length < 120) pushEntry(seedSetting);

    const customDetails = (book?.customDetails || '').toString().trim();
    if (customDetails) {
      // Crude place extraction: look for capitalized multi-word proper-noun
      // fragments ("Hudson Park", "Nonna's bakery"). If nothing useful is
      // found we simply drop through — no generic fillers.
      const matches = customDetails.match(/\b(?:the\s+)?(?:[A-Z][a-zA-Z'’]*\s+){1,3}(?:Park|Garden|Beach|Market|Bakery|Library|Bridge|Trail|Station|Harbor|Pier|Meadow|Forest|Zoo|Aquarium|Museum)\b/g);
      if (matches) matches.forEach(m => pushEntry(m));
    }

    if (entries.length === 0) return null;

    // Assign spreads round-robin across whatever entries we managed to pull.
    // Consecutive spreads share locations to give the reader continuity.
    const beatAssignments = [];
    const spreadsPerEntry = Math.max(1, Math.ceil(beats.length / entries.length));
    for (let i = 0; i < beats.length; i++) {
      const idx = Math.min(Math.floor(i / spreadsPerEntry), entries.length - 1);
      beatAssignments.push({ spread: beats[i].spread, location_id: entries[idx].id });
    }
    // Pre-assigned spreads override the round-robin.
    for (const p of preassigned) {
      const entry = entries.find(e => e.name.toLowerCase() === p.location.toLowerCase());
      if (!entry) continue;
      const at = beatAssignments.findIndex(a => a.spread === p.spread);
      if (at >= 0) beatAssignments[at] = { spread: p.spread, location_id: entry.id };
    }

    return { palette: entries, beatAssignments };
  }

  /**
   * Get age tier name based on child's age.
   * Two tiers: young-picture (0-3) and picture-book (4-6).
   * Both produce 13-spread books; tier affects vocabulary, not structure.
   * @param {number|string} age
   * @returns {string} 'young-picture' or 'picture-book'
   */
  getAgeTier(age) {
    const a = Number(age) || 3;
    if (a <= 3) return 'young-picture';
    return 'picture-book';
  }

  /**
   * Get word count limits for an age tier.
   * @param {number|string} age
   * @returns {{ maxWords: number, wordsPerSpread: { min: number, max: number } }}
   */
  getWordLimits(age) {
    const tierName = this.getAgeTier(age);
    const tier = WRITER_CONFIG.ageTiers[tierName];
    return { maxWords: tier.maxWords, wordsPerSpread: tier.wordsPerSpread };
  }

  /**
   * Get spread count range for an age tier.
   * @param {number|string} age
   * @returns {{ min: number, max: number }}
   */
  getSpreadCount(age) {
    const tierName = this.getAgeTier(age);
    return WRITER_CONFIG.ageTiers[tierName].spreads;
  }

  /**
   * Call the best available LLM — GPT-5.4 primary, Gemini fallback.
   * @param {string} role - 'planner', 'writer', 'critic', 'reviser'
   * @param {string} systemPrompt
   * @param {string} userPrompt
   * @param {object} opts - { jsonMode, maxTokens, timeoutMs }
   * @returns {{ text: string, model: string, inputTokens: number, outputTokens: number }}
   */
  async callLLM(role, systemPrompt, userPrompt, opts = {}) {
    const modelConfig = WRITER_CONFIG.models[role] || WRITER_CONFIG.models.writer;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (openaiKey) {
      try {
        console.log(`[writerV2] Calling GPT-5.4 for ${role}...`);
        const result = await callOpenAI(systemPrompt, userPrompt, {
          apiKey: openaiKey,
          temperature: opts.temperature || modelConfig.temperature,
          maxTokens: opts.maxTokens || 8000,
          jsonMode: opts.jsonMode,
          timeoutMs: opts.timeoutMs,
          requestLabel: `writerV2-${role}`,
        });
        if (opts.jsonMode && !String(result.text || '').trim()) {
          throw new Error('GPT-5.4 returned empty JSON-mode content');
        }
        const llmResult = { ...result, model: 'gpt-5.4' };
        this._recordLLMCall(role, llmResult, systemPrompt, userPrompt);
        return llmResult;
      } catch (err) {
        console.warn(`[writerV2] GPT-5.4 failed for ${role}, falling back to Gemini: ${err.message}`);
      }
    }

    // Fallback to Gemini
    const fallbackModel = modelConfig.fallback || GEMINI_MODEL;
    const isFlash = fallbackModel.includes('flash');
    console.log(`[writerV2] Calling Gemini ${fallbackModel} for ${role}...`);
    const result = await callGeminiText(systemPrompt, userPrompt, {
      maxOutputTokens: opts.maxTokens || 8000,
      temperature: opts.temperature || modelConfig.temperature,
      responseMimeType: opts.jsonMode ? 'application/json' : undefined,
      timeoutMs: opts.timeoutMs,
      requestLabel: `writerV2-${role}`,
      model: isFlash ? GEMINI_FLASH_MODEL : GEMINI_MODEL,
    });
    const llmResult = { ...result, model: fallbackModel };
    this._recordLLMCall(role, llmResult, systemPrompt, userPrompt);
    return llmResult;
  }

  /**
   * Record raw LLM call data for pipeline transparency.
   * Only records if _pipeline was set by the engine.
   */
  _recordLLMCall(role, result, systemPrompt, userPrompt) {
    if (!this._pipeline) return;
    this._pipeline.llmCalls.push({
      role,
      model: result.model,
      systemPrompt: systemPrompt.substring(0, 500) + (systemPrompt.length > 500 ? '...' : ''),
      userPrompt: userPrompt.substring(0, 1000) + (userPrompt.length > 1000 ? '...' : ''),
      rawResponse: result.text.substring(0, 2000) + (result.text.length > 2000 ? '...' : ''),
      tokens: { input: result.inputTokens, output: result.outputTokens },
      finishReason: result.finishReason,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Parse LLM output into structured spread array.
   * Handles ---SPREAD N--- delimited format and optional TEXT: / SCENE: blocks.
   *
   * With TEXT + SCENE blocks (new writer format):
   *   ---SPREAD 1---
   *   TEXT:
   *   The story text here...
   *   SCENE:
   *   Scene description for the illustrator...
   *
   * Returns `{ spread, text, scene }` objects. `scene` is an empty string when
   * the writer didn't emit a SCENE block (legacy writers, older revisers, or
   * the odd parse failure). Callers should fall back to their previous
   * illustrator prompt source in that case.
   *
   * @param {string} rawText
   * @returns {Array<{ spread: number, text: string, scene: string }>}
   */
  parseSpreads(rawText) {
    const spreads = [];
    if (!rawText || !rawText.trim()) {
      console.warn(`[writerV2] parseSpreads: received empty or null rawText`);
      return spreads;
    }
    const pattern = /---\s*SPREAD\s+(\d+)\s*---/gi;
    const parts = rawText.split(pattern);

    for (let i = 1; i < parts.length; i += 2) {
      const spreadNum = parseInt(parts[i], 10);
      const body = (parts[i + 1] || '').trim();
      if (!body) continue;
      const { text, scene } = splitTextAndScene(body);
      if (text) {
        spreads.push({ spread: spreadNum, text, scene });
      }
    }

    if (spreads.length === 0) {
      const fallbackPattern = /(?:^|\n)\s*(?:Spread\s+)?(\d+)[:.]\s*/gi;
      const fallbackParts = rawText.split(fallbackPattern);
      for (let i = 1; i < fallbackParts.length; i += 2) {
        const spreadNum = parseInt(fallbackParts[i], 10);
        const body = (fallbackParts[i + 1] || '').trim();
        if (body && spreadNum >= 1 && spreadNum <= 20) {
          const { text, scene } = splitTextAndScene(body);
          if (text) spreads.push({ spread: spreadNum, text, scene });
        }
      }
    }

    if (spreads.length === 0 && rawText.trim()) {
      console.warn(`[writerV2] parseSpreads: no spread markers found, falling back to paragraph splitting. Raw text starts with: ${rawText.substring(0, 200)}`);
      const chunks = rawText.trim().split(/\n\s*\n/).filter(c => c.trim());
      chunks.forEach((chunk, i) => {
        const { text, scene } = splitTextAndScene(chunk.trim());
        spreads.push({ spread: i + 1, text, scene });
      });
    }

    if (spreads.length === 0) {
      console.error(`[writerV2] parseSpreads: FAILED to extract any spreads. Raw text length: ${rawText.length}, first 300 chars: ${rawText.substring(0, 300)}`);
    }

    return spreads;
  }

  /**
   * Validate spread structure against age tier requirements.
   * @param {Array<{ spread: number, text: string }>} spreads
   * @param {number|string} age
   * @returns {{ valid: boolean, issues: string[] }}
   */
  validateStructure(spreads, age) {
    const tierName = this.getAgeTier(age);
    const tier = WRITER_CONFIG.ageTiers[tierName];
    const issues = [];

    // Check spread count
    if (spreads.length < tier.spreads.min) {
      issues.push(`Too few spreads: got ${spreads.length}, need at least ${tier.spreads.min}`);
    }
    if (spreads.length > tier.spreads.max) {
      issues.push(`Too many spreads: got ${spreads.length}, max is ${tier.spreads.max}`);
    }

    // Check total word count
    const totalWords = spreads.reduce((sum, s) => sum + (s.text || '').split(/\s+/).length, 0);
    if (totalWords > tier.maxWords * 1.2) {
      issues.push(`Total word count too high: ${totalWords} words, max is ${tier.maxWords}`);
    }

    // Check per-spread word counts
    for (const s of spreads) {
      const words = (s.text || '').split(/\s+/).length;
      if (words > tier.wordsPerSpread.max * 1.5) {
        issues.push(`Spread ${s.spread} has ${words} words, max is ${tier.wordsPerSpread.max}`);
      }
    }

    return { valid: issues.length === 0, issues };
  }

  /**
   * Get the child's word for their parent based on theme.
   * @param {object} child - { anecdotes: { calls_mom, calls_dad } }
   * @param {object} book - { theme }
   * @returns {string|null}
   */
  getParentName(child, book) {
    const theme = book.theme || this.themeName;
    if (theme === 'mothers_day' || theme === 'mom_birthday') {
      return child.anecdotes?.calls_mom || 'Mama';
    }
    if (theme === 'fathers_day' || theme === 'dad_birthday') {
      return child.anecdotes?.calls_dad || 'Daddy';
    }
    return null;
  }

  /**
   * Get pronoun info for the child.
   * @param {object} child - { gender }
   * @returns {{ subject: string, object: string, possessive: string, pair: string }}
   */
  getPronouns(child) {
    return getPronounInfo(child.gender);
  }

  // ── Abstract methods — subclasses MUST implement ──

  async plan(child, book) {
    throw new Error(`${this.constructor.name} must implement plan()`);
  }

  async write(plan, child, book) {
    throw new Error(`${this.constructor.name} must implement write()`);
  }

  async revise(story, feedback, child, book) {
    throw new Error(`${this.constructor.name} must implement revise()`);
  }
}

// ── Module helpers (palette + parseSpreads) ──────────────────────────────────

/**
 * Split a spread body into `{ text, scene }` where `scene` is the content
 * after a `SCENE:` marker. Tolerates writer drift:
 *   - `TEXT:` header is optional.
 *   - Missing SCENE block → `scene = ''`.
 *   - `SCENE DESCRIPTION:` and `### SCENE` variants all match.
 *   - Text inside the SCENE block keeps its internal line breaks but is
 *     trimmed at both ends.
 *
 * @param {string} body
 */
function splitTextAndScene(body) {
  if (!body) return { text: '', scene: '' };
  const sceneMarker = /(?:^|\n)\s*(?:#{1,3}\s*)?SCENE(?:\s+DESCRIPTION)?\s*:?\s*(?:\n|$)/i;
  const match = body.match(sceneMarker);
  let textPart = body;
  let scenePart = '';
  if (match && typeof match.index === 'number') {
    textPart = body.slice(0, match.index);
    scenePart = body.slice(match.index + match[0].length);
  }
  textPart = textPart.replace(/^\s*(?:#{1,3}\s*)?TEXT\s*:?\s*/i, '').trim();
  scenePart = scenePart.trim();
  return { text: textPart, scene: scenePart };
}

/**
 * Map a theme to a "palette ambition" — how far the imagination should
 * stretch. The bands are broad so most themes land in the middle; the
 * critical outliers are bedtime (cozy / small-world) and "magic" themes
 * (fully imaginative worlds allowed).
 */
function pickAmbition(theme) {
  if (theme === 'bedtime') {
    return {
      label: 'INTIMATE (cozy, small, warm)',
      guidance: 'The palette should feel like a nest of quiet-yet-rich places — the kind of spots a child would lean into before sleep (a cozy tucked-away garden at dusk, a lantern-lit library alcove, a firefly meadow). Scale back on adrenaline; keep the wonder.',
    };
  }
  if (['birthday', 'birthday_magic', 'adventure', 'dreams'].includes(theme)) {
    return {
      label: 'HIGH AMBITION (imaginative + real, leaning toward the extraordinary)',
      guidance: 'The palette may include fantastical or dreamlike places — weather-impossible gardens, candlelit floating markets, towers that catch the wind. They must still feel like a child could wander in. Pair the fantastical with one grounded real-world location so the book breathes.',
    };
  }
  if (['mothers_day', 'fathers_day'].includes(theme)) {
    return {
      label: 'ELEVATED REAL (everyday raised to cinematic)',
      guidance: 'Each palette entry must feel postcard-worthy: distinctive light, materials, and mood — the kind of place a parent would travel to photograph, not a default subdivision backyard or bland playroom. Real-world places only (not fantasy), but every entry needs one clear visual hook (weather, architecture, time of day, signature prop). Avoid catalog-flat domestic stock unless a parent anecdote explicitly names that exact home space.',
    };
  }
  return {
    label: 'ELEVATED REAL (everyday raised to cinematic)',
    guidance: 'Pick places a child could plausibly visit in this world, but at their most photogenic: distinctive light, distinctive materials, distinctive sounds. The reader should feel like they are on a guided tour of beautiful real places.',
  };
}

/**
 * Parse the palette builder's LLM JSON response into the canonical shape.
 * Returns null if parsing or basic shape validation fails.
 */
function normalizePaletteResponse(raw, beats) {
  if (!raw) return null;
  let parsed;
  try {
    let s = String(raw).trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    parsed = JSON.parse(s);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rawPalette = Array.isArray(parsed.palette) ? parsed.palette : [];
  const rawAssignments = Array.isArray(parsed.beatAssignments) ? parsed.beatAssignments : [];

  const palette = [];
  const seen = new Set();
  for (const entry of rawPalette) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) continue;
    let id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id) id = slugify(name);
    if (seen.has(id)) id = `${id}_${palette.length + 1}`;
    seen.add(id);
    const anchors = Array.isArray(entry.visual_anchors)
      ? entry.visual_anchors.map(a => (typeof a === 'string' ? a.trim() : '')).filter(Boolean).slice(0, 6)
      : [];
    palette.push({ id, name, visual_anchors: anchors });
  }
  if (palette.length < 2 || palette.length > 8) return null;

  const paletteIds = new Set(palette.map(p => p.id));
  const beatAssignments = [];
  const spreadsCovered = new Set();
  for (const a of rawAssignments) {
    if (!a || typeof a !== 'object') continue;
    const spread = Number(a.spread);
    const id = typeof a.location_id === 'string' ? a.location_id.trim() : '';
    if (!Number.isFinite(spread) || !paletteIds.has(id)) continue;
    if (spreadsCovered.has(spread)) continue;
    beatAssignments.push({ spread, location_id: id });
    spreadsCovered.add(spread);
  }

  // Fill any missing beats by inheriting from the previous covered spread
  // (consecutive spreads naturally share locations).
  const beatSpreads = beats.map(b => Number(b.spread)).filter(Number.isFinite);
  beatSpreads.sort((a, b) => a - b);
  let lastId = palette[0].id;
  for (const spread of beatSpreads) {
    const existing = beatAssignments.find(a => a.spread === spread);
    if (existing) {
      lastId = existing.location_id;
    } else {
      beatAssignments.push({ spread, location_id: lastId });
    }
  }
  beatAssignments.sort((a, b) => a.spread - b.spread);

  return { palette, beatAssignments };
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'location';
}

/**
 * Strip all trailing `OUTFIT_LOCK: ...` lines from the end of model output so
 * {@link BaseThemeWriter#parseSpreads} only sees spread blocks. The last non-empty
 * lock value found is returned as `outfitLock` and forwarded to the illustration
 * pipeline as `characterOutfit` (cover-coherent day clothes for the hero).
 *
 * The function also tolerates other non-spread trailing lines that may follow
 * (or be interleaved with) the lock lines — it strips everything from the first
 * `OUTFIT_LOCK:` occurrence in the trailing tail upward, rather than stopping at
 * the first match.
 *
 * @param {string} rawText
 * @returns {{ text: string, outfitLock: string | null }}
 */
function stripOutfitLockFromRaw(rawText) {
  if (!rawText || !String(rawText).trim()) {
    return { text: rawText, outfitLock: null };
  }
  const t = String(rawText);
  const lines = t.split('\n');

  let outfitLock = null;
  let lastSpreadLineIdx = lines.length - 1;
  let seenLock = false;

  // Walk backward, consuming all trailing OUTFIT_LOCK lines and any blank
  // lines that follow (or are interleaved with) them.  Blank lines that appear
  // *before* we have seen any lock line stop the scan immediately so that
  // in-spread blank lines are never incorrectly trimmed.
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    const lockMatch = trimmed.match(/^OUTFIT_LOCK:\s*(.+)$/i);
    if (lockMatch) {
      seenLock = true;
      // Keep the last (chronologically latest) non-empty value.
      const lockValue = lockMatch[1].trim();
      if (!outfitLock && lockValue) {
        outfitLock = lockValue;
      }
      lastSpreadLineIdx = i - 1;
    } else if (trimmed === '' && seenLock) {
      // Blank lines between / after lock lines are fine to skip, but only
      // once we know we are inside the trailing lock zone.
      lastSpreadLineIdx = i - 1;
    } else {
      // First non-blank / non-lock line (or blank before any lock) —
      // this is where the spread content ends.
      lastSpreadLineIdx = i;
      break;
    }
  }

  const strippedText = lines.slice(0, lastSpreadLineIdx + 1).join('\n').trim();
  return { text: strippedText, outfitLock };
}

module.exports = { BaseThemeWriter, callGeminiText, GEMINI_FLASH_MODEL, splitTextAndScene, stripOutfitLockFromRaw };
