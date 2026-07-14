/**
 * Illustration Director — V3→v1 adapter (milestone 1).
 *
 * Milestone 1 reuses v1's production illustrator (renderAllSpreadsQuad),
 * exactly as v2 does: this activity synthesizes a v1-shaped book document
 * from V3 artifacts (creative brief, winning concept, manuscript with
 * per-spread scene_contracts) and hands it to the renderer.
 *
 * This file is the contract boundary between V3 writing and v1 rendering —
 * the same "single seam, easy to rip out" rule as v2's adapter. Milestone 2
 * (identity kit + per-spread photo-referenced rendering, design doc §5)
 * replaces this file; the raw scene contracts it consumes are preserved
 * under `doc.v3` so the native art director never has to re-derive them.
 *
 * Deliberate difference from v2's adapter: `storyBible.narrativeSpine` is a
 * STRING here. toLegacyStoryPlan String()s that field into the back-cover
 * synopsis; v2 passes an array which collapses to "[object Object]" junk.
 */

const { renderAllSpreadsQuad } = require('../../../bookPipeline/illustrator/renderAllSpreadsQuad');
const { createBookDocument } = require('../../contract/bookDocument');
const {
  deriveParentVisibility,
  buildSpreadsForLegacyIllustrator,
} = require('./illustrationAdapterHelpers');

const CAREGIVER_RE = /\b(mama|mommy|mom|mother|dada|daddy|dad|father|grandma|granny|nana|grandpa|papa|abuela|abuelo|savta|saba|ima|aba)\b/i;

/**
 * Union of scene-contract fields across the manuscript → book-wide visual
 * facts: recurring props (key_objects appearing on >= 2 spreads), distinct
 * settings, and the supporting cast (everyone listed present who isn't the
 * hero).
 */
function collectVisualFacts(manuscript, heroName) {
  const objectSpreads = new Map();
  const settings = [];
  const castNames = new Map();
  const heroLower = String(heroName || '').toLowerCase();

  for (const s of manuscript.spreads) {
    const sc = s.scene_contract || {};
    if (sc.setting && !settings.includes(sc.setting)) settings.push(sc.setting);
    for (const obj of sc.key_objects || []) {
      const key = String(obj).toLowerCase().trim();
      if (!key) continue;
      if (!objectSpreads.has(key)) objectSpreads.set(key, { name: obj, spreads: [] });
      objectSpreads.get(key).spreads.push(s.spread);
    }
    for (const who of sc.characters_present || []) {
      const key = String(who).toLowerCase().trim();
      if (!key || key === heroLower || key.includes(heroLower)) continue;
      if (!castNames.has(key)) castNames.set(key, { name: who, spreads: [] });
      castNames.get(key).spreads.push(s.spread);
    }
  }

  const recurringProps = Array.from(objectSpreads.values())
    .filter((p) => p.spreads.length >= 2)
    .map((p) => ({ name: p.name, description: '', appearsInSpreads: p.spreads }));

  const supportingCast = Array.from(castNames.values()).map((c) => ({
    name: c.name,
    role: c.name,
    onCover: false, // v1's illustrator + QA resolve actual cover presence from detection
    description: c.name,
    isThemedParent: CAREGIVER_RE.test(c.name),
    partialPresenceLock: null,
  }));

  return { recurringProps, environmentAnchors: settings, supportingCast };
}

/**
 * Build a v1-shape visualBible from the brief + concept + manuscript.
 * The approved cover stays the character/style ground truth (v1 renderer
 * anchors on it); the physical description here is prompt reinforcement.
 */
function buildVisualBible({ rawRequest, brief, concept, manuscript }) {
  const heroName = brief?.child?.name || rawRequest?.child?.name || 'the child';
  const appearance = rawRequest?.child?.appearance || rawRequest?.childAppearance || '';
  const facts = collectVisualFacts(manuscript, heroName);

  return {
    hero: {
      name: heroName,
      physicalDescription: [
        typeof appearance === 'string' ? appearance : JSON.stringify(appearance),
        'Match the approved cover exactly — the cover is the identity and style ground truth.',
      ].filter(Boolean).join(' '),
      outfitDescription: '',
    },
    outfitLocks: {
      ruleSummary: `Locked to the hero's outfit on the approved cover of "${manuscript.title || rawRequest?.cover?.title || ''}".`,
    },
    supportingCastPolicy: {
      onCoverFullFigure: 'allowed',
      offCoverFullFigure: 'forbidden',
      partialPresenceRequired: true,
    },
    supportingCast: facts.supportingCast,
    recurringProps: facts.recurringProps,
    style: '',
    palette: '',
    environmentAnchors: facts.environmentAnchors,
    compositionRules: 'one focal action per spread; varied camera angles; text never crosses center; warm cinematic lighting.',
    textRendering: { policy: 'painted-into-illustration' },
    prohibitedVisualDrift: [],
    climaxImage: concept?.climax_image || null,
  };
}

/**
 * scene_contract → v1 spread spec. This is the writer→illustrator
 * interface doing its job: the fields v1's buildIllustrationSpec reads
 * come straight from the contract the writer promised.
 */
