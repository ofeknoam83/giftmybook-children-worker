/** Offline encode/mix/concat test; set FFMPEG_PATH to run against a real binary. */
const fs = require('fs');
const path = require('path');
const { speechShots, shotCommand, finishCommand } = require('../../../../services/catalogEngine/video/filmMedia');
const { encodeWav, parseWav } = require('../../../../services/catalogEngine/audio/wav');
const { buildMixCommand } = require('../../../../services/catalogEngine/audio/mix');
const ffmpeg = require('../../../../services/catalogEngine/video/ffmpeg');

const run = process.env.FFMPEG_PATH ? test : test.skip;
run('a real full-length encode retains the final spoken audio and measured duration across cuts', async () => {
  const dir = await ffmpeg.makeTempDir('film-test');
  try {
    const sr = 24000;
    const wave = Float32Array.from({ length: sr * 31 }, (_, i) => Math.sin(i / sr * 2 * Math.PI * 440) * 0.1);
    const shots = speechShots(encodeWav(wave, sr));
    let at = 0; const takes = [];
    for (let i = 0; i < shots.length; i++) {
      const audio = path.join(dir, `voice-${i}.wav`); const source = path.join(dir, `source-${i}.mp4`);
      await fs.promises.writeFile(audio, shots[i].buffer);
      await ffmpeg.runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30', '-t', String(shots[i].seconds), '-c:v', 'libx264', '-preset', 'ultrafast', source]);
      await ffmpeg.runFfmpeg(shotCommand({ video: source, audio, output: path.join(dir, `shot-${i}.mkv`), seconds: shots[i].seconds, width: 160, height: 90 }));
      takes.push({ path: audio, at, trim: { start: 0, end: shots[i].seconds }, lufs: -23 }); at += shots[i].seconds;
    }
    const master = path.join(dir, 'master.wav');
    const score = path.resolve(__dirname, '../../../../services/catalogEngine/data/audio/fallback/ambient-light.mp3');
    await ffmpeg.runFfmpeg(buildMixCommand({ timeline: { totalSeconds: at }, takes, music: [{ path: score, from: 0, to: at, gainDb: -18, fadeIn: 1, fadeOut: 1 }], outputs: { master } }).args);
    const list = path.join(dir, 'shots.txt'); await fs.promises.writeFile(list, shots.map((_, i) => `file 'shot-${i}.mkv'`).join('\n'));
    const output = path.join(dir, 'film.mp4');
    await ffmpeg.runFfmpeg(finishCommand({ list, soundtrack: master, output, seconds: at }));
    const probe = await ffmpeg.probeVideo(output);
    expect(probe.durationSeconds).toBeCloseTo(at, 1);
    expect(probe.durationSeconds).toBeGreaterThan(31);
    const decodedFile = path.join(dir, 'decoded.wav');
    await ffmpeg.runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', output, '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', decodedFile]);
    const decoded = parseWav(await fs.promises.readFile(decodedFile));
    // The final second of speech, not just the beginning, is audible in the final MP4.
    const tail = decoded.samples.subarray(Math.floor((at - 1.2) * sr), Math.floor((at - 0.7) * sr));
    const rms = Math.sqrt(tail.reduce((sum, n) => sum + n * n, 0) / tail.length);
    expect(rms).toBeGreaterThan(0.03);
  } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
}, 120000);
