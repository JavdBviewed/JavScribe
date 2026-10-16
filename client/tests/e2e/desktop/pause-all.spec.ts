// 桌面端功能类：「暂停所有 / 继续任务」（P2-2：transport-desktop.pauseAll → main 本机管线闸 + 全已登记服务队列扇出）
//  - mock serve 8302 用户面队列暂停：POST /jobs/pause|resume → state.queuePaused，/health.paused 透出
//  - 验收（PRD P2-2）：有在途任务时「暂停所有」可见可用；暂停后 serve /health paused=true 且排队冻结；
//    继续恢复；单端离线逐条降级不阻塞整体（IPC 返回 PauseAllResult 结构逐端可辨）
//  - 本机管线闸（等待式）额外验证：暂停期间新上传在 IPC 入口挂起、不触及 mock；恢复后放行受理
import { test, expect, type APIRequestContext } from "./helpers";
import { MOCK, FIXTURES, mockPause, mockSeed, mockUploadDelay, goView } from "./helpers";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BTN = "#job-pause-all";

/** renderer 侧 t-call 助手（返回原始结果对象，断言 PauseAllResult 结构） */
const icall = (page: any, method: string, ...args: string[]) =>
  page.evaluate(async ([m, a]: [string, string[]]) => {
    const r = await (window as any).javDesktop.call(m, a);
    return { ok: r.ok, data: r.data, error: r.error, network: r.network };
  }, [method, args]);

async function healthPaused(req: APIRequestContext): Promise<boolean> {
  const r = await req.get(`${MOCK}/health`);
  const d = (await r.json()) as { paused?: boolean };
  return d.paused === true;
}

function pipelinePaused(userData: string): boolean {
  const raw = JSON.parse(readFileSync(join(userData, "client-config.json"), "utf-8")) as { pipeline_paused?: boolean };
  return raw.pipeline_paused === true;
}

test("暂停所有/继续往返 + 本机管线闸 + 持久化 + 单端离线降级", async ({ userData, page, request }) => {
  // mockPause 冻结 mock tick：running 行不会秒完，保证在途行稳定存在（hasActive → 按钮可见）
  await mockPause(request);
  await mockSeed(request, { n: 1, status: "running", progress: 40 });
  await goView(page, "jobs");

  const btn = page.locator(BTN);
  await expect(btn).toBeVisible();
  await expect(btn).toHaveText("⏸ 暂停所有");
  page.on("dialog", (d) => d.accept()); // 暂停方向有确认框（继续方向无）

  // ---- 暂停：本机管线闸生效 + mock 队列冻结 ----
  await btn.click();
  await expect(page.locator("#toasts .toast.ok").last()).toContainText("已暂停");
  expect(await healthPaused(request)).toBe(true); // PRD 验收：serve /health paused=true
  await expect(btn).toHaveText("▶ 继续任务", { timeout: 30_000 });
  await expect.poll(() => pipelinePaused(userData), { timeout: 10_000 }).toBe(true); // 闸态持久化（重启不丢）

  // ---- 本机管线闸（等待式）：暂停期间新上传在 IPC 入口挂起，不触及 mock ----
  await page.evaluate(() => {
    (window as any).__gateProbe = null;
    (window as any).javDesktop.upload.file({
      id: "gate-probe", engine: "mock", name: "gate-probe.mp4", ext: "mp4", data: new Uint8Array(1),
    }).then(
      (r: any) => { (window as any).__gateProbe = { resolved: true, ok: !!r.ok, job_id: r.job_id || "" }; },
      (e: unknown) => { (window as any).__gateProbe = { resolved: true, error: String(e) }; },
    );
  });
  await page.waitForTimeout(3000);
  expect(await page.evaluate(() => (window as any).__gateProbe), "暂停期间上传应挂起未执行").toBeNull();

  // ---- 继续：无确认；队列解冻、闸放行、持久化清除 ----
  await btn.click();
  await expect(page.locator("#toasts .toast.ok").last()).toContainText("已继续");
  expect(await healthPaused(request)).toBe(false);
  await expect(btn).toHaveText("⏸ 暂停所有", { timeout: 30_000 });
  await expect.poll(() => pipelinePaused(userData), { timeout: 10_000 }).toBe(false);
  await expect
    .poll(() => page.evaluate(() => (window as any).__gateProbe), { timeout: 20_000 })
    .toMatchObject({ resolved: true, ok: true }); // 恢复后挂起的上传被受理（mock 201 → job_id）

  // ---- 单端离线降级：加一个死端口端，暂停扇出逐端可辨，在线端不受影响 ----
  expect((await icall(page, "addEngine", "dead", "http://127.0.0.1:8399", "")).ok).toBe(true);
  await page.waitForFunction(
    () => {
      const s = (window as any).state;
      return !!s?.engines?.some((e: any) => e.name === "dead" && e.online === false);
    },
    { timeout: 30_000 },
  );
  const r = await icall(page, "pauseAll", "true");
  expect(r.ok).toBe(true); // 整体不 throw：单端失败不影响受理
  expect(r.data.ok).toBe(true);
  expect(r.data.paused).toBe(true);
  expect(r.data.engines).toEqual(expect.arrayContaining([
    expect.objectContaining({ engine: "mock", ok: true, paused: true }),
    expect.objectContaining({ engine: "dead", ok: false, error: "服务离线" }),
  ]));
  expect(await healthPaused(request)).toBe(true); // 在线端照旧冻结：离线端不阻塞整体

  // 恢复收尾：扇出含离线端 → 走降级分支，toast err 列出坏端（此场景无 ok toast；
  // 旧断言 .toast.ok 只靠首次继续的 8s 存活旧 toast 假绿，运行变慢即超时红）
  await expect(btn).toHaveText("▶ 继续任务", { timeout: 30_000 });
  await btn.click(); // 继续方向无确认框
  await expect(page.locator("#toasts .toast.err").last()).toContainText("dead：服务离线");
  expect(await healthPaused(request)).toBe(false);
  await expect(btn).toHaveText("⏸ 暂停所有", { timeout: 30_000 });
});

