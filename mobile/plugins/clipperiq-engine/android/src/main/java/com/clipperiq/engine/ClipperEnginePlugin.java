package com.clipperiq.engine;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.AbsoluteSizeSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.StyleSpan;

import androidx.activity.result.ActivityResult;
import androidx.media3.common.Effect;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.effect.OverlayEffect;
import androidx.media3.effect.OverlaySettings;
import androidx.media3.effect.Presentation;
import androidx.media3.effect.TextOverlay;
import androidx.media3.effect.TextureOverlay;
import androidx.media3.transformer.Composition;
import androidx.media3.transformer.EditedMediaItem;
import androidx.media3.transformer.Effects;
import androidx.media3.transformer.ExportException;
import androidx.media3.transformer.ExportResult;
import androidx.media3.transformer.ProgressHolder;
import androidx.media3.transformer.Transformer;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.collect.ImmutableList;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * ClipperIQ on-device engine, stage 1.
 *
 *   pickVideo()           system file picker, returns a content uri
 *   probe({uri})          duration / size of the video
 *   cutClips({...})       cuts the listed stretches into separate clips (hardware encoder), with optional crop to
 *                         9:16 / 4:5 / 1:1 / 16:9 and a PART N label; saves them to Movies/ClipperIQ
 *   cancel()              stops the run
 *   openClip / shareClip  hand a finished clip to the phone's player / share sheet
 */
@CapacitorPlugin(name = "ClipperEngine")
public class ClipperEnginePlugin extends Plugin {

    private final Handler main = new Handler(Looper.getMainLooper());

    private static class Job { long startMs; long durMs; int part; }

    // state of the run in progress (touched on the main thread only)
    private PluginCall runCall = null;
    private Transformer current = null;
    private boolean polling = false;
    private List<Job> jobs = new ArrayList<>();
    private int index = 0;
    private Uri sourceUri = null;
    private String aspect = "9:16";
    private boolean partText = true;
    private String baseName = "clip";
    private JSArray outputs = new JSArray();
    private long runStartedAt = 0;

    // ───────────────────────── picking and probing ─────────────────────────

    @PluginMethod
    public void pickVideo(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("video/*");
        startActivityForResult(call, intent, "pickResult");
    }

