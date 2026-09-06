// JavScribe Client — Electron main 进程（构建：esbuild --platform=node --format=cjs --external:electron）
//
// 与 web 形态的差异：不经 8400 工作台代理，直连字幕服务 serve 协议
// （src/jav_scribe/core/progress_api.py）：
//   GET /health、GET /jobs、GET /jobs/{id}、PUT /upload（裸字节，无 key）、
//   GET /jobs/{id}/result、POST /jobs/{id}/retry（无 key）、
//   GET/PUT /config、GET /scan?path=、POST /scan/submit（X-Api-Key）
// 语义对齐工作台：
//   - engines.json（userData）多服务登记，等价 web/src/jav_scribe_web/config.py 的 EngineStore
//     （env 预置 JAVSCRIBE_ENGINES="name=url,name=url" 幂等合并）
//   - refresh 单飞 + 3s TTL，等价 poller（离线保留上次 version/device/jobs）
//   - 任务行展平/排序等价 api.py 的 _job_rows + sort
//   - 错误文案等价 _map_config_error / api_retry
// 平台能力（原生对话框 / 递归枚举 / ffmpeg 提取 / fs 写回 / 保存下载）走 IPC。

import { app, BrowserWindow, Menu, dialog, ipcMain } from "electron";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { OPUS_EXTRACT_ARGS, VIDEO_EXTS } from "../core/constants";
import { sanitizeSrtBytes } from "../core/srt-sanitize";

// ---------------------------------------------------------------------------
// 引擎登记（语义与 web/src/jav_scribe_web/config.py 一致）
// ---------------------------------------------------------------------------

const URL_RE = /^https?:\/\/[^\s]+$/;
const isUrl = (url: string): boolean => URL_RE.test(url.trim());
const normUrl = (url: string): string => url.replace(/\/+$/, "");

function parseEnginesEnv(value: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const part of value.split(",")) {
    const p = part.trim();
    if (!p || !p.includes("=")) continue;
    const eq = p.indexOf("=");
    const name = p.slice(0, eq).trim();
    const url = p.slice(eq + 1).trim();
    if (name && isUrl(url)) out.push([name, normUrl(url)]);
  }
  return out;
}

interface EngineEntry { name: string; url: string; api_key: string; }

class EngineStore {
  private _path: string;
  private _engines = new Map<string, EngineEntry>();

  constructor(dataDir: string) {
    this._path = path.join(dataDir, "engines.json");
    this._load();
    for (const [name, url] of parseEnginesEnv(process.env.JAVSCRIBE_ENGINES || "")) {
      this._upsert(name, url, null); // api_key=null: 保留已登记的 key
    }
  }

  private _load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this._path, "utf-8");
    } catch {
      return;
    }
    let data: { engines?: Array<Partial<EngineEntry>> };
    try {
      data = JSON.parse(raw);
    } catch {
      return; // 损坏的登记表：空表起步，不崩溃
    }
    for (const e of data.engines || []) {
      const name = typeof e.name === "string" ? e.name : "";
      const url = typeof e.url === "string" ? e.url : "";
      if (name && isUrl(url)) {
        this._upsert(name, normUrl(url), typeof e.api_key === "string" ? e.api_key : "");
      }
    }
  }

  private _save(): void {
    fs.mkdirSync(path.dirname(this._path), { recursive: true });
    const tmp = this._path + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ engines: [...this._engines.values()] }, null, 1), "utf-8");
    fs.renameSync(tmp, this._path);
  }

  private _upsert(name: string, url: string, apiKey: string | null): void {
    this._engines.set(name, {
      name,
      url: normUrl(url),
      api_key: apiKey === null ? (this._engines.get(name)?.api_key ?? "") : apiKey.trim(),
    });
  }

  all(): EngineEntry[] { return [...this._engines.values()]; }
  get(name: string): EngineEntry | undefined { return this._engines.get(name); }

  /** 成功返回 entry；重名异址 / 非法 name / 非法 url → null */
  add(name: string, url: string, apiKey: string): EngineEntry | null {
    name = (name || "").trim();
    url = (url || "").trim();
    if (!name || !isUrl(url)) return null;
    const existing = this._engines.get(name);
    if (existing && existing.url !== normUrl(url)) return null;
    this._upsert(name, url, apiKey || "");
    this._save();
    return this._engines.get(name)!;
  }

  setApiKey(name: string, key: string): EngineEntry | null {
    const e = this._engines.get(name);
    if (!e) return null;
    e.api_key = (key || "").trim();
    this._save();
    return e;
  }

  /** 幂等：不存在也正常返回 */
  remove(name: string): boolean {
    const had = this._engines.delete(name);
    if (had) this._save();
    return had;
  }
}

