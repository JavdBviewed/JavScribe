// 字幕工作台前端主逻辑（web / desktop 共享 UI 层）。
// 由 static/app.js 机械迁移 + 类型标注，行为 1:1（回归基线：client/tests/e2e 四类套件）。
// 网络请求全部走 transport 接口（web 形态实现见 transport-web）。

import type { Transport } from "../core/transport";
import { LOCAL_SUB_PATTERNS, SRT_SUFFIX, VIDEO_EXTS } from "../core/constants";
import type { BatchRecord, BulkResult, ClientConfig, ConfigItem, Engine, EngineMetrics, JobRow, JobSummary, MetricsResponse, ReadinessPayload, ScanItem, ScanResult, ScanTaskSnapshot, ServeRelease, UpdateInfo, UploadStatus } from "../core/types";
import type { AudioCacheHit, LocalServeState, UpdateSettings, UpdateState, WatchCandidate, WatchState } from "../core/desktop-bridge";
import type { FolderFile, FolderVideo, PlatformAdapter, WriteBackInfo } from "../core/platform";
import type { JavExtractAPI } from "./extract";
import { canStartInFlight, CLIENT_CFG_DEFAULTS, countInFlightRows, normalizeClientConfig } from "../core/concurrency";
import { folderIsVideo, folderVideoMeta, type FolderScanRules } from "../core/folder-scan";
import { TransportError } from "../core/transport";
import { $, esc } from "./dom";
import { toast } from "./toast";
import { fmtSrtSpan, fmtSrtTime, parseSrt, type SrtCue, type SrtParseResult } from "../core/srt";

const DEFAULT_TITLE = "JavScribe 字幕工作台";

interface AppState {
  file: File | null;
  folderFiles: FolderVideo[] | null;
  folderChecked: Set<string>;      // 文件夹待选表勾选项（key=rel；有字幕/过小默认不勾，与扫描表同口径）
  folderPage: number;              // 文件夹待选表当前页（0 起；勾选态全局维护，与翻页互不影响）
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
  scanPageSize: number;      // 扫描列表每页行数（10/20/50/100/500 档，localStorage 持久化，默认 10）
  lastScan: ScanResult | null; // 最近一次扫描结果（翻页重渲染用，免重发请求）
  scanTask: ScanTaskSnapshot | null; // 后台扫描任务（web 形态刷新后可恢复）
  page: number;              // 任务分页：当前页（0 起）
  pageSize: number;          // 任务分页：每页行数（10/20/50/100/500 档，localStorage 持久化，默认 10）
  _jobs: JobRow[];           // 最近一次 /api/jobs 结果（翻页/筛选即时重渲染，不等网络）
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
  watchWriteBack: Set<string>;          // watch 派发任务完成后强制写回（不受 autoSave 门控；仅 desktop 会写入）
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
  filter: "all",
  source: "all",
  busy: false,
  knownJobs: new Map(),
  retried: new Set(),
  engines: [],
  cfgItems: [],
  scanItems: [],
  scanMapped: false,
  scanResolvedPath: "",
  scanChecked: new Set(),
  scanPage: 0,
  scanPageSize: readPageSize("javweb_scan_pagesize"),
  lastScan: null,
  scanTask: null,
  page: 0,
  pageSize: readPageSize("javweb_jobs_pagesize"),
  _jobs: [],
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

const PLANE_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;

const STATUS_ZH: Record<string, string> = {
  running: "运行中", done: "完成", error: "失败",
  skipped: "跳过", canceled: "已取消", pending: "排队", paused: "已暂停",
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

function mb(b: number): number { return Math.round(b / 1048576); }

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
    const sh = $("scan-help") as HTMLElement | null;
    if (sh) sh.dataset.tip =
      "扫描这台电脑上的目录。普通扫描只读取文件名、大小和同目录字幕文件，不会打开视频，也不会触发网盘下载。要处理另一台电脑里的文件，请改用「选择文件 / 选择文件夹」。";
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
    for (const k of [...state.knownJobs.keys()]) if (!seen.has(k)) state.knownJobs.delete(k);
  }

  // ---------- 完成后写回源目录（auto-save）：任务 running→done 时触发 ----------
  function maybeWriteBack(r: JobRow) {
    if (!r.job_id) return;
    const key = r.engine + "|" + r.job_id;
    const info = state.writeBackJobs.get(key);
    if (!info) return;
    // autoSave 门控：watch 派发的任务在 watchWriteBack 里登记，完成后必须写回（语义上就是「落回影片旁」）
    if (!state.autoSave && !state.watchWriteBack.has(key)) return;
    state.writeBackJobs.delete(key);
    state.watchWriteBack.delete(key);
    if (platform.canWriteBack(info)) doWriteBack(r, info);
    else autoDownloadSrt(r, info.videoName);
  }

