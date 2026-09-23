// SRT 字幕解析（前端预览弹窗用）：宽容处理 BOM / WEBVTT 头 / 毫秒分隔符 , 或 . /
// ASS 风格 H:MM:SS.cc；无有效时间轴行 → invalid=true（弹窗降级展示原文）。
export interface SrtCue {
  /** 1 基序号（解析顺序） */
  index: number;
  /** 起始秒（浮点，毫秒精度） */
  start: number;
  /** 结束秒 */
  end: number;
  /** 字幕文本（多行保留 \n） */
  text: string;
}

export interface SrtParseResult {
  cues: SrtCue[];
  /** 未解析出任何 cue（非 srt / 空文件 / 格式异常） */
  invalid: boolean;
}

// H:MM:SS,mmm --> H:MM:SS,mmm（毫秒段 1-3 位；分隔符 , 或 .；ASS 的 .cc 兼容——
// 2 位按百分秒 pad 到 3 位即毫秒）
const TS_RE =
  /^(\d{1,2}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

function tsSec(h: string, m: string, s: string, frac: string): number {
  const ms = parseInt(frac.padEnd(3, "0"), 10);
  return (+h) * 3600 + (+m) * 60 + (+s) + ms / 1000;
}

export function parseSrt(text: string): SrtParseResult {
  const src = (text || "").replace(/^\uFEFF/, "");
  const blocks = src.split(/\r?\n[ \t]*\r?\n/);
  const cues: SrtCue[] = [];
  let idx = 1;
  for (const blk of blocks) {
    const lines = blk.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    let tsLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (TS_RE.test(lines[i])) { tsLine = i; break; }
    }
    if (tsLine < 0) continue; // WEBVTT HEAD / 序号行 / 噪声块
    const m = lines[tsLine].match(TS_RE)!;
    const start = tsSec(m[1], m[2], m[3], m[4]);
    const end = tsSec(m[5], m[6], m[7], m[8]);
    // 0/负时长 cue 不进时间轴：播放器不渲染，且 serve 尾部指纹即 0 时长
    // 注释 cue（`<!-- jav-scribe ... -->`），计入会污染预览与条数统计
    if (end <= start) continue;
    const body = lines.slice(tsLine + 1);
    if (!body.length) continue;
    cues.push({ index: idx++, start, end, text: body.join("\n") });
  }
  if (!cues.length) return { cues: [], invalid: true };
  return { cues, invalid: false };
}

/** 00:01:02,345 形式时间轴文本 */
export function fmtSrtTime(sec: number): string {
  const v = Math.max(0, sec);
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = Math.floor(v % 60);
  const ms = Math.round(v * 1000) % 1000;
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(ms, 3)}`;
}

/** 人类化总时长（2小时01分 / 12分03秒 / 45秒） */
export function fmtSrtSpan(sec: number): string {
  const v = Math.max(0, Math.round(sec));
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = v % 60;
  if (h) return `${h}小时${String(m).padStart(2, "0")}分`;
  if (m) return `${m}分${String(s).padStart(2, "0")}秒`;
  return `${s}秒`;
}
