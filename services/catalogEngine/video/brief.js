/**
 * Journey brief (gift video, gv-2 — docs/GIFT_VIDEO_PLAN.md, revision 4).
 *
 * The provider-neutral motion brief for the film's ONE continuous take,
 * built from pinned data only: per act the beat's action, the assigned
 * camera angle and the move that carries the take into it, the planned
 * emotion, the companion when the beat or the manuscript names them, the
 * personal props, the fixed lock and negative lines, and the identity-kit
 * references in a fixed order. Reference mentions are `[REFn]` placeholders
 * that each provider renders into its own syntax (or into "the first frame"
 * when the model takes no references). A repair brief appends template notes
 * for the verified defects and nudges the numeric knobs. Pure; the hash is
 * part of the clip's cache key.
 */

const { EMOTION_CUES } = require('../illustrator/emotionPlan');
const { inertPropValue } = require('../illustrator/scenes');
const { fnv1a } = require('../selection');

const MOTION_SCALE = {
  soft: 'barely moving — small, natural breathing motion, a blink, a slight turn of the head, an unhurried walk',
  clear: 'gentle, natural motion — the child performs each action calmly and walks on, feet on the ground',
  big: 'lively but grounded motion — the child performs each action with energy and moves on, feet on the ground',
};

const NEGATIVE_PROMPT = 'text, captions, subtitles, letters, words, signage, logo, watermark, speech, talking, lip sync, '
  + 'new character, extra people, extra limbs, morphing, distorted face, outfit change, style change, camera cut, hard cut, fade, wipe, dissolve, split screen, montage, flicker';

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

/** `0–3.4s` for an act window. */
function windowText(act) {
  const f = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  return `${f(act.from)}–${f(act.to)}s`;
}

/**
 * Build the brief for the single take.
 * @param {object} p
 * @param {{kind: 'journey', seconds: number, acts: Array<{index: number, spread: number, from: number, to: number, angleText: string, moveText: string}>}} p.segment the plan's segment
 * @param {string} p.name the child's (profile) name
 * @param {Array<{spread: number, beat: string|null, emotion: {emotion: string, intensity: string}|null, companion: {name: string, type?: string}|null, propValues: string[]}>} p.acts per-act pinned content, in the segment's act order
 * @param {Array<{kind: 'character'|'companion'|'prop', value?: string}>} p.references reference images, in attachment order
 * @param {{display_name?: string, world_name?: string}|null} [p.theme]
 * @param {string} [p.ageBand]
 * @param {boolean} [p.endFrame] the provider also gets the last act's still as the end frame
 * @returns {{prompt: string, negativePrompt: string, cameraMotion: 'journey', motionScale: string, angles: string[], references: object[], params: {cfgScale: number}, hash: string}}
 */
