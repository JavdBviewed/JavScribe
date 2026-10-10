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

import { app, BrowserWindow, Menu, dialog, ipcMain, net, session, shell, type MenuItemConstructorOptions } from "electron";
import { autoUpdater } from "electron-updater";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { LOCAL_SUB_PATTERNS, OPUS_EXTRACT_ARGS, VIDEO_EXTS } from "../core/constants";
import type { AudioCacheHit, UploadDispatchResult } from "../core/desktop-bridge";
import type { ScanItem, ScanResult, ScanTaskSnapshot } from "../core/types";
import { folderIsVideo, folderTokensIn, folderVideoMeta, type FolderScanRules } from "../core/folder-scan";
import { jobRows, pickJobDetail } from "../core/job-rows";
import { sanitizeSrtBytes } from "../core/srt-sanitize";
import {
  type EmbeddedSub,
  parseProbeOutput,
  probeArgs,
  shouldSkipEmbedded,
} from "../core/sub-embed";

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

interface EngineEntry { name: string; url: string; api_key: string; /** 参与自动均衡（desktop 客户端侧持久化；缺省=参与） */ enabled?: boolean; }

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
        if (typeof e.enabled === "boolean") this._engines.get(name)!.enabled = e.enabled;
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

  setEnabled(name: string, enabled: boolean): EngineEntry | null {
    const e = this._engines.get(name);
    if (!e) return null;
    e.enabled = !!enabled;
    this._save();
    return e;
  }

  /** 幂等登记（本地服务端集成用）：不存在才创建，存在（用户改过 URL/Key）一律保留 */
  ensure(name: string, url: string): void {
    if (!this._engines.has(name) && isUrl(url)) {
      this._upsert(name, url, "");
      this._save();
    }
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
    // 显式 Content-Length：不带时 Node http 自动改 chunked 编码，serve（http.server）
    // 不自动解 chunked → 一切带体 POST 会被 400「bad body size」误杀
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers || {}) };
    if (opts.body) headers["Content-Length"] = String(Buffer.byteLength(opts.body, "utf-8"));
    const req = lib.request(
      u,
      {
        method: opts.method || "GET",
        headers,
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
// 服务端音轨缓存「先问后传」：上传前算 sha1 → /cache/check 预检 →
//   命中：/upload/submit 直接建任务（免传字节，UI 推满进度）
//   未命中 / 旧版服务（404）/ submit 竞态失败：返回 null，调用方回退常规 PUT /upload
// ---------------------------------------------------------------------------

/** 文件 sha1（流式分块读，不整包驻留内存） */
function sha1File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha1");
    const st = fs.createReadStream(p, { highWaterMark: 4 * 1024 * 1024 });
    st.on("data", (c: Buffer) => h.update(c));
    st.on("end", () => resolve(h.digest("hex")));
    st.on("error", reject);
  });
}

const sha1Hex = (buf: Buffer): string => crypto.createHash("sha1").update(buf).digest("hex");

/**
 * 预检 + 命中提交。成功返回 ok+cached:true 的受理结果；
 * 需要回退上传（未命中 / 404 / 409 / 预检网络异常）时返回 null。
 */
async function tryServerCache(
  base: string,
  sha1: string,
  sizeBytes: number,
  ext: string,
  sourceName: string,
  onProgress: (loaded: number, total: number) => void,
  batch?: { id: string; label?: string } | null,
): Promise<UploadDispatchResult | null> {
  const batchQ = batch
    ? `&batch_id=${encodeURIComponent(batch.id)}&batch_label=${encodeURIComponent(batch.label || "")}`
    : "";
  try {
    const ck = await httpJson<{ ok?: boolean; cached?: boolean }>(
      `${base}/cache/check?sha1=${sha1}&size=${sizeBytes}&ext=${encodeURIComponent(ext)}`,
      { timeoutMs: 10000 },
    );
    if (ck.status !== 200 || ck.data?.cached !== true) return null; // 404=旧版服务，直接回退
    onProgress(sizeBytes, sizeBytes); // 命中：直接推满进度（无需传字节）
    const sub = await httpJson<{ job_id?: string; file?: string }>(
      `${base}/upload/submit?sha1=${sha1}&ext=${encodeURIComponent(ext)}${batchQ}`,
      { method: "POST", headers: { "X-Source-Name": sourceName }, timeoutMs: 15000 },
    );
    if (sub.status === 201 && sub.data && typeof sub.data === "object") {
      const d = sub.data as { job_id?: string; file?: string };
      return { ok: true, job_id: String(d.job_id || ""), file: String(d.file || ""), cached: true };
    }
    return null; // 命中后 submit 失败（如缓存文件恰被 retention 清理）→ 回退重传
  } catch {
    return null; // 预检网络异常不阻断主上传流程，回退后由 PUT 报真实错误
  }
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
  batch_paused: string[];
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
          // 明细仅采纳 200 且带 id 的响应；404 错误体回退摘要（摘要必带 id），杜绝幻行
          return pickJobDetail(d.status, d.data, s);
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
      batch_paused: Array.isArray(h.data.batch_paused)
        ? h.data.batch_paused.filter((x: unknown): x is string => typeof x === "string")
        : [],
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
      batch_paused: prev?.batch_paused ?? [],
      error: String((e as Error)?.message || e).slice(0, 200),
      _details: prev?._details ?? [],
    };
  }
}

/** 对外引擎视图：去内部 _details；「参与均衡」状态由 store 合并（快照无此字段） */
function publicEngines(s: Snapshot) {
  return s.engines.map((e) => {
    const { _details, ...pub } = e;
    return { ...pub, enabled: store.get(e.name)?.enabled !== false };
  });
}

