// 共享并发控制 core（纯逻辑，无 DOM/window 依赖；单测见 client/tests/unit/concurrency.test.mjs）。
// S4 消费点：
//   - createPool            → extract_workers：本机音轨提取并发（web wasm 池 / desktop IPC 池共用）
//   - canStartInFlight      → queue_cap：派发循环 per-service 在途封顶（显式引擎 / auto 均衡）
//   - countInFlightRows     → 在途行计数（任务表行口径）
//   - normalizeClientConfig → 并发设置值域钳制（与 web 工作台 /api/client-config、desktop
//                             userData/client-config.json 的 clamp 口径一致：1..8 / 1..16）

import type { ClientConfig, EngineMetricsGpu } from "./types";
import { MIN_FREE_VRAM_GB } from "./constants";

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
  // 扫描规则（扁平 scan_* 键）：type-guard 透传，脏值丢弃（保存前的值域校验在服务端/IPC 侧）
  const strList = (v: unknown): v is string[] =>
    Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === "string");
  if (strList(o.scan_video_exts)) out.scan_video_exts = o.scan_video_exts;
  if (strList(o.scan_subtitle_patterns)) out.scan_subtitle_patterns = o.scan_subtitle_patterns;
  if (strList(o.scan_has_sub_tokens)) out.scan_has_sub_tokens = o.scan_has_sub_tokens;
  if (strList(o.scan_no_sub_tokens)) out.scan_no_sub_tokens = o.scan_no_sub_tokens;
  if (typeof o.scan_recurse === "boolean") out.scan_recurse = o.scan_recurse;
  if (typeof o.scan_min_size_mb === "number" && Number.isFinite(o.scan_min_size_mb) && o.scan_min_size_mb >= 0) {
    out.scan_min_size_mb = o.scan_min_size_mb;
  }
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

/** 本机提取已中止（主任务取消）：池入口闸/main 进程 kill 回传；派发链识别后行落「跳过」而非失败 */
export class ExtractAbortError extends Error {
  constructor() {
    super("提取已中止（主任务取消）");
    this.name = "ExtractAbortError";
  }
}

/**
 * 池任务钩子：onQueue = 入队等槽时回调一次（ahead=前方等待数，UI 展示「提取排队（前方 N）」）；
 * onStart = 拿到槽、task 真正执行前回调（UI 从「排队」切「执行中」，状态与真实并发对齐）。
 */
export interface PoolHooks {
  onQueue?: (ahead: number) => void;
  onStart?: () => void;
}