function buildSpreadSpecs({ manuscript, ageProfile }) {
  const ageBand = ageProfile?.ageBand || ageProfile?.band || 'PB_PRESCHOOL';
  const total = manuscript.spreads.length;
  return manuscript.spreads.map((s, idx) => {
    const sc = s.scene_contract || {};
    const caregiverPresent = (sc.characters_present || []).some((w) => CAREGIVER_RE.test(String(w)));
    const prev = manuscript.spreads[idx - 1];
    const next = manuscript.spreads[idx + 1];
    return {
      spreadNumber: s.spread,
      purpose: sc.hero_action || '',
      plotBeat: sc.hero_action || '',
      emotionalBeat: sc.emotion || '',
      humorBeat: null,
      location: sc.setting || '',
      focalAction: sc.hero_action || '',
      cameraIntent: 'medium close-up, warm cinematic lighting',
      textSide: idx % 2 === 0 ? 'right' : 'left',
      textLineTarget: ageProfile?.narrativeConstraints?.linesPerSpread?.target || 4,
      mustUseDetails: [
        ...(sc.key_objects || []).map((o) => `must include: ${o}`),
        ...(s.refrain_here && manuscript.refrain ? [`refrain moment: "${manuscript.refrain.text}"`] : []),
      ],
      sceneBridge: sc.continuity_notes || '',
      continuityAnchors: [sc.continuity_notes, sc.time_of_day].filter(Boolean),
      proseProps: sc.key_objects || [],
      qaTargets: [],
      forbiddenMistakes: [],
      parentVisibility: caregiverPresent
        ? deriveParentVisibility('full', ageBand)
        : deriveParentVisibility(null, ageBand),
      arcContext: {
        phase: idx === 0 ? 'opening' : idx >= total - 2 ? 'ending' : idx >= Math.floor(total / 2) - 1 && idx <= Math.floor(total / 2) ? 'midpoint' : 'middle',
        whatJustHappened: prev?.scene_contract?.hero_action || '',
        whatComesNext: next?.scene_contract?.hero_action || '',
      },
    };
  });
}

/**
 * v1 storyBible shape. narrativeSpine MUST be a string (see module doc).
 */
function buildStoryBible({ concept, manuscript }) {
  return {
    title: manuscript.title || '',
    logline: concept?.logline || '',
    narrativeSpine: concept?.external_plot || concept?.logline || '',
    visualJourneySpine: manuscript.spreads.map((s) => s.scene_contract?.setting).filter(Boolean),
    recurringVisualMotifs: manuscript.refrain ? [manuscript.refrain.text] : [],
    themeDeliveredVia: [],
    threeActShape: null,
    midpoint: null,
    climaxPayoffImage: concept?.climax_image || null,
    endingImage: concept?.final_page_note || null,
  };
}

/**
 * Compose the v1 document and run the v1 renderer.
 */
async function illustrationDirectorActivity(input, ctx) {
  const {
    rawRequest, brief, ageProfile, concept, manuscript,
    coverImageUrl, coverTitle, operationalContext,
  } = input;

  const visualBible = buildVisualBible({ rawRequest, brief, concept, manuscript });
  const spreadSpecs = buildSpreadSpecs({ manuscript, ageProfile });
  const storyBible = buildStoryBible({ concept, manuscript });
  const draftBySpread = new Map(manuscript.spreads.map((s) => [s.spread, { text: s.text, lines: s.lines }]));

  let doc = createBookDocument({
    request: { ...rawRequest, bookId: ctx.bookId, ageBand: ageProfile?.ageBand || ageProfile?.band },
    brief: rawRequest || {},
    cover: {
      title: manuscript.title || coverTitle || rawRequest?.cover?.title || 'My Story',
      imageUrl: coverImageUrl || rawRequest?.cover?.imageUrl || null,
      characterLocks: {},
      outfitLocks: {},
    },
  });
  doc.storyBible = storyBible;
  doc.visualBible = visualBible;
  doc.spreadSpecs = spreadSpecs;
  doc.spreads = buildSpreadsForLegacyIllustrator({ spreadSpecs, draftBySpread });
  doc.operationalContext = operationalContext || {};

  ctx.log('info', `[v3] illustrationDirector handing off ${doc.spreads.length} spreads to v1 illustrator (renderAllSpreadsQuad)`);

  let rendered;
  try {
    rendered = await renderAllSpreadsQuad(doc);
  } catch (err) {
    // Same transient-tagging as v2's adapter: setup-phase infra errors
    // bypass the renderer's internal retries, so surface `isTransient`
    // for the workflow engine's outer retry.
    const msg = String(err?.message || '');
    const looksTransient =
      err?.isTransientInfrastructure === true ||
      /Session API error (500|502|503|504|429)\b/.test(msg) ||
      /"code":\s*(500|502|503|504|429)\b/.test(msg) ||
      /"status":\s*"(UNAVAILABLE|INTERNAL|RESOURCE_EXHAUSTED)"/.test(msg) ||
      /\bUNAVAILABLE\b|\bINTERNAL\b|\bRESOURCE_EXHAUSTED\b/i.test(msg) ||
      /Deadline expired|timed out/i.test(msg);
    if (looksTransient && err && !err.isTransient) err.isTransient = true;
    throw err;
  }
  ctx.log('info', `[v3] illustrationDirector: render complete, ${rendered.spreads.length} spreads`);
  return rendered;
}

module.exports = {
  illustrationDirectorActivity,
  // exported for tests
  buildVisualBible,
  buildSpreadSpecs,
  buildStoryBible,
  collectVisualFacts,
};
