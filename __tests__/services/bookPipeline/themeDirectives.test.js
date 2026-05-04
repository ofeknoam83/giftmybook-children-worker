const {
  getThemeDirective,
  renderThemeDirectiveBlock,
} = require('../../../services/bookPipeline/planner/themeDirectives');

describe('themeDirectives', () => {
  describe('parent themes (mothers_day / fathers_day / grandparents_day)', () => {
    test.each(['mothers_day', 'fathers_day', 'grandparents_day'])(
      '%s framing leads with adventure-first orientation',
      (theme) => {
        const directive = getThemeDirective(theme);
        expect(directive).toBeTruthy();
        // Mother's Day prepends a "Love to Mom" line; grandparents has its own
        // framing. They should all surface the adventure-first idea somewhere.
        const framing = String(directive.framing).toLowerCase();
        if (theme === 'grandparents_day') {
          expect(framing).toContain('shared adventure');
          expect(framing).toContain('co-hero');
        } else {
          expect(framing).toContain('adventure book first');
          expect(framing).toContain('emotional spine');
        }
      },
    );

    test.each(['mothers_day', 'fathers_day', 'grandparents_day'])(
      '%s qualityBar contains ADVENTURE SCALE and INHERIT THE ADVENTURE DEFAULTS',
      (theme) => {
        const directive = getThemeDirective(theme);
        const bar = directive.qualityBar.join(' || ');
        expect(bar).toMatch(/ADVENTURE SCALE/);
        expect(bar).toMatch(/INHERIT THE ADVENTURE DEFAULTS/);
        // Saturation softened to BOND THREADS, not all 13 spreads.
        expect(bar).toMatch(/BOND THREADS/);
        expect(bar).not.toMatch(/BOND SATURATION — all 13/);
        // Location variety raised.
        expect(bar).toMatch(/at least 5 distinct named places/);
      },
    );

    test.each(['mothers_day', 'fathers_day', 'grandparents_day'])(
      '%s peakMomentPatterns leads with kinetic options, A QUIET RECOGNITION is last and tagged "use sparingly"',
      (theme) => {
        const directive = getThemeDirective(theme);
        const patterns = directive.peakMomentPatterns;
        expect(patterns.length).toBeGreaterThan(0);
        // First entry must be the new kinetic default.
        expect(patterns[0]).toMatch(/^A SHARED TRIUMPH/);
        // Quiet pattern still present, but last and explicitly de-emphasized.
        const last = patterns[patterns.length - 1];
        expect(last).toMatch(/^A QUIET RECOGNITION/);
        expect(last.toLowerCase()).toContain('use sparingly');
      },
    );

    test('renderThemeDirectiveBlock surfaces FRAMING, qualityBar, and peakMomentPatterns for parent themes', () => {
      const block = renderThemeDirectiveBlock('mothers_day');
      expect(block).toContain('THEME DIRECTIVE — mothers_day');
      expect(block).toContain('FRAMING:');
      expect(block).toContain('PARENT-THEME QUALITY BAR');
      expect(block).toContain('PEAK-MOMENT PATTERNS');
      // Adventure-first framing should be visible in the rendered block.
      expect(block).toContain('ADVENTURE book first');
      expect(block).toContain('ADVENTURE SCALE');
      expect(block).toContain('A SHARED TRIUMPH');
    });

    test('parent-theme directives no longer carry the legacy mustInclude / bannedCliches / adventureHooks fields', () => {
      for (const theme of ['mothers_day', 'fathers_day', 'grandparents_day']) {
        const d = getThemeDirective(theme);
        expect(d.mustInclude).toBeUndefined();
        expect(d.bannedCliches).toBeUndefined();
        expect(d.adventureHooks).toBeUndefined();
      }
    });
  });

  describe('birthday (legacy shape preserved)', () => {
    test('birthday still uses mustInclude / bannedCliches / adventureHooks', () => {
      const d = getThemeDirective('birthday');
      expect(d).toBeTruthy();
      expect(Array.isArray(d.mustInclude)).toBe(true);
      expect(Array.isArray(d.bannedCliches)).toBe(true);
      expect(Array.isArray(d.adventureHooks)).toBe(true);
      expect(d.mustInclude.length).toBeGreaterThan(0);
    });

    test('birthday block renders MUST INCLUDE / BANNED CLICHÉS / ADVENTURE HOOKS', () => {
      const block = renderThemeDirectiveBlock('birthday');
      expect(block).toContain('THEME DIRECTIVE — birthday');
      expect(block).toContain('MUST INCLUDE');
      expect(block).toContain('BANNED CLICHÉS');
      expect(block).toContain('ADVENTURE HOOKS');
    });
  });

  describe('themes without a directive', () => {
    test('returns null and renders empty string for adventure (default planner system prompt drives it)', () => {
      expect(getThemeDirective('adventure')).toBeNull();
      expect(renderThemeDirectiveBlock('adventure')).toBe('');
    });

    test('handles unknown / empty inputs gracefully', () => {
      expect(getThemeDirective('not_a_theme')).toBeNull();
      expect(renderThemeDirectiveBlock('')).toBe('');
      expect(renderThemeDirectiveBlock(null)).toBe('');
      expect(renderThemeDirectiveBlock(undefined)).toBe('');
    });
  });
});
