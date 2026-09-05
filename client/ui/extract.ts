/* 浏览器本地提音轨（ffmpeg.wasm）：与服务端完全相同的参数
 * （16kHz 单声道 opus @32kbps，见 audio.py 的 audio_args）。
 * 暴露 window.JavExtract：
 *   extractAudio(file, { onProgress }) -> Promise<Blob | { skipped: true }>
 *     - 超过 MAX_BYTES 或空文件返回 { skipped: true }，由调用方决定回退
 *     - onProgress(p)：0..1，节流至 ~100 次
 *   MAX_BYTES：wasm 线性内存上限 ~2GB，1.6GB 是含中间数据的安全上限
 * 串行队列：批量时一次只跑一个文件，避免 wasm 内存叠加。
 */
import { DEFAULT_MAX_EXTRACT_BYTES, OPUS_EXTRACT_ARGS } from "../core/constants";

// 历史行为（基线 1:1 保留）：app 直接传回调函数，而实现按 opts 对象读 onProgress
// （函数上没有 onProgress 属性），因此当前生产代码本地提取阶段没有实时百分比。
// 二期 desktop 形态可顺手修正，一期不得改变 web 行为。
export type ExtractProgress = (p: number) => void;
export type ExtractOpts = { onProgress?: ExtractProgress } | ExtractProgress;

export interface JavExtractAPI {
  extractAudio: (f: File, opts?: ExtractOpts) => Promise<Blob | { skipped: true }>;
  MAX_BYTES: number;
  fits: (f: File | null) => boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FFmpegLike = any;

const MAX_BYTES =
  (window as { JAV_EXTRACT_MAX_BYTES?: unknown }).JAV_EXTRACT_MAX_BYTES != null
    ? Number((window as { JAV_EXTRACT_MAX_BYTES?: unknown }).JAV_EXTRACT_MAX_BYTES)
    : DEFAULT_MAX_EXTRACT_BYTES;
let inst: FFmpegLike | null = null;
let loading: Promise<FFmpegLike> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function ensure(): Promise<FFmpegLike> {
  if (inst && inst.loaded) return Promise.resolve(inst);
  if (!loading) {
    const F = (window as { FFmpegWASM?: { FFmpeg?: new () => FFmpegLike } }).FFmpegWASM;
    if (!F || !F.FFmpeg) {
      return Promise.reject(new Error("ffmpeg.wasm 未加载"));
    }
    const f = new F.FFmpeg();
    loading = f
      .load({
        // 不传 classWorkerURL：wrapper 按 /lib/ffmpeg.js 位置自动定位 worker chunk；
        // core/wasm 必须用绝对路径——importScripts 在 worker 内按 worker 自身 URL 解析
        coreURL: "/ffmpeg/ffmpeg-core.js",
        wasmURL: "/ffmpeg/ffmpeg-core.wasm",
      })
      .then(() => {
        inst = f;
        return f;
      })
      .catch((e: unknown) => {
        loading = null;
        throw e;
      });
  }
  // 闭包内会赋值 loading，tsgo(TS7) 在 any 赋值后不保留窄化；逻辑上此处必然非 null，
  // 兜底 reject 仅为满足类型
  return loading ?? Promise.reject(new Error("ffmpeg.wasm 未加载"));
}

function runOne(f: File, onProgress?: (p: number) => void) {
  return ensure().then((ff) => {
    const ext = /\.([a-z0-9]{1,8})$/i.exec(f.name);
    const inName = "in" + (ext ? "." + ext[1].toLowerCase() : ".bin");
    const outName = "out.opus";
    let last = -1;
    const handler = (ev: { progress?: number }) => {
      const p0 = ev && typeof ev.progress === "number" ? ev.progress : 0;
      const p = Math.max(0, Math.min(1, p0));
      if (onProgress && (p - last >= 0.01 || p >= 1)) {
        last = p;
        onProgress(p);
      }
    };
    const cleanup = () => {
      ff.off("progress", handler);
      // 释放 wasm 内存，供批量下一个文件使用
      ff.deleteFile(inName).catch(() => {});
      ff.deleteFile(outName).catch(() => {});
    };
    ff.on("progress", handler);
    return ff
      .deleteFile(outName)
      .catch(() => {})
      .then(() => f.arrayBuffer())
      .then((buf: ArrayBuffer) => ff.writeFile(inName, new Uint8Array(buf)))
      .then(() => {
        // 与服务端 audio_args 完全一致
        return ff.exec(["-i", inName, ...OPUS_EXTRACT_ARGS, outName]);
      })
      .then((rc: number) => {
        if (rc !== 0) throw new Error("ffmpeg 本地提取失败（退出码 " + rc + "）");
        return ff.readFile(outName);
      })
      .then((data: { buffer: ArrayBuffer }) => {
        const blob = new Blob([data.buffer], { type: "audio/ogg" });
        cleanup();
        return blob;
      })
      .catch((e: unknown) => {
        cleanup();
        throw e;
      });
  });
}

function extractAudio(f: File, opts?: ExtractOpts) {
  if (!f) return Promise.reject(new Error("没有文件"));
  if (f.size <= 0) return Promise.resolve({ skipped: true } as const);
  if (f.size > MAX_BYTES) return Promise.resolve({ skipped: true } as const);
  // 与迁移前一致：函数形式第二参读不到 onProgress → 无实时进度（生产基线行为）
  const optsObj = (typeof opts === "function" ? undefined : opts) as
    | { onProgress?: ExtractProgress }
    | undefined;
  const onProgress = optsObj?.onProgress;
  const prev = queue;
  let release: () => void = () => {};
  queue = new Promise<void>((r) => { release = r; });
  return prev
    .then(() => runOne(f, onProgress))
    .finally(() => { release(); });
}

const api: JavExtractAPI = {
  extractAudio,
  MAX_BYTES,
  fits: (f) => !!f && f.size > 0 && f.size <= MAX_BYTES,
};

// 与迁移前一致：挂 window，app.ts 按需取用（模块加载即就位，先于任何 dispatch）
(window as { JavExtract?: JavExtractAPI }).JavExtract = api;
export { api as JavExtract };
