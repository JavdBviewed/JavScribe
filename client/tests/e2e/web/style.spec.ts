// 样式类：整页 + 关键区块截图基线（像素 diff）
// 动态元素（时钟/更新时间/耗时/ETA/动画）由 freezeForShot 统一冻结
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import {
  waitForEngineOnline, waitForEngineKey, mockReset, mockSeed, mockPause, cleanEngines, freezeForShot, shot, triggerToast,
  addEngine, MOCK_KEY, FIXTURES, waitForJobsEmpty,
} from "../helpers";
import path from "node:path";

const fx = (n: string) => path.join(FIXTURES, n);

let req: APIRequestContext;
test.beforeEach(async ({ page, request }) => {
  req = request;
  await mockReset(request);
  await cleanEngines(request);
  await waitForJobsEmpty(request);
  await page.goto("/");
  await waitForEngineOnline(page);
  await waitForEngineKey(page, "mock");
});

test("整页空态（服务在线，无任务）", async ({ page }) => {
  await freezeForShot(page, req);
  await shot(page, "style-01-whole-empty", { fullPage: true });
});

test("服务卡片区块", async ({ page }) => {
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

test("流水线：本地提取引擎加载帧", async ({ page }) => {
  // 「加载提取引擎」帧是瞬态（wasm 有缓存 + 小文件 <1s 提完）：
  // route 对 core 请求永不响应（不 abort——abort 会触发 load 失败回退整片上传），加载帧被无限保持
  await page.route(/\/ffmpeg\/ffmpeg-core\.(js|wasm)/, () => {});
  await page.setInputFiles("#file", fx("video-a.mp4"));
  await page.selectOption("#engine-select", "mock");
  await page.click("#dispatch-go");
  await page.locator("#meta-upload", { hasText: "加载提取引擎" }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(300);
  await freezeForShot(page, req);
  await shot(page, "style-05-pipeline-loading", { element: "#pipeline" });
});

test("流水线：三步完成态", async ({ page }) => {
  await page.setInputFiles("#file", fx("video-a.mp4"));
  await page.selectOption("#engine-select", "mock");
  await page.click("#dispatch-go");
  // 完成信号：meta-dispatch 出现任务 id（dispatch-status 与之同时可见，不能 .or 双选）
  await expect(page.locator("#meta-dispatch", { hasText: /^任务 [\w-]+$/ })).toBeVisible({ timeout: 90_000 });
  await expect(page.locator("#step-dispatch.done")).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(200);
  await freezeForShot(page, req);
  await shot(page, "style-06-pipeline-done", { element: "#sec-dispatch" });
});

test("任务看板：进行中（扫光动画帧）", async ({ page }) => {
  await mockPause(req); // 先停：running 行不会在页面刷新前进成 done
  await mockSeed(req, { n: 1, status: "running", progress: 0.37 });
  await page.locator(".job-row.running").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(400);
  await freezeForShot(page, req);
  await shot(page, "style-07-jobs-running", { element: "#sec-jobs" });
});

test("任务看板：已完成 + 分页器", async ({ page }) => {
  await mockSeed(req, { n: 25, status: "done" });
  await page.click('#job-filter [data-f="finished"]');
  await expect(page.locator("#job-pager")).toBeVisible();
  await page.locator("#pg-next").click();
  await page.locator(".pg-info", { hasText: "第 2 / 2 页" }).waitFor();
  await page.waitForTimeout(200);
  await freezeForShot(page, req);
  await shot(page, "style-08-jobs-pager", { element: "#sec-jobs" });
});

test("设置弹窗：未登记 Key 表单", async ({ page }) => {
  await addEngine(req, { name: "nokey", url: "http://127.0.0.1:8301" });
  await page.locator('article.eng[data-name="nokey"] .icon-btn.set').waitFor({ timeout: 15_000 });
  await page.click('article.eng[data-name="nokey"] .icon-btn.set');
  await expect(page.locator("#key-input")).toBeVisible({ timeout: 5_000 });
  await page.locator("#key-input").fill("");
  await freezeForShot(page, req);
  await shot(page, "style-09-settings-keyless", { element: "#modal" });
});

test("设置弹窗：配置表单（8 组白名单）", async ({ page }) => {
  await page.click('article.eng .icon-btn.set');
  await expect(page.locator("#cfg-save")).toBeVisible({ timeout: 10_000 });
  // 展开弹窗内部滚动，整表单入帧
  await page.evaluate(() => { const b = document.getElementById("modal-body"); if (b) b.style.maxHeight = "none"; });
  await page.waitForTimeout(200);
  await freezeForShot(page, req);
  await shot(page, "style-10-settings-form", { fullPage: true });
});

test("扫描结果表（字幕标记行）", async ({ page }) => {
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
  await addEngine(req, { name: "offline-svc", url: "http://127.0.0.1:9999" });
  await page.locator('article.eng[data-name="offline-svc"] .eng-err').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(200);
  await freezeForShot(page, req);
  await shot(page, "style-13-offline-card", { element: "#sec-engines" });
});
