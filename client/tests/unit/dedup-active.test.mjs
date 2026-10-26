// client/core/dedup-active.ts 常驻单测（node 直接跑，esbuild 打包 TS 后断言，与 disk-split 套件同模式）
// 0.2.61：批量提交「进行中」查重——路径规范化 / 活跃判定 / 候选过滤纯逻辑（desktop/web 共用）。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const tsSrc = resolve(here, "../../core/dedup-active.ts");

const tmp = await mkdtemp(resolve(tmpdir(), "dedup-"));
try {
  const out = resolve(tmp, "dedup.cjs");
  await build({ entryPoints: [tsSrc], bundle: true, format: "cjs", outfile: out, logLevel: "silent" });
  const mod = await import(`file://${out}`);
  const { normVideoPath, serveRowActive, clientRowActive, activeVideoPathSet, splitActiveDuplicates } = mod.default ?? mod;

  // ---------- 路径规范化 ----------
  assert.equal(normVideoPath("D:\\Videos\\A.mp4", false), "D:/Videos/A.mp4", "反斜杠归一");
  assert.equal(normVideoPath("  /media/jav/B.mp4  ", false), "/media/jav/B.mp4", "trim");
  assert.equal(normVideoPath("D:\\Videos\\A.mp4", true), "d:/videos/a.mp4", "Win 小写");
  assert.equal(normVideoPath("", false), "", "空串 → 空串");
  assert.equal(normVideoPath(null, false), "", "null → 空串");
  assert.equal(normVideoPath("/a/B.mp4", false), "/a/B.mp4", "Linux 保持大小写");
  console.log("ok 1 - normVideoPath 规范化口径");

  // ---------- serve 行活跃判定（非终态即活跃，面向未来新状态） ----------
  assert.equal(serveRowActive({ status: "pending" }), true, "pending 活跃");
  assert.equal(serveRowActive({ status: "running" }), true, "running 活跃");
  assert.equal(serveRowActive({ status: "done" }), false, "done 终态");
  assert.equal(serveRowActive({ status: "skipped" }), false, "skipped 终态");
  assert.equal(serveRowActive({ status: "error" }), false, "error 终态");
  assert.equal(serveRowActive({ status: "canceled" }), false, "canceled 终态");
  assert.equal(serveRowActive({ status: "" }), false, "空状态不活跃");
  assert.equal(serveRowActive(null), false, "null 行不活跃");
  assert.equal(serveRowActive({}), false, "缺状态不活跃");
  assert.equal(serveRowActive({ status: "subtitling" }), true, "未来新增非终态自动视为活跃");
  console.log("ok 2 - serveRowActive 反向终态口径");

  // ---------- 客户端行活跃判定（含 interrupted 视同终态） ----------
  assert.equal(clientRowActive({ status: "pending" }), true, "pending 活跃");
  assert.equal(clientRowActive({ status: "running" }), true, "running 活跃");
  assert.equal(clientRowActive({ status: "paused" }), true, "paused 活跃（暂停仍在途）");
  assert.equal(clientRowActive({ status: "done" }), false, "done 终态");
  assert.equal(clientRowActive({ status: "canceled" }), false, "canceled 终态");
  assert.equal(clientRowActive({ status: "skipped" }), false, "skipped 终态");
  assert.equal(clientRowActive({ status: "error" }), false, "error 终态");
  assert.equal(clientRowActive({ status: "interrupted" }), false, "interrupted 视同终态（允许重跑）");
  assert.equal(clientRowActive(null), false, "null 行不活跃");
  console.log("ok 3 - clientRowActive 终态口径（interrupted 视同终态）");

  // ---------- 活跃路径集（三源并集 + 规范化 + 大小写） ----------
  const set1 = activeVideoPathSet({
    serveRows: [
      { file_path: "D:\\Videos\\A.mp4", status: "running" },
      { file_path: "D:\\Videos\\C.mp4", status: "done" },          // 终态不入集
      { file_path: null, status: "running" },                       // 无路径不入集
      { file_path: "D:\\Inbox\\hash\\E.mp4", status: "pending" },   // inbox 哈希路径照入（不误杀源路径）
    ],
    clientRows: [
      { file_path: "/media/jav/B.mp4", status: "pending" },
      { file_path: "/media/jav/F.mp4", status: "interrupted" },     // 账本中断视同终态不入集
    ],
    caseInsensitive: true,
  });
  assert.equal(set1.has("d:/videos/a.mp4"), true, "serve 行 Win 大小写归一");
  assert.equal(set1.has("d:/videos/c.mp4"), false, "serve 终态行不入集");
  assert.equal(set1.has("d:/inbox/hash/e.mp4"), true, "inbox 哈希路径入集（无源路径对应，不误杀）");
  assert.equal(set1.has("/media/jav/b.mp4"), true, "Win 敏感目录下 linux 路径原样入集");
  assert.equal(set1.has("/media/jav/f.mp4"), false, "账本 interrupted 不入集");
  assert.equal(set1.size, 3, "三源并集共 3 键");
  console.log("ok 4 - activeVideoPathSet 三源并集 + 规范化");

  // Linux 大小写敏感
  const set2 = activeVideoPathSet({
    serveRows: [{ file_path: "/media/jav/Big.mp4", status: "running" }],
    clientRows: [],
    caseInsensitive: false,
  });
  assert.equal(set2.has("/media/jav/big.mp4"), false, "Linux 大小写敏感不误判");
  assert.equal(set2.has("/media/jav/Big.mp4"), true, "原样命中");
  console.log("ok 5 - 大小写敏感模式");

  // ---------- 候选过滤（保序 / 无路径恒 kept） ----------
  const active = new Set(["d:/videos/a.mp4", "d:/videos/b.mp4"]);
  const r = splitActiveDuplicates(
    ["D:\\Videos\\B.mp4", "d:\\videos\\A.MP4", "D:\\Videos\\new.mp4", ""],
    active,
    true,
  );
  assert.deepEqual(r.skipped, ["D:\\Videos\\B.mp4", "d:\\videos\\A.MP4"], "命中按输入序归 skipped");
  assert.deepEqual(r.kept, ["D:\\Videos\\new.mp4", ""], "未命中 + 空路径恒 kept");

  const r2 = splitActiveDuplicates(["/x/a.mp4"], new Set(["/x/A.mp4"]), false);
  assert.deepEqual(r2.kept, ["/x/a.mp4"], "敏感模式不同大小写不判重");
  assert.deepEqual(r2.skipped, [], "敏感模式 skipped 空");

  const r3 = splitActiveDuplicates([], new Set(["x"]), true);
  assert.deepEqual(r3.kept, [], "空输入");
  assert.deepEqual(r3.skipped, [], "空输入 skipped 空");
  console.log("ok 6 - splitActiveDuplicates 保序 + 无路径不阻断");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
console.log("dedup-active test ok");
