// 客户端日志中心（0.2.62）：纯逻辑层，node 可单测（无 electron / DOM 依赖）
//
// 数据面在 main 进程：console 挂钩 / renderer console-message / 内嵌 serve 日志文件；
// 本模块提供环形缓冲（内存）、过滤（源/最低级别/关键词/时间起）、格式化。
// 文件面（daily 落盘 + 3 天清理）在 main 进程直写，不走本模块。

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSource = "main" | "ui" | "serve";

export interface LogLine {
  /** ISO 时间戳；serve 文件行可能为空（无行内时间） */
  t: string;
  level: LogLevel;
  src: LogSource;
  msg: string;
}

/** 严重度排序：数字越大越严重 */
export const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export const DEFAULT_RING_CAP = 20000;
export const DEFAULT_TAIL_LIMIT = 2000;

/** 内存环形缓冲：超过 cap 丢弃最旧 */
export class LogRing {
  private lines: LogLine[] = [];
  private readonly cap: number;

  constructor(cap: number = DEFAULT_RING_CAP) {
    this.cap = cap > 0 ? Math.floor(cap) : DEFAULT_RING_CAP;
  }

  push(level: LogLevel, src: LogSource, msg: string, t?: string): void {
    this.lines.push({ t: t || new Date().toISOString(), level, src, msg: String(msg) });
    if (this.lines.length > this.cap) {
      this.lines.splice(0, this.lines.length - this.cap);
    }
  }

  /** 最近 limit 条（limit<=0 = 全部） */
  tail(limit: number = DEFAULT_TAIL_LIMIT): LogLine[] {
    if (limit > 0) return this.lines.slice(-limit);
    return this.lines.slice();
  }

  clear(): void {
    this.lines.length = 0;
  }

  get size(): number {
    return this.lines.length;
  }
}

export interface LogFilter {
  /** 源过滤；缺省 = 全部源 */
  source?: LogSource;
  /** 最低级别（含）：error → 只 error；warn → warn+error；info → info+warn+error；debug → 全部 */
  level?: LogLevel;
  /** 关键词：msg 大小写不敏感子串 */
  q?: string;
  /** 起始时间（ISO 或 Date 可解析串，t >= since） */
  since?: string;
}

export function filterLines(lines: LogLine[], f: LogFilter): LogLine[] {
  const min = f.level != null ? LEVEL_RANK[f.level] : 0;
  const q = (f.q || "").trim().toLowerCase();
  const sinceMs = f.since ? Date.parse(f.since) : NaN;
  return lines.filter((l) => {
    if (f.source && l.src !== f.source) return false;
    if (LEVEL_RANK[l.level] < min) return false;
    if (q && !l.msg.toLowerCase().includes(q)) return false;
    if (!Number.isNaN(sinceMs)) {
      const t = l.t ? Date.parse(l.t) : NaN;
      if (Number.isNaN(t) || t < sinceMs) return false;
    }
    return true;
  });
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** ISO → 本地时间 YYYY-MM-DD HH:mm:ss.SSS；解析失败原样返回（serve 空串 → 空） */
export function formatTs(t: string): string {
  if (!t) return "";
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

/** 固定列宽格式化：`2026-10-26 12:34:56.789 [warn] [main] msg`（无时间戳补空白对齐） */
export function formatLine(l: LogLine): string {
  const ts = formatTs(l.t) || "                    ";
  return `${ts} [${l.level}] [${l.src}] ${l.msg}`;
}

export function formatLines(lines: LogLine[]): string {
  return lines.map(formatLine).join("\n");
}
