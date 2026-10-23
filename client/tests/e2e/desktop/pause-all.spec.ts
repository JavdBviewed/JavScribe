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
 * F-10（0.2.54）：「暂停所有/继续任务」不再受 busy 门控——提交进行中恰是最高频暂停场景，
 * 主进程管线闸 pipelineGateWait 挂起等待（不中断在途阶段）是唯一控制面。
 * 回归口径随行为更新：busy 期按钮必须保持可用（防 busy 门控回归；历史 0.2.38 V4「busy 期
 * disabled 从不复位永久卡死」的根因——busy 门控本身——已移除）→ settled 后仍可用。
 * 造法：mockPause 冻结一条 running 行（hasActive 恒真、按钮恒可见）→ 真实派发 2 项文件夹批
 * （state.busy=true 直至整批 settled，mockUploadDelay 撑住 busy 窗口，300ms pending 合帧渲染保证 busy 期必渲染）→
 * poll state.busy=true（防 busy 从未置位的假通过）→ busy 期断按钮可用 → settled 后断仍可用。
 */
test("F-10：派发在途期「暂停所有」保持可用（不受 busy 门控）→ settled 后仍可用", async ({ page, request }) => {
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

  // F-10：busy 期按钮保持可用——若回归为 busy 门控（busy 期置 disabled），此处超时红
  await expect
    .poll(() => page.evaluate(() => (window as any).state?.busy), { timeout: 30_000, intervals: [200] })
    .toBe(true);
  await expect(btn).toBeEnabled({ timeout: 10_000 });

  // 整批 settled（提交/失败即结，不等 serve 终态）→ state.busy=false
  await expect
    .poll(() => page.evaluate(() => (window as any).state?.busy), { timeout: 120_000, intervals: [500] })
    .toBe(false);

  // 冻结的 running 行仍在途 → 按钮仍可见且可用
  await expect(btn).toBeVisible({ timeout: 10_000 });
  await expect(btn).toBeEnabled({ timeout: 15_000 });
});

/**
 * F-12（0.2.55）：「暂停所有」可见性口径对齐看板展示行集 —— 仅本机 pending 子行在途
 * （serve 行全终态）时按钮必须可见。旧实现只看 state._jobs（桌面形态 serve-only）：
 * 批次处在本机提取/上传阶段（serve 行未生成）时按钮被误隐藏，提交/提取进行中恰是
 * 最高频暂停窗口，用户找不到入口（「暂停没效果」的另一变体）。
 * 造法：seed 1 条 done 行（serve 侧全终态 → 基线按钮隐藏）+ mockUploadDelay 撑住
 * 上传帧 + 真实派发 2 项文件夹批（提取并发=1）→ 窗口 = [建行 → 首项提交]（≈12s，
 * serve 侧恒全终态、本机子行恒在途）→ 断按钮可见（旧口径此处恒隐藏 = 回归红）
 * → 暂停冻结生效（管线闸持久化 + 按钮翻「继续任务」）→ 继续恢复 → 上传撑持结束
 * 后首项提交 → serve 活跃行接管，按钮持续可见。
 * 注：排队行「已暂停（全局暂停）」显示副本在 fixture 里只存活 <1s（提取极快即离队），
 * 不做 DOM 断言（必然竞态）；冻结态以按钮文案 + 持久化两个稳定口径覆盖。
 */
test("F-12：仅本机 pending 子行在途（serve 行全终态）「暂停所有」可见 + 冻结生效", async ({ page, request, userData }) => {
  await mockPause(request); // 冻结 tick：种子行/派发 serve 行不会自行跑完
  await mockSeed(request, { n: 1, status: "done" }); // serve 侧只有一条终态行
  await mockUploadDelay(request, 12_000); // 撑住上传帧：拉长「仅本机子行在途」窗口

  await goView(page, "jobs");
  const btn = page.locator(BTN);
  await expect(btn).toBeHidden({ timeout: 15_000 }); // 基线：只有终态行 → 无暂停对象 → 隐藏

  // 真实派发：文件夹批 2 项 + 批次提取并发=1 → 提取/上传/提交链串行
  await goView(page, "dispatch");
  await page.setInputFiles("#folder", FIXTURES);
  await expect(page.locator("#folder-table tbody tr")).toHaveCount(3, { timeout: 20_000 });
  await page.locator("#folder-table tbody tr", { hasText: "video-a.mp4" }).locator("input[type=checkbox]").check();
  await page.locator("#folder-table tbody tr", { hasText: "video-b.mkv" }).locator("input[type=checkbox]").check();
  await page.fill("#batch-extract-workers", "1");
  await page.selectOption("#engine-select", "mock");
  await page.click("#dispatch-go");
  await expect(page.locator(".job-batch-row")).toHaveCount(1, { timeout: 20_000 });

  // F-12 窗口不变式：serve 行全终态 + 本机 pending 子行在途（无 job_id）
  await expect
    .poll(() => page.evaluate(() => {
      const s = (window as any).state;
      const pend = Array.from(s?._pending?.values?.() ?? []);
      const local = pend.filter((p: any) => p.row.dispatch_pending && !p.row.job_id);
      const term = (st: string) => ["done", "skipped", "error", "canceled"].includes(st);
      return (
        (s?._jobs ?? []).length > 0 && (s?._jobs ?? []).every((j: any) => !j.job_id || term(j.status)) &&
        local.length >= 1 && local.some((p: any) => p.row.status === "running" || p.row.status === "pending")
      );
    }), { timeout: 45_000, intervals: [300] })
    .toBe(true);
  await expect(btn).toBeVisible({ timeout: 15_000 }); // 旧口径（仅 serve 行）此处恒隐藏 = 回归红

  // 暂停生效：管线闸冻结（持久化）+ 按钮翻「继续任务」（paused_all 稳定口径）
  page.on("dialog", (d) => d.accept());
  await btn.click();
  await expect(page.locator("#toasts .toast.ok").last()).toContainText("已暂停");
  await expect.poll(() => pipelinePaused(userData), { timeout: 10_000 }).toBe(true);
  await expect(btn).toHaveText("▶ 继续任务", { timeout: 15_000 });

  // 继续：闸放行、持久化清除、按钮复位
  await btn.click();
  await expect(page.locator("#toasts .toast.ok").last()).toContainText("已继续");
  await expect.poll(() => pipelinePaused(userData), { timeout: 10_000 }).toBe(false);
  await expect(btn).toHaveText("⏸ 暂停所有", { timeout: 15_000 });

  // 上传撑持结束后首项提交成功 → serve 活跃行接管（frozen running）→ 按钮持续可见
  await expect
    .poll(() => page.evaluate(() => {
      const s = (window as any).state;
      return (s?._jobs ?? []).some((r: any) => r.job_id && !["done", "skipped", "error", "canceled"].includes(r.status));
    }), { timeout: 90_000, intervals: [500] })
    .toBe(true);
  await expect(btn).toBeVisible({ timeout: 15_000 });
});
