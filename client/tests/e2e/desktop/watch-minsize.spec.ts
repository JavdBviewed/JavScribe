// 文件夹监听 min_size_mb 口径对齐 e2e（仅 desktop 形态；任务线 10-26 C 项，P2）：
//   watch 候选循环此前不检查 too_small，比客户端扫描规则 min_size_mb（默认 200MB）
//   小的视频也会被派发，与「选择文件夹」扫描口径不一致（walkVideos 已按 clientScanCfg()
//   把小视频标 too_small）。候选循环补判定后口径对齐，覆盖：
//   1. min_size_mb 生效：72KB 夹具 < 200MB 阈值 → 稳定性轮询后仍不派发（无 job、processed 不增）
//   2. min_size_mb=0 放行：putClientConfig 置 0 后同一小文件改名入监听目录 → 派发且 job 完成
// 节奏说明：JAVSCRIBE_WATCH_MIN_POLL_MS=300（helpers launchApp 注入）允许 pollMs=800；
//           候选需 (size, mtime) 连续两次轮询不变（稳定性基线），故首个候选 ≈2s，等 ~6s 留足窗口。
import { test, expect, mockJobs, mockSpeed, FIXTURES, waitForMockJobFinished } from "./helpers";
import type { APIRequestContext } from "./helpers";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "@playwright/test";

const fx = (n: string) => join(FIXTURES, n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// step 是每 100ms tick 的进度增量：0.005 → 200 tick ≈ 20s/job（mock 默认速度太快，job 常在
// 首次观察前已 done；放慢便于用例内观察派发节奏）
const slowJobs = (request: APIRequestContext) => mockSpeed(request, { step: 0.005, tickMs: 100 });

async function watchState(page: Page) {
  return page.evaluate(async () => (window as any).javDesktop.watch.state());
}
async function watchSet(page: Page, partial: { enabled?: boolean; path?: string; pollMs?: number }) {
  return page.evaluate(async (q) => (window as any).javDesktop.watch.set(q), partial);
}
let dir: string | null = null;
function tmpWatchDir() {
  dir = mkdtempSync(join(tmpdir(), "javscribe-watch-minsize-"));
  return dir;
}
test.afterEach(() => {
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
});

test("min_size_mb 生效：小于阈值的小视频不派发（默认 200MB）", async ({ page, request }) => {
  await slowJobs(request);
  const d = tmpWatchDir();
  copyFileSync(fx("video-a.mp4"), join(d, "video-a.mp4")); // 72KB < 200MB → too_small
  await page.selectOption("#engine-select", "mock");

  const r = await watchSet(page, { enabled: true, path: d, pollMs: 800 });
  expect(r.ok).toBe(true);
  expect(r.state).toMatchObject({ enabled: true, on: true });

  // 稳定性需连续两次轮询（≈2s）；等 ~6s 覆盖完整派发窗口：
  // too_small 在稳定性判定前被拦截 → 全程无候选、无派发
  await sleep(6_000);
  expect(await mockJobs(request)).toHaveLength(0);

  const st = await watchState(page);
  expect(st).toMatchObject({ on: true, processed: 0, lastError: null });
});

test("min_size_mb=0 放行：同一小文件改名后派发并完成", async ({ page, request }) => {
  await slowJobs(request);
  const d = tmpWatchDir();
  // 客户端扫描规则「忽略小于」置 0（与 interaction.spec 同款；每用例独立 userData，无需还原）
  await page.evaluate(async () => {
    const r = await (window as any).javDesktop.call("putClientConfig", [JSON.stringify({ scan_min_size_mb: 0 })]);
    if (!r.ok) throw new Error(r.error || "putClientConfig 失败");
  });
  copyFileSync(fx("video-a.mp4"), join(d, "small-ok.mp4")); // 新命名：watchSeen 无此记录
  await page.selectOption("#engine-select", "mock");

  const r = await watchSet(page, { enabled: true, path: d, pollMs: 800 });
  expect(r.ok).toBe(true);
  expect(r.state).toMatchObject({ enabled: true, on: true });

  // 两次轮询稳定 ≈2s → 候选 → 派发（本机 ffmpeg 提取 + 上传），job 应很快出现
  await expect.poll(async () => (await mockJobs(request)).length, { timeout: 30_000 }).toBe(1);
  const jobs = await mockJobs(request);
  expect(String(jobs[0].label ?? "")).toContain("small-ok.mp4");
  // slowJobs ≈20s/job：等真正 finished（派发链路完整走通）
  await waitForMockJobFinished(request, jobs[0].id, 60_000);
});
