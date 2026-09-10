// 字幕工作台前端主逻辑（web / desktop 共享 UI 层）。
// 由 static/app.js 机械迁移 + 类型标注，行为 1:1（回归基线：client/tests/e2e 四类套件）。
// 网络请求全部走 transport 接口（web 形态实现见 transport-web）。

import type { Transport } from "../core/transport";
import { LOCAL_SUB_PATTERNS, SRT_SUFFIX, VIDEO_EXTS } from "../core/constants";
import type { ConfigItem, Engine, JobRow, ScanItem, ScanResult, UpdateInfo, UploadStatus } from "../core/types";
import type { AudioCacheHit, LocalServeState, UpdateSettings, UpdateState, WatchCandidate, WatchState } from "../core/desktop-bridge";
import type { FolderFile, FolderVideo, PlatformAdapter, WriteBackInfo } from "../core/platform";
import type { JavExtractAPI } from "./extract";
import { $, esc } from "./dom";
import { toast } from "./toast";

const DEFAULT_TITLE = "JavScribe 字幕工作台";

interface AppState {
  file: File | null;
  folderFiles: FolderVideo[] | null;
  filter: string;
  busy: boolean;
  knownJobs: Map<string, string>;
  retried: Set<string>;
  engines: Engine[];
  cfgItems: ConfigItem[];
  scanItems: ScanItem[];
  scanMapped: boolean;
  scanResolvedPath: string;
  scanChecked: Set<string>;
  page: number;              // 任务分页：当前页（0 起）
  pageSize: number;          // 任务分页：每页行数
  _jobs: JobRow[];           // 最近一次 /api/jobs 结果（翻页/筛选即时重渲染，不等网络）
  extractMode: "auto" | "local" | "server";
  autoSave: boolean;
  writeBackJobs: Map<string, WriteBackInfo>; // jobKey(engine|job_id) -> { engine, videoName, dirHandle|null }
  watchWriteBack: Set<string>;          // watch 派发任务完成后强制写回（不受 autoSave 门控；仅 desktop 会写入）
  _fsFileDir: FileSystemDirectoryHandle | null; // 当前单文件所选目录句柄（File System Access API，用于写回源目录）
}

const savedExtract = localStorage.getItem("javweb_extract");

const state: AppState = {
  file: null,
  folderFiles: null,
  filter: "all",
  busy: false,
  knownJobs: new Map(),
  retried: new Set(),
  engines: [],
  cfgItems: [],
  scanItems: [],
  scanMapped: false,
  scanResolvedPath: "",
  scanChecked: new Set(),
  page: 0,
  pageSize: 20,
  _jobs: [],
  extractMode: savedExtract === "auto" || savedExtract === "local" || savedExtract === "server"
    ? savedExtract
    : "auto",
  autoSave: localStorage.getItem("javweb_autosave") === "1",
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
  skipped: "跳过", canceled: "已取消", pending: "排队",
};

function fmtDuration(s: number | null | undefined): string {
  if (s == null || !isFinite(s) || s < 0) return "";
  const v = Math.round(s);
  const h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), ss = v % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

