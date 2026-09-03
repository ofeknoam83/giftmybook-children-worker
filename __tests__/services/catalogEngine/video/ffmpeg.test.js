/**
 * ffmpeg builders (gv-1): pure argv snapshots (no drawtext, exact total,
 * xfade offsets, blur-fill per segment, silent vs music track), the probe
 * parser, and — when FFMPEG_PATH points at a real binary — an end-to-end
 * stitch of synthetic clips measured with the probe.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildStitchCommand, buildFrameCommand, buildPosterCommand, parseProbe, probeVideo, runFfmpeg, extractFrames } = require('../../../../services/catalogEngine/video/ffmpeg');

const four = () => [{ path: 'a.mp4', seconds: 2.4 }, { path: 'b.mp4', seconds: 3.0 }, { path: 'c.mp4', seconds: 3.0 }, { path: 'd.mp4', seconds: 2.8 }];

describe('buildStitchCommand', () => {
  test('four segments → exactly 10.000 s, xfade offsets from the table, no drawtext', () => {
    const { args, totalSeconds } = buildStitchCommand({ segments: four(), output: 'out.mp4' });
    expect(totalSeconds).toBe(10);
    const joined = args.join(' ');
    expect(joined).not.toContain('drawtext');
    expect(args.slice(-2)).toEqual(['10.000', 'out.mp4']);
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('xfade=transition=fade:duration=0.4:offset=2.000[x1]');
    expect(graph).toContain('xfade=transition=fade:duration=0.4:offset=4.600[x2]');
    expect(graph).toContain('xfade=transition=fade:duration=0.4:offset=7.200[x3]');
    expect(graph).toContain('fade=t=out:st=9.500:d=0.5:color=white');
    expect(graph).toContain('gblur=sigma=40'); // blur-fill behind every segment
    expect(args).toContain('anullsrc=r=48000:cl=stereo');
    expect(args).toContain('+faststart');
    expect(args).toContain('yuv420p');
    // every clip input is trimmed to its planned seconds
    expect(args.slice(0, 20)).toEqual(expect.arrayContaining(['-t', '2.400', '-i', 'a.mp4', '-t', '3.000', '-i', 'b.mp4']));
  });
  test('a single segment is 10 s with no crossfade', () => {
    const { args, totalSeconds } = buildStitchCommand({ segments: [{ path: 'a.mp4', seconds: 10 }], output: 'o.mp4' });
    expect(totalSeconds).toBe(10);
    expect(args[args.indexOf('-filter_complex') + 1]).not.toContain('xfade');
  });
  test('a music bed replaces the silent track and fades', () => {
    const { args } = buildStitchCommand({ segments: four(), output: 'o.mp4', musicPath: '/m/bed.mp3' });
    expect(args).toContain('/m/bed.mp3');
    expect(args).not.toContain('anullsrc=r=48000:cl=stereo');
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('afade=t=out:st=8.500:d=1.5');
    expect(args[args.indexOf('-map', args.indexOf('-map') + 1) + 1]).toBe('[a]');
  });
  test('portrait frames build the same graph at 1080x1920', () => {
    const { args } = buildStitchCommand({ segments: four(), output: 'o.mp4', width: 1080, height: 1920 });
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('scale=1080:1920');
  });
  test('refuses an empty plan', () => {
    expect(() => buildStitchCommand({ segments: [], output: 'o.mp4' })).toThrow(/at least one segment/);
  });
  test('frame and poster commands seek to the timestamp', () => {
    expect(buildFrameCommand({ input: 'c.mp4', timeSeconds: 1.5, output: 'f.png' })).toEqual(expect.arrayContaining(['-ss', '1.500', '-i', 'c.mp4', '-frames:v', '1', 'f.png']));
    expect(buildPosterCommand({ input: 'v.mp4', timeSeconds: 1.2, output: 'p.jpg' })).toEqual(expect.arrayContaining(['-ss', '1.200', '-q:v', '2', 'p.jpg']));
  });
});

describe('parseProbe', () => {
  test('reads duration, size and fps from ffmpeg -i output', () => {
    const stderr = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'video.mp4':\n  Duration: 00:00:10.00, start: 0.000000, bitrate: 3143 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 3131 kb/s, 30 fps, 30 tbr, 15360 tbn (default)";
    expect(parseProbe(stderr)).toEqual({ durationSeconds: 10, width: 1920, height: 1080, fps: 30 });
  });
});

const FF = process.env.FFMPEG_PATH;
(FF && fs.existsSync(FF) ? describe : describe.skip)('end to end with a real ffmpeg (FFMPEG_PATH)', () => {
  jest.setTimeout(240000);
  let dir;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-ffmpeg-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('stitches four synthetic clips into a 10.000 s 1080p30 film and extracts frames', async () => {
    const clips = [];
    const colours = ['red', 'green', 'blue', 'orange'];
    const seconds = [2.4, 3.0, 3.0, 2.8];
    for (let i = 0; i < 4; i++) {
      const file = path.join(dir, `clip-${i}.mp4`);
      // a 4 s clip; the second one is square to exercise the blur-fill path
      const size = i === 1 ? '640x640' : '1280x720';
      execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${colours[i]}:s=${size}:r=24:d=4`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
      clips.push({ path: file, seconds: seconds[i] });
    }
    const output = path.join(dir, 'video.mp4');
    const { args, totalSeconds } = buildStitchCommand({ segments: clips, output, fps: 30 });
    expect(totalSeconds).toBe(10);
    await runFfmpeg(args, { timeoutMs: 200000 });
    const probe = await probeVideo(output);
    expect(probe.durationSeconds).toBe(10);
    expect(probe.width).toBe(1920);
    expect(probe.height).toBe(1080);
    expect(probe.fps).toBe(30);
    const frames = await extractFrames(clips[0].path, [0, 1.5, 3.9], { dir });
    expect(frames).toHaveLength(3);
    for (const f of frames) expect(f.buffer.slice(1, 4).toString()).toBe('PNG');
  });
});
