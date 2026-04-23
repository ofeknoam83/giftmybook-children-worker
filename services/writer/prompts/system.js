/**
 * Single system prompt builder for Writer V2.
 * Replaces 6 competing prompt files with one unified builder.
 *
 * Takes (theme, ageTier, child, book) and returns a complete system prompt.
 */

const { getRulesForTier, TEN_COMMANDMENTS } = require('./rules');
const { getExemplars } = require('./exemplars');
const { buildPronounInstruction } = require('../quality/pronoun');

/**
 * Build the system prompt for story writing.
 * @param {string} theme - e.g. 'mothers_day'
 * @param {string} tierName - 'young-picture' or 'picture-book'
 * @param {object} child - { name, age, gender, ... }
 * @param {object} book - { theme, format, ... }
 * @param {object} opts - { role: 'writer'|'planner'|'reviser' }
 * @returns {string} system prompt
 */
function buildSystemPrompt(theme, tierName, child, book, opts = {}) {
  const role = opts.role || 'writer';
  const rules = getRulesForTier(tierName);
  const exemplar = getExemplars(theme, tierName);
  const pronounInstruction = buildPronounInstruction(child.name, child.gender);

  const sections = [];

  // Role declaration
  if (role === 'planner') {
    sections.push('You are a world-class children\'s book story planner. You create detailed beat-by-beat story plans for picture books that will be written by a separate writer.');
  } else if (role === 'reviser') {
    sections.push('You are a world-class children\'s book editor. You revise picture book stories based on quality feedback, preserving the emotional arc and fixing specific issues.');
  } else {
    sections.push('You are a world-class children\'s book writer. You write picture books that parents love reading aloud and children beg to hear again. Your writing is clever, fun, and easy to follow — like Dr. Seuss or Julia Donaldson, not like poetry for adults. Keep it simple and playful. A parent should be able to read it once, out loud, and a child should understand every line without explanation.');
  }

  // Core identity
  sections.push(`\nYou are writing a ${rules?.label || 'children\'s picture book'} for a child named ${child.name}, age ${child.age}.`);

  // Pronoun enforcement
  if (pronounInstruction) {
    sections.push(`\n${pronounInstruction}`);
  }

  // The 10 Commandments
  sections.push('\n## THE 10 COMMANDMENTS OF CHILDREN\'S PICTURE BOOK WRITING\n');
  TEN_COMMANDMENTS.forEach((rule, i) => {
    sections.push(`${i + 1}. ${rule}`);
  });

  // Tier-specific rules
  if (rules) {
    sections.push('\n## STRUCTURE RULES\n');
    rules.structure.forEach(r => sections.push(`- ${r}`));

    sections.push('\n## LANGUAGE RULES\n');
    rules.language.forEach(r => sections.push(`- ${r}`));

    sections.push('\n## RHYME & METER RULES\n');
    rules.rhyme.forEach(r => sections.push(`- ${r}`));

    sections.push('\n## ANTI-AI-FLATNESS RULES (CRITICAL)\n');
    sections.push('AI-generated children\'s text has recognizable signatures. You MUST avoid all of these:');
    rules.antiAI.forEach(r => sections.push(`- ${r}`));
  }

  // Exemplar
  if (exemplar && role === 'writer') {
    sections.push('\n## EXEMPLAR — STUDY THIS STYLE\n');
    sections.push(`${exemplar.description}\n`);
    sections.push('Here is an exemplar showing the craft quality we expect. Study the rhythm, the concrete nouns, the emotional arc, and the natural rhymes:\n');
    exemplar.spreads.forEach((text, i) => {
      sections.push(`Spread ${i + 1}:\n${text}\n`);
    });
    sections.push('Your story should match this quality level. Do NOT copy these lines — write original text that demonstrates the same craft.');
  }

  // Output format
  if (role === 'planner') {
    sections.push('\n## OUTPUT FORMAT\n');
    sections.push('Return a JSON object with this structure:');
    sections.push('```json');
    sections.push('{');
    sections.push('  "beats": [');
    sections.push('    { "spread": 1, "beat": "OPENING", "description": "...", "wordTarget": 20 },');
    sections.push('    ...');
    sections.push('  ],');
    sections.push('  "refrain": "the repeating phrase",');
    sections.push('  "ageTier": "picture-book",');
    sections.push('  "totalWordTarget": 400');
    sections.push('}');
    sections.push('```');
  } else if (role === 'writer') {
    sections.push('\n## OUTPUT FORMAT — EVERY SPREAD HAS TEXT + SCENE\n');
    sections.push('Write the story as a sequence of spreads. Every spread MUST include BOTH a TEXT block (the poem the parent will read aloud) AND a SCENE block (art direction for the illustrator).\n');
    sections.push('Format each spread exactly like this:\n');
    sections.push('---SPREAD 1---');
    sections.push('TEXT:');
    sections.push('The story text for spread 1 goes here.');
    sections.push('Two or four lines of AABB couplets.');
    sections.push('SCENE:');
    sections.push('A single paragraph of 40-70 words describing what the illustrator should draw for this spread. Always start by naming the palette location (exactly as written in the user prompt). Include a clear **viewpoint / framing** in plain language (e.g. wide establishing, medium, closer on the hero, low angle, looking toward a landmark). If this spread **repeats a palette location** (same place as the previous spread OR a place the book visited earlier), change at least two of: distance to the hero, camera height, viewing direction, dominant foreground, or time-of-day light — so the still is not a near-duplicate of that other moment. Describe the light, time of day, the hero\'s body action, their expression, 2-3 concrete visual anchors, and any objects the TEXT names. Never mention art style, aspect ratio, captions, or on-image text. Never describe a family member\'s face; reference them only via hand / shoulder / silhouette (when policy allows an implied caregiver).\n');
    sections.push('---SPREAD 2---');
    sections.push('TEXT:');
    sections.push('...');
    sections.push('SCENE:');
    sections.push('...\n');
    sections.push('...and so on for each spread.');
    sections.push('\nThe TEXT block is ONLY the story text — no beat labels, no meta-commentary, nothing for the illustrator. The SCENE block is the illustrator\'s prompt. Both are mandatory on every spread. Omitting the SCENE block on any spread is a ship-blocker.');
    sections.push('After the last spread, output exactly one line: OUTFIT_LOCK: <one sentence describing the hero\'s day outfit (matches the cover) for every dry-land SCENE.>');
  } else if (role === 'reviser') {
    sections.push('\n## OUTPUT FORMAT — EVERY SPREAD STILL HAS TEXT + SCENE\n');
    sections.push('Return the COMPLETE revised story in the same TEXT + SCENE spread format:');
    sections.push('---SPREAD 1---');
    sections.push('TEXT:');
    sections.push('<revised story text>');
    sections.push('SCENE:');
    sections.push('<single paragraph of 40-70 words of art direction — must match the TEXT, lock the palette location, and include viewpoint/framing; when location matches the prior spread, vary distance, angle, or foreground as required>\n');
    sections.push('Preserve the total number of spreads. When you change the TEXT, you MUST rewrite the SCENE to match. Never drop the SCENE block. Fix only the issues identified in the feedback; keep everything that already works.');
    sections.push('Keep or update the final OUTFIT_LOCK line so the hero\'s clothes stay consistent with the cover.');
  }

  return sections.join('\n');
}

module.exports = { buildSystemPrompt };