function refresh(force = false): Promise<Snapshot> {
  if (!force && lastSnap && Date.now() - lastSnap.at < TTL_MS) return Promise.resolve(lastSnap);
  if (!inFlight) {
    inFlight = (async () => {
      const engines = await Promise.all(store.all().map(refreshOne));
      batchesReconcile(engines); // 主任务完成对账（batches.json；快照成功才判）
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
// Desktop 本地后台扫描
// ---------------------------------------------------------------------------
// 扫描目录属于客户端能力：这里只读目录项、视频 stat 大小和同目录字幕文件名。
// 绝不调用 serve /scan、ffprobe、ffmpeg，也不打开视频文件，因此不会因为扫描
// 115/CloudDrive2 挂载目录而主动下载视频内容。

const DESKTOP_SCAN_MAX_ITEMS = 5000;
const DESKTOP_SCAN_DEFAULTS = {
  video_exts: [...VIDEO_EXTS],
  subtitle_patterns: [...LOCAL_SUB_PATTERNS],
  recurse: true,
  min_size_mb: 200,
  has_sub_tokens: [] as string[],
  no_sub_tokens: ["c"],
};
// 文件名 token 切分：连续字母数字段（- 空格 _ . [ ] 等分隔均切开）；整词相等匹配
// 天然排除粘番号（SSIS-123C）、CD 集数（CD1/1CD）、词内词（Uncut/CUT）。
const _SCAN_TOKEN_RE = /^[a-z0-9]{1,16}$/;

/** 文件名按 token 整词匹配（语义单点在 core/folder-scan.ts；此处保留旧名供扫描项判定复用） */
function scanTokensIn(name: string, tokens: string[]): string | null {
  return folderTokensIn(name, tokens);
}

type DesktopScanOptions = {
  min_size_mb: number;
  has_sub_tokens: string[];
  no_sub_tokens: string[];
  video_exts: string[];
  subtitle_patterns: string[];
  recurse: boolean;
};

type DesktopScanRecord = ScanTaskSnapshot & {
  options: DesktopScanOptions;
  pauseRequested: boolean;
  cancelRequested: boolean;
};

const desktopScanTasks = new Map<string, DesktopScanRecord>();
const desktopScanWorkers = new Set<string>();
let desktopScanSaveTimer: NodeJS.Timeout | null = null;

function desktopScanPath(): string {
  return path.join(app.getPath("userData"), "scan-tasks.json");
}

function safeScanOptions(raw: unknown, cfg?: Partial<DesktopScanOptions>): DesktopScanOptions {
  const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const number = Number(o.min_size_mb ?? cfg?.min_size_mb ?? DESKTOP_SCAN_DEFAULTS.min_size_mb);
  // token 列表：显式 [] = 关该方向；两键都缺且带旧版持久化任务的 naming_c 时按老语义映射
  const tokList = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((x) => typeof x === "string")
      ? [...new Set(v.map((x) => String(x).toLowerCase()))] : null;
  let hasSub: string[] | null = tokList(o.has_sub_tokens);
  let noSub: string[] | null = tokList(o.no_sub_tokens);
  if (hasSub === null && noSub === null && typeof o.naming_c === "string") {
    const naming = String(o.naming_c);
    hasSub = naming === "has_sub" ? ["c"] : [];
    noSub = naming === "no_sub" ? ["c"] : [];
  }
  if (hasSub === null) hasSub = tokList(cfg?.has_sub_tokens);
  if (noSub === null) noSub = tokList(cfg?.no_sub_tokens);
  const exts = Array.isArray(o.video_exts) ? o.video_exts : cfg?.video_exts;
  const pats = Array.isArray(o.subtitle_patterns) ? o.subtitle_patterns : cfg?.subtitle_patterns;
  return {
    min_size_mb: Number.isFinite(number) && number >= 0 ? number : DESKTOP_SCAN_DEFAULTS.min_size_mb,
    has_sub_tokens: hasSub || DESKTOP_SCAN_DEFAULTS.has_sub_tokens,
    no_sub_tokens: noSub || DESKTOP_SCAN_DEFAULTS.no_sub_tokens,    video_exts: [...new Set((exts || DESKTOP_SCAN_DEFAULTS.video_exts).map(String).map((x) => x.toLowerCase().replace(/^\./, "")).filter(Boolean))],
    subtitle_patterns: [...new Set((pats || DESKTOP_SCAN_DEFAULTS.subtitle_patterns).map(String).map((x) => x.toLowerCase().startsWith(".") ? x.toLowerCase() : "." + x.toLowerCase()).filter(Boolean))],
    recurse: o.recurse == null ? (cfg?.recurse ?? true) : Boolean(o.recurse),
  };
}

function desktopScanPublic(r: DesktopScanRecord): ScanTaskSnapshot {
  const { options: _options, pauseRequested: _pause, cancelRequested: _cancel, ...publicTask } = r;
  return structuredClone(publicTask);
}

function persistDesktopScanTasks(): void {
  if (desktopScanSaveTimer) return;
  desktopScanSaveTimer = setTimeout(() => {
    desktopScanSaveTimer = null;
    try {
      const file = desktopScanPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + ".tmp";
      const data = [...desktopScanTasks.values()].map((r) => {
        const { pauseRequested: _pause, cancelRequested: _cancel, ...safe } = r;
        return safe;
      });
      fs.writeFileSync(tmp, JSON.stringify({ tasks: data }, null, 1), "utf8");
      fs.renameSync(tmp, file);
    } catch (e) {
      console.warn("[scan] 保存任务状态失败:", (e as Error).message);
    }
  }, 150);
}

function persistDesktopScanTasksNow(): void {
  if (desktopScanSaveTimer) {
    clearTimeout(desktopScanSaveTimer);
    desktopScanSaveTimer = null;
  }
  try {
    const file = desktopScanPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    const data = [...desktopScanTasks.values()].map((r) => {
      const { pauseRequested: _pause, cancelRequested: _cancel, ...safe } = r;
      return safe;
    });
    fs.writeFileSync(tmp, JSON.stringify({ tasks: data }, null, 1), "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn("[scan] 保存任务状态失败:", (e as Error).message);
  }
}

function loadDesktopScanTasks(): void {
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(desktopScanPath(), "utf8")); } catch { return; }
  const rows = parsed && typeof parsed === "object" && Array.isArray((parsed as { tasks?: unknown[] }).tasks)
    ? (parsed as { tasks: unknown[] }).tasks : [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<DesktopScanRecord>;
    if (typeof r.id !== "string" || typeof r.path !== "string" || typeof r.engine !== "string") continue;
    const status = r.status === "queued" || r.status === "running" ? "paused" : r.status;
    if (!["paused", "done", "error", "canceled"].includes(String(status))) continue;
    desktopScanTasks.set(r.id, {
      id: r.id, engine: r.engine, path: r.path, resolved_path: r.resolved_path || null,
      mapped: false, status: status as ScanTaskSnapshot["status"],
      scanned: Number(r.scanned) || 0, found: Number(r.found) || 0,
      result: r.result || null, error: r.error || null,
      created: Number(r.created) || Date.now(), updated: Date.now(), finished: r.finished || null,
      options: safeScanOptions((r as { options?: unknown }).options),
      pauseRequested: status === "paused", cancelRequested: false,
    });
  }
}

function clientScanCfg(): Partial<DesktopScanOptions> {
  // 扫描规则统一来自本机 client config（「客户端设置 · 扫描规则」组）；服务离线也可扫
  const c = clientCfgLoad();
  const out: Partial<DesktopScanOptions> = {};
  if (Array.isArray(c.scan_video_exts)) out.video_exts = c.scan_video_exts;
  if (Array.isArray(c.scan_subtitle_patterns)) out.subtitle_patterns = c.scan_subtitle_patterns;
  if (typeof c.scan_recurse === "boolean") out.recurse = c.scan_recurse;
  if (typeof c.scan_min_size_mb === "number") out.min_size_mb = c.scan_min_size_mb;
  if (Array.isArray(c.scan_has_sub_tokens)) out.has_sub_tokens = c.scan_has_sub_tokens;
  if (Array.isArray(c.scan_no_sub_tokens)) out.no_sub_tokens = c.scan_no_sub_tokens;
  return out;
}

function desktopScanItem(filePath: string, name: string, size: number, options: DesktopScanOptions, subtitleNames: Set<string>): ScanItem {
  const stem = path.basename(name, path.extname(name));
  const subtitle = options.subtitle_patterns
    .map((suffix) => stem + suffix)
    .find((candidate) => subtitleNames.has(candidate)) || null;
  let namedTok = scanTokensIn(name, options.has_sub_tokens);
  const noSubTok = scanTokensIn(name, options.no_sub_tokens);
  if (namedTok !== null && noSubTok !== null) namedTok = null; // 双列表同时命中 → 无字幕优先（保守）
  const named = namedTok !== null;
  const noSub = noSubTok !== null;
  return {
    path: filePath, name, size,
    has_subtitle: Boolean(subtitle) || named,
    subtitle,
    subtitle_status: subtitle ? "external" : named ? "named" : "none",
    embedded_checked: false, embedded_langs: [], probe_failed: false,
    too_small: options.min_size_mb > 0 && size < options.min_size_mb * 1048576,
    name_sub: named, name_no_sub: noSub,
    name_sub_token: namedTok, name_no_sub_token: noSubTok,
  };
}

async function waitDesktopScanControl(task: DesktopScanRecord): Promise<void> {
  while (task.pauseRequested && !task.cancelRequested) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (task.cancelRequested) throw new Error("__SCAN_CANCELED__");
}

async function runDesktopScan(task: DesktopScanRecord): Promise<void> {
  if (desktopScanWorkers.has(task.id)) return;
  desktopScanWorkers.add(task.id);
  let lastPersist = 0;
  const progress = (force = false) => {
    task.updated = Date.now();
    if (force || Date.now() - lastPersist > 250) { lastPersist = Date.now(); persistDesktopScanTasks(); }
  };
  try {
    await waitDesktopScanControl(task);
    const options = safeScanOptions(task.options, clientScanCfg());
    task.options = options;
    task.status = task.pauseRequested ? "paused" : "running";
    task.updated = Date.now();
    persistDesktopScanTasks();
    const root = path.resolve(task.path);
    const stack = [root];
    const items: ScanItem[] = [];
    let truncated = false;
    while (stack.length) {
      await waitDesktopScanControl(task);
      const current = stack.pop()!;
      let dir: fs.Dir;
      try { dir = await fs.promises.opendir(current); } catch { continue; }
      const entries: fs.Dirent[] = [];
      try {
        for await (const entryItem of dir) entries.push(entryItem);
      } finally { await dir.close().catch(() => {}); }
      entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      const subtitleNames = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
      for (const entryItem of entries) {
        await waitDesktopScanControl(task);
        task.scanned += 1;
        const full = path.join(current, entryItem.name);
        try {
          if (entryItem.isDirectory()) { if (options.recurse) stack.push(full); continue; }
          if (!entryItem.isFile()) continue;
          const ext = path.extname(entryItem.name).slice(1).toLowerCase();
          if (!options.video_exts.includes(ext)) continue;
          const st = await fs.promises.stat(full);
          if (!st.isFile() || st.size <= 0) continue;
          if (items.length >= DESKTOP_SCAN_MAX_ITEMS) { truncated = true; break; }
          items.push(desktopScanItem(full, entryItem.name, st.size, options, subtitleNames));
          task.found = items.length;
        } catch { /* 文件在网盘目录变化时消失：跳过，不中断整次扫描 */ }
        progress();
      }
      if (truncated) break;
    }
    items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const result: ScanResult = {
      path: root, items, truncated, mapped: false,
      min_size_mb: options.min_size_mb,
      has_sub_tokens: options.has_sub_tokens, no_sub_tokens: options.no_sub_tokens,
      embedded_checked: false, probe_errors: [],
    };
    task.result = result;
    task.status = "done";
    task.found = items.length;
    task.finished = Date.now();
    progress(true);
  } catch (e) {
    if ((e as Error).message === "__SCAN_CANCELED__" || task.cancelRequested) {
      task.status = "canceled";
      task.error = null;
    } else {
      task.status = "error";
      task.error = (e as Error).message || String(e);
    }
    task.finished = Date.now();
    progress(true);
  } finally {
    desktopScanWorkers.delete(task.id);
    persistDesktopScanTasksNow();
  }
}

function startDesktopScan(task: DesktopScanRecord): void {
  void runDesktopScan(task);
}

// ---------------------------------------------------------------------------
// ffmpeg 本地提音轨（spawn，stderr time=/Duration: 算进度）
// ---------------------------------------------------------------------------

function findFfmpeg(): string | null {
  const env = process.env.JAVSCRIBE_FFMPEG;
  if (env && fs.existsSync(env)) return env;
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  // 打包资源位：extraResources 在三种形态（NSIS/portable/AppImage+deb）下都落在
  // process.resourcesPath；win 安装目录下 exe 旁的 resources/ 作兜底（布局等价）
  const cands = [
    path.join(process.resourcesPath, name),
    path.join(path.dirname(app.getPath("exe")), "resources", name),
  ];
  for (const res of cands) if (fs.existsSync(res)) return res;
  const paths = (process.env.PATH || "").split(path.delimiter);
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

// ---------------------------------------------------------------------------
// 音轨缓存（userData/audio-cache/）：本地提取的 opus 落盘复用
//   - key = sha1(videoPath|size|mtimeMs)；条目 <key>.opus + <key>.meta.json
//   - 命中（源视频 size/mtime 未变）→ 免重提，直接复用
//   - 清理：启动时删超 7 天条目；总量超 20GB 按 lastUsedAt LRU 裁剪
//   - 仅 videoPath 通道缓存；data 通道（无真实路径的 File）走 tmp 原行为
// ---------------------------------------------------------------------------

const AUDIO_CACHE_MAX_AGE_MS = 7 * 86400 * 1000;
const AUDIO_CACHE_MAX_BYTES = 20 * 1024 * 1024 * 1024;

interface AudioCacheMeta {
  videoPath: string;
  videoName: string;
  videoSize: number;
  videoMtimeMs: number;
  audioBytes: number;
  createdAt: number;
  lastUsedAt: number;
}

/** upload-audio finally 清理判定：仅允许删除应用自建 mkdtemp 目录（tmpdir 下、首层名 javscribe-client-*） */
function isOwnTempDir(dir: string): boolean {
  const tmp = os.tmpdir().replace(/[\\/]+$/, "");
  if (!dir.startsWith(tmp + path.sep)) return false;
  const first = dir.slice(tmp.length + 1).split(path.sep)[0];
  return first.startsWith("javscribe-client-");
}

function audioCacheDir(): string {
  return path.join(app.getPath("userData"), "audio-cache");
}

function audioKey(videoPath: string, size: number, mtimeMs: number): string {
  return crypto.createHash("sha1").update(`${videoPath}|${size}|${Math.round(mtimeMs)}`).digest("hex");
}

function cacheMetaOf(key: string): string {
  return path.join(audioCacheDir(), key + ".meta.json");
}

function cacheOpusOf(key: string): string {
  return path.join(audioCacheDir(), key + ".opus");
}

function readCacheMeta(key: string): AudioCacheMeta | null {
  try {
    const m = JSON.parse(fs.readFileSync(cacheMetaOf(key), "utf8")) as AudioCacheMeta;
    if (!m || typeof m.videoPath !== "string") return null;
    return m;
  } catch {
    return null;
  }
}

function touchCache(key: string): void {
  const m = readCacheMeta(key);
  if (!m) return;
  m.lastUsedAt = Date.now();
  try { fs.writeFileSync(cacheMetaOf(key), JSON.stringify(m, null, 1)); } catch { /* 忽略 */ }
}

/** 精确命中：源视频存在且 size/mtime 与缓存一致 → 返回 opus 缓存路径，否则 null */
function cacheGetExact(videoPath: string, size: number, mtimeMs: number): string | null {
  const key = audioKey(videoPath, size, mtimeMs);
  const opus = cacheOpusOf(key);
  try {
    const st = fs.statSync(opus);
    if (!st.isFile() || st.size <= 0) return null;
    const m = readCacheMeta(key);
    if (!m) return null;
    touchCache(key);
    return opus;
  } catch {
    return null;
  }
}

/** 提取成功落缓存（同卷 rename，失败回退 copy）；返回最终 opus 路径（缓存目录或原 tmp） */
function cacheStore(videoPath: string, size: number, mtimeMs: number, opusSrc: string): string {
  try {
    const key = audioKey(videoPath, size, mtimeMs);
    const dir = audioCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const opus = cacheOpusOf(key);
    try { fs.renameSync(opusSrc, opus); }
    catch { fs.copyFileSync(opusSrc, opus); }
    const meta: AudioCacheMeta = {
      videoPath, videoName: path.basename(videoPath),
      videoSize: size, videoMtimeMs: Math.round(mtimeMs),
      audioBytes: fs.statSync(opus).size,
      createdAt: Date.now(), lastUsedAt: Date.now(),
    };
    fs.writeFileSync(cacheMetaOf(key), JSON.stringify(meta, null, 1));
    return opus;
  } catch (e) {
    console.warn("[audio-cache] 落缓存失败（回退 tmp 原行为）:", (e as Error).message);
    return opusSrc;
  }
}

/** 按影片文件名查最近缓存条目（换服务重跑用）；无则 null */
function cacheFindByName(videoName: string): AudioCacheHit | null {
  let dir: string;
  try { dir = audioCacheDir(); fs.readdirSync(dir); } catch { return null; }
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith(".meta.json"));
  let best: { meta: AudioCacheMeta; opus: string; valid: boolean; exists: boolean } | null = null;
  for (const f of entries) {
    const m = readCacheMeta(f.slice(0, -".meta.json".length));
    if (!m || m.videoName !== videoName) continue;
    const opus = cacheOpusOf(f.slice(0, -".meta.json".length));
    let exists = false;
    let valid = false;
    try {
      const vst = fs.statSync(m.videoPath);
      exists = vst.isFile();
      valid = exists && vst.size === m.videoSize && Math.round(vst.mtimeMs) === m.videoMtimeMs
        && fs.statSync(opus).size > 0;
    } catch { /* 源视频或缓存缺失 */ }
    const rank = valid ? 2 : exists ? 1 : 0;
    if (!best || rank > bestValidRank(best) || (rank === bestValidRank(best) && m.lastUsedAt > best.meta.lastUsedAt)) {
      best = { meta: m, opus, valid, exists };
    }
  }
  if (!best) return null;
  if (best.valid) touchCache(path.basename(best.opus, ".opus"));
  return {
    opusPath: best.opus,
    audioBytes: best.meta.audioBytes,
    videoPath: best.meta.videoPath,
    videoName: best.meta.videoName,
    videoBytes: best.meta.videoSize,
    opusValid: best.valid,
    videoExists: best.exists,
    lastUsedAt: best.meta.lastUsedAt,
  };
}

function bestValidRank(b: { valid: boolean; exists: boolean }): number {
  return b.valid ? 2 : b.exists ? 1 : 0;
}

/** 启动清理：超 7 天条目删除；总量超 20GB 按 lastUsedAt LRU 裁剪 */
function cachePrune(): void {
  try {
    const dir = audioCacheDir();
    const metas: { key: string; meta: AudioCacheMeta; bytes: number }[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".meta.json")) continue;
      const key = f.slice(0, -".meta.json".length);
      const m = readCacheMeta(key);
      if (!m) continue;
      let bytes = 0;
      try { bytes = fs.statSync(cacheOpusOf(key)).size; } catch { /* opus 缺失 */ }
      metas.push({ key, meta: m, bytes });
    }
    const now = Date.now();
    for (const e of metas) {
      const stale = now - Math.max(e.meta.createdAt, e.meta.lastUsedAt) > AUDIO_CACHE_MAX_AGE_MS;
      if (stale) {
        try { fs.rmSync(cacheOpusOf(e.key), { force: true }); fs.rmSync(cacheMetaOf(e.key), { force: true }); } catch { /* 忽略 */ }
      }
    }
    let total = metas.filter((e) => now - Math.max(e.meta.createdAt, e.meta.lastUsedAt) <= AUDIO_CACHE_MAX_AGE_MS)
      .reduce((a, e) => a + e.bytes, 0);
    if (total > AUDIO_CACHE_MAX_BYTES) {
      const survivors = metas
        .filter((e) => now - Math.max(e.meta.createdAt, e.meta.lastUsedAt) <= AUDIO_CACHE_MAX_AGE_MS)
        .sort((a, b) => b.meta.lastUsedAt - a.meta.lastUsedAt);
      for (const e of survivors) {
        if (total <= AUDIO_CACHE_MAX_BYTES) break;
        total -= e.bytes;
        try { fs.rmSync(cacheOpusOf(e.key), { force: true }); fs.rmSync(cacheMetaOf(e.key), { force: true }); } catch { /* 忽略 */ }
      }
    }
  } catch (e) {
    console.warn("[audio-cache] 清理失败（忽略）:", (e as Error).message);
  }
}

type ExtractResult = { ok: true; opusPath: string; sizeBytes: number; cached?: boolean } | { ok: false; error: string };

function runExtract(args: { videoPath?: string; data?: Uint8Array }, onFrac: (f: number) => void): Promise<ExtractResult> {
  // 音轨缓存命中：源视频未变（size/mtime）→ 免重提，直接复用
  if (args.videoPath) {
    try {
      const st = fs.statSync(args.videoPath);
      const hit = cacheGetExact(args.videoPath, st.size, st.mtimeMs);
      if (hit) {
        onFrac(1);
        return Promise.resolve({ ok: true, opusPath: hit, sizeBytes: fs.statSync(hit).size, cached: true });
      }
    } catch { /* stat 失败走提取流程 */ }
  }
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
          let finalPath = outPath;
          let cached = false;
          if (src && args.videoPath) {
            // 源视频仍在 → 落音轨缓存（换服务重跑/二次派发免重提）；
            // 仅 videoPath 通道：data 通道的 src 是 tmp/in.bin（一次性文件），落缓存会产生 videoName=in.bin 的垃圾条目
            try {
              const vst = fs.statSync(src);
              finalPath = cacheStore(src, vst.size, vst.mtimeMs, outPath);
              cached = path.dirname(finalPath) === audioCacheDir();
              if (cached) fs.rmSync(tmp, { recursive: true, force: true }); // opus 已 rename 进缓存，tmp 已空 → 清掉不留 /tmp 残留
            } catch { /* 源已删 → 保持 tmp 原行为 */ }
          }
          finish({ ok: true, opusPath: finalPath, sizeBytes: size, cached });
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
// 本地磁盘递归枚举（「选择文件夹」与「文件夹监控」共用）
//   VIDEO_EXTS 过滤、size>0、上限 5000、名称排序、rel 含根目录名（与 web webkitRelativePath 同构）；
//   dirNames 顺带收集每个目录的小写文件名集合（「同 stem 已有字幕」判定用，与 setFolder 规则一致）
// ---------------------------------------------------------------------------

interface WalkedVideo {
  path: string; name: string; size: number; rel: string;
  // 字幕/过小判定（按「客户端设置 · 扫描规则」；与 web 渲染层 folderVideoMeta 同口径）
  sub_status: "external" | "named" | "none";
  sub_name: string | null;
  sub_token: string | null;
  no_sub_token: string | null;
  too_small: boolean;
}

function walkVideos(
  root: string,
  options?: Partial<DesktopScanOptions>,
  dirNames?: Map<string, Set<string>>,
): WalkedVideo[] {
  // 选项默认吃本机 client config（「客户端设置 · 扫描规则」）；未传=全默认
  const opts = safeScanOptions(undefined, options ?? clientScanCfg());
  const rules: FolderScanRules = {
    video_exts: opts.video_exts,
    subtitle_patterns: opts.subtitle_patterns,
    min_size_mb: opts.min_size_mb,
    has_sub_tokens: opts.has_sub_tokens,
    no_sub_tokens: opts.no_sub_tokens,
  };
  const names = dirNames ?? new Map<string, Set<string>>();
  const videos: WalkedVideo[] = [];
  walkTree(root, path.basename(root), videos, names, rules);
  // 第二遍：每视频按同目录文件名集判定字幕（walk 完成后各目录集合已齐全）
  for (const v of videos) {
    const meta = folderVideoMeta(v.name, v.size, names.get(path.dirname(v.path)) ?? new Set(), rules);
    v.sub_status = meta.sub_status;
    v.sub_name = meta.sub_name;
    v.sub_token = meta.sub_token;
    v.no_sub_token = meta.no_sub_token;
    v.too_small = meta.too_small;
  }
  return videos;
}

function walkTree(
  dir: string, rel: string, videos: WalkedVideo[], dirNames: Map<string, Set<string>>, rules: FolderScanRules,
): void {
  if (videos.length >= 5000) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 不可读目录：跳过
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const names = new Set<string>();
  dirNames.set(dir, names);
  for (const e of entries) {
    if (videos.length >= 5000) return;
    names.add(e.name.toLowerCase());
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkTree(full, rel + "/" + e.name, videos, dirNames, rules);
    } else if (e.isFile()) {
      if (!folderIsVideo(e.name, rules)) continue;
      try {
        const size = fs.statSync(full).size;
        if (size <= 0) continue;
        videos.push({
          path: full, name: e.name, size, rel: rel + "/" + e.name,
          sub_status: "none", sub_name: null, sub_token: null, no_sub_token: null, too_small: false,
        });
      } catch {
        /* 权限怪癖 / 扫描中途消失：跳过 */
      }
    }
  }
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
  // 窗控（frameless 自定义标题栏）：send 语义，fire-and-forget
  ipcMain.on("win-min", () => win?.minimize());
  ipcMain.on("win-max", () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on("win-close", () => win?.close());
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
          return { ok: true, data: publicEngines(s) };
        }
        case "openedExternal": {
          // e2e：读 setWindowOpenHandler 实际交给系统浏览器的 URL（需 env JAVSCRIBE_OPEN_EXTERNAL_CAPTURE=1）
          if (process.env.JAVSCRIBE_OPEN_EXTERNAL_CAPTURE !== "1") {
            return { ok: false, error: "capture 未启用（JAVSCRIBE_OPEN_EXTERNAL_CAPTURE=1）" };
          }
          return { ok: true, data: openedExternalUrls.slice() };
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
        case "setEngineEnabled": {
          const e = store.setEnabled(String(a0 || ""), a1 === "true");
          if (!e) return { ok: false, error: "服务不存在" };
          return { ok: true };
        }
        case "refreshEngines": {
          // 手动重探测所有服务在线状态/版本/运行任务数：绕过 3s TTL 单飞快照
          const s = await refresh(true);
          return { ok: true, data: publicEngines(s) };
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
        case "cancelJob": {
          const entry = engineByName(String(a0));
          const r = await httpJson<any>(
            entry.url + "/jobs/" + encodeURIComponent(String(a1)) + "/cancel",
            { method: "POST", body: "", timeoutMs: 15000 },
          );
          if (r.status === 200) return { ok: true, data: { status: String((r.data as { status?: string })?.status || "canceled") } };
          if (r.status === 404) return { ok: false, error: "任务不存在（已过期）" };
          if (r.status === 409) return { ok: false, error: "任务已结束，无需取消" };
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
        case "getClientConfig": {
          return { ok: true, data: clientCfgLoad() };
        }
        case "putClientConfig": {
          // renderer 侧 call("putClientConfig", JSON.stringify(cfg))：payload 在第一个位置参数 a0
          let cfg: unknown;
          try {
            cfg = JSON.parse(String(a0 || "{}"));
          } catch {
            return { ok: false, error: "客户端配置格式错误" };
          }
          const c = (cfg && typeof cfg === "object" ? cfg : {}) as Record<string, unknown>;
          const checkInt = (v: unknown, k: string, [lo, hi]: [number, number]):
            { ok: true; v: number } | { ok: false; error: string } => {
            if (typeof v === "boolean" || typeof v !== "number" || !Number.isInteger(v)) {
              return { ok: false, error: `${k} 需要整数` };
            }
            if (v < lo || v > hi) return { ok: false, error: `${k} 需在 ${lo} ~ ${hi} 之间` };
            return { ok: true, v };
          };
          // 部分合并：只校验出现的键（并发卡只发 ew/qc；扫描规则卡只发 scan_*），缺键保留现值
          const next: ClientCfgFile = { ...clientCfgLoad() };
          const normList = (v: unknown): string[] | null => {
            let arr: unknown = v;
            if (typeof arr === "string") arr = arr.split(",");
            if (!Array.isArray(arr) || arr.length > 200 || !arr.every((x) => typeof x === "string")) return null;
            return [...new Set(arr.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
          };
          if (c.extract_workers !== undefined) {
            const r = checkInt(c.extract_workers, "extract_workers", CLIENT_CFG_LIMITS.extract_workers);
            if (!r.ok) return { ok: false, error: r.error };
            next.extract_workers = r.v;
          }
          if (c.queue_cap !== undefined) {
            const r = checkInt(c.queue_cap, "queue_cap", CLIENT_CFG_LIMITS.queue_cap);
            if (!r.ok) return { ok: false, error: r.error };
            next.queue_cap = r.v;
          }
          if (c.scan_video_exts !== undefined) {
            const v = normList(c.scan_video_exts);
            if (v === null || v.length === 0 || !v.every((x) => /^[a-z0-9]{1,8}$/.test(x))) {
              return { ok: false, error: "scan_video_exts 需要 1~8 位字母数字扩展名（逗号分隔可）" };
            }
            next.scan_video_exts = v;
          }
          if (c.scan_subtitle_patterns !== undefined) {
            const v = normList(c.scan_subtitle_patterns);
            if (v === null || v.length === 0 || !v.every((x) => /^\.[a-z0-9]{1,16}(\.[a-z0-9]{1,8})?$/.test(x))) {
              return { ok: false, error: "scan_subtitle_patterns 需要 .srt / .zh.srt 形态（逗号分隔可）" };
            }
            next.scan_subtitle_patterns = v;
          }
          if (c.scan_has_sub_tokens !== undefined) {
            const v = normList(c.scan_has_sub_tokens);
            if (v === null || !v.every((x) => _SCAN_TOKEN_RE.test(x))) {
              return { ok: false, error: "scan_has_sub_tokens 需要 1~16 位字母数字标记（逗号分隔可，空=关）" };
            }
            next.scan_has_sub_tokens = v;
          }
          if (c.scan_no_sub_tokens !== undefined) {
            const v = normList(c.scan_no_sub_tokens);
            if (v === null || !v.every((x) => _SCAN_TOKEN_RE.test(x))) {
              return { ok: false, error: "scan_no_sub_tokens 需要 1~16 位字母数字标记（逗号分隔可，空=关）" };
            }
            next.scan_no_sub_tokens = v;
          }
          if (c.scan_recurse !== undefined) {
            if (typeof c.scan_recurse !== "boolean") return { ok: false, error: "scan_recurse 需要布尔值" };
            next.scan_recurse = c.scan_recurse;
          }
          if (c.scan_min_size_mb !== undefined) {
            const v = c.scan_min_size_mb;
            if (typeof v === "boolean" || typeof v !== "number" || !Number.isFinite(v) || v < 0) {
              return { ok: false, error: "scan_min_size_mb 需要 >=0 的有限数字" };
            }
            next.scan_min_size_mb = v;
          }
          clientCfgSave(next);
          return { ok: true };
        }
        case "getReadiness": {
          // 组件就绪自检（serve 0.2.6+）：错误不外抛，包装成 payload 让 UI 降级展示
          let entry;
          try {
            entry = engineByName(String(a0));
          } catch {
            return { ok: true, data: { ok: false, error: "unsupported" } };
          }
          try {
            const r = await httpJson<any>(entry.url + "/ready", { timeoutMs: 15000 });
            if (r.status === 200) return { ok: true, data: { ok: true, ready: r.data } };
            if (r.status === 404) return { ok: true, data: { ok: false, error: "unsupported" } };
            return { ok: true, data: { ok: false, error: `服务返回 HTTP ${r.status}` } };
          } catch {
            return { ok: true, data: { ok: false, error: "unreachable" } };
          }
        }
        case "engineMetrics": {
          // 监控快照（serve 0.2.4+ /metrics/json；后台 LiveSampler 读取，成本可忽略）：
          // 错误不外抛，包装成 payload 让 UI 降级展示（与工作台 /api/engines/{name}/metrics 同构）
          let entry;
          try {
            entry = engineByName(String(a0));
          } catch {
            return { ok: true, data: { ok: false, error: "unsupported" } };
          }
          try {
            const r = await httpJson<any>(entry.url + "/metrics/json", { timeoutMs: 15000 });
            if (r.status === 200) return { ok: true, data: { ok: true, metrics: r.data } };
            if (r.status === 404) return { ok: true, data: { ok: false, error: "unsupported" } };
            return { ok: true, data: { ok: false, error: `服务返回 HTTP ${r.status}` } };
          } catch {
            return { ok: true, data: { ok: false, error: "unreachable" } };
          }
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
        case "startScanTask": {
          const requested: unknown = (() => { try { return JSON.parse(String(a2 || "{}")); } catch { return {}; } })();
          const id = crypto.randomUUID();
          const rawPath = String(a1 || "").trim();
          const task: DesktopScanRecord = {
            id, engine: String(a0 || ""), path: rawPath ? path.resolve(rawPath) : rawPath,
            resolved_path: null, mapped: false, status: "queued", scanned: 0, found: 0,
            result: null, error: null, created: Date.now(), updated: Date.now(), finished: null,
            options: safeScanOptions(requested, clientScanCfg()), pauseRequested: false, cancelRequested: false,
          };
          try {
            if (!task.path || !fs.statSync(task.path).isDirectory()) {
              task.status = "error"; task.error = "路径不存在或不是目录"; task.finished = Date.now();
            }
          } catch {
            task.status = "error"; task.error = "路径不存在或不是目录"; task.finished = Date.now();
          }
          desktopScanTasks.set(id, task);
          persistDesktopScanTasksNow();
          if (task.status === "queued") startDesktopScan(task);
          return { ok: true, data: desktopScanPublic(task) };
        }
        case "listScanTasks": {
          return { ok: true, data: [...desktopScanTasks.values()]
            .sort((a, b) => (b.created || 0) - (a.created || 0)).map(desktopScanPublic) };
        }
        case "getScanTask": {
          const task = desktopScanTasks.get(String(a0 || ""));
          if (!task) return { ok: false, error: "扫描任务不存在" };
          return { ok: true, data: desktopScanPublic(task) };
        }
        case "pauseScanTask": {
          const task = desktopScanTasks.get(String(a0 || ""));
          if (!task) return { ok: false, error: "扫描任务不存在" };
          if (["queued", "running"].includes(task.status)) {
            task.pauseRequested = true; task.status = "paused"; task.updated = Date.now();
            persistDesktopScanTasksNow();
          }
          return { ok: true, data: desktopScanPublic(task) };
        }
        case "resumeScanTask": {
          const task = desktopScanTasks.get(String(a0 || ""));
          if (!task) return { ok: false, error: "扫描任务不存在" };
          if (task.status === "paused") {
            task.pauseRequested = false; task.cancelRequested = false; task.status = "running"; task.updated = Date.now();
            persistDesktopScanTasksNow();
            if (!desktopScanWorkers.has(task.id)) startDesktopScan(task);
          }
          return { ok: true, data: desktopScanPublic(task) };
        }
        case "cancelScanTask": {
          const task = desktopScanTasks.get(String(a0 || ""));
          if (!task) return { ok: false, error: "扫描任务不存在" };
          if (["queued", "running", "paused"].includes(task.status)) {
            task.cancelRequested = true; task.pauseRequested = false; task.status = "canceled";
            task.finished = Date.now(); task.updated = Date.now(); persistDesktopScanTasksNow();
          }
          return { ok: true, data: desktopScanPublic(task) };
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
          // batch 参数（JSON 串；空串=单文件/旧客户端 → 行为不变）
          let batch: { id: string; label?: string } | null = null;
          if (a2) {
            try {
              const p = JSON.parse(String(a2)) as { id?: unknown; label?: unknown };
              if (p && typeof p.id === "string" && p.id) {
                batch = { id: p.id, label: typeof p.label === "string" ? p.label : "" };
              }
            } catch { /* 畸形 batch 参数按无 batch 处理，不阻断提交 */ }
          }
          const payload = JSON.stringify({
            files,
            ...(batch ? { batch_id: batch.id, batch_label: batch.label || "" } : {}),
          });
          // body 预检：serve 0.2.8+ /scan/submit 上限 16MB，超了明确报错引导分批
          //（不发请求：超限会被服务端先拒体后关连接，报成「服务不可达」更费解）
          if (Buffer.byteLength(payload, "utf-8") > 15 * 1024 * 1024) {
            return { ok: false, error: "所选文件过多（路径列表超过 15MB），超出服务端单次提交上限：请取消部分勾选后分批提交" };
          }
          const r = await httpJson<any>(entry.url + "/scan/submit", {
            method: "POST",
            headers,
            body: payload,
            timeoutMs: 30000,
          });
          if (r.status !== 201) {
            const bodyErr = (r.data as { error?: unknown })?.error;
            if (r.status === 400 && typeof bodyErr === "string" && bodyErr.startsWith("bad body size")) {
              // 按服务端上报上限分流：≥16MB = 0.2.8+ 新服务端（确实文件过多）；
              // 1MB = 旧服务端 ≤0.2.7（提示升级或分批）
              const capMatch = /max (\d+)KB/.exec(bodyErr);
              const capKb = capMatch ? Number(capMatch[1]) : 0;
              if (capKb >= 16384) {
                return { ok: false, error: "所选文件过多：路径列表超过服务端单次提交上限（16MB），请取消部分勾选后分批提交" };
              }
              return { ok: false, error: "所选文件过多，超出该服务单次提交上限（1MB）：请升级服务端到 0.2.8+，或取消部分勾选后分批提交" };
            }
            const err = configError(r.status, r.data);
            // 400「文件不存在」= 服务读不到本机路径（远程服务场景）：结构化上抛，
            // 渲染层据此自动回退本机提取+上传
            if (r.status === 400 && typeof bodyErr === "string" && bodyErr.startsWith("文件不存在")) {
              (err as Error & { code?: string }).code = "not-found";
            }
            throw err;
          }
          const d = r.data as { job_id?: string; files?: number };
          if (batch && d?.job_id) batchUpsert(batch.id, batch.label || "", entry.name, String(d.job_id));
          return { ok: true, data: { files: Number(d?.files || 0), jobId: String(d?.job_id || "") } };
        }
        // 主任务（batch）操作：fan-out 所有已登记服务（serve 只按 batch_id 记暂停态；
        // 旧版 serve 无此端点 → 404 → 该引擎 unsupported，不 throw 不阻塞整体）
        case "batchOp": {
          const action = String(a0 || "");
          const bid = String(a1 || "");
          if (!["pause", "resume", "cancel"].includes(action) || !bid) {
            return { ok: false, error: "batchOp 参数错误（action/batch_id）" };
          }
          return { ok: true, data: await batchOpAll(action, bid) };
        }
        // 主任务记录列表（batches.json，created 降序）
        case "listBatches": {
          const recs = Object.keys(batches)
            .map((id) => {
              const r = batches[id];
              return {
                batch_id: id,
                label: r.label || id,
                created: r.created ?? null,
                finished: r.finished ?? null,
                services: r.services || {},
              };
            })
            .sort((a, b) => (b.created || 0) - (a.created || 0));
          return { ok: true, data: recs };
        }
        default:
          return { ok: false, error: "unknown method: " + args?.method };
      }
    } catch (e) {
      const err = e as Error & { network?: boolean; code?: string };
      return {
        ok: false, error: err.message || String(e), network: !!err.network,
        ...(err.code ? { code: err.code } : {}),
      };
    }
  });

  // 本地提音轨：videoPath（本机文件）或 data（无路径的 File 字节，e2e setInputFiles 场景）
  ipcMain.handle("extract-audio", (_ev, args: { videoPath?: string; data?: Uint8Array }) => {
    return runExtract(args || {}, (frac) => sendToWin("extract-progress", { frac }));
  });

  // 音轨缓存查找（任务表「换服务重跑」按影片文件名查最近条目）
  ipcMain.handle("audio-cache-find", (_ev, videoName: string) => {
    try {
      return cacheFindByName(String(videoName || ""));
    } catch (e) {
      console.warn("[audio-cache] find 失败:", (e as Error).message);
      return null;
    }
  });

  // 音频上传（opus 字节流 → serve /upload?ext=opus，无 key）
  ipcMain.handle("upload-audio", async (_ev, args: { id: string; engine: string; name: string; opusPath?: string; data?: Uint8Array; batchId?: string; batchLabel?: string }) => {
    let opusDir: string | null = null;
    try {
      const entry = engineByName(String(args.engine || ""));
      const batch = args.batchId
        ? { id: args.batchId, label: args.batchLabel || "" }
        : null;
      let body: Buffer | NodeJS.ReadableStream;
      let totalBytes: number;
      let sha1 = "";
      if (args.opusPath) {
        opusDir = path.dirname(args.opusPath);
        totalBytes = fs.statSync(args.opusPath).size;
        if (totalBytes <= 0) return { ok: false, error: "音频文件为空" };
        body = fs.createReadStream(args.opusPath, { highWaterMark: 1024 * 1024 });
        sha1 = await sha1File(args.opusPath);
      } else if (args.data) {
        const buf = Buffer.from(args.data);
        body = buf;
        totalBytes = buf.length;
        if (!totalBytes) return { ok: false, error: "音频文件为空" };
        sha1 = sha1Hex(buf);
      } else {
        return { ok: false, error: "缺少音频载荷" };
      }
      // 先问后传：服务端命中同内容缓存 → 免传字节直接建任务（batch 随 /upload/submit 透传）
      const hit = await tryServerCache(
        entry.url, sha1, totalBytes, "opus", String(args.name || "remote"),
        (loaded, total) => sendToWin("t-progress", { id: args.id, loaded, total }),
        batch,
      );
      if (hit) {
        if (!Buffer.isBuffer(body)) (body as unknown as { destroy?: () => void }).destroy?.(); // 命中免传，释放未读的文件流
        if (hit.job_id && batch) batchUpsert(batch.id, batch.label || "", entry.name, hit.job_id);
        return hit;
      }
      const batchQ = batch
        ? `&batch_id=${encodeURIComponent(batch.id)}&batch_label=${encodeURIComponent(batch.label || "")}`
        : "";
      const r = await httpPutBytes(
        entry.url + `/upload?ext=opus&sha1=${sha1}` + batchQ,
        totalBytes,
        body,
        { "X-Source-Name": encodeURIComponent(String(args.name || "remote")) },
        (loaded, total) => sendToWin("t-progress", { id: args.id, loaded, total }),
      );
      const res = uploadAccept(r.status, r.data);
      if (batch && res.ok && res.job_id) batchUpsert(batch.id, batch.label || "", entry.name, res.job_id);
      return res;
    } catch (e) {
      const err = e as Error & { network?: boolean };
      return { ok: false, error: err.message || String(e), network: !!err.network };
    } finally {
      // 只清理应用自建 mkdtemp 目录（data 通道音轨的临时落点）；
      // 用户指定路径（影片目录等）永不删除——历史 bug 曾把 opus 源目录整目录递归删掉，误删用户文件
      if (opusDir && isOwnTempDir(opusDir)) {
        try {
          fs.rmSync(opusDir, { recursive: true, force: true });
        } catch {
          /* 临时目录清理失败可忽略 */
        }
      }
    }
  });

  // 整片直传（用户显式选「整片直传字幕服务」时的逃生通道；受服务端 MAX_UPLOAD_MB 限制）
  ipcMain.handle("upload-file", async (_ev, args: { id: string; engine: string; name: string; ext: string; localPath?: string; data?: Uint8Array; batchId?: string; batchLabel?: string }) => {
    let tmpDir: string | null = null;
    try {
      const entry = engineByName(String(args.engine || ""));
      const batch = args.batchId
        ? { id: args.batchId, label: args.batchLabel || "" }
        : null;
      let filePath = args.localPath;
      if (!filePath) {
        if (!args.data || !args.data.length) return { ok: false, error: "空文件" };
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "javscribe-client-up-"));
        filePath = path.join(tmpDir, path.basename(String(args.name || "file")));
        fs.writeFileSync(filePath, args.data);
      }
      const totalBytes = fs.statSync(filePath).size;
      if (totalBytes <= 0) return { ok: false, error: "空文件" };
      const ext = String(args.ext || "mp4");
      const sha1 = await sha1File(filePath);
      // 先问后传：服务端命中同内容缓存 → 免传字节直接建任务（batch 随 /upload/submit 透传）
      const hit = await tryServerCache(
        entry.url, sha1, totalBytes, ext, String(args.name || "remote"),
        (loaded, total) => sendToWin("t-progress", { id: args.id, loaded, total }),
        batch,
      );
      if (hit) {
        if (hit.job_id && batch) batchUpsert(batch.id, batch.label || "", entry.name, hit.job_id);
        return hit;
      }
      const batchQ = batch
        ? `&batch_id=${encodeURIComponent(batch.id)}&batch_label=${encodeURIComponent(batch.label || "")}`
        : "";
      const r = await httpPutBytes(
        entry.url + `/upload?ext=${encodeURIComponent(ext)}&sha1=${sha1}` + batchQ,
        totalBytes,
        fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 }),
        { "X-Source-Name": encodeURIComponent(String(args.name || "remote")) },
        (loaded, total) => sendToWin("t-progress", { id: args.id, loaded, total }),
      );
      const res = uploadAccept(r.status, r.data);
      if (batch && res.ok && res.job_id) batchUpsert(batch.id, batch.label || "", entry.name, res.job_id);
      return res;
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
    return walkVideos(r.filePaths[0], safeScanOptions(undefined, clientScanCfg()));
  });

  // 通用目录选择（「扫描目录」浏览按钮；title 可自定义）
  ipcMain.handle("pick-dir", async (_ev, title?: string) => {
    const r = await dialog.showOpenDialog(win as BrowserWindow, {
      title: typeof title === "string" && title ? title : "选择目录",
      properties: ["openDirectory"],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  // 字幕预览（扫描面板「外部 srt」/ 任务表）：只放行字幕扩展名 + ≤2MB 常规文件
  const SRT_PREVIEW_EXTS = new Set([".srt", ".subrip", ".vtt", ".ass", ".ssa"]);
  ipcMain.handle("read-srt", async (_ev, p: unknown) => {
    if (typeof p !== "string" || !p.trim()) return { ok: false, error: "path 必填" };
    const f = path.resolve(p);
    if (!SRT_PREVIEW_EXTS.has(path.extname(f).toLowerCase()))
      return { ok: false, error: "仅可预览 .srt / .vtt / .ass / .ssa 字幕文件" };
    try {
      const st = fs.statSync(f);
      if (!st.isFile()) return { ok: false, error: "文件不存在" };
      if (st.size > 2 * 1048576) return { ok: false, error: "文件超过 2MB，无法预览" };
      const text = fs.readFileSync(f, "utf-8");
      return { ok: true, data: { path: f, name: path.basename(f),
        size_mb: Math.round((st.size / 1048576) * 100) / 100, text } };
    } catch (ex) {
      return { ok: false, error: `无法读取文件: ${ex instanceof Error ? ex.message : String(ex)}` };
    }
  });

  // ---------- 文件夹监控（仅 desktop；renderer 就绪后 watch-arm flush 启动期候选） ----------
  ipcMain.handle("local-serve-state", () => lsState);
  ipcMain.handle("watch-state", () => watchPublicState());
  ipcMain.handle("watch-arm", () => {
    watchArmed = true;
    for (const c of watchCandidateBuf.splice(0)) sendToWin("watch-candidate", c);
    return watchPublicState();
  });
  ipcMain.handle("watch-pick-dir", async () => {
    const r = await dialog.showOpenDialog(win as BrowserWindow, {
      title: "选择监听文件夹",
      properties: ["openDirectory"],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });
  ipcMain.handle("watch-set", (_ev, p: { enabled?: unknown; path?: unknown; pollMs?: unknown }) => {
    const cur = { ...watchSettings };
    if (p && typeof p.path === "string") {
      const d = p.path.trim();
      if (d && !fs.existsSync(d)) return { ok: false, error: "目录不存在或不可访问" };
      if (d && !fs.statSync(d).isDirectory()) return { ok: false, error: "路径不是文件夹" };
      cur.path = d;
    }
    if (p && typeof p.pollMs === "number" && isFinite(p.pollMs)) {
      cur.pollMs = Math.max(WATCH_MIN_POLL_MS, Math.min(WATCH_MAX_POLL_MS, Math.round(p.pollMs)));
    }
    if (p && typeof p.enabled === "boolean") {
      if (p.enabled && !cur.path) return { ok: false, error: "请先选择要监听的文件夹" };
      cur.enabled = p.enabled;
    }
    watchApplySettings(cur);
    return { ok: true, state: watchPublicState() };
  });
  ipcMain.handle("watch-mark-processed", (_ev, p: unknown) => {
    if (typeof p === "string" && p) {
      const i = watchSettings.processed.indexOf(p);
      if (i >= 0) watchSettings.processed.splice(i, 1);
      watchSettings.processed.push(p);
      if (watchSettings.processed.length > WATCH_PROCESSED_CAP) {
        watchSettings.processed.splice(0, watchSettings.processed.length - WATCH_PROCESSED_CAP);
      }
      watchSave();
      watchPushState();
    }
    return { ok: true };
  });
}


// ---------------------------------------------------------------------------
// 版本更新（electron-updater；仅打包形态生效）
//   - feed：
//     ① 默认无钩子无镜像 → 检查前经 GitHub Releases API 动态解析最新稳定 client-v* tag，
//        切 generic 到该 tag 目录（避免 electron-updater 6.x「Atom feed 首条=仓库 latest release」
//        被无 latest.yml 的 serve release 抢占导致 404；v0.2.6 事故根因）。解析失败静默回退
//        app-update.yml 的 github provider（owner/repo 已固化）。
//     ② 设置「镜像源」后切 generic provider：mirror + "https://github.com/JavdBviewed/JavScribe/releases/download/"
//        （generic 按平台取清单：win=latest.yml，linux x64=latest-linux.yml——与 electron-builder 产物一致）
//   - 代理：设置「更新代理」（socks5://127.0.0.1:10808 / http://host:port）→
//        session.defaultSession.setProxy，electron.net 通道（updater 清单/下载 + 本模块 API）全走代理
//   - 测试钩子：JAVSCRIBE_UPDATE_FEED 直接覆盖 feed base（e2e 指向本地 mock-update-feed，
//     存在钩子时跳过 API 动态解析，CI 零外网依赖）；
//     JAVSCRIBE_NO_UPDATE_RELUNCH=1 时「重启安装」只退出不重启（e2e 断言进程退出用）
//   - dev 形态（!app.isPackaged）：upState 恒 disabled，UI 角标恒隐藏（既有桌面基线零变化）
// ---------------------------------------------------------------------------

interface UpState {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error" | "disabled";
  version?: string;
  notes?: string;
  pct?: number;
  error?: string;
}

interface UpSettings {
  update_check: { enabled: boolean; mirror: string; proxy: string };
  ignored_versions: string[];
}

const UP_SETTINGS_FILE = "settings.json";
const UP_AUTO_CHECK_DELAY_MS = 3000;

let upState: UpState = { status: app.isPackaged ? "idle" : "disabled" };
let upIgnored: string[] = [];
let upSettingsPath = "";

function upLoadSettings(): UpSettings {
  const def: UpSettings = { update_check: { enabled: true, mirror: "", proxy: "" }, ignored_versions: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(upSettingsPath, "utf-8")) as Partial<UpSettings>;
    return {
      update_check: {
        enabled: raw.update_check?.enabled !== false,
        mirror: typeof raw.update_check?.mirror === "string" ? raw.update_check.mirror : "",
        proxy: typeof raw.update_check?.proxy === "string" ? raw.update_check.proxy : "",
      },
      ignored_versions: Array.isArray(raw.ignored_versions)
        ? raw.ignored_versions.filter((v): v is string => typeof v === "string")
        : [],
    };
  } catch {
    return def; // 无配置/损坏：默认值起步
  }
}

function upSaveSettings(s: UpSettings): void {
  try {
    fs.mkdirSync(path.dirname(upSettingsPath), { recursive: true });
    fs.writeFileSync(upSettingsPath, JSON.stringify(s, null, 1));
  } catch (e) {
    console.error("[update] 设置写入失败:", (e as Error).message);
  }
}

function upSet(patch: Partial<UpState>): void {
  upState = { ...upState, ...patch };
  sendToWin("update-state", upState);
}

/** feed base：测试钩子 > 镜像源(generic) > 空(app-update.yml 的 github provider) */
function upFeedBase(): string {
  const hook = process.env.JAVSCRIBE_UPDATE_FEED || "";
  if (hook) return hook.replace(/\/+$/, "");
  const mirror = upLoadSettings().update_check.mirror.replace(/\/+$/, "");
  if (mirror) {
    return mirror + "/https://github.com/JavdBviewed/JavScribe/releases/download/";
  }
  return "";
}

/** 应用「更新代理」到 Electron 全局会话：electron.net 通道（updater 清单/下载 + 本模块 API 请求）走该代理。
 *  留空 = direct:// 直连。仅打包形态应用（dev 形态 updater 禁用，避免影响开发网络）。 */
function upApplyProxy(): void {
  if (!app.isPackaged) return;
  try {
    const proxy = upLoadSettings().update_check.proxy.trim();
    if (proxy) session.defaultSession.setProxy({ mode: "fixed_servers", proxyRules: proxy });
    else session.defaultSession.setProxy({ mode: "direct" });
  } catch (e) {
    console.error("[update] 代理应用失败:", (e as Error).message);
  }
}

function upCmpVer(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** GitHub Releases API：最新稳定（非 prerelease）client-v* 版本号；任何失败 reject（调用方静默回退）。
 *  走 Electron net（认会话代理）而非 node https（不走代理，国内直连会挂）。 */
function upLatestClientTag(): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = net.request({ url: "https://api.github.com/repos/JavdBviewed/JavScribe/releases?per_page=30" });
    req.setHeader("Accept", "application/vnd.github+json");
    let buf = "";
    const timer = setTimeout(() => fail(new Error("github-api-timeout(8s)")), 8000);
    function fail(e: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req.abort(); } catch { /* 已 abort */ }
      reject(e);
    }
    req.on("response", (res) => {
      if (res.statusCode !== 200) {
        fail(new Error(`github-api-http-${res.statusCode}`));
        return;
      }
      res.on("data", (d: Buffer) => {
        buf += d.toString("utf-8");
        if (buf.length > 2_000_000) fail(new Error("github-api-response-too-large"));
      });
      res.on("end", () => {
        if (settled) return;
        try {
          const j: unknown = JSON.parse(buf);
          if (!Array.isArray(j)) { fail(new Error("github-api-bad-shape")); return; }
          let best: number[] | null = null;
          let bestVer = "";
          for (const r of j) {
            const o = r as { tag_name?: unknown; prerelease?: unknown };
            if (o?.prerelease === true) continue; // 自动更新只追稳定版
            const tag = typeof o?.tag_name === "string" ? o.tag_name : "";
            const m = /^client-v(\d+(?:\.\d+)*)$/.exec(tag);
            if (!m) continue;
            const nums = m[1].split(".").map(Number);
            if (!best || upCmpVer(nums, best) > 0) { best = nums; bestVer = m[1]; }
          }
          settled = true;
          clearTimeout(timer);
          resolve(bestVer); // 无匹配 = ""（回退现有行为）
        } catch (e) {
          fail(e as Error);
        }
      });
      res.on("error", (e: Error) => fail(e));
    });
    req.on("error", (e: Error) => fail(e));
    req.end();
  });
}

/** checkForUpdates 前确保 feed 正确：
 *  - 测试钩子（JAVSCRIBE_UPDATE_FEED）→ 不动（init 已按钩子设置，e2e 零外网）
 *  - 镜像源 → 切 generic（幂等，保证对话框改完立即生效，无需重启）
 *  - 默认 → 动态解析最新 client-v* tag 切 generic；失败静默回退 app-update.yml github provider */
async function upEnsureFeed(): Promise<void> {
  try {
    const hook = process.env.JAVSCRIBE_UPDATE_FEED || "";
    if (hook) return;
    const mirror = upLoadSettings().update_check.mirror.trim().replace(/\/+$/, "");
    if (mirror) {
      autoUpdater.setFeedURL({ provider: "generic", url: mirror + "/https://github.com/JavdBviewed/JavScribe/releases/download/" });
      return;
    }
    const ver = await upLatestClientTag();
    if (!ver) return; // 解析不到 → 保持 app-update.yml 默认行为
    autoUpdater.setFeedURL({ provider: "generic", url: `https://github.com/JavdBviewed/JavScribe/releases/download/client-v${ver}/` });
  } catch (e) {
    console.error("[update] feed 解析失败，回退默认行为:", (e as Error).message);
  }
}

function upNotesOf(info: { releaseNotes?: unknown }): string {
  const n = info?.releaseNotes;
  if (typeof n === "string") return n;
  if (Array.isArray(n)) {
    return n
      .map((x) => (x && typeof x === "object" ? String((x as { note?: unknown }).note ?? "") : String(x)))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

async function doUpdateCheck(): Promise<void> {
  if (!app.isPackaged) {
    upSet({ status: "disabled" });
    return;
  }
  if (upState.status === "checking") return;
  upSet({ status: "checking" });
  await upEnsureFeed(); // 动态 feed 解析（钩子/镜像/默认三种路径；内部全捕获不抛）
  autoUpdater
    .checkForUpdates()
    .catch((e: Error) => upSet({ status: "error", error: e?.message || String(e) }));
}

function initUpdater(): void {
  upSettingsPath = path.join(app.getPath("userData"), UP_SETTINGS_FILE);
  if (!app.isPackaged) {
    upState = { status: "disabled" };
    return; // dev 形态：不接 electron-updater（无 app-update.yml，避免噪声日志）
  }
  upIgnored = upLoadSettings().ignored_versions;
  upApplyProxy(); // 启动即应用持久化代理（早于 3s 延迟检查）
  const base = upFeedBase();
  if (base) {
    autoUpdater.setFeedURL({ provider: "generic", url: base });
  }
  autoUpdater.autoDownload = false; // 用户点「下载并安装」才下载
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("checking-for-update", () => upSet({ status: "checking" }));
  autoUpdater.on("update-available", (info) => {
    const v = String(info.version || "");
    if (upIgnored.includes(v)) {
      upSet({ status: "idle" }); // 忽略列表命中：静默
      return;
    }
    upSet({ status: "available", version: v, notes: upNotesOf(info) });
  });
  autoUpdater.on("update-not-available", () => upSet({ status: "idle" }));
  autoUpdater.on("download-progress", (p) => upSet({ status: "downloading", pct: p.percent }));
  autoUpdater.on("update-downloaded", (info) =>
    upSet({ status: "downloaded", version: String(info?.version || upState.version || "") }),
  );
  autoUpdater.on("error", (err: Error) => upSet({ status: "error", error: err?.message || String(err) }));
  if (upLoadSettings().update_check.enabled) {
    setTimeout(() => { void doUpdateCheck(); }, UP_AUTO_CHECK_DELAY_MS); // 启动延迟检查：不抢首屏
  } else {
    upSet({ status: "idle" });
  }
}

function buildMenu(): void {
  if (!app.isPackaged) {
    Menu.setApplicationMenu(null); // dev 形态保持无菜单（既有行为）
    return;
  }
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? ([{ role: "appMenu" }] as MenuItemConstructorOptions[]) : []),
    {
      label: "文件",
      submenu: [{ role: "quit" }],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "窗口",
      submenu: isMac
        ? [{ role: "minimize" }, { role: "zoom" }]
        : [{ role: "minimize" }, { role: "close" }],
    },
    {
      label: "帮助",
      submenu: [{ label: "检查更新…", click: () => { void doUpdateCheck(); } }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// 服务端（serve）最新版本检查：服务端无自有界面，新版本提示在客户端 UI 呈现
//   - GitHub Releases API（serve-v* 首个命中 = 最新）；unauth 60/h 限流，TTL 兜底
//   - e2e 覆盖：JAVSCRIBE_UPDATE_GITHUB_BASE / JAVSCRIBE_UPDATE_INTERVAL_S
//   - 静默降级：拉不到返回 null（UI 不出角标）；失败 1h 重试背压，防网络恢复慢时重试风暴
// ---------------------------------------------------------------------------
interface ServeLatest { version: string; url: string; }
let serveLatest: { data: ServeLatest | null; ts: number; fail: boolean } | null = null;
let serveLatestInflight: Promise<ServeLatest | null> | null = null;

function serveLatestIntervalS(): number {
  const n = Number(process.env.JAVSCRIBE_UPDATE_INTERVAL_S || "86400");
  return Number.isFinite(n) && n > 0 ? n : 86400;
}

function fetchServeLatest(): Promise<ServeLatest | null> {
  if (serveLatestInflight) return serveLatestInflight;
  serveLatestInflight = (async () => {
    const base = (process.env.JAVSCRIBE_UPDATE_GITHUB_BASE || "https://api.github.com").replace(/\/+$/, "");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(`${base}/repos/JavdBviewed/JavScribe/releases?per_page=30`, {
        signal: ctrl.signal,
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!r.ok) throw new Error(`releases -> ${r.status}`);
      const rels = (await r.json()) as Array<{ tag_name?: string; html_url?: string }>;
      const hit = rels.find((x) => /^serve-v\d/.test(x.tag_name || ""));
      if (!hit || !hit.tag_name) return null;
      return { version: hit.tag_name.replace(/^serve-v/, ""), url: hit.html_url || "" };
    } catch (_e) {
      return null;
    } finally {
      clearTimeout(timer);
      serveLatestInflight = null;
    }
  })();
  return serveLatestInflight;
}

async function serveLatestNow(): Promise<ServeLatest | null> {
  const now = Date.now();
  // 失败记录短 TTL（最多 1h 重试）；成功记录按配置间隔（默认 24h）
  const ttl = (serveLatest?.fail ? Math.min(serveLatestIntervalS(), 3600) : serveLatestIntervalS()) * 1000;
  if (serveLatest && now - serveLatest.ts < ttl) return serveLatest.data;
  // 缓存未命中/过期：等待在途 fetch 结果（single-flight + 8s 超时，有界）。
  // 不能首轮返回空：渲染端有 6h 节流只问一次——首轮空 = 角标永不出现。
  const d = await fetchServeLatest();
  serveLatest = { data: d, ts: Date.now(), fail: d === null };
  return d;
}

function registerUpdateIpc(): void {
  // 服务端最新版本（渲染端每次 5s 刷新问一次；main 侧 TTL + single-flight 限流，永不抛错）
  ipcMain.handle("serve-update", () => serveLatestNow());
  ipcMain.handle("update-state", () => upState);
  ipcMain.handle("update-check", () => {
    void doUpdateCheck();
    return upState;
  });
  ipcMain.handle("update-download", () => {
    if (upState.status === "available") {
      autoUpdater.downloadUpdate().catch((e: Error) =>
        upSet({ status: "error", error: e?.message || String(e) }),
      );
    }
    return upState;
  });
  ipcMain.handle("update-restart", () => {
    if (upState.status === "downloaded") {
      if (process.env.JAVSCRIBE_NO_UPDATE_RELUNCH === "1") {
        app.quit(); // e2e：只断言退出，不真重启
      } else {
        autoUpdater.quitAndInstall();
      }
    }
    return upState;
  });
  ipcMain.handle("update-ignore", (_ev, version: string) => {
    if (typeof version === "string" && version) {
      upIgnored = [...new Set([...upIgnored, version])];
      const cur = upLoadSettings();
      cur.ignored_versions = upIgnored;
      upSaveSettings(cur);
    }
    upSet({ status: "idle" });
    return upState;
  });
  ipcMain.handle("update-settings-get", () => upLoadSettings().update_check);
  ipcMain.handle("update-settings-put", (_ev, s: { enabled?: unknown; mirror?: unknown; proxy?: unknown }) => {
    const cur = upLoadSettings();
    cur.update_check = {
      enabled: s?.enabled !== false,
      mirror: typeof s?.mirror === "string" ? s.mirror.trim() : "",
      proxy: typeof s?.proxy === "string" ? s.proxy.trim() : "",
    };
    upSaveSettings(cur);
    upApplyProxy(); // 代理立即生效（下一次检查/下载即走新代理；镜像源下次检查经 upEnsureFeed 生效）
    return cur.update_check;
  });
}

// ---------------------------------------------------------------------------
// 客户端设置（仅 desktop 形态）：userData/client-config.json —— 本机工作台并发设置
//   - 与 update 的 settings.json / 文件夹监听的 watch.json 分文件（同一惯例，互不覆盖）
//   - 默认镜像 web 工作台（extract_workers=2 / queue_cap=4）；文件损坏回落默认 + clamp
//   - 桌面管线消费并发值/热重载在 S4 线，本线只做 IPC + 持久化
// ---------------------------------------------------------------------------

interface ClientCfgFile {
  extract_workers: number;
  queue_cap: number;
  // ---- 扫描规则（扁平 scan_* 键，与 web client_config.json 同形；10-08 归位） ----
  scan_video_exts?: string[];
  scan_subtitle_patterns?: string[];
  scan_recurse?: boolean;
  scan_min_size_mb?: number;
  scan_has_sub_tokens?: string[];
  scan_no_sub_tokens?: string[];
}
const CLIENT_CFG_FILE = "client-config.json";
const CLIENT_CFG_DEFAULTS: ClientCfgFile = { extract_workers: 2, queue_cap: 4 };
const CLIENT_CFG_LIMITS: Record<"extract_workers" | "queue_cap", [number, number]> = {
  extract_workers: [1, 8],
  queue_cap: [1, 16],
};
let clientCfgPath = "";

function clientCfgClamp(v: unknown, lo: number, hi: number, dflt: number): number {
  return typeof v === "number" && Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
}

function clientCfgLoad(): ClientCfgFile {
  try {
    const raw = JSON.parse(fs.readFileSync(clientCfgPath, "utf-8")) as Partial<ClientCfgFile>;
    const out: ClientCfgFile = {
      extract_workers: clientCfgClamp(raw.extract_workers, CLIENT_CFG_LIMITS.extract_workers[0], CLIENT_CFG_LIMITS.extract_workers[1], CLIENT_CFG_DEFAULTS.extract_workers),
      queue_cap: clientCfgClamp(raw.queue_cap, CLIENT_CFG_LIMITS.queue_cap[0], CLIENT_CFG_LIMITS.queue_cap[1], CLIENT_CFG_DEFAULTS.queue_cap),
    };
    // 扫描规则 type-guard 透传（脏值丢弃）；值域校验在 putClientConfig 侧
    const strList = (v: unknown): v is string[] =>
      Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === "string");
    if (strList(raw.scan_video_exts)) out.scan_video_exts = raw.scan_video_exts;
    if (strList(raw.scan_subtitle_patterns)) out.scan_subtitle_patterns = raw.scan_subtitle_patterns;
    if (strList(raw.scan_has_sub_tokens)) out.scan_has_sub_tokens = raw.scan_has_sub_tokens;
    if (strList(raw.scan_no_sub_tokens)) out.scan_no_sub_tokens = raw.scan_no_sub_tokens;
    if (typeof raw.scan_recurse === "boolean") out.scan_recurse = raw.scan_recurse;
    if (typeof raw.scan_min_size_mb === "number" && Number.isFinite(raw.scan_min_size_mb) && raw.scan_min_size_mb >= 0) {
      out.scan_min_size_mb = raw.scan_min_size_mb;
    }
    return out;
  } catch {
    return { ...CLIENT_CFG_DEFAULTS }; // 无文件/损坏：默认值起步
  }
}

function clientCfgSave(c: ClientCfgFile): void {
  fs.mkdirSync(path.dirname(clientCfgPath), { recursive: true });
  const tmp = clientCfgPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(c, null, 1));
  fs.renameSync(tmp, clientCfgPath); // 同盘原子替换
}

// ---------------------------------------------------------------------------
// 文件夹监控（仅 desktop 形态）：main 进程轮询检测，候选推 renderer 排队派发
//   - 轮询而非 fs.watch：watch 事件在跨网络盘 / Windows 过滤驱动下不可靠；
//     秒级 stat 遍历对数千文件量级的库足够轻（与引擎侧稳定性取向一致）
//   - 候选条件：视频扩展名 + size>0 + 同目录无同 stem 字幕（LOCAL_SUB_PATTERNS，
//     与「选择文件夹」跳过规则一致）+ (size, mtime) 连续两次轮询不变（防半下载文件）
//     + 不在 processed（跨重启去重，派发成功/失败后由 renderer 标记）
//   - 持久化：watch.json（userData；与 update 的 settings.json 分离，避免双模块互写互删）
//   - renderer 就绪前产生的候选进缓冲，watch-arm 时一次性 flush
// ---------------------------------------------------------------------------

interface WatchSettings { enabled: boolean; path: string; pollMs: number; processed: string[]; }
interface WatchCandidate { path: string; name: string; size: number; }

const WATCH_FILE = "watch.json";
const WATCH_DEFAULT_POLL_MS = 15_000;
/** 最小轮询间隔（e2e 提速钩子：JAVSCRIBE_WATCH_MIN_POLL_MS；UI 不暴露间隔输入） */
const WATCH_MIN_POLL_MS = Number(process.env.JAVSCRIBE_WATCH_MIN_POLL_MS || 5_000);
const WATCH_MAX_POLL_MS = 300_000;
const WATCH_PROCESSED_CAP = 5_000;
const WATCH_CANDIDATE_BUF_CAP = 5_000;

let watchSettings: WatchSettings = { enabled: false, path: "", pollMs: WATCH_DEFAULT_POLL_MS, processed: [] };
let watchStorePath = "";
let watchTimer: NodeJS.Timeout | null = null;
let watchArmed = false;
let watchLastScan: number | null = null;
let watchLastError: string | null = null;
// path -> 上一轮 (size, mtime)：本轮不变 = 稳定，下轮发候选（两次轮询确认）
const watchSeen = new Map<string, { size: number; mtimeMs: number }>();
const watchCandidateBuf: WatchCandidate[] = [];

function watchLoad(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(watchStorePath, "utf-8")) as Partial<WatchSettings>;
    watchSettings = {
      enabled: raw.enabled === true,
      path: typeof raw.path === "string" ? raw.path : "",
      pollMs: typeof raw.pollMs === "number" && isFinite(raw.pollMs)
        ? Math.max(WATCH_MIN_POLL_MS, Math.min(WATCH_MAX_POLL_MS, raw.pollMs))
        : WATCH_DEFAULT_POLL_MS,
      processed: Array.isArray(raw.processed)
        ? raw.processed.filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch {
    /* 无配置 / 损坏：默认值起步 */
  }
}

function watchSave(): void {
  try {
    fs.mkdirSync(path.dirname(watchStorePath), { recursive: true });
    fs.writeFileSync(watchStorePath, JSON.stringify(watchSettings, null, 1));
  } catch (e) {
    console.error("[watch] 设置写入失败:", (e as Error).message);
  }
}

function watchPublicState() {
  return {
    enabled: watchSettings.enabled,
    path: watchSettings.path,
    pollMs: watchSettings.pollMs,
    on: !!watchTimer,
    processed: watchSettings.processed.length,
    lastScan: watchLastScan,
    lastError: watchLastError,
  };
}

function watchPushState(): void {
  sendToWin("watch-state", watchPublicState());
}

function watchEmit(c: WatchCandidate): void {
  if (watchArmed && win && !win.isDestroyed()) {
    sendToWin("watch-candidate", c);
  } else {
    watchCandidateBuf.push(c);
    if (watchCandidateBuf.length > WATCH_CANDIDATE_BUF_CAP) watchCandidateBuf.shift();
  }
}

/** 同 stem 已有字幕（同目录、大小写不敏感；与 LOCAL_SUB_PATTERNS 一致） */
function watchHasSub(dir: string, name: string, dirNames: Map<string, Set<string>>): boolean {
  const names = dirNames.get(dir);
  if (!names) return false;
  const stem = name.replace(/\.[^.]+$/, "").toLowerCase();
  return LOCAL_SUB_PATTERNS.some((pt) => names.has(stem + pt));
}

// ---------------------------------------------------------------------------
// 内嵌字幕探测（watch 候选过滤；语义与服务端 core/subprobe.py 同源，
// 见 client/core/sub-embed.ts）。ffprobe 只读容器头，(path,size,mtime) 缓存；
// 缺失/失败 fail-open（服务端 engine 同判定是权威兜底）。
// 客户端无独立设置面：内置默认 target/zh（与服务端默认一致），serve 侧
// /config 的 skip_embedded/embedded_langs 为权威（偏差已记入任务 implement.md）。
// ---------------------------------------------------------------------------
const EMBED_DEFAULTS = { skip_embedded: "target", lang_tag: "zh", embedded_langs: ["zh"] };
const embedProbeCache = new Map<string, EmbeddedSub[]>();
const EMBED_CACHE_MAX = 256;

function findFfprobe(): string | null {
  const name = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const envDir = process.env.JAVSCRIBE_FFMPEG_DIR;
  if (envDir) {
    const cand = path.join(envDir, name);
    if (fs.existsSync(cand)) return cand;
  }
  const ffmpeg = findFfmpeg();
  if (ffmpeg) {
    const cand = path.join(path.dirname(ffmpeg), name);
    if (fs.existsSync(cand)) return cand;
  }
  for (const p of (process.env.PATH || "").split(path.delimiter)) {
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

function probeEmbeddedSubsCached(
  ff: string, file: string, size: number, mtimeMs: number,
): Promise<EmbeddedSub[]> {
  const key = `${file}|${size}|${mtimeMs}`;
  const hit = embedProbeCache.get(key);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    execFile(
      ff,
      probeArgs(file), // 参数契约见 sub-embed.probeArgs（单测钉死）
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const subs = err ? [] : parseProbeOutput(stdout);
        if (embedProbeCache.size >= EMBED_CACHE_MAX) embedProbeCache.clear();
        embedProbeCache.set(key, subs);
        resolve(subs);
      },
    );
  });
}

/** 内嵌目标语言字幕轨 -> 不派发；ffprobe 缺失/异常 fail-open。 */
async function watchSkipEmbedded(file: string, st: fs.Stats): Promise<boolean> {
  const ff = findFfprobe();
  if (!ff) return false;
  try {
    const subs = await probeEmbeddedSubsCached(ff, file, st.size, st.mtimeMs);
    const r = shouldSkipEmbedded(EMBED_DEFAULTS, subs.map((x) => x.language));
    if (r.skip) console.log(`[watch] 跳过（内嵌字幕）: ${path.basename(file)} ${r.reason}`);
    return r.skip;
  } catch {
    return false;
  }
}

let watchTickInFlight = false;

async function watchTick(): Promise<void> {
  if (watchTickInFlight) return; // ffprobe 探测未结束：跳过本轮，防 tick 重叠
  watchTickInFlight = true;
  try {
    await watchTickInner();
  } finally {
    watchTickInFlight = false;
  }
}

async function watchTickInner(): Promise<void> {
  const root = watchSettings.path;
  if (!root || !fs.existsSync(root)) {
    watchLastError = "监听目录不存在或不可访问";
    watchPushState();
    return;
  }
  try {
    const dirNames = new Map<string, Set<string>>();
    const videos = walkVideos(root, undefined, dirNames); // 监听只需视频列表，字幕判定用不到
    const processed = new Set(watchSettings.processed);
    const nowSeen = new Map<string, { size: number; mtimeMs: number }>();
    for (const v of videos) {
      let st: fs.Stats;
      try {
        st = fs.statSync(v.path);
      } catch {
        continue; // 轮询中途消失（用户删除/移动）：跳过
      }
      nowSeen.set(v.path, { size: st.size, mtimeMs: st.mtimeMs });
      if (processed.has(v.path)) continue;
      if (watchHasSub(path.dirname(v.path), v.name, dirNames)) continue;
      const prev = watchSeen.get(v.path);
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
        watchSeen.delete(v.path); // 连续两次不变 → 稳定，发候选
        if (await watchSkipEmbedded(v.path, st)) continue; // 内嵌目标字幕轨：不派发
        watchEmit({ path: v.path, name: v.name, size: st.size });
      } else {
        watchSeen.set(v.path, { size: st.size, mtimeMs: st.mtimeMs });
      }
    }
    for (const k of [...watchSeen.keys()]) if (!nowSeen.has(k)) watchSeen.delete(k);
    watchLastError = null;
    watchLastScan = Date.now();
  } catch (e) {
    watchLastError = (e as Error).message || String(e);
  }
  watchPushState();
}

function watchStartTimer(): void {
  if (watchTimer) return;
  watchTimer = setInterval(watchTick, watchSettings.pollMs);
  watchTimer.unref?.();
  void watchTick(); // 立即首轮：建立稳定性基线 / 发现存量文件
}

function watchStopTimer(): void {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}

function watchApplySettings(next: WatchSettings): void {
  const pathChanged = next.path !== watchSettings.path;
  watchSettings = next;
  watchSave();
  if (next.enabled && next.path) {
    if (pathChanged) {
      watchSeen.clear();
      watchCandidateBuf.length = 0;
    }
    watchStartTimer();
  } else {
    watchStopTimer();
    watchLastError = null;
  }
  watchPushState();
}

// ---------------------------------------------------------------------------
// 主任务（batch）记录：客户端维度任务组 —— batches.json（userData，与 settings.json/watch.json 分文件）
//   结构 {batch_id: {label, created, finished, services: {engine: [job_id]}}}
//   - 生成：扫描提交 / 文件夹上传派发成功时登记（单文件上传不落记录）；label=扫描目录名/文件夹名
//   - serve 只按 batch_id 记其持有子任务的暂停态；batch 暂停/继续/取消由客户端发起 fan-out（batchOp）
//   - 完成对账：refresh() 快照成功后，记录各 job 均 finished 或已不在在线引擎快照
//     （200 窗过期/serve 重启 → 视为完成，与工作台口径一致）→ finished；离线引擎不判
//   - cap 200：先最旧 finished（按 finished 时间），再最旧 created
// ---------------------------------------------------------------------------

const BATCH_FILE = "batches.json";
const BATCH_CAP = 200;

interface BatchRec {
  label?: string | null;
  created?: number | null;
  finished?: number | null;
  services?: Record<string, string[]>;
}

let batches: Record<string, BatchRec> = {};
let batchesPath = "";

function batchesLoad(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(batchesPath, "utf-8")) as Record<string, unknown>;
    const out: Record<string, BatchRec> = {};
    for (const [bid, v] of Object.entries(raw || {})) {
      if (!bid || typeof v !== "object" || v === null) continue;
      const rec = v as Partial<BatchRec>;
      out[bid] = {
        label: typeof rec.label === "string" ? rec.label : null,
        created: typeof rec.created === "number" && isFinite(rec.created) ? rec.created : null,
        finished: typeof rec.finished === "number" && isFinite(rec.finished) ? rec.finished : null,
        services: rec.services && typeof rec.services === "object"
          ? Object.fromEntries(Object.entries(rec.services).filter(
              (e): e is [string, string[]] => Array.isArray(e[1])))
          : {},
      };
    }
    batches = out;
  } catch {
    /* 无记录 / 损坏：重新起步 */
  }
}

