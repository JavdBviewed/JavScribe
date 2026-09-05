import { expect, type Page, type APIRequestContext } from "@playwright/test";

export const MOCK_URL = "http://127.0.0.1:8301";
export const WEB_URL = "http://127.0.0.1:8901";
export const MOCK_KEY = "mock-key-123";
export const FIXTURES = new URL("./fixtures", import.meta.url).pathname;

/** mock serve 控制口（测试专用） */
export async function mockControl(req: APIRequestContext, path: string, body?: unknown) {
  const r = await req.post(`${MOCK_URL}/_mock/${path}`, {
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

/**
 * 等 web 端 poller 快照的任务清空（/api/jobs 直读快照）。
 * reuseExistingServer 下 web 进程跨 suite 存活：上一 suite 遗留的 running 任务
 * 在 mockReset 后仍会在快照里滞留最多一个 tick（1s），页面先渲染就会拍到残留行。
 */
export async function waitForJobsEmpty(req: APIRequestContext, timeoutMs = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const rows = (await (await req.get("/api/jobs")).json()) as unknown[];
    if (rows.length === 0) return;
    if (Date.now() - t0 > timeoutMs) throw new Error("web 快照任务未在超时内清空");
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 工作台就绪：预设引擎 mock 在线 */
export async function waitForEngineOnline(page: Page) {
  await page.getByText(/服务 1\/1 在线/).waitFor({ timeout: 20_000 });
}

/**
 * 等页面 state.engines 里该引擎的 API Key 就位。
 * 冷启动竞态：cleanEngines 刚 PUT 完 key 时，poller 首轮快照可能还是 has_key=false，
 * scan-go / ⚙ 会走「请先登记 API Key」toast 提前返回。页面 5s 刷新后自愈，
 * 但全套首个用例（冷 web 进程）必须等，否则单跑必挂。
 * app.js 顶层 const state 是全局词法绑定（不在 window 上），evaluate 里按名引用。
 */
export async function waitForEngineKey(page: Page, name = "mock") {
  // Playwright 1.63 的字符串形式 waitForFunction 有 bug：谓词为假时仍立即 resolve（/tmp/wf-repro.mjs 复现）。
  // 必须用函数形式：函数体序列化后在页面全局作用域执行，裸 state 可解析到 app.js 顶层词法 const。
  await page.waitForFunction(
    (n) => {
      try {
        // @ts-expect-error 页面词法全局（不在 window/globalThis 上），TS 无法识别
        const s = state;
        return !!s && Array.isArray(s.engines) && s.engines.some((e: any) => e.name === n && e.has_key === true);
      } catch (_e) { return false; }
    },
    name,
    { timeout: 15_000 },
  );
}

/**
 * 截图前冻结所有动态元素（基线与回归用同一 helper，保证可比）：
 * - mock 暂停（进度/ETA/位置数据静态）
 * - CSS 动画暂停（扫光/呼吸灯等）
 * - HUD 时钟 / 更新时间 / 行内耗时 隐藏（文本每秒变，版式保留）
 * - 运行行 ETA 清空（5s 轮询可能重填，窗口极小）
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
  // toHaveScreenshot 要求名字自带扩展名（项目后缀会自动追加），统一兜底
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

/** 在页面上触发一个普通 toast（用于样式基线） */
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

/** 工作台 /api/jobs 是 poller 快照（按 JAV_POLL_INTERVAL_S 刷新）：mock seed 后需等它体现 */
export async function waitForJobRow(
  req: APIRequestContext,
  pred: (row: any) => boolean,
  timeoutMs = 15_000,
) {
  const t0 = Date.now();
  for (;;) {
    const jobs: any[] = await (await req.get(`${WEB_URL}/api/jobs`)).json();
    const row = jobs.find(pred);
    if (row) return row;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitForJobRow timeout (pred 未命中)`);
    await new Promise((rs) => setTimeout(rs, 200));
  }
}

/** /api/engines 同样来自 poller 快照：POST 后等引擎出现在列表 */
export async function waitForEngineListed(
  req: APIRequestContext,
  name: string,
  timeoutMs = 15_000,
) {
  const t0 = Date.now();
  for (;;) {
    const list: Array<{ name: string }> = await (await req.get(`${WEB_URL}/api/engines`)).json();
    if (list.some((e) => e.name === name)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitForEngineListed timeout (${name})`);
    await new Promise((rs) => setTimeout(rs, 200));
  }
}

/**
 * 引擎表复位：删掉除 mock 外的所有引擎；确保 mock 存在且已登记 API Key。
 * （env 预置的 mock 没有 key；store.add 对同名同址是 no-op，Key 只能走 PUT）
 */
export async function cleanEngines(req: APIRequestContext) {
  const jh = { "Content-Type": "application/json" };
  const r = await req.get(`${WEB_URL}/api/engines`);
  if (!r.ok()) return;
  const list = (await r.json()) as Array<{ name: string; has_key: boolean }>;
  for (const e of list) {
    if (e.name !== "mock") {
      await req.delete(`${WEB_URL}/api/engines/${encodeURIComponent(e.name)}`);
    }
  }
  const mock = list.find((e) => e.name === "mock");
  if (!mock) {
    await req.post(`${WEB_URL}/api/engines`, {
      data: { name: "mock", url: MOCK_URL, api_key: MOCK_KEY }, headers: jh,
    });
  } else if (!mock.has_key) {
    await req.put(`${WEB_URL}/api/engines/mock`, { data: { api_key: MOCK_KEY }, headers: jh });
  }
}

/** mock 任务推进速度（测试控速：慢速保证页面 5s 轮询能观察到 running→done 迁移） */
export async function mockSpeed(req: APIRequestContext, body: { step: number; tickMs?: number }) {
  return mockControl(req, "speed", body);
}

export async function addEngine(
  req: APIRequestContext,
  body: { name: string; url: string; api_key?: string },
) {
  return req.post(`${WEB_URL}/api/engines`, { data: body, headers: { "Content-Type": "application/json" } });
}