// ---------------------------------------------------------------------------
// HTTP 直连（node http/https；错误统一带 network 标记供 transport 分文案）
// ---------------------------------------------------------------------------

interface HttpOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

function httpJson<T = unknown>(url: string, opts: HttpOpts = {}): Promise<{ status: number; data: T }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new Error("URL 无效: " + url));
      return;
    }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      {
        method: opts.method || "GET",
        headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
        timeout: opts.timeoutMs ?? 15000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let data: unknown;
          try {
            data = JSON.parse(buf.toString("utf-8"));
          } catch {
            data = buf.toString("utf-8");
          }
          resolve({ status: res.statusCode || 0, data: data as T });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", (e) => reject(Object.assign(new Error("服务不可达: " + e.message), { network: true })));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function httpRaw(url: string, timeoutMs = 30000): Promise<{ status: number; buf: Buffer }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new Error("URL 无效: " + url));
      return;
    }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method: "GET", timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode || 0, buf: Buffer.concat(chunks) }));
    });
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", (e) => reject(Object.assign(new Error("服务不可达: " + e.message), { network: true })));
    req.end();
  });
}

/**
 * 流式 PUT 裸字节（上传音频 / 整片直传），带字节进度回调（≥100ms 节流）。
 * body 为 Buffer（内存分片）或 Readable（文件流）；失败时流被 destroy。
 */
function httpPutBytes(
  url: string,
  totalBytes: number,
  body: Buffer | NodeJS.ReadableStream,
  headers: Record<string, string>,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new Error("URL 无效: " + url));
      return;
    }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(totalBytes),
          ...headers,
        },
        timeout: 10 * 60 * 1000, // 大文件慢网：空闲 10 分钟才断
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let data: unknown;
          try {
            data = JSON.parse(buf.toString("utf-8"));
          } catch {
            data = buf.toString("utf-8");
          }
          resolve({ status: res.statusCode || 0, data });
        });
      },
    );
    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      if (!Buffer.isBuffer(body)) (body as unknown as { destroy?: () => void }).destroy?.();
      req.destroy();
      reject(e);
    };
    req.on("timeout", () => fail(new Error("上传超时")));
    req.on("error", (e) => fail(Object.assign(new Error("网络错误: " + e.message), { network: true })));

    let loaded = 0;
    let lastSent = 0;
    const notify = () => {
      const now = Date.now();
      if (onProgress && now - lastSent > 100) {
        lastSent = now;
        onProgress(loaded, totalBytes);
      }
    };
    const done = () => {
      onProgress?.(totalBytes, totalBytes);
      req.end();
    };

    if (Buffer.isBuffer(body)) {
      const buf = body;
      const CHUNK = 1024 * 1024;
      let off = 0;
      const step = () => {
        while (off < totalBytes) {
          const end = Math.min(off + CHUNK, totalBytes);
          if (!req.write(buf.subarray(off, end))) {
            req.once("drain", step);
            return;
          }
          off = end;
          loaded = off;
          notify();
        }
        done();
      };
      step();
    } else {
      const stream = body as NodeJS.ReadableStream;
      stream.on("error", (e) => fail(e instanceof Error ? e : new Error(String(e))));
      stream.on("data", (c: Buffer) => {
        loaded += c.length;
        notify();
        if (!req.write(c)) {
          stream.pause();
          req.once("drain", () => stream.resume());
        }
      });
      stream.on("end", () => done());
    }
  });
}

// ---------------------------------------------------------------------------
// 引擎快照：单飞 + 3s TTL（等价工作台 poller：离线保留上次值）
// ---------------------------------------------------------------------------

interface EngineInfo {
  name: string;
  url: string;
  online: boolean;
  has_key: boolean;
  version: string | null;
  device: string | null;
  jobs_running: number;
  error: string | null;
  _details: any[];
}
interface Snapshot { engines: EngineInfo[]; at: number; }

let store: EngineStore;
let win: BrowserWindow | null = null;
let lastSnap: Snapshot | null = null;
let inFlight: Promise<Snapshot> | null = null;
const TTL_MS = 3000;