function batchesSave(): void {
  try {
    fs.mkdirSync(path.dirname(batchesPath), { recursive: true });
    fs.writeFileSync(batchesPath, JSON.stringify(batches, null, 1));
  } catch (e) {
    console.error("[batch] 记录写入失败:", (e as Error).message);
  }
}

/** 派发登记：扫描提交成功 / 上传 201 受理 → services[engine] += job_id；label 仅空补 */
function batchUpsert(id: string, label: string, service: string, jobId: string): void {
  if (!id || !jobId) return;
  let rec = batches[id];
  if (!rec) {
    rec = { label: label || null, created: Date.now() / 1000, finished: null, services: {} };
    batches[id] = rec;
  } else if (label && !rec.label) {
    rec.label = label;
  }
  if (service) {
    const arr = rec.services?.[service] || [];
    if (!arr.includes(jobId)) arr.push(jobId);
    if (!rec.services) rec.services = {};
    rec.services[service] = arr;
  }
  batchCap();
  batchesSave();
}

/** cap 200：先最旧 finished（按 finished 时间），再最旧 created（与工作台口径一致） */
function batchCap(): void {
  if (Object.keys(batches).length <= BATCH_CAP) return;
  const ids = Object.keys(batches);
  let over = ids.length - BATCH_CAP;
  const finished = ids
    .filter((id) => batches[id].finished)
    .sort((a, b) => (batches[a].finished || 0) - (batches[b].finished || 0));
  for (const id of finished) {
    if (over <= 0) break;
    delete batches[id];
    over--;
  }
  if (over > 0) {
    const rest = ids
      .filter((id) => batches[id])
      .sort((a, b) => (batches[a].created || 0) - (batches[b].created || 0));
    for (const id of rest) {
      if (over <= 0) break;
      delete batches[id];
      over--;
    }
  }
}

