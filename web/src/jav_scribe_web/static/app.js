"use strict";
const $ = (id) => document.getElementById(id);
const DEFAULT_TITLE = "JavScribe 中控室";
const state = { file: null, filter: "all", busy: false, knownJobs: new Map(), retried: new Set() };

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
    }
  }
  for (const k of [...state.knownJobs.keys()]) if (!seen.has(k)) state.knownJobs.delete(k);
}

async function refresh() {
  try {
    const [health, engines, jobs] = await Promise.all([
      jget("/api/health"), jget("/api/engines"), jget("/api/jobs"),
    ]);
    const allOnline = health.online === health.engines && health.engines > 0;
    $("health").textContent = `v${health.version} · 车间 ${health.online}/${health.engines} 在线`;
    $("health").style.color = allOnline ? "" : "var(--err)";
    $("foot-ver").textContent = "v" + health.version;
    renderEngines(engines);
    renderJobs(jobs);
    renderSelect(engines);
    $("last-updated").textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
    notifyJobChanges(jobs);
    updateTitle(jobs);
  } catch (_e) { /* 网络抖动：保留上一次渲染 */ }
}

// ---------- 车间卡片 ----------
function renderEngines(list) {
  const grid = $("engine-grid");
  grid.innerHTML = "";
  $("engines-empty").hidden = list.length > 0;
  for (const e of list) {
    const card = document.createElement("article");
    card.className = "eng " + (e.online ? "on" : "off");
    card.innerHTML = `
      <div class="eng-top">
        <span class="lamp"></span>
        <h3>${esc(e.name)}</h3>
        <button type="button" class="icon-btn del" data-name="${esc(e.name)}" title="删除车间">&#10005;</button>
      </div>
      <div class="eng-url mono">${esc(e.url)}</div>
      <div class="eng-specs">
        <span class="tag">${esc(e.device || "—")}</span>
        <span class="tag">v${esc(e.version || "—")}</span>
        <span class="tag${e.jobs_running ? " hot" : ""}">运行 ${e.jobs_running || 0}</span>
        ${e.online ? "" : `<div class="eng-err">${esc(e.error || "离线")}</div>`}
      </div>`;
    grid.appendChild(card);
  }
  grid.querySelectorAll(".del").forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`删除车间「${b.dataset.name}」？`)) return;
      await fetch("/api/engines/" + encodeURIComponent(b.dataset.name), { method: "DELETE" });
      refresh();
    };
  });
}

