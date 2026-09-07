// 桌面端 UI 结构类：关键 DOM 断言（id/class/aria、桌面措辞、列序、chip 文案）
import { test, expect } from "./helpers";
import { MOCK } from "./helpers";

test.beforeEach(async ({ page }) => {
  // 页面已随 fixture 冷启动完成（引擎 mock 在线、Key 预置）
  await expect(page.locator("#health")).toHaveText(/v0\.2\.2 · 服务 1\/1 在线/);
});

test("页头与板块顺序", async ({ page }) => {
  await expect(page.locator("header h1")).toHaveText("字幕工作台");
  // 桌面版品牌副标（构建期 REWRITES）
  await expect(page.locator(".brand-sub")).toHaveText("JAVSCRIBE CLIENT · DESKTOP");
  const sections = await page.locator("main > section").evaluateAll((els) => els.map((e) => e.id));
  expect(sections).toEqual(["sec-engines", "sec-dispatch", "sec-jobs"]);
  await expect(page.locator("#sec-engines h2")).toHaveText("字幕服务");
  await expect(page.locator("#sec-dispatch h2")).toHaveText("生成字幕");
  await expect(page.locator("#sec-jobs h2")).toHaveText("字幕任务");
  await expect(page.locator("#sec-engines .kicker")).toHaveText("Services");
  await expect(page.locator("#sec-dispatch .kicker")).toHaveText("Generate");
  await expect(page.locator("#sec-jobs .kicker")).toHaveText("Tasks");
});

test("拖放区结构（桌面措辞：本机提取、无大小限制）", async ({ page }) => {
  const drop = page.locator("#drop");
  await expect(drop).toHaveAttribute("role", "button");
  await expect(drop).toHaveAttribute("tabindex", "0");
  await expect(drop).toHaveAttribute("aria-label", "选择影片文件");
  await expect(drop.locator(".drop-main")).toHaveText("拖入影片，或点击选择文件");
  // 桌面措辞：无 1.6GB 字样（wasm 上限仅存在于浏览器形态）
  const hint = drop.locator(".muted.small").first();
  await expect(hint).toHaveText(/在本机提取音轨，只上传 ~35MB 音频（无大小限制）/);
  await expect(hint).not.toHaveText(/1\.6GB/);
  await expect(page.locator("#file")).toBeHidden();
  expect(await page.locator("#file").getAttribute("accept")).toContain(".mp4");
  await expect(page.locator("#folder")).toBeHidden();
  await expect(page.locator("#folder")).toHaveAttribute("webkitdirectory", "");
  await expect(page.locator("#pick-folder")).toBeVisible();
  await expect(page.locator("#file-chip")).toBeHidden();
  await expect(page.locator("#folder-chip")).toBeHidden();
});

test("派单栏结构（提取模式三选项桌面措辞 + autosave）", async ({ page }) => {
  await expect(page.locator("#engine-select")).toBeVisible();
  const opts = page.locator("#extract-select option");
  await expect(opts).toHaveCount(3);
  expect(await opts.nth(0).evaluate((e) => (e as HTMLOptionElement).value)).toBe("auto");
  expect(await opts.nth(1).evaluate((e) => (e as HTMLOptionElement).value)).toBe("local");
  expect(await opts.nth(2).evaluate((e) => (e as HTMLOptionElement).value)).toBe("server");
  await expect(opts.nth(0)).toHaveText("自动（推荐，本机提取）");
  await expect(opts.nth(1)).toHaveText("仅本机提取");
  await expect(opts.nth(2)).toHaveText("整片直传字幕服务");
  await expect(page.locator("#dispatch-go")).toBeDisabled();
  await expect(page.locator("#autosave")).not.toBeChecked();
  await expect(page.getByText("完成后写回源目录")).toBeVisible();
  // autosave 说明桌面措辞：写回失败走保存对话框
  await expect(page.locator(".autosave-note").first()).toHaveText(/写回失败时改为自动下载（保存对话框）/);
});

test("扫描面板结构（服务端目录语义文案不变）", async ({ page }) => {
  await expect(page.locator(".scan-title")).toHaveText("扫描服务机器上的目录");
  await expect(page.locator("#scan-path")).toHaveAttribute("placeholder", "/media/jav");
  await expect(page.locator("#scan-go")).toBeDisabled();
  await expect(page.locator("#scan-results")).toBeHidden();
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

test("页脚与 modal/toast 结构（JAVSCRIBE-CLIENT）", async ({ page }) => {
  await expect(page.locator("footer .mono").first()).toHaveText("JAVSCRIBE-CLIENT");
  await expect(page.locator("footer #foot-ver")).toHaveText("v0.2.2");
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
  // 地址不是超链接：跳转按钮是独立小飞机（eng-go），地址文本本身无 <a>
  const go = card.locator(".eng-go");
  await expect(go).toHaveAttribute("href", MOCK);
  await expect(go.locator("svg")).toHaveCount(1);
  const urlTxt = card.locator(".eng-url-txt");
  expect(await urlTxt.innerHTML()).not.toContain("<a");
  await expect(urlTxt).toHaveText(MOCK);
  const tags = card.locator(".eng-specs .tag");
  await expect(tags).toHaveCount(3);
  expect(await tags.evaluateAll((els) => els.map((e) => e.textContent))).toEqual(["cuda", "v0.1.0", "运行 0"]);
});

test("监听面板结构（桌面形态：灯 + 文案 + 输入 + 选择/启停 + 状态行）", async ({ page }) => {
  await expect(page.locator("#watch-panel")).toBeVisible();
  await expect(page.locator("#watch-panel .watch-title")).toContainText("监听本机文件夹");
  await expect(page.locator("#watch-lamp")).toBeVisible();
  await expect(page.locator("#watch-path")).toHaveAttribute("placeholder", "选择本机上的文件夹");
  await expect(page.locator("#watch-pick")).toHaveText("选择文件夹");
  await expect(page.locator("#watch-toggle")).toHaveText("开始监听");
  await expect(page.locator("#watch-toggle")).toBeDisabled(); // 初始无路径
});

test("engines-empty 文案为桌面环境变量名", async ({ page }) => {
  // env 预置 mock 时该空态隐藏，但 DOM 仍在：断言文案已是 JAVSCRIBE_ENGINES
  await expect(page.locator("#engines-empty")).toContainText("JAVSCRIBE_ENGINES");
  await expect(page.locator("#engines-empty")).not.toContainText("JAV_ENGINES=");
});

test("页面源码不引 ffmpeg.wasm（提取由 main 进程承担）", async ({ page }) => {
  const html = await page.content();
  expect(html).not.toContain("/lib/ffmpeg.js");
  expect(html).not.toContain("ffmpeg-core");
  // 页面源码标题是桌面端
  expect(html).toContain("<title>JavScribe Client</title>");
});
