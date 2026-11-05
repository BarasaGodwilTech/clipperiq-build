# ClipperIQ Studio: video pipeline fixes

## Shortened videos
- Files whose clock restarts (stitched M3U8/HLS), jumps forward (ad breaks / dropped segments) or is
  squashed are now detected from the actual frames and repaired on upload. If a repair isn't possible
  the app shows a warning instead of cutting from the wrong place.

## Empty / wrong clips
- Fast Mode (stream copy) is only used when keyframes are <= 2.5s apart (it produced 600s clips with
  wrong content on sparse-keyframe files).
- Every rendered clip is verified (length, decodable, not all-black); a bad fast-copy clip is re-rendered
  by encoding; an unfixable clip fails with a clear message instead of saving a blank video.
- Browser re-downloads clips that arrive empty or cut short.
- Thumbnail generator rewritten (cards no longer stay on the clapperboard placeholder); unreadable clips
  show "Preview not available".

## Other fixes
- "Generating Part 1/1" label and progress bar (server now returns the total number of parts).
- Wrong part number on the shorter final part (now uses the stored number).
- Sub-second leftover clip at the end of a series is no longer created.
- Drag-and-drop now accepts .ts/.mkv etc. (blank MIME type); file picker lists them too.
- Clip length shown rounded (60s, not 215.022s). Temp overlay file no longer leaks on render errors.
- Clearer error for truncated/incomplete uploads.
- service-worker cache bumped to v20 (hard-refresh once after updating).

## Files changed
server/src/media/ffmpeg.js, server/src/media/renderer.js, server/src/services/cloudStore.js,
server/README.md, js/core/clipGenerator.js, js/ui/clips.js, js/ui/upload.js, index.html, service-worker.js

## Update 2
- Processing window no longer shows clips from an earlier, resumed job (it could show a stale "Part 1"
  from a previous upload while a new one was still uploading).
- The processing window now shows the length the server measured ("Video length 1:52:10 → 31 parts").
- service-worker cache bumped to v21.

## Update 3: speed
- Clips of a job now render in parallel (CLIP_CONCURRENCY; auto 1 / 2 / 3 by CPU cores), published strictly in
  order, with clean abort of the other renders if one fails. Encoder threads are split between parallel renders.
- Background music is loudness-normalised once per job instead of for every clip (same loudness, faster).
- Cheaper scaler (bicubic instead of lanczos) for downscaling.
- Uploads send 3 chunks at once (helps a lot with a remote server); status polling 1.5s -> 0.8s.
- Preview: scroll lock is balanced, Escape closes it. Verified: plays, closes 3 ways, download valid.
- Processing window shows accurate steps in cloud mode (Save to storage / Upload to server / Analyze video / Cut clips / Save clips).
- The detected video length now stays visible in the processing window ('Generating Part 3/9 · video 9:00'); part counter is clearer when continuing a series.

## Update 4: stuck at 60% / IDM
- Cause: download managers such as Internet Download Manager grab the app's request for each finished clip
  (a .mp4 URL) and hold it behind a dialog. The app waited forever on clip 1: progress frozen at 60%, no live
  preview, nothing in Clips. (Reproduced by simulating IDM, then verified fixed.)
- Clips are now downloaded in 4 MB pieces through a small POST endpoint (/api/cloud/clip-chunk, neutral content
  type, no .mp4 in the URL) that download managers leave alone. Each piece has a 30s stall timeout and retries;
  a retry continues where it stopped. Nothing can hang silently any more.
- If something still blocks the download, the app says so (and mentions IDM). Finished clips stay on the server:
  reload the page and processing resumes where it left off.
