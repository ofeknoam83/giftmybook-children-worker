const {
  getThemeDirective,
  renderThemeDirectiveBlock,
} = require('../../../services/bookPipeline/planner/themeDirectives');

describe('themeDirectives', () => {
  test('renders Mother\'s Day hooks without dragon-specific attractors', () => {
    const block = renderThemeDirectiveBlock('mothers_day');
    const directive = getThemeDirective('mothers_day');
    const directiveMissionAndHooks = [...directive.mustInclude, ...directive.adventureHooks].join(' ');

    expect(block).toContain('THEME DIRECTIVE — mothers_day');
    expect(block).toContain('ADVENTURE HOOKS');
    expect(block).toContain('mission palette');
    expect(block).toContain('companion/object palette');
    expect(block).toContain('Mom connection palette');
    expect(block.toLowerCase()).not.toContain('dragon');
    expect(directiveMissionAndHooks.toLowerCase()).not.toContain('sunrise ribbon courier');
    expect(directiveMissionAndHooks.toLowerCase()).not.toContain('ribbon crumbs');
  });

  test('keeps Mother\'s Day anti-cliche and adventure requirements', () => {
    const directive = getThemeDirective('mothers_day');

    expect(directive.bannedCliches).toEqual(expect.arrayContaining([
      'tea party / pouring tea',
      'breakfast in bed as the main event',
      'handmade card as the climax',
    ]));
    expect(directive.mustInclude.join(' ')).toMatch(/4 DISTINCT/);
    expect(directive.adventureHooks.join(' ')).toMatch(/recombination/);
  });
});
