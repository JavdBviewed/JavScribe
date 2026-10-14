// 完成写回对账决策（10-13-javscribe-client-writeback-guard；单测见 client/tests/unit/writeback.test.mjs）
// F2 背景（run10 A3 实锤）：旧逻辑只认同会话观测到的 running→done 转换
// （notifyJobChanges prev === "running"）；快任务（首次轮询已 done）或客户端重启后
// 首见的行（knownJobs 是内存态，重启即空 → prev=undefined）转换不可观测 →
// writeBackJobs 里登记的 job 永不写回。
// 对账式：每轮 reconcile 对「done + 已登记 + 门控通过」的行触发写回，不依赖转换观测。
// 幂等：调用方（maybeWriteBack）触发后消费登记（writeBackJobs.delete + watchWriteBack.delete），
// 后续轮次自然不再命中；本模块纯决策、不改状态。

/** 参与写回对账的行最小结构（JobRow 结构兼容） */
export interface WriteBackRowLite {
  engine: string;
  job_id?: string | null;
  file?: string;
  status: string;
}

/** writeBackJobs / watchWriteBack 的 key：engine|job_id（与 app.ts 登记口径一致） */
export function jobKey(engine: string, jobId: string): string {
  return engine + "|" + jobId;
}

export interface WriteBackGate {
  /** autoSave 开关（localStorage javweb_autosave；仅控制无本地源场景的既有行为） */
  autoSave: boolean;
  /** 已登记的 job key 集合（writeBackJobs；本地派发路径登记） */
  registered: ReadonlySet<string>;
  /** 本地源强制写回 key 集合（desktop：watch / 扫描 / 选择文件夹 / 单文件 / 换服务重跑） */
  forced: ReadonlySet<string>;
}

/**
 * 对账决策：本轮行中哪些应触发写回。
 * 触发条件 = 行 done + 已登记 +（autoSave 开 || 本地源强制）；
 * 不看 prev（knownJobs 记忆）——快任务 / 重启后首见的行（prev=undefined）同样写回（F2 兜底）。
 * 边界：非 done 终态（skipped/error/canceled）与无 job_id 的本机管线行不写回；
 * 他端任务（无本机登记）不写回（走既有 autoDownloadSrt 分支，由调用方按 canWriteBack 分流）。
 * 幂等：调用方触发后须从 registered / forced 删除 key，下轮自然不重复命中。
 */
export function pickWriteBackRows(rows: readonly WriteBackRowLite[], gate: WriteBackGate): WriteBackRowLite[] {
  const out: WriteBackRowLite[] = [];
  for (const r of rows) {
    if (r.status !== "done" || !r.job_id) continue;
    const key = jobKey(r.engine, r.job_id);
    if (!gate.registered.has(key)) continue;
    if (!gate.autoSave && !gate.forced.has(key)) continue;
    out.push(r);
  }
  return out;
}
