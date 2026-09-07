/**
 * The optional director (ab-1, docs/AUDIOBOOK_V2_PLAN.md §4.1): ONE
 * strict-JSON text call per story that refines the per-line DIRECTION
 * within the closed enums and picks sound cues per spread from the
 * spread's ALLOWED candidates only — the emotionPlan.js classifier
 * pattern. Every field is validated against the enums; anything else is
 * dropped; any failure leaves the table plan standing (fail-open). No free
 * text from the model ever reaches a provider.
 */

const { judgeAudio } = require('./geminiAudio');
const { EMOTIONS, INTENSITIES } = require('../illustrator/emotionPlan');
const { candidatesForSegment, loadSfxLibrary } = require('./sfx/plan');
const flags = require('../flags');

const DIRECTOR_SCHEMA = {
  type: 'OBJECT',
  properties: {
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          segment: { type: 'INTEGER' },
          line: { type: 'INTEGER' },
          emotion: { type: 'STRING', enum: [...EMOTIONS] },
          intensity: { type: 'STRING', enum: [...INTENSITIES] },
        },
        required: ['segment', 'line', 'emotion', 'intensity'],
      },
    },
    cues: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { spread: { type: 'INTEGER' }, cueIds: { type: 'ARRAY', items: { type: 'STRING' } } },
        required: ['spread', 'cueIds'],
      },
    },
  },
  required: ['lines', 'cues'],
};

/**
 * The director prompt: the lines with their table direction, the allowed
 * cue ids per spread. Manuscript text is quoted as data.
 * @param {object[]} segments
 * @param {Object<number, string[]>} allowed
 * @param {string} band
 * @returns {string}
 */
function buildDirectorPrompt(segments, allowed, band) {
  const rows = [];
  for (const seg of segments) {
    for (const l of seg.lines) rows.push(`${seg.index}.${l.index} [${seg.kind}${seg.spread ? ` ${seg.spread}` : ''}] (${l.direction.emotion}/${l.direction.intensity}${l.isRefrain ? ', REFRAIN' : ''}) ${JSON.stringify(l.text)}`);
  }
  const cueRows = Object.entries(allowed).map(([spread, ids]) => `spread ${spread}: ${ids.length ? ids.join(', ') : '(none)'}`);
  return [
    'You are directing the narrator of a children\'s picture-book audiobook.',
    `The listener is in the ${band} age band.`,
    'For every line below you may refine the delivery: choose ONE emotion from [' + EMOTIONS.join(', ') + '] and ONE intensity from [' + INTENSITIES.join(', ') + '].',
    'Keep the table\'s choice unless the words clearly call for another emotion. A REFRAIN line keeps joy/clear. Band 1-3 never uses worry.',
    'Then, per spread, pick which of the ALLOWED sound cues (if any) should play — only ids from that spread\'s list, at most two, only where the words name the sound.',
    'Lines (segment.line [kind spread] (table emotion/intensity) "text"):',
    ...rows,
    'Allowed sound cues per spread:',
    ...cueRows,
    'Return JSON: {"lines": [{"segment", "line", "emotion", "intensity"}], "cues": [{"spread", "cueIds": []}]}. Include only the lines you change.',
  ].join('\n');
}

/**
 * Run the director over built segments. Returns validated refinements or
 * null (disabled / failed).
 * @param {object} p
 * @param {object[]} p.segments the script's segments (lines with table directions)
 * @param {object} p.book
 * @param {object} p.theme
 * @param {string} p.band
 * @param {object[]} [p.evidence]
 * @param {string[]} [p.masks]
 * @param {object} [p.costTracker]
 * @param {(level: string, msg: string) => void} [p.log]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{lines: Array<{segment: number, line: number, emotion: string, intensity: string}>, cues: Object<number, string[]>}|null>}
 */
async function runDirector({ segments, book, theme, band, evidence = [], masks = [], costTracker, log = () => {}, signal }) {
  if (!flags.audioDirectorEnabled()) return null;
  try {
    const library = loadSfxLibrary();
    const themeId = theme.theme_id || theme.themeId;
    const beats = new Map((book.beats || []).map(b => [b.spread, b]));
    const allowed = {};
    for (const seg of segments) {
      if (seg.kind !== 'spread') continue;
      allowed[seg.spread] = candidatesForSegment({ segment: seg, beat: beats.get(seg.spread) || null, evidence, masks, themeId, band, library }).map(c => c.cueId);
    }
    const { json } = await judgeAudio({ prompt: buildDirectorPrompt(segments, allowed, band), schema: DIRECTOR_SCHEMA, costTracker, signal, maxOutputTokens: 4096 });
    const lines = [];
    const byIndex = new Map(segments.map(s => [s.index, s]));
    for (const row of Array.isArray(json.lines) ? json.lines : []) {
      const seg = byIndex.get(Number(row.segment));
      const line = seg && seg.lines[Number(row.line)];
      if (!line || !EMOTIONS.includes(row.emotion) || !INTENSITIES.includes(row.intensity)) continue;
      if (line.isRefrain) continue;
      if (band === '1-3' && row.emotion === 'worry') continue;
      lines.push({ segment: seg.index, line: line.index, emotion: row.emotion, intensity: row.intensity });
    }
    const cues = {};
    for (const row of Array.isArray(json.cues) ? json.cues : []) {
      const spread = Number(row.spread);
      if (!allowed[spread]) continue;
      const ids = (Array.isArray(row.cueIds) ? row.cueIds : []).filter(id => allowed[spread].includes(id)).slice(0, 2);
      if (ids.length) cues[spread] = ids;
    }
    log('info', `director: ${lines.length} line direction(s) refined, cues on ${Object.keys(cues).length} spread(s)`);
    return { lines, cues };
  } catch (err) {
    log('warn', `director failed (${err.message}) — the table plan stands`);
    return null;
  }
}

/**
 * Apply validated line refinements onto segments (in place).
 * @param {object[]} segments
 * @param {{lines: object[]}|null} refinements
 * @returns {number} lines changed
 */
function applyDirectorLines(segments, refinements) {
  if (!refinements || !Array.isArray(refinements.lines)) return 0;
  let n = 0;
  for (const r of refinements.lines) {
    const seg = segments.find(s => s.index === r.segment);
    const line = seg && seg.lines[r.line];
    if (!line || line.isRefrain) continue;
    if (line.direction.emotion !== r.emotion || line.direction.intensity !== r.intensity) {
      line.direction = { ...line.direction, emotion: r.emotion, intensity: r.intensity };
      n += 1;
    }
  }
  return n;
}

module.exports = { DIRECTOR_SCHEMA, buildDirectorPrompt, runDirector, applyDirectorLines };
