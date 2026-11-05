'use strict';
/**
 * Turns a raw failure (an ffmpeg message, a Node error) into something a person can act on, and says whether the server can
 * put it right by itself and try again.
 *
 *   explain(message) -> { code, title, advice, healable }
 *
 * `healable`: worth repairing and trying once more automatically (a damaged temporary file, a file another program held for a
 * moment). Everything else is reported with what to do about it. The raw text is always kept as the "technical details".
 */

const RULES = [
  { code: 'canceled', test: /^(cancelled|canceled|stopped|aborted)$|The user aborted/i, title: 'Stopped.', advice: '', healable: false },
  { code: 'source-missing', test: /Invalid uploadId|upload (was )?not found/i, title: 'The original video is no longer on the server.', advice: 'It will be sent again from the browser if it is still there; otherwise upload the video again.', healable: false },
  { code: 'layer-damaged', test: /(moov atom not found|Invalid data found when processing input|End of file|Error while decoding)[\s\S]*\blt_[0-9a-f]{8,}\.mov|\blt_[0-9a-f]{8,}\.mov[\s\S]*(moov atom not found|Invalid data found)/i,
    title: 'A saved lower-third animation file was damaged (an earlier run was probably interrupted).', advice: 'It has been deleted and is drawn again.', healable: true },
  { code: 'disk-full', test: /ENOSPC|No space left on device|not enough space|disk (is )?full/i, title: 'The computer ran out of disk space.', advice: 'Free some space on the drive that holds the ClipperIQ "data" folder, then press Retry. Finished clips are kept.', healable: false },
  { code: 'file-locked', test: /\b(EBUSY|EPERM|EACCES|EMFILE|ENFILE)\b|Permission denied|being used by another process|resource busy/i, title: 'A file was held by another program for a moment (often antivirus or a backup tool).', advice: 'It is tried again automatically. If it keeps happening, exclude the ClipperIQ "data" folder from antivirus scanning.', healable: true },
  { code: 'out-of-memory', test: /Cannot allocate memory|out of memory|ENOMEM|heap out of memory|std::bad_alloc|Memory allocation/i, title: 'The computer ran out of memory.', advice: 'Close other programs, set CLIP_CONCURRENCY=1 in .env (one clip at a time) and restart the server, then press Retry.', healable: false },
  { code: 'encoder-problem', test: /Unknown encoder|Encoder .* not found|Error initializing output stream|Could not open encoder|Cannot load nvcuda|nvenc|amf|qsv|videotoolbox/i, title: 'The video encoder could not start.', advice: 'Set VIDEO_ENCODER=libx264 in .env (the software encoder that works everywhere), restart the server and press Retry.', healable: false },
  { code: 'canvas-missing', test: /canvas module is not installed/i, title: 'The lower thirds need a component that is not installed.', advice: 'Run "npm install" in the server folder (the lower thirds use @napi-rs/canvas) and restart the server. Clips without lower thirds are not affected.', healable: false },
  { code: 'subtitles-missing', test: /No such filter: 'ass'|subtitle support \(libass\)/i, title: 'This ffmpeg cannot draw captions.', advice: 'Use an ffmpeg build with libass (the standard builds have it), or turn captions off.', healable: false },
  { code: 'source-damaged', test: /moov atom not found|Invalid data found when processing input|Error opening input|Truncated|corrupt/i, title: 'The video file looks damaged or incomplete.', advice: 'Upload it again (a copy that was not fully sent, or a damaged download, cannot be read).', healable: false },
  { code: 'file-missing', test: /ENOENT|No such file or directory/i, title: 'A file the clip needed was missing.', advice: 'A temporary file was probably cleaned up while it was in use. It is tried again automatically.', healable: true },
  { code: 'process-crashed', test: /exited with code (3221225477|3221226505|3221225786|-1073740791|139|134|137)|SIGSEGV|SIGKILL|Segmentation fault/i, title: 'ffmpeg stopped unexpectedly.', advice: 'It is tried again automatically. If it keeps happening, set CLIP_CONCURRENCY=1 and VIDEO_ENCODER=libx264 in .env.', healable: true },
  { code: 'took-too-long', test: /took too long|timed out|ETIMEDOUT/i, title: 'The step took too long and was stopped.', advice: 'Press Retry. For very long videos choose the Turbo speed.', healable: true },
];

function explain(message) {
  const text = String((message && message.message) || message || '');
  for (const r of RULES) if (r.test.test(text)) return { code: r.code, title: r.title, advice: r.advice, healable: r.healable };
  return { code: 'unknown', title: 'Something unexpected stopped the clip.', advice: 'Press Retry (finished clips are kept). If it keeps happening, use "Copy error details" and send them along.', healable: false };
}

/** The raw message with the install folder shortened and cut to a sensible length (for "technical details"). */
function detailOf(message, rootDir = '') {
  let t = String((message && message.message) || message || '');
  if (rootDir) t = t.split(rootDir).join('...');
  return t.replace(/\s+/g, ' ').trim().slice(0, 700);
}

module.exports = { explain, detailOf, RULES };