    @ActivityCallback
    private void pickResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("No video was chosen.", "CANCELLED");
            return;
        }
        Uri uri = result.getData().getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignored) { /* not every provider allows it; the uri still works for this session */ }
        String name = "video";
        long size = 0;
        Cursor c = null;
        try {
            c = getContext().getContentResolver().query(uri, null, null, null, null);
            if (c != null && c.moveToFirst()) {
                int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int si = c.getColumnIndex(OpenableColumns.SIZE);
                if (ni >= 0) name = c.getString(ni);
                if (si >= 0) size = c.getLong(si);
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        JSObject ret = new JSObject();
        ret.put("uri", uri.toString());
        ret.put("name", name);
        ret.put("size", size);
        call.resolve(ret);
    }

    @PluginMethod
    public void probe(final PluginCall call) {
        final String uriStr = call.getString("uri");
        if (uriStr == null) { call.reject("No video given."); return; }
        new Thread(() -> {
            MediaMetadataRetriever mmr = new MediaMetadataRetriever();
            try {
                mmr.setDataSource(getContext(), Uri.parse(uriStr));
                long dur = parseLong(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION));
                long w = parseLong(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH));
                long h = parseLong(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));
                long rot = parseLong(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION));
                if (rot == 90 || rot == 270) { long t = w; w = h; h = t; }
                if (dur <= 0) { call.reject("This file could not be read as a video."); return; }
                JSObject ret = new JSObject();
                ret.put("durationMs", dur);
                ret.put("width", w);
                ret.put("height", h);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("This file could not be read as a video: " + e.getMessage());
            } finally {
                try { mmr.release(); } catch (Exception ignored) { }
            }
        }).start();
    }

    private static long parseLong(String s) {
        try { return s == null ? 0 : Long.parseLong(s); } catch (Exception e) { return 0; }
    }

    // ───────────────────────── cutting ─────────────────────────

    @PluginMethod
    public void cutClips(final PluginCall call) {
        final String uriStr = call.getString("uri");
        final JSArray clips = call.getArray("clips");
        if (uriStr == null || clips == null || clips.length() == 0) { call.reject("Nothing to cut."); return; }
        final List<Job> list = new ArrayList<>();
        try {
            for (int i = 0; i < clips.length(); i++) {
                JSONObject o = clips.getJSONObject(i);
                Job j = new Job();
                j.startMs = o.getLong("startMs");
                j.durMs = o.getLong("durationMs");
                j.part = o.optInt("part", 0);
                if (j.durMs < 500) continue;
                list.add(j);
            }
        } catch (Exception e) {
            call.reject("The list of clips was not valid: " + e.getMessage());
            return;
        }
        if (list.isEmpty()) { call.reject("Nothing to cut."); return; }
        final String asp = call.getString("aspect", "9:16");
        final Boolean pt = call.getBoolean("partText", true);
        final String name = call.getString("baseName", "clip");
        main.post(() -> {
            if (runCall != null) { call.reject("A run is already in progress."); return; }
            runCall = call;
            jobs = list;
            index = 0;
            sourceUri = Uri.parse(uriStr);
            aspect = asp == null ? "9:16" : asp;
            partText = pt == null || pt;
            baseName = safeName(name);
            outputs = new JSArray();
            runStartedAt = System.currentTimeMillis();
            runNext();
        });
    }

    private static String safeName(String s) {
        String n = s == null ? "clip" : s.replaceAll("[^A-Za-z0-9._-]+", "_");
        if (n.length() > 40) n = n.substring(0, 40);
        return n.isEmpty() ? "clip" : n;
    }

    private void runNext() {
        if (runCall == null) return;
        if (index >= jobs.size()) {
            JSObject ret = new JSObject();
            ret.put("clips", outputs);
            PluginCall c = runCall;
            runCall = null;
            current = null;
            c.resolve(ret);
            return;
        }
        final Job job = jobs.get(index);
        final File out = new File(getContext().getCacheDir(), "cliq_" + System.currentTimeMillis() + "_" + index + ".mp4");
        try {
            MediaItem.ClippingConfiguration cc = new MediaItem.ClippingConfiguration.Builder()
                    .setStartPositionMs(job.startMs)
                    .setEndPositionMs(job.startMs + job.durMs)
                    .build();
            MediaItem item = new MediaItem.Builder().setUri(sourceUri).setClippingConfiguration(cc).build();

            List<Effect> video = new ArrayList<>();
            float ar = aspectRatio(aspect);
            int outH = outputHeight(aspect);
            if (ar > 0f) {
                video.add(Presentation.createForAspectRatio(ar, Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP));
                video.add(Presentation.createForHeight(outH));
            }
            if (partText && job.part > 0) video.add(partOverlay(job.part, outH > 0 ? outH : 1080));

            EditedMediaItem edited = new EditedMediaItem.Builder(item)
                    .setEffects(new Effects(new ArrayList<AudioProcessor>(), video))
                    .build();

            Transformer t = new Transformer.Builder(getContext())
                    .setVideoMimeType(MimeTypes.VIDEO_H264)
                    .setAudioMimeType(MimeTypes.AUDIO_AAC)
                    .addListener(new Transformer.Listener() {
                        @Override
                        public void onCompleted(Composition composition, ExportResult exportResult) {
                            polling = false;
                            publish(out, job);
                        }

                        @Override
                        public void onError(Composition composition, ExportResult exportResult, ExportException exportException) {
                            polling = false;
                            failRun("Part " + (job.part > 0 ? job.part : index + 1) + " could not be cut: " + exportException.getMessage());
                        }
                    })
                    .build();
            current = t;
            t.start(edited, out.getAbsolutePath());
            polling = true;
            pollProgress(t);
        } catch (Exception e) {
            failRun("Could not start cutting: " + e.getMessage());
        }
    }

    private void pollProgress(final Transformer t) {
        main.postDelayed(() -> {
            if (!polling || t != current || runCall == null) return;
            ProgressHolder ph = new ProgressHolder();
            int state = t.getProgress(ph);
            if (state != Transformer.PROGRESS_STATE_NOT_STARTED && state != Transformer.PROGRESS_STATE_UNAVAILABLE) {
                emitProgress(ph.progress);
            }
            pollProgress(t);
        }, 400);
    }

    private void emitProgress(int pctOfClip) {
        JSObject ev = new JSObject();
        int total = jobs.size();
        double overall = ((index + Math.max(0, Math.min(100, pctOfClip)) / 100.0) / total) * 100.0;
        ev.put("index", index);
        ev.put("total", total);
        ev.put("part", jobs.get(index).part);
        ev.put("pct", pctOfClip);
        ev.put("overall", overall);
        ev.put("elapsedMs", System.currentTimeMillis() - runStartedAt);
        notifyListeners("progress", ev);
    }

    /** Copies the finished clip to Movies/ClipperIQ (so it shows up in the gallery) on a worker thread. */
    private void publish(final File tmp, final Job job) {
        final String display = String.format(Locale.US, "%s_part%02d_%d.mp4", baseName, job.part > 0 ? job.part : index + 1, System.currentTimeMillis() % 100000);
        new Thread(() -> {
            String uriOut = null;
            String err = null;
            try {
                uriOut = saveToMovies(tmp, display);
            } catch (Exception e) {
                err = e.getMessage();
            } finally {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
            }
            final String fu = uriOut;
            final String fe = err;
            main.post(() -> {
                if (runCall == null) return; // cancelled while saving
                if (fu == null) { failRun("Could not save the clip: " + fe); return; }
                JSObject o = new JSObject();
                o.put("uri", fu);
                o.put("name", display);
                o.put("part", job.part);
                o.put("startMs", job.startMs);
                o.put("durationMs", job.durMs);
                outputs.put(o);
                emitProgress(100);
                index++;
                runNext();
            });
        }).start();
    }

    private String saveToMovies(File src, String display) throws Exception {
        ContentResolver cr = getContext().getContentResolver();
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Video.Media.DISPLAY_NAME, display);
            v.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4");
            v.put(MediaStore.Video.Media.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/ClipperIQ");
            v.put(MediaStore.Video.Media.IS_PENDING, 1);
            Uri dest = cr.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, v);
            if (dest == null) throw new Exception("the phone refused to create the file");
            try (InputStream in = new FileInputStream(src); OutputStream os = cr.openOutputStream(dest)) {
                if (os == null) throw new Exception("could not open the file for writing");
                byte[] buf = new byte[256 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            } catch (Exception e) {
                try { cr.delete(dest, null, null); } catch (Exception ignored) { }
                throw e;
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.Video.Media.IS_PENDING, 0);
            cr.update(dest, done, null, null);
            return dest.toString();
        }
        // Android 9 and older: the app's own movie folder
        File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_MOVIES);
        if (dir == null) throw new Exception("no storage available");
        File dst = new File(dir, display);
        try (InputStream in = new FileInputStream(src); OutputStream os = new java.io.FileOutputStream(dst)) {
            byte[] buf = new byte[256 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
        }
        return Uri.fromFile(dst).toString();
    }

    private void failRun(String message) {
        PluginCall c = runCall;
        runCall = null;
        current = null;
        polling = false;
        if (c != null) c.reject(message);
    }

    @PluginMethod
    public void cancel(final PluginCall call) {
        main.post(() -> {
            polling = false;
            Transformer t = current;
            current = null;
            if (t != null) { try { t.cancel(); } catch (Exception ignored) { } }
            PluginCall c = runCall;
            runCall = null;
            if (c != null) c.reject("Stopped.", "CANCELLED");
            call.resolve();
        });
    }

    // ───────────────────────── look ─────────────────────────

    private static float aspectRatio(String a) {
        switch (a) {
            case "9:16": return 9f / 16f;
            case "4:5": return 4f / 5f;
            case "1:1": return 1f;
            case "16:9": return 16f / 9f;
            default: return 0f; // original: keep the shape
        }
    }

    private static int outputHeight(String a) {
        switch (a) {
            case "9:16": return 1280;
            case "4:5": return 1080;
            case "1:1": return 1080;
            case "16:9": return 720;
            default: return 0;
        }
    }

    private static Effect partOverlay(int part, int frameHeight) {
        String label = "PART " + part;
        SpannableString text = new SpannableString(label);
        int size = Math.max(36, frameHeight / 16);
        text.setSpan(new ForegroundColorSpan(Color.WHITE), 0, label.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        text.setSpan(new AbsoluteSizeSpan(size), 0, label.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        text.setSpan(new StyleSpan(Typeface.BOLD), 0, label.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        OverlaySettings settings = new OverlaySettings.Builder()
                .setBackgroundFrameAnchor(0f, 0.78f) // horizontally centred, near the top
                .setOverlayFrameAnchor(0f, 0f)
                .build();
        TextureOverlay overlay = TextOverlay.createStaticTextOverlay(text, settings);
        return new OverlayEffect(ImmutableList.of(overlay));
    }

    // ───────────────────────── hand-off ─────────────────────────

    @PluginMethod
    public void openClip(PluginCall call) {
        String u = call.getString("uri");
        if (u == null) { call.reject("No clip given."); return; }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(Uri.parse(u), "video/mp4");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("No app on this phone can play the clip: " + e.getMessage());
        }
    }

    @PluginMethod
    public void shareClip(PluginCall call) {
        String u = call.getString("uri");
        if (u == null) { call.reject("No clip given."); return; }
        try {
            Intent s = new Intent(Intent.ACTION_SEND);
            s.setType("video/mp4");
            s.putExtra(Intent.EXTRA_STREAM, Uri.parse(u));
            s.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(s, "Share clip");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open the share sheet: " + e.getMessage());
        }
    }
}
