// client/core/disk-split.ts 常驻单测（node 直接跑，esbuild 打包 TS 后断言，与 disk-key 套件同模式）
// 0.2.52 M1：提交时刻按盘拆 batch 的分组/label 纯逻辑（desktop/web 共用）。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const tsSrc = resolve(here, "../../core/disk-split.ts");

const tmp = await mkdtemp(resolve(tmpdir(), "dsk-"));
try {
  const out = resolve(tmp, "dsk.cjs");
  await build({ entryPoints: [tsSrc], bundle: true, format: "cjs", outfile: out, logLevel: "silent" });
  const mod = await import(`file://${out}`);
  const { groupByDisk, multiGroupLabel, folderGroupLabel } = mod.default ?? mod;

  // ---------- 分组：两顶层目录 → 2 组 ----------
  const linKey = (p) => { const m = p.match(/^\/[^\/]+/); return m ? m[0] : ""; }; // 模拟 diskKeyOf：顶层段
  const linDir = (p) => p.split("/").filter(Boolean)[1] || ""; // 模拟目录名
  const r1 = groupByDisk(
    ["/tmp/a/x1.mp4", "/home/b/y1.mp4", "/tmp/a/x2.mp4"],
    linKey, linDir,
  );
  assert.equal(r1.length, 2, "两顶层目录 → 2 组");
  assert.deepEqual(r1.map((g) => g.key), ["/tmp", "/home"], "组键=顶层段，首见序");
  assert.deepEqual(r1[0].items, ["/tmp/a/x1.mp4", "/tmp/a/x2.mp4"], "组内顺序保持");
  assert.deepEqual(r1[1].items, ["/home/b/y1.mp4"]);
  console.log("ok 1 - 两顶层目录 → 2 组（首见序、组内保序）");

  // ---------- 分组：单目录 → 1 组 ----------
  const r2 = groupByDisk(["/tmp/a/x1.mp4", "/tmp/a/x2.mkv"], linKey, linDir);
  assert.equal(r2.length, 1, "单目录 → 1 组");
  assert.equal(r2[0].key, "/tmp");
  assert.deepEqual(r2[0].dirNames, ["a"], "目录名单值");
  console.log("ok 2 - 单目录 → 1 组");

  // ---------- 分组：同顶层多目录 → 1 组，dirNames「、」连 ----------
  const r3 = groupByDisk(
    ["/tmp/a/x1.mp4", "/tmp/b/y1.mp4", "/tmp/a/x2.mp4"],
    linKey, linDir,
  );
  assert.equal(r3.length, 1, "同顶层多目录 → 1 组");
  assert.deepEqual(r3[0].dirNames, ["a", "b"], "dirNames 去重首见序");
  assert.equal(multiGroupLabel(r3[0]), "/tmp·a、b", "多目录 label = 顶层·目录名（、连接）");
  console.log("ok 3 - 同顶层多目录 → 1 组（dirNames 去重 + label 连接）");

  // ---------- 分组：Win 两盘 ----------
  const r4 = groupByDisk(
    ["D:\\Movies\\a.mp4", "E:\\Vids\\b.mp4", "D:\\Movies\\c.mkv"],
    (p) => (p.match(/^[a-zA-Z]:/) ? p[0].toUpperCase() + ":" : ""),
    (p) => p.split(/[\\/]/)[1],
  );
  assert.deepEqual(r4.map((g) => g.key), ["D:", "E:"], "Win 两盘 → 2 组");
  assert.equal(multiGroupLabel(r4[0]), "D:·Movies");
  assert.equal(multiGroupLabel(r4[1]), "E:·Vids");
  console.log("ok 4 - Win 两盘符 → 2 组（label 盘符·目录名）");

  // ---------- 分组：UNC 同共享 → 1 组 ----------
  const r5 = groupByDisk(
    ["\\\\server\\share\\a.mp4", "\\\\server\\share\\b.mp4"],
    (p) => "//server/share",
    (p) => "share",
  );
  assert.equal(r5.length, 1, "UNC 同共享 → 1 组");
  assert.equal(r5[0].key, "//server/share");
  console.log("ok 5 - UNC 同共享 → 1 组");

  // ---------- 无盘维度（web 形态无 _localPath）→ 全部单组 ----------
  const r6 = groupByDisk(["a.mp4", "b.mp4"], () => "", () => "目录A");
  assert.equal(r6.length, 1, "空键 → 单组");
  assert.equal(r6[0].key, "");
  assert.deepEqual(r6[0].dirNames, ["目录A"], "dirNames 去重");
  assert.equal(multiGroupLabel(r6[0]), "目录A", "空键 label 只留目录名");
  console.log("ok 6 - 无盘维度（空键）→ 单组（web 形态退化单组）");

  // ---------- 边界：dirNames 缺失时 label 兜底 ----------
  assert.equal(multiGroupLabel({ key: "D:", dirNames: [] }), "D:·目录", "目录名缺失兜底");
  assert.equal(multiGroupLabel({ key: "", dirNames: [] }), "目录", "全缺兜底");
  console.log("ok 7 - multiGroupLabel 兜底口径");

  // ---------- folderGroupLabel 三级决策（startBatch 口径） ----------
  // 多组 → 盘符·目录名
  assert.equal(folderGroupLabel({ key: "/tmp", dirNames: ["a"] }, true, "现状"), "/tmp·a", "多组带盘符");
  assert.equal(folderGroupLabel({ key: "/tmp", dirNames: ["a", "b"] }, true, "现状"), "/tmp·a、b", "多组同组多目录「、」连");
  assert.equal(folderGroupLabel({ key: "", dirNames: ["a"] }, true, "现状"), "a", "多组空键无盘符");
  // 单组多目录（同顶层多选）→ 目录名「、」连（无盘符）
  assert.equal(folderGroupLabel({ key: "/tmp", dirNames: ["a", "b"] }, false, "a"), "a、b", "单组多目录「、」连");
  // 单组单目录 → 现状 label 原样
  assert.equal(folderGroupLabel({ key: "/tmp", dirNames: ["a"] }, false, "a"), "a", "单组单目录零噪音");
  assert.equal(folderGroupLabel({ key: "", dirNames: ["目录A"] }, false, "目录A"), "目录A", "web 形态单组原样");
  console.log("ok 8 - folderGroupLabel 三级决策（多组盘符·/单组多目录「、」/单组单目录原样）");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
