// desktop 形态本地提音轨：替代浏览器 ffmpeg.wasm（ui/extract.ts）——
// IPC 调 main 进程系统 ffmpeg（spawn，stderr time=/Duration: 算进度）。
// 接口与 JavExtractAPI 1:1；返回的 Blob 是空壳（真实 opus 在 main 侧 tmp），
// 打上 _javOpusPath/_javOpusSize 标签，transport-desktop 凭标签走流式上传。
// 与 web 的两点差异（均为修正，不影响 UI 契约）：
//   - MAX_BYTES=Infinity（无 wasm 线性内存上限，任意大小本机提取）
//   - 裸回调形式的 opts 被正确读取（web 一期怪癖：函数形式读不到 onProgress）
import type { ExtractHooks, ExtractOpts, JavExtractAPI } from "../ui/extract";
import type { JavDesktop } from "../core/desktop-bridge";
import { CLIENT_CFG_DEFAULTS, createPool, ExtractAbortError } from "../core/concurrency";
import { diskKeyOf } from "../core/disk-key";

const desktop: JavDesktop = (window as unknown as { javDesktop: JavDesktop }).javDesktop;

const MAX_BYTES = Infinity;
// S4：串行队列 → 可 resize 池（extract_workers 消费点）；上限读者由 app.ts 注入
//（0.2.53 需求③：客户端设置基线 + Σ 活跃主任务本机提取预算，主任务收尾即回落基线）。
// 与 web 不同：main 侧每次 IPC 起独立系统 ffmpeg（无共享实例），池上限 = N 路真并行；
// cacheStore 原子 rename 保证并发同文件安全（last-writer-wins）。skipped 分支不进池。
const pool = createPool(() => CLIENT_CFG_DEFAULTS.extract_workers);
// 在跑提取登记（key=本机路径或文件名；主任务「取消」按名匹配逐条 kill）
const activeExtracts = new Map<string, { id: string }>();
let extSeq = 0;
function genExtId(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  return c && typeof c.randomUUID === "function" ? c.randomUUID() : `ext-${Date.now()}-${++extSeq}`;
}

function extractAudio(f: File, opts?: ExtractOpts): Promise<Blob | { skipped: true }> {
  if (!f) return Promise.reject(new Error("没有文件"));
  if (f.size <= 0) return Promise.resolve({ skipped: true } as const);
  if (f.size > MAX_BYTES) return Promise.resolve({ skipped: true } as const);
  const o = (typeof opts === "function" ? { onProgress: opts } : opts) as ExtractHooks | undefined;
  const id = genExtId();
  // 本机路径在入队前定稿（池分组键 groupKey 要用；desktop.filePath 为同步桥接，提前解析无副作用）
  const localPath = (f as File & { _localPath?: string })._localPath || desktop.filePath(f);
  // 0.2.52 M2：按盘公平准入——同盘文件不独占全部提取槽（保底 1/盘）；无本机路径 → ""（无分组，纯 FIFO）
  const groupKey = diskKeyOf(localPath);
  const run = async (): Promise<Blob> => {
    // 池拿到槽、执行前：中止闸（主任务取消）→ 不起 ffmpeg
    if (o?.isAborted?.()) throw new ExtractAbortError();
    // 池出队闸：主任务「暂停」保持（行显「已暂停」）；保持期间被取消则入口拒绝
    if (o?.waitReady) {
      await o.waitReady();
      if (o?.isAborted?.()) throw new ExtractAbortError();
    }
    activeExtracts.set(localPath || f.name, { id });
    try {
      const res = localPath
        ? await desktop.extractAudio({ videoPath: localPath, id }, o?.onProgress)
        : await desktop.extractAudio({ data: new Uint8Array(await f.arrayBuffer()), id }, o?.onProgress);
      if (!res.ok) {
        if (res.cancelled) throw new ExtractAbortError(); // main 侧被 kill（主任务取消）
        throw new Error(res.error);
      }
      const blob = new Blob([], { type: "audio/ogg" });
      Object.defineProperty(blob, "size", { value: res.sizeBytes, configurable: true });
      (blob as { _javOpusPath?: string; _javOpusSize?: number })._javOpusPath = res.opusPath;
      (blob as { _javOpusPath?: string; _javOpusSize?: number })._javOpusSize = res.sizeBytes;
      return blob;
    } finally {
      activeExtracts.delete(localPath || f.name);
    }
  };
  return pool.run(run, { onQueue: o?.onQueue, onStart: o?.onStart, groupKey }) as Promise<Blob | { skipped: true }>;
}

const api: JavExtractAPI = {
  extractAudio,
  MAX_BYTES,
  fits: (f) => !!f && f.size > 0 && f.size <= MAX_BYTES,
  setExtractLimit: (read) => {
    pool.setLimitReader(read);
    pool.wake();
  },
  wakeExtract: () => {
    pool.wake();
  },
  cancelExtracts: async (names: string[]): Promise<number> => {
    if (!names.length) return 0;
    let n = 0;
    for (const [key, v] of [...activeExtracts]) {
      const base = key.split(/[\\/]/).pop() || key;
      if (!names.includes(key) && !names.includes(base)) continue;
      try {
        const r = await desktop.extractAudioCancel(v.id);
        if (r.ok) n++;
      } catch { /* 单条 kill 失败不挡其余 */ }
    }
    return n;
  },
};

(window as { JavExtract?: JavExtractAPI }).JavExtract = api;
