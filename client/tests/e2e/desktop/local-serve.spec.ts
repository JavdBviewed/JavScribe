// 本地服务端集成 e2e（仅 desktop 形态；CI 冒烟不含此文件，本地全量回归跑）
//   A 检测 + 自动拉起：env JAVSCRIBE_LOCAL_SERVE_CMD 指向 wrapper（node → mock-serve，
//     与真实 exe 同款 `--port N` 调用约定），客户端 detached 拉起 → health 就绪 →
//     登记「本地服务端」引擎卡 + 状态行运行中
//   B 未检测：dev 态 exe 同目录无服务程序 → 提示文案可见、不拉起、端口无监听
//   C 已在线：端口已有实例 → 直接复用，不重复拉起（MOCK_COUNT_FILE 计数断言）
import { test as base, expect, _electron as electron } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DIST, MOCK, MOCK_KEY, assertDistBuilt, ensureFixtures, mockReset } from "./helpers";

const MOCK_SERVE = fileURLToPath(new URL("../mock-serve.mjs", import.meta.url));
const PORT_A = 8395; // A：由客户端拉起
const PORT_B = 8396; // B：未检测（端口应无监听）
const PORT_C = 8397; // C：预启动实例，验证不重复拉起

function killPort(port: number): void {
  try {
    const pids = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8" })
      .trim().split("\n").filter(Boolean);
    for (const p of pids) process.kill(Number(p), "SIGKILL");
  } catch { /* 端口无进程 / 无 lsof：忽略 */ }
}

/** Shebang wrapper：客户端 spawn(cmd, ["--port", N]) → node 执行 mock-serve.mjs */
function makeWrapper(countFile: string): string {
  const p = join(tmpdir(), `ls-mock-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.cjs`);
  writeFileSync(
    p,
    `#!/usr/bin/env node\nprocess.env.MOCK_COUNT_FILE = ${JSON.stringify(countFile)};\nimport(${JSON.stringify(pathToFileURL(MOCK_SERVE).href)});\n`,
    "utf-8",
  );
  chmodSync(p, 0o755);
  return p;
}

