// 派发账本（0.2.51 引入；0.2.57 中断态）纯逻辑层：数据模型 + 字段归一 + 中断迁移 + 惰性剪枝。
// 状态接线（localStorage / main 磁盘镜像 / pending 行 / 渲染）留在 ui/app.ts；
// 本模块零 DOM / localStorage / transport 依赖，node 可单测（tests/unit/ledger.test.mjs）。
//
// 背景：行优先 pending 子行纯 renderer 内存，客户端中途退出后主任务子行/状态全丢；
// 服务端 200 内存窗 + jobs.json（仅恢复终态）也会挤丢/重启丢非终态任务。
// 账本 = pkey → 最后已知子行状态。0.2.57 起：客户端退出/重启后非终态条目落「interrupted」
// （服务端在途任务必丢——serve 重启只恢复终态），中断行可重跑/可清除，不再是永久僵尸行。

/** 账本子行：pkey → 最后已知子行状态 */
export interface LedgerChild {
  batch_id: string | null;
  batch_label: string;
  engine: string;
  job_id: string | null;
  videoName: string;
  status: string;
  progress: number;
  message: string;
  created: number | null;
  finished: number | null;
  updatedAt: number;
  // ↓ 0.2.57 新增（可选字段；旧数据缺失 = 按 null 处理）
  /** 派发时源视频路径（本地扫描/文件夹行的 file_path/local_path；中断重跑的前置） */
  file_path?: string | null;
  /** 中断前最后状态（running/pending/extracting…） */
  last_status?: string | null;
  /** 中断时刻（ms；= 迁移前 updatedAt） */
  interrupted_at?: number | null;
  /** 中断原因（如「客户端重启，任务链路断开」） */
  interrupted_reason?: string;
}

/** 0.2.57：中断（一等状态：视同终态参与清理/聚合/排序，但可重跑） */
export const INTERRUPTED = "interrupted";

/** 终态口径（账本剪枝 / 批次聚合 / 清理筛选 / 筛选桶共用）；interrupted 视同终态。 */
export const TERMINAL_LIKE = new Set(["done", "skipped", "error", "canceled", "interrupted"]);

export const LEDGER_STORE_KEY = "javweb_dispatch_ledger_v1";
export const LEDGER_MAX_CHILDREN = 500;   // 对齐 serve JOBS_HISTORY_MAX
export const LEDGER_MAX_SUPPRESS = 1000;  // 抑制集上限（最旧优先剪）
export const LEDGER_TTL_MS = 14 * 24 * 3600 * 1000; // 陈旧条目惰性剪枝

/** store 结构 v:1 不变（0.2.57 字段均为 LedgerChild 加性可选，旧数据直接兼容） */
export interface LedgerStore {
  v: 1;
  children: Record<string, LedgerChild>;
  suppress: string[];
}

/** 字段校验 + 归一（localStorage 读回与 main 镜像灌回共用）；缺关键项 → null（宁缺勿错）。 */
export function normalizeChild(c: Partial<LedgerChild> | null | undefined, now: number): LedgerChild | null {
  if (!c || typeof c.status !== "string" || typeof c.videoName !== "string") return null;
  return {
    batch_id: typeof c.batch_id === "string" ? c.batch_id : null,
    batch_label: typeof c.batch_label === "string" ? c.batch_label : "",
    engine: typeof c.engine === "string" ? c.engine : "",
    job_id: typeof c.job_id === "string" ? c.job_id : null,
    videoName: c.videoName,
    status: c.status,
    progress: typeof c.progress === "number" ? c.progress : 0,
    message: typeof c.message === "string" ? c.message : "",
    created: typeof c.created === "number" ? c.created : null,
    finished: typeof c.finished === "number" ? c.finished : null,
    updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : now,
    file_path: typeof c.file_path === "string" ? c.file_path : null,
    last_status: typeof c.last_status === "string" ? c.last_status : null,
    interrupted_at: typeof c.interrupted_at === "number" ? c.interrupted_at : null,
    interrupted_reason: typeof c.interrupted_reason === "string" ? c.interrupted_reason : undefined,
  };
}

