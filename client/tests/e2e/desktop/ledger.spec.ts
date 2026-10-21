// 桌面端派发账本专测（10-21-javscribe-0251-task-history）
// 打的是用户痛点链：多端客户端任务跑一半退出 → 重开主任务/子行/状态全丢。
//   A. 派发未提交阶段杀进程 → 重启：主任务行 + 全部子行按最后本地状态恢复（账本兜底）
//   B. 已提交任务杀进程 → 重启：服务端行优先不双行；服务失忆（mockReset）后账本行兜底
//   C. 主任务取消（全终态未提交）→ 重启：终态账本行可单行「清除」，「清理已完成」整批清 + fan-out
//   D. 清理已完成：终态行清除、非终态不动、服务端任务表收缩、抑制集重启后仍生效
// 账本键：localStorage javweb_dispatch_ledger_v1（desktop 另有 main 进程 ledger.json 镜像，
// 本套断言走 localStorage 口径——renderer 侧同步写，kill 前至少一次 transition 已落盘）。
import {
  test, expect, goView, launchApp, waitForReady, makeScanDir,
  mockJobs, mockReset, mockSeed, mockSpeed, mockUploadDelay,
} from "./helpers";
import type { Page } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LEDGER_KEY = "javweb_dispatch_ledger_v1";

/** 假 ffmpeg：每帧 0.6s × 5 帧 ≈ 3s 提取（同 dispatch-rows.spec.ts 口径） */
function makeFakeFfmpeg(): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "javscribe-e2e-ledgerff-"));
  const bin = join(dir, "ffmpeg");
  const lines = [
    "#!/bin/bash",
    'out="${@: -1}"',
    "printf 'Duration: 00:00:10.00, start: 0.000000, bitrate: 128 kb/s\\n' >&2",
    "printf 'size= 10kB time=00:00:02.00 bitrate=40.0kbits/s speed=0.6x \\r' >&2; sleep 0.6",
    "printf 'size= 20kB time=00:00:04.00 bitrate=40.0kbits/s speed=0.6x \\r' >&2; sleep 0.6",
    "printf 'size= 30kB time=00:00:06.00 bitrate=40.0kbits/s speed=0.6x \\r' >&2; sleep 0.6",
    "printf 'size= 40kB time=00:00:08.00 bitrate=40.0kbits/s speed=0.6x \\r' >&2; sleep 0.6",
    "printf 'size= 50kB time=00:00:10.00 bitrate=40.0kbits/s speed=0.6x \\r' >&2; sleep 0.6",
    'head -c 4096 /dev/zero > "$out"',
    "exit 0",
  ];
  writeFileSync(bin, lines.join("\n") + "\n", "utf8");
  chmodSync(bin, 0o755);
  return { dir, bin };
}

/** 扫描目录 → 按勾选策略提交（默认全选；names 指定则只勾这些文件）。 */
async function submitScan(page: Page, dir: string, names?: string[]): Promise<void> {
  await page.selectOption("#engine-select", "mock");
  await page.locator("#scan-path").fill(dir);
  await page.click("#scan-go");
  const rows = page.locator("#scan-table tbody tr");
  await expect(rows).toHaveCount(3, { timeout: 20_000 });
  if (names) {
    // 扫描默认勾选全部「无字幕」文件（SUB-001 会被带上）：先清勾选再按名单勾
    for (const row of await rows.all()) {
      const cb = row.locator("input[type=checkbox]").first();
      if (await cb.isChecked()) await cb.uncheck();
    }
    for (const n of names) {
      await rows.filter({ hasText: n }).locator("input[type=checkbox]").first().check();
    }
  } else {
    await page.locator("#scan-select-all").check();
  }
  await page.click("#scan-submit");
}

const ledgerState = (page: Page) =>
  page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as { children?: Record<string, unknown>; suppress?: string[] };
    return {
      children: Object.keys(d.children || {}).length,
      suppress: [...(d.suppress || [])],
    };
  }, LEDGER_KEY);

