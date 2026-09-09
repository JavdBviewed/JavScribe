// SRT 防御性清洗（与 web/src/jav_scribe_web/srt_sanitizer.py 逻辑一致，独立 port）。
//
// 背景：上游引擎偶发产出负的 cue 起点（模型输出未以时间戳 token 开头时，首个
// 子段 start 被算成大负数）。非法 SRT 会让 Emby/Jellyfin/Plex 行为不可预期。
// serve 侧（core/finalize.py）在生成时已清洗一次；桌面形态不经 8400 工作台代理、
// 直接取服务上的 srt（写回源目录 / 保存下载），在 main 进程侧再做一次兜底。
//
// 兜底规则（只改时间戳，不动文本；删除除外——被删 cue 是 fallback 冗余产物）：
//   - start < 0    -> clamp 到 0
//   - end < start  -> 提到 start
//   - 超长 cue（>30s）且区间内有其他 cue 起点 -> 删除（VAD 全量覆盖 fallback 产物）
//   - 相邻 cue 重叠 -> 前一条 end 截到后一条 start（截成零长则删除）
//   - 按 (start 升序, end 降序) 稳定排序并重编号
// 无法完整解析的内容原样放行（宁可不动，不可改坏）。
//
// 超长 cue 背景（2026-09-09 PJAM-045 取证，任务线 09-09-srt-overlap-long-cues）：
// 引擎 VAD 空结果时走「整段覆盖」fallback，产出 chunk 全长 + 一两句的长 cue，
// 与同区域细粒度 cue 时间重叠（两路分段流），播放器表现为旧文本滞留叠压。
// 孤立长 cue（区间内无其他 cue 起点，如 40s 连续独白）是该时段唯一字幕，保留。

/** 超长 cue 阈值：正常对话字幕时长 p90 ≈ 9s（PJAM-045 实测），30s ≈ 3×p90 */
const LONG_CUE_MS = 30_000;

const TS_LINE_RE = /^\s*(-?\d{1,2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(-?\d{1,2}:\d{2}:\d{2}[,.]\d{3})\s*$/;

/** '1:02:03,456'（可带负号）-> 毫秒（可为负） */
function tsToMs(hms: string): number {
  const neg = hms.startsWith("-");
  const body = neg ? hms.slice(1) : hms;
  const [h, m, sPart] = body.split(":");
  const [s, ms] = sPart.split(/[,.]/).map(Number);
  const v = (Number(h) * 3600 + Number(m) * 60 + s) * 1000 + ms;
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
  // start 升序；同 start 时长 cue 在前（同起点重叠时长的被截/删，保留细粒度）
  blocks.sort((a, b) => a.start - b.start || b.end - a.end);

  // 防御二a：超长 cue（>30s）且区间内有其他 cue 起点 → 删除。
  // 排序后只需看相邻：前一个同 start（同起点组）或后一个 start 落在本条区间内。
  const keep: Block[] = [];
  let dropped = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const covered =
      b.end - b.start > LONG_CUE_MS &&
      ((i > 0 && blocks[i - 1].start === b.start) ||
        (i + 1 < blocks.length && blocks[i + 1].start < b.end));
    if (covered) dropped++;
    else keep.push(b);
  }

  // 防御二b：相邻重叠 → 前一条 end 截到后一条 start；截成零长则删除。
  // 按 start 排序后此规则保证输出任意两 cue 零重叠。
  const outBlocks: Block[] = [];
  for (let i = 0; i < keep.length; i++) {
    const b = keep[i];
    if (i + 1 < keep.length && b.end > keep[i + 1].start) {
      b.end = keep[i + 1].start;
      b.newTs = `${msToTs(b.start)} --> ${msToTs(b.end)}`;
      if (b.end <= b.start) {
        dropped++;
        continue;
      }
    }
    outBlocks.push(b);
  }
  let out = "";
  for (let idx = 0; idx < outBlocks.length; idx++) {
    const b = outBlocks[idx];
    const ts = b.newTs ?? `${msToTs(b.start)} --> ${msToTs(b.end)}`;
    out += `${idx + 1}\n${ts}\n${b.text}\n\n`;
  }
  if (out === text) return data; // 完全合法（含已按序）：原样返回
  return new TextEncoder().encode(out);
}
