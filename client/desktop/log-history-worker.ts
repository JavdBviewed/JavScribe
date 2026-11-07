import { parentPort, workerData } from "node:worker_threads";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseDailyLine, queryHistory, type HistoryLine, type HistoryQuery } from "../core/log-history";

interface HistoryInput {
  dir: string | null;
  names: string[];
  servePath: string | null;
  ring: string[];
  localDate: string;
  query: HistoryQuery;
}

const { dir, names, servePath, ring, localDate, query } = workerData as HistoryInput;
const entries: HistoryLine[] = [];
let truncated = false;

function tailFile(fp: string, cap: number): { text: string; offset: number } {
  const st = fs.lstatSync(fp);
  if (!st.isFile()) return { text: "", offset: 0 };
  const offset = Math.max(0, st.size - cap);
  const buf = Buffer.alloc(st.size - offset);
  const fd = fs.openSync(fp, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!fs.fstatSync(fd).isFile()) return { text: "", offset: 0 };
    fs.readSync(fd, buf, 0, buf.length, offset);
  } finally { fs.closeSync(fd); }
  return { text: buf.toString("utf8"), offset };
}

for (const name of names) {
  if (!dir || !/^jav-scribe-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
  const date = name.slice("jav-scribe-".length, -".log".length);
  if ((query.from && date < query.from) || (query.to && date > query.to)) continue;
  try {
    const { text, offset } = tailFile(path.join(dir, name), 8 * 1024 * 1024);
    const lines = text.split("\n");
    if (offset) { lines.shift(); truncated = true; }
    for (const line of lines) {
      const parsed = parseDailyLine(line, date);
      if (parsed) entries.push(parsed);
    }
  } catch { truncated = true; }
}

if (!names.includes(`jav-scribe-${localDate}.log`)) {
  for (const line of ring) {
    const parsed = parseDailyLine(line, localDate);
    if (parsed) entries.push(parsed);
  }
}

if (servePath && (!query.source || query.source === "all" || query.source === "serve")) {
  try {
    const st = fs.lstatSync(servePath);
    if (st.isFile()) {
      const { text, offset } = tailFile(servePath, 2 * 1024 * 1024);
      truncated ||= offset > 0;
      const date = new Date(st.mtimeMs);
      const serveDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const lines = text.split("\n").filter(Boolean);
      if (offset) lines.shift();
      for (const line of lines) {
        const parsed = parseDailyLine(line, serveDate);
        if (parsed) entries.push({ ...parsed, text: `[serve · 文件日期 ${serveDate}] ${line}`, source: "serve" });
      }
    }
  } catch { /* 内嵌服务日志不存在时忽略 */ }
}

parentPort?.postMessage({ ...queryHistory(entries, query), truncated, serveLogPath: servePath });
