// 共享领域类型（web / desktop 两形态共用，字段对齐工作台 /api/* 响应）

/** GET /api/health */
export interface Health {
  ok: boolean;
  app: string;
  version: string;
  engines: number;
  online: number;
}

/** GET /api/engines 单引擎（poller 快照） */
export interface Engine {
  name: string;
  url: string;
  online: boolean;
  has_key?: boolean;
  version?: string | null;
  device?: string | null;
  jobs_running?: number;
  error?: string | null;
  /** 服务队列已挂起（serve 0.2.3+ /health.paused；旧服务无此字段） */
  paused?: boolean;
  /** 参与自动负载均衡（工作台 v0.2.11+；false 时不接收 auto 派发的新任务） */
  enabled?: boolean;
}

/** GET /api/jobs 展平行（running 优先 + created 降序，工作台侧已排好） */
/** 看板统计（/api/jobs/summary）：serve 累计终态计数 + 当前在途数 */
export interface JobSummary {
  running: number;
  done: number;
  skipped: number;
  failed: number;
  /** 本机管线已暂停的行数（工作台 0.2.10+；老工作台无此字段） */
  paused?: number;
  /** 全局暂停开关（本机管线闸 + 各服务队列的目标态） */
  paused_all?: boolean;
  /** 各服务队列实际挂起状态（name -> paused） */
  engines_paused?: Record<string, boolean>;
}

/** 客户端（本机工作台）并发设置：web 工作台 /api/client-config */
export interface ClientConfig {
  /** 音轨提取并发：本机同时跑 ffmpeg 的数量（1..8） */
  extract_workers: number;
  /** 转译并发（服务队列上限）：同时在途任务数，超出本机排队（1..16） */
  queue_cap: number;
  /** 管线全局暂停（工作台持久化，重启不丢；与 /api/pause 联动） */
  pipeline_paused?: boolean;
}

export interface JobRow {
  engine: string;
  job_id?: string | null;
  label?: string;
  file?: string;
  state?: string | null;
  status: string;
  phase?: string | null;
  progress?: number;
  position?: string;
  duration_s?: number | null;
  position_s?: number | null;
  phase_detail?: string | null;
  eta_s?: number | null;
  message?: string;
  created?: number | null;
  finished?: number | null;
  source_kind?: string | null;
  /** 服务任务被单任务挂起（serve 0.2.3+ /jobs 行字段；排队挂起时行 status 仍是 pending） */
  paused?: boolean;
  /** 本机管线任务 id（仅工作台本机行：暂停/继续→重提取重提交用） */
  task_id?: string | null;
  /** 本机视频路径（仅本机扫描/监听行有；浏览器上传任务为 null → 无重试/继续按钮） */
  local_path?: string | null;
  /** 本地扫描任务：提交前检测到的字幕状态（external/embedded/named）——制作图「已有字幕」提示 */
  sub_status?: string | null;
  output_files?: string[];
  /** 本地扫描任务的字幕回写状态（工作台本机回写）：ok / skipped_exists / skipped / failed:… */
  writeback?: string | null;
}

/** GET /api/uploads/{id}：提取→派发 两阶段任务 */
export interface UploadStatus {
  id: string;
  engine: string;
  name: string;
  size_mb: number;
  phase: "extracting" | "dispatching" | "done" | "error" | "paused";
  progress: number;
  created: number;
  finished?: number | null;
  audio_mb?: number | null;
  job_id?: string | null;
  error?: string | null;
  /** 服务端命中内容缓存（免上传；web 链路轮询可见） */
  cached?: boolean | null;
  /** 「扫描目录」任务：视频在本机（工作台部署机）的实际路径 */
  local_path?: string | null;
  /** 提交前检测到的字幕状态（external/embedded/named） */
  sub_status?: string | null;
  /** 本地字幕回写状态：ok / skipped_exists / skipped / failed:… */
  writeback?: string | null;
}

export type ConfigType = "bool" | "enum" | "list" | "int" | "float" | "secret" | "text";

/** 服务端 /config 展平后的单个设置项 */
export interface ConfigItem {
  path: string;
  label: string;
  type: ConfigType;
  value: unknown;
  options?: string[];
  /** 帮助文案（服务端 v0.2.1+ 返回；旧服务端无此字段，前端用本地兜底） */
  hint?: string;
}

/** 目录扫描命中的单个文件 */
export interface ScanItem {
  path: string;
  name: string;
  size: number;
  has_subtitle: boolean;
  subtitle?: string | null;
  /** 字幕四态：external（外部 srt）/ named（文件名 C 版）/ embedded（内嵌轨）/ none */
  subtitle_status?: "external" | "named" | "embedded" | "none";
  /** 内嵌字幕轨语言（归一后，如 ["zh"]） */
  embedded_langs?: string[];
  /** 低于 scan.min_size_mb：列表显示但不默认选中（显式勾选仍可提交） */
  too_small?: boolean;
  /** 内嵌字幕探测失败（ffprobe 异常）：本次未检测到 ≠ 视频没有内嵌字幕，重新扫描会再探测 */
  probe_failed?: boolean;
  /** 文件名含独立 C、语义判为「已压字幕」（naming_c=has_sub） */
  name_sub?: boolean;
  /** 文件名含独立 C、语义设为「无字幕版」（naming_c=no_sub，默认；仅信息标） */
  name_no_sub?: boolean;
}

/** 扫描目录响应（web 形态 GET /api/scan/local?engine=&path=；desktop 为本地 serve /scan） */
export interface ScanResult {
  items: ScanItem[];
  mapped?: boolean;
  path?: string;
  truncated?: boolean;
  /** 生效的 scan.min_size_mb（MB；客户端侧规则） */
  min_size_mb?: number;
  /** 生效的独立 C 语义：has_sub / no_sub / off */
  naming_c?: string;
}

/** GET /api/fs/read-srt：字幕预览内容（只放行字幕扩展名 ≤2MB） */
export interface SrtReadResult {
  path: string;
  name: string;
  size_mb: number;
  text: string;
}

/** 目录浏览条目（web 形态 GET /api/fs/browse） */
export interface FsBrowseEntry {
  name: string;
  is_dir: boolean;
  /** 文件大小 MB（仅文件） */
  size_mb?: number | null;
}

/** GET /api/fs/browse：客户端部署机目录浏览快照 */
export interface FsBrowseResult {
  ok: boolean;
  path: string;
  /** 上级目录；根目录为 "" */
  parent: string;
  home: string;
  entries: FsBrowseEntry[];
  /** 超过 4000 项被截断 */
  truncated?: boolean;
}

/** GitHub Release 条目（/api/update 版本对比用） */
export interface UpdateRelease {
  version: string;
  name: string;
  body: string;
  url: string;
  published_at: string | null;
}

/** GET /api/update：工作台版本对比快照 */
export interface UpdateInfo {
  enabled: boolean;
  /** 当前工作台版本 */
  current: string;
  /** 最新 serve/web 镜像 Release（tag v*） */
  latest_app: UpdateRelease | null;
  /** 最新桌面端 Release（tag client-v*） */
  latest_client: UpdateRelease | null;
  /** 工作台或任一已登记服务落后于最新镜像 */
  has_update: boolean;
  /** 一键复制的更新命令（两种部署形态） */
  commands: { docker: string; source: string };
  last_error: string | null;
  last_checked: number | null;
}
