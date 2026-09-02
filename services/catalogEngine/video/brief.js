/**
 * Clip brief (gift video, gv-1 — docs/GIFT_VIDEO_PLAN.md §4.2).
 *
 * The provider-neutral motion brief for ONE segment, built from pinned data
 * only: the beat's action, the assigned camera move, the planned emotion,
 * the fixed lock and negative lines, and the identity-kit references in a
 * fixed order. Reference mentions are `[REFn]` placeholders that each
 * provider renders into its own syntax (or into "the first frame" when the
 * model takes no references). A repair brief appends template notes for the
 * verified defects and nudges the numeric knobs. Pure; the hash is part of
 * every clip's cache key.
 */

const { EMOTION_CUES } = require('../illustrator/emotionPlan');
const { inertPropValue } = require('../illustrator/scenes');
const { fnv1a } = require('../selection');

const CAMERA_SENTENCES = {
  'push-in': 'a slow, smooth push-in toward the child',
  'pull-out': 'a slow, smooth pull back that reveals more of the scene',
  'pan-left': 'a slow, smooth pan to the left across the scene',
  'pan-right': 'a slow, smooth pan to the right across the scene',
  rise: 'a slow, smooth rise, the camera tilting up over the scene',
  hold: 'a locked-off camera with no camera movement at all',
};

const MOTION_SCALE = {
  soft: 'barely moving — small, natural breathing motion, a blink, a slight turn of the head',
  clear: 'gentle, natural motion — the child performs the action calmly, feet on the ground',
  big: 'lively but grounded motion — the child performs the action with energy, feet on the ground',
};

const NEGATIVE_PROMPT = 'text, captions, subtitles, letters, words, signage, logo, watermark, speech, talking, lip sync, '
  + 'new character, extra people, extra limbs, morphing, distorted face, outfit change, style change, camera cut, flicker';

/**
 * Turn a catalog beat ("Child gets ready to visit …") into the child's
 * action sentence with the (sanitized) name in place of the generic subject.
 * @param {string} beat
 * @param {string} name
 * @returns {string}
 */
function actionSentence(beat, name) {
  const b = inertPropValue(beat).replace(/\.$/, '');
  const who = name || 'The child';
  const swapped = b.replace(/^(The )?child\b/i, who);
  return swapped === b && !/^\p{Lu}/u.test(b) ? `${who} ${b}` : swapped;
}

/**
 * Build the brief for one segment.
 * @param {object} p
 * @param {{kind: 'cover'|'spread', spread: number|null, motion: string, seconds: number}} p.segment
 * @param {string} p.name the child's (profile) name
 * @param {string|null} p.beat the spread's fixed beat text (null for the cover)
 * @param {{name: string, type?: string}|null} p.companion theme companion when it appears on this spread
 * @param {{emotion: string, intensity: string}|null} p.emotion planned emotion for the spread
 * @param {string[]} p.propValues personal props visible on this spread (declared + carried)
 * @param {Array<{kind: 'character'|'companion'|'prop', value?: string}>} p.references reference images, in attachment order
 * @param {string} [p.ageBand]
 * @param {{display_name?: string, world_name?: string}|null} [p.theme]
 * @returns {{prompt: string, negativePrompt: string, cameraMotion: string, motionScale: string, references: object[], params: {cfgScale: number}, hash: string}}
 */
