/**
 * Chef Social render worker.
 *
 * Claim -> plan -> cut with native ffmpeg -> upload -> callback. Same edit the
 * browser cutter makes (1080x1920, 30fps, graded, on-screen text, end card,
 * optional licensed music), just 5-10x faster and without holding the tab open.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";
import http from "node:http";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const APP = (process.env.APP_URL ?? "http://localhost:8080").replace(/\/$/, "");
const SECRET = process.env.RENDER_WORKER_SECRET ?? "";
const WORKER_ID = process.env.WORKER_ID ?? `worker-${process.pid}`;
const VERSION = "2026-08-22-v6.1";
const IDLE_DELAY_MS = 5000;
const REQUEST_TIMEOUT_MS = 30000;
const REQUEST_ATTEMPTS = 3;
// Big camera clips (4K .mov) are the main crash risk on small instances.
const MAX_CLIPS = Number(process.env.MAX_CLIPS ?? 14);
const W = 1080;

const H = 1920;

/* ---------- app API ---------- */

async function post(path, body) {
  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${APP}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-secret": SECRET },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 204) return null;
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON error bodies are logged as-is below */
      }
      if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 300)}`);
      return json;
    } catch (err) {
      const message = String(err);
      const retryable =
        message.includes("fetch failed") ||
        message.includes("ETIMEDOUT") ||
        message.includes("TimeoutError") ||
        /-> 5\d\d\b/.test(message);
      if (!retryable || attempt === REQUEST_ATTEMPTS) throw err;
      const delay = 1000 * 2 ** (attempt - 1);
      console.warn(`${path} attempt ${attempt} failed; retrying in ${delay}ms`, message);
      await sleep(delay);
    }
  }
  return null;
}

const claim = () => post("/api/public/render/claim", { worker_id: WORKER_ID, lease_seconds: 300 });
const plan = (body) => post("/api/public/render/plan", body);

function startHeartbeat(jobId, state) {
  const beat = async () => {
    try {
      await post("/api/public/render/heartbeat", {
        job_id: jobId,
        worker_id: WORKER_ID,
        progress: state.progress,
        stage: state.stage,
      });
    } catch (err) {
      // 409 means another worker took the lease; stop wasting cycles.
      if (String(err).includes("409")) state.cancelled = true;
      else console.warn("heartbeat failed", String(err));
    }
  };
  // Beat straight away so the UI moves off "queued" the second work starts.
  void beat();
  const timer = setInterval(beat, 10000);
  return () => clearInterval(timer);
}


/* ---------- ffmpeg helpers ---------- */

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${bin} failed: ${err.slice(-500)}`)),
    );
  });
}

const ffmpeg = (args) => run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

