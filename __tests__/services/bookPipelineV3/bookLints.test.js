'use strict';

/**
 * Book-level manuscript lints + prop plate selection + hero-box
 * normalization (2026-07-18 print-audit hardening). All pure functions —
 * no LLM or sharp dependencies.
 */

const {
  runBookLints,
  duplicateClimaxLint,
  unintroducedPropLint,
  wordOveruseLint,
  unintroducedRefrainObjectLint,
  monotonePageTurnLint,
  repetitiveOpenerLint,
  refrainNeverEvolvesLint,
} = require('../../../services/bookPipelineV3/gate/checks/bookLints');
const { selectPlateProps } = require('../../../services/bookPipelineV3/illustrator/artDirection/propPlate');
const { normalizeHeroBox, buildSpreadJudgePrompt } = require('../../../services/bookPipelineV3/illustrator/qa/spreadJudge');

const ms = (spreads, extra = {}) => ({
  title: 'T',
  refrain: 'This way? That way!',
  spreads: spreads.map((text, i) => ({ spread: i + 1, text })),
  ...extra,
});

describe('duplicateClimaxLint', () => {
  test('flags the audit case: the "My way." payoff landing twice', () => {
    const m = ms([
      'Amit lands on a crystal planet.',
      'He walks on.',
      'Nothing here.',
      'Still walking.',
      'More maze.',
      'Deep maze.',
      'The map goes dark.',
      'He lifts the lamp.',
      '"This way? My way," he says, and steps onto the bridge. My way.',
      'The bridge glows.',
      'Almost there.',
      'Amit laughs, warm and low. My way.',
      'The rocket lifts.',
    ]);
    const lints = duplicateClimaxLint(m);
    const dup = lints.find((l) => l.message.includes('my way'));
    expect(dup).toBeTruthy();
    expect(dup.spreads).toEqual([9, 12]);
    // The fix targets the EARLIER spread — the later occurrence is the payoff.
    expect(dup.targetSpreads).toEqual([9]);
  });

  test('the declared refrain is exempt no matter how often it repeats', () => {
    const m = ms([
      'He calls, "This way? That way!"',
      '"This way? That way!" again.',
      'Onward. "This way? That way!"',
    ]);
    expect(duplicateClimaxLint(m)).toEqual([]);
  });

  test('a sentence on 4+ spreads reads as an intentional refrain — not flagged', () => {
    const m = ms(['Boom goes the drum.', 'Boom goes the drum.', 'Boom goes the drum.', 'Boom goes the drum.']);
    expect(duplicateClimaxLint(m)).toEqual([]);
  });
});

describe('unintroducedPropLint', () => {
  test('flags the audit case: "his small lamp" first appearing on spread 8', () => {
    const m = ms([
      'Amit holds his glowing map.',
      'The map hums.',
      'He crosses the bridge.',
      'Three tunnels open.',
      'He picks one.',
      'Floating steps.',
      'The map goes dark and still.',
      'Near his chest, his small lamp glows with a golden dot.',
      'The lamp lights a crystal.',
      'The lamp glows on.',
    ]);
    const lints = unintroducedPropLint(m);
    const lamp = lints.find((l) => l.message.includes('"lamp"'));
    expect(lamp).toBeTruthy();
    expect(lamp.targetSpreads).toEqual([1]); // fix = introduce it early
  });

  test('a prop introduced in the opening spreads is fine', () => {
    const m = ms([
      'Amit clips his lamp to his belt.',
      'He walks.',
      'Dark now.',
      'He lifts his lamp high.',
    ]);
    expect(unintroducedPropLint(m)).toEqual([]);
  });

  test('body parts and one-off possessives never flag', () => {
    const m = ms([
      'He grins.',
      'Wind in his hair.',
      'He shields his eyes.',
      'On his shoulders the pack sits heavy.',
      'His compass gleams once.', // single mention — not recurring
    ]);
    expect(unintroducedPropLint(m)).toEqual([]);
  });
});

describe('wordOveruseLint', () => {
  test('flags a signature noun used more often than the spread count', () => {
    const line = 'The crystal path met a crystal arch by the crystal crater.';
    const m = ms(Array.from({ length: 6 }, () => line));
    const lints = wordOveruseLint(m);
    expect(lints.some((l) => l.message.includes('"crystal"'))).toBe(true);
    // Advisory only — no revision targets.
    expect(lints.every((l) => l.targetSpreads.length === 0)).toBe(true);
  });

  test('normal prose stays silent', () => {
    const m = ms(['A quiet page.', 'Another calm page.', 'The end nears.']);
    expect(wordOveruseLint(m)).toEqual([]);
  });
});

