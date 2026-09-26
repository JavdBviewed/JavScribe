// 服务端（serve）新版本检查（desktop 形态）：服务端无自有界面，新版本提示落在「字幕服务」卡片
//  - main 进程拉 GitHub Releases API（mock-github 8306；env JAVSCRIBE_UPDATE_GITHUB_BASE / INTERVAL=3s，e2e 零外网）
//  - mock serve（8302）上报 0.1.0 = mock-github 默认 serve-v0.1.0 → 「同版本无角标」基线
//  - 用例内切 serve-v0.2.0 → 卡片角标「更新至 v0.2.0 ↗」，href 指向 Release 页
//  - afterAll 复位 mock-github：角标状态不得泄漏到后续 spec 的快照
import { test, expect, goView, type APIRequestContext } from "./helpers";

const GITHUB = "http://127.0.0.1:8306";

async function ghSetReleases(req: APIRequestContext, body: unknown) {
  const r = await req.post(`${GITHUB}/_mock/releases`, {
    data: body,
    headers: { "Content-Type": "application/json" },
  });
  if (!r.ok()) throw new Error(`mock-github releases -> ${r.status()}`);
}

async function ghReset(req: APIRequestContext) {
  const r = await req.post(`${GITHUB}/_mock/reset`, {
    data: "{}",
    headers: { "Content-Type": "application/json" },
  });
  if (!r.ok()) throw new Error(`mock-github reset -> ${r.status()}`);
}

test.afterAll(async ({ request }) => {
  await ghReset(request);
});

test("服务端同版本：服务卡片无角标", async ({ app, page, request }) => {
  await ghReset(request);
  // 引擎卡片在「字幕服务」侧边栏视图（默认视图=生成字幕），先切过去再断言
  await goView(page, "engines");
  // 等 ≥2 个刷新周期（main 首轮 GitHub 拉取 + 渲染），确认基线无角标
  await page.waitForTimeout(7_000);
  const card = page.locator("#engine-grid .eng");
  await expect(card).toHaveCount(1);
  await expect(card.locator(".tag", { hasText: "v0.1.0" })).toBeVisible();
  await expect(card.locator(".tag-up")).toHaveCount(0);
});

test("服务端新版本：卡片角标「更新至 vX ↗」+ Release 链接", async ({ app, page, request }) => {
  await ghReset(request);
  await ghSetReleases(request, { app: "serve-v0.2.0" });
  try {
    await goView(page, "engines");
    const badge = page.locator("#engine-grid .eng .tag-up");
    // main 3s 间隔重拉 + 页面 5s 刷新 → 角标出现
    await expect(badge).toHaveCount(1, { timeout: 30_000 });
    await expect(badge).toHaveText("更新至 v0.2.0 ↗");
    await expect(badge).toHaveAttribute(
      "href",
      "https://github.com/JavdBviewed/JavScribe/releases/tag/serve-v0.2.0",
    );
    // 原版本 tag 保留（角标是追加，不替换上报版本）
    await expect(page.locator("#engine-grid .eng .tag", { hasText: "v0.1.0" })).toBeVisible();
  } finally {
    // 立即复位 mock：缩小「serve-v0.2.0 为最新」的窗口，避免其它 spec 冷启动误捡角标打挂 tag 计数
    await ghReset(request);
  }
});
