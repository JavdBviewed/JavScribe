// 交互类：完整用户流（单文件三步动画→完成→看板→下载；整片上传回退；文件夹批量；扫描全流程；Windows 拦截；筛选×分页；retry；autosave 降级下载；小飞机跳转；删除服务）
import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  waitForEngineOnline, waitForEngineKey, mockReset, mockSeed, mockSpeed, cleanEngines, addEngine, MOCK_KEY, FIXTURES,
  waitForJobsEmpty,
} from "../helpers";
import path from "node:path";
import { readFileSync } from "node:fs";

const fx = (n: string) => path.join(FIXTURES, n);
const readText = (p: string) => readFileSync(p, "utf-8");

let req: APIRequestContext;
test.beforeEach(async ({ page, request }) => {
  req = request;
  await mockReset(request);
  await cleanEngines(request);
  await waitForJobsEmpty(request);
  // 8s/任务：保证页面 5s 轮询能观察到 running→done（autosave 写回、看板 running 态都依赖此迁移）
  await mockSpeed(request, { step: 0.0125, tickMs: 100 });
  await page.goto("/");
  await waitForEngineOnline(page);
  await waitForEngineKey(page, "mock");
});

test("单文件本地提音轨全流程：chip → 三步动画 → 完成 → 看板 → 下载 srt", async ({ page }) => {
  // 1. 选文件 → chip
  await page.setInputFiles("#file", fx("video-a.mp4"));
  await expect(page.locator("#chip-name")).toHaveText("video-a.mp4");
  await expect(page.locator("#file-chip")).toBeVisible();
  await expect(page.locator("#dispatch-go")).toBeEnabled();

  // 2. 开始 → 本地提音轨（wasm）
  await page.selectOption("#engine-select", "mock");
  await page.click("#dispatch-go");
  await expect(page.locator("#step-upload .step-name")).toHaveText("本地提音轨");
  await expect(page.locator("#step-extract .step-name")).toHaveText("上传音频");
  // 「浏览器本地提取 · N%」是瞬态（小文件 <1s 提完，轮询抓不到），只断言终态
  await expect(page.locator("#step-upload.done")).toBeVisible({ timeout: 90_000 });
  await expect(page.locator("#meta-upload", { hasText: /本地提取完成 · 音频 \d+ MB/ })).toBeVisible();
  await expect(page.locator("#line-1.on")).toHaveCount(1);

  // 3. 音频上传 + 提交（「上传音频 X / Y MB」也是瞬态，断言终态）
  await expect(page.locator("#step-extract.done")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#step-dispatch.done")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#meta-dispatch", { hasText: /^任务 [\w-]+$/ })).toBeVisible();
  await expect(page.locator("#dispatch-status.ok")).toBeVisible();
  await expect(page.locator("#toasts .toast.ok").first()).toBeVisible();

  // 4. 看板出现 running 行（标题带运行数）→ 完成
  const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: "video-a.mp4" }) });
  await expect(row.locator(".pill.p-running")).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveTitle(/\(1\) JavScribe 字幕工作台/);
  await expect(row.locator(".pill.p-done")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#toasts .toast.ok", { hasText: "完成" }).first()).toBeVisible();

  // 5. 行内下载 srt
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    row.locator(".job-actions a.dl-btn").click(),
  ]);
  const p = path.join(test.info().outputDir, "dl.srt");
  await dl.saveAs(p);
  expect(readText(p)).toContain("テスト字幕 video-a.mp4");
});

