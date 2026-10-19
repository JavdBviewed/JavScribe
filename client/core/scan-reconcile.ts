// 扫描 × 已完成任务对账（0.2.47 需求 1）：已 done 且有结果的直播/远端任务未把字幕落盘时，
// 再「扫描目录」该影片会被当「无字幕」重复生成。对账命中 → 扫描项标「已生成未落盘」，
// 可一键用任务结果回写（不重跑生成）。纯函数模块（node 可单测，同 writeback.ts 形态）。
//
// 匹配口径（P0 同名误配的缓解，见 research/0247-plan.md）：
//   键 = 带扩展名 basename、小写。任务行优先级 local_path → label（须是视频名）→ file。
//   远端行 file 是内容寻址 hash（<sha1>.opus）——label 不是视频名时键=hash basename，
//   天然不会命中任何视频扫描项（hash 不误配）。

/** 与 app.ts VIDEO_EXT_RE / serve constants.VIDEO_EXTS 同口径 */
const VIDEO_EXT_RE = /\.(mp4|mkv|avi|mov|webm|flv|wmv|ts|m2ts|mpg|mpeg)$/i;

/** 对账参与的最小行形态（JobRow 的子集；_pending 派发子行同构） */
export interface ReconcilableRow {
  engine: string;
  status: string;
  job_id?: string | null;
  created?: number | null;
  local_path?: string | null;
  label?: string | null;
  file?: string | null;
}

/** 对账参与的最小扫描项形态 */
export interface ScanItemLike {
  name: string;
  has_subtitle: boolean;
}

const basename = (s: string): string => (s || "").replace(/.*[\\/]/, "");

/** 匹配键：带扩展名 basename 小写。优先级 local_path → label（视频名）→ file。
 *  返回 "" = 该行不可匹配（任何字段都没有可用文件名片）。 */
export function matchKeyOf(row: ReconcilableRow): string {
  const lp = basename(row.local_path || "");
  if (lp) return lp.toLowerCase();
  const lab = basename(row.label || "");
  if (lab && !String(row.label || "").startsWith("文件夹扫描") && VIDEO_EXT_RE.test(lab)) return lab.toLowerCase();
  const f = basename(row.file || "");
  return f ? f.toLowerCase() : "";
}

/** done 且有 job_id 行的索引：key -> 行。同键多行（重跑历史）取 created 最新（平手取后见者）。 */
export function buildDoneJobIndex(rows: readonly ReconcilableRow[]): Map<string, ReconcilableRow> {
  const idx = new Map<string, ReconcilableRow>();
  for (const r of rows) {
    if (!r || r.status !== "done" || !r.job_id) continue;
    const k = matchKeyOf(r);
    if (!k) continue;
    const cur = idx.get(k);
    if (!cur || (r.created ?? 0) >= (cur.created ?? 0)) idx.set(k, r);
  }
  return idx;
}

export interface ScanMatch {
  row: ReconcilableRow;
  key: string;
}

/** 扫描项命中「已生成未落盘」：仅 has_subtitle=false 参与，按自身 basename 小写查索引。 */
export function matchScanItem(item: ScanItemLike, index: Map<string, ReconcilableRow>): ScanMatch | null {
  if (!item || item.has_subtitle) return null;
  const k = basename(item.name).toLowerCase();
  if (!k) return null;
  const row = index.get(k);
  return row ? { row, key: k } : null;
}
