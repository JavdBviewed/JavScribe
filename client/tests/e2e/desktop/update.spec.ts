// 桌面端功能类：electron-updater 真实更新链路（打包形态 + mock-update-feed generic feed 8304）
//  - 前置：pnpm build:desktop && pnpm exec electron-builder --linux --x64 --dir --publish never
//    （产物缺失时整文件 skip，CI 在 build job 之后必然存在）
//  - 每 test 全新 userData（userData fixture：mockReset + 预置 engines.json），launchPackedApp
//    恒带 JAVSCRIBE_UPDATE_FEED=http://127.0.0.1:8304/ 与 JAVSCRIBE_NO_UPDATE_RELUNCH=1
//  - 打包形态启动 3s 后自动检查（main 的 UP_AUTO_CHECK_DELAY_MS）；feed 版本 9.9.9 > 应用 0.2.1
//  - 安装包 1.5MB 分块 64KB/25ms ≈ 0.6s 下载完，进度事件真实推进
import { test, expect, type APIRequestContext } from "./helpers";
import { PACKED_BIN, relaunchPacked, freezeForShot, shot } from "./helpers";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FEED = "http://127.0.0.1:8304";

test.skip(
  !existsSync(PACKED_BIN),
  "打包产物缺失——先 pnpm build:desktop && pnpm exec electron-builder --linux --x64 --dir --publish never",
);

/** 读 mock feed 已记录的清单请求（前缀匹配：electron-updater 拉 manifest 带 ?noCache= 查询串） */
async function manifestRequests(req: APIRequestContext): Promise<string[]> {
  const r = await req.post(`${FEED}/_mock/state`, {
    data: "{}",
    headers: { "Content-Type": "application/json" },
  });
  if (!r.ok()) throw new Error(`mock-update-feed state -> ${r.status()}`);
  return ((await r.json()) as { requests: string[] }).requests.filter((u) =>
    u.startsWith("/latest-linux.yml"),
  );
}

const CHIP = "#up-chip";

test("自动检查发现新版本 → 下载 → 重启安装 → 进程退出", async ({ userData, request }) => {
  const reqsBefore = await manifestRequests(request);
  const { app, page } = await relaunchPacked(userData);
  try {
    const chip = page.locator(CHIP);
    // 启动 3s 延迟自动检查 + electron-updater 拉 feed → 角标高亮「新版本 9.9.9」
    await expect(chip).toHaveText("新版本 9.9.9", { timeout: 30_000 });
    // 服务端佐证：本次自动检查确实拉了 linux x64 清单 latest-linux.yml（electron-builder 产物命名约定）
    expect((await manifestRequests(request)).length).toBeGreaterThan(reqsBefore.length);

    await chip.click();
    await expect(page.locator("#modal-title")).toHaveText("检查更新");
    await expect(page.locator(".set-note")).toContainText("当前 v0.2.1 → 最新 v9.9.9");
    await expect(page.locator(".up-changelog")).toContainText("e2e 测试内容");
    await expect(page.locator("#up-dl")).toBeVisible();
    await expect(page.locator("#up-later")).toBeVisible();
    await expect(page.locator("#up-ignore")).toBeVisible();

    // 下载并安装：autoUpdater.autoDownload=false，点击才下载；sha512 强校验通过 → downloaded
    await page.click("#up-dl");
    await expect(chip).toHaveText("重启安装 v9.9.9", { timeout: 30_000 });

    // 弹窗全程未关：状态推进后已原地重建为「downloaded」变体，直接「重启并安装」
    //（NO_UPDATE_RELUNCH=1 → app.quit，断言进程真退出）
    await expect(page.locator("#up-restart")).toBeVisible();
    const pid = app.process().pid;
    if (pid === undefined) throw new Error("electron 进程 pid 不可用");
    await page.click("#up-restart");
    await expect
      .poll(
        async () => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        },
        { timeout: 20_000, message: "重启安装后 electron 进程应退出（JAVSCRIBE_NO_UPDATE_RELUNCH=1）" },
      )
      .toBe(true);
  } finally {
    await app.close().catch(() => {}); // 已退出则忽略
  }
});