test("A：派发中退出（未提交服务）→ 重启主任务 + 3 子行恢复（账本兜底，无 serve 行）", async ({ userData, request }) => {
  const ff = makeFakeFfmpeg();
  // queue_cap=1：只有第 1 个文件开跑，2 条子行停「排队提取」；upload 延迟 5s：杀在提交前
  writeFileSync(join(userData, "client-config.json"), JSON.stringify(
    { scan_min_size_mb: 0, extract_workers: 1, queue_cap: 1 }), "utf8");
  await mockUploadDelay(request, 5000);
  const app = await launchApp(userData, { JAVSCRIBE_FFMPEG: ff.bin });
  try {
    const page = await app.firstWindow();
    await waitForReady(page);
    page.on("dialog", (d) => d.accept()); // AKDL-002 同目录已有 srt → 提交前确认
    await goView(page, "dispatch");
    await submitScan(page, makeScanDir("javscribe-desktop-ledger-A-__notfound__"));

    await expect(page.locator(".job-batch-row")).toHaveCount(1);
    await expect(page.locator(".job-row")).toHaveCount(3);
    // 杀在「提取中」：第 1 条子行已进提取阶段（transition 已落盘），尚未提交服务
    await expect
      .poll(() => page.evaluate(() => {
        const st = (window as unknown as { state?: { _pending?: Map<string, { row: { phase?: string } }> } }).state;
        let extracting = 0;
        if (st?._pending) for (const p of st._pending.values()) if (p.row.phase === "extracting") extracting++;
        return extracting;
      }), { timeout: 30_000, intervals: [300] })
      .toBeGreaterThanOrEqual(1);
    await app.close();
    expect(await mockJobs(request)).toHaveLength(0); // 杀前没有任何任务到服务

    // 重启同 userData：主任务行 + 3 子行全恢复（最后本地状态 + 本地记录提示）
    const app2 = await launchApp(userData);
    try {
      const page2 = await app2.firstWindow();
      await waitForReady(page2);
      await goView(page2, "jobs");
      await expect(page2.locator(".job-batch-row")).toHaveCount(1, { timeout: 20_000 });
      await expect(page2.locator(".job-batch-row .batch-sub-n")).toHaveText("3 子任务");
      // 4 行 = 3 账本子行 + 1 pre ghost（杀前提取已 pre 登记 → F4「未提交」占位行，既有行为）
      await expect(page2.locator(".job-row")).toHaveCount(4);
      // 非终态账本行带「本地记录」提示；账本组无主任务操作按钮（无 pending 队列、serve 不认识）
      const noted = page2.locator(".job-row .sub", { hasText: "本地记录（服务端记录不可用" });
      await expect(noted).toHaveCount(3, { timeout: 20_000 });
      await expect(page2.locator(".job-row .pill.p-unsubmitted")).toHaveCount(1);
      await expect(page2.locator(".job-batch-row .batch-op")).toHaveCount(0);
      const ls = await ledgerState(page2);
      expect(ls && ls.children).toBe(3);
    } finally {
      await app2.close().catch(() => {});
    }
  } finally {
    rmSync(ff.dir, { recursive: true, force: true });
  }
});

test("B：已提交任务退出 → 重启服务端行优先不双行；服务失忆后账本行兜底", async ({ userData, request }) => {
  const ff = makeFakeFfmpeg();
  // queue_cap=3：三文件同时开跑，尽快提交；mock 减速：任务停在 running（账本最后态=非终态，有提示语）
  writeFileSync(join(userData, "client-config.json"), JSON.stringify(
    { scan_min_size_mb: 0, extract_workers: 3, queue_cap: 3 }), "utf8");
  await mockSpeed(request, { step: 0.005, tickMs: 500 });
  const app = await launchApp(userData, { JAVSCRIBE_FFMPEG: ff.bin });
  try {
    const page = await app.firstWindow();
    await waitForReady(page);
    page.on("dialog", (d) => d.accept());
    await goView(page, "dispatch");
    await submitScan(page, makeScanDir("javscribe-desktop-ledger-B-__notfound__"));
    // 三项全部提交服务（job_id 回填账本 + pending 行交棒）
    await expect.poll(async () => (await mockJobs(request)).length, { timeout: 60_000 }).toBe(3);
    await expect(page.locator(".job-row")).toHaveCount(3);
    await app.close();

    // 重启：mock 仍持有 3 任务 → 服务端行优先，不出账本行（不双行）
    const app2 = await launchApp(userData);
    try {
      const page2 = await app2.firstWindow();
      await waitForReady(page2);
      await goView(page2, "jobs");
      await expect(page2.locator(".job-row")).toHaveCount(3, { timeout: 20_000 });
      await expect(page2.locator(".job-row .sub", { hasText: "本地记录" })).toHaveCount(0);
      const ls = await ledgerState(page2);
      expect(ls && ls.children).toBe(3); // 账本条目仍在（隐藏态，供服务失忆时兜底）

      // 服务失忆（重启丢非终态 / 200 窗挤出 的同形模拟）→ 账本行兜底出现
      await mockReset(request);
      await expect
        .poll(async () => page2.locator(".job-row .sub", { hasText: "本地记录（服务端记录不可用" }).count(),
          { timeout: 30_000 })
        .toBe(3);
      // 同一文件恒一行（serve 行与账本行不同时出现）
      await expect(page2.locator(".job-row")).toHaveCount(3);
    } finally {
      await app2.close().catch(() => {});
    }
  } finally {
    rmSync(ff.dir, { recursive: true, force: true });
  }
});

