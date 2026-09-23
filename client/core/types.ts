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
}

/** GET /api/jobs 展平行（running 优先 + created 降序，工作台侧已排好） */
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
  phase: "extracting" | "dispatching" | "done" | "error";
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
