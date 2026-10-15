// 桌面端功能类：更新检查整体看门狗（P2-1：checkForUpdates 无整体超时，feed 黑洞时 UI 恒「检查中…」）
//  - 黑洞 = 测试进程内 node:net 服务（接受 TCP 连接但永不响应）：
//    死端口会立刻 ECONNREFUSED 走既有 error 路径（update.spec 已覆盖），不触发看门狗
//  - 打包形态（dev 形态 updater 禁用）；JAVSCRIBE_UPDATE_CHECK_TIMEOUT_MS=1500 压缩断言窗
//  - 断言：启动 3s 自动检查 → 挂起 → 看门狗落 error 态（侧边栏「重试检查」，自动路径静默无 toast）；
//    手动重试 → 再超时 → toast 可读提示（含「超时」+「检查网络」指引）
import { test, expect } from "./helpers";
import { PACKED_BIN, relaunchPacked } from "./helpers";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:net";

test.skip(
  !existsSync(PACKED_BIN),
  "打包产物缺失——先 pnpm build:desktop && pnpm exec electron-builder --linux --x64 --dir --publish never",
);

test("feed 黑洞：看门狗窗内落 error 态，手动重试给出可读超时提示", async ({ userData }) => {
  // 黑洞：accept 后永不写回（模拟 feed 主机吞包/无响应）；
  // 挂住的 HTTP 连接会长期占住 socket——close 前必须 destroy，否则 close 回调不触发（测试挂死）
  const sockets = new Set<import("node:net").Socket>();
  const blackhole: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
  });
  await new Promise<void>((r) => blackhole.listen(0, "127.0.0.1", r));
  const port = (blackhole.address() as { port: number }).port;

  const { app, page } = await relaunchPacked(userData, {
    JAVSCRIBE_UPDATE_CHECK_TIMEOUT_MS: "1500",
    JAVSCRIBE_UPDATE_FEED: `http://127.0.0.1:${port}/`, // extraEnv 覆盖 launchPackedApp 的 8304
  });
  try {
    const aside = page.locator("#up-check");
    // 启动 3s 自动检查 → 黑洞挂起 → 1.5s 看门狗 → error 态（自动路径静默：不打 toast）
    await expect(aside).toHaveText("重试检查", { timeout: 30_000 });
    await expect(page.locator("#up-chip")).toBeHidden(); // error 态 chip 隐藏
    expect(await page.locator("#toasts .toast.err").count()).toBe(0);

    // 手动重试：同一黑洞 feed 再挂起 → 看门狗再触发 → error + 可读提示（超时 + 检查网络/镜像代理指引）
    await aside.click();
    await expect(page.locator("#toasts .toast.err").last()).toContainText("超时", { timeout: 30_000 });
    await expect(page.locator("#toasts .toast.err").last()).toContainText("检查网络");
    await expect(aside).toHaveText("重试检查");
  } finally {
    await app.close().catch(() => {});
    sockets.forEach((s) => s.destroy()); // 先拆挂住的连接，close 回调才能触发
    await new Promise<void>((r) => blackhole.close(() => r()));
  }
});
