// JavScribe serve 的 mock（e2e 专用）：忠实复刻 8300 协议
// （progress_api.py 的 /health /jobs /jobs/<id> /upload /retry /result /config /scan /scan/submit），
// 另加 /_mock/* 控制口（仅测试用：暂停/播种/读上传/配 key 模式）。
// 用法: node mock-serve.mjs [port]   默认 8301，仅监听 127.0.0.1
import http from "node:http";

const PORT = Number(process.argv[2] || 8301);
const VERSION = "0.1.0";
const GOOD_KEY = "mock-key-123";

// ---- 配置项（与 serve progress_api.py CONFIG_ITEMS 一一对应）----
const CONFIG_ITEMS = [
  ["subtitle.lang_tag", "字幕语言标签", "string", null, false, "zh"],
  ["subtitle.skip_if_exists", "字幕已存在时跳过", "bool", null, false, true],
  ["subtitle.overwrite", "覆盖已存在字幕", "bool", null, false, false],
  ["subtitle.naming", "输出命名方式", "enum", ["rename", "keep"], false, "keep"],
  ["infer.device", "推理设备", "enum", ["auto", "cpu", "cuda"], false, "auto"],
  ["infer.model", "字幕模型", "string", null, false, "aishell1-ctc-ja"],
  ["infer.log_level", "日志级别", "enum", ["DEBUG", "INFO", "WARNING", "ERROR"], false, "INFO"],
  ["infer.batch", "批量推理", "bool", null, false, true],
  ["infer.max_batch_size", "批处理大小", "int", null, false, 16],
  ["vad.threshold", "VAD 语音检测阈值", "float", null, false, 0.5],
  ["polish.enabled", "启用 AI 润色", "bool", null, false, false],
  ["polish.base_url", "润色服务地址", "string", null, false, ""],
  ["polish.model", "润色模型", "string", null, false, ""],
  ["polish.batch_lines", "润色批行数", "int", null, false, 200],
  ["polish.api_key", "润色 API Key", "secret", null, true, ""],
  ["emby.enabled", "启用 Emby 刷新", "bool", null, false, false],
  ["emby.url", "Emby 地址", "string", null, false, ""],
  ["emby.api_key", "Emby API Key", "secret", null, true, ""],
  ["jasna.enabled", "启用音频修复（JASNA）", "bool", null, false, false],
  ["scan.video_exts", "视频扩展名（逗号分隔）", "list", null, false, ["mp4", "mkv", "ts", "m2ts", "avi", "mov"]],
  ["scan.subtitle_patterns", "已有字幕判定后缀（逗号分隔）", "list", null, false, [".zh.srt", ".srt"]],
  ["scan.recurse", "扫描时进入子目录", "bool", null, false, true],
];
const SPEC = Object.fromEntries(CONFIG_ITEMS.map(([p, l, t, o, s]) => [p, { label: l, type: t, options: o, secret: s }]));

// ---- 扫描用的虚拟目录树（服务机器上的 /media/jav）----
const SCAN_TREE = {
  "/media/jav": [
    { name: "AKDL-001.mp4", size: 3_400_000_000, has_subtitle: false, subtitle: "" },
    { name: "AKDL-002.mp4", size: 5_100_000_000, has_subtitle: true, subtitle: "AKDL-002.zh.srt" },
    { name: "SUB-001.mkv", size: 2_200_000_000, has_subtitle: false, subtitle: "" },
  ],
};
const SCAN_DIRS = Object.keys(SCAN_TREE);

// ---- 状态 ----
const state = {
  version: VERSION,     // 可经 /_mock/version 切换（更新检查 e2e：模拟服务落后于最新镜像）
  jobs: new Map(),      // id -> job
  uploads: [],          // PUT /upload 收到的载荷（测试断言：只传 opus）
  values: Object.fromEntries(CONFIG_ITEMS.map(([p, , , , , v]) => [p, v])),
  apiKeyMode: "ok",     // ok | no-key
  paused: false,
  uploadDelayMs: 0,    // 测试控速：PUT /upload 收到全部字节后延迟应答（桌面端「上传中」帧基线用）
  tickMs: 100,
  step: 0.25,           // 每 tick 进度增量（0.25 → ~4s 完成）
  seq: 0,
};

