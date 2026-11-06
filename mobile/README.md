# ClipperIQ Studio for Android

**Phone Studio (stage 1)**: choose a video from the gallery, pick Series or Spread out, a length and a shape
(9:16, 4:5, 1:1, 16:9 or as-is), optionally show "PART N", and the clips are cut ON THE PHONE with Android's hardware video
encoder (Media3 Transformer). Clips are saved to the gallery in Movies/ClipperIQ. No server, no internet.

Also in the app: "Connect to a server" opens the full ClipperIQ web app from your computer or a hosted server.

## Build the APK (no Android Studio needed)
Put the project on GitHub, then Actions > "Build installer and APK" > Run workflow. Download `ClipperIQ-Android-apk`
from the finished run, copy it to the phone and open it (allow "install unknown apps" for your file manager or browser).

## What stage 1 does NOT have yet (planned next)
- Smart "best moments" detection (audio and scene scoring). Stage 1 offers Series and evenly spread clips.
- Lower thirds, captions, background music, custom overlays, the library, scheduler and posting.
- Keeps cutting when the app is in the background (needs a foreground service). Keep the screen open for now.
- Android 9 and older: clips are saved to the app's own folder, not the gallery. Android 10+ is the supported target.

## Files
- `www/index.html`: the Phone Studio screen. `www/connect.html`: the server connection screen.
- `plugins/clipperiq-engine/`: the native engine (Java, Media3). Methods: pickVideo, probe, cutClips, cancel, openClip, shareClip.
