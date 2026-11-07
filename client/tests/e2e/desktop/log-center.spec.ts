// 日志中心（桌面形态）e2e（0.2.66：设置页卡片 → 侧边栏一级视图「日志」+ 独立页 UI）：
//   1) 独立页结构：侧边栏「日志」入口 + sec-logs（标题/kicker/4 按钮/过滤控件/统计/输出区/状态行）
//   2) 自动刷新默认开：页面 console.log 独特串 → 落环 → 不点刷新也轮询进输出区
//   3) logs-tail 捕获链路：页面 console.log 独特串 → 切 ui 源 + 关键词 → 手动刷新可查
//   4) 导出：main 的 logs-export 支持 env 后门 JAVSCRIBE_E2E_EXPORT_DIR（set 时跳过
//      showSaveDialog，直写 <dir>/jav-scribe-logs-<YYYY-MM-DD>.log；与 JAVSCRIBE_FFMPEG
//      / JAVSCRIBE_UPDATE_FEED 同款 e2e env 约定）→ 点 UI「导出」→ 轮询目录断言内容。
import { test, expect, goView, launchApp, waitForReady, CLIENT_VERSION } from "./helpers";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("日志中心独立页：侧边栏「日志」入口 + 页面结构（标题/4 按钮/过滤控件/统计/输出区）", async ({ page }) => {
  // 侧边栏一级入口（位于「设置」之后）
  await expect(page.locator('#nav .view-tab[data-view="logs"] > span')).toHaveText("日志");
  await goView(page, "logs");
  const sec = page.locator("#sec-logs");
  await expect(sec).toHaveClass(/view-on/);
  await expect(sec.locator("h2")).toHaveText("日志中心");
  await expect(sec.locator(".kicker")).toHaveText("Logs");
  // 动作按钮（DOM 顺序）
  const btns = sec.locator(".sec-head .btn");
  expect(await btns.evaluateAll((els) => els.map((e) => e.textContent))).toEqual(["刷新", "复制", "导出", "清内存", "删除历史"]);
  expect(await btns.evaluateAll((els) => els.map((e) => e.id))).toEqual([
    "logs-refresh", "logs-copy", "logs-export", "logs-clear", "logs-clear-history",
  ]);
  // 过滤控件：来源（4 档）+ 最低级别（5 档）+ 关键词 + 自动刷新（默认开）
  expect(await page.locator("#logs-source option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value)))
    .toEqual(["all", "main", "ui", "serve"]);
  expect(await page.locator("#logs-source option").evaluateAll((els) => els.map((e) => e.textContent)))
    .toEqual(["全部", "主进程", "页面", "内嵌 serve"]);
  expect(await page.locator("#logs-level option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value)))
    .toEqual(["", "debug", "info", "warn", "error"]);
  await expect(page.locator("#logs-q")).toBeVisible();
  await expect(page.locator("#logs-from")).toBeVisible();
  await expect(page.locator("#logs-to")).toBeVisible();
  await expect(page.locator("#logs-page")).toBeVisible();
  await expect(page.locator("#logs-auto")).toBeChecked();
  // 输出区 + 统计 chip + 状态行
  await expect(page.locator("#logs-out")).toBeVisible();
  await expect(page.locator("#logs-stats")).toBeVisible();
  await expect(page.locator("#logs-note")).toBeVisible();
  // 冷启动主进程日志已入环 → 状态行落「环 N 条」，统计 chip 有「N 条」
  await expect(page.locator("#logs-note")).toContainText("共", { timeout: 10_000 });
  await expect(page.locator("#logs-stats .stat")).toHaveCount(3);
});

test("日志页紧凑窗口：筛选与分页可操作，无横向溢出", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await goView(page, "logs");
  await expect(page.locator("#logs-from")).toBeVisible();
  await expect(page.locator("#logs-to")).toBeVisible();
  await expect(page.locator("#logs-next")).toBeVisible();
  await expect(page.locator("#logs-clear-history")).toBeVisible();
  const layout = await page.evaluate(() => {
    const filter = document.querySelector(".logs-bar")?.getBoundingClientRect();
    const output = document.querySelector("#logs-out")?.getBoundingClientRect();
    const pager = document.querySelector(".logs-pager")?.getBoundingClientRect();
    return { overflow: document.documentElement.scrollWidth - window.innerWidth,
      order: !!filter && !!output && !!pager && filter.bottom <= output.top && output.bottom <= pager.top };
  });
  expect(layout.overflow).toBeLessThanOrEqual(0);
  expect(layout.order).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("logs-compact.png") });
});

test("大日志查询放到后台，主进程 IPC 不等待多日文件解析", async ({ userData }) => {
  const dir = join(userData, "logs");
  mkdirSync(dir, { recursive: true });
  for (let day = 1; day <= 7; day++) {
    const date = `2026-11-${String(day).padStart(2, "0")}`;
    const line = `${date} 10:01:00.001 [info] [main] perf-marker-${day} ${"x".repeat(700)}\n`;
    writeFileSync(join(dir, `jav-scribe-${date}.log`), line.repeat(10_000));
  }
  const app = await launchApp(userData);
  try {
    const page = await app.firstWindow();
    await waitForReady(page);
    const result = await page.evaluate(async () => {
      const bridge = (window as any).javDesktop.logs;
      const query = bridge.query({ q: "perf-marker", page: 1, pageSize: 10 });
      const ping = bridge.tail(1).then(() => "main-responsive");
      const first = await Promise.race([query.then(() => "query-finished"), ping]);
      const history = await query;
      return { first, total: history.total };
    });
    expect(result.first).toBe("main-responsive");
    expect(result.total).toBe(70_000);
  } finally { await app.close(); }
});

test("历史日志：日期、来源和关键词筛选后可分页，清理后重启不回归", async ({ userData }) => {
  const dir = join(userData, "logs");
  mkdirSync(dir, { recursive: true });
  const old = "2026-11-01";
  const recent = "2026-11-02";
  const oldFile = join(dir, `jav-scribe-${old}.log`);
  const recentFile = join(dir, `jav-scribe-${recent}.log`);
  writeFileSync(oldFile, Array.from({ length: 120 }, (_, n) => `${old} 10:01:00.001 [warn] [ui] old-marker-${n}`).join("\n") + "\n");
  writeFileSync(recentFile, `${recent} 10:01:00.001 [error] [main] recent-marker\n`);
  writeFileSync(join(dir, "unmanaged.log"), "untouched");
  const app = await launchApp(userData);
  try {
    const page = await app.firstWindow();
    await waitForReady(page);
    await goView(page, "logs");
    await page.locator("#logs-from").fill(old);
    await page.locator("#logs-to").fill(old);
    await page.locator("#logs-q").fill("old-marker");
    await expect(page.locator("#logs-note")).toContainText("共 120 条");
    await expect(page.locator("#logs-page")).toHaveText("1 / 2 页");
    await expect(page.locator("#logs-out .log-line")).toHaveCount(100);
    await page.locator("#logs-next").click();
    await expect(page.locator("#logs-page")).toHaveText("2 / 2 页");
    await expect(page.locator("#logs-out .log-line")).toHaveCount(20);
    await page.locator("#logs-clear").click();
    await expect(page.locator("#logs-note")).toContainText("共 120 条");
    const dailyCount = readdirSync(dir).filter((name) => /^jav-scribe-\d{4}-\d{2}-\d{2}\.log$/.test(name)).length;
    page.on("dialog", async (d) => {
      if (d.message().includes("删除本机")) await d.accept();
      else await d.dismiss();
    });
    await page.locator("#logs-clear-history").click();
    await expect(page.locator("#toasts .toast.ok", { hasText: `已删除 ${dailyCount} 个每日文件` })).toBeVisible();
    await expect(page.locator("#logs-note")).toContainText("共 0 条");
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(recentFile)).toBe(false);
    expect(readFileSync(join(dir, "unmanaged.log"), "utf8")).toBe("untouched");
    const afterClear = `after-clear-${Date.now()}`;
    await page.evaluate((marker) => console.log(marker), afterClear);
    await expect.poll(() => readdirSync(dir).some((name) => name.startsWith("jav-scribe-") && readFileSync(join(dir, name), "utf8").includes(afterClear))).toBe(true);
  } finally { await app.close(); }
  const app2 = await launchApp(userData);
  try {
    const page = await app2.firstWindow();
    await waitForReady(page);
    await goView(page, "logs");
    await page.locator("#logs-q").fill("old-marker");
    await expect(page.locator("#logs-note")).toContainText("共 0 条");
  } finally { await app2.close(); }
});