async function probeDuration(file) {
  const out = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    file,
  ]);
  const d = Number.parseFloat(out.trim());
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/** Stream large source clips straight to disk instead of buffering them in RAM. */
async function downloadToFile(url, file) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`clip download failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
}

/**
 * Camera files are often 4K ProRes-ish .mov at hundreds of MB. We only ever
 * output 1080x1920, so shrink each source to a small proxy once and delete the
 * original: same final quality, a fraction of the disk and memory.
 */
async function makeProxy(source, target) {
  await ffmpeg([
    // Frame-level threading is what balloons memory on 4K HEVC: every worker
    // thread holds its own decoded frame buffers. Slice threading on one thread
    // keeps peak RSS flat at the cost of a little speed.
    "-threads", "1",
    "-thread_type", "slice",
    "-filter_threads", "1",
    "-filter_complex_threads", "1",
    "-i", source,
    // Short side to 1080 so the portrait 1080x1920 export never upscales.
    "-vf",
    "scale='if(gt(iw,ih),-2,1080)':'if(gt(iw,ih),1080,-2)',fps=30",
    "-an",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "24",
    "-threads", "1",
    "-pix_fmt", "yuv420p",
    "-max_muxing_queue_size", "256",
    "-movflags", "+faststart",
    target,
  ]);

  await rm(source, { force: true }).catch(() => {});
  return target;
}


/**
 * Cheap footage check: ffmpeg's own scene/black/freeze detection tells us which
 * stretch of a clip is actually usable, so dark or dead shots lose to live ones.
 */
async function scanClip(file, duration) {
  const fallback = { quality: 1, action: 0.5, goodStart: 0, goodEnd: duration };
  try {
    const out = await run("ffmpeg", [
      "-hide_banner", "-nostats", "-i", file,
      "-vf", "scale=96:-2,blackdetect=d=0.3:pic_th=0.98,freezedetect=n=-55dB:d=0.6,metadata=print",
      "-an", "-f", "null", "-",
    ]).catch((e) => String(e));
    const text = String(out);
    const black = [...text.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    const frozen = [...text.matchAll(/freeze_start: ?([\d.]+)[\s\S]*?freeze_end: ?([\d.]+)/g)].map(
      (m) => [Number(m[1]), Number(m[2])],
    );
    const bad = [...black, ...frozen].sort((a, b) => a[0] - b[0]);
    const badTime = bad.reduce((n, [s, e]) => n + Math.max(0, e - s), 0);

    // Longest stretch with nothing bad in it.
    let cursor = 0;
    let best = [0, duration];
    for (const [s, e] of [...bad, [duration, duration]]) {
      if (s - cursor > best[1] - best[0]) best = [cursor, s];
      cursor = Math.max(cursor, e);
    }
    const goodStart = Math.max(0, best[0]);
    const goodEnd = Math.min(duration, Math.max(goodStart + 0.6, best[1]));
    return {
      quality: Math.max(0, Math.min(1, 1 - badTime / Math.max(1, duration))),
      action: goodEnd - goodStart > 1.2 ? 0.7 : 0.3,
      goodStart,
      goodEnd,
    };
  } catch {
    return fallback;
  }
}

/* ---------- text overlays ---------- */

const FONT_DIR = process.env.FONT_DIR ?? "/usr/share/fonts/truetype/chefsocial";
const KITS = {
  luxury: { font: "PlayfairDisplay-Bold.ttf", upper: true, size: 96, spacing: 6 },
  editorial: { font: "PlayfairDisplay-Bold.ttf", upper: false, size: 96, spacing: 0 },
  bold: { font: "BebasNeue-Regular.ttf", upper: true, size: 118, spacing: 2 },
  handwritten: { font: "Caveat-Bold.ttf", upper: false, size: 124, spacing: 0 },
  clean: { font: "PlusJakartaSans-ExtraBold.ttf", upper: false, size: 100, spacing: -1 },
};

function fontFile(style) {
  const kit = KITS[style] ?? KITS.clean;
  return { kit, file: path.join(FONT_DIR, kit.font) };
}

/** Rough wrap: ~0.52em per glyph is close enough for a 3-line safety budget. */
function wrapText(text, size, maxWidth = W - 260) {
  const perChar = size * 0.52;
  const maxChars = Math.max(8, Math.floor(maxWidth / perChar));
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function escapeDrawtext(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\u2019")
    .replace(/%/g, "\\%");
}

/** drawtext filters for one block of centred, stroked lines. */
function textFilters(text, style, centerY, startSize) {
  if (!text.trim()) return { filters: [], height: 0 };
  const { kit, file } = fontFile(style);
  const value = kit.upper ? text.toUpperCase() : text;
  let size = startSize ?? kit.size;
  let lines = wrapText(value, size);
  while (lines.length > 3 && size > 44) {
    size = Math.round(size * 0.9);
    lines = wrapText(value, size);
  }
  const lh = size * 1.12;
  const height = lines.length * lh;
  const top = centerY - height / 2 + lh / 2;
  const filters = lines.map((line, i) =>
    [
      `drawtext=fontfile='${file}'`,
      `text='${escapeDrawtext(line)}'`,
      `fontsize=${size}`,
      `fontcolor=white`,
      `borderw=${Math.max(4, Math.round(size * 0.08))}`,
      `bordercolor=black@0.85`,
      `shadowcolor=black@0.35:shadowx=0:shadowy=4`,
      `x=(w-text_w)/2`,
      `y=${Math.round(top + i * lh - size / 2)}`,
    ].join(":"),
  );
  return { filters, height };
}

/** Segment text high in frame; the last shot also carries the end card. */
function overlayFilters(segment, style, endCard, isLast) {
  const safeTop = H * 0.14;
  const safeBottom = H * 0.82;
  const clamp = (y, h) => Math.max(safeTop + h / 2, Math.min(y, safeBottom - h / 2));

  const filters = [];
  if (segment.text?.trim()) {
    const base = segment.text.length > 34 ? 78 : segment.text.length > 20 ? 92 : 108;
    const probe = textFilters(segment.text.trim(), style, H * 0.34, base);
    const block = textFilters(segment.text.trim(), style, clamp(H * 0.34, probe.height), base);
    filters.push(...block.filters);
  }
  if (isLast && endCard) {
    const name = textFilters(endCard.line1 ?? "", style, H * 0.5, 96);
    const addr = textFilters(endCard.line2 ?? "", style, H * 0.5 + name.height / 2 + 60, 52);
    filters.push(...name.filters, ...addr.filters);
  }
  return filters;
}

/* ---------- the cut ---------- */

async function cutVariation(dir, sources, cutPlan, index) {
  const style = cutPlan.textStyle ?? "clean";
  const parts = [];

  for (const [i, seg] of cutPlan.segments.entries()) {
    const src = sources.get(seg.clip);
    if (!src) continue;
    const out = path.join(dir, `v${index}_part${i}.mp4`);
    const overlays = overlayFilters(
      seg,
      style,
      cutPlan.endCard,
      i === cutPlan.segments.length - 1,
    );
    const chain = [
      `scale=${W}:${H}:force_original_aspect_ratio=increase`,
      `crop=${W}:${H}`,
      "fps=30",
      "eq=saturation=1.32:contrast=1.08:brightness=0.02",
      "setsar=1",
      ...overlays,
      "format=yuv420p",
    ].join(",");

    await ffmpeg([
      "-threads", "1",
      "-ss", Number(seg.start).toFixed(2),
      "-t", Number(seg.duration).toFixed(2),
      "-i", src,
      "-vf", chain,
      "-an",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "22",
      "-threads", "1",
      "-pix_fmt", "yuv420p",
      "-r", "30",
      "-g", "30",
      out,
    ]);
    parts.push(out);
  }

  if (!parts.length) throw new Error("No usable clips for this cut.");

  const list = path.join(dir, `v${index}_list.txt`);
  await writeFile(list, parts.map((p) => `file '${p}'`).join("\n"));
  const silent = path.join(dir, `v${index}_out.mp4`);
  await ffmpeg([
    "-f", "concat", "-safe", "0", "-i", list,
    "-c", "copy", "-movflags", "+faststart", silent,
  ]);

  const poster = path.join(dir, `v${index}_poster.jpg`);
  await ffmpeg(["-ss", "0.5", "-i", silent, "-frames:v", "1", "-q:v", "4", poster]).catch(() => {});

  return { silent, poster };
}

/** Bakes a licensed library track onto the finished, muted cut. */
async function bakeMusic(dir, videoFile, trackUrl, index) {
  const audio = path.join(dir, `v${index}_track`);
  const res = await fetch(trackUrl);
  if (!res.ok) return null;
  await writeFile(audio, Buffer.from(await res.arrayBuffer()));
  const out = path.join(dir, `v${index}_music.mp4`);
  // The music has to run under the whole cut: fade in at the top, hold, then
  // fade out over the final 0.8s of the VIDEO (not of the track).
  const vid = await probeDuration(videoFile).catch(() => 0);
  const d = vid > 1.5 ? vid : 0;
  const filter = d
    ? `[1:a]atrim=0:${d.toFixed(2)},asetpts=N/SR/TB,afade=t=in:st=0:d=0.4,afade=t=out:st=${(d - 0.8).toFixed(2)}:d=0.8,volume=0.9[a]`
    : `[1:a]afade=t=in:st=0:d=0.4,volume=0.9[a]`;
  await ffmpeg([
    "-i", videoFile,
    "-i", audio,
    "-filter_complex", filter,
    "-map", "0:v", "-map", "[a]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
    "-shortest", "-movflags", "+faststart",
    out,
  ]);
  return out;
}

/* ---------- storage ---------- */

async function upload(projectId, key, file, contentType) {
  const body = await readFile(file);
  const qs = new URLSearchParams({ project_id: projectId, key, content_type: contentType });
  const res = await fetch(`${APP}/api/public/render/upload?${qs}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-worker-secret": SECRET },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  if (!json?.url) throw new Error("upload did not return a URL");
  return json.url;
}

