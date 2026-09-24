// web 形态 transport：所有请求走工作台 /api/*（FastAPI 聚合器，API Key 藏服务端）。
// 端点与迁移前 app.js 内联 fetch/XHR 完全一致，行为 1:1。

import {
  TransportError, type PauseAllResult, type Transport, type UploadDispatch, type UploadProgress,
} from "../core/transport";
import type {
  BulkResult, ConfigItem, Engine, Health, JobRow, FsBrowseResult, MetricsResponse,
  ScanResult, SrtReadResult, UpdateInfo, UploadStatus,
} from "../core/types";

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new TransportError(`${url} -> ${r.status}`);
  return (await r.json()) as T;
}

/** 取 detail 文案的 GET（设置/扫描用）：detail 优先，否则 "HTTP <status>" */
async function jgetOrDetail<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (r.ok) return (await r.json()) as T;
  let msg = "HTTP " + r.status;
  try { msg = ((await r.json()) as { detail?: string }).detail || msg; } catch (_e) {}
  throw new TransportError(msg);
}

/** 带 detail 的写操作：成功 resolve，失败 throw(detail 或 "<status>") */
async function jput(url: string, body: unknown): Promise<void> {
  const r = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.ok) return;
  let msg = String(r.status);
  try { msg = ((await r.json()) as { detail?: string }).detail || msg; } catch (_e) {}
  throw new TransportError(msg);
}

/** 带 detail 的 POST 写操作：成功返回 JSON，失败 throw(detail 或 "<status>") */
async function jpost<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (r.ok) return (await r.json()) as T;
  let msg = String(r.status);
  try { msg = ((await r.json()) as { detail?: string }).detail || msg; } catch (_e) {}
  throw new TransportError(msg);
}

/** XHR 上传（要进度条，fetch 流式进度不可用）：202 受理 → ok；其余 → 错误文案 */
function xhrUpload(url: string, fd: FormData, onProgress: UploadProgress): Promise<UploadDispatch> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable) return;
      onProgress(ev.loaded, ev.total, (ev.loaded / ev.total) * 100);
    };
    xhr.onload = () => {
      if (xhr.status === 202) {
        const d = JSON.parse(xhr.responseText) as { upload_id: string; size_mb: number };
        resolve({ ok: true, uploadId: d.upload_id, sizeMb: d.size_mb });
      } else {
        let msg = "失败: " + xhr.status;
        try { msg = (JSON.parse(xhr.responseText) as { detail?: string }).detail || msg; } catch (_e) {}
        resolve({ ok: false, error: msg });
      }
    };
    xhr.onerror = () => resolve({ ok: false, error: "网络错误", network: true });
    xhr.send(fd);
  });
}