/** 完成对账（refresh() 快照成功后调用）：记录 services 各 job 均 finished 或
 *  不在在线引擎快照（200 窗过期/serve 重启 → 视为完成）→ finished。
 *  离线引擎不判（无法区分过期与离线）；服务侧未登记的记录（上传在途）不判。 */
function batchesReconcile(engines: EngineInfo[]): void {
  if (!batchesPath) return;
  let changed = false;
  for (const id of Object.keys(batches)) {
    const rec = batches[id];
    if (rec.finished) continue;
    const jobs: Array<{ service: string; jobId: string }> = [];
    for (const [svc, list] of Object.entries(rec.services || {})) {
      for (const j of list || []) jobs.push({ service: svc, jobId: j });
    }
    if (!jobs.length) continue;
    let allDone = true;
    for (const { service, jobId } of jobs) {
      const info = engines.find((e) => e.name === service);
      if (!info || !info.online) { allDone = false; break; }
      const d = info._details.find((x) => x && String(x.id) === jobId);
      if (d && d.state !== "finished") { allDone = false; break; }
    }
    if (allDone) {
      rec.finished = Date.now() / 1000;
      changed = true;
    }
  }
  if (changed) {
    batchCap();
    batchesSave();
  }
}

/** batch 操作 fan-out：对全部已登记服务发 /jobs/batch/<id>/<action>。
 *  旧版 serve 404 → 该引擎 unsupported；网络错误 → 逐条 error；不 throw。
 *  local 恒空对象（desktop 无本机管线冻结，UI 容忍）。 */
