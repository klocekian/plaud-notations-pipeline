#!/usr/bin/env bash
set -euo pipefail

# plaud-transcribe.sh
# Download a Plaud recording's audio and transcribe it locally with whisper.cpp,
# writing a Markdown note in the grounding vault's Meetings format.
#
# This is the "download + transcribe + format" half of the pipeline. The auth +
# listing + presigned-URL half is handled by Claude via the Plaud MCP server
# (tokens live in ~/.plaud/tokens-mcp.json and refresh automatically). Claude
# passes a fresh presigned URL (valid 24h) into --url.
#
# Usage:
#   plaud-transcribe.sh --url  <presigned_mp3_url> --out <file.md> [meta...]
#   plaud-transcribe.sh --audio <local.mp3>        --out <file.md> [meta...]
#
# Metadata flags (all optional, for the note header):
#   --title "..."        human title
#   --date  "Aug 18, 2026 2:58 PM PDT"
#   --id    <plaud_file_id>
#   --duration-ms <int>  raw Plaud duration (ms) -> rendered human-readable
#
# Diarization (optional):
#   --diarize            label speakers via sherpa-onnx (local, no account)
#   --speakers <N>       force N speakers. STRONGLY recommended — auto-detect
#                        over-clusters badly (e.g. 88 "speakers" on a 4-person
#                        call). Pass the known count of distinct voices.
#
# Env overrides:
#   WHISPER_MODEL  (default ~/.config/claude-watch/models/ggml-small.en.bin)
#   WHISPER_BIN    (default whisper-cli)
#   THREADS        (default hw.ncpu)
#   DIARIZE_PY     (default ~/.config/plaud-diarize/venv/bin/python)
#   DIARIZE_SCRIPT (default ~/bin/plaud-diarize.py)

MODEL="${WHISPER_MODEL:-$HOME/.config/claude-watch/models/ggml-small.en.bin}"
WHISPER_BIN="${WHISPER_BIN:-whisper-cli}"
THREADS="${THREADS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
# Diarization (optional, --diarize): sherpa-onnx via a dedicated venv + models
DIARIZE_PY="${DIARIZE_PY:-$HOME/.config/plaud-diarize/venv/bin/python}"
DIARIZE_SCRIPT="${DIARIZE_SCRIPT:-$HOME/bin/plaud-diarize.py}"

URL="" AUDIO="" OUT="" JSON_OUT="" TITLE="" DATE="" ID="" DURMS="" DIARIZE="" SPEAKERS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2;;
    --audio) AUDIO="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --json-out) JSON_OUT="$2"; shift 2;;
    --title) TITLE="$2"; shift 2;;
    --date) DATE="$2"; shift 2;;
    --id) ID="$2"; shift 2;;
    --duration-ms) DURMS="$2"; shift 2;;
    --diarize) DIARIZE=1; shift;;
    --speakers) SPEAKERS="$2"; shift 2;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "Unknown arg: $1" >&2; exit 2;;
  esac
done