/** 可 resize 工作池：limit 每次获取时现读（热重载），FIFO，调大唤醒等待者，调小不中断在跑者。 */
export interface WorkerPool {
  run<T>(task: () => Promise<T>, hooks?: PoolHooks): Promise<T>;
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
    run<T>(task: () => Promise<T>, hooks?: PoolHooks): Promise<T> {
      const acquired = active < limit()
        ? ((active += 1), Promise.resolve())
        : new Promise<void>((res) => {
          waiters.push(res);
          hooks?.onQueue?.(waiters.length - 1);
        });
      return acquired.then(async () => {
        hooks?.onStart?.();
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

// ---------- auto 派发显存感知（10-13-javscribe-client-writeback-guard F3④；单测见 client/tests/unit/auto-engine.test.mjs） ----------
// 背景：run10 A4 实锤——auto 均衡只看「在途最少」，把任务发到显存不足的服务
//（158 空闲 9.3G 仍收 2 并发 → 后起进程 CUDA OOM）。显存数据已有（/metrics/json 采样，
// 看板「显存 used/totalG」同源），派发侧用它过滤无谓命中；服务端预检是兜底（另线）。

/**
 * 某服务最近一次 metrics 采样的空闲显存（GB）：
 *  - null = 无数据（旧版 serve 无 /metrics/json、未采样、无 GPU、字段缺失）→ 调用方视为「满足」不过滤；
 *  - 否则 (mem_total_mb - mem_used_mb) / 1024。
 */
export function freeVramGb(gpu: EngineMetricsGpu | null | undefined): number | null {
  if (!gpu) return null;
  if (typeof gpu.mem_used_mb !== "number" || typeof gpu.mem_total_mb !== "number") return null;
  if (!Number.isFinite(gpu.mem_used_mb) || !Number.isFinite(gpu.mem_total_mb)) return null;
  return (gpu.mem_total_mb - gpu.mem_used_mb) / 1024;
}

/**
 * auto 派发时刻解析（显存感知）：
 *  - 候选 = 在线且参与均衡（enabled !== false）；
 *  - 显存过滤：最近采样空闲显存 < minFreeVramGb → 不作候选；无数据（null）视为满足、不过滤；
 *  - 剩余候选按在途最少取胜，平手按注册序取首个（稳定即可）；
 *  - 显存过滤后候选全空但原候选非空 → 回退「在途最少」（原逻辑），保证不卡派发。
 */
export function pickAutoEngine(
  engines: readonly EngineLite[],
  opts: {
    inFlight: (name: string) => number;
    /** 显存阈值（GB）；缺省 MIN_FREE_VRAM_GB */
    minFreeVramGb?: number;
    /** 某服务最近 metrics 采样空闲显存（GB）；null/缺省 = 无数据不过滤 */
    freeVramOf?: (name: string) => number | null;
  },
): string | null {
  const minGb = typeof opts.minFreeVramGb === "number" && Number.isFinite(opts.minFreeVramGb) && opts.minFreeVramGb > 0
    ? opts.minFreeVramGb
    : MIN_FREE_VRAM_GB;
  const freeVram = opts.freeVramOf || ((_n: string): number | null => null);
  const cands = engines.filter((e) => e.online && e.enabled !== false);
  const pickMin = (list: readonly EngineLite[]): string | null => {
    let best: string | null = null;
    let bestN = Infinity;
    for (const e of list) {
      const n = opts.inFlight(e.name);
      if (n < bestN) { best = e.name; bestN = n; }
    }
    return best;
  };
  const vramOk = cands.filter((e) => {
    const f = freeVram(e.name);
    return f == null || f >= minGb;
  });
  return pickMin(vramOk) ?? pickMin(cands);
}

// ---------- auto 批次分发（10-17-javscribe-0243-scan-auto-balance；单测见 client/tests/unit/auto-engine.test.mjs） ----------
// 背景：「扫描目录」选 auto 时客户端曾 probe 一次把整批钉死单台服务，
// 与「选择文件夹」per-file 派发时刻均衡不对称。desktop 形态 serve 之间无对等注册表，
// 分发只能客户端做：提交前按负载把文件摊到候选服务，子批各自 /scan/submit。

/**
 * auto 批次分发（list-scheduling）：每个文件依次落「本批已分配数」最少的服务；
 * 平手取输入序靠前者（调用方按在途升序传入、平手注册序 → 整体负载最均）。
 * 返回每文件的服务名（长度 = n）；空输入/ n<=0 → []。
 */
export function distributeToEngines(ordered: readonly string[], n: number): string[] {
  if (!ordered.length || !Number.isFinite(n) || n <= 0) return [];
  const assigned = new Array<number>(ordered.length).fill(0);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let bi = 0;
    for (let j = 1; j < assigned.length; j++) if (assigned[j] < assigned[bi]) bi = j;
    assigned[bi]++;
    out.push(ordered[bi]);
  }
  return out;
}

const _enc = new TextEncoder();

/**
 * 路径列表按 JSON 字节切子批（desktop 扫描 auto 分发用）：
 * 每元素计 UTF-8 字节 + 3（引号/逗号），数组括号预留 2；单批 ≤ maxBytes。
 * 调用方上限取 900KB：新 serve 16MB / 旧 serve（≤0.2.7）1MB 都兼容，
 * 杜绝「整批钉死单台 → bad body size (max 1024KB)」复发。
 */
export function chunkPathsByBytes(paths: readonly string[], maxBytes: number): string[][] {
  const out: string[][] = [];
  if (!paths.length || !Number.isFinite(maxBytes) || maxBytes < 8) return out;
  let cur: string[] = [];
  let used = 2; // "[]"
  for (const p of paths) {
    const c = _enc.encode(p).length + 3;
    if (cur.length && used + c > maxBytes) {
      out.push(cur);
      cur = [];
      used = 2;
    }
    cur.push(p);
    used += c;
  }
  out.push(cur);
  return out;
}
