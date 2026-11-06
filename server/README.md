# ClipperIQ Studio — backend

The Node/Express server behind ClipperIQ Studio: video upload, highlight detection, ffmpeg
rendering, and the proxies the frontend uses to publish to TikTok, YouTube and Instagram.

## Requirements

- **Node.js 18.17+** (works out of the box up to the current LTS).
- No system ffmpeg install needed — `npm install` downloads a working `ffmpeg`/`ffprobe`
  ([`@ffmpeg-installer/ffmpeg`](https://www.npmjs.com/package/@ffmpeg-installer/ffmpeg) /
  [`ffprobe-static`](https://www.npmjs.com/package/ffprobe-static)) automatically — both are
  ordinary npm packages fetched from the npm registry, not a download from GitHub at install
  time, so they install fine even on networks that block that. Set `FFMPEG_PATH`/`FFPROBE_PATH`
  in `.env` if you'd rather use a system install.

## Running it

From the repo root, the easiest way is `start.bat` (Windows) — it installs dependencies, checks
the environment, and starts everything. To run it by hand instead:

```bash
cd server
npm install
npm run doctor   # checks ffmpeg, disk space, the port, etc. — safe to run any time
npm start        # or: node index.js
```

The server serves the frontend itself, so once it's running, open **http://localhost:3000**
(or whatever `PORT` you set) — no separate static server or build step needed.

## Configuration

There is **one** `.env` file for the whole app, and it lives in the **repo root** (next to
`start.bat`, one level up from this `server/` folder) — copy `.env.example` there to `.env` and
adjust as needed. `start.bat` does this for you on first run. Every setting has a sensible
default; you only need to touch it at all to change the port, raise upload limits, add a
password before exposing the server on the internet, or set platform API credentials (which,
once set here, every browser picks up automatically via `GET /api/config/public` — see
`.env.example` for the full list).

## How it fits together

```
server/
├── index.js                 Entry point — wires everything below into one Express app
├── scripts/doctor.js         Environment checker (npm run doctor)
├── assets/fonts/              Bundled fonts for overlays and lower thirds (Archivo Black, Inter, Oswald; OFL-licensed)
└── src/
    ├── config.js             Loads .env + defaults into one config object
    ├── logger.js             Console + rotating file logger (data/logs/server.log)
    ├── db.js                 Small JSON document store (uploads/jobs persist across restarts)
    ├── net.js                 Outbound HTTP client (used for TikTok/YouTube proxying)
    ├── media/
    │   ├── ffmpeg.js          Locates ffmpeg/ffprobe, runs them, parses progress
    │   ├── ytdlp.js           Background-music-from-a-link + /api/audio streaming
    │   ├── analyzer.js        Highlight detection (audio peaks + scene changes → scored clips)
    │   ├── overlay.js         "PART N" / big-number overlay rendering (canvas, with a
    │   │                      drawtext fallback if @napi-rs/canvas isn't available)
    │   └── renderer.js        Turns one candidate clip into an .mp4 (crop, overlay, BGM mix,
    │                          loudness normalization, fast stream-copy when nothing needs
    │                          re-encoding)
    ├── services/
    │   ├── cloudStore.js      Upload tracking + the render-job queue (the heart of /api/cloud)
    │   ├── bgmStore.js        Background-music library (uploaded files or fetched from a link)
    │   └── errors.js          HttpError used across routes for correct status codes
    ├── middleware/
    │   ├── asyncRoute.js, errorHandler.js, basicAuth.js
    └── routes/
        ├── cloud.js           Video upload → analyze → render → download, and BGM registration
        ├── config.js          GET /api/config/public — the browser's half of the single .env
        ├── tiktok.js          TikTok Content Posting API proxy
        ├── youtube.js         YouTube resumable-upload proxy
        ├── instagramUpload.js Publishes a rendered clip to a fetchable URL for Instagram
        └── media.js           /api/audio and /api/proxy-image CORS proxies
```

## The video-processing API

This is what the frontend's "Cloud Processing" option talks to:

| Route | Purpose |
|---|---|
| `GET /api/cloud/health` | ffmpeg availability + capabilities |
| `POST /api/cloud/upload/init` | Start an upload — `{name, size, type}` → `{uploadId}` |
| `PUT /api/cloud/upload?uploadId=` | Send one chunk (`Content-Range: bytes a-b/total`) |
| `POST /api/cloud/info` | `{uploadId}` → `{duration}` once fully uploaded |
| `POST /api/cloud/analyze` | `{uploadId, maxClips, targetDuration}` → scored clip candidates |
| `POST /api/cloud/jobs` | Start rendering a chosen set of candidates → `{jobId}` |
| `GET /api/cloud/jobs/:jobId` | Poll status/progress; `clips` fills in as each one finishes |
| `POST /api/cloud/bgm/upload` | Register an uploaded audio file as background music → `{bgmId}` |
| `POST /api/cloud/bgm/from-url` | Fetch audio from a link (yt-dlp) and register it → `{bgmId}` |

Uploads are tracked by merged byte ranges (not just a running total), so out-of-order or
retried chunks can't make an incomplete upload look finished. Jobs persist to disk after every
clip, so a restart mid-render picks the job back up from the start rather than losing it. A
job's `bgm` field is `{bgmId, volume, duck, restart}`, referencing a track registered via one of
the two routes above — register once, reuse across a whole series or a re-render.

## Notes

- **Platform app credentials** (TikTok/YouTube/Instagram) are read from `.env` first; the
  browser fetches the non-secret app IDs from `GET /api/config/public` on load, so setting them
  once in `.env` is enough for every device — no more per-browser entry. Client secrets never
  leave the server. The in-app Settings/admin panel still works as a per-browser override for
  anyone who prefers that.
- This server only **proxies** the actual TikTok/YouTube API calls (so they see a stable server
  IP and browser CORS limits don't get in the way) — OAuth tokens themselves still live in the
  browser, the same as before.
- **Instagram** publishing needs the clip reachable at a real https URL — set `PUBLIC_BASE_URL`
  in `.env` if you're behind a tunnel or reverse proxy.
- **Deploying to a VPS**: set `HOST=0.0.0.0`, put this behind a reverse proxy (nginx/Caddy) that
  terminates HTTPS, set `PUBLIC_BASE_URL` to your domain, and set `AUTH_PASSWORD` so random
  visitors can't use your upload/publish quota.
- Old uploads and finished jobs are cleaned up automatically (`SOURCE_RETENTION_DAYS` in
  `.env`); nothing is deleted while still in progress.
- **Where clips are stored**: one folder per job (everything made from one video in one go), clips inside it:
  `data/uploads/cloud/jobs/<jobId>/clips/clip_01.mp4, clip_02.mp4 ...` plus `job.json` (source video, settings, clips,
  re-renders). An Edit / Mix Audio / Design re-render of a clip is filed in the same job folder
  (`clip_03.r2.mp4`, `clip_03.r3.mp4` ...). A clip only gets its real file name once it is complete. Cleanup removes a
  whole job folder when it expires and never touches another job. Older layouts are moved into job folders on startup
  (anything that can't be moved stays where it is and keeps working).
- **Retry / resume**: `POST /api/cloud/jobs/:id/retry` with `{ "mode": "resume" | "restart", "force": false }`. Resume keeps
  every finished clip and renders only the rest; `force` takes over a job that is marked running but is stuck. After a
  restart, crash or power cut, interrupted jobs continue by themselves (finished clips are kept, half-written ones are
  discarded).

## How uploaded videos are checked and repaired

On upload the server scans every packet of the video (not just the header) and compares the
file's clock with the footage actually in it. Three kinds of broken clock are detected and
repaired automatically (a lossless re-wrap first; a one-off re-encode only if that isn't enough):

- **restart**: the clock jumps back (stitched HLS/M3U8 segments), so the file looks shorter than it is
- **gap**: the clock jumps forward (ad breaks / dropped segments), so it looks far longer than it is
- **compressed**: timestamps squashed together

If a file can't be repaired the app shows a warning instead of silently cutting from the wrong place.

Every rendered clip is verified (length, decodable, not all-black). "Fast Mode" stream-copy is only
used when the source's keyframes are at most 2.5s apart; if a fast copy comes out wrong, that clip is
automatically re-rendered by encoding. A clip that can't be rendered correctly fails with a clear
message instead of being saved as an empty video.

## Lower thirds, framing and the browser backup
- `POST /api/cloud/jobs` also accepts `frame` ({mode: fill|fit, bg: blur|black|color, color, zoom, x, y}) and `lowerThird`
  (see `js/shared/lowerThird.js` for the fields). Both are validated and normalised; a lower third that can't be drawn only
  adds a warning to the clip.
- `src/media/lowerThird.js` draws the animation with `@napi-rs/canvas` into a small transparent video (cached in `data/tmp`,
  one per job) which `renderer.js` overlays; `js/shared/*.js` are shared with the browser preview.
- `GET/PUT /api/state` stores a copy of the browser's library (`data/browser-state.json`); empty snapshots are refused
  unless `?force=1`. `CLIP_RETENTION_DAYS` (default 30, 0 = forever) controls how long finished clips are kept.

## Auto captions

Captions are drawn onto every clip by the server (ffmpeg's subtitle renderer, libass: the standard Windows / Linux / macOS
ffmpeg builds include it, and the app tells you if yours does not). The words come from one of three places:

- **Speech to text on this computer, free.** Easiest is faster-whisper: install Python, run `pip install faster-whisper`,
  restart the server. The first use downloads the model (`WHISPER_MODEL`, `small` by default; `medium` / `large-v3` are more
  accurate and slower). No GPU is needed. Or use the whisper.cpp program (`WHISPER_CPP_BIN`, `WHISPER_CPP_MODEL`).
- **OpenAI's hosted Whisper**, with `OPENAI_API_KEY` (the audio is sent to OpenAI; they bill for it).
- **A file you already have** (.srt / .vtt): "Import .srt / .vtt" in the Captions panel. Works with no engine installed.

Either way the words end up in the same editor in the app: read through them, fix mistakes (text and times), split or join
lines, find and replace a word everywhere, then pick a look. The words are kept on the server next to the video
(`data/captions/<uploadId>.json`) and every clip, and every later Edit / Mix Audio / Design re-render, takes the part it needs.

Looks: the built-in ones are in `config/caption-templates.json` (edit them or add your own; restart the server and hard-refresh).
Looks you save in the app live in your browser. Fonts are in `server/assets/fonts` (Poppins, Inter, Archivo Black, Oswald; all
under the SIL Open Font License). To add a font, put the `.ttf` there and add it to `CAPTION_FONTS` in `js/shared/captions.js`
(with its metrics: see the comment there).

API: `GET /api/cloud/captions/engine`, `GET|PUT /api/cloud/captions/:uploadId`, `POST /api/cloud/captions/:uploadId/transcribe`,
`GET|DELETE /api/cloud/caption-tasks/:taskId`.

