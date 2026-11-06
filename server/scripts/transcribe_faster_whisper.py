#!/usr/bin/env python3
"""Speech to text with faster-whisper, for ClipperIQ's auto captions.

    python transcribe_faster_whisper.py <audio.wav> <out.json> <model> [language|auto]

Writes {"language": "en", "words": [{"s": 1.2, "e": 1.5, "w": "Hello"}, ...]} and prints "PROGRESS 0.42" lines while it works.
Install once with:  pip install faster-whisper     (the model is downloaded the first time it is used)
"""
import json
import sys


def main():
    if len(sys.argv) < 4:
        print("usage: transcribe_faster_whisper.py <audio> <out.json> <model> [language]", file=sys.stderr)
        return 2
    audio, out, model_name = sys.argv[1], sys.argv[2], sys.argv[3]
    language = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] not in ("", "auto") else None
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper is not installed. Run: pip install faster-whisper", file=sys.stderr)
        return 3
    model = WhisperModel(model_name, device="auto", compute_type="auto")
    segments, info = model.transcribe(audio, language=language, word_timestamps=True, vad_filter=True, beam_size=5)
    total = float(getattr(info, "duration", 0) or 0)
    words = []
    for seg in segments:
        for w in (seg.words or []):
            text = (w.word or "").strip()
            if text:
                words.append({"s": round(float(w.start), 3), "e": round(float(w.end), 3), "w": text})
        if total > 0:
            print("PROGRESS %.3f" % min(0.99, float(seg.end) / total), flush=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"language": getattr(info, "language", language or ""), "words": words}, f, ensure_ascii=False)
    print("PROGRESS 1.000", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
