/**
 * Takes — candidates, verification, selection, bounded repair, replay
 * (ab-1, docs/AUDIOBOOK_V2_PLAN.md §4.3-4.4, §4.9): the ce-9 gate applied
 * to narration.
 *
 * A segment's lines are grouped into CHUNKS by speaker (the narrator's
 * lines, then a companion quote, then the narrator again); each chunk is
 * one synthesis unit keyed by its content hash
 * (`children-jobs/{bookId}/audiobook/{AUDIO_VERSION}/takes/{takeHash}/chunk{j}.wav`).
 * Every candidate keeps its own bytes (`.c{k}.wav`, repair pass P as
 * `.r{P}c{k}.wav`), is measured and transcribed, scored, and the best is
 * promoted to the canonical key with a `.qa.json` marker. The repair loop
 * runs ONLY while blocking defects remain, down a ladder whose last rung
 * is NO direction at all. Every candidate draws on ONE per-chunk budget.
 * A marker at the current AUDIO_QA_VERSION with no blocking list replays.
 */

const crypto = require('crypto');
const { AUDIO_VERSION, AUDIO_QA_VERSION } = require('../versions');
const { uploadBuffer, downloadBuffer, loadJson } = require('../../gcsStorage');
const { fnv1a } = require('../selection');
const { measureTake } = require('./metrics');
const { checkTake, repairNote, classifyTakeDefects } = require('./takeQa');
const { scoreTake, takeCandidateKey, pickBest, compareCandidates, residualBlocking } = require('./select');
const { directionWords, paceWords, controlWords, expectedTiming, normalizeSpoken } = require('./script');
const flags = require('../flags');

const RUNGS = ['full', 'restate', 'plain'];

/** @param {Buffer} buffer @returns {string} */
function contentHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

/**
 * Group a segment's lines into single-speaker chunks.
 * @param {{lines: object[]}} segment
 * @returns {Array<{index: number, speaker: string, lines: object[]}>}
 */
function chunkLines(segment) {
  const chunks = [];
  // A sound cue anchored on a line plays in the gap AFTER it — so that line
  // ends its chunk and the timeline can widen the gap (never over a word).
  const breakAfter = new Set((segment.sfx || []).map(s => s.anchorLine));
  let open = false;
  for (const line of segment.lines) {
    const last = chunks[chunks.length - 1];
    if (open && last && last.speaker === line.speaker) last.lines.push(line);
    else chunks.push({ index: chunks.length, speaker: line.speaker, lines: [line] });
    open = !breakAfter.has(line.index);
  }
  return chunks;
}

/**
 * The content hash a chunk's takes are keyed by.
 * @param {object} p
 * @returns {string}
 */
