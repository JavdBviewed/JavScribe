// 日志中心（桌面形态）e2e（0.2.64 诊断级）：
//   1) 卡片结构：ccfg-logs 卡 + 4 按钮 + 过滤 select 选项齐（对照 app.ts ccfg-logs 卡 DOM）
//   2) logs-tail 捕获链路：页面 console.log 独特串 → renderer console-message 进环 → 切 ui 源 + 关键词可查到
//   3) 导出：main 的 logs-export 支持 env 后门 JAVSCRIBE_E2E_EXPORT_DIR（set 时跳过
//      showSaveDialog，直写 <dir>/jav-scribe-logs-<YYYY-MM-DD>.log；与 JAVSCRIBE_FFMPEG
//      / JAVSCRIBE_UPDATE_FEED 同款 e2e env 约定）→ 点 UI「导出」→ 轮询目录断言内容。
// 导出用例依赖 main 侧后门接线，接线完成前跑必红（预期）。
import { test, expect, goView, launchApp, waitForReady, CLIENT_VERSION } from "./helpers";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("日志中心卡（桌面形态）：ccfg-logs 卡 + 4 按钮 + select 选项齐", async ({ page }) => {
  await goView(page, "ccfg");
  const card = page.locator("#sec-ccfg .cc-card[data-sec=ccfg-logs]");
  await expect(card).toBeVisible({ timeout: 10_000 });
  // 标题 + 「仅桌面」角标 + 描述（环容量 / 保留期文案）
  await expect(card.locator("h4.cfg-sec-title")).toContainText("日志中心");
  await expect(card.locator(".cc-only-badge")).toHaveText("仅桌面");
  await expect(card.locator(".cfg-sec-desc")).toContainText("内存环 2 万条");
  // 4 个按钮：刷新 / 复制 / 导出 / 清空（顺序即 DOM 顺序）
  const btns = card.locator(".ccfg-foot .btn");
  await expect(btns).toHaveCount(4);
  expect(await btns.evaluateAll((els) => els.map((e) => e.textContent))).toEqual(["刷新", "复制", "导出", "清空"]);
  expect(await btns.evaluateAll((els) => els.map((e) => e.id))).toEqual([
    "cc-logs-refresh", "cc-logs-copy", "cc-logs-export", "cc-logs-clear",
  ]);
  // 过滤控件：来源（全部/主进程/页面/内嵌 serve）+ 最低级别（全 5 档）+ 关键词 + 自动刷新
  expect(await card.locator("#cc-logs-source option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value)))
    .toEqual(["all", "main", "ui", "serve"]);
  expect(await card.locator("#cc-logs-source option").evaluateAll((els) => els.map((e) => e.textContent)))
    .toEqual(["全部", "主进程", "页面", "内嵌 serve"]);
  expect(await card.locator("#cc-logs-level option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value)))
    .toEqual(["", "debug", "info", "warn", "error"]);
  await expect(card.locator("#cc-logs-q")).toBeVisible();
  await expect(card.locator("#cc-logs-auto")).toBeVisible();
  // 输出区 + 状态行
  await expect(card.locator("#cc-logs-out.cc-logs-pre")).toBeVisible();
  await expect(card.locator("#cc-logs-note")).toBeVisible();
});

test("logs-tail：页面 console.log 独特串 → 切 ui 源可查到（renderer 捕获链路）", async ({ page }) => {
  await goView(page, "ccfg");
  await expect(page.locator("#cc-logs-out")).toBeVisible({ timeout: 10_000 });
  // 页面里 console.log 一行独特串 → main 的 console-message 挂钩推入环（src=ui，info）
  const marker = `logcenter-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await page.evaluate((m) => console.log(m), marker);
  // ui 源 + 关键词过滤后应能查到该行
  await page.selectOption("#cc-logs-source", "ui");
  await page.locator("#cc-logs-q").fill(marker);
  // console-message 是跨进程消息，落环与 evaluate 返回无严格先后 → 轮询点「刷新」直到可查
  await expect
    .poll(async () => {
      await page.click("#cc-logs-refresh");
      return page.locator("#cc-logs-out").innerText();
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
    await goView(page, "ccfg");
    await expect(page.locator("#cc-logs-out")).toBeVisible({ timeout: 10_000 });
    await page.click("#cc-logs-export");
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
