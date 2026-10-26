// 设置 tab（桌面形态）：客户端 pane（并发卡 + 仅桌面区 更新设置/文件夹监听）+
// 服务端 pane 骨架（子 tab + 服务下拉 __all__+每引擎）；
// userData 独立文件持久化（client-config.json；与 settings.json/watch.json 分文件，重启仍在）
import { test, expect, goView, relaunch } from "./helpers";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

test("设置 tab（桌面形态）：客户端 pane 默认 on + 子 tab/服务端下拉骨架 + 仅桌面区", async ({ page }) => {
  await goView(page, "ccfg");
  await expect(page.locator("#sec-ccfg")).toHaveClass(/view-on/);
  await expect(page.locator("#sec-ccfg h2")).toHaveText("设置");
  // 0246 A：页内子 tab（客户端默认 on）+ 服务端下拉 = __all__ + 每引擎一项
  expect(await page.locator(".cc-subtabs .cfg-tab").evaluateAll((els) => els.map((e) => e.textContent))).toEqual(["客户端", "服务端"]);
  await expect(page.locator('#sec-ccfg .cc-subtabs .cfg-tab[data-cctab="client"]')).toHaveClass(/on/);
  const engCount = await page.locator("#sec-engines article.eng").count();
  await expect(page.locator("#srv-sel option")).toHaveCount(engCount + 1);
  expect(await page.locator("#srv-sel option").first().getAttribute("value")).toBe("__all__");
  // 并发卡（web/桌面一致项，范围校验原样）
  await expect(page.locator("#ccfg-extract_workers")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#ccfg-extract_workers")).toHaveAttribute("min", "1");
  await expect(page.locator("#ccfg-extract_workers")).toHaveAttribute("max", "8");
  await expect(page.locator("#ccfg-queue_cap")).toHaveAttribute("min", "1");
  await expect(page.locator("#ccfg-queue_cap")).toHaveAttribute("max", "16");
  // 桌面专属区标「仅桌面」：更新设置（settings.json 同源）+ 文件夹监听（watch.json 同源）
  // + 日志中心（0.2.62；ring 内存态 + daily 文件，与两文件分源）
  await expect(page.locator("#sec-ccfg .cc-only-badge", { hasText: "仅桌面" })).toHaveCount(3);
  await expect(page.locator("#cc-up-enabled")).toBeVisible();
  await expect(page.locator("#cc-up-mirror")).toBeVisible();
  await expect(page.locator("#cc-up-proxy")).toBeVisible();
  await expect(page.locator("#cc-watch-pick")).toBeVisible();
  await expect(page.locator("#cc-watch-toggle")).toBeVisible();
});

test("设置 tab（客户端 pane）：改并发保存 → client-config.json 独立落盘 → 重启后仍在", async ({ app, userData, page }) => {
  await goView(page, "ccfg");
  await expect(page.locator("#ccfg-extract_workers")).toBeVisible({ timeout: 10_000 });
  await page.locator("#ccfg-extract_workers").fill("5");
  await page.locator("#ccfg-queue_cap").fill("7");
  await page.click("#ccfg-save");
  await expect(page.locator("#toasts .toast.ok", { hasText: "客户端设置已保存" })).toBeVisible({ timeout: 10_000 });
  // 独立文件持久化（userData/client-config.json；不混写 settings.json/watch.json）
  const cfgFile = join(userData, "client-config.json");
  expect(existsSync(cfgFile)).toBe(true);
  // 0.2.47：新增 vram_free_min_gb（空闲显存阈值，缺省 5）随表单整体落盘
  expect(JSON.parse(readFileSync(cfgFile, "utf-8"))).toEqual({ extract_workers: 5, queue_cap: 7, vram_free_min_gb: 5 });
  // 同 userData 重启 → 读回保存值
  await app.close();
  const r = await relaunch(userData);
  try {
    await goView(r.page, "ccfg");
    await expect(r.page.locator("#ccfg-extract_workers")).toHaveValue("5", { timeout: 10_000 });
    await expect(r.page.locator("#ccfg-queue_cap")).toHaveValue("7");
  } finally {
    await r.app.close().catch(() => {});
  }
});

test("设置页：子 tab 无调试残留文本（回归：模板字符串内注释外泄 // cc-pane client）", async ({ page }) => {
  await goView(page, "ccfg");
  await page.click('.cc-subtabs .cfg-tab[data-cctab="server"]');
  await expect(page.locator("#srv-sel")).toBeVisible({ timeout: 10_000 });
  const leak = await page.evaluate(() =>
    document.querySelector("#sec-ccfg")?.textContent.includes("// cc-pane") ?? false);
  expect(leak).toBe(false);
});

test("设置页：未保存改动保护（切服务/切视图均确认，取消则留在原地、下拉回退）", async ({ page }) => {
  await goView(page, "ccfg");
  await page.click('.cc-subtabs .cfg-tab[data-cctab="server"]');
  await page.selectOption("#srv-sel", "mock");
  await expect(page.locator("#srv-body #cfg-save")).toBeVisible({ timeout: 15_000 });
  // 弄脏单服务表单
  await page.locator("#cfg-subtitle-lang_tag").fill("en");
  await expect(page.locator("#cfg-dirty")).toHaveText("有 1 项未保存");
  // 守卫在 handler 里同步 confirm（阻塞渲染器）→ 测试须先挂 dialog 处理，动作才能返回
  // 1) dirty 时切服务 → confirm；取消 → 下拉回退、表单保持
  const d1: { msg: string | null } = { msg: null };
  page.once("dialog", (d) => { d1.msg = d.message(); void d.dismiss(); });
  await page.selectOption("#srv-sel", "__all__");
  expect(d1.msg).toContain("未保存");
  await expect(page.locator("#srv-sel")).toHaveValue("mock");
  await expect(page.locator("#cfg-subtitle-lang_tag")).toHaveValue("en");
  // 2) dirty 时切走视图 → confirm；取消 → 仍在设置视图
  const d2: { msg: string | null } = { msg: null };
  page.once("dialog", (d) => { d2.msg = d.message(); void d.dismiss(); });
  await page.click('#nav .view-tab[data-view="engines"]');
  expect(d2.msg).toContain("未保存");
  await expect(page.locator("#sec-ccfg")).toHaveClass(/view-on/);
  // 3) 接受确认 → 切换生效（设置页整体重渲染，未保存值丢弃）
  const d3: { msg: string | null } = { msg: null };
  page.once("dialog", (d) => { d3.msg = d.message(); void d.accept(); });
  await page.click('#nav .view-tab[data-view="engines"]');
  expect(d3.msg).toContain("未保存");
  await expect(page.locator("#sec-engines")).toHaveClass(/view-on/);
});

test("设置页（客户端 pane）：扫描卡触改不误标「进入子目录」复选框行（回归：base 1/0 与 true/false 失配恒脏）", async ({ page }) => {
  await goView(page, "ccfg");
  await expect(page.locator("#cc-scan-exts")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#cc-scan-dirty")).toHaveText("无改动");
  await page.locator("#cc-scan-exts").fill("mp4,mkv");
  await expect(page.locator("#cc-scan-dirty")).toHaveText("有 1 项未保存");
  // 只有扩展名行 dirty；复选框行（data-base 1/0 约定）不得误标
  expect(await page.locator("#sec-ccfg .cc-card[data-sec=ccfg-scan] .ccfg-row.dirty").count()).toBe(1);
});

test("设置页（桌面）：更新卡 dirty 追踪（改镜像源 → 计数 → 保存重置）", async ({ page }) => {
  await goView(page, "ccfg");
  await expect(page.locator("#cc-up-mirror")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#cc-up-dirty")).toHaveText("无改动");
  await page.locator("#cc-up-mirror").fill("https://mirror.example.com/");
  await expect(page.locator("#cc-up-dirty")).toHaveText("有 1 项未保存");
  await page.click("#cc-up-save");
  await expect(page.locator("#toasts .toast.ok", { hasText: "更新设置已保存" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#cc-up-dirty")).toHaveText("无改动");
  await expect(page.locator("#cc-up-mirror")).toHaveValue("https://mirror.example.com/");
});