function takeHash({ chunk, voice, provider, language, aliasHash = 'none', tuningHash = 'none' }) {
  const basis = JSON.stringify({
    v: AUDIO_VERSION, provider, model: voice.model || null, voice: voice.hash, language, aliasHash, tuningHash,
    lines: chunk.lines.map(l => ({ t: l.text, d: l.direction, r: l.isRefrain, p: l.pauseAfterMs })),
  });
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

/**
 * The takes base for a book.
 * @param {string} bookId
 * @returns {string}
 */
function takesBase(bookId) {
  return `children-jobs/${bookId}/audiobook/${AUDIO_VERSION}/takes`;
}

/** @param {string} bookId @param {string} hash @param {number} chunkIndex @returns {string} */
function chunkKey(bookId, hash, chunkIndex) {
  return `${takesBase(bookId)}/${hash}/chunk${chunkIndex}.wav`;
}

/**
 * Render, verify, select and (if needed) repair one chunk.
 * @param {object} p
 * @param {string} p.bookId
 * @param {object} p.segment
 * @param {{index: number, speaker: string, lines: object[]}} p.chunk
 * @param {object} p.voice the cast entry for the chunk's speaker
 * @param {object} p.adapter
 * @param {string} p.provider
 * @param {{apiKey: string|null}} p.credentials
 * @param {string} p.language
 * @param {string} p.band
 * @param {string|null} [p.name] the child's name
 * @param {{status: string, alias: string|null}|null} [p.pronunciation]
 * @param {string|null} [p.tuning] audio tuning text (instruction-channel providers)
 * @param {object} p.costTracker
 * @param {(level: string, msg: string) => void} [p.log]
 * @param {() => void} [p.touch]
 * @param {AbortSignal} [p.signal]
 * @param {boolean} [p.forceRetake]
 * @param {{candidates?: number, maxRepairs?: number, budget?: number}} [p.opts]
 * @returns {Promise<object>}
 */
async function renderChunk({ bookId, segment, chunk, voice, adapter, provider, credentials, language, band, name = null, pronunciation = null, tuning = null, costTracker, log = () => {}, touch = () => {}, signal, forceRetake = false, opts = {} }) {
  const n = opts.candidates || flags.audioTakeCandidates();
  const maxRepairs = opts.maxRepairs ?? flags.audioMaxRepairs();
  const budget = opts.budget || flags.audioBudgetPerSegment();
  const alias = pronunciation && pronunciation.status === 'alias' ? pronunciation.alias : null;
  const aliasHash = alias ? fnv1a(alias).toString(36) : 'none';
  const tuningHash = tuning ? fnv1a(tuning).toString(36) : 'none';
  const hash = takeHash({ chunk, voice, provider, language, aliasHash, tuningHash });
  const canonical = chunkKey(bookId, hash, chunk.index);
  const label = `take:${segment.kind}${segment.spread ? segment.spread : ''}/c${chunk.index}`;
  const expectedText = chunk.lines.map(l => l.text).join(' ');
  const timing = expectedTiming(chunk.lines, band);
  const first = chunk.lines[0];
  const dWords = directionWords(first.direction, { refrain: first.isRefrain });
  const pWords = paceWords(first.direction.pace);
  const ctrl = controlWords();
  const nameInText = name && new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(expectedText) ? name : null;

  // ── Replay ──────────────────────────────────────────────────────────────
  if (!forceRetake) {
    const marker = await loadJson(`${canonical}.qa.json`).catch(() => null);
    if (marker && marker.audioQaVersion === AUDIO_QA_VERSION && (marker.adminPicked || !marker.unresolved) && (!opts.requireExactText || normalizeSpoken(marker.transcript) === normalizeSpoken(expectedText))) {
      const buffer = await downloadBuffer(canonical).catch(() => null);
      if (buffer && buffer.length > 44 && contentHash(buffer) === marker.renderHash) {
        log('info', `${label}: replays from ${canonical}${marker.adminPicked ? ' (admin-picked)' : ''}`);
        const measure = marker.measure || measureTake(buffer);
        return {
          chunk: chunk.index, speaker: chunk.speaker, lineIndexes: chunk.lines.map(l => l.index), storageKey: canonical, takeHash: hash, buffer, measure: { ...measure, samples: undefined },
          alignment: marker.alignment || null, transcript: marker.transcript || null, compare: marker.compare || null,
          qa: marker.adminPicked ? { blocking: [], advisory: [], qaUnavailable: null } : (marker.qa || { blocking: [], advisory: [], qaUnavailable: null }),
          score: marker.score ?? null, rung: marker.rung || null, candidates: 0, repairs: 0, cached: true, adminPicked: !!marker.adminPicked, candidateFiles: [], unresolved: false,
        };
      }
    }
  }

  // ── Candidates → verify → select → repair ───────────────────────────────
  let best = null;
  let repairs = 0;
  let spent = 0;
  let rung = 'full';
  let useAlias = !!alias;
  const all = [];
  for (let pass = 0; pass <= maxRepairs; pass++) {
    if (signal && signal.aborted) throw Object.assign(new Error('audiobook generation cancelled'), { failureCode: 'cancelled' });
    if (pass > 0) {
      const residual = residualBlocking(best);
      if (!best || residual.length === 0 || best.qa.qaUnavailable) break;
      const note = repairNote(residual, { directionWords: dWords, name: nameInText, alias });
      rung = note.rung === 'plain' ? 'plain' : (RUNGS[Math.min(RUNGS.length - 1, pass)] || 'plain');
      useAlias = useAlias || note.useAlias;
      repairs += 1;
    }
    const count = Math.min(n, budget - spent);
    if (count <= 0) { log('warn', `${label}: render budget exhausted (${budget})`); break; }
    const rendered = await Promise.all(Array.from({ length: count }, (_, i) => {
      const k = i + 1;
      const seed = adapter.supportsSeed ? fnv1a(`${hash}|${pass}|${k}`) : null;
      return adapter.synthesize({
        lines: chunk.lines, directionWords: dWords, paceWords: pWords, rung, voice, language, seed, tuning: rung === 'plain' ? null : tuning,
        aliases: useAlias && alias ? [{ name, alias }] : [], credentials, signal, pace: first.direction.pace,
      }).then(r => ({ k, ...r })).catch(err => ({ k, error: err }));
    }));
    spent += count;
    touch();
    for (const r of rendered) {
      const key = takeCandidateKey(canonical, r.k, pass);
      if (r.error) {
        if (r.error.failureCode === 'audiobook_provider_unavailable' || r.error.failureCode === 'audiobook_provider_input_rejected') throw r.error;
        log('warn', `${label}: candidate ${r.k} failed (${r.error.message})`);
        all.push({ k: r.k, pass, storageKey: key, error: r.error.message, score: null });
        continue;
      }
      if (costTracker && typeof costTracker.addAudioCharacters === 'function') costTracker.addAudioCharacters(`${provider}:${r.model}`, r.characters || expectedText.length);
      let measure;
      try { measure = measureTake(r.wav); } catch (err) { all.push({ k: r.k, pass, storageKey: key, error: `unreadable audio (${err.message})`, score: null }); continue; }
      const qa = await checkTake({ wav: r.wav, measure, expectedText, expectedSeconds: timing.expectedSeconds, directionWords: dWords, name: nameInText, alias: useAlias ? alias : null, controlWords: ctrl, expectedEmotion: first.direction.emotion, costTracker, signal, log });
      if (opts.requireExactText && normalizeSpoken(qa.transcript) !== normalizeSpoken(expectedText) && !qa.blocking.includes('narration text mismatch')) qa.blocking.push('narration text mismatch');
      const cand = {
        k: r.k, pass, storageKey: key, buffer: r.wav, rung, alignment: r.alignment || null, model: r.model,
        measure: { seconds: measure.seconds, trim: measure.trim, trimmedSeconds: measure.trimmedSeconds, lufs: measure.lufs, peakDb: measure.peakDb, truePeakDb: measure.truePeakDb, longestSilenceSeconds: measure.longestSilenceSeconds, sampleRate: measure.sampleRate },
        qa: { blocking: qa.blocking, advisory: qa.advisory, qaUnavailable: qa.qaUnavailable },
        transcript: qa.transcript, compare: qa.compare, judged: qa.judged, durationRatio: qa.durationRatio,
      };
      cand.score = scoreTake(cand);
      all.push({ k: r.k, pass, storageKey: key, score: cand.score, blocking: qa.blocking, advisory: qa.advisory, qaUnavailable: qa.qaUnavailable || null });
      uploadBuffer(r.wav, key, 'audio/wav').catch(err => log('warn', `${label}: candidate upload failed (${err.message})`));
      if (!best || compareCandidates(cand, best) > 0) best = cand;
      touch();
    }
    log('info', `${label}: pass ${pass} (${rung}) → ${rendered.filter(r => !r.error).length} judged, best ${best ? best.score : 'none'}${best && best.qa.blocking.length ? ` (blocking: ${best.qa.blocking.join(' | ')})` : ''}`);
    if (best && !best.qa.qaUnavailable && best.qa.blocking.length === 0) break;
  }
  if (!best) {
    const err = new Error(`${label}: no take came back (${all.map(c => c.error).filter(Boolean).slice(0, 2).join('; ') || 'no output'})`);
    err.failureCode = 'audiobook_render_failed';
    throw err;
  }

  // ── Promote ─────────────────────────────────────────────────────────────
  const unresolved = best.qa.blocking.length > 0;
  const renderHash = contentHash(best.buffer);
  await uploadBuffer(best.buffer, canonical, 'audio/wav');
  await uploadBuffer(Buffer.from(JSON.stringify({
    audioQaVersion: AUDIO_QA_VERSION, audioVersion: AUDIO_VERSION, takeHash: hash, renderHash, score: best.score,
    qa: best.qa, measure: best.measure, transcript: best.transcript, compare: best.compare, judged: best.judged, alignment: best.alignment,
    provider, model: best.model, voiceKey: voice.key, rung: best.rung, candidate: best.storageKey, pass: best.pass, repairs, unresolved, checkedAt: new Date().toISOString(),
  })), `${canonical}.qa.json`, 'application/json');
  return {
    chunk: chunk.index, speaker: chunk.speaker, lineIndexes: chunk.lines.map(l => l.index), storageKey: canonical, takeHash: hash, buffer: best.buffer, measure: best.measure,
    alignment: best.alignment, transcript: best.transcript, compare: best.compare, judged: best.judged,
    qa: best.qa, score: best.score, rung: best.rung, candidates: all.filter(c => c.score != null).length, repairs, cached: false, adminPicked: false,
    candidateFiles: all.filter(c => c.score != null).map(c => ({ storageKey: c.storageKey, score: c.score })), unresolved,
  };
}

/**
 * Render every chunk of a segment (sequentially — the chunks of one spread
 * are few and their order is the read's).
 * @param {object} p renderChunk's params minus `chunk`/`voice`, plus `cast`
 * @returns {Promise<{index: number, kind: string, spread: number|null, chunks: object[], unresolved: boolean, cached: boolean}>}
 */
async function renderSegment(p) {
  const { segment, cast } = p;
  const chunks = [];
  for (const chunk of chunkLines(segment)) {
    const voice = chunk.speaker === 'companion' && cast.companion ? cast.companion : cast.narrator;
    chunks.push(await renderChunk({ ...p, chunk, voice }));
  }
  return { index: segment.index, kind: segment.kind, spread: segment.spread, chunks, unresolved: chunks.some(c => c.unresolved), cached: chunks.every(c => c.cached) };
}

module.exports = { RUNGS, contentHash, chunkLines, takeHash, takesBase, chunkKey, renderChunk, renderSegment };
