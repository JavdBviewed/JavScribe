// desktop 形态本地提音轨：替代浏览器 ffmpeg.wasm（ui/extract.ts）——
// IPC 调 main 进程系统 ffmpeg（spawn，stderr time=/Duration: 算进度）。
// 接口与 JavExtractAPI 1:1；返回的 Blob 是空壳（真实 opus 在 main 侧 tmp），
// 打上 _javOpusPath/_javOpusSize 标签，transport-desktop 凭标签走流式上传。
// 与 web 的两点差异（均为修正，不影响 UI 契约）：
//   - MAX_BYTES=Infinity（无 wasm 线性内存上限，任意大小本机提取）
//   - 裸回调形式的 opts 被正确读取（web 一期怪癖：函数形式读不到 onProgress）
import type { ExtractOpts, JavExtractAPI } from "../ui/extract";
import type { JavDesktop } from "../core/desktop-bridge";
import { CLIENT_CFG_DEFAULTS, createPool } from "../core/concurrency";

const desktop: JavDesktop = (window as unknown as { javDesktop: JavDesktop }).javDesktop;

const MAX_BYTES = Infinity;
// S4：串行队列 → 可 resize 池（extract_workers 消费点）。与 web 不同：main 侧每次 IPC 起
// 独立系统 ffmpeg（无共享实例），池上限 = N 路真并行；cacheStore 原子 rename 保证并发
// 同文件安全（last-writer-wins）。skipped 分支不进池。
const pool = createPool(() => CLIENT_CFG_DEFAULTS.extract_workers);

function extractAudio(f: File, opts?: ExtractOpts): Promise<Blob | { skipped: true }> {
  if (!f) return Promise.reject(new Error("没有文件"));
  if (f.size <= 0) return Promise.resolve({ skipped: true } as const);
  if (f.size > MAX_BYTES) return Promise.resolve({ skipped: true } as const);
  const onProgress = typeof opts === "function" ? opts : opts?.onProgress;
  const run = async (): Promise<Blob> => {
    const localPath = (f as File & { _localPath?: string })._localPath || desktop.filePath(f);
    const res = localPath
      ? await desktop.extractAudio({ videoPath: localPath }, onProgress)
      : await desktop.extractAudio({ data: new Uint8Array(await f.arrayBuffer()) }, onProgress);
    if (!res.ok) throw new Error(res.error);
    const blob = new Blob([], { type: "audio/ogg" });
    Object.defineProperty(blob, "size", { value: res.sizeBytes, configurable: true });
    (blob as { _javOpusPath?: string; _javOpusSize?: number })._javOpusPath = res.opusPath;
    (blob as { _javOpusPath?: string; _javOpusSize?: number })._javOpusSize = res.sizeBytes;
    return blob;
  };
  return pool.run(run) as Promise<Blob | { skipped: true }>;
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
};

(window as { JavExtract?: JavExtractAPI }).JavExtract = api;
