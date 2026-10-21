// 提交时刻按盘拆 batch（0.2.52 M1）桌面 e2e：
//  - 两顶层目录（Linux「盘」= 顶层段：/tmp + /home）→ 2 主任务行，label 各「顶层·目录名」，
//    子行各自聚合，暂停 fan-out 不跨组，独立走完
//  - #folder webkitdirectory 回退通道（CDP 注入跨两目录树真实文件）→ _localPath 桥
//    （webUtils.getPathForFile）解析成功 → 按顶层段拆 2 组
//  - 单目录回归：1 主任务行，label = 目录名（无盘符前缀），chip 无「· N 个目录」后缀
// 注入口径（e2e 受限下的两条通道，均走真实渲染层路径）：
//  1) 原生 multiSelections 对话框（GTK）headless 不可驱动 → 用例 1 用 app.evaluate 在
//     主进程 patch IPC pick-video-folder，返回 walkVideos 同构 items（rel 各自带本目录
//     根目录名 + 绝对路径 + too_small）；renderer 路径（pickVideoFolder→shimFile→
//     setFolder→分组）全真，main 侧 multiSelections+逐目录 walk 合并为 3 行直改+typecheck 覆盖
//  2) playwright setInputFiles 不支持多目录（"Multiple directories are not supported"）
//     → 用例 2 运行期移除 webkitdirectory + CDP DOM.setFileInputFiles 显式文件列表
//     （playwright-core 对 webkitdirectory 输入只处理首个目录，显式文件列表可跨树注入）
import { test, expect, mockSpeed, FIXTURES } from "./helpers";
import type { APIRequestContext } from "./helpers";
import type { Locator, Page } from "@playwright/test";
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

/** 8s/任务（与 interaction.spec 同口径）：保证暂停/完成观察窗 */
const slowJobs = (request: APIRequestContext) => mockSpeed(request, { step: 0.0125, tickMs: 100 });

/** walkVideos/PickFolderItem 同构（main 侧 IPC patch 返回形状） */
interface MdItem {
  path: string; name: string; size: number; rel: string;
  sub_status: "external" | "named" | "none";
  sub_name: string | null; sub_token: string | null; no_sub_token: string | null;
  too_small: boolean;
}
/** 拷夹具视频进目标目录，生成 PickFolderItem（72KB < 默认 200MB → too_small，与原生判定一致） */
const mkItem = (dir: string, name: string, src: string): MdItem => {
  const p = join(dir, name);
  copyFileSync(src, p);
  return {
    path: p, name, size: statSync(p).size,
    rel: `${basename(dir)}/${name}`,
    sub_status: "none", sub_name: null, sub_token: null, no_sub_token: null,
    too_small: true,
  };
};
const checkRows = async (page: Page, names: string[]): Promise<void> => {
  for (const name of names) {
    await page.locator("#folder-table tbody tr", { hasText: name }).locator("input[type=checkbox]").check();
  }
};
const waitBatchDone = (row: Locator): Promise<void> =>
  expect(row.locator(".pill")).toHaveText("完成", { timeout: 90_000 });