function buildClipBrief(p) {
  const seg = p.segment;
  const name = inertPropValue(p.name || '') || 'the child';
  const refs = Array.isArray(p.references) ? p.references : [];
  const refIndex = (kind, value) => {
    const i = refs.findIndex(r => r.kind === kind && (kind !== 'prop' || r.value === value));
    return i >= 0 ? `[REF${i + 1}]` : null;
  };
  const charRef = refIndex('character');
  const intensity = p.emotion && MOTION_SCALE[p.emotion.intensity] ? p.emotion.intensity : 'clear';
  const young = p.ageBand === '1-3';
  const motionScale = young && intensity === 'big' ? 'clear' : intensity;
  const lines = [];
  lines.push("Animate this children's-book illustration as a short, gentle cinematic moment in exactly the same premium 3D animated-film style as the first frame.");
  if (seg.kind === 'cover') {
    lines.push(`ACTION: ${name} comes alive on the book's cover — a warm look toward the viewer, a small natural movement, then a happy smile.`);
  } else {
    lines.push(`ACTION: ${actionSentence(p.beat || '', name)}.`);
  }
  if (p.companion && p.companion.name) {
    const cRef = refIndex('companion');
    lines.push(`COMPANION: ${inertPropValue(p.companion.name)}${p.companion.type ? ` (${inertPropValue(p.companion.type)})` : ''} is present and moves naturally beside the child${cRef ? `, exactly as in ${cRef}` : ''}.`);
  }
  lines.push(`CAMERA: ${CAMERA_SENTENCES[seg.motion] || CAMERA_SENTENCES['push-in']}; no cuts, no zoom bursts, no shake.`);
  if (p.emotion && EMOTION_CUES[p.emotion.emotion]) {
    lines.push(`PERFORMANCE: the child's expression reads as ${intensity} ${p.emotion.emotion} — ${EMOTION_CUES[p.emotion.emotion]}. Motion scale: ${MOTION_SCALE[motionScale]}.`);
  } else {
    lines.push(`PERFORMANCE: a warm, natural expression. Motion scale: ${MOTION_SCALE[motionScale]}.`);
  }
  lines.push(`CHARACTER: exactly ONE child — ${name}${charRef ? `, the child of ${charRef}` : ''}: keep the face, hair, skin tone, age, proportions and the complete outfit (every garment and colour) EXACTLY as in the first frame for the whole clip; the outfit never changes; the last frame shows the same child as the first.`);
  const props = (p.propValues || []).map(v => inertPropValue(v)).filter(Boolean);
  if (props.length > 0) {
    lines.push(`PROPS: ${props.map(v => `"${v}"${refIndex('prop', v) ? ` (exactly as ${refIndex('prop', v)})` : ''}`).join(', ')} stay exactly as drawn — same object, colours and size; never duplicated, never turned into text.`);
  }
  lines.push('WORLD: the setting, lighting, palette and every object stay exactly as in the first frame; nothing new enters the frame.');
  lines.push('RULES: no speech, no talking, no mouth flapping, no dialogue, no narration; no text, captions, subtitles, letters, words, signs, logos or watermarks anywhere; no new characters; no camera cuts; the clip starts exactly on the first frame.');
  const prompt = lines.join('\n');
  const brief = {
    prompt,
    negativePrompt: NEGATIVE_PROMPT,
    cameraMotion: seg.motion,
    motionScale,
    references: refs.map((r, i) => ({ ...r, placeholder: `[REF${i + 1}]` })),
    params: { cfgScale: 0.5 },
  };
  brief.hash = briefHash(brief);
  return brief;
}

/**
 * Content hash of a brief (prompt + negative + knobs + reference kinds).
 * @param {object} brief
 * @returns {string}
 */
function briefHash(brief) {
  return fnv1a(JSON.stringify({
    p: brief.prompt, n: brief.negativePrompt, c: brief.cameraMotion, m: brief.motionScale,
    r: (brief.references || []).map(r => [r.kind, r.value || null]), k: brief.params,
  })).toString(36);
}

/**
 * Template repair notes for a verified defect list (pinned data only).
 * @param {string[]} defects
 * @param {{name?: string}} [ctx]
 * @returns {string[]}
 */