test("整片上传回退路径（extract-select=server）：上传视频→提取音频→提交", async ({ page }) => {
  await page.selectOption("#extract-select", "server");
  await page.setInputFiles("#file", fx("video-a.mp4"));
  await page.selectOption("#engine-select", "mock");
  await page.click("#dispatch-go");
  await expect(page.locator("#step-upload .step-name")).toHaveText("上传视频");
  await expect(page.locator("#step-extract .step-name")).toHaveText("提取音频");
  await expect(page.locator("#step-upload.done")).toBeVisible({ timeout: 60_000 });
  // 「提取音频中 · N%」是瞬态（服务端 ffmpeg 对 72KB 文件秒级完成），断言终态
  await expect(page.locator("#step-extract.done")).toBeVisible({ timeout: 90_000 });
  await expect(page.locator("#step-dispatch.done")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#dispatch-status.ok")).toBeVisible();
});

test("文件夹批量：chip 文案 → 顺序流水线 1/2 → 批量完成（有字幕跳过）", async ({ page }) => {
  await page.setInputFiles("#folder", FIXTURES); // webkitdirectory：传目录，相对路径自动带上
  await expect(page.locator("#folder-chip-text")).toHaveText("3 个视频（1 个已有字幕，将跳过）");
  await page.selectOption("#engine-select", "mock");
  await expect(page.locator("#dispatch-go")).toContainText("（2 项）");
  await page.click("#dispatch-go");
  await expect(page.locator("#meta-upload", { hasText: "文件 1/2 ·" })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#meta-upload", { hasText: "文件 2/2 ·" })).toBeVisible({ timeout: 120_000 });
  await expect(page.locator("#dispatch-status.ok", { hasText: "批量完成：已提交 2/2 项" })).toBeVisible({ timeout: 120_000 });
  // 两条任务行；video-c（有字幕）不上传
  await expect(page.locator(".job-row .fn", { hasText: "video-a.mp4" })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".job-row .fn", { hasText: "video-b.mkv" })).toBeVisible();
  expect(await page.locator(".job-row .fn", { hasText: "video-c.mp4" }).count()).toBe(0);
});

test("文件夹 chip 移除后派单禁用", async ({ page }) => {
  await page.setInputFiles("#folder", FIXTURES);
  await expect(page.locator("#folder-chip")).toBeVisible();
  await page.click("#folder-x");
  await expect(page.locator("#folder-chip")).toBeHidden();
  await expect(page.locator("#dispatch-go")).toBeDisabled();
});

test("扫描全流程：/media/jav → 默认勾选无字幕 → 全选 → 提交入队", async ({ page }) => {
  await page.locator("#scan-path").fill("/media/jav");
  await expect(page.locator("#scan-go")).toBeEnabled();
  await page.click("#scan-go");
  await expect(page.locator("#scan-table table")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".scan-name")).toHaveCount(3);
  await expect(page.locator(".has-sub .subtag")).toHaveText("AKDL-002.zh.srt");
  await expect(page.locator("#scan-count")).toHaveText("已选 2 / 3 · 已有字幕的默认不勾选");
  await expect(page.locator("#scan-submit")).toContainText("开始生成（2 项）");
  await page.locator("#scan-select-all").check();
  await expect(page.locator("#scan-count")).toHaveText("已选 3 / 3 · 已有字幕的默认不勾选");
  const [toast] = await Promise.all([
    page.waitForSelector("#toasts .toast.ok", { state: "visible" }),
    page.click("#scan-submit"),
  ]);
  expect(await toast.textContent()).toContain("已入队 3 项");
  await expect(page.locator("#scan-results")).toBeHidden();
  await expect(page.locator(".job-row .sub", { hasText: "文件夹扫描 · 3 项" })).toHaveCount(3, { timeout: 15_000 });
});

test("扫描：Windows 路径客户端拦截（toast 引导用选择文件夹）", async ({ page }) => {
  await page.locator("#scan-path").fill("D:\\Videos");
  await page.click("#scan-go");
  const t = page.locator("#toasts .toast.err");
  await expect(t).toBeVisible({ timeout: 5_000 });
  expect(await t.textContent()).toContain("这是 Windows 本地路径");
  expect(await t.textContent()).toContain("选择文件夹");
  await expect(page.locator("#scan-results")).toBeHidden();
});

