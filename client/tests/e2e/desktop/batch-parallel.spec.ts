// 批次并发（0.2.53 需求①）桌面 e2e：
//  - 主任务运行中可选文件夹（A1b）/ 扫描另一路径（A1a）并发建新主任务；
//    两主任务行并存、暂停 fan-out 不跨组（A1c）、已完批不清中途新选文件夹 UI（A1d，代际比对）、
//    重复点「开始生成」不二次提交（A1e，发送时刻消费勾选 → 按钮禁用）
// 本页全选（0.2.53 需求②）桌面 e2e：
//  - 文件夹表 / 扫描表表头勾选框 = 当前页 ∩ 可选项（too_small 需手动勾选；扫描表另排除已生成未落盘）
//  - 取消只清当前页；半选态回写 indeterminate；整页无可选项 → 禁用
// 注入口径：文件夹选择走主进程 IPC pick-video-folder patch（与 multi-drive-batch 同款）；
// 扫描 = 真实本地目录 + 真实扫描任务；「忽略小于」经「设置 → 客户端 → 扫描规则」UI 置 0
//（72KB 夹具 < 默认 200MB，不置 0 会整表过小出勾选域）。
import { test, expect, mockSpeed, FIXTURES, goView, type ElectronApp } from "./helpers";
import type { APIRequestContext } from "@playwright/test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Page } from "@playwright/test";

/** 8s/任务（与 interaction / multi-drive-batch 同口径）：保证并发观察窗 */
const slowJobs = (request: APIRequestContext) => mockSpeed(request, { step: 0.0125, tickMs: 100 });

/** walkVideos/PickFolderItem 同构（main 侧 IPC patch 返回形状） */
interface PdItem {
  path: string; name: string; size: number; rel: string;
  sub_status: "none"; sub_name: null; sub_token: null; no_sub_token: null;
  too_small: boolean;
}
const mkDir = (tag: string, names: string[], tooSmall: boolean): { dir: string; items: PdItem[] } => {
  const dir = mkdtempSync(join(tmpdir(), `javscribe-bpp-${tag}-`));
  const items = names.map((name) => {
    const p = join(dir, name);
    copyFileSync(join(FIXTURES, "video-a.mp4"), p);
    return {
      path: p, name, size: statSync(p).size,
      rel: `${basename(dir)}/${name}`,
      sub_status: "none" as const, sub_name: null, sub_token: null, no_sub_token: null,
      too_small: tooSmall,
    };
  });
  return { dir, items };
};
const patchPick = (app: ElectronApp, items: PdItem[]) =>
  app.evaluate((el: any, its: PdItem[]) => {
    el.ipcMain.removeHandler("pick-video-folder");
    el.ipcMain.handle("pick-video-folder", () => its);
  }, items);
const checkRow = async (page: Page, tableSel: string, name: string) =>
  page.locator(`${tableSel} tbody tr`, { hasText: name }).locator("input[type=checkbox]").check();
const waitBatchDone = (row: import("@playwright/test").Locator): Promise<void> =>
  expect(row.locator(".pill")).toHaveText("完成", { timeout: 90_000 });

/** 扫描规则 UI 把「忽略小于」置 0（72KB 夹具才进勾选域） */
const setMinSize0 = async (page: Page) => {
  await goView(page, "ccfg");
  await expect(page.locator("#cc-scan-minsize")).toHaveValue("200", { timeout: 10_000 });
  await page.locator("#cc-scan-minsize").fill("0");
  await page.locator("#cc-scan-save").click();
  await expect(page.locator("#toasts .toast.ok", { hasText: "扫描规则已保存" })).toBeVisible({ timeout: 10_000 });
  await goView(page, "dispatch");
};