[[ -n "$OUT" || -n "$JSON_OUT" ]] || { echo "ERROR: --out and/or --json-out required" >&2; exit 2; }
[[ -f "$MODEL" ]]   || { echo "ERROR: whisper model not found: $MODEL" >&2; exit 2; }
command -v ffmpeg >/dev/null       || { echo "ERROR: ffmpeg not found" >&2; exit 2; }
command -v "$WHISPER_BIN" >/dev/null || { echo "ERROR: $WHISPER_BIN not found" >&2; exit 2; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
MP3="$WORK/audio.mp3"

if [[ -n "$URL" ]]; then
  echo "[1/4] Downloading audio…" >&2
  curl -fsSL "$URL" -o "$MP3"
elif [[ -n "$AUDIO" ]]; then
  echo "[1/4] Using local audio: $AUDIO" >&2
  cp "$AUDIO" "$MP3"
else
  echo "ERROR: provide --url or --audio" >&2; exit 2
fi

echo "[2/4] Converting to 16kHz mono WAV…" >&2
WAV="$WORK/audio.wav"
ffmpeg -nostdin -loglevel error -y -i "$MP3" -ar 16000 -ac 1 -c:a pcm_s16le "$WAV"

echo "[3/4] Transcribing with $(basename "$MODEL") on $THREADS threads…" >&2
BASE="$WORK/out"
# -oj (JSON w/ timestamps) is needed for diarization alignment AND for --json-out
# structured utterances; -otxt for the plain-text fallback.
WHISPER_OUTS=(-otxt)
[[ -n "$DIARIZE" || -n "$JSON_OUT" ]] && WHISPER_OUTS+=(-oj)
"$WHISPER_BIN" -m "$MODEL" -f "$WAV" -t "$THREADS" -l en "${WHISPER_OUTS[@]}" -of "$BASE" -pp >&2

# Optional speaker diarization (sherpa-onnx) -> labeled transcript
LABELED=""
DIARIZE_NOTE=""
if [[ -n "$DIARIZE" ]]; then
  if [[ -x "$DIARIZE_PY" && -f "$DIARIZE_SCRIPT" ]]; then
    echo "[3b] Diarizing (sherpa-onnx${SPEAKERS:+, ${SPEAKERS} speakers})…" >&2
    LABELED="$WORK/labeled.txt"
    SPK_ARG=(); [[ -n "$SPEAKERS" ]] && SPK_ARG=(--num-speakers "$SPEAKERS")
    JSON_ARG=(); [[ -n "$JSON_OUT" ]] && JSON_ARG=(--json-out "$JSON_OUT")
    if "$DIARIZE_PY" "$DIARIZE_SCRIPT" --wav "$WAV" --whisper-json "$BASE.json" \
         --out "$LABELED" "${SPK_ARG[@]+"${SPK_ARG[@]}"}" "${JSON_ARG[@]+"${JSON_ARG[@]}"}" >&2; then
      DIARIZE_NOTE=" + sherpa-onnx diarization${SPEAKERS:+ (${SPEAKERS} speakers)}"
    else
      echo "WARN: diarization failed; falling back to plain transcript" >&2
      LABELED=""
    fi
  else
    echo "WARN: --diarize requested but $DIARIZE_PY / $DIARIZE_SCRIPT missing; plain transcript" >&2
  fi
fi

# Structured utterances JSON for the Notations ingest path. Diarization writes it
# directly (labeled speakers); otherwise derive it from whisper's -oj segments
# with a single "Speaker" label.
if [[ -n "$JSON_OUT" && ! -s "$JSON_OUT" ]]; then
  echo "[3c] Building utterances JSON (no diarization) -> $(basename "$JSON_OUT")…" >&2
  python3 - "$BASE.json" "$JSON_OUT" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src) as f:
    wj = json.load(f)
utts = []
for seg in wj.get("transcription", []):
    text = (seg.get("text") or "").strip()
    if not text:
        continue
    off = seg.get("offsets", {})
    utts.append({
        "start_time": int(off.get("from", 0)),
        "end_time": int(off.get("to", 0)),
        "speaker": "Speaker",
        "content": text,
    })
with open(dst, "w") as f:
    json.dump(utts, f, ensure_ascii=False)
print(f"[json] wrote {len(utts)} utterances -> {dst}", file=sys.stderr)
PY
fi

# Human-readable duration from ms
DURH=""
if [[ -n "$DURMS" ]]; then
  s=$(( DURMS / 1000 ))
  if (( s >= 3600 )); then DURH="$(( s/3600 ))h$(printf '%02d' $(( (s%3600)/60 )))m"
  else DURH="$(( s/60 ))m$(printf '%02d' $(( s%60 )))s"; fi
fi

MODEL_TAG="$(basename "$MODEL" .bin | sed 's/^ggml-//')"

if [[ -n "$OUT" ]]; then
  echo "[4/4] Writing ${OUT}…" >&2
  mkdir -p "$(dirname "$OUT")"
  {
    echo "# ${TITLE:-Untitled Plaud recording}"
    echo
    [[ -n "$DATE" ]] && echo "- **Date:** $DATE"
    [[ -n "$DURH" ]] && echo "- **Duration:** $DURH"
    [[ -n "$ID"   ]] && echo "- **Plaud ID:** $ID"
    if [[ -n "$LABELED" ]]; then
      echo "- **Source:** Plaud device (local Whisper \`$MODEL_TAG\`$DIARIZE_NOTE)"
    else
      echo "- **Source:** Plaud device (local Whisper \`$MODEL_TAG\` — no speaker diarization)"
    fi
    echo
    echo "---"
    echo
    if [[ -n "$LABELED" ]]; then cat "$LABELED"; else cat "$BASE.txt"; fi
  } > "$OUT"
  echo "Done: $OUT" >&2
fi

[[ -n "$JSON_OUT" ]] && echo "Done (JSON): $JSON_OUT" >&2
exit 0