test("历史查询与删除不跟随日志符号链接", async ({ userData }) => {
  test.skip(process.platform === "win32", "Windows 测试环境可能禁止创建符号链接");
  const dir = join(userData, "logs");
  mkdirSync(dir, { recursive: true });
  const sentinel = join(userData, "untouched.txt");
  writeFileSync(sentinel, "2026-11-01 10:01:00.001 [error] [main] secret-marker\n");
  const dailyLink = join(dir, "jav-scribe-2026-11-01.log");
  const serveLink = join(userData, "local-serve.log");
  symlinkSync(sentinel, dailyLink);
  symlinkSync(sentinel, serveLink);
  const exportDir = join(userData, "export");
  const app = await launchApp(userData, { JAVSCRIBE_E2E_EXPORT_DIR: exportDir });
  try {
    const page = await app.firstWindow();
    await waitForReady(page);
    const r = await page.evaluate(async () => (window as any).javDesktop.logs.query({ page: 1, pageSize: 100 }));
    expect(r.lines.join("\n")).not.toContain("secret-marker");
    const cleared = await page.evaluate(async () => (window as any).javDesktop.logs.clearHistory({ serve: true }));
    expect(cleared.serveCleared).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toContain("secret-marker");
    expect(existsSync(dailyLink)).toBe(true);
    const out = await page.evaluate(async () => (window as any).javDesktop.logs.export());
    expect(out).toBeTruthy();
    expect(readFileSync(out, "utf8")).not.toContain("secret-marker");
  } finally { await app.close(); }
});