test("C：全终态未提交批 → 重启终态账本行可单行清除；「清理已完成」整批清 + 抑制", async ({ userData, request }) => {
  const ff = makeFakeFfmpeg();
  writeFileSync(join(userData, "client-config.json"), JSON.stringify(
    { scan_min_size_mb: 0, extract_workers: 1, queue_cap: 1 }), "utf8");
  await mockUploadDelay(request, 5000); // 保证整批取消发生在任何提交之前
  const app = await launchApp(userData, { JAVSCRIBE_FFMPEG: ff.bin });
  try {
    const page = await app.firstWindow();
    await waitForReady(page);
    page.on("dialog", (d) => d.accept());
    await goView(page, "dispatch");
    await submitScan(page, makeScanDir("javscribe-desktop-ledger-C-__notfound__"));
    await expect(page.locator(".job-row")).toHaveCount(3);
    // 主任务取消：2 条未开始 → 已取消；在跑 1 条 → 跑完当前阶段不提交 = 已跳过
    await page.locator('.job-batch-row [data-bact="cancel"]').click();
    await expect(page.locator(".job-row .pill.p-canceled")).toHaveCount(2, { timeout: 20_000 });
    await expect(page.locator(".job-row .pill.p-skipped")).toHaveCount(1, { timeout: 60_000 });
    expect(await mockJobs(request)).toHaveLength(0); // 全程无服务任务
    await app.close();

    // 重启：3 条终态账本行恢复，行级「清除」可用；主任务行（账本组）无操作按钮
    const app2 = await launchApp(userData);
    try {
      const page2 = await app2.firstWindow();
      await waitForReady(page2);
      page2.on("dialog", (d) => d.accept()); // 「清理已完成」走 window.confirm：无监听时 Playwright 默认 dismiss（confirm=false，静默不执行）
      await goView(page2, "jobs");
      // 4 行 = 3 终态账本行 + 1 pre ghost（跑完提取阶段被跳过 → pre 登记残留 → F4 占位行）
      await expect(page2.locator(".job-row")).toHaveCount(4, { timeout: 20_000 });
      await expect(page2.locator(".job-batch-row .batch-op")).toHaveCount(0);
      // 筛选计数含账本终态行（summary 覆盖桶时叠加回）：1 跳过 + 2 失败（取消）
      await expect(page2.locator('#job-filter button[data-f="skipped"]')).toContainText("1");
      await expect(page2.locator('#job-filter button[data-f="failed"]')).toContainText("2");
      const clears = page2.locator(".job-row .led-clear");
      await expect(clears).toHaveCount(3);
      // 单行清除：删本地账本条目，行消失，其余不动（ghost 行无 led-clear，不受影响）
      await clears.first().click();
      await expect(page2.locator("#toasts .toast.ok", { hasText: "已清除该本地记录" })).toBeVisible();
      await expect(page2.locator(".job-row")).toHaveCount(3);
      // 「清理已完成」：余下 2 条终态整清（服务侧无任务可清）；ghost 占位行非账本终态，保留
      await page2.locator("#job-clear-done").click();
      await expect(page2.locator("#toasts .toast.ok", { hasText: "已清理 2 条本机已完成任务" })).toBeVisible({ timeout: 15_000 });
      await expect(page2.locator(".job-row")).toHaveCount(1);
      await expect(page2.locator(".job-row .pill.p-unsubmitted")).toHaveCount(1);
      const ls = await ledgerState(page2);
      expect(ls && ls.children).toBe(0);
      expect(await mockJobs(request)).toHaveLength(0);
    } finally {
      await app2.close().catch(() => {});
    }
  } finally {
    rmSync(ff.dir, { recursive: true, force: true });
  }
});

