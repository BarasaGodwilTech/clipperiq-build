# ClipperIQ Studio for Android

**Phone Studio (stage 1)**: choose a video from the gallery, pick Series or Spread out, a length and a shape
(9:16, 4:5, 1:1, 16:9 or as-is), optionally show "PART N", and the clips are cut ON THE PHONE with Android's hardware video
encoder (Media3 Transformer). Clips are saved to the gallery in Movies/ClipperIQ. No server, no internet.

Also in the app: "Connect to a server" opens the full ClipperIQ web app from your computer or a hosted server.

## Build the APK (no Android Studio needed)
Put the project on GitHub, then Actions > "Build installer and APK" > Run workflow. Download `ClipperIQ-Android-apk`
from the finished run, copy it to the phone and open it (allow "install unknown apps" for your file manager or browser).

## What is in the app now (phone engine v2)
- Four tabs: **Studio**, **Library**, **Schedule**, **Settings**.
- Studio: choose which part of the video to use (From / To, with −1s/+1s, typed times and picture previews), Series or Spread
  out, any clip length, shape, PART label, start number, file name. Presets: built-in, your own (Save current), Import (a computer
  settings file saved from ClipperIQ on Windows, or a presets file), Copy my presets.
- Library: every run, with Play, Share, Remind me, Remove (from the list only; files stay in the gallery).
- Schedule: reminders at a chosen date and time with a caption. The phone notifies you; Open & share copies the caption and
  opens the share sheet. Reminders can be a few minutes late (Android saves battery). Posting itself happens in the app you share to.
- Settings: remember last settings, notification permission, backup/restore as text, link to a ClipperIQ server.

## What the phone app does NOT have yet (planned next)
- Smart "best moments" detection (audio and scene scoring). The phone offers Series and evenly spread clips; the computer version has Best moments.
- Lower thirds, captions, background music, custom overlays and automatic posting.
- Keeps cutting when the app is in the background (needs a foreground service). Keep the screen open for now.
- Android 9 and older: clips are saved to the app's own folder, not the gallery. Android 10+ is the supported target.

## Files
- `www/index.html`: the Phone Studio screen. `www/connect.html`: the server connection screen.
- `plugins/clipperiq-engine/`: the native engine (Java, Media3). Methods: pickVideo, probe, cutClips, cancel, openClip, shareClip.