/* ---------- job ---------- */

async function renderProject(job, state) {
  const dir = await mkdtemp(path.join(tmpdir(), "chefsocial-"));
  const outputs = [];
  try {
    state.stage = "Getting your clips ready";
    state.progress = 3;
    const info = await plan({ action: "job", project_id: job.project_id });
    if (!info.clips?.length) throw new Error("This project has no clips to cut.");

    // Download + shrink + probe + scan every clip once, reused across all variations.
    const sources = new Map();
    const clipInfo = [];
    const clips = info.clips.slice(0, MAX_CLIPS);
    if (info.clips.length > clips.length) {
      console.log(`using first ${clips.length} of ${info.clips.length} clips (MAX_CLIPS)`);
    }
    for (const [clipNumber, clip] of clips.entries()) {
      state.stage = `Getting clip ${clipNumber + 1} of ${clips.length} ready`;
      state.progress = Math.max(3, Math.round(3 + (clipNumber / clips.length) * 6));
      const raw = path.join(dir, `raw_${clip.index}`);
      const file = path.join(dir, `src_${clip.index}.mp4`);
      try {
        await downloadToFile(clip.url, raw);
        const size = (await stat(raw)).size;
        if (size < 1000) {
          await rm(raw, { force: true }).catch(() => {});
          continue;
        }
        console.log(`clip ${clip.index}: ${(size / 1e6).toFixed(1)} MB downloaded, transcoding`);
        await makeProxy(raw, file);
      } catch (err) {
        console.warn(`skipping clip ${clip.index}`, String(err));
        await rm(raw, { force: true }).catch(() => {});
        continue;
      }
      const duration = await probeDuration(file);
      if (!duration) continue;
      sources.set(clip.index, file);
      const scan = await scanClip(file, duration);
      clipInfo.push({ index: clip.index, filename: clip.filename, duration, ...scan });
      const mem = process.memoryUsage().rss / 1e6;
      console.log(`clip ${clip.index} ready (${duration.toFixed(1)}s, rss ${mem.toFixed(0)} MB)`);
    }
    if (!clipInfo.length) throw new Error("None of the uploaded clips could be read.");

    if (!clipInfo.length) throw new Error("None of the uploaded clips could be read.");

    const requestedVariations = Array.isArray(job.payload?.only_variations)
      ? job.payload.only_variations.filter((value) => ["A", "B", "C", "D", "E"].includes(value))
      : [];
    const count = requestedVariations.length
      ? requestedVariations.length
      : Math.max(1, Math.min(5, job.batch_size ?? info.variationCount ?? 1));
    state.stage = "Planning the videos";
    state.progress = 10;
    const concepts = await plan({
      action: "concepts",
      project_id: job.project_id,
      count,
      clips: clipInfo,
    }).catch(() => []);

    const variations = requestedVariations.length
      ? requestedVariations
      : ["A", "B", "C", "D", "E"].slice(0, count);
    const used = [];

    for (const [i, variation] of variations.entries()) {
      if (state.cancelled) break;
      const span = 85 / variations.length;
      state.stage = `Cutting video ${i + 1} of ${variations.length}`;
      state.progress = Math.round(12 + i * span);

      const cutPlan = await plan({
        action: "cut",
        project_id: job.project_id,
        variation,
        clips: clipInfo,
        avoid: used,
        concept: Array.isArray(concepts) ? concepts[i] : undefined,
      });

      const { silent, poster } = await cutVariation(dir, sources, cutPlan, i);
      used.push(...cutPlan.segments.map((s) => s.clip));

      state.progress = Math.round(12 + (i + 0.7) * span);
      state.stage = `Finishing video ${i + 1} of ${variations.length}`;

      const audio = info.audioByVariation?.[i] ?? null;
      let musicFile = null;
      if (audio?.choice === "library" && audio.track_url) {
        musicFile = await bakeMusic(dir, silent, audio.track_url, i).catch(() => null);
      }

      const base = `${job.project_id}/${variation}-${Date.now()}`;
      const videoUrl = await upload(job.project_id, `${base}.mp4`, silent, "video/mp4");
      const musicUrl = musicFile
        ? await upload(job.project_id, `${base}-music.mp4`, musicFile, "video/mp4")
        : null;
      let thumbUrl = null;
      try {
        thumbUrl = await upload(job.project_id, `${base}.jpg`, poster, "image/jpeg");
      } catch {
        /* a missing poster is not worth failing the job over */
      }

      outputs.push({
        variation,
        video_url: videoUrl,
        music_video_url: musicUrl,
        ...(thumbUrl ? { thumbnail_url: thumbUrl } : {}),
        caption: cutPlan.caption ?? "",
      });
    }

    state.progress = 99;
    state.stage = "Wrapping up";
    return outputs;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runOnce() {
  const job = await claim();
  if (!job) return false;

  console.log(`claimed job ${job.job_id} (project ${job.project_id}, attempt ${job.attempt})`);
  const state = { progress: 1, stage: "Getting your clips ready", cancelled: false };
  const stopBeat = startHeartbeat(job.job_id, state);

  try {
    const outputs = await renderProject(job, state);
    if (state.cancelled) return true;
    await post("/api/public/render-callback", {
      project_id: job.project_id,
      status: "ready",
      outputs,
    });
    console.log(`finished job ${job.job_id} with ${outputs.length} videos`);
  } catch (err) {
    console.error(`job ${job.job_id} failed`, err);
    await post("/api/public/render-callback", {
      project_id: job.project_id,
      status: "failed",
      error: String(err).slice(0, 500),
    }).catch(() => {});
  } finally {
    stopBeat();
  }
  return true;
}

// Render (and most PaaS web services) require an open port; this also gives us
// a health check endpoint. Harmless when running as a plain background worker.
function startHealthServer() {
  const port = Number(process.env.PORT ?? 0);
  if (!port) return null;
  return http
    .createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          worker: WORKER_ID,
          version: VERSION,
          app: APP,
          rss_mb: Math.round(process.memoryUsage().rss / 1e6),
        }),
      );
    })
    .listen(port, "0.0.0.0", () => console.log(`health server on :${port}`));
}

// A silent restart is the hardest failure to debug, so always say why we died.
process.on("uncaughtException", (err) => console.error("uncaughtException", err));
process.on("unhandledRejection", (err) => console.error("unhandledRejection", err));

let stopping = false;
let healthServer = null;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.warn(`received ${signal}; stopping cleanly after the current request`);
  healthServer?.close();
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

async function main() {
  if (!SECRET) throw new Error("RENDER_WORKER_SECRET is required");
  healthServer = startHealthServer();
  console.log(`render worker ${WORKER_ID} (${VERSION}) polling ${APP}`);

  while (!stopping) {
    let didWork = false;
    try {
      didWork = await runOnce();
    } catch (err) {
      console.error("claim loop error", err);
    }
    // Idle backoff keeps an empty queue from hammering the app.
    if (!didWork && !stopping) await sleep(IDLE_DELAY_MS);
  }
  console.log("worker stopped cleanly");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
