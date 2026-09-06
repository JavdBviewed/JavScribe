// preload 暴露给 renderer 的 IPC 桥（window.javDesktop）类型契约。
// preload / transport-desktop / platform-desktop / desktop-entry 共同依赖，
// 仅类型（import type），不进任何运行时 bundle。

/** t-call 统一返回：ok 时 data 有效；!ok 时 error 为可直接展示的文案 */
export interface TCallResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  network?: boolean;
}

/** 上传字节进度（main 进程 httpPutBytes ≥100ms 节流推送） */
export interface TProgress {
  id: string;
  loaded: number;
  total: number;
}

/** 本地提音轨结果：ok 时 opus 在 main 侧 tmp（由 upload 流式读后清理） */
export type ExtractResult =
  | { ok: true; opusPath: string; sizeBytes: number }
  | { ok: false; error: string };

export interface PickFileResult {
  path: string;
  name: string;
  size: number;
}

/** 文件夹枚举项：rel 含根目录名（与 web webkitRelativePath 同构） */
export interface PickFolderItem {
  path: string;
  name: string;
  size: number;
  rel: string;
}

export interface FileOpResult {
  ok: boolean;
  path?: string;
  error?: string;
  network?: boolean;
}

export interface JavDesktop {
  /** 服务请求（直连 serve 协议，语义等价工作台 /api/*） */
  call(method: string, args?: string[]): Promise<TCallResult>;
  pickVideoFile(): Promise<PickFileResult | null>;
  pickVideoFolder(): Promise<PickFolderItem[] | null>;
  writeSrt(videoPath: string, srtName: string, data: Uint8Array): Promise<FileOpResult>;
  /** srt 保存对话框（手动下载 / 自动下载兜底） */
  download(url: string, filename: string): Promise<FileOpResult>;
  /** renderer File 的真实磁盘路径（对话框选中的文件；合成文件返回 ""） */
  filePath(f: File): string;
  extractAudio(
    args: { videoPath?: string; data?: Uint8Array },
    onProgress?: (frac: number) => void,
  ): Promise<ExtractResult>;
  /** 订阅上传字节进度；返回取消订阅函数 */
  onTProgress(cb: (p: TProgress) => void): () => void;
}

/** upload-audio / upload-file 受理结果（serve 201 → job_id） */
export interface UploadDispatchResult {
  ok: boolean;
  job_id?: string;
  file?: string;
  error?: string;
  network?: boolean;
}
