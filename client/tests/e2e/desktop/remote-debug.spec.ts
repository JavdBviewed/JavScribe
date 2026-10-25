// 0.2.60（10-25-javscribe-remote-debug）：
//  客户端 exe 远程调试窗口（opt-in --remote-debug）：
//   - 不带参数：零行为变化（不监听任何调试端口，state 恒 null）
//   - 带参数：renderer CDP + main inspector 监听（内网 0.0.0.0），一次性 toast 提示端口
// 端口用 9555 避开真实环境 9222；CDP /json 由测试进程（Node）直接 HTTP 探活。
import { test, expect, launchApp, waitForReady } from "./helpers";

const RD_PORT = 9555;
// main inspector 端口由 main 进程实际解析后上报：
//  - 生产/手动：port+1（9556）
//  - Playwright e2e：launcher 注入 --inspect=0（随机端口且 inspector 已激活），
//    main 复用既有端口 → 断言必须用上报值而非硬编码

type CdpTarget = { type: string; url?: string; title?: string };

async function cdpJson(port: number): Promise<CdpTarget[] | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return (await res.json()) as CdpTarget[];
  } catch {
    return null;
  }
}

async function remoteDebugState(page: any): Promise<{ rendererPort: number; inspectorPort: number; lanIps: string[] } | null> {
  return page.evaluate(() =>
    (window as unknown as { javDesktop: { remoteDebugState(): Promise<unknown> } }).javDesktop.remoteDebugState(),
  );
}

test("未带 --remote-debug：不监听调试端口，state 恒 null（默认零行为变化）", async ({ page }) => {
  await waitForReady(page);
  expect(await remoteDebugState(page)).toBeNull();
  expect(await cdpJson(RD_PORT)).toBeNull();
});

test("带 --remote-debug：CDP 与 inspector 监听 + toast 提示端口", async ({ userData }) => {
  const app = await launchApp(userData, {}, [`--remote-debug-port=${RD_PORT}`]);
  try {
    const page = await app.firstWindow();
    await waitForReady(page);

    const st = await remoteDebugState(page);
    expect(st).toMatchObject({ rendererPort: RD_PORT });
    expect(typeof st?.inspectorPort).toBe("number");
    expect((st?.inspectorPort ?? 0) > 0).toBeTruthy();
    expect(Array.isArray(st?.lanIps)).toBeTruthy();

    // renderer CDP：/json 能列到本页 target
    const targets = await cdpJson(RD_PORT);
    expect(Array.isArray(targets)).toBeTruthy();
    expect(targets?.some((t) => t.type === "page" && /index\.html/.test(t.url || ""))).toBeTruthy();

    // main inspector 监听探活（探 state 上报的实际端口，/json/version HTTP 即可）
    let inspectorAlive = false;
    try {
      const res = await fetch(`http://127.0.0.1:${st?.inspectorPort}/json/version`, { signal: AbortSignal.timeout(3000) });
      inspectorAlive = res.ok;
    } catch {
      inspectorAlive = false;
    }
    expect(inspectorAlive).toBeTruthy();

    // 一次性 toast 提示（端口 + 用完请关）
    await expect(page.locator("#toasts .toast", { hasText: "远程调试已开启" })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#toasts .toast", { hasText: "远程调试已开启" })).toContainText(String(RD_PORT));
    await expect(page.locator("#toasts .toast", { hasText: "远程调试已开启" })).toContainText("用完请关");
  } finally {
    await app.close().catch(() => {});
  }
});
