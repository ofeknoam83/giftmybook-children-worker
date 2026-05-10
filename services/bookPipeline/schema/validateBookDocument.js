/**
 * Lightweight structural validators for the canonical book document.
 *
 * These are NOT a full JSON schema; they are acceptance gates the
 * orchestrator uses between stages. Each validator returns a list of
 * issue strings — empty list means the document satisfies the gate for
 * that stage.
 */

const { TOTAL_SPREADS, AGE_BANDS, FORMATS } = require('../constants');

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
  // Lap-baby books (PB_INFANT) intentionally cap scope at 1-3 micro-settings
  // — a 7-month-old cannot travel a multi-location quest, but the planner
  // is allowed up to 3 stops on ONE continuous outdoor/semi-outdoor journey
  // the baby is CARRIED through (front stoop → garden path → river-edge
  // bench). The previous 1-2 cap snapped any outdoor walk-spine back to
  // a domestic pair; the still-point rule is enforced separately by the
  // plannerGuard at the spread-spec layer regardless of how many stops the
  // bible names. See createStoryBible.js infantStoryBibleClause.
  const isInfant = doc.request?.ageBand === AGE_BANDS.PB_INFANT;
  if (isInfant) {
    if (!Array.isArray(sb.cinematicLocations) || sb.cinematicLocations.length < 1) {
      issues.push('storyBible.cinematicLocations must have at least 1 specific micro-setting (lap, cot, kitchen window, porch, etc.) for infant board books');
    } else if (sb.cinematicLocations.length > 3) {
      issues.push('storyBible.cinematicLocations must have at most 3 micro-settings for infant board books (lap-baby scope; the baby is carried across all stops)');
    }
  } else if (!Array.isArray(sb.cinematicLocations) || sb.cinematicLocations.length < 3) {
    issues.push('storyBible.cinematicLocations must have at least 3 specific photogenic settings (with time-of-day and weather)');
  }

  // Phase 1 — thicker-bible structural gates. These exist because every
  // downstream stage (writer voice, refrain placement, illustrator opening/
  // closing image) reads these fields. Empty here = a quietly bad book later.
  // Bars are deliberately permissive (length only) — content quality is the
  // writer's job, not the planner gate's.
  if (!sb.moment || String(sb.moment).trim().length < 12) {
    issues.push('storyBible.moment weak (need a specific time + place, e.g. "the morning between waking up and the bus on the first day of kindergarten")');
  }
  if (!sb.weather || String(sb.weather).trim().length < 6) {
    issues.push('storyBible.weather weak (need light + time of day + mood, e.g. "late-afternoon gold")');
  }
  if (!sb.openingImage || String(sb.openingImage).trim().length < 12) {
    issues.push('storyBible.openingImage weak (need a concrete, drawable image — not a feeling)');
  }
  if (!sb.closingCallback || String(sb.closingCallback).trim().length < 12) {
    issues.push('storyBible.closingCallback weak (need a concrete callback to openingImage)');
  }
  // ritual is optional — null means "no ritual fits this book" — but if
  // present it must have both fields, otherwise it's noise to downstream.
  if (sb.ritual !== null && sb.ritual !== undefined) {
    if (typeof sb.ritual !== 'object') {
      issues.push('storyBible.ritual must be an object or null');
    } else if (!sb.ritual.name || !sb.ritual.description) {
      issues.push('storyBible.ritual partial (need both name and description, or set to null)');
    }
  }
  // voiceCard — all four fields required and non-empty.
  if (!sb.voiceCard || typeof sb.voiceCard !== 'object') {
    issues.push('storyBible.voiceCard missing (need narratorPOV, tonalRegister, signatureMove, refrainSeed)');
  } else {
    for (const k of ['narratorPOV', 'tonalRegister', 'signatureMove', 'refrainSeed']) {
      if (!sb.voiceCard[k] || String(sb.voiceCard[k]).trim().length < 3) {
        issues.push(`storyBible.voiceCard.${k} weak`);
      }
    }
  }
  // refrain — text required; plant 1-4, deepen 5-9, transform 10-13, strict.
  if (!sb.refrain || typeof sb.refrain !== 'object') {
    issues.push('storyBible.refrain missing (need text, plant, deepen, transform)');
  } else {
    const text = String(sb.refrain.text || '').trim();
    const wordCount = text ? text.split(/\s+/).length : 0;
    if (wordCount < 4 || wordCount > 12) {
      issues.push('storyBible.refrain.text must be 4-12 words');
    }
    const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    if (!inRange(sb.refrain.plant, 1, 4)) issues.push('storyBible.refrain.plant must be an integer in 1..4');
    if (!inRange(sb.refrain.deepen, 5, 9)) issues.push('storyBible.refrain.deepen must be an integer in 5..9');
    if (!inRange(sb.refrain.transform, 10, 13)) issues.push('storyBible.refrain.transform must be an integer in 10..13');
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
    // AA-CW-2 — Planner Guard hits. The guard (planner/plannerGuard.js) runs
    // at the end of createSpreadSpecs for PB_INFANT books and stashes hits
    // onto spec.plannerGuardHits. We surface each hit as a validator issue
    // so the existing runStage gate-retry loop kicks in: retryMemory captures
    // the hits and the next planner attempt sees them in its user prompt via
    // renderRetryMemoryForPrompt. The hit message names the specific phrase
    // and a suggested rewrite so the next attempt can self-correct.
    const guardHits = Array.isArray(s.spec.plannerGuardHits) ? s.spec.plannerGuardHits : [];
    for (const h of guardHits) {
      const phrase = String(h?.problemPhrase || '').slice(0, 120);
      const reason = String(h?.reason || 'baby cannot self-locomote').slice(0, 200);
      const suggestion = String(h?.suggestedAlternative || '').slice(0, 200);
      issues.push(
        `spread ${s.spreadNumber}: planner guard hit — phrase="${phrase}" reason="${reason}"` +
          (suggestion ? ` suggestedAlternative="${suggestion}"` : ''),
      );
    }
  }
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
