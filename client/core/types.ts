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
  message?: string;
  created?: number | null;
  finished?: number | null;
  source_kind?: string | null;
  output_files?: string[];
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
}

/** GET /api/engines/{name}/scan?path= 响应 */
export interface ScanResult {
  items: ScanItem[];
  mapped?: boolean;
  path?: string;
  truncated?: boolean;
}