  async function doWriteBack(r: JobRow, info: WriteBackInfo) {
    const srtName = info.videoName.replace(/\.[^.]+$/, "") + SRT_SUFFIX;
    try {
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
      reconcilePending(); // S4：行接管 pending 记账（行到终态即释 cap 槽）
      if (ccRaw) {
        const ccNow = normalizeClientConfig(ccRaw);
        if (!state.ccfg
          || ccNow.extract_workers !== state.ccfg.extract_workers
          || ccNow.queue_cap !== state.ccfg.queue_cap) {
          state.ccfg = ccNow;
          jav()?.wakeExtract?.(); // 提取并发变更 → 释放池等待者（调小无害：不中断在跑者）
          pumpDispatch();         // 在途封顶变更 → 立即重判排队项
        }
      }
      state._batches = batches || [];
      renderJobs(jobs);
      if (platform.kind === "web" && typeof t.engineMetrics === "function") {
        for (const e of engines) {
          if (!e.online) continue;
          void t.engineMetrics(e.name).then((m) => {
            state._metrics[e.name] = m;
            const card = document.querySelector<HTMLElement>(
              `#engine-grid .eng[data-name="${CSS.escape(e.name)}"]`);
            if (card) renderEngineMetrics(card, e.name);
          }).catch(() => {
            state._metrics[e.name] = { ok: false, error: "unreachable" };
            const card = document.querySelector<HTMLElement>(
              `#engine-grid .eng[data-name="${CSS.escape(e.name)}"]`);
            if (card) renderEngineMetrics(card, e.name);
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

  // 文件夹监听「客户端设置 tab」钩子：桌面形态由 watch 块接线（与派单页监听面板同一数据源）；web 形态恒 null
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
      <label class="field"><span class="field-label">镜像源（URL 前缀，如 https://gh-proxy.example.com/；留空走官方）</span>
      <input id="up-mirror" class="mono" type="text" placeholder="留空使用 GitHub 官方" value="${esc(upSettings?.mirror || "")}"></label>
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
    <div class="muted small">若网络无法直连 GitHub，可设置镜像源或更新代理后重试。</div>`;
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
      <button type="button" class="icon-btn set" data-name="${esc(e.name)}" title="服务设置">&#9881;</button>
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
      ${e.online ? "" : `<div class="eng-err">${esc(e.error || "离线")}</div>`}
    </div>
    <div class="eng-metrics"></div>
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
    const del = target.closest<HTMLElement>(".del");
    if (del) {
      const name = del.dataset.name || "";
      if (!confirm(`删除服务「${name}」？`)) return;
      await t.deleteEngine(name);
      refresh();
      return;
    }
    const set = target.closest<HTMLElement>(".set");
    if (set) openSettings(set.dataset.name || "");
  };

  // ---------- 任务行（按任务 key 就地更新：进度/ETA/位置只改文字与条宽，不重排行节点，扫光与过渡不中断） ----------
  interface JobRowEl extends HTMLDivElement { _core?: string; _html?: string; }

  function jobKey(j: JobRow) {
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
    // 服务单任务挂起：行 status 仍是 pending，展示态归一为「已暂停」
    const st = j.paused ? "paused" : j.status;
    const paused = st === "paused";
    // 位置列：运行中/已暂停显示当前处理阶段（服务端日志事件驱动），终态显示时间轴位置
    const pos = isRun || paused
      ? (j.phase_detail || (paused ? "已暂停（等待继续）" : "—"))
      : (j.duration_s != null && j.position ? `${j.position} / ${fmtDuration(j.duration_s)}` : (j.position || "—"));
    const createdSeconds = timestampSeconds(j.created);
    const finishedSeconds = timestampSeconds(j.finished);
    const elapsed = createdSeconds != null
      ? fmtDuration(Math.max(0, (finishedSeconds ?? now) - createdSeconds))
      : "—";
    const createdAt = fmtJobDateTime(j.created);
    const finishedAt = fmtJobDateTime(j.finished);
    const finishedLabel = j.status === "done" ? "完成于" : "结束于";
    const jobTime = createdAt
      ? `<div class="job-time"><span class="job-time-created">添加于 ${esc(createdAt)}</span>`
        + (finishedAt ? `<span class="job-time-finished">${finishedLabel} ${esc(finishedAt)}</span>` : "")
        + `</div>`
      : "";
    let eta = "";
    const prog = j.progress || 0;
    if (isRun) {
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
    const labBase = (j.label || "").replace(/.*[\\/]/, "");
    const labelMain = !!j.label && !j.label.startsWith("文件夹扫描")
      && labBase !== j.file && VIDEO_EXT_RE.test(labBase);
    const primary = labelMain ? labBase : (j.file || "");
    // 跳过行优先显示 message（含已存在字幕的完整路径）
    const sub = j.status === "skipped" && j.message ? j.message
      : (!labelMain && j.message) ? j.message : "";
    const dl = j.status === "done" && j.job_id
      ? `<a class="dl-btn" href="${t.getResultUrl(j.engine, j.job_id)}" download="${esc(srtNameFor(j))}">&#8595; 下载 srt</a>`
      : "";
    // 预览：done 且有任务 id → 走 result 端点拉内容（本地扫描/远端任务通用）
    const pv = j.status === "done" && j.job_id
      ? `<button type="button" class="srt-pv" data-eng="${esc(j.engine)}" data-jid="${esc(j.job_id)}" title="预览生成的字幕（时间轴 + 全文）">预览 srt</button>`
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
    const isServeRow = !!j.job_id;
    // 他端标记：他端客户端提交的服务任务（字幕不落回本机；服务端操作仍可用）
    const srcTag = j.local === false
      ? `<span class="src-tag" title="该任务由其他客户端提交：可看进度并做服务端操作（暂停/继续/重试/取消/下载 srt）；源视频不在本机，字幕不会自动落回本机磁盘">他端</span>`
      : "";
    const jobActive = isServeRow && state._jobActive.get(retryKey) === true;
    // 跳过（服务行）：删旧字幕重新生成
    const retry = isServeRow && j.status === "skipped" && !state.retried.has(retryKey)
      ? `<button type="button" class="dl-btn retry" data-eng="${esc(j.engine)}" data-jid="${esc(j.job_id)}" data-mode="regen" title="删除已存在字幕并重新生成">&#8635; 仍要重新生成</button>`
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
    const cancel = (j.status === "running" || j.status === "pending") && j.job_id && !j.paused
      ? `<button type="button" class="dl-btn cancel" data-eng="${esc(j.engine)}" data-jid="${esc(j.job_id)}" title="终止排队/未开始文件；运行中将在检查点中止，已生成字幕保留">&#10006; 取消</button>`
      : "";
    // 换服务重跑（仅 desktop）：终态行复用本地音轨缓存向其他服务提交新任务
    const rerunBtn = (platform.kind === "desktop" && j.file
      && (j.status === "done" || j.status === "error" || j.status === "skipped"))
      ? `<button type="button" class="dl-btn rerun" data-file="${esc(j.file)}" data-eng="${esc(j.engine)}" data-jid="${esc(j.job_id || "")}" title="复用该影片的本地音轨缓存，选择另一个服务端重新提交">&#8644; 换服务重跑</button>`
      : "";
    // core：变化时整行重写（状态/文件/操作按钮，低频）；pct/eta/pos/elapsed 单独打补丁（高频）
    const core = [key, sel, j.status, j.paused, j.engine, j.file, sub, dl, pv, retry, srvRetry, pauseJobBtn, resumeJobBtn, localAct, localPauseBtn, reassignCtl, rerunBtn, pos, wb, ss, cancel, srcTag, createdAt, finishedAt].join("\u0001");
    const html = `
      <label class="job-chk-box"><input type="checkbox" class="job-chk" data-key="${esc(key)}"${sel ? " checked" : ""} aria-label="勾选任务（批量操作）"></label>
      <div class="job-cell" title="${j.engine === "auto" ? "派发时按实时负载自动选择服务" : ""}">${esc(j.engine === "auto" ? "⚖ 自动均衡" : j.engine)}</div>
      <div class="job-name"><div class="fn">${esc(primary)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}${jobTime}</div>
      <div><span class="pill p-${esc(st)}"><i></i>${STATUS_ZH[st] || esc(st)}</span>${srcTag}${wb}${ss}</div>
      <div class="prog"><div class="bar${isRun ? " live" : ""}"><div style="width:${pct}%"></div></div><span class="pct mono">${pct}%</span><span class="eta"></span></div>
      <div class="job-cell mono cell-pos">${esc(pos)}</div>
      <div class="job-cell mono cell-elapsed">${esc(elapsed)}</div>
      <div class="job-actions">${dl}${pv}${retry}${srvRetry}${pauseJobBtn}${resumeJobBtn}${localAct}${localPauseBtn}${reassignCtl}${rerunBtn}${cancel}</div>`;
    return { html, core, pct, eta, pos, elapsed };
  }

  function patchJobRow(row: JobRowEl, pct: number, eta: string, pos: string, elapsed: string) {
    const bar = row.querySelector(".bar > div") as HTMLDivElement | null;
    if (bar) bar.style.width = pct + "%";
    const pctEl = row.querySelector(".pct");
    if (pctEl && pctEl.textContent !== pct + "%") pctEl.textContent = pct + "%";
    const etaEl = row.querySelector(".eta");
    if (etaEl && etaEl.textContent !== eta) etaEl.textContent = eta;
    const posEl = row.querySelector(".cell-pos");
    if (posEl && posEl.textContent !== pos) posEl.textContent = pos;
    const elEl = row.querySelector(".cell-elapsed");
    if (elEl && elEl.textContent !== elapsed) elEl.textContent = elapsed;
  }

  // ---------- 主任务（batch）：聚合状态 / 行渲染 ----------
  const BATCH_TERMINAL = new Set(["done", "skipped", "error", "canceled"]);

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

  function batchAgg(children: JobRow[]): { status: string; label: string; pct: number } {
    let status = "done";
    let label = "";
    if (children.length) {
      // 优先级 paused > running：本机冻结行走既有口径 status="running"（phase=queued），
      // running 在前会让冻结 batch 的主行卡在「运行中」，永远到不了「已暂停」（「继续」按钮不可达）
      if (children.some((j) => j.status === "paused" || j.paused === true || j.batch_paused === true)) status = "paused";
      else if (children.some((j) => j.status === "running")) status = "running";
      else if (children.every((j) => BATCH_TERMINAL.has(j.status))) {
        if (children.some((j) => j.status === "error" || j.status === "canceled")) {
          status = "error";
          label = "完成（部分失败）";
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
    return `
      <button type="button" class="batch-caret" data-bid="${esc(g.bid)}" title="${collapsed ? "展开子任务" : "收起子任务"}">${collapsed ? "&#9656;" : "&#9662;"}</button>
      <div class="job-cell mono batch-sub-n">${g.children.length} 子任务</div>
      <div class="job-name"><div class="fn">${esc(label)}</div>${g.stale ? '<div class="sub">子任务已过期（记录保留）</div>' : ""}</div>
      <div><span class="pill p-${esc(agg.status)}"><i></i>${esc(agg.label || STATUS_ZH[agg.status] || agg.status)}</span></div>
      <div class="prog"><div class="bar${agg.status === "running" ? " live" : ""}"><div style="width:${agg.pct}%"></div></div><span class="pct mono">${agg.pct}%</span></div>
      <div class="job-cell mono cell-pos cell-bt"${timeTitle ? ` title="${esc(timeTitle)}"` : ""}>${created ? (fmtJobDateTime(created).split(" ")[1] || "—") : "—"}</div>
      <div class="job-cell mono cell-elapsed">${esc(elapsed)}</div>
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

  function renderJobs(rows: JobRow[]) {
    // 统计与筛选合一（renderFilterBar）：终态计数走 serve 累计 summary（200 内存窗
    // 下行计数必少算），活跃态按现行计数；按钮内带数字，不再另设一套统计条。
    renderFilterBar();
    renderSourceFilter();
    renderPauseAllBtn();

    // 单任务挂起可用性：同任务任一文件运行中 → 服务侧拒绝挂起（409），行级「暂停」隐藏
    const jobActive = new Map<string, boolean>();
    for (const r of rows) {
      if (r.job_id && r.status === "running") jobActive.set(r.engine + "|" + r.job_id, true);
    }
    state._jobActive = jobActive;

    // 勾选维护：消失的行（任务过期/挤出窗口）自动取消勾选
    const allKeys = new Set(rows.map(jobKey));
    for (const k of Array.from(state.selected)) if (!allKeys.has(k)) state.selected.delete(k);

    const filtered = visibleRows(rows);
    state._filteredKeys = filtered.map(jobKey);

    // 顶层条目：普通行 + 主任务（batch）组（组位置=首个子行出现处；组按 1 条计页）。
    // 顶部统计/筛选计数仍按子行（口径不翻倍）；勾选/批量操作仍只在子行。
    interface BatchGroup {
      bid: string; label: string; children: JobRow[];
      stale?: { created?: number | null; finished?: number | null };
    }
    type Entry = { kind: "row"; row: JobRow } | { kind: "batch"; g: BatchGroup };
    const batchGroups = new Map<string, BatchGroup>();
    const entries: Entry[] = [];
    for (const j of filtered) {
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
    // 渲染一条完成态主任务行（无子行）；筛选非全量时不展示，避免误导
    if (state.filter === "all" && state.source === "all") {
      const liveBids = new Set(rows.map((r) => r.batch_id).filter(Boolean) as string[]);
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
    $("jobs-empty").hidden = filtered.length > 0;
    $("jobs-empty-text").textContent = rows.length ? "当前筛选下无任务" : "暂无任务";
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
        el.className = "job-grid job-row" + (j.status === "running" ? " running" : "");
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
          + (j.paused || j.status === "paused" ? " paused" : "");
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
        || g.children.every((j) => BATCH_TERMINAL.has(j.status));
      const created = g.children.length
        ? (Math.min(...g.children.map((j) => j.created || 0)) || null)
        : (g.stale?.created ?? null);
      const finished = g.children.length
        ? (Math.max(...g.children.map((j) => j.finished || 0)) || null)
        : (g.stale?.finished ?? null);
      // 总耗时：全终态 = max(finished) - min(created)；在途 = now - min(created)
      const elapsed = created != null
        ? fmtDuration(Math.max(0, (allTerminal ? (finished || now) : now) - created))
        : "—";
      const collapsed = state._batchCollapsed.has(g.bid);
      const hasFailed = g.children.some((j) => j.status === "error" || j.status === "canceled");
      const canOp = typeof t.batchOp === "function" && !g.stale;
      const ops = [
        canOp && agg.status !== "paused" && !allTerminal
          ? `<button type="button" class="dl-btn batch-op" data-bid="${esc(g.bid)}" data-bact="pause" title="暂停主任务：运行中的子任务跑完，排队中冻结">&#9208; 暂停</button>` : "",
        canOp && agg.status === "paused"
          ? `<button type="button" class="dl-btn batch-op" data-bid="${esc(g.bid)}" data-bact="resume" title="继续主任务：解除排队冻结，恢复开跑">&#9654; 继续</button>` : "",
        canOp && hasFailed
          ? `<button type="button" class="dl-btn batch-op" data-bid="${esc(g.bid)}" data-bact="retry" title="重试本主任务中失败的子任务">&#8635; 重试失败</button>` : "",
        canOp && !allTerminal
          ? `<button type="button" class="dl-btn batch-op" data-bid="${esc(g.bid)}" data-bact="cancel" title="取消主任务：未开始子任务全部取消，运行中不受影响">&#10006; 取消</button>` : "",
      ].join("");
      const label = g.label || g.bid;
      const core = [gkey, label, g.children.length, agg.status, collapsed, allTerminal, created, finished, hasFailed, canOp, ops].join("\u0001");
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
        + (agg.status === "paused" ? " paused" : "");
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
    if (r.status === "error" || r.status === "canceled") return "failed";
    if (r.status === "paused" || r.paused) return "paused";
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
  ];

  function renderFilterBar() {
    const box = $("job-filter");
    const counts: Record<string, number> = {
      all: 0, active: 0, queued: 0, extracting: 0, transcribing: 0,
      done: 0, skipped: 0, failed: 0, paused: 0,
    };
    for (const r of state._jobs) counts[rowBucket(r)] += 1;
    // 终态计数用 serve 累计 summary（200 内存窗下行计数必少算）；活跃态只能按现行
    if (state._summary) {
      counts.done = state._summary.done;
      counts.skipped = state._summary.skipped;
      counts.failed = state._summary.failed;
    }
    counts.active = counts.queued + counts.extracting + counts.transcribing;
    counts.all = counts.active + counts.done + counts.skipped + counts.failed + counts.paused;
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
  function renderSourceFilter() {
    const box = $("job-source-filter") as HTMLElement;
    let nLocal = 0;
    let nServe = 0;
    for (const r of state._jobs) {
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
    // 主任务（batch）行操作：暂停/继续/取消/重试失败子任务（fan-out 逐引擎提示，不阻塞）
    const bo = (ev.target as HTMLElement).closest(".batch-op") as HTMLButtonElement | null;
    if (bo && !bo.disabled && t.batchOp) {
      const bid = bo.dataset.bid || "";
      const act = bo.dataset.bact || "";
      const btn = bo as HTMLButtonElement;
      const labelOf = (x: string) => x === "pause" ? "暂停" : x === "resume" ? "继续" : x === "cancel" ? "取消" : "重试";
      if (act === "cancel") {
        const ok = window.confirm(
          `确认取消主任务？\n\n· 未开始的子任务全部取消\n· 运行中的子任务不受影响（与单任务取消语义一致）`,
        );
        if (!ok) return;
      }
      btn.disabled = true;
      try {
        if (act === "retry") {
          // 重试失败子任务：serve 行→retryJob；本机行（task_id）→rerunLocal
          const failed = (state._jobs || []).filter(
            (j) => j.batch_id === bid && (j.status === "error" || j.status === "canceled"));
          if (!failed.length) { toast("该主任务没有可重试的失败子任务", "err"); return; }
          let n = 0;
          for (const j of failed) {
            try {
              if (j.job_id) await t.retryJob(j.engine, j.job_id);
              else if (j.task_id && t.rerunLocal) await t.rerunLocal(j.task_id);
              else continue;
              n++;
            } catch (_e2) { /* 单个失败继续：结果在任务行可见 */ }
          }
          toast(n ? `已重新提交 ${n} 个失败子任务` : "重试失败（子任务已过期或不可重试）", n ? "ok" : "err");
        } else {
          const d = await t.batchOp(act as "pause" | "resume" | "cancel", bid);
          const bad = (d.engines || []).filter((e) => !e.ok);
          const badTxt = bad.map((e) => `${e.engine}：${e.unsupported ? "版本过旧不支持" : (e.error || "失败")}`).join("；");
          const localTxt = act === "cancel"
            ? `，本机取消 ${d.local?.canceled ?? 0} 个未开始任务`
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
    const rb = (ev.target as HTMLElement).closest(".rerun") as HTMLButtonElement | null;
    if (rb && !rb.disabled) {
      if (state.busy) { toast("有正在进行的提交任务，请完成后再试", "err"); return; }
      void openRerunModal(rb.dataset.file || "", rb.dataset.eng || "", rb.dataset.jid || "");
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
      if (oldInfo) state.writeBackJobs.set(eng + "|" + d.jobId, oldInfo);
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
  function renderPauseAllBtn() {
    const btn = $("job-pause-all") as HTMLButtonElement;
    if (!t.pauseAll) { btn.hidden = true; return; }
    const pausedAll = !!state._summary?.paused_all;
    btn.hidden = false;
    btn.classList.toggle("on", pausedAll);
    const label = pausedAll ? "▶ 继续任务" : "⏸ 暂停所有";
    if (btn.textContent !== label) btn.textContent = label;
    if (state.busy) btn.disabled = true;
  }

  ($("job-pause-all") as HTMLButtonElement).onclick = async () => {
    if (!t.pauseAll) return;
    if (state.busy) { toast("有正在进行的提交任务，请完成后再试", "err"); return; }
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
      btn.disabled = state.busy;
    }
  };

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

  // 表头「全选当前筛选结果」（跨页；部分选中 → indeterminate）
  const selAll = $("job-sel-all") as HTMLInputElement | null;
  if (selAll) {
    selAll.onchange = () => {
      if (selAll.checked) for (const k of state._filteredKeys) state.selected.add(k);
      else for (const k of state._filteredKeys) state.selected.delete(k);
      // 当前页行内勾选同步（不触发 renderJobs，避免 5s 数据外的多余重排）
      for (const row of Array.from(jobList.children) as JobRowEl[]) {
        const chk = row.querySelector<HTMLInputElement>("input.job-chk");
        if (chk) chk.checked = selAll.checked;
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
  }

  const bulkBar = $("job-bulk-bar");
  bulkBar.onclick = async (ev) => {
    const t0 = ev.target as HTMLElement;
    if (t0.closest(".bulk-clear")) {
      state.selected.clear();
      for (const row of Array.from(jobList.children) as JobRowEl[]) {
        const chk = row.querySelector<HTMLInputElement>("input.job-chk");
        if (chk) chk.checked = false;
      }
      renderBulkBar();
      renderSelAll();
      return;
    }
    const btn = t0.closest<HTMLButtonElement>(".bulk-act");
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act as "pause" | "resume" | "retry" | "cancel" | "assign";
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
        if (chk) chk.checked = false;
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

  function engineAddClose(): void {
    if (engineAddBackdrop) engineAddBackdrop.hidden = true;
  }

  function engineAddOpen(): void {
    if (!engineAddBackdrop) return;
    engineAddBackdrop.hidden = false;
    engineName.focus();
    engineName.select();
  }

  ($("engine-add-btn") as HTMLButtonElement | null)?.addEventListener("click", engineAddOpen);
  ($("engine-add-x") as HTMLButtonElement | null)?.addEventListener("click", engineAddClose);
  ($("engine-add-cancel") as HTMLButtonElement | null)?.addEventListener("click", engineAddClose);
  engineAddBackdrop?.addEventListener("click", (ev) => { if (ev.target === engineAddBackdrop) engineAddClose(); });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && engineAddBackdrop && !engineAddBackdrop.hidden) engineAddClose();
  });

  engineForm.onsubmit = async (ev) => {
    ev.preventDefault();
    const name = engineName.value.trim();
    const url = engineUrl.value.trim();
    const api_key = engineKey.value.trim();
    if (engineAddSubmit) engineAddSubmit.disabled = true;
    try {
      await t.addEngine(name, url, api_key);
      engineForm.reset();
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
      ? "⚖ 自动均衡：每个任务派发时刻按实时负载选最闲服务（推荐）；任务表内可逐条/批量改派"
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
    // auto 选项：仅工作台形态且 ≥2 台服务（auto 由工作台服务端在派发时刻按实时负载解析；
    // desktop 形态客户端直连单服务，无均衡概念）
    const canAuto = typeof t.setEngineEnabled === "function" && engines.length >= 2;
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
    const ok = !state.busy && n > 0 && !!engineSelect.value;
    dispatchGo.disabled = !ok;
    dispatchGo.innerHTML = n > 1 ? "&#9654; 开始生成（" + n + " 项）" : "&#9654; 开始生成";
    updateScanGo();
  }

  function updateScanGo() {
    const scanActive = !!state.scanTask && ["queued", "running", "paused"].includes(state.scanTask.status);
    scanGo.disabled =
      !scanPath.value.trim() || !engineSelect.value || state.busy || scanActive;
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
          sz.textContent = e.size_mb >= 1024
            ? (e.size_mb / 1024).toFixed(1) + " GB"
            : e.size_mb.toFixed(1) + " MB";
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
      (sizeMb != null ? `<span class="srt-stat">文件 <b class="mono">${sizeMb.toFixed(2)} MB</b></span>` : "");
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
    setStep("step-extract", "done", "\u2713",
      audioMb != null ? `音频 ${audioMb} MB` : "音频提取完成");
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
    $("chip-size").textContent = mb(f.size) + " MB";
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
    if (!state.busy) pickFile();
  };
  drop.onkeydown = (ev) => {
    if ((ev.key === "Enter" || ev.key === " ") && !state.busy) { ev.preventDefault(); pickFile(); }
  };
  fileInput.onchange = (ev) => {
    const files = (ev.target as HTMLInputElement).files;
    setFile(files ? files[0] : null);
  };
  for (const name of ["dragover", "dragenter"] as const) {
    drop.addEventListener(name, (ev) => { ev.preventDefault(); if (!state.busy) drop.classList.add("hover"); });
  }
  for (const name of ["dragleave", "drop"] as const) {
    drop.addEventListener(name, (ev) => { ev.preventDefault(); drop.classList.remove("hover"); });
  }
  drop.addEventListener("drop", (ev) => {
    const dt = ev.dataTransfer;
    if (!state.busy && dt) setFile(dt.files[0]);
  });

  chipX.onclick = () => {
    if (state.busy) return;
    state.file = null;
    state._fsFileDir = null;
    fileInput.value = "";
    $("file-chip").hidden = true;
    drop.classList.remove("has-file");
    resetPipeline();
    updateGo();
  };

  // ---------- 选择文件夹（本地过滤 + 待选表，规则统一消费「客户端设置 · 扫描规则」） ----------
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
      has_sub_tokens: Array.isArray(cc.scan_has_sub_tokens) ? cc.scan_has_sub_tokens : [],
      no_sub_tokens: Array.isArray(cc.scan_no_sub_tokens) ? cc.scan_no_sub_tokens : ["c"],
    };
  }

  function folderKey(v: FolderVideo): string {
    return v.file.webkitRelativePath || v.file.name;
  }
  function folderHasSub(v: FolderVideo): boolean {
    return v.sub_status !== "none";
  }

  function clearFolder() {
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
      toast("该文件夹里没有支持的视频文件（可到「客户端设置 · 扫描规则」调整扩展名）", "err");
      return;
    }
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
      return `<span class="tag subtag" title="文件名含标记 ${esc(v.sub_token || "")}，按规则视为已压字幕（可在「客户端设置 · 扫描规则」改判）">标记（名）</span>`;
    }
    if (v.no_sub_token) {
      return `<span class="tag subtag ok" title="文件名含标记 ${esc(v.no_sub_token)}，按规则视为无字幕版（可在「客户端设置 · 扫描规则」改判）">无字幕（名）</span>`;
    }
    return '<span class="muted" title="本地不检查内嵌字幕轨">未检查</span>';
  }

  function renderFolderTable(): void {
    const items = state.folderFiles || [];
    const PAGE = state.scanPageSize; // 复用扫描表每页行数档位（同一 localStorage 键）
    const pages = Math.max(1, Math.ceil(items.length / PAGE));
    const pg = Math.min(Math.max(0, state.folderPage), pages - 1);
    const pageItems = items.slice(pg * PAGE, (pg + 1) * PAGE);
    $("folder-table").innerHTML = pageItems.length ? `
      <table class="scan-table">
        <thead><tr><th class="col-check"></th><th>文件</th><th class="col-size">大小</th><th class="col-sub">字幕</th></tr></thead>
        <tbody>
          ${pageItems.map((v) => `
            <tr class="${folderHasSub(v) ? "has-sub" : ""}${v.too_small ? " too-small" : ""}">
              <td class="col-check"><input type="checkbox" data-key="${esc(folderKey(v))}"${state.folderChecked.has(folderKey(v)) ? " checked" : ""}></td>
              <td class="scan-name mono" title="${esc(folderKey(v))}">${esc(v.file.name)}${v.too_small ? '<span class="tag tinytag" title="低于「忽略小于」阈值，不默认选中；可手动勾选提交">过小</span>' : ""}</td>
              <td class="mono">${mb(v.file.size)} MB</td>
              <td class="col-sub">${folderSubCell(v)}</td>
            </tr>`).join("")}
        </tbody>
      </table>` : '<div class="muted small">该文件夹里没有视频文件</div>';
    $("folder-table").querySelectorAll("input[type=checkbox]").forEach((cb) => {
      const input = cb as HTMLInputElement;
      input.onchange = () => {
        if (input.checked) state.folderChecked.add(input.dataset.key || "");
        else state.folderChecked.delete(input.dataset.key || "");
        updateFolderSummary();
      };
    });
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
    let text = items.length ? `已选 ${n} / ${items.length}` : "";
    if (nSub) text += ` · ${nSub} 个已有字幕默认不勾选`;
    if (nSmall) text += ` · ${nSmall} 个过小未选`;
    $("folder-count").textContent = text;
    $("folder-chip-text").textContent = items.length ? `已选 ${n} / ${items.length}` : "";
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
        input.checked = state.folderChecked.has(input.dataset.key || "");
      });
    updateFolderSummary();
  };

  pickFolder.onclick = async (ev) => {
    ev.stopPropagation();
    if (state.busy) return;
    const r = await platform.pickVideoFolder();
    if (r === "fallback") { folderInput.click(); return; }
    if (r) setFolder(r);
  };
  folderInput.onchange = (ev) => {
    const files = (ev.target as HTMLInputElement).files;
    setFolder(files ? [...files] as FolderFile[] : []);
  };
  folderX.onclick = () => { if (!state.busy) clearFolder(); };

  dispatchGo.onclick = () => {
    const engine = engineSelect.value;
    if (!engine || state.busy) return;
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
  let batchStartNext: (() => void) | null = null; // 文件夹批量封顶等待的续发（泵重触发）
  let singleQueuedFile: File | null = null;       // 等 cap 槽位的单文件（文件变更/重新派发即失效，身份匹配防误发）

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

  function canDispatch(engine: string): boolean {
    return canStartInFlight({ engine, cap: queueCapNow(), inFlight: inFlightOf, engines: state.engines });
  }

  /** 带记账派发：链启动 +1 / 链结算 -1；提交成功带 job_id 进 pending（等行接管） */
  function dispatchTracked(f: File, engine: string, labelPrefix?: string, batch?: { id: string; label?: string }): Promise<DispatchOutcome> {
    chainInFlight.set(engine, (chainInFlight.get(engine) || 0) + 1);
    return dispatchOne(f, engine, labelPrefix, batch).then(
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
    if (batchStartNext) batchStartNext();
    if (singleQueuedFile && !state.busy && state.file === singleQueuedFile && !state.folderFiles) {
      const engine = engineSelect.value;
      if (engine && canDispatch(engine)) startSingle(engine);
    }
  }

  function startSingle(engine: string) {
    const file = state.file;
    if (!file) { singleQueuedFile = null; return; }
    if (!canDispatch(engine)) {
      // 在途封顶（queue_cap）：不阻塞 UI，等 cap 槽位释放 → pumpDispatch 重触发（≤5s 轮询安全网）
      singleQueuedFile = file;
      showStatus(`「${engine}」在途任务已达上限（${queueCapNow()}），排队等待空位`, "");
      return;
    }
    singleQueuedFile = null; // 显式派发（含泵触发）：排队标记作废
    state.busy = true;
    updateGo();
    localStorage.setItem("javweb_engine", engine);
    preparePipeline();
    dispatchTracked(file, engine).then(([ok, d]) => {
      if (ok) {
        const up = d as UploadStatus;
        state.writeBackJobs.set(engine + "|" + up.job_id, {
          engine, videoName: file.name, dirHandle: state._fsFileDir || null,
          videoPath: (file as FolderFile)._localPath || null,
        });
        showStatus(`已提交到「${engine}」· ${up.name} → 任务 ${up.job_id}`, "ok");
        toast(`已提交到「${engine}」· ${up.name} → 任务 ${up.job_id}`, "ok");
        webShowView("jobs"); // 提交即进任务看板
        finishDispatch(true);
        refresh();
      } else {
        const msg = (d as { error?: string }).error || "上传失败";
        showStatus(`${file.name}：${msg}`, "err");
        toast(`${file.name}：${msg}`, "err");
        finishDispatch(false);
      }
    });
  }

  // S4：泵驱动并发派发（基线为串行 for-await；在途封顶下各链并行推进至 cap）。
  // 完成 = 全部链 settled（提交或失败），不等任务终态（终态由任务表记账并释 cap 槽）。
  // 公共泵：文件夹批量 / 扫描 400 回退共用（差异只在 finishNote 文案与 afterDone 收尾）。
  function runDispatchQueue(
    queue: FolderFile[],
    engine: string,
    batch: { id: string; label: string },
    finishNote: (okN: number, total: number) => string,
    afterDone: (okN: number) => void,
  ): void {
    state.busy = true;
    updateGo();
    localStorage.setItem("javweb_engine", engine);
    const total = queue.length;
    let okN = 0, started = 0, settled = 0, done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      batchStartNext = null;
      showStatus(finishNote(okN, total), okN ? "ok" : "err");
      afterDone(okN);
      refresh();
      if (okN > 0) webShowView("jobs"); // 批量完成进任务看板
    };
    const startNext = (): void => {
      if (done) return;
      while (started < total) {
        if (!canDispatch(engine)) break; // 封顶：等 refresh / 链结算 / 设置保存重触发
        const idx = started++;
        const file = queue[idx];
        const prefix = `文件 ${idx + 1}/${total} · `;
        preparePipeline(prefix + (effectiveMode(file) === "local" ? "开始本地提取…" : "开始上传…"));
        void (async () => {
          let ok = false;
          let d: UploadStatus | { error: string } = { error: "" };
          try { [ok, d] = await dispatchTracked(file, engine, prefix, batch); } catch (_e) { ok = false; }
          if (ok) {
            okN++;
            const up = d as UploadStatus;
            if (up.job_id) {
              state.writeBackJobs.set(engine + "|" + up.job_id, {
                engine, videoName: file.name, dirHandle: file._dirHandle || null,
                videoPath: file._localPath || null,
              });
            }
          }
          settled++;
          startNext(); // 链结算后立即试下一项
          if (settled === total) finish();
        })();
      }
    };
    if (total > 0) preparePipeline(`文件 1/${total}`); // 空队列不亮管线
    startNext();
    if (started < total) batchStartNext = startNext; // 封顶等待：泵重触发
    if (settled === total) finish(); // 空队列
  }

  function startBatch(engine: string) {
    // 待选表：只提交勾选的项（旧「全有字幕自动跳过」改由表内勾选表达）
    const queue = (state.folderFiles || [])
      .filter((v) => state.folderChecked.has(folderKey(v)))
      .map((v) => v.file);
    singleQueuedFile = null; // 文件夹批量接管单发排队（批量结束后按当前文件由泵重判）
    if (!queue.length) return;
    // 主任务（batch）：同一文件夹提交共享 batch_id（单文件上传不套壳）
    const batch = { id: genBatchId(), label: batchLabelForFolder() };
    runDispatchQueue(
      queue,
      engine,
      batch,
      (okN, total) => okN === total
        ? `批量完成：已提交 ${okN}/${total} 项，见「字幕任务」`
        : `批量完成：成功 ${okN}/${total} 项，其余失败（可重新选择文件夹）`,
      () => finishBatch(),
    );
  }

  // 「扫描目录」400 回退：所选服务读不到本机路径（浏览器电脑的盘符路径）→ 本机提取后上传
  function dispatchLocalScanPaths(engine: string, files: string[], batch: { id: string; label: string }) {
    const queue: FolderFile[] = files.map((p) => {
      const it = state.scanItems.find((i) => i.path === p);
      const f = new File([new Blob()], it ? it.name : p.split(/[\\/]/).pop() || p) as FolderFile;
      if (it) Object.defineProperty(f, "size", { value: it.size, configurable: true });
      f._localPath = p;
      return f;
    });
    // 清扫描 UI（回退后任务由任务看板跟踪）
    state.scanItems = [];
    state.scanChecked = new Set();
    state.lastScan = null;
    state.scanPage = 0;
    $("scan-pager").hidden = true;
    $("scan-results").hidden = true;
    $("scan-submit").hidden = true;
    $("scan-table").innerHTML = "";
    runDispatchQueue(
      queue,
      engine,
      batch,
      (okN, total) => okN === total
        ? `回退完成：本机提取上传已提交 ${okN}/${total} 项，见「字幕任务」`
        : `回退完成：成功 ${okN}/${total} 项，其余失败`,
      () => {
        state.busy = false;
        updateGo();
        watchPump();
      },
    );
  }

  function finishBatch() {
    state.busy = false;
    state.folderFiles = null;
    state.folderChecked = new Set();
    state.folderPage = 0;
    folderInput.value = "";
    $("folder-chip").hidden = true;
    $("folder-pending").hidden = true;
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

  function extractLocal(f: File, prefix: string): Promise<Blob | { skipped: true }> {
    return new Promise<Blob | { skipped: true }>((resolve, reject) => {
      let t0: number | null = null;
      setStep("step-upload", "active", "1", prefix + (platform.kind === "desktop"
        ? "本地提取音轨…"
        : "加载提取引擎（首次 ~30MB，有缓存）…"));
      setFill("0", true);
      jav()!.extractAudio(f, (p) => {
        const now = Date.now() / 1000;
        if (t0 == null) t0 = now;
        let meta = prefix + (platform.kind === "desktop" ? "本机提取 · " : "浏览器本地提取 · ") + Math.round(p * 100) + "%";
        const el = now - t0;
        if (el > 5 && p > 0.01) meta += ` · 剩 ~${fmtDuration(el * (1 - p) / p)}`;
        setStep("step-upload", "active", "1", meta);
        setFill((p * 100).toFixed(1) + "%");
      }).then(resolve, reject);
    });
  }

  function uploadAudioBlob(f: File, engine: string, blob: Blob, prefix: string, batch?: { id: string; label?: string }) {
    return new Promise<[boolean, UploadStatus]>((resolve) => {
      t.uploadAudio(f, engine, blob, (loaded, total, pct) => {
        setStep("step-extract", "active", "2",
          `${prefix}上传音频 ${mb(loaded)} / ${mb(total)} MB · ${pct.toFixed(1)}%`);
        setFill(pct + "%");
      }, batch).then((d) => {
        if (d.ok) {
          setStep("step-extract", "done", "\u2713",
            d.cached ? `${prefix}服务端已缓存，免上传` : `${prefix}音频 ${d.sizeMb} MB 已接收`);
          line2.classList.add("on");
          setStep("step-dispatch", "active", "3", "提交中…");
          setFill("100%");
          pollUpload(d.uploadId, engine, prefix, resolve);
        } else {
          setStep("step-extract", "error", "\u2715", d.error);
          resolve([false, { error: d.network ? "音频上传失败（网络错误）" : d.error } as UploadStatus]);
        }
      });
    });
  }

  // 整片上传（原路径）：视频 → 本服务 → 服务端提取 → 转发
  function serverUpload(f: File, engine: string, labelPrefix?: string, batch?: { id: string; label?: string }) {
    const prefix = labelPrefix || "";
    return new Promise<DispatchOutcome>((resolve) => {
      t.uploadFile(f, engine, (loaded, total, pct) => {
        setStep("step-upload", "active", "1",
          `${prefix}${mb(loaded)} / ${mb(total)} MB · ${pct.toFixed(1)}%`);
        setFill(pct + "%");
      }, batch).then((d) => {
        if (d.ok) {
          setStep("step-upload", "done", "\u2713",
            d.cached ? `${prefix}服务端已缓存，免上传` : `${prefix}${d.sizeMb} MB 已接收`);
          line1.classList.add("on");
          setStep("step-extract", "active", "2", "准备提取音频…");
          setFill("0", true);
          pollUpload(d.uploadId, engine, prefix, resolve);
        } else {
          setStep("step-upload", "error", "\u2715", d.error);
          resolve([false, { error: d.network ? "上传失败（网络错误）" : d.error }]);
        }
      });
    });
  }

  // 统一入口：按提取模式走 本地提音轨→传音频 或 整片上传
  function dispatchOne(f: File, engine: string, labelPrefix?: string, batch?: { id: string; label?: string }): Promise<DispatchOutcome> {
    const prefix = labelPrefix || "";
    const mode = effectiveMode(f);
    const Jav = jav();
    if (mode === "server" && state.extractMode === "auto" && Jav
        && f.size > Jav.MAX_BYTES) {
      toast(`「${f.name}」超过 1.6GB，改为整片上传本服务`);
    }
    if (mode === "local") {
      labelPipeline("local");
      return extractLocal(f, prefix)
        .catch((e: unknown) => ({ error: e }))
        .then((r: Blob | { skipped: true } | { error: unknown }) => {
          if (r && "error" in r) {
            const err = r.error;
            const msg = String((err as Error)?.message || err);
            if (state.extractMode === "local") {
              setStep("step-upload", "error", "\u2715", prefix + msg);
              return [false, { error: msg }];
            }
            toast(`本地提取失败，改用整片上传（${msg}）`, "err");
            labelPipeline("server");
            return serverUpload(f, engine, prefix, batch);
          }
          if (!r || "skipped" in r) {
            if (state.extractMode === "local") {
              const msg = "文件超过 1.6GB，无法在浏览器本地提取";
              setStep("step-upload", "error", "\u2715", prefix + msg);
              return [false, { error: msg }];
            }
            labelPipeline("server");
            return serverUpload(f, engine, prefix, batch);
          }
          setStep("step-upload", "done", "\u2713",
            `${prefix}本地提取完成 · 音频 ${mb(r.size)} MB`);
          line1.classList.add("on");
          setStep("step-extract", "active", "2", prefix + "准备上传音频…");
          setFill("0", true);
          return uploadAudioBlob(f, engine, r, prefix, batch);
        });
    }
    labelPipeline("server");
    return serverUpload(f, engine, prefix, batch);
  }

  function showStatus(text: string, cls: "ok" | "err" | "" = "") {
    const el = $("dispatch-status");
    el.hidden = false;
    el.className = "dispatch-status" + (cls ? " " + cls : "");
    el.textContent = text;
  }

  function finishDispatch(ok: boolean) {
    state.busy = false;
    if (ok) {
      state.file = null;
      fileInput.value = "";
      $("file-chip").hidden = true;
      drop.classList.remove("has-file");
    }
    updateGo();
    watchPump();
  }

  function pollUpload(id: string, _engine: string, labelPrefix: string, onDone: (r: [boolean, UploadStatus]) => void) {
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
        setStep("step-extract", "active", "2", meta);
        setFill((d.progress * 100).toFixed(1) + "%");
      } else if (d.phase === "dispatching") {
        markExtractDone(d.audio_mb);
        setStep("step-dispatch", "active", "3", "提交中…");
        setFill("100%");
      } else if (d.phase === "done") {
        clearInterval(timer);
        markExtractDone(d.audio_mb);
        setStep("step-dispatch", "done", "\u2713", `任务 ${d.job_id}`);
        setFill("100%");
        if (d.cached && platform.kind === "web") toast("服务端已缓存该音轨，免上传", "ok");
        onDone([true, d]);
      } else if (d.phase === "error") {
        clearInterval(timer);
        const which = d.job_id ? "step-dispatch" : "step-extract";
        if (which === "step-dispatch") markExtractDone(d.audio_mb);
        setStep(which, "error", "\u2715", d.error || "失败");
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
  async function openRerunModal(videoName: string, curEngine: string, _curJobId: string) {
    showModal(`换服务重跑 · ${videoName}`);
    const body = $("modal-body");
    body.innerHTML = '<div class="muted">检测本地音轨缓存中…</div>';
    let hit: AudioCacheHit | null = null;
    try { hit = await platform.findAudioCache(videoName); } catch { hit = null; }
    if (!hit || (!hit.opusValid && !hit.videoExists)) {
      body.innerHTML = `
      <div class="set-note err">本地没有该影片的音轨缓存${hit && hit.videoExists ? "" : "（源视频也不在本机）"}</div>
      <div class="muted small">重跑复用的是本机提取的音轨缓存（7 天保留）。该任务若是整片直传提交、或缓存已过期，就没有可复用的音轨。</div>`;
      return;
    }
    const cands = (state.engines || []).filter((e) => e.name !== curEngine && e.online);
    const statusHtml = hit.opusValid
      ? `<div class="set-note">音轨缓存命中：<b>${mb(hit.audioBytes)} MB</b>·来源 ${esc(hit.videoPath)}</div>`
      : `<div class="set-note">无有效音轨缓存（源视频已变更）。源视频在本机，将重新提取音轨后提交。</div>`;
    if (!cands.length) {
      body.innerHTML = statusHtml + '<div class="set-note err">没有其他在线服务可选（仅登记了本行服务，或其他服务均离线）</div>';
      return;
    }
    const opts = cands.map((e, i) => `
      <label class="chk-row"><input type="radio" name="rerun-engine" value="${esc(e.name)}"${i === 0 ? " checked" : ""}>
      <span>${esc(e.name)} <span class="muted small mono">${esc(e.url)}</span></span></label>`).join("");
    body.innerHTML = `
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
        const h = hit!;
        // 第一段：取 opus（缓存命中直接复用；错开从源视频重提）
        let opusPath: string; let audioBytes: number;
        if (h.opusValid) {
          opusPath = h.opusPath; audioBytes = h.audioBytes;
          prog.textContent = "上传音轨中…";
        } else {
          prog.textContent = "重新提取音轨中…";
          const shim = new File([], h.videoName) as File & { _localPath?: string };
          Object.defineProperty(shim, "size", { value: h.videoBytes || 1, configurable: true });
          shim._localPath = h.videoPath;
          const res = await new Promise<Blob | { skipped: true }>((resolve, reject) => {
            jav()!.extractAudio(shim, (pr) => {
              prog.textContent = `重新提取音轨 · ${Math.round(pr * 100)}%`;
            }).then(resolve, reject);
          });
          if (!res || "skipped" in res) throw new Error("音轨提取被跳过（文件为空或超限）");
          const b = res as Blob & { _javOpusPath?: string; _javOpusSize?: number };
          opusPath = b._javOpusPath || "";
          audioBytes = b._javOpusSize || 0;
          if (!opusPath) throw new Error("音轨提取没有产生可用音频");
          prog.textContent = "上传音轨中…";
        }
        // 第二段：复用现有上传通道提交到目标服务（字节进度回显）
        const upFile = new File([], h.videoName) as File & { _localPath?: string };
        Object.defineProperty(upFile, "size", { value: audioBytes, configurable: true });
        const audio = new Blob([]) as Blob & { _javOpusPath?: string; _javOpusSize?: number };
        Object.defineProperty(audio, "size", { value: audioBytes, configurable: true });
        audio._javOpusPath = opusPath;
        audio._javOpusSize = audioBytes;
        const d = await t.uploadAudio(upFile, eng, audio, (loaded, total, pct) => {
          prog.textContent = `上传音轨 ${mb(loaded)} / ${mb(total)} MB · ${pct.toFixed(1)}%`;
        });
        if (!d.ok) throw new Error(d.error || "音频上传失败");
        if (d.cached) prog.textContent = "服务端已缓存，免上传";
        // 等接受出具 job_id（desktop transport：201 即列 done；兼容 web 轮询语义多轮几次）
        let jobId = "";
        for (let i = 0; i < 20 && !jobId; i++) {
          const st = await t.getUpload(d.uploadId);
          if (st.phase === "done") jobId = st.job_id || "";
          else if (st.phase === "error") throw new Error(st.error || "提交失败");
          else await new Promise((r) => setTimeout(r, 300));
        }
        if (!jobId) throw new Error("提交接受超时（可在任务表查看）");
        state.writeBackJobs.set(eng + "|" + jobId, {
          engine: eng, videoName, dirHandle: null, videoPath: h.videoPath,
        });
        hideModal();
        toast(`换服务重跑：「${videoName}」→ 「${eng}」任务 ${jobId}`, "ok");
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
    scan: "服务端「扫描目录」的判定规则",
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

  function openSettings(name: string) {
    showModal(`「${name}」服务设置`);
    $("modal").classList.add("modal-wide"); // 仅服务设置加宽一倍（其他复用 #modal 的弹窗不受影响）
    const e = (state.engines || []).find((x) => x.name === name);
    const body = $("modal-body");
    if (!e || !e.has_key) {
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
          openSettings(name);
        } catch (e2) {
          toast((e2 as Error).message, "err");
        }
      };
      ($("key-input") as HTMLInputElement).focus();
      return;
    }
    body.innerHTML = '<div class="muted">加载设置中…</div>';
    t.getConfig(name)
      .then((items) => renderConfigForm(name, items))
      .catch((err: Error) => {
        body.innerHTML = `
        <div class="set-note err">
          <div class="set-note-title">无法读取服务端设置</div>
          ${esc(err.message)}
        </div>
        <div class="muted small">提示：若 Key 不正确，先把 Key 清空（保存空值）再重填；若提示版本过旧，请升级该服务端的 JavScribe。</div>`;
      });
  }

  function renderConfigForm(name: string, items: ConfigItem[]) {
    state.cfgItems = items;
    const e = (state.engines || []).find((x) => x.name === name);
    const groups: Record<string, ConfigItem[]> = {};
    for (const it of items) {
      const g = it.path.split(".")[0];
      (groups[g] = groups[g] || []).push(it);
    }
    const body = $("modal-body");
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
    html += `
    <div class="cfg-global-note"><b>服务端级设置</b>：以下改动作用于服务端本身，影响<b>所有连接该服务的客户端</b>（对新提交的任务生效）。</div>`;
    // tab 分类：总览（组件就绪）+ 各设置组；组顺序 = GROUP_ZH 既定顺序，未知组（服务端新增）排末尾兜底
    const orderedGroups = [
      ...Object.keys(GROUP_ZH).filter((k) => groups[k]),
      ...Object.keys(groups).filter((k) => !(k in GROUP_ZH)),
    ];
    const tabBtnHtml = (key: string, label: string, on: boolean): string =>
      `<button type="button" class="cfg-tab${on ? " on" : ""}" role="tab" data-pane="${esc(key)}" aria-selected="${on ? "true" : "false"}">${esc(label)}<i class="cfg-tab-dot" hidden></i></button>`;
    html += '<div class="cfg-tabs" role="tablist" id="cfg-tabs">';
    html += tabBtnHtml("ready", "总览", true);
    for (const g of orderedGroups) html += tabBtnHtml(g, GROUP_ZH[g] || g, false);
    html += "</div>";
    // 总览 pane = 组件就绪自检卡片（serve 0.2.6+ GET /ready）：打开弹窗即拉取一次
    html += `
    <div class="cfg-tab-pane" data-pane="ready" role="tabpanel">
      <section class="cfg-sec cfg-sec-ready" data-sec="ready">
        <h4 class="cfg-sec-title">组件就绪${`<span class="cfg-sec-desc">模型 / 引擎 / GPU / 磁盘等是否就绪</span>`}${helpIcon("服务端各组件与模型的就绪自检（serve v0.2.6+）。仅本地检查（文件存在性/命令探测），不探测 LLM、Emby 等网络连通性；连通性由任务级失败体现。旧版服务无此接口，显示升级提示。")}</h4>
        <div class="ready-body" id="ready-body"><div class="muted small">检查中…</div></div>
      </section>
    </div>`;
    for (const g of orderedGroups) {
      const list = groups[g];
      html += `
      <div class="cfg-tab-pane" data-pane="${esc(g)}" role="tabpanel" hidden>
        <section class="cfg-sec" data-sec="${esc(g)}">
          <h4 class="cfg-sec-title">${esc(GROUP_ZH[g] || g)}${GROUP_DESC[g] ? `<span class="cfg-sec-desc">${esc(GROUP_DESC[g])}</span>` : ""}</h4>
          <div class="cfg-sec-body">${list.map(configFieldHtml).join("")}</div>
        </section>
      </div>`;
    }
    const hasSecret = items.some((i) => i.type === "secret");
    html += `
    <div class="cfg-foot">
      <span class="cfg-foot-note">保存后对新提交的任务生效${hasSecret ? "；Key 类留空 = 保持不变" : ""}</span>
      <span id="cfg-dirty" class="muted small">无改动</span>
      <span class="cfg-foot-actions">
        <button type="button" id="cfg-reset" class="btn" hidden>重置改动</button>
        <button type="button" id="cfg-save" class="btn btn-primary">保存设置</button>
      </span>
    </div>`;
    body.innerHTML = html;
    loadReadiness(name);
    // tab 切换：全部 pane 常驻 DOM 仅显隐（输入值/dirty 态保留）；未保存项在所属 tab 上点圆点
    const cfgTabs = Array.from(body.querySelectorAll<HTMLButtonElement>(".cfg-tab"));
    const cfgPanes = Array.from(body.querySelectorAll<HTMLElement>(".cfg-tab-pane"));
    const syncCfgTabDots = (): void => {
      for (const p of cfgPanes) {
        const dot = body.querySelector<HTMLElement>(
          `.cfg-tab[data-pane="${CSS.escape(p.dataset.pane || "")}"] .cfg-tab-dot`);
        if (dot) dot.hidden = p.querySelectorAll<HTMLElement>(".cfg-row.dirty").length === 0;
      }
    };
    const showCfgPane = (key: string): void => {
      for (const tb of cfgTabs) {
        const on = (tb.dataset.pane || "") === key;
        tb.classList.toggle("on", on);
        tb.setAttribute("aria-selected", on ? "true" : "false");
      }
      for (const p of cfgPanes) p.hidden = (p.dataset.pane || "") !== key;
    };
    for (const tb of cfgTabs) tb.onclick = () => showCfgPane(tb.dataset.pane || "ready");
    // 改动追踪：控件当前值与初始快照比较，差异行标 .dirty（标签前圆点 + 描边高亮）
    body.querySelectorAll<HTMLElement>(".cfg-row").forEach((row) => {
      const ctl = row.querySelector<HTMLInputElement | HTMLSelectElement>("input, select");
      if (!ctl) return;
      const sync = (): void => {
        const cur = ctl instanceof HTMLInputElement && ctl.type === "checkbox"
          ? JSON.stringify(ctl.checked)
          : JSON.stringify(ctl.value);
        row.classList.toggle("dirty", cur !== (row.dataset.base ?? ""));
        const n = body.querySelectorAll(".cfg-row.dirty").length;
        const d = $("cfg-dirty");
        if (d) d.textContent = n ? `有 ${n} 项未保存` : "无改动";
        const r = $("cfg-reset");
        if (r) r.hidden = n === 0;
        syncCfgTabDots();
      };
      ctl.addEventListener("input", sync);
      ctl.addEventListener("change", sync);
      if (ctl.type === "checkbox" && GATE_SEC[row.dataset.path || ""]) {
        ctl.addEventListener("change", () => applyGating(body));
      }
    });
    applyGating(body);
    ($("cfg-reset") as HTMLButtonElement).onclick = () => {
      body.querySelectorAll<HTMLElement>(".cfg-row").forEach((row) => {
        const ctl = row.querySelector<HTMLInputElement | HTMLSelectElement>("input, select");
        if (!ctl) return;
        const base = JSON.parse(row.dataset.base ?? '""') as boolean | string;
        if (ctl.type === "checkbox") ctl.checked = base === true;
        else ctl.value = base === true ? "true" : base === false ? "false" : String(base);
        ctl.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    ($("cfg-save") as HTMLButtonElement).onclick = () => saveConfig(name);
  }

  // 组件就绪自检：拉取 /ready 渲染卡片；旧服务(unsupported)/离线(unreachable)降级为提示，不 throw
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
      const opts = (it.options || []).map((o: string) =>
        `<option value="${esc(o)}"${o === it.value ? " selected" : ""}>${esc(zh[o] || o)}</option>`).join("");
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
      : it.type === "float" ? "留空用服务端默认（0.5）" : "";
    const numAttrs = it.type === "float" ? ' step="0.05" min="0.01" max="0.99"' : it.type === "int" ? ' min="1"' : "";
    return `<div class="cfg-row" data-path="${esc(it.path)}" data-base="${esc(base)}">
      ${lab(it.label)}
      <input id="${id}" type="${type}"${numAttrs} class="${it.type === "secret" ? "mono" : ""}"
             value="${esc(val)}" placeholder="${esc(ph)}" spellcheck="false" autocomplete="off"></div>`;
  }

  async function saveConfig(name: string) {
    const values: Record<string, unknown> = {};
    for (const it of state.cfgItems) {
      const f = $("cfg-" + it.path.replace(/\./g, "-")) as HTMLInputElement;
      if (!f) continue;
      if (it.type === "bool") {
        values[it.path] = f.checked;
      } else if (it.type === "int") {
        const v = parseInt(f.value, 10);
        if (isNaN(v) || v < 1) { toast(`${it.label} 需要正整数`, "err"); return; }
        values[it.path] = v;
      } else if (it.type === "float") {
        if (f.value.trim() === "") continue; // 空 = 保持服务端默认阈值
        const v = parseFloat(f.value);
        if (isNaN(v) || v < 0.01 || v > 0.99) { toast(`${it.label} 需在 0.01 ~ 0.99 之间`, "err"); return; }
        values[it.path] = v;
      } else if (it.type === "secret") {
        if (f.value === "") continue; // 空 = 保持
        values[it.path] = f.value;
      } else {
        values[it.path] = f.value;
      }
    }
    try {
      await t.putConfig(name, values);
      toast("服务设置已保存（对新提交的任务生效）", "ok");
      refresh();
      openSettings(name); // 重新拉取：敏感项回到打码、改动追踪归零
    } catch (e) {
      toast((e as Error).message, "err");
    }
  }

  // ---------- 本机目录扫描 ----------
  // 扫描规则统一在「客户端设置 · 扫描规则」维护（本机 client config 落盘）；面板不再放规则控件。
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
  function applyScanResult(d: ScanResult) {
    state.scanItems = d.items || [];
    state.lastScan = d;
    state.scanPage = 0;
    state.scanMapped = d.mapped === true;
    state.scanResolvedPath = d.path || "";
    state.scanChecked = new Set(state.scanItems.filter((i) => !i.has_subtitle && !i.too_small).map((i) => i.path));
    renderScanResults(d);
    updateScanGo();
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
    if (!engine || !path || state.busy) return;
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
    $("scan-submit").hidden = false;
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
      $("scan-submit").hidden = true;
      state.scanTask = null; renderScanTaskStatus(null);
      toast((err as Error).message, "err");
      updateScanGo();
    }
  };

  function renderScanResults(d: ScanResult) {
    const items = state.scanItems;
    if (state.scanMapped) {
      $("scan-mapped").hidden = false;
      $("scan-mapped").textContent =
        (platform.kind === "desktop" ? "已扫描实际路径：" : "已扫描映射后的实际路径：")
        + state.scanResolvedPath;
    } else {
      $("scan-mapped").hidden = true;
    }
    if (!items.length) {
      $("scan-table").innerHTML =
        '<div class="muted small">没有找到符合条件的视频文件。可到「客户端设置 · 扫描规则」调整扩展名'
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
        <thead><tr><th class="col-check"></th><th>文件</th><th class="col-size">大小</th><th class="col-sub">字幕</th></tr></thead>
        <tbody>
          ${pageItems.map((i) => {
            const langs = (i.embedded_langs || []).join("/") || "—";
            const subCell = i.subtitle_status === "external"
              ? `<span class="tag subtag" title="${esc(i.subtitle || "")}">外部 srt</span><button type="button" class="srt-pv" data-srt="${esc(i.subtitle ? siblingOf(i.path, i.subtitle) : "")}" title="预览字幕内容">预览</button>`
              : i.subtitle_status === "named"
              ? `<span class="tag subtag" title="文件名含标记 ${esc(i.name_sub_token || "")}，按规则视为已压字幕（可在「客户端设置 · 扫描规则」改判）">标记（名）</span>`
              : i.subtitle_status === "embedded"
              ? `<span class="tag subtag warn" title="普通扫描不会读取视频内容；如需确认内嵌字幕，请单独发起检查">内嵌字幕（需单独检查）</span>`
              : i.name_no_sub
              ? `<span class="tag subtag ok" title="文件名含标记 ${esc(i.name_no_sub_token || "")}，按规则视为无字幕版（可在「客户端设置 · 扫描规则」改判）">无字幕（名）</span>`
              : '<span class="muted" title="普通扫描不会读取视频内容">未检查</span>';
            return `
            <tr class="${i.has_subtitle ? "has-sub" : ""}${i.too_small ? " too-small" : ""}">
              <td class="col-check"><input type="checkbox" data-path="${esc(i.path)}"${state.scanChecked.has(i.path) ? " checked" : ""}></td>
              <td class="scan-name mono" title="${esc(i.path)}">${esc(i.name)}${i.too_small ? '<span class="tag tinytag" title="低于「忽略小于」阈值，不默认选中；可手动勾选提交">过小</span>' : ""}</td>
              <td class="col-size mono muted">${mb(i.size)} MB</td>
              <td class="col-sub">${subCell}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`;
      $("scan-table").querySelectorAll("input[type=checkbox]").forEach((cb) => {
        const input = cb as HTMLInputElement;
        input.onchange = () => {
          if (input.checked) state.scanChecked.add(input.dataset.path || "");
          else state.scanChecked.delete(input.dataset.path || "");
          updateScanSummary();
        };
      });
      renderScanPager(items.length);
    }
    $("scan-results").hidden = false;
    $("scan-submit").hidden = false;
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
    let text = total ? `已选 ${n} / ${total}` : "";
    if (nSub) text += ` · ${nSub} 个已有字幕默认不勾选`;
    if (nSmall) text += ` · ${nSmall} 个过小未选`;
    text += (text ? " · " : "") + "内嵌字幕未检查（不会触发网盘下载）";
    if (truncated) text += (text ? " · " : "") + "列表已截断（仅前 5000 项）";
    $("scan-count").textContent = text;
    const button = scanSubmit;
    button.disabled = n === 0 || !engineSelect.value || state.busy;
    button.innerHTML = "&#9654; 生成字幕（已选择 " + n + " 项）";
    // 「全选」只覆盖非「忽略」文件：too_small 只能手动勾选
    const selectable = state.scanItems.filter((i) => !i.too_small).length;
    scanSelectAll.checked = selectable > 0 && state.scanChecked.size === selectable;
  }

  scanSelectAll.onchange = (ev) => {
    const checked = (ev.target as HTMLInputElement).checked;
    // 过小（忽略）文件不参与全选，保持未选
    state.scanChecked = checked
      ? new Set(state.scanItems.filter((i) => !i.too_small).map((i) => i.path))
      : new Set<string>();
    $("scan-table").querySelectorAll("input[type=checkbox]")
      .forEach((cb) => {
        const input = cb as HTMLInputElement;
        input.checked = state.scanChecked.has(input.dataset.path || "");
      });
    updateScanSummary();
  };

  scanSubmit.onclick = async () => {
    const engine = engineSelect.value;
    const files = [...state.scanChecked];
    if (!engine || !files.length || state.busy) return;
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
    try {
      // 主任务（batch）：扫描提交恒生成（label=扫描目录名）
      const batch = { id: genBatchId(), label: batchLabelForScan() };
      const d = await t.submitScan(engine, files, subStatus, batch);
      if (d.skipped && d.skipped.length) {
        const names = d.skipped.slice(0, 3).join("、") + (d.skipped.length > 3 ? ` 等 ${d.skipped.length} 项` : "");
        toast(`已跳过 ${d.skipped.length} 个在跑/排队的重复任务：${names}`, "");
      }
      if (d.files > 0) {
        toast(d.jobId
          ? `已入队 ${d.files} 项 → 任务 ${d.jobId}`
          : `已入队 ${d.files} 项（本机扫描）→ 任务表中跟进，完成后字幕自动落回本机影片旁`, "ok");
      }
      state.scanItems = [];
      state.scanChecked = new Set();
      state.lastScan = null;
      state.scanPage = 0;
      $("scan-pager").hidden = true;
      $("scan-results").hidden = true;
      $("scan-submit").hidden = true;
      $("scan-table").innerHTML = "";
      refresh();
      webShowView("jobs"); // 提交即进任务看板
    } catch (e) {
      if (platform.kind === "desktop" && e instanceof TransportError && e.code === "not-found") {
        toast("所选服务读不到这些本机路径，已改为本机提取后上传到该服务", "");
        dispatchLocalScanPaths(engine, files, { id: genBatchId(), label: batchLabelForScan() });
        return;
      }
      toast((e as Error).message, "err");
    } finally {
      updateScanSummary();
    }
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
          const engine = engineSelect.value;
          if (!engine) { watchRender(); return; } // 未选服务：留队列等（onchange / 5s 轮询会再触发）
          if (!canDispatch(engine)) return; // S4 在途封顶：留队列等（refresh / watchPump 5s 安全网重触发）
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
          dispatchTracked(f, engine, "监听 · ").then(([ok, d]) => {
            watchDispatchingPath = null;
            state.busy = false;
            updateGo();
            const up = d as UploadStatus;
            if (ok && up.job_id) {
              const k = engine + "|" + up.job_id;
              state.writeBackJobs.set(k, { engine, videoName: it.name, dirHandle: null, videoPath: it.path });
              state.watchWriteBack.add(k); // 完成后强制写回影片同目录（不受 autoSave 门控）
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

  // ---------- 客户端设置 tab（本机工作台并发 + 桌面专属：更新设置 / 文件夹监听） ----------
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
    let scanVals = { exts: "", pats: "", recurse: true, min: 200, hasTok: "", noTok: "c" };
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
    let html = '<div class="cc-cards">';
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
          <span class="cfg-lab">疑似已压字幕标记${helpIcon("文件名 token（按 - _ . 空格等分隔）整词命中即视为已压字幕版，命中才默认不选。逗号分隔，如 c、chs；大小写不敏感。空 = 不识别。")}</span>
          <input id="cc-scan-has-tokens" class="mono" type="text" placeholder="空 = 不识别" value="${esc(scanVals.hasTok)}" spellcheck="false" autocomplete="off"></div>
        <div class="cfg-row ccfg-row" data-base="${esc(scanVals.noTok)}">
          <span class="cfg-lab">疑似无字幕标记${helpIcon("文件名 token 整词命中即显示「无字幕（名）」信息标（只提示、不拦截）。逗号分隔，如 c；大小写不敏感。默认 c。空 = 不识别。")}</span>
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
        <label class="chk-row"><input type="checkbox" id="cc-up-enabled"${upCfg && upCfg.enabled ? " checked" : ""}><span>启动时自动检查更新</span></label>
        <div class="cfg-row"><span class="cfg-lab">镜像源（URL 前缀，如 https://gh-proxy.example.com/；留空走官方）</span>
        <input id="cc-up-mirror" class="mono" type="text" placeholder="留空使用 GitHub 官方" value="${esc(upCfg?.mirror || "")}"></div>
        <div class="cfg-row"><span class="cfg-lab">更新代理（socks5://127.0.0.1:10808 或 http://127.0.0.1:7890；留空直连）</span>
        <input id="cc-up-proxy" class="mono" type="text" placeholder="留空直连 GitHub" value="${esc(upCfg?.proxy || "")}"></div>
      </div>
      <div class="ccfg-foot">
        <span class="cfg-foot-note">保存后立即生效（代理下次检查/下载即走新代理）</span>
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
    html += "</div>";
    body.innerHTML = html;
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
        if (d) d.textContent = n ? `有 ${n} 项未保存` : "无改动";
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
        if (isNaN(ew) || ew < 1 || ew > 8) { toast("音轨提取并发需在 1 ~ 8 之间", "err"); return; }
        if (isNaN(qc) || qc < 1 || qc > 16) { toast("转译并发需在 1 ~ 16 之间", "err"); return; }
        try {
          await t.putClientConfig!({ extract_workers: ew, queue_cap: qc });
          // S4：保存成功才应用本端内存（R2：保存失败不落内存，下轮 refresh 读回自愈）
          state.ccfg = normalizeClientConfig({ ...(state.ccfg || {}), extract_workers: ew, queue_cap: qc });
          jav()?.wakeExtract?.(); // 提取并发变更 → 释放池等待者
          pumpDispatch();         // 在途封顶变更 → 立即重判排队项
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
        return ctl.type === "checkbox" ? String(ctl.checked) : ctl.value;
      };
      const ccScanDirty = (): void => {
        let n = 0;
        for (const row of scanRows) {
          const changed = sRowVal(row) !== (row.dataset.base ?? "");
          row.classList.toggle("dirty", changed);
          if (changed) n++;
        }
        const d = $("cc-scan-dirty");
        if (d) d.textContent = n ? `有 ${n} 项未保存` : "无改动";
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
  let savedView = "dispatch";
  try { savedView = localStorage.getItem("javview_view") || "dispatch"; } catch { /* 忽略 */ }
  const initialView: ViewName = VIEWS.includes(savedView as ViewName) ? (savedView as ViewName) : "dispatch";
  webShowView = (view: ViewName) => {
    for (const v of VIEWS) secs[v].classList.toggle("view-on", v === view);
    for (const item of navItems) {
      const active = item.dataset.view === view;
      item.classList.toggle("on", active);
      item.setAttribute("aria-selected", active ? "true" : "false");
    }
    try { localStorage.setItem("javview_view", view); } catch { /* 忽略 */ }
    if (view === "ccfg") void renderCcView(); // 激活即重渲染（取最新值；seq 丢弃过期异步）
  };
  webShowView(initialView);
  for (const item of navItems) {
    item.addEventListener("click", () => webShowView(item.dataset.view as ViewName));
  }
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

  // S4：提取并发读者注入（闭包实时读 state.ccfg，注入一次不缓存值）+ 启动读回客户端设置（验收 d）
  jav()?.setExtractLimit?.(() => state.ccfg?.extract_workers ?? CLIENT_CFG_DEFAULTS.extract_workers);
  if (t.getClientConfig) void t.getClientConfig()
    .then((cc) => { state.ccfg = normalizeClientConfig(cc); })
    .catch(() => {});
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
}
