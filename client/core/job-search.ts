// 字幕任务页搜索（0.2.47 需求 2）：按 文件名 / 任务 id 小写子串过滤。
// 纯函数模块（node 可单测）：主名计算从 app.ts 行渲染抽出——远端/上传任务 file 是
// opus 内容寻址 hash，label 才是原始视频名（hash 泄漏进任务表即 F2 投诉）。
// 抽出后行渲染与搜索共用同一口径，避免两处漂移。

/** 与 app.ts VIDEO_EXT_RE / serve constants.VIDEO_EXTS 同口径 */
const VIDEO_EXT_RE = /\.(mp4|mkv|avi|mov|webm|flv|wmv|ts|m2ts|mpg|mpeg)$/i;

export interface SearchableRow {
  file?: string | null;
  label?: string | null;
  job_id?: string | null;
  task_id?: string | null;
}

const basename = (s: string): string => (s || "").replace(/.*[\\/]/, "");

/** label 的 basename 是否可当主名（真实视频名，非「文件夹扫描」批标占位、非 file 同值） */
export function jobLabelMain(j: SearchableRow): boolean {
  const labBase = basename(j.label || "");
  return !!j.label && !j.label.startsWith("文件夹扫描") && labBase !== j.file && VIDEO_EXT_RE.test(labBase);
}

/** 行显示主名：label 是视频名 → 用它；否则 file（本地任务 file 即真实路径/名） */
export function jobPrimaryName(j: SearchableRow): string {
  return jobLabelMain(j) ? basename(j.label || "") : (j.file || "");
}

/** 搜索命中：term 是 主名 / file / job_id / task_id 任一的小写子串（term 已 trim 非空） */
export function matchJobSearch(j: SearchableRow, term: string): boolean {
  const t = (term || "").toLowerCase();
  if (!t) return true;
  const cands = [jobPrimaryName(j), j.file || "", j.job_id || "", j.task_id || ""].map((s) => String(s).toLowerCase());
  return cands.some((s) => s && s.includes(t));
}
