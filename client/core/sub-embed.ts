// 内嵌字幕探测 + 跳过策略（与服务端 src/jav_scribe/core/subprobe.py 同源语义）。
//
// 客户端 watch 在候选「两轮稳定」后用本地 ffprobe 只读容器头探测内嵌字幕轨，
// 命中目标语言（默认 zh）则不派发；ffprobe 缺失/失败一律 fail-open（不挡派发，
// 服务端 engine 侧同判定是权威兜底）。
//
// 策略与服务端一致：off=不跳 / target=仅目标语言内嵌轨命中才跳（und 不命中，
// JAV 库内嵌 ja PGS 不挡 zh）/ any=任意内嵌字幕轨都跳。

/** 只认这些字幕 codec（与服务端 SUBTITLE_CODECS 一致） */
export const SUBTITLE_CODECS: ReadonlySet<string> = new Set([
  "subrip", "srt", "ass", "ssa", "mov_text", "webvtt",
  "hdmv_pgs_subtitle", "dvb_subtitle", "dvb_teletext", "xsub", "txt",
]);

export interface EmbeddedSub {
  codec: string;
  language: string | null;
}

export interface EmbedCfg {
  /** off | target | any（缺省 target） */
  skip_embedded?: string;
  /** target 模式的目标语言集合；空/缺省回落 [lang_tag] */
  embedded_langs?: string[];
  /** 目标语言标签（默认 zh） */
  lang_tag?: string;
}

/** ffprobe 语言标签归一：chi/zho→zh；jpn/jap→ja；空→und；其余小写透传 */
export function normLanguage(lang: string | null | undefined): string {
  const l = (lang ?? "").trim().toLowerCase();
  if (!l) return "und";
  if (l === "chi" || l === "zho") return "zh";
  if (l === "jpn" || l === "jap") return "ja";
  return l;
}

/** target 模式的有效目标语言：embedded_langs（非空）否则 [lang_tag] */
export function embeddedTargets(cfg: EmbedCfg): string[] {
  const langs = cfg.embedded_langs;
  if (Array.isArray(langs)) {
    const items = langs.filter((x) => x && String(x).trim()).map((x) => normLanguage(String(x)));
    if (items.length) return items;
  }
  return [normLanguage(cfg.lang_tag ?? "zh")];
}

/** 纯决策：内嵌轨语言列表是否触发跳过。reason 仅在 skip=true 时非空。 */
export function shouldSkipEmbedded(
  cfg: EmbedCfg,
  langs: Array<string | null | undefined>,
): { skip: boolean; reason: string } {
  const mode = String(cfg.skip_embedded ?? "target").toLowerCase();
  if (mode === "off" || !langs.length) return { skip: false, reason: "" };
  if (mode === "any") {
    return { skip: true, reason: `视频已内嵌 ${langs.length} 条字幕轨（不区分语言）` };
  }
  if (mode !== "target") return { skip: false, reason: "" }; // 未知值按 off，不挡流程
  const targets = embeddedTargets(cfg);
  const hit = [...new Set(langs.map(normLanguage).filter((l) => targets.includes(l)))].sort();
  if (hit.length) return { skip: true, reason: `视频已内嵌 ${hit.join("/")} 字幕轨` };
  return { skip: false, reason: "" };
}

interface ProbeStream {
  codec_name?: string;
  tags?: { language?: string } | null;
}

/** 解析 `ffprobe -select_streams s -show_entries stream=codec_name,tags.language -of json` 输出 */
export function parseProbeOutput(jsonText: string): EmbeddedSub[] {
  let data: { streams?: ProbeStream[] };
  try {
    data = JSON.parse(jsonText || "{}");
  } catch {
    return [];
  }
  const out: EmbeddedSub[] = [];
  for (const s of data.streams || []) {
    if (!s.codec_name || !SUBTITLE_CODECS.has(s.codec_name)) continue;
    out.push({ codec: s.codec_name, language: s.tags?.language ?? null });
  }
  return out;
}