function mb(b: number): number { return Math.round(b / 1048576); }

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
  const scanGo = $("scan-go") as HTMLButtonElement;
  const scanSubmit = $("scan-submit") as HTMLButtonElement;
  const scanSelectAll = $("scan-select-all") as HTMLInputElement;
  const line1 = $("line-1");
  const line2 = $("line-2");
  const jobPager = $("job-pager");
  const jobList = $("job-list");
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
      const [health, engines, jobs] = await Promise.all([
        t.getHealth(), t.listEngines(), t.listJobs(),
      ]);
      const allOnline = health.online === health.engines && health.engines > 0;
      $("health").textContent = `v${health.version} · 服务 ${health.online}/${health.engines} 在线`;
      $("health").style.color = allOnline ? "" : "var(--err)";
      $("foot-ver").textContent = "v" + health.version;
      renderEngines(engines);
      state._jobs = jobs;
      renderJobs(jobs);
      renderSelect(engines);
      $("last-updated").textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
      notifyJobChanges(jobs);
      updateTitle(jobs);
      viewBadge(jobs.filter((r) => r.status === "running").length);
    } catch (_e) { /* 网络抖动：保留上一次渲染 */ }
    watchPump(); // watch 队列安全网：漏触发的消费在 5s 内自愈
    if (platform.kind === "web") void refreshUpdateWeb();
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

  // ---- web 形态：GET /api/update（独立链路，失败静默，绝不拖累主刷新） ----
  let updateWeb: UpdateInfo | null = null;
  async function refreshUpdateWeb() {
    try {
      const u = await t.getUpdate();
      updateWeb = u.enabled && u.has_update && u.latest_app ? u : null;
    } catch (_e) {
      updateWeb = null; // 更新检查失败静默降级，不打扰看板
    }
    renderUpChip();
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
    <div class="set-note">当前工作台 v${esc(u.current)} → 最新 ${esc(rel.version)}${
      u.latest_client ? `<br>桌面端 JavScribe Client 已有 ${esc(u.latest_client.version)}（应用内自动检查更新，见 GitHub Releases）` : ""
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
    if (s.status === "available") {
      body.innerHTML = `
      <div class="set-note">当前 v${esc(curVer || "?")} → 最新 v${esc(s.version || "?")}。下载完成后需重启应用完成安装。</div>
      <div class="up-sec-label">更新说明</div>
      <pre class="up-changelog">${esc(s.notes || "（无发布说明）")}</pre>
      <div class="up-row">
        <button type="button" class="btn btn-primary" id="up-dl">下载并安装</button>
        <button type="button" class="btn" id="up-later">稍后提醒</button>
        <button type="button" class="btn" id="up-ignore">忽略此版本</button>
      </div>
      <div class="up-sec-label">高级</div>
      <label class="chk-row"><input type="checkbox" id="up-enabled"${upSettings?.enabled ? " checked" : ""}><span>启动时自动检查更新</span></label>
      <label class="field"><span class="field-label">镜像源（URL 前缀，如 https://gh-proxy.example.com/；留空走官方）</span>
      <input id="up-mirror" class="mono" type="text" placeholder="留空使用 GitHub 官方" value="${esc(upSettings?.mirror || "")}"></label>
      <div class="up-row">
        <button type="button" class="btn" id="up-save-set">保存设置</button>
        <span class="muted small">镜像源下次启动应用时生效。</span>
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
    <div class="muted small">若网络无法直连 GitHub，可设置镜像源后重试。</div>`;
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
      <span class="tag">v${esc(e.version || "—")}</span>
      <span class="tag${e.jobs_running ? " hot" : ""}">运行 ${e.jobs_running || 0}</span>
      ${e.online ? "" : `<div class="eng-err">${esc(e.error || "离线")}</div>`}
    </div>`;
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
    }
    const order = Array.from(grid.children).map((c) => (c as HTMLElement).dataset.name).join("\u0001");
    if (order !== list.map((e) => e.name).join("\u0001")) {
      for (const e of list) grid.appendChild(cards.get(e.name)!);
    }
  }

  $("engine-grid").onclick = async (ev) => {
    const target = ev.target as HTMLElement;
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

  function jobRowData(j: JobRow, now: number) {
    const pct = Math.round((j.progress || 0) * 100);
    const isRun = j.status === "running";
    const pos = j.duration_s != null && j.position ? `${j.position} / ${fmtDuration(j.duration_s)}` : (j.position || "—");
    const elapsed = j.created ? fmtDuration((j.finished || now) - j.created) : "—";
    let eta = "";
    const prog = j.progress || 0;
    if (isRun && prog > 0.01 && j.created) {
      const el = now - j.created;
      eta = el > 5 ? fmtDuration(el * (1 - prog) / prog) : "";
    }
    // 跳过行优先显示 message（含已存在字幕的完整路径）
    const sub = j.status === "skipped" && j.message ? j.message
      : (j.label && j.label !== j.file) ? j.label : (j.message || "");
    const dl = j.status === "done" && j.job_id
      ? `<a class="dl-btn" href="${t.getResultUrl(j.engine, j.job_id)}" download>&#8595; 下载 srt</a>`
      : "";
    const retryKey = j.engine + "|" + (j.job_id || "");
    const retry = j.status === "skipped" && j.job_id && !state.retried.has(retryKey)
      ? `<button type="button" class="dl-btn retry" data-eng="${esc(j.engine)}" data-jid="${esc(j.job_id)}" title="删除已存在字幕并重新生成">&#8635; 仍要重新生成</button>`
      : (j.status === "skipped" ? `<span class="retried-note">已重新提交</span>` : "");
    // 换服务重跑（仅 desktop）：终态行复用本地音轨缓存向其他服务提交新任务
    const rerunBtn = (platform.kind === "desktop" && j.file
      && (j.status === "done" || j.status === "error" || j.status === "skipped"))
      ? `<button type="button" class="dl-btn rerun" data-file="${esc(j.file)}" data-eng="${esc(j.engine)}" data-jid="${esc(j.job_id || "")}" title="复用该影片的本地音轨缓存，选择另一个服务端重新提交">&#8644; 换服务重跑</button>`
      : "";
    // core：变化时整行重写（状态/文件/操作按钮，低频）；pct/eta/pos/elapsed 单独打补丁（高频）
    const core = [j.status, j.engine, j.file, sub, dl, retry, rerunBtn].join("\u0001");
    const html = `
      <div class="job-cell">${esc(j.engine)}</div>
      <div class="job-name"><div class="fn">${esc(j.file)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
      <div><span class="pill p-${esc(j.status)}"><i></i>${STATUS_ZH[j.status] || esc(j.status)}</span></div>
      <div class="prog"><div class="bar${isRun ? " live" : ""}"><div style="width:${pct}%"></div></div><span class="pct mono">${pct}%</span><span class="eta"></span></div>
      <div class="job-cell mono cell-pos">${esc(pos)}</div>
      <div class="job-cell mono cell-elapsed">${esc(elapsed)}</div>
      <div class="job-actions">${dl}${retry}${rerunBtn}</div>`;
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

  function renderJobs(rows: JobRow[]) {
    const running = rows.filter((r) => r.status === "running").length;
    const done = rows.filter((r) => r.status === "done").length;
    const skipped = rows.filter((r) => r.status === "skipped").length;
    const failed = rows.filter((r) => r.status === "error" || r.status === "canceled").length;
    $("job-stats").innerHTML =
      `<span class="stat${running ? " s-run" : ""}">进行中 <b>${running}</b></span>` +
      `<span class="stat">完成 <b>${done}</b></span>` +
      `<span class="stat">跳过 <b>${skipped}</b></span>` +
      `<span class="stat">失败 <b>${failed}</b></span>`;

    const filtered = visibleRows(rows);

    // 分页：只渲染当前页；stats/空态仍基于全量 filtered。页码越界自动收回（任务完成会收缩列表）。
    const pages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
    if (state.page >= pages) state.page = pages - 1;
    const pageRows = filtered.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize);

    const list = jobList;
    $("jobs-empty").hidden = filtered.length > 0;
    $("jobs-empty-text").textContent = rows.length ? "当前筛选下无任务" : "暂无任务";
    const now = Date.now() / 1000;
    const rowMap = new Map<string, JobRowEl>();
    for (const r of Array.from(list.children)) rowMap.set((r as HTMLElement).dataset.jkey ?? "", r as JobRowEl);
    const wanted = new Set<string>();
    for (const j of pageRows) {
      const key = jobKey(j);
      wanted.add(key);
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
        list.appendChild(row);
        rowMap.set(key, row);
      } else if (row._core !== d.core) {
        row._core = d.core;
        row._html = d.html;
        row.innerHTML = d.html;
        row.className = "job-grid job-row" + (j.status === "running" ? " running" : "");
      }
      patchJobRow(row, d.pct, d.eta, d.pos, d.elapsed);
    }
    for (const [k, r] of rowMap) if (!wanted.has(k)) r.remove();
    const order = Array.from(list.children).map((r) => (r as HTMLElement).dataset.jkey).join("\u0001");
    if (order !== pageRows.map(jobKey).join("\u0001")) {
      for (const j of pageRows) list.appendChild(rowMap.get(jobKey(j))!);
    }
    renderPager(filtered.length);
  }

  // ---------- 任务分页（基于缓存即时翻页，不请求网络；5s 轮询照常刷新数据） ----------
  function visibleRows(rows: JobRow[]) {
    return rows.filter((r) =>
      state.filter === "all" ? true :
      state.filter === "running" ? r.status === "running" : r.status !== "running");
  }

  function renderPager(total: number) {
    const el = jobPager;
    const pages = Math.max(1, Math.ceil(total / state.pageSize));
    if (pages <= 1) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    el.innerHTML =
      `<button type="button" id="pg-prev" class="pg-btn" ${state.page === 0 ? "disabled" : ""} aria-label="上一页">&#8249;</button>` +
      `<span class="pg-info mono">第 ${state.page + 1} / ${pages} 页 · 共 ${total} 条</span>` +
      `<button type="button" id="pg-next" class="pg-btn" ${state.page >= pages - 1 ? "disabled" : ""} aria-label="下一页">&#8250;</button>`;
  }

  jobPager.onclick = (ev) => {
    const target = ev.target as HTMLElement;
    const pages = Math.max(1, Math.ceil(visibleRows(state._jobs).length / state.pageSize));
    if (target.closest("#pg-prev") && state.page > 0) {
      state.page--; renderJobs(state._jobs);
    } else if (target.closest("#pg-next") && state.page < pages - 1) {
      state.page++; renderJobs(state._jobs);
    }
  };

  jobList.onclick = async (ev) => {
    const rb = (ev.target as HTMLElement).closest(".rerun") as HTMLButtonElement | null;
    if (rb && !rb.disabled) {
      if (state.busy) { toast("有正在进行的提交任务，请完成后再试", "err"); return; }
      void openRerunModal(rb.dataset.file || "", rb.dataset.eng || "", rb.dataset.jid || "");
      return;
    }
    const b = (ev.target as HTMLElement).closest(".retry") as HTMLButtonElement | null;
    if (!b || b.disabled) return;
    const tr = b.closest(".job-row");
    const name = tr?.querySelector(".fn")?.textContent || "";
    const jid = b.dataset.jid || "", eng = b.dataset.eng || "";
    state.retried.add(eng + "|" + jid);
    b.disabled = true; b.textContent = "重新生成中…";
    try {
      const d = await t.retryJob(eng, jid);
      const oldInfo = state.writeBackJobs.get(eng + "|" + jid);
      if (oldInfo) state.writeBackJobs.set(eng + "|" + d.jobId, oldInfo);
      toast(`「${name}」已删旧字幕并重新提交 → 任务 ${d.jobId}`, "ok");
      refresh();
    } catch (e) {
      state.retried.delete(eng + "|" + jid);
      toast(`重新生成失败：${(e as Error).message}`, "err");
      refresh();
    }
  };

  // ---------- 筛选 ----------
  for (const b of document.querySelectorAll<HTMLButtonElement>("#job-filter button")) {
    b.onclick = () => {
      state.filter = b.dataset.f || "all";
      state.page = 0;
      document.querySelectorAll("#job-filter button").forEach((x) => x.classList.toggle("on", x === b));
      renderJobs(state._jobs);
    };
  }

  // ---------- 服务表单 ----------
  engineForm.onsubmit = async (ev) => {
    ev.preventDefault();
    const name = engineName.value.trim();
    const url = engineUrl.value.trim();
    const api_key = engineKey.value.trim();
    try {
      await t.addEngine(name, url, api_key);
      (ev.target as HTMLFormElement).reset();
      refresh();
    } catch (e) {
      alert((e as Error).message);
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
    // 选项集（名称+在线态）无变化不重建：避免 5s 轮询周期性重绘把用户手选静默打回第一项
    const sig = pool.map((e) => `${e.name}:${e.online ? 1 : 0}`).join("|");
    if (sel.dataset.sig === sig) {
      updateGo();
      return;
    }
    const prev = sel.value;
    sel.dataset.sig = sig;
    sel.innerHTML = pool
      .map((e) => `<option value="${esc(e.name)}">${esc(e.name)}${engineHostHint(e)}${e.online ? "" : "（离线）"}</option>`)
      .join("");
    // 现存选中（用户手选）> 持久化值 > 第一项
    if (pool.some((e) => e.name === prev)) sel.value = prev;
    else {
      const saved = localStorage.getItem("javweb_engine");
      if (saved && pool.some((e) => e.name === saved)) sel.value = saved;
    }
    updateGo();
  }

  function pendingCount() {
    if (state.folderFiles) return state.folderFiles.filter((v) => !v.hasSub).length;
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
    scanGo.disabled =
      !scanPath.value.trim() || !engineSelect.value || state.busy;
  }

  engineSelect.onchange = () => {
    // 即时持久化：手选即生效，轮询刷新/重启后保留（修复「选了远程却提交到本地服务端」）
    if (engineSelect.value) localStorage.setItem("javweb_engine", engineSelect.value);
    updateGo();
    watchPump();
  };
  scanPath.oninput = updateScanGo;

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

  drop.onclick = () => { if (!state.busy) pickFile(); };
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

  // ---------- 选择文件夹（浏览器本地过滤，不依赖服务端） ----------
  function videoExt(name: string): string {
    const m = /\.([a-z0-9]{1,8})$/i.exec(name);
    return m ? m[1].toLowerCase() : "";
  }

  function clearFolder() {
    state.folderFiles = null;
    folderInput.value = "";
    $("folder-chip").hidden = true;
    resetPipeline();
    updateGo();
  }

  function setFolder(files: FolderFile[]) {
    if (!files || !files.length) return;
    state.file = null;
    fileInput.value = "";
    $("file-chip").hidden = true;
    drop.classList.remove("has-file");
    // 同目录名集合：用于判断「<stem>.zh.srt / <stem>.srt」是否已随文件夹选中
    const byDir = new Map<string, Set<string>>();
    for (const f of files) {
      const rel = f.webkitRelativePath || f.name;
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      if (!byDir.has(dir)) byDir.set(dir, new Set());
      byDir.get(dir)!.add(f.name.toLowerCase());
    }
    const vids: FolderVideo[] = [];
    for (const f of files) {
      if (!VIDEO_EXTS.includes(videoExt(f.name)) || f.size <= 0) continue;
      const rel = f.webkitRelativePath || f.name;
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const base = f.name.replace(/\.[^.]+$/, "").toLowerCase();
      const names = byDir.get(dir) || new Set<string>();
      const hasSub = LOCAL_SUB_PATTERNS.some((pat) => names.has(base + pat));
      vids.push({ file: f, hasSub });
    }
    if (!vids.length) {
      toast("该文件夹里没有支持的视频文件（mp4 / mkv / ts / mov …）", "err");
      return;
    }
    state.folderFiles = vids;
    const subN = vids.filter((v) => v.hasSub).length;
    $("folder-chip-text").textContent = subN
      ? `${vids.length} 个视频（${subN} 个已有字幕，将跳过）`
      : `${vids.length} 个视频`;
    $("folder-chip").hidden = false;
    resetPipeline();
    updateGo();
  }

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

  function startSingle(engine: string) {
    const file = state.file;
    if (!file) return;
    state.busy = true;
    updateGo();
    localStorage.setItem("javweb_engine", engine);
    preparePipeline();
    dispatchOne(file, engine).then(([ok, d]) => {
      if (ok) {
        const up = d as UploadStatus;
        state.writeBackJobs.set(engine + "|" + up.job_id, {
          engine, videoName: file.name, dirHandle: state._fsFileDir || null,
          videoPath: (file as FolderFile)._localPath || null,
        });
        showStatus(`已提交到「${engine}」· ${up.name} → 任务 ${up.job_id}，见上方任务表`, "ok");
        toast(`已提交到「${engine}」· ${up.name} → 任务 ${up.job_id}`, "ok");
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

  async function startBatch(engine: string) {
    const queue = (state.folderFiles || []).filter((v) => !v.hasSub).map((v) => v.file);
    state.busy = true;
    updateGo();
    localStorage.setItem("javweb_engine", engine);
    preparePipeline(`文件 1/${queue.length}`);
    let okN = 0;
    for (let i = 0; i < queue.length; i++) {
      const prefix = `文件 ${i + 1}/${queue.length} · `;
      preparePipeline(prefix + (effectiveMode(queue[i]) === "local" ? "开始本地提取…" : "开始上传…"));
      const [ok, d] = await dispatchOne(queue[i], engine, prefix);
      if (ok) {
        okN++;
        const up = d as UploadStatus;
        if (up.job_id) {
          state.writeBackJobs.set(engine + "|" + up.job_id, {
            engine, videoName: queue[i].name, dirHandle: queue[i]._dirHandle || null,
            videoPath: queue[i]._localPath || null,
          });
        }
      }
    }
    showStatus(
      okN === queue.length
        ? `批量完成：已提交 ${okN}/${queue.length} 项，见上方任务表`
        : `批量完成：成功 ${okN}/${queue.length} 项，其余失败（可重新选择文件夹）`,
      okN ? "ok" : "err"
    );
    finishBatch();
    refresh();
  }

  function finishBatch() {
    state.busy = false;
    state.folderFiles = null;
    folderInput.value = "";
    $("folder-chip").hidden = true;
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

  function uploadAudioBlob(f: File, engine: string, blob: Blob, prefix: string) {
    return new Promise<[boolean, UploadStatus]>((resolve) => {
      t.uploadAudio(f, engine, blob, (loaded, total, pct) => {
        setStep("step-extract", "active", "2",
          `${prefix}上传音频 ${mb(loaded)} / ${mb(total)} MB · ${pct.toFixed(1)}%`);
        setFill(pct + "%");
      }).then((d) => {
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
  function serverUpload(f: File, engine: string, labelPrefix?: string) {
    const prefix = labelPrefix || "";
    return new Promise<DispatchOutcome>((resolve) => {
      t.uploadFile(f, engine, (loaded, total, pct) => {
        setStep("step-upload", "active", "1",
          `${prefix}${mb(loaded)} / ${mb(total)} MB · ${pct.toFixed(1)}%`);
        setFill(pct + "%");
      }).then((d) => {
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
  function dispatchOne(f: File, engine: string, labelPrefix?: string): Promise<DispatchOutcome> {
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
            return serverUpload(f, engine, prefix);
          }
          if (!r || "skipped" in r) {
            if (state.extractMode === "local") {
              const msg = "文件超过 1.6GB，无法在浏览器本地提取";
              setStep("step-upload", "error", "\u2715", prefix + msg);
              return [false, { error: msg }];
            }
            labelPipeline("server");
            return serverUpload(f, engine, prefix);
          }
          setStep("step-upload", "done", "\u2713",
            `${prefix}本地提取完成 · 音频 ${mb(r.size)} MB`);
          line1.classList.add("on");
          setStep("step-extract", "active", "2", prefix + "准备上传音频…");
          setFill("0", true);
          return uploadAudioBlob(f, engine, r, prefix);
        });
    }
    labelPipeline("server");
    return serverUpload(f, engine, prefix);
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
  const GROUP_ZH: Record<string, string> = { subtitle: "字幕", infer: "推理引擎", vad: "VAD 过滤", polish: "AI 润色", emby: "Emby", jasna: "音频修复", scan: "扫描规则" };

  function showModal(title: string) {
    $("modal-title").textContent = title;
    $("modal-body").innerHTML = "";
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
    const e = (state.engines || []).find((x) => x.name === name);
    const body = $("modal-body");
    if (!e || !e.has_key) {
      body.innerHTML = `
      <div class="set-note">该服务还没有登记 API Key。保存后才可以读取和管理服务端设置项。</div>
      <form id="key-form" class="set-row" autocomplete="off">
        <label class="field grow">
          <span class="field-label">API Key</span>
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
        <div class="set-note err">${esc(err.message)}</div>
        <div class="muted small">若提示 Key 不正确：先清空 Key（保存空值）再重填；若提示版本过旧：请升级该服务端的 JavScribe。</div>`;
      });
  }

  function renderConfigForm(name: string, items: ConfigItem[]) {
    state.cfgItems = items;
    const groups: Record<string, ConfigItem[]> = {};
    for (const it of items) {
      const g = it.path.split(".")[0];
      (groups[g] = groups[g] || []).push(it);
    }
    const body = $("modal-body");
    let html = "";
    for (const [g, list] of Object.entries(groups)) {
      html += `<div class="set-group">${esc(GROUP_ZH[g] || g)}</div>`;
      for (const it of list) html += configFieldHtml(it);
    }
    html += `
    <div class="set-row">
      <button type="button" id="cfg-save" class="btn btn-primary">保存设置</button>
      <span class="muted small">改动对之后新提交的任务生效；敏感项留空 = 保持不变。</span>
    </div>`;
    body.innerHTML = html;
    $("cfg-save").onclick = () => saveConfig(name);
  }

  function configFieldHtml(it: ConfigItem): string {
    const id = "cfg-" + it.path.replace(/\./g, "-");
    if (it.type === "bool") {
      return `<label class="chk-row"><input type="checkbox" id="${id}" data-path="${esc(it.path)}"${it.value ? " checked" : ""}>
      <span>${esc(it.label)}</span></label>`;
    }
    if (it.type === "enum") {
      const opts = (it.options || []).map((o: string) => `<option value="${esc(o)}"${o === it.value ? " selected" : ""}>${esc(o)}</option>`).join("");
      return `<label class="field"><span class="field-label">${esc(it.label)}</span>
      <select id="${id}" data-path="${esc(it.path)}">${opts}</select></label>`;
    }
    if (it.type === "list") {
      const val = Array.isArray(it.value) ? (it.value as string[]).join(", ") : (it.value == null ? "" : String(it.value));
      return `<label class="field"><span class="field-label">${esc(it.label)}</span>
      <input id="${id}" type="text" class="mono" data-path="${esc(it.path)}"
             value="${esc(val)}" placeholder="逗号分隔，如 mp4, mkv"></label>`;
    }
    const type = it.type === "int" || it.type === "float" ? "number" : it.type === "secret" ? "password" : "text";
    const val = it.type === "secret" ? "" : (it.value == null ? "" : String(it.value));
    const ph = it.type === "secret" ? (it.value === "***" ? "已设置，留空保持不变" : "")
      : it.type === "float" ? "留空用服务端默认（0.5）" : "";
    const numAttrs = it.type === "float" ? ' step="0.05" min="0.01" max="0.99"' : it.type === "int" ? " min=1" : "";
    return `<label class="field"><span class="field-label">${esc(it.label)}</span>
    <input id="${id}" type="${type}"${numAttrs} class="${it.type === "secret" ? "mono" : ""}"
           data-path="${esc(it.path)}" value="${esc(val)}" placeholder="${esc(ph)}"></label>`;
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
      openSettings(name); // 重新拉取，敏感项回到打码状态
    } catch (e) {
      toast((e as Error).message, "err");
    }
  }

  // ---------- 服务端目录扫描 ----------
  scanGo.onclick = async () => {
    const engine = engineSelect.value;
    const path = scanPath.value.trim();
    if (!engine || !path || state.busy) return;
    const e = (state.engines || []).find((x) => x.name === engine);
    if (!e || !e.has_key) {
      toast("请先在「服务设置」里为这个服务登记 API Key，才能扫描", "err");
      return;
    }
    if (/^[a-zA-Z]:[\\/]/.test(path)) {
      toast("这是 Windows 本地路径（如 D:\\Videos）。服务端扫描只能读服务运行机器上的目录；要批量处理本机文件夹，请用上方「选择文件夹」", "err");
      return;
    }
    scanGo.disabled = true;
    $("scan-results").hidden = false;
    $("scan-table").innerHTML = '<div class="muted small scan-loading">扫描中…</div>';
    $("scan-submit").hidden = false;
    scanSubmit.disabled = true;
    try {
      const d = await t.scan(engine, path);
      state.scanItems = d.items || [];
      state.scanMapped = d.mapped === true;
      state.scanResolvedPath = d.path || "";
      // 默认勾选没有字幕的；有字幕的留待用户强制勾选
      state.scanChecked = new Set(
        state.scanItems.filter((i) => !i.has_subtitle).map((i) => i.path)
      );
      renderScanResults(d);
    } catch (err) {
      $("scan-table").innerHTML = "";
      $("scan-results").hidden = true;
      $("scan-submit").hidden = true;
      toast((err as Error).message, "err");
    } finally {
      updateScanGo();
    }
  };

  function renderScanResults(d: ScanResult) {
    const items = state.scanItems;
    if (state.scanMapped) {
      $("scan-mapped").hidden = false;
      $("scan-mapped").textContent =
        "已按服务机器实际路径扫描：" + state.scanResolvedPath;
    } else {
      $("scan-mapped").hidden = true;
    }
    if (!items.length) {
      $("scan-table").innerHTML =
        '<div class="muted small">该目录下没有符合规则的视频文件（可在「服务设置 · 扫描规则」调整扩展名；本机文件夹请用上方「选择文件夹」）</div>';
    } else {
      $("scan-table").innerHTML = `
      <table class="scan-table">
        <thead><tr><th class="col-check"></th><th>文件</th><th class="col-size">大小</th><th class="col-sub">字幕</th></tr></thead>
        <tbody>
          ${items.map((i) => `
            <tr class="${i.has_subtitle ? "has-sub" : ""}">
              <td class="col-check"><input type="checkbox" data-path="${esc(i.path)}"${state.scanChecked.has(i.path) ? " checked" : ""}></td>
              <td class="scan-name mono" title="${esc(i.path)}">${esc(i.name)}</td>
              <td class="col-size mono muted">${mb(i.size)} MB</td>
              <td class="col-sub">${i.has_subtitle ? `<span class="tag subtag">${esc(i.subtitle)}</span>` : '<span class="muted">—</span>'}</td>
            </tr>`).join("")}
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
    }
    $("scan-results").hidden = false;
    $("scan-submit").hidden = false;
    updateScanSummary(d.truncated);
  }

  function updateScanSummary(truncated?: boolean) {
    const n = state.scanChecked.size;
    const total = state.scanItems.length;
    let text = total ? `已选 ${n} / ${total} · 已有字幕的默认不勾选` : "";
    if (truncated) text += (text ? " · " : "") + "列表已截断（仅前 5000 项）";
    $("scan-count").textContent = text;
    const b = scanSubmit;
    b.disabled = n === 0 || !engineSelect.value || state.busy;
    b.innerHTML = "&#9654; 开始生成（" + n + " 项）";
    const all = scanSelectAll;
    all.checked = total > 0 && state.scanChecked.size === total;
  }

  scanSelectAll.onchange = (ev) => {
    const checked = (ev.target as HTMLInputElement).checked;
    state.scanChecked = checked
      ? new Set(state.scanItems.map((i) => i.path))
      : new Set<string>();
    $("scan-table").querySelectorAll("input[type=checkbox]")
      .forEach((cb) => { (cb as HTMLInputElement).checked = checked; });
    updateScanSummary();
  };

  scanSubmit.onclick = async () => {
    const engine = engineSelect.value;
    const files = [...state.scanChecked];
    if (!engine || !files.length || state.busy) return;
    scanSubmit.disabled = true;
    try {
      const d = await t.submitScan(engine, files);
      toast(`已入队 ${d.files} 项 → 任务 ${d.jobId}`, "ok");
      state.scanItems = [];
      state.scanChecked = new Set();
      $("scan-results").hidden = true;
      $("scan-submit").hidden = true;
      $("scan-table").innerHTML = "";
      refresh();
    } catch (e) {
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
          dispatchOne(f, engine, "监听 · ").then(([ok, d]) => {
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
          const next = { enabled: chk.checked, mirror: upSettings?.mirror || "" };
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

  // ---------- 桌面壳：侧边栏视图切换 + 任务数徽标 + 窗控按钮（frameless 自定义标题栏） ----------
  // web 形态无 body.desktop / #nav / #titlebar 节点，整块不执行（web 100% 不变硬约束）
  if (platform.kind === "desktop") {
    const VIEWS = ["engines", "dispatch", "jobs"] as const;
    type ViewName = (typeof VIEWS)[number];
    const secs: Record<ViewName, HTMLElement> = {
      engines: $("sec-engines"), dispatch: $("sec-dispatch"), jobs: $("sec-jobs"),
    };
    const items = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item[data-view]"));
    const badge = $("nav-badge") as HTMLElement | null;
    let saved = "dispatch";
    try { saved = localStorage.getItem("javview_view") || "dispatch"; } catch { /* 忽略 */ }
    const initial: ViewName = VIEWS.includes(saved as ViewName) ? (saved as ViewName) : "dispatch";
    const showView = (view: ViewName) => {
      for (const v of VIEWS) secs[v].classList.toggle("view-on", v === view);
      for (const it of items) it.classList.toggle("on", it.dataset.view === view);
      try { localStorage.setItem("javview_view", view); } catch { /* 忽略 */ }
    };
    showView(initial);
    for (const it of items) it.addEventListener("click", () => showView(it.dataset.view as ViewName));
    viewBadge = (n: number) => {
      if (!badge) return;
      badge.hidden = n <= 0;
      if (n > 0) badge.textContent = String(n);
    };

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
      // 双击标题栏 = 最大化/还原（窗控按钮与更新角标区域除外）
      const tb = $("titlebar");
      if (tb) tb.addEventListener("dblclick", (e) => {
        if ((e.target as HTMLElement).closest(".tb-btn, #up-chip")) return;
        d.toggleMax();
      });
    }
  }

  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
}
