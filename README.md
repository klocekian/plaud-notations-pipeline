# Plaud → Notations Pipeline

One button that turns a **Plaud voice recording** into a **searchable, formatted meeting note filed in Notations** — with a real, local transcript. No cloud transcription service, no copy-pasting, no manual formatting.

Grab a recording → transcribe it on your own Mac with Whisper → upload the transcript (plus an optional AI-summary companion) to your Notations "Meetings" folder as a draft. All from a single local web page.

---

## What it does, from the user's side

You wear a Plaud recorder (or use the app) during a meeting, a call, a lecture, a doctor's visit. Later you open one page in your browser and get a clean, filed, searchable note out the other end. That's the whole experience.

### The one-button flow
Open **`http://localhost:8791`**. You see:

1. **A dropdown of your recent Plaud recordings** — pulled live from your account, newest first, with names, dates, and durations. Accidental sub-60-second blips and demo files are filtered out automatically, so the list is just your real recordings.
2. **A big "▶ Grab & transcribe" button.** Press it. The page shows a live progress bar and a real terminal feed as it downloads the audio, converts it, and transcribes — you watch Whisper's percentage climb, not a fake spinner.
3. **A finished note** — written to disk and filed in Notations as a draft in your **Meetings** folder, tagged `plaud` / `recording`. A link appears when it's done.

That's it. Pick, press, done.

### What makes it genuinely useful

- **Real transcription, done locally.** Audio never goes to a third-party transcription API. Whisper (`small.en`) runs on your own machine, so the transcript is private and free — no per-minute billing, no upload of sensitive conversations. A one-hour recording transcribes in roughly 90 seconds per hour of audio.
- **Zero copy-paste.** It talks to Plaud directly to fetch the recording and to Notations directly to file the note. You never touch a file path, a download button, or a share URL.
- **Speaker labels (optional).** Tick **Diarize** and give it the number of people in the room, and the transcript comes back as `Speaker 1:` / `Speaker 2:` turns instead of one undifferentiated wall of text — again, entirely local (sherpa-onnx, no account).
- **Bring your own audio.** Not everything is on a Plaud device. Hit **Choose file…** to transcribe any local audio or video file through the exact same pipeline and filing.
- **Filed, not just transcribed.** The output isn't a loose `.txt` — it's a formatted Markdown note (title, date, duration, source, transcript) saved to `~/Documents/plaud-runs/` **and** posted to Notations as a searchable draft you can clean up and publish. Nothing gets lost in a downloads folder.
- **Always on, out of your way.** It runs as a quiet background login service. There's no app to launch — the page is just there at `localhost:8791` whenever you want it, and it restarts itself if it ever dies.
- **Honest about what's happening.** The progress display maps to the real work: downloading, converting, transcribing (with a live %), labeling speakers, writing, uploading. If something fails — a bad download URL, a missing token — it tells you exactly what and where, in plain language.

### The value in one line
It collapses "I recorded that meeting" → "it's a clean, speaker-labeled, searchable note in my knowledge base" into a single click, keeps the audio private by transcribing on your own machine, and costs nothing per recording.

### Who it's for
Anyone already recording with Plaud who wants those recordings to *become something* — consultants and clinicians who need meeting/visit notes, researchers logging interviews, students capturing lectures, anyone building a searchable personal record of what was said. If you value privacy (local transcription) and hate manual filing (automatic upload), this is the point.

---

## How it fits together (technical)

Three stages, three components:

```
   ┌─────────────┐        ┌──────────────────────┐        ┌──────────────────┐
   │  Plaud MCP  │  grab  │  plaud-transcribe.sh │ upload │   Notations MCP  │
   │ (recordings)│ ─────▶ │  ffmpeg → whisper.cpp │ ─────▶ │ (Meetings, draft)│
   └─────────────┘        │  → Markdown note      │        └──────────────────┘
                          └──────────────────────┘
             all orchestrated by  plaud-pipeline-server.mjs  (localhost:8791)
                     UI: plaud-pipeline.html  ·  setup: plaud-setup.html
```

| File | Role |
|------|------|
| `web/plaud-pipeline.html` | The single-page UI — recording picker, run button, live progress + terminal. |
| `web/plaud-setup.html` | Requirements page + a one-shot Claude Code install prompt. |
| `bin/plaud-pipeline-server.mjs` | Zero-dependency Node server. Serves the UI, lists recordings and pulls presigned URLs via the Plaud MCP, runs the transcribe script, and posts the result to the Notations MCP. |
| `bin/plaud-transcribe.sh` | Download → `ffmpeg` (16 kHz mono WAV) → `whisper-cli` → formatted Markdown note. Optional diarization. |
| `bin/plaud-diarize.py` | Local speaker diarization (sherpa-onnx) — clusters speakers and labels each turn. |
| `launchd/com.stefan.plaud-pipeline.plist` | The concrete login service (port 8791, RunAtLoad + KeepAlive). |
| `launchd/com.USER.plaud-pipeline.plist.template` | Portable version of the above; `install.sh` fills it in for your user. |

### Ports & config
- The server's **code default is 8787**, but the launchd plist overrides it to **`PORT=8791`** (8787 is often taken by other dev tools). Open **8791** in practice.
- Env knobs: `PORT`, `PLAUD_HTML`, `TRANSCRIBE`, `NOTATIONS_MCP`, `NOTATIONS_TOKEN` / `FIELDLINES_TOKEN`, `WHISPER_MODEL`, `WHISPER_BIN`, `THREADS`.

---

## Install

```bash
./install.sh
```

Then open **http://localhost:8791**.

`install.sh` copies the scripts to `~/bin`, the UI to `~/Desktop`, generates a personalized launchd plist, and starts the service. It is idempotent.

### Prerequisites (not auto-installed)
```bash
brew install ffmpeg whisper-cpp
# Whisper model → ~/.config/claude-watch/models/ggml-small.en.bin
npx -y @plaud-ai/mcp@latest install     # one-time Plaud browser login
```
Plus a **Notations MCP token** in `NOTATIONS_TOKEN` or `FIELDLINES_TOKEN`.

Optional (speaker labels): a sherpa-onnx venv at `~/.config/plaud-diarize/` with the pyannote segmentation + titanet embedding ONNX models under `~/.config/plaud-diarize/models/`.

> The setup page (`web/plaud-setup.html`) also contains a paste-into-Claude-Code prompt that provisions all of this for you.

---

## Notes

- **Privacy:** transcription and diarization are 100% local. Only the recording download (from your own Plaud account) and the final note upload (to your own Notations) touch the network.
- **The AI-summary companion** (`add_iteration`) mentioned in the UI is added by Claude, not the server — it needs an LLM, so it's a deliberate manual step.
- **Diarization tip:** always pass the real speaker count. Auto-detect over-clusters badly (it'll happily invent 88 speakers on a 4-person call).
