// 0.2.62（10-26-javscribe-debug-gate-logcenter）：
//  远程调试 token 门禁（opt-in --remote-debug，门禁默认开）：
//   - 不带参数：零行为变化（不监听任何调试端口，state 恒 null）
//   - --remote-debug（不带 token）：自动生成 12 位 hex 随机 token；
//     外部端口为门禁（HTTP 只认 x-debug-token/Bearer，WS 只认 subprotocol debug-token-<token>）
//   - --remote-debug-token=none：显式恢复 0.0.0.0 裸口行为
//   - --remote-debug-token=<s>：固定 token
// 端口用 9555 避开真实环境 9222；CDP /json 由测试进程（Node）直接 HTTP 探活。
// main inspector 端口由 main 进程实际解析后上报：
//  - 生产/手动：port+1（9556，门禁代理口）
//  - Playwright e2e：launcher 注入 --inspect=0（随机端口且 inspector 已激活），
//    门禁接既有回环端口 → 断言必须用上报值而非硬编码
import { test, expect, launchApp, waitForReady } from "./helpers";

const RD_PORT = 9555;

type CdpTarget = { type: string; url?: string; title?: string; webSocketDebuggerUrl?: string };

async function cdpJson(port: number, token?: string): Promise<CdpTarget[] | null> {
  try {
    const headers: Record<string, string> = {};
    if (token) headers["x-debug-token"] = token;
    const res = await fetch(`http://127.0.0.1:${port}/json`, { headers, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return (await res.json()) as CdpTarget[];
  } catch {
    return null;
  }
}

async function httpStatus(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: AbortSignal.timeout(3000) });
    return res.status;
  } catch {
    return -1;
  }
}

type RdState = { rendererPort: number; inspectorPort: number; lanIps: string[]; token: string };

async function remoteDebugState(page: any): Promise<RdState | null> {
  return page.evaluate(() =>
    (window as unknown as { javDesktop: { remoteDebugState(): Promise<unknown> } }).javDesktop.remoteDebugState(),
  );
}

test("未带 --remote-debug：不监听调试端口，state 恒 null（默认零行为变化）", async ({ page }) => {
  await waitForReady(page);
  expect(await remoteDebugState(page)).toBeNull();
  expect(await cdpJson(RD_PORT)).toBeNull();
});

test("带 --remote-debug：自动 token 门禁 + HTTP/WS 鉴权 + toast 带 token", async ({ userData }) => {
  const app = await launchApp(userData, {}, [`--remote-debug-port=${RD_PORT}`]);
  try {
    const page = await app.firstWindow();
    await waitForReady(page);

    const st = await remoteDebugState(page);
    expect(st).toMatchObject({ rendererPort: RD_PORT });
    expect(typeof st?.inspectorPort).toBe("number");
    expect((st?.inspectorPort ?? 0) > 0).toBeTruthy();
    expect(Array.isArray(st?.lanIps)).toBeTruthy();
    expect(st?.token).toMatch(/^[0-9a-f]{12}$/); // 自动生成 token
    const token = st!.token;
    const inspectorPort = st!.inspectorPort;

    // renderer CDP 门禁：无 token 401；带 token 列 target；Bearer 同效
    expect(await httpStatus(RD_PORT, "/json")).toBe(401);
    expect(await cdpJson(RD_PORT)).toBeNull();
    const targets = await cdpJson(RD_PORT, token);
    expect(Array.isArray(targets)).toBeTruthy();
    expect(targets?.some((t) => t.type === "page" && /index\.html/.test(t.url || ""))).toBeTruthy();
    expect(await httpStatus(RD_PORT, "/json", { authorization: `Bearer ${token}` })).toBe(200);

    // main inspector 门禁（state 上报端口）：无 token 401，Bearer 200
    expect(await httpStatus(inspectorPort, "/json/version")).toBe(401);
    expect(await httpStatus(inspectorPort, "/json/version", { authorization: `Bearer ${token}` })).toBe(200);

    // WS 门禁：subprotocol debug-token-<token> 可握手
    //（undici 严格遵循 RFC6455：服务端 101 不回显所请求 subprotocol 会直接断连 → open 即证明回显正确）
    // webSocketDebuggerUrl 由上游 CDP 生成，门禁已把 host:port 改写为外部口 → 原样可连
    const wsUrl = targets!.find((t) => t.type === "page" && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl || "";
    expect(wsUrl).toContain(`127.0.0.1:${RD_PORT}/devtools/page/`);
    const wsOpened = await new Promise<boolean>((res) => {
      const w = new WebSocket(wsUrl, [`debug-token-${token}`]);
      const t = setTimeout(() => { try { w.close(); } catch { /* ignore */ } res(false); }, 6000);
      w.onopen = () => { clearTimeout(t); try { w.close(); } catch { /* ignore */ } res(true); };
      w.onerror = () => { clearTimeout(t); res(false); };
    });
    expect(wsOpened).toBeTruthy();

    // WS 错误 subprotocol → 401 拒绝
    const wsRejected = await new Promise<boolean>((res) => {
      const w = new WebSocket(wsUrl, ["debug-token-wrong"]);
      const t = setTimeout(() => { try { w.close(); } catch { /* ignore */ } res(false); }, 6000);
      w.onerror = () => { clearTimeout(t); res(true); };
      w.onopen = () => { clearTimeout(t); res(false); };
    });
    expect(wsRejected).toBeTruthy();

    // 一次性 toast（端口 + token + 用完请关）
    await expect(page.locator("#toasts .toast", { hasText: "远程调试已开启" })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#toasts .toast", { hasText: "远程调试已开启" })).toContainText(String(RD_PORT));
    await expect(page.locator("#toasts .toast", { hasText: "远程调试已开启" })).toContainText(token);
    await expect(page.locator("#toasts .toast", { hasText: "远程调试已开启" })).toContainText("用完请关");
  } finally {
    await app.close().catch(() => {});
  }
});

test("--remote-debug-token=none：显式恢复裸口（无 token 直接可达）", async ({ userData }) => {
  const app = await launchApp(userData, {}, [`--remote-debug-port=${RD_PORT}`, "--remote-debug-token=none"]);
  try {
    const page = await app.firstWindow();
    await waitForReady(page);
    const st = await remoteDebugState(page);
    expect(st?.token).toBe("none");
    expect(await httpStatus(RD_PORT, "/json")).toBe(200); // 裸口：无 token 200
    expect(await cdpJson(RD_PORT)).toBeTruthy();
  } finally {
    await app.close().catch(() => {});
  }
});

test("--remote-debug-token=<固定值>：固定 token 门禁", async ({ userData }) => {
  const app = await launchApp(userData, {}, [`--remote-debug-port=${RD_PORT}`, "--remote-debug-token=fixedtok123"]);
  try {
    const page = await app.firstWindow();
    await waitForReady(page);
    const st = await remoteDebugState(page);
    expect(st?.token).toBe("fixedtok123");
    expect(await httpStatus(RD_PORT, "/json")).toBe(401);
    expect(await httpStatus(RD_PORT, "/json", { "x-debug-token": "fixedtok123" })).toBe(200);
  } finally {
    await app.close().catch(() => {});
  }
});