function newId() {
  state.seq += 1;
  // 字面量日期前缀（避免时区/跨日漂移）+ reset 清零 seq：id 与运行环境、测试顺序无关，截图基线稳定
  return `20260905-${state.seq.toString().padStart(6, "0")}`;
}
function makeTask(path, opts = {}) {
  return {
    path,
    name: path.split("/").pop(),
    status: opts.status || "running",
    phase: opts.phase || "subtitling",
    progress: opts.progress ?? 0,
    message: opts.message || "",
    duration_s: opts.duration_s ?? 120,
    position_s: null,
    position: "",
    output_files: opts.output_files || [],
    started: opts.started ?? Date.now() / 1000,
    finished: opts.finished ?? null,
  };
}
function jobOf(files, { source_kind = "remote", label = "" } = {}) {
  const j = {
    id: newId(),
    created: Date.now() / 1000,
    finished: null,
    source_kind,
    label,
    files,
  };
  state.jobs.set(j.id, j);
  return j;
}
function taskDone(t, outPath) {
  t.status = "done";
  t.phase = "done";
  t.progress = 1;
  t.finished = Date.now() / 1000;
  t.message = "完成";
  t.output_files = [outPath];
}
function jobToDict(j, detail = false) {
  const d = {
    id: j.id,
    created: j.created,
    finished: j.finished,
    source_kind: j.source_kind,
    label: j.label,
    total: j.files.length,
    done: j.files.filter((t) => t.status === "done").length,
    skipped: j.files.filter((t) => t.status === "skipped").length,
    failed: j.files.filter((t) => t.status === "error").length,
    state: j.files.every((t) => ["done", "skipped", "canceled"].includes(t.status)) ? "finished" : "running",
  };
  const cur = j.files.find((t) => t.status === "running");
  if (cur) d.current = { ...cur };
  if (detail) d.files = j.files.map((t) => ({ ...t }));
  return d;
}
function srtFor(name) {
  return `1\n00:00:01,000 --> 00:00:03,500\nテスト字幕 ${name}\n\n2\n00:00:04,000 --> 00:00:06,000\n第二行 ${name}\n`;
}

// ---- 推进 running 任务 ----
setInterval(() => {
  if (state.paused) return;
  for (const j of state.jobs.values()) {
    for (const t of j.files) {
      if (t.status !== "running") continue;
      t.progress = Math.min(1, t.progress + state.step);
      t.position_s = Math.round(t.duration_s * t.progress);
      t.position = fmtTs(t.position_s);
      if (t.progress >= 1) taskDone(t, `/mock/out/${t.name.replace(/\.[^.]+$/, "")}.zh.srt`);
    }
    if (j.files.every((t) => t.status !== "running")) {
      j.finished = Date.now() / 1000;
    }
  }
}, state.tickMs);

function fmtTs(s) {
  if (s == null) return "";
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return `${h}:${p(m)}:${p(ss)}`;
}

