#!/usr/bin/env node
/**
 * plaud-pipeline-server — serves plaud-pipeline.html and drives the REAL
 * transcribe script (~/bin/plaud-transcribe.sh), streaming live per-step status
 * the page polls.
 *
 * Stage 2 (Transcribe) is genuinely executed here. Stages 1 (Grab, Plaud MCP)
 * and 3 (Upload, Fieldlines MCP) are orchestrated by Claude via MCP, not by this
 * server, so the page shows them as manual/MCP steps.
 *
 * Zero dependencies (Node 18+). Run:
 *   node ~/bin/plaud-pipeline-server.mjs      # then open http://localhost:8787
 * Env: PORT (default 8787), PLAUD_HTML (default ~/plaud-pipeline.html),
 *      TRANSCRIBE (default ~/bin/plaud-transcribe.sh).
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const PORT = Number(process.env.PORT ?? 8787);
const HOME = homedir();
const HTML = process.env.PLAUD_HTML ?? join(HOME, "plaud-pipeline.html");
const TRANSCRIBE = process.env.TRANSCRIBE ?? join(HOME, "bin", "plaud-transcribe.sh");
const OUT_DIR = join(HOME, "Documents", "plaud-runs");
const MIN_DURATION_MS = 60_000; // skip accidental blips
const DEFAULT_NAME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/; // Plaud's untitled fallback

// --- Plaud MCP stdio client (the "Grab" half) -------------------------------
// Talks to the same consumer login the CLI/skills use (tokens auto-refresh at
// ~/.plaud/tokens-mcp.json). Lazily spawned, reused across requests.
class Mcp {
  constructor() {
    this.proc = spawn("npx", ["-y", "@plaud-ai/mcp@latest"], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
    this.buf = ""; this.id = 0; this.pending = new Map(); this.ready = null; this.dead = false;
    this.proc.on("error", (e) => { this.dead = true; for (const p of this.pending.values()) p.reject(e); });
    this.proc.on("close", () => { this.dead = true; for (const p of this.pending.values()) p.reject(new Error("Plaud MCP exited")); });
    this.proc.stdout.on("data", (chunk) => {
      this.buf += chunk; let nl;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl).trim(); this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message || JSON.stringify(msg.error))) : p.resolve(msg.result); }
      }
    });
  }
  send(method, params, notify = false) {
    if (notify) { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); return; }
    const id = ++this.id;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`Plaud MCP ${method} timed out`)); }, 60_000);
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return promise;
  }
  start() {
    if (!this.ready) this.ready = (async () => {
      await this.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "plaud-pipeline", version: "1.0" } });
      this.send("notifications/initialized", {}, true);
    })();
    return this.ready;
  }
  async call(name, args = {}) {
    await this.start();
    const res = await this.send("tools/call", { name, arguments: args });
    const text = res?.content?.find?.((c) => c.type === "text")?.text;
    if (text != null) { try { return JSON.parse(text); } catch { return text; } }
    return res?.structuredContent ?? res;
  }
}
let mcp = null;
function plaud() { if (!mcp || mcp.dead) mcp = new Mcp(); return mcp; }

async function listRecordings() {
  const me = await plaud().call("get_current_user");
  const list = await plaud().call("list_files", { page: 1, page_size: 40 });
  const files = list?.data ?? [];
  return files.map((f) => {
    const isDemo = f.serial_number && me?.id && f.serial_number === me.id;
    const isBlip = (f.duration ?? 0) < MIN_DURATION_MS;
    const isUntitled = f.name && DEFAULT_NAME_RE.test(f.name.trim());
    return {
      id: f.id, name: f.name, date: f.start_at || f.created_at, duration: f.duration ?? 0,
      skip: isDemo || isBlip, untitled: isUntitled,
    };
  });
}
async function presignedUrl(fileId) {
  // Plaud intermittently returns file detail without a presigned_url; retry.
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const detail = await plaud().call("get_file", { file_id: fileId });
    if (detail?.presigned_url) return { url: detail.presigned_url, name: detail.name, duration: detail.duration };
    last = detail;
    if (attempt < 3) await new Promise((r) => setTimeout(r, 800 * attempt));
  }
  throw new Error("Plaud returned no download URL for that recording (try Refresh, or pick another)");
}

// --- Notations MCP over HTTP (the "Upload" half) ----------------------------
const NOTATIONS_MCP = process.env.NOTATIONS_MCP ?? "https://notations.app/api/mcp/mcp";
const PLAUD_SYNC_PLIST = join(HOME, "Library", "LaunchAgents", "com.fieldlines.plaud-sync.plist");
let _notToken;
async function notationsToken() {
  if (_notToken !== undefined) return _notToken;
  _notToken = process.env.NOTATIONS_TOKEN || process.env.FIELDLINES_TOKEN || null;
  if (!_notToken) { // fall back to the token the plaud-sync cron already stores
    try {
      const plist = await readFile(PLAUD_SYNC_PLIST, "utf8");
      const m = plist.match(/FIELDLINES_TOKEN='([^']+)'/);
      if (m) _notToken = m[1];
    } catch {}
  }
  return _notToken;
}
// Stateless streamable-HTTP MCP: POST JSON-RPC, parse the SSE `data:` line.
let _rpcId = 100;
async function notationsCall(method, params) {
  const token = await notationsToken();
  if (!token) throw new Error("no Notations token (set NOTATIONS_TOKEN or install the plaud-sync agent)");
  const res = await fetch(NOTATIONS_MCP, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++_rpcId, method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Notations ${res.status}: ${text.slice(0, 200)}`);
  const line = text.split("\n").reverse().find((l) => l.startsWith("data:"));
  const msg = JSON.parse(line ? line.slice(5).trim() : text);
  if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
  return msg.result;
}
async function notationsTool(name, args) {
  const result = await notationsCall("tools/call", { name, arguments: args });
  const t = result?.content?.find?.((c) => c.type === "text")?.text;
  if (t != null) { try { return JSON.parse(t); } catch { return t; } }
  return result?.structuredContent ?? result;
}
async function uploadTranscript(title, outFile, input) {
  const md = await readFile(outFile, "utf8");
  // Post body: the whole formatted note (title header + source + transcript).
  const out = await notationsTool("create_post", {
    filename: title,
    content: md,
    folderId: "Meetings",
    tags: ["plaud", "recording"],
    published: false,
  });
  const slug = out?.post?.slug ?? out?.slug ?? null;
  if (!slug && out?.success === false) throw new Error(out.message || "create_post failed");
  return { slug, folder: "Meetings" };
}

// The steps whose <li> the page lights up, keyed to the script's stderr markers.
const STEP_IDS = ["download", "convert", "whisper", "diarize", "write"];

let state = freshState();
function freshState() {
  return {
    running: false,
    input: null,
    steps: Object.fromEntries(STEP_IDS.map((id) => [id, "idle"])), // idle|run|done|skip
    out: null,
    log: [],
    error: null,
    startedAt: null,
    finishedAt: null,
    upload: { state: "idle", slug: null, folder: null, error: null }, // idle|run|done|skip|error
  };
}

function setStep(id, s) { if (id in state.steps) state.steps[id] = s; }
function advanceTo(id) {
  // mark everything before `id` done, `id` running
  let hit = false;
  for (const s of STEP_IDS) {
    if (s === id) { setStep(s, "run"); hit = true; }
    else if (!hit && state.steps[s] === "run") setStep(s, "done");
  }
}

// Map a stderr line from plaud-transcribe.sh to a step transition.
function ingestLine(line) {
  state.log.push(line);
  if (state.log.length > 400) state.log.shift();
  if (/^\[1\/4\]/.test(line)) advanceTo("download");
  else if (/^\[2\/4\]/.test(line)) { setStep("download", "done"); advanceTo("convert"); }
  else if (/^\[3\/4\]/.test(line)) { setStep("convert", "done"); advanceTo("whisper"); }
  else if (/^\[3b\]/.test(line)) { setStep("whisper", "done"); advanceTo("diarize"); }
  else if (/^\[3c\]/.test(line)) { setStep("whisper", "done"); } // building JSON, no diarize
  else if (/^\[4\/4\]/.test(line)) {
    setStep("whisper", "done");
    if (state.steps.diarize === "run") setStep("diarize", "done");
    else if (state.steps.diarize === "idle") setStep("diarize", "skip");
    advanceTo("write");
  } else if (/^Done:/.test(line)) {
    setStep("write", "done");
  } else if (/WARN: diarization failed|--diarize requested but/.test(line)) {
    setStep("diarize", "skip");
  }
}

function runScript(body) {
  if (state.running) throw new Error("already running");
  const { mode, value, title, speakers, diarize } = body;
  if (!value || !String(value).trim()) throw new Error("provide a presigned URL or a local audio path");
  if (!existsSync(TRANSCRIBE)) throw new Error(`transcribe script not found: ${TRANSCRIBE}`);

  const doUpload = body.upload !== false; // default: upload to Notations
  state = freshState();
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.input = { mode, value: mode === "url" ? "(presigned URL)" : value, diarize: !!diarize, speakers: speakers || null };
  state.upload.state = doUpload ? "idle" : "skip";

  const stamp = state.startedAt.replace(/[:.]/g, "-").slice(0, 19);
  const out = join(OUT_DIR, `${stamp}.md`);
  state.out = out;

  const finalTitle = title && title.trim() ? title.trim() : "Untitled Plaud recording";
  const args = [];
  if (mode === "audio") args.push("--audio", String(value));
  else args.push("--url", String(value)); // spawn = no shell, so / and % are safe
  args.push("--out", out);
  args.push("--title", finalTitle);
  if (diarize) { args.push("--diarize"); if (speakers) args.push("--speakers", String(speakers)); }

  ingestLine(`$ plaud-transcribe.sh ${args.join(" ")}`);
  const child = spawn("bash", [TRANSCRIBE, ...args], { env: process.env });

  let buf = "";
  const onData = (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const l = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (l.trim()) ingestLine(l);
    }
  };
  child.stderr.on("data", onData);
  child.stdout.on("data", onData);
  child.on("error", (e) => { state.error = e.message; state.running = false; state.finishedAt = new Date().toISOString(); });
  child.on("close", async (code) => {
    if (buf.trim()) ingestLine(buf);
    if (code !== 0) {
      state.error = `transcribe exited ${code}`;
      state.running = false; state.finishedAt = new Date().toISOString();
      return;
    }
    setStep("write", "done");
    if (state.steps.diarize === "idle") setStep("diarize", diarize ? "done" : "skip");

    // Stage 3 — upload the transcript to Notations (Meetings folder).
    if (doUpload) {
      state.upload.state = "run";
      ingestLine("[upload] create_post → Notations Meetings…");
      try {
        const { slug, folder } = await uploadTranscript(finalTitle, out, state.input);
        state.upload.slug = slug; state.upload.folder = folder; state.upload.state = "done";
        ingestLine(`[upload] Done: /posts/${slug}`);
      } catch (e) {
        state.upload.state = "error"; state.upload.error = e.message;
        ingestLine(`[upload] ERROR: ${e.message}`);
      }
    }
    state.running = false;
    state.finishedAt = new Date().toISOString();
  });
}

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(b);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(HTML, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(html);
    }
    if (req.method === "GET" && url.pathname === "/setup") {
      const setupPath = join(dirname(HTML), "plaud-setup.html");
      const html = await readFile(setupPath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(html);
    }
    if (req.method === "GET" && url.pathname === "/status") return json(res, 200, state);
    if (req.method === "GET" && url.pathname === "/recordings") {
      try { return json(res, 200, { ok: true, recordings: await listRecordings() }); }
      catch (e) { return json(res, 502, { ok: false, error: `Plaud grab failed: ${e.message}` }); }
    }
    if (req.method === "POST" && url.pathname === "/reset") { if (!state.running) state = freshState(); return json(res, 200, state); }
    if (req.method === "POST" && url.pathname === "/run-upload") {
      // Browser file picker: raw audio bytes in the body, metadata in headers.
      if (state.running) return json(res, 400, { ok: false, error: "already running" });
      const h = req.headers;
      const fname = decodeURIComponent(h["x-filename"] || "audio");
      const title = decodeURIComponent(h["x-title"] || "");
      const diarize = h["x-diarize"] === "1";
      const speakers = h["x-speakers"] ? Number(h["x-speakers"]) : null;
      const upload = h["x-upload"] !== "0";
      const chunks = []; for await (const c of req) chunks.push(c);
      const buf = Buffer.concat(chunks);
      if (!buf.length) return json(res, 400, { ok: false, error: "empty upload" });
      const upDir = join(OUT_DIR, ".uploads"); await mkdir(upDir, { recursive: true });
      const safe = fname.replace(/[^\w.\-]/g, "_");
      const tmpPath = join(upDir, `${Date.now()}_${safe}`);
      await writeFile(tmpPath, buf);
      try { runScript({ mode: "audio", value: tmpPath, title: title || fname, diarize, speakers, upload }); return json(res, 200, { ok: true, out: state.out }); }
      catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    }
    if (req.method === "POST" && url.pathname === "/run") {
      let raw = ""; for await (const c of req) raw += c;
      let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
      try {
        // fileId mode: server grabs the fresh presigned URL itself (no URL copying).
        if (body.fileId) {
          if (state.running) throw new Error("already running");
          const { url: presigned, name } = await presignedUrl(body.fileId);
          body = { mode: "url", value: presigned, title: body.title || name, diarize: body.diarize, speakers: body.speakers, upload: body.upload };
        }
        runScript(body);
        return json(res, 200, { ok: true, out: state.out });
      } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    }
    res.writeHead(404); res.end("not found");
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

await mkdir(OUT_DIR, { recursive: true }).catch(() => {});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`plaud-pipeline-server → http://localhost:${PORT}`);
  console.log(`  serving : ${HTML}`);
  console.log(`  script  : ${TRANSCRIBE}`);
  console.log(`  output  : ${OUT_DIR}/`);
});
