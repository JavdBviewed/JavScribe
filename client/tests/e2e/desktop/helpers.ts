// 桌面端 e2e 基础设施：每 test 全新 userData 冷启动 Electron（_electron.launch），
// mock serve（8302）由 playwright.desktop.config.ts 的 webServer 托管。
//
// 与 web helpers 的差异：
//  - 没有 8400 工作台代理：页面 file:// 加载，数据链路是 renderer → IPC → main 直连 mock
//  - 引擎 Key 预置在 userData/engines.json（等价 web 的 cleanEngines：启动即 has_key），
//    「Key 登记 UI 流程」单独有一个用例走真实 UI 路径
//  - 无 page.goto（loadFile 自动）；「重启」= close + 同 userData 重新 launch
import {
  test as base, expect, _electron as electron,
  type Page, type APIRequestContext,
} from "@playwright/test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MOCK = "http://127.0.0.1:8302";
export const MOCK_KEY = "mock-key-123";
export const FIXTURES = new URL("../fixtures", import.meta.url).pathname;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
export const DIST = join(ROOT, "client", "dist-desktop");

// ---------------------------------------------------------------------------
// fixtures 自愈：本开发机的 /home/ryen/Git 被 Syncthing 与另一台机器双向同步，
// 对端 git 工作区若缺少这些文件，删除会周期性同步回来（外部进程删除，非测试所为）。
// fixtures 已入库（commit f2cd2e0），缺了直接 git restore，保证每个 test 冷启动时齐全。
// ---------------------------------------------------------------------------
const FIXTURE_FILES = ["video-a.mp4", "video-b.mkv", "sine.opus", "folder/video-c.mp4", "folder/video-c.zh.srt"];
export function ensureFixtures(): void {
  const missing = FIXTURE_FILES.filter((f) => !existsSync(join(FIXTURES, f)));
  if (missing.length) {
    console.log(`[fixtures] 缺失 ${missing.join(", ")} → git restore`);
    try {
      execFileSync("git", ["restore", "--", "client/tests/e2e/fixtures"], { cwd: ROOT, stdio: "pipe" });
    } catch { /* 下面统一校验 */ }
    const still = FIXTURE_FILES.filter((f) => !existsSync(join(FIXTURES, f)));
    if (still.length) {
      throw new Error(`测试 fixtures 缺失且 git restore 失败：${still.join(", ")}（检查仓库是否被外部同步工具持续删除）`);
    }
  }
}

export type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

// ---------------------------------------------------------------------------
// mock serve 控制口（127.0.0.1:8302）
// ---------------------------------------------------------------------------

export async function mockControl(req: APIRequestContext, path: string, body?: unknown) {
  const r = await req.post(`${MOCK}/_mock/${path}`, {
    data: body === undefined ? "{}" : body,
    headers: { "Content-Type": "application/json" },
  });
  if (!r.ok()) throw new Error(`mock control ${path} -> ${r.status()}`);
  return r.json();
}

export const mockReset = (req: APIRequestContext) => mockControl(req, "reset");
export const mockPause = (req: APIRequestContext) => mockControl(req, "pause");
export const mockResume = (req: APIRequestContext) => mockControl(req, "resume");
export const mockSeed = (req: APIRequestContext, body: unknown) => mockControl(req, "seed", body);
export const mockConfigMode = (req: APIRequestContext, mode: string) => mockControl(req, "config-mode", { mode });
export const mockSpeed = (req: APIRequestContext, body: { step: number; tickMs?: number }) => mockControl(req, "speed", body);
export const mockUploadDelay = (req: APIRequestContext, ms: number) => mockControl(req, "upload-delay", { ms });

export async function mockJobs(req: APIRequestContext): Promise<any[]> {
  return (await (await req.get(`${MOCK}/jobs`)).json()) as any[];
}