/**
 * 回归（P2-2 补漏）：renderPauseAllBtn 曾在 busy 期间置 btn.disabled=true 后从不复位——
 * 派发在途期渲染过按钮的客户端，之后 busy 结束按钮永久禁用（真机 0.2.38 V4 90s 点击卡死）。
 * 造法：mockPause 冻结一条 running 行（hasActive 恒真、按钮恒可见）→ 真实派发 2 项文件夹批
 * （state.busy=true 直至整批 settled，行优先 300ms pending 渲染保证 busy 期必渲染）→
 * busy 期断按钮禁用（新旧代码均可达，防假通过）→ settled 后断按钮恢复可用（旧代码恒禁用→超时红）。
 */
test("回归：派发在途期「暂停所有」禁用 → 派发 settled 后必须恢复可用（busy 复位）", async ({ page, request }) => {
  await mockPause(request); // 冻结 mock tick：种子行与派发行都不会自行跑完
  await mockSeed(request, { n: 1, status: "running", progress: 40 });
  await mockUploadDelay(request, 1500); // 撑住「上传中」帧：busy 窗口足够长，稳定捕获 busy 期渲染

  const btn = page.locator(BTN);
  await goView(page, "jobs");
  await expect(btn).toBeVisible({ timeout: 20_000 });
  await expect(btn).toBeEnabled(); // 初始非 busy → 可用（也确认按钮走的是 disabled 而非 hidden 路径）

  // 真实派发：文件夹批 2 项（夹具小文件低于默认「忽略小于 200MB」→ 默认 0 勾选，手动勾 2 个视频）
  await goView(page, "dispatch");
  await page.setInputFiles("#folder", FIXTURES);
  await expect(page.locator("#folder-table tbody tr")).toHaveCount(3, { timeout: 20_000 });
  await page.locator("#folder-table tbody tr", { hasText: "video-a.mp4" }).locator("input[type=checkbox]").check();
  await page.locator("#folder-table tbody tr", { hasText: "video-b.mkv" }).locator("input[type=checkbox]").check();
  await page.selectOption("#engine-select", "mock");
  await page.click("#dispatch-go");
  await expect(page.locator(".job-batch-row")).toHaveCount(1, { timeout: 20_000 });

  // busy 期：pending 行 300ms 合帧渲染 → renderPauseAllBtn 在 state.busy=true 下执行 → 禁用
  await expect(btn).toBeDisabled({ timeout: 30_000 });

  // 整批 settled（提交/失败即结，不等 serve 终态）→ state.busy=false
  await expect
    .poll(() => page.evaluate(() => (window as any).state?.busy), { timeout: 120_000, intervals: [500] })
    .toBe(false);

  // 冻结的 running 行仍在途 → 按钮仍可见；修复后下一拍渲染（serve 轮询 ≤5s）必须复位为可用。
  // 旧代码（if busy → disabled=true，从不复位）会在此恒禁用 → toBeEnabled 超时失败 = 回归生效。
  await expect(btn).toBeVisible({ timeout: 10_000 });
  await expect(btn).toBeEnabled({ timeout: 15_000 });
});