// ---------- 任务行 ----------
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

  const filtered = rows.filter((r) =>
    state.filter === "all" ? true :
    state.filter === "running" ? r.status === "running" : r.status !== "running");

  const list = $("job-list");
  list.innerHTML = "";
  $("jobs-empty").hidden = filtered.length > 0;
  $("jobs-empty-text").textContent = rows.length ? "当前筛选下无任务" : "暂无任务";
  const now = Date.now() / 1000;
  for (const j of filtered) {
    const pct = Math.round((j.progress || 0) * 100);
    const isRun = j.status === "running";
    const pos = j.duration_s != null && j.position ? `${j.position} / ${fmtDuration(j.duration_s)}` : (j.position || "—");
    const elapsed = j.created ? fmtDuration((j.finished || now) - j.created) : "—";
    let eta = "";
    if (isRun && (j.progress || 0) > 0.01 && j.created) {
      const el = now - j.created;
      eta = el > 5 ? `<span class="eta">剩 ~${fmtDuration(el * (1 - j.progress) / j.progress)}</span>` : "";
    }
    // 跳过行优先显示 message（含已存在字幕的完整路径）
    const sub = j.status === "skipped" && j.message ? j.message
      : (j.label && j.label !== j.file) ? j.label : (j.message || "");
    const dl = j.status === "done" && j.job_id
      ? `<a class="dl-btn" href="/api/jobs/${encodeURIComponent(j.engine)}/${encodeURIComponent(j.job_id)}/result" download>&#8595; 下载 srt</a>`
      : "";
    const retryKey = j.engine + "|" + j.job_id;
    const retry = j.status === "skipped" && j.job_id && !state.retried.has(retryKey)
      ? `<button type="button" class="dl-btn retry" data-eng="${esc(j.engine)}" data-jid="${esc(j.job_id)}" title="删除已存在字幕并重新派工">&#8635; 仍要重新生成</button>`
      : (j.status === "skipped" ? `<span class="retried-note">已重新派工</span>` : "");
    const row = document.createElement("div");
    row.className = "job-grid job-row" + (isRun ? " running" : "");
    row.innerHTML = `
      <div class="job-cell">${esc(j.engine)}</div>
      <div class="job-name"><div class="fn">${esc(j.file)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
      <div><span class="pill p-${esc(j.status)}"><i></i>${STATUS_ZH[j.status] || esc(j.status)}</span></div>
      <div class="prog"><div class="bar${isRun ? " live" : ""}"><div style="width:${pct}%"></div></div><span class="pct mono">${pct}%</span>${eta}</div>
      <div class="job-cell mono">${esc(pos)}</div>
      <div class="job-cell mono">${esc(elapsed)}</div>
      <div class="job-actions">${dl}${retry}</div>`;
    list.appendChild(row);
  }
  list.querySelectorAll(".retry").forEach((b) => {
    b.onclick = async () => {
      const tr = b.closest(".job-row");
      const name = tr.querySelector(".fn")?.textContent || "";
      const jid = b.dataset.jid, eng = b.dataset.eng;
      state.retried.add(eng + "|" + jid);
      b.disabled = true; b.textContent = "重新派工中…";
      const r = await fetch(`/api/jobs/${encodeURIComponent(eng)}/${encodeURIComponent(jid)}/retry`, { method: "POST" });
      if (r.ok) {
        const d = await r.json();
        toast(`「${name}」已删旧字幕重新派工 → 任务 ${d.job_id}`, "ok");
        refresh();
      } else {
        let msg;
        try { msg = (await r.json()).detail; } catch (_e) {}
        state.retried.delete(eng + "|" + jid);
        toast(`重新生成失败：${msg || r.status}`, "err");
        refresh();
      }
    };
  });
}

// ---------- 筛选 ----------
for (const b of document.querySelectorAll("#job-filter button")) {
  b.onclick = () => {
    state.filter = b.dataset.f;
    document.querySelectorAll("#job-filter button").forEach((x) => x.classList.toggle("on", x === b));
    refresh();
  };
}

// ---------- 车间表单 ----------
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

