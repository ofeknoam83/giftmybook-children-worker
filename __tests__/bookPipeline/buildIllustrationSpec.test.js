const {
  composeScene,
  readsAlphabetTrailScene,
} = require('../../services/bookPipeline/illustrator/buildIllustrationSpec');

/** Generic fixtures — triggers are linguistic patterns, not one customer story. */
const baseDoc = () => ({
  request: { theme: 'mothers_day' },
  visualBible: {
    hero: {
      physicalDescription: 'toddler',
      outfitDescription: 'yellow tee, blue shorts',
    },
    supportingCast: [
      {
        role: 'Mother',
        name: 'Mom',
        onCover: false,
        partialPresenceIdeas: ['knit scarf'],
      },
    ],
  },
  storyBible: {},
});

const baseSpread = (overrides = {}) => ({
  spreadNumber: 3,
  spec: {
    focalAction: 'The child taps a carved letter on the garden path',
    location: 'sunlit garden steps',
    cameraIntent: 'wide establishing',
    continuityAnchors: [],
    ...overrides.spec,
  },
  manuscript: {
    text: 'Stone letters line the way. The child taps one today. A bright scarf lifts toward the stairs.',
    ...overrides.manuscript,
  },
  ...overrides,
});

describe('buildIllustrationSpec / composeScene', () => {
  test('readsAlphabetTrailScene matches common letter-path wording', () => {
    expect(readsAlphabetTrailScene({ focalAction: 'x', location: 'y' }, 'Stone letters line the way')).toBe(true);
    expect(readsAlphabetTrailScene({ focalAction: 'taps letter M' }, '')).toBe(true);
    expect(readsAlphabetTrailScene({ focalAction: 'plays', location: 'sandbox' }, 'fun day')).toBe(false);
  });

  test('composeScene injects alphabet-trail and wardrobe-vs-caption blocks when patterns match', () => {
    const scene = composeScene(baseDoc(), baseSpread());
    expect(scene).toMatch(/Alphabet-trail \/ letter-path composition/);
    expect(scene).toMatch(/Hero wardrobe vs caption/);
    expect(scene).toMatch(/partial presence/);
  });

  test('composeScene omits wardrobe block when caption has no prop or parent keywords', () => {
    const scene = composeScene(baseDoc(), baseSpread({
      manuscript: { text: 'They run through the meadow.' },
      spec: {
        focalAction: 'Child runs',
        location: 'meadow',
        cameraIntent: 'medium',
        continuityAnchors: [],
      },
    }));
    expect(scene).not.toMatch(/Hero wardrobe vs caption/);
  });
});
