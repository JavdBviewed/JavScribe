// UI 结构类：关键 DOM 断言（id/class/aria、文案、列序、chip 文案）
import { test, expect } from "@playwright/test";
import { WEB_URL, waitForEngineOnline, mockReset, cleanEngines, waitForJobsEmpty, goTab } from "../helpers";

test.beforeEach(async ({ page, request }) => {
  await mockReset(request);
  await cleanEngines(request);
  await waitForJobsEmpty(request);
  await page.goto("/");
  await waitForEngineOnline(page);
});

test("监听面板在 web 形态恒隐藏（web 100% 不变契约）", async ({ page }) => {
  await expect(page.locator("#watch-panel")).toBeHidden();
});

test("页头与板块顺序", async ({ page }) => {
  await expect(page.locator("header h1")).toHaveText("字幕工作台");
  await expect(page.locator(".brand-sub")).toHaveText("JAVSCRIBE · SUBTITLE CONSOLE");
  const sections = await page.locator("main > section").evaluateAll((els) => els.map((e) => e.id));
  expect(sections).toEqual(["sec-engines", "sec-dispatch", "sec-jobs", "sec-ccfg"]);
  // 板块先后顺序（09-06 用户指定）：字幕服务 → 生成字幕 → 字幕任务 → 客户端设置（S3 新增独立 tab）
  await expect(page.locator("#sec-engines h2")).toHaveText("字幕服务");
  await expect(page.locator("#sec-dispatch h2")).toHaveText("生成字幕");
  await expect(page.locator("#sec-jobs h2")).toHaveText("字幕任务");
  await expect(page.locator("#sec-ccfg h2")).toHaveText("客户端设置");
  await expect(page.locator("#sec-engines .kicker")).toHaveText("Services");
  await expect(page.locator("#sec-dispatch .kicker")).toHaveText("Generate");
  await expect(page.locator("#sec-jobs .kicker")).toHaveText("Tasks");
  await expect(page.locator("#sec-ccfg .kicker")).toHaveText("Client");
});

test("统一侧边导航：Web 与桌面共用同一组视图按钮", async ({ page }) => {
  const tabs = page.locator("#nav .view-tab");
  await expect(page.locator("#nav")).toBeVisible();
  await expect(page.locator("#view-tabs")).toHaveCount(0);
  await expect(tabs).toHaveCount(4);
  // 顺序（10-08 应用户要求交换）：生成字幕 → 字幕服务 → 字幕任务 → 客户端设置
  await expect(tabs.nth(0)).toHaveText("生成字幕");
  await expect(tabs.nth(1)).toHaveText("字幕服务");
  await expect(tabs.nth(2)).toContainText("字幕任务");
  await expect(tabs.nth(3)).toHaveText("客户端设置");
  // 默认视图 = 生成字幕（首页）：view-on + aria-selected 跟随，其余板块隐藏
  await expect(tabs.nth(0)).toHaveClass(/on/);
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#sec-dispatch")).toHaveClass(/view-on/);
  await expect(page.locator("#sec-jobs")).not.toHaveClass(/view-on/);
  await expect(page.locator("#sec-engines")).not.toHaveClass(/view-on/);
  // 点击切换：view-on 与 aria-selected 移动
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveClass(/on/);
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#sec-engines")).toHaveClass(/view-on/);
  await expect(page.locator("#sec-dispatch")).not.toHaveClass(/view-on/);
  // localStorage 持久化：reload 后仍停在「字幕服务」
  await page.reload();
  await waitForEngineOnline(page);
  await expect(tabs.nth(1)).toHaveClass(/on/);
  await expect(page.locator("#sec-engines")).toHaveClass(/view-on/);
});

