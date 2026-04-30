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
    expect(block).toContain('missions:');
    expect(block).toContain('companions:');
    expect(block).toContain('Mom ties:');
    expect(block.toLowerCase()).not.toContain('dragon');
    expect(directiveMissionAndHooks.toLowerCase()).not.toContain('sunrise ribbon courier');
    expect(directiveMissionAndHooks.toLowerCase()).not.toContain('ribbon crumbs');
  });

  test('keeps Mother\'s Day anti-cliche and adventure requirements', () => {
    const directive = getThemeDirective('mothers_day');

    expect(directive.bannedCliches).toEqual(expect.arrayContaining([
      'tea party / pouring tea as THE entire plot spine',
      'breakfast in bed as the ONLY climax',
      'handmade card as the ONLY payoff',
    ]));
    expect(directive.mustInclude.join(' ')).toMatch(/4 DISTINCT/);
    expect(directive.adventureHooks.join(' ')).toMatch(/recombination/);
  });
});
