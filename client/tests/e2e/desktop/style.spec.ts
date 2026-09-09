// 桌面端样式类：整页 + 关键区块截图基线（像素 diff）
// 动态元素（时钟/更新时间/耗时/ETA/动画）由 freezeForShot 统一冻结
// 帧 05「上传音频中」：本机 ffmpeg 提取仅 ~57ms 抓不到，用 mock 的 upload-delay（3s）稳定保持上传帧
import { test, expect, goView, type APIRequestContext } from "./helpers";
import {
  mockPause, mockSeed, mockUploadDelay, freezeForShot, shot, triggerToast,
  MOCK, FIXTURES,
} from "./helpers";
import { join } from "node:path";

const fx = (n: string) => join(FIXTURES, n);

let req: APIRequestContext;
test.beforeEach(async ({ request }) => {
  req = request;
  // mock 状态已由 userData fixture 的 mockReset 清零
});

test("整页空态（服务在线，无任务）", async ({ page }) => {
  await freezeForShot(page, req);
  await shot(page, "style-01-whole-empty", { fullPage: true });
});

test("服务卡片区块", async ({ page }) => {
  await goView(page, "engines");
  await freezeForShot(page, req);
  await shot(page, "style-02-engine-card", { element: "#sec-engines" });
});

test("单文件 chip 选中态", async ({ page }) => {
  await page.setInputFiles("#file", fx("video-a.mp4"));
  await expect(page.locator("#file-chip")).toBeVisible();
  await freezeForShot(page, req);
  await shot(page, "style-03-file-chip", { element: "#sec-dispatch" });
});

test("文件夹 chip（N 视频 M 已有字幕）", async ({ page }) => {
  await page.setInputFiles("#folder", FIXTURES); // webkitdirectory：传目录
  await expect(page.locator("#folder-chip-text")).toHaveText("3 个视频（1 个已有字幕，将跳过）");
  await freezeForShot(page, req);
  await shot(page, "style-04-folder-chip", { element: "#sec-dispatch" });
});

test("流水线：上传音频中（mock upload-delay 保持 3s 窗口）", async ({ page }) => {
  await mockUploadDelay(req, 3000);
  try {
    await page.setInputFiles("#file", fx("video-a.mp4"));
    await page.selectOption("#engine-select", "mock");
    await page.click("#dispatch-go");
    // 本机提取 ~57ms 完成 → 上传帧由 mock 延迟应答稳定保持
    await page.locator("#meta-extract", { hasText: "上传音频" }).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(200);
    await freezeForShot(page, req);
    await shot(page, "style-05-pipeline-uploading", { element: "#pipeline" });
  } finally {
    await mockUploadDelay(req, 0);
  }
});

test("流水线：三步完成态", async ({ page }) => {
  await page.setInputFiles("#file", fx("video-a.mp4"));
  await page.selectOption("#engine-select", "mock");
  await page.click("#dispatch-go");
  // 完成信号：meta-dispatch 出现任务 id（与 step-dispatch.done 同时可见，不能 .or 双选）
  await expect(page.locator("#meta-dispatch", { hasText: /^任务 [\w-]+$/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#step-dispatch.done")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(200);
  await freezeForShot(page, req);
  await shot(page, "style-06-pipeline-done", { element: "#sec-dispatch" });
});

test("任务看板：进行中（扫光动画帧）", async ({ page }) => {
  await mockPause(req); // 先停：running 行不会在页面刷新前进成 done
  await mockSeed(req, { n: 1, status: "running", progress: 0.37 });
  await goView(page, "jobs");
  await page.locator(".job-row.running").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(400);
  await freezeForShot(page, req);
  await shot(page, "style-07-jobs-running", { element: "#sec-jobs" });
});

test("任务看板：已完成 + 分页器", async ({ page }) => {
  await mockSeed(req, { n: 25, status: "done" });
  await goView(page, "jobs");
  await page.click('#job-filter [data-f="finished"]');
  await expect(page.locator("#job-pager")).toBeVisible();
  await page.locator("#pg-next").click();
  await page.locator(".pg-info", { hasText: "第 2 / 2 页" }).waitFor();
  await page.waitForTimeout(200);
  await freezeForShot(page, req);
  await shot(page, "style-08-jobs-pager", { element: "#sec-jobs" });
});

test("设置弹窗：未登记 Key 表单", async ({ page }) => {
  const r = await page.evaluate(async (url) => {
    const res = await (window as any).javDesktop.call("addEngine", ["nokey", url, ""]);
    return res;
  }, MOCK);
  expect(r.ok).toBe(true);
  await goView(page, "engines");
  await page.locator('article.eng[data-name="nokey"] .icon-btn.set').waitFor({ timeout: 15_000 });
  await page.click('article.eng[data-name="nokey"] .icon-btn.set');
  await expect(page.locator("#key-input")).toBeVisible({ timeout: 5_000 });
  await freezeForShot(page, req);
  await shot(page, "style-09-settings-keyless", { element: "#modal" });
});

test("设置弹窗：配置表单（白名单全组）", async ({ page }) => {
  await goView(page, "engines");
  await page.click('article.eng[data-name="mock"] .icon-btn.set');
  await expect(page.locator("#cfg-save")).toBeVisible({ timeout: 10_000 });
  // 展开弹窗内部滚动，整表单入帧
  await page.evaluate(() => { const b = document.getElementById("modal-body"); if (b) b.style.maxHeight = "none"; });
  await page.waitForTimeout(200);
  await freezeForShot(page, req);
  await shot(page, "style-10-settings-form", { fullPage: true });
});

test("扫描结果表（字幕标记行）", async ({ page }) => {
  await page.selectOption("#engine-select", "mock");
  await page.locator("#scan-path").fill("/media/jav");
  await page.click("#scan-go");
  await expect(page.locator("#scan-table table")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#scan-submit")).toBeVisible();
  await page.waitForTimeout(200);
  await freezeForShot(page, req);
  await shot(page, "style-11-scan-results", { element: "#scan-panel" });
});

test("toast 三种态", async ({ page }) => {
  await triggerToast(page, "操作成功提示", "ok");
  await triggerToast(page, "操作失败提示", "err");
  await triggerToast(page, "普通状态提示");
  await page.waitForTimeout(150);
  await freezeForShot(page, req);
  await shot(page, "style-12-toasts", { element: "#toasts" });
});

test("离线服务卡片（eng-err）", async ({ page }) => {
  const r = await page.evaluate(async (url) => {
    const res = await (window as any).javDesktop.call("addEngine", ["offline-svc", url, ""]);
    return res;
  }, "http://127.0.0.1:9999");
  expect(r.ok).toBe(true);
  await goView(page, "engines");
  await page.locator('article.eng[data-name="offline-svc"] .eng-err').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(200);
  await freezeForShot(page, req);
  await shot(page, "style-13-offline-card", { element: "#sec-engines" });
});