/** 等 mock 侧某 job 真正 finished（getResultData 前必须等，serve 未完成 result 404） */
export async function waitForMockJobFinished(
  req: APIRequestContext, jobId: string, timeoutMs = 20_000,
) {
  const t0 = Date.now();
  for (;;) {
    const j = (await (await req.get(`${MOCK}/jobs/${encodeURIComponent(jobId)}`)).json()) as any;
    if (j && j.state === "finished") return j;
    if (Date.now() - t0 > timeoutMs) throw new Error(`mock job ${jobId} 未在超时内 finished`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ---------------------------------------------------------------------------
// Electron 启动
// ---------------------------------------------------------------------------

function ffmpegEnv(): Record<string, string> {
  const ff = process.env.JAVSCRIBE_FFMPEG || "/home/ryen/.local/bin/ffmpeg";
  return existsSync(ff) ? { JAVSCRIBE_FFMPEG: ff } : {};
}

export function assertDistBuilt(): void {
  if (!existsSync(join(DIST, "index.html")) || !existsSync(join(DIST, "main.cjs"))) {
    throw new Error("client/dist-desktop 未构建——先跑 pnpm build:desktop");
  }
}

export async function launchApp(userData: string, extraEnv: Record<string, string> = {}) {
  return electron.launch({
    args: [DIST, "--no-sandbox"],
    env: {
      ...process.env,
      JAVSCRIBE_CLIENT_USERDATA: userData,
      JAVSCRIBE_ENGINES: `mock=${MOCK}`,
      // 无框窗口：viewport 与 web 基线（1440x1000）一致
      JAVSCRIBE_CLIENT_FRAMELESS: "1",
      ...ffmpegEnv(),
      ...extraEnv,
    },
  });
}

/** 冷启动 + 等引擎在线（health 文案 v0.1.0 · 服务 1/1 在线） */
export async function waitForReady(page: Page) {
  await page.getByText(/服务 1\/1 在线/).first().waitFor({ timeout: 25_000 });
}

/** 同 userData 重启（localStorage / engines.json 持久化验证） */
export async function relaunch(userData: string) {
  const app = await launchApp(userData);
  const page = await app.firstWindow();
  await waitForReady(page);
  return { app, page };
}

// ---------------------------------------------------------------------------
// fixtures：userData（mock reset + 预置引擎表）→ app → page
// ---------------------------------------------------------------------------

type DesktopFixtures = {
  userData: string;
  app: ElectronApp;
  page: Page;
};

export const test = base.extend<DesktopFixtures>({
  userData: async ({ request }, use) => {
    assertDistBuilt();
    ensureFixtures();
    await mockReset(request);
    const dir = mkdtempSync(join(tmpdir(), "javscribe-e2e-"));
    writeFileSync(
      join(dir, "engines.json"),
      JSON.stringify({ engines: [{ name: "mock", url: MOCK, api_key: MOCK_KEY }] }, null, 1),
      "utf-8",
    );
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
  app: async ({ userData }, use) => {
    const app = await launchApp(userData);
    await use(app);
    await app.close().catch(() => {});
  },
  page: async ({ app }, use) => {
    const page = await app.firstWindow();
    await waitForReady(page);
    await use(page);
  },
});

export { expect };
export type { APIRequestContext } from "@playwright/test";

// ---------------------------------------------------------------------------
// 页面级 helper
// ---------------------------------------------------------------------------

/**
 * 等 state.engines 里该引擎 has_key 就位（Key 登记 UI 流程用）。
 * app.ts 把 state 挂在 window 上；Playwright 1.63 字符串形式 waitForFunction 有 bug，必须函数形式。
 */
export async function waitForEngineKey(page: Page, name = "mock") {
  await page.waitForFunction(
    (n) => {
      try {
        const s = (window as unknown as { state?: { engines?: Array<{ name: string; has_key: boolean }> } }).state;
        return !!s && Array.isArray(s.engines) && s.engines.some((e) => e.name === n && e.has_key === true);
      } catch {
        return false;
      }
    },
    name,
    { timeout: 20_000 },
  );
}

/**
 * 截图前冻结所有动态元素（与 web freezeForShot 同款，保证基线可比）：
 * mock 暂停 + CSS 动画暂停 + 时钟/更新时间/行内耗时隐藏 + ETA 清空
 */
export async function freezeForShot(page: Page, req: APIRequestContext) {
  await mockPause(req).catch(() => {});
  await page.evaluate(() => {
    document.getAnimations().forEach((a) => a.pause());
    for (const id of ["clock", "last-updated"]) {
      const el = document.getElementById(id);
      if (el) el.style.visibility = "hidden";
    }
    document.querySelectorAll<HTMLElement>(".cell-elapsed").forEach((el) => (el.style.visibility = "hidden"));
    document.querySelectorAll(".eta").forEach((el) => (el.textContent = ""));
  });
}

export function shot(page: Page, name: string, opts?: { fullPage?: boolean; element?: string }) {
  const png = name.endsWith(".png") || name.endsWith(".webp") ? name : name + ".png";
  if (opts?.element) {
    return expect(page.locator(opts.element).first()).toHaveScreenshot(png, {
      maxDiffPixels: 0,
      animations: "disabled",
    });
  }
  return expect(page).toHaveScreenshot(png, {
    fullPage: opts?.fullPage ?? false,
    maxDiffPixels: 10,
    animations: "disabled",
  });
}

/** 页面上触发一个普通 toast（样式基线用，与 web 同款） */
export async function triggerToast(page: Page, msg: string, kind: "ok" | "err" | "" = "") {
  await page.evaluate(
    ({ msg, kind }) => {
      const box = document.createElement("div");
      box.className = "toast" + (kind ? " " + kind : "");
      const icon = kind === "ok" ? "✓" : kind === "err" ? "✗" : "●";
      box.innerHTML = `<span class="t-icon">${icon}</span><span>${msg}</span>`;
      document.getElementById("toasts")!.appendChild(box);
    },
    { msg, kind },
  );
}
