// UI 结构类：关键 DOM 断言（id/class/aria、文案、列序、chip 文案）
import { test, expect } from "@playwright/test";
import { waitForEngineOnline, mockReset, cleanEngines, waitForJobsEmpty } from "../helpers";

test.beforeEach(async ({ page, request }) => {
  await mockReset(request);
  await cleanEngines(request);
  await waitForJobsEmpty(request);
  await page.goto("/");
  await waitForEngineOnline(page);
});

test("页头与板块顺序", async ({ page }) => {
  await expect(page.locator("header h1")).toHaveText("字幕工作台");
  await expect(page.locator(".brand-sub")).toHaveText("JAVSCRIBE · SUBTITLE CONSOLE");
  const sections = await page.locator("main > section").evaluateAll((els) => els.map((e) => e.id));
  expect(sections).toEqual(["sec-engines", "sec-dispatch", "sec-jobs"]);
  // 板块先后顺序（09-06 用户指定）：字幕服务 → 生成字幕 → 字幕任务
  await expect(page.locator("#sec-engines h2")).toHaveText("字幕服务");
  await expect(page.locator("#sec-dispatch h2")).toHaveText("生成字幕");
  await expect(page.locator("#sec-jobs h2")).toHaveText("字幕任务");
  await expect(page.locator("#sec-engines .kicker")).toHaveText("Services");
  await expect(page.locator("#sec-dispatch .kicker")).toHaveText("Generate");
  await expect(page.locator("#sec-jobs .kicker")).toHaveText("Tasks");
});

test("拖放区结构", async ({ page }) => {
  const drop = page.locator("#drop");
  await expect(drop).toHaveAttribute("role", "button");
  await expect(drop).toHaveAttribute("tabindex", "0");
  await expect(drop).toHaveAttribute("aria-label", "选择影片文件");
  await expect(drop.locator(".drop-main")).toHaveText("拖入影片，或点击选择文件");
  await expect(page.locator("#file")).toBeHidden();
  expect(await page.locator("#file").getAttribute("accept")).toContain(".mp4");
  expect(await page.locator("#file").getAttribute("accept")).toContain(".mkv");
  await expect(page.locator("#folder")).toBeHidden();
  await expect(page.locator("#folder")).toHaveAttribute("webkitdirectory", "");
  await expect(page.locator("#pick-folder")).toBeVisible();
  await expect(page.locator("#file-chip")).toBeHidden();
  await expect(page.locator("#folder-chip")).toBeHidden();
});

test("派单栏结构（含提取模式三选项与 autosave）", async ({ page }) => {
  await expect(page.locator("#engine-select")).toBeVisible();
  const opts = page.locator("#extract-select option");
  await expect(opts).toHaveCount(3);
  expect(await opts.nth(0).evaluate((e) => (e as HTMLOptionElement).value)).toBe("auto");
  expect(await opts.nth(1).evaluate((e) => (e as HTMLOptionElement).value)).toBe("local");
  expect(await opts.nth(2).evaluate((e) => (e as HTMLOptionElement).value)).toBe("server");
  await expect(opts.nth(0)).toHaveText(/自动（推荐，≤1.6GB 本地）/);
  await expect(page.locator("#dispatch-go")).toBeDisabled();
  await expect(page.locator("#autosave")).not.toBeChecked();
  await expect(page.getByText("完成后写回源目录")).toBeVisible();
});

test("扫描面板结构（服务端目录语义文案）", async ({ page }) => {
  await expect(page.locator(".scan-title")).toHaveText("扫描服务机器上的目录");
  await expect(page.locator("#scan-path")).toHaveAttribute("placeholder", "/media/jav");
  await expect(page.locator("#scan-go")).toBeDisabled();
  await expect(page.locator("#scan-results")).toBeHidden();
  // 关键语义：路径填「所选服务」运行所在服务器，不是本机
  await expect(page.locator(".scan-head .muted")).toHaveText(/不是当前访问本页面这台电脑的本地路径/);
});

test("任务看板结构（列序/筛选/分页/空态）", async ({ page }) => {
  const head = page.locator(".job-head > span");
  await expect(head).toHaveCount(7);
  expect(await head.evaluateAll((els) => els.map((e) => e.textContent))).toEqual(
    ["服务", "文件", "状态", "进度", "位置", "耗时", ""],
  );
  const stats = page.locator("#job-stats .stat");
  await expect(stats).toHaveCount(4);
  expect(await stats.evaluateAll((els) => els.map((e) => e.textContent))).toEqual(
    ["进行中 0", "完成 0", "跳过 0", "失败 0"],
  );
  const filters = page.locator("#job-filter button");
  await expect(filters).toHaveCount(3);
  expect(await filters.evaluateAll((els) => els.map((e) => e.textContent))).toEqual(["全部", "进行中", "已完成"]);
  await expect(filters.nth(0)).toHaveClass(/on/);
  await expect(page.locator("#job-pager")).toBeHidden();
  await expect(page.locator("#jobs-empty")).toBeVisible();
  await expect(page.locator("#jobs-empty-text")).toHaveText("暂无任务");
});

test("页脚与 modal/toast 结构", async ({ page }) => {
  await expect(page.locator("footer").locator(".mono").first()).toHaveText("JAVSCRIBE-WEB");
  await expect(page.getByText("看板 5s · 生成 1s")).toBeVisible();
  await expect(page.locator("#modal-backdrop")).toBeHidden();
  await expect(page.locator("#modal")).toHaveAttribute("role", "dialog");
  await expect(page.locator("#modal")).toHaveAttribute("aria-modal", "true");
  await expect(page.locator("#toasts")).toHaveAttribute("aria-live", "polite");
});

test("预设服务卡片结构（小飞机跳转 + 版本/设备/运行 tag）", async ({ page }) => {
  const card = page.locator('article.eng[data-name="mock"]');
  await expect(card).toHaveClass(/on/);
  await expect(card.locator(".lamp")).toHaveCount(1);
  await expect(card.locator("h3")).toHaveText("mock");
  await expect(card.locator(".icon-btn.set")).toHaveAttribute("title", "服务设置");
  await expect(card.locator(".icon-btn.del")).toHaveAttribute("title", "删除服务");
  // 地址不是超链接样式：跳转按钮是独立的小飞机（eng-go），地址本身无 <a>
  const go = card.locator(".eng-go");
  await expect(go).toHaveAttribute("href", "http://127.0.0.1:8301");
  await expect(go.locator("svg")).toHaveCount(1);
  const urlTxt = card.locator(".eng-url-txt");
  expect(await urlTxt.innerHTML()).not.toContain("<a");
  await expect(urlTxt).toHaveText("http://127.0.0.1:8301");
  const tags = card.locator(".eng-specs .tag");
  await expect(tags).toHaveCount(3);
  expect(await tags.evaluateAll((els) => els.map((e) => e.textContent))).toEqual(["cuda", "v0.1.0", "运行 0"]);
});

test("服务表单校验（重名异址 400）", async ({ page, request }) => {
  const r = await request.post("/api/engines", {
    data: { name: "mock", url: "http://127.0.0.1:9999" },
    headers: { "Content-Type": "application/json" },
  });
  expect(r.status()).toBe(400);
  // 同名同址 = 幂等
  const r2 = await request.post("/api/engines", {
    data: { name: "mock", url: "http://127.0.0.1:8301" },
    headers: { "Content-Type": "application/json" },
  });
  expect(r2.status()).toBe(201);
});
