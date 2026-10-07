// 共享并发控制 core（纯逻辑，无 DOM/window 依赖；单测见 client/tests/unit/concurrency.test.mjs）。
// S4 消费点：
//   - createPool            → extract_workers：本机音轨提取并发（web wasm 池 / desktop IPC 池共用）
//   - canStartInFlight      → queue_cap：派发循环 per-service 在途封顶（显式引擎 / auto 均衡）
//   - countInFlightRows     → 在途行计数（任务表行口径）
//   - normalizeClientConfig → 并发设置值域钳制（与 web 工作台 /api/client-config、desktop
//                             userData/client-config.json 的 clamp 口径一致：1..8 / 1..16）

import type { ClientConfig } from "./types";

/** 终态集（与 app.ts rowBucket 终态口径一致）：到终态才释放在途槽。 */
export const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set(["done", "skipped", "error", "canceled"]);

/** 在途行计数最小结构（JobRow 结构兼容；local 语义见 types.JobRow.local 注释）。 */
export interface InFlightRow {
  engine: string;
  job_id?: string | null;
  status: string;
  local?: boolean | null;
}

/** auto 模式候选引擎最小结构（Engine 结构兼容）。 */
export interface EngineLite {
  name: string;
  online: boolean;
  enabled?: boolean;
}

/** 客户端并发设置默认值（与 web 服务端 CLIENT_CONFIG_DEFAULTS / desktop CLIENT_CFG_DEFAULTS 对齐）。 */
export const CLIENT_CFG_DEFAULTS: { extract_workers: number; queue_cap: number } = {
  extract_workers: 2,
  queue_cap: 4,
};

/** 值域钳制 + 脏值回落默认（保存失败不落内存：调用方决定何时应用本函数的结果）。 */
export function normalizeClientConfig(raw: unknown): ClientConfig {
  const o: Record<string, unknown> = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const cc = (v: unknown, lo: number, hi: number, dflt: number): number =>
    typeof v === "number" && Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  const out: ClientConfig = {
    extract_workers: cc(o.extract_workers, 1, 8, CLIENT_CFG_DEFAULTS.extract_workers),
    queue_cap: cc(o.queue_cap, 1, 16, CLIENT_CFG_DEFAULTS.queue_cap),
  };
  if (typeof o.pipeline_paused === "boolean") out.pipeline_paused = o.pipeline_paused;
  return out;
}

/**
 * 某服务当前在途任务数（任务表行口径）：
 *  - 同服务 + 本机归属（local !== false；desktop/旧 API 未定义按本机）；
 *  - 有 job_id 且非终态（pending/running/paused 均占槽，到终态释放）；
 *  - 本机管线行（无 job_id：提取/上传/派发中）不计——由派发链记账覆盖，防双算。
 */
export function countInFlightRows(rows: readonly InFlightRow[], engine: string): number {
  let n = 0;
  for (const r of rows) {
    if (r.engine !== engine) continue;
    if (r.local === false) continue;
    if (!r.job_id) continue;
    if (!TERMINAL_JOB_STATUSES.has(r.status)) n++;
  }
  return n;
}

/**
 * 派发限流决策（queue_cap 消费）：显式引擎按该服务在途数判；
 * auto（仅 web 形态提供）= 任一「在线且参与均衡」的服务有空位即放行
 * （落点由服务端派发时刻实时选最闲，服务端 _gate 再叠一层）。
 * cap 下限 1（脏值不致锁死派发）。
 */
export function canStartInFlight(opts: {
  engine: string;
  cap: number;
  inFlight: (engine: string) => number;
  engines?: EngineLite[];
}): boolean {
  const cap = Number.isFinite(opts.cap) && opts.cap >= 1 ? Math.trunc(opts.cap) : 1;
  if (opts.engine !== "auto") return opts.inFlight(opts.engine) < cap;
  const cands = opts.engines || [];
  return cands.some((e) => e.online && e.enabled !== false && opts.inFlight(e.name) < cap);
}

/** 可 resize 工作池：limit 每次获取时现读（热重载），FIFO，调大唤醒等待者，调小不中断在跑者。 */
export interface WorkerPool {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** 换 limit 读数函数（app 注入 state.ccfg 实时读者；注入后旧读者作废）。 */
  setLimitReader(read: () => number): void;
  /** limit 调大后释放等待者（设置保存/变更时调用；无空位时空操作）。 */
  wake(): void;
  active(): number;
  waiting(): number;
}

export function createPool(limitOf: () => number): WorkerPool {
  let reader = limitOf;
  let active = 0;
  const waiters: Array<() => void> = [];
  const limit = (): number => {
    const n = Math.trunc(Number(reader()));
    return Number.isFinite(n) && n >= 1 ? n : 2; // 脏读数（NaN/负/0）防御：回落默认 2
  };
  const tryWake = (): void => {
    while (waiters.length > 0 && active < limit()) {
      const w = waiters.shift()!;
      active += 1;
      w();
    }
  };
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const acquired = active < limit()
        ? ((active += 1), Promise.resolve())
        : new Promise<void>((res) => waiters.push(res));
      return acquired.then(async () => {
        try {
          return await task();
        } finally {
          active -= 1;
          tryWake();
        }
      });
    },
    setLimitReader(read: () => number): void {
      reader = read;
    },
    wake(): void {
      tryWake();
    },
    active(): number {
      return active;
    },
    waiting(): number {
      return waiters.length;
    },
  };
}
