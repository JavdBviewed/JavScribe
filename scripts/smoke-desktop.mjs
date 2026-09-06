// 桌面端冷启动冒烟：mock serve 8302 + 全新 userData 启动 Electron，
// 等引擎上线后截屏（供 view_image 自查），并打印关键 DOM 状态。
// 用法: node scripts/smoke-desktop.mjs [out.png]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] || resolve(ROOT, "smoke-desktop.png");

const mock = spawn(process.execPath, [resolve(ROOT, "client/tests/e2e/mock-serve.mjs"), "8302"], { stdio: "ignore" });
const userData = mkdtempSync(resolve(tmpdir(), "javscribe-smoke-"));
try {
  const app = await electron.launch({
    args: [resolve(ROOT, "client/dist-desktop"), "--no-sandbox"],
    env: {
      ...process.env,
      JAVSCRIBE_CLIENT_USERDATA: userData,
      JAVSCRIBE_ENGINES: "mock=http://127.0.0.1:8302",
      JAVSCRIBE_CLIENT_FRAMELESS: "1",
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForSelector("#health", { state: "visible", timeout: 20000 });
  await win.getByText(/服务 1\/1 在线/).first().waitFor({ timeout: 20000 });
  await win.waitForTimeout(800);
  const state = await win.evaluate(() => ({
    health: document.querySelector("#health")?.textContent,
    engines: (window.state?.engines || []).map((e) => ({ name: e.name, online: e.online, has_key: e.has_key })),
    brandSub: document.querySelector(".brand-sub")?.textContent,
    extractOpts: [...document.querySelectorAll("#extract-select option")].map((o) => o.textContent),
  }));
  console.log(JSON.stringify(state, null, 2));
  writeFileSync(OUT, await win.screenshot({ fullPage: false }));
  console.log("screenshot →", OUT);
  await app.close();
} finally {
  mock.kill();
}
