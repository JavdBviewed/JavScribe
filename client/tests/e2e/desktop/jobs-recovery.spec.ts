// 桌面端中断恢复链路专测（10-24-javscribe-jobs-recovery，0.2.57 批次）
// 打的是用户事故链：客户端/服务端非正常停机 → 重启后任务链路断开的可恢复性：
//   S1 重启后非终态账本行迁移为「中断」（sub 显中断原因）+ 行级入口 + chip 计数
//   S2 行级「清除」：删本机账本条目（localStorage + 磁盘镜像），批次落孤儿兜底行
//   S3 行级「重跑」：源文件仍在 → 重新提交（新 job id），旧账本条目删除
//   S4 「历史清理」对话框：完成+中断两类实时计数、勾选清理、toast + 服务端 fan-out
//   S5 全中断主任务组：组级 [重跑全部][清除]，ledger-clear 清组（batches.json 同步删）
//   S6 工具条「N 中断 · 重跑」：批量重跑中断行 + toast 汇总
// 构造口径（与 ledger.spec 一致）：提交 → mockJobs 落账 → 优雅 app.close()（触发 pagehide
// 迁移，非终态账本子行落「中断」+ reason「客户端退出，任务链路断开」；启动迁移幂等不
// 覆盖）→ mockReset（模拟客户端停机期间 serve 重启丢任务）→ 同 userData 重启。不可
// 运行中 mockReset（轮询致 live 失忆，中断行不再复现）。
// 端口纪律：mock serve 8302 与 web e2e 共享（playwright.desktop.config.ts webServer 托管），
// 不可与发版门禁全量跑并发。
import {
  test, expect, goView, launchApp, waitForReady, makeScanDir,
  mockJobs, mockReset, mockSeed, mockSpeed,
} from "./helpers";
import type { Page } from "@playwright/test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LEDGER_KEY = "javweb_dispatch_ledger_v1";

/** 假 ffmpeg（同 ledger.spec 口径：每帧 0.6s × 5 帧 ≈ 3s 提取）——S5 走 400 回退上传链需要 */
function makeFakeFfmpeg(): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "javscribe-e2e-jobrecff-"));
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

/** 扫描目录 → 按勾选策略提交（同 ledger.spec：默认全选；names 指定则只勾这些文件） */
async function submitScan(page: Page, dir: string, names?: string[]): Promise<void> {
  await page.selectOption("#engine-select", "mock");
  await page.locator("#scan-path").fill(dir);
  await page.click("#scan-go");
  const rows = page.locator("#scan-table tbody tr");
  await expect(rows).toHaveCount(3, { timeout: 20_000 });
  if (names) {
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

/** 账本子行键集合（localStorage 口径） */
const ledgerPkeys = (page: Page) =>
  page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return [] as string[];
    const d = JSON.parse(raw) as { children?: Record<string, unknown> };
    return Object.keys(d.children || {});
  }, LEDGER_KEY);

/** 真实构造入口（request 供 mock 控制口；slow 减速保任务非终态贯穿全程） */
async function setupInterrupted(
  request: import("@playwright/test").APIRequestContext,
  userData: string, tag: string,
  opts: { names?: string[]; ffBin?: string; slow?: boolean; all?: boolean } = {},
): Promise<{ app: Awaited<ReturnType<typeof launchApp>>; page: Page; oldJobIds: string[]; pkeys: string[] }> {
  writeFileSync(join(userData, "client-config.json"), JSON.stringify(
    { scan_min_size_mb: 0, extract_workers: 3, queue_cap: 3 }), "utf8");
  if (opts.slow !== false) await mockSpeed(request, { step: 0.005, tickMs: 500 });
  const app = await launchApp(userData, opts.ffBin ? { JAVSCRIBE_FFMPEG: opts.ffBin } : {});
  const page = await app.firstWindow();
  await waitForReady(page);
  page.on("dialog", (d) => d.accept()); // AKDL-002 同目录已有 srt → 提交前确认（全选场景）
  await goView(page, "dispatch");
  const dir = makeScanDir(`javscribe-jobs-recovery-${tag}${opts.ffBin ? "-__notfound__" : ""}`);
  await submitScan(page, dir, opts.all === false ? (opts.names ?? ["AKDL-001.mp4"]) : undefined);
  const want = opts.all === false ? (opts.names?.length ?? 1) : 3;
  await expect.poll(async () => (await mockJobs(request)).length, { timeout: 90_000 }).toBe(want);
  // 等账本子行全部回填 job_id（非终态落盘的前提）
  await expect.poll(async () => (await ledgerPkeys(page)).length, { timeout: 30_000 }).toBe(want);
  const ids = (await mockJobs(request)).map((j: { id: string }) => j.id);
  const pkeys = await ledgerPkeys(page); // close 前快照：迁移/重启后键应稳定（不丢键）
  await app.close();
  await mockReset(request); // 模拟客户端停机期间 serve 重启丢非终态
  const app2 = await launchApp(userData, opts.ffBin ? { JAVSCRIBE_FFMPEG: opts.ffBin } : {});
  const page2 = await app2.firstWindow();
  await waitForReady(page2);
  await goView(page2, "jobs");
  return { app: app2, page: page2, oldJobIds: ids, pkeys };
}