async function refreshOne(entry: EngineEntry): Promise<EngineInfo> {
  const prev = lastSnap?.engines.find((e) => e.name === entry.name);
  try {
    const h = await httpJson<any>(entry.url + "/health", { timeoutMs: 5000 });
    if (h.status !== 200 || !h.data || h.data.ok !== true) throw new Error("health not ok");
    let details: any[] = [];
    const sj = await httpJson<any[]>(entry.url + "/jobs", { timeoutMs: 5000 });
    const summaries = Array.isArray(sj.data) ? sj.data : [];
    details = await Promise.all(
      summaries.map(async (s) => {
        try {
          const d = await httpJson<any>(entry.url + "/jobs/" + encodeURIComponent(String(s.id)), { timeoutMs: 5000 });
          return d.data;
        } catch {
          return s; // 单任务明细失败：摘要兜底，不拖垮引擎
        }
      }),
    );
    return {
      name: entry.name,
      url: entry.url,
      online: true,
      has_key: !!entry.api_key,
      version: String(h.data.version || ""),
      device: String(h.data.device || ""),
      jobs_running: details.filter((j) => j && j.state === "running").length,
      error: null,
      _details: details,
    };
  } catch (e) {
    // 离线：保留上次 version/device/jobs（与 poller 一致）
    return {
      name: entry.name,
      url: entry.url,
      online: false,
      has_key: !!entry.api_key,
      version: prev?.version ?? null,
      device: prev?.device ?? null,
      jobs_running: 0,
      error: String((e as Error)?.message || e).slice(0, 200),
      _details: prev?._details ?? [],
    };
  }
}

