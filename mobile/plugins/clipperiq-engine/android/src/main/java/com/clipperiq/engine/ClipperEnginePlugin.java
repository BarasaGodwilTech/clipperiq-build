package com.clipperiq.engine;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
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
import android.util.Base64;
import android.util.LruCache;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.AbsoluteSizeSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.StyleSpan;

import androidx.activity.result.ActivityResult;
import androidx.media3.common.Effect;
import androidx.media3.common.VideoFrameProcessingException;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.audio.SonicAudioProcessor;
import androidx.media3.effect.BitmapOverlay;
import androidx.media3.effect.Brightness;
import androidx.media3.effect.Contrast;
import androidx.media3.effect.Crop;
import androidx.media3.effect.HslAdjustment;
import androidx.media3.effect.OverlayEffect;
import androidx.media3.effect.OverlaySettings;
import androidx.media3.effect.Presentation;
import androidx.media3.effect.ScaleAndRotateTransformation;
import androidx.media3.effect.SpeedChangeEffect;
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

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
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

    private static class Job { long startMs; long durMs; int part; JSONArray overlays; }

    /** Look settings shared by every clip of a run (framing, colour, flip, speed, pitch). */
    private static class Fx {
        int outW = 0, outH = 0;          // output frame size (0 = keep the source)
        boolean fit = false;             // true: whole picture visible with bars; false: fill (crop)
        float fitScale = 1f;             // zoom inside a 'fit' frame
        float cx0 = 0, cy0 = 0, cx1 = 1, cy1 = 1; boolean hasCrop = false; // crop window as fractions of the source
        boolean flipH = false, flipV = false;
        float brightness = 0f, contrast = 0f, saturation = 0f; // brightness/contrast -1..1, saturation percent -100..100
        float speed = 1f, pitch = 1f; boolean preservePitch = true;
    }
    private Fx fx = new Fx();

    // ───────────────────────── lower-third layers ─────────────────────────
    // The page draws the animation with the same code as the Windows version and hands over the frames; they are laid over
    // the clip at the right moments (see LayerOverlay).
    private static class LayerMeta {
        String key; int frameW, frameH, width, height, y0; float fps, startSec, seconds; boolean loop; int[] map; File dir;
    }
    private final HashMap<String, LayerMeta> layers = new HashMap<>();

    private class LayerOverlay extends BitmapOverlay {
        private final LayerMeta m;
        private final Bitmap blank = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888);
        private final LruCache<Integer, Bitmap> cache = new LruCache<>(40);
        private final OverlaySettings shown;
        private final OverlaySettings hidden = new OverlaySettings.Builder().setAlphaScale(0f).build();

        LayerOverlay(LayerMeta meta) {
            this.m = meta;
            float ay = 1f - 2f * ((m.y0 + m.height / 2f) / (float) m.frameH); // centre of the band, top = +1
            shown = new OverlaySettings.Builder()
                    .setBackgroundFrameAnchor(0f, ay)
                    .setOverlayFrameAnchor(0f, 0f)
                    .build();
        }

        private int frameAt(long presentationTimeUs) {
            double local = presentationTimeUs / 1e6 - m.startSec;
            if (local < 0) return -1;
            if (m.loop) local = local % m.seconds; else if (local >= m.seconds) return -1;
            int i = (int) Math.floor(local * m.fps);
            if (i < 0) i = 0; if (i >= m.map.length) i = m.map.length - 1;
            return m.map[i];
        }

        @Override
        public Bitmap getBitmap(long presentationTimeUs) throws VideoFrameProcessingException {
            int idx = frameAt(presentationTimeUs);
            if (idx < 0) return blank;
            Bitmap b = cache.get(idx);
            if (b == null) {
                b = BitmapFactory.decodeFile(new File(m.dir, idx + ".png").getAbsolutePath());
                if (b == null) return blank;
                cache.put(idx, b);
            }
            return b;
        }

        @Override
        public OverlaySettings getOverlaySettings(long presentationTimeUs) {
            return frameAt(presentationTimeUs) < 0 ? hidden : shown;
        }
    }

    @PluginMethod
    public void beginOverlay(PluginCall call) {
        try {
            LayerMeta m = new LayerMeta();
            m.key = call.getString("key");
            if (m.key == null || m.key.isEmpty()) { call.reject("No overlay key."); return; }
            m.frameW = call.getInt("frameW", 0); m.frameH = call.getInt("frameH", 0);
            m.width = call.getInt("width", 0); m.height = call.getInt("height", 0); m.y0 = call.getInt("y0", 0);
            Float fps = call.getFloat("fps", 24f); m.fps = fps == null ? 24f : fps;
            Float st = call.getFloat("startSec", 0f); m.startSec = st == null ? 0f : st;
            Float sec = call.getFloat("seconds", 1f); m.seconds = sec == null || sec <= 0 ? 1f : sec;
            Boolean lp = call.getBoolean("loop", false); m.loop = lp != null && lp;
            JSArray map = call.getArray("map");
            if (map == null || map.length() == 0 || m.frameW <= 0 || m.frameH <= 0 || m.height <= 0) { call.reject("The overlay description is not valid."); return; }
            m.map = new int[map.length()];
            for (int i = 0; i < m.map.length; i++) m.map[i] = map.getInt(i);
            m.dir = new File(getContext().getCacheDir(), "ov_" + m.key.replaceAll("[^A-Za-z0-9_-]", "_"));
            //noinspection ResultOfMethodCallIgnored
            m.dir.mkdirs();
            synchronized (layers) { layers.put(m.key, m); }
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not prepare the overlay: " + e.getMessage());
        }
    }

    @PluginMethod
    public void addOverlayFrames(final PluginCall call) {
        final String key = call.getString("key");
        final Integer start = call.getInt("start", 0);
        final JSArray frames = call.getArray("frames");
        final LayerMeta m;
        synchronized (layers) { m = key == null ? null : layers.get(key); }
        if (m == null || frames == null) { call.reject("Unknown overlay."); return; }
        new Thread(() -> {
            try {
                for (int i = 0; i < frames.length(); i++) {
                    String url = frames.getString(i);
                    int comma = url.indexOf(',');
                    byte[] bytes = Base64.decode(url.substring(comma + 1), Base64.DEFAULT);
                    try (FileOutputStream os = new FileOutputStream(new File(m.dir, ((start == null ? 0 : start) + i) + ".png"))) { os.write(bytes); }
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("Could not store overlay pictures: " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void clearOverlays(PluginCall call) {
        synchronized (layers) {
            for (LayerMeta m : layers.values()) {
                File[] fs = m.dir == null ? null : m.dir.listFiles();
                if (fs != null) for (File f : fs) //noinspection ResultOfMethodCallIgnored
                    f.delete();
                if (m.dir != null) //noinspection ResultOfMethodCallIgnored
                    m.dir.delete();
            }
            layers.clear();
        }
        call.resolve();
    }

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

    /** One picture from the video at a given time (for choosing where clips start and end). Returns a small JPEG as a data url. */
    @PluginMethod
    public void frame(final PluginCall call) {
        final String uriStr = call.getString("uri");
        final Long at = call.getLong("atMs", 0L);
        final Integer w = call.getInt("width", 320);
        if (uriStr == null) { call.reject("No video given."); return; }
        new Thread(() -> {
            MediaMetadataRetriever mmr = new MediaMetadataRetriever();
            try {
                mmr.setDataSource(getContext(), Uri.parse(uriStr));
                Bitmap bmp = mmr.getFrameAtTime((at == null ? 0L : at) * 1000L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
                if (bmp == null) { call.reject("No picture at that time."); return; }
                int tw = Math.max(64, Math.min(1080, w == null ? 320 : w));
                int th = Math.max(1, Math.round(bmp.getHeight() * (tw / (float) bmp.getWidth())));
                Bitmap scaled = Bitmap.createScaledBitmap(bmp, tw, th, true);
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                scaled.compress(Bitmap.CompressFormat.JPEG, 70, bos);
                JSObject ret = new JSObject();
                ret.put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Could not read a picture: " + e.getMessage());
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
                j.overlays = o.optJSONArray("overlays");
                if (j.durMs < 500) continue;
                list.add(j);
            }
        } catch (Exception e) {
            call.reject("The list of clips was not valid: " + e.getMessage());
            return;
        }
        if (list.isEmpty()) { call.reject("Nothing to cut."); return; }
        final Fx newFx = readFx(call.getObject("fx"));
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
            fx = newFx;
            partText = pt == null || pt;
            baseName = safeName(name);
            outputs = new JSArray();
            runStartedAt = System.currentTimeMillis();
            runNext();
        });
    }

    private static Fx readFx(JSObject o) {
        Fx f = new Fx();
        if (o == null) return f;
        f.outW = o.optInt("outW", 0); f.outH = o.optInt("outH", 0);
        f.fit = o.optBoolean("fit", false);
        f.fitScale = (float) o.optDouble("fitScale", 1.0);
        JSONObject c = o.optJSONObject("crop");
        if (c != null) {
            f.hasCrop = true;
            f.cx0 = (float) c.optDouble("x0", 0); f.cy0 = (float) c.optDouble("y0", 0);
            f.cx1 = (float) c.optDouble("x1", 1); f.cy1 = (float) c.optDouble("y1", 1);
        }
        f.flipH = o.optBoolean("flipH", false); f.flipV = o.optBoolean("flipV", false);
        f.brightness = (float) o.optDouble("brightness", 0); f.contrast = (float) o.optDouble("contrast", 0);
        f.saturation = (float) o.optDouble("saturation", 0);
        f.speed = (float) o.optDouble("speed", 1.0); f.pitch = (float) o.optDouble("pitch", 1.0);
        f.preservePitch = o.optBoolean("preservePitch", true);
        f.brightness = Math.max(-1f, Math.min(1f, f.brightness));
        f.contrast = Math.max(-1f, Math.min(1f, f.contrast));
        f.saturation = Math.max(-100f, Math.min(100f, f.saturation));
        if (Float.isNaN(f.brightness)) f.brightness = 0f;
        if (Float.isNaN(f.contrast)) f.contrast = 0f;
        if (Float.isNaN(f.saturation)) f.saturation = 0f;
        if (f.speed < 0.5f || f.speed > 2f || Float.isNaN(f.speed)) f.speed = 1f;
        if (f.pitch < 0.4f || f.pitch > 2.5f || Float.isNaN(f.pitch)) f.pitch = 1f;
        return f;
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
            // 1. framing: crop window (fill) or fit with bars, then the output size
            float ar = aspectRatio(aspect);
            int outH = fx.outH > 0 ? fx.outH : outputHeight(aspect);
            if (fx.hasCrop) {
                // fractions of the source; Crop wants -1..1 with y pointing up
                video.add(new Crop(-1f + 2f * fx.cx0, -1f + 2f * fx.cx1, 1f - 2f * fx.cy1, 1f - 2f * fx.cy0));
            }
            if (ar > 0f) {
                video.add(Presentation.createForAspectRatio(ar, fx.fit ? Presentation.LAYOUT_SCALE_TO_FIT : Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP));
            }
            if (outH > 0) video.add(Presentation.createForHeight(outH));
            // 2. flip and zoom
            if (fx.flipH || fx.flipV || Math.abs(fx.fitScale - 1f) > 0.001f) {
                float sc = fx.fit ? fx.fitScale : 1f;
                video.add(new ScaleAndRotateTransformation.Builder().setScale((fx.flipH ? -1f : 1f) * sc, (fx.flipV ? -1f : 1f) * sc).build());
            }
            // 3. colour
            if (Math.abs(fx.brightness) > 0.0001f) video.add(new Brightness(fx.brightness));
            if (Math.abs(fx.contrast) > 0.0001f) video.add(new Contrast(fx.contrast));
            if (Math.abs(fx.saturation) > 0.01f) video.add(new HslAdjustment.Builder().adjustSaturation(fx.saturation).build());
            // 4. speed (the picture here, the sound below)
            List<AudioProcessor> audio = new ArrayList<>();
            boolean speedChanged = Math.abs(fx.speed - 1f) > 0.001f;
            boolean pitchChanged = Math.abs(fx.pitch - 1f) > 0.001f;
            if (speedChanged) video.add(new SpeedChangeEffect(fx.speed));
            if (speedChanged || pitchChanged) {
                SonicAudioProcessor sonic = new SonicAudioProcessor();
                sonic.setSpeed(fx.speed);
                sonic.setPitch((fx.preservePitch ? 1f : fx.speed) * fx.pitch);
                audio.add(sonic);
            }
            // 5. lower thirds and the PART label are laid on top, so colour, flip and zoom never touch them
            List<TextureOverlay> overlays = new ArrayList<>();
            if (job.overlays != null) {
                for (int k = 0; k < job.overlays.length(); k++) {
                    LayerMeta lm;
                    synchronized (layers) { lm = layers.get(job.overlays.optString(k)); }
                    if (lm != null) overlays.add(new LayerOverlay(lm));
                }
            }
            if (partText && job.part > 0) overlays.add(partOverlayTexture(job.part, outH > 0 ? outH : 1080));
            if (!overlays.isEmpty()) video.add(new OverlayEffect(ImmutableList.copyOf(overlays)));

            EditedMediaItem edited = new EditedMediaItem.Builder(item)
                    .setEffects(new Effects(audio, video))
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

    private static TextureOverlay partOverlayTexture(int part, int frameHeight) {
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
        return TextOverlay.createStaticTextOverlay(text, settings);
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
