// 桌面端交互类：完整用户流（单文件本机提取三步动画、写回落盘 IPC、整片直传、文件夹批量、
// Key 登记 UI、localStorage 持久化、retry、筛选×分页、扫描全流程、Windows 拦截、删除服务、小飞机二窗口）
// 注意：autosave 的「自动下载」兜底走原生保存对话框，e2e 无法驱动，不覆盖；
//       写回链路由 writeSrt IPC 用例在进程级覆盖（同一条 IPC 通路）。
import { test, expect, goView, mockSpeed, mockSeed, mockReset, launchApp, relaunch, waitForReady, waitForEngineKey,
  waitForMockJobFinished, MOCK, MOCK_KEY, FIXTURES } from "./helpers";
import type { APIRequestContext } from "./helpers";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const fx = (n: string) => join(FIXTURES, n);

/** 8s/任务：test 体内调用（userData fixture 的 mockReset 之后），保证 5s 轮询观察到 running→done */
const slowJobs = (request: APIRequestContext) => mockSpeed(request, { step: 0.0125, tickMs: 100 });

test("单文件全流程（auto→本机提取）：chip → 三步动画 → 看板 → 完成 toast", async ({ page, request }) => {
  await slowJobs(request);
  await page.setInputFiles("#file", fx("video-a.mp4"));
  await expect(page.locator("#chip-name")).toHaveText("video-a.mp4");
  await page.locator("#file-chip").waitFor();
  await page.selectOption("#engine-select", "mock");
  await page.click("#dispatch-go");

  // 桌面端 fits 恒 true → auto 恒走本机提取（桌面核心语义）
  await expect(page.locator("#step-upload .step-name")).toHaveText("本地提音轨");
  await expect(page.locator("#step-extract .step-name")).toHaveText("上传音频");
  await expect(page.locator("#step-upload.done")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#meta-upload", { hasText: /本地提取完成 · 音频 \d+ MB/ })).toBeVisible();
  await expect(page.locator("#step-extract.done")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#step-dispatch.done")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#meta-dispatch", { hasText: /^任务 [\w-]+$/ })).toBeVisible();
  await expect(page.locator("#dispatch-status.ok")).toBeVisible();

  await goView(page, "jobs");
  const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: "video-a.mp4" }) });
  await expect(row.locator(".pill.p-running")).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveTitle(/\(1\) JavScribe Client/);
  await expect(row.locator(".pill.p-done")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#toasts .toast.ok", { hasText: "完成" }).first()).toBeVisible();
  // 行内下载按钮存在（桌面端拦截 → 原生保存对话框，e2e 不点击，只断言存在）
  await expect(row.locator(".job-actions a.dl-btn")).toHaveCount(1);
});

test("写回落盘：getResultData → writeSrt IPC → srt 内容断言", async ({ page, request }) => {
  await page.setInputFiles("#file", fx("video-a.mp4"));
  await page.selectOption("#engine-select", "mock");
  await page.click("#dispatch-go");
  await expect(page.locator("#meta-dispatch", { hasText: /^任务 [\w-]+$/ })).toBeVisible({ timeout: 30_000 });
  const meta = (await page.locator("#meta-dispatch").textContent()) || "";
  const jid = (meta.match(/任务 (\S+)/) || [])[1];
  expect(jid).toBeTruthy();
  // 等 mock 侧真正 finished（result 才可下载）
  await waitForMockJobFinished(request, jid!, 30_000);

  const outDir = test.info().outputDir;
  const r = await page.evaluate(async (a) => {
    const [engine, jobId, videoPath, srtName] = a as [string, string, string, string];
    const r1 = await (window as any).javDesktop.call("getResultData", [engine, jobId]);
    if (!r1.ok) return { ok: false, error: r1.error };
    const r2 = await (window as any).javDesktop.writeSrt(videoPath, srtName, r1.data);
    return { ok: r2.ok, path: r2.path, error: r2.error, bytes: r1.data && r1.data.length };
  }, ["mock", jid!, join(outDir, "video-a.mp4"), "video-a.zh.srt"]);
  expect(r.ok).toBe(true);
  expect(r.path).toBe(join(outDir, "video-a.zh.srt"));
  expect(r.bytes).toBeGreaterThan(0);
  const text = readFileSync(join(outDir, "video-a.zh.srt"), "utf-8");
  expect(text).toContain("テスト字幕 video-a.mp4");
});