async function batchOpAll(action: string, bid: string): Promise<unknown> {
  const engines: Array<{ engine: string; ok: boolean; unsupported?: boolean; error?: string }> = [];
  for (const entry of store.all()) {
    const headers: Record<string, string> = {};
    if (entry.api_key) headers["X-Api-Key"] = entry.api_key;
    try {
      const r = await httpJson<any>(
        `${entry.url}/jobs/batch/${encodeURIComponent(bid)}/${action}`,
        { method: "POST", headers, timeoutMs: 5000 },
      );
      if (r.status === 200) engines.push({ engine: entry.name, ok: true });
      else if (r.status === 404) {
        engines.push({ engine: entry.name, ok: false, unsupported: true, error: "服务版本过旧，不支持主任务操作" });
      } else {
        engines.push({ engine: entry.name, ok: false, error: "HTTP " + r.status });
      }
    } catch (e) {
      engines.push({ engine: entry.name, ok: false, error: (e as Error).message || String(e) });
    }
  }
  return { ok: true, batch_id: bid, action, engines, local: {} };
}

// ---------------------------------------------------------------------------
// 本地服务端集成（仅 desktop 形态）：客户端同目录的服务程序自动拉起
//   - 检测：打包态 → exe 同目录找 JavScribeServe.exe (win) / jav-scribe-serve (linux)；
//     dev/测试态 → env JAVSCRIBE_LOCAL_SERVE_CMD 覆盖为可执行文件路径
//   - 端口：env JAVSCRIBE_LOCAL_SERVE_PORT（默认 8300）
//   - 流程：GET /health 探活（1.5s）→ 在线则直接登记；
//     离线则 spawn detached 拉起 → 轮询 /health（~20s 上限）
//   - 引擎登记固定名「本地服务端」：已存在同名条目（用户改过 URL/Key）一律保留
//   - 生命周期：客户端拉起的实例随客户端退出而终止（杀进程树，覆盖 PyInstaller
//     onefile 父子结构）；用户手动启动的实例（启动前已在线）不受影响，重启探活复用
// ---------------------------------------------------------------------------

