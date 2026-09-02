"use strict";
const $ = (id) => document.getElementById(id);
const DEFAULT_TITLE = "JavScribe 中控室";
const state = { file: null, filter: "all", busy: false, knownJobs: new Map() };

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
  box.textContent = msg;
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
    }
  }
  for (const k of [...state.knownJobs.keys()]) if (!seen.has(k)) state.knownJobs.delete(k);
}

async function refresh() {
  try {
    const [health, engines, jobs] = await Promise.all([
      jget("/api/health"), jget("/api/engines"), jget("/api/jobs"),
    ]);
    $("health").textContent = `v${health.version} · 车间 ${health.online}/${health.engines} 在线`;
    renderEngines(engines);
    renderJobs(jobs);
    renderSelect(engines);
    $("last-updated").textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
    notifyJobChanges(jobs);
    updateTitle(jobs);
  } catch (_e) { /* 网络抖动：保留上一次渲染 */ }
}

function renderEngines(list) {
  const tb = $("engine-rows");
  tb.innerHTML = "";
  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="7" class="muted">还没有车间 — 用上方表单添加，或用 JAV_ENGINES 环境变量预置</td></tr>';
    return;
  }
  for (const e of list) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="dot ${e.online ? "on" : "off"}"></span></td>
      <td>${esc(e.name)}${e.online ? "" : `<div class="eng-err" title="${esc(e.error || "离线")}">${esc(e.error || "离线")}</div>`}</td>
      <td class="mono">${esc(e.url)}</td>
      <td>${esc(e.device || "—")}</td>
      <td>${esc(e.version || "—")}</td>
      <td>${e.jobs_running || 0}</td>
      <td><button class="del" data-name="${esc(e.name)}" title="删除">✕</button></td>`;
    tb.appendChild(tr);
  }
  tb.querySelectorAll(".del").forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`删除车间「${b.dataset.name}」？`)) return;
      await fetch("/api/engines/" + encodeURIComponent(b.dataset.name), { method: "DELETE" });
      refresh();
    };
  });
}

function renderJobs(rows) {
  const running = rows.filter((r) => r.status === "running").length;
  const done = rows.filter((r) => r.status === "done").length;
  const skipped = rows.filter((r) => r.status === "skipped").length;
  const failed = rows.filter((r) => r.status === "error" || r.status === "canceled").length;
  $("job-counts").textContent =
    `进行中 ${running} · 完成 ${done} · 跳过 ${skipped} · 失败 ${failed}`;

  const filtered = rows.filter((r) =>
    state.filter === "all" ? true :
    state.filter === "running" ? r.status === "running" : r.status !== "running");

  const tb = $("job-rows");
  tb.innerHTML = "";
  $("jobs-empty").hidden = filtered.length > 0;
  $("jobs-empty").textContent = rows.length ? "当前筛选下无任务" : "暂无任务";
  const now = Date.now() / 1000;
  for (const j of filtered) {
    const pct = Math.round((j.progress || 0) * 100);
    const pos = j.duration_s != null && j.position ? `${j.position} / ${fmtDuration(j.duration_s)}` : (j.position || "");
    let elapsed = j.created ? fmtDuration((j.finished || now) - j.created) : "";
    let eta = "";
    if (j.status === "running" && (j.progress || 0) > 0.01 && j.created) {
      const el = now - j.created;
      eta = el > 5 ? ` · 预计剩 ~${fmtDuration(el * (1 - j.progress) / j.progress)}` : "";
    }
    const dl = j.status === "done" && j.job_id
      ? `<a class="dl" href="/api/jobs/${encodeURIComponent(j.engine)}/${encodeURIComponent(j.job_id)}/result" download>下载 srt</a>`
      : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(j.engine)}</td>
      <td title="${esc(j.label || j.file)}">${esc(j.file)}</td>
      <td class="st-${esc(j.status)}">${STATUS_ZH[j.status] || esc(j.status)}${j.message ? ` <span class="muted">${esc(j.message)}</span>` : ""}</td>
      <td class="prog"><div class="bar"><div style="width:${pct}%"></div></div><span class="muted small">${pct}%${eta}</span></td>
      <td class="mono">${esc(pos)}</td>
      <td class="mono">${esc(elapsed)}</td>
      <td>${dl}</td>`;
    tb.appendChild(tr);
  }
}

