/**
 * companionKind (ce-19): the ONE shared answer to "is the theme companion a
 * person?" — consumed by the sheet builder, the renderer's COMPANION block,
 * the spread QA and the contact gate, so they can never disagree.
 */

const { HUMAN_TYPE_RE, isHumanCompanionType, isChildCompanionType } = require('../../../services/shared/illustration/companionKind');
const catalogJson = require('../../../services/catalogEngine/data/catalog.json');

test('the catalog\'s two adult guides are people; every other companion is a creature/character', () => {
  const themes = Array.isArray(catalogJson.themes) ? catalogJson.themes : Object.values(catalogJson.themes || catalogJson);
  const human = Object.fromEntries(themes.map(t => [t.theme_id, isHumanCompanionType(t.companion.type)]));
  expect(human).toEqual({
    farm: true, construction: true,
    dinosaur: false, space: false, under_the_sea: false, jungle: false, safari: false,
    enchanted_forest: false, pirate: false, dream: false, christmas: false, thanksgiving: false,
  });
});

test('human roles, fairy-tale people and children match; creatures, robots and sprites do not; non-strings never match', () => {
  for (const t of ['kindly old fisherman guide', 'forest witch', 'brave knight', 'little boy', 'a grandmother', 'friendly astronaut', 'elf', 'space pirate']) {
    expect(isHumanCompanionType(t)).toBe(true);
  }
  for (const t of ['young triceratops', 'small exploration robot', 'small glowing forest sprite', 'friendly green parrot', 'young reindeer', 'guide dog']) {
    expect(isHumanCompanionType(t)).toBe(t === 'guide dog'); // "guide" is a human-role word — conservative by design
  }
  expect(isHumanCompanionType(null)).toBe(false);
  expect(isHumanCompanionType(undefined)).toBe(false);
  expect(isHumanCompanionType(42)).toBe(false);
  expect(HUMAN_TYPE_RE.flags).toContain('i');
});

test('isChildCompanionType names only child words', () => {
  expect(isChildCompanionType('little boy helper')).toBe(true);
  expect(isChildCompanionType('a toddler')).toBe(true);
  expect(isChildCompanionType('friendly adult farm guide')).toBe(false);
  expect(isChildCompanionType('young triceratops')).toBe(false);
  expect(isChildCompanionType(null)).toBe(false);
});