function refresh(): Promise<Snapshot> {
  if (lastSnap && Date.now() - lastSnap.at < TTL_MS) return Promise.resolve(lastSnap);
  if (!inFlight) {
    inFlight = (async () => {
      const engines = await Promise.all(store.all().map(refreshOne));
      return { engines, at: Date.now() };
    })();
    inFlight.then(
      (s) => {
        lastSnap = s;
      },
      () => {},
    ).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** 任务行展平（等价 web/src/jav_scribe_web/api.py 的 _job_rows） */
function jobRows(infos: EngineInfo[]): any[] {
  const rows: any[] = [];
  for (const info of infos) {
    for (const job of info._details) {
      const base = {
        engine: info.name,
        job_id: job?.id ?? null,
        label: job?.label || "",
        state: job?.state ?? null,
        created: job?.created ?? null,
        finished: job?.finished ?? null,
        source_kind: job?.source_kind ?? null,
      };
      const files = job?.files;
      if (!files || !files.length) {
        const total = job?.total || 0;
        const done = job?.done || 0;
        const finished = job?.state === "finished";
        rows.push({
          ...base,
          file: job?.label || String(job?.id),
          status: finished ? "done" : "running",
          progress: total ? done / total : finished ? 1 : 0,
          position: "",
          duration_s: null,
          position_s: null,
          message: `${done}/${total}`,
          output_files: [],
        });
      } else {
        for (const t of files) {
          rows.push({
            ...base,
            file: t?.name || "",
            status: t?.status,
            phase: t?.phase ?? null,
            progress: t?.progress || 0,
            position: t?.position || "",
            duration_s: t?.duration_s ?? null,
            position_s: t?.position_s ?? null,
            message: t?.message || "",
            finished: t?.finished ?? null,
            output_files: t?.output_files || [],
          });
        }
      }
    }
  }
  // running 优先 + created 降序（JS sort 稳定，等价 Python 的 (running?0:1, -created)）
  rows.sort(
    (a, b) =>
      (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1) ||
      ((b.created || 0) - (a.created || 0)),
  );
  return rows;
}

// ---------------------------------------------------------------------------
// serve 请求封装（错误文案等价工作台 _map_config_error / api_retry）
// ---------------------------------------------------------------------------

function engineByName(name: string): EngineEntry {
  const e = store.get(name);
  if (!e) throw new Error("服务不存在");
  return e;
}

function serveError(status: number, data: unknown): Error {
  const msg = data && typeof data === "object" && (data as { error?: unknown }).error
    ? String((data as { error?: unknown }).error)
    : "";
  if (status >= 400 && status < 500) return new Error(`服务请求失败: ${msg || status}`);
  return new Error(`服务请求失败: HTTP ${status}`);
}

function configError(status: number, data: unknown): Error {
  if (status === 403) return new Error("该服务尚未设置 API Key（需在服务端配置 JAVSCRIBE_API_KEY）");
  if (status === 401) return new Error("API Key 不正确：请核对服务端的 JAVSCRIBE_API_KEY 与登记的 Key");
  if (status === 404) return new Error("该服务版本过旧，不支持配置管理（请升级 JavScribe 服务）");
  return serveError(status, data);
}

// ---------------------------------------------------------------------------
// ffmpeg 本地提音轨（spawn，stderr time=/Duration: 算进度）
// ---------------------------------------------------------------------------

function findFfmpeg(): string | null {
  const env = process.env.JAVSCRIBE_FFMPEG;
  if (env && fs.existsSync(env)) return env;
  // 打包资源位（三期随包 ffmpeg；二期留空位）
  const res = path.join(
    path.dirname(app.getPath("exe")),
    "resources",
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  if (fs.existsSync(res)) return res;
  const paths = (process.env.PATH || "").split(path.delimiter);
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  for (const p of paths) {
    if (!p) continue;
    const cand = path.join(p, name);
    try {
      if (fs.statSync(cand).isFile()) return cand;
    } catch {
      /* 不存在 */
    }
  }
  return null;
}

type ExtractResult = { ok: true; opusPath: string; sizeBytes: number } | { ok: false; error: string };

function runExtract(args: { videoPath?: string; data?: Uint8Array }, onFrac: (f: number) => void): Promise<ExtractResult> {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    return Promise.resolve({
      ok: false,
      error: "未找到 ffmpeg（请安装 ffmpeg 并加入 PATH，或设置 JAVSCRIBE_FFMPEG 环境变量）",
    });
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "javscribe-client-"));
  const outPath = path.join(tmp, "out.opus");
  let src = args.videoPath;
  try {
    if (!src) {
      if (!args.data || !args.data.length) {
        fs.rmSync(tmp, { recursive: true, force: true });
        return Promise.resolve({ ok: false, error: "空文件" });
      }
      src = path.join(tmp, "in.bin");
      fs.writeFileSync(src, args.data);
    }
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return Promise.resolve({ ok: false, error: "读取文件失败: " + (e as Error).message });
  }

  return new Promise((resolve) => {
    let durationSec = 0;
    let lastFrac = -1;
    let finished = false;
    const finish = (r: ExtractResult) => {
      if (finished) return;
      finished = true;
      // 成功时保留 opus 文件：由 upload-audio 流式读完后清理整个 tmp 目录
      if (!r.ok) fs.rmSync(tmp, { recursive: true, force: true });
      resolve(r);
    };
    const proc = spawn(
      ffmpeg,
      ["-hide_banner", "-i", src, ...OPUS_EXTRACT_ARGS, "-y", outPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderrTail = "";
    proc.stderr.on("data", (c: Buffer) => {
      const s = c.toString("utf-8");
      stderrTail = (stderrTail + s).slice(-4000);
      const dm = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderrTail);
      if (dm && !durationSec) durationSec = +dm[1] * 3600 + +dm[2] * 60 + parseFloat(dm[3]);
      const tm = /time=(\d+):(\d+):(\d+(?:\.\d+)?)\s/.exec(s);
      if (tm && durationSec > 0) {
        const t = +tm[1] * 3600 + +tm[2] * 60 + parseFloat(tm[3]);
        const frac = Math.max(0, Math.min(1, t / durationSec));
        if (frac - lastFrac >= 0.01 || frac >= 1) {
          lastFrac = frac;
          onFrac(frac);
        }
      }
    });
    proc.on("error", (e) => finish({ ok: false, error: "ffmpeg 启动失败: " + e.message }));
    proc.on("close", (code) => {
      if (code === 0) {
        try {
          const size = fs.statSync(outPath).size;
          onFrac(1);
          finish({ ok: true, opusPath: outPath, sizeBytes: size });
        } catch (e) {
          finish({ ok: false, error: "提取输出读取失败: " + (e as Error).message });
        }
      } else {
        const lines = stderrTail.split("\n").map((l) => l.trim()).filter(Boolean);
        const tail = lines.slice(-3).join(" | ").slice(0, 300);
        finish({ ok: false, error: `本地提取失败（退出码 ${code}）${tail ? ": " + tail : ""}` });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function sendToWin(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** 上传受理：201 → {job_id,file}；其余用 serve 错误体文案 */
function uploadAccept(
  status: number,
  data: unknown,
): { ok: true; job_id: string; file: string } | { ok: false; error: string; network?: boolean } {
  if (status === 201) {
    const d = data as { job_id?: string; file?: string };
    return { ok: true, job_id: String(d?.job_id || ""), file: String(d?.file || "") };
  }
  const msg = data && typeof data === "object" && (data as { error?: unknown }).error
    ? String((data as { error?: unknown }).error)
    : `HTTP ${status}`;
  return { ok: false, error: msg };
}

function registerIpc(): void {
  ipcMain.handle("t-call", async (_ev, args: { method: string; args?: unknown[] }) => {
    const [a0, a1, a2] = (args?.args || []) as string[];
    try {
      switch (args?.method) {
        case "getHealth": {
          const s = await refresh();
          return {
            ok: true,
            data: {
              ok: true,
              app: "JavScribe Client",
              version: app.getVersion(),
              engines: s.engines.length,
              online: s.engines.filter((e) => e.online).length,
            },
          };
        }
        case "listEngines": {
          const s = await refresh();
          const list = s.engines.map((e) => {
            const { _details, ...pub } = e;
            return pub;
          });
          return { ok: true, data: list };
        }
        case "listJobs": {
          const s = await refresh();
          return { ok: true, data: jobRows(s.engines) };
        }
        case "addEngine": {
          const e = store.add(String(a0 || ""), String(a1 || ""), String(a2 || ""));
          if (!e) return { ok: false, error: "name/url 无效，或该名称已指向其它地址" };
          lastSnap = null;
          return { ok: true };
        }
        case "deleteEngine": {
          store.remove(String(a0 || "")); // 幂等
          lastSnap = null;
          return { ok: true };
        }
        case "putEngineKey": {
          const e = store.setApiKey(String(a0 || ""), String(a1 || ""));
          if (!e) return { ok: false, error: "服务不存在" };
          lastSnap = null;
          return { ok: true };
        }
        case "getResultData": {
          const entry = engineByName(String(a0));
          const r = await httpRaw(entry.url + "/jobs/" + encodeURIComponent(String(a1)) + "/result");
          if (r.status !== 200) return { ok: false, error: "no result yet" };
          return { ok: true, data: sanitizeSrtBytes(new Uint8Array(r.buf)) };
        }
        case "retryJob": {
          const entry = engineByName(String(a0));
          const r = await httpJson<any>(
            entry.url + "/jobs/" + encodeURIComponent(String(a1)) + "/retry",
            { method: "POST", body: "", timeoutMs: 15000 },
          );
          if (r.status === 201) return { ok: true, data: { jobId: String((r.data as { job_id?: string })?.job_id || "") } };
          if (r.status === 404) return { ok: false, error: "任务不存在（已过期）" };
          if (r.status === 409) return { ok: false, error: "无可重新生成的文件（非跳过或已处理）" };
          throw serveError(r.status, r.data);
        }
        case "getConfig": {
          const entry = engineByName(String(a0));
          const headers: Record<string, string> = {};
          if (entry.api_key) headers["X-Api-Key"] = entry.api_key;
          const r = await httpJson<any>(entry.url + "/config", { headers, timeoutMs: 15000 });
          if (r.status !== 200) throw configError(r.status, r.data);
          return { ok: true, data: (r.data as { items?: unknown[] })?.items || [] };
        }
        case "putConfig": {
          const entry = engineByName(String(a0));
          const headers: Record<string, string> = {};
          if (entry.api_key) headers["X-Api-Key"] = entry.api_key;
          let values: Record<string, unknown>;
          try {
            values = JSON.parse(String(a1 || "{}"));
          } catch {
            return { ok: false, error: "values 不能为空" };
          }
          const r = await httpJson<any>(entry.url + "/config", {
            method: "PUT",
            headers,
            body: JSON.stringify({ values }),
            timeoutMs: 15000,
          });
          if (r.status !== 200) throw configError(r.status, r.data);
          return { ok: true };
        }
        case "scan": {
          const entry = engineByName(String(a0));
          const headers: Record<string, string> = {};
          if (entry.api_key) headers["X-Api-Key"] = entry.api_key;
          const r = await httpJson<any>(entry.url + "/scan?path=" + encodeURIComponent(String(a1 || "")), {
            headers,
            timeoutMs: 30000,
          });
          if (r.status !== 200) throw configError(r.status, r.data);
          return { ok: true, data: r.data };
        }
        case "submitScan": {
          const entry = engineByName(String(a0));
          const headers: Record<string, string> = {};
          if (entry.api_key) headers["X-Api-Key"] = entry.api_key;
          let files: unknown;
          try {
            files = JSON.parse(String(a1 || "[]"));
          } catch {
            return { ok: false, error: "files 需要非空数组（绝对路径列表）" };
          }
          if (!Array.isArray(files) || !files.length) {
            return { ok: false, error: "files 需要非空数组（绝对路径列表）" };
          }
          const r = await httpJson<any>(entry.url + "/scan/submit", {
            method: "POST",
            headers,
            body: JSON.stringify({ files }),
            timeoutMs: 30000,
          });
          if (r.status !== 201) throw configError(r.status, r.data);
          const d = r.data as { job_id?: string; files?: number };
          return { ok: true, data: { files: Number(d?.files || 0), jobId: String(d?.job_id || "") } };
        }
        default:
          return { ok: false, error: "unknown method: " + args?.method };
      }
    } catch (e) {
      const err = e as Error & { network?: boolean };
      return { ok: false, error: err.message || String(e), network: !!err.network };
    }
  });

  // 本地提音轨：videoPath（本机文件）或 data（无路径的 File 字节，e2e setInputFiles 场景）
  ipcMain.handle("extract-audio", (_ev, args: { videoPath?: string; data?: Uint8Array }) => {
    return runExtract(args || {}, (frac) => sendToWin("extract-progress", { frac }));
  });

  // 音频上传（opus 字节流 → serve /upload?ext=opus，无 key）
  ipcMain.handle("upload-audio", async (_ev, args: { id: string; engine: string; name: string; opusPath?: string; data?: Uint8Array }) => {
    let opusDir: string | null = null;
    try {
      const entry = engineByName(String(args.engine || ""));
      let body: Buffer | NodeJS.ReadableStream;
      let totalBytes: number;
      if (args.opusPath) {
        opusDir = path.dirname(args.opusPath);
        totalBytes = fs.statSync(args.opusPath).size;
        if (totalBytes <= 0) return { ok: false, error: "音频文件为空" };
        body = fs.createReadStream(args.opusPath, { highWaterMark: 1024 * 1024 });
      } else if (args.data) {
        body = Buffer.from(args.data);
        totalBytes = body.length;
        if (!totalBytes) return { ok: false, error: "音频文件为空" };
      } else {
        return { ok: false, error: "缺少音频载荷" };
      }
      const r = await httpPutBytes(
        entry.url + "/upload?ext=opus",
        totalBytes,
        body,
        { "X-Source-Name": String(args.name || "remote") },
        (loaded, total) => sendToWin("t-progress", { id: args.id, loaded, total }),
      );
      return uploadAccept(r.status, r.data);
    } catch (e) {
      const err = e as Error & { network?: boolean };
      return { ok: false, error: err.message || String(e), network: !!err.network };
    } finally {
      if (opusDir) {
        try {
          fs.rmSync(opusDir, { recursive: true, force: true });
        } catch {
          /* 临时目录清理失败可忽略 */
        }
      }
    }
  });

  // 整片直传（用户显式选「整片直传字幕服务」时的逃生通道；受服务端 MAX_UPLOAD_MB 限制）
  ipcMain.handle("upload-file", async (_ev, args: { id: string; engine: string; name: string; ext: string; localPath?: string; data?: Uint8Array }) => {
    let tmpDir: string | null = null;
    try {
      const entry = engineByName(String(args.engine || ""));
      let filePath = args.localPath;
      if (!filePath) {
        if (!args.data || !args.data.length) return { ok: false, error: "空文件" };
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "javscribe-client-up-"));
        filePath = path.join(tmpDir, path.basename(String(args.name || "file")));
        fs.writeFileSync(filePath, args.data);
      }
      const totalBytes = fs.statSync(filePath).size;
      if (totalBytes <= 0) return { ok: false, error: "空文件" };
      const r = await httpPutBytes(
        entry.url + "/upload?ext=" + encodeURIComponent(String(args.ext || "mp4")),
        totalBytes,
        fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 }),
        { "X-Source-Name": String(args.name || "remote") },
        (loaded, total) => sendToWin("t-progress", { id: args.id, loaded, total }),
      );
      return uploadAccept(r.status, r.data);
    } catch (e) {
      const err = e as Error & { network?: boolean };
      return { ok: false, error: err.message || String(e), network: !!err.network };
    } finally {
      if (tmpDir) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* 忽略 */
        }
      }
    }
  });

  // srt 保存（写回失败兜底 / 手动下载）
  ipcMain.handle("download-srt", async (_ev, args: { url: string; filename: string }) => {
    try {
      const r = await httpRaw(String(args.url || ""));
      if (r.status !== 200) return { ok: false, error: `下载失败: HTTP ${r.status}` };
      const buf = sanitizeSrtBytes(new Uint8Array(r.buf));
      const out = await dialog.showSaveDialog(win as BrowserWindow, {
        defaultPath: String(args.filename || "subtitle.srt"),
        filters: [{ name: "字幕", extensions: ["srt"] }],
      });
      if (out.canceled || !out.filePath) return { ok: false, error: "已取消" };
      fs.writeFileSync(out.filePath, buf);
      return { ok: true, path: out.filePath };
    } catch (e) {
      const err = e as Error & { network?: boolean };
      return { ok: false, error: err.message || String(e), network: !!err.network };
    }
  });

  // 写回源目录（影片同目录 <stem>.zh.srt）
  ipcMain.handle("write-srt", (_ev, args: { videoPath: string; srtName: string; data: Uint8Array }) => {
    try {
      const videoPath = String(args.videoPath || "");
      const srtName = String(args.srtName || "");
      if (!videoPath || !srtName) return { ok: false, error: "缺少路径" };
      if (srtName.includes("/") || srtName.includes("\\")) return { ok: false, error: "文件名非法" };
      const dir = path.dirname(videoPath);
      fs.mkdirSync(dir, { recursive: true });
      const full = path.join(dir, srtName);
      fs.writeFileSync(full, new Uint8Array(args.data || new Uint8Array()));
      return { ok: true, path: full };
    } catch (e) {
      return { ok: false, error: (e as Error).message || String(e) };
    }
  });

  // 原生对话框
  ipcMain.handle("pick-video-file", async () => {
    const r = await dialog.showOpenDialog(win as BrowserWindow, {
      title: "选择影片文件",
      properties: ["openFile"],
      filters: [{ name: "视频文件", extensions: [...VIDEO_EXTS] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    const p = r.filePaths[0];
    try {
      return { path: p, name: path.basename(p), size: fs.statSync(p).size };
    } catch {
      return { path: p, name: path.basename(p), size: 0 };
    }
  });

  // 原生目录选择 + 递归枚举（VIDEO_EXTS 过滤、上限 5000、rel 含根目录名——与 web webkitRelativePath 同构）
  ipcMain.handle("pick-video-folder", async () => {
    const r = await dialog.showOpenDialog(win as BrowserWindow, {
      title: "选择影片文件夹",
      properties: ["openDirectory"],
    });
    if (r.canceled || !r.filePaths.length) return null;
    const root = r.filePaths[0];
    const out: Array<{ path: string; name: string; size: number; rel: string }> = [];
    const walk = (dir: string, rel: string) => {
      if (out.length >= 5000) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // 子目录不可读：跳过
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= 5000) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full, rel + "/" + e.name);
        } else if (e.isFile()) {
          const m = /\.([a-z0-9]{1,8})$/i.exec(e.name);
          if (!m || !VIDEO_EXTS.includes(m[1].toLowerCase())) continue;
          try {
            const size = fs.statSync(full).size;
            if (size <= 0) continue;
            out.push({ path: full, name: e.name, size, rel: rel + "/" + e.name });
          } catch {
            /* 权限怪癖 / 扫描中途消失：跳过 */
          }
        }
      }
    };
    walk(root, path.basename(root));
    return out;
  });
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 1000,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#f2efe9",
    title: "JavScribe Client",
    // e2e 无框（JAVSCRIBE_CLIENT_FRAMELESS=1）：viewport 与 web 基线（1440x1000）完全一致
    frame: process.env.JAVSCRIBE_CLIENT_FRAMELESS !== "1",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "index.html"));
  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(() => {
  if (process.env.JAVSCRIBE_CLIENT_USERDATA) {
    app.setPath("userData", process.env.JAVSCRIBE_CLIENT_USERDATA);
  }
  store = new EngineStore(app.getPath("userData"));
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