test("批次运行中：选文件夹建新主任务 + 独立暂停 + 已完批不清新选文件夹 + 不二次提交", async ({ app, page, request }) => {
  await slowJobs(request);
  const A = mkDir("a", ["PA-001.mp4", "PA-002.mp4"], true);
  const B = mkDir("b", ["PB-001.mp4", "PB-002.mp4"], true);
  const C = mkDir("c", ["PC-001.mp4"], true);
  try {
    // 主任务 A（2 文件，过小手动勾）
    await patchPick(app, A.items);
    await page.click("#pick-folder");
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 0 / 2");
    await checkRow(page, "#folder-table", "PA-001.mp4");
    await checkRow(page, "#folder-table", "PA-002.mp4");
    await page.selectOption("#engine-select", "mock");
    await page.click("#dispatch-go");
    await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/);
    const rowA = page.locator(".job-batch-row", { hasText: basename(A.dir) });
    await expect(rowA).toHaveCount(1);

    // A1b：A 运行中 → 选文件夹 B → 新主任务（入口 busy 门控已放开）
    await goView(page, "dispatch");
    await patchPick(app, B.items);
    await page.click("#pick-folder");
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 0 / 2");
    await checkRow(page, "#folder-table", "PB-001.mp4");
    await checkRow(page, "#folder-table", "PB-002.mp4");
    await page.click("#dispatch-go");
    await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/);
    const rowB = page.locator(".job-batch-row", { hasText: basename(B.dir) });
    await expect(rowA).toHaveCount(1);
    await expect(rowB).toHaveCount(1);

    // A1e：勾选发送时刻已消费 → 无待提交 → 「开始生成」禁用（重复点击天然 no-op）
    await goView(page, "dispatch");
    await expect(page.locator("#dispatch-go")).toBeDisabled();

    // A1c：暂停 A → A 停，B 不受影响（fan-out 按 batch.id，不跨组）
    await goView(page, "jobs");
    await rowA.locator('[data-bact="pause"]').click();
    await expect(rowA.locator(".pill")).toHaveText("已暂停", { timeout: 10_000 });
    await expect(rowB.locator(".pill")).not.toHaveText("已暂停");

    // A1d：B 在跑期间选文件夹 C（代际推进）→ A/B 收尾均不得清 C 的 UI
    await goView(page, "dispatch");
    await patchPick(app, C.items);
    await page.click("#pick-folder");
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 0 / 1");
    await goView(page, "jobs");
    await rowA.locator('[data-bact="resume"]').click();
    await waitBatchDone(rowA);
    await waitBatchDone(rowB);
    await goView(page, "dispatch");
    await expect(page.locator("#folder-chip")).toBeVisible();
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 0 / 1");
    await expect(page.locator("#folder-table tbody tr", { hasText: "PC-001.mp4" })).toHaveCount(1);
  } finally {
    rmSync(A.dir, { recursive: true, force: true });
    rmSync(B.dir, { recursive: true, force: true });
    rmSync(C.dir, { recursive: true, force: true });
  }
});

