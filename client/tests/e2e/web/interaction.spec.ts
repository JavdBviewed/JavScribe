// 交互类：完整用户流（单文件三步动画→完成→看板→下载；整片上传回退；文件夹批量；扫描全流程；Windows 拦截；筛选×分页；retry；autosave 降级下载；小飞机跳转；删除服务）
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  waitForEngineOnline, waitForEngineKey, mockReset, mockSeed, mockSpeed, cleanEngines, addEngine, MOCK_KEY, MOCK_URL, FIXTURES,
  waitForJobsEmpty, makeScanDir, resetPipelinePause,
} from "../helpers";
import path from "node:path";
import { readFileSync, existsSync, unlinkSync } from "node:fs";

const fx = (n: string) => path.join(FIXTURES, n);

// 本地扫描夹具（工作台本机临时目录）
const SCAN_DIR = makeScanDir();
const readText = (p: string) => readFileSync(p, "utf-8");

let req: APIRequestContext;
test.beforeEach(async ({ page, request }) => {
  req = request;
  await mockReset(request);
  await resetPipelinePause(request);
  await cleanEngines(request);
  await waitForJobsEmpty(request);
  // 8s/任务：保证页面 5s 轮询能观察到 running→done（autosave 写回、看板 running 态都依赖此迁移）
  await mockSpeed(request, { step: 0.0125, tickMs: 100 });
  await page.goto("/");
  await waitForEngineOnline(page);
  await waitForEngineKey(page, "mock");
});
// pipeline_paused 持久化在共享 web 数据目录：用例中途失败也要复位，防拖死后续本机管线用例
test.afterEach(async () => {
  await resetPipelinePause(req);
});

/** 轮询等包含指定文案的 toast（避免「首个可见 toast」误匹配上一条操作的旧 toast，8s 内会共存） */
async function expectToast(page: Page, needle: string, timeoutMs = 15_000) {
  const t0 = Date.now();
  for (;;) {
    const texts = await page.locator("#toasts .toast").allTextContents();
    if (texts.some((t) => t.includes(needle))) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`toast 未出现: ${needle}（当前: ${texts.join(" | ") || "无"}）`);
    await new Promise((rs) => setTimeout(rs, 100));
  }
}

test("全局暂停 UI：暂停所有 → 服务卡/行态 → 提交任务挂起 → 继续任务 → 派发完成", async ({ page }) => {
  // 「忽略小于」默认 200MB 会把夹具小文件判成过小未选 → 置 0；
  // scanMinSizeMb 在页面加载时读入 state，必须 reload 后设置才生效
  await page.evaluate(() => localStorage.setItem("javweb_scan_minsize", "0"));
  await page.reload();
  await waitForEngineOnline(page);
  await waitForEngineKey(page, "mock");
  page.on("dialog", (d) => d.accept());
  // 1. 暂停所有（confirm 放行）
  await page.click("#job-pause-all");
  await expectToast(page, "已暂停所有任务");
  const btn = page.locator("#job-pause-all");
  await expect(btn).toHaveText("▶ 继续任务");
  await expect(btn).toHaveClass(/on/);
  // 服务卡「已暂停」tag（poller 读 /health paused：1s tick + 页面 5s 刷新）
  await expect(page.locator('article.eng[data-name="mock"] .tag-paused')).toHaveText("已暂停", { timeout: 20_000 });
  // 2. 本机扫描提交 → 3 条任务全部停在闸前（不提取、不派发）
  await page.locator("#scan-path").fill(SCAN_DIR);
  await page.click("#scan-go");
  await expect(page.locator("#scan-table table")).toBeVisible({ timeout: 10_000 });
  await page.locator("#scan-select-all").check();
  await page.click("#scan-submit");
  await expectToast(page, "已入队 3 项（本机扫描）");
  await expect(page.locator(".job-row .pill.p-paused")).toHaveCount(3, { timeout: 20_000 });
  await expect(
    page.locator(".job-row .cell-pos", { hasText: "已暂停（等待继续）" }).first(),
  ).toBeVisible({ timeout: 20_000 });
  // 合并筛选条：「已暂停」按钮内嵌计数（旧 #job-stats 统计行已删）
  await expect(page.locator('#job-filter button[data-f="paused"]')).toContainText("已暂停 3", { timeout: 20_000 });
  // 3. 继续任务（resume 无 confirm）
  await page.click("#job-pause-all");
  await expectToast(page, "已继续所有任务");
  await expect(btn).toHaveText("⏸ 暂停所有");
  await expect(btn).not.toHaveClass(/on/);
  // 4. 提取+派发+转写完成 → 三条行回 done
  for (const f of ["AKDL-001.mp4", "AKDL-002.mp4", "SUB-001.mkv"]) {
    await expect(
      page.locator(".job-row", { has: page.locator(".fn", { hasText: f }) }).locator(".pill.p-done"),
    ).toBeVisible({ timeout: 60_000 });
  }
  // 等写回完成再还原夹具（防下一个「扫描全流程」用例的提交被防重跳过）
  const want = [path.join(SCAN_DIR, "AKDL-001.zh.srt"), path.join(SCAN_DIR, "SUB-001.zh.srt")];
  const t0 = Date.now();
  while (!want.every((n) => existsSync(n)) && Date.now() - t0 < 90_000) await new Promise((rs) => setTimeout(rs, 500));
  for (const n of want) expect(existsSync(n)).toBe(true);
  for (const n of want) unlinkSync(n);
});