const LS_ENGINE_NAME = "本地服务端";
const LS_HEALTH_TIMEOUT_MS = 1500;
const LS_START_TIMEOUT_MS = 20_000;
const LS_POLL_MS = 500;
const lsPort = Number(process.env.JAVSCRIBE_LOCAL_SERVE_PORT) > 0
  ? Number(process.env.JAVSCRIBE_LOCAL_SERVE_PORT)
  : 8300;

interface LocalServeState {
  /** 客户端同目录（或 env 覆盖）是否找到服务程序 */
  detected: boolean;
  /** 找到的可执行文件路径（未找到为空串；UI 用于展示） */
  cmd: string;
  port: number;
  url: string;
  /** /health 已就绪 */
  running: boolean;
  /** 正在拉起（spawn 已发出、health 未就绪） */
  starting: boolean;
  error: string | null;
}

let lsState: LocalServeState = {
  detected: false, cmd: "", port: lsPort,
  url: `http://127.0.0.1:${lsPort}`, running: false, starting: false, error: null,
};
let lsEnsuring = false;
let lsChild: ChildProcess | null = null;
let lsSpawnedByUs = false;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 服务程序路径：env 覆盖（e2e/dev）> 打包态 exe 同目录探测 */
function localServeExePath(): string {
  const envCmd = (process.env.JAVSCRIBE_LOCAL_SERVE_CMD || "").trim();
  if (envCmd) return envCmd;
  const exe = process.platform === "win32" ? "JavScribeServe.exe" : "jav-scribe-serve";
  const p = path.join(path.dirname(process.execPath), exe);
  return fs.existsSync(p) ? p : "";
}

