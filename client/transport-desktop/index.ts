// desktop 形态 transport：renderer → IPC（window.javDesktop）→ main 进程直连字幕服务。
// 与 transport-web 同接口（core/transport.ts），UI 无感：
//   - t-call 方法 1:1 映射 main 的 switch（错误文案在 main 侧已对齐工作台）
//   - 上传走 main 流式 PUT（httpPutBytes），字节进度经 t-progress 事件回推
//   - 上传状态本地自持（UploadStatus Map）：201 受理即 done+job_id
//     （web 形态的 extracting 阶段 = 服务端提取音轨；desktop 本地提取已前置，
//      整片直传的服务端提取进度在任务看板呈现）
//   - 无 _localPath 的合成 File（e2e setInputFiles 场景）走 data 通道读全量字节

import { TransportError, type Transport, type UploadDispatch, type UploadProgress } from "../core/transport";
import type {
  ConfigItem, Engine, Health, JobRow, ScanResult, UpdateInfo, UploadStatus,
} from "../core/types";
import type { JavDesktop, UploadDispatchResult } from "../core/desktop-bridge";

/** preload 实际暴露的窗口对象（JavDesktop + 上传通道） */
export interface DesktopBridge extends JavDesktop {
  upload: {
    audio(args: { id: string; engine: string; name: string; opusPath?: string; data?: Uint8Array }): Promise<UploadDispatchResult>;
    file(args: { id: string; engine: string; name: string; ext: string; localPath?: string; data?: Uint8Array }): Promise<UploadDispatchResult>;
  };
}

const desktop: DesktopBridge = (window as unknown as { javDesktop: DesktopBridge }).javDesktop;

function call<T = unknown>(method: string, ...args: string[]): Promise<T> {
  return desktop.call(method, args).then((r) => {
    if (!r.ok) throw new TransportError(r.error || "未知错误", !!r.network);
    return r.data as T;
  });
}

const toMb = (bytes: number): number => Math.round(bytes / 1048576);
const extOf = (name: string): string => (name.split(".").pop() || "mp4").toLowerCase();

/** 引擎 name→url 缓存（getResultUrl 是同步接口，listEngines 时填充） */
const urlCache = new Map<string, string>();

// ---------- 上传状态本地自持（pollUpload 1s 轮询 getUpload） ----------
const uploads = new Map<string, UploadStatus>();

/** 发起上传：注册状态 + 订阅字节进度，201 受理 → done+job_id */
function dispatchUpload(
  file: File,
  engine: string,
  invoke: (id: string) => Promise<UploadDispatchResult>,
  onProgress: UploadProgress,
  extra?: Partial<UploadStatus>,
): Promise<UploadDispatch> {
  const id = crypto.randomUUID();
  const status: UploadStatus = {
    id,
    engine,
    name: file.name,
    size_mb: toMb(file.size),
    phase: "dispatching",
    progress: 0,
    created: Date.now() / 1000,
    ...extra,
  };
  uploads.set(id, status);
  const off = desktop.onTProgress((p) => {
    if (p.id !== id) return;
    status.progress = p.total ? Math.min(1, p.loaded / p.total) : 0;
    onProgress(p.loaded, p.total, status.progress * 100);
  });
  return invoke(id).then((r) => {
    off();
    if (r.ok) {
      Object.assign(status, {
        phase: "done", progress: 1, finished: Date.now() / 1000, job_id: r.job_id || "",
      });
      return { ok: true as const, uploadId: id, sizeMb: toMb(file.size), cached: r.cached === true };
    }
    Object.assign(status, {
      phase: "error", error: r.error || "上传失败", finished: Date.now() / 1000,
    });
    return { ok: false as const, error: r.error || "上传失败", network: r.network };
  });
}

function localPathOf(f: File): string {
  const lp = (f as File & { _localPath?: string })._localPath;
  if (lp) return lp;
  try { return desktop.filePath(f) || ""; } catch { return ""; }
}

export const desktopTransport: Transport = {
  getHealth: () => call<Health>("getHealth"),

  async listEngines() {
    const list = await call<Engine[]>("listEngines");
    for (const e of list) urlCache.set(e.name, e.url);
    return list;
  },

  addEngine: (name, url, apiKey) => call("addEngine", name, url, apiKey || ""),
  deleteEngine: (name) => call("deleteEngine", name),
  putEngineKey: (name, apiKey) => call("putEngineKey", name, apiKey),
  listJobs: () => call<JobRow[]>("listJobs"),

  // 桌面端更新走 main 进程 electron-updater（window.javDesktop.update.*），
  // 此占位恒 disabled，UI 桌面分支不会调用
  getUpdate: () =>
    Promise.resolve({
      enabled: false, current: "", latest_app: null, latest_client: null,
      has_update: false, commands: { docker: "", source: "" },
      last_error: null, last_checked: null,
    }),

  getResultUrl(engine, jobId) {
    const e = urlCache.get(engine);
    return e ? e + "/jobs/" + encodeURIComponent(jobId) + "/result" : "";
  },

  async getResultData(engine, jobId) {
    const r = await desktop.call("getResultData", [engine, jobId]);
    if (!r.ok || !(r.data instanceof Uint8Array)) return null;
    const u = r.data;
    return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
  },

  retryJob: (engine, jobId) => call<{ jobId: string }>("retryJob", engine, jobId),
  getConfig: (name) => call<ConfigItem[]>("getConfig", name),
  putConfig: (name, values) => call("putConfig", name, JSON.stringify(values)),

  async uploadFile(file, engine, onProgress) {
    const localPath = localPathOf(file);
    return dispatchUpload(file, engine, (id) =>
      localPath
        ? desktop.upload.file({ id, engine, name: file.name, ext: extOf(file.name), localPath })
        : desktop.upload.file({
            id, engine, name: file.name, ext: extOf(file.name),
            data: new Uint8Array(0),
          }),
      onProgress,
    );
  },

  async uploadAudio(file, engine, audio, onProgress) {
    const b = audio as Blob & { _javOpusPath?: string; _javOpusSize?: number };
    const extra: Partial<UploadStatus> = b._javOpusSize != null
      ? { audio_mb: Math.round(b._javOpusSize / 1048576) }
      : {};
    return dispatchUpload(file, engine, async (id) => {
      if (b._javOpusPath) {
        return desktop.upload.audio({ id, engine, name: file.name, opusPath: b._javOpusPath });
      }
      return desktop.upload.audio({
        id, engine, name: file.name,
        data: new Uint8Array(await audio.arrayBuffer()),
      });
    }, onProgress, extra);
  },

  async getUpload(id) {
    const st = uploads.get(id);
    if (!st) throw new TransportError("upload 不存在（已过期或 id 无效）");
    return { ...st };
  },

  scan: (name, p) => call<ScanResult>("scan", name, p),
  submitScan: (name, files) =>
    call<{ files: number; jobId: string }>("submitScan", name, JSON.stringify(files)),
};
