/**
 * Shared style block for every 2.5D sprite Gemini call.
 *
 * The pivot moved the whole game to billboarded painted sprites in the
 * Don't Starve / Paper Mario family, so every sprite generator (character
 * pose sheet, hero props, NPCs, library items, backdrops) needs the exact
 * same visual language. Import this block — don't duplicate it.
 */

const SPRITE_STYLE_BLOCK = [
  'STYLE (MANDATORY — applies to the subject and every painted element):',
  "- Don't Starve / Paper Mario family: thick dark ink outline (≈3-5% of the sprite short-edge), painterly gouache fills, matte highlights.",
  '- Stylized flat-3D silhouette read at a glance; no photoreal textures, no airbrush gradients, no shiny plastic.',
  '- Warm pastel palette with one saturated accent colour so the item pops against a neutral floor.',
  '- Three-quarter orthographic view (≈35° above the horizon). Subject centered and upright.',
  '- Soft baked cast shadow (elliptical, dark taupe, ≈30% opacity) directly under the subject on an otherwise TRANSPARENT canvas.',
  '- No props, text, letters, watermarks, borders, floor lines, or backgrounds other than the baked shadow.',
].join('\n');

const TRANSPARENT_BG_BLOCK = [
  'BACKGROUND (ABSOLUTELY CRITICAL — we will chromakey this):',
  '- Every pixel that is NOT the subject (and its own cast shadow) must be pure flat white #FFFFFF.',
  '- No gradients, no off-white, no gray fringe, no rim glow, no halo.',
  '- Crisp subject edges — no anti-aliased bloom, no outer soft fade.',
].join('\n');

const CROP_BLOCK = [
  'COMPOSITION:',
  '- Square 1:1 aspect unless noted otherwise.',
  '- Subject occupies ~70% of the frame height, centered horizontally.',
  '- The subject\'s base (feet, wheels, pot bottom) rests at ~85% from the top so the cast shadow lives in the bottom band.',
].join('\n');

function spritePrompt(subjectLine, extraLines = []) {
  return [
    subjectLine,
    '',
    SPRITE_STYLE_BLOCK,
    '',
    CROP_BLOCK,
    '',
    TRANSPARENT_BG_BLOCK,
    ...(extraLines.length ? ['', ...extraLines] : []),
    '',
    'Output: ONE image only. No sheet, no grid, no alternate angles, no text annotations.',
  ].join('\n');
}

module.exports = {
  SPRITE_STYLE_BLOCK,
  TRANSPARENT_BG_BLOCK,
  CROP_BLOCK,
  spritePrompt,
};
