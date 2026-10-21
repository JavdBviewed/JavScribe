// client/core/disk-key.ts 常驻单测（node 直接跑，esbuild 打包 TS 后断言，与 concurrency 套件同模式）
// 0.2.52 多盘符主任务地基：按盘拆 batch（M1）与提取池公平准入（M2）共用 diskKeyOf。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const tsSrc = resolve(here, "../../core/disk-key.ts");

const tmp = await mkdtemp(resolve(tmpdir(), "dk-"));
try {
  const out = resolve(tmp, "dk.cjs");
  await build({ entryPoints: [tsSrc], bundle: true, format: "cjs", outfile: out, logLevel: "silent" });
  const mod = await import(`file://${out}`);
  const { diskKeyOf } = mod.default ?? mod;

  // ---------- Win 盘符 ----------
  assert.equal(diskKeyOf("D:\\Videos\\a.mp4"), "D:", "Win 反斜杠盘符");
  assert.equal(diskKeyOf("d:/Videos/a.mp4"), "D:", "Win 小写盘符 + 正斜杠归一大写");
  assert.equal(diskKeyOf("E:\\a.mkv"), "E:", "不同盘不同键");

  // ---------- UNC ----------
  assert.equal(diskKeyOf("\\\\server\\share\\a.mp4"), "//server/share", "UNC 归一整串");
  assert.equal(diskKeyOf("//server/share/"), "//server/share", "UNC 去尾部斜杠");

  // ---------- Linux/macOS：前两段 = 顶层挂载点粒度 ----------
  assert.equal(diskKeyOf("/tmp/jav-e2e/a.mp4"), "/tmp", "顶层 /tmp");
  assert.equal(diskKeyOf("/home/ryen/x/a.mp4"), "/home", "顶层 /home");
  assert.equal(diskKeyOf("/media/jav/movies/a.mp4"), "/media", "外接盘 /media 归挂载点");
  assert.equal(diskKeyOf("/srv"), "/srv", "单段顶层路径");
  assert.equal(diskKeyOf("/"), "/", "根路径");

  // ---------- 无盘维度 ----------
  assert.equal(diskKeyOf(""), "", "空串");
  assert.equal(diskKeyOf("a.mp4"), "", "纯文件名无盘维度");
  assert.equal(diskKeyOf("rel/path/a.mp4"), "", "相对路径无盘维度");

  console.log("ok 1 - diskKeyOf 盘符/UNC/顶层/无盘维度 全口径");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
