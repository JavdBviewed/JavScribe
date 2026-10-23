// 批次并发（0.2.53 需求①）web e2e：
//  - 文件夹批运行中可扫描另一路径并发新主任务（A1 web 形态），新旧主任务同看板并存、各自完成
// 本页全选（0.2.53 需求②）web e2e：
//  - 文件夹表 / 扫描表表头勾选框 = 当前页 ∩ 可选项（too_small 需手动勾选；扫描表另排除已生成未落盘）
//  - 取消只清当前页；半选态回写 indeterminate；现有全局全选口径不变
// 夹具小文件均低于默认「忽略小于 200MB」→ 用例内置 0（W1 走设置 UI，W2/W3 走服务端即时置位，
// afterEach 统一还原 200）。
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  waitForEngineOnline, waitForEngineKey, mockReset, mockSpeed, cleanEngines,
  waitForJobsEmpty, makeScanDir, resetPipelinePause, goTab, WEB_URL, FIXTURES,
} from "../helpers";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const VIDEO_A = join(FIXTURES, "video-a.mp4");

let req: APIRequestContext;
test.beforeEach(async ({ page, request }) => {
  req = request;
  await mockReset(request);
  await resetPipelinePause(request);
  await cleanEngines(request);
  await waitForJobsEmpty(request);
  // 8s/任务：保证并发观察窗（与 interaction 同口径）
  await mockSpeed(request, { step: 0.0125, tickMs: 100 });
  await page.goto("/");
  await waitForEngineOnline(page);
  await waitForEngineKey(page, "mock");
});
// pipeline_paused 与扫描规则 minsize 均持久化在共享 client_config.json：用例中途失败也要复位
test.afterEach(async () => {
  await resetPipelinePause(req);
  await req.put("/api/client-config", { data: { scan_min_size_mb: 200 } }).catch(() => {});
});

/** 轮询等包含指定文案的 toast（避免误匹配上一条操作的旧 toast，8s 内会共存） */
async function expectToast(page: Page, needle: string, timeoutMs = 15_000) {
  const t0 = Date.now();
  for (;;) {
    const texts = await page.locator("#toasts .toast").allTextContents();
    if (texts.some((t: string) => t.includes(needle))) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`toast 未出现: ${needle}（当前: ${texts.join(" | ") || "无"}）`);
    await new Promise((rs) => setTimeout(rs, 100));
  }
}

/** 临时目录铺 N 个无字幕视频夹具（webkitdirectory 选目录用） */
function mkVideos(tag: string, n: number, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `javweb-bpp-${tag}-`));
  for (let i = 1; i <= n; i++) {
    copyFileSync(VIDEO_A, join(dir, `${prefix}-${String(i).padStart(3, "0")}.mp4`));
  }
  return dir;
}

test("批次运行中：扫描另一路径并发新主任务，新旧同看板并存各自完成（A1 web）", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  // 1) 「忽略小于」置 0（走设置 UI，顺带验 ccfg 保存链路）
  await goTab(page, "ccfg");
  await expect(page.locator("#cc-scan-minsize")).toHaveValue("200", { timeout: 10_000 });
  await page.locator("#cc-scan-minsize").fill("0");
  await page.locator("#cc-scan-save").click();
  await expect(page.locator("#toasts .toast.ok", { hasText: "扫描规则已保存" })).toBeVisible({ timeout: 10_000 });
  await goTab(page, "dispatch");

  const dirA = mkVideos("w1a", 3, "WB-A");
  const labelA = basename(dirA);
  const scanDir = makeScanDir(`w1-${process.pid}-${Date.now()}`);
  try {
    // 2) 文件夹批 A（3 文件无字幕 → 默认全勾）→ 提交，自动切任务看板
    await page.setInputFiles("#folder", dirA);
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 3 / 3");
    await page.selectOption("#engine-select", "mock");
    await expect(page.locator("#dispatch-go")).toContainText("（3 项）");
    await page.click("#dispatch-go");
    await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/);
    const rowA = page.locator(".job-batch-row", { hasText: labelA });
    await expect(rowA).toHaveCount(1);
    // 批 A 的 3 个子任务全部入快照（提交成功才允许开批 B）
    const t0 = Date.now();
    for (;;) {
      const jobs: any[] = await (await req.get(`${WEB_URL}/api/jobs`)).json();
      if (jobs.length >= 3) break;
      if (Date.now() - t0 > 20_000) throw new Error(`批 A 子任务未入快照（当前 ${jobs.length}）`);
      await new Promise((rs) => setTimeout(rs, 200));
    }

    // 3) 批 A 运行中 → 扫描另一路径（入口 busy 门控已放开）→ 提交新主任务
    await goTab(page, "dispatch");
    await page.locator("#scan-path").fill(scanDir);
    await page.click("#scan-go");
    await expect(page.locator("#scan-table table")).toBeVisible({ timeout: 15_000 });
    // AKDL-002 带外部 srt 默认不勾 → 2 项入队
    await expect(page.locator("#scan-count")).toContainText("已选 2 / 3");
    await page.click("#scan-submit");
    await expectToast(page, "已入队 2 项");
    await goTab(page, "jobs");
    const rowB = page.locator(".job-batch-row", { hasText: basename(scanDir) });
    await expect(rowB).toHaveCount(1);
    // 新旧主任务同看板并存
    await expect(rowA).toHaveCount(1);

    // 4) 各自完成：5 个文件行全 done（3 + 2）
    for (const f of ["WB-A-001.mp4", "WB-A-002.mp4", "WB-A-003.mp4", "AKDL-001.mp4", "SUB-001.mkv"]) {
      await expect(
        page.locator(".job-row", { has: page.locator(".fn", { hasText: f }) }).locator(".pill.p-done"),
      ).toBeVisible({ timeout: 90_000 });
    }
    await expect(page.locator(".job-row .pill.p-done")).toHaveCount(5);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(scanDir, { recursive: true, force: true });
  }
});

