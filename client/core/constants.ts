// 跨形态共享常量（与服务端 audio.py / 扫描规则默认值保持一致）

/** 本地过滤用视频扩展名 */
export const VIDEO_EXTS = ["mp4", "mkv", "avi", "mov", "webm", "flv", "wmv", "ts", "m2ts", "mpg", "mpeg"];

/** 本地判断「已有字幕」的文件名模式（与服务端默认一致，仅本地过滤用） */
export const LOCAL_SUB_PATTERNS = [".zh.srt", ".srt"];

/** 写回/下载的 srt 命名：影片 stem + .zh.srt */
export const SRT_SUFFIX = ".zh.srt";

/** ffmpeg.wasm 线性内存上限 ~2GB，1.6GB 是含中间数据的安全上限（与服务端一致） */
export const DEFAULT_MAX_EXTRACT_BYTES = Math.floor(1.6 * 1024 * 1024 * 1024);

/** 与服务端 audio_args 完全一致的本地提取参数（16kHz 单声道 opus @32kbps） */
export const OPUS_EXTRACT_ARGS = [
  "-vn", "-c:a", "libopus", "-ar", "16000", "-ac", "1", "-b:a", "32k",
] as const;
