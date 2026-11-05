'use strict';
/**
 * Auto captions: the words (cues), the animated ASS subtitles, the burn-in through the renderer (real ffmpeg + libass),
 * the speech-to-text adapters, and storing / job plumbing. No speech engine is needed: engines are replaced by stand-ins.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');
const imp = (f) => import(pathToFileURL(path.join(REPO, 'js', 'shared', f)).href);
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function lib() {
  const C = await imp('captions.js');
  C.setCaptionTemplates(JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'caption-templates.json'), 'utf8')));
  return C;
}
const WORDS = 'So today I want to talk about how you can double your reach without posting more content every single day'.split(' ').map((w, i) => ({ s: 1 + i * 0.4, e: 1 + i * 0.4 + 0.35, w }));

// ── cues ───────────────────────────────────────────────────────────────────────────────
test('words become readable caption lines, which can be edited, split, merged and searched', async () => {
  const C = await lib();
  const cues = C.groupWordsIntoCues([...WORDS, { s: 40, e: 40.4, w: 'After' }, { s: 40.4, e: 40.8, w: 'a' }, { s: 40.8, e: 41.2, w: 'pause.' }]);
  assert.ok(cues.length >= 2 && cues.every((c) => c.words.length <= 10));
  assert.equal(cues[cues.length - 1].text, 'After a pause.', 'a long silence starts a new line');
  // fixing a typo keeps the word timings; changing the word count re-spreads them
  const c0 = cues[0];
  const fixed = C.setCueText(c0, c0.text.replace('So', 'Sooo'));
  assert.equal(fixed.words[0].w, 'Sooo'); assert.equal(fixed.words[1].s, c0.words[1].s);
  const longer = C.setCueText(c0, `${c0.text} extra`);
  assert.equal(longer.words, undefined); assert.equal(C.cueWords(longer).length, c0.words.length + 1);
  const [a, b] = C.splitCue(c0, 3);
  assert.equal(a.words.length, 3); assert.equal(C.mergeCues(a, b).text, c0.text);
  const r = C.replaceInCues(cues, 'today', 'tonight');
  assert.equal(r.count, 1); assert.match(r.cues[0].text, /tonight/);
  assert.equal(C.replaceInCues(cues, 'to', 'X').count >= 1, true);
  assert.equal(C.replaceInCues([{ s: 0, e: 1, text: 'rather than that' }], 'the', 'X').count, 0, 'whole words only');
});

test('.srt and .vtt files are read, and written back', async () => {
  const C = await lib();
  const srt = '\uFEFF1\r\n00:00:01,000 --> 00:00:03,500\r\n<i>Hello</i> there\r\nfriend\r\n\r\n2\r\n00:01:05,250 --> 00:01:07,000\r\nSecond &amp; last\r\n';
  const cues = C.parseSubtitles(srt);
  assert.deepEqual(cues.map((c) => [c.s, c.e, c.text]), [[1, 3.5, 'Hello there friend'], [65.25, 67, 'Second & last']]);
  const vtt = 'WEBVTT\n\n00:01.500 --> 00:03.000 align:center\nShort form\n\n01:00:00.000 --> 01:00:02.000\nHours\n';
  assert.deepEqual(C.parseSubtitles(vtt).map((c) => [c.s, c.e, c.text]), [[1.5, 3, 'Short form'], [3600, 3602, 'Hours']]);
  assert.deepEqual(C.parseSubtitles(C.cuesToSrt(cues)).map((c) => [c.s, c.e, c.text]), [[1, 3.5, 'Hello there friend'], [65.25, 67, 'Second & last']]);
  assert.deepEqual(C.parseSubtitles('nothing useful here'), []);
});

test('looks are cleaned, built-in ones come from the JSON, saved ones can never shadow them', async () => {
  const C = await lib();
  const st = C.normalizeCaptionStyle({ font: 'comic-sans', size: 99, color: 'red', y: -4, wordsPerPage: 0, animIn: 'explode', highlight: 'color' });
  assert.equal(st.font, 'poppins'); assert.equal(st.size, 16); assert.equal(st.color, '#ffffff'); assert.equal(st.y, 6); assert.equal(st.wordsPerPage, 1); assert.equal(st.animIn, 'pop');
  const sys = C.captionTemplates();
  assert.ok(sys.length >= 8 && sys.every((t) => t.system && JSON.stringify(t.style) === JSON.stringify(C.normalizeCaptionStyle(t.style))));
  const user = C.normalizeUserTemplates([{ id: sys[0].id, label: 'Fake', style: {} }, { id: 'u1', label: ' Mine ', style: { size: 5 } }, { label: '' }]);
  assert.deepEqual(user.map((t) => t.id), ['u1']);
  C.setCaptionTemplates(JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'caption-templates.json'), 'utf8')));
});

test('pages, line breaks and the ASS script', async () => {
  const C = await lib();
  const cues = C.groupWordsIntoCues(WORDS);
  const style = { ...C.defaultCaptionStyle(), wordsPerPage: 3 };
  const pages = C.pagesOf(cues, style);
  assert.ok(pages.every((p) => p.words.length <= 3));
  assert.equal(C.pageAt(pages, 1.1).words[0].w, 'So'); assert.equal(C.pageAt(pages, 0.2), null);
  const lay = C.layoutPage({ words: [{ w: 'a' }, { w: 'quite' }, { w: 'long' }, { w: 'caption' }, { w: 'indeed' }] }, { ...style, size: 9, uppercase: true, maxLines: 2 }, 1080);
  assert.ok(lay.lines.length <= 2 && lay.lines.flat().length === 5);
  const ass = C.buildAss({ cues, style, W: 1080, H: 1920, clipStart: 0, span: 10, speed: 1 });
  assert.match(ass, /PlayResX: 1080/); assert.match(ass, /Dialogue: 0,0:00:01\.00/);
  assert.equal(C.buildAss({ cues, style, W: 1080, H: 1920, clipStart: 500, span: 10, speed: 1 }), '', 'nothing from this part of the video: no subtitles');
  // a clip that starts at 5s and plays 2x: the word at source 5.4s shows at 0.2s of the clip
  const fast = C.buildAss({ cues, style: { ...style, highlight: 'none', animIn: 'none', wordsPerPage: 12 }, W: 1080, H: 1920, clipStart: 5, span: 6, speed: 2 });
  const first = /Dialogue: 0,(\d+:\d\d:\d\d\.\d\d),(\d+:\d\d:\d\d\.\d\d)/.exec(fast);
  assert.equal(first[1], '0:00:00.00', 'a page already under way when the clip begins starts at 0');
  assert.ok(Number(first[2].split(':')[2]) <= 3, 'times are divided by the speed');
  // braces / backslashes in a person's text can never become subtitle commands
  const evil = C.buildAss({ cues: [{ s: 0, e: 2, text: 'x {\\fs999} y\\Nz' }], style: { ...style, highlight: 'none', reveal: 'page' }, W: 1080, H: 1920, clipStart: 0, span: 3 });
  const text = evil.split('[Events]')[1].split('\n').find((l) => l.startsWith('Dialogue')).replace(/^[^{]*\{[^}]*\}/, ''); // after the line's own tags
  assert.doesNotMatch(text, /[{}\\]/, 'a person\'s braces and backslashes are removed, so they cannot become subtitle commands');
});

// ── speech engines ───────────────────────────────────────────────────────────────────────
test('the engines\' outputs are understood', () => {
  const { parseWhisperCppJson, parseOpenAiVerbose, parseHelperJson } = require(path.join(ROOT, 'src', 'media', 'transcriber.js'));
  const cpp = { transcription: [{ offsets: { from: 1200, to: 1500 }, text: ' Hello' }, { offsets: { from: 1500, to: 1900 }, text: ' world,' }, { offsets: { from: 2000, to: 2600 }, text: ' [BLANK_AUDIO]' }, { offsets: { from: 3000, to: 4000 }, text: ' two words' }] };
  const w = parseWhisperCppJson(cpp);
  assert.deepEqual(w.slice(0, 2).map((x) => [x.s, x.e, x.w]), [[1.2, 1.5, 'Hello'], [1.5, 1.9, 'world,']]);
  assert.equal(w.length, 4, 'sound-effect markers are dropped and a two-word segment is split');
  assert.deepEqual(parseOpenAiVerbose({ words: [{ word: 'Hi', start: 0.5, end: 0.9 }, { word: ' ', start: 1, end: 1 }] }, 600).map((x) => [x.s, x.e, x.w]), [[600.5, 600.9, 'Hi']]);
  assert.deepEqual(parseHelperJson({ words: [{ s: 1, e: 2, w: ' ok ' }, { s: 2, e: 3, w: '' }] }), [{ s: 1, e: 2, w: 'ok' }]);
});

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const havePython = spawnSync('python3', ['--version']).status === 0;
const tmp = (t, p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const config = (extra = {}) => {
  const { load } = require(path.join(ROOT, 'src', 'config'));
  const c = load({ ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'capcfg-')) });
  c.rootDir = REPO; Object.assign(c.captions, extra); return c;
};

test('engine selection: says plainly when nothing is set up, and uses what is', { skip: !haveFfmpeg }, async () => {
  const { createTranscriber } = require(path.join(ROOT, 'src', 'media', 'transcriber.js'));
  const ff = { bins: { ffmpeg: 'ffmpeg' }, probe: async () => ({ duration: 10 }) };
  const none = await createTranscriber({ ff, config: config({ engine: 'auto', python: 'definitely-not-python', cppBin: '', openaiKey: '' }), logger: silent }).status();
  assert.equal(none.ready, false); assert.match(none.hint, /pip install faster-whisper/);
  await assert.rejects(() => createTranscriber({ ff, config: config({ engine: 'auto', python: 'definitely-not-python' }), logger: silent }).transcribe('x.mp4'), (e) => e.status === 503 && e.code === 'engine-missing');
  assert.equal((await createTranscriber({ ff, config: config({ engine: 'openai-api', openaiKey: 'sk-test' }), logger: silent }).status()).ready, true);
  assert.equal((await createTranscriber({ ff, config: config({ engine: 'off' }), logger: silent }).status()).ready, false);
});

test('the faster-whisper helper script runs end to end (with a stand-in for the package)', { skip: !(haveFfmpeg && havePython) }, async (t) => {
  const d = tmp(t, 'fw-');
  fs.mkdirSync(path.join(d, 'faster_whisper'));
  fs.writeFileSync(path.join(d, 'faster_whisper', '__init__.py'), `
class W:
    def __init__(s, w, st, e): s.word, s.start, s.end = w, st, e
class Seg:
    def __init__(s): s.words = [W(' Hello', 0.5, 0.9), W(' there', 0.9, 1.3)]; s.end = 1.3
class Info:
    duration = 2.0; language = 'en'
class WhisperModel:
    def __init__(s, name, device='auto', compute_type='auto'): s.name = name
    def transcribe(s, audio, **kw): return iter([Seg()]), Info()
`);
  const { createTranscriber } = require(path.join(ROOT, 'src', 'media', 'transcriber.js'));
  process.env.PYTHONPATH = d; t.after(() => { delete process.env.PYTHONPATH; });
  const video = path.join(d, 'v.mp4');
  assert.equal(spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=4', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=4', '-shortest', video]).status, 0);
  const progress = [];
  const tr = createTranscriber({ ff: { bins: { ffmpeg: 'ffmpeg' }, probe: async () => ({ duration: 4 }) }, config: config({ engine: 'faster-whisper', python: 'python3' }), logger: silent });
  assert.equal((await tr.status()).engine, 'faster-whisper');
  const r = await tr.transcribe(video, { rangeStart: 10, rangeEnd: 14, language: 'en', onProgress: (f) => progress.push(f) });
  assert.deepEqual(r.words.map((w) => [w.s, w.e, w.w]), [[10.5, 10.9, 'Hello'], [10.9, 11.3, 'there']], 'times are put back on the video\'s own timeline');
  assert.equal(r.language, 'en'); assert.ok(progress.length >= 1);
});

// ── burn-in with real ffmpeg ────────────────────────────────────────────────────────────
test('captions are burned into a rendered clip at the right moments (with a speed change)', { skip: !haveFfmpeg, timeout: 240000 }, async (t) => {
  const C = await lib();
  const { createFfmpeg } = require(path.join(ROOT, 'src', 'media', 'ffmpeg.js'));
  const { createRenderer } = require(path.join(ROOT, 'src', 'media', 'renderer.js'));
  const cfg = config(); cfg.ffmpeg.crf = 30;
  const dir = tmp(t, 'capr-');
  const ff = createFfmpeg(cfg, null);
  await ff.detectCapabilities();
  assert.ok(ff.caps.filters.ass, 'this ffmpeg can draw subtitles');
  const renderer = createRenderer({ ff, config: cfg, logger: null });
  const input = path.join(dir, 'src.mp4');
  assert.equal(spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:r=30:d=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input]).status, 0);
  const src = await ff.probe(input);
  // one caption on screen from 3s to 5s of the SOURCE; the clip is cut from 2s, 8s long, played at 2x (so 4s long)
  const cues = [{ s: 3, e: 5, text: 'HELLO FROM THE CLIP' }];
  const style = { ...C.captionTemplates().find((x) => x.id === 'clean-box').style, animIn: 'none', animOut: 'none' };
  const brightAt = async (file, sec) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(sec), '-i', file, '-frames:v', '1', '-vf', 'crop=iw:ih/3:0:ih*0.55,scale=32:16', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 20 });
    return Math.max(...r.stdout);
  };
  const go = async (name, captions) => {
    const outFile = path.join(dir, `${name}.mp4`);
    const res = await renderer.render({ src: { ...src, maxKeyframeGap: 1 }, inputFile: input, start: 2, duration: 8, outFile, aspectRatio: '9:16', profile: 'turbo', audio: { originalVolume: 1, normalize: false, bgm: null }, adjust: { speed: 2 }, captions }, { workDir: dir });
    return { outFile, res };
  };
  const plain = await go('plain', null);
  const withCaps = await go('caps', { style, cues });
  assert.deepEqual(withCaps.res.warnings, []);
  assert.ok(Math.abs(withCaps.res.duration - 4) < 0.6, `speed 2x: ${withCaps.res.duration}s`);
  // source 3s..5s -> clip (3-2)/2 = 0.5s .. 1.5s: text is there at 1.0s, not at 0.1s and not at 2.5s
  const lo = await brightAt(plain.outFile, 1.0);
  assert.ok((await brightAt(withCaps.outFile, 1.0)) > lo + 60, 'the caption is on screen at 1.0s');
  assert.ok(Math.abs((await brightAt(withCaps.outFile, 0.1)) - (await brightAt(plain.outFile, 0.1))) < 25, 'nothing at 0.1s');
  assert.ok(Math.abs((await brightAt(withCaps.outFile, 2.5)) - (await brightAt(plain.outFile, 2.5))) < 25, 'gone again by 2.5s');
  // the temporary subtitle file is cleaned up
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.ass')), []);
});

test('a Windows-style path is escaped for the filter', async () => {
  const { buildPlan } = require(path.join(ROOT, 'src', 'media', 'renderer.js'));
  const fr = await import(pathToFileURL(path.join(REPO, 'js', 'shared', 'framing.js')).href);
  const caps = { ok: true, filters: { ass: true, loudnorm: true, afade: true, alimiter: true, sidechaincompress: true, amix: true, gblur: true }, amixHasNormalize: true };
  const cfg = { ffmpeg: { crf: 20, preset: 'veryfast', loudnormTarget: -16, clipConcurrency: 1, threads: 0 } };
  const spec = { src: { width: 1280, height: 720, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', maxKeyframeGap: 2 }, inputFile: 'in.mp4', start: 0, duration: 10, outFile: 'o.mp4', aspectRatio: '9:16', audio: { originalVolume: 1, normalize: true }, reEncode: true };
  const p = buildPlan(spec, { framing: fr, captions: { file: 'C:\\Users\\Me\\AppData\\Local\\Temp\\caps_1.ass', fontsDir: "C:\\app's\\fonts" }, caps, config: cfg });
  const fc = p.args[p.args.indexOf('-filter_complex') + 1];
  assert.match(fc, /\[vcapin\]ass=filename='C\\:\/Users\/Me\/AppData\/Local\/Temp\/caps_1\.ass':fontsdir='C\\:\/app\\'s\/fonts'\[vout\]/);
  const without = buildPlan(spec, { framing: fr, caps, config: cfg });
  assert.doesNotMatch(without.args.join(' '), /vcapin|ass=/, 'a clip without captions is made exactly as before');
});

// ── storage, tasks and jobs ──────────────────────────────────────────────────────────────
function makeStore(dataDir, { render, transcriber } = {}) {
  const { load } = require(path.join(ROOT, 'src', 'config'));
  const { Store } = require(path.join(ROOT, 'src', 'db'));
  const { createCloudStore } = require(path.join(ROOT, 'src', 'services', 'cloudStore'));
  const cfg = load({ ...process.env, DATA_DIR: dataDir }); cfg.rootDir = REPO;
  fs.mkdirSync(cfg.dirs.data, { recursive: true });
  const db = new Store(cfg.dbFile, { logger: silent });
  const seen = [];
  const renderer = { prepareBgm: async () => ({ bgm: null, cleanup: async () => {} }), render: render || (async (spec) => { seen.push(spec); fs.writeFileSync(spec.outFile, Buffer.alloc(4096, 7)); return { duration: spec.duration, size: 4096, mode: 'encode', warnings: [] }; }) };
  const cloud = createCloudStore({ db, config: cfg, logger: silent, ff: { probe: async () => ({ duration: 10 }) }, renderer, bgmStore: { cleanup: async () => 0, get() { throw new Error('none'); } }, overlayStore: null, transcriber });
  db.collection('cloud_uploads').upsert({ id: 'u1', filePath: path.join(dataDir, 'src.mp4'), name: 'a.mp4', size: 100, ranges: [[0, 100]], probed: true, duration: 600, width: 1920, height: 1080, hasAudio: true, createdAt: Date.now(), updatedAt: Date.now() });
  return { cloud, db, seen, cfg };
}
async function until(fn, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(20); } throw new Error('timed out waiting'); }

test('caption words are saved next to the video, cleaned, and replaced as a whole', async (t) => {
  const { cloud } = makeStore(path.join(tmp(t, 'capst-'), 'data'));
  assert.deepEqual((await cloud.readCaptions('u1')).cues, []);
  const saved = await cloud.saveCaptions('u1', { cues: [{ s: 5, e: 6, text: ' second ' }, { s: 1, e: 2, text: 'first' }, { s: 3, e: 3, text: '' }, 'junk'], language: 'en' });
  assert.deepEqual(saved.cues.map((c) => c.text), ['first', 'second']);
  assert.equal((await cloud.readCaptions('u1')).language, 'en');
  await assert.rejects(() => cloud.saveCaptions('nope', { cues: [] }), (e) => e.status === 400);
});

test('finding the words runs as a task and fills in the captions; part of a video keeps the rest', async (t) => {
  let calls = 0;
  const transcriber = {
    status: async () => ({ engine: 'fake', ready: true }),
    transcribe: async (file, { rangeStart, rangeEnd, onProgress }) => { calls++; onProgress(0.5); const base = rangeStart || 0; return { words: [{ s: base + 1, e: base + 1.4, w: 'Hello' }, { s: base + 1.4, e: base + 1.9, w: 'world' }], language: 'en', engine: 'fake' }; },
  };
  const { cloud } = makeStore(path.join(tmp(t, 'capt-'), 'data'), { transcriber });
  assert.equal((await cloud.captionEngine()).ready, true);
  const task = await cloud.startTranscription('u1', { language: 'en' });
  assert.equal((await cloud.startTranscription('u1', {})).taskId, task.taskId, 'asking again while it works gives the same task');
  const done = await until(() => { const v = cloud.getTranscription(task.taskId); return v.status === 'done' && v; });
  assert.equal(done.cueCount, 1);
  assert.deepEqual((await cloud.readCaptions('u1')).cues.map((c) => c.text), ['Hello world']);
  // do 100s-130s only: the earlier words stay
  const t2 = await cloud.startTranscription('u1', { rangeStart: 100, rangeEnd: 130 });
  await until(() => cloud.getTranscription(t2.taskId).status === 'done');
  assert.deepEqual((await cloud.readCaptions('u1')).cues.map((c) => [c.s, c.text]), [[1, 'Hello world'], [101, 'Hello world']]);
  assert.equal(calls, 2);
  await assert.rejects(async () => cloud.getTranscription('cap_nope'), (e) => e.status === 404);
});

test('a missing engine and a failing engine are reported to the person, not swallowed', async (t) => {
  const failing = { status: async () => ({ ready: true, engine: 'fake' }), transcribe: async () => { throw Object.assign(new Error('The engine is not set up.'), { code: 'engine-missing' }); } };
  const { cloud } = makeStore(path.join(tmp(t, 'capf-'), 'data'), { transcriber: failing });
  const task = await cloud.startTranscription('u1', {});
  const v = await until(() => { const x = cloud.getTranscription(task.taskId); return x.status === 'failed' && x; });
  assert.equal(v.errorCode, 'engine-missing'); assert.match(v.error, /not set up/);
  const { cloud: bare } = makeStore(path.join(tmp(t, 'capn-'), 'data'));
  assert.equal((await bare.captionEngine()).ready, false);
  await assert.rejects(() => bare.startTranscription('u1', {}), (e) => e.status === 503);
});

test('a job hands every clip only the caption words from its own stretch of the video', async (t) => {
  const { cloud, seen } = makeStore(path.join(tmp(t, 'capj-'), 'data'));
  await cloud.saveCaptions('u1', { cues: [{ s: 2, e: 4, text: 'in the first clip' }, { s: 34, e: 36, text: 'in the second clip' }, { s: 100, e: 102, text: 'in neither' }] });
  const style = { font: 'inter', size: 6 };
  const id = cloud.createJob({ uploadId: 'u1', candidates: [{ start: 0, duration: 30 }, { start: 30, duration: 30 }], reEncode: true, aspectRatio: '9:16', overlayFormat: 'none', captions: { enabled: true, style } }, 'http://x');
  await until(() => cloud.getJob(id).status === 'done');
  const byStart = Object.fromEntries(seen.map((s) => [s.start, s.captions]));
  assert.deepEqual(byStart[0].cues.map((c) => c.text), ['in the first clip']);
  assert.deepEqual(byStart[30].cues.map((c) => c.text), ['in the second clip']);
  assert.equal(byStart[0].style.font, 'inter');
  // captions switched off: nothing is handed over
  seen.length = 0;
  const off = cloud.createJob({ uploadId: 'u1', candidates: [{ start: 0, duration: 30 }], reEncode: true, aspectRatio: '9:16', overlayFormat: 'none', captions: { enabled: false, style } }, 'http://x');
  await until(() => cloud.getJob(off).status === 'done');
  assert.equal(seen[0].captions, null);
});