test("D：清理已完成 = 终态清除 + 非终态不动 + 服务端表收缩 + 抑制重启仍生效", async ({ userData, request }) => {
  const ff = makeFakeFfmpeg();
  // queue_cap=3：running seed 与本机 job 必须并行在途。cap=1 时 seed 占住唯一槽位，
  // 本机 job 要等 seed 完成才能派发 → 「clear 时恰 3 终态」在结构上不可能成立（seed 必先终态）
  writeFileSync(join(userData, "client-config.json"), JSON.stringify(
    { scan_min_size_mb: 0, extract_workers: 1, queue_cap: 3 }), "utf8");
  // canary：确认当前 mock 实例按每任务 step 限速（防 reuseExistingServer 复用旧代码实例：
  // 旧实例不认识 step，running 会按默认 0.25/100ms 秒级穿完，本用例速度口径全部失效）
  await mockSeed(request, { n: 1, status: "running", progress: 0.5, step: 0.0001 });
  const canaryId = (await mockJobs(request))[0]?.id;
  await new Promise((r) => setTimeout(r, 2500));
  const canary = (await mockJobs(request)).find((j) => j.id === canaryId);
  expect(canary?.state, "canary：mock 未按每任务 step 限速（疑似复用了旧 mock 实例）").toBe("running");
  await mockReset(request);
  // 服务侧预置：2 终态（done）+ 1 非终态（running，每任务 step 0.0005 约百秒级，全用例保持不推进），
  // 确定性 job id（seed 序列 reset 后可复现）。本机 job 走 mock 默认速度（秒级跑完），
  // 保证 clear 时 3 条终态 = 2 seed + 本机（本机 key 入抑制集，reseed 后 0 行口径成立）
  await mockSeed(request, { n: 2, status: "done" });
  await mockSeed(request, { n: 1, status: "running", progress: 0.5, step: 0.0005 });
  const app = await launchApp(userData, { JAVSCRIBE_FFMPEG: ff.bin });
  try {
    const page = await app.firstWindow();
    await waitForReady(page);
    page.on("dialog", (d) => d.accept());
    // 本机再派 1 条并跑完（真实链路：pending → 提交 → done）
    await goView(page, "dispatch");
    await submitScan(page, makeScanDir("javscribe-desktop-ledger-D-__notfound__"), ["AKDL-001.mp4"]);
    // 按文件名定位本机行等 done（不用 p-done 总数判：running seed 若提前完成会把计数顶满造成假绿）
    const localRow = page.locator(".job-row", { hasText: "AKDL-001" });
    await expect(localRow.locator(".pill.p-done")).toBeVisible({ timeout: 90_000 });
    // clear 前确认服务端侧只有 running seed 一条非终态（UI 文本有重名 seed-001，走 mock 口径更稳）
    const nonFinished = (await mockJobs(request)).filter((j) => j.state !== "finished");
    expect(nonFinished, "clear 前 running seed 不应完成（step 0.0005 限速失效？）").toHaveLength(1);
    // 「清理已完成」：3 条终态（2 seed done + 1 本机 done）；running 不动
    await page.locator("#job-clear-done").click();
    await expect(page.locator("#toasts .toast.ok", { hasText: "已清理 3 条本机已完成任务；服务侧 1/1 成功（清 3 条）" }))
      .toBeVisible({ timeout: 15_000 });
    // 服务端任务表收缩：只剩 running 那条
    await expect.poll(async () => (await mockJobs(request)).length).toBe(1);
    // 本机视图：终态行消失（seed 行直接消失；本机批子行被抑制 → 批行落孤儿兜底带「清除」）
    await expect(page.locator(".job-row")).toHaveCount(1);
    await expect(page.locator(".job-row .pill.p-running")).toHaveCount(1);
    // 账本：无终态条目（本机 done 行交棒后残留 ≤1 条非终态条目，被抑制隐藏）；抑制集含 3 条终态 key
    const ls = await ledgerState(page);
    expect(ls && ls.children).toBeLessThanOrEqual(1);
    expect(ls && ls.suppress).toHaveLength(3);

    // 服务端「残留」同 id 终态任务 → 被抑制不回来（reset 后 seed 序列重置 = 同 id 复现）
    await mockReset(request);
    await mockSeed(request, { n: 2, status: "done" });
    await expect
      .poll(async () => page.locator(".job-row").count(), { timeout: 30_000 })
      .toBe(0);
    await app.close();

    // 重启：抑制集持久化（localStorage + main 镜像），残留行仍不回来
    const app2 = await launchApp(userData);
    try {
      const page2 = await app2.firstWindow();
      await waitForReady(page2);
      await goView(page2, "jobs");
      await expect
        .poll(async () => page2.locator(".job-row").count(), { timeout: 30_000 })
        .toBe(0);
    } finally {
      await app2.close().catch(() => {});
    }
  } finally {
    rmSync(ff.dir, { recursive: true, force: true });
  }
});
