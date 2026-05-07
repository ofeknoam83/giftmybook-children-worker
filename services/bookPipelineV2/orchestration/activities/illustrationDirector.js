/**
 * Stage 13 — Illustration Director (v2-→-v1 adapter for tonight)
 *
 * For Phase 0+1 we reuse v1's mature illustrator (renderAllSpreadsQuad)
 * which has shipped through AA-CW-1 → AA-CW-28 of art-direction
 * fixes. The v2 illustration director's job tonight is purely
 * adaptive: take the v2 artifacts (CharacterBible, WorldBible,
 * BeatSheet, accepted SpreadDrafts, raw cover) and synthesize a
 * v1-shaped book document the existing renderer can consume.
 *
 * Phase 3 replaces this with a native v2 illustrator that calls the
 * image model directly using the WorldBible as the spec. We keep the
 * same I/O contract here so that swap is a one-file change.
 *
 * IMPORTANT: This file is the contract boundary between v2 planning
 * and v1 rendering. If a field is missing from a v2 artifact, this
 * file is where we choose a sensible default — we never reach back
 * into the v2 activities to "patch" them. Single seam, easy to
 * rip out.
 */

const { renderAllSpreadsQuad } = require('../../../bookPipeline/illustrator/renderAllSpreadsQuad');
const { createBookDocument } = require('../../../bookPipeline/schema/bookDocument');

/**
 * Build a v1-shape `visualBible` from the v2 CharacterBible + WorldBible.
 * v1's illustrator reads these specific fields; we synthesize each one
 * from the most informative v2 source.
 */
function buildLegacyVisualBible({ characterBible, worldBible, coverTitle }) {
  const protagonist = (characterBible?.characters || [])[0] || {};

  // Hero locks — sourced from CharacterBible (which itself was anchored
  // to the cover image during Stage 5).
  const hero = {
    name: protagonist.name || 'the child',
    physicalDescription: [
      protagonist.ethnicity_descriptor && `${protagonist.ethnicity_descriptor}`,
      protagonist.skin_tone_family && `skin tone ${protagonist.skin_tone_family}`,
      protagonist.hair && `hair ${protagonist.hair.color_family || ''} ${protagonist.hair.length || ''} ${protagonist.hair.texture || ''}${protagonist.hair.signature_styling ? ' (' + protagonist.hair.signature_styling + ')' : ''}`.trim(),
      protagonist.eyes && `${protagonist.eyes.color || ''} ${protagonist.eyes.shape || ''} eyes`.trim(),
      protagonist.body && (protagonist.body.developmental_stage || protagonist.body.head_to_body_ratio ? `body: ${protagonist.body.developmental_stage || ''} ${protagonist.body.head_to_body_ratio ? '(' + protagonist.body.head_to_body_ratio + ' head-to-body)' : ''}`.trim() : ''),
    ].filter(Boolean).join('; '),
    outfitDescription: protagonist.signature_outfit
      ? [
        protagonist.signature_outfit.top && `top: ${protagonist.signature_outfit.top}`,
        protagonist.signature_outfit.bottom && `bottom: ${protagonist.signature_outfit.bottom}`,
        Array.isArray(protagonist.signature_outfit.accessories) && protagonist.signature_outfit.accessories.length
          ? `accessories: ${protagonist.signature_outfit.accessories.join(', ')}`
          : '',
      ].filter(Boolean).join('; ')
      : '',
  };

  const outfitLocks = {
    ruleSummary: hero.outfitDescription || `Locked outfit for hero on cover of "${coverTitle || ''}".`,
  };

  // Supporting cast — fold v2 WorldBible.supporting_cast into v1's
  // partialPresenceLock shape.
  const supportingCast = (worldBible?.supporting_cast || []).map((c) => ({
    name: c.role || c.id || 'supporting',
    role: c.role || c.id || 'supporting',
    onCover: Boolean(c.on_cover),
    description: c.role || '',
    isThemedParent: /mama|mother|mom|dada|dad|father/i.test(c.role || ''),
    partialPresenceLock: c.partial_presence_lock ? {
      skinTone: c.partial_presence_lock.skin_tone || '',
      hand: c.partial_presence_lock.hand_or_arm || '',
      sleeve: c.partial_presence_lock.sleeve_or_outfit_fragment || '',
      signatureProp: c.partial_presence_lock.signature_item || '',
    } : null,
  }));

  // Recurring props — direct shape map.
  const recurringProps = (worldBible?.recurring_props || []).map((p) => ({
    name: p.name || p.id || 'prop',
    description: p.locked_description || '',
    appearsInSpreads: Array.isArray(p.appears_in_spreads) ? p.appears_in_spreads : [],
  }));

  // Style + composition + palette + environments → flatten into v1's
  // freeform descriptors. The renderer reads them as text into the
  // image prompt.
  const styleRules = Array.isArray(worldBible?.style_rules) ? worldBible.style_rules.join(' ') : '';
  const palette = worldBible?.palette
    ? `Primaries: ${(worldBible.palette.primaries || []).join(', ')}. Accents: ${(worldBible.palette.accents || []).join(', ')}. Lighting: ${worldBible.palette.lighting || ''}.`
    : '';
  // v1's buildIllustrationSpec expects `environmentAnchors` to be an
  // array of strings (it does `.slice(0, 3).join('; ')`). Flatten each
  // env object into one descriptor string but keep the array shape.
  const rawEnvs = Array.isArray(worldBible?.environment_anchors)
    ? worldBible.environment_anchors
    : Array.isArray(worldBible?.environments)
    ? worldBible.environments
    : [];
  const environmentAnchors = rawEnvs
    .map((e) => {
      if (typeof e === 'string') return e;
      if (!e || typeof e !== 'object') return '';
      const label = e.label || e.name || '';
      const surfaces = Array.isArray(e.defining_surfaces) ? e.defining_surfaces.join(', ') : '';
      const props = Array.isArray(e.defining_props) ? e.defining_props.join(', ') : '';
      const parts = [label, surfaces && `surfaces: ${surfaces}`, props && `props: ${props}`].filter(Boolean);
      return parts.join(' | ');
    })
    .filter(Boolean);

  return {
    hero,
    outfitLocks,
    supportingCastPolicy: {
      onCoverFullFigure: 'allowed',
      offCoverFullFigure: 'forbidden',
      partialPresenceRequired: true,
    },
    supportingCast,
    recurringProps,
    style: styleRules,
    palette,
    environmentAnchors,
    compositionRules: 'one focal action per spread; varied camera angles; text never crosses center; warm cinematic lighting.',
    textRendering: { policy: 'painted-into-illustration' },
    prohibitedVisualDrift: Array.isArray(worldBible?.prohibited_visual_drift)
      ? worldBible.prohibited_visual_drift
      : [],
  };
}