- Server reports smooth per-clip progress, so the bar moves during rendering instead of sitting at 60%.
- Tip: in IDM you can also add localhost to its exclusions (Options > General > "Don't start downloading
  automatically from the following sites") or disable its browser extension for localhost:3000.

## Update 5: clean clip start + series overlap
- Series mode: each part now starts 3 seconds BEFORE the previous part ended (like the original browser-only
  version): 30s clips become 0-30, 27-57, 54-84 ... Parts keep the full clip length; a tail with less than 1s of
  NEW video is not made into a part. The overlap shrinks automatically for very short clip lengths (max 25% of
  the clip). Applies to both cloud and in-browser processing (js/core/clipGenerator.js, SERIES_OVERLAP_SEC).
  Note: the overlap adds roughly 1 part per 9 (e.g. 90s at 30s clips = 4 parts instead of 3), which counts
  towards MAX_CLIPS_PER_JOB.
- Fast Mode (stream copy) clips started with a lag: the clip began at the previous keyframe (1-2 s early) and the
  picture ran ~80 ms behind the sound. The cut now begins exactly where asked, picture and sound in sync
  (-avoid_negative_ts disabled in server/src/media/renderer.js). Measured on test files: start offset 0 ms,
  A/V offset 0 ms (was ~80-100 ms). High Compatibility / overlay / 9:16 renders were already frame-exact and are unchanged.
- service-worker cache bumped to v26 (hard-refresh once after updating).

## Update 6: clips that start frozen, refresh-proof processing status
- Later clips opened on a frozen picture for up to ~1 s (sound was fine; the first clip never showed it). Cause:
  cutting in the middle of a video (.ts / streamed sources especially) starts decoding on a keyframe that is not
  a clean restart point, so the first frames are lost. Re-encoded clips now start decoding a few seconds earlier
  and trim the warm-up away inside the filter graph (server/src/media/renderer.js). Clips that start at 0:00 use
  exactly the same command as before; overlay and music timing are unchanged. Verified: clean sources identical to
  before, frozen start gone on the problem source, picture/sound within ~12 ms, frame-exact content.
- Processing status survives a page reload: the "Processing ... % - View" badge is back (and now shows on every
  screen), Recent Uploads rows show live progress, and clicking a row opens an upload details window (steps, parts
  rendered/saved, clips so far, errors). New file: js/ui/processingStatus.js. Progress events come from
  clipGenerator (clip:job-progress), so they work for resumed jobs too.
- If the browser cannot reach the server for a moment (up to 5 min) the page keeps retrying instead of giving up, and a
  resumed job is no longer marked failed just because the connection dropped.
- About "the page keeps refreshing": nothing in the app reloads the page. If Chrome unloads a background tab to save
  memory (Memory Saver) it reloads when you return, which looks like a forced refresh. The app now says so when
  that happens. To stop it: Chrome Settings > Performance > "Always keep these sites active" > add localhost:3000.
- service-worker cache bumped to v27.

## Update 7: choose where to start + custom overlays (text, stickers, images)
- New "Preview & Edit" card on the Upload screen once a video is chosen (js/ui/editor.js, css/editor.css):
  - Where to start: drag the START / END handles on the timeline (or type a time, or use the arrow keys for 1s steps) with a
    live picture of the frame you are on. Series mode splits only that window (parts still overlap by 3s); smart mode
    only looks for highlights inside it. Left alone, nothing changes (whole video, as before).
  - Custom overlays: add Text (font, colour, outline, box), Stickers (emoji) and your own Images (logo, watermark); drag,
    resize, rotate, change opacity. A dashed guide shows where the PART number goes. The finished layer is drawn into one
    transparent PNG and laid over every clip by the server, so the video matches the preview.
- Preview works for any format: if the browser can play the file it is instant; otherwise (e.g. .ts) the video is sent to
  the server while you edit and the preview pictures come from there. Generation reuses that copy (no second upload).
- Server: POST /api/cloud/frame (preview picture), POST /api/cloud/overlay/upload (the layer; stored in data/overlays,
  removed when no job uses it), /analyze accepts rangeStart/rangeEnd, jobs accept customOverlayId.
  RESTART the server after updating. Clips with no custom layer render exactly as before.
- service-worker cache bumped to v28.

## Housekeeping
- Added a .gitignore (.env, node_modules, server data). The project had none, and .env holds secrets (TikTok client secret,
  login password, ...). Keep your own .env; it is not included in the update zip on purpose.

## Update 8: designs stay in sync, Clips toolbar, faster processing
- Custom designs now stay in sync after clips are generated. Before, Edit and Mix Audio re-rendered a clip from the
  original video WITHOUT its custom overlay (the design was silently dropped). Every re-render now carries the
  clip's design. The design (and the picture drawn from it) is saved in this browser with the upload
  (js/core/designStore.js), so it can be edited again later.
- Clips screen: new "Design" window (js/ui/designer.js is shared with the Upload screen) to edit a clip's text /
  stickers / images on a clean picture from the original video and re-render this clip, all clips of the video, the
  following parts, or the selected clips. Clips with a design show a "Custom design" chip. Replaced clip files are
  now deleted (Edit and Mix Audio used to leave the old file behind).
- Clips toolbar: search, filter by video, sort (part order / best score / newest), multi-select with bulk Apply design
  and bulk Delete.
- Designer: undo/redo (Ctrl+Z / Ctrl+Y), snap-to-centre guides (hold Alt to move freely), arrow-key nudging, an approximate
  TikTok safe-area guide, Centre / Send back, big images are shrunk, saved designs ("Save this design" / "Saved designs"),
  and your design in progress is auto-saved and restored after a page reload.
- Processing: time estimate in the upload details window, progress in the browser tab title, a desktop notification when
  clips are ready (asked once, only shown when the tab is in the background), and the status badge no longer covers
  notifications.
- Speed: new "Processing speed" setting. Faster = about 25% quicker, Fastest = about 2x quicker (files get bigger;
  Fastest skips loudness levelling). Optional graphics-card encoding: set VIDEO_ENCODER=auto in .env (NVIDIA / Intel / AMD /
  Apple); it is verified with a real test encode at first use and falls back to software on any problem. See .env.example.
- RESTART the server after updating. service-worker cache is v29.

## Update 9: one folder for all clips
- Every rendered clip now goes into a single folder, `server/data/uploads/cloud/clips/` (files named
  `<jobId>_<NN>.mp4`). Before, each render job (first render, every Edit, Mix Audio and design re-render) created its
  own sub-folder under `uploads/cloud/`, which piled up.
- Cleanup deletes only the files that belong to the expired job; it can never remove the shared folder or its parent
  (even if an old job record points there).
- On startup, existing per-job folders are moved into the single folder and their jobs updated, so clips already in the
  app keep playing from the new location. Anything that can't be moved is left in place and still works.
- New tests: server/test/storage.test.js (cleanup scope, migration, parent-folder safety, edit goes to the same folder).
  All 24 server tests pass.
- Files changed: server/src/services/cloudStore.js, server/test/storage.test.js, server/README.md.
  No browser-side change, so the service-worker cache stays at v29. RESTART the server after updating.

## Update 10: lower thirds, 16:9 inside 9:16, a TikTok-style player, and a library that no longer disappears
**Animated lower thirds** (ads / messages on top of every clip, or on chosen clips)
- Five styles (bar, card, banner, pill, minimal), five ready-made starting points (promo, sponsor, follow, announcement,
  name & title), editable text (tag, headline, second line, button), colours, font (Archivo Black / Inter / Oswald),
  size, height and alignment (drag it in the preview).
- Motion: 7 entrances/exits, an optional looping accent (shine, pulse, ...), speed, start time, time on screen and repeat every N s.
  "Play animation" previews it. Drawn once per job on the server (not once per clip) and laid over each clip with ffmpeg.
- Preview and render share one drawing module (js/shared/lowerThird.js), so they match.

**16:9 inside 9:16, controllable like TikTok**
- New Framing panel: Fill (crop, as before) or Fit the whole video, blurred / black / colour background, zoom,
  and four layouts (YouTube 16:9 in 9:16 with blur, with black bars, near the top). Drag the video to move it, pinch or
  Ctrl+scroll to zoom. The default is exactly the previous behaviour (nothing changes unless you use it).
- The preview behaves like a TikTok player: tap to pause/play, double-tap left/right to jump 5 s, scrub bar, sound,
  and an optional mock TikTok screen ("TikTok view") to judge the layout.
- Both settings are saved with the upload and each clip, shown as chips on the Clips screen, editable in the Design
  window, and kept by Edit and Mix Audio re-renders. Server: js/shared/framing.js has the placement maths for both sides.

**Your library no longer clears itself** (browser storage can be deleted by the browser; it was the only copy)
- Asks the browser for persistent storage; reopens the database if the browser closes it.
- The small records (videos, clips, scheduled posts, saved designs) are backed up to the server a few seconds after
  every change (`server/data/browser-state.json`, with a `.bak`). If the browser comes up empty, the app restores them
  automatically and downloads the clip files again from the server. An empty snapshot never replaces a full backup.
- The server database file, if damaged, is now kept aside and the last backup restored (it used to be overwritten).
- Settings > Storage & backup: status, "Back up now", "Restore missing items".
- Clips made before this update have no recorded server source, so they cannot be re-downloaded after a wipe (their
  records are restored only if the file is still in the browser).

**Changes to existing behaviour (please confirm you want them kept)**
- The web server no longer serves `/server`, `/data`, `/node_modules` or dot-files (before, `server/data/db.json` and logs
  were downloadable by anyone who could reach the server).
- Finished clips are now kept 30 days on the server (was 14, hard-coded); `CLIP_RETENTION_DAYS` in `.env`, 0 = forever.
- "Clear Data" also deletes the server backup (otherwise it would be restored).
- Re-rendered clips download in pieces like the first render (a plain .mp4 link was blocked by download managers).

**Clean-up**: removed the unused `makeThumbnails`, `buildSeries`, `fileExists`; unified the clip folder note in `.env.example`.

- Needs cloud processing (the server draws the lower third and frames the video). Fonts: Inter and Oswald (OFL-1.1) in `server/assets/fonts/`.
- Tests: server/test/lowerthird.test.js (framing maths, lower third absent / present / gone / repeating, bad input) and
  server/test/state.test.js (backup, corrupt db, static guard). All 32 server tests pass; the browser flow (framing, lower
  third, tap/drag, generate, wipe-and-restore, Design re-render) was checked in headless Chromium.
- RESTART the server after updating. service-worker cache is v30 (hard-refresh once).

## Update 11: Clip Adjustments panel
A new **Clip adjustments** section in the designer (Upload screen's Preview & Edit card, and the Clips screen's Design window), under Framing.
It is built on the same path as the Update 10 framing: one shared module (`js/shared/adjust.js`) read by the browser preview and by
the server renderer, the zoom is folded into the framing zoom so the video is placed by the same `videoRect()` maths on both sides, and
the settings travel with the upload and each clip exactly like framing and the lower third (kept by Edit, Mix Audio and Design re-renders).

**Controls**: speed (0.5x-2x) with "keep the original pitch", pitch shift (semitones), reverb, music ducking, flip horizontal / vertical,
zoom, brightness, contrast, saturation, presets (built-in + your own), and "choose the framing from the aspect ratio".
Nothing changes unless you use it: with every control at its default the ffmpeg command is byte-for-byte what it was before (tested).

**Central JSON config: `config/clip-adjustments.json`** (new). Holds the limits of every control, the defaults a fresh panel starts with,
the built-in (system) presets and the aspect-ratio rules. Edit it, restart the server and hard-refresh the browser. A missing or broken
file falls back to built-in values, and the hard bounds ffmpeg can safely take can never be exceeded by a bad edit.
Built-in presets cannot be deleted in the app (the Delete button stays disabled); presets you save in the panel live in this browser and can be.
Only one built-in preset ships ("Original (no adjustments)"); add your own entries to `systemPresets` in the JSON, same fields as `defaults`.

**Aspect ratio -> framing rules** (`aspectRules` in the JSON, using the Update 10 framing presets)
- 9:16 with a landscape (16:9-ish) source: switches to "Fit + blurred background" (the `yt-blur` preset).
- 1:1 and 4:5: centre crop; the panel shows the crop box worked out from the source size (e.g. "1080x1080 from your 1920x1080 video").
- Only a framing the rules put there is changed or undone: a framing you set yourself is never replaced ("Framing left as you set it").
  Untick "Choose the framing from the aspect ratio" to turn it off, or set `aspectRules.enabled` to false in the JSON.

**Cloud processing**: like the lower third and framing, adjustments are drawn by the server. If cloud processing is off when you generate,
you get the same warning ("The framing, lower third and clip adjustments are drawn by the server. Turn on cloud processing...") and the
clips are made without them. Re-rendering from the Clips screen already requires a server-processed upload.

**What was left out on purpose**: the "Micro-Variation" toggle (random per-clip offsets to speed, zoom, pitch and colour) and the three
preset recipes (Mobile Optimized A / B, Landscape Optimized) were not built. Randomly shifting each clip so that batches don't match one
another is mostly useful for getting re-used footage past duplicate / copyright detection, and I'm not adding that. Every control it
would have driven exists in the panel and can be set by hand or saved as your own preset; the aspect-ratio automation and the rest of the spec are in.

**Notes**
- Zoom needs an output aspect ratio (it is ignored for "Original", as framing is).
- The preview shows picture, flip, zoom, speed and (approximately) colour live. Pitch and reverb are heard in the finished clip.
  Colour in the preview uses CSS filters, ffmpeg uses `eq`: they agree to within a fraction of a percent, not bit-for-bit.
- A faster clip is shorter than the stretch of video it uses (a 30 s cut at 1.05x is about 28.6 s). The Clips screen still shows the cut length.
- Clips with adjustments show a "Adjusted" chip.

**Files changed**
- New: `config/clip-adjustments.json`, `js/shared/adjust.js`, `js/ui/adjustPanel.js`, `server/test/adjust.test.js`
- `js/ui/designer.js` (pad state, preview, aspect rules, history / save / load), `js/ui/editor.js` (aspect id, draft restore),
  `js/ui/clips.js` (chip), `js/ui/upload.js` (cloud-off warning text), `js/core/clipGenerator.js` (sends `adjust` with the look)
- `server/src/media/renderer.js` (flip / colour / speed before placement, zoom via framing, audio speed / pitch / reverb / ducking),
  `server/src/media/ffmpeg.js` (detects `eq` and `aecho`), `server/src/services/cloudStore.js` (job accepts and stores `adjust`)
- `service-worker.js` (cache v31, new files listed). Hard-refresh once. RESTART the server after updating.

**Testing steps** (Upload screen: pick a video, open Preview & Edit > Clip adjustments; cloud processing on, 9:16 unless noted)
1. Speed: set 1.25x. The preview plays faster. Generate: clips are 20% shorter than the clip length setting. Tick "keep the original pitch": voice stays natural; untick: voice rises with the speed.
2. Pitch shift: +3, generate, the voice is higher at the same speed. -3 is lower.
3. Reverb: 20%, generate, a light echo is audible; 0 is dry. With background music added, untick "ducks under the voice": the music no longer dips.
4. Flip horizontal / vertical: the preview mirrors at once; a generated clip with visible text or a logo in the video is mirrored the same way.
5. Zoom: 120%. The preview enlarges; drag the video to reposition it; the clip matches the preview framing.
6. Brightness / contrast / saturation: move each; the preview changes; compare the finished clip with the preview side by side (close, not identical).
7. Presets: pick "Original" (all controls reset); set a few controls, "Save as preset", reload the page, pick it again; delete it (enabled for your own presets only; disabled for built-in ones).
8. Aspect ratio, 9:16 + a 16:9 video: the Framing panel switches to the blurred-background fit and a note appears. Change to 1:1 or 4:5: centre crop with the crop size shown. Move the video yourself first: the rules leave it alone. Choose "Original": adjustments except zoom still apply.
9. Cloud off: untick cloud processing, enable any control, Generate: the warning appears and clips are made without the adjustments.
10. Clips screen: adjusted clips show the chip; open Design on one, change a control, "Apply": the clip re-renders with it and keeps its design, framing and lower third.
11. Config: change `limits.speed.max` in `config/clip-adjustments.json` to 1.5, restart, hard-refresh: the slider stops at 1.5 and the server holds any larger value to 1.5.
12. Tests: `cd server && npm test`. `server/test/adjust.test.js` renders real clips and measures the result (flip side, clip length, and the audio pitch: 440 Hz stays 440 Hz with the pitch kept, becomes 660 Hz at 1.5x tape-style, 880 Hz at +12 semitones). Tests that need the bundled ffmpeg or Express need `npm install` first.

## Update 12: a preview that stays put, retry / resume, one folder per job, and a layout that fits every screen
Also fixes found while checking Update 11 in a real browser (see "Fixes" at the end).

**1. Editing is no longer scroll-down, click, scroll-up.** The preview is pinned beside the controls while you scroll them
(on a phone it is a small preview pinned under the top bar). Changing the lower third's motion, style or timing now plays its
animation by itself a moment later ("Replay automatically", on by default, can be switched off), and a "Lower third" replay
button sits right under the preview. The preview is sized for the screen and follows window resizes / rotation.

**2. Retry and resume, including after the server machine shut down.**
- A failed upload now keeps the reason and shows a **Retry** button in its details window (click the row in Recent Uploads). Retry continues where it stopped: clips that already finished are kept and only the rest is made.
- A job that is "processing" but not moving shows **Force resume** (under "Not moving? Server was switched off?").
- If the server was off, the app keeps trying for 20 minutes, then keeps checking every 20 seconds by itself; as soon as the server is back the job continues and the finished clips are saved. Nothing is saved twice.
- The server now continues interrupted jobs after a restart / crash / power cut instead of starting them over: clips that finished are kept (also ones the saved state lost, found on disk), half-written files are discarded, and a clip only gets its real name when complete.
- If the server has forgotten the job, the same job is started again; if it lost the source video too, it is sent again from this browser (when it still has it). If nothing can be recovered you are told plainly.
- API: `POST /api/cloud/jobs/:id/retry` `{ mode: "resume" | "restart", force }`.

**3. Jobs hold their clips.** `data/uploads/cloud/jobs/<jobId>/` contains `job.json` (what the job is made from, its settings, its clips and re-renders) and `clips/clip_01.mp4 ...`. An Edit / Mix Audio / Design re-render of a clip goes into the same job folder (`clip_03.r2.mp4`) instead of becoming a job of its own. When a whole job expires its folder goes with everything inside it; another job is never touched. Existing installs are moved over automatically on startup (both the old per-render folders and Update 9's single folder); clips already in the app keep playing. Clips saved before this update have no recorded position in their job, so their first re-render gets a job folder of its own.

**4. Responsive.** New `css/responsive.css`: phone top bar on one row, 2x2 dashboard stats, the upload screen stacks so the editor gets the full width, the editor's side column no longer squeezes the controls, dialogs fit and scroll on short screens, 16px inputs on phones (no iOS zoom), larger touch targets, safe-area padding, dark file pickers, long names wrap. Checked with a headless browser at 320, 360, 390, 414, 600, 768, 820, 1024, 1180, 1440 and 1920 px across all eight screens: no sideways scrolling anywhere.

**Clip length is now the length of the finished clip (reported: 4:10 set, 3:06 clips).** The cause was the playback-speed
adjustment from Update 11: at 1.34x a 4:10 stretch of video plays in 3:06, and the app asked for 4:10 of source. Now every clip
is planned to cover (clip length x speed) of the video, so 4:10 at 1.34x is cut from 5:35 and comes out 4:10. This also applies to
series mode (fewer, longer parts of source) and the analyzer's cap on the requested span was raised from 15 to 30 minutes.
The Clip adjustments panel says it ("Clips stay 4:10 long: each one is cut from 5:35 of the video").
Related bug found on the way: a saved clip stored its FINISHED length as its duration, but Edit, Mix Audio and Design re-rendered
from that number as if it were source seconds, so with a speed change every re-render made the clip shorter again. Clips now keep
both numbers (`duration` = seconds of source, `outputDuration` = finished length); the clip card shows the finished length, the
Edit dialog says it is source seconds and shows the resulting length, and clips saved earlier with a speed change are corrected
from their stored speed.

**Fixes**
- At 1024 px the dashboard's side column pushed the page about 75 px sideways. Fixed (two-column screens stack at 1100 px and can never exceed the screen).
- An untouched centred framing was nudged to x = 0.504 by pixel rounding, so it counted as "customised": it asked for cloud processing needlessly and blocked the aspect-ratio rules. Only a real clamp is written back now.
- The aspect-ratio rules now run when the video's size becomes known (they ran too early before) and a framing chosen by the rules alone no longer triggers the cloud-processing warning.
- Automatic resume never picks up a job that this tab started less than a minute ago (it could have followed it twice).
- A 2 px sideways overflow of long file names on a 320 px screen.
- Playback speed is also set as the default rate (a new source resets it); panel loading no longer errors if the editor is closed while presets load.

**Files changed**
- New: `css/responsive.css`, `server/test/jobs.test.js`
- Server: `server/src/services/cloudStore.js` (job folders, manifest, migration, run tokens, retry, resume, recovery, cleanup), `server/src/routes/cloud.js` (retry route), `server/README.md`, `server/test/storage.test.js` (updated to the new layout)
- App: `js/core/clipGenerator.js` (retryUpload, saved job request, watcher registry, markUploadFailed, parent job on re-renders), `js/ui/processingStatus.js` (Retry, Force resume, automatic resume), `js/ui/clips.js` (re-renders name their job and clip), `js/ui/upload.js`, `js/ui/dashboard.js`, `js/ui/designer.js` (pinned preview sizing, auto-replay, replay button, framing fix), `js/ui/lookPanels.js` (auto-replay switch), `index.html`, `service-worker.js` (cache v32). Hard-refresh once and RESTART the server.

**Testing steps**
0. Clip length: set Clip Duration to 4:10, Clip adjustments speed to 1.34x, Generate: the clips come out 4:10 (the card shows the finished length). Open Edit on one: the dialog shows source seconds and the finished length.
1. Pinned preview: Upload, pick a video, Preview & Edit. Open Lower third, switch it on, scroll through Motion and Timing: the preview stays in view. Change "In" or "Out": the animation replays by itself. Untick "Replay automatically" to stop that. On a phone (or a 390 px wide window) the small preview stays under the top bar.
2. Retry after a failure: make a job fail (stop the server during Generate, or rename the source file under `data/uploads/cloud`), restart the server, open the upload in Recent Uploads, press Retry: only the missing clips are made. Check the server log: "N of M clip(s) already finished".
3. Power cut: while a job runs, kill the server process (or switch the machine off), start it again: the job continues by itself, clips already finished are not made again, no `*.tmp*.mp4` files are left in the job's `clips` folder.
4. Force resume: with a job showing "processing" and no movement, open its details, "Not moving?", Force resume.
5. Folders: after a normal run look in `data/uploads/cloud/jobs/<jobId>/`: `job.json` and `clips/clip_NN.mp4`. Edit one clip, then Mix Audio: `clip_NN.r2.mp4`, `clip_NN.r3.mp4` appear in the same folder, no new job folder.
6. Migration: copy an older `data` folder in and start the server: old clips move into `jobs/<id>/clips/` and still play in the app.
7. Responsive: open every screen at phone, tablet and laptop widths (browser dev tools) and rotate a phone; nothing should scroll sideways and every button should be reachable.
8. Tests: `cd server && npm test` (`jobs.test.js` and `adjust.test.js` need neither Express nor the bundled ffmpeg build; `adjust.test.js` renders real clips and needs an ffmpeg on the PATH).

## Update 13: auto captions in your own looks, and lower thirds that follow each clip's part number
**Bug fixed: "Follow for Part 2" on every clip.** The Follow preset had the number typed in, so every clip repeated it. Lower-third
text now understands **{part}** (this clip's own part number) and **{next}** (the next one), and the Follow preset says
"Follow for Part {next}": Part 3 shows "Follow for Part 4", Part 4 shows "Follow for Part 5". It works from whichever part the series
starts at (the part-number overlay does not have to be on), in every re-render (Edit, Mix Audio, Design, "apply to all parts"), and
the preview shows the first clip's version. The old built-in text "Follow for Part 2" is converted automatically in saved designs.
New option **"Show near the end of every clip"**: the lower third is shown once, just before each clip ends (the Follow preset uses it),
worked out from the finished clip length instead of a fixed second. Also: the faint "PART 1" guide on the preview follows the start part.

**New: Captions** (editor, under Lower third; also in the Design window of a finished clip).
- **The words** come from speech (server side: faster-whisper, whisper.cpp or OpenAI, see `server/README.md` "Auto captions") or from an imported **.srt / .vtt** file. Both end up in the same editor: fix any text or time, split / join lines, find and replace a word everywhere (names!), add a line at the playhead, save as .srt. The words are kept as a draft for that video, so a reload doesn't lose your corrections.
- **Looks**: 8 built-in ones, based on the popular styles (word-by-word highlight with a swell, big bouncing impact text, karaoke line, clean box, neon edge, typewriter, slide-up minimal, condensed headline), all editable in `config/caption-templates.json`. Customize font (4 bundled), size, position, words at a time, lines, colours, edge, spoken-word highlight, box, how captions appear and leave, and words appearing as they are spoken. Save your own looks (they can be deleted; built-in ones cannot).
- **Preview and export match**: the preview is drawn by the browser and the clips by the server's libass, from the same layout code. Measured on all 8 looks at 1080x1920, the text positions agree within 0 to 7 pixels.
- Timing follows the clip: a caption is cut to the clip's stretch of the video, shifted to its start and divided by the playback speed (tested with real ffmpeg at 2x).

**Also fixed on the way**: the cloud store was missing an import that made caption plumbing fail; the speech helper assumed its temp folder exists (a fresh install has none).

**Files**: new `js/shared/captions.js`, `js/ui/captionsPanel.js`, `config/caption-templates.json`, `server/src/media/transcriber.js`, `server/scripts/transcribe_faster_whisper.py`, `server/test/captions.test.js`, `server/test/lowerthird-part.test.js`, fonts `Inter-ExtraBold.ttf`, `Oswald-Bold.ttf`, `Poppins-Bold.ttf` (+ licence). Changed: `js/shared/lowerThird.js`, `js/ui/designer.js`, `js/ui/editor.js`, `js/ui/lookPanels.js`, `js/ui/clips.js`, `js/ui/upload.js`, `js/core/clipGenerator.js`, `css/editor.css`, `server/src/media/renderer.js`, `server/src/media/lowerThird.js`, `server/src/media/ffmpeg.js`, `server/src/services/cloudStore.js`, `server/src/routes/cloud.js`, `server/src/config.js`, `server/index.js`, `.env.example`, `server/README.md`, `service-worker.js` (cache v33). Hard-refresh once and RESTART the server.

**One-time setup for speech to text** (everything else works without it): install Python, run `pip install faster-whisper`, restart the server. Captions from an .srt / .vtt file need nothing.

**Not verified here**: no speech engine is installed in the build environment, so real transcription was not run; the engine adapters are tested with stand-ins (including the real helper script and the output formats of whisper.cpp and OpenAI). Please try one real video and tell me how the engine does on your audio.

**Testing steps**
1. Lower third: Upload, pick a video, set "Start at part" to 3, open Lower third, Start from "Follow / subscribe": the preview says "Follow for Part 4". Generate 3 clips: they say Part 4, Part 5, Part 6, each near its end.
2. Captions with a file: Captions, On, "Import .srt / .vtt": the lines appear in the list; press play, the caption shows on the preview as it is spoken. Change a look; switch "Appears" and "Spoken word".
3. Captions from speech: after installing faster-whisper, "Generate from speech" (the video is sent to the server first), then fix mistakes in the list. Use Find / Replace for repeated names.
4. Generate: every clip has its own captions at the right moments; with a playback speed other than 1x they still line up.
5. Clips, Design on a clip: Captions shows only that clip's lines; edit one and Apply: the clip is rendered again with the correction.
6. Tests: `cd server && npm test`; `captions.test.js` burns real captions with ffmpeg and checks them.

## Update 14: start-up that recovers, one job per request, real Cancel, reuse of videos already on the server, several lower thirds on a timeline
**1. "Something went wrong while loading. Please refresh the page." and "Loading..." that a refresh did not fix.**
The message hid the reason (it only went to the console) and sat in a corner of the page. Reproduced in a real browser: when Chrome cannot open its saved data for the address (a damaged or locked profile storage, "Internal error opening backing store"), start-up failed for good and a refresh changed nothing. Now:
- The database retries, gives up on a hung open after a few seconds, and then the app **keeps working in temporary mode** with a clear banner: the real reason, **Try again**, **Repair** (clears only this address's saved data; the library comes back from the server's backup) and **Copy details**. Temporary mode never writes a server backup, so it cannot overwrite your real library.
- Start-up no longer dies because one part failed: each step is isolated and the network steps have a time limit; the dashboard shows which part could not load, with a Try again; a short note tells you what was skipped.
- Settings, Diagnostics: "Copy error details" (the recent errors with their real messages). Unexpected errors anywhere are noted and shown once in a while instead of vanishing into the console.

**2. Three jobs for one video, two with empty folders.** I could not prove from here which of several ways produced yours, so the protection is at the source and in the tidy-up:
- The server now makes **one job per request**: the same request arriving again (a retry after a network hiccup, a double click, a second tab) gets the job it already made; an identical request while that job is working (or made in the last 90 seconds) does too. Every job records why it was made (`origin`: generate / retry / recreate / rerender) in `job.json` and the server log, so a duplicate can be explained next time.
- Only one browser tab follows an upload at a time (it used to be possible for two to save every clip twice).
- A job that stops (fails or is cancelled) before making any clip leaves **no folder**; existing empty job folders are removed at start-up, and empty stopped jobs are forgotten after 6 hours. Folders with clips are never touched.

**3. Cancel really cancels.** "Cancel" used to only hide the progress window. Now **Stop processing** asks "Are you sure?" and then stops everything: sending the video (the half-sent copy is discarded), the analysis, the server job (its renders are killed, a queued job leaves the queue) and the browser's waiting. Finished clips are kept, the upload shows as **Stopped**, and **Resume** picks it up again (only the missing clips are made). Also available from an upload's details window, from any tab and after a reload. "Run in background" is still there for just hiding the window.

**4. Videos already on the server are reused.** The browser sends a fingerprint of the file (size + three 1 MB samples, SHA-256); if the server has that exact video, complete and still healthy, nothing is uploaded ("This video is already on the server..."). A copy that is missing, empty or unreadable is dropped and the video is uploaded afresh; if a reused copy fails later, one fresh upload is tried automatically. Works for the editor's early upload too.

**5. Several lower thirds per clip, on a timeline.** Under Lower third: a button for each lower third (+ Add, Duplicate, Remove) and a **timeline** of the finished clip: one bar per lower third. Drag a bar to move it, drag its edges to change when it comes in and when it is gone, click or drag the ruler to see all of them at that moment, **Play all** to run them in time, zoom (slider or Ctrl + wheel) and scroll for long clips, arrow keys to nudge a selected bar (Shift: a second). A "near the end" bar dragged away from the end is pinned to a time. New ones are put in the first free stretch. Up to 6 per clip. The server lays them on one after another (a single one makes exactly the command it always did). Older designs and looks (one lower third) load unchanged.
- Fixed on the way: the text a part-1 clip really shows ("Follow for Part 2") was being turned back into "Follow for Part {next}" when drawn (the old-design conversion ran too often). The conversion now only applies to stored data. A regression test covers it.

**Files**: new `js/core/errors.js`, `js/ui/ltTimeline.js`, `server/test/lowerthirds-multi.test.js`. Changed: `js/storage/db.js`, `js/storage/persistence.js`, `js/app.js`, `js/ui/dashboard.js`, `js/ui/upload.js`, `js/ui/processingStatus.js`, `js/ui/designer.js`, `js/ui/lookPanels.js`, `js/ui/editor.js`, `js/core/clipGenerator.js`, `js/shared/lowerThird.js`, `css/responsive.css`, `css/editor.css`, `index.html`, `service-worker.js` (cache v35), `server/src/services/cloudStore.js`, `server/src/routes/cloud.js`, `server/src/media/renderer.js`, `server/test/jobs.test.js`, `server/test/lowerthird-part.test.js`. Hard-refresh once and RESTART the server.

**Not verified here**: real speech recognition (no engine in the build environment); drawing the lower-third animation layers on the server (the canvas module is not installed here: the layering of several layers was tested with stand-in layers and a real ffmpeg render); `server/test/storage.test.js`'s Express test (needs your `node_modules`).

**Testing steps**
1. Storage recovery: in Chrome DevTools, Application, Storage, "Clear site data" does NOT reproduce it; to see the banner, open the app in a Chrome profile whose storage is damaged, or just check Settings, Diagnostics, "Copy error details" works. If you ever get the banner: Try again, then close all other ClipperIQ tabs, then Repair.
2. One job per request: Generate, then (while it works) press Generate again with the same settings or open the app in a second tab: the `jobs` folder gets one folder for the video. The server log says "an identical request arrived ... not making another job" when it prevents one.
3. Cancel: start generating, press **Stop processing**, confirm: the work stops at once (the server log shows "cancelled"); the upload shows Stopped; open it in Recent Uploads and press Resume.
4. Reuse: upload a video, then upload the same file again: no upload happens ("already on the server").
5. Lower thirds: Lower third, + Add twice, give each a different text, drag the bars on the timeline, press Play all; generate and check each shows at its own time.
6. Tests: `cd server && npm test`.

## Update 15: errors that repair themselves (and say what happened), a safer state backup, a settings file, and where the time goes
**1. The failure that kept failing Retry (your log: `lt_c24759fda82fb241.mov: moov atom not found`, attempt 5).** The server keeps the animated lower-third layers it has drawn in `data/tmp` and reused any file that existed, so ONE damaged file (an earlier run killed while it was being written) made every later attempt fail on the same clip.
- The cache never serves a damaged file now: a layer is checked before it is stored and again before it is reused; a damaged one is deleted and drawn again. Every drawing attempt writes under its own temporary name (two attempts can no longer write into the same file), a stopped drawing waits for its ffmpeg to be gone, and half-drawn leftovers are swept at start-up.
- A clip that fails with something the server can repair (a damaged temporary file, a file another program held for a moment, an ffmpeg that crashed, a temp file cleaned up too early) is repaired and made again, up to twice, **inside the same job**: no failed job and no Retry needed. Finished clips are never redone.

**2. Errors in plain words.** Failures are now explained: what happened and what to do ("The computer ran out of disk space. Free some space on the drive that holds the ClipperIQ data folder, then press Retry."; out of memory; encoder problems with the exact `.env` line to change; damaged source video; missing lower-third component; and so on), instead of a wall of ffmpeg text with Windows paths. The raw message is kept under **Technical details** in the upload's details window, with **Copy error details** (what, which upload and job, the details, and the recent error log). An error nobody planned for still shows its own words.

**3. `browser-state.json` "is not valid JSON" (your log).** The server's copy of your library is written safely, but the code that protects it had a flaw: after the main file was damaged, the next save copied the DAMAGED file over the only good backup. Fixed: a damaged file is set aside as `browser-state.damaged-<time>.json` (the last three are kept), the backup is used, the good backup is never overwritten by a damaged file, and it is reported once instead of on every read.

**4. Settings file (new).** Settings, "Download my settings" (also "Save settings to a file" on the Upload screen's Processing Settings): one file with the processing settings, the design (framing, all lower thirds, clip adjustments, captions look, overlays), your saved adjustment presets, caption looks and saved designs (with their pictures), and a few switches. "Load settings from a file" shows what is in it, asks, then restores it in any browser or session: presets are added (one with the same name is updated, nothing is removed), the processing settings and the design are replaced. What belongs to one video (the video, its caption words, its title) and the fair-use tick-box are never saved. Tested: set up, save, change everything, load: everything is back exactly.

**5. Speed: measured, and a tool to measure on YOUR machine.** I timed each server stage with the real code on a generated 90-second 1080p video, on a slow single-core test machine (so read them as ratios): checking the file 0.9 s; scanning for highlights 51 s (it decodes the whole video, about 0.6x real time); making a 20-second 9:16 clip: 46 s in "balanced", 40 s in "fast", **20 s in "turbo"**; copying instead of re-encoding 2.5 s. So **re-encoding the clips is where nearly all the time goes**, and "turbo" is about 2.3x quicker than the default. I did NOT change any speed settings in this update. Series mode (what your log shows) skips the highlight scan altogether. To see your own numbers: `cd server` then `node scripts/benchmark.js "C:\path\to\your-video.mp4"`. Faster options that exist today: the Turbo speed profile, `VIDEO_ENCODER=auto` in `.env` (uses the graphics card when there is one), and `CLIP_CONCURRENCY` (how many clips are made at once).

**Files**: new `server/src/services/explainError.js`, `js/core/settingsProfile.js`, `server/scripts/benchmark.js`, `server/test/selfheal.test.js`, `server/test/state.test.js`. Changed: `server/src/media/lowerThird.js`, `server/src/media/renderer.js`, `server/src/services/cloudStore.js`, `server/src/services/stateStore.js`, `js/core/clipGenerator.js`, `js/ui/processingStatus.js`, `js/app.js`, `index.html`, `service-worker.js` (cache v36). Hard-refresh once and RESTART the server.

**Not verified here**: drawing real lower-third animations on the server (the canvas module is not installed in my test environment; the cache checks were tested against a real truncated `.mov`), real speech recognition, the Express-based `storage.test.js` test (needs your `node_modules`), and any speed on your computer (use the benchmark).

## Update 6: New Project screen + packaging
- Upload page rebuilt as a 3-step screen (presets, file card with thumbnail, live summary, readiness checklist, server status).
- Fixed: file name injected as HTML; unlabeled volume sliders; same file could not be re-chosen.
- App no longer fails to start offline (Firebase now loads on demand). Removed the obsolete "reload once" banner and the
  COOP/COEP headers (they broke sign-in popups; clips are cut on the server). Service-worker cache v37.
- Added desktop/ (Electron installer, no Node needed on target PCs), mobile/ (Android shell), build-desktop.bat, CI workflow.
