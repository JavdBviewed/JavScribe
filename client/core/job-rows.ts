// 任务行展平（desktop 形态；等价 web/src/jav_scribe_web/api.py 的 _job_rows）
// 纯逻辑模块：main.ts 的 refreshOne 明细采纳 + listJobs 行展平共用，node 可单测。
//
// 背景（10-09-javscribe-phantom-job-row）：引擎 /jobs/{id} 明细拉取 404（任务在列表
// 与明细之间被挤出内存窗 / 服务重启）时，httpJson 不抛错，错误体 {ok:false,error}
// 曾被当 job 入库 → 展平出 file=String(undefined)="undefined"、status=running、
// 0/0、无位置耗时的「幻行」。本模块两道防御：
//   1. pickJobDetail：仅采纳 200 且带 id 的明细响应，否则回退列表摘要（摘要必带 id）；
//   2. jobRows：无 id 且无 files 的残缺条目直接跳过（合法 job 恒有 id）。

/** refreshOne 视角的引擎信息（最小结构；main.ts 的 EngineInfo 满足） */
export interface JobSourceInfo {
  name: string;
  batch_paused: string[];
  _details: unknown[];
}

/**
 * 明细响应采纳：status=200 且 data 为带非空 id 的对象才当 job 明细；
 * 其余（404 错误体 / 200 空体 / 非对象）一律回退列表摘要，保证行必带 id。
 */
export function pickJobDetail(
  status: number,
  data: unknown,
  summary: unknown,
): unknown {
  if (
    status === 200
    && data !== null
    && typeof data === "object"
    && !Array.isArray(data)
    && (data as { id?: unknown }).id != null
  ) {
    return data;
  }
  return summary;
}

function isJobLike(job: unknown): job is Record<string, unknown> {
  if (job === null || typeof job !== "object" || Array.isArray(job)) return false;
  const j = job as Record<string, unknown>;
  // 残缺条目（无 id 且无 files，典型=HTTP 错误体）不产行
  if (j.id == null && !Array.isArray(j.files)) return false;
  return true;
}

/** 引擎快照列表 → 任务行（running 优先 + created 降序，等价 web 端排序） */
export function jobRows(infos: JobSourceInfo[]): any[] {
  const rows: any[] = [];
  for (const info of infos) {
    for (const job of info._details) {
      if (!isJobLike(job)) continue;
      const base = {
        engine: info.name,
        job_id: job.id ?? null,
        label: job.label || "",
        state: job.state ?? null,
        created: job.created ?? null,
        finished: job.finished ?? null,
        source_kind: job.source_kind ?? null,
        // 主任务（batch）归属：serve 持久化字段，旧 serve 无字段 → null（单文件行为不变）
        batch_id: job.batch_id ?? null,
        batch_label: job.batch_label ?? null,
        batch_paused: !!(job.batch_id) && info.batch_paused.includes(String(job.batch_id)),
      };
      const files = job.files;
      if (!Array.isArray(files) || !files.length) {
        const total = Number(job.total || 0);
        const done = Number(job.done || 0);
        const finished = job.state === "finished";
        rows.push({
          ...base,
          file: job.label || String(job.id),
          status: finished ? "done" : "running",
          progress: total ? done / total : finished ? 1 : 0,
          position: "",
          duration_s: null,
          position_s: null,
          message: `${done}/${total}`,
          output_files: [],
        });
      } else {
        for (const t of files) {
          rows.push({
            ...base,
            file: t?.name || "",
            status: t?.status,
            phase: t?.phase ?? null,
            progress: t?.progress || 0,
            position: t?.position || "",
            duration_s: t?.duration_s ?? null,
            position_s: t?.position_s ?? null,
            phase_detail: t?.phase_detail || "",
            eta_s: t?.eta_s ?? null,
            message: t?.message || "",
            finished: t?.finished ?? null,
            output_files: t?.output_files || [],
          });
        }
      }
    }
  }
  // running 优先 + created 降序（JS sort 稳定，等价 Python 的 (running?0:1, -created)）
  rows.sort(
    (a, b) =>
      (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1) ||
      ((b.created || 0) - (a.created || 0)),
  );
  return rows;
}