test("整片直传（extract-select=server 逃生通道）：上传视频→提取音频→提交", async ({ page }) => {
  await page.selectOption("#extract-select", "server");
  await page.setInputFiles("#file", fx("video-a.mp4"));
  await page.selectOption("#engine-select", "mock");
  await page.click("#dispatch-go");
  await expect(page.locator("#step-upload .step-name")).toHaveText("上传视频");
  await expect(page.locator("#step-extract .step-name")).toHaveText("提取音频");
  await expect(page.locator("#step-upload.done")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#step-extract.done")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#step-dispatch.done")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#dispatch-status.ok")).toBeVisible();
});

test("文件夹批量：chip →（2 项）→ 批量完成 toast → 两行看板完成", async ({ page, request }) => {
  await slowJobs(request);
  await page.setInputFiles("#folder", FIXTURES); // webkitdirectory：传目录，相对路径自动带上
  await expect(page.locator("#folder-chip-text")).toHaveText("3 个视频（1 个已有字幕，将跳过）");
  await page.selectOption("#engine-select", "mock");
  await expect(page.locator("#dispatch-go")).toContainText("（2 项）");
  await page.click("#dispatch-go");
  await expect(page.locator("#dispatch-status.ok", { hasText: /批量完成：已提交 2\/2 项/ })).toBeVisible({ timeout: 30_000 });
  await goView(page, "jobs");
  for (const name of ["video-a.mp4", "video-b.mkv"]) {
    const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: name }) });
    await expect(row.locator(".pill.p-done")).toBeVisible({ timeout: 30_000 });
  }
});

