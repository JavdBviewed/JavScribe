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

/** 本地提音轨结果：ok 时 opus 在 main 侧（命中音轨缓存=缓存目录；未命中=tmp，upload 流式读后清理） */
export type ExtractResult =
  | { ok: true; opusPath: string; sizeBytes: number; cached?: boolean }
  | { ok: false; error: string };

/** 音轨缓存查找结果（main 侧 audio-cache/；videoName 匹配最近条目） */
export interface AudioCacheHit {
  /** opus 缓存文件路径（仅 opusValid 时可直接复用） */
  opusPath: string;
  audioBytes: number;
  videoPath: string;
  videoName: string;
  /** 源视频字节数（重提时 File shim size 用） */
  videoBytes: number;
  /** 源视频仍在且 size/mtime 与缓存一致 → opus 可直接复用 */
  opusValid: boolean;
  /** 源视频文件是否仍在磁盘 */
  videoExists: boolean;
  lastUsedAt: number;
}

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

// ---------- 窗口控制（frameless 自定义标题栏：min/max/close + 最大化状态回推） ----------
export interface WinCtl {
  minimize(): void;
  toggleMax(): void;
  close(): void;
  /** 订阅最大化状态（main 侧 maximize/unmaximize 事件）；返回取消订阅函数 */
  onMaxState(cb: (maximized: boolean) => void): () => void;
}

// ---------- 版本更新（electron-updater，main 进程自持状态机） ----------

export interface UpdateState {
  /** idle=未检查/无新版（chip=「检查更新」）；disabled=dev 形态或未启用 */
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error" | "disabled";
  version?: string;
  notes?: string;
  pct?: number;
  error?: string;
}

export interface UpdateSettings {
  enabled: boolean;
  mirror: string;
}

// ---------- 文件夹监控（仅 desktop 形态；main 进程轮询检测，renderer 排队派发） ----------

export interface WatchState {
  enabled: boolean;
  path: string;
  pollMs: number;
  /** 轮询循环是否实际在跑（enabled 且路径有效） */
  on: boolean;
  processed: number;
  lastScan: number | null;
  lastError: string | null;
}

export interface WatchCandidate {
  path: string;
  name: string;
  size: number;
}

export interface WatchSetResult {
  ok: boolean;
  error?: string;
  state?: WatchState;
}

// ---------- 本地服务端集成（仅 desktop 形态：客户端同目录服务程序自动拉起） ----------

export interface LocalServeState {
  /** 客户端同目录（或 env 覆盖）是否找到服务程序 */
  detected: boolean;
  cmd: string;
  port: number;
  url: string;
  /** /health 已就绪 */
  running: boolean;
  /** 正在拉起（spawn 已发出、health 未就绪） */
  starting: boolean;
  error: string | null;
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
  /** 音轨缓存（按影片文件名查最近条目；无则 null） */
  audioCache: {
    find(videoName: string): Promise<AudioCacheHit | null>;
  };
  /** 订阅上传字节进度；返回取消订阅函数 */
  onTProgress(cb: (p: TProgress) => void): () => void;


  /** 文件夹监控（仅 desktop 形态；preload 恒提供，web 形态无此字段） */
  watch: {
    state(): Promise<WatchState>;
    set(partial: { enabled?: boolean; path?: string; pollMs?: number }): Promise<WatchSetResult>;
    /** 原生目录选择对话框；取消返回 null */
    pickDir(): Promise<string | null>;
    /** renderer 就绪后调用：flush 启动期间缓冲的候选（幂等） */
    arm(): Promise<WatchState>;
    /** 标记某影片已处理（派发成功/失败后调用，跨重启去重） */
    markProcessed(path: string): Promise<void>;
    /** 订阅状态推送；返回取消订阅函数 */
    onState(cb: (s: WatchState) => void): () => void;
    /** 订阅候选事件（新出现且稳定的视频文件）；返回取消订阅函数 */
    onCandidate(cb: (c: WatchCandidate) => void): () => void;
  };

  /** 版本更新（仅打包形态生效；dev 形态 state 恒 disabled） */
  update: {
    state(): Promise<UpdateState>;
    check(): Promise<UpdateState>;
    download(): Promise<UpdateState>;
    restart(): Promise<UpdateState>;
    ignore(version: string): Promise<UpdateState>;
    getSettings(): Promise<UpdateSettings>;
    putSettings(s: UpdateSettings): Promise<UpdateSettings>;
    /** 订阅状态推送；返回取消订阅函数 */
    onState(cb: (s: UpdateState) => void): () => void;
    };

  /** 本地服务端（仅 desktop 形态：自动拉起同目录服务程序并登记「本地服务端」） */
  localServe: {
    state(): Promise<LocalServeState>;
    /** 订阅状态推送；返回取消订阅函数 */
    onState(cb: (s: LocalServeState) => void): () => void;
  };
  /** 窗口控制（frameless 自定义标题栏；web 形态无此字段） */
  win: WinCtl;

}

/** upload-audio / upload-file 受理结果（serve 201 → job_id） */
export interface UploadDispatchResult {
  ok: boolean;
  job_id?: string;
  file?: string;
  error?: string;
  network?: boolean;
}
