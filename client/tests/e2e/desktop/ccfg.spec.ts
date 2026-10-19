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
  await expect(page.locator("#sec-ccfg .cc-only-badge", { hasText: "仅桌面" })).toHaveCount(2);
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