async function lsHealth(): Promise<boolean> {
  try {
    const { status, data } = await httpJson<{ ok?: boolean }>(
      `http://127.0.0.1:${lsPort}/health`,
      { timeoutMs: LS_HEALTH_TIMEOUT_MS },
    );
    return status === 200 && (data as { ok?: boolean } | null)?.ok === true;
  } catch {
    return false;
  }
}

function lsPushState(): void {
  sendToWin("local-serve-state", lsState);
}

/** 杀 serve 进程树：win 用 taskkill /T（同 CI 约定）；POSIX 杀整个进程组（detached ⇒ 子为组长，覆盖 PyInstaller 父/子进程） */
function lsKillTree(pid: number, force: boolean): void {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    } catch { /* 已退出 */ }
    return;
  }
  const sig = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, sig);
  } catch {
    try { process.kill(pid, sig); } catch { /* 已退出 */ }
  }
}

function lsSpawn(): void {
  try {
    // serve_launcher 约定：首参是 flag 时自动补 serve 子命令
    const args = ["--port", String(lsPort)];
    let child: ChildProcess;
    if (process.platform === "win32") {
      // 窗口态 exe 无控制台：日志由 serve_launcher 重定向到 ~/.jav_scribe/serve.log
      child = spawn(lsState.cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    } else {
      // 冻结态 exe 自带日志重定向；dev/脚本形态落 userData/local-serve.log
      const log = fs.openSync(path.join(app.getPath("userData"), "local-serve.log"), "a");
      child = spawn(lsState.cmd, args, { detached: true, stdio: ["ignore", log, log] });
      // 父进程必须立刻 close：子进程已 dup 该 fd；留着会占住 libuv 句柄表，主进程事件循环永不排空
      fs.closeSync(log);
    }
    // 注意：子进程会继承父进程 fd3+（e2e 下可能是 Playwright 的 stdio pipe），若其存活期
    // 超过父进程（detached），会一直占住这些 pipe 的写端，父进程 stdio 'close' 永不触发
    // （app.close() 永久挂死）。因此 before-quit 必须同步杀掉本进程树释放 pipe。
    lsChild = child;
    lsSpawnedByUs = true;
    child.on("error", (e) => {
      lsState.error = "启动失败：" + e.message;
      lsPushState();
    });
    child.on("exit", () => {
      if (lsChild === child) lsChild = null;
      if (lsState.running) {
        lsState.running = false;
        lsState.starting = false;
        lsPushState();
      }
    });
    child.unref();
  } catch (e) {
    lsState.error = "启动失败：" + (e as Error).message;
    lsPushState();
  }
}

/** whenReady 时 fire-and-forget：不阻塞窗口创建 */
async function ensureLocalServe(): Promise<void> {
  if (lsEnsuring) return;
  lsEnsuring = true;
  try {
    const cmd = localServeExePath();
    lsState = {
      detected: !!cmd,
      cmd,
      port: lsPort,
      url: `http://127.0.0.1:${lsPort}`,
      running: false,
      starting: false,
      error: null,
    };
    lsPushState();
    if (!cmd) return;
    if (await lsHealth()) {
      // 已有实例在线（用户手动起过 / 上次客户端拉起后仍在跑）：直接复用，
      // 客户端退出时不 kill（lsSpawnedByUs 保持 false）
      lsState.running = true;
    } else {
      lsState.starting = true;
      lsPushState();
      lsSpawn();
      const deadline = Date.now() + LS_START_TIMEOUT_MS;
      for (;;) {
        await sleep(LS_POLL_MS);
        if (await lsHealth()) {
          lsState.running = true;
          break;
        }
        if (Date.now() > deadline) {
          lsState.error = "拉起后 20s 仍未就绪——请查看日志或手动运行服务程序";
          break;
        }
      }
    }
    lsState.starting = false;
    if (lsState.running) store.ensure(LS_ENGINE_NAME, lsState.url);
    lsPushState();
  } finally {
    lsEnsuring = false;
  }
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------

// 测试钩子：已交给系统浏览器的 URL（JAVSCRIBE_OPEN_EXTERNAL_CAPTURE=1 时记录；e2e 经 t-call openedExternal 读）
const openedExternalUrls: string[] = [];

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 1000,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#f2efe9",
    title: "JavScribe Client",
    // frameless：自绘标题栏 + 窗控按钮（JavdBviewed 风格；不再用 Win 默认标题栏/组件）
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "index.html"));
  // 外部链接（target=_blank / window.open）交系统浏览器：frameless 新窗口无窗控，体验差
  // 测试钩子：JAVSCRIBE_OPEN_EXTERNAL_CAPTURE=1 记录实际交出的 URL（e2e 经 t-call openedExternal 读）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      if (process.env.JAVSCRIBE_OPEN_EXTERNAL_CAPTURE === "1") openedExternalUrls.push(url);
      void shell.openExternal(url).catch(() => { /* 无系统浏览器 / 无头环境：静默忽略 */ });
    }
    return { action: "deny" };
  });
  // 最大化状态回推 renderer（标题栏按钮图标切换）
  const pushMaxState = (): void => {
    if (win && !win.isDestroyed()) win.webContents.send("win-max-state", win.isMaximized());
  };
  win.on("maximize", pushMaxState);
  win.on("unmaximize", pushMaxState);
  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(() => {
  if (process.env.JAVSCRIBE_CLIENT_USERDATA) {
    app.setPath("userData", process.env.JAVSCRIBE_CLIENT_USERDATA);
  }
  store = new EngineStore(app.getPath("userData"));
  loadDesktopScanTasks();
  void cachePrune(); // 音轨缓存启动清理（7 天 / 20GB LRU，fire-and-forget）
  buildMenu();
  registerIpc();
  registerUpdateIpc();
  initUpdater();
  clientCfgPath = path.join(app.getPath("userData"), CLIENT_CFG_FILE);
  watchStorePath = path.join(app.getPath("userData"), WATCH_FILE);
  watchLoad();
  batchesPath = path.join(app.getPath("userData"), BATCH_FILE);
  batchesLoad();
  void ensureLocalServe(); // 本地服务端自动集成（fire-and-forget，不阻塞窗口）
  if (watchSettings.enabled && watchSettings.path && fs.existsSync(watchSettings.path)) {
    watchStartTimer(); // 恢复上次会话的监听（renderer 就绪前的候选进缓冲，watch-arm 时 flush）
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

// 客户端拉起的 serve 随客户端退出（杀进程树）；用户手动启动的实例不受影响。
// 必须在 before-quit 同步杀：子进程继承的额外 stdio pipe 只有随其消亡才 EOF，
// 否则 e2e（Playwright）的 app.close() 永不 resolve。
app.on("before-quit", () => {
  if (!lsSpawnedByUs) return;
  const c = lsChild;
  lsChild = null;
  lsSpawnedByUs = false;
  if (!c || c.pid === undefined) return;
  const pid = c.pid;
  lsKillTree(pid, false);
  setTimeout(() => lsKillTree(pid, true), 500).unref(); // 兜底：500ms 未退出则强杀
});