function repairNotes(defects, ctx = {}) {
  const d = defects || [];
  const has = (re) => d.some(x => re.test(x));
  const notes = [];
  if (has(/^(identity break|hair differs|skin tone differs|age or proportions differ)/)) {
    notes.push('IDENTITY REPAIR: the child must remain EXACTLY the child of [REF1] and of the first frame for the whole clip — same face, hair colour and style, skin tone, age and proportions; the last frame must show the same child as the first.');
  }
  if (has(/^outfit break/)) {
    notes.push('OUTFIT REPAIR: the outfit never changes during the clip — every garment, colour, pattern and length stays exactly as in the first frame; nothing is added or removed.');
  }
  if (has(/^child hero missing/)) {
    notes.push('FRAMING REPAIR: keep the child fully in frame for the whole clip; the camera never loses the child.');
  }
  if (has(/^duplicated child hero|^new character/)) {
    notes.push('CAST REPAIR: exactly ONE child in the whole clip; nobody else enters the frame.');
  }
  if (has(/^painted text|^stray lettering|^pseudo-script|text appears/)) {
    notes.push('LETTERING REPAIR: absolutely no letters, words, captions, signs, logos or letter-like glyphs anywhere in any frame.');
  }
  if (has(/^motion break|morph/)) {
    notes.push('MOTION REPAIR: subtle, slow, natural motion only — no deformation, no melting or morphing of the face, hands or body; every frame is a clean illustration.');
  }
  if (has(/^frozen clip/)) {
    notes.push('LIFE REPAIR: the child must visibly move — a head turn, an arm gesture, a step — so the clip is clearly animated, not a still.');
  }
  if (has(/^speech/)) {
    notes.push('SILENCE REPAIR: the child does not talk — mouth closed or a calm smile; no lip movement as if speaking.');
  }
  if (has(/^prop /) || has(/^carried prop/)) {
    notes.push('PROP REPAIR: every personal prop stays exactly as drawn in the first frame — same object, colours and size, exactly one of it, never as text.');
  }
  if (has(/^companion/)) {
    notes.push('COMPANION REPAIR: the companion stays exactly as drawn in the first frame — same design, colours and proportions, friendly and secondary to the child.');
  }
  if (has(/^action break/)) {
    notes.push('ACTION REPAIR: the child actively performs the ACTION described above (not posing beside it), gently and clearly.');
  }
  if (has(/^anatomy defect/)) {
    notes.push('ANATOMY REPAIR: two arms, two hands with five fingers, two legs, one face with correctly placed features in every frame — no extra, missing or fused limbs.');
  }
  if (has(/^composition break/)) {
    notes.push('CAMERA REPAIR: perform exactly the CAMERA move described above, slowly and smoothly.');
  }
  return notes;
}

/**
 * A repair brief: the base brief plus REPAIR notes for the defects, with the
 * knobs nudged (identity/outfit defects raise guidance; motion defects lower
 * the motion scale). Pure; a new hash.
 * @param {object} brief from buildClipBrief
 * @param {string[]} defects
 * @returns {object}
 */
function repairBrief(brief, defects) {
  const notes = repairNotes(defects);
  const identity = (defects || []).some(x => /^(identity break|hair differs|skin tone differs|age or proportions differ|outfit break)/.test(x));
  const motion = (defects || []).some(x => /^(motion break|anatomy defect)|morph/.test(x));
  const next = {
    ...brief,
    prompt: notes.length > 0 ? `${brief.prompt}\n${notes.join('\n')}` : brief.prompt,
    motionScale: motion && brief.motionScale !== 'soft' ? 'soft' : brief.motionScale,
    params: { ...brief.params, cfgScale: identity ? Math.min(1, Math.round((brief.params.cfgScale + 0.2) * 100) / 100) : brief.params.cfgScale },
  };
  if (motion && next.motionScale !== brief.motionScale) {
    next.prompt = next.prompt.replace(/Motion scale: [^\n]+/, `Motion scale: ${MOTION_SCALE.soft}.`);
  }
  next.hash = briefHash(next);
  return next;
}

/**
 * Render the prompt for a model: `[REFn]` becomes the model's mention syntax,
 * or "the first frame" when the model takes no references.
 * @param {object} brief
 * @param {((index: number) => string)|null} mention 1-based reference mention renderer
 * @returns {string}
 */
function renderPromptForModel(brief, mention) {
  return brief.prompt.replace(/\[REF(\d+)\]/g, (m, n) => (mention ? mention(Number(n)) : 'the first frame'));
}

module.exports = { buildClipBrief, repairBrief, repairNotes, renderPromptForModel, briefHash, actionSentence, CAMERA_SENTENCES, MOTION_SCALE, NEGATIVE_PROMPT };