function buildJourneyBrief(p) {
  const seg = p.segment;
  const name = inertPropValue(p.name || '') || 'the child';
  const refs = Array.isArray(p.references) ? p.references : [];
  const refIndex = (kind, value) => {
    const i = refs.findIndex(r => r.kind === kind && (kind !== 'prop' || r.value === value));
    return i >= 0 ? `[REF${i + 1}]` : null;
  };
  const charRef = refIndex('character');
  const cRef = refIndex('companion');
  const world = p.theme && p.theme.world_name ? inertPropValue(p.theme.world_name) : 'the world of the book';
  const planActs = Array.isArray(seg.acts) ? seg.acts : [];
  const acts = planActs.map((a, i) => ({ plan: a, content: (p.acts && p.acts[i]) || { spread: a.spread, beat: null, emotion: null, companion: null, propValues: [] } }));
  const seconds = Number.isFinite(seg.seconds) ? seg.seconds : 10;
  const secondsText = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
  const young = p.ageBand === '1-3';
  const intensities = acts.map(a => (a.content.emotion && MOTION_SCALE[a.content.emotion.intensity] ? a.content.emotion.intensity : 'clear'));
  const peak = intensities.includes('big') ? 'big' : (intensities.includes('clear') ? 'clear' : 'soft');
  const motionScale = young && peak === 'big' ? 'clear' : peak;

  const lines = [];
  lines.push(`Animate this children's-book illustration into ONE continuous, unbroken ${secondsText}-second shot in exactly the same premium 3D animated-film style as the first frame — a single take: no cuts, no fades, no wipes, no split screens, no montage; the camera travels through the space instead.`);
  lines.push(`JOURNEY: ${name} travels through ${acts.length === 1 ? 'one moment' : `${acts.length} moments`} of ${world} in one continuous take — ${name} advances forward out of each moment and the surroundings flow seamlessly into the next as one connected place, while the camera angle changes along the way.`);
  acts.forEach((a, i) => {
    const action = a.content.beat ? actionSentence(a.content.beat, name) : `${name} looks around and moves on`;
    const first = i === 0;
    const last = i === acts.length - 1;
    const lead = first ? 'starts exactly on the first frame' : null;
    const enter = first || acts.length === 1 ? '' : `${name} advances into the next part of ${world}: `;
    const camera = first
      ? `${a.plan.angleText}; the camera ${a.plan.moveText}`
      : `the camera ${a.plan.moveText} to ${a.plan.angleText}`;
    const settle = last && acts.length > 1 ? (p.endFrame ? ' and settles on the final composition — exactly the last frame' : ' and settles on the final composition') : '';
    lines.push(`MOMENT ${i + 1} (${windowText(a.plan)}${lead ? `, ${lead}` : ''}): ${enter}${action}. CAMERA: ${camera}${settle}.`);
  });
  const companionActs = acts.filter(a => a.content.companion && a.content.companion.name);
  if (companionActs.length > 0) {
    const c = companionActs[0].content.companion;
    const where = companionActs.length === acts.length ? 'throughout' : `in moment${companionActs.length > 1 ? 's' : ''} ${companionActs.map(a => a.plan.index + 1).join(' and ')}`;
    lines.push(`COMPANION: ${inertPropValue(c.name)}${c.type ? ` (${inertPropValue(c.type)})` : ''} is present ${where} and moves naturally beside the child${cRef ? `, exactly as in ${cRef}` : ''}; exactly ONE of them.`);
  }
  const cues = acts.map(a => (a.content.emotion && EMOTION_CUES[a.content.emotion.emotion] ? `${a.content.emotion.intensity} ${a.content.emotion.emotion} (${EMOTION_CUES[a.content.emotion.emotion]})` : null)).filter(Boolean);
  if (cues.length > 0) {
    lines.push(`PERFORMANCE: the child's expression reads, moment by moment, as ${cues.join(', then ')}. Motion scale: ${MOTION_SCALE[motionScale]}.`);
  } else {
    lines.push(`PERFORMANCE: a warm, natural expression. Motion scale: ${MOTION_SCALE[motionScale]}.`);
  }
  lines.push(`CHARACTER: exactly ONE child — ${name}${charRef ? `, the child of ${charRef}` : ''}: keep the face, hair, skin tone, age, proportions and the complete outfit (every garment and colour) EXACTLY as in the first frame for the whole take; the outfit never changes; the last frame shows the same child as the first.`);
  const props = [...new Set(acts.flatMap(a => (a.content.propValues || []).map(v => inertPropValue(v)).filter(Boolean)))];
  if (props.length > 0) {
    lines.push(`PROPS: ${props.map(v => `"${v}"${refIndex('prop', v) ? ` (exactly as ${refIndex('prop', v)})` : ''}`).join(', ')} stay exactly as drawn — same object, colours and size; never duplicated, never turned into text.`);
  }
  lines.push('WORLD: one world throughout — the same palette, lighting, era and physical laws as the first frame; the surroundings change ONLY because the child walks on through them, never by a cut; nothing new enters the frame beyond what each moment describes.');
  lines.push('RULES: no speech, no talking, no mouth flapping, no dialogue, no narration; no text, captions, subtitles, letters, words, signs, logos or watermarks anywhere; no new characters; no cuts, fades, wipes or scene jumps of any kind; the take starts exactly on the first frame.');
  const prompt = lines.join('\n');
  const brief = {
    prompt,
    negativePrompt: NEGATIVE_PROMPT,
    cameraMotion: 'journey',
    motionScale,
    angles: planActs.map(a => a.angle),
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
    p: brief.prompt, n: brief.negativePrompt, c: brief.cameraMotion, m: brief.motionScale, g: brief.angles || null,
    r: (brief.references || []).map(r => [r.kind, r.value || null]), k: brief.params,
  })).toString(36);
}

