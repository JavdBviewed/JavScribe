// client/core/scan-reconcile.ts 单测（0.2.47 需求1：扫描×已完成任务对账）
// 运行：pnpm test:unit:client
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = await mkdtemp(resolve(tmpdir(), "scanrec-"));
try {
  const out = resolve(tmp, "scanrec.cjs");
  await build({
    entryPoints: [resolve(here, "../../core/scan-reconcile.ts")],
    bundle: true, format: "cjs", outfile: out, logLevel: "silent",
  });
  const ex = (await import(`file://${out}`)).default ?? (await import(`file://${out}`));
  const { matchKeyOf, buildDoneJobIndex, matchScanItem } = ex;

  // ---------- matchKeyOf：local_path → label（视频名）→ file ----------
  assert.equal(matchKeyOf({ local_path: "/media/jav/AAA-001.MP4", label: "x", file: "f" }), "aaa-001.mp4");
  assert.equal(matchKeyOf({ local_path: "D:\\Videos\\BBB-002.mkv", label: "x", file: "f" }), "bbb-002.mkv");
  assert.equal(matchKeyOf({ local_path: null, label: "/mnt/videos/CCC-003.mp4", file: "f" }), "ccc-003.mp4");
  // 远端行：label 是视频名 → 用视频名（不是 opus hash 文件名）
  assert.equal(matchKeyOf({ local_path: null, label: "DDD-004.mp4", file: "60d514.opus" }), "ddd-004.mp4");
  // 远端行：label 是「文件夹扫描」批标占位 → 退回 file（hash basename 不会命中任何视频扫描项）
  assert.equal(matchKeyOf({ local_path: null, label: "文件夹扫描 · 3 项", file: "60d514bef136a97d6517d3d5d02cdb28cd72251b.opus" }),
    "60d514bef136a97d6517d3d5d02cdb28cd72251b.opus");
  // 非视频扩展名 label 不当主名 → 退回 file
  assert.equal(matchKeyOf({ local_path: null, label: "notes.txt", file: "EEE-005.mp4" }), "eee-005.mp4");
  // 全空 → ""（不可匹配）
  assert.equal(matchKeyOf({ local_path: null, label: null, file: null }), "");
  console.log("ok 1 - matchKeyOf 优先级/大小写/批标占位/hash 不误配");

  // ---------- buildDoneJobIndex：仅 done+job_id；同键取 created 最新 ----------
  const idx = buildDoneJobIndex([
    { engine: "127", status: "done", job_id: "j1", created: 100, file: "AAA-001.mp4" },
    { engine: "127", status: "done", job_id: "j2", created: 200, file: "AAA-001.mp4" }, // 同键重跑 → 取 j2
    { engine: "158", status: "done", job_id: "j3", created: 999, file: "AAA-001.mp4" }, // 更新 → 取 j3
    { engine: "127", status: "running", job_id: "j4", created: 999, file: "BBB-002.mp4" }, // 非 done 不收
    { engine: "127", status: "done", job_id: null, created: 999, file: "CCC-003.mp4" }, // 无 job_id 不收
    { engine: "127", status: "done", job_id: "j5", created: 1, local_path: "/x/DDD-004.MKV" }, // local_path 口径
  ]);
  assert.equal(idx.size, 2); // 同键 3 行收敛为 1 个 key + ddd-004.mkv
  assert.equal(idx.get("aaa-001.mp4").job_id, "j3");
  assert.equal(idx.get("ddd-004.mkv").job_id, "j5");
  assert.equal(idx.has("bbb-002.mp4"), false);
  assert.equal(idx.has("ccc-003.mp4"), false);
  console.log("ok 2 - buildDoneJobIndex 过滤/同键取最新");

  // ---------- matchScanItem：仅 has_subtitle=false 参与 ----------
  const hit = matchScanItem({ name: "AAA-001.mp4", has_subtitle: false }, idx);
  assert.ok(hit);
  assert.equal(hit.row.job_id, "j3");
  assert.equal(hit.key, "aaa-001.mp4");
  assert.equal(matchScanItem({ name: "AAA-001.mp4", has_subtitle: true }, idx), null); // 已有字幕不参与
  assert.equal(matchScanItem({ name: "no-such.mp4", has_subtitle: false }, idx), null);
  // too_small 仍可匹配（过小项命中也标「已生成未落盘」，归类留在「过小」）
  assert.ok(matchScanItem({ name: "ddd-004.mkv", has_subtitle: false }, idx));
  console.log("ok 3 - matchScanItem 命中/已有字幕排除");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
console.log("scan-reconcile tests passed");
