import { LEVEL_RANK, type LogLevel, type LogSource } from "./log-center";

export interface HistoryLine {
  text: string;
  date: string;
  time: string;
  level: LogLevel;
  source: LogSource;
}

export interface HistoryQuery {
  from?: string;
  to?: string;
  source?: "all" | LogSource;
  level?: LogLevel;
  q?: string;
  page: number;
  pageSize: number;
}

export function managedLogName(name: string): boolean {
  return /^jav-scribe-\d{4}-\d{2}-\d{2}\.log$/.test(name);
}

export function parseDailyLine(text: string, fallbackDate: string): HistoryLine | null {
  if (!text) return null;
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3}) \[(debug|info|warn|error)\] \[(main|ui|serve)\] /.exec(text);
  return { text, date: m?.[1] || fallbackDate, time: m?.[2] || "", level: (m?.[3] || "info") as LogLevel, source: (m?.[4] || "main") as LogSource };
}

export function queryHistory(entries: HistoryLine[], q: HistoryQuery): { lines: string[]; total: number; page: number; pages: number } {
  const filtered = entries.filter((l) =>
    (!q.from || l.date >= q.from) && (!q.to || l.date <= q.to)
    && (!q.source || q.source === "all" || l.source === q.source)
    && (!q.level || LEVEL_RANK[l.level] >= LEVEL_RANK[q.level])
    && (!q.q || l.text.toLowerCase().includes(q.q.toLowerCase().trim())),
  ).reverse().sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
  const size = Math.max(1, Math.min(500, Math.floor(q.pageSize) || 100));
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const page = Math.min(Math.max(1, Math.floor(q.page) || 1), pages);
  return { lines: filtered.slice((page - 1) * size, page * size).map((l) => l.text), total: filtered.length, page, pages };
}
