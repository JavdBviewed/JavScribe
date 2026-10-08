// 「选择文件夹」两形态共用的过滤与字幕判定（消费「客户端设置 · 扫描规则」）
// 纯逻辑模块：web 渲染层（webkitdirectory 文件列表）与 desktop main（walkVideos）
// 走同一判定，node 可单测。
//
// 10-09-javscribe-local-scan-parity 背景：选择文件夹原先硬编码 VIDEO_EXTS +
// LOCAL_SUB_PATTERNS，与「扫描目录」的扫描规则两套口径；desktop 侧只回传视频项，
// 渲染层 byDir 判同目录 srt 永远 miss → hasSub 恒 false。本模块统一判定。

/** 文件夹扫描规则（与「客户端设置 · 扫描规则」同字段语义） */
export interface FolderScanRules {
  /** 小写、无点（mp4 / mkv …） */
  video_exts: string[];
  /** 小写、带点（.zh.srt / .srt …）；按序匹配 <stem>+suffix */
  subtitle_patterns: string[];
  /** 低于该 MB 视为过小（列表保留、默认不勾选）；0 = 不限 */
  min_size_mb: number;
  /** 文件名整词命中 → 视为已压字幕 */
  has_sub_tokens: string[];
  /** 文件名整词命中 → 视为无字幕版（双列表同时命中时无字幕优先） */
  no_sub_tokens: string[];
}

/** 单个视频的判定结果（PickFolderItem / FolderVideo 携带，两形态同构） */
export interface FolderVideoMeta {
  /** external（同目录 srt）/ named（文件名标记）/ none */
  sub_status: "external" | "named" | "none";
  /** external 命中的字幕文件名（小写）；其余 null */
  sub_name: string | null;
  /** has_sub 命中标记；未命中或双命中被无字幕覆盖时 null */
  sub_token: string | null;
  /** no_sub 命中标记；未命中 null */
  no_sub_token: string | null;
  /** 低于 min_size_mb */
  too_small: boolean;
}

/** 文件名按 token 整词匹配标记列表（大小写不敏感）；未命中 null。
 *  连续字母数字段（- 空格 _ . [ ] 等分隔均切开）；天然排除粘番号（SSIS-123C）、
 *  CD 集数（CD1/1CD）、词内词（Uncut/CUT）。 */
const _NAME_TOKEN_RE = /[A-Za-z0-9]+/g;
export function folderTokensIn(name: string, tokens: string[]): string | null {
  if (!name || !tokens.length) return null;
  const parts = new Set((name.match(_NAME_TOKEN_RE) || []).map((x) => x.toLowerCase()));
  for (const tok of tokens) {
    const t = String(tok).toLowerCase();
    if (t && parts.has(t)) return t;
  }
  return null;
}

/** 取扩展名（小写、无点）；无扩展名返回 "" */
export function folderExtOf(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

/** 是否视频扩展名（按规则 video_exts） */
export function folderIsVideo(name: string, rules: FolderScanRules): boolean {
  return rules.video_exts.includes(folderExtOf(name));
}

/**
 * 单视频判定：同目录 srt / 文件名标记 / 过小。
 * @param dirNames 同目录小写文件名集合（含自身）
 */
export function folderVideoMeta(
  name: string,
  size: number,
  dirNames: Set<string>,
  rules: FolderScanRules,
): FolderVideoMeta {
  const stem = name.replace(/\.[^.]+$/, "").toLowerCase();
  const subName = rules.subtitle_patterns
    .map((suffix) => stem + suffix)
    .find((candidate) => dirNames.has(candidate)) || null;
  let subToken = folderTokensIn(name, rules.has_sub_tokens);
  const noSubToken = folderTokensIn(name, rules.no_sub_tokens);
  if (subToken !== null && noSubToken !== null) subToken = null; // 双命中 → 无字幕优先（保守）
  return {
    sub_status: subName ? "external" : subToken ? "named" : "none",
    sub_name: subName,
    sub_token: subToken,
    no_sub_token: noSubToken,
    too_small: rules.min_size_mb > 0 && size < rules.min_size_mb * 1048576,
  };
}
