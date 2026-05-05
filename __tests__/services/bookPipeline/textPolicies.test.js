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

  describe('PR M: identity-rhyme ban in the infant block', () => {
    test('block contains an explicit IDENTITY-RHYME BAN section', () => {
      // Draft 8 shipped with sky/sky, beams/beams, gleams/gleams, gold/gold —
      // 6 of 13 spreads used the same word at both end-positions. Naming the
      // failure mode in the prompt is the cheapest fix; the writer needs to
      // see the literal phrase "identity rhyme" so it knows what to avoid.
      const block = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_INFANT));
      expect(block).toMatch(/IDENTITY-?RHYME/i);
    });

    test('block explains that same-word endings are NOT a rhyme', () => {
      const block = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_INFANT));
      // The principle has to be stated in plain language, not just by example.
      expect(block.toLowerCase()).toMatch(/(same word|different end-words|repeating the same word)/);
    });

    test('block flags partial-match identity rhymes (sky/skies, beam/beams)', () => {
      // The model often games the rule by inflecting the second word: beam/beams
      // is still an identity rhyme to a child's ear. The prompt must call this out.
      const block = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_INFANT));
      expect(block.toLowerCase()).toMatch(/sky\/skies|gold\/golden|beam\/beams|sky\s*\/\s*skies/);
    });

    test('block includes BAD/GOOD pairs drawn from the actual draft 8 failures', () => {
      const block = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_INFANT));
      // At least the worst offenders from draft 8 must appear as BAD examples
      // so the writer recognizes the exact pattern it produced.
      const lower = block.toLowerCase();
      expect(lower).toMatch(/beams\/beams|sky\/sky|gleams\/gleams|gold\/gold/);
    });
  });

  describe('PR M: vocabulary diversity guidance in the infant block', () => {
    test('block contains a VOCABULARY DIVERSITY section', () => {
      const block = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_INFANT));
      expect(block).toMatch(/VOCABULARY\s+DIVERSITY/i);
    });

    test('block names the actual repeated words from draft 8 (sun, peekaboo, toes)', () => {
      // The prompt has to be specific. Generic "don't repeat words" guidance
      // is what the writer already ignored. Concrete words from real failures
      // give the model something to pattern-match against.
      const block = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_INFANT));
      const lower = block.toLowerCase();
      expect(lower).toContain('sun');
      expect(lower).toContain('peekaboo');
      expect(lower).toContain('toes');
    });

    test('block sets a clear ceiling on per-word repetition (no more than 2 spreads)', () => {
      const block = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_INFANT));
      // The previous prompt had no ceiling at all; the model defaulted to its
      // training prior of repeating cozy words. Set an explicit ceiling.
      expect(block).toMatch(/(more than 2 spreads|in 2 spreads|2\s*spreads)/i);
    });
  });

  test('PR M regression: identity-rhyme ban does NOT bleed into toddler/preschool', () => {
    // Toddler picture books often DO use intentional identity callbacks
    // ("more, more, more") — the strict identity-rhyme ban is an infant-only
    // rule because infant books are 2-line couplets where any same-word
    // ending is a missed rhyme, not a stylistic choice.
    const toddlerBlock = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_TODDLER));
    const preschoolBlock = renderTextPolicyBlock(buildDoc(AGE_BANDS.PB_PRESCHOOL));
    expect(toddlerBlock).not.toMatch(/IDENTITY-?RHYME/i);
    expect(preschoolBlock).not.toMatch(/IDENTITY-?RHYME/i);
    expect(toddlerBlock).not.toMatch(/VOCABULARY\s+DIVERSITY/i);
    expect(preschoolBlock).not.toMatch(/VOCABULARY\s+DIVERSITY/i);
  });
});
