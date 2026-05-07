/**
 * Stage 7 — Beat Sheet
 *
 * Maps the StoryIntent + StoryBible into one beat per spread, with
 * per-spread success_criteria and prohibited[] arrays the deterministic
 * gate enforces literally. The most important field in the system is
 * each beat's success_criteria — the critic grades against it.
 */

const fs = require('fs');
const path = require('path');
const { callWithRole } = require('../../llm/modelRouter');

const SYSTEM = fs.readFileSync(
  path.join(__dirname, '../../llm/prompts/beatSheetPlanner.system.md'),
  'utf8',
);

async function beatSheetActivity(input, ctx) {
  const { intent, storyBible, ageProfile, characterBible, worldBible } = input;
  const spreadCount = ageProfile?.narrativeConstraints?.spreadCount || 12;

  const userPrompt = JSON.stringify({
    instructions: `Produce a BeatSheet JSON with exactly ${spreadCount} beats — one per spread.`,
    spreadCount,
    intent,
    storyBible,
    ageProfile,
    characterBible,
    worldBible,
  });

  const resp = await callWithRole('PLANNER', {
    systemPrompt: SYSTEM,
    userPrompt,
    jsonMode: true,
    temperature: 0.5,
    maxTokens: 7000,
    label: 'v2.beatSheet',
  });
  // Accept several shapes the model may emit despite a strict prompt:
  //   { spreads: [...] }   (canonical)
  //   { beats:   [...] }   (common synonym)
  //   [ ...beats ]         (bare array)
  //   { beat_sheet: [...] }, { items: [...] }  (rarer)
  // The downstream contract is `sheet.spreads = [...]`, so we normalize.
  let sheet = resp.json;
  let beats = null;
  if (Array.isArray(sheet)) {
    beats = sheet;
    sheet = {};
  } else if (sheet && typeof sheet === 'object') {
    beats = (
      Array.isArray(sheet.spreads)    ? sheet.spreads :
      Array.isArray(sheet.beats)      ? sheet.beats :
      Array.isArray(sheet.beat_sheet) ? sheet.beat_sheet :
      Array.isArray(sheet.items)      ? sheet.items :
      Array.isArray(sheet.pages)      ? sheet.pages :
      null
    );
  }
  if (!beats) {
    const keys = sheet && typeof sheet === 'object' ? Object.keys(sheet).join(',') : typeof sheet;
    throw new Error(`beatSheet: model did not return an array of beats (top-level keys: ${keys})`);
  }
  sheet.spreads = beats;
  if (sheet.spreads.length !== spreadCount) {
    ctx.log('warn', `[v2] beatSheet returned ${sheet.spreads.length} beats, age profile asked for ${spreadCount} — will proceed (writer loops handle off-by-one)`);
  }
  // Drop empties just in case the model padded with placeholders.
  sheet.spreads = sheet.spreads.filter(b => b && typeof b === 'object');
  // Ensure every beat has the structural fields the writer + gate read.
  sheet.spreads = sheet.spreads.map((b, i) => ({
    spread: typeof b.spread === 'number' ? b.spread : i + 1,
    phase: b.phase || null,
    purpose: b.purpose || '',
    target_emotion: b.target_emotion || '',
    success_criteria: Array.isArray(b.success_criteria) ? b.success_criteria : [],
    prohibited: Array.isArray(b.prohibited) ? b.prohibited : [],
    page_turn_hook: b.page_turn_hook || null,
    callbacks_introduced: Array.isArray(b.callbacks_introduced) ? b.callbacks_introduced : [],
    callbacks_used: Array.isArray(b.callbacks_used) ? b.callbacks_used : [],
    implied_caregiver: b.implied_caregiver || null,
    location_hint: b.location_hint || null,
    on_screen_characters: Array.isArray(b.on_screen_characters) ? b.on_screen_characters : [],
  }));
  sheet.version = '1.0';
  sheet.generated_at = new Date().toISOString();
  sheet.model = resp.model;
  ctx.log('info', `[v2] beatSheet locked: ${sheet.spreads.length} beats`);
  return sheet;
}

module.exports = { beatSheetActivity };