test("两顶层目录（两盘）→ 2 主任务行：label 顶层·目录名、子行各自聚合、暂停不跨组", async ({ app, page, request }) => {
  await slowJobs(request);
  // 两个「盘」：/tmp（用例 A 2 文件）+ /home（用例 B 1 文件）
  const dirA = mkdtempSync(join(tmpdir(), "javscribe-e2e-md-a-"));
  const dirB = mkdtempSync(join(homedir(), "javscribe-e2e-md-b-"));
  const baseA = basename(dirA);
  const baseB = basename(dirB);
  try {
    const its: MdItem[] = [
      mkItem(dirA, "A-001.mp4", join(FIXTURES, "video-a.mp4")),
      mkItem(dirA, "A-002.mkv", join(FIXTURES, "video-b.mkv")),
      mkItem(dirB, "B-001.mp4", join(FIXTURES, "video-a.mp4")),
    ];
    // 模拟原生 multiSelections 对话框输出（patch 主进程 IPC；首参 = require('electron') 模块）
    await app.evaluate((el: any, items: MdItem[]) => {
      el.ipcMain.removeHandler("pick-video-folder");
      el.ipcMain.handle("pick-video-folder", () => items);
    }, its);
    await page.click("#pick-folder");
    // chip：默认 0 勾选（过小）+「· 2 个目录」（rel 首段 = 各自根目录名）
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 0 / 3 · 2 个目录");
    await checkRows(page, ["A-001.mp4", "A-002.mkv", "B-001.mp4"]);
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 3 / 3 · 2 个目录");
    await page.selectOption("#engine-select", "mock");
    await expect(page.locator("#dispatch-go")).toContainText("（3 项）");
    await page.click("#dispatch-go");
    // 提交即进任务看板：2 主任务行，label 各「顶层·目录名」（Linux 顶层段 = /tmp、/home）
    await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/);
    await expect(page.locator(".job-batch-row")).toHaveCount(2);
    const rowA = page.locator(".job-batch-row", { hasText: `/tmp·${baseA}` });
    const rowB = page.locator(".job-batch-row", { hasText: `/home·${baseB}` });
    await expect(rowA).toHaveCount(1);
    await expect(rowB).toHaveCount(1);
    await expect(rowA.locator(".batch-sub-n")).toHaveText("2 子任务");
    await expect(rowB.locator(".batch-sub-n")).toHaveText("1 子任务");
    // 暂停组 A：fan-out 仅作用于 A（batchQueues 按 batch.id），B 不受影响
    await rowA.locator('[data-bact="pause"]').click();
    await expect(rowA.locator(".pill")).toHaveText("已暂停", { timeout: 10_000 });
    await expect(rowB.locator(".pill")).not.toHaveText("已暂停");
    // 立即继续 A（两泵并行推进，避免终态竞态），两组各自走完
    await rowA.locator('[data-bact="resume"]').click();
    await waitBatchDone(rowB);
    await waitBatchDone(rowA);
    for (const name of ["A-001.mp4", "A-002.mkv", "B-001.mp4"]) {
      const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: name }) });
      await expect(row).toHaveCount(1);
      await expect(row.locator(".pill.p-done")).toBeVisible({ timeout: 30_000 });
    }
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("#folder 回退通道多顶层目录：CDP 跨树注入 → _localPath 桥 → 2 组", async ({ page, request }) => {
  await slowJobs(request);
  const dirA = mkdtempSync(join(tmpdir(), "javscribe-e2e-mdf-a-"));
  const dirB = mkdtempSync(join(homedir(), "javscribe-e2e-mdf-b-"));
  const baseA = basename(dirA);
  const baseB = basename(dirB);
  try {
    const fA1 = join(dirA, "A-001.mp4");
    const fA2 = join(dirA, "A-002.mkv");
    const fB1 = join(dirB, "B-001.mp4");
    copyFileSync(join(FIXTURES, "video-a.mp4"), fA1);
    copyFileSync(join(FIXTURES, "video-b.mkv"), fA2);
    copyFileSync(join(FIXTURES, "video-a.mp4"), fB1);
    // playwright setInputFiles 不支持多目录 → 运行期移除 webkitdirectory + CDP 显式文件列表；
    // webkitdirectory 在场时 multiple 为隐含语义，移除后须补显式 multiple，否则退化为单文件 input
    // （setFileInputFiles 仅保留首个文件）
    await page.$eval("#folder", (el) => {
      el.removeAttribute("webkitdirectory");
      el.setAttribute("multiple", "");
    });
    const cdp = await page.context().newCDPSession(page);
    const doc = (await cdp.send("DOM.getDocument")) as { root?: { nodeId: number }; document?: { nodeId: number } };
    const q = (await cdp.send("DOM.querySelector", {
      nodeId: (doc.root || doc.document)!.nodeId, selector: "#folder",
    })) as { nodeId: number };
    await cdp.send("DOM.setFileInputFiles", { nodeId: q.nodeId, files: [fA1, fA2, fB1] });
    // rel 空（普通输入）→ chip 无「· N 个目录」后缀；过小默认 0 勾选
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 0 / 3");
    await checkRows(page, ["A-001.mp4", "A-002.mkv", "B-001.mp4"]);
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 3 / 3");
    // _localPath 桥（javDesktop.filePath = webUtils.getPathForFile）：3 文件全部解析出真实路径
    const lps = await page.evaluate(() =>
      ((window as unknown as { state: { folderFiles: Array<{ file: { _localPath?: string } }> } }).state.folderFiles
        .map((v) => v.file._localPath || "")),
    );
    expect(lps).toHaveLength(3);
    expect(lps.filter((p) => p.startsWith("/tmp/"))).toHaveLength(2);
    expect(lps.filter((p) => p.startsWith("/home/"))).toHaveLength(1);
    await page.selectOption("#engine-select", "mock");
    await page.click("#dispatch-go");
    await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/);
    // 按顶层段拆 2 组：label = 顶层·目录名（rel 空 → 目录名取 _localPath 父目录名）
    await expect(page.locator(".job-batch-row")).toHaveCount(2);
    const rowA = page.locator(".job-batch-row", { hasText: `/tmp·${baseA}` });
    const rowB = page.locator(".job-batch-row", { hasText: `/home·${baseB}` });
    await expect(rowA.locator(".batch-sub-n")).toHaveText("2 子任务");
    await expect(rowB.locator(".batch-sub-n")).toHaveText("1 子任务");
    await waitBatchDone(rowA);
    await waitBatchDone(rowB);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("单目录回归：1 主任务行、label = 目录名（无盘符前缀）、chip 无目录后缀", async ({ page, request }) => {
  await slowJobs(request);
  const dirC = mkdtempSync(join(tmpdir(), "javscribe-e2e-mdf-c-"));
  const baseC = basename(dirC);
  try {
    const fC1 = join(dirC, "C-001.mp4");
    const fC2 = join(dirC, "C-002.mkv");
    copyFileSync(join(FIXTURES, "video-a.mp4"), fC1);
    copyFileSync(join(FIXTURES, "video-b.mkv"), fC2);
    // 单目录走 playwright setInputFiles 原生范式（webkitdirectory 传目录，rel 自动带目录名）
    await page.setInputFiles("#folder", dirC);
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 0 / 2");
    await checkRows(page, ["C-001.mp4", "C-002.mkv"]);
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 2 / 2");
    await page.selectOption("#engine-select", "mock");
    await expect(page.locator("#dispatch-go")).toContainText("（2 项）");
    await page.click("#dispatch-go");
    await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/);
    // 单组：1 主任务行，label = 目录名原样（零噪音，不加顶层段前缀）
    await expect(page.locator(".job-batch-row")).toHaveCount(1);
    const rowC = page.locator(".job-batch-row");
    await expect(rowC.locator(".job-name .fn")).toHaveText(baseC);
    await expect(rowC.locator(".batch-sub-n")).toHaveText("2 子任务");
    await expect(page.locator(".job-row")).toHaveCount(2);
    await waitBatchDone(rowC);
    for (const name of ["C-001.mp4", "C-002.mkv"]) {
      const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: name }) });
      await expect(row.locator(".pill.p-done")).toBeVisible({ timeout: 30_000 });
    }
  } finally {
    rmSync(dirC, { recursive: true, force: true });
  }
});
