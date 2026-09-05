"use strict";
const $ = (id) => document.getElementById(id);
const DEFAULT_TITLE = "JavScribe 字幕工作台";
const state = {
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
  page: 0,              // 任务分页：当前页（0 起）
  pageSize: 20,         // 任务分页：每页行数
  _jobs: [],            // 最近一次 /api/jobs 结果（翻页/筛选即时重渲染，不等网络）
  autoSave: localStorage.getItem("javweb_autosave") === "1",
  writeBackJobs: new Map(), // jobKey(engine|job_id) -> { engine, videoName, dirHandle|null }
  _fsFileDir: null,          // 当前单文件所选目录句柄（File System Access API，用于写回源目录）
};
const VIDEO_EXTS = ["mp4", "mkv", "avi", "mov", "webm", "flv", "wmv", "ts", "m2ts", "mpg", "mpeg"];
const LOCAL_SUB_PATTERNS = [".zh.srt", ".srt"]; // 与服务端默认一致，仅本地过滤用
// File System Access API 仅在安全上下文（https/localhost）暴露；用于「完成后写回源目录」
const HAS_FS_PICKER = typeof window.showOpenFilePicker === "function"
  && typeof window.showDirectoryPicker === "function";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function fmtDuration(s) {
  if (s == null || !isFinite(s) || s < 0) return "";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

function mb(b) { return Math.round(b / 1048576); }

const STATUS_ZH = {
  running: "运行中", done: "完成", error: "失败",
  skipped: "跳过", canceled: "已取消", pending: "排队",
};

async function jget(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

function toast(msg, kind) {
  const box = document.createElement("div");
  box.className = "toast" + (kind ? " " + kind : "");
  const icon = kind === "ok" ? "&#10003;" : kind === "err" ? "&#10007;" : "&#9679;";
  box.innerHTML = `<span class="t-icon">${icon}</span><span>${esc(msg)}</span>`;
  $("toasts").appendChild(box);
  setTimeout(() => box.remove(), 8000);
}

function updateTitle(rows) {
  const n = rows.filter((r) => r.status === "running").length;
  document.title = n ? `(${n}) ${DEFAULT_TITLE}` : DEFAULT_TITLE;
}

function notifyJobChanges(rows) {
  const seen = new Set();
  for (const r of rows) {
    const key = r.engine + "|" + r.job_id + "|" + (r.file || "");
    seen.add(key);
    const prev = state.knownJobs.get(key);
    state.knownJobs.set(key, r.status);
    if (prev === "running" && r.status !== "running") {
      const kind = r.status === "done" ? "ok" : r.status === "skipped" ? "" : "err";
      const verb = { done: "完成", skipped: "已跳过（srt 已存在）", error: "失败", canceled: "已取消" }[r.status] || r.status;
      toast(`${r.engine} · ${r.file || r.label} ${verb}`, kind);
      if (r.status === "done") maybeWriteBack(r);
    }
  }
  for (const k of [...state.knownJobs.keys()]) if (!seen.has(k)) state.knownJobs.delete(k);
}

// ---------- 完成后写回源目录（auto-save）：任务 running→done 时触发 ----------
function maybeWriteBack(r) {
  if (!state.autoSave || !r.job_id) return;
  const key = r.engine + "|" + r.job_id;
  const info = state.writeBackJobs.get(key);
  if (!info) return;
  state.writeBackJobs.delete(key);
  if (info.dirHandle) doWriteBack(r, info.dirHandle, info.videoName);
  else autoDownloadSrt(r, info.videoName);
}

async function doWriteBack(r, dirHandle, videoName) {
  const srtName = videoName.replace(/\.[^.]+$/, "") + ".zh.srt";
  try {
    let data = null;
    for (let i = 0; i < 5 && !data; i++) {
      const resp = await fetch(`/api/jobs/${encodeURIComponent(r.engine)}/${encodeURIComponent(r.job_id)}/result`);
      if (resp.ok) data = await resp.arrayBuffer();
      else await new Promise((res) => setTimeout(res, 2000));
    }
    if (!data) { toast(`「${videoName}」字幕暂不可下载，请用手动下载`, "err"); return; }
    const fh = await dirHandle.getFileHandle(srtName, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
    toast(`「${videoName}」字幕已写回源目录（${srtName}）`, "ok");
  } catch (e) {
    toast(`「${videoName}」写回失败（${e.name || e.message}），改为自动下载`, "err");
    autoDownloadSrt(r, videoName);
  }
}

function autoDownloadSrt(r, videoName) {
  const srtName = videoName.replace(/\.[^.]+$/, "") + ".zh.srt";
  try {
    const a = document.createElement("a");
    a.href = `/api/jobs/${encodeURIComponent(r.engine)}/${encodeURIComponent(r.job_id)}/result`;
    a.download = srtName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(`已自动下载 ${srtName}（此方式无法直接写回源目录，请放到影片同目录）`, "");
  } catch (_e) {
    toast(`自动下载 ${srtName} 失败，请用手动下载`, "err");
  }
}

async function refresh() {
  try {
    const [health, engines, jobs] = await Promise.all([
      jget("/api/health"), jget("/api/engines"), jget("/api/jobs"),
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
  } catch (_e) { /* 网络抖动：保留上一次渲染 */ }
}

// ---------- 服务卡片（按名称就地更新：轮询不重建 DOM，入场动画只在新卡片播放，避免闪烁） ----------
const PLANE_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;

function engineCardHtml(e) {
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

function renderEngines(list) {
  state.engines = list;
  const grid = $("engine-grid");
  $("engines-empty").hidden = list.length > 0;
  const cards = new Map();
  for (const c of grid.children) cards.set(c.dataset.name, c);
  const wanted = new Set(list.map((e) => e.name));
  for (const [name, c] of cards) if (!wanted.has(name)) c.remove();
  for (const e of list) {
    let card = cards.get(e.name);
    if (!card) {
      card = document.createElement("article");
      card.className = "eng";
      card.dataset.name = e.name;
      grid.appendChild(card);
    }
    const html = engineCardHtml(e);
    if (card._html !== html) { card.innerHTML = html; card._html = html; }
    card.classList.toggle("on", !!e.online);
    card.classList.toggle("off", !e.online);
  }
  const order = [...grid.children].map((c) => c.dataset.name).join("\u0001");
  if (order !== list.map((e) => e.name).join("\u0001")) {
    for (const e of list) grid.appendChild(cards.get(e.name));
  }
}

$("engine-grid").onclick = async (ev) => {
  const del = ev.target.closest(".del");
  if (del) {
    if (!confirm(`删除服务「${del.dataset.name}」？`)) return;
    await fetch("/api/engines/" + encodeURIComponent(del.dataset.name), { method: "DELETE" });
    refresh();
    return;
  }
  const set = ev.target.closest(".set");
  if (set) openSettings(set.dataset.name);
};

// ---------- 任务行（按任务 key 就地更新：进度/ETA/位置只改文字与条宽，不重排行节点，扫光与过渡不中断） ----------
function jobKey(j) {
  return j.job_id ? j.engine + "|" + j.job_id
                  : j.engine + "|" + (j.file || "") + "|" + (j.created || "");
}

function jobRowData(j, now) {
  const pct = Math.round((j.progress || 0) * 100);
  const isRun = j.status === "running";
  const pos = j.duration_s != null && j.position ? `${j.position} / ${fmtDuration(j.duration_s)}` : (j.position || "—");
  const elapsed = j.created ? fmtDuration((j.finished || now) - j.created) : "—";
  let eta = "";
  if (isRun && (j.progress || 0) > 0.01 && j.created) {
    const el = now - j.created;
    eta = el > 5 ? fmtDuration(el * (1 - j.progress) / j.progress) : "";
  }
  // 跳过行优先显示 message（含已存在字幕的完整路径）
  const sub = j.status === "skipped" && j.message ? j.message
    : (j.label && j.label !== j.file) ? j.label : (j.message || "");
  const dl = j.status === "done" && j.job_id
    ? `<a class="dl-btn" href="/api/jobs/${encodeURIComponent(j.engine)}/${encodeURIComponent(j.job_id)}/result" download>&#8595; 下载 srt</a>`
    : "";
  const retryKey = j.engine + "|" + j.job_id;
  const retry = j.status === "skipped" && j.job_id && !state.retried.has(retryKey)
    ? `<button type="button" class="dl-btn retry" data-eng="${esc(j.engine)}" data-jid="${esc(j.job_id)}" title="删除已存在字幕并重新生成">&#8635; 仍要重新生成</button>`
    : (j.status === "skipped" ? `<span class="retried-note">已重新提交</span>` : "");
  // core：变化时整行重写（状态/文件/操作按钮，低频）；pct/eta/pos/elapsed 单独打补丁（高频）
  const core = [j.status, j.engine, j.file, sub, dl, retry].join("\u0001");
  const html = `
      <div class="job-cell">${esc(j.engine)}</div>
      <div class="job-name"><div class="fn">${esc(j.file)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
      <div><span class="pill p-${esc(j.status)}"><i></i>${STATUS_ZH[j.status] || esc(j.status)}</span></div>
      <div class="prog"><div class="bar${isRun ? " live" : ""}"><div style="width:${pct}%"></div></div><span class="pct mono">${pct}%</span><span class="eta"></span></div>
      <div class="job-cell mono cell-pos">${esc(pos)}</div>
      <div class="job-cell mono cell-elapsed">${esc(elapsed)}</div>
      <div class="job-actions">${dl}${retry}</div>`;
  return { html, core, pct, eta, pos, elapsed };
}

function patchJobRow(row, pct, eta, pos, elapsed) {
  const bar = row.querySelector(".bar > div");
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

function renderJobs(rows) {
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

  const list = $("job-list");
  $("jobs-empty").hidden = filtered.length > 0;
  $("jobs-empty-text").textContent = rows.length ? "当前筛选下无任务" : "暂无任务";
  const now = Date.now() / 1000;
  const rowMap = new Map();
  for (const r of list.children) rowMap.set(r.dataset.jkey, r);
  const wanted = new Set();
  for (const j of pageRows) {
    const key = jobKey(j);
    wanted.add(key);
    const d = jobRowData(j, now);
    let row = rowMap.get(key);
    if (!row) {
      row = document.createElement("div");
      row.className = "job-grid job-row" + (j.status === "running" ? " running" : "");
      row.dataset.jkey = key;
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
  const order = [...list.children].map((r) => r.dataset.jkey).join("\u0001");
  if (order !== pageRows.map(jobKey).join("\u0001")) {
    for (const j of pageRows) list.appendChild(rowMap.get(jobKey(j)));
  }
  renderPager(filtered.length);
}

// ---------- 任务分页（基于缓存即时翻页，不请求网络；5s 轮询照常刷新数据） ----------
function visibleRows(rows) {
  return rows.filter((r) =>
    state.filter === "all" ? true :
    state.filter === "running" ? r.status === "running" : r.status !== "running");
}

function renderPager(total) {
  const el = $("job-pager");
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  if (pages <= 1) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML =
    `<button type="button" id="pg-prev" class="pg-btn" ${state.page === 0 ? "disabled" : ""} aria-label="上一页">&#8249;</button>` +
    `<span class="pg-info mono">第 ${state.page + 1} / ${pages} 页 · 共 ${total} 条</span>` +
    `<button type="button" id="pg-next" class="pg-btn" ${state.page >= pages - 1 ? "disabled" : ""} aria-label="下一页">&#8250;</button>`;
}

$("job-pager").onclick = (ev) => {
  const pages = Math.max(1, Math.ceil(visibleRows(state._jobs).length / state.pageSize));
  if (ev.target.closest("#pg-prev") && state.page > 0) {
    state.page--; renderJobs(state._jobs);
  } else if (ev.target.closest("#pg-next") && state.page < pages - 1) {
    state.page++; renderJobs(state._jobs);
  }
};

$("job-list").onclick = async (ev) => {
  const b = ev.target.closest(".retry");
  if (!b || b.disabled) return;
  const tr = b.closest(".job-row");
  const name = tr.querySelector(".fn")?.textContent || "";
  const jid = b.dataset.jid, eng = b.dataset.eng;
  state.retried.add(eng + "|" + jid);
  b.disabled = true; b.textContent = "重新生成中…";
  const r = await fetch(`/api/jobs/${encodeURIComponent(eng)}/${encodeURIComponent(jid)}/retry`, { method: "POST" });
  if (r.ok) {
    const d = await r.json();
    const oldInfo = state.writeBackJobs.get(eng + "|" + jid);
    if (oldInfo) state.writeBackJobs.set(eng + "|" + d.job_id, oldInfo);
    toast(`「${name}」已删旧字幕并重新提交 → 任务 ${d.job_id}`, "ok");
    refresh();
  } else {
    let msg;
    try { msg = (await r.json()).detail; } catch (_e) {}
    state.retried.delete(eng + "|" + jid);
    toast(`重新生成失败：${msg || r.status}`, "err");
    refresh();
  }
};

// ---------- 筛选 ----------
for (const b of document.querySelectorAll("#job-filter button")) {
  b.onclick = () => {
    state.filter = b.dataset.f;
    state.page = 0;
    document.querySelectorAll("#job-filter button").forEach((x) => x.classList.toggle("on", x === b));
    renderJobs(state._jobs);
  };
}

// ---------- 服务表单 ----------
$("engine-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const name = $("engine-name").value.trim();
  const url = $("engine-url").value.trim();
  const api_key = $("engine-key").value.trim();
  const r = await fetch("/api/engines", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, url, api_key }),
  });
  if (r.ok) { ev.target.reset(); refresh(); }
  else alert((await r.json()).detail || r.status);
};

// ---------- 生成字幕 ----------
function renderSelect(engines) {
  const sel = $("engine-select");
  if (!engines.length) {
    sel.innerHTML = '<option value="">（先添加服务）</option>';
    updateGo();
    return;
  }
  const online = engines.filter((e) => e.online);
  const pool = online.length ? online : engines;
  sel.innerHTML = pool
    .map((e) => `<option value="${esc(e.name)}">${esc(e.name)}${e.online ? "" : "（离线）"}</option>`)
    .join("");
  const saved = localStorage.getItem("javweb_engine");
  if (saved && pool.some((e) => e.name === saved)) sel.value = saved;
  updateGo();
}

function pendingCount() {
  if (state.folderFiles) return state.folderFiles.filter((v) => !v.hasSub).length;
  return state.file ? 1 : 0;
}

function updateGo() {
  const n = pendingCount();
  const ok = !state.busy && n > 0 && !!$("engine-select").value;
  $("dispatch-go").disabled = !ok;
  $("dispatch-go").innerHTML = n > 1 ? "&#9654; 开始生成（" + n + " 项）" : "&#9654; 开始生成";
  updateScanGo();
}

function updateScanGo() {
  $("scan-go").disabled =
    !$("scan-path").value.trim() || !$("engine-select").value || state.busy;
}

$("engine-select").onchange = updateGo;
$("scan-path").oninput = updateScanGo;

function setStep(id, cls, dot, meta) {
  const el = $(id);
  el.className = "step" + (cls ? " " + cls : "");
  if (dot != null) el.querySelector(".step-dot").textContent = dot;
  if (meta != null) $(id.replace("step-", "meta-")).textContent = meta;
}

// 进度条设宽；instant=true 时跳过过渡（阶段重置归零不能播“回退”动画）
function setFill(width, instant) {
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
function markExtractDone(audioMb) {
  setStep("step-extract", "done", "\u2713",
    audioMb != null ? `音频 ${audioMb} MB` : "音频提取完成");
  $("line-2").classList.add("on");
}

function resetPipeline() {
  $("pipeline").hidden = true;
  setStep("step-upload", "", "1", "");
  setStep("step-extract", "", "2", "");
  setStep("step-dispatch", "", "3", "");
  $("line-1").classList.remove("on");
  $("line-2").classList.remove("on");
  setFill("0", true);
  $("dispatch-status").hidden = true;
  $("dispatch-status").className = "dispatch-status";
}

function setFile(f) {
  if (!f) return;
  state.file = f;
  state._fsFileDir = null;
  if (state.folderFiles) clearFolder();
  $("file-chip").hidden = false;
  $("chip-name").textContent = f.name;
  $("chip-size").textContent = mb(f.size) + " MB";
  $("drop").classList.add("has-file");
  resetPipeline();
  updateGo();
}

async function pickFile() {
  if (HAS_FS_PICKER) {
    try {
      const [h] = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: "视频文件", accept: { "video/*": VIDEO_EXTS.map((e) => "." + e) } }],
      });
      const f = await h.getFile();
      setFile(f);
      state._fsFileDir = await h.getParent();
    } catch (e) {
      if (e && e.name !== "AbortError") toast("选择文件失败：" + e.message, "err");
    }
    return;
  }
  $("file").click();
}

$("drop").onclick = () => { if (!state.busy) pickFile(); };
$("drop").onkeydown = (ev) => {
  if ((ev.key === "Enter" || ev.key === " ") && !state.busy) { ev.preventDefault(); pickFile(); }
};
$("file").onchange = (ev) => setFile(ev.target.files[0]);
for (const t of ["dragover", "dragenter"]) {
  $("drop").addEventListener(t, (ev) => { ev.preventDefault(); if (!state.busy) $("drop").classList.add("hover"); });
}
for (const t of ["dragleave", "drop"]) {
  $("drop").addEventListener(t, (ev) => { ev.preventDefault(); $("drop").classList.remove("hover"); });
}
$("drop").addEventListener("drop", (ev) => { if (!state.busy) setFile(ev.dataTransfer.files[0]); });

$("chip-x").onclick = () => {
  if (state.busy) return;
  state.file = null;
  state._fsFileDir = null;
  $("file").value = "";
  $("file-chip").hidden = true;
  $("drop").classList.remove("has-file");
  resetPipeline();
  updateGo();
};

// ---------- 选择文件夹（浏览器本地过滤，不依赖服务端） ----------
function videoExt(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

function clearFolder() {
  state.folderFiles = null;
  $("folder").value = "";
  $("folder-chip").hidden = true;
  resetPipeline();
  updateGo();
}

function setFolder(files) {
  if (!files || !files.length) return;
  state.file = null;
  $("file").value = "";
  $("file-chip").hidden = true;
  $("drop").classList.remove("has-file");
  // 同目录名集合：用于判断「<stem>.zh.srt / <stem>.srt」是否已随文件夹选中
  const byDir = new Map();
  for (const f of files) {
    const rel = f.webkitRelativePath || f.name;
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    if (!byDir.has(dir)) byDir.set(dir, new Set());
    byDir.get(dir).add(f.name.toLowerCase());
  }
  const vids = [];
  for (const f of files) {
    if (!VIDEO_EXTS.includes(videoExt(f.name)) || f.size <= 0) continue;
    const rel = f.webkitRelativePath || f.name;
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const base = f.name.replace(/\.[^.]+$/, "").toLowerCase();
    const names = byDir.get(dir) || new Set();
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

async function pickFolderFs() {
  let root;
  try {
    root = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (e) {
    if (e && e.name !== "AbortError") toast("选择文件夹失败：" + e.message, "err");
    return;
  }
  const files = [];
  try {
    await walkDirForFiles(root, root.name, files);
  } catch (e) {
    toast("读取文件夹失败：" + e.message, "err");
    return;
  }
  setFolder(files);
}

async function walkDirForFiles(dir, prefix, out) {
  for await (const entry of dir.values()) {
    const rel = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.kind === "file") {
      const f = await entry.getFile();
      Object.defineProperty(f, "webkitRelativePath", { value: rel });
      f._dirHandle = dir; // 记录所在目录句柄，任务完成后把 srt 写回这里
      out.push(f);
    } else if (entry.kind === "directory") {
      await walkDirForFiles(entry, rel, out);
    }
  }
}

$("pick-folder").onclick = async (ev) => {
  ev.stopPropagation();
  if (state.busy) return;
  if (HAS_FS_PICKER) { await pickFolderFs(); return; }
  $("folder").click();
};
$("folder").onchange = (ev) => setFolder([...ev.target.files]);
$("folder-x").onclick = () => { if (!state.busy) clearFolder(); };

$("dispatch-go").onclick = () => {
  const engine = $("engine-select").value;
  if (!engine || state.busy) return;
  if (state.folderFiles) { startBatch(engine); return; }
  if (!state.file) return;
  startSingle(engine);
};

function preparePipeline(label) {
  $("pipeline").hidden = false;
  setStep("step-upload", "active", "1", label || "开始上传…");
  setStep("step-extract", "", "2", "");
  setStep("step-dispatch", "", "3", "");
  $("line-1").classList.remove("on");
  $("line-2").classList.remove("on");
  setFill("0", true);
}

function startSingle(engine) {
  const file = state.file;
  state.busy = true;
  updateGo();
  localStorage.setItem("javweb_engine", engine);
  preparePipeline();
  uploadOne(file, engine).then(([ok, d]) => {
    if (ok) {
      state.writeBackJobs.set(engine + "|" + d.job_id, {
        engine, videoName: file.name, dirHandle: state._fsFileDir || null,
      });
      showStatus(`已提交到「${engine}」· ${d.name} → 任务 ${d.job_id}，见上方任务表`, "ok");
      toast(`已提交到「${engine}」· ${d.name} → 任务 ${d.job_id}`, "ok");
      finishDispatch(true);
      refresh();
    } else {
      const msg = (d && d.error) || "上传失败";
      showStatus(`${file.name}：${msg}`, "err");
      toast(`${file.name}：${msg}`, "err");
      finishDispatch(false);
    }
  });
}

async function startBatch(engine) {
  const queue = state.folderFiles.filter((v) => !v.hasSub).map((v) => v.file);
  state.busy = true;
  updateGo();
  localStorage.setItem("javweb_engine", engine);
  preparePipeline(`文件 1/${queue.length}`);
  let okN = 0;
  for (let i = 0; i < queue.length; i++) {
    const prefix = `文件 ${i + 1}/${queue.length} · `;
    preparePipeline(prefix + "开始上传…");
    const [ok, d] = await uploadOne(queue[i], engine, prefix);
    if (ok) {
      okN++;
      if (d && d.job_id) {
        state.writeBackJobs.set(engine + "|" + d.job_id, {
          engine, videoName: queue[i].name, dirHandle: queue[i]._dirHandle || null,
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
  $("folder").value = "";
  $("folder-chip").hidden = true;
  updateGo();
}

function uploadOne(f, engine, labelPrefix) {
  const prefix = labelPrefix || "";
  return new Promise((resolve) => {
    const fd = new FormData();
    fd.append("file", f);
    fd.append("engine", engine);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable) return;
      const pct = ev.loaded / ev.total * 100;
      setStep("step-upload", "active", "1",
        `${prefix}${mb(ev.loaded)} / ${mb(ev.total)} MB · ${pct.toFixed(1)}%`);
      setFill(pct + "%");
    };
    xhr.onload = () => {
      if (xhr.status === 202) {
        const d = JSON.parse(xhr.responseText);
        setStep("step-upload", "done", "\u2713", `${prefix}${d.size_mb} MB 已接收`);
        $("line-1").classList.add("on");
        setStep("step-extract", "active", "2", "准备提取音频…");
        setFill("0", true);
        pollUpload(d.upload_id, engine, prefix, resolve);
      } else {
        let msg = "失败: " + xhr.status;
        try { msg = JSON.parse(xhr.responseText).detail; } catch (_e) {}
        setStep("step-upload", "error", "\u2715", msg);
        resolve([false, { error: msg }]);
      }
    };
    xhr.onerror = () => {
      setStep("step-upload", "error", "\u2715", "网络错误");
      resolve([false, { error: "上传失败（网络错误）" }]);
    };
    xhr.send(fd);
  });
}

function showStatus(text, cls) {
  const el = $("dispatch-status");
  el.hidden = false;
  el.className = "dispatch-status" + (cls ? " " + cls : "");
  el.textContent = text;
}

function finishDispatch(ok) {
  state.busy = false;
  if (ok) {
    state.file = null;
    $("file").value = "";
    $("file-chip").hidden = true;
    $("drop").classList.remove("has-file");
  }
  updateGo();
}

function pollUpload(id, engine, labelPrefix, onDone) {
  const prefix = labelPrefix || "";
  let extractT0 = null;
  const timer = setInterval(async () => {
    let d;
    try { d = await jget("/api/uploads/" + id); } catch (_e) { return; }
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


// ---------- 完成后自动写回源目录（默认关） ----------
$("autosave").checked = state.autoSave;
$("autosave").onchange = (ev) => {
  state.autoSave = ev.target.checked;
  localStorage.setItem("javweb_autosave", state.autoSave ? "1" : "0");
};

// ---------- 服务设置 modal ----------
const GROUP_ZH = { subtitle: "字幕", infer: "推理引擎", vad: "VAD 过滤", polish: "AI 润色", emby: "Emby", jasna: "音频修复", scan: "扫描规则" };

function showModal(title) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = "";
  $("modal-backdrop").hidden = false;
}

function hideModal() {
  $("modal-backdrop").hidden = true;
  $("modal-body").innerHTML = "";
}

$("modal-x").onclick = hideModal;
$("modal-backdrop").addEventListener("click", (ev) => { if (ev.target === $("modal-backdrop")) hideModal(); });
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") hideModal(); });

async function jgetOrDetail(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (r.ok) return r.json();
  let msg = "HTTP " + r.status;
  try { msg = (await r.json()).detail || msg; } catch (_e) {}
  const e = new Error(msg);
  e.status = r.status;
  throw e;
}

function openSettings(name) {
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
    $("key-form").onsubmit = async (ev) => {
      ev.preventDefault();
      const r = await fetch("/api/engines/" + encodeURIComponent(name), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: $("key-input").value.trim() }),
      });
      if (r.ok) {
        toast("API Key 已保存", "ok");
        refresh();
        openSettings(name);
      } else {
        let msg = r.status;
        try { msg = (await r.json()).detail || msg; } catch (_e) {}
        toast(msg, "err");
      }
    };
    $("key-input").focus();
    return;
  }
  body.innerHTML = '<div class="muted">加载设置中…</div>';
  jgetOrDetail("/api/engines/" + encodeURIComponent(name) + "/config")
    .then((d) => renderConfigForm(name, d.items || []))
    .catch((err) => {
      body.innerHTML = `
        <div class="set-note err">${esc(err.message)}</div>
        <div class="muted small">若提示 Key 不正确：先清空 Key（保存空值）再重填；若提示版本过旧：请升级该服务端的 JavScribe。</div>`;
    });
}

function renderConfigForm(name, items) {
  state.cfgItems = items;
  const groups = {};
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

function configFieldHtml(it) {
  const id = "cfg-" + it.path.replace(/\./g, "-");
  if (it.type === "bool") {
    return `<label class="chk-row"><input type="checkbox" id="${id}" data-path="${esc(it.path)}"${it.value ? " checked" : ""}>
      <span>${esc(it.label)}</span></label>`;
  }
  if (it.type === "enum") {
    const opts = (it.options || []).map((o) => `<option value="${esc(o)}"${o === it.value ? " selected" : ""}>${esc(o)}</option>`).join("");
    return `<label class="field"><span class="field-label">${esc(it.label)}</span>
      <select id="${id}" data-path="${esc(it.path)}">${opts}</select></label>`;
  }
  if (it.type === "list") {
    const val = Array.isArray(it.value) ? it.value.join(", ") : (it.value == null ? "" : String(it.value));
    return `<label class="field"><span class="field-label">${esc(it.label)}</span>
      <input id="${id}" type="text" class="mono" data-path="${esc(it.path)}"
             value="${esc(val)}" placeholder="逗号分隔，如 mp4, mkv"></label>`;
  }
  const type = it.type === "int" || it.type === "float" ? "number" : it.type === "secret" ? "password" : "text";
  const val = it.type === "secret" ? "" : (it.value == null ? "" : it.value);
  const ph = it.type === "secret" ? (it.value === "***" ? "已设置，留空保持不变" : "")
    : it.type === "float" ? "留空用服务端默认（0.5）" : "";
  const numAttrs = it.type === "float" ? ' step="0.05" min="0.01" max="0.99"' : it.type === "int" ? " min=1" : "";
  return `<label class="field"><span class="field-label">${esc(it.label)}</span>
    <input id="${id}" type="${type}"${numAttrs} class="${it.type === "secret" ? "mono" : ""}"
           data-path="${esc(it.path)}" value="${esc(val)}" placeholder="${esc(ph)}"></label>`;
}

async function saveConfig(name) {
  const values = {};
  for (const it of state.cfgItems) {
    const f = $("cfg-" + it.path.replace(/\./g, "-"));
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
  const r = await fetch(`/api/engines/${encodeURIComponent(name)}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  if (r.ok) {
    toast("服务设置已保存（对新提交的任务生效）", "ok");
    refresh();
    openSettings(name); // 重新拉取，敏感项回到打码状态
  } else {
    let msg = r.status;
    try { msg = (await r.json()).detail || msg; } catch (_e) {}
    toast(msg, "err");
  }
}

// ---------- 服务端目录扫描 ----------
$("scan-go").onclick = async () => {
  const engine = $("engine-select").value;
  const path = $("scan-path").value.trim();
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
  $("scan-go").disabled = true;
  $("scan-results").hidden = false;
  $("scan-table").innerHTML = '<div class="muted small scan-loading">扫描中…</div>';
  $("scan-submit").hidden = false;
  $("scan-submit").disabled = true;
  try {
    const d = await jgetOrDetail(
      `/api/engines/${encodeURIComponent(engine)}/scan?path=${encodeURIComponent(path)}`
    );
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
    toast(err.message, "err");
  } finally {
    updateScanGo();
  }
};

function renderScanResults(d) {
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
      cb.onchange = () => {
        if (cb.checked) state.scanChecked.add(cb.dataset.path);
        else state.scanChecked.delete(cb.dataset.path);
        updateScanSummary();
      };
    });
  }
  $("scan-results").hidden = false;
  $("scan-submit").hidden = false;
  updateScanSummary(d.truncated);
}

function updateScanSummary(truncated) {
  const n = state.scanChecked.size;
  const total = state.scanItems.length;
  let text = total ? `已选 ${n} / ${total} · 已有字幕的默认不勾选` : "";
  if (truncated) text += (text ? " · " : "") + "列表已截断（仅前 5000 项）";
  $("scan-count").textContent = text;
  const b = $("scan-submit");
  b.disabled = n === 0 || !$("engine-select").value || state.busy;
  b.innerHTML = "&#9654; 开始生成（" + n + " 项）";
  const all = $("scan-select-all");
  if (all) all.checked = total > 0 && state.scanChecked.size === total;
}

$("scan-select-all").onchange = (ev) => {
  state.scanChecked = ev.target.checked
    ? new Set(state.scanItems.map((i) => i.path))
    : new Set();
  $("scan-table").querySelectorAll("input[type=checkbox]")
    .forEach((cb) => { cb.checked = ev.target.checked; });
  updateScanSummary();
};

$("scan-submit").onclick = async () => {
  const engine = $("engine-select").value;
  const files = [...state.scanChecked];
  if (!engine || !files.length || state.busy) return;
  $("scan-submit").disabled = true;
  try {
    const r = await fetch(`/api/engines/${encodeURIComponent(engine)}/scan/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
    });
    if (r.ok) {
      const d = await r.json();
      toast(`已入队 ${d.files} 项 → 任务 ${d.job_id}`, "ok");
      state.scanItems = [];
      state.scanChecked = new Set();
      $("scan-results").hidden = true;
      $("scan-submit").hidden = true;
      $("scan-table").innerHTML = "";
      refresh();
    } else {
      let msg;
      try { msg = (await r.json()).detail; } catch (_e) {}
      toast(msg || r.status, "err");
    }
  } catch (_e) {
    toast("网络错误", "err");
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

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