/**
 * 中断迁移（0.2.57 核心）：所有非终态条目 → interrupted。
 * 语义：客户端退出/重启即任务链路断开，服务端在途任务必丢（serve 重启只恢复终态），
 * 留在账本里的非终态条目若不改状态会永远渲染成「运行中/排队中 0%」僵尸行。
 * 幂等：interrupted / 其他终态不动；last_status 只记第一次（已中断条目的 last_status 保留）。
 * @returns 本次改动的条目数
 */
export function migrateInterrupted(
  children: Record<string, LedgerChild>,
  now: number,
  reason: string,
): number {
  let changed = 0;
  for (const [k, c] of Object.entries(children)) {
    if (TERMINAL_LIKE.has(c.status)) continue;
    if (c.status !== INTERRUPTED && !c.last_status) c.last_status = c.status;
    c.status = INTERRUPTED;
    c.interrupted_at = c.updatedAt || now;
    c.interrupted_reason = reason;
    changed++;
  }
  return changed;
}

/**
 * 惰性剪枝：TTL（14 天）→ 子行上限 500（先剪最旧终态，再剪最旧任意）→ 抑制集上限 1000。
 * 原地修改。@returns 是否有变化
 */
export function pruneLedger(
  children: Record<string, LedgerChild>,
  suppress: string[],
  now: number,
): boolean {
  let changed = false;
  for (const [k, c] of Object.entries(children)) {
    if (now - c.updatedAt > LEDGER_TTL_MS) { delete children[k]; changed = true; }
  }
  let excess = Object.keys(children).length - LEDGER_MAX_CHILDREN;
  if (excess > 0) {
    const sorted = Object.entries(children).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [k, c] of sorted) {
      if (excess <= 0) break;
      if (TERMINAL_LIKE.has(c.status)) { delete children[k]; excess--; changed = true; }
    }
    for (const [k] of sorted) {
      if (excess <= 0) break;
      if (k in children) { delete children[k]; excess--; changed = true; }
    }
  }
  excess = suppress.length - LEDGER_MAX_SUPPRESS;
  if (excess > 0) { suppress.splice(0, excess); changed = true; }
  return changed;
}

/** pending 行 transition 指纹：仅状态迁移落盘（进度 tick 不写）。 */
export function pendingFingerprint(r: {
  status: string;
  phase?: string | null;
  job_id?: string | null;
  engine: string;
  finished?: number | null;
  aborted?: boolean;
}): string {
  return `${r.status}|${r.phase || ""}|${r.job_id || ""}|${r.engine}|${r.finished ? 1 : 0}|${r.aborted ? 1 : 0}`;
}

/** pending 行 → 账本条目。0.2.57：透传 file_path（源视频路径，中断重跑的前置）。 */
export function childFromPendingRow(
  r: {
    batch_id?: string | null;
    batch_label?: string | null;
    engine: string;
    job_id?: string | null;
    file?: string | null;
    label?: string | null;
    status: string;
    progress?: number | null;
    phase_detail?: string | null;
    position?: string | null;
    message?: string | null;
    created?: number | null;
    finished?: number | null;
    file_path?: string | null;
    local_path?: string | null;
  },
  now: number,
): LedgerChild {
  return {
    batch_id: r.batch_id || null,
    batch_label: r.batch_label || "",
    engine: r.engine,
    job_id: r.job_id ? String(r.job_id) : null,
    videoName: r.file || r.label || "",
    status: r.status,
    progress: r.progress || 0,
    message: r.phase_detail || r.position || r.message || "",
    created: r.created ?? null,
    finished: r.finished ?? null,
    updatedAt: now,
    file_path: r.file_path || r.local_path || null,
  };
}

/** 清理类别口径（0.2.57 历史清理对话框 5 类；其余状态不可清理 → null） */
export const CLEANUP_CATS: Array<[string, string]> = [
  ["done", "完成"], ["skipped", "跳过"], ["error", "失败"], ["canceled", "已取消"], ["interrupted", "中断"],
];

export function cleanupCatOf(status: string): string | null {
  if (status === "done") return "done";
  if (status === "skipped") return "skipped";
  if (status === "error") return "error";
  if (status === "canceled") return "canceled";
  if (status === INTERRUPTED) return "interrupted";
  return null;
}