// ---------- 派工单 ----------
function renderSelect(engines) {
  const sel = $("engine-select");
  if (!engines.length) {
    sel.innerHTML = '<option value="">（先添加车间）</option>';
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

function updateGo() {
  $("dispatch-go").disabled = state.busy || !state.file || !$("engine-select").value;
}

$("engine-select").onchange = updateGo;

function setStep(id, cls, dot, meta) {
  const el = $(id);
  el.className = "step" + (cls ? " " + cls : "");
  if (dot != null) el.querySelector(".step-dot").textContent = dot;
  if (meta != null) $(id.replace("step-", "meta-")).textContent = meta;
}

function resetPipeline() {
  $("pipeline").hidden = true;
  setStep("step-upload", "", "1", "");
  setStep("step-extract", "", "2", "");
  setStep("step-dispatch", "", "3", "");
  $("line-1").classList.remove("on");
  $("line-2").classList.remove("on");
  $("dispatch-fill").style.width = "0";
  $("dispatch-status").hidden = true;
  $("dispatch-status").className = "dispatch-status";
}

function setFile(f) {
  if (!f) return;
  state.file = f;
  $("file-chip").hidden = false;
  $("chip-name").textContent = f.name;
  $("chip-size").textContent = mb(f.size) + " MB";
  $("drop").classList.add("has-file");
  resetPipeline();
  updateGo();
}

$("drop").onclick = () => { if (!state.busy) $("file").click(); };
$("drop").onkeydown = (ev) => {
  if ((ev.key === "Enter" || ev.key === " ") && !state.busy) { ev.preventDefault(); $("file").click(); }
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
  $("file").value = "";
  $("file-chip").hidden = true;
  $("drop").classList.remove("has-file");
  resetPipeline();
  updateGo();
};

$("dispatch-go").onclick = () => {
  const engine = $("engine-select").value;
  if (!state.file || !engine || state.busy) return;
  state.busy = true;
  updateGo();
  localStorage.setItem("javweb_engine", engine);
  const fd = new FormData();
  fd.append("file", state.file);
  fd.append("engine", engine);
  $("pipeline").hidden = false;
  setStep("step-upload", "active", "1", "开始上传…");
  setStep("step-extract", "", "2", "");
  setStep("step-dispatch", "", "3", "");
  $("line-1").classList.remove("on");
  $("line-2").classList.remove("on");
  $("dispatch-fill").style.width = "0";

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload");
  xhr.upload.onprogress = (ev) => {
    if (!ev.lengthComputable) return;
    const pct = ev.loaded / ev.total * 100;
    setStep("step-upload", "active", "1",
      `${mb(ev.loaded)} / ${mb(ev.total)} MB · ${pct.toFixed(1)}%`);
    $("dispatch-fill").style.width = pct + "%";
  };
  xhr.onload = () => {
    if (xhr.status === 202) {
      const d = JSON.parse(xhr.responseText);
      setStep("step-upload", "done", "\u2713", `${mb(d.size_mb)} MB 已接收`);
      $("line-1").classList.add("on");
      setStep("step-extract", "active", "2", "准备抽音轨…");
      $("dispatch-fill").style.width = "0";
      pollUpload(d.upload_id, engine);
    } else {
      let msg = "失败: " + xhr.status;
      try { msg = JSON.parse(xhr.responseText).detail; } catch (_e) {}
      setStep("step-upload", "error", "\u2715", msg);
      showStatus(msg, "err");
      finishDispatch(false);
    }
  };
  xhr.onerror = () => {
    setStep("step-upload", "error", "\u2715", "网络错误");
    showStatus("上传失败（网络错误）", "err");
    finishDispatch(false);
  };
  xhr.send(fd);
};

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

function pollUpload(id, engine) {
  let extractT0 = null;
  const timer = setInterval(async () => {
    let d;
    try { d = await jget("/api/uploads/" + id); } catch (_e) { return; }
    if (d.phase === "extracting") {
      if (extractT0 == null) extractT0 = Date.now() / 1000;
      let meta = `抽音轨中 · ${Math.round(d.progress * 100)}%`;
      const el = Date.now() / 1000 - extractT0;
      if (el > 5 && d.progress > 0.01) meta += ` · 剩 ~${fmtDuration(el * (1 - d.progress) / d.progress)}`;
      setStep("step-extract", "active", "2", meta);
      $("dispatch-fill").style.width = (d.progress * 100).toFixed(1) + "%";
    } else if (d.phase === "dispatching") {
      setStep("step-extract", "done", "\u2713", `音轨 ${d.audio_mb} MB`);
      $("line-2").classList.add("on");
      setStep("step-dispatch", "active", "3", "派工中…");
      $("dispatch-fill").style.width = "100%";
    } else if (d.phase === "done") {
      clearInterval(timer);
      setStep("step-dispatch", "done", "\u2713", `任务 ${d.job_id}`);
      showStatus(`已派给「${engine}」· ${d.name} → 任务 ${d.job_id}，见上方任务表`, "ok");
      toast(`已派给「${engine}」· ${d.name} → 任务 ${d.job_id}`, "ok");
      finishDispatch(true);
      refresh();
    } else if (d.phase === "error") {
      clearInterval(timer);
      const which = d.job_id ? "step-dispatch" : "step-extract";
      setStep(which, "error", "\u2715", d.error || "失败");
      showStatus(d.error || "失败", "err");
      toast(d.error || "派工失败", "err");
      finishDispatch(false);
    }
  }, 1000);
}

// ---------- 时钟 ----------
function tick() {
  $("clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
}
tick();
setInterval(tick, 1000);

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
