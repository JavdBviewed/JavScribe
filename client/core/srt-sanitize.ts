// SRT 防御性清洗（与 web/src/jav_scribe_web/srt_sanitizer.py 逻辑一致，独立 port）。
//
// 背景：上游引擎偶发产出负的 cue 起点（模型输出未以时间戳 token 开头时，首个
// 子段 start 被算成大负数）。非法 SRT 会让 Emby/Jellyfin/Plex 行为不可预期。
// serve 侧（core/finalize.py）在生成时已清洗一次；桌面形态不经 8400 工作台代理、
// 直接取服务上的 srt（写回源目录 / 保存下载），在 main 进程侧再做一次兜底。
//
// 兜底规则（只改时间戳，不动文本）：
//   - start < 0    -> clamp 到 0
//   - end < start  -> 提到 start
//   - 按 (start, end) 稳定排序并重编号
// 无法完整解析的内容原样放行（宁可不动，不可改坏）。

const TS_LINE_RE = /^\s*(-?\d{1,2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(-?\d{1,2}:\d{2}:\d{2}[,.]\d{3})\s*$/;

/** '1:02:03,456'（可带负号）-> 毫秒（可为负） */
function tsToMs(hms: string): number {
  const neg = hms.startsWith("-");
  const body = neg ? hms.slice(1) : hms;
  const [hm, sPart] = body.split(":");
  const [h, m] = hm.split(":").map(Number);
  const [s, ms] = sPart.split(/[,.]/).map(Number);
  const v = (h * 3600 + m * 60 + s) * 1000 + ms;
  return neg ? -v : v;
}

function msToTs(ms: number): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(ms / 3600000);
  const rem1 = ms % 3600000;
  const m = Math.floor(rem1 / 60000);
  const s = Math.floor((rem1 % 60000) / 1000);
  const r3 = rem1 % 1000;
  return `${p2(h)}:${p2(m)}:${p2(s)},${String(r3).padStart(3, "0")}`;
}

interface Block {
  start: number;
  end: number;
  newTs?: string;
  text: string;
}

/** 严格解析 SRT；任何不符合「序号(可选) + 时间戳行 + 文本(到空行)」的结构返回 null */
function parseBlocks(text: string): Block[] | null {
  const lines = text.split("\n");
  if (lines.some((ln) => ln.includes("\r"))) return null;
  const blocks: Block[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    while (i < n && !lines[i].trim()) i++;
    if (i >= n) break;
    let j = i;
    if (/^\d+$/.test(lines[j].trim())) j++; // 可选序号行
    if (j >= n) return null;
    const m = TS_LINE_RE.exec(lines[j]);
    if (!m) return null;
    j++;
    const textLines: string[] = [];
    while (j < n && lines[j].trim()) {
      textLines.push(lines[j]);
      j++;
    }
    blocks.push({ start: tsToMs(m[1]), end: tsToMs(m[2]), text: textLines.join("\n") });
    i = j;
  }
  if (!blocks.length) return null;
  return blocks;
}

/** bytes 进出（utf-8）；解码失败或无需修改时原样返回 */
export function sanitizeSrtBytes(data: Uint8Array): Uint8Array {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return data;
  }
  const blocks = parseBlocks(text);
  if (!blocks) return data;

  let fixed = 0;
  for (const b of blocks) {
    const ns = Math.max(0, b.start);
    const ne = Math.max(ns, b.end);
    if (ns !== b.start || ne !== b.end) {
      b.start = ns;
      b.end = ne;
      b.newTs = `${msToTs(ns)} --> ${msToTs(ne)}`;
      fixed++;
    }
  }
  blocks.sort((a, b) => a.start - b.start || a.end - b.end); // 稳定排序 + 重编号
  let out = "";
  for (let idx = 0; idx < blocks.length; idx++) {
    const b = blocks[idx];
    const ts = b.newTs ?? `${msToTs(b.start)} --> ${msToTs(b.end)}`;
    out += `${idx + 1}\n${ts}\n${b.text}\n\n`;
  }
  if (out === text) return data; // 完全合法（含已按序）：原样返回
  return new TextEncoder().encode(out);
}