test("批次运行中：扫描另一路径发新主任务（两主任务行并存各自完成）", async ({ app, page, request }) => {
  await slowJobs(request);
  const A = mkDir("sa", ["SA-001.mp4", "SA-002.mp4"], true);
  const scanDir = join(tmpdir(), `javscribe-bpp-scan-${process.pid}-${Date.now()}`);
  rmSync(scanDir, { recursive: true, force: true });
  mkdirSync(scanDir, { recursive: true });
  copyFileSync(join(FIXTURES, "video-a.mp4"), join(scanDir, "SB-001.mp4"));
  copyFileSync(join(FIXTURES, "video-b.mkv"), join(scanDir, "SB-002.mkv"));
  try {
    await patchPick(app, A.items);
    await page.click("#pick-folder");
    await checkRow(page, "#folder-table", "SA-001.mp4");
    await checkRow(page, "#folder-table", "SA-002.mp4");
    await page.selectOption("#engine-select", "mock");
    await page.click("#dispatch-go");
    const rowA = page.locator(".job-batch-row", { hasText: basename(A.dir) });
    await expect(rowA).toHaveCount(1);
    // A1a：A 运行中 → 扫描另一路径 → 发新主任务
    await goView(page, "dispatch");
    await page.locator("#scan-path").fill(scanDir);
    await page.click("#scan-go");
    await expect(page.locator("#scan-table table")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#scan-count")).toContainText("已选 0 / 2"); // 过小手动勾
    await checkRow(page, "#scan-table", "SB-001.mp4");
    await checkRow(page, "#scan-table", "SB-002.mkv");
    await page.click("#scan-submit");
    await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/);
    const rowB = page.locator(".job-batch-row", { hasText: basename(scanDir) });
    await expect(rowA).toHaveCount(1);
    await expect(rowB).toHaveCount(1);
    await expect(rowB.locator(".batch-sub-n")).toHaveText("2 子任务");
    await waitBatchDone(rowA);
    await waitBatchDone(rowB);
  } finally {
    rmSync(A.dir, { recursive: true, force: true });
    rmSync(scanDir, { recursive: true, force: true });
  }
});

test("文件夹表本页全选：当前页 ∩ 可选项、取消只清当前页、半选态、全局全选口径不变", async ({ app, page }) => {
  await setMinSize0(page);
  const D = mkDir("pg", Array.from({ length: 12 }, (_, i) => `PG-${String(i + 1).padStart(3, "0")}.mp4`), false);
  try {
    await patchPick(app, D.items);
    await page.click("#pick-folder");
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 12 / 12"); // 无字幕且非过小 → 默认全勾
    await page.locator("#folder-select-all").uncheck(); // 清空起测
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 0 / 12");
    // 第 1 页（10 项）：本页全选 → 10 选中
    const pa = page.locator("#folder-page-all");
    await expect(pa).toBeEnabled();
    await pa.check();
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 10 / 12");
    // 半选态：清后手动勾 5 → indeterminate
    await pa.uncheck();
    for (let i = 1; i <= 5; i++) await checkRow(page, "#folder-table", `PG-00${i}.mp4`);
    await expect(pa).toHaveJSProperty("indeterminate", true);
    // 第 2 页（2 项）：本页全选 → 7 选中；取消 → 只清当前页 → 5 选中
    await page.locator("#fpg-next").click();
    await expect(page.locator("#folder-table tbody tr")).toHaveCount(2);
    await page.locator("#folder-page-all").check();
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 7 / 12");
    await page.locator("#folder-page-all").uncheck();
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 5 / 12");
    // 现有全局「全选」口径不变：勾 = 所有页可选项
    await page.locator("#folder-select-all").check();
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 12 / 12");
  } finally {
    rmSync(D.dir, { recursive: true, force: true });
  }
});

test("文件夹表本页全选：整页过小（无可选项）→ 禁用", async ({ app, page }) => {
  const D = mkDir("sm", ["SM-001.mp4", "SM-002.mp4", "SM-003.mp4"], true); // 默认 200MB → 全过小
  try {
    await patchPick(app, D.items);
    await page.click("#pick-folder");
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 0 / 3");
    await expect(page.locator("#folder-page-all")).toBeDisabled();
  } finally {
    rmSync(D.dir, { recursive: true, force: true });
  }
});

test("扫描表本页全选：当前页 ∩ 视图 ∩ 可选项、取消只清当前页、全局全选口径不变", async ({ page }) => {
  await setMinSize0(page);
  const dir = join(tmpdir(), `javscribe-bpp-scanpg-${process.pid}-${Date.now()}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 12; i++) {
    copyFileSync(join(FIXTURES, "video-a.mp4"), join(dir, `SP-${String(i).padStart(3, "0")}.mp4`));
  }
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
    // 第 2 页（2 项）：勾 1 → indeterminate；本页全选 → 12 选中（全局全选同步勾选态）
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