// 2026-07-28 lints (book 16758e3c, "Liv's Great Underwater Discovery"):
// the refrain chased "the sound" that no line ever introduced, a question
// ended 11 of 13 spreads, and "Swish, swish—Liv" opened 10 of 13.
describe('unintroducedRefrainObjectLint', () => {
  test('flags the Liv case: the refrain asks about "the sound" nobody planted', () => {
    const m = {
      title: 'T',
      refrain: { text: 'Could this be the sound?', evolution: [] },
      spreads: [
        { spread: 1, text: 'Liv swims with Bun. A gold chest gleams far ahead.' },
        { spread: 2, text: 'Liv kicks past berries. Could this be the sound?', refrain_here: true },
        { spread: 3, text: 'Liv glides through reeds. Could this be the sound?', refrain_here: true },
      ],
    };
    const lints = unintroducedRefrainObjectLint(m);
    expect(lints).toHaveLength(1);
    expect(lints[0].code).toBe('unintroduced_refrain_object');
    expect(lints[0].message).toContain('"the sound"');
    expect(lints[0].targetSpreads).toEqual([1]); // plant it in the opening spread
  });

  test('a planted quest object never flags', () => {
    const m = {
      title: 'T',
      refrain: { text: 'Could this be the sound?', evolution: [] },
      spreads: [
        { spread: 1, text: 'A far-off sound hums under the waves. Liv listens.' },
        { spread: 2, text: 'Liv kicks past berries. Could this be the sound?', refrain_here: true },
        { spread: 3, text: 'Reeds sway. Could this be the sound?', refrain_here: true },
      ],
    };
    expect(unintroducedRefrainObjectLint(m)).toEqual([]);
  });

  test('a refrain with no definite object (or no refrain) stays silent', () => {
    expect(unintroducedRefrainObjectLint({ refrain: { text: 'This way? That way!' }, spreads: [{ spread: 1, text: 'Go. This way? That way!' , refrain_here: true }] })).toEqual([]);
    expect(unintroducedRefrainObjectLint({ refrain: null, spreads: [] })).toEqual([]);
  });
});

describe('monotonePageTurnLint', () => {
  const q = (n, opener = 'Liv swims on.') => ({ spread: n, text: `${opener}\nIs THAT the sound?` });

  test('flags a book where (nearly) every spread ends on a question', () => {
    const m = { spreads: [q(1), q(2), q(3), q(4), q(5), q(6), q(7), { spread: 8, text: 'Liv rests.\nThe reef glows.' }] };
    const lints = monotonePageTurnLint(m);
    expect(lints).toHaveLength(1);
    expect(lints[0].code).toBe('monotone_page_turn');
    // Middle offenders targeted so the revision has spreads to vary.
    expect(lints[0].targetSpreads.length).toBeGreaterThan(0);
    expect(lints[0].targetSpreads.every((s) => s > 1 && s < 8)).toBe(true);
  });

  test('a book with varied hooks stays silent', () => {
    const m = {
      spreads: [q(1), { spread: 2, text: 'Then — plink!' }, q(3), { spread: 4, text: 'The lid creaks…' },
        q(5), { spread: 6, text: 'Bun leans in.' }, q(7), { spread: 8, text: 'All wiggle.' }],
    };
    expect(monotonePageTurnLint(m)).toEqual([]);
  });

  test('short books are exempt', () => {
    expect(monotonePageTurnLint({ spreads: [q(1), q(2), q(3)] })).toEqual([]);
  });
});

