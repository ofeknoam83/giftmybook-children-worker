/**
 * Clip verification (gift video, gv-1 — docs/GIFT_VIDEO_PLAN.md §4.5): the
 * ce-9 selection gate applied to motion.
 *
 * Three judgments, all against pinned data:
 *  1. sampled frames (0 / 25 / 50 / 75 / 100 % of the USED segment) through
 *     the book's own structured verdict `checkSpreadRenderV2` with the
 *     character sheet, prop and companion sheets attached — identity,
 *     outfit garment by garment, props, companion, action, emotion,
 *     anatomy, painted text; the clip's frame verdict is the UNION of the
 *     frames' defects (the last frame is where drift lives);
 *  2. the same frames' painted-text checks double as the text gate;
 *  3. ONE video-level judge call with the clip itself as inline input for
 *     the temporal defects a still cannot show: morphing, identity drift
 *     over time, an outfit change, a new character, text appearing, speech,
 *     a frozen (near-still) clip, and the camera move (advisory).
 *
 * Scoring reuses select.js — blocking defects sink a candidate below zero,
 * advisories shade it, an unchecked clip ranks below any checked one.
 */

const path = require('path');
const fs = require('fs');
const { checkSpreadRenderV2, classifyDefects } = require('../illustrator/spreadQa');
const { EMOTIONS } = require('../illustrator/emotionPlan');
const { scoreCandidate } = require('../illustrator/select');
const { fetchWithTimeout, getNextApiKey } = require('../../illustrationGenerator');
const { jsonQaGenerationConfig, responseText, parseJsonText } = require('../../shared/llm/geminiJson');
const { extractFrames } = require('./ffmpeg');

const QA_MODEL = () => process.env.CATALOG_QA_VISION_MODEL || 'gemini-2.5-flash';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Video-level defect strings that BLOCK, beyond spreadQa's own prefixes. */
const VIDEO_BLOCKING_PREFIXES = ['motion break', 'identity drift', 'new character', 'speech:', 'frozen clip'];

/**
 * Split clip defects into blocking vs advisory (spreadQa's classes plus the
 * video-level ones).
 * @param {string[]} defects
 * @returns {{blocking: string[], advisory: string[]}}
 */
function classifyClipDefects(defects) {
  const base = classifyDefects(defects);
  const blocking = [...base.blocking];
  const advisory = [];
  for (const d of base.advisory) {
    (VIDEO_BLOCKING_PREFIXES.some(pfx => d.startsWith(pfx)) ? blocking : advisory).push(d);
  }
  return { blocking, advisory };
}

/**
 * Sample times inside the USED part of a clip.
 * @param {number} seconds the segment's seconds
 * @returns {number[]}
 */
function sampleTimes(seconds) {
  const end = Math.max(0.2, seconds - 0.05);
  return [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(f * end * 1000) / 1000);
}

/**
 * The video-level judge: strict JSON over the whole clip.
 * @param {Buffer} clipBuffer mp4 bytes (inline; clips are a few MB)
 * @param {{cameraMotion: string, label?: string, costTracker?: object}} opts
 * @returns {Promise<{defects: string[], verdict: object|null, unavailable?: string}>}
 */