function renderSelect(engines) {
  const sel = $("engine-select");
  if (!engines.length) { sel.innerHTML = '<option value="">（先添加车间）</option>'; return; }
  const online = engines.filter((e) => e.online);
  const pool = online.length ? online : engines;
  sel.innerHTML = pool
    .map((e) => `<option value="${esc(e.name)}">${esc(e.name)}${e.online ? "" : "（离线）"}</option>`)
    .join("");
  const saved = localStorage.getItem("javweb_engine");
  if (saved && pool.some((e) => e.name === saved)) sel.value = saved;
}

// ---- 车间管理 ----
$("engine-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const name = $("engine-name").value.trim();
  const url = $("engine-url").value.trim();
  const r = await fetch("/api/engines", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, url }),
  });
  if (r.ok) { ev.target.reset(); refresh(); }
  else alert((await r.json()).detail || r.status);
};

// ---- 任务筛选 ----
$("job-filter").onchange = (ev) => { state.filter = ev.target.value; refresh(); };

// ---- 派工单（上传流水线：上传 → 抽音轨 → 派工）----
$("drop").onclick = () => { if (!state.busy) $("file").click(); };
$("file").onchange = (ev) => setFile(ev.target.files[0]);
for (const t of ["dragover", "dragenter"]) {
  $("drop").addEventListener(t, (ev) => { ev.preventDefault(); $("drop").classList.add("hover"); });
}
for (const t of ["dragleave", "drop"]) {
  $("drop").addEventListener(t, (ev) => { ev.preventDefault(); $("drop").classList.remove("hover"); });
}
$("drop").addEventListener("drop", (ev) => { if (!state.busy) setFile(ev.dataTransfer.files[0]); });

function setFile(f) {
  if (!f) return;
  state.file = f;
  $("dispatch-bar").hidden = false;
  $("dispatch-name").textContent = `${f.name}（${mb(f.size)} MB）`;
  $("dispatch-status").textContent = "";
  $("dispatch-progress").hidden = true;
  $("dispatch-fill").style.width = "0";
}

function setPhase(frac, text) {
  $("dispatch-progress").hidden = false;
  $("dispatch-fill").style.width = (frac * 100).toFixed(1) + "%";
  $("dispatch-status").textContent = text;
}

function finishDispatch(ok) {
  state.busy = false;
  $("dispatch-go").disabled = false;
  if (ok) {
    state.file = null;
    $("file").value = "";
    $("dispatch-name").textContent = "已派单 ✓";
    $("dispatch-progress").hidden = true;
    $("dispatch-fill").style.width = "0";
  }
}

$("dispatch-go").onclick = () => {
  const engine = $("engine-select").value;
  if (!state.file || !engine || state.busy) return;
  state.busy = true;
  $("dispatch-go").disabled = true;
  localStorage.setItem("javweb_engine", engine);
  const fd = new FormData();
  fd.append("file", state.file);
  fd.append("engine", engine);
  setPhase(0, "上传中…");
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload");
  xhr.upload.onprogress = (ev) => {
    if (!ev.lengthComputable) return;
    setPhase(ev.loaded / ev.total,
      `上传中… ${mb(ev.loaded)} / ${mb(ev.total)} MB（${(ev.loaded / ev.total * 100).toFixed(1)}%）`);
  };
  xhr.onload = () => {
    if (xhr.status === 202) {
      const d = JSON.parse(xhr.responseText);
      setPhase(0, "已接收，准备抽音轨…");
      pollUpload(d.upload_id, engine);
    } else {
      let msg = "失败: " + xhr.status;
      try { msg = "失败: " + JSON.parse(xhr.responseText).detail; } catch (_e) {}
      setPhase(0, msg);
      finishDispatch(false);
    }
  };
  xhr.onerror = () => { setPhase(0, "上传失败（网络错误）"); finishDispatch(false); };
  xhr.send(fd);
};

function pollUpload(id, engine) {
  const timer = setInterval(async () => {
    let d;
    try { d = await jget("/api/uploads/" + id); } catch (_e) { return; /* 抖动，下轮重试 */ }
    if (d.phase === "extracting") {
      setPhase(d.progress, `抽音轨中… ${Math.round(d.progress * 100)}%（${d.name}）`);
    } else if (d.phase === "dispatching") {
      setPhase(1, "音轨已提取，派工中…");
    } else if (d.phase === "done") {
      clearInterval(timer);
      setPhase(1, `已派给「${engine}」，任务 ${d.job_id}（音轨 ${d.audio_mb} MB），见上方任务表`);
      toast(`已派给「${engine}」· ${d.name} → 任务 ${d.job_id}`, "ok");
      finishDispatch(true);
      refresh();
    } else if (d.phase === "error") {
      clearInterval(timer);
      setPhase(d.progress, d.error || "失败");
      finishDispatch(false);
    }
  }, 1000);
}

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