test("S1：重启后非终态账本行迁移「中断」——pill/sub/行级入口/chip/组级按钮齐全", async ({ userData, request }) => {
  const { app, page, pkeys } = await setupInterrupted(request, userData, "S1", { all: false });
  try {
    await expect(page.locator(".job-row")).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator(".job-row .pill.p-interrupted")).toHaveCount(1, { timeout: 20_000 });
    // app.close() 优雅关闭 → pagehide 迁移先落「客户端退出」（启动迁移幂等不覆盖）
    await expect(page.locator(".job-row .sub", { hasText: "客户端退出，任务链路断开" })).toHaveCount(1);
    // 行级入口：重跑（源文件在 → 可用）+ 清除
    await expect(page.locator(".job-row .led-rerun")).toBeEnabled();
    await expect(page.locator(".job-row .led-clear")).toBeVisible();
    // 工具条：「1 中断 · 重跑」出现
    await expect(page.locator("#job-rerun-interrupted")).toBeVisible();
    await expect(page.locator("#job-rerun-interrupted")).toContainText("1 中断 · 重跑");
    // 主任务组：全中断 → 组级 [重跑全部][清除]
    await expect(page.locator(".job-batch-row")).toHaveCount(1);
    await expect(page.locator(".job-batch-row .batch-op")).toHaveCount(2);
    // chip：中断桶计数 1（0.2.57 新增筛选态）
    await expect(page.locator('#job-filter button[data-f="interrupted"]')).toContainText("1");
    // 账本键稳定：批量流账本键 = pend|<batch>|<idx>（迁移只改状态不丢键，无 jobid 重键）
    expect(await ledgerPkeys(page)).toEqual(pkeys);
  } finally {
    await app.close().catch(() => {});
  }
});

test("S2：行级「清除」——删账本条目（localStorage + 磁盘镜像），批次落孤儿兜底行", async ({ userData, request }) => {
  const { app, page, pkeys } = await setupInterrupted(request, userData, "S2", { all: false });
  const pkey = pkeys[0];
  try {
    await expect(page.locator(".job-row .pill.p-interrupted")).toHaveCount(1, { timeout: 20_000 });
    await page.locator(".job-row .led-clear").click();
    await expect(page.locator("#toasts .toast.ok", { hasText: "已清除该本地记录" })).toBeVisible();
    await expect(page.locator(".job-row")).toHaveCount(0, { timeout: 15_000 });
    const pkeys = await ledgerPkeys(page);
    expect(pkeys).not.toContain(pkey);
    // 磁盘镜像同步删（main ledger.json write-through）
    await expect.poll(async () => {
      try { return !readFileSync(join(userData, "ledger.json"), "utf-8").includes(pkey); }
      catch { return true; }
    }, { timeout: 15_000 }).toBe(true);
    // 批次记录仍在但无子行 → 孤儿兜底主任务行（带「清除」，删本地 batches.json 记录）
    await expect(page.locator(".job-batch-row")).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('.job-batch-row .batch-op[data-bact="clear"]')).toHaveCount(1);
  } finally {
    await app.close().catch(() => {});
  }
});

test("S3：行级「重跑」——源文件仍在 → 重新提交新 job，旧账本条目删除", async ({ userData, request }) => {
  const { app, page, pkeys } = await setupInterrupted(request, userData, "S3", { all: false });
  const pkey = pkeys[0];
  try {
    await expect(page.locator(".job-row .pill.p-interrupted")).toHaveCount(1, { timeout: 20_000 });
    await page.locator(".job-row .led-rerun").click();
    await expect(page.locator("#toasts .toast.ok", { hasText: "已重新提交" })).toBeVisible({ timeout: 30_000 });
    // mock /reset 清零 seq → 重启后首个 job 复用 000001（与旧 id 相同为 mock 语义，真实 serve 必新 id）；
    // 产品口径断言：任务表恰好 1 行 + 中断清零 + 旧账本条目删除（不双行）
    await expect.poll(async () => (await mockJobs(request)).length, { timeout: 60_000 }).toBe(1);
    await expect(page.locator(".job-row .pill.p-interrupted")).toHaveCount(0);
    expect(await ledgerPkeys(page)).not.toContain(pkey);
  } finally {
    await app.close().catch(() => {});
  }
});

