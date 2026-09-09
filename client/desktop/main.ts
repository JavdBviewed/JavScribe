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

import { app, BrowserWindow, Menu, dialog, ipcMain, type MenuItemConstructorOptions } from "electron";
import { autoUpdater } from "electron-updater";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { LOCAL_SUB_PATTERNS, OPUS_EXTRACT_ARGS, VIDEO_EXTS } from "../core/constants";
import type { AudioCacheHit } from "../core/desktop-bridge";
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

interface WalkedVideo { path: string; name: string; size: number; rel: string; }

function walkVideos(root: string, dirNames?: Map<string, Set<string>>): WalkedVideo[] {
  const videos: WalkedVideo[] = [];
  walkTree(root, path.basename(root), videos, dirNames ?? new Map<string, Set<string>>());
  return videos;
}

function walkTree(dir: string, rel: string, videos: WalkedVideo[], dirNames: Map<string, Set<string>>): void {
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
      walkTree(full, rel + "/" + e.name, videos, dirNames);
    } else if (e.isFile()) {
      const m = /\.([a-z0-9]{1,8})$/i.exec(e.name);
      if (!m || !VIDEO_EXTS.includes(m[1].toLowerCase())) continue;
      try {
        const size = fs.statSync(full).size;
        if (size <= 0) continue;
        videos.push({ path: full, name: e.name, size, rel: rel + "/" + e.name });
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
      // 音轨缓存目录内的文件保留（换服务重跑复用）；tmp 文件照旧整目录清理
      if (opusDir && opusDir !== audioCacheDir()) {
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
    return walkVideos(r.filePaths[0]);
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
//   - feed：默认 app-update.yml（三期 CI 产出的 github provider，owner/repo 已固化）；
//     设置「镜像源」后切 generic provider：mirror + "https://github.com/JavdBviewed/JavScribe/releases/download/"
//     （generic 按平台取清单：win=latest.yml，linux x64=latest-linux.yml——与 electron-builder 产物一致）
//   - 测试钩子：JAVSCRIBE_UPDATE_FEED 直接覆盖 feed base（e2e 指向本地 mock-update-feed）；
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
  update_check: { enabled: boolean; mirror: string };
  ignored_versions: string[];
}

const UP_SETTINGS_FILE = "settings.json";
const UP_AUTO_CHECK_DELAY_MS = 3000;

let upState: UpState = { status: app.isPackaged ? "idle" : "disabled" };
let upIgnored: string[] = [];
let upSettingsPath = "";

function upLoadSettings(): UpSettings {
  const def: UpSettings = { update_check: { enabled: true, mirror: "" }, ignored_versions: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(upSettingsPath, "utf-8")) as Partial<UpSettings>;
    return {
      update_check: {
        enabled: raw.update_check?.enabled !== false,
        mirror: typeof raw.update_check?.mirror === "string" ? raw.update_check.mirror : "",
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

function doUpdateCheck(): void {
  if (!app.isPackaged) {
    upSet({ status: "disabled" });
    return;
  }
  if (upState.status === "checking") return;
  upSet({ status: "checking" });
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
    setTimeout(() => doUpdateCheck(), UP_AUTO_CHECK_DELAY_MS); // 启动延迟检查：不抢首屏
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
      submenu: [{ label: "检查更新…", click: () => doUpdateCheck() }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerUpdateIpc(): void {
  ipcMain.handle("update-state", () => upState);
  ipcMain.handle("update-check", () => {
    doUpdateCheck();
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
  ipcMain.handle("update-settings-put", (_ev, s: { enabled?: unknown; mirror?: unknown }) => {
    const cur = upLoadSettings();
    cur.update_check = {
      enabled: s?.enabled !== false,
      mirror: typeof s?.mirror === "string" ? s.mirror.trim() : "",
    };
    upSaveSettings(cur);
    return cur.update_check;
  });
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

function watchTick(): void {
  const root = watchSettings.path;
  if (!root || !fs.existsSync(root)) {
    watchLastError = "监听目录不存在或不可访问";
    watchPushState();
    return;
  }
  try {
    const dirNames = new Map<string, Set<string>>();
    const videos = walkVideos(root, dirNames);
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
  watchTick(); // 立即首轮：建立稳定性基线 / 发现存量文件
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
  void cachePrune(); // 音轨缓存启动清理（7 天 / 20GB LRU，fire-and-forget）
  buildMenu();
  registerIpc();
  registerUpdateIpc();
  initUpdater();
  watchStorePath = path.join(app.getPath("userData"), WATCH_FILE);
  watchLoad();
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