test("页头仓库链接 + demo 试听卡结构", async ({ page }) => {
  const pill = page.locator(".repo-pill");
  await expect(pill).toHaveAttribute("href", "https://github.com/JavdBviewed/JavScribe");
  await expect(pill).toHaveAttribute("target", "_blank");
  await expect(pill).toContainText("JavScribe 仓库");
  // demo 卡：默认收起（不常驻首页），展开后 = 日语原声 + 中文翻译 + SRT 示例 + 可播放音频（内置容器静态资产）
  await expect(page.locator("#demo-card")).toBeVisible();
  await expect(page.locator("#demo-body")).toBeHidden();
  await expect(page.locator("#demo-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.click("#demo-toggle");
  await expect(page.locator("#demo-body")).toBeVisible();
  await expect(page.locator("#demo-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#demo-play")).toContainText("试听");
  await expect(page.locator(".demo-jp")).toHaveText("こんにちは、中国万歳！");
  await expect(page.locator("#demo-zh")).toHaveText("你好啊，中国万岁！");
  await expect(page.locator("#demo-audio")).toHaveAttribute("src", "/demo/ja-hello.mp3");
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

test("扫描面板结构（客户端部署机语义文案）", async ({ page }) => {
  await expect(page.locator(".scan-title")).toHaveText("扫描客户端目录");
  await expect(page.locator("#scan-path")).toHaveAttribute("placeholder", "例如 /mnt/115/JPMV/115DZL");
  await expect(page.locator("#scan-go")).toBeDisabled();
  await expect(page.locator("#scan-results")).toBeHidden();
  // 关键语义：路径填客户端（本页面服务）部署机上的目录，不是浏览器电脑（长解释收进 ? 帮助 tooltip）
  await expect(page.locator(".scan-head .muted")).toHaveText(/扫描运行 JavScribe 的这台机器/);
  const tip = await page.locator(".scan-head .help").getAttribute("data-tip");
  expect(tip).toMatch(/浏览器电脑里的文件/);
});

test("任务看板结构（列序/筛选/分页/空态）", async ({ page }) => {
  await goTab(page, "jobs");
  const head = page.locator(".job-head > span");
  // 首列为「全选当前筛选结果」勾选框（批量操作入口）；「添加于/完成于」独立两列
  await expect(head).toHaveCount(10);
  expect(await head.evaluateAll((els) => els.map((e) => e.textContent))).toEqual(
    ["", "服务", "文件", "状态", "进度", "位置", "耗时", "添加于", "完成于", ""],
  );
  await expect(page.locator("#job-sel-all")).toBeVisible();
  // 旧「统计行」已删：统计与筛选合一（筛选按钮内嵌计数）
  expect(await page.locator("#job-stats").count()).toBe(0);
  // 全局暂停按钮：无在途任务时隐藏（10-09 需求；有任务可见性见 interaction 全局暂停用例）
  await expect(page.locator("#job-pause-all")).toBeHidden();
  const filters = page.locator("#job-filter button");
  await expect(filters).toHaveCount(9);
  expect(await filters.evaluateAll((els) => els.map((e) => e.textContent))).toEqual([
    "全部 0", "进行中 0", "排队中 0", "提取中 0", "转译中 0", "完成 0", "跳过 0", "失败 0", "已暂停 0",
  ]);
  await expect(filters.nth(0)).toHaveClass(/on/);
  await expect(page.locator("#job-pager")).toBeHidden();
  await expect(page.locator("#jobs-empty")).toBeVisible();
  await expect(page.locator("#jobs-empty-text")).toHaveText("暂无任务");
});

test("页脚与 modal/toast 结构", async ({ page }) => {
  await expect(page.locator("footer").locator(".mono").first()).toHaveText("JAVSCRIBE-WEB");
  await expect(page.locator("footer > .muted")).toContainText("看板 5s · 生成 1s");
  await expect(page.locator("#modal-backdrop")).toBeHidden();
  await expect(page.locator("#modal")).toHaveAttribute("role", "dialog");
  await expect(page.locator("#modal")).toHaveAttribute("aria-modal", "true");
  await expect(page.locator("#toasts")).toHaveAttribute("aria-live", "polite");
});

test("预设服务卡片结构（小飞机跳转 + 版本/设备/运行 tag）", async ({ page, request }) => {
  await goTab(page, "engines");
  const svcVer = ((await (await request.get(`${WEB_URL}/api/health`)).json()) as { version: string }).version;
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
  expect(await tags.evaluateAll((els) => els.map((e) => e.textContent))).toEqual(["cuda", `v${svcVer}`, "运行 0"]);
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

test("客户端设置 tab（web 形态）：并发卡可改可存，无仅桌面项", async ({ page }) => {
  const tabs = page.locator("#nav .view-tab");
  await tabs.nth(3).click();
  await expect(page.locator("#sec-ccfg")).toHaveClass(/view-on/);
  // 扫描规则卡（10-08 归位客户端设置）：6 控件在 web 形态也渲染；保存按钮无改动时保持隐藏
  await expect(page.locator("#cc-scan-exts")).toBeVisible({ timeout: 10_000 });
  // 并发卡：范围校验与原弹窗卡片同语义（1~8 / 1~16）
  await expect(page.locator("#ccfg-extract_workers")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#ccfg-extract_workers")).toHaveAttribute("min", "1");
  await expect(page.locator("#ccfg-extract_workers")).toHaveAttribute("max", "8");
  await expect(page.locator("#ccfg-queue_cap")).toHaveAttribute("min", "1");
  await expect(page.locator("#ccfg-queue_cap")).toHaveAttribute("max", "16");
  // web 形态不渲染桌面专属区（无「仅桌面」徽标）
  await expect(page.locator("#sec-ccfg .cc-only-badge")).toHaveCount(0);
  // 保存 → toast → reload 后仍在（/api/client-config 持久化）
  await page.locator("#ccfg-extract_workers").fill("5");
  await page.locator("#ccfg-queue_cap").fill("7");
  await expect(page.locator("#ccfg-save")).toBeVisible();
  await page.click("#ccfg-save");
  await expect(page.locator("#toasts .toast.ok", { hasText: "客户端设置已保存" })).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await waitForEngineOnline(page);
  // localStorage 记住视图 = ccfg，reload 后直接在该 tab
  await expect(page.locator("#sec-ccfg")).toHaveClass(/view-on/);
  await expect(page.locator("#ccfg-extract_workers")).toHaveValue("5");
  await expect(page.locator("#ccfg-queue_cap")).toHaveValue("7");
});