/**
 * Build v1-shape spread specs from v2 BeatSheet + accepted drafts.
 * v1's `buildIllustrationSpec` reads: focalAction, location, cameraIntent,
 * emotionalBeat, humorBeat, forbiddenMistakes, continuityAnchors,
 * sceneBridge, mustUseDetails, parentVisibility, proseProps, textSide,
 * arcContext, plotBeat, purpose, textLineTarget.
 */
function deriveParentVisibility(implied, ageBand) {
  if (!implied) return ageBand === 'PB_INFANT' || ageBand === 'PB_TODDLER' ? 'cropped-torso' : 'absent';
  const s = String(implied).toLowerCase();
  if (s.includes('full')) return 'full';
  if (s.includes('arm') || s.includes('hand')) return 'hand';
  if (s.includes('shoulder') || s.includes('back')) return 'shoulder-back';
  if (s.includes('torso') || s.includes('crop')) return 'cropped-torso';
  if (s.includes('shadow')) return 'shadow';
  if (s.includes('voice') || s.includes('off')) return 'absent';
  return 'cropped-torso';
}

function buildLegacySpreadSpecs({ beatSheet, ageProfile }) {
  const ageBand = ageProfile?.ageBand || ageProfile?.band || 'PB_PRESCHOOL';
  return (beatSheet?.spreads || []).map((b, idx) => ({
    spreadNumber: b.spread || idx + 1,
    purpose: b.purpose || '',
    plotBeat: b.purpose || '',
    emotionalBeat: b.target_emotion || '',
    humorBeat: null,
    location: b.location_hint || '',
    focalAction: b.purpose || '',
    cameraIntent: 'medium close-up, warm cinematic lighting',
    textSide: idx % 2 === 0 ? 'right' : 'left',
    textLineTarget: ageProfile?.narrativeConstraints?.linesPerSpread?.target || 4,
    mustUseDetails: [
      ...(b.callbacks_introduced || []).map((c) => `introduce callback: ${c}`),
      ...(b.callbacks_used || []).map((c) => `use callback: ${c}`),
    ],
    sceneBridge: b.page_turn_hook || '',
    continuityAnchors: [],
    proseProps: [],
    qaTargets: Array.isArray(b.success_criteria) ? b.success_criteria : [],
    forbiddenMistakes: Array.isArray(b.prohibited) ? b.prohibited : [],
    parentVisibility: deriveParentVisibility(b.implied_caregiver, ageBand),
    arcContext: {
      phase: b.phase || 'middle',
      whatJustHappened: '',
      whatComesNext: '',
    },
  }));
}

