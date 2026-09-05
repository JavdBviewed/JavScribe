// web 形态 transport：所有请求走工作台 /api/*（FastAPI 聚合器，API Key 藏服务端）。
// 端点与迁移前 app.js 内联 fetch/XHR 完全一致，行为 1:1。

import { TransportError, type Transport, type UploadDispatch, type UploadProgress } from "../core/transport";
import type {
  ConfigItem, Engine, Health, JobRow, ScanResult, UploadStatus,
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

  listJobs: () => jget<JobRow[]>("/api/jobs"),

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

  scan: (name, path) =>
    jgetOrDetail<ScanResult>(
      `/api/engines/${encodeURIComponent(name)}/scan?path=${encodeURIComponent(path)}`,
    ),

  async submitScan(name, files) {
    let r: Response;
    try {
      r = await fetch(`/api/engines/${encodeURIComponent(name)}/scan/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });
    } catch (_e) {
      throw new TransportError("网络错误", true);
    }
    if (r.ok) {
      const d = (await r.json()) as { files: number; job_id: string };
      return { files: d.files, jobId: d.job_id };
    }
    let msg = String(r.status);
    try { msg = ((await r.json()) as { detail?: string }).detail || msg; } catch (_e) {}
    throw new TransportError(msg);
  },
};