test("行级挂起：排队行 ⏸ 暂停 → 已暂停（行变暗）→ ▶ 继续 → 回排队", async ({ page }) => {
  await mockSpeed(req, { step: 0.002, tickMs: 100 }); // running 行保持运行（409 判定依赖）
  await mockSeed(req, { n: 2, status: "running", progress: 0.2, pending: 1 });
  const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: "seed-001.mp4" }) });
  await expect(row.locator(".pill.p-pending")).toBeVisible({ timeout: 15_000 });
  // 运行中行（seed-002）无暂停按钮（只有取消）；排队行有
  const runRow = page.locator(".job-row", { has: page.locator(".fn", { hasText: "seed-002.mp4" }) });
  expect(await runRow.locator(".pause-job").count()).toBe(0);
  expect(await runRow.locator(".cancel").count()).toBe(1);
  await expect(row.locator(".pause-job")).toBeVisible({ timeout: 15_000 });
  await row.locator(".pause-job").click();
  await expectToast(page, "已挂起");
  // pill 归一「已暂停」，行变暗，按钮切「▶ 继续」，取消按钮消失（暂停中不重复操作）
  await expect(row.locator(".pill.p-paused")).toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveClass(/paused/);
  await expect(row.locator(".resume-job")).toBeVisible({ timeout: 15_000 });
  expect(await row.locator(".pause-job").count()).toBe(0);
  expect(await row.locator(".cancel").count()).toBe(0);
  // 恢复 → 回排队
  await row.locator(".resume-job").click();
  await expectToast(page, "已恢复排队");
  await expect(row.locator(".pill.p-pending")).toBeVisible({ timeout: 15_000 });
  await expect(row).not.toHaveClass(/paused/);
});

test("行级重试：失败行 ↻ 重试 → 重新入队 → 同文件新任务 running（不删已生成字幕）", async ({ page }) => {
  // beforeEach 已设 8s/任务：重试后的新任务有可观察的 running 窗口
  await mockSeed(req, { n: 1, status: "error", errors: 1 });
  const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: "seed-001.mp4" }) });
  await expect(row.locator(".pill.p-error")).toBeVisible({ timeout: 15_000 });
  await expect(row.locator(".sub")).toContainText("转写失败");
  const btn = row.locator(".retry");
  await expect(btn).toHaveText("↻ 重试");
  await btn.click();
  await expectToast(page, "已重新入队");
  // 旧失败行保留 + 同文件新任务 running（两行）
  const all = page.locator(".job-row", { has: page.locator(".fn", { hasText: "seed-001.mp4" }) });
  await expect(all.locator(".pill.p-running").first()).toBeVisible({ timeout: 20_000 });
  await expect(all).toHaveCount(2, { timeout: 20_000 });
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

test("任务行细节：阶段文案 / ETA 倒计时 / 耗时逐秒 / 下载命名", async ({ page }) => {
  await page.setInputFiles("#file", fx("video-a.mp4"));
  await page.selectOption("#engine-select", "mock");
  await page.click("#dispatch-go");
  const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: "video-a.mp4" }) });
  // 运行中：位置列 = 服务端阶段文案（非时间轴位置），ETA 带「剩 ~」
  await expect(row.locator(".pill.p-running")).toBeVisible({ timeout: 15_000 });
  await expect(row.locator(".cell-pos")).toContainText("转写中", { timeout: 15_000 });
  await expect(row.locator(".eta")).toContainText("剩 ~", { timeout: 15_000 });
  // 耗时列 1s 走秒：先等 ticker 至少走过 2s，再间隔 2s 采样两次必须不同
  const secs = async () => {
    const m = ((await row.locator(".cell-elapsed").textContent()) || "").trim().match(/^(\d+):?(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  };
  await expect.poll(secs, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  const el1 = (await row.locator(".cell-elapsed").textContent()) || "";
  await page.waitForTimeout(2000);
  const el2 = (await row.locator(".cell-elapsed").textContent()) || "";
  expect(el2).not.toBe(el1);
  // 完成：下载链接名 = <源视频名>.zh.srt（与落盘/写回一致）
  await expect(row.locator(".pill.p-done")).toBeVisible({ timeout: 40_000 });
  expect(await row.locator(".job-actions a.dl-btn").getAttribute("download")).toBe("video-a.zh.srt");
});

// 09-12 回归：空 label + 音轨 sha1 文件名的任务，下载按钮文件名绝不许是 40 位 hash
test("下载名回归：空 label + hash 名音轨任务 → 下载按钮用任务 id 命名（非 40 位 hash）", async ({ page }) => {
  const sha1 = "60d514bef136a97d6517d3d5d02cdb28cd72251b";
  const seed = await (await req.post(`${MOCK_URL}/_mock/seed-hash-job`, {
    data: { sha1 }, headers: { "Content-Type": "application/json" },
  })).json() as { ok: boolean; job_id: string };
  expect(seed.ok).toBe(true);
  const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: `${sha1}.opus` }) });
  await expect(row.locator(".pill.p-done")).toBeVisible({ timeout: 15_000 });
  const name = await row.locator(".job-actions a.dl-btn").getAttribute("download");
  expect(name).not.toMatch(/^[0-9a-f]{40}\.zh\.srt$/i);
  expect(name).toBe(`${seed.job_id}.zh.srt`);
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

