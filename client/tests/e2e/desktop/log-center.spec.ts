// 日志中心（桌面形态）e2e（0.2.66：设置页卡片 → 侧边栏一级视图「日志」+ 独立页 UI）：
//   1) 独立页结构：侧边栏「日志」入口 + sec-logs（标题/kicker/4 按钮/过滤控件/统计/输出区/状态行）
//   2) 自动刷新默认开：页面 console.log 独特串 → 落环 → 不点刷新也轮询进输出区
//   3) logs-tail 捕获链路：页面 console.log 独特串 → 切 ui 源 + 关键词 → 手动刷新可查
//   4) 导出：main 的 logs-export 支持 env 后门 JAVSCRIBE_E2E_EXPORT_DIR（set 时跳过
//      showSaveDialog，直写 <dir>/jav-scribe-logs-<YYYY-MM-DD>.log；与 JAVSCRIBE_FFMPEG
//      / JAVSCRIBE_UPDATE_FEED 同款 e2e env 约定）→ 点 UI「导出」→ 轮询目录断言内容。
import { test, expect, goView, launchApp, waitForReady, CLIENT_VERSION } from "./helpers";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("日志中心独立页：侧边栏「日志」入口 + 页面结构（标题/4 按钮/过滤控件/统计/输出区）", async ({ page }) => {
  // 侧边栏一级入口（位于「设置」之后）
  await expect(page.locator('#nav .view-tab[data-view="logs"] > span')).toHaveText("日志");
  await goView(page, "logs");
  const sec = page.locator("#sec-logs");
  await expect(sec).toHaveClass(/view-on/);
  await expect(sec.locator("h2")).toHaveText("日志中心");
  await expect(sec.locator(".kicker")).toHaveText("Logs");
  // 4 个动作按钮（DOM 顺序）：刷新 / 复制 / 导出 / 清空
  const btns = sec.locator(".sec-head .btn");
  expect(await btns.evaluateAll((els) => els.map((e) => e.textContent))).toEqual(["刷新", "复制", "导出", "清空"]);
  expect(await btns.evaluateAll((els) => els.map((e) => e.id))).toEqual([
    "logs-refresh", "logs-copy", "logs-export", "logs-clear",
  ]);
  // 过滤控件：来源（4 档）+ 最低级别（5 档）+ 关键词 + 自动刷新（默认开）
  expect(await page.locator("#logs-source option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value)))
    .toEqual(["all", "main", "ui", "serve"]);
  expect(await page.locator("#logs-source option").evaluateAll((els) => els.map((e) => e.textContent)))
    .toEqual(["全部", "主进程", "页面", "内嵌 serve"]);
  expect(await page.locator("#logs-level option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value)))
    .toEqual(["", "debug", "info", "warn", "error"]);
  await expect(page.locator("#logs-q")).toBeVisible();
  await expect(page.locator("#logs-auto")).toBeChecked();
  // 输出区 + 统计 chip + 状态行
  await expect(page.locator("#logs-out")).toBeVisible();
  await expect(page.locator("#logs-stats")).toBeVisible();
  await expect(page.locator("#logs-note")).toBeVisible();
  // 冷启动主进程日志已入环 → 状态行落「环 N 条」，统计 chip 有「N 条」
  await expect(page.locator("#logs-note")).toContainText("环", { timeout: 10_000 });
  await expect(page.locator("#logs-stats .stat")).toHaveCount(3);
});

test("日志中心：自动刷新默认开 — 页面 console.log 独特串不点刷新也进输出区", async ({ page }) => {
  await goView(page, "logs");
  await expect(page.locator("#logs-out")).toBeVisible({ timeout: 10_000 });
  // 页面里 console.log 一行独特串 → main 的 console-message 挂钩推入环（src=ui，info）
  const marker = `logcenter-auto-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await page.evaluate((m) => console.log(m), marker);
  // 不点「刷新」：自动刷新（2s 轮询）应自行把该行带进输出区
  await expect(page.locator("#logs-out")).toContainText(marker, { timeout: 15_000 });
});

test("logs-tail：页面 console.log 独特串 → 切 ui 源 + 关键词，手动刷新可查（renderer 捕获链路）", async ({ page }) => {
  await goView(page, "logs");
  await expect(page.locator("#logs-out")).toBeVisible({ timeout: 10_000 });
  const marker = `logcenter-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await page.evaluate((m) => console.log(m), marker);
  // ui 源 + 关键词过滤后应能查到该行
  await page.selectOption("#logs-source", "ui");
  await page.locator("#logs-q").fill(marker);
  // console-message 是跨进程消息，落环与 evaluate 返回无严格先后 → 轮询点「刷新」直到可查
  await expect
    .poll(async () => {
      await page.click("#logs-refresh");
      return page.locator("#logs-out").innerText();
    }, { timeout: 15_000 })
    .toContain(marker);
});

test("导出（env 后门 JAVSCRIBE_E2E_EXPORT_DIR）：点 UI 导出 → 直写文件 → 元信息头 + 版本 + runtime + serve 段", async ({ userData }) => {
  // 导出目标指向 userData 下子目录（每用例全新 userData，天然隔离；同日重跑覆盖同名文件无碍）
  const exportDir = join(userData, "e2e-export");
  mkdirSync(exportDir, { recursive: true });
  const app = await launchApp(userData, { JAVSCRIBE_E2E_EXPORT_DIR: exportDir });
  try {
    const page = await app.firstWindow();
    await waitForReady(page);
    await goView(page, "logs");
    await expect(page.locator("#logs-out")).toBeVisible({ timeout: 10_000 });
    await page.click("#logs-export");
    // UI 侧：导出成功 toast（带落盘路径）
    await expect(page.locator("#toasts .toast.ok", { hasText: "已导出" })).toBeVisible({ timeout: 15_000 });
    // 文件侧：轮询目录下生成 jav-scribe-logs-<YYYY-MM-DD>.log
    let file: string | undefined;
    await expect
      .poll(() => {
        file = readdirSync(exportDir).find((f) => /^jav-scribe-logs-\d{4}-\d{2}-\d{2}\.log$/.test(f));
        return !!file;
      }, { timeout: 15_000 })
      .toBe(true);
    const text = readFileSync(join(exportDir, file!), "utf-8");
    // 元信息头：首行标识 + 版本（package.json 单一事实源）+ runtime 行
    expect(text.split("\n")[0]).toBe("# JavScribe Client 日志导出");
    expect(text).toContain(`# version: ${CLIENT_VERSION}`);
    expect(text).toContain("# runtime: electron");
    // 内嵌 serve 日志段标记
    expect(text).toContain("── 内嵌 serve 日志");
  } finally {
    await app.close().catch(() => {});
  }
});