describe('repetitiveOpenerLint', () => {
  test('flags the Liv case: "Swish, swish—" opening 10 of 13 spreads', () => {
    const spreads = Array.from({ length: 13 }, (_, i) => ({
      spread: i + 1,
      text: i === 0 || i === 6 || i === 12
        ? 'The reef hums bright.\nFish zip by.'
        : 'Swish, swish—Liv swims on.\nBright fish zip by.',
    }));
    const lints = repetitiveOpenerLint({ spreads });
    expect(lints).toHaveLength(1);
    expect(lints[0].code).toBe('repetitive_opener');
    expect(lints[0].message).toContain('swish swish');
    expect(lints[0].spreads).toHaveLength(10);
    // Bookend uses stay; middle occurrences are targeted.
    expect(lints[0].targetSpreads.length).toBeGreaterThan(0);
    expect(lints[0].targetSpreads).not.toContain(2);
  });

  test('an opener on half the spreads or fewer is a ritual, not a rut', () => {
    const spreads = Array.from({ length: 13 }, (_, i) => ({
      spread: i + 1,
      text: i % 2 === 0 ? 'Swish, swish—Liv swims on.' : 'The reef hums.',
    }));
    expect(repetitiveOpenerLint({ spreads })).toEqual([]);
  });
});

describe('refrainNeverEvolvesLint', () => {
  const base = { text: 'Could this be the sound?', evolution: [{ phase: 'climax', variant: 'THAT is the sound!' }] };

  test('flags a declared evolution that never prints', () => {
    const m = {
      refrain: base,
      spreads: [
        { spread: 1, text: 'Liv listens. Could this be the sound?' },
        { spread: 2, text: 'Reeds sway. Could this be the sound?' },
        { spread: 3, text: 'Bun bobs. Could this be the sound?' },
        { spread: 4, text: 'Liv laughs and laughs.' },
      ],
    };
    const lints = refrainNeverEvolvesLint(m);
    expect(lints).toHaveLength(1);
    expect(lints[0].code).toBe('refrain_never_evolves');
    expect(lints[0].targetSpreads).toEqual([3]); // the last (climax-adjacent) use
  });

  test('a printed variant satisfies the declaration', () => {
    const m = {
      refrain: base,
      spreads: [
        { spread: 1, text: 'Could this be the sound?' },
        { spread: 2, text: 'Could this be the sound?' },
        { spread: 3, text: 'Could this be the sound?' },
        { spread: 4, text: 'Liv giggles. THAT is the sound!' },
      ],
    };
    expect(refrainNeverEvolvesLint(m)).toEqual([]);
  });

  test('string-form refrains and refrains without variants stay silent', () => {
    expect(refrainNeverEvolvesLint({ refrain: 'plain string', spreads: [] })).toEqual([]);
    expect(refrainNeverEvolvesLint({ refrain: { text: 'Hey!', evolution: [] }, spreads: [] })).toEqual([]);
  });
});

describe('refrain shape handling (object vs legacy string)', () => {
  test('the {text, evolution} refrain emitted by normalizeManuscript is exempt from duplicate_climax', () => {
    const m = {
      refrain: { text: 'This way? That way!', evolution: [] },
      spreads: [
        { spread: 1, text: 'He calls, "This way? That way!"' },
        { spread: 2, text: '"This way? That way!" again.' },
        { spread: 3, text: 'Onward. "This way? That way!"' },
      ],
    };
    expect(duplicateClimaxLint(m)).toEqual([]);
  });
});

describe('wordLengthLint', () => {
  const { wordLengthLint } = require('../../../services/bookPipelineV3/gate/checks/bookLints');
  const infantProfile = { vocabularyConstraints: { maxWordLengthChars: 7 } };

  test('flags over-budget words with targets; name and proper nouns exempt', () => {
    const m = {
      spreads: [
        { spread: 1, text: 'Scarlett sees a wonderful underwater rainbow.' },
        { spread: 2, text: 'Mama hums soft.' },
      ],
    };
    const lints = wordLengthLint(m, { ageProfile: infantProfile, protagonistName: 'Scarlett' });
    expect(lints).toHaveLength(1);
    expect(lints[0].code).toBe('word_length');
    expect(lints[0].message).toContain('"underwater"');
    expect(lints[0].message).toContain('"wonderful"');
    expect(lints[0].message).not.toContain('Scarlett');
    expect(lints[0].targetSpreads).toEqual([1]);
  });

  test('silent when the band has no limit or all words fit', () => {
    expect(wordLengthLint({ spreads: [{ spread: 1, text: 'a very extraordinarily long word' }] }, {})).toEqual([]);
    expect(wordLengthLint({ spreads: [{ spread: 1, text: 'short words only here' }] }, { ageProfile: infantProfile })).toEqual([]);
  });
});

