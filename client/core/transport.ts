// transport 抽象：UI 只依赖本接口，不感知请求走哪条链路。
//  - web 形态（transport-web）：fetch/XHR → 工作台 /api/*（FastAPI 聚合器，Key 藏服务端）
//  - desktop 形态（transport-desktop，二期）：main 进程直连服务 + spawn ffmpeg + fs 写回
//
// 错误约定：失败时 throw Error，e.message 为可直接展示给用户的文案
// （服务端 detail 优先，否则 "HTTP <status>" / "网络错误"）；e.network === true 表示网络层失败。

import type {
  ConfigItem, Engine, Health, JobRow, ScanResult, UploadStatus,
} from "./types";

export type UploadProgress = (loadedBytes: number, totalBytes: number, pct: number) => void;

/** 上传（整片/音频）受理结果：202 → ok；非 202 → 错误文案 */
export type UploadDispatch =
  | { ok: true; uploadId: string; sizeMb: number }
  | { ok: false; error: string; network?: boolean };

export class TransportError extends Error {
  network = false;
  constructor(message: string, network = false) {
    super(message);
    this.name = "TransportError";
    this.network = network;
  }
}

export interface Transport {
  /** 工作台健康（版本 + 在线数） */
  getHealth(): Promise<Health>;
  /** 引擎列表（poller 快照） */
  listEngines(): Promise<Engine[]>;
  /** 添加引擎；重名异址等 400 会 throw */
  addEngine(name: string, url: string, apiKey?: string): Promise<void>;
  /** 删除引擎（幂等：不存在不抛） */
  deleteEngine(name: string): Promise<void>;
  /** 登记/更新 API Key */
  putEngineKey(name: string, apiKey: string): Promise<void>;
  /** 任务看板（poller 快照展平行） */
  listJobs(): Promise<JobRow[]>;
  /** srt 下载 URL（供 <a download> / 自动下载） */
  getResultUrl(engine: string, jobId: string): string;
  /** srt 二进制（写回源目录用）；非 2xx 返回 null，由调用方重试 */
  getResultData(engine: string, jobId: string): Promise<ArrayBuffer | null>;
  /** 删旧字幕重新生成；失败 throw(detail) */
  retryJob(engine: string, jobId: string): Promise<{ jobId: string }>;
  /** 服务端设置项；Key 错误/版本过旧等 throw(detail 或 "HTTP <status>") */
  getConfig(name: string): Promise<ConfigItem[]>;
  /** 保存设置；失败 throw(detail 或 "<status>") */
  putConfig(name: string, values: Record<string, unknown>): Promise<void>;
  /** 整片上传（带进度）；受理成功返回 uploadId 进入轮询 */
  uploadFile(file: File, engine: string, onProgress: UploadProgress): Promise<UploadDispatch>;
  /** 音频（opus）上传（带进度） */
  uploadAudio(file: File, engine: string, audio: Blob, onProgress: UploadProgress): Promise<UploadDispatch>;
  /** 上传任务阶段轮询（extracting → dispatching → done/error） */
  getUpload(id: string): Promise<UploadStatus>;
  /** 扫描服务机器目录；失败 throw(detail) */
  scan(name: string, path: string): Promise<ScanResult>;
  /** 扫描结果入队；失败 throw(detail 或 "网络错误") */
  submitScan(name: string, files: string[]): Promise<{ files: number; jobId: string }>;
}