test("文件夹表本页全选：当前页 ∩ 可选项、取消只清当前页、半选态、全局全选口径不变", async ({ page }) => {
  // 文件夹表 too_small 判定走客户端本地已加载配置 → minsize 须走设置 UI（与 W1 同口径；
  // raw PUT 只改服务端，已加载页面的本地 state 不刷新，12 个 71KB 夹具会被误判过小）
  await goTab(page, "ccfg");
  await expect(page.locator("#cc-scan-minsize")).toHaveValue("200", { timeout: 10_000 });
  await page.locator("#cc-scan-minsize").fill("0");
  await page.locator("#cc-scan-save").click();
  await expect(page.locator("#toasts .toast.ok", { hasText: "扫描规则已保存" })).toBeVisible({ timeout: 10_000 });
  await goTab(page, "dispatch");
  const dir = mkVideos("w2", 12, "W2");
  try {
    await page.setInputFiles("#folder", dir);
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 12 / 12"); // 非过小 → 默认全勾
    await page.locator("#folder-select-all").uncheck(); // 清空起测
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 0 / 12");
    // 第 1 页（10 项）：本页全选 → 10 选中
    const pa = page.locator("#folder-page-all");
    await expect(pa).toBeEnabled();
    await pa.check();
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 10 / 12");
    // 第 2 页（2 项）：本页全选 → 12 选中；取消 → 只清当前页 → 10 选中
    await page.locator("#fpg-next").click();
    await expect(page.locator("#folder-table tbody tr")).toHaveCount(2);
    await page.locator("#folder-page-all").check();
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 12 / 12");
    await page.locator("#folder-page-all").uncheck();
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 10 / 12");
    // 半选态：回第 1 页手动取消 1 行 → indeterminate
    await page.locator("#fpg-prev").click();
    await page.locator("#folder-table tbody tr").first().locator("input[type=checkbox]").uncheck();
    await expect(page.locator("#folder-page-all")).toHaveJSProperty("indeterminate", true);
    // 现有全局「全选」口径不变：勾 = 所有页可选项
    await page.locator("#folder-select-all").check();
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 12 / 12");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("扫描表本页全选：当前页 ∩ 视图 ∩ 可选项、取消只清当前页、全局全选口径不变", async ({ page }) => {
  await req.put("/api/client-config", { data: { scan_min_size_mb: 0 } });
  const dir = mkVideos("w3", 12, "W3");
  try {
    await page.locator("#scan-path").fill(dir);
    await page.click("#scan-go");
    await expect(page.locator("#scan-table table")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#scan-count")).toContainText("已选 12 / 12"); // 非过小 → 默认全勾
    await page.locator("#scan-select-all").uncheck(); // 清空起测
    await expect(page.locator("#scan-count")).toContainText("已选 0 / 12");
    // 第 1 页（10 项）：本页全选 → 10 选中
    const pa = page.locator("#scan-page-all");
    await expect(pa).toBeEnabled();
    await pa.check();
    await expect(page.locator("#scan-count")).toContainText("已选 10 / 12");
    // 第 2 页（2 项）：勾 1 行 → indeterminate；本页全选 → 12 选中（全局全选同步勾选态）
    await page.locator("#spg-next").click();
    await expect(page.locator("#scan-table tbody tr")).toHaveCount(2);
    await page.locator("#scan-table tbody tr").first().locator("input[type=checkbox]").check();
    await expect(page.locator("#scan-page-all")).toHaveJSProperty("indeterminate", true);
    await page.locator("#scan-page-all").check();
    await expect(page.locator("#scan-count")).toContainText("已选 12 / 12");
    await expect(page.locator("#scan-select-all")).toBeChecked();
    // 取消只清当前页 → 10 选中（第 1 页不动）
    await page.locator("#scan-page-all").uncheck();
    await expect(page.locator("#scan-count")).toContainText("已选 10 / 12");
    // 现有全局「全选」口径不变：取消 = 清所有页（此时框派生为未勾选态，uncheck 不触发 →
    // 按真实用户两步操作：先勾选至 12/12，再取消清空至 0/12）
    await page.locator("#scan-select-all").check();
    await expect(page.locator("#scan-count")).toContainText("已选 12 / 12");
    await page.locator("#scan-select-all").uncheck();
    await expect(page.locator("#scan-count")).toContainText("已选 0 / 12");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
