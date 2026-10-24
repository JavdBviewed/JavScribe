// client/core/ledger.ts 单测（0.2.57 中断态账本）
// 运行：pnpm test:unit:client
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = await mkdtemp(resolve(tmpdir(), "ledger-"));
try {
  const out = resolve(tmp, "ledger.cjs");
  await build({
    entryPoints: [resolve(here, "../../core/ledger.ts")],
    bundle: true, format: "cjs", outfile: out, logLevel: "silent",
  });
  const mod = await import(`file://${out}`);
  const ex = mod.default ?? mod;
  const {
    INTERRUPTED, TERMINAL_LIKE, LEDGER_TTL_MS, LEDGER_MAX_CHILDREN, LEDGER_MAX_SUPPRESS,
    normalizeChild, migrateInterrupted, pruneLedger, pendingFingerprint,
    childFromPendingRow, cleanupCatOf, CLEANUP_CATS,
  } = ex;

  const NOW = 1_760_000_000_000;
  const mk = (over = {}) => ({
    batch_id: "b1", batch_label: "批次A", engine: "127-npc", job_id: "j1",
    videoName: "AAA-001.mp4", status: "running", progress: 40, message: "提取中",
    created: NOW - 5000, finished: null, updatedAt: NOW - 1000, ...over,
  });

  // ---------- normalizeChild ----------
  const n = normalizeChild(mk(), NOW);
  assert.equal(n.videoName, "AAA-001.mp4");
  assert.equal(n.file_path, null);            // 旧数据无新字段 → null
  assert.equal(n.last_status, null);
  assert.equal(n.interrupted_at, null);
  assert.ok(n.interrupted_reason === undefined);
  // 旧数据缺 updatedAt → 兜底 now；缺 status/videoName → 拒收
  assert.equal(normalizeChild({ ...mk(), updatedAt: undefined }, NOW).updatedAt, NOW);
  assert.equal(normalizeChild({ videoName: "x" }, NOW), null);
  assert.equal(normalizeChild(null, NOW), null);
  // 新字段原样保留
  const n2 = normalizeChild({ ...mk(), status: "interrupted", file_path: "/media/a.mp4", last_status: "running", interrupted_at: 123, interrupted_reason: "客户端重启，任务链路断开" }, NOW);
  assert.equal(n2.file_path, "/media/a.mp4");
  assert.equal(n2.interrupted_at, 123);
  assert.equal(n2.interrupted_reason, "客户端重启，任务链路断开");
  console.log("ok 1 - normalizeChild 旧数据兼容 + 拒收");

  // ---------- migrateInterrupted：迁移 + 幂等 + last_status 只记第一次 ----------
  const children = {
    k1: mk({ status: "running" }),
    k2: mk({ status: "pending", updatedAt: NOW - 2000 }),
    k3: mk({ status: "done", finished: NOW - 100 }),      // 终态不动
    k4: mk({ status: "error" }),                           // 终态不动
    k5: mk({ status: "interrupted", last_status: "running", interrupted_at: 111 }), // 已中断不动
  };
  let changed = migrateInterrupted(children, NOW, "客户端重启，任务链路断开");
  assert.equal(changed, 2);
  assert.equal(children.k1.status, "interrupted");
  assert.equal(children.k1.last_status, "running");
  assert.equal(children.k1.interrupted_at, NOW - 1000);   // = 迁移前 updatedAt
  assert.equal(children.k1.interrupted_reason, "客户端重启，任务链路断开");
  assert.equal(children.k2.last_status, "pending");
  assert.equal(children.k3.status, "done");
  assert.equal(children.k4.status, "error");
  // 幂等：再跑一遍 0 改动，last_status 不被覆盖
  changed = migrateInterrupted(children, NOW + 500, "客户端退出，任务链路断开");
  assert.equal(changed, 0, "二次迁移必须 0 改动（k3/k4 终态跳过，k1/k2/k5 已中断跳过）");
  console.log("ok 2 - migrateInterrupted 迁移/幂等/last_status 首记");
  assert.equal(children.k1.last_status, "running", "last_status 不可被二次迁移覆盖");
  assert.equal(children.k1.interrupted_reason, "客户端重启，任务链路断开", "reason 保留首次");

  // 边界：updatedAt 缺失 → interrupted_at 兜底 now
  const c2 = { k9: mk({ status: "extracting", updatedAt: 0 }) };
  migrateInterrupted(c2, NOW, "r");
  assert.equal(c2.k9.interrupted_at, NOW);

  // ---------- pruneLedger：TTL ----------
  const c3 = { a: mk({ updatedAt: NOW - LEDGER_TTL_MS - 1 }), b: mk({ status: "done", updatedAt: NOW - 100 }) };
  assert.equal(pruneLedger(c3, [], NOW), true);
  assert.ok(!("a" in c3) && "b" in c3);
  assert.equal(pruneLedger(c3, [], NOW), false);

  // ---------- pruneLedger：子行上限（先剪终态，再剪任意） ----------
  const c4 = {};
  for (let i = 0; i < LEDGER_MAX_CHILDREN + 5; i++) {
    const terminal = i < 3; // 最旧的 3 条是终态
    c4["x" + i] = mk({ status: terminal ? "done" : "pending", updatedAt: NOW - (LEDGER_MAX_CHILDREN + 5 - i) });
  }
  assert.equal(pruneLedger(c4, [], NOW), true);
  assert.equal(Object.keys(c4).length, LEDGER_MAX_CHILDREN);
  assert.ok(!("x0" in c4) && !("x1" in c4) && !("x2" in c4), "最旧终态先剪");
  assert.ok(!("x3" in c4) && !("x4" in c4), "终态剪完按最旧任意继续剪满");
  assert.ok("x5" in c4);
  // 全部非终态时按 updatedAt 最旧剪
  const c5 = {};
  for (let i = 0; i < LEDGER_MAX_CHILDREN + 2; i++) {
    c5["y" + i] = mk({ status: "pending", updatedAt: NOW - (LEDGER_MAX_CHILDREN + 2 - i) });
  }
  pruneLedger(c5, [], NOW);
  assert.equal(Object.keys(c5).length, LEDGER_MAX_CHILDREN);
  assert.ok(!("y0" in c5) && !("y1" in c5));
  console.log("ok 3 - pruneLedger TTL/上限/优先剪终态");

  // ---------- pruneLedger：抑制集上限 ----------
  const sup = Array.from({ length: LEDGER_MAX_SUPPRESS + 10 }, (_, i) => "s" + i);
  assert.equal(pruneLedger({}, sup, NOW), true);
  assert.equal(sup.length, LEDGER_MAX_SUPPRESS);
  assert.equal(sup[0], "s10", "最旧优先剪");
  console.log("ok 4 - pruneLedger 抑制集上限");

  // ---------- pendingFingerprint ----------
  const base = { status: "running", phase: "extract", job_id: "j1", engine: "127-npc", finished: null, aborted: false };
  assert.equal(pendingFingerprint(base), "running|extract|j1|127-npc|0|0");
  // 进度 tick 不进指纹
  assert.equal(pendingFingerprint({ ...base, progress: 55 }), pendingFingerprint(base));
  // 状态迁移变指纹
  assert.notEqual(pendingFingerprint({ ...base, status: "done", finished: NOW }), pendingFingerprint(base));
  assert.notEqual(pendingFingerprint({ ...base, aborted: true }), pendingFingerprint(base));
  console.log("ok 5 - pendingFingerprint 仅状态迁移");

  // ---------- childFromPendingRow：file_path 透传 ----------
  const row = {
    batch_id: "b1", batch_label: "批次A", engine: "158-npc", job_id: null,
    file: "BBB-002.mp4", label: "BBB-002.mp4", status: "running", progress: 12,
    phase_detail: "本地提取音轨…", position: null, message: null,
    created: NOW - 100, finished: null, local_path: "D:\\Videos\\BBB-002.mp4",
  };
  const ch = childFromPendingRow(row, NOW);
  assert.equal(ch.file_path, "D:\\Videos\\BBB-002.mp4");
  assert.equal(ch.videoName, "BBB-002.mp4");
  assert.equal(ch.job_id, null);
  assert.equal(ch.updatedAt, NOW);
  // file_path 优先 local_path
  const ch2 = childFromPendingRow({ ...row, file_path: "/media/x.mp4" }, NOW);
  assert.equal(ch2.file_path, "/media/x.mp4");
  // 皆无 → null
  const ch3 = childFromPendingRow({ engine: "127", file: "c.opus", status: "running", created: null }, NOW);
  assert.equal(ch3.file_path, null);
  assert.equal(ch3.created, null);
  console.log("ok 6 - childFromPendingRow file_path 透传");

  // ---------- cleanupCatOf ----------
  assert.deepEqual(CLEANUP_CATS.map((c) => c[0]), ["done", "skipped", "error", "canceled", "interrupted"]);
  assert.equal(cleanupCatOf("done"), "done");
  assert.equal(cleanupCatOf("interrupted"), "interrupted");
  assert.equal(cleanupCatOf("running"), null);
  assert.equal(cleanupCatOf("paused"), null);
  assert.equal(cleanupCatOf("extracting"), null);
  console.log("ok 7 - cleanupCatOf 五类口径");

  // ---------- 常量 ----------
  assert.equal(INTERRUPTED, "interrupted");
  assert.ok(TERMINAL_LIKE.has("interrupted") && TERMINAL_LIKE.has("done") && !TERMINAL_LIKE.has("running"));
  console.log("ok 8 - 常量");
} finally {
  await import("node:fs/promises").then((m) => m.rm(tmp, { recursive: true, force: true }).catch(() => {}));
}
console.log("PASS ledger.test");
