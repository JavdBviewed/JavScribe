// 引擎选择稳定性回归（09-09-client-ui-interaction-polish）
// 缺陷：用户手选远程引擎后，5s 主轮询 refresh() 重建 <select> 会把选中值
//       静默打回 pool 第一项（「本地服务端」自动登记恒第一），提交打错服务
//       （用户报告 job 20260909-2a2f61：选 127 远程却提交到本地服务端）。
// 回归（双在线引擎：mock 8302 + 第二 mock 8305，同脚本换端口）：
//   1. 手选第二引擎 → 等 ≥2 个 5s 刷新周期 → select 值不变
//   2. 手选第二引擎 → 同 userData 重启 → 选中值保留（持久化）
//   3. 选项 label 带 host 提示（本地/远程可辨识）
import { test, expect, _electron as electron } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
const DIST = join(ROOT, "client", "dist-desktop");
const MOCK = "http://127.0.0.1:8302";
const SECOND_PORT = 8305;
const SECOND = `http://127.0.0.1:${SECOND_PORT}`;
const MOCK_KEY = "mock-key-123";
const ENGINES = `mock=${MOCK},second=${SECOND}`;

let secondMock: ChildProcess | null = null;

test.beforeAll(async () => {
  secondMock = spawn(
    process.execPath,
    [join(ROOT, "client", "tests", "e2e", "mock-serve.mjs"), String(SECOND_PORT)],
    { stdio: "ignore" },
  );
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${SECOND}/health`);
      if (r.ok) break;
    } catch { /* 未就绪 */ }
    if (Date.now() - t0 > 15_000) throw new Error("第二 mock serve 未就绪");
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.afterAll(() => {
  secondMock?.kill();
});

function freshUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), "javscribe-engsel-"));
  writeFileSync(
    join(dir, "engines.json"),
    JSON.stringify({
      engines: [
        { name: "mock", url: MOCK, api_key: MOCK_KEY },
        { name: "second", url: SECOND, api_key: MOCK_KEY },
      ],
    }, null, 1),
    "utf-8",
  );
  return dir;
}

async function launch(userData: string) {
  const app = await electron.launch({
    args: [DIST, "--no-sandbox"],
    env: {
      ...process.env,
      JAVSCRIBE_CLIENT_USERDATA: userData,
      JAVSCRIBE_ENGINES: ENGINES,
      JAVSCRIBE_CLIENT_FRAMELESS: "1",
    },
  });
  const page = await app.firstWindow();
  await page.getByText(/服务 2\/2 在线/).first().waitFor({ timeout: 25_000 });
  return { app, page };
}

test("稳定性：手选第二引擎后 ≥2 个 5s 轮询周期不被打回第一项", async () => {
  const dir = freshUserData();
  const { app, page } = await launch(dir);
  try {
    await page.selectOption("#engine-select", "second");
    // 主刷新周期 5s；等 2 个完整周期 + 余量
    await page.waitForTimeout(12_000);
    const v = await page.locator("#engine-select").evaluate((e) => (e as HTMLSelectElement).value);
    expect(v).toBe("second");
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("持久化：手选第二引擎 → 重启（同 userData）→ 选中保留", async () => {
  const dir = freshUserData();
  const first = await launch(dir);
  await first.page.selectOption("#engine-select", "second");
  await first.app.close().catch(() => {});

  const second = await launch(dir);
  try {
    const v = await second.page.locator("#engine-select").evaluate((e) => (e as HTMLSelectElement).value);
    expect(v).toBe("second");
  } finally {
    await second.app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("选项 label：host 提示区分本地/远程", async () => {
  const dir = freshUserData();
  const { app, page } = await launch(dir);
  try {
    await expect(page.locator('#engine-select option[value="mock"]')).toHaveText("mock（127.0.0.1:8302）");
    await expect(page.locator('#engine-select option[value="second"]')).toHaveText(`second（127.0.0.1:${SECOND_PORT}）`);
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