test("筛选 × 分页：25 条已完成 → 2 页 → 翻页重渲染", async ({ page }) => {
  await mockSeed(req, { n: 25, status: "done" });
  // /api/jobs 按 created 降序（最新在前），mock 按 60s 间隔赋 created：
  // 第 1 页 = seed-006..025（20 行），第 2 页 = seed-001..005（5 行）
  await page.locator('.job-row .fn', { hasText: "seed-025.mp4" }).waitFor({ timeout: 15_000 });
  await page.click('#job-filter [data-f="finished"]');
  await expect(page.locator(".pg-info")).toHaveText("第 1 / 2 页 · 共 25 条");
  await expect(page.locator("#job-list .job-row")).toHaveCount(20);
  // 页 1 的末行边界：最老的一条（seed-006）仍在页 1
  await expect(page.locator('.job-row .fn', { hasText: "seed-006.mp4" })).toBeVisible();
  await page.click("#pg-next");
  await expect(page.locator(".pg-info")).toHaveText("第 2 / 2 页 · 共 25 条");
  await expect(page.locator("#job-list .job-row")).toHaveCount(5);
  await expect(page.locator('.job-row .fn', { hasText: "seed-001.mp4" })).toBeVisible();
  await expect(page.locator("#pg-next")).toBeDisabled();
  await page.click('#job-filter [data-f="running"]');
  await expect(page.locator("#jobs-empty")).toBeVisible();
  await expect(page.locator("#jobs-empty-text")).toHaveText("当前筛选下无任务");
});

test("retry 按钮：跳过行 → 重新提交 → 新任务入列", async ({ page }) => {
  await mockSeed(req, { n: 1, status: "skipped", skipped: 1 });
  const row = page.locator(".job-row", { has: page.locator(".retry") });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.locator(".pill")).toHaveText("跳过");
  const [toast] = await Promise.all([
    page.waitForSelector("#toasts .toast.ok", { state: "visible" }),
    row.locator(".retry").click(),
  ]);
  expect(await toast.textContent()).toContain("已删旧字幕并重新提交");
  await expect(page.locator(".retried-note").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".job-row.running").first()).toBeVisible({ timeout: 15_000 });
});

test("autosave 开启 + 无目录句柄 → 完成自动下载 srt", async ({ page }) => {
  await page.locator("#autosave").check();
  await page.setInputFiles("#file", fx("video-a.mp4"));
  await page.selectOption("#engine-select", "mock");
  const dlP = page.waitForEvent("download", { timeout: 120_000 });
  await page.click("#dispatch-go");
  const dl = await dlP;
  expect(dl.suggestedFilename()).toBe("video-a.zh.srt");
  const p = path.join(test.info().outputDir, "autosave.srt");
  await dl.saveAs(p);
  expect(readText(p)).toContain("テスト字幕 video-a.mp4");
  await expect(page.locator("#toasts .toast", { hasText: "已自动下载" }).first()).toBeVisible();
});

test("小飞机跳转：新标签打开服务地址（地址本身非超链接）", async ({ page, context }) => {
  const [np] = await Promise.all([
    context.waitForEvent("page", { timeout: 10_000 }),
    page.locator('.eng[data-name="mock"] .eng-go').click(),
  ]);
  expect(np.url()).toContain("127.0.0.1:8301");
  await np.close();
});

test("删除服务：confirm → 卡片移除", async ({ page }) => {
  await addEngine(req, { name: "del-me", url: "http://127.0.0.1:8301" });
  await page.locator('article.eng[data-name="del-me"] h3', { hasText: "del-me" }).waitFor({ timeout: 10_000 });
  page.on("dialog", (d) => d.accept());
  await page.click('article.eng[data-name="del-me"] .del');
  await expect(page.locator('article.eng[data-name="del-me"]')).toHaveCount(0, { timeout: 10_000 });
  expect(await page.locator("article.eng").count()).toBe(1);
});