async function judgeClip(clipBuffer, opts = {}) {
  const label = opts.label || 'videoJudge';
  const camera = String(opts.cameraMotion || 'push-in').replace(/[^a-z-]/g, '');
  const prompt = 'You are checking one short animated clip generated from a children\'s picture-book illustration. '
    + 'Watch the whole clip. Answer with strict JSON only, every field a boolean: '
    + '{"morphing": <the child\'s face, hands or body melt, deform or morph at any point>, '
    + '"identity_drift": <by the end the child reads as a DIFFERENT child than at the start — face, hair, skin tone, age or proportions changed>, '
    + '"outfit_change": <any garment, colour or pattern of the child\'s outfit changes during the clip>, '
    + '"new_character": <a person or creature that was not in the first frame appears>, '
    + '"text_appears": <legible letters, words, captions, signs or logos appear in any frame>, '
    + '"speech": <the child\'s mouth moves as if talking or singing>, '
    + '"frozen": <the clip is a near-still: no visible motion of the child at all>, '
    + `"camera_matches": <the camera move reads as "${camera}" (push-in = slowly closer, pull-out = slowly wider, pan-left/pan-right = slow horizontal pan, rise = slow tilt up, hold = no camera movement)>}`;
  try {
    const apiKey = getNextApiKey();
    const resp = await fetchWithTimeout(
      `${GEMINI_API}/${QA_MODEL()}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mimeType: 'video/mp4', data: clipBuffer.toString('base64') } }] }],
          generationConfig: jsonQaGenerationConfig(512, QA_MODEL()),
        }),
      },
      180000,
    );
    if (!resp.ok) return { defects: [], verdict: null, unavailable: `video judge HTTP ${resp.status}` };
    const data = await resp.json();
    if (opts.costTracker) opts.costTracker.addTextUsage(QA_MODEL(), 4000, 60);
    const json = parseJsonText(responseText(data));
    const bools = ['morphing', 'identity_drift', 'outfit_change', 'new_character', 'text_appears', 'speech', 'frozen', 'camera_matches'];
    if (!json || !bools.every(k => typeof json[k] === 'boolean')) return { defects: [], verdict: null, unavailable: 'video judge returned a malformed verdict' };
    const defects = [];
    if (json.morphing) defects.push('motion break: the face or body morphs or deforms during the clip');
    if (json.identity_drift) defects.push('identity drift: the child reads as a different child by the end of the clip');
    if (json.outfit_change) defects.push('outfit break: the outfit changes during the clip');
    if (json.new_character) defects.push('new character enters the clip');
    if (json.text_appears) defects.push('painted text in the illustration');
    if (json.speech) defects.push('speech: the child appears to talk');
    if (json.frozen) defects.push('frozen clip: no visible motion');
    if (json.camera_matches === false) defects.push(`composition break: the camera move does not read as the assigned ${camera}`);
    return { defects, verdict: json };
  } catch (err) {
    console.warn(`[${label}] video judge failed to run: ${err.message}`);
    return { defects: [], verdict: null, unavailable: `video judge errored: ${err.message}` };
  }
}

/**
 * Verify one candidate clip.
 * @param {object} p
 * @param {Buffer} p.buffer mp4 bytes
 * @param {string} p.dir temp dir (the clip is written there for frame extraction)
 * @param {string} p.label
 * @param {{index: number, seconds: number, kind: string}} p.segment
 * @param {object} p.brief
 * @param {object} p.checks pinned QA inputs: {sheet, outfitSpec, props, companion, beat, emotion}
 * @param {object} [p.costTracker]
 * @param {Function} [p.log]
 * @returns {Promise<{pass: boolean, defects: string[], blocking: string[], advisory: string[], frames: Array<{t: number, defects: string[], unavailable: string|null}>, judge: object, qaUnavailable?: string, score: number}>}
 */
async function verifyClip(p) {
  const log = p.log || (() => {});
  const file = path.join(p.dir, `${String(p.label).replace(/[^A-Za-z0-9_-]/g, '')}.mp4`);
  await fs.promises.writeFile(file, p.buffer);
  const times = sampleTimes(p.segment.seconds);
  let frames;
  try {
    frames = await extractFrames(file, times, { dir: p.dir });
  } catch (err) {
    log('warn', `${p.label}: frame extraction failed (${err.message})`);
    const unavailable = `frame extraction failed: ${err.message}`;
    return { pass: true, defects: [], blocking: [], advisory: [], frames: [], judge: { defects: [], verdict: null, unavailable }, qaUnavailable: unavailable, score: scoreCandidate({ qa: { pass: true, qaUnavailable: unavailable } }) };
  }
  const c = p.checks || {};
  const frameResults = [];
  for (const f of frames) {
    const r = await checkSpreadRenderV2(f.buffer, {
      label: `${p.label}@${f.t}s`,
      expectedText: null,
      shotType: null, // motion changes framing; the video judge checks the camera move instead
      outfitSpec: c.outfitSpec || null,
      sheet: c.sheet || null,
      props: c.props || [],
      companion: c.companion || null,
      beat: p.segment.kind === 'spread' ? (c.beat || null) : null,
      emotion: p.segment.kind === 'spread' ? (c.emotion || null) : null,
      emotionVocabulary: EMOTIONS,
    });
    frameResults.push({ t: f.t, defects: r.defects || [], unavailable: r.qaUnavailable || null });
  }
  const judge = await judgeClip(p.buffer, { cameraMotion: p.brief.cameraMotion, label: `${p.label}:judge`, costTracker: p.costTracker });
  const framesChecked = frameResults.filter(f => !f.unavailable).length;
  const defects = [...new Set([...frameResults.flatMap(f => f.defects), ...judge.defects])];
  const { blocking, advisory } = classifyClipDefects(defects);
  const qaUnavailable = framesChecked === 0 && judge.unavailable
    ? `no verdict: ${frameResults[0] ? frameResults[0].unavailable : 'no frames'}; ${judge.unavailable}`
    : undefined;
  const qa = { pass: defects.length === 0, blocking, advisory, ...(qaUnavailable ? { qaUnavailable } : {}) };
  return { pass: defects.length === 0, defects, blocking, advisory, frames: frameResults, judge, ...(qaUnavailable ? { qaUnavailable } : {}), score: scoreCandidate({ qa }) };
}

module.exports = { verifyClip, judgeClip, classifyClipDefects, sampleTimes, VIDEO_BLOCKING_PREFIXES };