function countLines(file: string): number {
  try {
    return readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

const test = base.extend<{ userData: string }>({
  userData: async ({ request }, use) => {
    assertDistBuilt();
    ensureFixtures();
    await mockReset(request);
    const dir = mkdtempSync(join(tmpdir(), "javscribe-ls-"));
    writeFileSync(
      join(dir, "engines.json"),
      JSON.stringify({ engines: [{ name: "mock", url: MOCK, api_key: MOCK_KEY }] }, null, 1),
      "utf-8",
    );
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
});

async function launchLS(userData: string, extraEnv: Record<string, string>) {
  return electron.launch({
    args: [DIST, "--no-sandbox"],
    env: {
      ...process.env,
      JAVSCRIBE_CLIENT_USERDATA: userData,
      JAVSCRIBE_ENGINES: `mock=${MOCK}`,
      JAVSCRIBE_CLIENT_FRAMELESS: "1",
      ...extraEnv,
    },
  });
}

/** 等 state.engines 里「本地服务端」上线（health 就绪后引擎卡才出现） */
async function waitForLocalEngine(page: import("@playwright/test").Page, name = "本地服务端") {
  await page.waitForFunction(
    (n) => {
      try {
        const s = (window as unknown as { state?: { engines?: Array<{ name: string; online: boolean }> } }).state;
        return !!s && Array.isArray(s.engines) && s.engines.some((e) => e.name === n && e.online === true);
      } catch {
        return false;
      }
    },
    name,
    { timeout: 30_000 },
  );
}

test("A 检测 + 自动拉起：本地服务端运行中 + 引擎卡在线", async ({ userData }, testInfo) => {
  const countFile = join(tmpdir(), `ls-count-${testInfo.workerIndex}-${Date.now()}.txt`);
  const wrapper = makeWrapper(countFile);
  const app = await launchLS(userData, {
    JAVSCRIBE_LOCAL_SERVE_CMD: wrapper,
    JAVSCRIBE_LOCAL_SERVE_PORT: String(PORT_A),
  });
  try {
    const page = await app.firstWindow();
    // 状态行：detected → starting → running（客户端 spawn → mock 启动 → health 就绪）
    await page.locator("#local-serve-status.show").waitFor({ timeout: 30_000 });
    await expect(page.locator("#local-serve-status-text")).toContainText("运行中");
    await expect(page.locator("#local-serve-status-text")).toContainText(`127.0.0.1:${PORT_A}`);
    await expect(page.locator("#local-serve-status-text")).toContainText("已登记为「本地服务端」");
    await expect(page.locator("#local-serve-hint")).toBeHidden();
    // 「本地服务端」引擎卡在线
    await waitForLocalEngine(page);
    await expect(page.locator('#engine-grid article.eng[data-name="本地服务端"].on')).toBeVisible();
    // 客户端拉起的 mock 真实在监听，且只拉起了一次
    const health = await (await page.request.get(`http://127.0.0.1:${PORT_A}/health`)).json();
    expect(health.ok).toBe(true);
    expect(countLines(countFile)).toBe(1);
  } finally {
    await app.close().catch(() => {});
    killPort(PORT_A);
    try { rmSync(wrapper, { force: true }); } catch { /* 忽略 */ }
  }
});

test("B 未检测：提示文案可见、不拉起、端口无监听", async ({ userData }) => {
  const app = await launchLS(userData, {
    // dev 态 process.execPath 是 electron 二进制，同目录无 JavScribeServe → 未检测
    JAVSCRIBE_LOCAL_SERVE_PORT: String(PORT_B),
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator("#local-serve-hint")).toBeVisible();
    await expect(page.locator("#local-serve-hint")).toContainText("未检测到本地服务端");
    await expect(page.locator("#local-serve-hint")).toContainText("JavScribe Serve");
    await expect(page.locator("#local-serve-status")).toBeHidden();
    await expect(page.locator('#engine-grid article.eng[data-name="本地服务端"]')).toHaveCount(0);
    const r = await page.request.get(`http://127.0.0.1:${PORT_B}/health`).catch(() => null);
    expect(r === null || !r.ok()).toBeTruthy();
  } finally {
    await app.close().catch(() => {});
  }
});

test("C 已在线：复用既有实例、不重复拉起", async ({ userData }, testInfo) => {
  const countFile = join(tmpdir(), `ls-count-${testInfo.workerIndex}-${Date.now()}.txt`);
  const wrapper = makeWrapper(countFile);
  // 预启动一个实例（模拟用户手动起过 / 上次客户端拉起后仍在跑）
  const pre = spawn(process.execPath, [MOCK_SERVE, "--port", String(PORT_C)], {
    env: { ...process.env, MOCK_COUNT_FILE: countFile },
    stdio: "ignore",
  });
  pre.unref();
  await new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const poll = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT_C}/health`);
        if (r.ok) return resolve();
      } catch { /* 未就绪 */ }
      if (Date.now() - t0 > 10_000) return reject(new Error("预启动 mock 未就绪"));
      setTimeout(poll, 100);
    };
    void poll();
  });
  const app = await launchLS(userData, {
    JAVSCRIBE_LOCAL_SERVE_CMD: wrapper,
    JAVSCRIBE_LOCAL_SERVE_PORT: String(PORT_C),
  });
  try {
    const page = await app.firstWindow();
    await page.locator("#local-serve-status.show").waitFor({ timeout: 30_000 });
    await expect(page.locator("#local-serve-status-text")).toContainText("运行中");
    await waitForLocalEngine(page);
    // 计数文件只有预启动的 1 行 → 客户端没有重复 spawn
    expect(countLines(countFile)).toBe(1);
  } finally {
    await app.close().catch(() => {});
    killPort(PORT_C);
    try { pre.kill("SIGKILL"); } catch { /* 已退出 */ }
  }
});
