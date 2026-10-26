// 0.2.61：批量提交「进行中」查重——路径规范化 + 活跃判定 + 候选过滤纯逻辑。
// 零 DOM / localStorage / transport 依赖，node 可单测（client/tests/unit/dedup-active.test.mjs）。
//
// 背景：客户端同一视频路径提交批量任务时不查重「正在处理」的任务，重复入批产生
// 重复子任务（占队列、重复提音轨）。客户端内存态有三处「进行中」记录：
//   1. serve 任务行（ui/app.ts state._jobs，jobRows 展平）：file_path 对 /scan/submit
//      来源=源视频路径；对 /upload 来源=inbox 哈希路径（非源路径，不会与本机源路径
//      撞键误判，取并集无害）；
//   2. pending 派发链行（state._pending，提取/上传/入队链未落 serve 行前）：row.file_path
//      = createPendingRows 透传的 _localPath（web 形态 null）；
//   3. 派发账本（core/ledger，0.2.51 引入；0.2.57+ 条目带 file_path，旧数据 null）：
//      客户端重启后非终态迁移 interrupted（终态口径），在途条目仍是最后本地状态。
// 不变式：账本行永不写 state._jobs（app.ts 派发账本注释），三源取并集无冲突。
//
// 口径：仅「进行中」查重（pending/running/queued/paused 及提取上传链态）；
// done/skipped/error/canceled/interrupted 不查重（允许有意重跑，重跑按钮不受影响）。
// 无路径候选（web _localPath 空 / 旧账本无 file_path）不查重、不阻断（宁漏勿误杀）。

/** 源视频路径规范化：trim + 反斜杠归一为正斜杠；Windows（caseInsensitive）再小写。空串 → 空串。 */
export function normVideoPath(p: string | null | undefined, caseInsensitive: boolean): string {
  if (!p) return "";
  let s = String(p).trim().replace(/\\/g, "/");
  if (caseInsensitive) s = s.toLowerCase();
  return s;
}

/** serve 任务行 file 级终态（src/jav_scribe/core/task.py TaskStatus 的 TERMINAL_STATUSES 镜像）。 */
const SERVE_TERMINAL = new Set(["done", "skipped", "error", "canceled"]);

/** 客户端侧终态口径（账本 TERMINAL_LIKE 镜像：interrupted 视同终态）。 */
const CLIENT_TERMINAL = new Set(["done", "skipped", "error", "canceled", "interrupted"]);

/** 最小行结构（JobRow / LedgerChild 均满足；只读用到的字段） */
export interface DedupRow {
  file_path?: string | null;
  status?: string | null;
}

/**
 * serve 任务行是否「进行中」：file 状态非空且不在服务端终态集。
 * 反向口径（排除终态）而非正向白名单：serve 未来新增非终态自动视为活跃，
 * 不会漏判；job 级 paused / batch_paused 时 file 状态本就是 pending/running，无需单列。
 */
export function serveRowActive(r: DedupRow | null | undefined): boolean {
  if (!r || typeof r.status !== "string" || !r.status) return false;
  return !SERVE_TERMINAL.has(r.status);
}

/** 客户端行（pending 派发链 / 账本条目）是否「进行中」：状态非空且不在客户端终态集。 */
export function clientRowActive(r: DedupRow | null | undefined): boolean {
  if (!r || typeof r.status !== "string" || !r.status) return false;
  return !CLIENT_TERMINAL.has(r.status);
}

/**
 * 「进行中」源视频路径集（规范化键）：serve 行 ∪ 客户端行。
 * @param serveRows  serve 任务行（state._jobs；file_path 可含 inbox 哈希路径，见头注）
 * @param clientRows pending 派发链行 ∪ 账本条目（core/ledger LedgerChild）
 * @param caseInsensitive  Windows 路径大小写不敏感（调用方按 UA 判定后传入）
 */
export function activeVideoPathSet(opts: {
  serveRows: readonly DedupRow[];
  clientRows: readonly DedupRow[];
  caseInsensitive: boolean;
}): Set<string> {
  const out = new Set<string>();
  const addIfActive = (r: DedupRow | null | undefined, active: (x: DedupRow) => boolean): void => {
    if (!r || !active(r) || !r.file_path) return;
    const n = normVideoPath(r.file_path, opts.caseInsensitive);
    if (n) out.add(n);
  };
  for (const r of opts.serveRows) addIfActive(r, serveRowActive);
  for (const r of opts.clientRows) addIfActive(r, clientRowActive);
  return out;
}

/**
 * 候选过滤：返回 kept / skipped（skipped=命中进行中集），保持输入顺序。
 * 无路径候选（空串）恒 kept——不查重、不阻断。
 */
export function splitActiveDuplicates(
  paths: readonly string[],
  active: Set<string>,
  caseInsensitive: boolean,
): { kept: string[]; skipped: string[] } {
  const kept: string[] = [];
  const skipped: string[] = [];
  for (const p of paths) {
    const n = normVideoPath(p, caseInsensitive);
    if (n && active.has(n)) skipped.push(p);
    else kept.push(p);
  }
  return { kept, skipped };
}