test("Key 登记 UI 流程（无预置 key）：设置弹窗 → 保存 → engines.json 落盘 → 自动转配置表单", async ({ request }) => {
  await mockReset(request);
  const dir = mkdtempSync(join(tmpdir(), "javscribe-e2e-keyless-"));
  const app = await launchApp(dir); // 无 engines.json：仅 env 预置的 mock 引擎（无 key）
  try {
    const page = await app.firstWindow();
    await waitForReady(page);
    await goView(page, "engines");
    await page.locator('article.eng[data-name="mock"] .icon-btn.set').click();
    await expect(page.locator(".set-note")).toHaveText(/还没有登记 API Key/, { timeout: 10_000 });
    await expect(page.locator("#key-input")).toBeVisible();
    await page.locator("#key-input").fill(MOCK_KEY);
    const [toast] = await Promise.all([
      page.waitForSelector("#toasts .toast.ok", { state: "visible" }),
      page.click("#key-form button[type=submit]"),
    ]);
    expect(await toast.textContent()).toContain("API Key 已保存");
    await waitForEngineKey(page);
    // 保存后 modal 自动重开为配置表单
    await expect(page.locator("#cfg-save")).toBeVisible({ timeout: 15_000 });
    // Key 落盘 engines.json
    const cfg = JSON.parse(readFileSync(join(dir, "engines.json"), "utf-8")) as {
      engines: Array<{ name: string; api_key: string }>;
    };
    const mockE = cfg.engines.find((e) => e.name === "mock");
    expect(mockE && mockE.api_key).toBe(MOCK_KEY);
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("localStorage 持久化：autosave + 提取模式 + 所选服务重启保留", async ({ app, userData, page }) => {
  await page.locator("#autosave").check();
  await page.selectOption("#extract-select", "server");
  await page.selectOption("#engine-select", "mock");
  await app.close();
  const r = await relaunch(userData);
  try {
    await expect(r.page.locator("#autosave")).toBeChecked();
    const extractVal = await r.page.locator("#extract-select").evaluate((e) => (e as HTMLSelectElement).value);
    expect(extractVal).toBe("server");
    const engineVal = await r.page.locator("#engine-select").evaluate((e) => (e as HTMLSelectElement).value);
    expect(engineVal).toBe("mock");
  } finally {
    await r.app.close().catch(() => {});
  }
});

test("retry：跳过行 → 重新提交 → 新任务入列 running", async ({ page, request }) => {
  await slowJobs(request);
  await mockSeed(request, { n: 1, status: "skipped", skipped: 1 });
  await goView(page, "jobs");
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

test("筛选 × 分页：25 条已完成 → 2 页 → 翻页边界", async ({ page, request }) => {
  await mockSeed(request, { n: 25, status: "done" });
  await goView(page, "jobs");
  // created 降序（最新在前）：第 1 页 = seed-006..025（20 行），第 2 页 = seed-001..005（5 行）
  await page.locator(".job-row .fn", { hasText: "seed-025.mp4" }).waitFor({ timeout: 15_000 });
  await page.click('#job-filter [data-f="finished"]');
  await expect(page.locator(".pg-info")).toHaveText("第 1 / 2 页 · 共 25 条");
  await expect(page.locator("#job-list .job-row")).toHaveCount(20);
  await expect(page.locator(".job-row .fn", { hasText: "seed-006.mp4" })).toBeVisible();
  await page.click("#pg-next");
  await expect(page.locator(".pg-info")).toHaveText("第 2 / 2 页 · 共 25 条");
  await expect(page.locator("#job-list .job-row")).toHaveCount(5);
  await expect(page.locator(".job-row .fn", { hasText: "seed-001.mp4" })).toBeVisible();
  await expect(page.locator("#pg-next")).toBeDisabled();
  await page.click('#job-filter [data-f="running"]');
  await expect(page.locator("#jobs-empty")).toBeVisible();
  await expect(page.locator("#jobs-empty-text")).toHaveText("当前筛选下无任务");
});

test("扫描全流程：3 项（1 有字幕）→ 全选 → 入队 3 项 → 看板 3 行", async ({ page }) => {
  await page.selectOption("#engine-select", "mock");
  await page.locator("#scan-path").fill("/media/jav");
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
  await page.selectOption("#engine-select", "mock");
  await page.locator("#scan-path").fill("D:\\Videos");
  await page.click("#scan-go");
  const t = page.locator("#toasts .toast.err");
  await expect(t).toBeVisible({ timeout: 5_000 });
  expect(await t.textContent()).toContain("这是 Windows 本地路径");
  expect(await t.textContent()).toContain("选择文件夹");
  await expect(page.locator("#scan-results")).toBeHidden();
});

test("删除服务：confirm → 卡片移除", async ({ page }) => {
  const r = await page.evaluate(async (url) => {
    const res = await (window as any).javDesktop.call("addEngine", ["del-me", url, ""]);
    return res;
  }, MOCK);
  expect(r.ok).toBe(true);
  await goView(page, "engines");
  await page.locator('article.eng[data-name="del-me"] h3', { hasText: "del-me" }).waitFor({ timeout: 10_000 });
  page.on("dialog", (d) => d.accept());
  await page.click('article.eng[data-name="del-me"] .del');
  await expect(page.locator('article.eng[data-name="del-me"]')).toHaveCount(0, { timeout: 10_000 });
  expect(await page.locator("article.eng").count()).toBe(1);
});

test("小飞机跳转：第二窗口打开服务地址（地址本身非超链接）", async ({ app, page }) => {
  const secondWindow = async () => {
    const t0 = Date.now();
    for (;;) {
      const ws = app.windows();
      for (const w of ws) {
        if (w !== page && w.url().includes("127.0.0.1:8302")) return w;
      }
      if (Date.now() - t0 > 15_000) throw new Error("第二窗口未打开");
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  await goView(page, "engines");
  const [np] = await Promise.all([
    secondWindow(),
    page.locator('.eng[data-name="mock"] .eng-go').click(),
  ]);
  expect(np.url()).toContain("127.0.0.1:8302");
  await np.close();
});
