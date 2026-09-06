// 功能类：版本检查与更新引导（web 形态 = 工作台 /api/update 版本对比 + 更新命令复制）
//  - mock-github（127.0.0.1:8303）提供 GitHub Releases API（默认与当前版本一致 → 无角标）
//  - 工作台 env：JAV_UPDATE_INTERVAL_S=3（后台循环 3s 拉一次，角标出现 ≤~5s）
//  - 版本判定：latest tag v* > 工作台版本 0.1.0 → 角标「新版本 vX」
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { WEB_URL, MOCK_URL, mockReset, cleanEngines, waitForEngineOnline, freezeForShot, shot } from "../helpers";

const GITHUB = "http://127.0.0.1:8303";

async function ghControl(req: APIRequestContext, path: string, body?: unknown) {
  const r = await req.post(`${GITHUB}${path}`, {
    data: body === undefined ? "{}" : body,
    headers: { "Content-Type": "application/json" },
  });
  if (!r.ok()) throw new Error(`mock-github ${path} -> ${r.status()}`);
}

const ghReset = (req: APIRequestContext) => ghControl(req, "/_mock/reset");
const ghSetReleases = (req: APIRequestContext, body: unknown) => ghControl(req, "/_mock/releases", body);

let req: APIRequestContext;
test.beforeEach(async ({ page, request }) => {
  req = request;
  await mockReset(request);
  await cleanEngines(request);
  await ghReset(request); // mock-github 恢复默认（v0.1.0/client-v0.1.0 = 当前版本）
  await page.goto("/");
  await waitForEngineOnline(page);
});

test("同版本：无更新角标，/api/update 结构正确", async ({ page }) => {
  // 启动竞态：webServer 就绪只保证 8303 在听，而 web 的首次检查发生在 mock-github
  // 就绪前（webServer 顺序）→ 首轮必失败、次轮（+3s）才成功。等首轮成功再断言结构。
  await expect
    .poll(
      async () => (await (await req.get(`${WEB_URL}/api/update`)).json() as any).last_checked,
      { timeout: 20_000 },
    )
    .not.toBeNull();
  const u = (await (await req.get(`${WEB_URL}/api/update`)).json()) as any;
  expect(u.enabled).toBe(true);
  expect(u.current).toBe("0.1.0");
  expect(u.latest_app?.version).toBe("v0.1.0");
  expect(u.latest_client?.version).toBe("client-v0.1.0");
  expect(u.has_update).toBe(false);
  expect(u.commands.docker).toBe("docker compose pull && docker compose up -d");
  expect(u.commands.source).toBe("git fetch && git pull && docker compose up -d --build");
  // 页面侧：角标恒隐藏（同版本不误报）
  await expect(page.locator("#up-chip")).toBeHidden();
});

test("新版本：角标出现 → 弹窗 changelog/命令/复制/形态记忆", async ({ page, context }) => {
  await ghSetReleases(req, {
    app: "v0.2.0",
    client: "client-v0.2.0",
    body: "## v0.2.0\n- 修复显存并发问题\n- 新增批量下载",
  });
  // 后台循环 ≤3s 拉取 + 页面 5s 刷新 → 角标出现
  const chip = page.locator("#up-chip");
  await expect(chip).toBeVisible({ timeout: 20_000 });
  await expect(chip).toHaveText("新版本 v0.2.0");

  await chip.click();
  await expect(page.locator("#modal-title")).toHaveText("新版本 v0.2.0");
  await expect(page.locator(".up-changelog")).toContainText("修复显存并发问题");
  await expect(page.locator(".up-changelog")).toContainText("新增批量下载");
  await expect(page.locator(".set-note")).toContainText("当前工作台 v0.1.0 → 最新 v0.2.0");
  await expect(page.locator(".set-note")).toContainText("桌面端 JavScribe Client 已有 client-v0.2.0");
  // Release 链接指向 GitHub Releases
  await expect(page.locator(".up-link")).toHaveAttribute("href", "https://github.com/JavdBviewed/JavScribe/releases/tag/v0.2.0");

  // 默认 docker 命令
  await expect(page.locator("#up-cmd-text")).toHaveText("docker compose pull && docker compose up -d");
  // 复制（clipboard API，e2e 需授权）
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.click("#up-cmd-copy");
  await expect(page.locator(".toast.ok", { hasText: "命令已复制" })).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe("docker compose pull && docker compose up -d");

  // 切换源码形态 → 命令联动 + 重载后记忆
  await page.locator('input[name="up-cmd"][value="source"]').check();
  await expect(page.locator("#up-cmd-text")).toHaveText("git fetch && git pull && docker compose up -d --build");
  await page.click("#modal-x");
  await chip.click();
  await expect(page.locator('input[name="up-cmd"][value="source"]')).toBeChecked();
  await expect(page.locator("#up-cmd-text")).toHaveText("git fetch && git pull && docker compose up -d --build");
});

test("服务落后（工作台同版本）：同样提示更新", async ({ page }) => {
  // 工作台 current=0.1.0 与镜像 v0.1.0 持平，但已登记服务上报 0.0.1 → 仍提示更新
  await req.post(`${MOCK_URL}/_mock/version`, { data: { version: "0.0.1" }, headers: { "Content-Type": "application/json" } });
  // 等 poller 快照吃到新版本（JAV_POLL_INTERVAL_S=1）；相对路径走 baseURL
  await page.waitForFunction(
    async () => {
      const r = await fetch("/api/update", { cache: "no-store" });
      return (await r.json()).has_update === true;
    },
    undefined,
    { timeout: 15_000 },
  );
  const chip = page.locator("#up-chip");
  await expect(chip).toBeVisible({ timeout: 20_000 });
  await expect(chip).toHaveText("新版本 v0.1.0");
});

test("样式：更新角标与更新弹窗", async ({ page, context }) => {
  await ghSetReleases(req, {
    app: "v0.2.0",
    body: "## v0.2.0\n- 修复显存并发问题\n- 新增批量下载",
  });
  const chip = page.locator("#up-chip");
  await expect(chip).toBeVisible({ timeout: 20_000 });
  // 必须等文本刷到 v0.2.0：同文件前例把引擎降到 0.0.1，web poller 快照 + 页面 5s tick
  // 存在竞态窗口，chip 可能短暂显示上一个 latest（v0.1.0）——直接截图会拍到旧文案。
  await expect(chip).toHaveText("新版本 v0.2.0", { timeout: 20_000 });
  await freezeForShot(page, req);
  await shot(page, "update-01-chip", { element: "footer" });
  await chip.click();
  await expect(page.locator("#modal-title")).toHaveText("新版本 v0.2.0");
  await freezeForShot(page, req);
  await shot(page, "update-02-modal", { element: "#modal" });
});
