/**
 * Lightweight structural validators for the canonical book document.
 *
 * These are NOT a full JSON schema; they are acceptance gates the
 * orchestrator uses between stages. Each validator returns a list of
 * issue strings — empty list means the document satisfies the gate for
 * that stage.
 */

const { TOTAL_SPREADS, AGE_BANDS, FORMATS } = require('../constants');
const { auditSpreadSpecsLocationDiversity } = require('../planner/spreadLocationAudit');

function validateInput(doc) {
  const issues = [];
  if (!doc) return ['document missing'];
  if (!doc.request?.bookId) issues.push('request.bookId missing');
  if (!Object.values(FORMATS).includes(doc.request?.format)) issues.push('request.format invalid');
  if (!Object.values(AGE_BANDS).includes(doc.request?.ageBand)) issues.push('request.ageBand invalid');
  if (!doc.brief?.child?.name) issues.push('brief.child.name missing');
  if (!doc.cover?.imageUrl && !doc.cover?.imageBase64 && !doc.cover?.imageStorageKey) {
    issues.push('cover image reference missing (need imageUrl, imageBase64, or imageStorageKey)');
  }
  if (!doc.cover?.title) issues.push('cover.title missing');
  return issues;
}

function validateStoryBible(doc) {
  const issues = [];
  const sb = doc.storyBible;
  if (!sb) return ['storyBible missing'];
  const required = [
    'narrativeSpine',
    'beginningHook',
    'middleEscalation',
    'endingPayoff',
    'emotionalArc',
    'humorStrategy',
    'locationStrategy',
  ];
  for (const k of required) {
    if (!sb[k] || String(sb[k]).trim().length < 6) issues.push(`storyBible.${k} weak`);
  }
  if (!sb.visualJourneySpine || String(sb.visualJourneySpine).trim().length < 20) {
    issues.push('storyBible.visualJourneySpine weak (need causal thread connecting settings)');
  }
  if (!Array.isArray(sb.recurringVisualMotifs) || sb.recurringVisualMotifs.length < 2) {
    issues.push('storyBible.recurringVisualMotifs must have at least 2 items');
  }
  if (!Array.isArray(sb.personalizationTargets) || sb.personalizationTargets.length === 0) {
    issues.push('storyBible.personalizationTargets empty');
  }
  return issues;
}

function validateVisualBible(doc) {
  const issues = [];
  const vb = doc.visualBible;
  if (!vb) return ['visualBible missing'];
  if (!vb.hero) issues.push('visualBible.hero missing');
  if (!vb.outfitLocks) issues.push('visualBible.outfitLocks missing');
  if (!vb.supportingCastPolicy) issues.push('visualBible.supportingCastPolicy missing');
  if (!vb.styleRules) issues.push('visualBible.styleRules missing');
  if (!vb.textRenderingRules) issues.push('visualBible.textRenderingRules missing');
  if (!vb.continuityRules) issues.push('visualBible.continuityRules missing');
  return issues;
}

function validateSpreadSpecs(doc) {
  const issues = [];
  if (doc.spreads.length !== TOTAL_SPREADS) {
    issues.push(`expected ${TOTAL_SPREADS} spreads, got ${doc.spreads.length}`);
  }
  for (const s of doc.spreads) {
    if (!s.spec) {
      issues.push(`spread ${s.spreadNumber}: spec missing`);
      continue;
    }
    const requiredStrings = ['purpose', 'plotBeat', 'location', 'focalAction', 'cameraIntent'];
    for (const k of requiredStrings) {
      if (!s.spec[k] || String(s.spec[k]).trim().length < 3) {
        issues.push(`spread ${s.spreadNumber}: spec.${k} weak`);
      }
    }
    if (!['left', 'right'].includes(s.spec.textSide)) {
      issues.push(`spread ${s.spreadNumber}: spec.textSide invalid`);
    }
    if (!Number.isFinite(s.spec.textLineTarget) || s.spec.textLineTarget < 1 || s.spec.textLineTarget > 5) {
      issues.push(`spread ${s.spreadNumber}: spec.textLineTarget invalid`);
    }
    const bridge = String(s.spec.sceneBridge || '').trim();
    if (s.spreadNumber > 1 && bridge.length < 8) {
      issues.push(`spread ${s.spreadNumber}: spec.sceneBridge weak (need bridge from prior spread)`);
    }
    if (s.spreadNumber === 1 && bridge.length < 6) {
      issues.push('spread 1: spec.sceneBridge weak (need opening launch line)');
    }
  }
  const locAudit = auditSpreadSpecsLocationDiversity(doc);
  if (!locAudit.ok) issues.push(...locAudit.issues);
  return issues;
}

function validateManuscript(doc) {
  const issues = [];
  for (const s of doc.spreads) {
    if (!s.manuscript || typeof s.manuscript.text !== 'string' || s.manuscript.text.trim().length < 2) {
      issues.push(`spread ${s.spreadNumber}: manuscript missing or empty`);
      continue;
    }
    if (s.spec && s.manuscript.side !== s.spec.textSide) {
      issues.push(`spread ${s.spreadNumber}: manuscript.side does not match spec.textSide`);
    }
  }
  return issues;
}

function validateAllIllustrations(doc) {
  const issues = [];
  for (const s of doc.spreads) {
    if (!s.illustration?.imageUrl || s.illustration.accepted !== true) {
      issues.push(`spread ${s.spreadNumber}: illustration not accepted`);
    }
  }
  return issues;
}

module.exports = {
  validateInput,
  validateStoryBible,
  validateVisualBible,
  validateSpreadSpecs,
  validateManuscript,
  validateAllIllustrations,
};
