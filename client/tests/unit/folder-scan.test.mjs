// client/core/folder-scan.ts 常驻单测（node 直接跑，无框架依赖）
// 运行：pnpm test:unit:client
// 10-09-javscribe-local-scan-parity 背景：「选择文件夹」与「扫描目录」统一吃
// 「客户端设置 · 扫描规则」；文件夹视频的字幕判定（同目录 srt / 文件名标记 /
// 过小）由本模块单点实现，web 渲染层与 desktop main 共用。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const tsSrc = resolve(here, "../../core/folder-scan.ts");

const tmp = await mkdtemp(resolve(tmpdir(), "fs-"));
try {
  const out = resolve(tmp, "fs.cjs");
  await build({ entryPoints: [tsSrc], bundle: true, format: "cjs", outfile: out, logLevel: "silent" });
  const mod = await import(`file://${out}`);
  const ex = mod.default ?? mod;
  const { folderTokensIn, folderExtOf, folderIsVideo, folderVideoMeta } = ex;

  const rules = (over = {}) => ({
    video_exts: ["mp4", "mkv"],
    subtitle_patterns: [".zh.srt", ".srt"],
    min_size_mb: 200,
    has_sub_tokens: ["chinese"],
    no_sub_tokens: ["c"],
    ...over,
  });

  // ---------- folderTokensIn：整词匹配 ----------
  {
    assert.equal(folderTokensIn("abc c def", ["c"]), "c", "独立词命中");
    assert.equal(folderTokensIn("ABC C DEF", ["c"]), "c", "大小写不敏感");
    assert.equal(folderTokensIn("SSIS-123C", ["c"]), null, "粘番号 123C 不算独立 C");
    assert.equal(folderTokensIn("CD1", ["c"]), null, "CD1 集数不算");
    assert.equal(folderTokensIn("1CD", ["c"]), null, "1CD 集数不算");
    assert.equal(folderTokensIn("Uncut", ["c"]), null, "词内词 Uncut 不算");
    assert.equal(folderTokensIn("c.mp4", ["c"]), "c", "纯标记文件名");
    assert.equal(folderTokensIn("abc", []), null, "空 token 列表不命中");
    assert.equal(folderTokensIn("abc", [""]), null, "空串 token 不命中");
  }
  console.log("ok 1 - folderTokensIn 整词匹配");

  // ---------- folderExtOf / folderIsVideo ----------
  {
    assert.equal(folderExtOf("a.MP4"), "mp4", "大写扩展名归小写");
    assert.equal(folderExtOf("a.mkv"), "mkv");
    assert.equal(folderExtOf("noext"), "", "无扩展名空串");
    assert.equal(folderExtOf("a.tar.gz"), "gz", "多点取最后段");

    const r = rules();
    assert.equal(folderIsVideo("a.mp4", r), true);
    assert.equal(folderIsVideo("a.MKV", r), true, "扩展名大小写不敏感");
    assert.equal(folderIsVideo("a.mov", r), false, "规则外扩展名不是视频");
    assert.equal(folderIsVideo("noext", r), false);
  }
  console.log("ok 2 - folderExtOf/folderIsVideo");

  // ---------- folderVideoMeta：同目录 srt（external 优先） ----------
  {
    const m = folderVideoMeta("ABC.mp4", 500 * 1048576, new Set(["abc.mp4", "abc.zh.srt"]), rules());
    assert.equal(m.sub_status, "external");
    assert.equal(m.sub_name, "abc.zh.srt");
    assert.equal(m.sub_token, null);
    assert.equal(m.too_small, false, "500MB ≥ 200MB");

    const m2 = folderVideoMeta("ABC.mp4", 500 * 1048576, new Set(["abc.mp4", "abc.srt"]), rules());
    assert.equal(m2.sub_status, "external");
    assert.equal(m2.sub_name, "abc.srt", "按序匹配到 .srt");

    const m3 = folderVideoMeta("abc.mp4", 500 * 1048576, new Set(["abc.mp4"]), rules());
    assert.equal(m3.sub_status, "none", "同目录无字幕");
  }
  console.log("ok 3 - folderVideoMeta external 判定");

  // ---------- folderVideoMeta：文件名标记（named）与双命中 ----------
  {
    const m = folderVideoMeta("abc-chinese.mp4", 500 * 1048576, new Set(["abc-chinese.mp4"]), rules());
    assert.equal(m.sub_status, "named");
    assert.equal(m.sub_token, "chinese");
    assert.equal(m.no_sub_token, null);

    const both = folderVideoMeta("abc c chinese.mp4", 500 * 1048576, new Set(["abc c chinese.mp4"]), rules());
    assert.equal(both.sub_status, "none", "双命中 → 无字幕优先（保守不跳过）");
    assert.equal(both.sub_token, null, "双命中 → has 标记清除");
    assert.equal(both.no_sub_token, "c", "双命中 → no 标记保留");

    const nosub = folderVideoMeta("abc c.mp4", 500 * 1048576, new Set(["abc c.mp4"]), rules());
    assert.equal(nosub.sub_status, "none", "no 标记不改变 sub_status（仅记账）");
    assert.equal(nosub.no_sub_token, "c");
  }
  console.log("ok 4 - folderVideoMeta 标记与双命中");

  // ---------- folderVideoMeta：过小 ----------
  {
    const small = folderVideoMeta("abc.mp4", 70 * 1024, new Set(["abc.mp4"]), rules());
    assert.equal(small.too_small, true, "70KB < 200MB → 过小");
    assert.equal(folderVideoMeta("abc.mp4", 70 * 1024, new Set(["abc.mp4"]), rules({ min_size_mb: 0 })).too_small, false, "min=0 不限");
    assert.equal(folderVideoMeta("abc.mp4", 200 * 1048576, new Set(["abc.mp4"]), rules()).too_small, false, "恰好 200MB 不算过小");
  }
  console.log("ok 5 - folderVideoMeta 过小判定");

  console.log("folder-scan.test: 5/5 组断言全过");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
