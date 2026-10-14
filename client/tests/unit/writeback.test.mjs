// client/core/writeback.ts 常驻单测（node 直接跑，无框架依赖）
// 运行：pnpm test:unit:client
// 10-13-javscribe-client-writeback-guard 背景（F2，run10 A3 实锤）：写回只认同会话观测到的
// running→done 转换（notifyJobChanges prev === "running"），快任务（首次轮询已 done）、
// 客户端重启后首见的行（knownJobs 内存态重启即空 → prev=undefined）转换不可见 → 永不写回。
// 对账式决策不依赖转换观测：done + 已登记 + 门控通过 即触发；幂等靠登记消费。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const tsSrc = resolve(here, "../../core/writeback.ts");

const tmp = await mkdtemp(resolve(tmpdir(), "wb-"));
try {
  const out = resolve(tmp, "wb.cjs");
  await build({ entryPoints: [tsSrc], bundle: true, format: "cjs", outfile: out, logLevel: "silent" });
  const mod = await import(`file://${out}`);
  const ex = mod.default ?? mod;
  const { jobKey, pickWriteBackRows } = ex;

  // ---------- jobKey ----------
  assert.equal(jobKey("127", "j1"), "127|j1");
  assert.equal(jobKey("158", "20261013-4064e8"), "158|20261013-4064e8");
  console.log("ok 1 - jobKey");

  const doneRow = { engine: "127", job_id: "j1", file: "movie.mp4", status: "done" };
  const gate = (o = {}) => ({
    autoSave: false,
    registered: new Set(["127|j1"]),
    forced: new Set(),
    ...o,
  });

  // 1. reconcile 首见即 done（knownJobs 空、prev=undefined）+ 已登记 + 本地源强制 → 触发写回（F2 快任务）
  {
    const known = new Map(); // 首见：无任何转换记忆（prev=undefined）
    const picked = pickWriteBackRows([doneRow], gate({ forced: new Set(["127|j1"]) }));
    assert.equal(known.size, 0, "首见时 knownJobs 为空（prev=undefined）");
    assert.equal(picked.length, 1, "首见 done + 已登记 + 强制 → 触发");
    assert.equal(picked[0].job_id, "j1");
  }
  console.log("ok 2 - 首见即 done（prev=undefined）触发写回（F2 快任务）");

  // 2. 重启模拟：knownJobs 内存态重启即空 → 首轮 reconcile 见 done → 触发写回（F2 重启）
  {
    const known = new Map([["127|j1|movie.mp4", "running"]]); // 重启前的内存态
    known.clear();                                             // 重启：内存态清空
    const picked = pickWriteBackRows([doneRow], gate({ forced: new Set(["127|j1"]) }));
    assert.equal(known.size, 0, "重启后 knownJobs 为空");
    assert.equal(picked.length, 1, "重启后首轮 reconcile 见 done → 触发写回（不要求 prev==='running'）");
  }
  console.log("ok 3 - 重启模拟（knownJobs 清空）首轮 reconcile 触发写回（F2 重启）");

  // 3. desktop 本地源 + autoSave=off → 写回（F1 门控放开）；
  //    无本地源（不在 forced）+ autoSave=off → 不写回（web 回归）；autoSave=on → 写回（回归）
  {
    assert.equal(
      pickWriteBackRows([doneRow], gate({ forced: new Set(["127|j1"]) })).length,
      1,
      "desktop 本地源（forced）+ autoSave=off → 写回（F1）",
    );
    assert.equal(
      pickWriteBackRows([doneRow], gate()).length,
      0,
      "无本地源（未 forced）+ autoSave=off → 不写回（web 回归）",
    );
    assert.equal(
      pickWriteBackRows([doneRow], gate({ autoSave: true })).length,
      1,
      "autoSave=on → 写回（回归）",
    );
  }
  console.log("ok 4 - 门控语义：本地源强制放开门控、web 行为不变（F1 + 回归）");

  // 4. 边界：非 done 终态 / 运行中 / 无 job_id / 未登记 → 不触发
  {
    const g = gate({
      registered: new Set(["127|j1", "127|j2", "127|j3", "127|j4", "127|j5"]),
      forced: new Set(["127|j1", "127|j2", "127|j3", "127|j4", "127|j5"]),
    });
    const rows = [
      { engine: "127", job_id: "j1", status: "skipped" },
      { engine: "127", job_id: "j2", status: "error" },
      { engine: "127", job_id: "j3", status: "canceled" },
      { engine: "127", job_id: "j4", status: "running" },
      { engine: "127", job_id: null, status: "done" },
      { engine: "127", job_id: "j5", status: "done" },
      { engine: "158", job_id: "jx", status: "done" }, // 未登记（他端/无本机登记）
    ];
    assert.deepEqual(pickWriteBackRows(rows, g).map((r) => r.job_id), ["j5"]);
  }
  console.log("ok 5 - 边界：skipped/error/canceled/running/无 job_id/未登记 均不触发");

  // 5. 幂等：触发后调用方消费登记（writeBackJobs/watchWriteBack 同删）→ 下轮不重复触发
  {
    const registered = new Set(["127|j1"]);
    const forced = new Set(["127|j1"]);
    assert.equal(pickWriteBackRows([doneRow], gate({ registered, forced })).length, 1, "首轮触发");
    registered.delete("127|j1"); // maybeWriteBack 收口消费
    forced.delete("127|j1");
    assert.equal(pickWriteBackRows([doneRow], gate({ registered, forced })).length, 0, "登记消费后下轮不再触发");
  }
  console.log("ok 6 - 幂等：登记消费后不重复触发");

  console.log("writeback: all ok");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