/**
 * Template repair notes for a verified defect list (pinned data only).
 * @param {string[]} defects
 * @returns {string[]}
 */
function repairNotes(defects) {
  const d = defects || [];
  const has = (re) => d.some(x => re.test(x));
  const notes = [];
  if (has(/^(identity break|hair differs|skin tone differs|age or proportions differ)/)) {
    notes.push('IDENTITY REPAIR: the child must remain EXACTLY the child of [REF1] and of the first frame for the whole take — same face, hair colour and style, skin tone, age and proportions; the last frame must show the same child as the first.');
  }
  if (has(/^outfit break/)) {
    notes.push('OUTFIT REPAIR: the outfit never changes during the take — every garment, colour, pattern and length stays exactly as in the first frame; nothing is added or removed.');
  }
  if (has(/^child hero missing/)) {
    notes.push('FRAMING REPAIR: keep the child fully in frame for the whole take; the camera travels WITH the child and never loses them.');
  }
  if (has(/^duplicated child hero|^new character/)) {
    notes.push('CAST REPAIR: exactly ONE child in the whole take; nobody else enters the frame.');
  }
  if (has(/^painted text|^stray lettering|^pseudo-script|text appears/)) {
    notes.push('LETTERING REPAIR: absolutely no letters, words, captions, signs, logos or letter-like glyphs anywhere in any frame.');
  }
  if (has(/^motion break|morph/)) {
    notes.push('MOTION REPAIR: subtle, slow, natural motion only — no deformation, no melting or morphing of the face, hands or body; every frame is a clean illustration.');
  }
  if (has(/^frozen clip/)) {
    notes.push('LIFE REPAIR: the child must visibly move — walk forward, turn the head, gesture — so the take is clearly animated, not a still.');
  }
  if (has(/^cut break/)) {
    notes.push('SINGLE-TAKE REPAIR: ONE unbroken shot from the first frame to the last — no cuts, fades, wipes, dissolves or sudden scene jumps; the camera physically travels through the space from each moment into the next.');
  }
  if (has(/^journey break/)) {
    notes.push('JOURNEY REPAIR: the child must clearly ADVANCE out of the first moment into the next ones — walking forward as the surroundings flow into the next part of the world; the take must not stay in one static scene.');
  }
  if (has(/^speech/)) {
    notes.push('SILENCE REPAIR: the child does not talk — mouth closed or a calm smile; no lip movement as if speaking.');
  }
  if (has(/^prop /) || has(/^carried prop/)) {
    notes.push('PROP REPAIR: every personal prop stays exactly as drawn in the first frame — same object, colours and size, exactly one of it, never as text.');
  }
  if (has(/^companion/)) {
    notes.push('COMPANION REPAIR: the companion stays exactly as drawn in the first frame — same design, colours and proportions, friendly and secondary to the child; exactly one of them.');
  }
  if (has(/^action break/)) {
    notes.push('ACTION REPAIR: the child actively performs each MOMENT\'s action described above (not posing beside it), gently and clearly.');
  }
  if (has(/^anatomy defect/)) {
    notes.push('ANATOMY REPAIR: two arms, two hands with five fingers, two legs, one face with correctly placed features in every frame — no extra, missing or fused limbs.');
  }
  if (has(/^composition break/)) {
    notes.push('CAMERA REPAIR: the camera angle must visibly change from moment to moment exactly as described above — slow, smooth camera travel, never a static camera and never a cut.');
  }
  return notes;
}

/**
 * A repair brief: the base brief plus REPAIR notes for the defects, with the
 * knobs nudged (identity/outfit defects raise guidance; motion defects lower
 * the motion scale). Pure; a new hash.
 * @param {object} brief from buildJourneyBrief
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

module.exports = { buildJourneyBrief, repairBrief, repairNotes, renderPromptForModel, briefHash, actionSentence, windowText, MOTION_SCALE, NEGATIVE_PROMPT };