/**
 * Build v1 storyBible-ish from v2 artifacts. v1 uses storyBible mostly
 * for back-cover blurb (computeSynopsis) and visual journey spine in
 * the planner. We populate the fields downstream code reads.
 */
function buildLegacyStoryBible({ intent, storyBible, beatSheet }) {
  return {
    title: intent?.logline || '',
    logline: intent?.logline || '',
    narrativeSpine: (beatSheet?.spreads || []).map((b) => ({
      spread: b.spread,
      beat: b.purpose,
      emotion: b.target_emotion,
    })),
    visualJourneySpine: (beatSheet?.spreads || [])
      .map((b) => b.location_hint)
      .filter(Boolean),
    recurringVisualMotifs: (intent?.callback_motifs || []).map((m) => m.id || m.label),
    themeDeliveredVia: intent?.theme_delivered_via || [],
    threeActShape: storyBible?.three_act_shape || null,
    midpoint: storyBible?.midpoint || null,
    climaxPayoffImage: storyBible?.climax_payoff_image || null,
    endingImage: storyBible?.ending_image || null,
  };
}

/**
 * Compose the v1-shape document and call the existing illustrator. The
 * illustrator returns the doc with `spread.illustration` populated and
 * uploads the JPEGs to GCS.
 */
async function illustrationDirectorActivity(input, ctx) {
  const {
    rawRequest, brief, ageProfile, intent, storyBible, characterBible,
    worldBible, beatSheet, drafts, coverImageUrl, coverTitle,
    operationalContext,
  } = input;

  // Map drafts by spread number for stable lookup.
  const draftBySpread = new Map(drafts.map((d) => [d.spread, d]));

  const visualBible = buildLegacyVisualBible({ characterBible, worldBible, coverTitle });
  const spreadSpecs = buildLegacySpreadSpecs({ beatSheet, ageProfile });
  const legacyStoryBible = buildLegacyStoryBible({ intent, storyBible, beatSheet });

  // Build a v1 doc shell. createBookDocument seeds the standard fields;
  // we then overwrite the planning artifacts and seed the per-spread
  // entries with their text + spec so the renderer + checker can run.
  let doc = createBookDocument({
    request: { ...rawRequest, bookId: ctx.bookId, ageBand: ageProfile?.band },
    brief: brief?.questionnaire || rawRequest || {},
    cover: {
      title: coverTitle || rawRequest?.cover?.title || 'My Story',
      imageUrl: coverImageUrl || rawRequest?.cover?.imageUrl || null,
      characterLocks: {},
      outfitLocks: {},
    },
  });
  doc.storyBible = legacyStoryBible;
  doc.visualBible = visualBible;
  doc.spreadSpecs = spreadSpecs;
  doc.spreads = spreadSpecs.map((spec) => {
    const draft = draftBySpread.get(spec.spreadNumber);
    const text = draft?.text || (Array.isArray(draft?.lines) ? draft.lines.join('\n') : '');
    return {
      spreadNumber: spec.spreadNumber,
      spec,
      manuscript: { text, lines: draft?.lines || [] },
      illustration: null,
    };
  });
  doc.operationalContext = operationalContext || {};

  ctx.log('info', `[v2] illustrationDirector handing off ${doc.spreads.length} spreads to v1 illustrator (renderAllSpreadsQuad)`);

  const rendered = await renderAllSpreadsQuad(doc);
  ctx.log('info', `[v2] illustrationDirector: render complete, ${rendered.spreads.length} spreads`);
  return rendered;
}

module.exports = {
  illustrationDirectorActivity,
  // exported for tests
  buildLegacyVisualBible,
  buildLegacySpreadSpecs,
  buildLegacyStoryBible,
  deriveParentVisibility,
};
