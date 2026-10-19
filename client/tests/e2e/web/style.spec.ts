// 样式类：整页 + 关键区块截图基线（像素 diff）
// 动态元素（时钟/更新时间/耗时/ETA/动画）由 freezeForShot 统一冻结
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import {
  waitForEngineOnline, waitForEngineKey, mockReset, mockSeed, mockPause, cleanEngines, freezeForShot, shot, triggerToast,
  addEngine, MOCK_KEY, FIXTURES, waitForJobsEmpty, makeScanDir, goTab,
} from "../helpers";
import path from "node:path";

const fx = (n: string) => path.join(FIXTURES, n);

// 本地扫描夹具（工作台本机临时目录）
const SCAN_DIR = makeScanDir();

let req: APIRequestContext;
test.afterEach(async () => {
  // 扫描规则 minsize 在共享 client_config.json（跨套件持久）：统一还原默认 200
  await req.put("/api/client-config", { data: { scan_min_size_mb: 200 } }).catch(() => {});
});
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
  await goTab(page, "engines");
  await freezeForShot(page, req);
  await shot(page, "style-02-engine-card", { element: "#sec-engines" });
});

test("单文件 chip 选中态", async ({ page }) => {
  await page.setInputFiles("#file", fx("video-a.mp4"));
  await expect(page.locator("#file-chip")).toBeVisible();
  await freezeForShot(page, req);
  await shot(page, "style-03-file-chip", { element: "#sec-dispatch" });
});

test("文件夹 chip + 待选表（默认 0 勾选）", async ({ page }) => {
  await page.setInputFiles("#folder", FIXTURES); // webkitdirectory：传目录
  // 夹具小文件均低于默认「忽略小于 200MB」→ 默认 0 勾选，待选表 3 行
  await expect(page.locator("#folder-chip-text")).toHaveText("已选 0 / 3");
  await expect(page.locator("#folder-table tbody tr")).toHaveCount(3);
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
  // 完成信号：提交成功先弹 toast（body 级，不受切视图影响）；此时已自动切到任务看板
  await expect(page.locator("#toasts .toast.ok", { hasText: "已提交到" })).toBeVisible({ timeout: 90_000 });
  // 切回派发页再断言终态并截
  await goTab(page, "dispatch");
  await expect(page.locator("#meta-dispatch", { hasText: /^任务 [\w-]+$/ })).toBeVisible();
  await expect(page.locator("#step-dispatch.done")).toBeVisible();
  await page.waitForTimeout(200);
  await freezeForShot(page, req);
  await shot(page, "style-06-pipeline-done", { element: "#sec-dispatch" });
});

test("任务看板：进行中（扫光动画帧）", async ({ page }) => {
  await mockPause(req); // 先停：running 行不会在页面刷新前进成 done
  await mockSeed(req, { n: 1, status: "running", progress: 0.37 });
  await goTab(page, "jobs");
  // 0.2.47：任务表最小内容 1069px < 默认视口容器宽 1102px，无横滚，整表完整可见
  await page.locator(".job-row.running").waitFor({ timeout: 15_000 });
  // 根治断言：前序用例残留批次记录随保留期剪枝 → 看板无 0 子任务孤儿主任务行，
  // 行集合精确 = 本用例 1 条 running seed（expect 自动重试覆盖最后几个 tick 的剪枝延迟）
  await expect(page.locator(".job-batch-row")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".job-row")).toHaveCount(1, { timeout: 15_000 });
  await page.waitForTimeout(400);
  await freezeForShot(page, req);
  await shot(page, "style-07-jobs-running", { element: "#sec-jobs" });
});

test("任务看板：已完成 + 分页器", async ({ page }) => {
  await mockSeed(req, { n: 25, status: "done" });
  await goTab(page, "jobs");
  await page.click('#job-filter [data-f="done"]');
  await expect(page.locator("#job-pager")).toBeVisible();
  await page.locator("#pg-next").click();
  await page.locator(".pg-info", { hasText: "第 2 / 3 页" }).waitFor();
  await page.waitForTimeout(200);
  await freezeForShot(page, req);
  await shot(page, "style-08-jobs-pager", { element: "#sec-jobs" });
});

test("服务端设置（设置 tab pane）：未登记 Key 表单", async ({ page }) => {
  await addEngine(req, { name: "nokey", url: "http://127.0.0.1:8301" });
  // 等 5s 看板把新引擎拉进 state.engines（ccfg 激活即重渲染，之后再进页下拉框才有 nokey）
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { state?: { engines?: { name: string }[] } }).state?.engines?.some((e) => e.name === "nokey") ?? false), { timeout: 20_000 })
    .toBe(true);
  // 0246 A：卡片齿轮已删 → 设置 tab 服务端 pane 选 nokey 服务
  await goTab(page, "ccfg");
  await page.click('.cc-subtabs .cfg-tab[data-cctab="server"]');
  await expect(page.locator('#srv-sel option[value="nokey"]')).toHaveCount(1, { timeout: 15_000 }); // option 在折叠 select 内恒 hidden，断 DOM 存在
  await page.selectOption("#srv-sel", "nokey");
  await expect(page.locator("#key-input")).toBeVisible({ timeout: 5_000 });
  await page.locator("#key-input").fill("");
  await freezeForShot(page, req);
  await shot(page, "style-09-settings-keyless", { element: "#srv-body" });
});

test("服务端设置（设置 tab pane）：叠放表单（就绪总览 + 设置组）", async ({ page }) => {
  // 0246 A：弹窗 + 内层 tab 已删 → 设置 tab 服务端 pane 叠放布局（首服务动态取，不硬编码）
  await goTab(page, "ccfg");
  await page.click('.cc-subtabs .cfg-tab[data-cctab="server"]');
  const firstEngine = await page.locator("#srv-sel option").nth(1).getAttribute("value");
  await page.selectOption("#srv-sel", firstEngine);
  await expect(page.locator("#cfg-save")).toBeVisible({ timeout: 10_000 });
  // 等组件就绪自检行渲染完成（异步 /ready 拉取），保证快照确定性
  await expect(page.locator("#srv-body .ready-row").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(200);
  await freezeForShot(page, req);
  await shot(page, "style-10-settings-form", { element: ".cc-pane[data-pane='server']" });
});

test("扫描结果表（字幕标记行）", async ({ page }) => {
  // 「忽略小于」默认 200MB 会多一个「过小」标签 → 服务端即时置 0 保持基线语义（afterEach 还原 200）
  await req.put("/api/client-config", { data: { scan_min_size_mb: 0 } });
  await page.locator("#scan-path").fill(SCAN_DIR);
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
  await goTab(page, "engines");
  await page.locator('article.eng[data-name="offline-svc"] .eng-err').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(200);
  await freezeForShot(page, req);
  await shot(page, "style-13-offline-card", { element: "#sec-engines" });
});
