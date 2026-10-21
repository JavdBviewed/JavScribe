// client/core/concurrency.ts createPool 分组准入（M2 按盘公平）常驻单测（node 直接跑，无框架依赖）
// 运行：pnpm test:unit:client
// 0.2.52 M2：run() 的 hooks 可带 groupKey（文件所在盘，diskKeyOf 口径；空/缺省 = 无分组）：
//   - 无 groupKey：纯 FIFO，行为与改动前逐字节一致（回归守卫）
//   - 带 groupKey：有空闲槽时先为「在跑=0 且在队>0」的每组各放 1 个（保底 1），余量按原 FIFO 补；
//     全局 limit 上限不变，不改任务最终状态/结果
// 用 esbuild 打包 TS 后对行为做断言（与 concurrency.test.mjs 同模式）。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const tsSrc = resolve(here, "../../core/concurrency.ts");
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const tmp = await mkdtemp(resolve(tmpdir(), "pfair-"));
try {
  const out = resolve(tmp, "pfair.cjs");
  await build({ entryPoints: [tsSrc], bundle: true, format: "cjs", outfile: out, logLevel: "silent" });
  const mod = await import(`file://${out}`);
  const { createPool } = mod.default ?? mod;

  // 门控任务世界：任务体只在 gate 放行时 resolve；started 记录「真正拿到槽开跑」的顺序
  const mkWorld = (limitOf) => {
    const p = createPool(limitOf);
    const started = [];
    const gate = new Map();
    const run = (name, key) => p.run(
      () => new Promise((res) => {
        started.push(name);
        gate.set(name, () => res(name));
      }),
      key != null ? { groupKey: key } : undefined,
    );
    return { p, started, gate, run };
  };

  // ---------- 用例 1：两盘交替到队 → 启动序 A1,B1,A2,B2，无单盘独占双槽（形态守卫） ----------
  {
    const { p, started, gate, run } = mkWorld(() => 2);
    const pr = [run("A1", "A"), run("B1", "B"), run("A2", "A"), run("B2", "B")];
    await tick();
    assert.deepEqual(started, ["A1", "B1"], "首波：两盘各 1 个直通（limit=2）");
    assert.equal(p.waiting(), 2, "A2/B2 排队");
    gate.get("A1")();
    await tick();
    assert.deepEqual(started, ["A1", "B1", "A2"], "A 在跑归零后，A2 拿保底槽（B2 仍在队）");
    gate.get("B1")();
    await tick();
    assert.deepEqual(started, ["A1", "B1", "A2", "B2"], "B 在跑归零后，B2 拿保底槽");
    for (const g of [...gate.values()]) g("done");
    await Promise.all(pr);
    assert.equal(p.active(), 0, "结束后无残留");
    assert.equal(p.waiting(), 0);
  }
  console.log("ok 1 - 两盘交替到队：各盘保底 1 个，无单盘独占双槽");

  // ---------- 用例 2：队列排出公平（机制判据：FIFO 会红） ----------
  // A1/B1 在跑，队列 A2,A3,B2（A 前缀占队首）→ 同时放行 A1+B1（2 空槽）：
  //   公平准入 = A2 + B2（各盘保底 1）；纯 FIFO = A2 + A3（单盘占双槽，B 盘饥饿）
  {
    const { p, started, gate, run } = mkWorld(() => 2);
    const pr = [run("A1", "A"), run("B1", "B"), run("A2", "A"), run("A3", "A"), run("B2", "B")];
    await tick();
    assert.deepEqual(started, ["A1", "B1"], "A1/B1 在跑");
    assert.equal(p.waiting(), 3, "A2/A3/B2 在队");
    gate.get("A1")();
    gate.get("B1")(); // 同一同步块放行 = 两槽同拍释放
    await tick();
    assert.ok(started.includes("A2") && started.includes("B2"), "两空槽：A/B 各放 1 个（保底）");
    assert.ok(!started.includes("A3"), "A3 仍在队：同盘不得独占双槽");
    assert.equal(p.waiting(), 1, "仅 A3 等待");
    gate.get("B2")();
    await tick();
    assert.ok(started.includes("A3"), "B2 完成后 A3 再拿槽");
    for (const g of [...gate.values()]) g("done");
    await Promise.all(pr);
    assert.equal(p.active(), 0);
  }
  console.log("ok 2 - 队列排出公平：双空槽时各盘各 1 个，单盘不占双槽");

  // ---------- 用例 3：单组（全同 groupKey）→ 与纯 FIFO 完全一致（同组不限并发、不重排） ----------
  {
    const { p, started, gate, run } = mkWorld(() => 2);
    const pr = [run("S1", "D"), run("S2", "D"), run("S3", "D"), run("S4", "D")];
    await tick();
    assert.deepEqual(started, ["S1", "S2"], "同组首波 2 个直通（同组不限并发）");
    gate.get("S1")();
    await tick();
    assert.deepEqual(started, ["S1", "S2", "S3"], "S1 完成 → S3 按 FIFO 顺序（无组保底延迟）");
    gate.get("S2")();
    await tick();
    assert.deepEqual(started, ["S1", "S2", "S3", "S4"], "S2 完成 → S4 跟上");
    for (const g of [...gate.values()]) g("done");
    await Promise.all(pr);
    assert.equal(p.active(), 0);
  }
  console.log("ok 3 - 单组 = 纯 FIFO（同组不限并发）");

  // ---------- 用例 4：不传 groupKey（旧调用方）→ 纯 FIFO 回归 ----------
  {
    const { p, started, gate, run } = mkWorld(() => 2);
    const pr = [run("N1"), run("N2"), run("N3"), run("N4")];
    await tick();
    assert.deepEqual(started, ["N1", "N2"], "无分组：前 2 直通");
    gate.get("N1")();
    await tick();
    assert.deepEqual(started, ["N1", "N2", "N3"], "无分组：FIFO 顺序不变");
    gate.get("N2")();
    await tick();
    assert.deepEqual(started, ["N1", "N2", "N3", "N4"]);
    for (const g of [...gate.values()]) g("done");
    await Promise.all(pr);
    assert.equal(p.active(), 0);
  }
  console.log("ok 4 - 无 groupKey 回归：行为与原 FIFO 一致");

  // ---------- 用例 5：limit 调大 + wake（设置热重载路径）叠加分组准入 ----------
  {
    let limit = 1;
    const { p, started, gate, run } = mkWorld(() => limit);
    const pr = [run("A1", "A"), run("B1", "B"), run("A2", "A")];
    await tick();
    assert.deepEqual(started, ["A1"], "limit=1：仅 A1 在跑");
    limit = 3;
    p.wake(); // 设置保存 → 立即释放等待者
    await tick();
    assert.deepEqual(started, ["A1", "B1", "A2"], "调大后：B 盘保底 1 个 + 余量 FIFO 补 A2");
    for (const g of [...gate.values()]) g("done");
    await Promise.all(pr);
    assert.equal(p.active(), 0);
  }
  console.log("ok 5 - 调大 limit + wake 叠加分组准入");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