test("扫描全流程：本地目录 → 默认勾选无字幕 → 全选 → 提交入队（本机管线）", async ({ page }) => {
  // 「忽略小于」默认 200MB 会把夹具小文件判成过小未选 → 置 0 复刻旧语义
  await page.evaluate(() => localStorage.setItem("javweb_scan_minsize", "0"));
  await page.reload();
  await waitForEngineOnline(page);
  await waitForEngineKey(page, "mock");
  // 全选含已有字幕项 → 提交前弹确认（window.confirm），e2e 一律放行
  page.on("dialog", (d) => d.accept());
  await page.locator("#scan-path").fill(SCAN_DIR);
  await expect(page.locator("#scan-go")).toBeEnabled();
  await page.click("#scan-go");
  await expect(page.locator("#scan-table table")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".scan-name")).toHaveCount(3);
  // 外部 srt 行：标签文案「外部 srt」，文件名在 title 上
  const subtag = page.locator(".has-sub .subtag");
  await expect(subtag).toHaveCount(1);
  await expect(subtag).toHaveText("外部 srt");
  await expect(subtag).toHaveAttribute("title", "AKDL-002.zh.srt");
  await expect(page.locator("#scan-count")).toHaveText("已选 2 / 3 · 1 个已有字幕默认不勾选");
  await expect(page.locator("#scan-submit")).toContainText("开始生成（2 项）");
  await page.locator("#scan-select-all").check();
  await expect(page.locator("#scan-count")).toHaveText("已选 3 / 3 · 1 个已有字幕默认不勾选");
  const [toast] = await Promise.all([
    page.waitForSelector("#toasts .toast.ok", { state: "visible" }),
    page.click("#scan-submit"),
  ]);
  expect(await toast.textContent()).toContain("已入队 3 项（本机扫描）");
  await expect(page.locator("#scan-results")).toBeHidden();
  // 本机管线：3 条独立任务，label = 原始视频名（mock 侧 job label = 源名）
  await expect(page.locator(".job-row .fn", { hasText: "AKDL-001.mp4" })).toBeVisible({ timeout: 40_000 });
  await expect(page.locator(".job-row .fn", { hasText: "AKDL-002.mp4" })).toBeVisible({ timeout: 40_000 });
  await expect(page.locator(".job-row .fn", { hasText: "SUB-001.mkv" })).toBeVisible({ timeout: 40_000 });
});

test("扫描：Windows 路径客户端拦截（toast 引导用选择文件夹）", async ({ page }) => {
  await page.locator("#scan-path").fill("D:\\Videos");
  await page.click("#scan-go");
  const t = page.locator("#toasts .toast.err");
  await expect(t).toBeVisible({ timeout: 5_000 });
  expect(await t.textContent()).toContain("浏览器电脑的本地路径");
  expect(await t.textContent()).toContain("选择文件夹");
  await expect(page.locator("#scan-results")).toBeHidden();
});

test("筛选 × 分页：25 条已完成 → 2 页 → 翻页重渲染", async ({ page }) => {
  await mockSeed(req, { n: 25, status: "done" });
  // /api/jobs 按 created 降序（最新在前），mock 按 60s 间隔赋 created：
  // 第 1 页 = seed-006..025（20 行），第 2 页 = seed-001..005（5 行）
  await page.locator('.job-row .fn', { hasText: "seed-025.mp4" }).waitFor({ timeout: 15_000 });
  await page.click('#job-filter [data-f="done"]');
  await expect(page.locator(".pg-info")).toHaveText("第 1 / 2 页 · 共 25 条");
  await expect(page.locator("#job-list .job-row")).toHaveCount(20);
  // 页 1 的末行边界：最老的一条（seed-006）仍在页 1
  await expect(page.locator('.job-row .fn', { hasText: "seed-006.mp4" })).toBeVisible();
  await page.click("#pg-next");
  await expect(page.locator(".pg-info")).toHaveText("第 2 / 2 页 · 共 25 条");
  await expect(page.locator("#job-list .job-row")).toHaveCount(5);
  await expect(page.locator('.job-row .fn', { hasText: "seed-001.mp4" })).toBeVisible();
  await expect(page.locator("#pg-next")).toBeDisabled();
  await page.click('#job-filter [data-f="active"]');
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
