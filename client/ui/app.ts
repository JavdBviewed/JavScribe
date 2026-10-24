// 字幕工作台前端主逻辑（web / desktop 共享 UI 层）。
// 由 static/app.js 机械迁移 + 类型标注，行为 1:1（回归基线：client/tests/e2e 四类套件）。
// 网络请求全部走 transport 接口（web 形态实现见 transport-web）。

import type { Transport } from "../core/transport";
import { LOCAL_SUB_PATTERNS, SRT_SUFFIX, VIDEO_EXTS } from "../core/constants";
import type { BatchRecord, BulkResult, ClientConfig, ConfigItem, Engine, EngineMetrics, JobRow, JobSummary, MetricsResponse, ReadinessPayload, ScanItem, ScanResult, ScanTaskSnapshot, ServeRelease, UpdateInfo, UploadStatus } from "../core/types";
import type { AudioCacheHit, LocalServeState, UpdateSettings, UpdateState, WatchCandidate, WatchState } from "../core/desktop-bridge";
import type { FolderFile, FolderVideo, PlatformAdapter, WriteBackInfo } from "../core/platform";
import type { JavExtractAPI } from "./extract";
import { canStartInFlight, CLIENT_CFG_DEFAULTS, countInFlightRows, ExtractAbortError, freeVramGb, isVramExcluded, normalizeClientConfig, pickAutoEngine } from "../core/concurrency";
import { folderIsVideo, folderVideoMeta, type FolderScanRules } from "../core/folder-scan";
import { pickWriteBackRows } from "../core/writeback";
import { diskKeyOf } from "../core/disk-key";
import { folderGroupLabel, groupByDisk, multiGroupLabel } from "../core/disk-split";
import { buildDoneJobIndex, matchScanItem, type ReconcilableRow } from "../core/scan-reconcile";
import { CLEANUP_CATS, INTERRUPTED, TERMINAL_LIKE, LEDGER_STORE_KEY, cleanupCatOf, childFromPendingRow, migrateInterrupted, normalizeChild, pendingFingerprint, pruneLedger, type LedgerChild } from "../core/ledger";
import { jobLabelMain, jobPrimaryName, matchJobSearch } from "../core/job-search";
import { TransportError } from "../core/transport";
import { $, esc } from "./dom";
import { toast } from "./toast";
import { fmtSrtSpan, fmtSrtTime, parseSrt, type SrtCue, type SrtParseResult } from "../core/srt";

const DEFAULT_TITLE = "JavScribe 字幕工作台";

/** 派发「行优先」pending 子行（纯 renderer 记账；serve 真行出现即让位删除） */
interface PendingDispatch {
  row: JobRow;                 // pending 行本体（渲染时并入行集，不写 state._jobs）
  pkey: string;                // 稳定行 key
  started: boolean;            // 链已到阶段回调（行 running/上传/已入队；不含提取池等槽期）
  dispatched: boolean;         // 链已派发（startNext 已调 dispatchTracked；覆盖提取池等槽——started 不覆盖此态）
  enqueuedAt: number | null;   // 已入队时刻（serve 行迟迟不可见时的让位兜底）
  aborted: boolean;            // 主任务取消：链跑完当前阶段也不再提交服务（行标「跳过」）
}

interface AppState {
  file: File | null;
  folderFiles: FolderVideo[] | null;
  folderChecked: Set<string>;      // 文件夹待选表勾选项（key=rel；有字幕/过小默认不勾，与扫描表同口径）
  folderPage: number;              // 文件夹待选表当前页（0 起；勾选态全局维护，与翻页互不影响）
  folderGen: number;               // 文件夹选择代际号（setFolder/clearFolder 用户动作递增；批次收尾按代际决定是否清 UI，防已完批误清中途新选文件夹）
  fileDispatching: boolean;        // 单文件在途标记（startSingle 派发置位 / finishDispatch 清位；防批次并行期单文件二次提交）
  filter: string;
  source: string;                  // 任务来源筛选：all / local（本机派发）/ serve（他端任务）
  busy: boolean;
  knownJobs: Map<string, string>;
  retried: Set<string>;
  engines: Engine[];
  cfgItems: ConfigItem[];
  scanItems: ScanItem[];
  scanMapped: boolean;
  scanResolvedPath: string;
  scanChecked: Set<string>;
  scanPage: number;          // 扫描列表当前页（0 起；勾选态全局维护，与翻页互不影响）
  scanFilter: "all" | "no-sub" | "has-sub" | "small" | "unwritten"; // 分类 tab 过滤（all 恒可用；勾选态跨 tab 全局）
  scanDoneIndex: Map<string, ReconcilableRow>; // 扫描×已完成任务对账索引（每次 refresh 重建；「已生成未落盘」标记用）
  jobSearch: string; // 任务页搜索词（内存态，不持久化；留空=全量）
  scanPageSize: number;      // 扫描列表每页行数（10/20/50/100/500 档，localStorage 持久化，默认 10）
  lastScan: ScanResult | null; // 最近一次扫描结果（翻页重渲染用，免重发请求）
  scanTask: ScanTaskSnapshot | null; // 后台扫描任务（web 形态刷新后可恢复）
  page: number;              // 任务分页：当前页（0 起）
  pageSize: number;          // 任务分页：每页行数（10/20/50/100/500 档，localStorage 持久化，默认 10）
  _jobs: JobRow[];           // 最近一次 /api/jobs 结果（翻页/筛选即时重渲染，不等网络）
  _pending: Map<string, PendingDispatch>; // 派发「行优先」pending 子行（key=pkey；不进 _jobs，防在途双算）
  _summary: JobSummary | null; // 最近一次 /api/jobs/summary（serve 累计口径；null=回退行计数）
  _jobActive: Map<string, boolean>; // engine|job_id -> 该任务是否有文件运行中（单任务挂起可用性）
  selected: Set<string>;                     // 勾选的任务行 key（批量操作）
  _filteredKeys: string[];                   // 当前筛选下的全部行 key（表头全选/半选态）
  _metrics: Record<string, MetricsResponse>; // 引擎名 -> 监控快照（卡片迷你趋势图）
  _batches: BatchRecord[];          // 最近一次主任务（batch）记录（t.listBatches；过期主任务对账兜底行）
  _batchCollapsed: Set<string>;     // 收起的主任务 batch_id（默认展开；内存态，刷新重置）
  _entryCount: number;              // 筛选后顶层条目数（分页口径：batch 组按 1 条计）
  latestServe: ServeRelease | null;   // 最新服务端 Release（服务端无界面，新版本提示落在卡片角标）
  extractMode: "auto" | "local" | "server";
  ccfg: ClientConfig | null;    // S4：客户端并发设置（热重载：refresh 读回 + 本端保存即时应用）
  autoSave: boolean;
  writeBackJobs: Map<string, WriteBackInfo>; // jobKey(engine|job_id) -> { engine, videoName, dirHandle|null }
  watchWriteBack: Set<string>;          // 本地源派发任务完成后强制写回（不受 autoSave 门控；desktop：watch/扫描/选择文件夹/单文件/换服务重跑）
  _fsFileDir: FileSystemDirectoryHandle | null; // 当前单文件所选目录句柄（File System Access API，用于写回源目录）
}

const savedExtract = localStorage.getItem("javweb_extract");

// 分页档位（任务表与扫描表共用）：默认 10，用户可在分页器上切换并持久化
const PAGE_SIZES: number[] = [10, 20, 50, 100, 500];
const PAGE_SIZE_OPTS = PAGE_SIZES.map((n) => `<option value="${n}">${n} / 页</option>`).join("");
function readPageSize(key: string): number {
  const v = Number(localStorage.getItem(key));
  return PAGE_SIZES.includes(v) ? v : 10;
}

const state: AppState = {
  file: null,
  folderFiles: null,
  folderChecked: new Set(),
  folderPage: 0,
  folderGen: 0,
  filter: "all",
  source: "all",
  busy: false,
  fileDispatching: false,
  knownJobs: new Map(),
  retried: new Set(),
  engines: [],
  cfgItems: [],
  scanItems: [],
  scanMapped: false,
  scanResolvedPath: "",
  scanChecked: new Set(),
  scanPage: 0,
  scanFilter: "all",
  scanDoneIndex: new Map(),
  jobSearch: "",
  scanPageSize: readPageSize("javweb_scan_pagesize"),
  lastScan: null,
  scanTask: null,
  page: 0,
  pageSize: readPageSize("javweb_jobs_pagesize"),
  _jobs: [],
  _pending: new Map(),
  _summary: null,
  _jobActive: new Map(),
  selected: new Set(),
  _filteredKeys: [],
  _metrics: {},
  _batches: [],
  _batchCollapsed: new Set(),
  _entryCount: 0,
  latestServe: null,
  extractMode: savedExtract === "auto" || savedExtract === "local" || savedExtract === "server"
    ? savedExtract
    : "auto",
  autoSave: localStorage.getItem("javweb_autosave") === "1",
  ccfg: null,
  writeBackJobs: new Map(),
  watchWriteBack: new Set(),
  _fsFileDir: null,
};

// e2e 的 waitForEngineKey 通过 page.waitForFunction 按名读 state：
// 经典脚本时代顶层 const 是全局词法绑定，模块化后显式挂 window（无其它行为影响）
(window as unknown as { state: AppState }).state = state;

// ---------- 写回登记持久化（10-17-javscribe-0242-batch-bugs B） ----------
// 背景：writeBackJobs / watchWriteBack 原是纯内存态，客户端重启即丢登记 →
// 批量提交后关过客户端，子任务完成时重启首见的 done 行无登记 → pickWriteBackRows
// 永不命中 → 字幕永不写回，只能人工逐个下载。
// 策略：localStorage 持久化；启动读回；refresh 对账「登记超宽限期且服务/pending 行
// 均不可见」（job 已从服务端窗口过期）→ 丢弃（过期 job 本就不可下载）。
const WB_STORE_KEY = "javweb_writeback_v1";
const WB_PRUNE_GRACE_MS = 10 * 60 * 1000; // 新登记宽限：服务行可能尚未轮到轮询
const wbAt = new Map<string, number>(); // key -> 登记时刻（剪枝宽限用）
function loadWriteBackStore(): void {
  try {
    const raw = localStorage.getItem(WB_STORE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw) as { jobs?: [string, { info?: unknown; at?: number }][]; forced?: string[] };
    for (const [k, e] of d.jobs || []) {
      const info = e?.info as WriteBackInfo | undefined;
      if (k && info && typeof info.engine === "string" && typeof info.videoName === "string") {
        info.dirHandle = null; // 目录句柄不可序列化；desktop 写回走 videoPath
        state.writeBackJobs.set(k, info);
        wbAt.set(k, Number(e?.at) || Date.now());
      }
    }
    for (const k of d.forced || []) if (typeof k === "string") state.watchWriteBack.add(k);
  } catch { /* 登记损坏按空处理，refresh 剪枝兜底 */ }
}
// desktop：main 进程磁盘镜像钩子（initApp 注入；renderer localStorage 异步落盘，SIGKILL 丢最后一次写入）
let wbMirrorSave: ((json: string) => void) | null = null;
function saveWriteBackStore(): void {
  let json = "";
  try {
    json = JSON.stringify({
      jobs: [...state.writeBackJobs.keys()].map((k) => [k, { info: state.writeBackJobs.get(k), at: wbAt.get(k) || Date.now() }]),
      forced: [...state.watchWriteBack],
    });
    localStorage.setItem(WB_STORE_KEY, json);
  } catch { /* 持久化失败不影响内存登记（本会话仍有效） */ }
  if (json) { try { wbMirrorSave?.(json); } catch { /* 镜像失败不影响内存登记 */ } }
}
// 预登记（10-17-javscribe-0242-batch-bugs B 收口）：派发时刻（上传请求发出前）先按临时键
// engine|pre|<视频名> 持久化登记；job 真实受理后再 rekey 为正式键 engine|job_id（真实登记点
// 先 rekey 后 registerWriteBack 覆盖 info）；若中间客户端被杀，重启后 refresh 的
// bindPreRegistrations 按 serve 真行（job_id + 视频名）补 rekey。点完生成 1s 内关客户端
// 首文件登记不再丢失。
// 安全：正式键不含 |pre|，pickWriteBackRows 永不命中 pre 键提前写回；未获得 job 的 pre 键
// （派发失败/取消）永不进 prune live 集，10 分钟宽限后自然剪除。
function preKeyOf(engine: string, videoName: string): string {
  return engine + "|pre|" + videoName;
}
function rekeyWriteBack(oldKey: string, newKey: string): void {
  if (oldKey === newKey || !state.writeBackJobs.has(oldKey)) return;
  const info = state.writeBackJobs.get(oldKey)!;
  state.writeBackJobs.set(newKey, info);
  wbAt.set(newKey, wbAt.get(oldKey) || Date.now());
  state.writeBackJobs.delete(oldKey);
  wbAt.delete(oldKey);
  if (state.watchWriteBack.has(oldKey)) {
    state.watchWriteBack.delete(oldKey);
    state.watchWriteBack.add(newKey);
  }
}
// 预登记绑定：refresh 每轮、prune 之前调。serve 真行（带 job_id）视频名在 file（本地上传 /
// mock）或 label（生产 opus hash 行）→ 临时键 rekey 为 engine|job_id（强制写回集随迁）。
function bindPreRegistrations(rows: readonly { engine: string; job_id?: string | null; file?: string | null; label?: string | null }[]): void {
  let changed = false;
  for (const k of [...state.writeBackJobs.keys()]) {
    const i = k.indexOf("|pre|");
    if (i < 0) continue;
    const engine = k.slice(0, i);
    const videoName = k.slice(i + 5); // "|pre|" 长度
    const row = rows.find((r) => r.job_id && r.engine === engine
      && ((r.file && r.file === videoName) || (r.label && r.label === videoName)));
    if (!row) continue;
    rekeyWriteBack(k, engine + "|" + row.job_id);
    changed = true;
  }
  if (changed) saveWriteBackStore();
}
function pruneWriteBackStore(): void {
  const live = new Set<string>();
  for (const r of state._jobs) if (r.job_id) live.add(r.engine + "|" + r.job_id);
  for (const p of state._pending.values()) if (p.row.job_id) live.add(p.row.engine + "|" + p.row.job_id);
  const now = Date.now();
  let changed = false;
  for (const k of [...state.writeBackJobs.keys()]) {
    if (live.has(k)) continue;
    if (now - (wbAt.get(k) || now) < WB_PRUNE_GRACE_MS) continue;
    state.writeBackJobs.delete(k);
    state.watchWriteBack.delete(k);
    wbAt.delete(k);
    changed = true;
  }
  if (changed) saveWriteBackStore();
}
// 写回登记兜底（10-17-javscribe-0242-batch-bugs B）：renderer localStorage 异步落盘，SIGKILL 丢
// 最后一次写入 → 启动读 main 进程磁盘镜像（writeback.json）合并灌回内存（内存已有 key 优先）。
// 须在 initApp 内调（transport 就绪后才走 IPC）；正常退出 localStorage 完整，合并为空操作。
async function hydrateWriteBackMirror(t: Transport): Promise<void> {
  if (typeof t.loadWriteBackMirror !== "function") return;
  try {
    const raw = await t.loadWriteBackMirror();
    if (!raw) return;
    const d = JSON.parse(raw) as { jobs?: [string, { info?: unknown; at?: number }][]; forced?: string[] };
    let added = 0;
    for (const [k, e] of d.jobs || []) {
      const info = e?.info as WriteBackInfo | undefined;
      if (!k || state.writeBackJobs.has(k)) continue;
      if (!info || typeof info.engine !== "string" || typeof info.videoName !== "string") continue;
      info.dirHandle = null; // 目录句柄不可序列化；desktop 写回走 videoPath
      state.writeBackJobs.set(k, info);
      wbAt.set(k, Number(e?.at) || Date.now());
      added++;
    }
    for (const k of d.forced || []) if (typeof k === "string") state.watchWriteBack.add(k);
    if (added) saveWriteBackStore(); // 回填 localStorage，后续会话不再依赖镜像
  } catch { /* 镜像损坏/缺失按无处理，refresh 剪枝兜底 */ }
}
loadWriteBackStore();

// ---------- 派发账本（0.2.51）：批量派发子行账本 ----------
// 背景：行优先 pending 子行纯 renderer 内存（state._pending），客户端中途退出后主任务的
// 子行/状态全丢；服务端 200 内存窗 + jobs.json（仅恢复终态）也会挤丢非终态任务。
// 账本 = pkey → 最后已知子行状态，持久化 localStorage（desktop 另加 main 进程磁盘镜像
// ledger.json 防 SIGKILL）。refresh 每轮与 /jobs 双向校准：
//   同 job_id 服务端行可见 → 服务端状态优先（不出账本行，不双行）；
//   服务端已忘（窗挤出 / serve 重启丢非终态）→ 出账本行（最后本地状态 + 「本地记录」标）；
//   子行带 batch_id/batch_label → 父子分组由账本供给（子行全过期时主任务行仍可见）。
// 不变式：账本行永不写 state._jobs（在途封顶 countInFlightRows 维持 serve-only，见 L1591）。
const ledger: { v: 1; children: Record<string, LedgerChild>; suppress: string[] } =
  { v: 1, children: {}, suppress: [] };
let ledgerMirrorSave: ((json: string) => void) | null = null;
const ledgerFinger = new Map<string, string>(); // pkey -> 上次落盘指纹（transition 才写盘）

function loadLedgerStore(): void {
  try {
    const raw = localStorage.getItem(LEDGER_STORE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw) as { v?: number; children?: Record<string, Partial<LedgerChild>>; suppress?: unknown };
    if (!d || d.v !== 1 || !d.children) return;
    for (const [k, c] of Object.entries(d.children)) {
      if (!k) continue;
      const n = normalizeChild(c, Date.now());
      if (n) ledger.children[k] = n;
    }
    if (Array.isArray(d.suppress)) {
      for (const s of d.suppress) if (typeof s === "string" && s) ledger.suppress.push(s);
    }
  } catch { /* 账本损坏按空处理（宁缺勿错；派发链运行期重建） */ }
}

function saveLedgerStore(): void {
  let json = "";
  try {
    json = JSON.stringify(ledger);
    localStorage.setItem(LEDGER_STORE_KEY, json);
  } catch { /* 持久化失败不影响内存账本（本会话仍有效） */ }
  if (json) { try { ledgerMirrorSave?.(json); } catch { /* 镜像失败不影响内存账本 */ } }
}

/** 账本剪枝：TTL（14 天）+ 条数上限（终态最旧优先）；剪枝本身触发落盘（0.2.57 逻辑抽至 core/ledger） */
function ledgerPrune(): void {
  if (pruneLedger(ledger.children, ledger.suppress, Date.now())) saveLedgerStore();
}

/** 账本同步（幂等）：仅 transition（status/phase/job_id/engine/终态时刻）落盘；进度 tick 不写 */
function ledgerSyncPending(p: PendingDispatch): void {
  const r = p.row;
  const fin = pendingFingerprint({ status: r.status, phase: r.phase ?? null, job_id: r.job_id ?? null,
    engine: r.engine, finished: r.finished ?? null, aborted: p.aborted });
  if (ledgerFinger.get(p.pkey) === fin) return;
  ledgerFinger.set(p.pkey, fin);
  ledger.children[p.pkey] = childFromPendingRow(r, Date.now());
  ledgerPrune();
  saveLedgerStore();
}

function ledgerRemove(key: string): void {
  if (key in ledger.children) {
    delete ledger.children[key];
    ledgerFinger.delete(key);
    saveLedgerStore();
  }
}

function ledgerAddSuppress(keys: string[]): void {
  if (!keys.length) return;
  for (const k of keys) {
    if (k && !ledger.suppress.includes(k)) ledger.suppress.push(k);
  }
  saveLedgerStore();
}

/** 账本恢复行：服务端同 job_id 行可见 → 跳过（服务端优先，不双行）；
 *  同 pkey 的 live pending 行在场 → 跳过（行池 jobKey 相同会碰撞，live 行被账本行覆盖、
 *  进度/阶段冻结在账本最后一次 transition——在途批次视觉丢失实时状态）；
 *  已清理（suppress）→ 跳过；否则按最后本地状态出参考行（非终态带「本地记录」提示） */
function ledgerRows(jobs: readonly JobRow[]): JobRow[] {
  if (!Object.keys(ledger.children).length) return [];
  const visible = new Set<string>();
  for (const r of jobs) if (r.job_id) visible.add(String(r.job_id));
  const livePkeys = new Set<string>(state._pending.keys());
  const out: JobRow[] = [];
  for (const [pkey, c] of Object.entries(ledger.children)) {
    if (livePkeys.has(pkey)) continue;
    if (c.job_id) {
      if (visible.has(c.job_id)) continue;
      if (ledger.suppress.includes(c.engine + "|" + c.job_id)) continue;
    }
    const interrupted = c.status === INTERRUPTED;
    const note = interrupted
      ? (c.interrupted_reason || "客户端重启，任务链路断开")
      : (TERMINAL_LIKE.has(c.status) ? "" : "本地记录（服务端记录不可用，显示最后本地状态）");
    out.push({
      engine: c.engine,
      job_id: c.job_id,
      label: c.videoName,
      file: c.videoName,
      status: c.status,
      progress: c.progress,
      position: c.message,
      phase_detail: c.message,
      message: note,
      created: c.created,
      // 中断行：「完成于」列显中断时刻
      finished: interrupted ? (c.interrupted_at ?? c.finished) : c.finished,
      batch_id: c.batch_id,
      batch_label: c.batch_label,
      pkey,
      ledger: true,
      file_path: c.file_path || null,
    });
  }
  return out;
}

/** refresh 每轮：双向校准的剪枝侧——suppress 自愈（非终态 serve 行复活 → 解除抑制）+ TTL/上限剪枝 */
function reconcileLedger(jobs: readonly JobRow[]): void {
  let supChanged = false;
  if (ledger.suppress.length) {
    for (const r of jobs) {
      if (!r.job_id || TERMINAL_LIKE.has(r.status)) continue;
      const k = r.engine + "|" + String(r.job_id);
      const i = ledger.suppress.indexOf(k);
      if (i >= 0) { ledger.suppress.splice(i, 1); supChanged = true; }
    }
  }
  if (supChanged) saveLedgerStore();
  ledgerPrune();
}

// desktop：main 进程磁盘镜像钩子（initApp 注入；renderer localStorage 异步落盘，SIGKILL 丢最后一次写入）
async function hydrateLedgerMirror(t: Transport): Promise<void> {
  if (typeof t.loadLedgerMirror !== "function") return;
  try {
    const raw = await t.loadLedgerMirror();
    if (!raw) return;
    const d = JSON.parse(raw) as { v?: number; children?: Record<string, Partial<LedgerChild>>; suppress?: unknown };
    if (!d || d.v !== 1) return;
    let added = 0;
    if (d.children) {
      for (const [k, c] of Object.entries(d.children)) {
        if (ledger.children[k]) continue; // 内存（localStorage）已有优先
        const n = normalizeChild(c, Date.now());
        if (!n) continue;
        ledger.children[k] = n;
        added++;
      }
    }
    if (Array.isArray(d.suppress)) {
      for (const s of d.suppress) if (typeof s === "string" && s && !ledger.suppress.includes(s)) ledger.suppress.push(s);
    }
    if (added) saveLedgerStore(); // 回填 localStorage，后续会话不再依赖镜像
  } catch { /* 镜像损坏/缺失按无处理 */ }
}

loadLedgerStore(); // 启动读回账本（localStorage 同步读，无需 transport）
// 0.2.57：客户端重启即在途必丢（serve 重启只恢复终态）→ 账本非终态条目统一落「中断」，
// 不再渲染成「运行中 0%」僵尸行（可重跑/可清除；幂等，二次迁移 0 改动）
if (migrateInterrupted(ledger.children, Date.now(), "客户端重启，任务链路断开")) saveLedgerStore();

const PLANE_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;

const STATUS_ZH: Record<string, string> = {
  running: "运行中", done: "完成", error: "失败",
  skipped: "跳过", canceled: "已取消", pending: "排队", paused: "已暂停",
  unsubmitted: "未提交", // F4 占位行（客户端异常退出前已提取未提交）
  interrupted: "中断", // 0.2.57：客户端退出/重启后在途任务落此态（可重跑/可清除）
};

function fmtDuration(s: number | null | undefined): string {
  if (s == null || !isFinite(s) || s < 0) return "";
  const v = Math.round(s);
  const h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), ss = v % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

/** 兼容服务端 Unix 秒与桌面端 Date.now() 毫秒，统一转换为 Unix 秒。 */
function timestampSeconds(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n >= 10_000_000_000 ? n / 1000 : n;
}

function fmtJobDateTime(value: number | string | null | undefined): string {
  const seconds = timestampSeconds(value);
  if (seconds == null) return "";
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} `
    + `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** 人类可读尺寸（F6：原 mb() 四舍五入，<1MB 一律显「0 MB」）：B / KB / MB(整数) / GB(1 位) */
function fmtSize(b: number): string {
  const n = isFinite(b) && b >= 0 ? b : 0;
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  if (n < 1073741824) return `${Math.round(n / 1048576)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}
/** MB 精度尺寸的展示：服务端 audio_mb/size_mb 按 0.1MB（web）或 1MB（desktop 旧口径）舍入，
 *  小文件会舍成 0.0（非 null）——直接换字节会误显「0 B」→ 统一兜底「<1 MB」（真上界，两种口径都成立） */
function mbText(mb: number | null | undefined): string {
  if (mb == null) return "";
  if (mb <= 0) return "<1 MB";
  return fmtSize(mb * 1048576);
}

// 下载/写回统一命名：<源视频名>.zh.srt（与服务端落盘、写回源目录一致）
// 优先用 label（上传时 X-Source-Name 的原始视频名；扫描任务 label 为「文件夹扫描 · N 项」，退回 file 路径）。
// 兜底链里任何一环若是 40 位内容寻址 hash（音轨 opus 的 sha1 文件名，非可读名）则弃用，
// 最终退回任务 id（与服务端 _result_disposition 的同款守卫，杜绝 hash 名泄漏到下载文件名）。
const HASH_RE = /^[0-9a-f]{40}$/i;
function cleanStem(s: string | null | undefined): string {
  const base = (s || "").replace(/.*[\\/]/, ""); // 取文件名（win 反斜杠 / posix 斜杠）
  const stem = base.replace(/\.[^.]+$/, "");      // 去扩展名
  return stem && !HASH_RE.test(stem) ? stem : "";
}
// 与 serve constants.VIDEO_EXTS 对齐：file 带这些扩展名时说明它是真实影片路径（本地任务），
// 远端任务的 file 则是 inbox 内容寻址名（<sha1>.opus / <sha1>.mp4）
const VIDEO_EXT_RE = /\.(mp4|mkv|avi|mov|webm|flv|wmv|ts|m2ts|mpg|mpeg)$/i;
/** 与影片同目录的字幕完整路径（扫描项 subtitle 只存文件名） */
function siblingOf(videoPath: string, name: string): string {
  const idx = Math.max(videoPath.lastIndexOf("/"), videoPath.lastIndexOf("\\"));
  return (idx >= 0 ? videoPath.slice(0, idx + 1) : "") + name;
}

function srtNameFor(j: JobRow): string {
  // 兜底链（任何一环是 40 位内容寻址 hash 则弃用）：
  // ① 本地任务（扫描/监听/本地直传）：file 即真实影片路径 → 最可信
  // ② 远端任务：label = 上传时的原始视频名（X-Source-Name；须带视频扩展名，"remote" 等占位值不可用）
  // ③ file 的任意可读名 → 任务 id（与服务端 _result_disposition 同款守卫）
  const fileStem = cleanStem(j.file);
  const stem =
    (fileStem && VIDEO_EXT_RE.test(j.file || "") ? fileStem : "") ||
    (j.label && !j.label.startsWith("文件夹扫描") && VIDEO_EXT_RE.test(j.label)
      ? cleanStem(j.label) : "") ||
    fileStem ||
    (j.job_id ? String(j.job_id) : "subtitle");
  return stem + SRT_SUFFIX;
}

function jav(): JavExtractAPI | undefined {
  return (window as { JavExtract?: JavExtractAPI }).JavExtract;
}

export function initApp(t: Transport, platform: PlatformAdapter): void {
  // 写回登记镜像（B）：注入 main 磁盘镜像钩子 + 启动兜底读回（SIGKILL 丢 localStorage 最后一次写入）
  wbMirrorSave = (json) => { t.saveWriteBackMirror?.(json); };
  void hydrateWriteBackMirror(t);
  // 派发账本镜像（0.2.51）：同 WB 语义
  ledgerMirrorSave = (json) => { t.saveLedgerMirror?.(json); };
  // 0.2.57：镜像可能带回非终态条目（localStorage 丢写时的磁盘兜底）→ 合并后再跑一遍中断迁移
  void hydrateLedgerMirror(t).then(() => {
    if (migrateInterrupted(ledger.children, Date.now(), "客户端重启，任务链路断开")) {
      saveLedgerStore();
      renderJobs(state._jobs);
    }
  });
  // 0.2.57：刷新/关闭即链路断开——非终态 pending/账本行立即落「中断」（下次会话不再出僵尸行）
  window.addEventListener("pagehide", () => {
    if (migrateInterrupted(ledger.children, Date.now(), "客户端退出，任务链路断开")) saveLedgerStore();
  });
  // ---------- 静态表单元素句柄（HTML 固定节点，轮询不重建，取一次即可） ----------
  const engineSelect = $("engine-select") as HTMLSelectElement;
  const engineName = $("engine-name") as HTMLInputElement;
  const engineUrl = $("engine-url") as HTMLInputElement;
  const engineKey = $("engine-key") as HTMLInputElement;
  const engineForm = $("engine-form") as HTMLFormElement;
  const drop = $("drop") as HTMLDivElement;
  const fileInput = $("file") as HTMLInputElement;
  const folderInput = $("folder") as HTMLInputElement;
  const pickFolder = $("pick-folder") as HTMLButtonElement;
  const folderX = $("folder-x") as HTMLButtonElement;
  const chipX = $("chip-x") as HTMLButtonElement;
  const dispatchGo = $("dispatch-go") as HTMLButtonElement;
  const extractSelect = $("extract-select") as HTMLSelectElement;
  const autosave = $("autosave") as HTMLInputElement;
  const scanPath = $("scan-path") as HTMLInputElement;
  if (platform.kind === "desktop") scanPath.placeholder = "本机绝对路径（如 D:\\Videos 或 /media/jav）";
  const scanGo = $("scan-go") as HTMLButtonElement;
  const scanSubmit = $("scan-submit") as HTMLButtonElement;
  // 0.2.53 需求③：「本机提并发」框跟随 scan-submit 显隐（初始无扫描结果时占 0 高度，布局零漂移）
  const scanWorkersCtl = $("scan-extract-workers-ctl") as HTMLLabelElement;
  const setScanSubmitHidden = (v: boolean): void => { scanSubmit.hidden = v; scanWorkersCtl.hidden = v; };
  const scanSelectAll = $("scan-select-all") as HTMLInputElement;
  const scanTaskStatus = $("scan-task-status") as HTMLElement | null;
  const scanTaskText = $("scan-task-text") as HTMLElement | null;
  const scanTaskPause = $("scan-task-pause") as HTMLButtonElement | null;
  const scanTaskCancel = $("scan-task-cancel") as HTMLButtonElement | null;
  const line1 = $("line-1");
  const line2 = $("line-2");
  const jobPager = $("job-pager");
  const jobList = $("job-list");

  // ---------- 效果速览 demo：内置日语示例音频 → 中文字幕（可折叠 + 试听 + 字幕点亮） ----------
  const demoCard = $("demo-card") as HTMLDivElement | null;
  const demoBody = $("demo-body") as HTMLDivElement | null;
  const demoToggle = $("demo-toggle") as HTMLButtonElement | null;
  const demoAudio = $("demo-audio") as HTMLAudioElement | null;
  const demoPlay = $("demo-play") as HTMLButtonElement | null;
  const demoTime = $("demo-time") as HTMLSpanElement | null;
  if (demoCard && demoBody && demoToggle && demoAudio && demoPlay && demoTime) {
    const fmtDT = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    const demoSync = () => {
      const total = Number.isFinite(demoAudio.duration) && demoAudio.duration > 0 ? demoAudio.duration : 3.1;
      demoTime.textContent = `${fmtDT(demoAudio.currentTime)} / ${fmtDT(total)}`;
      demoCard.classList.toggle("playing", !demoAudio.paused && !demoAudio.ended);
      demoPlay.innerHTML = demoAudio.paused
        ? (demoAudio.ended ? "&#8635; 重听" : "&#9654; 试听")
        : "&#9208; 暂停";
    };
    // 默认收起（不常驻首页），展开状态记忆；收起时停播并回卷
    const setDemoOpen = (open: boolean) => {
      demoBody.hidden = !open;
      demoCard.classList.toggle("open", open);
      demoToggle.setAttribute("aria-expanded", String(open));
      try { localStorage.setItem("javweb_demo_open", open ? "1" : "0"); } catch { /* 忽略 */ }
    };
    let demoOpenInit = false;
    try { demoOpenInit = localStorage.getItem("javweb_demo_open") === "1"; } catch { /* 忽略 */ }
    setDemoOpen(demoOpenInit);
    demoToggle.onclick = () => {
      // 当前收起（hidden=true）→ 点击后目标展开（open=true）；hidden 布尔值本身就是目标开合态
      const open = Boolean(demoBody.hidden);
      if (!open) { demoAudio.pause(); demoAudio.currentTime = 0; }
      setDemoOpen(open);
      demoSync();
    };
    demoPlay.onclick = () => {
      if (demoAudio.paused) {
        if (demoAudio.ended) demoAudio.currentTime = 0;
        demoAudio.play().catch(() => toast("示例音频播放失败（浏览器自动播放策略可能拦截，点一次重试）", "err"));
      } else {
        demoAudio.pause();
      }
      demoSync();
    };
    for (const ev of ["timeupdate", "play", "pause", "ended", "loadedmetadata"] as const) {
      demoAudio.addEventListener(ev, demoSync);
    }
  }

  // 桌面端的「客户端部署机」就是当前这台电脑，帮助文案去掉 Web 形态的部署区别。
  if (platform.kind === "desktop") {
    // 桌面端可见文案去 web 口径（「不是当前浏览器电脑」在桌面形态语义不成立）
    const sn = $("scan-scope-text") as HTMLElement | null;
    if (sn) sn.textContent = "扫描这台电脑。";
    const sh = $("scan-help") as HTMLElement | null;
    if (sh) sh.dataset.tip =
      "扫描这台电脑上的目录。普通扫描只读取文件名、大小和同目录字幕文件，不会打开视频，也不会触发网盘下载。要处理另一台电脑里的文件，请改用「选择文件 / 选择文件夹」。";
    // autosave 说明桌面措辞（10-13-javscribe-client-writeback-guard F1）：本地源任务强制写回不受开关门控
    const ah = document.querySelector(".autosave-chk .help") as HTMLElement | null;
    if (ah) ah.dataset.tip =
      "桌面端：本地源任务（选择文件 / 选择文件夹、扫描目录、监听目录、换服务重跑）完成后一律自动写回影片旁，不受本开关控制；写回失败时改为自动下载（保存对话框）。本开关仅控制无本地路径的文件（如拖入）：勾选后完成时弹保存对话框另存 srt。";
  }
  const modalX = $("modal-x");
  const modalBackdrop = $("modal-backdrop");

  function updateTitle(rows: JobRow[]) {
    const n = rows.filter((r) => r.status === "running").length;
    const base = platform.kind === "desktop" ? "JavScribe Client" : DEFAULT_TITLE;
    document.title = n ? `(${n}) ${base}` : base;
  }

  function notifyJobChanges(rows: JobRow[]) {
    const seen = new Set<string>();
    for (const r of rows) {
      const key = r.engine + "|" + (r.job_id || "") + "|" + (r.file || "");
      seen.add(key);
      const prev = state.knownJobs.get(key);
      state.knownJobs.set(key, r.status);
      if (prev === "running" && r.status !== "running") {
        const kind: "ok" | "err" | "" = r.status === "done" ? "ok" : r.status === "skipped" ? "" : "err";
        const verb: Record<string, string> = { done: "完成", skipped: "已跳过（srt 已存在）", error: "失败", canceled: "已取消" };
        toast(`${r.engine} · ${r.file || r.label} ${verb[r.status] || r.status}`, kind);
        if (r.status === "done") maybeWriteBack(r);
      }
    }
    // F2 对账兜底（10-13-javscribe-client-writeback-guard）：快任务（首见即 done）/ 客户端重启后
    //（knownJobs 内存态，首见 prev=undefined）running→done 转换不可观测 → 每轮对「已登记且过门的
    // done 行」对账式触发写回；幂等：maybeWriteBack 触发即消费登记，成功后不再命中
    for (const r of pickWriteBackRows(rows, {
      autoSave: state.autoSave,
      registered: new Set(state.writeBackJobs.keys()),
      forced: state.watchWriteBack,
    })) maybeWriteBack(r);
    for (const k of [...state.knownJobs.keys()]) if (!seen.has(k)) state.knownJobs.delete(k);
  }

  // 本地源派发登记收口（10-13-javscribe-client-writeback-guard F1）：writeBackJobs（写回登记）
  // +（desktop 且有本地路径）watchWriteBack（强制写回集）。desktop 本地源任务（扫描/选择文件夹/
  // watch/单文件/换服务重跑）完成后一律写回影片旁，不受 autoSave 门控；autoSave 开关仅继续
  // 控制无本地源场景（web 形态 / desktop 拖入文件）既有行为，本线不改 web 语义。
  function registerWriteBack(key: string, info: WriteBackInfo): void {
    state.writeBackJobs.set(key, info);
    wbAt.set(key, Date.now());
    if (platform.kind === "desktop" && info.videoPath) state.watchWriteBack.add(key);
    saveWriteBackStore();
  }

  // ---------- 完成后写回源目录（auto-save）：running→done 即时分支 + reconcile 对账兜底触发 ----------
  function maybeWriteBack(r: JobRow) {
    if (!r.job_id) return;
    const key = r.engine + "|" + r.job_id;
    const info = state.writeBackJobs.get(key);
    if (!info) return;
    // 门控：本地源派发任务（desktop：watch/扫描/选择文件夹/单文件/换服务重跑）在 watchWriteBack
    // 登记，完成后一律写回影片旁（不受 autoSave 门控）；autoSave 开关仅控制无本地源场景
    //（web 自动下载 srt 等）既有行为
    if (!state.autoSave && !state.watchWriteBack.has(key)) return;
    state.writeBackJobs.delete(key);
    state.watchWriteBack.delete(key);
    wbAt.delete(key);
    saveWriteBackStore();
    if (platform.canWriteBack(info)) doWriteBack(r, info);
    else autoDownloadSrt(r, info.videoName);
  }

  async function doWriteBack(r: JobRow, info: WriteBackInfo) {
    const srtName = info.videoName.replace(/\.[^.]+$/, "") + SRT_SUFFIX;
    try {
      // 幂等预检（10-13-javscribe-client-writeback-guard）：目标 srt 已存在（重复触发 / 用户已
      // 手动放到影片旁）→ 跳过不覆盖；登记已由 maybeWriteBack 消费（跳过并清理登记）
      if (await platform.srtExists(info, srtName)) {
        toast(`「${info.videoName}」字幕已存在（${srtName}），跳过写回`, "");
        return;
      }
      let data: ArrayBuffer | null = null;
      for (let i = 0; i < 5 && !data; i++) {
        data = await t.getResultData(r.engine, r.job_id!);
        if (!data) await new Promise((res) => setTimeout(res, 2000));
      }
      if (!data) { toast(`「${info.videoName}」字幕暂不可下载，请用手动下载`, "err"); return; }
      const ok = await platform.writeSrt(info, srtName, data);
      if (!ok) throw new Error("写回失败");
      toast(`「${info.videoName}」字幕已写回源目录（${srtName}）`, "ok");
    } catch (e) {
      const err = e as { name?: string; message?: string };
      toast(`「${info.videoName}」写回失败（${err.name || err.message}），改为自动下载`, "err");
      autoDownloadSrt(r, info.videoName);
    }
  }

  function autoDownloadSrt(r: JobRow, videoName: string) {
    const srtName = videoName.replace(/\.[^.]+$/, "") + SRT_SUFFIX;
    try {
      platform.downloadSrt(t.getResultUrl(r.engine, r.job_id!), srtName);
      toast(`已自动下载 ${srtName}（此方式无法直接写回源目录，请放到影片同目录）`, "");
    } catch (_e) {
      toast(`自动下载 ${srtName} 失败，请用手动下载`, "err");
    }
  }


  // ---------- F4/F5 ghost 行（10-18 修复轮）：pre 占位行 + 丢失在途行 ----------
  // pre ghost：客户端异常退出后残留的 pre 登记（已提取未上传）→ 可见占位行（「未提交」）+ 重试/取消；
  //   数据源 = writeBackStore 的 pre 键（localStorage + main 镜像，跨重启存活），refresh 每轮物化，
  //   登记被 rekey/取消后自动清理。
  // lost ghost：服务中断（offline→online 迁移轮）后在途 job 消失 → 逐文件失败行（「失败（服务重启丢失）」）+ 重试；
  //   数据源 = engineJobsSeen（内存快照，仅在线轮更新；客户端重启即失 → 残留风险见 fix-p2.md）。
  // 两类 ghost 行均为 renderer 本地行（pkey=ghost|... 前缀、job_id=null → 天然不进 serve 指向按钮
  // 与批量操作），不写 state._jobs / knownJobs（在途封顶 serve-only 不变式不受影响）。
  interface GhostRow {
    kind: "pre" | "lost";
    row: JobRow;
    preKey?: string;      // kind=pre：写回登记键 engine|pre|<视频名>
    engine?: string;      // 原引擎
    jobId?: string;       // kind=lost：原 job_id（写回登记 rekey 用）
    videoPath?: string | null;
    sourceKind?: string | null; // kind=lost：最后观测行 source_kind（local=按路径重提；remote=重提取上传）
    batchId?: string | null;
    batchLabel?: string | null;
  }
  const ghostRows = new Map<string, GhostRow>();        // pkey -> ghost
  const engineOnlineState = new Map<string, boolean>(); // 首见 undefined → 不判迁移（防首载误判）
  const engineJobsSeen = new Map<string, Map<string, JobRow[]>>(); // engine -> job_id -> 最后观测行（仅在线轮更新）
  let offlineEngines = new Set<string>();               // 本轮离线引擎（refresh 每轮刷新）

  /** F5：引擎在线态追踪 + offline→online 迁移对账。
   * 在线轮 → 刷新该引擎 job 快照；离线轮 → 保留快照（serve 行滞留 stale，无新信息）；
   * 迁移轮 → 快照中已不在本轮且当时非终态的 job → 逐文件建 lost 行；引擎注销 → 清追踪集。 */
  function reconcileEngineGhosts(engines: Engine[], jobs: JobRow[]): void {
    offlineEngines = new Set(engines.filter((e) => !e.online).map((e) => e.name));
    for (const e of engines) {
      const live = new Map<string, JobRow[]>();
      for (const r of jobs) if (r.engine === e.name && r.job_id) {
        const arr = live.get(String(r.job_id));
        if (arr) arr.push(r); else live.set(String(r.job_id), [r]);
      }
      const prev = engineOnlineState.get(e.name);
      if (e.online) {
        const seen = engineJobsSeen.get(e.name);
        if (prev === false && seen) {
          for (const [jid, rows] of [...seen]) {
            if (live.has(jid)) continue;
            if (rows.every((r) => TERMINAL_LIKE.has(r.status))) continue; // 当时已终态 = 正常过期，非「丢失」
            createLostGhosts(e.name, jid, rows);
          }
        }
        engineJobsSeen.set(e.name, live);
      }
      engineOnlineState.set(e.name, !!e.online);
    }
    for (const name of [...engineOnlineState.keys()]) {
      if (!engines.some((en) => en.name === name)) {
        engineOnlineState.delete(name);
        engineJobsSeen.delete(name);
      }
    }
  }

  /** F5：服务重启丢失的在途 job 逐文件建 lost 行。
   * job_id=null → 天然无服务端按钮（下载/预览/重试/取消均 isServeRow 门控）；
   * batch_id/label 继承最后观测行 → 进对应主任务组（「重试失败」主任务按钮由批量重试 handler
   * 的 ghostFailed 分支覆盖）。 */
  function createLostGhosts(engine: string, jobId: string, rows: JobRow[]): void {
    const now = Date.now() / 1000;
    const wbKey = engine + "|" + jobId;
    let wbTouched = false;
    for (const r of rows) {
      const f = r.file || r.label || jobId;
      const pk = `ghost|lost|${engine}|${jobId}|${f}`;
      if (ghostRows.has(pk)) continue;
      ghostRows.set(pk, {
        kind: "lost",
        engine,
        jobId: String(jobId),
        videoPath: state.writeBackJobs.get(wbKey)?.videoPath ?? null,
        sourceKind: r.source_kind ?? null,
        batchId: r.batch_id ?? null,
        batchLabel: r.batch_label ?? null,
        row: {
          engine,
          job_id: null,
          file: f,
          label: r.label || f,
          status: "error",
          message: `失败（服务重启丢失）：服务「${engine}」中断时该任务在途，已被服务端丢弃`,
          created: r.created ?? null,
          finished: now,
          source_kind: r.source_kind ?? null,
          batch_id: r.batch_id ?? null,
          batch_label: r.batch_label ?? null,
          pkey: pk,
        },
      });
      // 写回登记重试窗口刷新：原 job 键仍在登记表（剪枝宽限未过）→ 刷 wbAt 续 10min
      if (state.writeBackJobs.has(wbKey)) { wbAt.set(wbKey, Date.now()); wbTouched = true; }
    }
    if (wbTouched) saveWriteBackStore();
  }

  /** F4：pre 登记 → 占位行（「未提交」）。
   * 去重：同引擎同名 serve 真行可见（bind 已/将 rekey）或同引擎同名 pending 子行
   * （会话内失败/取消的显示位）→ 跳过；建行时刷 wbAt：剪枝宽限从建行时刻起算
   * （否则隔较久重启会被立即剪掉、占位行不可见）。 */
  function materializePreGhosts(jobs: JobRow[]): void {
    const now = Date.now();
    // pre 键已被消费（rekey/用户取消）→ 清理失效占位行
    for (const [pk, g] of [...ghostRows]) {
      if (g.kind === "pre" && !state.writeBackJobs.has(g.preKey!)) ghostRows.delete(pk);
    }
    for (const k of state.writeBackJobs.keys()) {
      const i = k.indexOf("|pre|");
      if (i < 0) continue;
      const engine = k.slice(0, i);
      const videoName = k.slice(i + 5); // "|pre|" 长度
      if (jobs.some((r) => r.job_id && r.engine === engine
        && ((r.file && r.file === videoName) || (r.label && r.label === videoName)))) continue;
      if ([...state._pending.values()].some((p) => p.row.engine === engine && p.row.file === videoName)) continue;
      const pk = "ghost|pre|" + k;
      if (ghostRows.has(pk)) continue;
      const info = state.writeBackJobs.get(k)!;
      ghostRows.set(pk, {
        kind: "pre",
        preKey: k,
        engine,
        videoPath: info.videoPath || null,
        row: {
          engine,
          job_id: null,
          file: videoName,
          label: videoName,
          status: "unsubmitted",
          progress: 0,
          position: "未提交",
          phase_detail: "未提交",
          message: "客户端异常退出前未提交服务：音轨已提取未上传，可重试或取消",
          created: (wbAt.get(k) || now) / 1000,
          finished: null,
          pkey: pk,
        },
      });
      wbAt.set(k, now); // 宽限从建行时刻起算（10min）
      saveWriteBackStore();
    }
  }

  /** F4/F5 ghost 行重试核心：{ok, error}。
   * 路由：lost + 本地源（扫描/watch）+ 原引擎在线 + 路径是视频 → 逐文件 /scan/submit 回原引擎
   * （F3 路径，写回登记随之；not-found → 落本机链）；
   * pre / 远端源 / 原引擎离线 → File+_localPath → dispatchTracked（重提取音轨+上传）。
   * 成功 → 写回登记 rekey/刷新 + 删 ghost 行。 */
  async function ghostRetryCore(g: GhostRow): Promise<{ ok: boolean; error?: string }> {
    const vp = g.videoPath;
    if (!vp) return { ok: false, error: "该任务无本机路径，无法重试" };
    const name = g.row.file || "";
    const origOnline = !!g.engine && state.engines.some((e) => e.name === g.engine && e.online);
    const engine = origOnline ? g.engine! : (resolveAutoEngine() || "");
    if (!engine) return { ok: false, error: "没有可用服务：全部离线，或都没有勾选「参与均衡」" };
    const batch = g.batchId ? { id: g.batchId, label: g.batchLabel || "" } : undefined;
    if (g.kind === "lost" && g.sourceKind === "local" && origOnline && VIDEO_EXT_RE.test(name)) {
      const r = await submitScanFile(g.engine!, vp, batch);
      if (r.kind === "ok") {
        if (r.jobId) {
          rekeyWriteBack(g.engine! + "|" + g.jobId, g.engine! + "|" + r.jobId);
          registerWriteBack(g.engine! + "|" + r.jobId,
            { engine: g.engine!, videoName: name, dirHandle: null, videoPath: vp });
        }
        removeGhost(g);
        return { ok: true };
      }
      if (r.kind === "error") return { ok: false, error: r.message };
      // not-found：服务读不到路径 → 落下面本机链
    }
    const f = new File([new Blob()], name) as FolderFile;
    f._localPath = vp;
    try {
      const [ok, d] = await dispatchTracked(f, engine, "", batch);
      if (!ok) return { ok: false, error: String((d as { error?: string }).error || "派发失败") };
      const up = d as UploadStatus;
      if (up.job_id) {
        const newKey = engine + "|" + up.job_id;
        rekeyWriteBack(g.kind === "pre" ? g.preKey! : (g.engine! + "|" + g.jobId), newKey);
        registerWriteBack(newKey, { engine, videoName: name, dirHandle: null, videoPath: vp });
      }
      removeGhost(g);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  function removeGhost(g: GhostRow): void {
    if (g.row.pkey) ghostRows.delete(g.row.pkey);
    schedulePendingRender(); // 删 ghost 行即时重渲（不等 5s 轮询）
  }

  async function ghostRetryUi(btn: HTMLButtonElement): Promise<void> {
    const g = ghostRows.get(btn.dataset.gkey || "");
    if (!g) { refresh(); return; }
    btn.disabled = true;
    btn.textContent = "重试中…";
    try {
      const r = await ghostRetryCore(g);
      toast(r.ok ? `「${g.row.file}」已重新提交` : `重试失败：${r.error}`, r.ok ? "ok" : "err");
    } catch (e) {
      toast(`重试失败：${(e as Error).message}`, "err");
    }
    refresh();
  }

  // ---------- 0.2.57 中断账本行重跑（ghost-retry 同款路径） ----------
  // 中断 = 客户端退出/重启、任务链路断开、服务端在途必丢 → 重跑 = 重新提取音轨 → 上传 → 提交；
  // 原引擎在线且路径是视频 → /scan/submit 回原引擎（服务端音轨缓存可能仍在）；否则本机链。
  async function rerunLedgerChild(c: LedgerChild): Promise<{ ok: boolean; error?: string }> {
    const vp = c.file_path || "";
    if (!vp) return { ok: false, error: "源文件路径未记录" };
    if (typeof t.fsExists === "function") {
      let exists = false;
      try { exists = await t.fsExists(vp); } catch { exists = false; }
      if (!exists) return { ok: false, error: "源文件已不存在（可能移动/删除）" };
    }
    const name = c.videoName;
    const origOnline = !!c.engine && state.engines.some((e) => e.name === c.engine && e.online);
    const engine = origOnline ? c.engine! : (resolveAutoEngine() || "");
    if (!engine) return { ok: false, error: "没有可用服务：全部离线，或都没有勾选「参与均衡」" };
    const batch = c.batch_id ? { id: c.batch_id, label: c.batch_label || "" } : undefined;
    const oldKey = c.engine + "|" + (c.job_id || "");
    if (origOnline && VIDEO_EXT_RE.test(name)) {
      const r = await submitScanFile(c.engine!, vp, batch);
      if (r.kind === "ok") {
        if (r.jobId) {
          if (c.job_id) rekeyWriteBack(oldKey, c.engine! + "|" + r.jobId);
          registerWriteBack(c.engine! + "|" + r.jobId,
            { engine: c.engine!, videoName: name, dirHandle: null, videoPath: vp });
        }
        return { ok: true };
      }
      if (r.kind === "error") return { ok: false, error: r.message };
      // not-found：服务读不到路径 → 落下面本机链
    }
    const f = new File([new Blob()], name) as FolderFile;
    f._localPath = vp;
    const [ok, d] = await dispatchTracked(f, engine, "", batch);
    if (!ok) return { ok: false, error: String((d as { error?: string }).error || "派发失败") };
    const up = d as UploadStatus;
    if (up.job_id) {
      const newKey = engine + "|" + up.job_id;
      if (c.job_id) rekeyWriteBack(oldKey, newKey);
      registerWriteBack(newKey, { engine, videoName: name, dirHandle: null, videoPath: vp });
    }
    return { ok: true };
  }

  /** 批量重跑中断行（并发 3）：无源文件路径的跳过并计数；成功即删旧账本条目（新派发新 pkey，旧 job_id 行会成永久双行） */
  async function rerunInterruptedRows(rows: JobRow[]): Promise<{ done: number; skippedNoPath: number; failed: number; errors: string[] }> {
    const targets = rows.filter((r) => r.ledger === true && r.status === INTERRUPTED);
    let done = 0, skippedNoPath = 0, failed = 0;
    const errors: string[] = [];
    const queue = [...targets];
    const worker = async (): Promise<void> => {
      for (;;) {
        const r = queue.shift();
        if (!r) return;
        const c = ledger.children[r.pkey || ""];
        if (!c) continue;
        if (!c.file_path) { skippedNoPath++; continue; }
        const res = await rerunLedgerChild(c);
        if (res.ok) {
          done++;
          ledgerRemove(r.pkey || "");
        } else {
          failed++;
          if (errors.length < 3) errors.push(`${c.videoName}：${res.error}`);
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (done || failed) saveLedgerStore();
    return { done, skippedNoPath, failed, errors };
  }

  function rerunSummary(r: { done: number; skippedNoPath: number; failed: number; errors: string[] }): { text: string; level: "ok" | "err" } {
    const parts = [`已重跑 ${r.done} 条`];
    if (r.skippedNoPath) parts.push(`${r.skippedNoPath} 条跳过（源文件路径未记录）`);
    if (r.failed) parts.push(`${r.failed} 条失败${r.errors.length ? `（${r.errors.join("；")}${r.failed > r.errors.length ? "…" : ""}）` : ""}`);
    return { text: parts.join("，"), level: r.failed ? "err" : "ok" };
  }

  async function rerunLedgerBtn(btn: HTMLButtonElement): Promise<void> {
    const pkey = btn.dataset.pkey || "";
    const c = ledger.children[pkey];
    if (!c) { refresh(); return; }
    if (!c.file_path) { toast("源文件路径未记录：请重新扫描该文件并提交", "err"); return; }
    btn.disabled = true;
    try {
      const res = await rerunLedgerChild(c);
      if (res.ok) {
        ledgerRemove(pkey);
        toast(`「${c.videoName}」已重新提交`, "ok");
      } else {
        toast(`重跑失败：${res.error}`, "err");
      }
    } finally {
      btn.disabled = false;
      refresh();
    }
  }

  /** 0.2.57：合并行集存在中断行时，暂停/继续按钮旁出现 [N 中断 · 重跑] */
  function renderInterruptedRerunBtn(rows: JobRow[]): void {
    const btn = $("job-rerun-interrupted") as HTMLButtonElement | null;
    if (!btn) return;
    const n = rows.filter((r) => r.status === INTERRUPTED).length;
    if (!n) { btn.hidden = true; return; }
    btn.hidden = false;
    const label = `⚡ ${n} 中断 · 重跑`;
    if (btn.textContent !== label) btn.textContent = label;
  }

  ($("job-rerun-interrupted") as HTMLButtonElement | null)?.addEventListener("click", async () => {
    if (state.busy) { toast("有正在进行的提交任务，请完成后再试", "err"); return; }
    const btn = $("job-rerun-interrupted") as HTMLButtonElement;
    btn.disabled = true;
    try {
      const r = await rerunInterruptedRows(lastMergedRows);
      if (r.done === 0 && r.failed === 0) toast("没有可重跑的中断任务（源文件路径未记录）", "err");
      else { const sum = rerunSummary(r); toast(sum.text, sum.level); }
    } finally {
      btn.disabled = false;
      schedulePendingRender();
      refresh();
    }
  });

  function ghostCancelUi(btn: HTMLButtonElement): void {
    const g = ghostRows.get(btn.dataset.gkey || "");
    if (!g || g.kind !== "pre") return;
    const name = g.row.file || "";
    if (!window.confirm(`确认丢弃「${name}」？
该文件的音轨提取结果将丢弃，不再提交生成字幕。`)) return;
    const k = g.preKey!;
    state.writeBackJobs.delete(k);
    state.watchWriteBack.delete(k);
    wbAt.delete(k);
    saveWriteBackStore();
    ghostRows.delete(g.row.pkey!);
    toast(`已丢弃「${name}」（不再生成字幕）`, "ok");
    renderJobs(state._jobs);
  }

  async function refresh() {
    try {
      const [health, engines, jobs, summary, ccRaw, batches] = await Promise.all([
        t.getHealth(), t.listEngines(), t.listJobs(),
        t.listJobsSummary ? t.listJobsSummary().catch(() => null) : Promise.resolve(null),
        // S4：客户端并发设置读回（多端/他端保存后 ≤5s 热生效；失败保留上一值）
        t.getClientConfig ? t.getClientConfig().catch(() => null) : Promise.resolve(null),
        // S2：工作台 batch 记录读回（主任务视图）
        t.listBatches ? t.listBatches().catch(() => null) : Promise.resolve(null),
      ]);
      const allOnline = health.online === health.engines && health.engines > 0;
      $("health").textContent = `v${health.version} · 服务 ${health.online}/${health.engines} 在线`;
      $("health").style.color = allOnline ? "" : "var(--err)";
      $("foot-ver").textContent = "v" + health.version;
      renderEngines(engines);
      state._jobs = jobs;
      state._summary = summary;
      bindPreRegistrations(jobs); // 预登记绑定：serve 真行可见 → 临时键 rekey 为正式键
      pruneWriteBackStore(); // 写回登记剪枝：job 已过期消失且超宽限 → 丢弃
      reconcileEngineGhosts(engines, jobs); // F5：引擎在线态迁移对账（offline→online：在途 job 消失 → lost 行）
      materializePreGhosts(jobs); // F4：残留 pre 登记 → 可见占位行（未提交）
      reconcilePending(); // S4：行接管 pending 记账（行到终态即释 cap 槽）
      reconcilePendingRows(); // 行优先：serve 真行可见 → 同 job_id 的 pending 行让位删除（不双行）
      reconcileLedger(jobs); // 0.2.51：账本双向校准（suppress 自愈 + TTL/上限剪枝）
      if (ccRaw) {
        const ccNow = normalizeClientConfig(ccRaw);
        if (!state.ccfg
          || ccNow.extract_workers !== state.ccfg.extract_workers
          || ccNow.queue_cap !== state.ccfg.queue_cap
          || ccNow.vram_free_min_gb !== state.ccfg.vram_free_min_gb) {
          state.ccfg = ccNow;
          jav()?.wakeExtract?.(); // 提取并发变更 → 释放池等待者（调小无害：不中断在跑者）
          pumpDispatch();         // 在途封顶变更 → 立即重判排队项
        }
      }
      state._batches = batches || [];
      // 0.2.47：done 任务出现/消失 → 刷新扫描结果「已生成未落盘」标记（仅扫描视图可见时重渲染）
      if (state.scanItems.length) {
        rebuildScanDoneIndex();
        const nRe = reconcileScanItems();
        if (nRe && $("sec-dispatch").classList.contains("view-on")) renderScanResults(state.lastScan!);
      }
      renderJobs(jobs);
      if (typeof t.engineMetrics === "function") { // web + desktop 均支持（desktop 走 main IPC 直连 serve /metrics/json）
        for (const e of engines) {
          if (!e.online) continue;
          void t.engineMetrics(e.name).then((m) => {
            state._metrics[e.name] = m;
            const card = document.querySelector<HTMLElement>(
              `#engine-grid .eng[data-name="${CSS.escape(e.name)}"]`);
            if (card) { renderEngineMetrics(card, e.name); updateEngExclHint(card, e); }
          }).catch(() => {
            state._metrics[e.name] = { ok: false, error: "unreachable" };
            const card = document.querySelector<HTMLElement>(
              `#engine-grid .eng[data-name="${CSS.escape(e.name)}"]`);
            if (card) { renderEngineMetrics(card, e.name); updateEngExclHint(card, e); }
          });
        }
      }
      renderSelect(engines);
      $("last-updated").textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
      notifyJobChanges(jobs);
      updateTitle(jobs);
      viewBadge(jobs.filter((r) => r.status === "running").length);
    } catch (_e) { /* 网络抖动：保留上一次渲染 */ }
    watchPump(); // watch 队列安全网：漏触发的消费在 5s 内自愈
    pumpDispatch(); // S4：任务终态/在途变化可能释出 cap 槽 → 重触发排队派发
    if (platform.kind === "web") void refreshUpdateWeb();
    else void refreshServeLatest(); // 桌面端：服务端新版本提示（GitHub Release 对比，静默降级）
  }

  // ---------- 服务端最新版本（桌面端 main 进程拉 GitHub；web 形态由 /api/update 提供） ----------
  // 服务端无自有界面，「服务端有新版本」提示落在字幕服务卡片角标（tag-up），点开即 Release 页。
  // 渲染端不做节流：main 侧 TTL + single-flight 已是限流者（成功 24h / 失败 1h），
  // 每次 5s 刷新问一次 = 缓存命中直接返回；渲染端节流会缓存「旧的最新版本」导致角标长时间不出现。
  async function refreshServeLatest() {
    const d = (window as unknown as { javDesktop?: { serveUpdate?: () => Promise<ServeRelease | null> } }).javDesktop;
    if (typeof d?.serveUpdate !== "function") return;
    try {
      const r = await d.serveUpdate();
      if (r && r.version) state.latestServe = r;
    } catch (_e) { /* 网络失败静默降级：不提示 */ }
    if (state.engines.length) renderEngines(state.engines); // 角标变化 → 卡片就地重渲染（diff 无变化则不重建）
  }

  // 版本号比较（serve-v0.2.6 / 0.2.6 均可）：缺位补 0，任一解析失败 → false
  function versionGt(a: string, b: string): boolean {
    const m = (x: string) => (x || "").replace(/^[^0-9]*/g, "").split(".").map((n) => parseInt(n, 10) || 0);
    const ta = m(a), tb = m(b);
    if (!ta.length || !tb.length || !ta.some((n) => n > 0) || !tb.some((n) => n > 0)) return false;
    const n = Math.max(ta.length, tb.length);
    for (let i = 0; i < n; i++) {
      const x = ta[i] || 0, y = tb[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  // ---------- 更新检查（footer chip 共享节点：web=工作台 /api/update 版本对比；desktop=main 进程 electron-updater） ----------
  const upChip = $("up-chip") as HTMLSpanElement;
  let upModalOpen = false;

  interface UpBridge {
    state(): Promise<UpdateState>;
    check(): Promise<UpdateState>;
    download(): Promise<UpdateState>;
    restart(): Promise<UpdateState>;
    ignore(v: string): Promise<UpdateState>;
    getSettings(): Promise<UpdateSettings>;
    putSettings(s: UpdateSettings): Promise<UpdateSettings>;
    onState(cb: (s: UpdateState) => void): () => void;
  }

  function upBridge(): UpBridge | null {
    return (window as unknown as { javDesktop?: { update?: UpBridge } }).javDesktop?.update ?? null;
  }

  // watch 消费泵钩子：web 形态恒空操作（#watch-panel 恒隐藏、不接线——web 100% 不变硬约束）
  let watchPump: () => void = () => {};

  // 桌面壳导航徽标钩子：web 形态恒空操作（无 .nav-badge 节点）
  let viewBadge: (n: number) => void = () => {};

  // web 壳顶部视图 tab 钩子：desktop 形态恒空操作（桌面用侧边栏）
  let webShowView: (v: "dispatch" | "jobs" | "engines" | "ccfg") => void = () => {};

  // 文件夹监听「设置 → 客户端」钩子：桌面形态由 watch 块接线（与派单页监听面板同一数据源）；web 形态恒 null
  let ccWatchCtl: {
    state(): WatchState | null;
    set(on: boolean, path: string): Promise<{ ok: boolean; error?: string; state?: WatchState }>;
    pickDir(): Promise<string | null>;
  } | null = null;

  // ---- web 形态：GET /api/update（独立链路，失败静默，绝不拖累主刷新） ----
  let updateWeb: UpdateInfo | null = null;
  async function refreshUpdateWeb() {
    try {
      const u = await t.getUpdate();
      updateWeb = u.enabled && u.has_update && u.latest_app ? u : null;
      // 卡片角标不依赖 has_update：同版本无角标，落后才有（latest_app 为空 = 未拉到/已关闭）
      state.latestServe = u.enabled && u.latest_app
        ? { version: (u.latest_app.version || "").replace(/^[^0-9]*/g, ""), url: u.latest_app.url }
        : null;
    } catch (_e) {
      updateWeb = null; // 更新检查失败静默降级，不打扰看板
    }
    renderUpChip();
    if (state.engines.length) renderEngines(state.engines);
  }

  // ---- desktop 形态：main 进程状态机（IPC 推送，订阅在 initApp 尾部接线） ----
  let upState: UpdateState = { status: "disabled" };
  let upSettings: UpdateSettings | null = null;
  let upManualCheck = false;
  // 侧边栏「检查更新」手动检查的未决标记：结果出来时 toast 最新 / 开弹窗
  let asideCheckPending = false;

  function renderUpChip() {
    if (platform.kind === "web") {
      if (updateWeb && updateWeb.latest_app) {
        upChip.hidden = false;
        upChip.classList.add("on");
        upChip.textContent = "新版本 " + updateWeb.latest_app.version;
      } else {
        upChip.hidden = true;
        upChip.classList.remove("on");
      }
      return;
    }
    if (!upBridge()) { upChip.hidden = true; return; }
    const s = upState;
    let text = "";
    let on = false;
    switch (s.status) {
      case "idle": text = "检查更新"; break;
      case "checking": text = "检查更新中…"; break;
      case "available": text = "新版本 " + (s.version || ""); on = true; break;
      case "downloading": text = "下载中 " + Math.round(s.pct ?? 0) + "%"; on = true; break;
      case "downloaded": text = "重启安装 v" + (s.version || ""); on = true; break;
      default: upChip.hidden = true; return; // error/disabled：静默降级，菜单仍可手动检查
    }
    upChip.hidden = false;
    upChip.classList.toggle("on", on);
    upChip.textContent = text;
  }

  // 侧边栏「检查更新」按钮：跟随状态机（仅桌面壳存在 #nav-up 节点；dev 态 disabled → 整块隐藏）
  function renderUpSidebar() {
    const wrap = $("nav-up") as HTMLElement | null;
    if (!wrap || platform.kind !== "desktop") return;
    if (!upBridge() || upState.status === "disabled") {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    const btn = $("up-check") as HTMLButtonElement | null;
    if (!btn) return;
    const st = upState;
    let text = "检查更新";
    let on = false;
    let dis = false;
    switch (st.status) {
      case "idle": break;
      case "checking": text = "检查中…"; dis = true; break;
      case "available": text = "新版本 " + (st.version || ""); on = true; break;
      case "downloading": text = "下载中 " + Math.round(st.pct ?? 0) + "%"; dis = true; break;
      case "downloaded": text = "重启安装 v" + (st.version || ""); on = true; break;
      case "error": text = "重试检查"; break;
    }
    if (btn.textContent !== text) btn.textContent = text;
    btn.classList.toggle("on", on);
    btn.disabled = dis;
  }

  function upCheckDesktop(manual: boolean) {
    const b = upBridge();
    if (!b) return;
    upManualCheck = manual;
    void b.check().catch(() => { /* 错误经 onState 状态机统一处理 */ });
  }

  function upChipDesktopClick() {
    const s = upState;
    if (s.status === "idle" || s.status === "checking") {
      upCheckDesktop(true);
      return;
    }
    if (s.status === "available" || s.status === "downloading" || s.status === "downloaded") {
      openUpdateDesktop();
    }
  }

  // ---- web 弹窗：changelog + 一键复制更新命令（部署形态选择记忆） ----
  function openUpdateWeb() {
    const u = updateWeb;
    if (!u || !u.latest_app) return;
    const rel = u.latest_app;
    upModalOpen = true;
    showModal("新版本 " + rel.version);
    const body = $("modal-body");
    const savedCmd = localStorage.getItem("javweb_update_cmd") === "source" ? "source" : "docker";
    body.innerHTML = `
    <div class="set-note">服务端（字幕服务）最新版本为 <b>${esc(rel.version)}</b>（当前连接服务上报 ${esc(state.engines.map((e) => (e.version ? "v" + e.version : "")).filter(Boolean).join("、") || "—")}）。
请在 GPU 服务器上更新字幕服务——选择你的部署形态后复制命令${
      u.latest_client ? `。<br>桌面端 JavScribe Client 已有 ${esc(u.latest_client.version)}（应用内自动检查更新，见 GitHub Releases）` : ""
    }。</div>
    <div class="up-sec-label">更新说明</div>
    <pre class="up-changelog">${esc(rel.body || "（无发布说明）")}</pre>
    <div class="up-sec-label">更新命令（选择你的部署形态）</div>
    <div class="up-cmds">
      <label class="up-cmd-opt"><input type="radio" name="up-cmd" value="docker"${savedCmd === "docker" ? " checked" : ""}><span>Docker 镜像部署（compose pull）</span></label>
      <label class="up-cmd-opt"><input type="radio" name="up-cmd" value="source"${savedCmd === "source" ? " checked" : ""}><span>源码部署（compose build）</span></label>
    </div>
    <div class="up-row">
      <code id="up-cmd-text" class="mono up-cmd-text"></code>
      <button type="button" class="btn" id="up-cmd-copy">复制命令</button>
    </div>
    <div class="up-row">
      <a class="up-link mono" href="${esc(rel.url)}" target="_blank" rel="noopener">查看 Release 详情 ↗</a>
    </div>`;
    const textEl = $("up-cmd-text") as HTMLElement;
    const syncCmd = () => {
      const v = (body.querySelector<HTMLInputElement>('input[name="up-cmd"]:checked') || null)?.value || "docker";
      localStorage.setItem("javweb_update_cmd", v);
      textEl.textContent = v === "docker" ? u.commands.docker : u.commands.source;
    };
    for (const el of body.querySelectorAll<HTMLInputElement>('input[name="up-cmd"]')) {
      el.addEventListener("change", syncCmd);
    }
    syncCmd();
    ($("up-cmd-copy") as HTMLButtonElement).onclick = async () => {
      const ok = await copyText(textEl.textContent || "");
      toast(ok ? "命令已复制" : "复制失败，请手动选择复制", ok ? "ok" : "err");
    };
  }

  async function copyText(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_e) { /* 落到 execCommand 兜底 */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (_e) {
      return false;
    }
  }

  // ---- desktop 弹窗：版本对比 + 下载/稍后/忽略 + 高级设置（自动检查/镜像源） ----
  function openUpdateDesktop() {
    const s = upState;
    if (s.status !== "available" && s.status !== "downloading" && s.status !== "downloaded" && s.status !== "error") return;
    upModalOpen = true;
    showModal("检查更新");
    const body = $("modal-body");
    const curVer = ($("foot-ver").textContent || "").replace(/^v/, "");
    // 服务端新版本提示（与服务卡片角标同源）：桌面端弹窗顺带提醒，手动更新在 GPU 服务器
    const _ls = state.latestServe;
    const serveUpNote = _ls && state.engines.some((e) => e.version && versionGt(_ls.version, e.version))
      ? `<div class="set-note">另外：服务端有 <b>v${esc(_ls.version)}</b> 新版本（见「字幕服务」页卡片角标，请在 GPU 服务器手动更新镜像/可执行文件）。</div>`
      : "";
    if (s.status === "available") {
      body.innerHTML = `
      <div class="set-note">当前 v${esc(curVer || "?")} → 最新 v${esc(s.version || "?")}。下载完成后需重启应用完成安装。</div>
      <div class="up-sec-label">更新说明</div>
      <pre class="up-changelog">${esc(s.notes || "（无发布说明）")}</pre>
      ${serveUpNote}
      <div class="up-row">
        <button type="button" class="btn btn-primary" id="up-dl">下载并安装</button>
        <button type="button" class="btn" id="up-later">稍后提醒</button>
        <button type="button" class="btn" id="up-ignore">忽略此版本</button>
      </div>
      <div class="up-sec-label">高级</div>
      <label class="chk-row"><input type="checkbox" id="up-enabled"${upSettings?.enabled ? " checked" : ""}><span>启动时自动检查更新</span></label>
      <label class="field"><span class="field-label">自定义加速地址（URL 前缀，如 https://gh-proxy.example.com/；与内置 3 渠道自动择优，谁快用谁）</span>
      <input id="up-mirror" class="mono" type="text" placeholder="留空仅用内置 3 渠道" value="${esc(upSettings?.mirror || "")}"></label>
      <label class="field"><span class="field-label">更新代理（socks5://127.0.0.1:10808 或 http://127.0.0.1:7890；留空直连）</span>
      <input id="up-proxy" class="mono" type="text" placeholder="留空直连 GitHub" value="${esc(upSettings?.proxy || "")}"></label>
      <div class="up-row">
        <button type="button" class="btn" id="up-save-set">保存设置</button>
        <span class="muted small">保存后立即生效（代理下次检查/下载即走新代理）。</span>
      </div>`;
      ($("up-dl") as HTMLButtonElement).onclick = () => {
        void upBridge()?.download().catch(() => {});
        toast("开始下载新版本…");
      };
      ($("up-later") as HTMLButtonElement).onclick = () => hideModal();
      ($("up-ignore") as HTMLButtonElement).onclick = () => {
        if (s.version) void upBridge()?.ignore(s.version).catch(() => {});
        hideModal();
      };
      ($("up-save-set") as HTMLButtonElement).onclick = async () => {
        const b = upBridge();
        if (!b) return;
        const next = {
          enabled: ($("up-enabled") as HTMLInputElement).checked,
          mirror: (($("up-mirror") as HTMLInputElement).value || "").trim(),
          proxy: (($("up-proxy") as HTMLInputElement).value || "").trim(),
        };
        try {
          upSettings = await b.putSettings(next);
          toast("设置已保存", "ok");
        } catch (e2) {
          toast((e2 as Error).message, "err");
        }
      };
      return;
    }
    if (s.status === "downloading") {
      const pct = Math.round(s.pct ?? 0);
      body.innerHTML = `
      <div class="set-note">正在下载 v${esc(s.version || "")}… ${pct}%（全量安装包，请勿关闭应用）</div>
      <div class="bar live"><div style="width:${pct}%"></div></div>`;
      return;
    }
    if (s.status === "downloaded") {
      body.innerHTML = `
      <div class="set-note">v${esc(s.version || "")} 已下载完成。点击按钮重启并完成安装。</div>
      <div class="up-row">
        <button type="button" class="btn btn-primary" id="up-restart">重启并安装</button>
        <button type="button" class="btn" id="up-later">暂不</button>
      </div>`;
      ($("up-restart") as HTMLButtonElement).onclick = () => { void upBridge()?.restart().catch(() => {}); };
      ($("up-later") as HTMLButtonElement).onclick = () => hideModal();
      return;
    }
    body.innerHTML = `
    <div class="set-note err">${esc(s.error || "检查更新失败")}</div>
    <div class="muted small">若网络无法直连 GitHub：内置加速渠道（gh.llkk.cc / gh-proxy.com / ghfast.top）与自定义加速地址自动择优，谁快用谁；全部不可用时走更新代理。</div>`;
  }

  upChip.onclick = () => {
    if (platform.kind === "web") openUpdateWeb();
    else upChipDesktopClick();
  };
  upChip.onkeydown = (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      upChip.click();
    }
  };

  // ---------- 服务卡片（按名称就地更新：轮询不重建 DOM，入场动画只在新卡片播放，避免闪烁） ----------
  interface EngCardEl extends HTMLElement { _html?: string; }

  /** 服务端新版本角标（共享：服务卡片 / 服务设置弹窗）；服务上报版本 < 最新 serve Release 才出 */
  function serveUpBadge(e: Engine): string {
    const latest = state.latestServe;
    if (!(latest && e.version && versionGt(latest.version, e.version))) return "";
    return `<a class="tag tag-up" href="${esc(latest.url)}" target="_blank" rel="noopener" title="服务端有新版本：点击打开 Release 页，在 GPU 服务器上更新镜像或可执行文件">更新至 v${esc(latest.version)} ↗</a>`;
  }

  function engineCardHtml(e: Engine): string {
    return `
    <div class="eng-top">
      <span class="lamp"></span>
      <h3>${esc(e.name)}</h3>
      ${typeof t.updateEngine === "function" ? `<button type="button" class="icon-btn edit" data-name="${esc(e.name)}" title="编辑服务（改名称/地址/Key，可复制）">&#9998;</button>` : ""}
      <button type="button" class="icon-btn del" data-name="${esc(e.name)}" title="删除服务">&#10005;</button>
    </div>
    <div class="eng-url mono">
      <a class="eng-go" href="${esc(e.url)}" target="_blank" rel="noopener" title="打开服务页面">${PLANE_SVG}</a>
      <span class="eng-url-txt">${esc(e.url)}</span>
    </div>
    <div class="eng-specs">
      <span class="tag">${esc(e.device || "—")}</span>
      <span class="tag" title="服务 /health 上报版本">v${esc(e.version || "—")}</span>
      ${serveUpBadge(e)}
      <span class="tag${e.jobs_running ? " hot" : ""}">运行 ${e.jobs_running || 0}</span>
      ${e.paused ? `<span class="tag tag-paused" title="服务队列已挂起：运行中任务跑完后不再开新任务（看板「继续任务」或单任务「继续」恢复）">已暂停</span>` : ""}
      ${e.online ? (e.error ? `<div class="eng-err-warn" title="${esc(e.error)}">检测异常：${esc(e.error)}（宽限期，未剔除）</div>` : "") : `<div class="eng-err">${esc(e.error || "离线")}</div>`}
    </div>
    <div class="eng-metrics"></div>
    <div class="eng-excl" hidden></div>
    ${typeof t.setEngineEnabled === "function" ? `
    <div class="eng-bal-row">
      <label class="eng-bal" title="勾选后该服务参与「自动均衡」：新任务实时分派给在途任务最少的在线服务；取消勾选后只收手动指定的任务"><input type="checkbox" class="bal-chk" data-name="${esc(e.name)}"${e.enabled === false ? "" : " checked"}> 参与均衡</label>
    </div>` : ""}`;
  }

  function renderEngines(list: Engine[]) {
    state.engines = list;
    const grid = $("engine-grid");
    $("engines-empty").hidden = list.length > 0;
    const cards = new Map<string, EngCardEl>();
    for (const c of Array.from(grid.children)) cards.set((c as HTMLElement).dataset.name ?? "", c as EngCardEl);
    const wanted = new Set(list.map((e) => e.name));
    for (const [name, c] of cards) if (!wanted.has(name)) c.remove();
    for (const e of list) {
      let card = cards.get(e.name);
      if (!card) {
        const el = document.createElement("article");
        el.className = "eng";
        el.dataset.name = e.name;
        grid.appendChild(el);
        card = el as EngCardEl;
        cards.set(e.name, card);
      }
      const html = engineCardHtml(e);
      if (card._html !== html) { card.innerHTML = html; card._html = html; }
      card.classList.toggle("on", !!e.online);
      card.classList.toggle("off", !e.online);
      card.classList.toggle("bal-off", e.enabled === false);
      renderEngineMetrics(card as HTMLElement, e.name);
      updateEngExclHint(card as HTMLElement, e);
    }
    const order = Array.from(grid.children).map((c) => (c as HTMLElement).dataset.name).join("\u0001");
    if (order !== list.map((e) => e.name).join("\u0001")) {
      for (const e of list) grid.appendChild(cards.get(e.name)!);
    }
  }

  // 引擎监控迷你趋势图（serve 0.2.4+ /metrics/json；旧版服务降级为小字提示）
  interface MetricsBoxEl extends HTMLElement { _mhtml?: string; }

  function renderEngineMetrics(card: HTMLElement, name: string) {
    const box = card.querySelector(".eng-metrics") as MetricsBoxEl | null;
    if (!box) return;
    const online = state.engines.some((e) => e.name === name && e.online);
    let html = "";
    if (!online) {
      html = "";
    } else {
      const m = state._metrics[name];
      if (!m) {
        html = `<span class="mm-muted">监控数据加载中…</span>`;
      } else if (!m.ok) {
        html = `<span class="mm-muted">${m.error === "unsupported" ? "无监控指标（服务版本过旧）" : "监控暂不可用"}</span>`;
      } else {
        const mm = m.metrics || ({} as EngineMetrics);
        const gpu = mm.gpu || null;
        const jobs = mm.jobs;
        // sparkline：最近 120 点；有 GPU → 利用率曲线，无 GPU → 队列深度曲线
        const hist = (mm.history || []).slice(-120);
        let spark = "";
        if (hist.length >= 2) {
          const useGpu = !!(gpu && gpu.present && gpu.util_pct != null);
          const vals = hist.map((h) => (useGpu ? (h.gpu_util ?? 0) : h.running + h.queued));
          const max = useGpu ? 100 : Math.max(10, Math.ceil(Math.max(...vals) / 10) * 10);
          const W = 132, H = 26;
          const step = W / (hist.length - 1);
          const pts = vals
            .map((v, i) => `${(i * step).toFixed(1)},${(H - 2 - (Math.min(v, max) / max) * (H - 8)).toFixed(1)}`)
            .join(" ");
          spark = `<svg class="spark" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" aria-hidden="true"><polygon class="spark-area" points="0,${H} ${pts} ${W},${H}"></polygon><polyline class="spark-line" points="${pts}"></polyline></svg>`;
        }
        let main: string;
        if (gpu && gpu.present) {
          const usedGb = gpu.mem_used_mb != null ? (gpu.mem_used_mb / 1024).toFixed(1) : "—";
          const totGb = gpu.mem_total_mb != null ? (gpu.mem_total_mb / 1024).toFixed(1) : "—";
          main = `GPU ${gpu.util_pct != null ? Math.round(gpu.util_pct) : "—"}% · 显存 ${usedGb}/${totGb}G`;
        } else {
          main = "队列深度";
        }
        const sub = jobs ? `排队 ${jobs.queued} · 运行 ${jobs.running}` : "";
        html = `<div class="mm-row"><span class="mm-main mono" title="${esc(gpu && gpu.name ? gpu.name : "")}">${esc(main)}</span>${spark}</div>${sub ? `<div class="mm-sub mono">${esc(sub)}</div>` : ""}`;
      }
    }
    if (box._mhtml !== html) { box._mhtml = html; box.innerHTML = html; }
  }

  $("engine-grid").onclick = async (ev) => {
    const target = ev.target as HTMLElement;
    const bal = target.closest<HTMLElement>(".bal-chk");
    if (bal) {
      if (typeof t.setEngineEnabled !== "function") return;
      const name = bal.dataset.name || "";
      const on = (bal as HTMLInputElement).checked;
      try {
        await t.setEngineEnabled(name, on);
        toast(`「${name}」${on ? "已加入自动均衡" : "已退出自动均衡"}`, "ok");
        refresh();
      } catch (ex) {
        (bal as HTMLInputElement).checked = !on;
        toast(ex instanceof Error ? ex.message : "设置失败", "err");
      }
      return;
    }
    const edit = target.closest<HTMLElement>(".edit");
    if (edit) {
      if (typeof t.updateEngine !== "function") return; // web 形态无本地引擎登记（理论分支）
      void engineEditOpen(edit.dataset.name || "");
      return;
    }
    const del = target.closest<HTMLElement>(".del");
    if (del) {
      const name = del.dataset.name || "";
      if (!confirm(`删除服务「${name}」？`)) return;
      await t.deleteEngine(name);
      refresh();
      return;
    }
  };

  // ---------- 任务行（按任务 key 就地更新：进度/ETA/位置只改文字与条宽，不重排行节点，扫光与过渡不中断） ----------
  interface JobRowEl extends HTMLDivElement { _core?: string; _html?: string; }

  function jobKey(j: JobRow) {
    // 派发「行优先」pending 行：无 job_id、created 为建行时刻 → 用显式稳定 key
    if (j.pkey) return j.pkey;
    // 一个 job 可含多个文件（watcher 批量），逐行展平后必须带文件名，
    // 否则同 job 的多行会共用 key 被去重折叠（09-05 分页验收时暴露）
    return j.engine + "|" + (j.job_id || "") + "|" + (j.file || "") + "|" + (j.created || "");
  }

  // 改派目的地选项：auto（派发时刻实时选最闲）+ 已注册服务；cur 预置当前绑定
  function reassignOptions(cur: string): string {
    const curOk = cur === "auto" || (state.engines || []).some((e) => e.name === cur);
    const opts = [`<option value="auto"${cur === "auto" ? " selected" : ""}>⚖ 自动</option>`];
    for (const e of state.engines || []) {
      if (e.enabled === false) continue;
      opts.push(`<option value="${esc(e.name)}"${e.name === cur ? " selected" : ""}>${esc(e.name)}${e.online ? "" : "（离线）"}</option>`);
    }
    return curOk && cur !== "auto" ? opts.join("") : opts.join("");
  }

  function jobRowData(j: JobRow, now: number) {
    const key = jobKey(j);
    const sel = state.selected.has(key);
    const pct = Math.round((j.progress || 0) * 100);
    const isRun = j.status === "running";
    // 行优先 pending 子行：排队未开始给单行「取消」；ETA 由阶段文案自带（不重复算，防跨阶段串味）
    const isPendingRow = j.dispatch_pending === true;
    // F4/F5 ghost 行（pre 占位 / lost 在途丢失）：renderer 本地行，无 job_id，按钮走独立 ghost- 类
    const isGhost = typeof j.pkey === "string" && j.pkey.startsWith("ghost|");
    const pendQueued = isPendingRow && !j.job_id && j.status === "pending";
    // 尚未拿到 job_id 的 pending 行不参与勾选：服务侧还不认识它，
    // 批量操作（暂停/取消/重试/改派）按 _jobs 取行，选了也是空操作（口径同 _filteredKeys）
    const pendNoJob = isPendingRow && !j.job_id;
    // 服务单任务挂起：行 status 仍是 pending，展示态归一为「已暂停」
    const st = j.paused ? "paused" : j.status;
    const paused = st === "paused";
    // 位置列：运行中/已暂停显示当前处理阶段（服务端日志事件驱动）；
    // 终态（done/skipped/canceled）不显陈旧时间轴位置（F2：「position / duration」在 60px 列折 2 行）；
    // error 保留失败位置（排障价值）；文本位置（「已跳过（主任务取消）」等，无 duration_s）原样保留
    const posPair = j.duration_s != null && j.position
      ? `${j.position} / ${fmtDuration(j.duration_s)}` : "";
    const pos = isRun || paused
      ? (j.phase_detail || (paused ? "已暂停（等待继续）" : "—"))
      : (posPair && (j.status === "done" || j.status === "skipped" || j.status === "canceled")
        ? "—" : (posPair || j.position || "—"));
    const createdSeconds = timestampSeconds(j.created);
    const finishedSeconds = timestampSeconds(j.finished);
    const elapsed = createdSeconds != null
      ? fmtDuration(Math.max(0, (finishedSeconds ?? now) - createdSeconds))
      : "—";
    const createdAt = fmtJobDateTime(j.created);
    const finishedAt = fmtJobDateTime(j.finished);
    let eta = "";
    const prog = j.progress || 0;
    if (isRun && !isPendingRow) {
      if (j.eta_s != null && j.eta_s >= 0 && j.eta_s < 86400) {
        eta = `剩 ~${fmtDuration(j.eta_s)}`;
      } else if (prog > 0.01 && createdSeconds != null) {
        const el = now - createdSeconds;
        eta = el > 5 ? `剩 ~${fmtDuration(el * (1 - prog) / prog)}` : "";
      }
    }
    // 主名：远端/上传任务 file 是 opus 内容寻址 hash（<sha1>.opus），
    // label 才是上传时的原始视频名——此时用视频名当主名（hash 泄漏进任务表即 F2 投诉）；
    // 本地任务 label 与 file 同值、或「文件夹扫描 · N 项」批量占位 → 主名仍用 file。
    const labelMain = jobLabelMain(j);
    const primary = jobPrimaryName(j);
    // 跳过行优先显示 message（含已存在字幕的完整路径）；ghost 行恒显 message（状态说明）
    // 0.2.57：中断行恒显中断原因（链路为何断开，供用户判断重跑/清除）
    const sub = isGhost ? (j.message || "")
      : j.status === INTERRUPTED && j.message ? j.message
      : j.status === "skipped" && j.message ? j.message
      : (!labelMain && j.message) ? j.message : "";
    // 0.2.51 派发账本行：服务端记录已不可寻址（200 窗挤出 / serve 重启丢失）→
    // serve 侧操作（重试/取消/挂起/恢复/下载/预览）一律不给，避免对不存在的任务发请求
    const isLedger = j.ledger === true;
    const isServeRow = !!j.job_id && !isLedger;
    const dl = j.status === "done" && j.job_id && !isLedger
      ? `<a class="dl-btn" href="${t.getResultUrl(j.engine, j.job_id)}" download="${esc(srtNameFor(j))}" title="下载生成的字幕（.srt）">&#8595; 下载</a>`
      : "";
    // 预览：done 且有任务 id → 走 result 端点拉内容（本地扫描/远端任务通用）
    const pv = j.status === "done" && j.job_id && !isLedger
      ? `<button type="button" class="srt-pv" data-eng="${esc(j.engine)}" data-jid="${esc(j.job_id)}" title="预览生成的字幕（时间轴 + 全文）">预览</button>`
      : "";
    // 本地扫描任务：工作台本机字幕回写状态（ok / skipped_exists / skipped / failed:…）
    const WB_TAG: Record<string, string> = { ok: "已落回本机", skipped_exists: "字幕已存在，未覆盖", skipped: "生成被跳过" };
    const wb = j.writeback
      ? `<span class="wb-tag${j.writeback.startsWith("failed") ? " wb-err" : ""}" title="${esc(j.writeback)}">${esc(j.writeback.startsWith("failed") ? "回写失败" : (WB_TAG[j.writeback] || j.writeback))}</span>`
      : "";
    // 本地扫描任务：提交前检测到的字幕状态（制作图「已有字幕」提示）
    const SUB_SRC: Record<string, string> = { external: "外部 srt", embedded: "内嵌轨", named: "标记（名）" };
    const ss = j.sub_status && SUB_SRC[j.sub_status]
      ? `<span class="wb-tag sub-exist" title="提交前检测到${SUB_SRC[j.sub_status]}，经确认继续生成">已有字幕</span>`
      : "";
    const retryKey = j.engine + "|" + (j.job_id || "");
    // 他端标记：他端客户端提交的服务任务（字幕不落回本机；服务端操作仍可用）
    const srcTag = j.local === false
      ? `<span class="src-tag" title="该任务由其他客户端提交：可看进度并做服务端操作（暂停/继续/重试/取消/下载 srt）；源视频不在本机，字幕不会自动落回本机磁盘">他端</span>`
      : "";
    // F5.1：离线引擎的非终态 serve 行 → 「服务离线」标注（行=服务最后在线时的观测状态；复用 .wb-tag 不加新类）
    const offTag = isServeRow && offlineEngines.has(j.engine) && !j.paused
      && j.status !== "done" && j.status !== "skipped" && j.status !== "error" && j.status !== "canceled"
      ? `<span class="wb-tag" title="服务离线：该行是服务最后在线时的观测状态，进度不再更新；服务恢复后任务仍在则自动续显，已消失则落「失败（服务重启丢失）」行">服务离线</span>`
      : "";
    const jobActive = isServeRow && state._jobActive.get(retryKey) === true;
    // 跳过（服务行）：删旧字幕重新生成
    const retry = isServeRow && j.status === "skipped" && !state.retried.has(retryKey)
      ? `<button type="button" class="dl-btn retry" data-eng="${esc(j.engine)}" data-jid="${esc(j.job_id)}" data-mode="regen" title="删除已存在字幕并重新生成">&#8635; 仍要生成</button>`
      : (isServeRow && j.status === "skipped" ? `<span class="retried-note">已重新提交</span>` : "");
    // 失败（服务行，serve 0.2.3+）：直接重新入队，不删已生成字幕
    const srvRetry = isServeRow && j.status === "error" && !state.retried.has(retryKey)
      ? `<button type="button" class="dl-btn retry" data-eng="${esc(j.engine)}" data-jid="${esc(j.job_id)}" data-mode="error" title="将该文件重新入队生成（不删已生成字幕）">&#8635; 重试</button>`
      : "";
    // 单任务挂起/恢复（服务行，serve 0.2.3+；仅排队中且任务空闲可挂起，运行中请用取消）
    const pauseJobBtn = isServeRow && !!t.pauseJob && !j.paused && j.status === "pending" && !jobActive
      ? `<button type="button" class="dl-btn pause-job" data-eng="${esc(j.engine)}" data-jid="${esc(j.job_id)}" title="挂起排队中的任务（不占服务并发；运行中的任务请改用取消）">&#9208; 暂停</button>`
      : "";
    const resumeJobBtn = isServeRow && !!t.resumeJob && j.paused
      ? `<button type="button" class="dl-btn resume-job" data-eng="${esc(j.engine)}" data-jid="${esc(j.job_id)}" title="恢复挂起的任务，重新排队等待服务并发">&#9654; 继续</button>`
      : "";
    // 本机管线行（工作台本机任务：无 job_id 但有 task_id + 本机视频路径）：
    // 失败→重试 / 已暂停→继续（均=重提取音轨并重提交）；浏览器上传任务无本机路径，不给按钮
    const isLocalRow = !isServeRow && !!j.task_id && !!j.local_path && !!t.rerunLocal;
    const localAct = isLocalRow && (j.status === "error" || j.status === "paused")
      ? (j.status === "paused"
        ? `<button type="button" class="dl-btn resume-job rerun-local" data-tid="${esc(j.task_id)}" data-mode="resume" title="继续：重新提取音轨并重新提交（本机视频需仍存在）">&#9654; 继续</button>`
        : `<button type="button" class="dl-btn retry rerun-local" data-tid="${esc(j.task_id)}" data-mode="error" title="重试：重新提取音轨并重新提交（本机视频需仍存在）">&#8635; 重试</button>`)
      : "";
    // 本机管线行暂停（排队/提取/派发中，未提交服务）：重提取音轨才能恢复
    const localPauseBtn = isLocalRow && !!t.pauseLocalTask && j.status === "running"
      ? `<button type="button" class="dl-btn pause-local" data-tid="${esc(j.task_id)}" title="暂停本机管线：停止排队/提取；恢复需重新提取音轨并提交">&#9208; 暂停</button>`
      : "";
    // 本机行改派目的地服务（仅排队/已暂停、未提交服务）：实时改道——
    // 排队中等待登记立即跟随新服务组；auto=派发时刻按实时负载选最闲
    const reassignCtl = isLocalRow && !!t.reassignLocal && !j.job_id
      && (j.phase === "queued" || j.phase === "paused")
      ? `<select class="reassign-sel" data-tid="${esc(j.task_id)}" title="改派目的地服务（排队/暂停中实时生效）">${reassignOptions(j.engine)}</select>`
        + `<button type="button" class="dl-btn reassign-go" data-tid="${esc(j.task_id)}" title="应用改派">&#10230;</button>`
      : "";
    // 取消（运行中/排队，未挂起）：协作式——排队立即收尾；运行中检查点中止；已生成字幕保留
    const cancel = (j.status === "running" || j.status === "pending") && j.job_id && !j.paused && !isLedger
      ? `<button type="button" class="dl-btn cancel" data-eng="${esc(j.engine)}" data-jid="${esc(j.job_id)}" title="终止排队/未开始文件；运行中将在检查点中止，已生成字幕保留">&#10006; 取消</button>`
      : "";
    // 换服务重跑（仅 desktop）：复用本地音轨缓存向其他服务提交新任务。
    // 0.2.47：从终态放宽到 排队/运行/暂停（cancel-first：先取消原任务再重交，防双活）；
    // data-file 传显示主名（remote 行 file 是 opus hash，传 hash 缓存必 miss → 既有 bug 修复）
    const rerunNonTerminal = j.job_id && (st === "pending" || st === "running" || st === "paused");
    const rerunBtn = (platform.kind === "desktop" && j.file && !isPendingRow && !isGhost
      && j.local !== false
      && ((j.status === "done" || j.status === "error" || j.status === "skipped") || rerunNonTerminal))
      ? `<button type="button" class="dl-btn rerun" data-file="${esc(primary)}" data-eng="${esc(j.engine)}" data-jid="${esc(j.job_id || "")}" data-status="${esc(st)}" data-fp="${esc(j.file_path || "")}" title="${rerunNonTerminal ? "先取消原服务上的任务（排队中立即终止；运行中检查点中止，已生成字幕保留），再向另一个服务端重新提交（音轨缓存或源视频直读）" : "复用该影片的本地音轨缓存或源视频，选择另一个服务端重新提交"}">&#8644; 重跑</button>`
      : "";
    // 行优先 pending 子行（未开始、未提交服务）：单行取消 = 不进队列、不占在途（链已开跑不给按钮）
    const pendCancel = pendQueued
      ? `<button type="button" class="dl-btn pend-cancel" data-pkey="${esc(key)}" title="取消该子任务（尚未开始，不会提交服务）">&#10006; 取消</button>`
      : "";
    // 0.2.51 账本行：单行清除本地记录（0.2.57 起全部账本行可清——非终态行重启后已落「中断」，同样可清）
    const ledClear = isLedger
      ? `<button type="button" class="dl-btn led-clear" data-pkey="${esc(key)}" title="清除该本地记录：仅删本机派发账本条目，不动服务端">&#10005; 清除</button>`
      : "";
    // 0.2.57 中断账本行：单行重跑（ghost-retry 同款路径：重提取音轨→上传→提交；原服务在线回原服务，否则自动均衡）
    const ledRerun = isLedger && j.status === INTERRUPTED
      ? (j.file_path
        ? `<button type="button" class="dl-btn led-rerun" data-pkey="${esc(key)}" data-fp="${esc(j.file_path)}" title="重跑：重新提取音轨并提交服务（源文件需仍存在）">&#8635; 重跑</button>`
        : `<button type="button" class="dl-btn led-rerun" disabled title="源文件路径未记录：请重新扫描该文件并提交">&#8635; 重跑</button>`)
      : "";
    // F4/F5 ghost 行按钮：重试（重新提交）/ 取消（丢弃 pre 登记）——独立类，不撞通用 .retry/.cancel handler
    const gGhost = isGhost ? ghostRows.get(key) : undefined;
    const gRetry = isGhost && gGhost?.videoPath
      ? `<button type="button" class="dl-btn ghost-retry" data-gkey="${esc(key)}" title="重试：重新提交该文件（按路径重提服务，或重新提取音轨上传）">&#8635; 重试</button>`
      : "";
    const gCancel = isGhost && j.pkey!.startsWith("ghost|pre|")
      ? `<button type="button" class="dl-btn ghost-cancel" data-gkey="${esc(key)}" title="丢弃该登记：放弃此文件的字幕生成">&#10006; 取消</button>`
      : "";
    // core：变化时整行重写（状态/文件/操作按钮，低频）；pct/eta/pos/elapsed 单独打补丁（高频）
    const core = [key, sel, j.status, j.paused, j.engine, j.file, sub, dl, pv, retry, srvRetry, pauseJobBtn, resumeJobBtn, localAct, localPauseBtn, reassignCtl, rerunBtn, pos, wb, ss, offTag, cancel, pendCancel, ledClear, ledRerun, gRetry, gCancel, srcTag, createdAt, finishedAt].join("\u0001");
    const html = `
      <label class="job-chk-box"><input type="checkbox" class="job-chk" data-key="${esc(key)}"${sel ? " checked" : ""}${pendNoJob || isGhost ? " disabled" : ""} aria-label="勾选任务（批量操作）"></label>
      <div class="job-cell" title="${j.engine === "auto" ? "派发时按实时负载自动选择服务" : ""}">${esc(j.engine === "auto" ? "⚖ 自动均衡" : j.engine)}</div>
      <div class="job-name"><div class="fn">${esc(primary)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
      <div><span class="pill p-${esc(st)}"><i></i>${STATUS_ZH[st] || esc(st)}</span>${srcTag}${wb}${ss}${offTag}</div>
      <div class="prog"><div class="bar${isRun ? " live" : ""}"><div style="width:${pct}%"></div></div><span class="pct mono">${pct}%</span><span class="eta"></span></div>
      <div class="job-cell mono cell-pos" title="${esc(pos)}">${esc(pos)}</div>
      <div class="job-cell mono cell-elapsed">${esc(elapsed)}</div>
      <div class="job-cell mono cell-created">${esc(createdAt) || "—"}</div>
      <div class="job-cell mono cell-finished${j.status === "done" && finishedAt ? " is-done" : ""}">${esc(finishedAt) || "—"}</div>
      <div class="job-actions">${dl}${pv}${retry}${srvRetry}${pauseJobBtn}${resumeJobBtn}${localAct}${localPauseBtn}${reassignCtl}${rerunBtn}${pendCancel}${cancel}${ledClear}${ledRerun}${gRetry}${gCancel}</div>`;
    return { html, core, pct, eta, pos, elapsed };
  }

  function patchJobRow(row: JobRowEl, pct: number, eta: string, pos: string, elapsed: string) {
    const bar = row.querySelector(".bar > div") as HTMLDivElement | null;
    if (bar) bar.style.width = pct + "%";
    const pctEl = row.querySelector(".pct");
    if (pctEl && pctEl.textContent !== pct + "%") pctEl.textContent = pct + "%";
    const etaEl = row.querySelector<HTMLElement>(".eta");
    if (etaEl) {
      if (etaEl.textContent !== eta) etaEl.textContent = eta;
      if (etaEl.title !== eta) etaEl.title = eta; // 窄列截断时全文进 tooltip
    }
    const posEl = row.querySelector<HTMLElement>(".cell-pos");
    if (posEl) {
      if (posEl.textContent !== pos) posEl.textContent = pos;
      if (posEl.title !== pos) posEl.title = pos;
    }
    const elEl = row.querySelector(".cell-elapsed");
    if (elEl && elEl.textContent !== elapsed) elEl.textContent = elapsed;
  }

  // ---------- 主任务（batch）：聚合状态 / 行渲染 ----------

  function genBatchId(): string {
    return "b-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function batchLabelForScan(): string {
    const p = state.scanResolvedPath || (state.lastScan?.path || "");
    if (p) {
      const segs = p.split(/[\\/]+/).filter(Boolean);
      if (segs.length) return segs[segs.length - 1];
    }
    return "扫描目录";
  }

  function batchLabelForFolder(): string {
    const f0 = (state.folderFiles || [])[0]?.file;
    if (!f0) return "文件夹";
    const lp = (f0 as FolderFile)._localPath;
    if (lp) {
      const segs = lp.split(/[\\/]+/).filter(Boolean);
      if (segs.length > 1) return segs[segs.length - 2];
      return "文件夹";
    }
    const rel = f0.webkitRelativePath || "";
    if (rel.includes("/")) return rel.split("/")[0];
    return "文件夹";
  }

  // 0.2.52 M1：按盘拆 batch 的目录名口径（多组 label 用；单组维持 batchLabelForFolder/batchLabelForScan 不变）。
  // 文件夹路径目录名 = webkitRelativePath 首段（原生选择 rel 以根目录名开头、webkitdirectory 输入
  // 天然顶层目录名开头 → 两口径统一即「用户选的目录名」）；rel 缺失时退 _localPath 父目录名。
  function folderFileDirName(f: FolderFile): string {
    const rel = f.webkitRelativePath || "";
    const segs = rel.split("/").filter(Boolean);
    if (segs.length) return segs[0];
    const lp = f._localPath || "";
    const lsegs = lp.split(/[\\/]+/).filter(Boolean);
    if (lsegs.length > 1) return lsegs[lsegs.length - 2];
    return "文件夹";
  }
  // 扫描路径目录名 = 文件父目录名（平扫即扫描根目录名；多组仅跨挂载稀有情形）。
  function scanPathDirName(p: string): string {
    const segs = p.split(/[\\/]+/).filter(Boolean);
    if (segs.length > 1) return segs[segs.length - 2];
    if (segs.length === 1) return segs[0];
    return "扫描目录";
  }

  function batchAgg(children: JobRow[]): { status: string; label: string; pct: number } {
    let status = "done";
    let label = "";
    if (children.length) {
      // 优先级 paused > running：本机冻结行走既有口径 status="running"（phase=queued），
      // running 在前会让冻结 batch 的主行卡在「运行中」，永远到不了「已暂停」（「继续」按钮不可达）
      if (children.some((j) => j.status === "paused" || j.paused === true || j.batch_paused === true)) status = "paused";
      else if (children.some((j) => j.status === "running")) status = "running";
      else if (children.every((j) => TERMINAL_LIKE.has(j.status))) {
        if (children.every((j) => j.status === INTERRUPTED)) {
          // 0.2.57：整批中断（客户端重启/退出）→ 主行「中断」（组级 [重跑全部][清除]）
          status = INTERRUPTED;
        } else if (children.some((j) => j.status === "error" || j.status === "canceled")) {
          status = "error";
          // 行优先：整批都没提交成功（取消 + 主任务取消跳过的链）= 主任务「已取消」；
          // 混有真失败仍是「完成（部分失败）」
          // F1：「完成（部分失败）」pill ~119px 溢出 92px 状态列叠压进度条 → 缩短 label，完整语义进 pill title
          label = children.every((j) => j.status === "canceled" || j.status === "skipped")
            ? "已取消" : "部分失败";
        } else if (children.some((j) => j.status === INTERRUPTED)) {
          label = "含中断"; // 完成但部分子任务中断（客户端重启/退出）
        }
      } else {
        status = "pending";
      }
    }
    const pct = children.length
      ? Math.round((children.reduce((s2, j) => s2 + (j.progress || 0), 0) / children.length) * 100)
      : 100;
    return { status, label, pct };
  }

  function batchRowHtml(
    g: { bid: string; children: JobRow[]; stale?: { created?: number | null; finished?: number | null } },
    label: string,
    agg: { status: string; label: string; pct: number },
    created: number | null,
    finished: number | null,
    elapsed: string,
    collapsed: boolean,
    ops: string,
  ): string {
    const timeTitle = (created ? `开始 ${fmtJobDateTime(created)}` : "")
      + (finished ? ` · 完成 ${fmtJobDateTime(finished)}` : "");
    // F1：label 缩短后完整语义进 pill title（hover 可见）
    const pillTitle = agg.label
      ? (agg.label === "已取消" ? "整批已取消：子任务未开始或被终止"
        : agg.label === "含中断" ? "整批结束：部分子任务中断（客户端重启/退出），其余完成"
        : "整批结束：部分子任务失败或取消，其余完成")
      : (agg.status === INTERRUPTED ? "整批中断：客户端重启/退出导致任务链路断开，可「重跑全部」" : "");
    return `
      <button type="button" class="batch-caret" data-bid="${esc(g.bid)}" title="${collapsed ? "展开子任务" : "收起子任务"}">${collapsed ? "&#9656;" : "&#9662;"}</button>
      <div class="job-cell mono batch-sub-n">${g.children.length} 子任务</div>
      <div class="job-name"><div class="fn">${esc(label)}</div>${g.stale ? '<div class="sub">子任务已过期（记录保留）</div>' : ""}</div>
      <div><span class="pill p-${esc(agg.status)}"${pillTitle ? ` title="${esc(pillTitle)}"` : ""}><i></i>${esc(agg.label || STATUS_ZH[agg.status] || agg.status)}</span></div>
      <div class="prog"><div class="bar${agg.status === "running" ? " live" : ""}"><div style="width:${agg.pct}%"></div></div><span class="pct mono">${agg.pct}%</span></div>
      <div class="job-cell mono cell-pos cell-bt"${timeTitle ? ` title="${esc(timeTitle)}"` : ""}>—</div>
      <div class="job-cell mono cell-elapsed">${esc(elapsed)}</div>
      <div class="job-cell mono cell-created">${created ? esc(fmtJobDateTime(created)) : "—"}</div>
      <div class="job-cell mono cell-finished${agg.status === "done" && finished ? " is-done" : ""}">${finished ? esc(fmtJobDateTime(finished)) : "—"}</div>
      <div class="job-actions">${ops}</div>`;
  }

  function patchBatchRow(row: JobRowEl, pct: number, elapsed: string): void {
    const bar = row.querySelector(".bar > div") as HTMLDivElement | null;
    if (bar) bar.style.width = pct + "%";
    const pctEl = row.querySelector(".pct");
    if (pctEl && pctEl.textContent !== pct + "%") pctEl.textContent = pct + "%";
    const elEl = row.querySelector(".cell-elapsed");
    if (elEl && elEl.textContent !== elapsed) elEl.textContent = elapsed;
  }

  // ---------- 派发「行优先」（10-10-javscribe-dispatch-row-first）----------
  // 背景：65 文件批量走本机提取回退时，提取/上传进度全压在「生成字幕」页的流程节点上，
  // 任务表此时是空的。改为：提交即建主任务 + N 条 pending 子行，派发链各阶段进度写进对应
  // 子行；serve 真行出现（同 job_id）后 pending 行让位删除（不双行）。
  // 范围线：仅桌面端多文件批量（runDispatchQueue）；单文件派发与 web 批量仍走派发页
  // pipeline（e2e / UX 依赖）。pending 行只活在 renderer（state._pending），
  // 不写 state._jobs —— 在途封顶口径（countInFlightRows）必须维持 serve-only。
  const PENDING_TEXT: Record<string, [string, string]> = {
    queued: ["排队提取", "排队等待本机派发"],
    "1:local": ["本地提音轨", "本机提取音轨中"],
    "1:server": ["上传视频", "整片上传中"],
    "2:local": ["上传音频", "音频上传中"],
    "2:server": ["服务端提取", "服务端提取音轨中"],
    "3": ["提交生成", "提交生成任务中"],
  };

  function pendingRows(): JobRow[] {
    // 全局暂停（pause-all）：待派发 pending 行套「已暂停」显示副本——行 pill/批次 pill/已暂停桶
    // 同步反映冻结态（用户「暂停没效果」修复）。不 mutate 原行：批次级 pause/resume 记账靠
    // r.status="paused"+_prevStatus；summary 翻转后副本自然消失，恢复自愈。
    // 仅 queued 态（status=pending）：提取中/上传中的行 ffmpeg/传输在真跑，管线闸只冻新派发，
    // 标「已暂停」是假话。summary 为 null（接口失败）→ 不套副本，回退现状。
    const gp = !!state._summary?.paused_all;
    return Array.from(state._pending.values()).map((p) =>
      gp && p.row.dispatch_pending && !p.row.job_id && p.row.status === "pending"
        ? { ...p.row, paused: true, position: "已暂停（全局暂停）", phase_detail: "已暂停（全局暂停）", message: "全局暂停中：点「继续任务」恢复" }
        : p.row,
    );
  }

  // 服务队列挂起（serve /health.paused=true，serve 0.2.3+；桌面/工作台快照均带此字段）：
  // 该服务上的排队中行（有 job_id、非终态、非 running）在服务端恢复前不会开跑 → 显示
  // 「已暂停（服务队列挂起）」（仅显示副本，不 mutate 原行；恢复后下轮 refresh 自愈）。
  // running 行不标：真 serve 队列暂停语义是「运行中跑完、不开新」，其进度仍属实。
  // 与全局暂停（paused_all 套本机 pending 行显示副本）互补：全文件已提交服务的批次
  // 暂停所有后主行不再卡「运行中」（用户「暂停没效果」诉求的另一半）。
  function applyQueuePauseDisplay(rows: JobRow[]): JobRow[] {
    const pausedEngines = new Set(state.engines.filter((e) => e.online && e.paused).map((e) => e.name));
    if (!pausedEngines.size) return rows;
    return rows.map((j) =>
      j.job_id && !j.paused && j.status === "pending" && pausedEngines.has(j.engine)
        ? { ...j, paused: true, position: "已暂停（服务队列挂起）", phase_detail: "已暂停（服务队列挂起）", message: "服务队列挂起：点「继续任务」恢复" }
        : j);
  }

  /** 排序秩（0.2.57）：running > interrupted > pending（排队/派发/上传）> paused > 其余终态；
   *  桶内 created 降序。中断行置顶一档：链路已断、需用户动作（重跑/清除），必须最先看到 */
  function pendingRank(r: JobRow): number {
    if (r.status === "running") return 0;
    if (r.status === INTERRUPTED) return 1;
    if (r.status === "unsubmitted") return 4; // F4 占位行：终态不抢置顶
    if (TERMINAL_LIKE.has(r.status)) return 4;
    if (r.paused || r.status === "paused") return 3; // 含全局暂停/服务队列挂起的显示副本
    return 2; // pending：排队/派发/上传/提交中
  }

  function ghostRowsList(): JobRow[] {
    return [...ghostRows.values()].map((g) => g.row);
  }

  /** serve 行 + pending 行 + 账本行 + ghost 行合并（口径同 job-rows：活跃优先 → created 降序；
   *  同批 pending 保队列正序）。账本行只进渲染层，不写 state._jobs（在途封顶 serve-only 不变式） */
  function mergePendingRows(rows: JobRow[]): JobRow[] {
    const pend = pendingRows();
    const led = ledgerRows(rows);
    const ghosts = ghostRowsList();
    if (!pend.length && !led.length && !ghosts.length) return rows;
    const out = rows.concat(pend, led, ghosts);
    out.sort((a, b) => pendingRank(a) - pendingRank(b) || (b.created || 0) - (a.created || 0));
    return out;
  }

  // pending 行进度 → 300ms 合帧重渲染（serve 轮询 5s 一次，行优先期间靠这里驱动看板）
  let pendingRenderTimer: number | null = null;
  function schedulePendingRender(): void {
    if (pendingRenderTimer != null) return;
    pendingRenderTimer = window.setTimeout(() => {
      pendingRenderTimer = null;
      renderJobs(state._jobs);
    }, 300);
  }

  /** 批量启动即建行：每个文件一条 pending 子行（serve 此时还没有任务，行先行） */
  function createPendingRows(
    batch: { id: string; label: string },
    queue: FolderFile[],
    engine: string,
  ): PendingDispatch[] {
    const base = Date.now() / 1000;
    const out: PendingDispatch[] = [];
    const pos = PENDING_TEXT.queued[0];
    queue.forEach((f, idx) => {
      const pkey = "pend|" + batch.id + "|" + idx;
      const row: JobRow = {
        engine,
        job_id: null,
        label: f.name,
        file: f.name,
        status: "pending",
        phase: "queued",
        progress: 0,
        position: pos,
        phase_detail: pos,
        message: PENDING_TEXT.queued[1],
        // 同批递减：created 降序排序后仍是提交队列正序（同毫秒建行也不会被打乱）
        created: base - idx * 0.001,
        finished: null,
        batch_id: batch.id,
        batch_label: batch.label,
        dispatch_pending: true,
        pkey,
        // 0.2.57：源文件路径透传账本（中断重跑前置；web 形态无 _localPath → null 门控）
        file_path: f._localPath || null,
      };
      const p: PendingDispatch = { row, pkey, started: false, dispatched: false, enqueuedAt: null, aborted: false };
      state._pending.set(pkey, p);
      ledgerSyncPending(p); // 0.2.51：建行即入账本（中途退出客户端后重启可恢复）
      out.push(p);
    });
    return out;
  }

  /** pending 子行取消（主任务取消 / 单行取消统一入口）：
   *  - 已提交服务（有 job_id）/ 已终态 → 拒绝（交服务侧）
   *  - 链已派发（含提取池等槽——started 不覆盖此态）→ 打中止标记：等槽行出队即被入口闸拒绝
   *    （不起 ffmpeg），在跑行跑完当前阶段不提交；未开跑的等槽行行落「已取消」终态
   *  - 未派发 → 直接置「已取消」
   */
  function cancelPendingRow(p: PendingDispatch): boolean {
    const r = p.row;
    if (r.job_id || TERMINAL_LIKE.has(r.status)) return false;
    if (p.dispatched) {
      p.aborted = true;
      if (!p.started) {
        r.status = "canceled";
        r.phase = "queued";
        r.progress = 0;
        r.position = "已取消";
        r.phase_detail = "已取消";
        r.message = "已取消（未开始）";
        r.finished = Date.now() / 1000;
      } else {
        r.message = "主任务已取消：当前阶段跑完后不再提交服务";
      }
      ledgerSyncPending(p);
      schedulePendingRender();
      return true;
    }
    r.status = "canceled";
    r.phase = "queued";
    r.progress = 0;
    r.position = "已取消";
    r.phase_detail = "已取消";
    r.message = "已取消（未开始）";
    r.finished = Date.now() / 1000;
    ledgerSyncPending(p);
    schedulePendingRender();
    return true;
  }

  /** 主任务「取消」：未开始的 pending 子行置取消、已派发的链打中止标记（跑完不提交服务=跳过）；返回收掉数 */
  function cancelPendingBatch(bid: string): number {
    const q = batchQueues.get(bid);
    if (q) return q.cancel();
    let n = 0;
    for (const p of Array.from(state._pending.values())) {
      if (p.row.batch_id === bid && cancelPendingRow(p)) n++;
    }
    return n;
  }

  /** 该主任务是否已在服务侧留痕（真行可见 / 本地 batch 记录 / pending 子行已拿到 job_id） */
  function batchServed(bid: string): boolean {
    if ((state._jobs || []).some((j) => j.batch_id === bid && j.job_id)) return true;
    if ((state._batches || []).some((b) => b && b.batch_id === bid)) return true;
    for (const p of state._pending.values()) if (p.row.batch_id === bid && p.row.job_id) return true;
    return false;
  }

  /** 链外抛错兜底：pending 行留失败信息（serve 行不会出现，不写就静默丢任务） */
  function markPendingFail(p: PendingDispatch, msg: string): void {
    const r = p.row;
    if (r.status === "error" || r.status === "canceled" || r.status === "skipped" || r.job_id) return;
    r.status = "error";
    r.message = msg;
    r.finished = Date.now() / 1000;
    ledgerSyncPending(p);
    schedulePendingRender();
  }

  /** refresh 见 serve 真行 → pending 行让位删除（reconcilePending 同款思路） */
  function reconcilePendingRows(): void {
    if (!state._pending.size) return;
    const seen = new Set<string>();
    // 同批 serve 行的文件名索引：pending 子行交棒前的双行窗口用（见下）
    const nameIndex = new Map<string, string>(); // batch_id + "|" + 文件名 → job_id
    for (const r of state._jobs) {
      if (!r.job_id) continue;
      const jid = String(r.job_id);
      seen.add(jid);
      if (r.batch_id) {
        for (const nm of [r.file, r.label]) {
          if (nm) nameIndex.set(r.batch_id + "|" + nm, jid);
        }
      }
    }
    const now = Date.now() / 1000;
    for (const [key, p] of Array.from(state._pending)) {
      const r = p.row;
      const jid = r.job_id;
      if (jid) {
        // 已入队：serve 行可见即让位；60s 仍不可见（服务重启/挤出内存窗）兜底删除不留幻行
        if (seen.has(String(jid)) || (p.enqueuedAt != null && now - p.enqueuedAt > 60)) {
          state._pending.delete(key);
          ledgerFinger.delete(key); // 0.2.51：行已交棒/过期，账本条目保留（重启恢复用）但指纹释放
        }
        continue;
      }
      // 交棒窗口：serve 的 job 在上传应答那一刻就已存在，而 pending 行要等 pollUpload
      // 下一拍（≤1s）才拿到 job_id——这期间若 refresh 先到，同一文件会双行。
      // 故：子行已进入提交阶段（上传已应答）且同批同文件名的 serve 行可见 → 直接交棒删除。
      if ((r.phase === "submitting" || r.phase === "enqueued") && r.batch_id) {
        const hit = nameIndex.get(r.batch_id + "|" + (r.file || ""))
          || nameIndex.get(r.batch_id + "|" + (r.label || ""));
        if (hit) {
          r.job_id = hit;
          state._pending.delete(key);
          ledgerFinger.delete(key); // 0.2.51：同上
        }
      }
    }
    // 未入队的终态行（取消/跳过/失败）只活在本次会话，超 200 丢最旧，防长跑久堆积
    const dead = Array.from(state._pending.values()).filter((p) => !p.row.job_id
      && TERMINAL_LIKE.has(p.row.status));
    if (dead.length > 200) {
      dead.sort((a, b) => (a.row.finished || 0) - (b.row.finished || 0));
      for (const p of dead.slice(0, dead.length - 200)) state._pending.delete(p.pkey);
    }
  }

  /** 服务端提取阶段收尾文案（与原 markExtractDone 一致） */
  function extractDoneMeta(audioMb: number | null | undefined): string {
    return audioMb != null ? `音频 ${mbText(audioMb)}` : "音频提取完成";
  }

  const STEP_IDS = ["step-upload", "step-extract", "step-dispatch"];

  /** 派发链的进度出口：pipeline = 派发页流程节点（改造前原行为）；row = 任务表 pending 子行 */
  interface ChainSink {
    mode(m: "local" | "server"): void;
    stage(n: number, meta: string, prog?: number | null, width?: string): void;
    stageDone(n: number, meta: string): void;
    done(meta: string, info?: { audioMb?: number | null; jobId?: string | null }): void;
    fail(msg: string, n: number, info?: { audioMb?: number | null }): void;
    /** 提取池入队等槽（尚未执行）：行落「排队中」桶显示「前方 N」，不计「提取中」 */
    queue(n: number, meta: string): void;
    /** 主任务取消闸门：true = 子行已置「跳过」终态，调用方必须放弃提交服务 */
    abort(): boolean;
    /** 主任务「暂停」保持：暂停解除（或被取消）后 resolve；保持期间行显示「已暂停」（仅行优先路径实现） */
    holdWhilePaused?(): Promise<void>;
  }

  /** 派发页流程节点 sink：逐字复刻改造前的 setStep / setFill / 连线点亮时序 */
  function pipelineSink(): ChainSink {
    const stepId = (n: number): string => STEP_IDS[Math.max(1, Math.min(3, n)) - 1];
    const stageDone = (n: number, meta: string): void => {
      setStep(stepId(n), "done", "\u2713", meta);
      if (n === 1) line1.classList.add("on");
      else if (n === 2) line2.classList.add("on");
    };
    return {
      mode: (m) => { labelPipeline(m); },
      // 派发页 pipeline 不参与主任务取消：链照常提交服务
      abort: () => false,
      queue: (n, meta) => { setStep(stepId(n), "active", String(n), meta); setFill("0", true); },
      stage: (n, meta, prog, width) => {
        setStep(stepId(n), "active", String(n), meta);
        if (prog == null) setFill("0", true);
        else setFill(width || "0%");
      },
      stageDone,
      done: (meta, info) => {
        stageDone(2, extractDoneMeta(info?.audioMb));
        setStep("step-dispatch", "done", "\u2713", meta);
        setFill("100%");
      },
      fail: (msg, n, info) => {
        if (n === 3) stageDone(2, extractDoneMeta(info?.audioMb));
        setStep(stepId(n), "error", "\u2715", msg);
      },
    };
  }

  /** 任务表 pending 子行 sink：阶段/进度写行（派发页不再有逐文件流程节点） */
  function rowSink(p: PendingDispatch): ChainSink {
    const r = p.row;
    let mode: "local" | "server" = "local";
    // 位置列：运行中行取 phase_detail（见 jobRowData），故 position 与 phase_detail 同步写
    const setPos = (text: string, msg?: string): void => {
      r.position = text;
      r.phase_detail = text;
      if (msg != null) r.message = msg;
    };
    const stageKey = (n: number): string => (n === 3 ? "3" : `${n}:${mode}`);
    // 阶段语义：1=本机提取（local）/整片上传（server）；2=上传音频（local）/服务端提取（server）；3=提交
    const phaseOf = (n: number): string => (n === 3
      ? "submitting"
      : (mode === "local") === (n === 1) ? "extracting" : "uploading");
    return {
      mode: (m) => { mode = m; },
      // 池入队等槽：状态保持 pending（落「排队中」桶、不计「提取中」——并发显示虚高根因）
      queue: (_n, meta) => {
        if (r.job_id || TERMINAL_LIKE.has(r.status)) return;
        r.status = "pending";
        r.phase = "queued";
        setPos(meta, meta);
        r.progress = 0;
        ledgerSyncPending(p);
        schedulePendingRender();
      },
      stage: (n, meta, prog) => {
        // 终态行（已取消/跳过/完成）不被陈旧阶段回调复活（链在取消后仍可能推阶段事件）
        if (TERMINAL_LIKE.has(r.status)) return;
        p.started = true;
        r.status = "running";
        r.phase = phaseOf(n);
        setPos(meta, PENDING_TEXT[stageKey(n)]?.[1]);
        r.progress = prog == null ? 0 : Math.max(0, Math.min(1, prog));
        ledgerSyncPending(p);
        schedulePendingRender();
      },
      stageDone: (n, meta) => {
        if (TERMINAL_LIKE.has(r.status)) return;
        p.started = true;
        setPos(meta, meta);
        r.progress = 1;
        ledgerSyncPending(p);
        schedulePendingRender();
      },
      done: (_meta, info) => {
        if (TERMINAL_LIKE.has(r.status)) return;
        p.started = true;
        const jid = info?.jobId ? String(info.jobId) : null;
        r.status = "pending";
        r.phase = "enqueued";
        r.job_id = jid;
        r.progress = 1;
        setPos("已入队", jid ? `已入队，等待服务开始（任务 ${jid}）` : "已入队，等待服务开始");
        p.enqueuedAt = Date.now() / 1000;
        ledgerSyncPending(p); // job_id 到手：账本回填（重启后按 job_id 与服务端对账）
        schedulePendingRender();
      },
      // 主任务取消：跑完当前阶段后到此为止，不再提交服务（行标「跳过」，非失败）
      abort: () => {
        if (!p.aborted) return false;
        if (r.status === "skipped") return true;
        // 池等槽行取消时已落「已取消」（未起 ffmpeg）：保留终态，不降级为「跳过」
        if (r.status === "canceled") return true;
        r.status = "skipped";
        r.phase = "canceled";
        r.progress = 0;
        setPos("已跳过（主任务取消）", "主任务已取消，未提交服务");
        r.finished = Date.now() / 1000;
        ledgerSyncPending(p);
        schedulePendingRender();
        return true;
      },
      fail: (msg) => {
        if (r.job_id || r.status === "skipped" || r.status === "canceled") return;
        p.started = true;
        r.status = "error";
        r.message = msg;
        r.finished = Date.now() / 1000;
        ledgerSyncPending(p);
        schedulePendingRender();
      },
      // 主任务「暂停」保持：暂停期间行落「已暂停」（_prevStatus 记账待恢复），
      // 「继续」或主任务取消后 resolve（调用方随后走 isAborted/提交闸门收口）
      holdWhilePaused: () => new Promise<void>((res) => {
        const bid = r.batch_id;
        const step = (): void => {
          const release = !bid || !pausedBatches.has(bid) || p.aborted;
          if (!release) {
            if (r.status !== "paused" && !TERMINAL_LIKE.has(r.status)) {
              r._prevStatus = r.status;
              r.status = "paused";
              r.position = "已暂停（主任务暂停）";
              r.phase_detail = "已暂停（主任务暂停）";
              r.message = "主任务已暂停：提取上传冻结，点「继续」恢复";
              ledgerSyncPending(p);
              schedulePendingRender();
            }
            window.setTimeout(step, 500);
            return;
          }
          if (r.status === "paused") {
            r.status = r._prevStatus || "pending";
            r.position = PENDING_TEXT.queued[0];
            r.phase_detail = PENDING_TEXT.queued[0];
            r.message = PENDING_TEXT.queued[1];
            delete r._prevStatus;
            ledgerSyncPending(p);
            schedulePendingRender();
          }
          res();
        };
        step();
      }),
    };
  }

  // 最近一次合并行集（清理已完成按钮的计数口径；renderJobs 每轮更新）
  let lastMergedRows: JobRow[] = [];

  function renderJobs(rows: JobRow[]) {
    // 清理已完成：被抑制的服务端残留终态行不再显示（非终态复活由 reconcileLedger 解除抑制）
    const sup = ledger.suppress;
    const rowsIn = sup.length
      ? rows.filter((j) => !(j.job_id && TERMINAL_LIKE.has(j.status)
          && sup.includes(j.engine + "|" + String(j.job_id))))
      : rows;
    // 行优先：pending 子行 + 账本恢复行并入看板（serve 真行出现后让位删除，不双行）
    const rows2 = applyQueuePauseDisplay(mergePendingRows(rowsIn));
    lastMergedRows = rows2;
    // 统计与筛选合一（renderFilterBar）：终态计数走 serve 累计 summary（200 内存窗
    // 下行计数必少算），活跃态按现行计数；按钮内带数字，不再另设一套统计条。
    renderFilterBar(rows2);
    renderSourceFilter(rows2);
    renderPauseAllBtn(rows2);
    renderInterruptedRerunBtn(rows2);
    renderClearDoneBtn();

    // 单任务挂起可用性：同任务任一文件运行中 → 服务侧拒绝挂起（409），行级「暂停」隐藏
    const jobActive = new Map<string, boolean>();
    for (const r of rows2) {
      if (r.job_id && r.status === "running") jobActive.set(r.engine + "|" + r.job_id, true);
    }
    state._jobActive = jobActive;

    // 勾选维护：消失的行（任务过期/挤出窗口）自动取消勾选
    const allKeys = new Set(rows2.map(jobKey));
    for (const k of Array.from(state.selected)) if (!allKeys.has(k)) state.selected.delete(k);

    const filtered = visibleRows(rows2);
    // 0.2.47 搜索：主名 / file / job_id / task_id 小写子串，与 筛选/来源 AND；
    // batch 组 = 组标（主任务名）或任一子行命中 → 整组显示
    let shown = filtered;
    const searchTerm = state.jobSearch.trim().toLowerCase();
    if (searchTerm) {
      const groupHit = new Map<string, boolean>();
      for (const j of filtered) {
        if (!j.batch_id || groupHit.get(j.batch_id)) continue;
        if ((j.batch_label || "").toLowerCase().includes(searchTerm) || matchJobSearch(j, searchTerm)) {
          groupHit.set(j.batch_id, true);
        }
      }
      shown = filtered.filter((j) => (j.batch_id ? groupHit.get(j.batch_id) === true : matchJobSearch(j, searchTerm)));
    }
    // 全选/批量操作只覆盖可操作的行：未入队的 pending 子行走行内「取消」（无 serve 任务可寻址）
    state._filteredKeys = shown
      .filter((j) => !(j.dispatch_pending && !j.job_id) // 未入队 pending 子行走行内「取消」（无 serve 任务可寻址）
        && !(typeof j.pkey === "string" && j.pkey.startsWith("ghost|"))) // F4/F5 ghost 行 renderer 本地，批量操作不可寻址
      .map(jobKey);
    // 0.2.57：账本行进批量条（批量「清除记录」/「重跑」）；服务侧批量操作对账本行逐条空转无害

    // 顶层条目：普通行 + 主任务（batch）组（组位置=首个子行出现处；组按 1 条计页）。
    // 顶部统计/筛选计数仍按子行（口径不翻倍）；勾选/批量操作仍只在子行。
    interface BatchGroup {
      bid: string; label: string; children: JobRow[];
      stale?: { created?: number | null; finished?: number | null };
    }
    type Entry = { kind: "row"; row: JobRow } | { kind: "batch"; g: BatchGroup };
    const batchGroups = new Map<string, BatchGroup>();
    const entries: Entry[] = [];
    for (const j of shown) {
      const bid = j.batch_id;
      if (!bid) { entries.push({ kind: "row", row: j }); continue; }
      let g = batchGroups.get(bid);
      if (!g) {
        g = { bid, label: j.batch_label || "", children: [] };
        batchGroups.set(bid, g);
        entries.push({ kind: "batch", g });
      }
      if (j.batch_label && !g.label) g.label = j.batch_label;
      g.children.push(j);
    }
    // 对账兜底：本地记录在、但子行已全部过期（serve 200 窗挤出 / 重启后刷新）→
    // 渲染一条完成态主任务行（无子行）；筛选非全量 / 搜索中不展示，避免误导
    if (state.filter === "all" && state.source === "all" && !searchTerm) {
      const liveBids = new Set(rows2.map((r) => r.batch_id).filter(Boolean) as string[]);
      for (const rec of state._batches) {
        if (!rec || !rec.batch_id || liveBids.has(rec.batch_id)) continue;
        entries.push({ kind: "batch", g: {
          bid: rec.batch_id, label: rec.label || rec.batch_id, children: [],
          stale: { created: rec.created ?? null, finished: rec.finished ?? null },
        } });
      }
    }
    state._entryCount = entries.length;

    // 分页：只渲染当前页（按顶层条目计；组=1）。页码越界自动收回（任务完成会收缩列表）。
    const pages = Math.max(1, Math.ceil(entries.length / state.pageSize));
    if (state.page >= pages) state.page = pages - 1;
    const pageEntries = entries.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize);

    const list = jobList;
    $("jobs-empty").hidden = shown.length > 0;
    $("jobs-empty-text").textContent = rows2.length
      ? (searchTerm ? "无匹配搜索词的任务" : "当前筛选下无任务")
      : "暂无任务";
    const now = Date.now() / 1000;
    const rowMap = new Map<string, JobRowEl>();
    for (const r of Array.from(list.children)) rowMap.set((r as HTMLElement).dataset.jkey ?? "", r as JobRowEl);
    const wanted = new Set<string>();
    const flatKeys: string[] = [];

    // 普通行（无 batch_id）与 batch 子行共用同一渲染路径：复用 jobRowData，逐像素不变
    const renderRowEl = (j: JobRow): void => {
      const key = jobKey(j);
      wanted.add(key);
      flatKeys.push(key);
      const d = jobRowData(j, now);
      let row = rowMap.get(key);
      if (!row) {
        const el = document.createElement("div");
        el.className = "job-grid job-row" + (j.status === "running" ? " running" : "")
          + (j.status === INTERRUPTED ? " interrupted" : "");
        el.dataset.jkey = key;
        row = el as JobRowEl;
        row._core = d.core;
        row._html = d.html;
        row.innerHTML = d.html;
        if (j.created) row.dataset.created = String(j.created);
        row.classList.toggle("paused", j.paused === true || j.status === "paused");
        list.appendChild(row);
        rowMap.set(key, row);
      } else if (row._core !== d.core) {
        row._core = d.core;
        row._html = d.html;
        row.innerHTML = d.html;
        row.className = "job-grid job-row" + (j.status === "running" ? " running" : "")
          + (j.paused || j.status === "paused" ? " paused" : "")
          + (j.status === INTERRUPTED ? " interrupted" : "");
      }
      patchJobRow(row, d.pct, d.eta, d.pos, d.elapsed);
    };

    for (const en of pageEntries) {
      if (en.kind === "row") { renderRowEl(en.row); continue; }
      const g = en.g;
      const gkey = "batch:" + g.bid;
      wanted.add(gkey);
      flatKeys.push(gkey);
      const agg = batchAgg(g.children);
      const allTerminal = g.children.length === 0
        || g.children.every((j) => TERMINAL_LIKE.has(j.status));
      // 统一归一 Unix 秒：中断账本行 finished = interrupted_at（毫秒时间戳），裸值聚合会把
      // 耗时放大 ~1000 倍（耗时列出现 497522xxx:00:00 级裸数字）；子行渲染走 timestampSeconds
      // 故正常，批量行聚合此前漏归一（0.2.57 中断行引入 finished 毫秒值后必现）
      const childSec = (v: number | null | undefined): number => timestampSeconds(v) || 0;
      const created = g.children.length
        ? (Math.min(...g.children.map((j) => childSec(j.created))) || null)
        : (timestampSeconds(g.stale?.created) ?? null);
      const finished = g.children.length
        ? (Math.max(...g.children.map((j) => childSec(j.finished))) || null)
        : (timestampSeconds(g.stale?.finished) ?? null);
      // 总耗时：全终态 = max(finished) - min(created)；在途 = now - min(created)
      const elapsed = created != null
        ? fmtDuration(Math.max(0, (allTerminal ? (finished || now) : now) - created))
        : "—";
      const collapsed = state._batchCollapsed.has(g.bid);
      const hasFailed = g.children.some((j) => j.status === "error" || j.status === "canceled");
      // 0.2.51 账本组：子行全是本地记录（无 pending 队列、serve 亦不认识）→ 服务侧主任务操作无对象，
      // 不给暂停/继续/取消/重试（0.2.57：全中断组改给 [重跑全部][清除]）
      const allLedger = g.children.length > 0 && g.children.every((j) => j.ledger === true);
      // 0.2.57：组内子行全部中断（客户端重启/退出）→ 组级批量恢复入口
      const allInterrupted = allLedger && g.children.every((j) => j.status === INTERRUPTED);
      const canOp = typeof t.batchOp === "function" && !g.stale && !allLedger;
      // 行优先：子行还全是本端 pending（尚未提交到服务）→ 服务侧不认识该主任务，
      // 暂停/继续/重试发了只会拿到「批次不存在」；「取消」走本端 pending 语义仍可用。
      const servedGroup = batchServed(g.bid);
      const localBatch = batchQueues.has(g.bid); // 本端行优先批次（serve 尚不认识）：暂停/继续/取消本端即时生效
      // 孤儿行（兜底 0 子任务）：手动清除入口（删本地 batches.json 记录；子任务已过期）
      const canClear = typeof t.batchClear === "function" && !!g.stale;
      // 全局暂停期：批次「暂停/继续」隐藏——继续一个主任务在管线闸冻结下不会真跑，点了也是空操作
      const globalPaused = !!state._summary?.paused_all;
      const ops = [
        canOp && (servedGroup || localBatch) && agg.status !== "paused" && !allTerminal && !globalPaused
          ? `<button type="button" class="dl-btn batch-op" data-bid="${esc(g.bid)}" data-bact="pause" title="暂停主任务：运行中的子任务跑完，排队中冻结">&#9208; 暂停</button>` : "",
        canOp && (servedGroup || localBatch) && agg.status === "paused" && !globalPaused
          ? `<button type="button" class="dl-btn batch-op" data-bid="${esc(g.bid)}" data-bact="resume" title="继续主任务：解除排队冻结，恢复开跑">&#9654; 继续</button>` : "",
        canOp && servedGroup && hasFailed
          ? `<button type="button" class="dl-btn batch-op" data-bid="${esc(g.bid)}" data-bact="retry" title="重试本主任务中失败的子任务">&#8635; 重试失败</button>` : "",
        canOp && !allTerminal
          ? `<button type="button" class="dl-btn batch-op" data-bid="${esc(g.bid)}" data-bact="cancel" title="取消主任务：未开始子任务立即取消；在跑子任务跑完当前阶段后中止，不再提交服务">&#10006; 取消</button>` : "",
        allInterrupted
          ? `<button type="button" class="dl-btn batch-op" data-bid="${esc(g.bid)}" data-bact="rerun-all" title="重跑全部中断子任务：重新提取音轨并提交服务（原服务在线回原服务，否则按自动均衡选服务；无源文件路径的跳过并计数）">&#8635; 重跑全部</button>` : "",
        allInterrupted
          ? `<button type="button" class="dl-btn batch-op batch-clear" data-bid="${esc(g.bid)}" data-bact="ledger-clear" title="清除该主任务全部本地记录（子任务均已中断）：仅删本机派发账本条目 + 本地主任务记录，不动服务端">&#10005; 清除</button>` : "",
        canClear
          ? `<button type="button" class="dl-btn batch-op batch-clear" data-bid="${esc(g.bid)}" data-bact="clear" title="清除该过期主任务记录（仅本地记录，子任务已过期）">&#10005; 清除</button>` : "",
      ].join("");
      const label = g.label || g.bid;
      const core = [gkey, label, g.children.length, agg.status, collapsed, allTerminal, created, finished, hasFailed, canOp, canClear, allInterrupted, servedGroup, localBatch, ops].join("\u0001");
      let el = rowMap.get(gkey);
      if (!el) {
        const div = document.createElement("div");
        div.dataset.jkey = gkey;
        el = div as JobRowEl;
        el._core = core;
        el.innerHTML = batchRowHtml(g, label, agg, created, finished, elapsed, collapsed, ops);
        list.appendChild(el);
        rowMap.set(gkey, el);
      } else if (el._core !== core) {
        el._core = core;
        el.innerHTML = batchRowHtml(g, label, agg, created, finished, elapsed, collapsed, ops);
      }
      el.className = "job-grid job-batch-row"
        + (agg.status === "running" ? " running" : "")
        + (agg.status === "paused" ? " paused" : "")
        + (agg.status === INTERRUPTED ? " interrupted" : "");
      patchBatchRow(el, agg.pct, elapsed);
      // 子行：展开时渲染（复用普通行路径）；收起时不在 wanted → 统一 remove
      if (!collapsed) for (const j of g.children) renderRowEl(j);
    }
    for (const [k, r] of rowMap) if (!wanted.has(k)) r.remove();
    const order = Array.from(list.children).map((r) => (r as HTMLElement).dataset.jkey ?? "").join("\u0001");
    if (order !== flatKeys.join("\u0001")) {
      for (const k of flatKeys) { const el2 = rowMap.get(k); if (el2) list.appendChild(el2); }
    }
    renderPager(entries.length);
    renderBulkBar();
    renderSelAll();
  }

  // ---------- 任务筛选（状态桶：活跃态分行细类，终态归一） ----------
  // 桶语义（与筛选按钮一一对应）：
  //   排队中 = 本机 queued/dispatching + serve pending
  //   提取中 = 本机 ffmpeg 提取音轨
  //   转译中 = serve 运行中（模型识别）
  //   已暂停 = 本机 paused 或 serve 单任务挂起（paused）
  //   完成/跳过/失败 = 终态（失败含 canceled）
  function rowBucket(r: JobRow): string {
    if (r.status === "done") return "done";
    if (r.status === "skipped") return "skipped";
    if (r.status === INTERRUPTED) return "interrupted"; // 0.2.57：独立桶（仅账本行会有）
    if (r.status === "error" || r.status === "canceled") return "failed";
    if (r.status === "paused" || r.paused) return "paused";
    if (r.status === "unsubmitted") return "failed"; // F4 占位行：待用户动作（重试/取消）的终态，归失败桶便查找
    if (!r.job_id) {
      // 本机管线行（无 job_id）：按 phase 细分
      if (r.phase === "extracting") return "extracting";
      return "queued"; // queued / dispatching 均属「排队/派发」
    }
    // serve 行
    if (r.status === "running") return "transcribing";
    return "queued"; // pending
  }

  // ---------- 任务分页（基于缓存即时翻页，不请求网络；5s 轮询照常刷新数据） ----------
  function visibleRows(rows: JobRow[]) {
    return rows.filter((r) => {
      // 来源维度（多客户端连同一服务端）：local 仅本机派发行；serve 仅他端提交的服务行。
      // r.local 未定义（desktop/旧 API）按本机处理，行为不变。
      if (state.source === "local" && r.local !== true) return false;
      if (state.source === "serve" && r.local !== false) return false;
      if (state.filter === "all") return true;
      const b = rowBucket(r);
      if (state.filter === "active") return b === "queued" || b === "extracting" || b === "transcribing";
      return b === state.filter;
    });
  }

  // ---------- 合并筛选条（统计 + 筛选一体：按钮内带计数，避免两套重复控件） ----------
  const FILTERS: Array<[string, string]> = [
    ["all", "全部"], ["active", "进行中"], ["queued", "排队中"], ["extracting", "提取中"],
    ["transcribing", "转译中"], ["done", "完成"], ["skipped", "跳过"], ["failed", "失败"], ["paused", "已暂停"],
    ["interrupted", "中断"], // 0.2.57：仅账本行（服务端无此态，不做 summary 叠加）
  ];

  function renderFilterBar(rows: JobRow[]) {
    const box = $("job-filter");
    const counts: Record<string, number> = {
      all: 0, active: 0, queued: 0, extracting: 0, transcribing: 0,
      done: 0, skipped: 0, failed: 0, paused: 0, interrupted: 0,
    };
    for (const r of rows) counts[rowBucket(r)] += 1;
    // 0.2.51：账本终态行不在 serve 累计 summary 内（服务端记录已不可用），
    // summary 覆盖终态桶时叠加回计数，否则纯本机终态行在看板上「全部 0」
    let ledDone = 0, ledSkip = 0, ledFail = 0;
    for (const r of rows) {
      if (r.ledger !== true) continue;
      if (r.status === "done") ledDone += 1;
      else if (r.status === "skipped") ledSkip += 1;
      else if (r.status === "error" || r.status === "canceled") ledFail += 1;
    }
    // 终态计数用 serve 累计 summary（200 内存窗下行计数必少算）；活跃态只能按现行
    if (state._summary) {
      counts.done = state._summary.done + ledDone;
      counts.skipped = state._summary.skipped + ledSkip;
      counts.failed = state._summary.failed + ledFail;
    }
    counts.active = counts.queued + counts.extracting + counts.transcribing;
    counts.all = counts.active + counts.done + counts.skipped + counts.failed + counts.paused + counts.interrupted;
    const html = FILTERS.map(([f, zh]) =>
      `<button type="button" data-f="${f}" class="${state.filter === f ? "on" : ""}">${zh} <b>${counts[f]}</b></button>`,
    ).join("");
    if ((box as HTMLElement & { _html?: string })._html !== html) {
      (box as HTMLElement & { _html?: string })._html = html;
      box.innerHTML = html;
    }
    for (const b of Array.from(box.querySelectorAll<HTMLButtonElement>("button"))) {
      b.onclick = () => {
        state.filter = b.dataset.f || "all";
        state.page = 0;
        renderJobs(state._jobs);
      };
    }
  }

  // ---------- 来源筛选（多客户端连同一服务端时出现；纯本机任务时隐藏，保持界面干净） ----------
  function renderSourceFilter(rows: JobRow[]) {
    const box = $("job-source-filter") as HTMLElement;
    let nLocal = 0;
    let nServe = 0;
    for (const r of rows) {
      if (r.local === true) nLocal += 1;
      else if (r.local === false) nServe += 1;
    }
    if (!nServe) {
      // 无他端任务：收起来源条；若用户正停留在「他端任务」筛选上则复位，避免列表空转
      if (state.source !== "all") {
        state.source = "all";
        state.page = 0;
      }
      box.hidden = true;
      (box as HTMLElement & { _html?: string })._html = "";
      return;
    }
    box.hidden = false;
    const items: Array<[string, string, number]> = [
      ["all", "全部", nLocal + nServe],
      ["local", "本机派发", nLocal],
      ["serve", "他端任务", nServe],
    ];
    const html = items.map(([k, zh, n]) =>
      `<button type="button" data-s="${k}" class="${state.source === k ? "on" : ""}">${zh} <b>${n}</b></button>`,
    ).join("");
    if ((box as HTMLElement & { _html?: string })._html !== html) {
      (box as HTMLElement & { _html?: string })._html = html;
      box.innerHTML = html;
    }
    for (const b of Array.from(box.querySelectorAll<HTMLButtonElement>("button"))) {
      b.onclick = () => {
        state.source = b.dataset.s || "all";
        state.page = 0;
        renderJobs(state._jobs);
      };
    }
  }

  function renderPager(total: number) {
    const el = jobPager;
    const pages = Math.max(1, Math.ceil(total / state.pageSize));
    if (pages <= 1) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    el.innerHTML =
      `<button type="button" id="pg-prev" class="pg-btn" ${state.page === 0 ? "disabled" : ""} aria-label="上一页">&#8249;</button>` +
      `<span class="pg-info mono">第 ${state.page + 1} / ${pages} 页 · 共 ${total} 条</span>` +
      `<button type="button" id="pg-next" class="pg-btn" ${state.page >= pages - 1 ? "disabled" : ""} aria-label="下一页">&#8250;</button>` +
      `<select id="pg-size" class="pg-size" title="任务列表每页行数" aria-label="每页行数">${PAGE_SIZE_OPTS}</select>`;
    const sizeSel = el.querySelector("#pg-size") as HTMLSelectElement;
    sizeSel.value = String(state.pageSize);
    sizeSel.onchange = () => {
      state.pageSize = Number(sizeSel.value) || 10;
      localStorage.setItem("javweb_jobs_pagesize", String(state.pageSize));
      state.page = 0;
      renderJobs(state._jobs);
    };
  }

  // 耗时列 1s 刷新：轮询 5s 一次，运行中任务的耗时要逐秒走（ETA 随轮询更新）
  window.setInterval(() => {
    const now = Date.now() / 1000;
    for (const row of Array.from(jobList.children) as JobRowEl[]) {
      if (!row.classList.contains("running")) continue;
      const created = Number(row.dataset.created || 0);
      if (!created) continue;
      const el = row.querySelector(".cell-elapsed");
      if (el) {
        const txt = fmtDuration(now - created);
        if (el.textContent !== txt) el.textContent = txt;
      }
    }
  }, 1000);

  jobPager.onclick = (ev) => {
    const target = ev.target as HTMLElement;
    const pages = Math.max(1, Math.ceil(state._entryCount / state.pageSize));
    if (target.closest("#pg-prev") && state.page > 0) {
      state.page--; renderJobs(state._jobs);
    } else if (target.closest("#pg-next") && state.page < pages - 1) {
      state.page++; renderJobs(state._jobs);
    }
  };

  jobList.onclick = async (ev) => {
    // 主任务（batch）行：展开/收起（默认展开；内存态，刷新重置）
    const bc = (ev.target as HTMLElement).closest<HTMLElement>(".batch-caret");
    if (bc && bc.dataset.bid) {
      const bid = bc.dataset.bid;
      if (state._batchCollapsed.has(bid)) state._batchCollapsed.delete(bid);
      else state._batchCollapsed.add(bid);
      renderJobs(state._jobs);
      return;
    }
    // 行优先 pending 子行：取消未开始的子任务（不进队列、不提交服务）
    const pc = (ev.target as HTMLElement).closest(".pend-cancel") as HTMLButtonElement | null;
    if (pc && !pc.disabled) {
      const pkey = pc.dataset.pkey || "";
      const p = state._pending.get(pkey);
      const bid = p?.row.batch_id || "";
      if (p && cancelPendingRow(p)) {
        toast(p.row.status === "canceled"
          ? "已取消该子任务（未开始，不会提交服务）"
          : "已标记取消：跑完当前阶段后不再提交服务", "ok");
      } else toast("该子任务已开跑或已结束，无法单行取消", "err");
      schedulePendingRender();
      batchQueues.get(bid)?.onRowCancel();
      return;
    }
    // 0.2.51 账本行：清除该本地记录（仅删本地账本条目，不动服务端）
    const lc = (ev.target as HTMLElement).closest(".led-clear") as HTMLButtonElement | null;
    if (lc && !lc.disabled) {
      const lpkey = lc.dataset.pkey || "";
      ledgerRemove(lpkey);
      toast("已清除该本地记录", "ok");
      renderJobs(state._jobs);
      return;
    }
    // 0.2.57 中断账本行：单行重跑（重提取音轨 → 上传 → 提交）
    const lr = (ev.target as HTMLElement).closest(".led-rerun") as HTMLButtonElement | null;
    if (lr && !lr.disabled) { void rerunLedgerBtn(lr); return; }
    // 主任务（batch）行操作：暂停/继续/取消/重试失败子任务（fan-out 逐引擎提示，不阻塞）；
    // 0.2.57 全中断组：重跑全部 / 清除（纯本机操作，不依赖服务端 batchOp）
    const bo = (ev.target as HTMLElement).closest(".batch-op") as HTMLButtonElement | null;
    if (bo && !bo.disabled) {
      const bid = bo.dataset.bid || "";
      const act = bo.dataset.bact || "";
      const btn = bo as HTMLButtonElement;
      if (act === "rerun-all") {
        btn.disabled = true;
        try {
          const r = await rerunInterruptedRows(lastMergedRows.filter((x) => x.batch_id === bid));
          if (r.done === 0 && r.failed === 0) toast("没有可重跑的中断子任务（源文件路径未记录）", "err");
          else { const sum = rerunSummary(r); toast(sum.text, sum.level); }
        } finally {
          btn.disabled = false;
          refresh();
        }
        return;
      }
      if (act === "ledger-clear") {
        btn.disabled = true;
        let n = 0;
        for (const k of Object.keys(ledger.children)) {
          if (ledger.children[k].batch_id === bid) { delete ledger.children[k]; ledgerFinger.delete(k); n++; }
        }
        if (n) saveLedgerStore();
        if (t.batchClear) { try { await t.batchClear(bid); } catch { /* 记录可能不存在（子行全过期时） */ } }
        toast(`已清除主任务 ${n} 条本地记录`, "ok");
        renderJobs(state._jobs);
        refresh();
        return;
      }
      if (!(t.batchOp || t.batchClear)) return;
      if (act === "clear") {
        // 孤儿行手动清除：显式用户意图，直接删本地记录（不走保留期闸门）
        btn.disabled = true;
        if (t.batchClear) {
          try {
            await t.batchClear(bid);
            toast("已清除过期主任务记录", "ok");
          } catch (e) {
            toast(`清除失败：${(e as Error).message}`, "err");
          }
        }
        btn.disabled = false;
        refresh();
        return;
      }
      const labelOf = (x: string) => x === "pause" ? "暂停" : x === "resume" ? "继续" : x === "cancel" ? "取消" : "重试";
      let pendingN = 0;
      if (act === "cancel") {
        const ok = window.confirm(
          `确认取消主任务？\n\n· 未开始的子任务全部取消\n· 本机提取中的子任务立即终止（标记已跳过）\n· 已提交到服务的子任务不受影响（与单任务取消语义一致）`,
        );
        if (!ok) return;
        // 行优先：先收掉本端 pending 子行（serve 侧此时还没有这些任务）——
        // 未开始的置「已取消」，已在跑的打中止标记（跑完当前阶段不提交服务 → 「已跳过」）
        pendingN = cancelPendingBatch(bid);
        // 立杀在跑本机 ffmpeg 提取：链收到取消 → 行立即「已跳过」（不等当前阶段跑完）
        const killNames: string[] = [];
        for (const p of state._pending.values()) {
          const r = p.row;
          if (r.batch_id === bid && !r.job_id && !TERMINAL_LIKE.has(r.status) && r.file) killNames.push(r.file);
        }
        if (killNames.length) void jav()?.cancelExtracts?.(killNames);
        // 上传/提交中的行：上传完成后 serve 侧建 job —— serve 尚不认识该批次也必须发取消 fan-out 防漏杀
        const anyUploading = Array.from(state._pending.values()).some(
          (p) => p.row.batch_id === bid && !p.row.job_id && !TERMINAL_LIKE.has(p.row.status)
            && (p.row.phase === "uploading" || p.row.phase === "submitting"));
        // 首个文件还没提交成功 → serve 不认识这个 batch，只做本端取消，不发无谓的 fan-out
        const served = batchServed(bid);
        if (!served && !anyUploading && batchQueues.has(bid)) {
          btn.disabled = true;
          toast(pendingN
            ? `主任务已取消：${pendingN} 个子任务不再提交服务（在跑的跑完当前阶段即止）`
            : "主任务已取消（未开始的子任务已全部结束）", pendingN ? "ok" : "err");
          renderJobs(state._jobs);
          refresh();
          return;
        }
      }
      btn.disabled = true;
      try {
        if (act === "retry") {
          // 重试失败子任务：serve 行→retryJob；本机行（task_id）→rerunLocal；
          // F5：lost ghost 行（服务重启丢在途 job、无 job_id 可寻址）→ 逐文件重新提交
          const failed = (state._jobs || []).filter(
            (j) => j.batch_id === bid && (j.status === "error" || j.status === "canceled"));
          const ghostFailed = [...ghostRows.values()].filter(
            (g) => (g.batchId || "") === bid && g.row.status === "error");
          if (!failed.length && !ghostFailed.length) { toast("该主任务没有可重试的失败子任务", "err"); return; }
          let n = 0;
          for (const j of failed) {
            try {
              if (j.job_id) await t.retryJob(j.engine, j.job_id);
              else if (j.task_id && t.rerunLocal) await t.rerunLocal(j.task_id);
              else continue;
              n++;
            } catch (_e2) { /* 单个失败继续：结果在任务行可见 */ }
          }
          for (const g of ghostFailed) {
            try { if ((await ghostRetryCore(g)).ok) n++; } catch (_e2) { /* 单个失败继续 */ }
          }
          toast(n ? `已重新提交 ${n} 个失败子任务` : "重试失败（子任务已过期或不可重试）", n ? "ok" : "err");
        } else if (t.batchOp) {
          // 本端（行优先）暂停/继续：立即冻结/放行本机派发队列（独立于 serve fan-out）
          const q = batchQueues.get(bid);
          if (q && (act === "pause" || act === "resume")) {
            if (act === "pause") q.pause(); else q.resume();
          }
          const d = await t.batchOp(act as "pause" | "resume" | "cancel", bid);
          const bad = (d.engines || []).filter((e) => !e.ok);
          const badTxt = bad.map((e) => `${e.engine}：${e.unsupported ? "版本过旧不支持" : (e.error || "失败")}`).join("；");
          const localTxt = act === "cancel"
            ? `，本机取消 ${(d.local?.canceled ?? 0) + pendingN} 个未开始任务`
            : act === "pause" ? "，本机排队已冻结" : "，本机已放行";
          if (bad.length) toast(`主任务${labelOf(act)}${localTxt}；${badTxt}`, "err");
          else toast(`主任务${labelOf(act)}完成${localTxt}`, "ok");
        }
      } catch (e) {
        toast(`${labelOf(act)}失败：${(e as Error).message}`, "err");
      }
      btn.disabled = false;
      refresh();
      return;
    }
    // 本机管线任务 重试/继续（重提取音轨并重提交）
    const rl = (ev.target as HTMLElement).closest(".rerun-local") as HTMLButtonElement | null;
    if (rl && !rl.disabled && t.rerunLocal) {
      const tid = rl.dataset.tid || "";
      const isResume = rl.dataset.mode === "resume";
      rl.disabled = true; rl.textContent = isResume ? "继续中…" : "重试中…";
      try {
        await t.rerunLocal(tid);
        toast(isResume ? "已继续（重新提取音轨并重新提交）" : "已重新提交（重新提取音轨）", "ok");
      } catch (e) {
        toast(`${isResume ? "继续" : "重试"}失败：${(e as Error).message}`, "err");
        rl.disabled = false; rl.textContent = isResume ? "▶ 继续" : "↻ 重试";
      }
      refresh();
      return;
    }
    // 单任务挂起（排队中）
    const pb = (ev.target as HTMLElement).closest(".pause-job") as HTMLButtonElement | null;
    if (pb && !pb.disabled && t.pauseJob) {
      const eng = pb.dataset.eng || "", jid = pb.dataset.jid || "";
      const name = pb.closest(".job-row")?.querySelector(".fn")?.textContent || "";
      pb.disabled = true; pb.textContent = "挂起中…";
      try {
        await t.pauseJob(eng, jid);
        toast(`「${name}」已挂起（不占服务并发，可随时继续）`, "ok");
      } catch (e) {
        toast(`挂起失败：${(e as Error).message}`, "err");
        pb.disabled = false; pb.textContent = "⏸ 暂停";
      }
      refresh();
      return;
    }
    // 本机行改派目的地服务（排队/已暂停实时生效）
    const rg = (ev.target as HTMLElement).closest(".reassign-go") as HTMLButtonElement | null;
    if (rg && !rg.disabled && t.reassignLocal) {
      const tid = rg.dataset.tid || "";
      const sel = rg.closest(".job-row")?.querySelector<HTMLSelectElement>(".reassign-sel");
      const engine = sel?.value || "auto";
      rg.disabled = true; rg.textContent = "…";
      try {
        await t.reassignLocal(tid, engine);
        toast(engine === "auto"
          ? "已改派为自动均衡（派发时刻按实时负载选最闲服务）"
          : `已改派到「${engine}」`, "ok");
      } catch (e) {
        toast(`改派失败：${(e as Error).message}`, "err");
      }
      rg.disabled = false; rg.innerHTML = "&#10230;";
      refresh();
      return;
    }
    // 单任务恢复（挂起 → 重新排队）
    const rj = (ev.target as HTMLElement).closest(".resume-job") as HTMLButtonElement | null;
    if (rj && !rj.disabled && t.resumeJob) {
      const eng = rj.dataset.eng || "", jid = rj.dataset.jid || "";
      const name = rj.closest(".job-row")?.querySelector(".fn")?.textContent || "";
      rj.disabled = true; rj.textContent = "恢复中…";
      try {
        await t.resumeJob(eng, jid);
        toast(`「${name}」已恢复排队`, "ok");
      } catch (e) {
        toast(`恢复失败：${(e as Error).message}`, "err");
        rj.disabled = false; rj.textContent = "▶ 继续";
      }
      refresh();
      return;
    }
    // 本机管线任务暂停（排队/提取/派发中，未提交服务）
    const pl = (ev.target as HTMLElement).closest(".pause-local") as HTMLButtonElement | null;
    if (pl && !pl.disabled && t.pauseLocalTask) {
      const tid = pl.dataset.tid || "";
      pl.disabled = true; pl.textContent = "暂停中…";
      try {
        const d = await t.pauseLocalTask(tid);
        toast(d.already ? "该任务已是暂停状态" : "已暂停（点「继续」重新提取音轨并提交）", "ok");
      } catch (e) {
        toast(`暂停失败：${(e as Error).message}`, "err");
        pl.disabled = false; pl.textContent = "⏸ 暂停";
      }
      refresh();
      return;
    }
    // F4/F5 ghost 行：重试（重新提交）/ 取消（丢弃 pre 登记）——独立类，先于通用 .retry/.cancel 判定
    const gr = (ev.target as HTMLElement).closest(".ghost-retry") as HTMLButtonElement | null;
    if (gr && !gr.disabled) { void ghostRetryUi(gr); return; }
    const gc = (ev.target as HTMLElement).closest(".ghost-cancel") as HTMLButtonElement | null;
    if (gc && !gc.disabled) { void ghostCancelUi(gc); return; }
    const rb = (ev.target as HTMLElement).closest(".rerun") as HTMLButtonElement | null;
    if (rb && !rb.disabled) {
      if (state.busy) { toast("有正在进行的提交任务，请完成后再试", "err"); return; }
      void openRerunModal(rb.dataset.file || "", rb.dataset.eng || "", rb.dataset.jid || "", rb.dataset.status || "", rb.dataset.fp || "");
      return;
    }
    const cb = (ev.target as HTMLElement).closest(".cancel") as HTMLButtonElement | null;
    if (cb && !cb.disabled) {
      const crow = cb.closest(".job-row");
      const cname = crow?.querySelector(".fn")?.textContent || "";
      const cjid = cb.dataset.jid || "", ceng = cb.dataset.eng || "";
      cb.disabled = true; cb.textContent = "取消中…";
      const ok = window.confirm(
        `确认取消「${cname}」？\n排队中/未开始的文件立即终止；运行中的将在当前检查点中止，已生成的字幕会保留。`,
      );
      if (!ok) { cb.disabled = false; cb.textContent = "\u2715 取消"; refresh(); return; }
      try {
        const d = await t.cancelJob(ceng, cjid);
        toast(d.status === "canceling"
          ? `「${cname}」正在取消（检查点中止，已生成字幕保留）`
          : `「${cname}」已取消`, "ok");
      } catch (e) {
        toast(`取消失败：${(e as Error).message}`, "err");
        cb.disabled = false; cb.textContent = "\u2715 取消";
      }
      refresh();
      return;
    }
    const b = (ev.target as HTMLElement).closest(".retry") as HTMLButtonElement | null;
    if (!b || b.disabled) return;
    const tr = b.closest(".job-row");
    const name = tr?.querySelector(".fn")?.textContent || "";
    const jid = b.dataset.jid || "", eng = b.dataset.eng || "";
    state.retried.add(eng + "|" + jid);
    const isErrRetry = b.dataset.mode === "error";
    b.disabled = true; b.textContent = isErrRetry ? "重试中…" : "重新生成中…";
    try {
      const d = await t.retryJob(eng, jid);
      const oldInfo = state.writeBackJobs.get(eng + "|" + jid);
      if (oldInfo) {
        state.writeBackJobs.set(eng + "|" + d.jobId, oldInfo);
        wbAt.set(eng + "|" + d.jobId, Date.now());
        // 强制写回标记随重跑迁移（否则本地源任务点「重试/重新生成」后新 job_id 丢标记 → F1 复发）
        if (state.watchWriteBack.has(eng + "|" + jid)) {
          state.watchWriteBack.delete(eng + "|" + jid);
          state.watchWriteBack.add(eng + "|" + d.jobId);
        }
        saveWriteBackStore();
      }
      toast(isErrRetry
        ? `「${name}」已重新入队 → 任务 ${d.jobId}`
        : `「${name}」已删旧字幕并重新提交 → 任务 ${d.jobId}`, "ok");
      refresh();
    } catch (e) {
      state.retried.delete(eng + "|" + jid);
      toast(`${isErrRetry ? "重试" : "重新生成"}失败：${(e as Error).message}`, "err");
      refresh();
    }
  };

  // ---------- 全局暂停 / 继续（web 工作台：本机管线闸 + 各在线服务队列代理） ----------
  // 按钮显隐跟随 transport 能力（desktop 形态无 /api/pause → 恒隐藏，像素不变）
  function renderPauseAllBtn(rows: JobRow[]) {
    const btn = $("job-pause-all") as HTMLButtonElement;
    if (!t.pauseAll) { btn.hidden = true; return; }
    // 无在途任务（运行中/排队中/已暂停）→ 隐藏：空列表或全终态时无暂停对象
    // F-12（0.2.55）：判定行集对齐看板展示行集 rows2（serve 行 + 本机 pending 子行 + 账本行 + ghost 行），
    // 不再 state._jobs —— 桌面形态 state._jobs 仅 serve 行，本机提取/派发中的子行只活在 state._pending；
    // 旧口径「只看 serve 行」：批次处在本机提取/上传阶段（serve 行未生成）时「暂停所有」被误隐藏，
    // 用户在最高频的暂停窗口（提交/提取进行中）找不到入口（「暂停没效果」的另一变体）。
    const hasActive = rows.some(
      (r) => r.status === "running" || r.status === "pending" || r.status === "paused" || r.paused,
    );
    if (!hasActive) { btn.hidden = true; return; }
    const pausedAll = !!state._summary?.paused_all;
    btn.hidden = false;
    btn.classList.toggle("on", pausedAll);
    const label = pausedAll ? "▶ 继续任务" : "⏸ 暂停所有";
    if (btn.textContent !== label) btn.textContent = label;
    // 0.2.54（F-10）：不受 busy 门控——暂停的语义就是冻结运行中的本机管线（提取/派发泵）
    // 与服务队列，提交进行中恰是最高频使用场景；主进程管线闸 pipelineGateWait 挂起等待
    // （不中断在途阶段）是唯一控制面。busy 只门控「新提交」类动作，不适用于本按钮。
    //（此前 busy 期间按钮禁用，大批次提交中用户无法暂停 = 「暂停没效果」的另一入口）
    btn.disabled = false;
  }

  ($("job-pause-all") as HTMLButtonElement).onclick = async () => {
    if (!t.pauseAll) return;
    // F-10：暂停/继续不受 busy 门控（管线闸挂起等待语义，见 renderPauseAllBtn 注释）
    const want = !state._summary?.paused_all;
    const btn = $("job-pause-all") as HTMLButtonElement;
    if (want) {
      const ok = window.confirm(
        "暂停所有任务？\n\n" +
        "· 本机管线（音轨提取 / 派发）不再开新任务，排队中的立即挂起\n" +
        "· 各在线服务队列同步挂起；运行中的任务会跑完当前影片\n" +
        "· 服务队列暂停是服务端级操作：所有连接这些服务的客户端都会看到队列挂起\n" +
        "· 已入队的批量任务不受影响，随时可「继续任务」恢复\n\n" +
        "适合在发布新版客户端前冻结队列，避免发版期间任务丢失。",
      );
      if (!ok) return;
    }
    btn.disabled = true;
    try {
      const res = await t.pauseAll(want);
      const bad = res.engines.filter((e) => !e.ok);
      const goodN = res.engines.length - bad.length;
      const badTxt = bad.map((e) => `${e.engine}：${e.error || "失败"}`).join("；");
      if (bad.length) {
        toast(`${want ? "已暂停" : "已继续"}本机管线${goodN ? ` + ${goodN} 个服务队列` : ""}；${badTxt}`, "err");
      } else {
        toast(want
          ? `已暂停所有任务（本机管线 + ${goodN} 个服务队列）`
          : "已继续所有任务", "ok");
      }
      refresh();
    } catch (e) {
      toast(`${want ? "暂停" : "继续"}失败：${(e as Error).message}`, "err");
    } finally {
      // F-10：与 renderPauseAllBtn 同口径——有在途任务即可用，不受 busy 门控
      btn.disabled = false;
    }
  };

  // ---------- 历史清理（0.2.57）：替换「清理已完成」confirm → 对话框（5 类终态 + 实时计数） ----------
  // 口径：合并行集（serve 行 + pending + 账本行）里勾选类别的可见行；进行中/排队/暂停一律不动。
  // 中断类服务端已忘（重启即丢）仅本机清除；服务端残留行写抑制集（持久化）；fan-out best-effort（404 = 旧版静默）。
  function renderClearDoneBtn(): void {
    const btn = $("job-clear-done") as HTMLButtonElement | null;
    if (!btn) return;
    let n = 0;
    for (const j of lastMergedRows) if (cleanupCatOf(j.status)) n++;
    btn.hidden = n === 0;
    btn.disabled = state.busy;
  }

  const cleanupBackdrop = $("job-cleanup-backdrop") as HTMLDivElement | null;

  function openCleanupDialog(): void {
    if (state.busy) { toast("有正在进行的提交任务，请完成后再试", "err"); return; }
    const counts = new Map<string, number>();
    for (const j of lastMergedRows) {
      const cat = cleanupCatOf(j.status);
      if (cat) counts.set(cat, (counts.get(cat) || 0) + 1);
    }
    if (!counts.size) { toast("暂无可清理的历史任务", "ok"); return; }
    const cats = $("job-cleanup-cats");
    if (cats) {
      cats.innerHTML = CLEANUP_CATS.map(([cat, zh]) => {
        const n = counts.get(cat) || 0;
        return `<label class="cleanup-cat"${n ? "" : " disabled"}>`
          + `<input type="checkbox" value="${cat}"${n ? " checked" : " disabled"}>`
          + `<span class="cleanup-cat-zh">${zh}</span><span class="cleanup-cat-n mono">${n}</span></label>`;
      }).join("");
    }
    const sync = $("job-cleanup-sync") as HTMLInputElement | null;
    if (sync) sync.checked = true;
    const okBtn = $("job-cleanup-ok") as HTMLButtonElement | null;
    if (okBtn) okBtn.disabled = false;
    if (cleanupBackdrop) cleanupBackdrop.hidden = false;
  }

  function closeCleanupDialog(): void {
    if (cleanupBackdrop) cleanupBackdrop.hidden = true;
  }

  async function runCleanup(checkedCats: Set<string>, syncServes: boolean): Promise<void> {
    // 勾类别的可见行（合并行集）；勾选类别均为终态，进行中/排队/暂停天然不受影响
    const rows = lastMergedRows.filter((j) => {
      const cat = cleanupCatOf(j.status);
      return !!cat && checkedCats.has(cat);
    });
    if (!rows.length) { toast("勾选的类别下没有可清理的任务", "err"); return; }
    const rowKeys = new Set(rows.map(jobKey));
    // 1) 本机：账本条目删除（勾类别的全部条目 + 命中行 pkey，防双行残留）
    for (const [k, c] of Object.entries(ledger.children)) {
      const cat = cleanupCatOf(c.status);
      if ((cat && checkedCats.has(cat)) || rowKeys.has(k)) {
        delete ledger.children[k];
        ledgerFinger.delete(k);
      }
    }
    // 2) 本轮内存里的勾类别终态 pending 行一并移除（非终态 pending 不动）
    for (const [k, p] of Array.from(state._pending)) {
      const cat = cleanupCatOf(p.row.status);
      if (cat && checkedCats.has(cat)) state._pending.delete(k);
    }
    // 3) 抑制集：本轮可见勾类别行 key 持久化（服务端残留行不再回来）
    const supKeys: string[] = [];
    for (const j of rows) {
      if (!j.job_id) continue;
      const k = j.engine + "|" + String(j.job_id);
      if (!ledger.suppress.includes(k) && !supKeys.includes(k)) supKeys.push(k);
    }
    ledgerAddSuppress(supKeys);
    saveLedgerStore();
    // 4) batches.json：仅当该 batch 已无其他未清理的 live 行才清组记录
    const bids = new Set<string>();
    for (const j of rows) if (j.batch_id) bids.add(j.batch_id);
    if (t.batchClear) {
      for (const bid of bids) {
        const hasLive = lastMergedRows.some((j) => j.batch_id === bid && !rowKeys.has(jobKey(j)));
        if (hasLive) continue;
        try { await t.batchClear(bid); } catch { /* 记录不存在等：静默 */ }
      }
    }
    // 5) 服务端 fan-out（best-effort；只清服务端终态，旧版 404 静默降级）
    let svcTxt = "";
    if (syncServes && t.cleanupFinishedJobs) {
      try {
        const res = await t.cleanupFinishedJobs();
        const good = res.engines.filter((e) => e.ok);
        const removedN = good.reduce((s2, e) => s2 + (e.removed || 0), 0);
        const bad = res.engines.filter((e) => !e.ok);
        svcTxt = res.engines.length
          ? `；服务侧 ${good.length}/${res.engines.length} 成功（清 ${removedN} 条）`
            + (bad.length ? `；${bad.map((e) => `${e.engine}：${e.error || "失败"}`).join("，")}` : "")
          : "；服务侧无已登记服务";
      } catch (e) {
        svcTxt = `；服务侧清理失败（${(e as Error).message}）`;
      }
    }
    toast(`已清理 ${rows.length} 条本机任务${svcTxt}`, "ok");
    schedulePendingRender();
    refresh();
  }

  ($("job-clear-done") as HTMLButtonElement | null)?.addEventListener("click", openCleanupDialog);
  ($("job-cleanup-ok") as HTMLButtonElement | null)?.addEventListener("click", () => {
    const catsEl = $("job-cleanup-cats");
    const boxes = Array.from(catsEl ? catsEl.querySelectorAll<HTMLInputElement>("input[type=checkbox]") : [])
      .filter((c) => c.checked).map((c) => c.value);
    if (!boxes.length) { toast("请至少勾选一个类别", "err"); return; }
    const sync = ($("job-cleanup-sync") as HTMLInputElement | null)?.checked ?? false;
    const okBtn = $("job-cleanup-ok") as HTMLButtonElement | null;
    if (okBtn) okBtn.disabled = true;
    closeCleanupDialog();
    runCleanup(new Set(boxes), sync)
      .catch((e) => toast(`清理失败：${(e as Error).message}`, "err"))
      .finally(() => { if (okBtn) okBtn.disabled = state.busy; });
  });
  ($("job-cleanup-x") as HTMLButtonElement | null)?.addEventListener("click", closeCleanupDialog);
  ($("job-cleanup-cancel") as HTMLButtonElement | null)?.addEventListener("click", closeCleanupDialog);
  cleanupBackdrop?.addEventListener("click", (ev) => { if (ev.target === cleanupBackdrop) closeCleanupDialog(); });

  // ---------- 勾选 + 批量操作（400+ 场景：勾选行 → 底部操作条） ----------
  // 行内勾选（change 委托；行整行重写时 checked 态由 core 串保证一致）
  jobList.onchange = (ev) => {
    const chk = (ev.target as HTMLElement).closest(".job-chk") as HTMLInputElement | null;
    if (!chk) return;
    const key = chk.dataset.key || "";
    if (chk.checked) state.selected.add(key);
    else state.selected.delete(key);
    renderBulkBar();
    renderSelAll();
  };

  // 0.2.47 需求2：任务搜索框（debounce 150ms；留空=全量；内存态，刷新即清）
  const jobSearchEl = $("job-search") as HTMLInputElement | null;
  if (jobSearchEl) {
    let searchTimer: number | undefined;
    jobSearchEl.addEventListener("input", () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        state.jobSearch = jobSearchEl.value;
        state.page = 0;
        renderJobs(state._jobs);
      }, 150);
    });
  }

  // 表头「全选当前筛选结果」（跨页；部分选中 → indeterminate）
  const selAll = $("job-sel-all") as HTMLInputElement | null;
  if (selAll) {
    selAll.onchange = () => {
      if (selAll.checked) for (const k of state._filteredKeys) state.selected.add(k);
      else for (const k of state._filteredKeys) state.selected.delete(k);
      // 当前页行内勾选同步（不触发 renderJobs，避免 5s 数据外的多余重排）
      for (const row of Array.from(jobList.children) as JobRowEl[]) {
        const chk = row.querySelector<HTMLInputElement>("input.job-chk");
        if (chk && !chk.disabled) chk.checked = selAll.checked;
      }
      renderBulkBar();
      renderSelAll();
    };
  }

  function renderSelAll() {
    if (!selAll) return;
    const sel = state._filteredKeys.filter((k) => state.selected.has(k)).length;
    selAll.checked = state._filteredKeys.length > 0 && sel === state._filteredKeys.length;
    selAll.indeterminate = sel > 0 && sel < state._filteredKeys.length;
  }

  const BULK_ACT_ZH: Record<string, string> = { pause: "暂停", resume: "继续", retry: "重试", cancel: "取消", assign: "改派" };

  /** F4：批量操作可用性 = 选中行中至少一行可操作（口径与服务端 api_jobs_bulk 逐条语义一致；
   *  不可操作行仍会逐条失败提示，不拖垮整批）。旧行为 5 按钮恒启用 → 点了必弹「暂无可操作任务」 */
  function bulkActEnabled(): Record<"pause" | "resume" | "retry" | "cancel" | "assign" | "ledger-clear" | "ledger-rerun", boolean> {
    const en = { pause: false, resume: false, retry: false, cancel: false, assign: false, "ledger-clear": false, "ledger-rerun": false };
    for (const r of lastMergedRows) {
      if (!state.selected.has(jobKey(r))) continue;
      // 0.2.57：账本行（本地记录）——清除恒可用；重跑仅中断且有源文件路径
      if (r.ledger === true) {
        en["ledger-clear"] = true;
        if (r.status === INTERRUPTED && r.file_path) en["ledger-rerun"] = true;
        continue;
      }
      if (r.dispatch_pending && !r.job_id) continue;
      if (r.job_id) {
        // 服务行：挂起仅限排队中；恢复仅限已挂起；重试=失败/跳过；取消=排队/运行中
        if (!r.paused && r.status === "pending") en.pause = true;
        if (r.paused) en.resume = true;
        if (r.status === "error" || r.status === "skipped") en.retry = true;
        if (!r.paused && (r.status === "pending" || r.status === "running")) en.cancel = true;
      } else if (r.task_id) {
        // 本机管线行：暂停=进行中；继续/重试=暂停/失败；改派=排队/已暂停（未提交服务）
        if (r.status === "running") en.pause = true;
        if (r.status === "paused" || r.status === "error") { en.resume = true; en.retry = true; }
        if (r.phase === "queued" || r.phase === "paused") en.assign = true;
      }
    }
    return en;
  }

  function renderBulkBar() {
    const bar = $("job-bulk-bar");
    const n = state.selected.size;
    if (!n) { bar.hidden = true; return; }
    bar.hidden = false;
    const info = $("job-bulk-info");
    if (info) info.textContent = `已选 ${n} 项`;
    // 改派目标下拉：auto + 已注册服务（sig 无变化不重建，避免吃掉用户选择）
    const sel = $("job-bulk-engine") as HTMLSelectElement | null;
    if (sel) {
      const opts = (state.engines || []).filter((e) => e.enabled !== false);
      const sig = "auto|" + opts.map((e) => `${e.name}:${e.online ? 1 : 0}`).join("|");
      if (sel.dataset.sig !== sig) {
        sel.dataset.sig = sig;
        sel.innerHTML = `<option value="auto">⚖ 自动均衡（实时选最闲）</option>`
          + opts.map((e) => `<option value="${esc(e.name)}">${esc(e.name)}${e.online ? "" : "（离线）"}</option>`).join("");
      }
    }
    // F4：按选中行状态启用/禁用（renderJobs 尾部恒调本函数，数据刷新后自动同步）
    const en = bulkActEnabled();
    for (const b of Array.from(bar.querySelectorAll<HTMLButtonElement>(".bulk-act"))) {
      b.disabled = !en[b.dataset.act as keyof typeof en];
    }
  }

  const bulkBar = $("job-bulk-bar");
  bulkBar.onclick = async (ev) => {
    const t0 = ev.target as HTMLElement;
    if (t0.closest(".bulk-clear")) {
      state.selected.clear();
      for (const row of Array.from(jobList.children) as JobRowEl[]) {
        const chk = row.querySelector<HTMLInputElement>("input.job-chk");
        if (chk && !chk.disabled) chk.checked = false;
      }
      renderBulkBar();
      renderSelAll();
      return;
    }
    const btn = t0.closest<HTMLButtonElement>(".bulk-act");
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act as "pause" | "resume" | "retry" | "cancel" | "assign" | "ledger-clear" | "ledger-rerun";
    // 0.2.57：账本行本地操作（纯本机，不依赖 t.bulkJobs）
    if (act === "ledger-clear" || act === "ledger-rerun") {
      const targets = lastMergedRows.filter((r) => r.ledger === true && state.selected.has(jobKey(r))
        && (act === "ledger-clear" || (r.status === INTERRUPTED && !!r.file_path)));
      if (!targets.length) {
        toast(act === "ledger-clear" ? "所选无本地记录行" : "所选无可重跑的中断行（需有源文件路径）", "err");
        return;
      }
      if (act === "ledger-clear") {
        for (const r of targets) ledgerRemove(r.pkey || jobKey(r));
        toast(`已清除 ${targets.length} 条本地记录`, "ok");
      } else {
        if (state.busy) { toast("有正在进行的提交任务，请完成后再试", "err"); return; }
        for (const b of Array.from(bulkBar.querySelectorAll<HTMLButtonElement>(".bulk-act"))) b.disabled = true;
        try {
          const rr = await rerunInterruptedRows(targets);
          const s2 = rerunSummary(rr);
          toast(s2.text, s2.level);
        } catch (e) {
          toast(`批量重跑失败：${(e as Error).message}`, "err");
        } finally {
          for (const b of Array.from(bulkBar.querySelectorAll<HTMLButtonElement>(".bulk-act"))) b.disabled = false;
        }
      }
      state.selected.clear();
      for (const row of Array.from(jobList.children) as JobRowEl[]) {
        const chk = row.querySelector<HTMLInputElement>("input.job-chk");
        if (chk && !chk.disabled) chk.checked = false;
      }
      renderBulkBar();
      renderSelAll();
      renderJobs(state._jobs);
      schedulePendingRender();
      refresh();
      return;
    }
    if (typeof t.bulkJobs !== "function") { toast("当前工作台版本不支持批量操作", "err"); return; }
    if (state.busy) { toast("有正在进行的提交任务，请完成后再试", "err"); return; }
    const bulkEngine = act === "assign"
      ? (($("job-bulk-engine") as HTMLSelectElement | null)?.value || "auto")
      : "";
    // 勾选行拆成两类：本机任务（task_id，无 job_id）/ 服务任务（engine+job_id 去重）
    const taskIds: string[] = [];
    const jobs: Array<{ engine: string; job_id: string }> = [];
    const seen = new Set<string>();
    for (const r of state._jobs) {
      if (!state.selected.has(jobKey(r))) continue;
      if (!r.job_id && r.task_id) {
        if (!taskIds.includes(r.task_id)) taskIds.push(r.task_id);
      } else if (r.job_id) {
        const ek = r.engine + "|" + r.job_id;
        if (!seen.has(ek)) { seen.add(ek); jobs.push({ engine: r.engine, job_id: r.job_id }); }
      }
    }
    if (!taskIds.length && !jobs.length) { toast("所选行暂无可操作任务（多为已完成行）", "err"); return; }
    if (act === "assign" && !taskIds.length) { toast("改派仅支持本机排队/暂停行（服务行已入队，不可改道）", "err"); return; }
    if (act === "cancel") {
      const ok = window.confirm(
        `确认取消选中的 ${jobs.length ? jobs.length + " 个服务任务" : "任务"}？\n` +
        "排队中/未开始的文件立即终止；运行中的将在检查点中止，已生成字幕保留。" +
        (taskIds.length ? "\n（本机未入队的任务无「取消」，会按失败计）" : ""),
      );
      if (!ok) return;
    }
    for (const b of Array.from(bulkBar.querySelectorAll<HTMLButtonElement>(".bulk-act"))) b.disabled = true;
    try {
      const res = await t.bulkJobs(act, taskIds, act === "assign" ? [] : jobs, bulkEngine || undefined);
      if (act === "assign") jobs.length = 0; // 改派只作用于本机行，避免误报服务行结果
      const fails = res.results.filter((x) => !x.ok);
      if (res.failed) {
        const detail = fails.slice(0, 3).map((f) => `${f.key}：${f.error || "失败"}`).join("；");
        toast(`批量${BULK_ACT_ZH[act]}：成功 ${res.succeeded}，失败 ${res.failed}${detail ? `（${detail}${fails.length > 3 ? "…" : ""}）` : ""}`, "err");
      } else {
        toast(`批量${BULK_ACT_ZH[act]}：成功 ${res.succeeded}`, "ok");
      }
      state.selected.clear();
      // core diff 未变的行不会重写 → 手动复位勾选，避免残留「已选」视觉态
      for (const row of Array.from(jobList.children) as JobRowEl[]) {
        const chk = row.querySelector<HTMLInputElement>("input.job-chk");
        if (chk && !chk.disabled) chk.checked = false;
      }
    } catch (e) {
      toast(`批量${BULK_ACT_ZH[act]}失败：${(e as Error).message}`, "err");
    } finally {
      for (const b of Array.from(bulkBar.querySelectorAll<HTMLButtonElement>(".bulk-act"))) b.disabled = false;
      refresh();
    }
  };

  // ---------- 服务表单（「＋ 添加服务」弹窗） ----------
  const engineAddBackdrop = $("engine-add-backdrop") as HTMLDivElement | null;
  const engineAddSubmit = $("engine-add-submit") as HTMLButtonElement | null;

  // 编辑态：null=「添加服务」；非 null=「编辑服务」（复用同一弹窗，预填 + 复制/查看 Key）
  let engineEditMode: { oldName: string } | null = null;

  function engineEditResetUi(): void {
    engineEditMode = null;
    engineForm.reset();
    engineKey.type = "password";
    ($("engine-add-title") as HTMLElement).textContent = "添加字幕服务";
    const revealBtn = $("engine-key-reveal") as HTMLButtonElement | null;
    if (revealBtn) revealBtn.textContent = "查看 Key";
    if (engineAddSubmit) engineAddSubmit.textContent = "添加服务";
    const copies = $("engine-edit-copies") as HTMLElement | null;
    if (copies) copies.hidden = true;
  }

  function engineAddClose(): void {
    engineEditResetUi();
    if (engineAddBackdrop) engineAddBackdrop.hidden = true;
  }

  function engineAddOpen(): void {
    if (!engineAddBackdrop) return;
    engineEditResetUi();
    engineAddBackdrop.hidden = false;
    engineName.focus();
    engineName.select();
  }

  /** 编辑服务：预填名称/地址/Key（Key 走 getEngineKey 本地登记），切编辑态文案 */
  async function engineEditOpen(name: string): Promise<void> {
    if (!engineAddBackdrop || typeof t.updateEngine !== "function") return;
    const eng = (state.engines || []).find((e) => e.name === name);
    if (!eng) return;
    engineEditMode = { oldName: name };
    engineForm.reset();
    engineName.value = eng.name;
    engineUrl.value = eng.url;
    engineKey.value = "";
    if (typeof t.getEngineKey === "function") {
      try { engineKey.value = (await t.getEngineKey(name)).api_key; } catch { /* 读不到按空预填 */ }
    }
    ($("engine-add-title") as HTMLElement).textContent = "编辑服务";
    if (engineAddSubmit) engineAddSubmit.textContent = "保存修改";
    const copies = $("engine-edit-copies") as HTMLElement | null;
    if (copies) copies.hidden = false;
    engineAddBackdrop.hidden = false;
    engineName.focus();
    engineName.select();
  }

  /** 服务改名联动（B 联动）：写回登记/watch/勾选 key 前缀、pending 子行、最近使用服务。
   *  写回登记不 remap → 改名后旧名 key 对不上新快照行，重启后写回静默失效（与 B 同根因） */
  function remapEngineName(oldName: string, newName: string): void {
    if (oldName === newName) return;
    const prefix = oldName + "|";
    const remapKey = (k: string): string => (k.startsWith(prefix) ? newName + k.slice(prefix.length) : k);
    for (const [k, info] of [...state.writeBackJobs]) {
      const nk = remapKey(k);
      if (nk === k) continue;
      state.writeBackJobs.delete(k);
      state.writeBackJobs.set(nk, { ...info, engine: newName });
      const at = wbAt.get(k);
      if (at != null) { wbAt.set(nk, at); wbAt.delete(k); }
    }
    for (const k of [...state.watchWriteBack]) {
      const nk = remapKey(k);
      if (nk !== k) { state.watchWriteBack.delete(k); state.watchWriteBack.add(nk); }
    }
    for (const k of [...state.selected]) {
      const nk = remapKey(k);
      if (nk !== k) { state.selected.delete(k); state.selected.add(nk); }
    }
    for (const p of state._pending.values()) if (p.row.engine === oldName) p.row.engine = newName;
    if (localStorage.getItem("javweb_engine") === oldName) localStorage.setItem("javweb_engine", newName);
    saveWriteBackStore();
  }

  ($("engine-add-btn") as HTMLButtonElement | null)?.addEventListener("click", engineAddOpen);
  // 「刷新状态」：立即重探测所有服务（web 触发工作台 poller 一轮；desktop 绕过 main 3s 快照）
  {
    const btn = $("engine-refresh-btn") as HTMLButtonElement | null;
    if (!btn) throw new Error("engine-refresh-btn 缺失");
    if (typeof t.refreshEngines !== "function") {
      btn.remove(); // 形态不支持（理论分支）：隐藏按钮
    } else {
      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        const prev = btn.innerHTML;
        btn.innerHTML = "检测中…";
        try {
          const list = await t.refreshEngines!();
          const on = list.filter((e) => e.online).length;
          toast(`在线 ${on} 台 / 离线 ${list.length - on} 台`, on ? "ok" : "err");
        } catch (ex) {
          toast(ex instanceof Error ? ex.message : "刷新失败", "err");
        } finally {
          btn.disabled = false;
          btn.innerHTML = prev;
          refresh(); // 以新快照重渲服务列表
        }
      });
    }
  }
  ($("engine-add-x") as HTMLButtonElement | null)?.addEventListener("click", engineAddClose);
  ($("engine-add-cancel") as HTMLButtonElement | null)?.addEventListener("click", engineAddClose);
  engineAddBackdrop?.addEventListener("click", (ev) => { if (ev.target === engineAddBackdrop) engineAddClose(); });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && engineAddBackdrop && !engineAddBackdrop.hidden) engineAddClose();
  });

  // 编辑态：复制地址 / 复制 Key / 显示-隐藏 Key（仅 desktop 编辑态可用，web 形态该行隐藏）
  ($("engine-copy-url") as HTMLButtonElement | null)?.addEventListener("click", async () => {
    const ok = await copyText(engineUrl.value.trim());
    toast(ok ? "服务地址已复制" : "复制失败，请手动选择复制", ok ? "ok" : "err");
  });
  ($("engine-copy-key") as HTMLButtonElement | null)?.addEventListener("click", async () => {
    const key = engineKey.value.trim();
    if (!key) { toast("该服务未登记 API Key", "err"); return; }
    const ok = await copyText(key);
    toast(ok ? "API Key 已复制" : "复制失败，请手动选择复制", ok ? "ok" : "err");
  });
  ($("engine-key-reveal") as HTMLButtonElement | null)?.addEventListener("click", () => {
    const reveal = engineKey.type === "password";
    engineKey.type = reveal ? "text" : "password";
    ($("engine-key-reveal") as HTMLButtonElement).textContent = reveal ? "隐藏 Key" : "查看 Key";
  });

  engineForm.onsubmit = async (ev) => {
    ev.preventDefault();
    const name = engineName.value.trim();
    const url = engineUrl.value.trim();
    const api_key = engineKey.value.trim();
    if (engineAddSubmit) engineAddSubmit.disabled = true;
    try {
      if (engineEditMode) {
        const oldName = engineEditMode.oldName;
        await t.updateEngine!(oldName, name, url, api_key);
        remapEngineName(oldName, name); // 写回登记/ pending 行/勾选/主任务(batches) 联动改键
        toast(`服务「${name}」已更新`, "ok");
      } else {
        await t.addEngine(name, url, api_key);
      }
      engineEditResetUi();
      engineAddClose();
      refresh();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      if (engineAddSubmit) engineAddSubmit.disabled = false;
    }
  };

  // ---------- 生成字幕 ----------
  function engineHostHint(e: Engine): string {
    try {
      const u = new URL(e.url);
      return u.host ? `（${u.host}）` : "";
    } catch {
      return "";
    }
  }

  const engineHint = $("engine-hint") as HTMLDivElement | null;
  function updateEngineHint() {
    if (!engineHint) return;
    const v = engineSelect.value;
    engineHint.textContent = v === "auto"
      ? "⚖ 自动均衡：派发/提交时刻按实时负载选最闲服务（推荐）；扫描目录提交按在途把文件摊给各服务；任务表内可逐条/批量改派"
      : (v ? `已绑定「${v}」：整批只发该服务、不参与均衡（任务表内可改派）` : "");
  }

  function renderSelect(engines: Engine[]) {
    const sel = engineSelect;
    if (!engines.length) {
      if (sel.dataset.sig !== "empty") {
        sel.dataset.sig = "empty";
        sel.innerHTML = '<option value="">（先添加服务）</option>';
      }
      updateGo();
      return;
    }
    const online = engines.filter((e) => e.online);
    const pool = online.length ? online : engines;
    // auto 选项：≥2 台服务即可用。派发时刻实时选最闲：web 由工作台服务端 pick_engine 解析，
    // desktop 由客户端 resolveAutoEngine 解析（数据源=客户端在途记账，desktop v0.2.32+）
    const canAuto = engines.length >= 2;
    // 选项集（auto 可用性+名称+在线态）无变化不重建：避免 5s 轮询周期性重绘把用户手选静默打回第一项
    const sig = (canAuto ? "auto|" : "") + pool.map((e) => `${e.name}:${e.online ? 1 : 0}`).join("|");
    if (sel.dataset.sig === sig) {
      updateGo();
      updateEngineHint();
      return;
    }
    const prev = sel.value;
    sel.dataset.sig = sig;
    const autoOpt = canAuto
      ? `<option value="auto">⚖ 自动均衡（${engines.length} 台服务，实时选最闲）</option>`
      : "";
    sel.innerHTML = autoOpt + pool
      .map((e) => `<option value="${esc(e.name)}">${esc(e.name)}${engineHostHint(e)}${e.online ? "" : "（离线）"}</option>`)
      .join("");
    // 现存选中（用户本次手选）> auto（默认：派发时刻实时调度）> 第一项。
    // 不再回读 localStorage 记忆值——历史记忆值导致整批静默绑死单台服务（09-25 批）。
    const prevValid = !!prev && (prev === "auto" ? canAuto : pool.some((e) => e.name === prev));
    if (prevValid) sel.value = prev;
    else if (canAuto) sel.value = "auto";
    updateGo();
    updateEngineHint();
  }

  function pendingCount() {
    if (state.folderFiles) return state.folderChecked.size;
    return state.file ? 1 : 0;
  }

  function updateGo() {
    const n = pendingCount();
    const ok = n > 0 && !!engineSelect.value; // 0.2.53 需求①：批次在跑不再门控入口（可并发建新主任务）
    dispatchGo.disabled = !ok;
    dispatchGo.innerHTML = n > 1 ? "&#9654; 开始生成（" + n + " 项）" : "&#9654; 开始生成";
    updateScanGo();
  }

  function updateScanGo() {
    const scanActive = !!state.scanTask && ["queued", "running", "paused"].includes(state.scanTask.status);
    scanGo.disabled =
      !scanPath.value.trim() || !engineSelect.value || scanActive; // 0.2.53 需求①：批次在跑可发起新扫描任务
  }

  engineSelect.onchange = () => {
    // 即时持久化：手选即生效，轮询刷新/重启后保留（修复「选了远程却提交到本地服务端」）
    if (engineSelect.value) localStorage.setItem("javweb_engine", engineSelect.value);
    updateEngineHint();
    updateGo();
    watchPump();
  };
  scanPath.oninput = updateScanGo;

  // ---------- 扫描目录「浏览」：web 形态目录浏览弹窗（客户端部署机文件系统）；desktop 形态原生对话框 ----------
  const scanBrowse = $("scan-browse") as HTMLButtonElement | null;
  const dirBackdrop = $("dir-backdrop") as HTMLDivElement | null;
  const dirCwd = $("dir-cwd") as HTMLInputElement | null;
  const dirList = $("dir-list") as HTMLDivElement | null;
  const dirUp = $("dir-up") as HTMLButtonElement | null;
  const dirPick = $("dir-pick") as HTMLButtonElement | null;
  const dirNote = $("dir-note");
  let dirLast = "";
  let dirSeq = 0;

  function dirClose(): void {
    if (dirBackdrop) dirBackdrop.hidden = true;
  }

  function dirJoin(base: string, name: string): string {
    return base === "/" ? "/" + name : base + "/" + name;
  }

  async function dirLoad(p: string): Promise<void> {
    const fn = t.fsBrowse;
    if (!fn) throw new Error("当前形态不支持目录浏览");
    const seq = ++dirSeq;
    if (dirList) dirList.innerHTML = '<div class="muted small" style="padding:10px 18px">加载中…</div>';
    try {
      const d = await fn(p);
      if (seq !== dirSeq) return;
      dirLast = d.path;
      if (dirCwd) dirCwd.value = d.path;
      if (dirUp) dirUp.disabled = !d.parent;
      if (dirPick) dirPick.disabled = false;
      if (dirNote) dirNote.textContent = d.truncated ? "仅显示前 4000 项；可在上方输入更精确路径后按 Enter" : "";
      if (!dirList) return;
      if (!d.entries.length) {
        dirList.innerHTML = '<div class="muted small" style="padding:10px 18px">空目录</div>';
        return;
      }
      const frag = document.createDocumentFragment();
      for (const e of d.entries) {
        const row = document.createElement("div");
        row.className = "dir-row" + (e.is_dir ? "" : " file");
        const nm = document.createElement("span");
        nm.className = "dir-name";
        nm.textContent = e.is_dir ? e.name + "/" : e.name;
        row.appendChild(nm);
        if (!e.is_dir && e.size_mb != null) {
          const sz = document.createElement("span");
          sz.className = "dir-size";
          sz.textContent = fmtSize(e.size_mb * 1048576);
          row.appendChild(sz);
        }
        if (e.is_dir) {
          row.tabIndex = 0;
          row.onclick = () => { void dirLoad(dirJoin(d.path, e.name)); };
          row.onkeydown = (ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              void dirLoad(dirJoin(d.path, e.name));
            }
          };
        }
        frag.appendChild(row);
      }
      dirList.replaceChildren(frag);
    } catch (ex) {
      if (seq !== dirSeq) return;
      if (dirList) dirList.replaceChildren();
      toast((ex as Error).message || "加载目录失败", "err");
    }
  }

  function dirOpen(): void {
    if (!dirBackdrop) return;
    dirBackdrop.hidden = false;
    void dirLoad(dirLast);
    if (dirCwd) { dirCwd.focus(); dirCwd.select(); }
  }

  if (scanBrowse) {
    scanBrowse.onclick = async () => {
      if (platform.kind === "desktop") {
        const bd = (window as unknown as {
          javDesktop?: { pickDir?: (title?: string) => Promise<string | null> };
        }).javDesktop?.pickDir;
        if (!bd) { toast("目录选择不可用", "err"); return; }
        try {
          const p = await bd("选择扫描目录");
          if (p) {
            scanPath.value = p;
            updateScanGo();
          }
        } catch (e) {
          toast((e as Error).message || "选择目录失败", "err");
        }
        return;
      }
      dirOpen();
    };
  }
  if (dirUp) dirUp.onclick = () => {
    const p = dirLast;
    if (!p || p === "/") return;
    const stripped = p.replace(/\/+$/, "") || "/";
    const idx = stripped.lastIndexOf("/");
    void dirLoad(idx <= 0 ? "/" : stripped.slice(0, idx));
  };
  dirCwd?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && dirCwd) {
      ev.preventDefault();
      void dirLoad(dirCwd.value.trim());
    }
  });
  if (dirPick) dirPick.onclick = () => {
    if (!dirLast) return;
    scanPath.value = dirLast;
    updateScanGo();
    dirClose();
  };
  const dirX = $("dir-x") as HTMLButtonElement | null;
  if (dirX) dirX.onclick = dirClose;
  dirBackdrop?.addEventListener("click", (ev) => { if (ev.target === dirBackdrop) dirClose(); });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && dirBackdrop && !dirBackdrop.hidden) dirClose();
  });

  // ---------- 字幕预览弹窗（扫描表「外部 srt」读客户端部署机文件 / 任务表走 result 端点） ----------
  const srtBackdrop = $("srt-backdrop") as HTMLDivElement | null;
  const srtTitle = $("srt-title") as HTMLHeadingElement | null;
  const srtMeta = $("srt-meta");
  const srtTimeline = $("srt-timeline") as HTMLDivElement | null;
  const srtList = $("srt-list") as HTMLDivElement | null;
  const srtNote = $("srt-note");

  function srtClose(): void {
    if (srtBackdrop) srtBackdrop.hidden = true;
  }

  let srtCues: SrtCue[] = [];
  let srtSpan = 1;

  /** 横坐标 frac → cue 下标：先按 [start,end] 命中，未命中就近（距任一 cue 边界 ≤5s 才算） */
  function srtCueAt(frac: number): number | null {
    if (!srtCues.length) return null;
    const t = frac * srtSpan;
    for (let i = 0; i < srtCues.length; i++) {
      const c = srtCues[i];
      if (t >= c.start - 0.001 && t <= c.end + 0.001) return i;
    }
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < srtCues.length; i++) {
      const c = srtCues[i];
      const d = Math.min(Math.abs(t - c.start), Math.abs(t - c.end));
      if (d < bd) { bd = d; best = i; }
    }
    return bd <= 5 ? best : null;
  }

  // 时间轴 segment ↔ 列表行 双向高亮；focusList=true 时列表滚动到该 cue
  function srtSelectCue(i: number, focusList: boolean): void {
    if (!srtTimeline || !srtList) return;
    srtTimeline.querySelectorAll(".srt-seg.active").forEach((n) => n.classList.remove("active"));
    srtList.querySelectorAll(".srt-cue.active").forEach((n) => n.classList.remove("active"));
    const seg = srtTimeline.querySelector(`.srt-seg[data-i="${i}"]`);
    const cue = srtList.querySelector(`.srt-cue[data-i="${i}"]`);
    if (seg) seg.classList.add("active");
    if (cue) {
      cue.classList.add("active");
      if (focusList) (cue as HTMLElement).scrollIntoView({ block: "center" });
    }
  }

  function srtRender(parsed: SrtParseResult, name: string, sizeMb: number | null, raw: string): void {
    if (srtTitle) srtTitle.textContent = `字幕预览 · ${name}`;
    if (srtBackdrop) srtBackdrop.hidden = false;
    if (!srtTimeline || !srtList || !srtMeta) return;
    srtTimeline.replaceChildren();
    srtList.replaceChildren();
    if (parsed.invalid || !parsed.cues.length) {
      srtMeta.textContent = "";
      srtTimeline.hidden = true;
      if (srtNote) srtNote.textContent = "未解析出有效字幕时间轴，以下为原文：";
      const pre = document.createElement("pre");
      pre.className = "srt-raw";
      pre.textContent = raw;
      srtList.appendChild(pre);
      return;
    }
    srtTimeline.hidden = false;
    if (srtNote) srtNote.textContent = "";
    const cues = parsed.cues;
    const first = cues[0].start;
    let last = 0;
    for (const c of cues) if (c.end > last) last = c.end;
    const span = Math.max(last - first, 0.001);
    srtMeta.innerHTML =
      `<span class="srt-stat"><b>${cues.length}</b> 条字幕</span>` +
      `<span class="srt-stat">起始 <b class="mono">${fmtSrtTime(first)}</b></span>` +
      `<span class="srt-stat">结束 <b class="mono">${fmtSrtTime(last)}</b></span>` +
      `<span class="srt-stat">跨 <b class="mono">${fmtSrtSpan(last - first)}</b></span>` +
      (sizeMb != null ? `<span class="srt-stat">文件 <b class="mono">${mbText(sizeMb)}</b></span>` : "");
    // 时间轴：cue 段纯视觉（密集时仅 1-2px，无独立点击面）；交互挂在轨道上——
    // 悬停显示时间游标 + tooltip，点击按横坐标反查 cue（命中优先、就近兜底 ≤5s）
    srtCues = cues;
    srtSpan = span;
    const tfrag = document.createDocumentFragment();
    for (const c of cues) {
      const seg = document.createElement("div");
      seg.className = "srt-seg";
      seg.dataset.i = String(c.index - 1);
      seg.style.left = `${(c.start / span) * 100}%`;
      seg.style.width = `${Math.max(((c.end - c.start) / span) * 100, 0.08)}%`;
      tfrag.appendChild(seg);
    }
    const cursor = document.createElement("div");
    cursor.className = "srt-cursor";
    const tip = document.createElement("div");
    tip.className = "srt-tip";
    tfrag.append(cursor, tip);
    srtTimeline.appendChild(tfrag);
    const hideHover = () => { cursor.style.opacity = "0"; tip.hidden = true; };
    srtTimeline.onmousemove = (ev) => {
      const r = srtTimeline.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      cursor.style.left = `${frac * 100}%`;
      cursor.style.opacity = "0.6";
      const i = srtCueAt(frac);
      if (i == null) { tip.hidden = true; return; }
      const c = srtCues[i];
      tip.textContent = `#${c.index} ${fmtSrtTime(c.start)} → ${fmtSrtTime(c.end)} · ${c.text.replace(/\n/g, " ").slice(0, 60)}`;
      tip.style.left = `${Math.min(0.97, Math.max(0.03, frac)) * 100}%`;
      tip.hidden = false;
    };
    srtTimeline.onmouseleave = hideHover;
    srtTimeline.onclick = (ev) => {
      const r = srtTimeline.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      const i = srtCueAt(frac);
      if (i != null) srtSelectCue(i, true);
    };
    // 列表：# / 时间轴 / 文本；点击高亮时间轴对应段
    const lfrag = document.createDocumentFragment();
    for (const c of cues) {
      const row = document.createElement("div");
      row.className = "srt-cue";
      row.dataset.i = String(c.index - 1);
      const no = document.createElement("span");
      no.className = "srt-no mono";
      no.textContent = String(c.index);
      const tm = document.createElement("span");
      tm.className = "srt-time mono";
      tm.textContent = `${fmtSrtTime(c.start)} → ${fmtSrtTime(c.end)}`;
      const tx = document.createElement("span");
      tx.className = "srt-text";
      tx.textContent = c.text;
      row.append(no, tm, tx);
      row.onclick = () => srtSelectCue(c.index - 1, false);
      lfrag.appendChild(row);
    }
    srtList.appendChild(lfrag);
  }

  function openSrtPreview(name: string, text: string, sizeMb: number | null): void {
    srtRender(parseSrt(text), name, sizeMb, text);
  }

  // 入口一：扫描表「外部 srt」→ 读客户端部署机上的 srt 文件
  $("scan-table").addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>(".srt-pv");
    if (b && b.dataset.srt) {
      t.readSrt(b.dataset.srt)
        .then((d) => openSrtPreview(d.name, d.text, d.size_mb))
        .catch((e: Error) => toast(e.message || "字幕预览失败", "err"));
      return;
    }
    // 0.2.47 需求1：「已生成未落盘」行 → 回写已完成任务结果到影片同目录（desktop-only 按钮）
    const wb = (ev.target as HTMLElement).closest<HTMLElement>(".scan-wb");
    if (wb && wb.dataset.path) {
      const path = wb.dataset.path;
      const item = state.scanItems.find((i) => i.path === path);
      if (item) {
        (wb as HTMLButtonElement).disabled = true; // 防连点
        void scanWriteBackItem(item).then(() => { if (state.lastScan) renderScanResults(state.lastScan); });
      }
      return;
    }
  });

  // 入口二：任务表 done 行 → result 端点拉 srt 内容（本地扫描/远端任务通用）
  jobList.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>(".srt-pv");
    if (!b || !b.dataset.jid) return;
    const j = (state._jobs || []).find(
      (x) => x.job_id === b!.dataset.jid && x.engine === b!.dataset.eng,
    );
    if (!j || !j.job_id) return;
    fetch(t.getResultUrl(j.engine, j.job_id), { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();
        openSrtPreview(srtNameFor(j), text, null);
      })
      .catch((e: Error) => toast(e.message || "字幕预览失败", "err"));
  });

  const srtX = $("srt-x") as HTMLButtonElement | null;
  if (srtX) srtX.onclick = srtClose;
  srtBackdrop?.addEventListener("click", (ev) => { if (ev.target === srtBackdrop) srtClose(); });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && srtBackdrop && !srtBackdrop.hidden) srtClose();
  });

  function setStep(id: string, cls: string, dot: string | null, meta: string | null) {
    const el = $(id);
    el.className = "step" + (cls ? " " + cls : "");
    if (dot != null) el.querySelector(".step-dot")!.textContent = dot;
    if (meta != null) $(id.replace("step-", "meta-")).textContent = meta;
  }

  // 进度条设宽；instant=true 时跳过过渡（阶段重置归零不能播“回退”动画）
  function setFill(width: string, instant = false) {
    const el = $("dispatch-fill");
    if (instant) {
      el.style.transition = "none";
      el.style.width = width;
      void el.offsetWidth;
      el.style.transition = "";
    } else {
      el.style.width = width;
    }
  }

  // 提取阶段收尾（轮询可能跳过 extracting 直接到 dispatching/done，需兜底补齐）
  function markExtractDone(audioMb: number | null | undefined) {
    setStep("step-extract", "done", "\u2713", extractDoneMeta(audioMb));
    line2.classList.add("on");
  }

  function resetPipeline() {
    $("pipeline").hidden = true;
    setStep("step-upload", "", "1", "");
    setStep("step-extract", "", "2", "");
    setStep("step-dispatch", "", "3", "");
    line1.classList.remove("on");
    line2.classList.remove("on");
    setFill("0", true);
    $("dispatch-status").hidden = true;
    $("dispatch-status").className = "dispatch-status";
  }

  function setFile(f?: File | null) {
    if (!f) return;
    state.file = f;
    state._fsFileDir = null;
    if (state.folderFiles) clearFolder();
    $("file-chip").hidden = false;
    $("chip-name").textContent = f.name;
    $("chip-size").textContent = fmtSize(f.size);
    drop.classList.add("has-file");
    resetPipeline();
    updateGo();
  }

  async function pickFile() {
    const p = await platform.pickVideoFile();
    if (p === "fallback") { fileInput.click(); return; }
    if (p) {
      setFile(p.file);
      state._fsFileDir = p.dirHandle;
    }
  }

  drop.onclick = (ev) => {
    if (ev.target instanceof Element && ev.target.closest(".help")) return; // 帮助图标不触发选文件
    pickFile(); // 0.2.53 需求①：批次在跑可选单文件
  };
  drop.onkeydown = (ev) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pickFile(); } // 0.2.53 需求①
  };
  fileInput.onchange = (ev) => {
    const files = (ev.target as HTMLInputElement).files;
    setFile(files ? files[0] : null);
  };
  for (const name of ["dragover", "dragenter"] as const) {
    drop.addEventListener(name, (ev) => { ev.preventDefault(); drop.classList.add("hover"); }); // 0.2.53 需求①
  }
  for (const name of ["dragleave", "drop"] as const) {
    drop.addEventListener(name, (ev) => { ev.preventDefault(); drop.classList.remove("hover"); });
  }
  drop.addEventListener("drop", (ev) => {
    const dt = ev.dataTransfer;
    if (dt) setFile(dt.files[0]); // 0.2.53 需求①
  });

  chipX.onclick = () => {
    state.file = null; // 0.2.53 需求①：批次在跑可清除（在途派发已持 File 引用）
    state._fsFileDir = null;
    fileInput.value = "";
    $("file-chip").hidden = true;
    drop.classList.remove("has-file");
    resetPipeline();
    updateGo();
  };

  // ---------- 选择文件夹（本地过滤 + 待选表，规则统一消费「设置 → 客户端 → 扫描规则」） ----------
  function folderRules(): FolderScanRules {
    // 与「扫描目录」同源：client config 的 scan_* 键；未设置过 = 内置默认
    const cc = state.ccfg || ({} as ClientConfig);
    return {
      video_exts: cc.scan_video_exts?.length
        ? cc.scan_video_exts.map((x) => String(x).toLowerCase().replace(/^\./, "")).filter(Boolean)
        : [...VIDEO_EXTS],
      subtitle_patterns: cc.scan_subtitle_patterns?.length
        ? cc.scan_subtitle_patterns.map((x) => (String(x).toLowerCase().startsWith(".") ? String(x).toLowerCase() : "." + String(x).toLowerCase())).filter(Boolean)
        : [...LOCAL_SUB_PATTERNS],
      min_size_mb: typeof cc.scan_min_size_mb === "number" ? cc.scan_min_size_mb : 200,
      has_sub_tokens: Array.isArray(cc.scan_has_sub_tokens) ? cc.scan_has_sub_tokens : ["c"],
      no_sub_tokens: Array.isArray(cc.scan_no_sub_tokens) ? cc.scan_no_sub_tokens : [],
    };
  }

  function folderKey(v: FolderVideo): string {
    return v.file.webkitRelativePath || v.file.name;
  }
  function folderHasSub(v: FolderVideo): boolean {
    return v.sub_status !== "none";
  }

  function clearFolder() {
    state.folderGen++; // 0.2.53 需求①：用户清除动作 → 代际递增
    state.folderFiles = null;
    state.folderChecked = new Set();
    state.folderPage = 0;
    folderInput.value = "";
    $("folder-chip").hidden = true;
    $("folder-pending").hidden = true;
    resetPipeline();
    updateGo();
  }

  function setFolder(files: FolderFile[]) {
    if (!files || !files.length) return;
    state.file = null;
    fileInput.value = "";
    $("file-chip").hidden = true;
    drop.classList.remove("has-file");
    const rules = folderRules();
    // 同目录名集合：判断「<stem>.zh.srt / <stem>.srt」是否已随文件夹选中
    //（web 渲染层判定；desktop 原生选择目录 main 侧已判好，随 _meta 带入）
    const byDir = new Map<string, Set<string>>();
    for (const f of files) {
      const rel = f.webkitRelativePath || f.name;
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      if (!byDir.has(dir)) byDir.set(dir, new Set());
      byDir.get(dir)!.add(f.name.toLowerCase());
    }
    const vids: FolderVideo[] = [];
    for (const f of files) {
      if (!folderIsVideo(f.name, rules) || f.size <= 0) continue;
      const rel = f.webkitRelativePath || f.name;
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const meta = f._meta || folderVideoMeta(f.name, f.size, byDir.get(dir) || new Set(), rules);
      vids.push({ file: f, ...meta });
    }
    if (!vids.length) {
      toast("该文件夹里没有支持的视频文件（可到「设置 → 客户端 → 扫描规则」调整扩展名）", "err");
      return;
    }
    state.folderGen++; // 0.2.53 需求①：用户选择动作 → 代际递增
    state.folderFiles = vids;
    // 默认勾选 = 无字幕项（外部 srt / 标记（名）默认不勾；过小默认不勾可手勾）——与扫描表同口径
    state.folderChecked = new Set(vids.filter((v) => !folderHasSub(v) && !v.too_small).map(folderKey));
    state.folderPage = 0;
    $("folder-chip").hidden = false;
    $("folder-pending").hidden = false;
    renderFolderTable();
    resetPipeline();
    updateGo();
  }

  function folderSubCell(v: FolderVideo): string {
    if (v.sub_status === "external") {
      return `<span class="tag subtag" title="同目录字幕：${esc(v.sub_name || "")}">外部 srt</span>`;
    }
    if (v.sub_status === "named") {
      return `<span class="tag subtag" title="文件名含标记 ${esc(v.sub_token || "")}，按规则视为已压字幕（可在「设置 → 客户端 → 扫描规则」改判）">标记（名）</span>`;
    }
    if (v.no_sub_token) {
      return `<span class="tag subtag ok" title="文件名含标记 ${esc(v.no_sub_token)}，按规则视为无字幕版（可在「设置 → 客户端 → 扫描规则」改判）">无字幕（名）</span>`;
    }
    return '<span class="muted" title="本地不检查内嵌字幕轨">未检查</span>';
  }

  // 本页全选派生回写（0.2.53 需求②）：render 与全局「全选」共用——全局全选手动同步行框
  // 不重渲染，表头框须同步重派生，否则残留上一渲染态（首击 page-all 会被误判为取消）
  function syncFolderPageAll(): void {
    const pa = $("folder-table").querySelector("#folder-page-all") as HTMLInputElement | null;
    if (!pa) return;
    const items = state.folderFiles || [];
    const PAGE = state.scanPageSize;
    const pages = Math.max(1, Math.ceil(items.length / PAGE));
    const pg = Math.min(Math.max(0, state.folderPage), pages - 1);
    const pageItems = items.slice(pg * PAGE, (pg + 1) * PAGE);
    const pageSelKeys = pageItems.filter((v) => !v.too_small).map(folderKey);
    const nSel = pageSelKeys.filter((k) => state.folderChecked.has(k)).length;
    pa.disabled = pageSelKeys.length === 0;
    pa.indeterminate = nSel > 0 && nSel < pageSelKeys.length;
    pa.checked = pageSelKeys.length > 0 && nSel === pageSelKeys.length;
  }

  function renderFolderTable(): void {
    const items = state.folderFiles || [];
    const PAGE = state.scanPageSize; // 复用扫描表每页行数档位（同一 localStorage 键）
    const pages = Math.max(1, Math.ceil(items.length / PAGE));
    const pg = Math.min(Math.max(0, state.folderPage), pages - 1);
    const pageItems = items.slice(pg * PAGE, (pg + 1) * PAGE);
    $("folder-table").innerHTML = pageItems.length ? `
      <table class="scan-table">
        <thead><tr><th class="col-check"><input type="checkbox" id="folder-page-all" aria-label="本页全选" title="勾选本页全部可选项（过小项需手动勾选）"></th><th>文件</th><th class="col-size">大小</th><th class="col-sub">字幕</th></tr></thead>
        <tbody>
          ${pageItems.map((v) => `
            <tr class="${folderHasSub(v) ? "has-sub" : ""}${v.too_small ? " too-small" : ""}">
              <td class="col-check"><input type="checkbox" data-key="${esc(folderKey(v))}"${state.folderChecked.has(folderKey(v)) ? " checked" : ""}></td>
              <td class="scan-name mono" title="${esc(folderKey(v))}">${esc(v.file.name)}${v.too_small ? '<span class="tag tinytag" title="低于「忽略小于」阈值，不默认选中；可手动勾选提交">过小</span>' : ""}</td>
              <td class="mono">${fmtSize(v.file.size)}</td>
              <td class="col-sub">${folderSubCell(v)}</td>
            </tr>`).join("")}
        </tbody>
      </table>` : '<div class="muted small">该文件夹里没有视频文件</div>';
    $("folder-table").querySelectorAll("input[type=checkbox]").forEach((cb) => {
      const input = cb as HTMLInputElement;
      if (input.id === "folder-page-all") return; // 0.2.53 需求②：表头本页全选走独立绑定
      input.onchange = () => {
        if (input.checked) state.folderChecked.add(input.dataset.key || "");
        else state.folderChecked.delete(input.dataset.key || "");
        updateFolderSummary();
        syncFolderPageAll(); // 0.2.53 需求②：行级勾选不重渲染，表头框须重派生
      };
    });
    // 本页全选（0.2.53 需求②）：只作用「当前页 ∩ 可选项」（too_small 需手动勾选）；取消只清当前页
    {
      const pa = $("folder-table").querySelector("#folder-page-all") as HTMLInputElement | null;
      if (pa) {
        const pageSelKeys = pageItems.filter((v) => !v.too_small).map(folderKey);
        syncFolderPageAll();
        pa.onchange = () => {
          if (pa.checked) for (const k of pageSelKeys) state.folderChecked.add(k);
          else for (const k of pageSelKeys) state.folderChecked.delete(k);
          renderFolderTable();
        };
      }
    }
    renderFolderPager(items.length);
    updateFolderSummary();
  }

  function renderFolderPager(total: number): void {
    const el = $("folder-pager");
    const pages = Math.max(1, Math.ceil(total / state.scanPageSize));
    if (pages <= 1) { el.hidden = true; el.innerHTML = ""; return; }
    const pg = Math.min(Math.max(0, state.folderPage), pages - 1);
    const go = (next: number) => {
      const clamped = Math.min(Math.max(0, next), pages - 1);
      if (clamped === state.folderPage) return;
      state.folderPage = clamped;
      renderFolderTable();
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };
    el.innerHTML = `
      <button type="button" class="pg-btn txt" id="fpg-prev"${pg === 0 ? " disabled" : ""}>← 上一页</button>
      <span class="pg-info mono">第 ${pg + 1} / ${pages} 页 · 共 ${total} 个文件</span>
      <button type="button" class="pg-btn txt" id="fpg-next"${pg >= pages - 1 ? " disabled" : ""}>下一页 →</button>` +
      `<select id="fpg-size" class="pg-size" title="待选表每页行数" aria-label="每页行数">${PAGE_SIZE_OPTS}</select>`;
    el.hidden = false;
    (el.querySelector("#fpg-prev") as HTMLButtonElement).onclick = () => go(pg - 1);
    (el.querySelector("#fpg-next") as HTMLButtonElement).onclick = () => go(pg + 1);
    const sizeSel = el.querySelector("#fpg-size") as HTMLSelectElement;
    sizeSel.value = String(state.scanPageSize);
    sizeSel.onchange = () => {
      state.scanPageSize = Number(sizeSel.value) || 10;
      localStorage.setItem("javweb_scan_pagesize", String(state.scanPageSize));
      state.folderPage = 0;
      renderFolderTable();
    };
  }

  function updateFolderSummary(): void {
    const items = state.folderFiles || [];
    const n = state.folderChecked.size;
    const nSub = items.filter(folderHasSub).length;
    const nSmall = items.filter((v) => v.too_small && !state.folderChecked.has(folderKey(v))).length;
    // 0.2.52 M1：多目录选择（multiSelections / webkitdirectory 多顶层）→ chip 追加「· N 个目录」；
    // 顶层目录 = webkitRelativePath 首段（原生选择与 webkitdirectory 同口径）
    const tops = new Set(
      items.map((v) => (v.file.webkitRelativePath || "").split("/").filter(Boolean)[0]).filter(Boolean),
    );
    const topN = tops.size;
    const topNote = items.length && topN > 1 ? ` · ${topN} 个目录` : "";
    let text = items.length ? `已选 ${n} / ${items.length}` : "";
    if (topNote) text += topNote;
    if (nSub) text += ` · ${nSub} 个已有字幕默认不勾选`;
    if (nSmall) text += ` · ${nSmall} 个过小未选`;
    $("folder-count").textContent = text;
    $("folder-chip-text").textContent = items.length ? `已选 ${n} / ${items.length}${topNote}` : "";
    // 「全选」只覆盖非「忽略」文件：too_small 只能手动勾选（与扫描表同口径）
    const selectable = items.filter((v) => !v.too_small).length;
    (document.getElementById("folder-select-all") as HTMLInputElement).checked =
      selectable > 0 && state.folderChecked.size === selectable;
  }

  (document.getElementById("folder-select-all") as HTMLInputElement).onchange = (ev) => {
    const checked = (ev.target as HTMLInputElement).checked;
    const items = state.folderFiles || [];
    state.folderChecked = checked
      ? new Set(items.filter((v) => !v.too_small).map(folderKey))
      : new Set<string>();
    $("folder-table").querySelectorAll("input[type=checkbox]")
      .forEach((cb) => {
        const input = cb as HTMLInputElement;
        if (input.id === "folder-page-all") return; // 0.2.53 需求②：表头框由 renderFolderTable 回写
        input.checked = state.folderChecked.has(input.dataset.key || "");
      });
    updateFolderSummary();
    syncFolderPageAll(); // 0.2.53 需求②：不重渲染路径也要重派生表头框
  };

  pickFolder.onclick = async (ev) => {
    ev.stopPropagation();
    const r = await platform.pickVideoFolder(); // 0.2.53 需求①：批次在跑可选文件夹
    if (r === "fallback") { folderInput.click(); return; }
    if (r) setFolder(r);
  };
  folderInput.onchange = (ev) => {
    const files = (ev.target as HTMLInputElement).files;
    const items: FolderFile[] = files ? [...files] as FolderFile[] : [];
    // 桌面端 webkitdirectory 回退：File 无 _localPath → 经 bridge 解析绝对路径挂上，
    // 完成写回落源目录（web 形态无 bridge 保持现状：自动下载；合成文件返回 "" 不挂）
    const dp = (window as unknown as { javDesktop?: { filePath?: (f: File) => string } }).javDesktop;
    if (dp && typeof dp.filePath === "function") {
      for (const f of items) {
        try {
          const p2 = dp.filePath(f);
          if (p2) f._localPath = p2;
        } catch { /* 无磁盘路径的合成 File：保持自动下载兜底 */ }
      }
    }
    setFolder(items);
  };
  folderX.onclick = () => { if (!state.busy) clearFolder(); };

  dispatchGo.onclick = () => {
    const engine = engineSelect.value;
    if (!engine) return; // 0.2.53 需求①：批次在跑可提交（单文件重复提交由 fileDispatching 挡）
    if (state.folderFiles) { startBatch(engine); return; }
    if (!state.file) return;
    startSingle(engine);
  };

  function preparePipeline(label?: string) {
    $("pipeline").hidden = false;
    setStep("step-upload", "active", "1", label || "开始上传…");
    setStep("step-extract", "", "2", "");
    setStep("step-dispatch", "", "3", "");
    line1.classList.remove("on");
    line2.classList.remove("on");
    setFill("0", true);
  }

  type DispatchOutcome = [boolean, UploadStatus | { error: string }];

  // ---------- S4：per-service 在途封顶（queue_cap）记账 + 泵 ----------
  // 在途窗 = 派发链启动 → 任务终态（done/skipped/error/canceled）：
  //   chainInFlight : 派发链（提取→上传→提交）进行中，链结算即减（提交成败都结算）
  //   pendingJobIds : 已提交但任务表行尚未可见（≤5s 桥接窗，refresh 见行即移入行计数）
  //   行计数        : 任务表有 job_id + 本机归属 + 非终态（countInFlightRows；本机管线行
  //                   无 job_id 由链记账覆盖，防双算）
  // 三者相加 = inFlightOf(engine)；任一记账到终态/行可见即释槽，pumpDispatch 为重触发入口。
  const chainInFlight = new Map<string, number>();
  const pendingJobIds = new Map<string, Set<string>>();
  // 主任务「暂停」本地冻结集：链层提取池入口闸在此等待放行（不占池槽，防阻塞他批次）
  const pausedBatches = new Set<string>();
  // 行优先批次操作登记：batch_id -> { 取消整批未开始子行 / 单行取消后续发 / 暂停冻结 / 继续放行 }
  const batchQueues = new Map<string, { cancel: () => number; onRowCancel: () => void; pause: () => void; resume: () => void }>();
  const pumpSlots = new Set<() => void>(); // 泵重触发槽（文件夹批量/扫描实时队列各占一槽；触发源=refresh 5s/链结算/设置保存）
  // 0.2.53 需求③：主任务级本机提取并发（预算）——池上限读者 = 客户端设置基线 + Σ 活跃主任务预算；
  // 各批泵入口闸把「该批」池内在途限制在自己预算内（单文件/监听 = __single__，预算 = 注册时刻 ccfg 现值）。
  // 批次收尾注销 → 读者即回落基线（setExtractLimit 内含 wake）；inFlight 计数只圈本机提取链
  //（extractLocal 同步段 +1、Promise .finally -1 并 pumpDispatch 重驱），不改池结构与任务结果。
  const SINGLE_EXTRACT_KEY = "__single__";
  const batchExtractBudgets = new Map<string, number>(); // batchId → 本机提取预算（注册 = 泵活跃）
  const batchExtractInFlight = new Map<string, number>(); // batchId → extractLocal 池内链计数
  function parseExtractWorkers(value: string): number | undefined {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 8 ? n : undefined;
  }
  function extractBudgetDefault(): number {
    return state.ccfg?.extract_workers ?? CLIENT_CFG_DEFAULTS.extract_workers;
  }
  // 池上限读者（定义一次存常量）：闭包实时读 state.ccfg，设置变更自动生效；
  // 批次注册/注销变化后重注入（setExtractLimit 内部 = setLimitReader + wake）。
  const extractLimitReader = (): number =>
    extractBudgetDefault() + [...batchExtractBudgets.values()].reduce((a, b) => a + b, 0);
  function injectExtractLimit(): void {
    jav()?.setExtractLimit?.(extractLimitReader);
  }
  function registerExtractBudget(b: { id: string; extractWorkers?: number }): void {
    batchExtractBudgets.set(b.id, b.extractWorkers ?? extractBudgetDefault());
    injectExtractLimit();
  }
  function unregisterExtractBudget(id: string): void {
    if (batchExtractBudgets.delete(id)) injectExtractLimit();
    batchExtractInFlight.delete(id);
  }
  const extractBudgetOf = (b: { id: string }): number =>
    batchExtractBudgets.get(b.id) ?? extractBudgetDefault();
  const extractInFlightOf = (id: string): number => batchExtractInFlight.get(id) || 0;
  let singleQueuedFile: File | null = null;       // 等 cap 槽位的单文件（文件变更/重新派发即失效，身份匹配防误发）
  // 0.2.52 M1：按盘拆组 → 一次提交可起多个 runDispatchQueue/runScanQueue（每组一泵）；
  // busy 改引用计数：首个组进入置位、末个组退出复位（单组 = 与现状逐拍一致）。
  let activeSubmitQueues = 0;
  function enterSubmitQueue(): void {
    activeSubmitQueues++;
    if (activeSubmitQueues === 1) { state.busy = true; updateGo(); }
  }
  function exitSubmitQueue(): void {
    activeSubmitQueues = Math.max(0, activeSubmitQueues - 1);
    if (activeSubmitQueues === 0) { state.busy = false; updateGo(); }
  }

  function inFlightOf(engine: string): number {
    let n = chainInFlight.get(engine) || 0;
    const pj = pendingJobIds.get(engine);
    if (pj) n += pj.size;
    n += countInFlightRows(state._jobs, engine);
    return n;
  }

  function queueCapNow(): number {
    return state.ccfg?.queue_cap ?? CLIENT_CFG_DEFAULTS.queue_cap;
  }

  /** auto 均衡空闲显存阈值（GB）：客户端设置值（0 = 不过滤），脏值/缺省回落内置缺省（core MIN_FREE_VRAM_GB 口径） */
  function vramFreeMinGbNow(): number {
    const v = state.ccfg?.vram_free_min_gb;
    return typeof v === "number" && Number.isFinite(v) && v >= 0
      ? v
      : CLIENT_CFG_DEFAULTS.vram_free_min_gb;
  }

  /** 0.2.48：auto 均衡显存阈值剔除提示文案（纯判定；与 pickAutoEngine 过滤口径一致：
   *  在线 + 参与均衡 + 阈值>0 + 有采样 + 空闲<阈值 → 才提示；无采样/阈值 0 → 不提示） */
  function engExclText(e: Engine): string {
    if (!e.online || e.enabled === false) return "";
    const thr = vramFreeMinGbNow();
    if (thr <= 0) return "";
    const m = state._metrics[e.name];
    if (!m || !m.ok || !m.metrics) return "";
    const free = freeVramGb(m.metrics.gpu ?? null);
    if (!isVramExcluded(free, thr)) return "";
    return `未参与均衡：空闲显存 ${(free as number).toFixed(1)}G < 阈值 ${thr}G（设置可调）`;
  }

  function updateEngExclHint(card: HTMLElement, e: Engine) {
    const box = card.querySelector<HTMLElement>(".eng-excl");
    if (!box) return;
    const txt = engExclText(e);
    if (txt) {
      if (box.hidden) box.hidden = false;
      if (box.textContent !== txt) box.textContent = txt;
    } else if (!box.hidden) {
      box.hidden = true;
    }
  }

  /** auto 派发时刻解析（显存感知，10-13-javscribe-client-writeback-guard F3④；0.2.47 阈值客户端可调）：
   *  在线且参与均衡的服务里，先按最近 metrics 采样的空闲显存过滤（< 阈值不作候选；0 = 不过滤；
   *  无数据视为满足不过滤），再选在途最少者（平手注册序）；显存过滤后候选全空 → 回退在途最少
   *  保证不卡派发。无候选返 null。决策纯函数在 core/concurrency.pickAutoEngine（单测）。 */
  function resolveAutoEngine(): string | null {
    return pickAutoEngine(state.engines, {
      inFlight: inFlightOf,
      minFreeVramGb: vramFreeMinGbNow(),
      freeVramOf: (name) => {
        const m = state._metrics[name];
        if (!m || !m.ok || !m.metrics) return null;
        return freeVramGb(m.metrics.gpu ?? null);
      },
    });
  }

  function canDispatch(engine: string): boolean {
    return canStartInFlight({ engine, cap: queueCapNow(), inFlight: inFlightOf, engines: state.engines });
  }

  /** 带记账派发：链启动 +1 / 链结算 -1；提交成功带 job_id 进 pending（等行接管） */
  function dispatchTracked(f: File, engine: string, labelPrefix?: string, batch?: { id: string; label?: string }, sink?: ChainSink): Promise<DispatchOutcome> {
    chainInFlight.set(engine, (chainInFlight.get(engine) || 0) + 1);
    return dispatchOne(f, engine, labelPrefix, batch, sink).then(
      (d) => {
        chainInFlight.set(engine, (chainInFlight.get(engine) || 0) - 1);
        if (d[0]) {
          const up = d[1] as UploadStatus;
          if (up.job_id) {
            let st = pendingJobIds.get(engine);
            if (!st) { st = new Set<string>(); pendingJobIds.set(engine, st); }
            st.add(String(up.job_id));
          }
        }
        return d;
      },
      (e: unknown) => {
        chainInFlight.set(engine, (chainInFlight.get(engine) || 0) - 1);
        throw e;
      },
    );
  }

  /** refresh 见到 job_id 行 → 移出 pending（行接管在途计数；行到终态即释槽） */
  function reconcilePending(): void {
    const seen = new Set<string>();
    for (const r of state._jobs) if (r.job_id) seen.add(String(r.job_id));
    for (const [e, st] of [...pendingJobIds]) {
      for (const id of [...st]) if (seen.has(id)) st.delete(id);
      if (!st.size) pendingJobIds.delete(e);
    }
  }

  /** 泵重触发入口（refresh / 链结算 / 设置保存均调）：只释放排队项，不产生新任务 */
  function pumpDispatch(): void {
    for (const fn of [...pumpSlots]) fn();
    if (singleQueuedFile && state.file === singleQueuedFile && !state.folderFiles) { // 0.2.53 需求①：去 busy 门控，保留 canDispatch 封顶
      const engine = engineSelect.value;
      if (engine && canDispatch(engine)) startSingle(engine);
    }
  }

  function startSingle(engine: string) {
    const file = state.file;
    if (!file) { singleQueuedFile = null; return; }
    if (state.fileDispatching) return; // 0.2.53 需求①：单文件在途防二次提交（不挡文件夹/扫描并发）
    if (engine === "auto") {
      const real = resolveAutoEngine();
      if (!real) {
        // 全部离线/都未勾选参与均衡：等待也等不出服务，明确告知（不占排队标记）
        singleQueuedFile = null;
        showStatus("没有可用服务：全部离线，或都没有勾选「参与均衡」", "err");
        toast("没有可用服务：全部离线，或都没有勾选「参与均衡」", "err");
        return;
      }
      engine = real;
    }
    if (!canDispatch(engine)) {
      // 在途封顶（queue_cap）：不阻塞 UI，等 cap 槽位释放 → pumpDispatch 重触发（≤5s 轮询安全网）
      singleQueuedFile = file;
      showStatus(`「${engine}」在途任务已达上限（${queueCapNow()}），排队等待空位`, "");
      return;
    }
    singleQueuedFile = null; // 显式派发（含泵触发）：排队标记作废
    state.fileDispatching = true; // 0.2.53 需求①：单文件在途标记
    enterSubmitQueue(); // 0.2.53 需求①：引用计数 busy（与批次泵并存，全部退出才复位）
    registerExtractBudget({ id: SINGLE_EXTRACT_KEY }); // 0.2.53 需求③：单文件预算 = ccfg 现值（派发口径）
    localStorage.setItem("javweb_engine", engine);
    preparePipeline();
    // 预登记：上传请求发出前先持久化登记（job 受理后 ok 分支 rekey 正式键）
    registerWriteBack(preKeyOf(engine, file.name), {
      engine, videoName: file.name, dirHandle: state._fsFileDir || null,
      videoPath: (file as FolderFile)._localPath || null,
    });
    dispatchTracked(file, engine).then(([ok, d]) => {
      if (ok) {
        const up = d as UploadStatus;
        rekeyWriteBack(preKeyOf(engine, file.name), engine + "|" + up.job_id);
        registerWriteBack(engine + "|" + up.job_id, {
          engine, videoName: file.name, dirHandle: state._fsFileDir || null,
          videoPath: (file as FolderFile)._localPath || null,
        });
        showStatus(`已提交到「${engine}」· ${up.name} → 任务 ${up.job_id}`, "ok");
        toast(`已提交到「${engine}」· ${up.name} → 任务 ${up.job_id}`, "ok");
        webShowView("jobs"); // 提交即进任务看板
        finishDispatch(true, file);
        refresh();
      } else {
        const msg = (d as { error?: string }).error || "上传失败";
        showStatus(`${file.name}：${msg}`, "err");
        toast(`${file.name}：${msg}`, "err");
        finishDispatch(false, file);
      }
    });
  }

  // S4：泵驱动并发派发（基线为串行 for-await；在途封顶下各链并行推进至 cap）。
  // 完成 = 全部链 settled（提交或失败），不等任务终态（终态由任务表记账并释 cap 槽）。
  // 公共泵：文件夹批量 / 扫描 400 回退共用（差异只在 finishNote 文案与 afterDone 收尾）。
  // 行优先（10-10-javscribe-dispatch-row-first）：桌面端多文件批量提交即建主任务 + N 条
  // pending 子行，链各阶段进度写进对应子行，派发页只留一条状态行并自动切任务看板。
  // 范围线：单文件派发（startSingle / watch 派发）与 web 形态批量仍走派发页 pipeline。
  function runDispatchQueue(
    queue: FolderFile[],
    engine: string,
    batch: { id: string; label: string; extractWorkers?: number },
    finishNote: (okN: number, total: number, canceledN: number) => string,
    afterDone: (okN: number) => void,
  ): void {
    enterSubmitQueue(); // 0.2.52 M1：多组提交引用计数 busy（首个组进入置位）
    registerExtractBudget(batch); // 0.2.53 需求③：主任务本机提取预算（池上限上浮 base + N）
    localStorage.setItem("javweb_engine", engine);
    const total = queue.length;
    const rowFirst = platform.kind === "desktop";
    const pend = rowFirst ? createPendingRows(batch, queue, engine) : [];
    let okN = 0, started = 0, settled = 0, done = false, cancelRequested = false, queuePaused = false;
    // settled 去重：整批取消标记的项与链结算的项可能重叠（在跑链跑完也只算一次）
    const counted = new Set<number>();
    const settle = (i: number): void => { if (!counted.has(i)) { counted.add(i); settled++; } };
    const finish = (): void => {
      if (done) return;
      done = true;
      pumpSlots.delete(startNext);
      batchQueues.delete(batch.id);
      pausedBatches.delete(batch.id); // 0.2.53 coord 修复：恢复基线清理（暂停后收尾的批次不残留）
      unregisterExtractBudget(batch.id); // 0.2.53 需求③：预算注销，池上限回落基线
      const canceledN = rowFirst
        ? pend.filter((p) => p.row.status === "canceled" || p.row.status === "skipped").length : 0;
      showStatus(finishNote(okN, total, canceledN), okN ? "ok" : "err");
      afterDone(okN);
      refresh();
      exitSubmitQueue(); // 0.2.52 M1：引用计数退出（末个组退出才复位 busy）
      // 行优先：提交时已切过一次任务看板，收尾不再抢视——用户可能已回派发页
      // 继续提交下一批（web 形态维持原行为）
      if (okN > 0 && !rowFirst) webShowView("jobs"); // web：批量完成进任务看板
    };
    const startNext = (): void => {
      if (done || cancelRequested || queuePaused) return;
      while (started < total) {
        // 行优先：已取消的子行直接跳过（不提交服务、不占 cap 槽）
        if (rowFirst && pend[started].row.status === "canceled") { settle(started); started++; continue; }
        // 0.2.53 需求③：主任务本机提取预算已满 → 本轮不派发（不消费索引，下次泵重驱重判）；
        // 提取链 .finally 计数归零即 pumpDispatch 重驱；server 模式 / 非 local 项不受闸影响
        if (effectiveMode(queue[started]) === "local" && extractInFlightOf(batch.id) >= extractBudgetOf(batch)) break;
        // auto：canDispatch("auto")=任一在线+参与均衡有空位；再解析出最闲者落具体服务
        let realName: string | null = engine;
        if (engine === "auto") {
          if (!canDispatch("auto")) break; // 全满/全离线：等泵重触发
          realName = resolveAutoEngine();
          if (!realName) break; // 理论不可达（canDispatch 真即有候选），双保险
        } else if (!canDispatch(engine)) {
          break; // 封顶：等 refresh / 链结算 / 设置保存重触发
        }
        const real = realName; // 收窄为 string（闭包内使用需 const）
        const idx = started++;
        const file = queue[idx];
        // 预登记：子行已建、即将提交 → 临时键先持久化（受理后 rekey 正式键）
        registerWriteBack(preKeyOf(real, file.name), {
          engine: real, videoName: file.name, dirHandle: file._dirHandle || null,
          videoPath: file._localPath || null,
        });
        if (rowFirst) {
          pend[idx].dispatched = true; // 取消/暂停记账：链已派发（含随后进提取池等槽）
          pend[idx].row.engine = real; // auto 解析出的真实服务回填子行
          ledgerSyncPending(pend[idx]);
        }
        const prefix = rowFirst ? "" : `文件 ${idx + 1}/${total} · `;
        const sink: ChainSink | undefined = rowFirst ? rowSink(pend[idx]) : undefined;
        if (!rowFirst) preparePipeline(prefix + (effectiveMode(file) === "local" ? "开始本地提取…" : "开始上传…"));
        void (async () => {
          let ok = false;
          let d: UploadStatus | { error: string } = { error: "" };
          try { [ok, d] = await dispatchTracked(file, real, prefix, batch, sink); } catch (_e) { ok = false; }
          if (ok) {
            okN++;
            const up = d as UploadStatus;
            if (up.job_id) {
              rekeyWriteBack(preKeyOf(real, file.name), real + "|" + up.job_id);
              registerWriteBack(real + "|" + up.job_id, {
                engine: real, videoName: file.name, dirHandle: file._dirHandle || null,
                videoPath: file._localPath || null,
              });
            }
          } else if (rowFirst) {
            // 链外抛错 / 未走到阶段回调：失败信息留在子行上（serve 不会出现该行）
            markPendingFail(pend[idx], String((d as { error?: string }).error || "派发失败"));
          }
          settle(idx);
          startNext(); // 链结算后立即试下一项
          if (settled === total) finish();
        })();
      }
    };
    // 批次取消登记（任务看板主任务行「取消」/ 子行「取消」走这里）。
    // 行优先取消语义：未开始的子行 → 取消；已在跑的链 → 打中止标记，跑完当前阶段
    // 也不提交服务（由 rowSink.abort 标「跳过」）；已拿到 job_id 的子行交服务侧处理。
    const cancel = (): number => {
      if (!rowFirst) return 0; // web / 非行优先：取消走 serve 侧 batchOp，本端无 pending 账本
      cancelRequested = true;
      // 未开始（含池等槽）→「已取消」；已派发未入队 → 中止标记（跑完当前阶段不提交服务）。
      // cancelPendingRow 内部覆盖 dispatched 语义；返回 true 的行本端已收口，即 settle。
      for (let i = 0; i < total; i++) {
        if (counted.has(i)) continue;
        cancelPendingRow(pend[i]);
        // 仅已落「已取消」终态的行在此收口；在跑行（已打中止标记）仍要等链结算
        // 标「已跳过」后才 settle（dispatch 结算处统一收口）——提前 settle 会让
        // finish 提前触发，汇总文案漏计在跑行，且 batchQueues 提前摘除
        if (pend[i].row.status === "canceled") settle(i);
      }
      if (settled >= total) finish();
      schedulePendingRender();
      return pend.filter((p) => p.row.status === "canceled" || p.row.status === "skipped").length;
    };
    const onRowCancel = (): void => {
      if (done) return;
      for (let i = started; i < total; i++) if (pend[i].row.status === "canceled") settle(i);
      startNext();
      if (settled === total) finish();
    };
    // 主任务「暂停/继续」（本端）：冻结派发队列 + 未开始子行标「已暂停」；
    // 已开跑的链（提取/上传/提交中）不中断——跑完当前阶段（与按钮语义一致）
    const pause = (): void => {
      if (!rowFirst) return;
      queuePaused = true;
      pausedBatches.add(batch.id);
      // 全量遍历：未派发行 startNext 冻结 + 已派发池等槽行 out-dequeue 被 holdWhilePaused 冻结
      for (let i = 0; i < total; i++) {
        const p = pend[i];
        const r = p.row;
        if (p.started || r.job_id || TERMINAL_LIKE.has(r.status) || r.status === "paused") continue;
        r._prevStatus = r.status;
        r.status = "paused";
        r.position = "已暂停（主任务暂停）";
        r.phase_detail = "已暂停（主任务暂停）";
        r.message = "主任务已暂停：提取上传冻结，点「继续」恢复";
      }
      schedulePendingRender();
    };
    const resume = (): void => {
      if (!rowFirst) return;
      queuePaused = false;
      pausedBatches.delete(batch.id);
      for (let i = 0; i < total; i++) {
        const r = pend[i].row;
        if (r.status !== "paused") continue;
        r.status = r._prevStatus || "pending";
        r.position = PENDING_TEXT.queued[0];
        r.phase_detail = PENDING_TEXT.queued[0];
        r.message = PENDING_TEXT.queued[1];
        delete r._prevStatus;
      }
      schedulePendingRender();
      startNext(); // 放行：立即补位至封顶
    };
    if (rowFirst) batchQueues.set(batch.id, { cancel, onRowCancel, pause, resume });
    if (rowFirst && total > 0) {
      // 派发页收掉流程节点，只留一条状态行；提交即进任务看板看进度
      resetPipeline();
      showStatus(`已创建主任务 ${batch.label}：${total} 子任务，后台提取上传中，进度见字幕任务`, "");
      webShowView("jobs");
      renderJobs(state._jobs);
    } else if (total > 0) preparePipeline(`文件 1/${total}`); // 空队列不亮管线
    startNext();
    if (started < total && !cancelRequested) pumpSlots.add(startNext); // 封顶等待：泵重触发
    if (settled === total) finish(); // 空队列
  }

  function startBatch(engine: string) {
    // 待选表：只提交勾选的项（旧「全有字幕自动跳过」改由表内勾选表达）
    const checked = (state.folderFiles || [])
      .filter((v) => state.folderChecked.has(folderKey(v)));
    singleQueuedFile = null; // 文件夹批量接管单发排队（批量结束后按当前文件由泵重判）
    if (!checked.length) return;
    // 0.2.53 需求①：消费勾选前先取现状 label 口径——消费后 state.folderFiles 可能为空，
    // 单组兜底再调 batchLabelForFolder() 会落「文件夹」
    const singleLabel = batchLabelForFolder();
    // 0.2.53 需求①：发送时刻消费已勾选项（泵闭包已持 queue 拷贝不受影响）；
    // 未勾选剩余留表可再勾再发，支持「批次运行中继续建主任务」
    const consumed = new Set(checked.map(folderKey));
    state.folderFiles = (state.folderFiles || []).filter((v) => !consumed.has(folderKey(v)));
    for (const k of consumed) state.folderChecked.delete(k);
    if (!state.folderFiles.length) {
      // 全部消费：收口文件夹 UI（单文件槽不动；批次收尾按代际决定清否）
      state.folderFiles = null;
      $("folder-chip").hidden = true;
      $("folder-pending").hidden = true;
    }
    renderFolderTable();
    updateFolderSummary();
    updateGo(); // 消费后即时刷新按钮态（剩余 0 勾选 → 开始生成禁用，重复点击天然 no-op）
    const queue = checked.map((v) => v.file);
    const gen = state.folderGen; // 捕获代际：批次收尾比对代际决定是否清文件夹 UI（防误清中途新选）
    // 0.2.52 M1：按盘拆 batch——按 diskKeyOf(_localPath) 分组，每组独立 batch + 各自泵；
    // 单组（web 形态无 _localPath 全空键 / 单目录选择）label 维持现状口径，零噪音。
    const groups = groupByDisk(
      queue,
      (f) => diskKeyOf(f._localPath || ""),
      folderFileDirName,
    );
    const multi = groups.length > 1;
    // 0.2.53 需求③：本主任务本机提音轨并发（空/非法 = 跟随客户端设置，不写入 batch）
    const batchExtractWorkers = parseExtractWorkers(($("batch-extract-workers") as HTMLInputElement).value);
    groups.forEach((g, gi) => {
      const batch = { id: genBatchId(), label: folderGroupLabel(g, multi, singleLabel), extractWorkers: batchExtractWorkers };
      runDispatchQueue(
        g.items,
        engine,
        batch,
        (okN, total, canceledN) => canceledN > 0
          ? `批量已取消：已提交 ${okN}/${total} 项，${canceledN} 项已取消（未提交服务）`
          : okN === total
          ? `批量完成：已提交 ${okN}/${total} 项，见「字幕任务」`
          : `批量完成：成功 ${okN}/${total} 项，其余失败（可重新选择文件夹）`,
        // 末组收尾清文件夹 UI（busy 由泵引用计数收口）；非末组空收尾；代际决定清否
        gi === groups.length - 1 ? () => finishBatch(gen) : () => {},
      );
    });
  }

  // 清扫描 UI（三处统一入口：400 回退 / auto 提交 / scanSubmit 成功路径）
  function clearScanUi(): void {
    state.scanItems = [];
    state.scanDoneIndex = new Map();
    state.scanChecked = new Set();
    state.lastScan = null;
    state.scanPage = 0;
    state.scanFilter = "all";
    $("scan-pager").hidden = true;
    $("scan-results").hidden = true;
    setScanSubmitHidden(true);
    $("scan-table").innerHTML = "";
  }

  // F3（10-18-javscribe-client-realmachine-round2）：单文件单 job 提交（serve /scan/submit）。
  // 写回登记逐文件成立（registerWriteBack 带 videoPath → desktop 进强制写回集，完成后写回影片旁）：
  // 成功先登 pre 键、job 受理再 rekey 正式键；400 not-found=服务确未受理，删 pre 登记防残留；
  // 网络错误=响应丢失、服务可能已受理，保留 pre 登记由 bindPreRegistrations 后续补 rekey。
  type ScanFileResult =
    | { kind: "ok"; jobId: string; okFiles: number; skipped: string[] }
    | { kind: "not-found" }
    | { kind: "error"; message: string };
  async function submitScanFile(
    engine: string,
    path: string,
    batch?: { id: string; label: string },
    subStatus?: Record<string, string>,
  ): Promise<ScanFileResult> {
    const name = path.split(/[\\/]/).pop() || path;
    const preKey = preKeyOf(engine, name);
    registerWriteBack(preKey, { engine, videoName: name, dirHandle: null, videoPath: path });
    try {
      const d = await t.submitScan(engine, [path], subStatus && subStatus[path] ? { [path]: subStatus[path] } : undefined, batch);
      const jobId = d.jobId || "";
      if (jobId) {
        rekeyWriteBack(preKey, engine + "|" + jobId);
        registerWriteBack(engine + "|" + jobId, { engine, videoName: name, dirHandle: null, videoPath: path });
      }
      return { kind: "ok", jobId, okFiles: d.files || 0, skipped: d.skipped || [] };
    } catch (e) {
      if (e instanceof TransportError && e.code === "not-found") {
        // 服务确未受理 → 删 pre 登记防残留
        state.writeBackJobs.delete(preKey);
        state.watchWriteBack.delete(preKey);
        wbAt.delete(preKey);
        saveWriteBackStore();
        return { kind: "not-found" };
      }
      // 响应丢失、服务可能已受理 → 保留 pre 登记
      return { kind: "error", message: (e as Error).message };
    }
  }

  // 「扫描目录」400 回退：所选服务读不到本机路径（浏览器电脑的盘符路径）→ 本机提取后上传
  function dispatchLocalScanPaths(engine: string, files: string[], batch: { id: string; label: string; extractWorkers?: number },
    meta?: Map<string, { name: string; size: number }>,
  ) {
    const queue: FolderFile[] = files.map((p) => {
      // 0.2.52 M1：多组提交时第二组起 state.scanItems 已被首组 clearScanUi 清空 →
      // 调用方预捕获的 name/size 优先（size 缺失会误导 effectiveMode 判 local）
      const m = meta?.get(p);
      const it = m ? undefined : state.scanItems.find((i) => i.path === p);
      const f = new File([new Blob()], m ? m.name : (it ? it.name : p.split(/[\\/]/).pop() || p)) as FolderFile;
      if (m || it) Object.defineProperty(f, "size", { value: m ? m.size : it!.size, configurable: true });
      f._localPath = p;
      return f;
    });
    // 清扫描 UI（回退后任务由任务看板跟踪）
    clearScanUi();
    runDispatchQueue(
      queue,
      engine,
      batch,
      (okN, total, canceledN) => canceledN > 0
        ? `回退已取消：已提交 ${okN}/${total} 项，${canceledN} 项已取消（未提交服务）`
        : okN === total
        ? `回退完成：本机提取上传已提交 ${okN}/${total} 项，见「字幕任务」`
        : `回退完成：成功 ${okN}/${total} 项，其余失败`,
      () => {
        watchPump(); // 0.2.52 M1：busy 由泵引用计数收口（exitSubmitQueue），不再在此复位
      },
    );
  }

  // 扫描路径 → 本地 File（400 回退本机提取链读 _localPath；与 dispatchLocalScanPaths 构造同款）
  function scanPathToFile(name: string, size: number, path: string): FolderFile {
    const f = new File([new Blob()], name) as FolderFile;
    if (Number.isFinite(size) && size >= 0) Object.defineProperty(f, "size", { value: size, configurable: true });
    f._localPath = path;
    return f;
  }

  // 「扫描目录」auto 候选（实时派发，10-18-javscribe-0246）：在线 + 参与均衡 + 已登记 API Key；
  // exclude = 已对该文件 400（读不到路径）的服务；显存过滤 / 在途最少选取在 pickAutoEngine 内
  // （与 resolveAutoEngine 同口径，此处不重复）。
  function scanAutoCandidates(exclude: ReadonlySet<string>): Engine[] {
    return state.engines.filter((e) => e.online && e.enabled !== false && e.has_key && !exclude.has(e.name));
  }

  // B（10-18-javscribe-0246）：扫描批次实时选机派发——不再点击时刻静态摊分整批（distributeToEngines 退役），
  // 改中性待派队列 + 泵：每文件提交时刻 pickAutoEngine 实时选机（在途最少 + 显存感知），受 queue_cap
  // 闸（滴水）；400 not-found 排除该服务试下一候选，候选耗尽回退本机提取上传。desktop 双路径统一
  // （auto / 显式引擎）：主任务 + N 子行（行优先），可暂停/取消，服务列提交时刻回填。
  // F3/F4 红线不变：逐文件 job、pre 登记提交时点落盘、受理 rekey 正式键、网络错误保留 pre 登记
  // （响应丢失=服务可能已受理）；行优先账本复用 createPendingRows/cancelPendingRow/markPendingFail/rowSink。
  interface ScanQItem {
    path: string;
    name: string;
    file: FolderFile;            // 回退本机提取链用（读 _localPath）
    pend: PendingDispatch;       // 子行账本
    failedEngines: Set<string>;  // 已对该文件 400 的服务
    fallback: boolean;           // 候选耗尽 / 显式 400 → 本机提取上传
  }
  function runScanQueue(
    files: string[],
    engine: string,
    batch: { id: string; label: string },
    subStatus?: Record<string, string>,
    meta?: Map<string, { name: string; size: number }>,
  ): void {
    // auto 无可用服务（全离线 / 无 Key / 全退出均衡）：不建主任务（与 0.2.46 前同口径）
    if (engine === "auto" && !scanAutoCandidates(new Set<string>()).length) {
      toast("自动均衡没有可用服务：全部离线，或都没有勾选「参与均衡」", "err");
      return;
    }
    enterSubmitQueue(); // 0.2.52 M1：多组提交引用计数 busy（首个组进入置位）
    registerExtractBudget(batch); // 0.2.53 需求③：主任务本机提取预算（池上限上浮 base + N）
    localStorage.setItem("javweb_engine", engine);
    // 清扫描 UI 前捕获 name/size（clearScanUi 后 state.scanItems 为空，回退时不能再查）；
    // 0.2.52 M1：多组提交时第二组起 state.scanItems 已被首组清空 → 调用方预捕获的 meta 优先
    const queueFiles: FolderFile[] = files.map((p) => {
      const m = meta?.get(p);
      const it = m ? undefined : state.scanItems.find((i) => i.path === p);
      const name = m ? m.name : (it ? it.name : p.split(/[\\/]/).pop() || p);
      return scanPathToFile(name, m ? m.size : (it ? it.size : 0), p);
    });
    const total = queueFiles.length;
    const pend = createPendingRows(batch, queueFiles, engine);
    const items: ScanQItem[] = queueFiles.map((f, idx) => ({
      path: files[idx],
      name: f.name,
      file: f,
      pend: pend[idx],
      failedEngines: new Set<string>(),
      fallback: false,
    }));
    let okN = 0, skippedN = 0, started = 0, settled = 0, done = false, pumping = false;
    let cancelRequested = false, queuePaused = false;
    const usedEngines = new Set<string>();
    const errors: string[] = [];
    // settled 去重：整批取消标记的项与链结算的项可能重叠（在跑链跑完也只算一次）
    const counted = new Set<number>();
    const settle = (i: number): void => { if (!counted.has(i)) { counted.add(i); settled++; } };
    const markFallback = (i: ScanQItem, reason: string): void => {
      i.fallback = true;
      const r = i.pend.row;
      if (TERMINAL_LIKE.has(r.status)) return;
      r.position = "转本机提取上传";
      r.phase_detail = "转本机提取上传";
      r.message = reason;
      schedulePendingRender();
    };
    const finish = (): void => {
      if (done) return;
      done = true;
      pumpSlots.delete(startNext);
      batchQueues.delete(batch.id);
      pausedBatches.delete(batch.id); // 0.2.53 coord 修复：恢复基线清理（暂停后收尾的批次不残留）
      unregisterExtractBudget(batch.id); // 0.2.53 需求③：预算注销，池上限回落基线
      const canceledN = pend.filter((p) => p.row.status === "canceled" || p.row.status === "skipped").length;
      const fallbackN = items.filter((i) => i.fallback).length;
      const notes: string[] = [];
      if (okN > 0) notes.push(engine === "auto"
        ? `已入队 ${okN} 项（自动均衡：派发时刻实时选机${usedEngines.size ? `，摊给 ${usedEngines.size} 台服务` : ""}）`
        : `已入队 ${okN} 项（本机扫描）→ 「${engine}」按空位派发`);
      if (fallbackN) notes.push(`${fallbackN} 项转本机提取后上传`);
      if (skippedN) notes.push(`跳过 ${skippedN} 个在跑/排队的重复任务`);
      if (canceledN) notes.push(`${canceledN} 项已取消（未提交服务）`);
      notes.push(...errors);
      toast(notes.length ? notes.join("；") : "无已入队项", okN > 0 ? "ok" : "err");
      exitSubmitQueue(); // 0.2.52 M1：引用计数退出（替换原 busy 复位；单组行为一致）
      watchPump();
      refresh();
      webShowView("jobs");
    };
    const startNext = (): void => {
      if (done || cancelRequested || queuePaused || pumping) return;
      pumping = true;
      void (async () => {
        try {
          while (started < total && !done && !cancelRequested && !queuePaused) {
            const it = items[started];
            const r = it.pend.row;
            // 行优先：已取消的子行直接跳过（不提交服务、不占 cap 槽）
            if (r.status === "canceled") { settle(started); started++; continue; }
            // 0.2.53 需求③：同 runDispatchQueue（回退项也走本机提取链，统一受批预算闸）
            if (effectiveMode(it.file) === "local" && extractInFlightOf(batch.id) >= extractBudgetOf(batch)) break;
            // —— 回退项：本机提取上传（与 runDispatchQueue 的 auto/显式分支同口径）——
            if (it.fallback) {
              let fbName: string | null = engine;
              if (engine === "auto") {
                if (!canDispatch("auto")) break; // 全满 / 全离线：等泵重触发
                fbName = resolveAutoEngine();
                if (!fbName) break; // 理论不可达，双保险
              } else if (!canDispatch(engine)) {
                break; // 封顶：等 refresh / 链结算 / 设置保存重触发
              }
              const real = fbName;
              const idx = started++;
              r.engine = real;
              it.pend.dispatched = true;
              ledgerSyncPending(it.pend);
              // 预登记：子行已建、即将提交 → 临时键先持久化（受理后 rekey 正式键）
              registerWriteBack(preKeyOf(real, it.name), {
                engine: real, videoName: it.name, dirHandle: null, videoPath: it.path,
              });
              void (async () => {
                let ok = false;
                let d: UploadStatus | { error: string } = { error: "" };
                try { [ok, d] = await dispatchTracked(it.file, real, "", batch, rowSink(it.pend)); } catch (_e) { ok = false; }
                if (ok) {
                  okN++;
                  usedEngines.add(real);
                  const up = d as UploadStatus;
                  if (up.job_id) {
                    rekeyWriteBack(preKeyOf(real, it.name), real + "|" + up.job_id);
                    registerWriteBack(real + "|" + up.job_id, {
                      engine: real, videoName: it.name, dirHandle: null, videoPath: it.path,
                    });
                  }
                } else {
                  markPendingFail(it.pend, String((d as { error?: string }).error || "派发失败"));
                }
                settle(idx);
                startNext();
                if (settled === total) finish();
              })();
              continue; // 链按 cap 并行推进，结算后继续
            }
            // —— 派发时刻选机（需要处理时才选，不预分配）——
            let realName: string | null = engine;
            if (engine === "auto") {
              const cands = scanAutoCandidates(it.failedEngines);
              if (!cands.length) {
                markFallback(it, "所有候选服务都读不到本机路径，转本机提取上传");
                continue; // 下轮循环进回退分支
              }
              realName = pickAutoEngine(cands, {
                inFlight: inFlightOf,
                minFreeVramGb: vramFreeMinGbNow(),
                freeVramOf: (name) => {
                  const m = state._metrics[name];
                  if (!m || !m.ok || !m.metrics) return null;
                  return freeVramGb(m.metrics.gpu ?? null);
                },
              });
              if (!realName) break; // 理论不可达（cands 非空即有候选），双保险
              if (inFlightOf(realName) >= queueCapNow()) break; // 封顶：等泵重触发
            } else if (inFlightOf(engine) >= queueCapNow()) {
              break; // 封顶：等 refresh / 链结算 / 设置保存重触发
            }
            const real = realName;
            const idx = started++;
            r.engine = real; // 服务列提交时刻回填
            it.pend.dispatched = true;
            ledgerSyncPending(it.pend);
            // 提交 HTTP 计入在途（原先漏计；≤5s 行可见后由行接管，cap 更准）
            chainInFlight.set(real, (chainInFlight.get(real) || 0) + 1);
            const res = await submitScanFile(real, it.path, batch, subStatus);
            chainInFlight.set(real, (chainInFlight.get(real) || 0) - 1);
            if (res.kind === "ok") {
              okN += res.okFiles;
              skippedN += res.skipped.length;
              usedEngines.add(real);
              if (res.jobId) {
                // 记账：已提交但行未可见的 job 进 pending（reconcilePending 见行即接管）
                let st = pendingJobIds.get(real);
                if (!st) { st = new Set<string>(); pendingJobIds.set(real, st); }
                st.add(res.jobId);
                if (!TERMINAL_LIKE.has(r.status)) {
                  r.job_id = res.jobId;
                  r.phase = "enqueued";
                  r.status = "pending";
                  r.progress = 1;
                  r.position = "已入队";
                  r.phase_detail = "已入队";
                  r.message = `已入队，等待服务开始（任务 ${res.jobId}）`;
                  it.pend.enqueuedAt = Date.now() / 1000;
                  ledgerSyncPending(it.pend);
                  schedulePendingRender();
                }
              }
              settle(idx);
            } else if (res.kind === "not-found") {
              // 服务确未受理（读不到路径）→ 排除该服务试下一候选（候选数有界）；耗尽 → 本机回退。
              // 不 advance：下轮循环试下一候选（auto）或进回退分支（显式）
              it.failedEngines.add(real);
              if (engine === "auto" ? !scanAutoCandidates(it.failedEngines).length : true) {
                markFallback(it, engine === "auto"
                  ? "所有候选服务都读不到本机路径，转本机提取上传"
                  : "所选服务读不到本机路径，转本机提取上传");
              }
              started--; // 本项未结算：回退槽位，下轮循环重新处理（auto 试下一候选 / 显式进回退分支）
            } else {
              // 网络错误 = 响应丢失、服务可能已受理 → 不回退、保留 pre 登记；行记失败
              errors.push(`${real}: ${res.message}`);
              markPendingFail(it.pend, res.message);
              settle(idx);
            }
          }
          // 自然收口：全部提交/回退派发完毕 → finish（toast + busy 复位 + 批次登记摘除）。
          // 回退链尚在跑的项由链内 settle 后收口（finish 幂等），此处只兜 HTTP 提交路径。
          if (settled >= total) finish();
          if (started < total && !done && !cancelRequested && !queuePaused) pumpSlots.add(startNext);
        } finally {
          pumping = false;
        }
      })();
    };
    // 批次取消登记（任务看板主任务行「取消」/ 子行「取消」走这里）；语义对照 runDispatchQueue：
    // 未开始的子行 → 取消；已派发未入队 → 中止标记（跑完当前阶段不提交服务）；已拿到 job_id 交服务侧。
    const cancel = (): number => {
      cancelRequested = true;
      for (let i = 0; i < total; i++) {
        if (counted.has(i)) continue;
        cancelPendingRow(pend[i]);
        if (pend[i].row.status === "canceled") settle(i);
      }
      if (settled >= total) finish();
      schedulePendingRender();
      return pend.filter((p) => p.row.status === "canceled" || p.row.status === "skipped").length;
    };
    const onRowCancel = (): void => {
      if (done) return;
      for (let i = started; i < total; i++) if (pend[i].row.status === "canceled") settle(i);
      startNext();
      if (settled === total) finish();
    };
    // 主任务「暂停/继续」：冻结派发队列 + 未开始子行标「已暂停」；
    // 已开跑的链（提取/上传/提交中）不中断——跑完当前阶段（与按钮语义一致）
    const pause = (): void => {
      queuePaused = true;
      pausedBatches.add(batch.id);
      for (let i = 0; i < total; i++) {
        const p = pend[i];
        const rr = p.row;
        if (p.started || rr.job_id || TERMINAL_LIKE.has(rr.status) || rr.status === "paused") continue;
        rr._prevStatus = rr.status;
        rr.status = "paused";
        rr.position = "已暂停（主任务暂停）";
        rr.phase_detail = "已暂停（主任务暂停）";
        rr.message = "主任务已暂停：派发冻结，点「继续」恢复";
      }
      schedulePendingRender();
    };
    const resume = (): void => {
      queuePaused = false;
      pausedBatches.delete(batch.id);
      for (let i = 0; i < total; i++) {
        const rr = pend[i].row;
        if (rr.status !== "paused") continue;
        rr.status = rr._prevStatus || "pending";
        rr.position = PENDING_TEXT.queued[0];
        rr.phase_detail = PENDING_TEXT.queued[0];
        rr.message = PENDING_TEXT.queued[1];
        delete rr._prevStatus;
      }
      schedulePendingRender();
      startNext(); // 放行：立即补位至封顶
    };
    batchQueues.set(batch.id, { cancel, onRowCancel, pause, resume });
    // 派发页流程节点收掉，只留一条状态行；提交即进任务看板看进度
    clearScanUi();
    resetPipeline();
    showStatus(`已创建主任务 ${batch.label}：${total} 子任务，提交时刻实时选机派发，进度见「字幕任务」`, "");
    webShowView("jobs");
    renderJobs(state._jobs);
    startNext();
    if (settled === total) finish(); // 空队列
  }

  function finishBatch(gen?: number) {
    // 0.2.53 需求①：busy 由泵引用计数收口（exitSubmitQueue），不再在此直接复位；
    // 代际比对：期间用户重选/清除过文件夹则保留其 UI（防已完批误清新选文件夹）
    const stale = gen !== undefined && gen !== state.folderGen;
    if (!stale) {
      state.folderFiles = null;
      state.folderChecked = new Set();
      state.folderPage = 0;
      folderInput.value = "";
      $("folder-chip").hidden = true;
      $("folder-pending").hidden = true;
    }
    updateGo();
    watchPump();
  }

  // ---------- 音轨提取模式：auto（≤1.6GB 本地）/ local（仅本地）/ server（整片上传） ----------
  function effectiveMode(f: File): "local" | "server" {
    if (state.extractMode === "server") return "server";
    if (state.extractMode === "local") return "local";
    return jav() && jav()!.fits(f) ? "local" : "server";
  }

  function labelPipeline(mode: "local" | "server") {
    const names = mode === "local"
      ? ["本地提音轨", "上传音频", "提交生成"]
      : ["上传视频", "提取音频", "提交生成"];
    ["step-upload", "step-extract", "step-dispatch"].forEach((id, i) => {
      $(id).querySelector(".step-name")!.textContent = names[i];
    });
  }

  function extractLocal(f: File, prefix: string, sink?: ChainSink, batchId?: string): Promise<Blob | { skipped: true }> {
    // 0.2.53 需求③：主任务本机提取池内计数（单文件/监听 = __single__）；.finally 归零并
    // pumpDispatch 重驱（闸等待的批次立即补位，不等 5s refresh）
    const extractKey = batchId || SINGLE_EXTRACT_KEY;
    batchExtractInFlight.set(extractKey, (batchExtractInFlight.get(extractKey) || 0) + 1);
    const s = sink || pipelineSink();
    return new Promise<Blob | { skipped: true }>((resolve, reject) => {
      let t0: number | null = null;
      void (async () => {
        // 链层暂停闸（主任务暂停）：等待放行后才进提取池——不占池槽、不起 ffmpeg；
        // 等待期间被取消则立即收口（行落「跳过」）
        if (batchId) {
          while (pausedBatches.has(batchId) && !s.abort()) {
            await new Promise((r2) => setTimeout(r2, 500));
          }
          if (s.abort()) { reject(new Error("主任务已取消，未提交服务")); return; }
        }
        jav()!.extractAudio(f, {
          onProgress: (p) => {
            const now = Date.now() / 1000;
            if (t0 == null) t0 = now;
            let meta = prefix + (platform.kind === "desktop" ? "本机提取 · " : "浏览器本地提取 · ") + Math.round(p * 100) + "%";
            const el = now - t0;
            if (el > 5 && p > 0.01) meta += ` · 剩 ~${fmtDuration(el * (1 - p) / p)}`;
            s.stage(1, meta, p, (p * 100).toFixed(1) + "%");
          },
          // 池入队/拿到槽：状态与真实并发对齐（并发 3 = 3「提取中」+ N「排队中·前方 N」）
          onQueue: (a) => s.queue(1, prefix + `本机提取排队（前方 ${a}）`),
          onStart: () => s.stage(1, prefix + (platform.kind === "desktop"
            ? "本地提取音轨…" : "加载提取引擎（首次 ~30MB，有缓存）…"), 0),
          isAborted: () => s.abort(),
          // 池出队闸：主任务暂停期间等槽的链在此冻结（行显「已暂停」），「继续」或被取消后放行
          waitReady: batchId ? () => (s.holdWhilePaused ? s.holdWhilePaused() : Promise.resolve()) : undefined,
        }).then(resolve, reject);
      })();
    }).finally(() => {
      const n = (batchExtractInFlight.get(extractKey) || 1) - 1;
      if (n <= 0) batchExtractInFlight.delete(extractKey);
      else batchExtractInFlight.set(extractKey, n);
      pumpDispatch();
    });
  }

  function uploadAudioBlob(f: File, engine: string, blob: Blob, prefix: string, batch?: { id: string; label?: string }, sink?: ChainSink) {
    const s = sink || pipelineSink();
    return new Promise<[boolean, UploadStatus]>((resolve) => {
      t.uploadAudio(f, engine, blob, (loaded, total, pct) => {
        s.stage(2, `${prefix}上传音频 ${fmtSize(loaded)} / ${fmtSize(total)} · ${pct.toFixed(1)}%`, pct / 100, pct + "%");
      }, batch).then((d) => {
        if (d.ok) {
          // 提交前取消闸：上传完成后主任务已取消 → 服务侧不再建 job
          if (s.abort()) { resolve([false, { error: "主任务已取消，未提交服务" } as UploadStatus]); return; }
          s.stageDone(2, d.cached ? `${prefix}服务端已缓存，免上传` : `${prefix}音频 ${fmtSize(blob.size)} 已接收`);
          s.stage(3, "提交中…", 1, "100%");
          pollUpload(d.uploadId, engine, prefix, resolve, s);
        } else {
          s.fail(d.error, 2);
          resolve([false, { error: d.network ? "音频上传失败（网络错误）" : d.error } as UploadStatus]);
        }
      });
    });
  }

  // 整片上传（原路径）：视频 → 本服务 → 服务端提取 → 转发
  function serverUpload(f: File, engine: string, labelPrefix?: string, batch?: { id: string; label?: string }, sink?: ChainSink) {
    const s = sink || pipelineSink();
    const prefix = labelPrefix || "";
    return new Promise<DispatchOutcome>((resolve) => {
      t.uploadFile(f, engine, (loaded, total, pct) => {
        s.stage(1, `${prefix}${fmtSize(loaded)} / ${fmtSize(total)} · ${pct.toFixed(1)}%`, pct / 100, pct + "%");
      }, batch).then((d) => {
        if (d.ok) {
          // 提交前取消闸：整片上传完成后主任务已取消 → 服务侧不再提取提交
          if (s.abort()) { resolve([false, { error: "主任务已取消，未提交服务" }]); return; }
          s.stageDone(1, d.cached ? `${prefix}服务端已缓存，免上传` : `${prefix}${d.sizeMb} MB 已接收`);
          s.stage(2, "准备提取音频…", null);
          pollUpload(d.uploadId, engine, prefix, resolve, s);
        } else {
          s.fail(d.error, 1);
          resolve([false, { error: d.network ? "上传失败（网络错误）" : d.error }]);
        }
      });
    });
  }

  // 统一入口：按提取模式走 本地提音轨→传音频 或 整片上传
  function dispatchOne(f: File, engine: string, labelPrefix?: string, batch?: { id: string; label?: string }, sink?: ChainSink): Promise<DispatchOutcome> {
    const s = sink || pipelineSink();
    const prefix = labelPrefix || "";
    const mode = effectiveMode(f);
    const Jav = jav();
    if (mode === "server" && state.extractMode === "auto" && Jav
        && f.size > Jav.MAX_BYTES) {
      toast(`「${f.name}」超过 1.6GB，改为整片上传本服务`);
    }
    if (mode === "local") {
      s.mode("local");
      return extractLocal(f, prefix, s, batch?.id)
        .catch((e: unknown) => ({ error: e }))
        .then(async (r: Blob | { skipped: true } | { error: unknown }) => {
          if (r && "error" in r) {
            const err = r.error;
            // 取消即时生效（池入口闸 ExtractAbortError / 中止标记）：行落「跳过」，
            // 不进 fail 分支、不回退整片上传；s.abort() 必须实际执行（防 || 短路漏标）
            if (err instanceof ExtractAbortError) s.abort();
            if (s.abort()) return [false, { error: "主任务已取消，未提交服务" }];
            const msg = String((err as Error)?.message || err);
            if (state.extractMode === "local") {
              s.fail(prefix + msg, 1);
              return [false, { error: msg }];
            }
            if (s.abort()) return [false, { error: "主任务已取消，未提交服务" }];
            toast(`本地提取失败，改用整片上传（${msg}）`, "err");
            s.mode("server");
            return serverUpload(f, engine, prefix, batch, s);
          }
          if (!r || "skipped" in r) {
            if (state.extractMode === "local") {
              const msg = "文件超过 1.6GB，无法在浏览器本地提取";
              s.fail(prefix + msg, 1);
              return [false, { error: msg }];
            }
            if (s.abort()) return [false, { error: "主任务已取消，未提交服务" }];
            s.mode("server");
            return serverUpload(f, engine, prefix, batch, s);
          }
          s.stageDone(1, `${prefix}本地提取完成 · 音频 ${fmtSize(r.size)}`);
          // 主任务取消闸门：本机提取（或整片上传前的回退判定）跑完即止，不再提交服务
          if (s.abort()) return [false, { error: "主任务已取消，未提交服务" }];
          // 主任务暂停闸门：提取完成时仍在暂停 → 音频上传前冻结（行显「已暂停」），「继续」后放行
          if (batch?.id) {
            const hold = s.holdWhilePaused;
            if (hold) await hold();
          }
          if (s.abort()) return [false, { error: "主任务已取消，未提交服务" }];
          s.stage(2, prefix + "准备上传音频…", null);
          return uploadAudioBlob(f, engine, r, prefix, batch, s);
        });
    }
    if (s.abort()) return Promise.resolve<DispatchOutcome>([false, { error: "主任务已取消，未提交服务" }]);
    s.mode("server");
    return serverUpload(f, engine, prefix, batch, s);
  }

  function showStatus(text: string, cls: "ok" | "err" | "" = "") {
    const el = $("dispatch-status");
    el.hidden = false;
    el.className = "dispatch-status" + (cls ? " " + cls : "");
    el.textContent = text;
  }

  function finishDispatch(ok: boolean, file?: File) {
    // 0.2.53 需求①：单文件在途引用计数收口（与批次并存，全部退出才复位 busy）
    state.fileDispatching = false;
    exitSubmitQueue();
    unregisterExtractBudget(SINGLE_EXTRACT_KEY); // 0.2.53 需求③：单文件预算注销
    if (ok && (!file || state.file === file)) {
      // 用户中途未换文件才清单文件槽（防误清新选文件 UI）
      state.file = null;
      fileInput.value = "";
      $("file-chip").hidden = true;
      drop.classList.remove("has-file");
    }
    updateGo();
    watchPump();
  }

  function pollUpload(id: string, _engine: string, labelPrefix: string, onDone: (r: [boolean, UploadStatus]) => void, sink?: ChainSink) {
    const s = sink || pipelineSink();
    const prefix = labelPrefix || "";
    let extractT0: number | null = null;
    const timer = setInterval(async () => {
      let d: UploadStatus;
      try { d = await t.getUpload(id); } catch (_e) { return; }
      if (d.phase === "extracting") {
        if (extractT0 == null) extractT0 = Date.now() / 1000;
        let meta = `${prefix}提取音频中 · ${Math.round(d.progress * 100)}%`;
        const el = Date.now() / 1000 - extractT0;
        if (el > 5 && d.progress > 0.01) meta += ` · 剩 ~${fmtDuration(el * (1 - d.progress) / d.progress)}`;
        s.stage(2, meta, d.progress, (d.progress * 100).toFixed(1) + "%");
      } else if (d.phase === "dispatching") {
        s.stageDone(2, extractDoneMeta(d.audio_mb));
        s.stage(3, "提交中…", 1, "100%");
      } else if (d.phase === "done") {
        clearInterval(timer);
        s.done(`任务 ${d.job_id}`, { audioMb: d.audio_mb, jobId: d.job_id == null ? null : String(d.job_id) });
        if (d.cached && platform.kind === "web") toast("服务端已缓存该音轨，免上传", "ok");
        onDone([true, d]);
      } else if (d.phase === "error") {
        clearInterval(timer);
        s.fail(d.error || "失败", d.job_id ? 3 : 2, { audioMb: d.audio_mb });
        onDone([false, d]);
      }
    }, 1000);
  }


  // ---------- 音轨提取模式（默认 auto，记忆选择） ----------
  extractSelect.value = state.extractMode;
  extractSelect.onchange = (ev) => {
    state.extractMode = (ev.target as HTMLSelectElement).value as "auto" | "local" | "server";
    localStorage.setItem("javweb_extract", state.extractMode);
  };

  // ---------- 完成后自动写回源目录（默认关） ----------
  autosave.checked = state.autoSave;
  autosave.onchange = (ev) => {
    state.autoSave = (ev.target as HTMLInputElement).checked;
    localStorage.setItem("javweb_autosave", state.autoSave ? "1" : "0");
  };

  // ---------- 任务表「换服务重跑」：复用本地音轨缓存向另一个服务端提交新任务（仅 desktop） ----------
  // F-11：路径直读提交的任务无音轨缓存，源视频路径恢复三通道（优先级从高到低）：
  // ① 音轨缓存 meta hit.videoPath ② serve 任务行 file_path（job-rows 透传 task.path）
  // ③ 写回登记（在途任务；完成回写后消费删除）。file_path 可能指向已删文件 → fileExists 验证。
  function findWriteBackVideoPath(videoName: string): string {
    let best = "";
    let bestAt = -1;
    for (const [k, info] of state.writeBackJobs) {
      if (info.videoName !== videoName || !info.videoPath) continue;
      const at = wbAt.get(k) || 0;
      if (at > bestAt) { bestAt = at; best = info.videoPath; }
    }
    return best;
  }

  async function openRerunModal(videoName: string, curEngine: string, curJobId: string, curStatus = "", filePath = "") {
    showModal(`换服务重跑 · ${videoName}`);
    const body = $("modal-body");
    body.innerHTML = '<div class="muted">检测本地音轨缓存 / 源视频路径中…</div>';
    let hit: AudioCacheHit | null = null;
    try { hit = await platform.findAudioCache(videoName); } catch { hit = null; }
    // F-11：源视频路径恢复（三通道，首个验证有效者胜出）
    let srcPath = hit && (hit.opusValid || hit.videoExists) ? hit.videoPath : "";
    if (!srcPath) {
      for (const c of [filePath, findWriteBackVideoPath(videoName)]) {
        if (!c || c === srcPath) continue;
        try { if (await platform.fileExists(c)) { srcPath = c; break; } } catch { /* 视为不存在 */ }
      }
    }
    if (!hit?.opusValid && !srcPath) {
      body.innerHTML = `
      <div class="set-note err">本地没有该影片的音轨缓存（源视频也不在本机）</div>
      <div class="muted small">重跑复用的是本机提取的音轨缓存（7 天保留）或本机源视频。该任务若是从其他机器整片直传提交、或缓存已过期且源视频已删除，就没有可复用的音轨。</div>`;
      return;
    }
    // F-11：cache=opus 缓存直接复用；video=源视频直读优先，服务读不到（400）自动转本机提取上传
    const mode: "cache" | "video" = hit?.opusValid ? "cache" : "video";
    // 0.2.47：非终态行（排队/运行/暂停）→ cancel-first：先取消原任务再重交，防双活
    const nonTerminal = !!curJobId && (curStatus === "pending" || curStatus === "running" || curStatus === "paused");
    const cands = (state.engines || []).filter((e) => e.name !== curEngine && e.online);
    const statusHtml = mode === "cache"
      ? `<div class="set-note">音轨缓存命中：<b>${fmtSize(hit!.audioBytes)}</b>·来源 ${esc(hit!.videoPath)}</div>`
      : `<div class="set-note">无可用音轨缓存（源视频在本机：${esc(srcPath)}）。将先尝试让所选服务直读源视频；服务读不到时自动转本机提取后上传。</div>`;
    if (!cands.length) {
      body.innerHTML = statusHtml + '<div class="set-note err">没有其他在线服务可选（仅登记了本行服务，或其他服务均离线）</div>';
      return;
    }
    const opts = cands.map((e, i) => `
      <label class="chk-row"><input type="radio" name="rerun-engine" value="${esc(e.name)}"${i === 0 ? " checked" : ""}>
      <span>${esc(e.name)} <span class="muted small mono">${esc(e.url)}</span></span></label>`).join("");
    body.innerHTML = `
      ${nonTerminal
        ? `<div class="set-note err">该任务当前「${curStatus === "running" ? "运行中" : curStatus === "paused" ? "已暂停" : "排队中"}」：将先在「${esc(curEngine)}」上取消该任务（排队中立即终止；运行中在检查点中止，已生成字幕保留），再向所选服务重新提交。</div>`
        : ""}
      ${statusHtml}
      <div class="set-group">目标服务</div>
      ${opts}
      <div class="set-row">
        <button type="button" id="rerun-go" class="btn btn-primary">提交到所选服务</button>
        <span id="rerun-prog" class="muted small"></span>
      </div>`;
    const goBtn = $("rerun-go") as HTMLButtonElement;
    const prog = $("rerun-prog") as HTMLElement;
    goBtn.onclick = async () => {
      const eng = (body.querySelector<HTMLInputElement>('input[name="rerun-engine"]:checked') || null)?.value;
      if (!eng || goBtn.disabled) return;
      goBtn.disabled = true;
      const fail = (msg: string) => {
        body.insertAdjacentHTML("afterbegin", `<div class="set-note err">${esc(msg)}</div>`);
        goBtn.disabled = false;
      };
      try {
        const h = hit; // F-11：video 模式可为 null（源路径由任务行 file_path / 写回登记恢复）
        // 0.2.47 cancel-first：非终态行先取消原任务。
        // 404/409 = 原任务已不存在/已结束 → 视同取消成功，直接重交；其余失败一律中止（防双活）
        if (nonTerminal) {
          prog.textContent = "取消原服务任务中…";
          try {
            const cd = await t.cancelJob(curEngine, curJobId);
            if (!["canceled", "canceling"].includes(cd.status)) {
              throw new Error(`取消状态异常（${cd.status}）`);
            }
          } catch (e) {
            const emsg = (e as Error).message || "";
            if (!/任务不存在|任务已结束|job not found|no need/i.test(emsg)) {
              throw new Error(`取消原任务失败（${emsg}），已中止重交；请确认原任务结束后再试`);
            }
          }
        }
        // 预登记：请求发出前先持久化登记（job 出具后 rekey 正式键）；
        // F-11：上移到模式分支前——video 模式直读提交与 cache 模式上传提交都要，videoPath 统一登记恢复的源路径
        registerWriteBack(preKeyOf(eng, videoName), { engine: eng, videoName, dirHandle: null, videoPath: srcPath });
        // 等接受出具 job_id（desktop transport：201 即列 done；兼容 web 轮询语义多轮几次）
        const waitJobId = async (uploadId: string): Promise<string> => {
          let id = "";
          for (let i = 0; i < 20 && !id; i++) {
            const st = await t.getUpload(uploadId);
            if (st.phase === "done") id = st.job_id || "";
            else if (st.phase === "error") throw new Error(st.error || "提交失败");
            else await new Promise((r) => setTimeout(r, 300));
          }
          if (!id) throw new Error("提交接受超时（可在任务表查看）");
          return id;
        };
        // 复用现有上传通道提交（字节进度回显）→ 轮询出具 job_id
        const uploadAndPoll = async (video: string, opusPath: string, audioBytes: number): Promise<string> => {
          prog.textContent = "上传音轨中…";
          const upFile = new File([], video) as File & { _localPath?: string };
          Object.defineProperty(upFile, "size", { value: audioBytes, configurable: true });
          const audio = new Blob([]) as Blob & { _javOpusPath?: string; _javOpusSize?: number };
          Object.defineProperty(audio, "size", { value: audioBytes, configurable: true });
          audio._javOpusPath = opusPath;
          audio._javOpusSize = audioBytes;
          const d = await t.uploadAudio(upFile, eng, audio, (loaded, total, pct) => {
            prog.textContent = `上传音轨 ${fmtSize(loaded)} / ${fmtSize(total)} · ${pct.toFixed(1)}%`;
          });
          if (!d.ok) throw new Error(d.error || "音频上传失败");
          if (d.cached) prog.textContent = "服务端已缓存，免上传";
          return waitJobId(d.uploadId);
        };
        // 本机提取音轨（video 模式直读 400 回退用；shim 口径同 ghostRetryCore）
        const extractLocal = async (): Promise<{ opusPath: string; audioBytes: number }> => {
          prog.textContent = "本机提取音轨中…";
          const shim = new File([], videoName) as File & { _localPath?: string };
          if (h?.videoBytes) Object.defineProperty(shim, "size", { value: h.videoBytes, configurable: true });
          shim._localPath = srcPath;
          const res = await new Promise<Blob | { skipped: true }>((resolve, reject) => {
            jav()!.extractAudio(shim, (pr) => {
              prog.textContent = `本机提取音轨 · ${Math.round(pr * 100)}%`;
            }).then(resolve, reject);
          });
          if (!res || "skipped" in res) throw new Error("音轨提取被跳过（文件为空或超限）");
          const b = res as Blob & { _javOpusPath?: string; _javOpusSize?: number };
          const opusPath = b._javOpusPath || "";
          const audioBytes = b._javOpusSize || 0;
          if (!opusPath) throw new Error("音轨提取没有产生可用音频");
          return { opusPath, audioBytes };
        };
        // 提交到目标服务：cache 模式=opus 缓存复用上传；video 模式=源视频直读优先
        let jobId = "";
        if (mode === "cache") {
          // cache 模式 hit 必非空且 opusValid（mode 判定保证）
          jobId = await uploadAndPoll(h!.videoName, h!.opusPath, h!.audioBytes);
        } else {
          prog.textContent = "提交源视频到所选服务…";
          try {
            const d = await t.submitScan(eng, [srcPath]);
            jobId = d.jobId || "";
            if (!jobId) throw new Error("提交接受失败（可在任务表查看）");
          } catch (e) {
            // 400 not-found = 服务读不到该路径（跨机 / 文件已删）→ 回退本机提取 + 上传（ghostRetryCore 同口径）
            if (!(e instanceof TransportError && e.code === "not-found")) throw e;
            const ex = await extractLocal();
            jobId = await uploadAndPoll(videoName, ex.opusPath, ex.audioBytes);
          }
        }
        rekeyWriteBack(preKeyOf(eng, videoName), eng + "|" + jobId);
        registerWriteBack(eng + "|" + jobId, {
          engine: eng, videoName, dirHandle: null, videoPath: srcPath,
        });
        // 0.2.47：非终态行的旧任务写回登记迁移到新键（镜像 retry handler：强制写回集/登记不丢）
        if (nonTerminal && curJobId) {
          const oldKey = curEngine + "|" + curJobId;
          if (state.writeBackJobs.has(oldKey)) {
            rekeyWriteBack(oldKey, eng + "|" + jobId);
            const mi = state.writeBackJobs.get(eng + "|" + jobId);
            if (mi) mi.engine = eng; // rekey 迁入的是旧服务 info，登记归属改为新服务
            saveWriteBackStore();
          }
        }
        hideModal();
        toast(nonTerminal
          ? `换服务重跑：已取消「${curEngine}」原任务，「${videoName}」→ 「${eng}」任务 ${jobId}（旧任务检查点收尾，已生成字幕保留）`
          : `换服务重跑：「${videoName}」→ 「${eng}」任务 ${jobId}`, "ok");
        refresh();
      } catch (e) {
        prog.textContent = "";
        fail((e as Error).message || "重跑失败");
      }
    };
  }

  // ---------- 服务设置 modal ----------
  // ---------- 服务设置 modal（服务端参数：分组卡片 + 帮助悬浮 + 改动追踪） ----------
  const GROUP_ZH: Record<string, string> = {
    subtitle: "字幕", infer: "推理引擎", vad: "VAD 过滤", polish: "AI 润色",
    emby: "Emby 刷新", jasna: "音频修复", scan: "扫描规则", storage: "缓存清理",
  };
  // 组职责一句话（组标题右侧）
  const GROUP_DESC: Record<string, string> = {
    subtitle: "命名、格式与跳过判定",
    infer: "语音识别使用的模型与设备",
    vad: "语音检测：滤掉背景乐/噪声再进识别",
    polish: "生成后再用大模型复核一遍（可选）",
    emby: "生成后自动刷新 Emby 媒体库",
    jasna: "识别前先对音轨降噪修复",
    scan: "已迁至「设置 → 客户端 → 扫描规则」，此处仅兼容说明",
    storage: "服务端临时缓存的清理周期",
  };
  // enum 选项的中文展示（提交值仍是原始值）
  const ENUM_ZH: Record<string, Record<string, string>> = {
    "subtitle.naming": {
      rename: "rename · 统一 <片名>.<标签>.srt（推荐）",
      keep: "keep · 保留引擎原始输出名",
    },
    "subtitle.skip_embedded": {
      off: "永不跳过",
      target: "命中目标语言才跳过（推荐）",
      any: "有任意内嵌字幕轨就跳过",
    },
    "infer.device": {
      auto: "auto · 引擎自选",
      cpu: "cpu · 纯 CPU（慢）",
      cuda: "cuda · GPU（需驱动）",
    },
    "infer.log_level": {
      DEBUG: "DEBUG · 最详细（排障用）",
      INFO: "INFO · 默认",
      WARNING: "WARNING · 安静（推荐）",
      ERROR: "ERROR · 仅错误",
    },
  };
  // 各设置项帮助文案（与服务端 CONFIG_HINTS 同源生成；服务端返回 hint 时优先用服务端的）
  const HINT_FALLBACK: Record<string, string> = {
    "subtitle.lang_tag": "加在影片名后的语言标签：zh → <片名>.zh.srt。客户端下载/写回按该标签匹配，无特殊需求保持 zh。",
    "subtitle.naming": "rename = 统一改名为 <片名>.<标签>.srt（推荐，客户端按此命名写回）；keep = 保留引擎原始输出文件名。",
    "subtitle.formats": "识别引擎一次产出的字幕格式，逗号分隔。必须包含 srt（客户端链路按 srt 交付），可加 vtt / lrc。",
    "subtitle.tag_formats": "落位时加语言标签的扩展名：这些格式的文件会命名成 <片名>.<标签>.*；其它格式保留引擎原文件名。",
    "subtitle.output_dir": "服务端上字幕落盘目录的绝对路径。留空 = 与源视频同目录（推荐；远端任务的字幕随后会经下载/写回交付，本地路径填了客户端也取不到）。",
    "subtitle.skip_if_exists": "目标字幕文件已存在时，该视频直接跳过、不再重复生成。",
    "subtitle.overwrite": "目标字幕已存在时，用新生成的覆盖。与「已存在时跳过」同时开启时，覆盖优先。",
    "subtitle.skip_embedded": "off = 永不跳过；target = 仅当内嵌轨命中下方目标语言时跳过（推荐）；any = 有任意内嵌字幕轨就跳过。",
    "subtitle.embedded_langs": "「内嵌字幕时跳过」生效时用的目标语言，如 zh、ja，逗号分隔；内嵌轨语言命中即视为已有字幕。",
    "subtitle.marker": "在生成的 srt 末尾追加 JavScribe 指纹（注释 + 0 时长 cue），用于识别本工具产出的文件；幂等，已有指纹不重复写。",
    "infer.device": "cuda = 用服务端 GPU 推理（需已装驱动）；cpu = 纯 CPU（慢很多）；auto = 引擎自行选择。",
    "infer.model": "识别模型目录/名。通常保持不变；改成别的名字前需确认服务端已有该模型。",
    "infer.log_level": "识别引擎日志详细度。排障用 DEBUG，平时 WARNING 更安静。",
    "infer.batch": "开启后引擎把队列内多个音轨合并成批推理，GPU 利用率与排队吞吐更高。",
    "infer.max_batch_size": "一批最多并行多少条音轨：越大排空越快、显存/内存压力越高；默认 8。",
    "vad.threshold": "语音检测阈值 0.01~0.99：越高越抗背景噪声，但轻声可能被切掉；越低越灵敏，但音乐/噪声更容易被当成语音识别。留空用引擎默认 0.5。",
    "polish.enabled": "生成字幕后再用大语言模型通读一遍，修正错译、漏译与不通顺。需同时配置下方地址/模型/Key 才生效。",
    "polish.base_url": "OpenAI 兼容 Chat 接口地址（Ollama / vLLM / 商用 API 均可），如 http://127.0.0.1:11434/v1。",
    "polish.model": "润色模型名，须与润色服务里登记的模型一致，如 qwen2.5:14b。",
    "polish.batch_lines": "每次发给模型的字幕行数。过大易让模型改错行数；默认 60。",
    "polish.timeout_s": "单次请求润色服务的超时秒数。本地模型跑长字幕建议调大，如 600。",
    "polish.api_key": "润色服务的 Key。留空 = 保持现值；只会发送到你配置的润色服务地址。",
    "emby.enabled": "字幕生成后通知 Emby 刷新媒体库，新字幕轨立即可选（需服务端能访问到 Emby 地址）。",
    "emby.url": "Emby 访问地址，如 http://192.168.0.134:8096。",
    "emby.api_key": "Emby 管理员 API Key。留空 = 保持现值。",
    "jasna.enabled": "识别前先对音轨做 JASNA 降噪修复。仅当服务端已配置 JASNA 命令（服务端内部设置，不能在此改）时可用。",
    "jasna.output": "修复后音频的文件名模板：{stem}=影片名，{ext}=扩展名，如 {stem}_restored{ext}。",
    "scan.video_exts": "「扫描目录」时当作视频的扩展名，逗号分隔，如 mp4, mkv, ts。",
    "scan.subtitle_patterns": "判定「该视频已有字幕文件」的后缀，如 .zh.srt, .srt：同目录存在 <片名>+<后缀> 即视为已有字幕。",
    "scan.recurse": "「扫描目录」时是否递归进入子目录。",
    "storage.retention_days": "服务端自动清理周期：inbox 里的上传音轨与生成字幕副本，超过 N 天未被引用即删除；落在影片旁的成品字幕不受影响。",
  };
  // 各分区的「启用」项：未勾选时其余项置灰（仍可编辑）
  const GATE_SEC: Record<string, string> = {
    "polish.enabled": "polish",
    "emby.enabled": "emby",
    "jasna.enabled": "jasna",
  };

  function helpIcon(tip: string): string {
    return `<span class="help" tabindex="0" data-tip="${esc(tip)}">?</span>`;
  }

  // 帮助图标 tooltip 自动翻转：下方空间不足时改上翻，贴近屏幕左右边缘时贴边对齐，
  // 避免悬浮文案被视口/弹窗裁掉（纯 CSS 定位 + 事件时补一个方向类）
  function helpRelocate(el: HTMLElement): void {
    const r = el.getBoundingClientRect();
    const estH = Math.min(200, 34 + Math.max(1, Math.ceil((el.dataset.tip || "").length / 20)) * 19);
    el.classList.toggle("flip", r.bottom + estH + 20 > window.innerHeight && r.top > estH + 20);
    el.classList.toggle("edge-l", r.left < 16);
    el.classList.toggle("edge-r", r.left >= 16 && r.right > window.innerWidth - 16 && r.left > 180);
  }
  document.addEventListener("mouseover", (ev) => {
    const h = (ev.target as HTMLElement).closest?.(".help");
    if (h) helpRelocate(h as HTMLElement);
  });
  document.addEventListener("focusin", (ev) => {
    const h = (ev.target as HTMLElement).closest?.(".help");
    if (h) helpRelocate(h as HTMLElement);
  });
  document.addEventListener("mouseout", (ev) => {
    const h = (ev.target as HTMLElement).closest?.(".help");
    if (h) (h as HTMLElement).classList.remove("flip", "edge-l", "edge-r");
  });
  document.addEventListener("focusout", (ev) => {
    const h = (ev.target as HTMLElement).closest?.(".help");
    if (h) (h as HTMLElement).classList.remove("flip", "edge-l", "edge-r");
  });

  function showModal(title: string) {
    $("modal-title").textContent = title;
    $("modal-body").innerHTML = "";
    $("modal").classList.remove("modal-wide");
    modalBackdrop.hidden = false;
  }

  function hideModal() {
    modalBackdrop.hidden = true;
    $("modal-body").innerHTML = "";
    upModalOpen = false;
  }

  modalX.onclick = hideModal;
  modalBackdrop.addEventListener("click", (ev) => { if (ev.target === modalBackdrop) hideModal(); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") hideModal(); });

  // ---------- 服务端设置（设置页 · 服务端子 tab，10-18-javscribe-0246 A） ----------
  // 通用组：所有服务端语义一致的组（fan-out 到所有端）；infer/jasna 为单端专属（模型/设备因端而异），
  // scan 组已弃用（新版客户端读本机 client config），均不进通用表单。
  const COMMON_GROUPS = new Set(["subtitle", "vad", "polish", "emby", "storage"]);

  // 共享表单渲染器：single = 单服务端（全组 + 组件就绪总览 + 保存设置）；common = 通用（仅通用组，
  // 取值参考某在线已登记 Key 的服务端，保存到所有服务）。同一时刻 DOM 只有一份表单，控件按 id 全局取。
  function renderCfgForm(target: HTMLElement, mode: "common" | "single", name: string, items: ConfigItem[]): void {
    const allGroups: Record<string, ConfigItem[]> = {};
    for (const it of items) {
      const g = it.path.split(".")[0];
      (allGroups[g] = allGroups[g] || []).push(it);
    }
    const orderedGroups = [
      ...Object.keys(GROUP_ZH).filter((k) => allGroups[k]),
      ...Object.keys(allGroups).filter((k) => !(k in GROUP_ZH)),
    ];
    const groups = mode === "single"
      ? allGroups
      : Object.fromEntries(orderedGroups.filter((g) => COMMON_GROUPS.has(g)).map((g) => [g, allGroups[g]]));
    // common 模式只收通用键（collectCfgValues 按 state.cfgItems 遍历取控件）
    state.cfgItems = mode === "single" ? items : items.filter((i) => COMMON_GROUPS.has(i.path.split(".")[0]));
    const e = (state.engines || []).find((x) => x.name === name);
    let html = "";
    if (e) {
      html += `
      <div class="cfg-meta">
        <span class="cfg-lamp${e.online ? " on" : " off"}"></span>
        <span class="cfg-meta-name">${esc(e.name)}</span>
        <a class="cfg-meta-url mono" href="${esc(e.url)}" target="_blank" rel="noopener" title="打开服务端页面">${esc(e.url)}</a>
        <span class="cfg-meta-tags">
          <span class="tag">${esc(e.device || "—")}</span>
          <span class="tag" title="服务 /health 上报版本">v${esc(e.version || "—")}</span>
          ${serveUpBadge(e)}
          <span class="tag${e.jobs_running ? " hot" : ""}">${e.jobs_running ? `运行 ${e.jobs_running}` : "队列空闲"}</span>
        </span>
      </div>`;
    }
    if (mode === "common") {
      html += `<div class="cfg-meta-ref muted small">取值参考：${esc(name)}（在线且已登记 Key 的服务端）；保存时下发到所有服务端。</div>`;
      html += `<div class="cfg-global-note"><b>通用设置</b>：一份配置下发到<b>所有服务端</b>（影响所有连接的客户端，对新提交的任务生效）。单端专属项（推理引擎 / 音频修复）不在这里，选具体服务单独设置。</div>`;
    } else {
      html += `<div class="cfg-global-note"><b>服务端级设置</b>：以下改动作用于服务端本身，影响<b>所有连接该服务的客户端</b>（对新提交的任务生效）。</div>`;
    }
    // 组内叠放（不再分 tab）：单服务 = 全组 + 组件就绪置顶；通用 = 仅通用组；scan 组 = 兼容说明不渲控件
    if (mode === "single") {
      html += `
    <section class="cfg-sec cfg-sec-ready" data-sec="ready">
      <h4 class="cfg-sec-title">组件就绪<span class="cfg-sec-desc">模型 / 引擎 / GPU / 磁盘等是否就绪</span>${helpIcon("服务端各组件与模型的就绪自检（serve v0.2.6+）。仅本地检查（文件存在性/命令探测），不探测 LLM、Emby 等网络连通性；连通性由任务级失败体现。旧版服务无此接口，显示升级提示。")}</h4>
      <div class="ready-body" id="ready-body"><div class="muted small">检查中…</div></div>
    </section>`;
    }
    for (const g of orderedGroups) {
      if (!(g in groups)) continue;
      const list = groups[g];
      // scan 组：新客户端扫描规则已整体归位「设置 → 客户端 → 扫描规则」（本机 client config），
      // 服务端 scan.* 仅留兼容旧客户端/直连 API，不再被任何新版客户端读取——
      // 渲染为指引说明而非可编辑控件，避免「改了没生效」的误导
      const bodyHtml = g === "scan"
        ? `<div class="set-note">扫描规则（视频扩展名 / 已有字幕判定 / 递归 / 忽略小于 / 文件名标记）已统一在 <b>「设置 → 客户端 → 扫描规则」</b> 维护（保存在本机，桌面端离线也可用）。<br>服务端的 <span class="mono">scan.*</span> 配置新版客户端不再读取，仅保留给旧版客户端 / 直连 API 兼容，无需在此调整。</div>`
        : list.map(configFieldHtml).join("");
      html += `
      <section class="cfg-sec" data-sec="${esc(g)}">
        <h4 class="cfg-sec-title">${esc(GROUP_ZH[g] || g)}${GROUP_DESC[g] ? `<span class="cfg-sec-desc">${esc(GROUP_DESC[g])}</span>` : ""}</h4>
        <div class="cfg-sec-body">${bodyHtml}</div>
      </section>`;
    }
    const hasSecret = state.cfgItems.some((i) => i.type === "secret");
    html += `
    <div class="cfg-foot">
      <span class="cfg-foot-note">保存后对新提交的任务生效${hasSecret ? "；Key 类留空 = 保持不变" : ""}</span>
      <span id="cfg-dirty" class="muted small">无改动</span>
      <span class="cfg-foot-actions">
        <button type="button" id="cfg-reset" class="btn" hidden>重置改动</button>
        ${mode === "single"
          ? `<button type="button" id="cfg-save" class="btn btn-primary">保存设置</button>`
          : `<button type="button" id="cfg-apply-all" class="btn btn-primary" title="把当前表单值下发到全部服务端（逐端保存；Key 类留空 = 各端保持现值，不覆盖）">保存到所有服务</button>`}
      </span>
    </div>`;
    target.innerHTML = html;
    if (mode === "single") loadReadiness(name);
    // 改动追踪：控件当前值与初始快照比较，差异行标 .dirty（叠放布局无 tab，无圆点）
    target.querySelectorAll<HTMLElement>(".cfg-row").forEach((row) => {
      const ctl = row.querySelector<HTMLInputElement | HTMLSelectElement>("input, select");
      if (!ctl) return;
      const sync = (): void => {
        const cur = ctl instanceof HTMLInputElement && ctl.type === "checkbox"
          ? JSON.stringify(ctl.checked)
          : JSON.stringify(ctl.value);
        row.classList.toggle("dirty", cur !== (row.dataset.base ?? ""));
        const n = target.querySelectorAll(".cfg-row.dirty").length;
        const d = $("cfg-dirty");
        if (d) { d.textContent = n ? `有 ${n} 项未保存` : "无改动"; d.classList.toggle("dirty-n", n > 0); }
        const r = $("cfg-reset");
        if (r) r.hidden = n === 0;
      };
      ctl.addEventListener("input", sync);
      ctl.addEventListener("change", sync);
      if (ctl.type === "checkbox" && GATE_SEC[row.dataset.path || ""]) {
        ctl.addEventListener("change", () => applyGating(target));
      }
    });
    applyGating(target);
    ($("cfg-reset") as HTMLButtonElement).onclick = () => {
      target.querySelectorAll<HTMLElement>(".cfg-row").forEach((row) => {
        const ctl = row.querySelector<HTMLInputElement | HTMLSelectElement>("input, select");
        if (!ctl) return;
        const base = JSON.parse(row.dataset.base ?? '""') as boolean | string;
        if (ctl.type === "checkbox") ctl.checked = base === true;
        else ctl.value = base === true ? "true" : base === false ? "false" : String(base);
        ctl.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const saveBtn = $("cfg-save") as HTMLButtonElement | null;
    if (saveBtn) saveBtn.onclick = () => saveConfig(name);
    const applyAll = $("cfg-apply-all") as HTMLButtonElement | null;
    if (applyAll) applyAll.onclick = () => applyCommonToAll();
  }

  // 服务端子 tab 面板：__all__ = 通用（一份 fan-out 所有端）；具体服务名 = 单端配置（含 API Key 登记）
  // 服务端 pane 渲染代际：切服务/切 pane 时自增，过期异步（getConfig 晚到）不得覆盖新表单
  let srvSeq = 0;
  function renderSrv(value: string): void {
    const body = $("srv-body");
    if (!body) return;
    if (value === "__all__") renderSrvPaneCommon();
    else renderSrvPaneSingle(value);
  }

  function setSrvNote(text: string): void {
    const n = $("srv-note");
    if (n) n.textContent = text;
  }

  function renderSrvPaneCommon(): void {
    const seq = ++srvSeq;
    const body = $("srv-body");
    if (!body) return;
    const engines = state.engines || [];
    if (!engines.length) {
      body.innerHTML = '<div class="set-note"><div class="set-note-title">还没有服务端</div>先到「字幕服务」页添加服务，再在这里配置通用设置。</div>';
      setSrvNote("");
      return;
    }
    // 取值参考：第一个在线且已登记 Key 的服务端，否则第一个（表单值来源，不代表下发目标）
    const ref = engines.find((e) => e.online && e.has_key) || engines[0];
    setSrvNote("通用设置 = 一份配置下发到所有服务端；保存前逐端差异确认（取值参考见下方卡片）。");
    body.innerHTML = '<div class="muted small">加载设置中…</div>';
    t.getConfig(ref.name)
      .then((items) => { if (seq === srvSeq) renderCfgForm(body, "common", ref.name, items); })
      .catch((err: Error) => {
        if (seq !== srvSeq) return;
        body.innerHTML = `
        <div class="set-note err">
          <div class="set-note-title">无法读取服务端设置</div>
          ${esc(err.message)}
        </div>
        <div class="muted small">提示：若 Key 不正确，先在具体服务里把 Key 清空（保存空值）再重填；若提示版本过旧，请升级该服务端的 JavScribe。</div>`;
      });
  }

  function renderSrvPaneSingle(name: string): void {
    const seq = ++srvSeq;
    const body = $("srv-body");
    if (!body) return;
    const e = (state.engines || []).find((x) => x.name === name);
    if (!e) {
      body.innerHTML = '<div class="set-note"><div class="set-note-title">服务不存在或已删除</div>请重新选择服务端。</div>';
      setSrvNote("");
      return;
    }
    setSrvNote(`仅修改「${name}」这一个服务端的配置。`);
    if (!e.has_key) {
      body.innerHTML = `
      <div class="set-note">
        <div class="set-note-title">该服务尚未登记 API Key</div>
        登记后即可在此查看与修改服务端设置（字幕规则、模型、润色、Emby 等）；
        不登记也能正常提交生成任务，只是进不了服务端设置。
      </div>
      <form id="key-form" class="set-row" autocomplete="off">
        <label class="field grow">
          <span class="field-label">API Key${helpIcon("需与服务端环境变量 JAVSCRIBE_API_KEY 完全一致。Key 只保存在客户端本机，请求时随 X-Api-Key 头发送。")}</span>
          <input id="key-input" class="mono" type="password" maxlength="128" required
                 placeholder="与服务端环境变量 JAVSCRIBE_API_KEY 一致">
        </label>
        <button type="submit" class="btn">保存 Key</button>
      </form>`;
      ($("key-form") as HTMLFormElement).onsubmit = async (ev) => {
        ev.preventDefault();
        try {
          await t.putEngineKey(name, ($("key-input") as HTMLInputElement).value.trim());
          toast("API Key 已保存", "ok");
          await refresh(); // 等 has_key 落地，否则下面又按 keyless 渲染
          renderSrvPaneSingle(name);
        } catch (e2) {
          toast((e2 as Error).message, "err");
        }
      };
      ($("key-input") as HTMLInputElement).focus();
      return;
    }
    body.innerHTML = '<div class="muted small">加载设置中…</div>';
    t.getConfig(name)
      .then((items) => { if (seq === srvSeq) renderCfgForm(body, "single", name, items); })
      .catch((err: Error) => {
        if (seq !== srvSeq) return;
        body.innerHTML = `
        <div class="set-note err">
          <div class="set-note-title">无法读取服务端设置</div>
          ${esc(err.message)}
        </div>
        <div class="muted small">提示：若 Key 不正确，先把 Key 清空（保存空值）再重填；若提示版本过旧，请升级该服务端的 JavScribe。</div>`;
      });
  }

  // 组件就绪自检：拉取 /ready 渲染卡片；旧服务(unsupported)/离线(unreachable)降级为提示，不 throw；旧服务(unsupported)/离线(unreachable)降级为提示，不 throw
  async function loadReadiness(name: string): Promise<void> {
    const box = $("ready-body");
    if (!box) return;
    if (!t.getReadiness) {
      box.innerHTML = '<div class="muted small">当前形态不支持组件就绪自检</div>';
      return;
    }
    box.innerHTML = '<div class="muted small">检查中…</div>';
    let payload: ReadinessPayload;
    try {
      payload = await t.getReadiness(name);
    } catch (e) {
      box.innerHTML = `<div class="muted small">获取失败：${esc((e as Error).message)}</div>`;
      return;
    }
    if (!payload.ok || !payload.ready) {
      const err = payload.error || "";
      if (err === "unsupported") {
        box.innerHTML = '<div class="muted small">该服务版本较旧（&lt; v0.2.6），暂不支持组件就绪自检；升级服务端后可在此查看模型 / 引擎 / GPU / 磁盘状态。</div>';
      } else if (err === "unreachable") {
        box.innerHTML = '<div class="muted small">服务不可达，暂无法检查组件就绪状态。</div>';
      } else {
        box.innerHTML = `<div class="muted small">无法检查：${esc(err)}</div>`;
      }
      return;
    }
    const rep = payload.ready;
    const flag = rep.ready
      ? '<span class="ready-flag ok">全部就绪</span>'
      : '<span class="ready-flag no">存在未就绪项</span>';
    let h = `<div class="ready-summary">${flag}<span class="muted small mono">服务 v${esc(rep.version || "—")} · ${esc(rep.device || "auto")}</span></div>`;
    for (const it of rep.items) {
      const det = it.detail ? `<span class="ready-det">${esc(it.detail)}</span>` : "";
      h += `<div class="ready-row st-${esc(it.status)}"><span class="ready-ico"></span><span class="ready-lab">${esc(it.label)}</span>${det}</div>`;
    }
    box.innerHTML = h;
  }

  // 「启用」项未勾选 → 同分区其余项置灰（保留可编辑：勾启用 + 填值可一起保存）
  function applyGating(body: HTMLElement): void {
    for (const path of Object.keys(GATE_SEC)) {
      const row = body.querySelector<HTMLElement>(`.cfg-row[data-path="${path}"]`);
      const ctl = row?.querySelector<HTMLInputElement>("input[type=checkbox]");
      const section = row?.closest<HTMLElement>(".cfg-sec");
      if (!row || !ctl || !section) continue;
      for (const r of section.querySelectorAll<HTMLElement>(".cfg-row")) {
        if (r !== row) r.classList.toggle("cfg-dim", !ctl.checked);
      }
    }
  }

  function configFieldHtml(it: ConfigItem): string {
    const id = "cfg-" + it.path.replace(/\./g, "-");
    const tip = it.hint || HINT_FALLBACK[it.path] || "";
    const lab = (text: string): string =>
      `<span class="cfg-lab">${esc(text)}${tip ? helpIcon(tip) : ""}</span>`;
    const baseVal: string | boolean = it.type === "bool" ? !!it.value
      : it.type === "secret" ? "" : (it.value == null ? "" : String(it.value));
    const base = JSON.stringify(baseVal);
    if (it.type === "bool") {
      return `<label class="cfg-row chk-row" data-path="${esc(it.path)}" data-base="${esc(base)}">
      <input type="checkbox" id="${id}"${it.value ? " checked" : ""}>
      ${lab(it.label)}</label>`;
    }
    if (it.type === "enum") {
      const zh = ENUM_ZH[it.path] || {};
      // 空值 → 「（未设置）」占位（否则浏览器默认选第一项，误导「当前=第一项」且保存时静默改写）；
      // value 不在 options（serve schema 变更/旧自定义值）→ 前插当前值合成项，显示真实值
      const cur = it.value == null ? "" : String(it.value);
      const emptyOpt = cur === "" ? `<option value="" selected>（未设置）</option>` : "";
      const curOpt = cur !== "" && !(it.options || []).includes(cur)
        ? `<option value="${esc(cur)}" selected>${esc(zh[cur] || cur)}</option>` : "";
      const opts = [emptyOpt, curOpt,
        ...(it.options || []).map((o: string) =>
          `<option value="${esc(o)}"${o === cur ? " selected" : ""}>${esc(zh[o] || o)}</option>`),
      ].join("");
      return `<div class="cfg-row" data-path="${esc(it.path)}" data-base="${esc(base)}">
      ${lab(it.label)}
      <select id="${id}">${opts}</select></div>`;
    }
    if (it.type === "list") {
      const val = Array.isArray(it.value) ? (it.value as string[]).join(", ") : (it.value == null ? "" : String(it.value));
      return `<div class="cfg-row" data-path="${esc(it.path)}" data-base="${esc(base)}">
      ${lab(it.label)}
      <input id="${id}" type="text" class="mono" value="${esc(val)}" placeholder="逗号分隔" spellcheck="false" autocomplete="off"></div>`;
    }
    const type = it.type === "int" || it.type === "float" ? "number" : it.type === "secret" ? "password" : "text";
    const val = it.type === "secret" ? "" : (it.value == null ? "" : String(it.value));
    const ph = it.type === "secret" ? (it.value === "***" ? "已设置，留空保持不变" : "")
      : it.type === "float" ? "留空用服务端默认（0.5）"
      : it.type === "int" ? "留空保持不变" : "";
    const numAttrs = it.type === "float" ? ' step="0.05" min="0.01" max="0.99"' : it.type === "int" ? ' min="1"' : "";
    return `<div class="cfg-row" data-path="${esc(it.path)}" data-base="${esc(base)}">
      ${lab(it.label)}
      <input id="${id}" type="${type}"${numAttrs} class="${it.type === "secret" ? "mono" : ""}"
             value="${esc(val)}" placeholder="${esc(ph)}" spellcheck="false" autocomplete="off"></div>`;
  }

  // 表单当前值 → 待提交 map（int/float/secret 留空 = 不发送，服务端保持现值）；校验失败 toast + 返回 null
  function collectCfgValues(): Record<string, unknown> | null {
    const values: Record<string, unknown> = {};
    for (const it of state.cfgItems) {
      const f = $("cfg-" + it.path.replace(/\./g, "-")) as HTMLInputElement;
      if (!f) continue;
      if (it.type === "bool") {
        values[it.path] = f.checked;
      } else if (it.type === "int") {
        if (f.value.trim() === "") continue; // 空 = 保持服务端现值（对齐 float/secret 语义）
        const v = parseInt(f.value, 10);
        if (isNaN(v) || v < 1) { toast(`${it.label} 需要正整数`, "err"); return null; }
        values[it.path] = v;
      } else if (it.type === "float") {
        if (f.value.trim() === "") continue; // 空 = 保持服务端默认阈值
        const v = parseFloat(f.value);
        if (isNaN(v) || v < 0.01 || v > 0.99) { toast(`${it.label} 需在 0.01 ~ 0.99 之间`, "err"); return null; }
        values[it.path] = v;
      } else if (it.type === "secret") {
        if (f.value === "") continue; // 空 = 保持
        values[it.path] = f.value;
      } else if (it.type === "enum") {
        const cur = it.value == null ? "" : String(it.value);
        if (f.value === "" || f.value === cur) continue; // 未设置/未改动不送（见上方注释）
        values[it.path] = f.value;
      } else {
        values[it.path] = f.value;
      }
    }
    return values;
  }

  async function saveConfig(name: string) {
    const values = collectCfgValues();
    if (!values) return;
    try {
      await t.putConfig(name, values);
      toast("服务设置已保存（对新提交的任务生效）", "ok");
      await refresh();
      // 重新拉取：敏感项回到打码、改动追踪归零（设置页内重渲，不再开弹窗）
      const sel = $("srv-sel") as HTMLSelectElement | null;
      if (sel && sel.value) renderSrv(sel.value);
      else renderSrvPaneSingle(name);
    } catch (e) {
      toast((e as Error).message, "err");
    }
  }

  // 「保存到所有服务」（设置页 · 服务端 · 通用）：先逐目标拉取现配置做字段级 diff，确认后才 fan-out
  // 覆盖（并行 putConfig，逐端独立成败）。确认交互放在发请求前的同步步骤：先取齐 diff 数据 →
  // 渲染确认弹窗（#modal）→ 点确认直接 fan-out；取消 = 只关弹窗，页内表单不回退，零请求。
  async function applyCommonToAll(): Promise<void> {
    const values = collectCfgValues();
    if (!values) return;
    const targets = (state.engines || []).map((e) => e.name);
    if (!targets.length) return;
    const btn = $("cfg-apply-all") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "正在比对差异…";
    const currents = await Promise.allSettled(targets.map((n) => t.getConfig(n)));
    btn.disabled = false;
    btn.textContent = "保存到所有服务";
    // 字段级 diff：只比本次下发的键（int/float/secret 留空 = 不下发，各端保持现值，不计差异）
    const normVal = (v: unknown): string =>
      Array.isArray(v) ? v.join(", ")
      : typeof v === "boolean" ? (v ? "开" : "关")
      : v == null ? "" : String(v);
    const disp = (x: string): string => (x === "" ? "（空）" : x);
    let html = `<div class="cfg-global-note"><b>即将对以下 ${targets.length} 个服务并行覆盖保存</b>：${targets.map(esc).join("、")}（对新提交的任务生效；表单留空的项不下发，各端保持现值）。</div>`;
    targets.forEach((n, i) => {
      const r = currents[i];
      html += `<div style="margin-top:10px;padding:10px 12px;border:1px solid var(--line);border-radius:8px">`;
      html += `<div style="font-weight:700;margin-bottom:4px"><span class="tag">${i + 1}</span>${esc(n)}</div>`;
      if (r.status === "rejected") {
        html += `<div class="muted small">不可达（${esc((r.reason as Error).message)}）：确认后仍会尝试覆盖该端现值</div>`;
      } else {
        const cur = new Map<string, ConfigItem>();
        for (const it of r.value) cur.set(it.path, it);
        const rows: string[] = [];
        for (const [path, nv] of Object.entries(values)) {
          const ci = cur.get(path);
          if (!ci) {
            rows.push(`<div style="line-height:1.7">${esc(path)}：<span class="mono" style="word-break:break-all">（该端无此项）</span> <span class="muted">→</span> <span class="mono" style="word-break:break-all">${esc(disp(normVal(nv)))}</span></div>`);
            continue;
          }
          const a = normVal(ci.value), b = normVal(nv);
          if (a === b) continue;
          rows.push(`<div style="line-height:1.7">${esc(ci.label)}：<span class="mono" style="word-break:break-all">${esc(disp(a))}</span> <span class="muted">→</span> <span class="mono" style="word-break:break-all">${esc(disp(b))}</span></div>`);
        }
        html += rows.length
          ? rows.join("")
          : `<div class="muted small">无差异（该端现值与表单一致，保存后不变）</div>`;
      }
      html += `</div>`;
    });
    html += `
    <div class="cfg-foot">
      <span class="cfg-foot-note">确认后按当前表单值覆盖各端现值（Key 类留空不覆盖）；取消则不发送任何请求。</span>
      <span class="cfg-foot-actions">
        <button type="button" id="cfg-apply-all-cancel" class="btn">取消</button>
        <button type="button" id="cfg-apply-all-ok" class="btn btn-primary">确认应用到 ${targets.length} 个服务</button>
      </span>
    </div>`;
    showModal(`保存到所有服务（${targets.length} 个）`);
    $("modal").classList.add("modal-wide");
    $("modal-body").innerHTML = html;
    ($("cfg-apply-all-cancel") as HTMLButtonElement).onclick = () => hideModal(); // 取消 = 只关弹窗，页内表单不回退
    ($("cfg-apply-all-ok") as HTMLButtonElement).onclick = async () => {
      const okBtn = $("cfg-apply-all-ok") as HTMLButtonElement;
      okBtn.disabled = true;
      okBtn.textContent = "应用中…";
      const results = await Promise.allSettled(targets.map((n) => t.putConfig(n, values)));
      const fails: string[] = [];
      results.forEach((res, j) => {
        if (res.status === "rejected") fails.push(`${targets[j]}（${(res.reason as Error).message}）`);
      });
      if (fails.length === 0) {
        toast(`已应用到全部 ${targets.length} 个服务（对新提交的任务生效）`, "ok");
      } else if (fails.length < targets.length) {
        toast(`已应用到 ${targets.length - fails.length}/${targets.length} 个服务；失败：${fails.join("、")}`, "err");
      } else {
        toast(`应用失败：${fails.join("、")}`, "err");
      }
      await refresh();
      hideModal();
      const sel = $("srv-sel") as HTMLSelectElement | null;
      if (sel && sel.value) renderSrv(sel.value);
    };
  }

  // ---------- 本机目录扫描 ----------
  // 扫描规则统一在「设置 → 客户端 → 扫描规则」维护（本机 client config 落盘）；面板不再放规则控件。
  let scanPollTimer: number | null = null;
  const stopScanPoll = () => { if (scanPollTimer != null) { window.clearInterval(scanPollTimer); scanPollTimer = null; } };
  const scanStatusLabel: Record<string, string> = {
    queued: "等待开始", running: "扫描中", paused: "已暂停", done: "已完成", error: "扫描失败", canceled: "已取消",
  };
  function renderScanTaskStatus(task: ScanTaskSnapshot | null) {
    if (!scanTaskStatus || !scanTaskText) return;
    if (!task) { scanTaskStatus.hidden = true; return; }
    scanTaskStatus.hidden = false;
    const stateText = scanStatusLabel[task.status] || task.status;
    const detail = task.status === "done"
      ? `找到 ${task.found} 个视频`
      : task.status === "error" ? (task.error || "扫描失败")
      : task.status === "canceled" ? `已检查 ${task.scanned} 项，扫描已取消`
      : `已检查 ${task.scanned} 项，找到 ${task.found} 个视频`;
    scanTaskText.textContent = `${stateText} · ${detail}`;
    scanTaskStatus.dataset.state = task.status;
    if (scanTaskPause) {
      scanTaskPause.hidden = !["queued", "running", "paused"].includes(task.status);
      scanTaskPause.disabled = task.status === "queued" || task.status === "running" ? false : task.status !== "paused";
      scanTaskPause.textContent = task.status === "paused" ? "▶ 继续" : "⏸ 暂停";
    }
    if (scanTaskCancel) scanTaskCancel.hidden = !["queued", "running", "paused"].includes(task.status);
    updateScanGo();
  }
  // 扫描列表分类（互斥）：已有字幕 > 过小 > 无字幕（含「无字幕（名）」信息标项）
  function scanCatOf(i: ScanItem): "no-sub" | "has-sub" | "small" {
    if (i.has_subtitle) return "has-sub";
    if (i.too_small) return "small";
    return "no-sub";
  }
  function scanViewItems(): ScanItem[] {
    if (state.scanFilter === "all") return state.scanItems;
    if (state.scanFilter === "unwritten") return state.scanItems.filter((i) => !!i.reconciled_job_id);
    return state.scanItems.filter((i) => scanCatOf(i) === state.scanFilter);
  }
  /** 当前视图内可被「全选」覆盖的项（过小 / 已生成未落盘 只能手动勾选，任何视图下都不进全选域） */
  function scanViewSelectable(): ScanItem[] {
    return scanViewItems().filter((i) => !i.too_small && !i.reconciled_job_id);
  }

  function applyScanResult(d: ScanResult) {
    state.scanItems = d.items || [];
    state.lastScan = d;
    state.scanPage = 0;
    state.scanFilter = "all"; // 每次新扫描重置分类 tab
    state.scanMapped = d.mapped === true;
    state.scanResolvedPath = d.path || "";
    rebuildScanDoneIndex();
    reconcileScanItems();
    // 默认勾选域：无字幕且非过小、且未对账命中（命中项走「回写」而非重跑，默认不勾）
    state.scanChecked = new Set(state.scanItems
      .filter((i) => !i.has_subtitle && !i.too_small && !i.reconciled_job_id).map((i) => i.path));
    renderScanResults(d);
    updateScanGo();
  }

  // ---------- 扫描×已完成任务对账（0.2.47 需求1）：「已生成未落盘」标记 + 一键回写 ----------
  // 直播/远端任务 done 后字幕未落盘 → 再扫描该影片会被当「无字幕」重复生成。
  // 对账命中（带扩展名 basename 小写）→ 行标 tag、进独立分类 tab、不进全选域；
  // 回写 = 取该 done 任务的结果 srt 落到扫描项同目录（不重跑生成；已有 srt 不覆盖）。
  function rebuildScanDoneIndex(): void {
    const rows: ReconcilableRow[] = [
      ...state._jobs,
      ...Array.from(state._pending.values()).map((p) => p.row),
    ];
    state.scanDoneIndex = buildDoneJobIndex(rows);
  }

  function reconcileScanItems(): number {
    let n = 0;
    for (const i of state.scanItems) {
      const m = matchScanItem(i, state.scanDoneIndex);
      const jid = m ? (m.row.job_id || "") : null;
      const eng = m ? (m.row.engine || null) : null;
      if (i.reconciled_job_id !== jid || i.reconciled_engine !== eng) {
        const wasReconciled = !!i.reconciled_job_id;
        i.reconciled_job_id = jid;
        i.reconciled_engine = eng;
        n++;
        // 动态新命中（先扫描后出 done 行）：同步移出勾选域，与 applyScanResult 的
        // 「默认不勾选」同口径——防止已生成影片被「生成字幕」重新提交跑一遍。
        // 仅 null→set 迁移清除：命中后用户手动重勾的项不回滚（下一轮无迁移）
        if (!wasReconciled && jid) state.scanChecked.delete(i.path);
      }
    }
    return n;
  }

  /** 单项回写：命中行的任务结果 srt → 扫描项同目录（幂等：已有 srt 视同已有字幕） */
  async function scanWriteBackItem(item: ScanItem): Promise<boolean> {
    const m = matchScanItem(item, state.scanDoneIndex);
    const jobId = m?.row.job_id;
    if (!m || !jobId) {
      toast("未匹配到可回写的任务（可能已过期），请刷新后重试", "err");
      return false;
    }
    const row = m.row;
    const srtName = item.name.replace(/\.[^.]+$/, "") + SRT_SUFFIX;
    const info: WriteBackInfo = { engine: row.engine, videoName: item.name, dirHandle: null, videoPath: item.path };
    try {
      if (await platform.srtExists(info, srtName)) {
        item.has_subtitle = true;
        item.subtitle_status = "external";
        item.subtitle = srtName;
        item.reconciled_job_id = null;
        item.reconciled_engine = null;
        toast(`「${item.name}」字幕已存在（${srtName}），视同已有字幕`, "");
        return true;
      }
      let data: ArrayBuffer | null = null;
      for (let i = 0; i < 5 && !data; i++) {
        data = await t.getResultData(row.engine, jobId);
        if (!data) await new Promise((res) => setTimeout(res, 2000));
      }
      if (!data) { toast(`「${item.name}」任务结果暂不可下载（可能已过期），请重新生成`, "err"); return false; }
      const ok = await platform.writeSrt(info, srtName, data);
      if (!ok) throw new Error("写回失败");
      item.has_subtitle = true;
      item.subtitle_status = "external";
      item.subtitle = srtName;
      item.reconciled_job_id = null;
      item.reconciled_engine = null;
      toast(`「${item.name}」已回写 ${srtName}（取任务 ${jobId} 结果，未重新生成）`, "ok");
      return true;
    } catch (e) {
      toast(`「${item.name}」回写失败（${(e as Error).message}）`, "err");
      return false;
    }
  }

  /** 批量回写（「回写所选」按钮）：逐项串行，每项独立 toast，末了重渲染 */
  async function scanWriteBackMany(paths: string[]): Promise<void> {
    const items = state.scanItems.filter((i) => paths.includes(i.path) && i.reconciled_job_id);
    if (!items.length) return;
    if (state.busy) { toast("有正在进行的提交任务，请完成后再试", "err"); return; }
    const btn = $("scan-writeback") as HTMLButtonElement;
    const total = items.length;
    for (let i = 0; i < total; i++) {
      btn.disabled = true;
      btn.innerHTML = `&#8617; 回写中 ${i + 1} / ${total}…`;
      await scanWriteBackItem(items[i]);
    }
    if (state.lastScan) renderScanResults(state.lastScan);
    updateScanSummary(); // 复位「回写所选」按钮的标签/禁用态（updateScanGo 只管 #scan-go）
  }
  async function pollScanTask(id: string) {
    if (!t.getScanTask) return;
    try {
      const task = await t.getScanTask(id);
      state.scanTask = task;
      renderScanTaskStatus(task);
      if (task.status === "done" && task.result) {
        stopScanPoll();
        applyScanResult(task.result);
        toast(`扫描完成：找到 ${task.found} 个视频`, "ok");
      } else if (task.status === "error") {
        stopScanPoll();
        toast(task.error || "扫描失败", "err");
      } else if (task.status === "canceled") {
        stopScanPoll();
        toast("扫描已取消", "");
      }
    } catch (e) {
      // 页面短暂断网时保留任务状态，下一轮继续；不要把用户误导成扫描丢失
    }
  }
  function beginScanPolling(id: string) {
    stopScanPoll();
    void pollScanTask(id);
    scanPollTimer = window.setInterval(() => void pollScanTask(id), 800);
  }
  if (t.startScanTask && t.getScanTask) {
    if (scanTaskStatus) scanTaskStatus.hidden = true;
    if (scanTaskPause) scanTaskPause.onclick = async () => {
      const task = state.scanTask; if (!task) return;
      try {
        const next = task.status === "paused" && t.resumeScanTask ? await t.resumeScanTask(task.id) : t.pauseScanTask ? await t.pauseScanTask(task.id) : task;
        state.scanTask = next; renderScanTaskStatus(next); beginScanPolling(next.id);
      } catch (e) { toast((e as Error).message, "err"); }
    };
    if (scanTaskCancel) scanTaskCancel.onclick = async () => {
      const task = state.scanTask; if (!task || !t.cancelScanTask) return;
      try { const next = await t.cancelScanTask(task.id); state.scanTask = next; renderScanTaskStatus(next); stopScanPoll(); updateScanGo(); }
      catch (e) { toast((e as Error).message, "err"); }
    };
    void t.listScanTasks?.().then((tasks) => {
      // 只恢复本页面发起并记住的扫描，避免把同一客户端上其他窗口/历史任务
      // 的路径和结果带进当前页面；任务 ID 已持久化，因此刷新仍可继续跟踪。
      const remembered = localStorage.getItem("javweb_scan_task_id");
      const task = remembered ? tasks.find((x) => x.id === remembered) : undefined;
      if (!task) return;
      state.scanTask = task;
      if (!scanPath.value.trim() && task.path) scanPath.value = task.path;
      renderScanTaskStatus(task);
      if (task.status === "done" && task.result) applyScanResult(task.result);
      else if (["queued", "running", "paused"].includes(task.status)) beginScanPolling(task.id);
    }).catch(() => {});
  }

  scanGo.onclick = async () => {
    const engine = engineSelect.value;
    const path = scanPath.value.trim();
    if (!engine || !path) return; // 0.2.53 需求①：批次在跑可发起新扫描（入口 disabled 判定已同步放开）
    if (engine === "auto") {
      const cands = (state.engines || []).filter((x) => x.online && x.enabled !== false);
      if (!cands.length) {
        toast("自动均衡没有可用服务（全部离线，或都没勾选「参与均衡」）", "err");
        return;
      }
      if (!cands.some((x) => x.has_key)) {
        toast("参与均衡的服务都未登记 API Key，请先在「服务设置」里登记", "err");
        return;
      }
    } else {
      const e = (state.engines || []).find((x) => x.name === engine);
      if (!e || !e.has_key) {
        toast("请先在「服务设置」里为这个服务登记 API Key，才能扫描", "err");
        return;
      }
    }
    if (platform.kind === "web" && /^[a-zA-Z]:[\\/]/.test(path)) {
      toast("这是浏览器电脑的本地路径（如 D:\\Videos）。「扫描目录」只能读客户端部署机上的目录（如 /media/jav）；要处理浏览器电脑上的文件夹，请用上方「选择文件夹」", "err");
      return;
    }
    scanGo.disabled = true;
    $("scan-results").hidden = false;
    $("scan-table").innerHTML = '<div class="muted small scan-loading">正在建立后台扫描任务…页面可以刷新，扫描不会丢失。</div>';
    setScanSubmitHidden(false);
    scanSubmit.disabled = true;
    try {
      if (t.startScanTask && t.getScanTask) {
        const task = await t.startScanTask(engine, path);
        state.scanTask = task;
        localStorage.setItem("javweb_scan_task_id", task.id);
        renderScanTaskStatus(task);
        beginScanPolling(task.id);
      } else {
        const d = await t.scan(engine, path);
        applyScanResult(d);
      }
    } catch (err) {
      $("scan-table").innerHTML = "";
      $("scan-results").hidden = true;
      setScanSubmitHidden(true);
      state.scanTask = null; renderScanTaskStatus(null);
      toast((err as Error).message, "err");
      updateScanGo();
    }
  };

  // 本页全选派生回写（0.2.53 需求②）：render 与全局「全选」共用（口径同 renderScanResults 表头块）
  function syncScanPageAll(): void {
    const pa = $("scan-table").querySelector("#scan-page-all") as HTMLInputElement | null;
    if (!pa) return;
    const items = scanViewItems();
    const PAGE = state.scanPageSize;
    const pages = Math.max(1, Math.ceil(items.length / PAGE));
    const pg = Math.min(Math.max(0, state.scanPage), pages - 1);
    const pageItems = items.slice(pg * PAGE, (pg + 1) * PAGE);
    const selPaths = pageItems.filter((i) => !i.too_small && !i.reconciled_job_id).map((i) => i.path);
    const nSel = selPaths.filter((p) => state.scanChecked.has(p)).length;
    pa.disabled = selPaths.length === 0;
    pa.indeterminate = nSel > 0 && nSel < selPaths.length;
    pa.checked = selPaths.length > 0 && nSel === selPaths.length;
  }

  function renderScanResults(d: ScanResult) {
    const items = scanViewItems();
    // 分类 tab（计数按全集；空分类隐藏，All 恒显；无结果整体隐藏）
    {
      const tabsEl = $("scan-tabs");
      if (state.scanItems.length) {
        const counts: Record<string, number> = { "no-sub": 0, "has-sub": 0, small: 0, unwritten: 0 };
        for (const i of state.scanItems) counts[scanCatOf(i)]++;
        for (const i of state.scanItems) if (i.reconciled_job_id) counts.unwritten++;
        const defs: Array<[typeof state.scanFilter, string]> =
          [["all", "全部"], ["no-sub", "无字幕"], ["has-sub", "已有字幕"], ["small", "过小"], ["unwritten", "已生成未落盘"]];
        tabsEl.innerHTML = defs
          .filter(([k]) => k === "all" || counts[k] > 0)
          .map(([k, label]) =>
            `<button type="button" class="scan-tab${state.scanFilter === k ? " on" : ""}" data-f="${k}">${label} ${k === "all" ? state.scanItems.length : counts[k]}</button>`)
          .join("");
        tabsEl.hidden = false;
        tabsEl.querySelectorAll<HTMLButtonElement>("button.scan-tab").forEach((b) => {
          b.onclick = () => {
            state.scanFilter = (b.dataset.f as typeof state.scanFilter) || "all";
            state.scanPage = 0;
            if (state.lastScan) renderScanResults(state.lastScan);
          };
        });
      } else {
        tabsEl.hidden = true;
        tabsEl.innerHTML = "";
      }
    }
    if (state.scanMapped) {
      $("scan-mapped").hidden = false;
      $("scan-mapped").textContent =
        (platform.kind === "desktop" ? "已扫描实际路径：" : "已扫描映射后的实际路径：")
        + state.scanResolvedPath;
    } else {
      $("scan-mapped").hidden = true;
    }
    if (!items.length) {
      $("scan-table").innerHTML = state.scanItems.length
        ? '<div class="muted small">该分类下没有文件，可切到上方其它 tab</div>'
        : '<div class="muted small">没有找到符合条件的视频文件。可到「设置 → 客户端 → 扫描规则」调整扩展名'
          + (platform.kind === "web"
            ? "；要处理浏览器电脑上的文件夹请用上方「选择文件夹」"
            : "；路径需被所选服务可读（本地服务可填 D:\\Videos 等本机路径）") + "）</div>";
      renderScanPager(0);
    } else {
      const PAGE = state.scanPageSize;
      const pages = Math.max(1, Math.ceil(items.length / PAGE));
      const pg = Math.min(Math.max(0, state.scanPage), pages - 1);
      const pageItems = items.slice(pg * PAGE, (pg + 1) * PAGE);
      $("scan-table").innerHTML = `
      <table class="scan-table">
        <thead><tr><th class="col-check"><input type="checkbox" id="scan-page-all" aria-label="本页全选" title="勾选本页全部可选项（过小 / 已生成未落盘项需手动勾选）"></th><th>文件</th><th class="col-size">大小</th><th class="col-sub">字幕</th></tr></thead>
        <tbody>
          ${pageItems.map((i) => {
            const langs = (i.embedded_langs || []).join("/") || "—";
            let subCell = i.subtitle_status === "external"
              ? `<span class="tag subtag" title="${esc(i.subtitle || "")}">外部 srt</span><button type="button" class="srt-pv" data-srt="${esc(i.subtitle ? siblingOf(i.path, i.subtitle) : "")}" title="预览字幕内容">预览</button>`
              : i.subtitle_status === "named"
              ? `<span class="tag subtag" title="文件名含标记 ${esc(i.name_sub_token || "")}，按规则视为已压字幕（可在「设置 → 客户端 → 扫描规则」改判）">标记（名）</span>`
              : i.subtitle_status === "embedded"
              ? `<span class="tag subtag warn" title="普通扫描不会读取视频内容；如需确认内嵌字幕，请单独发起检查">内嵌字幕（需单独检查）</span>`
              : i.name_no_sub
              ? `<span class="tag subtag ok" title="文件名含标记 ${esc(i.name_no_sub_token || "")}，按规则视为无字幕版（可在「设置 → 客户端 → 扫描规则」改判）">无字幕（名）</span>`
              : '<span class="muted" title="普通扫描不会读取视频内容">未检查</span>';
            if (i.reconciled_job_id) {
              // 0.2.47 需求1：对账命中 → 前置 tag（服务/任务号供核对，防同名误配）+ desktop 回写按钮
              subCell = `<span class="tag subtag warn" title="已匹配完成任务（服务 ${esc(i.reconciled_engine || "—")} · 任务 ${esc(i.reconciled_job_id)}）：字幕已生成但未落盘到影片旁，可直接回写，无需重新生成">已生成未落盘</span>`
                + (platform.kind === "desktop"
                  ? `<button type="button" class="srt-pv scan-wb" data-path="${esc(i.path)}" title="把该已完成任务的结果写回影片同目录（已有 srt 不覆盖）">回写</button>`
                  : "");
            }
            return `
            <tr class="${i.has_subtitle ? "has-sub" : ""}${i.too_small ? " too-small" : ""}">
              <td class="col-check"><input type="checkbox" data-path="${esc(i.path)}"${state.scanChecked.has(i.path) ? " checked" : ""}></td>
              <td class="scan-name mono" title="${esc(i.path)}">${esc(i.name)}${i.too_small ? '<span class="tag tinytag" title="低于「忽略小于」阈值，不默认选中；可手动勾选提交">过小</span>' : ""}</td>
              <td class="col-size mono muted">${fmtSize(i.size)}</td>
              <td class="col-sub">${subCell}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`;
      $("scan-table").querySelectorAll("input[type=checkbox]").forEach((cb) => {
        const input = cb as HTMLInputElement;
        if (input.id === "scan-page-all") return; // 0.2.53 需求②：表头本页全选走独立绑定
        input.onchange = () => {
          if (input.checked) state.scanChecked.add(input.dataset.path || "");
          else state.scanChecked.delete(input.dataset.path || "");
          updateScanSummary();
          syncScanPageAll(); // 0.2.53 需求②：行级勾选不重渲染，表头框须重派生
        };
      });
      // 本页全选（0.2.53 需求②）：只作用「当前页 ∩ 当前视图域 ∩ 可选项」（视图域已由 scanViewItems 过滤）
      {
        const pa = $("scan-table").querySelector("#scan-page-all") as HTMLInputElement | null;
        if (pa) {
          const selPaths = pageItems.filter((i) => !i.too_small && !i.reconciled_job_id).map((i) => i.path);
          syncScanPageAll();
          pa.onchange = () => {
            if (pa.checked) for (const p of selPaths) state.scanChecked.add(p);
            else for (const p of selPaths) state.scanChecked.delete(p);
            if (state.lastScan) renderScanResults(state.lastScan);
          };
        }
      }
      renderScanPager(items.length);
    }
    $("scan-results").hidden = false;
    setScanSubmitHidden(false);
    updateScanSummary(d.truncated);
  }

  // 扫描结果翻页（大量文件场景；勾选态全局维护，与当前页无关）
  function renderScanPager(total: number) {
    const el = $("scan-pager");
    const pages = Math.max(1, Math.ceil(total / state.scanPageSize));
    if (pages <= 1) { el.hidden = true; el.innerHTML = ""; return; }
    const pg = Math.min(Math.max(0, state.scanPage), pages - 1);
    const go = (next: number) => {
      const clamped = Math.min(Math.max(0, next), pages - 1);
      if (clamped === state.scanPage) return;
      state.scanPage = clamped;
      if (state.lastScan) renderScanResults(state.lastScan);
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };
    el.innerHTML = `
      <button type="button" class="pg-btn txt" id="spg-prev"${pg === 0 ? " disabled" : ""}>← 上一页</button>
      <span class="pg-info mono">第 ${pg + 1} / ${pages} 页 · 共 ${total} 个文件</span>
      <button type="button" class="pg-btn txt" id="spg-next"${pg >= pages - 1 ? " disabled" : ""}>下一页 →</button>` +
      `<select id="spg-size" class="pg-size" title="扫描列表每页行数" aria-label="每页行数">${PAGE_SIZE_OPTS}</select>`;
    el.hidden = false;
    (el.querySelector("#spg-prev") as HTMLButtonElement).onclick = () => go(pg - 1);
    (el.querySelector("#spg-next") as HTMLButtonElement).onclick = () => go(pg + 1);
    const sizeSel = el.querySelector("#spg-size") as HTMLSelectElement;
    sizeSel.value = String(state.scanPageSize);
    sizeSel.onchange = () => {
      state.scanPageSize = Number(sizeSel.value) || 10;
      localStorage.setItem("javweb_scan_pagesize", String(state.scanPageSize));
      state.scanPage = 0;
      if (state.lastScan) renderScanResults(state.lastScan);
    };
  }

  function updateScanSummary(truncated?: boolean) {
    const n = state.scanChecked.size;
    const total = state.scanItems.length;
    const nSub = state.scanItems.filter((i) => i.has_subtitle).length;
    const nSmall = state.scanItems.filter((i) => i.too_small && !state.scanChecked.has(i.path)).length;
    const nUnwritten = state.scanItems.filter((i) => i.reconciled_job_id).length;
    let text = total ? `已选 ${n} / ${total}` : "";
    if (nSub) text += ` · ${nSub} 个已有字幕默认不勾选`;
    if (nSmall) text += ` · ${nSmall} 个过小未选`;
    if (nUnwritten) text += ` · ${nUnwritten} 个已生成未落盘默认不勾选`;
    text += (text ? " · " : "") + "内嵌字幕未检查（不会触发网盘下载）";
    if (truncated) text += (text ? " · " : "") + "列表已截断（仅前 5000 项）";
    $("scan-count").textContent = text;
    const button = scanSubmit;
    button.disabled = n === 0 || !engineSelect.value; // 0.2.53 需求①：批次在跑可提交扫描
    button.innerHTML = "&#9654; 生成字幕（已选择 " + n + " 项）";
    // 「回写所选」：desktop-only；已选中 ∩ 已生成未落盘 ≥1 才可点（回写不重跑生成）
    const wbBtn = $("scan-writeback") as HTMLButtonElement;
    if (platform.kind === "desktop") {
      const selUnwritten = state.scanItems.filter((i) => i.reconciled_job_id && state.scanChecked.has(i.path)).length;
      wbBtn.hidden = nUnwritten === 0;
      wbBtn.disabled = selUnwritten === 0 || state.busy;
      wbBtn.innerHTML = `&#8617; 回写所选（${selUnwritten}）`;
    } else {
      wbBtn.hidden = true;
    }
    // 「全选」按当前分类 tab 视图域：只覆盖视图内非「过小」「已生成未落盘」文件（两者只能手动勾选）
    const selectable = scanViewSelectable();
    scanSelectAll.checked = selectable.length > 0
      && selectable.every((i) => state.scanChecked.has(i.path));
    scanSelectAll.disabled = selectable.length === 0; // 「过小」tab / 空视图：全选不可用
  }

  scanSelectAll.onchange = (ev) => {
    const checked = (ev.target as HTMLInputElement).checked;
    // 视图域全选：勾选=加视图内非过小项（保留其它 tab 已选项）；取消=只减视图项
    const view = new Set(scanViewItems().map((i) => i.path));
    if (checked) {
      for (const i of state.scanItems) if (view.has(i.path) && !i.too_small && !i.reconciled_job_id) state.scanChecked.add(i.path);
    } else {
      for (const p of [...state.scanChecked]) if (view.has(p)) state.scanChecked.delete(p);
    }
    $("scan-table").querySelectorAll("input[type=checkbox]")
      .forEach((cb) => {
        const input = cb as HTMLInputElement;
        if (input.id === "scan-page-all") return; // 0.2.53 需求②：表头框由 renderScanResults 回写
        input.checked = state.scanChecked.has(input.dataset.path || "");
      });
    updateScanSummary();
    syncScanPageAll(); // 0.2.53 需求②：不重渲染路径也要重派生表头框
  };

  scanSubmit.onclick = async () => {
    const engine = engineSelect.value;
    const files = [...state.scanChecked];
    if (!engine || !files.length) return; // 0.2.53 需求①：批次在跑可提交扫描
    // 0.2.53 需求③：本主任务本机提音轨并发（分组循环前捕获一次，desktop/web 两构造点共用）
    const scanExtractWorkers = parseExtractWorkers(($("scan-extract-workers") as HTMLInputElement).value);
    // 已有字幕确认：所选含字幕文件（外部 srt / 内嵌轨 / 文件名 C 版）须用户确认
    const subItems = state.scanItems.filter(
      (i) => state.scanChecked.has(i.path) && i.has_subtitle,
    );
    if (subItems.length) {
      const cnt = (st: string) => subItems.filter((i) => i.subtitle_status === st).length;
      const parts = [
        cnt("external") ? `外部 srt ${cnt("external")}` : "",
        cnt("embedded") ? `内嵌轨 ${cnt("embedded")}` : "",
        cnt("named") ? `标记（名） ${cnt("named")}` : "",
      ].filter(Boolean).join("、");
      const ok = window.confirm(
        `所选 ${subItems.length} 个文件已检测到字幕（${parts}）。\n`
        + "继续将照常生成字幕并回写本机；影片旁已有同名 .zh.srt 时不会覆盖"
        + "（标记为「字幕已存在」）。\n是否继续生成？",
      );
      if (!ok) return;
    }
    const subStatus: Record<string, string> = {};
    for (const i of subItems) subStatus[i.path] = i.subtitle_status || "embedded";
    scanSubmit.disabled = true;
    // 0.2.52 M1：按盘拆 batch——按 diskKeyOf(扫描路径) 分组，每组独立 batch + 逐组提交/回退；
    // 单组（Linux 单挂载常态）label 维持现状口径（扫描目录名），零噪音。
    const groups = groupByDisk(files, (p) => diskKeyOf(p), scanPathDirName);
    const multi = groups.length > 1;
    // 分组循环前预捕获 name/size：runScanQueue 内部 clearScanUi 会清空 state.scanItems，
    // 第二组起再查即空（size 丢失会误导 effectiveMode 判 local）
    const fileMeta = new Map<string, { name: string; size: number }>();
    for (const p of files) {
      const it = state.scanItems.find((i) => i.path === p);
      fileMeta.set(p, { name: it ? it.name : p.split(/[\\/]/).pop() || p, size: it ? it.size : 0 });
    }
    try {
      if (platform.kind === "desktop") {
        // desktop（10-18-javscribe-0246 B）：auto / 显式引擎统一实时派发队列——提交时刻实时选机
        //（受 queue_cap 闸），400 候选耗尽回退本机提取上传；主任务 + N 子行可暂停/取消。
        // 0.2.52 M1：逐组起泵；400 回退 catch 按组复用本组 batch（回退不断父任务，不变式按组成立）
        for (const g of groups) {
          const batch = { id: genBatchId(), label: multi ? multiGroupLabel(g) : batchLabelForScan(), extractWorkers: scanExtractWorkers };
          try {
            runScanQueue(g.items, engine, batch, subStatus, fileMeta);
          } catch (e) {
            if (e instanceof TransportError && e.code === "not-found") {
              toast(engine === "auto"
                ? "所选服务读不到这些本机路径，已改为本机提取后上传（自动均衡分发）"
                : "所选服务读不到这些本机路径，已改为本机提取后上传到该服务", "");
              dispatchLocalScanPaths(engine, g.items, batch, fileMeta);
            } else {
              throw e; // 非 400 异常：抛给外层 catch 统一 toast
            }
          }
        }
        return;
      }
      // web：原样透传（含 "auto"——工作台 v0.2.11+ 已支持 per-task auto，派发时刻 pick_engine）；
      // 0.2.52 M1：逐组透传（单挂载自然退化单组，行为不变）；400 回退按组复用本组 batch
      for (const g of groups) {
        const batch = { id: genBatchId(), label: multi ? multiGroupLabel(g) : batchLabelForScan(), extractWorkers: scanExtractWorkers };
        try {
          const d = await t.submitScan(engine, g.items, subStatus, batch);
          if (d.skipped && d.skipped.length) {
            const names = d.skipped.slice(0, 3).join("、") + (d.skipped.length > 3 ? ` 等 ${d.skipped.length} 项` : "");
            toast(`已跳过 ${d.skipped.length} 个在跑/排队的重复任务：${names}`, "");
          }
          if (d.files > 0) {
            toast(d.jobId
              ? `已入队 ${d.files} 项 → 任务 ${d.jobId}`
              : `已入队 ${d.files} 项（本机扫描）→ 任务表中跟进`, "ok");
          }
        } catch (e) {
          if (e instanceof TransportError && e.code === "not-found") {
            toast(engine === "auto"
              ? "所选服务读不到这些本机路径，已改为本机提取后上传（自动均衡分发）"
              : "所选服务读不到这些本机路径，已改为本机提取后上传到该服务", "");
            dispatchLocalScanPaths(engine, g.items, batch, fileMeta);
            continue;
          }
          throw e;
        }
      }
      clearScanUi();
      refresh();
      webShowView("jobs"); // 提交即进任务看板
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      updateScanSummary();
    }
  };

  // 「回写所选」（desktop-only；web 该按钮恒 hidden，接线无副作用）：
  // 勾选 ∩ 「已生成未落盘」项 → 逐项串行回写（回写不置 state.busy，逐项 toast 自行门控）
  const scanWbBtn = $("scan-writeback") as HTMLButtonElement;
  scanWbBtn.onclick = async () => {
    if (platform.kind !== "desktop" || state.busy) return;
    const paths = [...state.scanChecked];
    if (!state.scanItems.some((i) => paths.includes(i.path) && i.reconciled_job_id)) return;
    await scanWriteBackMany(paths);
  };

  // ---------- 时钟 ----------
  function tick() {
    $("clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }
  tick();
  setInterval(tick, 1000);

  // ---------- 文件夹监控（仅 desktop 形态：main 进程轮询检测，这里排队 + 串行派发） ----------
  // web 形态：#watch-panel 保持 hidden、不接线（web 100% 不变硬约束）
  if (platform.kind === "desktop") {
    interface WatchBridge {
      state(): Promise<WatchState>;
      set(q: { enabled?: boolean; path?: string; pollMs?: number }): Promise<{ ok: boolean; error?: string; state?: WatchState }>;
      pickDir(): Promise<string | null>;
      arm(): Promise<WatchState>;
      markProcessed(pp: string): Promise<void>;
      onState(cb: (st: WatchState) => void): () => void;
      onCandidate(cb: (c: WatchCandidate) => void): () => void;
    }
    const watchPanel = $("watch-panel");
    const wBridge = (): WatchBridge | null =>
      (window as unknown as { javDesktop?: { watch?: WatchBridge } }).javDesktop?.watch ?? null;
    if (watchPanel) {
      const b = wBridge();
      if (b) {
        watchPanel.hidden = false;
        const watchPath = $("watch-path") as HTMLInputElement;
        const watchPick = $("watch-pick");
        const watchToggle = $("watch-toggle") as HTMLButtonElement;
        const watchStatus = $("watch-status");
        const watchLamp = $("watch-lamp");
        let wState: WatchState | null = null;
        let lastStatusHtml = "";
        const watchQueue: WatchCandidate[] = [];
        let watchDispatchingPath: string | null = null;

        function watchRender() {
          const st = wState;
          watchLamp.classList.toggle("on", !!st?.on);
          watchLamp.classList.toggle("err", !!st?.lastError);
          if (!st) return;
          watchToggle.textContent = st.enabled ? "停止监听" : "开始监听";
          watchToggle.disabled = !st.path;
          if (watchPath.value !== st.path) watchPath.value = st.path;
          const parts: string[] = [];
          if (st.on) {
            parts.push(`监听中 · 每 ${Math.round(st.pollMs / 1000)}s`);
            if (st.processed) parts.push(`已处理 ${st.processed}`);
            if (st.lastScan) {
              parts.push(`上次扫描 <span id="watch-lastscan">${new Date(st.lastScan).toLocaleTimeString("zh-CN", { hour12: false })}</span>`);
            }
          } else {
            parts.push(st.path ? "未监听" : "未监听 · 请先选择文件夹");
          }
          if (st.lastError) parts.push(`监听出错：${esc(st.lastError)}`);
          if (watchQueue.length) {
            parts.push(`等待 ${watchQueue.length}`);
            if (!engineSelect.value) parts.push("未选择服务");
          }
          if (watchDispatchingPath) {
            parts.push(`<b>生成中：${esc(watchDispatchingPath.split("/").pop() || watchDispatchingPath)}</b>`);
          }
          const html = parts.join(" · ");
          if (html !== lastStatusHtml) {
            lastStatusHtml = html;
            watchStatus.innerHTML = html;
          }
          watchStatus.hidden = false;
          watchStatus.className = "muted small watch-status" + (st.lastError ? " err" : "");
        }

        const watchPumpImpl = (): void => {
          if (state.busy || watchDispatchingPath) return;
          const it = watchQueue[0];
          if (!it) { watchRender(); return; }
          let engine = engineSelect.value;
          if (!engine) { watchRender(); return; } // 未选服务：留队列等（onchange / 5s 轮询会再触发）
          if (engine === "auto") {
            const real = resolveAutoEngine();
            if (!real || !canDispatch(real)) return; // 无候选/全满：留队列等（5s 安全网重触发）
            engine = real;
          } else if (!canDispatch(engine)) {
            return; // S4 在途封顶：留队列等（refresh / watchPump 5s 安全网重触发）
          }
          watchQueue.shift();
          watchDispatchingPath = it.path;
          state.busy = true;
          updateGo();
          watchRender();
          // 带 _localPath 的 File shim：main 进程本机 ffmpeg 提取 + 流式上传（与「选择文件夹」同通路）
          const f = new File([new Blob()], it.name) as FolderFile;
          Object.defineProperty(f, "size", { value: it.size, configurable: true });
          f._localPath = it.path;
          preparePipeline("监听");
          // 预登记：上传请求发出前先持久化登记（受理后 rekey 正式键）
          registerWriteBack(preKeyOf(engine, it.name), { engine, videoName: it.name, dirHandle: null, videoPath: it.path });
          dispatchTracked(f, engine, "监听 · ").then(([ok, d]) => {
            watchDispatchingPath = null;
            state.busy = false;
            updateGo();
            const up = d as UploadStatus;
            if (ok && up.job_id) {
              const k = engine + "|" + up.job_id;
              rekeyWriteBack(preKeyOf(engine, it.name), k);
              registerWriteBack(k, { engine, videoName: it.name, dirHandle: null, videoPath: it.path }); // 完成后强制写回影片同目录（不受 autoSave 门控）
              void b.markProcessed(it.path).catch(() => {});
              toast(`监听 · ${it.name} 已提交 → 任务 ${up.job_id}`, "ok");
            } else {
              void b.markProcessed(it.path).catch(() => {}); // 失败也标记，防无限重试
              toast(`监听 · ${it.name}：${(d as { error?: string }).error || "提交失败"}`, "err");
            }
            refresh();
            watchPumpImpl();
          }).catch(() => {
            watchDispatchingPath = null;
            state.busy = false;
            updateGo();
            watchRender();
            watchPumpImpl();
          });
        }
        watchPump = watchPumpImpl;
        ccWatchCtl = {
          state: () => wState,
          set: async (on, pth) => {
            const r = await b.set(on ? { enabled: true, path: pth } : { enabled: false });
            if (r.state) { wState = r.state; watchRender(); watchPumpImpl(); } // 面板与 tab 同源刷新
            return r;
          },
          pickDir: async () => {
            const p = await b.pickDir();
            if (p) { watchPath.value = p; watchToggle.disabled = false; watchRender(); }
            return p;
          },
        };

        watchPath.oninput = () => {
          watchToggle.disabled = !watchPath.value.trim();
        };
        watchPick.onclick = async () => {
          const p = await b.pickDir();
          if (p) {
            watchPath.value = p;
            watchToggle.disabled = false;
            watchRender();
          }
        };
        watchToggle.onclick = async () => {
          if (state.busy) return;
          const wantOn = !wState?.enabled;
          const r = await b.set(wantOn
            ? { enabled: true, path: watchPath.value.trim() }
            : { enabled: false });
          if (!r.ok) {
            toast(r.error || "监听设置失败", "err");
            watchRender();
            return;
          }
          if (r.state) {
            wState = r.state;
            watchRender();
            watchPumpImpl();
          }
        };
        b.onState((st) => {
          wState = st;
          watchRender();
          watchPumpImpl(); // 路径/可用性变化可能解锁消费
        });
        b.onCandidate((c) => {
          if (c.path === watchDispatchingPath) return;
          if (!watchQueue.some((q) => q.path === c.path)) watchQueue.push(c);
          watchRender();
          watchPumpImpl();
        });
        void b.state().then((st) => { wState = st; watchRender(); }).catch(() => {});
        void b.arm().then((st) => { wState = st; watchRender(); watchPumpImpl(); }).catch(() => {});
      }
    }
  }

  // desktop 形态：接 main 进程更新状态机（dev 形态 state 恒 disabled → chip 恒隐藏）
  if (platform.kind === "desktop") {
    const b = upBridge();
    if (b) {
      b.onState((s2) => {
        upState = s2;
        renderUpChip();
        renderUpSidebar();
        if (upModalOpen) openUpdateDesktop(); // 状态推进（下载进度等）时重建弹窗内容
        if (s2.status === "error" && upManualCheck) {
          upManualCheck = false;
          toast(s2.error || "检查更新失败", "err");
        }
        // 侧边栏手动检查出结果：有新版本 → 开弹窗；已是最新 → toast；error 由上方统一 toast（不重复）
        if (asideCheckPending && s2.status !== "checking") {
          asideCheckPending = false;
          if (s2.status === "available" || s2.status === "downloading" || s2.status === "downloaded") {
            openUpdateDesktop();
          } else if (s2.status === "idle") {
            const cur = (($("foot-ver").textContent || "").trim());
            toast("已是最新版 " + (cur || ""), "ok");
          }
        }
      });
      void b.state().then((s2) => { upState = s2; renderUpChip(); }).catch(() => {});
      void b.getSettings().then((s2) => { upSettings = s2; }).catch(() => {});
    }
  }

  // desktop 形态：本地服务端集成（同目录服务程序自动拉起 + 登记「本地服务端」）
  // web 形态：#local-serve-* 恒 hidden、不接线（web 100% 不变硬约束）
  if (platform.kind === "desktop") {
    const lsStatus = $("local-serve-status");
    const lsHint = $("local-serve-hint");
    if (lsStatus && lsHint) {
      const b = (window as unknown as {
        javDesktop?: { localServe?: { state(): Promise<LocalServeState>; onState(cb: (s: LocalServeState) => void): () => void } };
      }).javDesktop?.localServe ?? null;
      if (b) {
        const lsLamp = $("local-serve-lamp");
        const lsText = $("local-serve-status-text");
        let ls: LocalServeState | null = null;
        let lastHtml = "";
        function lsRender() {
          const st = ls;
          if (!st || !st.detected) {
            lsStatus.classList.remove("show");
            lsStatus.hidden = true;
            lsHint.hidden = false;
            lastHtml = "";
            return;
          }
          lsHint.hidden = true;
          lsStatus.hidden = false;
          lsStatus.classList.add("show");
          if (lsLamp) {
            lsLamp.classList.toggle("on", st.running);
            lsLamp.classList.toggle("err", !st.running && !!st.error);
          }
          const txt = st.running
            ? `本地服务端运行中 · <span class="mono">${esc(st.url)}</span> · 已登记为「本地服务端」`
            : st.starting
              ? `本地服务端启动中…（${esc(st.url)}）`
              : `本地服务端未运行 · ${esc(st.url)}${st.error ? ` · ${esc(st.error)}` : ""}`;
          if (lsText && txt !== lastHtml) {
            lastHtml = txt;
            lsText.innerHTML = txt;
          }
          lsStatus.classList.toggle("err", !st.running && !!st.error);
        }
        b.onState((st) => {
          const wasRunning = ls?.running === true;
          ls = st;
          lsRender();
          if (st.running && !wasRunning) refresh(); // 「本地服务端」卡片出现后刷一次引擎列表
        });
        void b.state().then((st) => { ls = st; lsRender(); }).catch(() => {});
      }
    }
  }

  // ---------- 桌面壳：侧边栏更新块（自动更新勾选 + 检查更新按钮；dev 态整块隐藏） ----------
  if (platform.kind === "desktop") {
    const navUpWrap = $("nav-up") as HTMLElement | null;
    if (navUpWrap) {
      const b = upBridge();
      const chk = $("up-auto") as HTMLInputElement | null;
      const btn = $("up-check") as HTMLButtonElement | null;
      if (b) {
        void b.getSettings().then((s2) => {
          upSettings = s2;
          if (chk) chk.checked = s2.enabled;
        }).catch(() => {});
      }
      if (chk) {
        chk.onchange = async () => {
          const br = upBridge();
          if (!br) return;
          const next = { enabled: chk.checked, mirror: upSettings?.mirror || "", proxy: upSettings?.proxy || "" };
          try {
            upSettings = await br.putSettings(next);
            toast(chk.checked ? "已启用启动时自动检查更新" : "已关闭启动时自动检查更新", "ok");
          } catch (e2) {
            chk.checked = upSettings?.enabled ?? chk.checked;
            toast((e2 as Error).message, "err");
          }
        };
      }
      if (btn) {
        btn.onclick = () => {
          const st = upState;
          if (st.status === "checking") return;
          if (st.status === "idle" || st.status === "error") {
            asideCheckPending = true;
            upCheckDesktop(true);
            return;
          }
          if (st.status === "available" || st.status === "downloading" || st.status === "downloaded") {
            openUpdateDesktop();
          }
        };
      }
    }
    renderUpSidebar();
  }

  // ---------- 设置 tab（客户端/服务端 子 tab：本机并发 + 桌面专属卡；服务端 = 通用/单端配置） ----------
  // 每次激活重渲染（与服务设置弹窗一致：每次打开取最新值）；ccViewSeq 丢弃过期异步结果
  function ccWatchStatusText(st: WatchState | null): string {
    if (!st) return "监听未启用";
    const parts: string[] = [];
    if (st.on) {
      parts.push(`监听中 · 每 ${Math.round(st.pollMs / 1000)}s`);
      if (st.processed) parts.push(`已处理 ${st.processed}`);
    } else {
      parts.push(st.path ? "未监听" : "未监听 · 请先选择文件夹");
    }
    if (st.lastError) parts.push(`监听出错：${st.lastError}`);
    return parts.join(" · ");
  }

  function ccWatchRenderBits(st: WatchState | null): void {
    const pathEl = $("cc-watch-path");
    if (pathEl) {
      pathEl.textContent = st?.path || "未选择文件夹";
      pathEl.classList.toggle("muted", !st?.path);
    }
    const statusEl = $("cc-watch-status");
    if (statusEl) statusEl.textContent = ccWatchStatusText(st);
    const toggle = $("cc-watch-toggle") as HTMLButtonElement | null;
    if (toggle) {
      toggle.textContent = st?.enabled ? "停止监听" : "开始监听";
      toggle.disabled = !st?.path;
    }
  }

  let ccViewSeq = 0;
  async function renderCcView(): Promise<void> {
    const body = $("cc-body");
    if (!body) return;
    const seq = ++ccViewSeq;
    body.innerHTML = '<div class="muted small">加载中…</div>';
    // 并发设置：web = /api/client-config；desktop = IPC（userData/client-config.json 独立落盘）
    let cc: ClientConfig | null = null;
    let ccErr = "";
    if (t.getClientConfig) {
      try { cc = await t.getClientConfig(); } catch (e) { ccErr = (e as Error).message; }
    }
    // 桌面专属数据源：更新设置（与更新弹窗高级区同源 settings.json）+ 文件夹监听（与派单页监听面板同源 watch.json）
    let upCfg: UpdateSettings | null = upSettings;
    let ws: WatchState | null = null;
    if (platform.kind === "desktop") {
      if (!upCfg) {
        try {
          const b = upBridge();
          upCfg = b ? await b.getSettings() : null;
          if (upCfg) upSettings = upCfg;
        } catch { upCfg = null; }
      }
      ws = ccWatchCtl ? ccWatchCtl.state() : null;
    }
    if (seq !== ccViewSeq) return; // 视图已切走，丢弃过期渲染
    // 扫描规则卡取值：client config 已有 scan_* 键则直接展示；无则一次性静默预填（不落盘）
    // —— 旧扫描面板 localStorage（用完删 key）→ 第一个可响应引擎 /config scan.* → 内置默认
    const SCAN_KEYS = ["scan_video_exts", "scan_subtitle_patterns", "scan_recurse",
      "scan_min_size_mb", "scan_has_sub_tokens", "scan_no_sub_tokens"] as const;
    const hasScan = !!cc && SCAN_KEYS.some((k) => k in cc);
    let scanVals = { exts: "", pats: "", recurse: true, min: 200, hasTok: "c", noTok: "" };
    if (cc && hasScan) {
      scanVals = {
        exts: (cc.scan_video_exts || []).join(","),
        pats: (cc.scan_subtitle_patterns || []).join(","),
        recurse: cc.scan_recurse ?? true,
        min: cc.scan_min_size_mb ?? 200,
        hasTok: (cc.scan_has_sub_tokens || []).join(","),
        noTok: (cc.scan_no_sub_tokens || []).join(","),
      };
    } else {
      const rawMin = localStorage.getItem("javweb_scan_minsize");
      localStorage.removeItem("javweb_scan_minsize");
      const v = rawMin != null && rawMin.trim() !== "" ? Number(rawMin) : NaN;
      scanVals.min = Number.isFinite(v) && v >= 0 ? v : 200;
      const nc = localStorage.getItem("javweb_scan_namingc");
      localStorage.removeItem("javweb_scan_namingc");
      if (nc === "has_sub") { scanVals.hasTok = "c"; scanVals.noTok = ""; }
      else if (nc === "no_sub") { scanVals.hasTok = ""; scanVals.noTok = "c"; }
      else if (nc === "off") { scanVals.hasTok = ""; scanVals.noTok = ""; }
      for (const e of state.engines) {
        try {
          const items = await t.getConfig(e.name);
          const val = (p: string) => (items.find((x) => x.path === p) || {}).value;
          const ve = val("scan.video_exts"), sp = val("scan.subtitle_patterns"), rc = val("scan.recurse");
          if (Array.isArray(ve) && ve.length) scanVals.exts = ve.map(String).join(",");
          if (Array.isArray(sp) && sp.length) scanVals.pats = sp.map(String).join(",");
          if (typeof rc === "boolean") scanVals.recurse = rc;
          break;
        } catch { /* 试下一个引擎 */ }
      }
      if (!scanVals.exts) scanVals.exts = VIDEO_EXTS.join(",");
      if (!scanVals.pats) scanVals.pats = LOCAL_SUB_PATTERNS.join(",");
    }
    // 设置页 = 客户端 / 服务端两个子 tab（10-18-javscribe-0246 A）：服务端 pane 懒渲染（首次切入才拉配置）
    let html = `
    <div class="cc-subtabs" role="tablist">
      <button type="button" class="cfg-tab on" role="tab" data-cctab="client" aria-selected="true">客户端</button>
      <button type="button" class="cfg-tab" role="tab" data-cctab="server" aria-selected="false">服务端</button>
    </div>
    <div class="cc-pane" data-pane="client">
    <div class="cc-cards">`;
    if (cc) {
      html += `
    <section class="cfg-sec cc-card" data-sec="ccfg-concurrency">
      <h4 class="cfg-sec-title">并发控制<span class="cfg-sec-desc">本机（客户端部署机）资源占用 · 保存后立即生效</span></h4>
      <div class="cfg-sec-body">
        <div class="cfg-row ccfg-row" data-base="${cc.extract_workers}">
          <span class="cfg-lab">音轨提取并发${helpIcon("本机（客户端部署机）同时运行 ffmpeg 提取音轨的数量。越大提取越快，但本机 CPU/IO 占用越高。封顶 1 ~ 8，保存后立即生效。")}</span>
          <input id="ccfg-extract_workers" type="number" min="1" max="8" value="${cc.extract_workers}" spellcheck="false" autocomplete="off"></div>
        <div class="cfg-row ccfg-row" data-base="${cc.queue_cap}">
          <span class="cfg-lab">转译并发（服务队列上限）${helpIcon("服务端逐条串行转译。此项为「同时在途任务数上限」≈ 服务队列深度，超出的任务在本机排队等待派发。调低可保护服务端内存/磁盘与队列稳定，也缩小服务重启时丢失排队任务的风险面。封顶 1 ~ 16，保存后立即生效。")}</span>
          <input id="ccfg-queue_cap" type="number" min="1" max="16" value="${cc.queue_cap}" spellcheck="false" autocomplete="off"></div>
        ${platform.kind === "desktop" ? `
        <div class="cfg-row ccfg-row" data-base="${cc.vram_free_min_gb}">
          <span class="cfg-lab">自动均衡空闲显存阈值（GB）${helpIcon("自动均衡选机：最近一次采样空闲显存低于此值的服务，不再接收新的 auto 派发（已派发任务不受影响）。单模型实例约占 5G 显存，设低于 5 可能让服务后起实例显存不足（服务端有显存预检与 OOM 自愈兜底）；设为 0 = 不按显存过滤、纯按在途最少派发（服务被其他程序占满显存时也有派发）。0 ~ 16，默认 5，保存后立即生效。")}</span>
          <input id="ccfg-vram_free_min_gb" type="number" min="0" max="16" step="1" value="${cc.vram_free_min_gb}" spellcheck="false" autocomplete="off"></div>` : ""}
      </div>
      <div class="ccfg-foot">
        <span class="cfg-foot-note">只保存在客户端本机，不影响服务端</span>
        <span id="ccfg-dirty" class="muted small">无改动</span>
        <span class="cfg-foot-actions"><button type="button" id="ccfg-save" class="btn" hidden>保存客户端设置</button></span>
      </div>
    </section>`;
    } else {
      html += `
    <section class="cfg-sec cc-card" data-sec="ccfg-concurrency">
      <h4 class="cfg-sec-title">并发控制<span class="cfg-sec-desc">本机（客户端部署机）资源占用 · 保存后立即生效</span></h4>
      <div class="set-note err"><div class="set-note-title">无法读取客户端并发设置</div>${esc(ccErr || "接口不可用")}</div>
    </section>`;
    }
    html += `
    <section class="cfg-sec cc-card" data-sec="ccfg-scan">
      <h4 class="cfg-sec-title">扫描规则<span class="cfg-sec-desc">本机目录扫描（${platform.kind === "desktop" ? "本机" : "工作台部署机"}）文件判定 · 对之后的扫描生效</span></h4>
      <div class="cfg-sec-body">
        <div class="cfg-row ccfg-row" data-base="${esc(scanVals.exts)}">
          <span class="cfg-lab">视频扩展名${helpIcon("参与本机目录扫描的扩展名（无点、逗号分隔）。默认 " + VIDEO_EXTS.join(",") + "。")}</span>
          <input id="cc-scan-exts" class="mono" type="text" value="${esc(scanVals.exts)}" spellcheck="false" autocomplete="off"></div>
        <div class="cfg-row ccfg-row" data-base="${esc(scanVals.pats)}">
          <span class="cfg-lab">已有字幕判定${helpIcon("影片同目录存在同名 + 该后缀的字幕文件即判为「已有字幕」。带点后缀、逗号分隔。默认 " + LOCAL_SUB_PATTERNS.join(",") + "。")}</span>
          <input id="cc-scan-pats" class="mono" type="text" value="${esc(scanVals.pats)}" spellcheck="false" autocomplete="off"></div>
        <div class="cfg-row ccfg-row" data-base="${scanVals.recurse ? "1" : "0"}">
          <label class="chk-row"><input type="checkbox" id="cc-scan-recurse"${scanVals.recurse ? " checked" : ""}><span>进入子目录</span></label></div>
        <div class="cfg-row ccfg-row" data-base="${scanVals.min}">
          <span class="cfg-lab">忽略小于（MB）${helpIcon("低于该大小的文件仍会列出但不默认选中（可显式勾选提交）。0 = 不按大小过滤。默认 200。")}</span>
          <input id="cc-scan-minsize" type="number" min="0" step="10" value="${scanVals.min}" spellcheck="false" autocomplete="off"></div>
        <div class="cfg-row ccfg-row" data-base="${esc(scanVals.hasTok)}">
          <span class="cfg-lab">疑似已压字幕标记${helpIcon("文件名 token（按 - _ . 空格等分隔）整词命中即视为已压字幕版（已内含字幕），命中才默认不选。逗号分隔，如 c、chs；大小写不敏感。默认 c。空 = 不识别。")}</span>
          <input id="cc-scan-has-tokens" class="mono" type="text" placeholder="空 = 不识别" value="${esc(scanVals.hasTok)}" spellcheck="false" autocomplete="off"></div>
        <div class="cfg-row ccfg-row" data-base="${esc(scanVals.noTok)}">
          <span class="cfg-lab">疑似无字幕标记${helpIcon("文件名 token 整词命中即显示「无字幕（名）」信息标（只提示、不拦截）。逗号分隔，如 c；大小写不敏感。空 = 不识别。")}</span>
          <input id="cc-scan-no-tokens" class="mono" type="text" placeholder="空 = 不识别" value="${esc(scanVals.noTok)}" spellcheck="false" autocomplete="off"></div>
      </div>
      <div class="ccfg-foot">
        <span class="cfg-foot-note">只保存在客户端本机；双列表同时命中时无字幕优先</span>
        <span id="cc-scan-dirty" class="muted small">无改动</span>
        <span class="cfg-foot-actions"><button type="button" id="cc-scan-save" class="btn" hidden>保存扫描规则</button></span>
      </div>
    </section>`;
    if (platform.kind === "desktop") {
      html += `
    <section class="cfg-sec cc-card" data-sec="ccfg-desktop-update">
      <h4 class="cfg-sec-title">桌面端更新<span class="cc-only-badge">仅桌面</span><span class="cfg-sec-desc">与「检查更新」弹窗高级区同源（settings.json）</span></h4>
      <div class="cfg-sec-body">
        <div class="cfg-row ccfg-row" data-base="${upCfg && upCfg.enabled ? "1" : "0"}">
        <label class="chk-row"><input type="checkbox" id="cc-up-enabled"${upCfg && upCfg.enabled ? " checked" : ""}><span>启动时自动检查更新</span></label></div>
        <div class="cfg-row ccfg-row" data-base="${esc(upCfg?.mirror || "")}"><span class="cfg-lab">自定义加速地址（URL 前缀，如 https://gh-proxy.example.com/；与内置 3 渠道自动择优，谁快用谁）</span>
        <input id="cc-up-mirror" class="mono" type="text" placeholder="留空仅用内置 3 渠道" value="${esc(upCfg?.mirror || "")}"></div>
        <div class="cfg-row ccfg-row" data-base="${esc(upCfg?.proxy || "")}"><span class="cfg-lab">更新代理（socks5://127.0.0.1:10808 或 http://127.0.0.1:7890；留空直连）</span>
        <input id="cc-up-proxy" class="mono" type="text" placeholder="留空直连 GitHub" value="${esc(upCfg?.proxy || "")}"></div>
      </div>
      <div class="ccfg-foot">
        <span class="cfg-foot-note">保存后立即生效（代理下次检查/下载即走新代理）</span>
        <span id="cc-up-dirty" class="muted small">无改动</span>
        <span class="cfg-foot-actions"><button type="button" id="cc-up-save" class="btn">保存更新设置</button></span>
      </div>
    </section>
    <section class="cfg-sec cc-card" data-sec="ccfg-desktop-watch">
      <h4 class="cfg-sec-title">文件夹监听<span class="cc-only-badge">仅桌面</span><span class="cfg-sec-desc">目录新视频自动排队生成字幕（与「生成字幕」页监听面板同源）</span></h4>
      <div class="cfg-sec-body">
        <div class="cfg-row"><span class="cfg-lab">监听目录</span>
        <div class="cc-watch-row"><span id="cc-watch-path" class="mono muted">${esc(ws?.path || "") || "未选择文件夹"}</span><button type="button" class="btn" id="cc-watch-pick">选择文件夹</button></div></div>
      </div>
      <div class="ccfg-foot">
        <span class="cfg-foot-note" id="cc-watch-status">${esc(ccWatchStatusText(ws))}</span>
        <span class="cfg-foot-actions"><button type="button" class="btn" id="cc-watch-toggle"${ws && ws.path ? "" : " disabled"}>${ws && ws.enabled ? "停止监听" : "开始监听"}</button></span>
      </div>
    </section>`;
    }
    html += "</div>"; // cc-cards
    html += `
    </div>
    <div class="cc-pane" data-pane="server" hidden>
      <div class="srv-bar">
        <span class="srv-bar-label">服务端</span>
        <select id="srv-sel">
          <option value="__all__">* 所有服务（通用设置）</option>
          ${state.engines.map((e) => `<option value="${esc(e.name)}">${esc(e.name)}（${e.online ? "在线" : "离线"} · v${esc(e.version || "—")}）</option>`).join("")}
        </select>
      </div>
      <div class="srv-note muted small" id="srv-note"></div>
      <div id="srv-body"><div class="muted small">（服务端设置懒加载：首次切入本 tab 时拉取）</div></div>
    </div>`;
    body.innerHTML = html;
    // 设置子 tab 切换：pane 显隐；服务端首次切入才懒渲染（避免无谓 getConfig）
    const ccSubTabs = Array.from(body.querySelectorAll<HTMLButtonElement>(".cc-subtabs .cfg-tab"));
    const ccPaneEls = Array.from(body.querySelectorAll<HTMLElement>(".cc-pane"));
    let srvRendered = false;
    for (const tb of ccSubTabs) {
      tb.onclick = () => {
        const isClient = (tb.dataset.cctab || "") === "client";
        for (const x of ccSubTabs) {
          x.classList.toggle("on", x === tb);
          x.setAttribute("aria-selected", x === tb ? "true" : "false");
        }
        for (const p of ccPaneEls) p.hidden = (p.dataset.pane || "client") !== (isClient ? "client" : "server");
        if (!isClient && !srvRendered) {
          srvRendered = true;
          const sel = $("srv-sel") as HTMLSelectElement | null;
          if (sel) renderSrv(sel.value);
        }
      };
    }
    const srvSel = $("srv-sel") as HTMLSelectElement | null;
    if (srvSel) {
      // 0.2.49 P6：切服务 = 整表单重渲染 —— 有未保存改动先确认；取消则回退下拉（与表单保持一致）
      srvSel.dataset.cur = srvSel.value;
      srvSel.onchange = () => {
        const sb = $("srv-body");
        if (sb?.querySelector(".cfg-row.dirty")
          && !window.confirm("当前服务设置未保存，切换将丢弃。继续？")) {
          srvSel.value = srvSel.dataset.cur || srvSel.value;
          return;
        }
        srvSel.dataset.cur = srvSel.value;
        renderSrv(srvSel.value);
      };
    }
    // 并发卡：改动追踪 + 独立保存（原弹窗卡片语义原样迁移）
    if (cc) {
      const rows = Array.from(body.querySelectorAll<HTMLElement>(".cc-card[data-sec=ccfg-concurrency] .ccfg-row"));
      const ccDirty = (): void => {
        let n = 0;
        for (const row of rows) {
          const ctl = row.querySelector("input") as HTMLInputElement;
          const changed = ctl.value !== (row.dataset.base ?? "");
          row.classList.toggle("dirty", changed);
          if (changed) n++;
        }
        const d = $("ccfg-dirty");
        if (d) { d.textContent = n ? `有 ${n} 项未保存` : "无改动"; d.classList.toggle("dirty-n", n > 0); }
        const b = $("ccfg-save");
        if (b) b.hidden = n === 0;
      };
      for (const row of rows) {
        const ctl = row.querySelector("input") as HTMLInputElement;
        ctl.addEventListener("input", ccDirty);
        ctl.addEventListener("change", ccDirty);
      }
      const saveBtn = $("ccfg-save") as HTMLButtonElement | null;
      if (saveBtn) saveBtn.onclick = async () => {
        const ew = parseInt(($("ccfg-extract_workers") as HTMLInputElement).value, 10);
        const qc = parseInt(($("ccfg-queue_cap") as HTMLInputElement).value, 10);
        const vfEl = $("ccfg-vram_free_min_gb") as HTMLInputElement | null;
        const vf = vfEl ? parseInt(vfEl.value, 10) : null;
        if (isNaN(ew) || ew < 1 || ew > 8) { toast("音轨提取并发需在 1 ~ 8 之间", "err"); return; }
        if (isNaN(qc) || qc < 1 || qc > 16) { toast("转译并发需在 1 ~ 16 之间", "err"); return; }
        if (vfEl && (isNaN(vf as number) || (vf as number) < 0 || (vf as number) > 16)) { toast("自动均衡空闲显存阈值需在 0 ~ 16 之间", "err"); return; }
        try {
          const payload: Record<string, unknown> = { extract_workers: ew, queue_cap: qc };
          if (vf !== null) payload.vram_free_min_gb = vf;
          await t.putClientConfig!(payload as unknown as import("../core/types").ClientConfig);
          // S4：保存成功才应用本端内存（R2：保存失败不落内存，下轮 refresh 读回自愈）
          state.ccfg = normalizeClientConfig({
            ...(state.ccfg || {}), extract_workers: ew, queue_cap: qc,
            ...(vf !== null ? { vram_free_min_gb: vf } : {}),
          });
          jav()?.wakeExtract?.(); // 提取并发变更 → 释放池等待者
          pumpDispatch();         // 在途封顶/显存阈值变更 → 立即重判排队项
          toast("客户端设置已保存（立即生效，无需重启）", "ok");
          for (const row of rows) row.dataset.base = (row.querySelector("input") as HTMLInputElement).value;
          ccDirty();
        } catch (e) {
          toast((e as Error).message, "err");
        }
      };
    }
    // 扫描规则卡：独立 dirty 追踪 + 独立保存（只发 6 个 scan_* 键；两端后端均为部分合并）
    const scanRows = Array.from(body.querySelectorAll<HTMLElement>(".cc-card[data-sec=ccfg-scan] .ccfg-row"));
    if (scanRows.length) {
      const sCtl = (id: string) => $(id) as HTMLInputElement;
      const sRowVal = (row: HTMLElement) => {
        const ctl = row.querySelector("input") as HTMLInputElement;
        return ctl.type === "checkbox" ? (ctl.checked ? "1" : "0") : ctl.value;
      };
      const ccScanDirty = (): void => {
        let n = 0;
        for (const row of scanRows) {
          const changed = sRowVal(row) !== (row.dataset.base ?? "");
          row.classList.toggle("dirty", changed);
          if (changed) n++;
        }
        const d = $("cc-scan-dirty");
        if (d) { d.textContent = n ? `有 ${n} 项未保存` : "无改动"; d.classList.toggle("dirty-n", n > 0); }
        const b = $("cc-scan-save");
        if (b) b.hidden = n === 0;
      };
      for (const row of scanRows) {
        const ctl = row.querySelector("input") as HTMLInputElement;
        ctl.addEventListener("input", ccScanDirty);
        ctl.addEventListener("change", ccScanDirty);
      }
      const scanSave = $("cc-scan-save") as HTMLButtonElement | null;
      if (scanSave) scanSave.onclick = async () => {
        const min = Number(sCtl("cc-scan-minsize").value);
        if (!Number.isFinite(min) || min < 0) { toast("忽略小于需要 >=0 的有限数字", "err"); return; }
        const norm = (s: string) => s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
        const payload = {
          scan_video_exts: norm(sCtl("cc-scan-exts").value),
          scan_subtitle_patterns: norm(sCtl("cc-scan-pats").value),
          scan_recurse: sCtl("cc-scan-recurse").checked,
          scan_min_size_mb: min,
          scan_has_sub_tokens: norm(sCtl("cc-scan-has-tokens").value),
          scan_no_sub_tokens: norm(sCtl("cc-scan-no-tokens").value),
        };
        try {
          await t.putClientConfig!(payload as ClientConfig);
          // 保存成功才落本端内存（scan_* 由 normalizeClientConfig type-guard 透传）
          state.ccfg = normalizeClientConfig({ ...(state.ccfg || {}), ...payload });
          toast("扫描规则已保存（对之后的扫描生效）", "ok");
          for (const row of scanRows) row.dataset.base = sRowVal(row);
          ccScanDirty();
        } catch (e) {
          toast((e as Error).message, "err");
        }
      };
    }
    // 桌面专属：更新设置（与更新弹窗高级区同数据源，保存后同步侧边栏「自动更新」勾选）
    const upSave = $("cc-up-save") as HTMLButtonElement | null;
    if (upSave) {
      // 0.2.49 P7：更新卡补 dirty 追踪（与并发/扫描卡同语义：脏行高亮 + 计数，保存成功重置基准）
      const upRows = Array.from(body.querySelectorAll<HTMLElement>(".cc-card[data-sec=ccfg-desktop-update] .ccfg-row"));
      const upRowVal = (row: HTMLElement) => {
        const ctl = row.querySelector("input") as HTMLInputElement;
        return ctl.type === "checkbox" ? (ctl.checked ? "1" : "0") : ctl.value;
      };
      const upDirty = (): void => {
        let n = 0;
        for (const row of upRows) {
          const changed = upRowVal(row) !== (row.dataset.base ?? "");
          row.classList.toggle("dirty", changed);
          if (changed) n++;
        }
        const d = $("cc-up-dirty");
        if (d) { d.textContent = n ? `有 ${n} 项未保存` : "无改动"; d.classList.toggle("dirty-n", n > 0); }
      };
      for (const row of upRows) {
        const ctl = row.querySelector("input") as HTMLInputElement;
        ctl.addEventListener("input", upDirty);
        ctl.addEventListener("change", upDirty);
      }
      upSave.onclick = async () => {
        const b = upBridge();
        if (!b) return;
        const next = {
          enabled: ($("cc-up-enabled") as HTMLInputElement).checked,
          mirror: (($("cc-up-mirror") as HTMLInputElement).value || "").trim(),
          proxy: (($("cc-up-proxy") as HTMLInputElement).value || "").trim(),
        };
        try {
          upSettings = await b.putSettings(next);
          const auto = $("up-auto") as HTMLInputElement | null;
          if (auto) auto.checked = upSettings.enabled;
          for (const row of upRows) row.dataset.base = upRowVal(row);
          upDirty();
          toast("更新设置已保存（立即生效）", "ok");
        } catch (e) {
          toast((e as Error).message, "err");
        }
      };
    }
    // 桌面专属：文件夹监听（与派单页监听面板同数据源）
    const wPick = $("cc-watch-pick") as HTMLButtonElement | null;
    if (wPick) {
      wPick.onclick = async () => {
        const ctl = ccWatchCtl;
        if (!ctl) return;
        const p = await ctl.pickDir();
        if (p) ccWatchRenderBits(ctl.state());
      };
      const wToggle = $("cc-watch-toggle") as HTMLButtonElement;
      wToggle.onclick = async () => {
        const ctl = ccWatchCtl;
        if (!ctl) return;
        const st = ctl.state();
        const wantOn = !st?.enabled;
        const r = await ctl.set(wantOn, (st?.path || "").trim());
        if (!r.ok) { toast(r.error || "监听设置失败", "err"); return; }
        if (r.state) ccWatchRenderBits(ctl.state());
      };
    }
  }

  // ---------- 共享工作台导航 + 平台必要的桌面窗口控制 ----------
  // Web 与 Desktop 使用同一套导航节点、视图状态和交互；桌面只额外保留窗口控制。
  const VIEWS = ["engines", "dispatch", "jobs", "ccfg"] as const;
  type ViewName = (typeof VIEWS)[number];
  const secs: Record<ViewName, HTMLElement> = {
    engines: $("sec-engines"), dispatch: $("sec-dispatch"), jobs: $("sec-jobs"), ccfg: $("sec-ccfg"),
  };
  const navItems = Array.from(document.querySelectorAll<HTMLButtonElement>("#nav .view-tab[data-view]"));
  const navBadge = $("nav-badge") as HTMLElement | null;
  // URL 锚点：hash 是合法 view 名时优先于 localStorage（分享/书签直接定位 tab）
  const hashView = (() => {
    const h = location.hash.replace(/^#/, "");
    return VIEWS.includes(h as ViewName) ? (h as ViewName) : null;
  })();
  let savedView = "dispatch";
  try { savedView = localStorage.getItem("javview_view") || "dispatch"; } catch { /* 忽略 */ }
  const initialView: ViewName = hashView || (VIEWS.includes(savedView as ViewName) ? (savedView as ViewName) : "dispatch");
  let currentView: ViewName = initialView;
  // 0.2.49 P6：设置页未保存改动检测 —— 客户端卡 / 服务端表单任一 dirty 即视为脏
  function ccViewDirty(): boolean {
    const body = $("cc-body");
    if (!body) return false;
    if (body.querySelector(".ccfg-row.dirty")) return true;
    if (body.querySelector("#srv-body .cfg-row.dirty")) return true;
    return false;
  }
  webShowView = (view: ViewName) => {
    // 0.2.49 P6：离开设置视图 / 重设已激活的设置 tab 都会整体重渲染（改动静默丢失）→ 先确认
    if (currentView === "ccfg" && ccViewDirty()
      && !window.confirm("设置页有未保存的改动，切换后将丢弃。继续？")) return;
    for (const v of VIEWS) secs[v].classList.toggle("view-on", v === view);
    for (const item of navItems) {
      const active = item.dataset.view === view;
      item.classList.toggle("on", active);
      item.setAttribute("aria-selected", active ? "true" : "false");
    }
    currentView = view;
    try { localStorage.setItem("javview_view", view); } catch { /* 忽略 */ }
    // 切 tab → 同步 hash（replaceState 不污染历史栈；失败退回 location.hash 同文档跳转）
    if (location.hash !== "#" + view) {
      try { history.replaceState(null, "", "#" + view); } catch { location.hash = view; }
    }
    if (view === "ccfg") void renderCcView(); // 激活即重渲染（取最新值；seq 丢弃过期异步）
  };
  webShowView(initialView);
  for (const item of navItems) {
    item.addEventListener("click", () => webShowView(item.dataset.view as ViewName));
  }
  // 外部 hash 变化（浏览器前进/后退、手改地址栏）→ 跟随切 tab
  window.addEventListener("hashchange", () => {
    const h = location.hash.replace(/^#/, "");
    if (VIEWS.includes(h as ViewName) && h !== currentView) webShowView(h as ViewName);
  });
  viewBadge = (n: number) => {
    if (!navBadge) return;
    navBadge.hidden = n <= 0;
    if (n > 0) navBadge.textContent = String(n);
  };

  if (platform.kind === "desktop") {
    const d = (window as unknown as {
      javDesktop?: {
        win?: {
          minimize(): void; toggleMax(): void; close(): void;
          onMaxState(cb: (m: boolean) => void): () => void;
        };
      };
    }).javDesktop?.win;
    if (d) {
      const min = $("win-min");
      const max = $("win-max");
      const close = $("win-close");
      if (min) min.onclick = () => d.minimize();
      if (close) close.onclick = () => d.close();
      if (max) {
        max.onclick = () => d.toggleMax();
        d.onMaxState((m) => {
          max.classList.toggle("maxed", m);
          max.title = m ? "还原" : "最大化";
          max.setAttribute("aria-label", m ? "还原" : "最大化");
        });
      }
      const tb = $("titlebar");
      if (tb) tb.addEventListener("dblclick", (e) => {
        if ((e.target as HTMLElement).closest(".tb-btn, #up-chip")) return;
        d.toggleMax();
      });
    }
  }

  // S4：提取并发读者注入（闭包实时读 state.ccfg，注入一次不缓存值）+ 启动读回客户端设置（验收 d）；
  // 0.2.53 需求③：读者 = 客户端设置基线 + Σ 活跃主任务预算（批次注册/注销后重注入，内含 wake）
  jav()?.setExtractLimit?.(extractLimitReader);
  if (t.getClientConfig) void t.getClientConfig()
    .then((cc) => { state.ccfg = normalizeClientConfig(cc); })
    .catch(() => {});
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
}
