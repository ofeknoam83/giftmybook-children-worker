const {
  ageRules,
  renderTextPolicyBlock,
} = require('../../../services/bookPipeline/writer/textPolicies');
const { AGE_BANDS, FORMATS } = require('../../../services/bookPipeline/constants');

describe('textPolicies ageRules', () => {
  test('returns infant-specific guidance for PB_INFANT', () => {
    const r = ageRules(AGE_BANDS.PB_INFANT);
    expect(r).toBeDefined();
    // Hard guarantees the lap-baby band relies on:
    // - sensory observation only, no plot, no dialogue
    // - the book is read TO the baby BY the parent
    // - tiny vocabulary
    expect(r.voice).toMatch(/baby/i);
    expect(r.voice).toMatch(/sensory|observation/i);
    expect(r.voice).toMatch(/no\s+(conflict|plot|dialogue)/i);
    expect(r.vocabulary).toMatch(/Mama|Dada/);
  });

  test('PR I: infant voice embeds the still-point principle', () => {
    // The single most important fix to keep the writer from reaching for
    // action verbs the baby cannot perform: name the principle explicitly
    // in BOTH surfaces of the prompt (ageRules.voice AND the structure block).
    const r = ageRules(AGE_BANDS.PB_INFANT);
    expect(r.voice).toMatch(/still\s*point/i);
    expect(r.voice).toMatch(/held|carried|seated/i);
    // The voice line must explicitly call out at least the worst-offender verbs
    // we have actually seen the model produce in production drafts.
    for (const verb of ['dance', 'twirl', 'march', 'climb', 'jump', 'hop', 'skip']) {
      expect(r.voice.toLowerCase()).toContain(verb);
    }
  });

  test('toddler band still returns toddler-shaped guidance (no regression)', () => {
    const r = ageRules(AGE_BANDS.PB_TODDLER);
    expect(r).toBeDefined();
    expect(r.voice).toBeTruthy();
  });

  test('preschool and early-reader bands unchanged', () => {
    expect(ageRules(AGE_BANDS.PB_PRESCHOOL)).toBeDefined();
    expect(ageRules(AGE_BANDS.ER_EARLY)).toBeDefined();
  });
});

describe('textPolicies renderTextPolicyBlock — infant structure', () => {
  function buildDoc(ageBand) {
    return {
      request: { ageBand, format: FORMATS.PICTURE_BOOK, theme: 'mothers_day' },
      brief: { child: { name: 'Scarlett', age: 0.58 }, customDetails: {} },
    };
  }

  test('infant block prescribes EXACTLY 2 lines per spread (AA couplet)', () => {
    const block = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_INFANT));
    expect(block).toMatch(/EXACTLY 2 lines/);
    expect(block).toMatch(/AA/);
    // Must NOT silently inherit the 4-line picture-book rule.
    expect(block).not.toMatch(/EXACTLY 4 lines/);
    expect(block).not.toMatch(/AABB/);
  });

  test('infant block forbids locomotion verbs in the writer prompt', () => {
    const block = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_INFANT));
    // Whitelist appears
    expect(block).toMatch(/sees|smiles|reaches|snuggles/);
    // Forbidden verbs are explicitly named
    expect(block).toMatch(/walks|runs|climbs/);
  });

  describe('PR I: still-point reframing in the infant block', () => {
    test('block opens with a CORE PRINCIPLE section that names the still-point rule', () => {
      const block = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_INFANT));
      expect(block).toMatch(/CORE PRINCIPLE/);
      expect(block).toMatch(/STILL POINT/);
      expect(block).toMatch(/held,?\s*carried,?\s*or\s*seated/i);
      // The principle must appear BEFORE the structure block so the writer
      // reads it first.
      const corePos = block.indexOf('CORE PRINCIPLE');
      const structPos = block.indexOf('STRUCTURE');
      expect(corePos).toBeGreaterThanOrEqual(0);
      expect(structPos).toBeGreaterThan(corePos);
    });

    test('block lists explicit reframe patterns for every worst-offender verb family', () => {
      const block = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_INFANT));
      expect(block).toMatch(/REFRAME PATTERNS/);
      // Every verb family that has caused production failures must have a
      // reframe rule the writer can copy from.
      const families = ['dance', 'twirl', 'spin', 'run', 'march', 'walk', 'climb', 'jump', 'hop', 'bounce', 'skip'];
      for (const verb of families) {
        // The reframe lines all use the form: Instead of "baby <verb>..."
        const re = new RegExp(`Instead of[^\\n]*${verb}`, 'i');
        expect(block).toMatch(re);
      }
    });

    test('block includes a BAD vs GOOD example showing the actual rewrite move', () => {
      const block = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_INFANT));
      expect(block).toMatch(/BAD vs GOOD/);
      // The BAD line names a real action-on-baby; the GOOD line moves the
      // motion to the WORLD, not the baby.
      expect(block).toMatch(/BAD\s*:\s*"[^"]*\b(skip|dance|spin|twirl|climb|run|march|hop|jump)/i);
      expect(block).toMatch(/GOOD\s*:\s*"/);
      // Must contain at least 3 BAD/GOOD pairs to cover multiple verb families.
      const badCount = (block.match(/BAD\s*:/g) || []).length;
      const goodCount = (block.match(/GOOD\s*:/g) || []).length;
      expect(badCount).toBeGreaterThanOrEqual(3);
      expect(goodCount).toBeGreaterThanOrEqual(3);
    });

    test('block warns against re-using the same descriptor across many spreads', () => {
      // The previous draft leaned on "bright" in 8/13 spreads. Anti-crutch
      // guidance must be explicit so the writer doesn\'t fall into it again.
      const block = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_INFANT));
      expect(block).toMatch(/descriptor|adjective/i);
      expect(block).toMatch(/bright/);
    });
  });

  test('toddler band keeps the 4-line AABB rule (no regression from infant change)', () => {
    const block = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_TODDLER));
    expect(block).toMatch(/EXACTLY 4 lines/);
    expect(block).toMatch(/AABB/);
  });

  test('preschool band keeps the 4-line AABB rule', () => {
    const block = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_PRESCHOOL));
    expect(block).toMatch(/EXACTLY 4 lines/);
    expect(block).toMatch(/AABB/);
  });

  test('PR I regression: toddler/preschool blocks do NOT inherit the still-point rule', () => {
    // The still-point rule is infant-only — a toddler can absolutely run,
    // dance, and climb. Make sure we didn\'t accidentally bleed the rule
    // into other bands.
    const toddlerBlock = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_TODDLER));
    const preschoolBlock = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_PRESCHOOL));
    expect(toddlerBlock).not.toMatch(/STILL POINT/);
    expect(toddlerBlock).not.toMatch(/CORE PRINCIPLE/);
    expect(preschoolBlock).not.toMatch(/STILL POINT/);
    expect(preschoolBlock).not.toMatch(/CORE PRINCIPLE/);
  });
});
