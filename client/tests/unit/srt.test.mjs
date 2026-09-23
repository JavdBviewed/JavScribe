// client/core/srt.ts 常驻单测（node 直接跑，无框架依赖）
// 运行：pnpm test:unit:client
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const tsSrc = resolve(here, "../../core/srt.ts");

const tmp = await mkdtemp(resolve(tmpdir(), "srt-"));
try {
  const out = resolve(tmp, "srt.cjs");
  await build({ entryPoints: [tsSrc], bundle: true, format: "cjs", outfile: out, logLevel: "silent" });
  const mod = await import(`file://${out}`);
  const { parseSrt, fmtSrtTime, fmtSrtSpan } = mod.default ?? mod;

  // 1) 标准 srt：序号块 + 多行文本
  const r1 = parseSrt([
    "1",
    "00:00:01,000 --> 00:00:04,500",
    "第一句",
    "换行第二句",
    "",
    "2",
    "00:00:05,250 --> 00:00:06,000",
    "第二句",
    "",
  ].join("\n"));
  assert.equal(r1.invalid, false);
  assert.equal(r1.cues.length, 2);
  assert.deepEqual(r1.cues[0], { index: 1, start: 1.0, end: 4.5, text: "第一句\n换行第二句" });
  assert.equal(r1.cues[1].start, 5.25);
  assert.equal(r1.cues[1].end, 6.0);

  // 2) BOM + CRLF + 毫秒 1 位（,5 = 500ms）+ 秒级小数（.456）
  const r2b = parseSrt("\uFEFF1\r\n00:00:01,5 --> 00:00:02,000\r\nhello\r\n\r\n2\r\n01:02:03.456 --> 01:02:04,000\r\nworld\r\n");
  assert.equal(r2b.invalid, false);
  assert.equal(r2b.cues.length, 2);
  assert.equal(r2b.cues[0].start, 1.5);          // ,5 → 500ms
  assert.equal(r2b.cues[0].end, 2.0);
  assert.equal(r2b.cues[1].start, 3723.456);     // .456 → 456ms
  assert.equal(r2b.cues[1].end, 3724.0);

  // 3) WEBVTT 头 + NOTE 块被忽略
  const r3 = parseSrt("WEBVTT\r\n\r\nNOTE 这是注释 00:00:00 --> 00:00:01\r\n\r\n00:00:10.000 --> 00:00:12.000\r\nvtt 行\r\n");
  assert.equal(r3.invalid, false);
  assert.equal(r3.cues.length, 1);
  assert.equal(r3.cues[0].text, "vtt 行");
  assert.equal(r3.cues[0].start, 10.0);

  // 4) 非字幕文本 / 空 → invalid
  assert.equal(parseSrt("").invalid, true);
  assert.equal(parseSrt("just some text\nno timestamps here").invalid, true);
  assert.equal(parseSrt("1\n\n\n2\n").invalid, true);

  // 5) 时间格式化
  assert.equal(fmtSrtTime(0), "00:00:00,000");
  assert.equal(fmtSrtTime(3671.503), "01:01:11,503");
  assert.equal(fmtSrtTime(0.5), "00:00:00,500");
  assert.equal(fmtSrtSpan(7263), "2小时01分");
  assert.equal(fmtSrtSpan(723), "12分03秒");
  assert.equal(fmtSrtSpan(45), "45秒");

  // 6) 0/负时长 cue 排除：serve 尾部指纹即 0 时长注释 cue，不得计入预览
  const r6 = parseSrt([
    "1",
    "00:00:00,000 --> 00:00:12,000",
    "第一句",
    "",
    "2",
    "00:00:00,000 --> 00:00:00,000",
    "<!-- jav-scribe v0.1.7 | engine=server | job=x -->",
    "",
  ].join("\n"));
  assert.equal(r6.invalid, false);
  assert.equal(r6.cues.length, 1);
  assert.ok(!r6.cues[0].text.includes("jav-scribe"));
  const r6b = parseSrt("1\n00:00:05,000 --> 00:00:04,000\n倒挂\n");
  assert.equal(r6b.invalid, true); // 仅含倒挂 cue → 无有效时间轴，降级原文

  console.log("srt.test ALL OK");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
