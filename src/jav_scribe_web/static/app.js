"use strict";
const $ = (id) => document.getElementById(id);
const state = { file: null };

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function fmtDuration(s) {
  if (s == null) return "";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

const STATUS_ZH = {
  running: "运行中", done: "完成", error: "失败",
  skipped: "跳过", canceled: "已取消", pending: "排队",
};

async function jget(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
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
      <td><span class="dot ${e.online ? "on" : "off"}" title="${esc(e.error || "")}"></span></td>
      <td>${esc(e.name)}</td>
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
  const tb = $("job-rows");
  tb.innerHTML = "";
  $("jobs-empty").hidden = rows.length > 0;
  for (const j of rows) {
    const pct = Math.round((j.progress || 0) * 100);
    const pos = j.duration_s != null && j.position ? `${j.position} / ${fmtDuration(j.duration_s)}` : (j.position || "");
    const elapsed = j.finished && j.created ? fmtDuration(j.finished - j.created) : "";
    const dl = j.status === "done" && j.job_id
      ? `<a class="dl" href="/api/jobs/${encodeURIComponent(j.engine)}/${encodeURIComponent(j.job_id)}/result" download>下载 srt</a>`
      : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(j.engine)}</td>
      <td title="${esc(j.label || j.file)}">${esc(j.file)}</td>
      <td class="st-${esc(j.status)}">${STATUS_ZH[j.status] || esc(j.status)}${j.message ? ` <span class="muted">${esc(j.message)}</span>` : ""}</td>
      <td class="prog"><div class="bar"><div style="width:${pct}%"></div></div><span class="muted small">${pct}%</span></td>
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
}

// ---- 派工单（上传）----
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

$("drop").onclick = () => $("file").click();
$("file").onchange = (ev) => setFile(ev.target.files[0]);
for (const t of ["dragover", "dragenter"]) {
  $("drop").addEventListener(t, (ev) => { ev.preventDefault(); $("drop").classList.add("hover"); });
}
for (const t of ["dragleave", "drop"]) {
  $("drop").addEventListener(t, (ev) => { ev.preventDefault(); $("drop").classList.remove("hover"); });
}
$("drop").addEventListener("drop", (ev) => setFile(ev.dataTransfer.files[0]));

function setFile(f) {
  if (!f) return;
  state.file = f;
  $("dispatch-bar").hidden = false;
  $("dispatch-name").textContent = `${f.name}（${(f.size / 1048576).toFixed(0)} MB）`;
  $("dispatch-status").textContent = "";
}

$("dispatch-go").onclick = () => {
  const engine = $("engine-select").value;
  if (!state.file || !engine) return;
  const fd = new FormData();
  fd.append("file", state.file);
  fd.append("engine", engine);
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload");
  $("dispatch-progress").hidden = false;
  $("dispatch-status").textContent = "上传中…";
  xhr.upload.onprogress = (ev) => {
    if (!ev.lengthComputable) return;
    $("dispatch-fill").style.width = (ev.loaded / ev.total * 100).toFixed(1) + "%";
    $("dispatch-status").textContent =
      `已传 ${Math.round(ev.loaded / 1048576)} / ${Math.round(ev.total / 1048576)} MB`;
  };
  xhr.onload = async () => {
    $("dispatch-progress").hidden = true;
    $("dispatch-fill").style.width = "0";
    if (xhr.status === 202) {
      const d = JSON.parse(xhr.responseText);
      $("dispatch-status").textContent = `已派给「${engine}」，任务 ${d.job_id}，见上方任务表`;
      state.file = null;
      $("file").value = "";
      $("dispatch-bar").hidden = true;
      refresh();
    } else {
      let msg = "失败: " + xhr.status;
      try { msg = "失败: " + JSON.parse(xhr.responseText).detail; } catch (_e) {}
      $("dispatch-status").textContent = msg;
    }
  };
  xhr.onerror = () => {
    $("dispatch-progress").hidden = true;
    $("dispatch-status").textContent = "上传失败（网络错误）";
  };
  xhr.send(fd);
};

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