test("S4：「历史清理」对话框——完成+中断实时计数、勾选清理、toast + 服务端 fan-out", async ({ userData, request }) => {
  const { app, page } = await setupInterrupted(request, userData, "S4", { all: false });
  try {
    await expect(page.locator(".job-row .pill.p-interrupted")).toHaveCount(1, { timeout: 20_000 });
    // 服务端补一条 done（独立行，无 batch）→ 可清理桶 = 完成 1 + 中断 1
    await mockSeed(request, { n: 1, status: "done" });
    await expect(page.locator(".job-row .pill.p-done")).toBeVisible({ timeout: 30_000 });
    await page.locator("#job-clear-done").click();
    await expect(page.locator("#job-cleanup-backdrop")).toBeVisible();
    // 5 类：完成=1、中断=1 勾选；跳过/失败/已取消=0 禁用
    for (const [zh, n] of [["完成", "1"], ["中断", "1"], ["跳过", "0"], ["失败", "0"], ["已取消", "0"]] as const) {
      const cat = page.locator(".cleanup-cat").filter({ has: page.locator(`.cleanup-cat-zh:has-text("${zh}")`) }).first();
      await expect(cat.locator(".cleanup-cat-n")).toHaveText(n);
      const input = cat.locator("input[type=checkbox]");
      if (n === "1") await expect(input).toBeChecked();
      else await expect(input).toBeDisabled();
    }
    await expect(page.locator("#job-cleanup-sync")).toBeChecked();
    await page.locator("#job-cleanup-ok").click();
    await expect(page.locator("#job-cleanup-backdrop")).toBeHidden({ timeout: 15_000 });
    await expect(page.locator("#toasts .toast.ok", { hasText: "已清理 2 条本机任务" })).toBeVisible({ timeout: 15_000 });
    // 本机行清零；服务端 done 被 fan-out 清掉（+ 抑制集防残留回来）
    await expect(page.locator(".job-row")).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(async () => (await mockJobs(request)).length, { timeout: 15_000 }).toBe(0);
  } finally {
    await app.close().catch(() => {});
  }
});

test("S5：全中断主任务组——组级 [重跑全部][清除]；ledger-clear 清组 + batches.json 同步删", async ({ userData, request }) => {
  const ff = makeFakeFfmpeg();
  try {
    // 3 文件走 400 回退本机提取上传链（__notfound__ 目录，同 ledger.spec B 形态）→ 3 个独立 job
    const { app, page } = await setupInterrupted(request, userData, "S5", { all: true, ffBin: ff.bin });
    try {
      await expect(page.locator(".job-batch-row")).toHaveCount(1, { timeout: 20_000 });
      await expect(page.locator(".job-row")).toHaveCount(3, { timeout: 20_000 });
      await expect(page.locator(".job-row .pill.p-interrupted")).toHaveCount(3, { timeout: 20_000 });
      await expect(page.locator(".job-row .sub", { hasText: "客户端退出，任务链路断开" })).toHaveCount(3);
      // 全中断组 → 组级两个操作按钮（无暂停/继续/取消/重试——纯本机组）
      const ops = page.locator(".job-batch-row .batch-op");
      await expect(ops).toHaveCount(2, { timeout: 15_000 });
      await expect(page.locator('.job-batch-row .batch-op[data-bact="rerun-all"]')).toHaveCount(1);
      const clearBtn = page.locator('.job-batch-row .batch-op[data-bact="ledger-clear"]');
      await expect(clearBtn).toHaveCount(1);
      const bid = (await clearBtn.getAttribute("data-bid")) || "";
      expect(bid).toBeTruthy();
      // 组级清除：3 条账本条目 + 本地主任务记录
      await clearBtn.click();
      await expect(page.locator("#toasts .toast.ok", { hasText: "已清除主任务 3 条本地记录" })).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(".job-row")).toHaveCount(0, { timeout: 15_000 });
      await expect(page.locator(".job-batch-row")).toHaveCount(0, { timeout: 15_000 });
      await expect.poll(async () => {
        try { return !readFileSync(join(userData, "batches.json"), "utf-8").includes(bid); }
        catch { return true; }
      }, { timeout: 15_000 }).toBe(true);
    } finally {
      await app.close().catch(() => {});
    }
  } finally {
    rmSync(ff.dir, { recursive: true, force: true });
  }
});

test("S6：工具条「N 中断 · 重跑」——批量重跑中断行 + toast 汇总", async ({ userData, request }) => {
  const { app, page, pkeys } = await setupInterrupted(request, userData, "S6", { all: false });
  const pkey = pkeys[0];
  try {
    await expect(page.locator(".job-row .pill.p-interrupted")).toHaveCount(1, { timeout: 20_000 });
    const btn = page.locator("#job-rerun-interrupted");
    await expect(btn).toBeVisible();
    await expect(btn).toContainText("1 中断 · 重跑");
    await btn.click();
    await expect(page.locator("#toasts .toast.ok", { hasText: "已重跑 1 条" })).toBeVisible({ timeout: 60_000 });
    // 重新提交落 mock；中断态清零；旧账本条目删除（mock /reset 清 seq → id 复用 000001，同 S3 口径）
    await expect.poll(async () => (await mockJobs(request)).length, { timeout: 60_000 }).toBe(1);
    await expect(page.locator(".job-row .pill.p-interrupted")).toHaveCount(0);
    expect(await ledgerPkeys(page)).not.toContain(pkey);
  } finally {
    await app.close().catch(() => {});
  }
});
