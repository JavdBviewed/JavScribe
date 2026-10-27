// preload 暴露给 renderer 的 IPC 桥（window.javDesktop）类型契约。
// preload / transport-desktop / platform-desktop / desktop-entry 共同依赖，
// 仅类型（import type），不进任何运行时 bundle。

/** t-call 统一返回：ok 时 data 有效；!ok 时 error 为可直接展示的文案 */
import type { ServeRelease } from "./types";
export interface TCallResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  network?: boolean;
  /** 结构化错误码（如 not-found=服务读不到本机路径，渲染层据此回退本机提取+上传） */
  code?: string;
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
  | { ok: false; error: string; /** 主任务取消被 kill（行落「跳过」，非失败） */ cancelled?: boolean };

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

/** 文件夹枚举项：rel 含根目录名（与 web webkitRelativePath 同构）；
 *  字幕/过小判定 main 侧按「客户端设置 · 扫描规则」算好回传（与 web 渲染层同口径） */
export interface PickFolderItem {
  path: string;
  name: string;
  size: number;
  rel: string;
  sub_status: "external" | "named" | "none";
  sub_name: string | null;
  sub_token: string | null;
  no_sub_token: string | null;
  too_small: boolean;
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
  /** 更新代理（socks5://127.0.0.1:10808 / http://host:port；空=直连），main 经 session.setProxy 应用 */
  proxy: string;
}

// ---------- 文件夹监控（仅 desktop 形态；main 进程轮询检测，renderer 排队派发） ----------

export interface WatchState {
  enabled: boolean;
  /** legacy 兼容：paths 首个目录（旧版 UI / 旧 e2e 断言单 path 字段） */
  path: string;
  /** 监听目录（0.2.63 起多目录；空 = 未设置） */
  paths: string[];
  pollMs: number;
  /** 轮询循环是否实际在跑（enabled 且至少一个目录有效） */
  on: boolean;
  processed: number;
  /** 派发失败条数（记 size/mtime 指纹；文件变化后自动重审，天然防无限重试） */
  failed: number;
  lastScan: number | null;
  /** 兼容单值 = errors 首条（per-dir 明细见 errors；扫描异常时与 errors 互斥出现） */
  lastError: string | null;
  /** 逐目录错误（目录不存在/不可访问 → 错误文案；该键无错误即不存在） */
  errors: Record<string, string>;
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

/** 日志中心 tail 结果（0.2.62） */
export interface LogTailResult {
  lines: string[];
  /** 内存环当前总行数（未过滤） */
  total: number;
  /** 环超 limit 或 serve 文件超 2MB 窗口 → 只展示尾部 */
  truncated: boolean;
  /** 内嵌 serve 日志文件路径（无则 null） */
  serveLogPath: string | null;
}

export interface JavDesktop {
  /** 服务请求（直连 serve 协议，语义等价工作台 /api/*） */
  call(method: string, args?: string[]): Promise<TCallResult>;
  pickVideoFile(): Promise<PickFileResult | null>;
  pickVideoFolder(): Promise<PickFolderItem[] | null>;
  /** 通用目录选择对话框（「扫描目录」浏览）；取消返回 null */
  pickDir(title?: string): Promise<string | null>;
  /** 字幕预览读文件（main 侧校验字幕扩展名/≤2MB）；失败 throw */
  readSrt(p: string): Promise<{ path: string; name: string; size_mb: number; text: string }>;
  writeSrt(videoPath: string, srtName: string, data: Uint8Array): Promise<FileOpResult>;
  /** 幂等预检：影片同目录目标 srt 是否已存在（main 侧只读探测，不落盘） */
  srtExists(videoPath: string, srtName: string): Promise<boolean>;
  /** 只读探测文件是否存在（换服务重跑：恢复任务行的本机源视频路径） */
  fileExists(p: string): Promise<boolean>;
  /** srt 保存对话框（手动下载 / 自动下载兜底） */
  download(url: string, filename: string): Promise<FileOpResult>;
  /** renderer File 的真实磁盘路径（对话框选中的文件；合成文件返回 ""） */
  filePath(f: File): string;
  extractAudio(
    args: { videoPath?: string; data?: Uint8Array; id?: string },
    onProgress?: (frac: number) => void,
  ): Promise<ExtractResult>;
  /** 终止在跑本机提取（主任务取消）；ok=false=无匹配任务 */
  extractAudioCancel(id: string): Promise<{ ok: boolean; error?: string }>;
  /** 音轨缓存（按影片文件名查最近条目；无则 null） */
  audioCache: {
    find(videoName: string): Promise<AudioCacheHit | null>;
  };
  /** 最新服务端 Release（服务端无自有界面，新版本提示在客户端 UI）；拉不到返回 null */
  serveUpdate(): Promise<ServeRelease | null>;
  /** 日志中心（0.2.62；仅桌面形态提供，web 形态 window.javDesktop 无此字段） */
  logs: {
    /** 按源/最低级别/关键词取格式化行尾（limit 默认 2000） */
    tail(p?: { source?: "all" | "main" | "ui" | "serve"; level?: "debug" | "info" | "warn" | "error"; q?: string; limit?: number }): Promise<LogTailResult>;
    /** 导出环全量 + serve 文件尾；取消/失败返回 null */
    export(): Promise<string | null>;
    /** 清空内存环（文件历史保留） */
    clear(): Promise<{ ok: boolean }>;
  };
  /** 订阅上传字节进度；返回取消订阅函数 */
  onTProgress(cb: (p: TProgress) => void): () => void;


  /** 文件夹监控（仅 desktop 形态；preload 恒提供，web 形态无此字段） */
  watch: {
    state(): Promise<WatchState>;
    /** path 为 legacy 单目录入参（=paths=[path]）；paths 全量替换，优先 */
    set(partial: { enabled?: boolean; path?: string; paths?: string[]; pollMs?: number }): Promise<WatchSetResult>;
    /** 原生目录选择对话框；取消返回 null */
    pickDir(): Promise<string | null>;
    /** renderer 就绪后调用：flush 启动期间缓冲的候选（幂等） */
    arm(): Promise<WatchState>;
    /** 标记某影片已处理（派发成功后调用，跨重启去重） */
    markProcessed(path: string): Promise<void>;
    /** 标记某影片派发失败（记 size/mtime 指纹；文件变化后 main 自动重审） */
    markFailed(path: string): Promise<void>;
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

/** upload-audio / upload-file 受理结果（serve 201 → job_id；cached=服务端内容缓存命中，免上传） */
export interface UploadDispatchResult {
  ok: boolean;
  job_id?: string;
  file?: string;
  /** 服务端已有同内容缓存（/upload/submit 建任务，未传字节） */
  cached?: boolean;
  error?: string;
  network?: boolean;
}
