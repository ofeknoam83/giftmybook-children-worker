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
  test('style-break class is 3D-relative: 2D drift breaks, bokeh never does', () => {
    const p = buildSpreadJudgePrompt({ sceneContract: {}, direction: null });
    expect(p).toContain('premium 3D CGI animated-film render');
    expect(p).toContain('flat 2D/painterly/watercolor/line-art/cel-shaded drift is the break');
    expect(p).toContain('depth-of-field/bokeh within the 3D render is part of the style, never a defect');
  });
});
