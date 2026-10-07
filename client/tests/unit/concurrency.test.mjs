// client/core/concurrency.ts 常驻单测（node 直接跑，无框架依赖）
// 运行：pnpm test:unit:client
// S4 背景：extract_workers / queue_cap 保存后客户端零消费（假「立即生效」）。
// 本线新增两个消费点，纯逻辑抽到 core 便于单测：
//   1. 提取并发（createPool 可 resize 工作池）：web wasm 池 / desktop IPC 池共用
//   2. 派发限流（queue_cap per-service 在途封顶）：canStartInFlight + countInFlightRows
// 用 esbuild 打包 TS 后对行为做断言（与 srt-sanitize 套件同模式）。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const tsSrc = resolve(here, "../../core/concurrency.ts");

const tmp = await mkdtemp(resolve(tmpdir(), "cc-"));
try {
  const out = resolve(tmp, "cc.cjs");
  await build({ entryPoints: [tsSrc], bundle: true, format: "cjs", outfile: out, logLevel: "silent" });
  const mod = await import(`file://${out}`);
  const ex = mod.default ?? mod;
  const { createPool, canStartInFlight, countInFlightRows, normalizeClientConfig, TERMINAL_JOB_STATUSES } = ex;

  // ---------- TERMINAL_JOB_STATUSES ----------
  assert.ok(TERMINAL_JOB_STATUSES.has("done"), "done 是终态");
  assert.ok(TERMINAL_JOB_STATUSES.has("skipped"), "skipped 是终态");
  assert.ok(TERMINAL_JOB_STATUSES.has("error"), "error 是终态");
  assert.ok(TERMINAL_JOB_STATUSES.has("canceled"), "canceled 是终态");
  for (const s of ["running", "pending", "paused", ""]) {
    assert.ok(!TERMINAL_JOB_STATUSES.has(s), `${s || "(空)"} 不是终态`);
  }
  console.log("ok 1 - TERMINAL_JOB_STATUSES 终态集");

  // ---------- countInFlightRows（queue_cap 在途行计数） ----------
  const rows = [
    { engine: "A", job_id: "j1", status: "running" },                       // 在途（desktop：local 未定义）
    { engine: "A", job_id: "j2", status: "pending", paused: true },         // 在途（挂起仍占槽）
    { engine: "A", job_id: "j3", status: "done" },                          // 终态
    { engine: "A", job_id: "j4", status: "canceled" },                      // 终态
    { engine: "A", job_id: "", status: "running", phase: "extracting" },    // 本机管线行（无 job_id）→ 链记账覆盖，不计
    { engine: "A", job_id: null, status: "running" },                       // 同上
    { engine: "A", job_id: "j5", status: "running", local: false },         // 他端提交 → 不占本客户端 cap
    { engine: "A", job_id: "j6", status: "running", local: true },          // 本机提交 → 计
    { engine: "B", job_id: "j7", status: "running", local: true },          // 别的服务 → 不计 A
  ];
  assert.equal(countInFlightRows(rows, "A"), 3, "A 在途 = j1 + j2(paused) + j6 = 3");
  assert.equal(countInFlightRows(rows, "B"), 1, "B 在途 = j7 = 1");
  assert.equal(countInFlightRows(rows, "C"), 0, "未知服务 = 0");
  assert.equal(countInFlightRows([], "A"), 0, "空列表 = 0");
  console.log("ok 2 - countInFlightRows 在途行计数（归属/终态/管线行排除）");

  // ---------- canStartInFlight（queue_cap 派发决策） ----------
  const fl = (n) => (engine) => (engine === "A" ? n : 0);
  assert.equal(canStartInFlight({ engine: "A", cap: 1, inFlight: fl(0) }), true, "显式引擎：0/1 放行");
  assert.equal(canStartInFlight({ engine: "A", cap: 1, inFlight: fl(1) }), false, "显式引擎：1/1 封顶");
  assert.equal(canStartInFlight({ engine: "A", cap: 2, inFlight: fl(1) }), true, "显式引擎：1/2 放行");
  assert.equal(canStartInFlight({ engine: "A", cap: 0, inFlight: fl(0) }), true, "cap 下限 1：cap=0 按 1 处理仍放行 0 在途");
  assert.equal(canStartInFlight({ engine: "A", cap: 0, inFlight: fl(1) }), false, "cap 下限 1：1 在途 = 封顶");
  const autos = [
    { name: "A", online: true },
    { name: "B", online: true },
    { name: "C", online: false },
    { name: "D", online: true, enabled: false },
  ];
  const flAB = (engine) => (engine === "A" ? 1 : engine === "B" ? 0 : 0);
  assert.equal(
    canStartInFlight({ engine: "auto", cap: 1, inFlight: flAB, engines: autos }),
    true, "auto：B 有空位（A 满、C 离线、D 不参与均衡）→ 放行");
  assert.equal(
    canStartInFlight({ engine: "auto", cap: 1, inFlight: () => 1, engines: autos }),
    false, "auto：A/B 全满 → 停发");
  assert.equal(
    canStartInFlight({ engine: "auto", cap: 1, inFlight: () => 0, engines: [{ name: "C", online: false }] }),
    false, "auto：无在线候选 → 停发");
  assert.equal(
    canStartInFlight({ engine: "auto", cap: 1, inFlight: () => 0, engines: [] }),
    false, "auto：空候选列表 → 停发");
  console.log("ok 3 - canStartInFlight 显式/auto 限流决策");

  // ---------- createPool（extract_workers 可 resize 提取池） ----------
  // cap=1：3 个任务任一时刻仅 1 个在跑，FIFO 顺序，全部完成
  {
    const p = createPool(() => 1);
    let cur = 0, max = 0, order = [];
    const task = (name, ms) => () => new Promise((res) => {
      cur++; max = Math.max(max, cur);
      order.push(`s:${name}`);
      setTimeout(() => { cur--; order.push(`e:${name}`); res(name); }, ms);
    });
    const rs = await Promise.all([p.run(task("a", 40)), p.run(task("b", 10)), p.run(task("c", 5))]);
    assert.deepEqual(rs, ["a", "b", "c"], "全部完成且按提交顺序完成（FIFO）");
    assert.equal(max, 1, "cap=1 时最大并发 = 1");
    assert.equal(p.active(), 0, "结束后无残留");
    assert.equal(order.join(","), "s:a,e:a,s:b,e:b,s:c,e:c", "严格串行 FIFO");
  }
  console.log("ok 4 - pool cap=1 串行 FIFO");

  // 调大即生效（无需重建）：A 在跑、B/C 等待 → limit 1→3 + wake → B/C 立即启动
  {
    let limit = 1;
    const p = createPool(() => limit);
    let running = 0, maxRunning = 0;
    const gate = new Map();
    const mk = (name) => () => new Promise((res) => {
      running++; maxRunning = Math.max(maxRunning, running);
      gate.set(name, (v) => { running--; res(v); });
    });
    const pa = p.run(mk("a"));
    const pb = p.run(mk("b"));
    const pc = p.run(mk("c"));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(running, 1, "cap=1：仅 A 在跑");
    assert.equal(p.active(), 1);
    assert.equal(p.waiting(), 2, "B/C 在等待");
    limit = 3;
    p.wake(); // 保存设置后 app 调用：立即释放等待者
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(running, 3, "调大 1→3 后 B/C 无需 A 完成即启动（热重载）");
    assert.equal(maxRunning, 3, "最大并发 = 3 = 新 cap");
    for (const g of [...gate.values()]) g("done");
    await Promise.all([pa, pb, pc]);
    assert.equal(p.active(), 0, "全部完成后归零");
  }
  console.log("ok 5 - pool 调大热生效（wake 释放等待者）");

  // 调小不中断在跑者，新获取者等待到 active < limit
  {
    let limit = 3;
    const p = createPool(() => limit);
    let running = 0, maxRunning = 0;
    const gate = new Map();
    const mk = (name) => () => new Promise((res) => {
      running++; maxRunning = Math.max(maxRunning, running);
      gate.set(name, (v) => { running--; res(v); });
    });
    const pa = p.run(mk("a"));
    const pb = p.run(mk("b"));
    const pc = p.run(mk("c"));
    const pd = p.run(mk("d"));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(running, 3, "cap=3：a/b/c 在跑，d 等待");
    limit = 1;
    p.wake(); // 调小：不中断已持有者
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(running, 3, "调小 3→1：在跑者不受影响");
    assert.equal(p.waiting(), 1, "d 仍在等待（1/1 满）");
    gate.get("a")("done");
    gate.get("b")("done");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(running, 1, "a/b 完成后仅 c 在跑（调小不中断在跑者）");
    assert.equal(p.waiting(), 1, "d 仍等待（c 占唯一槽）");
    gate.get("c")("done");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(gate.has("d"), true, "c 完成后 d 获得槽位启动");
    assert.equal(running, 1, "d 启动，running=1 ≤ 新 cap");
    assert.equal(maxRunning, 3, "调小前已启动的 3 并发不被追溯中断");
    gate.get("d")("done");
    await Promise.all([pa, pb, pc, pd]);
    assert.equal(p.active(), 0);
  }
  console.log("ok 6 - pool 调小不中断在跑者、新获取者排队");

  // 任务失败也释放槽位（finally 语义）
  {
    const p = createPool(() => 1);
    const boom = () => Promise.reject(new Error("提取失败"));
    const p1 = p.run(boom).catch((e) => e.message);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(p.active(), 0, "拒绝后槽位立即释放（finally）");
    assert.equal(await p1, "提取失败", "错误原样传播");
    let ok = false;
    await p.run(async () => { ok = true; });
    assert.ok(ok, "后续任务正常获取槽位");
  }
  console.log("ok 7 - pool 失败释放槽位");

  // 脏值防御：limit 读数为 NaN/负/0 → 回落默认 2（与 extract_workers 默认一致，不致锁死 0）
  {
    const p = createPool(() => NaN);
    let n = 0, max = 0;
    const t = () => new Promise((res) => { n++; max = Math.max(max, n); setTimeout(res, 20); });
    await Promise.all([p.run(t), p.run(t)]);
    assert.equal(max, 2, "NaN limit → 回落默认 2");
  }
  console.log("ok 8 - pool 脏 limit 防御");

  // ---------- normalizeClientConfig（保存/读回的值域钳制） ----------
  {
    const cc = normalizeClientConfig({ extract_workers: 2, queue_cap: 4 });
    assert.deepEqual(cc, { extract_workers: 2, queue_cap: 4 }, "合法值原样");
    assert.deepEqual(normalizeClientConfig({ extract_workers: 99, queue_cap: -3 }),
      { extract_workers: 8, queue_cap: 1 }, "越界 clamp（8/1）");
    assert.deepEqual(normalizeClientConfig({ extract_workers: "x", queue_cap: null }),
      { extract_workers: 2, queue_cap: 4 }, "脏值回落默认（2/4）");
    assert.deepEqual(normalizeClientConfig(null), { extract_workers: 2, queue_cap: 4 }, "null → 默认");
    const withPause = normalizeClientConfig({ extract_workers: 1, queue_cap: 16, pipeline_paused: true });
    assert.equal(withPause.pipeline_paused, true, "pipeline_paused 保留");
    assert.equal(normalizeClientConfig({ extract_workers: 1, queue_cap: 16 }).pipeline_paused, undefined, "未提供则不补 pipeline_paused");
  }
  console.log("ok 9 - normalizeClientConfig 值域钳制/默认回落");

  console.log("concurrency.test: 9/9 组断言全过");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
