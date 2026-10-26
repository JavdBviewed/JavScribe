// 文件夹监听多目录（A）+ 派发失败自动重审（B）e2e（仅 desktop 形态；
// 任务线 10-26-javscribe-watch-multifolder-retry A/B 项）：
//   A 多目录：watch.set 收 paths 全量替换；双目录并行各自派发；移除目录后其新文件
//   不再派发；重复 / 嵌套 / symlink 重复路径拒绝且状态不变；被监听目录被删 →
//   该目录记 errors（其余照常），目录恢复后自动复原。
//   B 失败重审：派发失败（本机提取失败）记入 failed（size/mtime 指纹）；
//   指纹不变 → 不重试（无第二次提取尝试）；文件变化 → 移出 failed，重走两次轮询
//   稳定性流程再派发，故障原因消除后完整走通。
//
// 失败注入（B）：app fixture 经 JAVSCRIBE_FFMPEG（findFfmpeg 第一优先级直路径）
//   注入假 ffmpeg（shell 脚本）：失败阶段 exit 1 → main spawn close code≠0 →
//   「本地提取失败（退出码 1）」；提取模式同时强制 local（#extract-select）→
//   dispatchOne 提取失败分支不回退整片上传 → [false, {error}] → watch 失败分支
//   markFailed。B2 恢复阶段把假 ffmpeg 覆写为系统真实 ffmpeg 的委托脚本
//   （findFfmpeg 每次提取重解析 env 路径 → 覆写即时生效），并 appendFileSync
//   追加视频尾部字节（size + mtime 变化 → 指纹失效）。
//   每次假 ffmpeg 被调起向 calls.log 追加一行，用例据此断言「提取实际尝试了几次」，
//   排除「重审从未触发 / 触发多次」的假覆盖。
//
// 节奏说明：JAVSCRIBE_WATCH_MIN_POLL_MS=300（helpers launchApp 注入）允许 pollMs=800；
//           候选需 (size, mtime) 连续两次轮询不变（稳定性基线，≈1.6s）；
//           72KB 夹具 < 默认 min_size_mb=200MB（C 项口径），派发类用例先
//           putClientConfig 置 0（与 watch-minsize 同款）。
import { test, test as baseTest, expect, launchApp, mockJobs, waitForMockJobFinished, FIXTURES } from "./helpers";
import type { ElectronApp } from "./helpers";
import type { Page } from "@playwright/test";
import {
  appendFileSync, chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync,
  readFileSync, rmdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const fx = (n: string) => join(FIXTURES, n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rp = (p: string) => realpathSync(p);

async function watchState(page: Page) {
  return page.evaluate(async () => (window as any).javDesktop.watch.state());
}
async function watchSet(page: Page, q: { enabled?: boolean; path?: string; paths?: string[]; pollMs?: number }) {
  return page.evaluate(async (x) => (window as any).javDesktop.watch.set(x), q);
}
function tmpWatchDir() {
  return mkdtempSync(join(tmpdir(), "javscribe-watch-mfr-"));
}
function countCalls(calls: string): number {
  if (!existsSync(calls)) return 0;
  const t = readFileSync(calls, "utf-8").trim();
  return t ? t.split("\n").length : 0;
}

/** 72KB 夹具 < 默认 min_size_mb=200MB（C 项口径）：需派发的用例先把阈值置 0 */
async function zeroMinSizeGate(page: Page) {
  await page.evaluate(async () => {
    const r = await (window as any).javDesktop.call("putClientConfig", [JSON.stringify({ scan_min_size_mb: 0 })]);
    if (!r.ok) throw new Error(r.error || "putClientConfig 失败");
  });
}

// ---------------------------------------------------------------------------
// A：多目录（helpers 默认 fixture，无需特殊 env）
// ---------------------------------------------------------------------------

test("A 双目录并行：两个目录的文件各自派发成 job 并完成", async ({ page, request }) => {
  await zeroMinSizeGate(page);
  await page.selectOption("#engine-select", "mock");
  const d1 = tmpWatchDir();
  const d2 = tmpWatchDir();
  copyFileSync(fx("video-a.mp4"), join(d1, "mf-a1.mp4"));
  copyFileSync(fx("video-b.mkv"), join(d2, "mf-b1.mkv"));
  try {
    const r = await watchSet(page, { enabled: true, paths: [rp(d1), rp(d2)], pollMs: 800 });
    expect(r.ok).toBe(true);
    expect(r.state.paths).toEqual([rp(d1), rp(d2)]);

    // 两目录同轮稳定（≈1.6s）后逐个派发（watch 单在途槽）
    await expect.poll(async () => (await mockJobs(request)).length, { timeout: 30_000 }).toBe(2);
    const jobs = await mockJobs(request);
    const labels = jobs.map((j) => String(j.label ?? "")).join("|");
    expect(labels).toContain("mf-a1.mp4");
    expect(labels).toContain("mf-b1.mkv");
    await waitForMockJobFinished(request, jobs[0].id, 60_000);
    await waitForMockJobFinished(request, jobs[1].id, 60_000);
    // markProcessed 是 fire-and-forget IPC（pollUpload 1s 周期，可能晚于 mock 侧 job finished）：轮询收敛
    await expect.poll(async () => (await watchState(page)).processed, {
      timeout: 15_000, message: "15s 内 processed 未收敛到 2",
    }).toBe(2);
    const st = await watchState(page);
    expect(st).toMatchObject({ failed: 0, errors: {} });
    expect(st.paths).toEqual([rp(d1), rp(d2)]);
  } finally {
    rmSync(d1, { recursive: true, force: true });
    rmSync(d2, { recursive: true, force: true });
  }
});

test("A 移除目录：被移除目录的新文件不再派发，保留目录照常", async ({ page, request }) => {
  await zeroMinSizeGate(page);
  await page.selectOption("#engine-select", "mock");
  const d1 = tmpWatchDir();
  const d2 = tmpWatchDir();
  copyFileSync(fx("video-a.mp4"), join(d1, "mf-keep.mp4"));
  try {
    const r0 = await watchSet(page, { enabled: true, paths: [rp(d1), rp(d2)], pollMs: 800 });
    expect(r0.ok).toBe(true);
    // 基线：d1 文件照常派发
    await expect.poll(async () => (await mockJobs(request)).length, { timeout: 30_000 }).toBe(1);

    // 全量替换 set：移除 d2
    const r1 = await watchSet(page, { paths: [rp(d1)] });
    expect(r1.ok).toBe(true);
    expect(r1.state.paths).toEqual([rp(d1)]);

    // 被移除目录放新文件：过完整稳定性轮询窗口（≈2s）也不应产生候选
    copyFileSync(fx("video-b.mkv"), join(d2, "mf-gone.mkv"));
    await sleep(6_000);
    expect(await mockJobs(request)).toHaveLength(1);

    const st = await watchState(page);
    expect(st).toMatchObject({ processed: 1, failed: 0, errors: {} });
    expect(st.paths).toEqual([rp(d1)]);
  } finally {
    rmSync(d1, { recursive: true, force: true });
    rmSync(d2, { recursive: true, force: true });
  }
});

test("A 重复 / 嵌套 / symlink 重复路径拒绝，拒绝后状态不变", async ({ page }) => {
  const d1 = tmpWatchDir();
  const dSub = join(d1, "sub");
  mkdirSync(dSub);
  const dLink = join(tmpdir(), `javscribe-watch-mfr-link-${Date.now()}`);
  symlinkSync(d1, dLink);
  try {
    // 重复：同一目录两次
    let r = await watchSet(page, { enabled: true, paths: [rp(d1), rp(d1)] });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("重复");
    // 嵌套：父目录 + 子目录
    r = await watchSet(page, { enabled: true, paths: [rp(d1), rp(dSub)] });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("嵌套");
    // symlink 重复：realpath 归一后同目录
    r = await watchSet(page, { enabled: true, paths: [rp(d1), rp(dLink)] });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("重复");

    // 全部拒绝 → 状态保持默认空
    let st = await watchState(page);
    expect(st).toMatchObject({ enabled: false, paths: [], failed: 0, errors: {} });

    // 对照：单目录可过；成功 set 后再被拒绝不得污染已有 paths
    r = await watchSet(page, { enabled: true, paths: [rp(d1)] });
    expect(r.ok).toBe(true);
    expect(r.state.paths).toEqual([rp(d1)]);
    r = await watchSet(page, { paths: [rp(d1), rp(dSub)] });
    expect(r.ok).toBe(false);
    st = await watchState(page);
    expect(st.paths).toEqual([rp(d1)]);
    expect(st.enabled).toBe(true);
  } finally {
    rmSync(d1, { recursive: true, force: true });
    rmSync(dLink, { force: true }); // 只删 symlink 本身（不递归目标）
  }
});

test("A 监听目录被删：该目录记 errors，其余照常，目录恢复后自动复原", async ({ page, request }) => {
  await zeroMinSizeGate(page);
  await page.selectOption("#engine-select", "mock");
  const d1 = tmpWatchDir();
  const d2 = mkdtempSync(join(tmpdir(), "javscribe-watch-mfr-a4-")); // 先存在（过 set 校验）再删
  copyFileSync(fx("video-a.mp4"), join(d1, "mf-d1.mp4"));
  try {
    const r = await watchSet(page, { enabled: true, paths: [rp(d1), rp(d2)], pollMs: 800 });
    expect(r.ok).toBe(true);

    // 删掉 d2（空目录）→ 下一轮 watchErrors 记之（realpath 必须先于删除取）
    const d2rp = rp(d2);
    rmdirSync(d2);
    await expect.poll(async () => Object.keys((await watchState(page)).errors ?? {}).length, {
      timeout: 15_000, message: "被删目录未在 15s 内记入 errors",
    }).toBe(1);
    let st = await watchState(page);
    expect(st.errors[d2rp]).toContain("不存在");
    expect(st.lastError).toBeTruthy(); // legacy 单值兼容 = per-dir 错误首条

    // d1 不受影响：派发全链路完成
    await expect.poll(async () => (await mockJobs(request)).length, { timeout: 30_000 }).toBe(1);
    const jobs = await mockJobs(request);
    expect(String(jobs[0].label ?? "")).toContain("mf-d1.mp4");
    await waitForMockJobFinished(request, jobs[0].id, 60_000);

    // 恢复目录 + 新文件 → errors 自动清空、派发恢复
    mkdirSync(d2);
    copyFileSync(fx("video-b.mkv"), join(d2, "mf-d2.mkv"));
    await expect.poll(async () => {
      const s = await watchState(page);
      return Object.keys(s.errors ?? {}).length === 0 && s.processed >= 2;
    }, { timeout: 30_000, message: "目录恢复后未在 30s 内复原" }).toBe(true);
    st = await watchState(page);
    expect(st.errors).toEqual({});
    expect(st.lastError).toBeNull();
    expect(st).toMatchObject({ processed: 2, failed: 0 });
  } finally {
    rmSync(d1, { recursive: true, force: true });
    rmSync(d2, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B：失败重审（假 ffmpeg 经 JAVSCRIBE_FFMPEG 注入；覆写 app fixture）
// ---------------------------------------------------------------------------

interface FakeFfmpeg { dir: string; bin: string; calls: string; }

function writeFakeFfmpeg(bin: string, calls: string, mode: "fail" | "passthrough", realFfmpeg?: string) {
  const body = mode === "fail"
    ? `#!/bin/sh\necho call >> "${calls}"\nexit 1\n`
    : `#!/bin/sh\necho call >> "${calls}"\nexec "${realFfmpeg}" "$@"\n`;
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
}

let fake: FakeFfmpeg | null = null;

const retryTest = baseTest.extend<{ app: ElectronApp }>({
  app: async ({ userData }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "javscribe-fake-ffmpeg-"));
    const bin = join(dir, "ffmpeg");
    const calls = join(dir, "calls.log");
    writeFakeFfmpeg(bin, calls, "fail");
    fake = { dir, bin, calls };
    const app = await launchApp(userData, { JAVSCRIBE_FFMPEG: bin });
    await use(app);
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    fake = null;
  },
});

function requireFake(): FakeFfmpeg {
  if (!fake) throw new Error("fake ffmpeg fixture 未就位（仅 retryTest 用例内可用）");
  return fake;
}

retryTest("B1 派发失败登记：指纹不变不重试（无第二次提取尝试）", async ({ page, request }) => {
  const f = requireFake();
  await zeroMinSizeGate(page);
  // 强制本地提取：提取失败不回退整片上传 → dispatchOne [false, {error}] → markFailed
  await page.selectOption("#extract-select", "local");
  await page.selectOption("#engine-select", "mock");
  const d = tmpWatchDir();
  copyFileSync(fx("video-a.mp4"), join(d, "wfr-fail.mp4"));
  try {
    const r = await watchSet(page, { enabled: true, paths: [rp(d)], pollMs: 800 });
    expect(r.ok).toBe(true);

    // 首次派发尝试：假 ffmpeg exit 1 → 提取失败 → 失败登记
    await expect.poll(async () => (await watchState(page)).failed, {
      timeout: 30_000, message: "派发失败未在 30s 内登记 failed",
    }).toBe(1);
    expect(await mockJobs(request)).toHaveLength(0);

    // 等在途派发 / markFailed 收口后取基线：指纹不变 → 此后不再有任何提取尝试
    await sleep(1_500);
    const n1 = countCalls(f.calls);
    expect(n1).toBeGreaterThanOrEqual(1);
    await sleep(8_000); // > 两次稳定性轮询：若重审失效（忽略 failed 指纹）必然再次提取
    expect(countCalls(f.calls)).toBe(n1);
    const st = await watchState(page);
    expect(st).toMatchObject({ failed: 1, processed: 0 });
    expect(await mockJobs(request)).toHaveLength(0);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

retryTest("B2 文件变化后自动重审：故障原因消除后重派发成功", async ({ page, request }) => {
  const f = requireFake();
  // 恢复阶段需要真实 ffmpeg（假 ffmpeg 委托它）；解析不到直接报明确错误
  const real = execFileSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf-8" }).trim();
  expect(real).not.toBe("");
  await zeroMinSizeGate(page);
  await page.selectOption("#extract-select", "local");
  await page.selectOption("#engine-select", "mock");
  const d = tmpWatchDir();
  copyFileSync(fx("video-a.mp4"), join(d, "wfr-retry.mp4"));
  try {
    const r = await watchSet(page, { enabled: true, paths: [rp(d)], pollMs: 800 });
    expect(r.ok).toBe(true);

    // 首次派发失败（假 ffmpeg exit 1）
    await expect.poll(async () => (await watchState(page)).failed, { timeout: 30_000 }).toBe(1);
    await sleep(1_500); // 等在途派发 / markFailed 收口
    const n1 = countCalls(f.calls);
    expect(n1).toBeGreaterThanOrEqual(1);

    // 修复故障原因：假 ffmpeg 改委托系统真实 ffmpeg（每次提取重解析 → 即时生效）
    writeFakeFfmpeg(f.bin, f.calls, "passthrough", real);
    // 文件变化（size + mtime）→ failed 指纹失效 → 移出 failed，重走两次轮询稳定性流程
    appendFileSync(join(d, "wfr-retry.mp4"), Buffer.from("# wfr-retry\n"));

    // 重审 → 再派发 → 成功 → markProcessed（failed 条目已移出）
    await expect.poll(async () => {
      const s = await watchState(page);
      return s.failed === 0 && s.processed === 1;
    }, { timeout: 30_000, message: "文件变化未在 30s 内触发重审再派发" }).toBe(true);

    // 重派发的 job 完成；srt 写回影片同目录（watch 派发强制写回）
    const jobs = await mockJobs(request);
    const job = jobs.find((j) => String(j.label ?? "").includes("wfr-retry.mp4"));
    expect(job, "重审再派发的 job 缺失").toBeTruthy();
    await waitForMockJobFinished(request, (job as any).id, 60_000);
    const srt = join(d, "wfr-retry.zh.srt");
    await expect.poll(() => existsSync(srt), { timeout: 20_000 }).toBe(true);
    expect(readFileSync(srt, "utf-8")).toContain("wfr-retry");

    // 恰好一次再提取（失败 1 次 + 成功 1 次），无多余重试
    expect(countCalls(f.calls)).toBe(n1 + 1);
    const st = await watchState(page);
    expect(st).toMatchObject({ processed: 1, failed: 0 });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
