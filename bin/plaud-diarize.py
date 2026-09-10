#!/usr/bin/env python3
"""
plaud-diarize.py — local speaker diarization for the Plaud pipeline.

Takes a 16 kHz mono WAV plus whisper.cpp JSON (segments with ms offsets),
clusters speakers with sherpa-onnx (offline, no account/token), and writes a
labeled transcript: `[MM:SS] Speaker N: text`, merging consecutive same-speaker
lines.

Usage:
  plaud-diarize.py --wav a.wav --whisper-json a.json --out labeled.txt \
      [--num-speakers N] [--threshold 0.5]

Models (defaults under ~/.config/plaud-diarize/models):
  --seg-model  sherpa-onnx-pyannote-segmentation-3-0/model.onnx
  --emb-model  nemo_en_titanet_small.onnx
"""
import argparse
import json
import os
import sys
import wave

import numpy as np
import sherpa_onnx

HOME = os.path.expanduser("~")
MODELS = os.path.join(HOME, ".config/plaud-diarize/models")


def load_wav(path):
    with wave.open(path, "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            sys.exit(f"WAV must be 16kHz mono s16le, got "
                     f"{w.getframerate()}Hz/{w.getnchannels()}ch/{w.getsampwidth()*8}bit")
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def mmss(sec):
    sec = int(sec)
    return f"{sec // 60:02d}:{sec % 60:02d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True)
    ap.add_argument("--whisper-json", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--json-out", default=None,
                    help="Also write structured utterances JSON "
                         "[{start_time ms, end_time ms, speaker, content}] here.")
    ap.add_argument("--seg-model",
                    default=os.path.join(MODELS, "sherpa-onnx-pyannote-segmentation-3-0/model.onnx"))
    ap.add_argument("--emb-model", default=os.path.join(MODELS, "nemo_en_titanet_small.onnx"))
    ap.add_argument("--num-speakers", type=int, default=-1,
                    help="Fixed speaker count; -1 = auto-detect (default).")
    ap.add_argument("--threshold", type=float, default=0.5,
                    help="Clustering threshold when auto-detecting (higher = fewer speakers).")
    a = ap.parse_args()

    for m in (a.seg_model, a.emb_model):
        if not os.path.isfile(m):
            sys.exit(f"Model not found: {m}")

    cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=a.seg_model),
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=a.emb_model),
        clustering=sherpa_onnx.FastClusteringConfig(
            num_clusters=a.num_speakers, threshold=a.threshold),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not cfg.validate():
        sys.exit("Invalid sherpa-onnx diarization config")

    print("[diarize] clustering speakers…", file=sys.stderr)
    sd = sherpa_onnx.OfflineSpeakerDiarization(cfg)
    audio = load_wav(a.wav)
    dia = [(s.start, s.end, s.speaker) for s in sd.process(audio).sort_by_start_time()]
    n_spk = len({s for _, _, s in dia})
    print(f"[diarize] found {n_spk} speaker(s), {len(dia)} speech segments", file=sys.stderr)

    # Whisper segments (offsets are ms)
    with open(a.whisper_json) as f:
        wj = json.load(f)
    segs = wj.get("transcription", [])

    def speaker_for(t0, t1):
        """Speaker id with max temporal overlap with [t0,t1] (seconds)."""
        best, best_ov = None, 0.0
        for s, e, spk in dia:
            ov = max(0.0, min(t1, e) - max(t0, s))
            if ov > best_ov:
                best_ov, best = ov, spk
        return best

    # Build labeled, merging consecutive same-speaker segments
    lines, cur_spk, cur_text, cur_start, cur_end = [], None, [], None, None
    for seg in segs:
        text = seg["text"].strip()
        if not text:
            continue
        t0 = seg["offsets"]["from"] / 1000.0
        t1 = seg["offsets"]["to"] / 1000.0
        spk = speaker_for(t0, t1)
        if spk != cur_spk and cur_text:
            lines.append((cur_start, cur_end, cur_spk, " ".join(cur_text)))
            cur_text = []
        if not cur_text:
            cur_start, cur_spk = t0, spk
        cur_end = t1
        cur_text.append(text)
    if cur_text:
        lines.append((cur_start, cur_end, cur_spk, " ".join(cur_text)))

    def label_for(spk):
        return f"Speaker {spk + 1}" if spk is not None else "Speaker ?"

    with open(a.out, "w") as f:
        for start, _end, spk, text in lines:
            f.write(f"[{mmss(start)}] {label_for(spk)}: {text}\n")

    if a.json_out:
        utts = [
            {
                "start_time": int(round(start * 1000)),
                "end_time": int(round(end * 1000)),
                "speaker": label_for(spk),
                "content": text,
            }
            for start, end, spk, text in lines
        ]
        with open(a.json_out, "w") as f:
            json.dump(utts, f, ensure_ascii=False)
        print(f"[diarize] wrote {len(utts)} utterances (JSON) -> {a.json_out}", file=sys.stderr)

    print(f"[diarize] wrote {len(lines)} labeled turns -> {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