// ---- HTTP ----
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const parts = url.pathname.replace(/^\//, "").split("/");
  const send = (code, body, ctype = "application/json") => {
    const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(code, { "Content-Type": `${ctype}; charset=utf-8`, "Content-Length": Buffer.byteLength(data) });
    res.end(data);
  };
  const sendErr = (code, error) => send(code, { ok: false, error });

  const checkKey = () => {
    if (state.apiKeyMode === "no-key") { sendErr(403, "服务未设置 API Key（JAVSCRIBE_API_KEY）"); return false; }
    const got = req.headers["x-api-key"] || "";
    if (got !== GOOD_KEY) { sendErr(401, "API Key 不正确"); return false; }
    return true;
  };

  // ---- 测试控制口 ----
  if (parts[0] === "_mock") {
    const readBody = () => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
    if (req.method === "POST") {
      const sub = parts[1];
      if (sub === "pause") { state.paused = true; return send(200, { ok: true }); }
      if (sub === "resume") { state.paused = false; return send(200, { ok: true }); }
      if (sub === "reset") { state.jobs.clear(); state.uploads.length = 0; state.paused = false; state.uploadDelayMs = 0; state.seq = 0; state.version = VERSION; state.step = 0.25; state.tickMs = 100; return send(200, { ok: true }); }
      if (sub === "version") {
        return readBody().then((b) => {
          const v = b && JSON.parse(b).version;
          if (typeof v === "string" && /^\d+\.\d+/.test(v)) state.version = v;
          return send(200, { ok: true, version: state.version });
        });
      }
      if (sub === "seed") {
        return readBody().then((b) => {
          const { n = 25, status = "done", skipped = 0, progress = 0 } = b ? JSON.parse(b) : {};
          for (let i = 0; i < n; i++) {
            const st = i < skipped ? "skipped" : status;
            const t = makeTask(`/media/jav/seed-${String(i + 1).padStart(3, "0")}.mp4`, {
              status: st, progress: st === "done" ? 1 : (st === "running" ? progress : 0),
              phase: st === "done" ? "done" : "subtitling",
              started: Date.now() / 1000 - 600 - i * 30,
              finished: st === "done" ? Date.now() / 1000 - 600 + 40 - i * 30 : null,
              output_files: st === "done" ? [`/mock/out/seed-${String(i + 1).padStart(3, "0")}.zh.srt`] : [],
              message: st === "skipped" ? "字幕已存在 /media/jav/seed-x.zh.srt" : "",
            });
            const j = jobOf([t], { source_kind: "watch", label: `监听目录 · seed-${i + 1}` });
            // 确定性 created（间隔 60s，seed-n 最新）：created 降序的分页断言不依赖真实毫秒
            j.created = Date.now() / 1000 - (n - i) * 60;
          }
          return send(200, { ok: true, n });
        });
      }
      if (sub === "config-mode") {
        return readBody().then((b) => {
          state.apiKeyMode = (b && JSON.parse(b).mode) || "ok";
          return send(200, { ok: true, mode: state.apiKeyMode });
        });
      }
      if (sub === "speed") {
        return readBody().then((b) => {
          const { step = 0.25, tickMs = 100 } = b ? JSON.parse(b) : {};
          state.step = step; state.tickMs = tickMs;
          return send(200, { ok: true });
        });
      }
      if (sub === "upload-delay") {
        return readBody().then((b) => {
          state.uploadDelayMs = (b && JSON.parse(b).ms) || 0;
          return send(200, { ok: true, ms: state.uploadDelayMs });
        });
      }
      return sendErr(404, "not found");
    }
    if (req.method === "GET" && parts[1] === "uploads") return send(200, state.uploads);
    return sendErr(404, "not found");
  }

  // ---- GET ----
  if (req.method === "GET") {
    if (!parts.length || parts[0] === "health") {
      return send(200, { ok: true, app: "JavScribe", version: state.version, profile: "default", device: "cuda", jobs: [...state.jobs.values()].map((j) => jobToDict(j)) });
    }
    if (parts[0] === "config") {
      if (!checkKey()) return;
      const items = CONFIG_ITEMS.map(([p, label, type, options, secret, ]) => {
        const it = { path: p, label, type, value: state.values[p] };
        if (options) it.options = options;
        if (secret) { it.secret = true; it.value = state.values[p] ? "***" : ""; }
        return it;
      });
      return send(200, { ok: true, profile: "default", items });
    }
    if (parts[0] === "scan") {
      if (!checkKey()) return;
      const raw = url.searchParams.get("path") || "";
      if (/^[A-Za-z]:/.test(raw)) return sendErr(400, "需要绝对路径");
      if (!raw || !raw.startsWith("/")) return sendErr(400, "需要绝对路径");
      if (!SCAN_DIRS.includes(raw)) return sendErr(400, `路径不存在: ${raw}`);
      const items = SCAN_TREE[raw].map((i) => ({ path: `${raw}/${i.name}`, ...i }));
      return send(200, { ok: true, mapped: false, path: raw, items, truncated: false });
    }
    if (parts[0] === "jobs") {
      if (parts.length === 1) return send(200, [...state.jobs.values()].map((j) => jobToDict(j)));
      const j = state.jobs.get(parts[1]);
      if (!j) return sendErr(404, "job not found");
      if (parts[2] === "result" || parts[2] === "result.srt") {
        const t = j.files[0];
        if (!t || t.status !== "done") return sendErr(404, "no result srt yet");
        return send(200, srtFor(t.name), "text/plain");
      }
      return send(200, jobToDict(j, true));
    }
    return sendErr(404, "not found");
  }

  // ---- PUT /upload（音频字节）----
  if (req.method === "PUT" && parts.length === 1 && parts[0] === "upload") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      const source = req.headers["x-source-name"] || "remote";
      const done = () => {
        state.uploads.push({ source, size: buf.length, head: buf.subarray(0, 4).toString("hex") });
        const t = makeTask(`/mock/out/${source}`, { status: "running", message: "已收到" });
        const j = jobOf([t], { source_kind: "remote", label: source });
        return send(201, { ok: true, job_id: j.id, file: source });
      };
      return state.uploadDelayMs > 0
        ? new Promise((r) => setTimeout(() => r(done()), state.uploadDelayMs))
        : done();
    });
    return;
  }

  // ---- PUT /config ----
  if (req.method === "PUT" && parts.length === 1 && parts[0] === "config") {
    if (!checkKey()) return;
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      let body;
      try { body = JSON.parse(b || "{}"); } catch { return sendErr(400, "bad body"); }
      const values = body.values;
      if (!values || typeof values !== "object") return sendErr(400, "values 必须是对象 {path: value}");
      const updated = [];
      for (const [p, v] of Object.entries(values)) {
        const spec = SPEC[p];
        if (!spec) return sendErr(400, `不支持的配置项: ${p}`);
        if (spec.type === "bool" && typeof v !== "boolean") return sendErr(400, `${p} 需要布尔值`);
        if (spec.type === "int" && (typeof v !== "number" || v < 1)) return sendErr(400, `${p} 需要正整数`);
        if (spec.type === "float" && (typeof v !== "number" || v < 0.01 || v > 0.99)) return sendErr(400, `${p} 需在 0.01 ~ 0.99 之间`);
        if (spec.type === "enum" && !spec.options.includes(v)) return sendErr(400, `${p} 需要取值为 ${spec.options} 之一`);
        if (spec.type === "secret") { if (typeof v !== "string") return sendErr(400, `${p} 需要字符串`); if (v === "") continue; }
        if (spec.type === "string" && typeof v !== "string") return sendErr(400, `${p} 需要字符串`);
        state.values[p] = v;
        updated.push(p);
      }
      return send(200, { ok: true, updated });
    });
    return;
  }

  // ---- POST /scan/submit ----
  if (req.method === "POST" && parts.length === 2 && parts[0] === "scan" && parts[1] === "submit") {
    if (!checkKey()) return;
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      let body;
      try { body = JSON.parse(b || "{}"); } catch { return sendErr(400, "bad body"); }
      const files = body.files;
      if (!Array.isArray(files) || !files.length) return sendErr(400, "files 需要非空数组");
      for (const f of files) {
        if (typeof f !== "string" || !f.startsWith("/")) return sendErr(400, `非法路径: ${f}`);
      }
      const j = jobOf(files.map((p) => makeTask(p, { status: "running", message: "已入队" })), { source_kind: "local", label: `文件夹扫描 · ${files.length} 项` });
      return send(201, { ok: true, job_id: j.id, files: files.length });
    });
    return;
  }

  // ---- POST /jobs/<id>/retry ----
  if (req.method === "POST" && parts.length === 3 && parts[0] === "jobs" && parts[2] === "retry") {
    const j = state.jobs.get(parts[1]);
    if (!j) return sendErr(404, "job not found（任务不存在或已过期）");
    const skipped = j.files.filter((t) => t.status === "skipped");
    if (!skipped.length) return sendErr(409, "no retryable file（无跳过的文件，或任务已过期）");
    const nj = jobOf(skipped.map((t) => makeTask(t.path, { status: "running", message: "重新生成" })), { source_kind: j.source_kind, label: j.label });
    return send(201, { ok: true, job_id: nj.id });
  }

  return sendErr(404, "not found");
});

server.listen(PORT, "127.0.0.1", () => console.log(`[mock-serve] http://127.0.0.1:${PORT} (key=${GOOD_KEY})`));