describe('runBookLints', () => {
  test('never throws on malformed manuscripts', () => {
    expect(runBookLints({})).toEqual([]);
    expect(runBookLints({ spreads: [{ spread: 1 }] })).toEqual([]);
  });
});

describe('selectPlateProps (prop plate slots)', () => {
  test('recurring props with locked designs win the slots, capped at 4', () => {
    const props = selectPlateProps({
      props: [
        { name: 'lamp', spreads: [8, 9, 11, 12, 13], design: 'a small brass camping lantern' },
        { name: 'one-off wand', spreads: [3] },
        { name: 'map', spreads: [1, 2, 4, 5, 6, 7], design: 'a glowing blue star-map' },
        { name: 'rocket', spreads: [1, 10, 12] },
        { name: 'boots', spreads: [1, 2] },
        { name: 'chime', spreads: [3, 4] },
      ],
    });
    expect(props).toHaveLength(4);
    expect(props[0].name).toBe('map'); // designed + most recurring first
    expect(props.map((p) => p.name)).not.toContain('one-off wand');
  });

  test('no recurring props → empty (no plate rendered)', () => {
    expect(selectPlateProps(null)).toEqual([]);
    expect(selectPlateProps({ props: [{ name: 'wand', spreads: [2] }] })).toEqual([]);
  });
});

describe('normalizeHeroBox (judge hero_box validation)', () => {
  test('valid box passes through', () => {
    expect(normalizeHeroBox({ x: 0.4, y: 0.1, w: 0.2, h: 0.8 })).toEqual({ x: 0.4, y: 0.1, w: 0.2, h: 0.8 });
  });

  test('out-of-range boxes clamp to the unit square', () => {
    const b = normalizeHeroBox({ x: -0.1, y: 0.5, w: 0.4, h: 0.9 });
    expect(b.x).toBe(0);
    expect(b.y + b.h).toBeLessThanOrEqual(1);
  });

  test('malformed boxes degrade to null', () => {
    expect(normalizeHeroBox(null)).toBeNull();
    expect(normalizeHeroBox({ x: 0.2, y: 0.2 })).toBeNull();
    expect(normalizeHeroBox({ x: 'a', y: 0, w: 0.5, h: 0.5 })).toBeNull();
    expect(normalizeHeroBox({ x: 1.2, y: 0, w: 0.5, h: 0.5 })).toBeNull(); // fully off-canvas
  });
});

describe('spread judge prompt — 2026-07-18 print-audit classes', () => {
  test('caption text enables the counted-object class', () => {
    const p = buildSpreadJudgePrompt({
      sceneContract: { setting: 'maze' },
      direction: null,
      captionText: 'At the end, three tunnels open like giant moonlit mouths.',
    });
    expect(p).toContain('three tunnels open');
    expect(p).toContain('counted-object mismatch');
    expect(p).toContain('hero_box');
  });

  test('wide spreads add the fold classes; square spreads do not', () => {
    const wide = buildSpreadJudgePrompt({ sceneContract: {}, direction: null, wideSpread: true });
    expect(wide).toContain('wide spreads only');
    expect(wide).toContain('fold');
    const square = buildSpreadJudgePrompt({ sceneContract: {}, direction: null, wideSpread: false });
    expect(square).not.toContain('wide spreads only');
  });

  // sb-1 (2026-07-20): the signature style is premium 3D CGI — 2D/painterly
  // drift is the break, and cinematic bokeh is part of the style.
  // P3 (2026-07-23 audit): the class now names flat-vector/hard-cel and
  // photoreal-live-action drift explicitly ("Amit's Star Map" intra-interior
  // drift), while keeping stylized-3D bokeh legal.
  test('style-break class is 3D-relative: 2D drift breaks, bokeh never does', () => {
    const p = buildSpreadJudgePrompt({ sceneContract: {}, direction: null });
    expect(p).toContain('premium STYLIZED 3D CGI animated-film render');
    expect(p).toContain('flat 2D/painterly/watercolor/line-art/cel-shaded drift is the break');
    expect(p).toContain('flat VECTOR look with hard cel outlines or uniform flat color fills');
    expect(p).toContain('photorealistic real-skin/real-camera CGI render');
    expect(p).toContain('cinematic depth-of-field/bokeh WITHIN the stylized 3D render is part of the style, never a defect');
  });
});