test("忽略此版本：落盘 ignored_versions，重启后自动检查静默跳过", async ({ userData, request }) => {
  const { app, page } = await relaunchPacked(userData);
  try {
    const chip = page.locator(CHIP);
    await expect(chip).toHaveText("新版本 9.9.9", { timeout: 30_000 });
    await chip.click();
    await expect(page.locator("#up-ignore")).toBeVisible();
    await page.click("#up-ignore");
    await expect(page.locator("#modal")).toBeHidden();
    // 忽略后回到 idle：角标「检查更新」（不高亮，仍可手动检查）
    await expect(chip).toHaveText("检查更新");
    const cfg = JSON.parse(readFileSync(join(userData, "settings.json"), "utf-8")) as {
      ignored_versions: string[];
    };
    expect(cfg.ignored_versions).toContain("9.9.9");
  } finally {
    await app.close().catch(() => {});
  }

  // 同 userData 再启：3s 自动检查真打了一次 feed（请求数 +1）但命中忽略列表 → 恒「检查更新」
  const before = (await manifestRequests(request)).length;
  const second = await relaunchPacked(userData);
  try {
    const chip = second.page.locator(CHIP);
    await expect(chip).toHaveText("检查更新");
    // 等自动检查（3s）+ 网络往返的富余
    await second.page.waitForTimeout(8_000);
    const after = (await manifestRequests(request)).length;
    expect(after).toBeGreaterThan(before); // 检查确实执行了
    await expect(chip).toHaveText("检查更新"); // 而非「新版本 9.9.9」→ 忽略生效
  } finally {
    await second.app.close().catch(() => {});
  }
});

test("稍后提醒：关弹窗，角标保持「新版本」", async ({ userData }) => {
  const { app, page } = await relaunchPacked(userData);
  try {
    const chip = page.locator(CHIP);
    await expect(chip).toHaveText("新版本 9.9.9", { timeout: 30_000 });
    await chip.click();
    await expect(page.locator("#up-later")).toBeVisible();
    await page.click("#up-later");
    await expect(page.locator("#modal")).toBeHidden();
    await expect(chip).toHaveText("新版本 9.9.9");
  } finally {
    await app.close().catch(() => {});
  }
});

test("更新设置 get/put（IPC 往返 + settings.json 落盘）", async ({ userData }) => {
  const { app, page } = await relaunchPacked(userData);
  try {
    // 分两次 evaluate（不把 bridge 函数对象传出 renderer，避免序列化歧义）
    const before = await page.evaluate(
      () =>
        (window as unknown as { javDesktop: { update: { getSettings: () => Promise<{ enabled: boolean; mirror: string }> } } })
          .javDesktop.update.getSettings(),
    );
    expect(before).toEqual({ enabled: true, mirror: "" });
    const after = await page.evaluate(
      () =>
        (window as unknown as { javDesktop: { update: { putSettings: (s: { enabled: boolean; mirror: string }) => Promise<{ enabled: boolean; mirror: string }> } } })
          .javDesktop.update.putSettings({ enabled: false, mirror: "https://gh.example.com/" }),
    );
    expect(after).toEqual({ enabled: false, mirror: "https://gh.example.com/" });
    const onDisk = JSON.parse(readFileSync(join(userData, "settings.json"), "utf-8")) as {
      update_check: { enabled: boolean; mirror: string };
    };
    expect(onDisk.update_check).toEqual({ enabled: false, mirror: "https://gh.example.com/" });
  } finally {
    await app.close().catch(() => {});
  }
});

test("feed 不可达：静默降级（角标隐藏、无错误打扰）", async ({ userData }) => {
  const { app, page } = await relaunchPacked(userData, {
    JAVSCRIBE_UPDATE_FEED: "http://127.0.0.1:59999/", // 无监听端口
  });
  try {
    const chip = page.locator(CHIP);
    await expect(chip).toHaveText("检查更新"); // 打包形态初始 idle
    // 3s 自动检查 → 连接拒绝 → error 状态 → 角标隐藏；自动检查失败不打 toast（仅手动检查才提示）
    await expect(chip).toBeHidden({ timeout: 30_000 });
    await expect(page.locator("#toasts .toast.err")).toHaveCount(0);
  } finally {
    await app.close().catch(() => {});
  }
});

test("样式：更新角标与更新弹窗（打包形态）", async ({ userData, request }) => {
  const { app, page } = await relaunchPacked(userData);
  try {
    const chip = page.locator(CHIP);
    await expect(chip).toHaveText("新版本 9.9.9", { timeout: 30_000 });
    await freezeForShot(page, request);
    await shot(page, "update-01-chip", { element: "footer" });
    await chip.click();
    await expect(page.locator("#modal-title")).toHaveText("检查更新");
    await freezeForShot(page, request);
    await shot(page, "update-02-modal", { element: "#modal" });
  } finally {
    await app.close().catch(() => {});
  }
});
