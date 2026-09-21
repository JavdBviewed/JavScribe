// client/core/sub-embed.ts 常驻单测（node 直接跑，无框架依赖）
// 运行：pnpm test:unit:client
// 语义必须与服务端 src/jav_scribe/core/subprobe.py 一致（09-21 同源契约）。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const tsSrc = resolve(here, "../../core/sub-embed.ts");

const tmp = await mkdtemp(resolve(tmpdir(), "subembed-"));
try {
  const out = resolve(tmp, "subembed.cjs");
  await build({ entryPoints: [tsSrc], bundle: true, format: "cjs", outfile: out, logLevel: "silent" });
  const mod = await import(`file://${out}`);
  const m = mod.default ?? mod; // esbuild CJS 打包：命名导出可能挂在 default 下
  const { normLanguage, shouldSkipEmbedded, parseProbeOutput, embeddedTargets, probeArgs } = m;

  // 语言归一（与服务端 norm_language 对齐）
  assert.equal(normLanguage("chi"), "zh");
  assert.equal(normLanguage("ZHO"), "zh");
  assert.equal(normLanguage("jpn"), "ja");
  assert.equal(normLanguage("JAP"), "ja");
  assert.equal(normLanguage(null), "und");
  assert.equal(normLanguage(undefined), "und");
  assert.equal(normLanguage("  "), "und");
  assert.equal(normLanguage("Eng"), "eng");
  console.log("  normLanguage OK");

  // 跳过策略矩阵（与服务端 should_skip_embedded 对齐）
  const zh = { skip_embedded: "target", lang_tag: "zh" };
  assert.deepEqual(shouldSkipEmbedded(zh, ["jpn", null]), { skip: false, reason: "" });
  const hit = shouldSkipEmbedded(zh, ["chi"]);
  assert.equal(hit.skip, true);
  assert.ok(hit.reason.includes("zh"));
  // embedded_langs 覆盖 lang_tag
  assert.equal(shouldSkipEmbedded({ skip_embedded: "target", lang_tag: "zh", embedded_langs: ["ja"] }, ["jap"]).skip, true);
  assert.equal(shouldSkipEmbedded({ skip_embedded: "target", lang_tag: "zh", embedded_langs: ["ja"] }, ["chi"]).skip, false);
  // embedded_langs 空 -> 回落 lang_tag
  assert.equal(shouldSkipEmbedded({ skip_embedded: "target", lang_tag: "zh", embedded_langs: [] }, ["chi"]).skip, true);
  // any：und 也跳
  const anyR = shouldSkipEmbedded({ skip_embedded: "any" }, [null]);
  assert.equal(anyR.skip, true);
  assert.ok(anyR.reason.includes("1 条"));
  // off / 未知 / 空轨
  assert.equal(shouldSkipEmbedded({ skip_embedded: "off" }, ["chi"]).skip, false);
  assert.equal(shouldSkipEmbedded({ skip_embedded: "bogus" }, ["chi"]).skip, false);
  assert.equal(shouldSkipEmbedded(zh, []).skip, false);
  // 缺省 = target
  assert.equal(shouldSkipEmbedded({ lang_tag: "zh" }, ["chi"]).skip, true);
  console.log("  shouldSkipEmbedded OK");

  // embeddedTargets 回落逻辑
  assert.deepEqual(embeddedTargets({ lang_tag: "zh" }), ["zh"]);
  assert.deepEqual(embeddedTargets({ lang_tag: "zh", embedded_langs: ["jap", "chi"] }), ["ja", "zh"]);
  assert.deepEqual(embeddedTargets({ lang_tag: "ja", embedded_langs: ["", " "] }), ["ja"]);
  console.log("  embeddedTargets OK");

  // ffprobe JSON 解析：只认白名单 codec，语言缺失 -> null
  const sample = JSON.stringify({
    streams: [
      { codec_name: "subrip", tags: { language: "chi" } },
      { codec_name: "hdmv_pgs_subtitle", tags: { language: "jpn" } },
      { codec_name: "ass", tags: {} },
      { codec_name: "aac", tags: { language: "und" } },   // 音频轨：排除
      { codec_name: "h264" },                             // 视频轨：排除
    ],
  });
  const subs = parseProbeOutput(sample);
  assert.equal(subs.length, 3);
  assert.deepEqual(subs[2], { codec: "ass", language: null });
  assert.deepEqual(parseProbeOutput("not json"), []);
  assert.deepEqual(parseProbeOutput(""), []);
  console.log("  parseProbeOutput OK");

  // 探测参数契约：language 必须走独立 stream_tags 段
  // （ffmpeg 7.x 实测 `-show_entries stream=...,tags.language` 合并写法不输出 tags）
  const args = probeArgs("/tmp/v.mkv");
  const si = args.indexOf("-show_entries");
  assert.ok(!args[si].includes("tags."), `禁止合并写法: ${args.join(" ")}`);
  assert.ok(args.includes("stream_tags=language"), `缺 stream_tags 段: ${args.join(" ")}`);
  assert.equal(args[args.length - 3], "-of");
  assert.equal(args[args.length - 2], "json");
  assert.equal(args[args.length - 1], "/tmp/v.mkv");
  console.log("  probeArgs OK");

  // 端到端语义：emby 库实测场景（und subrip + und ass）target/zh 不挡
  const emby = parseProbeOutput(sample).filter((x) => !x.language);
  assert.equal(shouldSkipEmbedded(zh, emby.map((x) => x.language)).skip, false);
  assert.equal(shouldSkipEmbedded({ skip_embedded: "any" }, emby.map((x) => x.language)).skip, true);
  console.log("  emby-und scenario OK");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
console.log("sub-embed.test ALL OK");
