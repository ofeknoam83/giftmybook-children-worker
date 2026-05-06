// AA-CW-5a: deterministic normalization of the LLM's arcContext output.
// Pure lookup-table logic — never throws, never invents content beyond
// the dictionaries declared in createSpreadSpecs.js. The writer and
// illustrator both rely on this shape being present on every spread.

const {
  normalizeArcContext,
  ARC_BEAT_VALUES,
  EMOTIONAL_REGISTER_VALUES,
} = require('../../../services/bookPipeline/planner/createSpreadSpecs');

describe('normalizeArcContext (AA-CW-5a)', () => {
  describe('actNumber', () => {
    test('honors valid LLM-supplied actNumber 1/2/3', () => {
      expect(normalizeArcContext({ actNumber: 1 }, 7, 'rising').actNumber).toBe(1);
      expect(normalizeArcContext({ actNumber: 2 }, 1, 'hook').actNumber).toBe(2);
      expect(normalizeArcContext({ actNumber: 3 }, 5, 'deeper').actNumber).toBe(3);
    });

    test('falls back to spread-number-derived act when LLM omits / passes garbage', () => {
      // 13 spreads → act 1 = 1-4, act 2 = 5-9, act 3 = 10-13.
      expect(normalizeArcContext({}, 1, 'hook').actNumber).toBe(1);
      expect(normalizeArcContext({}, 4, 'rising').actNumber).toBe(1);
      expect(normalizeArcContext({}, 5, 'deeper').actNumber).toBe(2);
      expect(normalizeArcContext({}, 9, 'aftermath').actNumber).toBe(2);
      expect(normalizeArcContext({}, 10, 'return').actNumber).toBe(3);
      expect(normalizeArcContext({}, 13, 'closing').actNumber).toBe(3);
    });

    test('rejects out-of-range actNumber (0, 4, NaN, "two")', () => {
      expect(normalizeArcContext({ actNumber: 0 }, 7, 'rising').actNumber).toBe(2);
      expect(normalizeArcContext({ actNumber: 4 }, 7, 'rising').actNumber).toBe(2);
      expect(normalizeArcContext({ actNumber: NaN }, 7, 'rising').actNumber).toBe(2);
      expect(normalizeArcContext({ actNumber: 'two' }, 7, 'rising').actNumber).toBe(2);
    });
  });

  describe('beat', () => {
    test('honors valid beat from ARC_BEAT_VALUES (case-insensitive)', () => {
      expect(normalizeArcContext({ beat: 'opening' }, 7, 'rising').beat).toBe('opening');
      expect(normalizeArcContext({ beat: 'PEAK' }, 7, 'rising').beat).toBe('peak');
      expect(normalizeArcContext({ beat: '  closing  ' }, 7, 'rising').beat).toBe('closing');
    });

    test('falls back to PURPOSE_TO_BEAT when LLM beat is invalid', () => {
      // 'hook' purpose → 'opening' beat per dictionary.
      expect(normalizeArcContext({ beat: 'wibble' }, 7, 'hook').beat).toBe('opening');
      expect(normalizeArcContext({}, 7, 'last_line').beat).toBe('closing');
      expect(normalizeArcContext({}, 7, 'warm_glow').beat).toBe('return');
    });

    test('falls back to SPREAD_TO_DEFAULT_BEAT when both beat and purpose are absent / unknown', () => {
      expect(normalizeArcContext({}, 1, 'unknown_purpose').beat).toBe('opening');
      expect(normalizeArcContext({}, 8, 'unknown_purpose').beat).toBe('peak');
      expect(normalizeArcContext({}, 13, 'unknown_purpose').beat).toBe('closing');
    });

    test('every emitted beat is in the canonical ARC_BEAT_VALUES set', () => {
      // Spot-check across all 13 spreads with no LLM input — every fallback
      // beat must be a member of ARC_BEAT_VALUES.
      for (let i = 1; i <= 13; i += 1) {
        const out = normalizeArcContext({}, i, '');
        expect(ARC_BEAT_VALUES.has(out.beat)).toBe(true);
      }
    });
  });

  describe('callbackToSpread', () => {
    test('accepts a finite earlier spread number', () => {
      expect(normalizeArcContext({ callbackToSpread: 3 }, 7, 'rising').callbackToSpread).toBe(3);
      expect(normalizeArcContext({ callbackToSpread: 1 }, 13, 'closing').callbackToSpread).toBe(1);
    });

    test('rejects callback to a later or equal spread (cannot reference the future)', () => {
      expect(normalizeArcContext({ callbackToSpread: 7 }, 7, 'rising').callbackToSpread).toBeNull();
      expect(normalizeArcContext({ callbackToSpread: 12 }, 5, 'deeper').callbackToSpread).toBeNull();
    });

    test('rejects out-of-range and non-numeric callback', () => {
      expect(normalizeArcContext({ callbackToSpread: 0 }, 7, 'rising').callbackToSpread).toBeNull();
      expect(normalizeArcContext({ callbackToSpread: 14 }, 13, 'closing').callbackToSpread).toBeNull();
      expect(normalizeArcContext({ callbackToSpread: 'three' }, 7, 'rising').callbackToSpread).toBeNull();
      expect(normalizeArcContext({ callbackToSpread: NaN }, 7, 'rising').callbackToSpread).toBeNull();
    });
  });

  describe('setsUpSpread', () => {
    test('accepts a finite later spread number', () => {
      expect(normalizeArcContext({ setsUpSpread: 9 }, 3, 'rising').setsUpSpread).toBe(9);
      expect(normalizeArcContext({ setsUpSpread: 13 }, 1, 'opening').setsUpSpread).toBe(13);
    });

    test('rejects setsUpSpread to an earlier or equal spread (cannot set up the past)', () => {
      expect(normalizeArcContext({ setsUpSpread: 3 }, 7, 'rising').setsUpSpread).toBeNull();
      expect(normalizeArcContext({ setsUpSpread: 7 }, 7, 'rising').setsUpSpread).toBeNull();
    });

    test('rejects out-of-range and non-numeric setsUpSpread', () => {
      expect(normalizeArcContext({ setsUpSpread: 0 }, 1, 'opening').setsUpSpread).toBeNull();
      expect(normalizeArcContext({ setsUpSpread: 14 }, 1, 'opening').setsUpSpread).toBeNull();
      expect(normalizeArcContext({ setsUpSpread: 'nine' }, 1, 'opening').setsUpSpread).toBeNull();
    });
  });

  describe('emotionalRegister', () => {
    test('honors valid register from EMOTIONAL_REGISTER_VALUES (case-insensitive)', () => {
      expect(normalizeArcContext({ emotionalRegister: 'warm' }, 7, 'rising').emotionalRegister).toBe('warm');
      expect(normalizeArcContext({ emotionalRegister: 'WONDER' }, 7, 'rising').emotionalRegister).toBe('wonder');
      expect(normalizeArcContext({ emotionalRegister: '  triumphant  ' }, 7, 'rising').emotionalRegister).toBe('triumphant');
    });

    test('falls back to SPREAD_TO_DEFAULT_REGISTER when invalid / missing', () => {
      expect(normalizeArcContext({}, 1, 'opening').emotionalRegister).toBe('warm');
      expect(normalizeArcContext({}, 8, 'peak').emotionalRegister).toBe('wonder');
      expect(normalizeArcContext({ emotionalRegister: 'gloomy' }, 10, 'return').emotionalRegister).toBe('triumphant');
    });

    test('every emitted register is in the canonical EMOTIONAL_REGISTER_VALUES set', () => {
      for (let i = 1; i <= 13; i += 1) {
        const out = normalizeArcContext({}, i, '');
        expect(EMOTIONAL_REGISTER_VALUES.has(out.emotionalRegister)).toBe(true);
      }
    });
  });

  describe('robustness', () => {
    test('null / undefined / array raw → all-fallback shape', () => {
      const out = normalizeArcContext(null, 5, 'deeper');
      expect(out).toEqual({
        actNumber: 2,
        beat: 'deeper',
        callbackToSpread: null,
        setsUpSpread: null,
        emotionalRegister: 'curious',
      });
      expect(normalizeArcContext(undefined, 5, 'deeper')).toEqual(out);
      expect(normalizeArcContext([], 5, 'deeper')).toEqual(out);
    });

    test('returns the strict 5-key shape regardless of extra junk on raw', () => {
      const out = normalizeArcContext(
        { actNumber: 1, beat: 'opening', extra: 'ignored', deeper: { nested: true } },
        1,
        'hook',
      );
      expect(Object.keys(out).sort()).toEqual([
        'actNumber', 'beat', 'callbackToSpread', 'emotionalRegister', 'setsUpSpread',
      ]);
    });

    test('does not throw on non-string purpose', () => {
      expect(() => normalizeArcContext({}, 7, undefined)).not.toThrow();
      expect(() => normalizeArcContext({}, 7, null)).not.toThrow();
    });
  });
});