test("日志目录为符号链接时不读取、导出或删除目标目录", async ({ userData }) => {
  test.skip(process.platform === "win32", "Windows 测试环境可能禁止创建符号链接");
  const other = join(userData, "other");
  mkdirSync(other, { recursive: true });
  const sentinel = join(other, "jav-scribe-2026-11-01.log");
  writeFileSync(sentinel, "2026-11-01 10:01:00.001 [error] [main] directory-secret\n");
  symlinkSync(other, join(userData, "logs"), "dir");
  const app = await launchApp(userData, { JAVSCRIBE_E2E_EXPORT_DIR: join(userData, "export") });
  try {
    const page = await app.firstWindow();
    await waitForReady(page);
    const queried = await page.evaluate(async () => (window as any).javDesktop.logs.query({ page: 1, pageSize: 100 }));
    expect(queried.lines.join("\n")).not.toContain("directory-secret");
    const cleared = await page.evaluate(async () => (window as any).javDesktop.logs.clearHistory());
    expect(cleared.deleted).toBe(0);
    const out = await page.evaluate(async () => (window as any).javDesktop.logs.export());
    expect(readFileSync(out, "utf8")).not.toContain("directory-secret");
    expect(readFileSync(sentinel, "utf8")).toContain("directory-secret");
  } finally { await app.close(); }
});

test("当日日志文件为符号链接时只记录内存环，不追加到外部文件", async ({ userData }) => {
  test.skip(process.platform === "win32", "Windows 测试环境可能禁止创建符号链接");
  const dir = join(userData, "logs");
  mkdirSync(dir, { recursive: true });
  const date = new Date();
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const sentinel = join(userData, "external.txt");
  writeFileSync(sentinel, "external-sentinel\n");
  symlinkSync(sentinel, join(dir, `jav-scribe-${stamp}.log`));
  const app = await launchApp(userData);
  try {
    const page = await app.firstWindow();
    await waitForReady(page);
    const marker = `memory-only-${Date.now()}`;
    await page.evaluate((m) => console.log(m), marker);
    await goView(page, "logs");
    await page.locator("#logs-q").fill(marker);
    await expect(page.locator("#logs-out")).toContainText(marker);
    expect(readFileSync(sentinel, "utf8")).toBe("external-sentinel\n");
  } finally { await app.close(); }
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

test("全新用户目录首次写日志会建每日文件，重启仍可按日期检索", async ({ userData }) => {
  const app = await launchApp(userData);
  const marker = `persistent-log-${Date.now()}`;
  try {
    const page = await app.firstWindow();
    await waitForReady(page);
    await page.evaluate((m) => console.log(m), marker);
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const file = join(userData, "logs", `jav-scribe-${date}.log`);
    await expect.poll(() => existsSync(file) && readFileSync(file, "utf8").includes(marker)).toBe(true);
  } finally { await app.close(); }
  const app2 = await launchApp(userData);
  try {
    const page = await app2.firstWindow();
    await waitForReady(page);
    const r = await page.evaluate(async (m) => (window as any).javDesktop.logs.query({ q: m, page: 1, pageSize: 100 }), marker);
    expect(r.total).toBe(1);
  } finally { await app2.close(); }
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