export const webTransport: Transport = {
  getHealth: () => jget<Health>("/api/health"),
  listEngines: () => jget<Engine[]>("/api/engines"),

  async addEngine(name, url, apiKey) {
    const r = await fetch("/api/engines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, url, api_key: apiKey || "" }),
    });
    if (r.ok) return;
    let msg = String(r.status);
    try { msg = ((await r.json()) as { detail?: string }).detail || msg; } catch (_e) {}
    throw new TransportError(msg);
  },

  // 与迁移前一致：非 2xx 不抛（删除后照样刷新）
  async deleteEngine(name) {
    await fetch("/api/engines/" + encodeURIComponent(name), { method: "DELETE" });
  },

  putEngineKey: (name, apiKey) =>
    jput("/api/engines/" + encodeURIComponent(name), { api_key: apiKey }),

  setEngineEnabled: (name, enabled) =>
    jput("/api/engines/" + encodeURIComponent(name), { enabled }),

  listJobs: () => jget<JobRow[]>("/api/jobs"),

  listJobsSummary: () => jget<import("../core/types").JobSummary>("/api/jobs/summary"),

  getClientConfig: () =>
    jget<{ config: import("../core/types").ClientConfig }>("/api/client-config").then((d) => d.config),

  putClientConfig: (cfg) =>
    jput("/api/client-config", cfg),

  getUpdate: () => jget<UpdateInfo>("/api/update"),

  getResultUrl: (engine, jobId) =>
    `/api/jobs/${encodeURIComponent(engine)}/${encodeURIComponent(jobId)}/result`,

  async getResultData(engine, jobId) {
    const resp = await fetch(
      `/api/jobs/${encodeURIComponent(engine)}/${encodeURIComponent(jobId)}/result`,
    );
    if (!resp.ok) return null;
    return resp.arrayBuffer();
  },

  async retryJob(engine, jobId) {
    const r = await fetch(
      `/api/jobs/${encodeURIComponent(engine)}/${encodeURIComponent(jobId)}/retry`,
      { method: "POST" },
    );
    if (r.ok) {
      const d = (await r.json()) as { job_id: string };
      return { jobId: d.job_id };
    }
    let msg = String(r.status);
    try { msg = ((await r.json()) as { detail?: string }).detail || msg; } catch (_e) {}
    throw new TransportError(msg);
  },

  async cancelJob(engine, jobId) {
    const r = await fetch(
      `/api/jobs/${encodeURIComponent(engine)}/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST" },
    );
    if (r.ok) {
      const d = (await r.json()) as { status?: string };
      return { status: d.status || "canceled" };
    }
    let msg = String(r.status);
    try { msg = ((await r.json()) as { detail?: string }).detail || msg; } catch (_e) {}
    throw new TransportError(msg);
  },

  // 全局暂停/继续：本机管线闸 + 代理所有在线服务队列（离线/版本过旧逐个降级，不阻塞整体）
  pauseAll: (paused) => jpost<PauseAllResult>("/api/pause", { paused }),
  // 单任务挂起/恢复（serve 0.2.3+；409 透传服务侧文案：运行中不可挂起等）
  pauseJob: (engine, jobId) =>
    jpost<{ ok: boolean; job_id: string; status: string }>(
      `/api/jobs/${encodeURIComponent(engine)}/${encodeURIComponent(jobId)}/pause`),
  resumeJob: (engine, jobId) =>
    jpost<{ ok: boolean; job_id: string; status: string }>(
      `/api/jobs/${encodeURIComponent(engine)}/${encodeURIComponent(jobId)}/resume`),
  // 本机任务 重试/继续：error 或 已暂停 且本机视频仍在 → 重提取重提交
  rerunLocal: (taskId) =>
    jpost<{ ok: boolean; task_id: string }>(`/api/local/${encodeURIComponent(taskId)}/rerun`),
  // 本机任务暂停（排队/提取/派发阶段；已提交服务的行不可暂停 → 409 透传）
  pauseLocalTask: (taskId) =>
    jpost<{ ok: boolean; task_id: string; already?: boolean }>(
      `/api/local/${encodeURIComponent(taskId)}/pause`),
  // 批量操作：taskIds=本机行，jobs=服务行（去重后）；单条失败不 throw
  bulkJobs: (action, taskIds, jobs) =>
    jpost<BulkResult>("/api/jobs/bulk", { action, task_ids: taskIds, jobs }),
  // 服务监控快照（serve 0.2.4+；旧版服务 404 → ok=false unsupported）
  engineMetrics: (name) =>
    jget<MetricsResponse>("/api/engines/" + encodeURIComponent(name) + "/metrics"),

  getConfig: (name) =>
    jgetOrDetail<{ items: ConfigItem[] }>(
      "/api/engines/" + encodeURIComponent(name) + "/config",
    ).then((d) => d.items || []),

  putConfig: (name, values) =>
    jput(
      "/api/engines/" + encodeURIComponent(name) + "/config",
      { values },
    ),

  async uploadFile(file, engine, onProgress) {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("engine", engine);
    return xhrUpload("/api/upload", fd, onProgress);
  },

  async uploadAudio(file, engine, audio, onProgress) {
    const fd = new FormData();
    fd.append("audio", audio, file.name.replace(/\.[^.]+$/, "") + ".opus");
    fd.append("engine", engine);
    fd.append("name", file.name);
    fd.append("size_mb", String(Math.round(file.size / 1048576)));
    return xhrUpload("/api/upload-audio", fd, onProgress);
  },

  getUpload: (id) => jget<UploadStatus>("/api/uploads/" + id),

  // 扫描目录 = 工作台部署所在机器（客户端本机），非服务端机器
  scan: (name, path, opts) => {
    let q = `/api/scan/local?engine=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}`;
    if (opts) {
      if (opts.min_size_mb != null) q += `&min_size_mb=${encodeURIComponent(String(opts.min_size_mb))}`;
      if (opts.naming_c) q += `&naming_c=${encodeURIComponent(opts.naming_c)}`;
    }
    return jgetOrDetail<ScanResult>(q);
  },

  // 目录浏览 = 客户端部署机文件系统（「浏览」按钮；只列目录，不读内容）
  fsBrowse: (p) => jgetOrDetail<FsBrowseResult>(`/api/fs/browse?path=${encodeURIComponent(p)}`),
  // 字幕预览：只放行字幕扩展名（服务端校验），内容返回给前端弹窗解析
  readSrt: (p) => jgetOrDetail<SrtReadResult>(`/api/fs/read-srt?path=${encodeURIComponent(p)}`),

  async submitScan(name: string, files: string[], subStatus?: Record<string, string>) {
    let r: Response;
    try {
      r = await fetch(`/api/scan/local/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          engine: name,
          files,
          ...(subStatus && Object.keys(subStatus).length ? { sub_status: subStatus } : {}),
        }),
      });
    } catch (_e) {
      throw new TransportError("网络错误", true);
    }
    if (r.ok) {
      const d = (await r.json()) as { files: number; upload_ids: string[]; skipped?: string[] };
      return { files: d.files, uploadIds: d.upload_ids, skipped: d.skipped };
    }
    let msg = String(r.status);
    try { msg = ((await r.json()) as { detail?: string }).detail || msg; } catch (_e) {}
    throw new TransportError(msg);
  },
};
